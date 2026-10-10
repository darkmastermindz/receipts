// Turns (already redacted) receipt text into a store, date, totals and line
// items. Works line by line: a line that ends in a price is an item unless it
// is a total, tax, tender or discount line.

import { REDACTED } from './pii.js';

export const KNOWN_STORES = [
  ['Home Depot', /home\s*depot|homedepot/i],
  ["Lowe's", /\blowe'?s\b|lowes\.com/i],
  ['Walmart', /wal[\s-]?mart/i],
  ['Target', /\btarget\b/i],
  ['Harbor Freight', /harbor\s*freight/i],
  ['Amazon', /amazon/i],
  ['Costco', /costco/i],
  ["Sam's Club", /sam'?s\s*club/i],
  ['Ace Hardware', /\bace\s*hardware/i],
  ['Menards', /menards/i],
  ['Tractor Supply', /tractor\s*supply/i],
  ['Dollar General', /dollar\s*general/i],
  ['Dollar Tree', /dollar\s*tree/i],
  ['Five Below', /five\s*below/i],
  ['Michaels', /\bmichaels\b/i],
  ['Hobby Lobby', /hobby\s*lobby/i],
  ["Dick's Sporting Goods", /dick'?s\s*sporting/i],
  ['Academy Sports', /academy\s*sports/i],
  ['Party City', /party\s*city/i],
  ['Ferguson', /ferguson/i],
  ['Northern Tool', /northern\s*tool/i],
  ['Walgreens', /walgreens/i],
  ['CVS', /\bcvs\b/i],
  ['Publix', /publix/i],
  ['Harris Teeter', /harris\s*teeter/i],
  ['Food Lion', /food\s*lion/i],
  ['Best Buy', /best\s*buy/i],
  ['Staples', /\bstaples\b/i],
  ['Office Depot', /office\s*depot/i],
  ['Bass Pro Shops', /bass\s*pro/i],
  ['REI', /\brei\b/i],
];

/** Canonical key for grouping by shop: "Lowe's #1234" and "LOWES" → "lowes". */
export function storeKey(name) {
  const s = String(name || '').trim();
  for (const [canon, re] of KNOWN_STORES) if (re.test(s)) return canon.toLowerCase().replace(/[^a-z0-9]/g, '');
  return s.toLowerCase().replace(/#\s*\d+.*/, '').replace(/\b(the|inc|llc|store)\b/g, '').replace(/[^a-z0-9]/g, '') || 'unknown';
}

export function canonicalStore(name) {
  const s = String(name || '').trim();
  for (const [canon, re] of KNOWN_STORES) if (re.test(s)) return canon;
  return s;
}

export function detectStore(lines) {
  const head = lines.slice(0, 12);
  for (const line of head) for (const [canon, re] of KNOWN_STORES) if (re.test(line)) return canon;
  // Fall back to the first line that is mostly letters and not redacted.
  for (const line of head) {
    const t = line.trim();
    if (!t || t.startsWith(REDACTED)) continue;
    if (/[a-z]{3,}/i.test(t) && (t.match(/[a-z]/gi) || []).length >= t.length * 0.6) return t.replace(/\s{2,}/g, ' ');
  }
  return '';
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');

export function detectDate(text) {
  // Item lines carry sizes ("1/4-20 X 1 IN") that look like dates, so look
  // at lines without a trailing price first.
  const lines = String(text).split(/\r?\n/);
  const unpriced = lines.filter((l) => !/\d[.,]\d{2}\s*-?\s*[A-Z*]{0,2}\s*$/.test(l)).join('\n');
  return dateIn(unpriced) || dateIn(text);
}

function dateIn(text) {
  let m = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = text.match(/(?<![\d/.-])(\d{1,2})([/.-])(\d{1,2})\2(\d{2}|\d{4})(?![\d/.-])/);
  if (m) {
    let y = Number(m[4]);
    if (y < 100) y += 2000;
    const mo = Number(m[1]), d = Number(m[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 2000 && y < 2100) return `${y}-${pad(mo)}-${pad(d)}`;
  }
  m = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})\b/i);
  if (m) return `${m[3]}-${pad(MONTHS[m[1].toLowerCase()])}-${pad(m[2])}`;
  return '';
}

// A price at the end of a line, with optional sign, trailing minus, and the
// tax flags stores print after it ("11.96 N", "5.98 T", "24.97 X", "-3.00").
const PRICE_AT_END = /(\(?)(-)?\s?\$?\s?(\d{1,5}(?:,\d{3})*[.,]\d{2})\)?\s*(-)?\s*(?:[A-Z]{1,2}|\*|<[A-Z]>)?\s*$/;
const QTY_AT = /(\d+(?:\.\d+)?)\s*(?:ea\.?\s*)?(?:@|at)\s*(?:\d+\s*(?:\/|for)\s*)?\$?\s?(\d+[.,]\d{2})(?:\s*(?:ea|each|\/ea))?/i;
const QTY_WORD = /\bqty\.?\s*[:#]?\s*(\d+)\b/i;

const SUBTOTAL = /\bsub[\s-]?total\b/i;
const TAX = /\b(?:sales\s*)?tax\b|\bhst\b|\bgst\b|\bvat\b/i;
const TOTAL = /\b(?:grand\s*)?total\b|\bbalance(?:\s*due)?\b|\bamount\s*due\b|\btotal\s*due\b/i;
const NOT_ITEM = /\b(?:sub[\s-]?total|total|tax|change\s*due|balance|amount\s*due|you\s*saved|total\s*savings|savings\s*total|items?\s*sold|#\s*items|number\s*of\s*items|rounding|refund\s*total|refund\s*due|total\s*refund|credit\s*due|store\s*credit\s*issued)\b/i;
// A tender line is a payment word followed only by card/amount noise
// ("VISA 102.96", "MC: 43.57", "CASH TEND"); "CHECK VALVE" is an item.
const TENDER = /^\s*(?:visa|mc|master\s*card|amex|american\s*express|discover|debit|credit|ebt|gift\s*card|cash|check|change|tender(?:ed)?|tend|payment|paid|tip|gratuity)\b(?:[\s:#*xX$\d-]|\b(?:usd|card|due|sale|purchase|refund|tend(?:ered)?|amount|amt)\b)*$/i;
const DISCOUNT = /^\s*(?:discount|savings|coupon|instant\s*savings|markdown|promo|price\s*adj(?:ustment)?|mfr\s*coupon|mil(?:itary)?\s*disc(?:ount)?|employee\s*disc(?:ount)?)\b/i;
export const RETURN_WORDS = /\b(?:returns?|returned|refund(?:ed)?|merchandise\s*credit|store\s*credit|exchange|rtn|ret\b)/i;

export function parseMoney(s) {
  if (s == null || s === '') return null;
  const n = Number(String(s).replace(/[$\s]/g, '').replace(/,(\d{2})$/, '.$1').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function priceAtEnd(line) {
  const m = line.match(PRICE_AT_END);
  if (!m) return null;
  const amount = parseMoney(m[3]);
  if (amount == null) return null;
  const negative = Boolean(m[1] || m[2] || m[4]);
  return { amount: negative ? -amount : amount, index: m.index };
}

function cleanDescription(desc) {
  let sku = '';
  let d = desc;
  // Leading or trailing SKU/UPC (6-14 digits) → sku.
  const lead = d.match(/^\s*(\d{6,14})\b/);
  if (lead) { sku = lead[1]; d = d.slice(lead[0].length); }
  const trail = d.match(/\b(\d{6,14})\s*$/);
  if (trail) { sku = sku || trail[1]; d = d.slice(0, trail.index); }
  d = d
    .replace(/<[A-Z]>/g, ' ')
    .replace(/\s+[A-Z]\s*$/, '')
    .replace(/[|_~`]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s.:*#-]+|[\s.:*#-]+$/g, '')
    .trim();
  return { desc: d, sku };
}

/**
 * Parses redacted receipt text.
 * @param {string} text redacted text (one receipt line per line)
 * @param {{rawStoreHint?: string}} opts
 */
export function parseReceipt(text, opts = {}) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
  const store = opts.rawStoreHint || detectStore(lines);
  const date = detectDate(lines.filter((l) => !l.startsWith(REDACTED)).join('\n'));
  let subtotal = null, tax = null, total = null;
  const items = [];
  let pendingQty = null;
  let returnHits = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith(REDACTED)) continue;
    if (RETURN_WORDS.test(line)) returnHits++;

    // A bare quantity line ("2 @ 5.98" with no extended price) applies to
    // the item above it when that item's price is the extended price,
    // otherwise to the next item (Walmart prints it first).
    const bare = line.match(QTY_AT);
    if (bare && line.replace(bare[0], '').replace(/[\s$]/g, '').length === 0) {
      const qty = Number(bare[1]), unit = parseMoney(bare[2]);
      const prev = items[items.length - 1];
      if (prev && prev.qty === 1 && Math.abs(prev.total - unit * qty) < 0.02) {
        prev.qty = qty; prev.unitPrice = unit;
      } else pendingQty = { qty, unit };
      continue;
    }

    const price = priceAtEnd(line);
    if (!price) continue;

    const before = line.slice(0, price.index).trim();
    if (SUBTOTAL.test(before)) { subtotal = Math.abs(price.amount); continue; }
    if (TAX.test(before) && !/\btax\s*exempt\b/i.test(before)) { tax = round2((tax || 0) + Math.abs(price.amount)); continue; }
    if (TOTAL.test(before) && !/\bsavings\b/i.test(before)) { if (total == null) total = Math.abs(price.amount); continue; }
    if (NOT_ITEM.test(before) || TENDER.test(before)) continue;

    if (DISCOUNT.test(before) || (/^\s*(?:\S+\s+)?(?:off|disc(?:ount)?|savings)\b/i.test(before) && price.amount < 0)) {
      const prev = items[items.length - 1];
      if (prev) {
        prev.discount = round2((prev.discount || 0) + Math.abs(price.amount));
        prev.total = round2(prev.total - Math.abs(price.amount));
      }
      continue;
    }

    // Quantity printed on the price line: "PVC TEE 4 @ 3.76 15.04".
    let qty = 1, unit = null, descPart = before;
    const q = before.match(QTY_AT);
    if (q) {
      qty = Number(q[1]); unit = parseMoney(q[2]);
      descPart = (before.slice(0, q.index) + ' ' + before.slice(q.index + q[0].length)).trim();
    } else {
      const qw = before.match(QTY_WORD);
      if (qw) { qty = Number(qw[1]); descPart = before.replace(qw[0], ' '); }
    }

    // A line that is only a quantity and an extended price ("2 @ 5.98  11.96")
    // completes the item above it (Lowe's prints quantity under the item).
    const { desc, sku } = cleanDescription(descPart);
    const amount = price.amount;
    if (!/[a-z]{2,}/i.test(desc)) {
      const prev = items[items.length - 1];
      if (prev && q) {
        prev.qty = qty; prev.unitPrice = unit ?? round2(Math.abs(amount) / qty); prev.total = round2(Math.abs(amount));
        if (amount < 0) prev.negative = true;
      }
      continue;
    }
    if (pendingQty && !q) {
      if (Math.abs(pendingQty.qty * pendingQty.unit - Math.abs(amount)) < 0.02) { qty = pendingQty.qty; unit = pendingQty.unit; }
      pendingQty = null;
    }
    const abs = Math.abs(amount);
    items.push({
      desc,
      sku,
      qty,
      unitPrice: unit ?? round2(abs / qty),
      total: round2(abs),
      negative: amount < 0,
    });
  }

  const negatives = items.filter((i) => i.negative).length;
  const isReturn = returnHits > 0 && (negatives > 0 || /\b(?:refund|return(?:ed)?\s+(?:items?|merchandise|receipt)|merchandise\s+return)\b/i.test(text))
    || (items.length > 0 && negatives >= Math.ceil(items.length / 2));

  for (const i of items) delete i.negative;
  const itemsSum = round2(items.reduce((s, i) => s + i.total, 0));
  return { store, date, subtotal, tax, total, items, itemsSum, isReturn };
}

/** Sanity checks shown to the user next to the parsed receipt. */
export function checkTotals(r) {
  const warnings = [];
  const sum = round2(r.items.reduce((s, i) => s + (Number(i.total) || 0), 0));
  if (r.subtotal != null && Math.abs(sum - r.subtotal) > 0.02) {
    warnings.push(`Items add up to $${sum.toFixed(2)} but the receipt subtotal is $${Number(r.subtotal).toFixed(2)}. Check for a missed or misread line.`);
  }
  if (r.subtotal != null && r.tax != null && r.total != null && Math.abs(r.subtotal + r.tax - r.total) > 0.02) {
    warnings.push(`Subtotal + tax ($${round2(r.subtotal + r.tax).toFixed(2)}) doesn't match the total ($${Number(r.total).toFixed(2)}).`);
  }
  for (const i of r.items) {
    if (Math.abs(i.qty * i.unitPrice - i.total - (i.discount || 0)) > 0.02) warnings.push(`"${i.desc}": ${i.qty} × $${Number(i.unitPrice).toFixed(2)} ≠ $${Number(i.total).toFixed(2)}.`);
  }
  return warnings;
}
