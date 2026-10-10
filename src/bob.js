// Imports the receipts the BOB team already recorded in the bob repo
// (data/build.json → receipts) so returns can be tracked against them.

import { newReceipt } from './model.js';
import { canonicalStore, storeKey, round2 } from './parse.js';

export const bobKey = (r) => `bob|${storeKey(r.store)}|${r.date}|${r.lines?.length ?? r.items?.length}`;

/** Converts build.json-style receipts ({store, date, lines: [[desc, qty, unit]]}). */
export function fromBuildJson(json) {
  const list = Array.isArray(json) ? json : json.receipts || [];
  return list.map((r) => {
    const rec = newReceipt({
      store: canonicalStore(r.store),
      date: r.date || '',
      subtotal: r.subtotal_usd ?? null,
      tax: r.tax_usd ?? null,
      total: r.total_usd ?? null,
      source: 'bob',
      items: (r.lines || []).map(([desc, qty, unit]) => ({
        desc,
        qty: qty || 1,
        unitPrice: unit ?? 0,
        total: round2((unit ?? 0) * (qty || 1)),
      })),
      notes: (r.lines || []).some((l) => l[2] == null) ? 'Some prices were not recorded in the BOB build file; fill them in.' : '',
    });
    rec.bobKey = bobKey(r);
    return rec;
  });
}

/** Returns only the receipts not already imported. */
export function newOnly(incoming, existing) {
  const have = new Set(existing.map((r) => r.bobKey).filter(Boolean));
  return incoming.filter((r) => !have.has(r.bobKey));
}
