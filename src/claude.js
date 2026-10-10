// Optional "enhanced extraction": sends the already-redacted, metadata-free
// receipt image to Claude and gets the line items back as JSON. Off unless
// the user adds their own API key in Settings. Results are scrubbed for PII
// again before use.

import Anthropic from '@anthropic-ai/sdk';
import { scrubValue } from './pii.js';

const SCHEMA = {
  type: 'object',
  properties: {
    store: { type: 'string', description: 'Store or chain name only, e.g. "Home Depot". No address.' },
    date: { type: 'string', description: 'Purchase or refund date as YYYY-MM-DD, or empty' },
    is_return: { type: 'boolean', description: 'True for a return/refund receipt' },
    subtotal: { type: ['number', 'null'] },
    tax: { type: ['number', 'null'] },
    total: { type: ['number', 'null'] },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          sku: { type: 'string', description: 'Item number/UPC printed on the line, or empty' },
          quantity: { type: 'number' },
          unit_price: { type: 'number' },
          line_total: { type: 'number', description: 'Extended price after any line discount, as a positive number' },
        },
        required: ['description', 'sku', 'quantity', 'unit_price', 'line_total'],
        additionalProperties: false,
      },
    },
  },
  required: ['store', 'date', 'is_return', 'subtotal', 'tax', 'total', 'items'],
  additionalProperties: false,
};

const SYSTEM = `You read photos of store receipts and extract the purchased (or returned) line items.
- One entry per product line. Fold quantity lines ("2 @ 5.98") and line discounts into the item they belong to.
- Leave out subtotal, tax, total, tender, change and savings-summary lines from items.
- Amounts are positive numbers even on a refund receipt; set is_return for refund/return receipts.
- Black boxes hide private information. Ignore them and never output names, addresses, phone numbers, emails, card or account numbers, or loyalty IDs.`;

export async function extractWithClaude(apiKey, jpegBase64) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const response = await client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegBase64 } },
          { type: 'text', text: 'Extract this receipt.' },
        ],
      },
    ],
  });
  if (response.stop_reason === 'refusal') throw new Error('Claude declined to read this image.');
  if (response.stop_reason === 'max_tokens') throw new Error('The receipt was too long to extract in one pass.');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const data = JSON.parse(text);
  return {
    store: scrubValue(data.store) || '',
    date: /^\d{4}-\d{2}-\d{2}$/.test(data.date) ? data.date : '',
    isReturn: Boolean(data.is_return),
    subtotal: data.subtotal,
    tax: data.tax,
    total: data.total,
    items: data.items
      .map((i) => ({
        desc: scrubValue(i.description),
        sku: /^\d{4,14}$/.test(i.sku) ? i.sku : '',
        qty: i.quantity || 1,
        unitPrice: Math.abs(i.unit_price),
        total: Math.abs(i.line_total),
      }))
      .filter((i) => i.desc && i.desc !== '[redacted]'),
  };
}

export function describeError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'The API key was rejected. Check it in Settings.';
  if (e instanceof Anthropic.RateLimitError) return 'Rate limited by the API. Try again in a minute.';
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach the API (offline?). The on-device result is kept.';
  if (e instanceof Anthropic.APIError) return `API error ${e.status}: ${e.message}`;
  return e?.message || String(e);
}
