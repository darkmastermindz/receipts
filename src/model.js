// Receipt/item model, the per-shop summary, and matching a return receipt
// against purchases.

import { round2, storeKey, canonicalStore } from './parse.js';

export const STATUS = {
  consumed: 'consumed', // kept / used in the build
  return: 'return', // planned: take it back
  returned: 'returned', // taken back (verified when matched to a return receipt)
};

export const uid = () =>
  (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

export function newItem(fields = {}) {
  const qty = Number(fields.qty) || 1;
  const unitPrice = round2(fields.unitPrice ?? (fields.total != null ? fields.total / qty : 0));
  return {
    id: uid(),
    desc: fields.desc || '',
    sku: fields.sku || '',
    qty,
    unitPrice,
    total: round2(fields.total ?? unitPrice * qty),
    discount: fields.discount || 0,
    status: fields.status || STATUS.consumed,
    returnQty: fields.returnQty ?? qty,
    refund: fields.refund ?? null, // actual refund from the return receipt
    verifiedQty: fields.verifiedQty || 0,
    verifiedBy: fields.verifiedBy || [], // return receipt ids
  };
}

export function newReceipt(fields = {}) {
  return {
    id: uid(),
    kind: fields.kind || 'purchase', // 'purchase' | 'return'
    store: canonicalStore(fields.store || ''),
    date: fields.date || '',
    subtotal: fields.subtotal ?? null,
    tax: fields.tax ?? null,
    total: fields.total ?? null,
    items: (fields.items || []).map(newItem),
    lines: fields.lines || [], // return receipts: [{desc, sku, qty, amount, match}]
    notes: fields.notes || '',
    source: fields.source || 'manual',
    redactions: fields.redactions || 0,
    image: fields.image || null, // redacted, metadata-free JPEG Blob
    createdAt: fields.createdAt || new Date().toISOString(),
  };
}

/** Unit price paid after discount. */
const effUnit = (it) => (it.qty ? it.total / it.qty : 0);

/** Tax multiplier for a purchase receipt (1 when unknown). */
export function taxFactor(r) {
  if (r.tax != null && r.subtotal) return 1 + r.tax / r.subtotal;
  if (r.tax != null && r.total && r.total > r.tax) return r.total / (r.total - r.tax);
  return 1;
}

/** Splits one item's cost into consumed / to-return / returned dollars. */
export function itemBreakdown(it) {
  const total = Number(it.total) || 0;
  const rq = Math.min(Number(it.returnQty) || 0, it.qty);
  const backValue = round2(effUnit(it) * rq);
  if (it.status === STATUS.return) return { spent: total, consumed: round2(total - backValue), pending: backValue, returned: 0, refunded: 0 };
  if (it.status === STATUS.returned) {
    const refunded = it.refund != null ? Number(it.refund) : backValue;
    return { spent: total, consumed: round2(total - backValue), pending: 0, returned: backValue, refunded: round2(refunded) };
  }
  return { spent: total, consumed: total, pending: 0, returned: 0, refunded: 0 };
}

/**
 * Per-shop totals. Amounts are pre-tax item prices unless withTax, which
 * scales each receipt's items by that receipt's tax rate.
 */
export function summarize(receipts, { withTax = false } = {}) {
  const shops = new Map();
  const blank = (name) => ({ name, key: storeKey(name), receipts: 0, returns: 0, spent: 0, consumed: 0, pending: 0, returned: 0, refunded: 0, verified: 0, unverified: 0, pendingCount: 0, net: 0 });
  for (const r of receipts) {
    const name = canonicalStore(r.store) || 'Unknown shop';
    const key = storeKey(name);
    if (!shops.has(key)) shops.set(key, blank(name));
    const s = shops.get(key);
    if (r.kind === 'return') { s.returns++; continue; }
    s.receipts++;
    const f = withTax ? taxFactor(r) : 1;
    for (const it of r.items) {
      const b = itemBreakdown(it);
      s.spent += b.spent * f;
      s.consumed += b.consumed * f;
      s.pending += b.pending * f;
      s.returned += b.returned * f;
      // A verified refund is the actual amount from the return receipt, which
      // already includes tax when the store refunded it, so it isn't scaled.
      s.refunded += it.refund != null ? b.refunded : b.refunded * f;
      if (it.status === STATUS.return) s.pendingCount++;
      if (it.status === STATUS.returned) (it.verifiedQty > 0 ? s.verified++ : s.unverified++);
    }
  }
  const list = [...shops.values()].map((s) => {
    for (const k of ['spent', 'consumed', 'pending', 'returned', 'refunded']) s[k] = round2(s[k]);
    s.net = round2(s.spent - s.refunded);
    return s;
  });
  list.sort((a, b) => b.spent - a.spent);
  const totals = list.reduce((t, s) => {
    for (const k of ['spent', 'consumed', 'pending', 'returned', 'refunded', 'net', 'verified', 'unverified', 'pendingCount']) t[k] = round2((t[k] || 0) + s[k]);
    return t;
  }, {});
  return { shops: list, totals };
}

// ---- Matching a return receipt to purchases --------------------------------

const STOP = new Set(['in', 'x', 'ft', 'the', 'and', 'with', 'for', 'of', 'a', 'pk', 'pack', 'ea', 'oz']);
function tokens(s) {
  return new Set(String(s || '').toLowerCase().replace(/(\d)\s*-\s*(\d)/g, '$1-$2').split(/[^a-z0-9/.-]+/).filter((t) => t && !STOP.has(t)));
}
export function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}

function remainingQty(it) {
  return it.qty - (it.verifiedQty || 0);
}

/**
 * Proposes a purchase item for each line of a return receipt.
 * lines: [{desc, sku, qty, amount}] where amount is the refund for the line.
 * Returns [{line, receiptId, itemId, score, expected, delta}] (receiptId null
 * when nothing fits).
 */
export function matchReturn(returnReceipt, purchases) {
  const key = storeKey(returnReceipt.store);
  const pool = [];
  for (const r of purchases) {
    if (r.kind !== 'purchase') continue;
    if (returnReceipt.store && storeKey(r.store) !== key) continue;
    for (const it of r.items) if (remainingQty(it) > 0) pool.push({ r, it, left: remainingQty(it) });
  }

  const candidates = [];
  returnReceipt.lines.forEach((line, li) => {
    const qty = Number(line.qty) || 1;
    const unitRefund = Math.abs(Number(line.amount) || 0) / qty;
    for (const p of pool) {
      let score = 0;
      if (line.sku && p.it.sku && line.sku === p.it.sku) score += 100;
      const unit = effUnit(p.it);
      if (Math.abs(unit - unitRefund) < 0.015) score += 50;
      else if (unit > 0 && Math.abs(unit - unitRefund) / unit < 0.1) score += 20;
      score += 40 * similarity(line.desc, p.it.desc);
      if (p.it.status === STATUS.return) score += 10;
      if (returnReceipt.date && p.r.date && p.r.date > returnReceipt.date) score -= 100;
      if (score >= 35) candidates.push({ li, p, score });
    }
  });
  candidates.sort((a, b) => b.score - a.score);

  const result = returnReceipt.lines.map((line) => ({ line, receiptId: null, itemId: null, score: 0, expected: null, delta: null }));
  for (const c of candidates) {
    const res = result[c.li];
    if (res.receiptId) continue;
    const qty = Number(res.line.qty) || 1;
    if (c.p.left < qty) continue;
    c.p.left -= qty;
    const expected = round2(effUnit(c.p.it) * qty);
    Object.assign(res, { receiptId: c.p.r.id, itemId: c.p.it.id, score: Math.round(c.score), expected, delta: round2(Math.abs(Number(res.line.amount) || 0) - expected) });
  }
  return result;
}

/**
 * Applies confirmed matches: the matched purchase items become returned and
 * verified, with the refund recorded. Mutates and returns the touched
 * purchase receipts.
 */
export function applyReturn(returnReceipt, matches, purchases) {
  const byId = new Map(purchases.map((r) => [r.id, r]));
  const touched = new Set();
  for (const m of matches) {
    if (!m.receiptId || !m.itemId) continue;
    const r = byId.get(m.receiptId);
    const it = r?.items.find((i) => i.id === m.itemId);
    if (!it) continue;
    const qty = Number(m.line.qty) || 1;
    // Remember what the item was before its first verification so deleting
    // the return receipt can put it back.
    if (!it.verifiedBy.length) it.before = { status: it.status, returnQty: it.returnQty };
    it.verifiedQty = Math.min(it.qty, (it.verifiedQty || 0) + qty);
    it.returnQty = Math.max(it.verifiedQty, it.status !== STATUS.consumed ? it.returnQty : 0);
    it.status = STATUS.returned;
    it.refund = round2((it.verifiedBy.length ? Number(it.refund) || 0 : 0) + Math.abs(Number(m.line.amount) || 0));
    if (!it.verifiedBy.includes(returnReceipt.id)) it.verifiedBy.push(returnReceipt.id);
    touched.add(r);
  }
  returnReceipt.lines = returnReceipt.lines.map((line, i) => ({ ...line, match: matches[i]?.itemId ? { receiptId: matches[i].receiptId, itemId: matches[i].itemId } : null }));
  return [...touched];
}

/** Undo a return receipt's verification (when it is deleted). */
export function unapplyReturn(returnReceipt, purchases) {
  const touched = new Set();
  for (const line of returnReceipt.lines) {
    if (!line.match) continue;
    const r = purchases.find((p) => p.id === line.match.receiptId);
    const it = r?.items.find((i) => i.id === line.match.itemId);
    if (!it) continue;
    const qty = Number(line.qty) || 1;
    it.verifiedQty = Math.max(0, (it.verifiedQty || 0) - qty);
    it.refund = it.refund != null ? round2(Math.max(0, it.refund - Math.abs(Number(line.amount) || 0))) : null;
    it.verifiedBy = it.verifiedBy.filter((id) => id !== returnReceipt.id);
    if (!it.verifiedBy.length) {
      it.refund = null;
      it.status = it.before?.status ?? STATUS.return;
      if (it.before) it.returnQty = it.before.returnQty;
      delete it.before;
    }
    touched.add(r);
  }
  return [...touched];
}

export function toCSV(receipts) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [['shop', 'date', 'description', 'sku', 'qty', 'unit_price', 'total', 'status', 'return_qty', 'refund', 'verified']];
  for (const r of receipts) {
    if (r.kind !== 'purchase') continue;
    for (const it of r.items) rows.push([r.store, r.date, it.desc, it.sku, it.qty, it.unitPrice, it.total, it.status, it.status === 'consumed' ? 0 : it.returnQty, it.refund ?? '', it.verifiedQty > 0 ? 'yes' : 'no']);
  }
  return rows.map((row) => row.map(esc).join(',')).join('\n');
}
