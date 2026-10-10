import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newReceipt, summarize, matchReturn, applyReturn, unapplyReturn, itemBreakdown, toCSV, STATUS } from '../src/model.js';

function fixture() {
  const hd = newReceipt({
    store: 'The Home Depot', date: '2026-10-01', subtotal: 100, tax: 7, total: 107,
    items: [
      { desc: '1-1/2" DWV SANI TEE', sku: '076174507132', qty: 4, unitPrice: 3.76, total: 15.04 },
      { desc: '1-1/2" X 10\' PVC40-DWV PE', sku: '611942084839', qty: 5, unitPrice: 11.96, total: 59.8 },
      { desc: 'HEAVY DUTY CABLE TIE 36IN', qty: 1, unitPrice: 25.16, total: 25.16 },
    ],
  });
  const lw = newReceipt({ store: "LOWE'S", date: '2026-10-03', items: [{ desc: 'INSULATION BOARD 2IN', qty: 1, total: 59.98 }] });
  return { hd, lw };
}

test('breakdown splits consumed / pending / returned', () => {
  const { hd } = fixture();
  hd.items[0].status = STATUS.return; hd.items[0].returnQty = 2;
  assert.deepEqual(itemBreakdown(hd.items[0]), { spent: 15.04, consumed: 7.52, pending: 7.52, returned: 0, refunded: 0 });
  hd.items[0].status = STATUS.returned;
  assert.equal(itemBreakdown(hd.items[0]).returned, 7.52);
});

test('summary groups by shop with and without tax', () => {
  const { hd, lw } = fixture();
  hd.items[1].status = STATUS.return; hd.items[1].returnQty = 1;
  lw.items[0].status = STATUS.returned;
  const s = summarize([hd, lw]);
  const homeDepot = s.shops.find((x) => x.name === 'Home Depot');
  const lowes = s.shops.find((x) => x.name === "Lowe's");
  assert.equal(homeDepot.spent, 100);
  assert.equal(homeDepot.pending, 11.96);
  assert.equal(homeDepot.consumed, 88.04);
  assert.equal(lowes.returned, 59.98);
  assert.equal(lowes.unverified, 1);
  assert.equal(lowes.net, 0);
  assert.equal(s.totals.spent, 159.98);
  const t = summarize([hd, lw], { withTax: true });
  assert.equal(t.shops.find((x) => x.name === 'Home Depot').spent, 107);
});

test('return receipt matches by sku/price and verifies items', () => {
  const { hd, lw } = fixture();
  hd.items[0].status = STATUS.return; hd.items[0].returnQty = 2;
  const ret = newReceipt({
    kind: 'return', store: 'HOME DEPOT', date: '2026-10-12',
    lines: [
      { desc: 'DWV SANI TEE', sku: '076174507132', qty: 2, amount: 7.52 },
      { desc: 'PVC40 DWV PE PIPE', sku: '', qty: 1, amount: 11.96 },
      { desc: 'SOMETHING ELSE', sku: '', qty: 1, amount: 3.33 },
    ],
  });
  const m = matchReturn(ret, [hd, lw]);
  assert.equal(m[0].itemId, hd.items[0].id);
  assert.equal(m[0].delta, 0);
  assert.equal(m[1].itemId, hd.items[1].id);
  assert.equal(m[2].itemId, null);

  applyReturn(ret, m, [hd, lw]);
  assert.equal(hd.items[0].status, STATUS.returned);
  assert.equal(hd.items[0].verifiedQty, 2);
  assert.equal(hd.items[0].refund, 7.52);
  assert.equal(hd.items[1].status, STATUS.returned);
  assert.equal(hd.items[1].returnQty, 1, 'only the returned quantity');
  const s = summarize([hd, lw, ret]).shops.find((x) => x.name === 'Home Depot');
  assert.equal(s.returns, 1);
  assert.equal(s.verified, 2);
  assert.equal(s.refunded, 19.48);

  unapplyReturn(ret, [hd, lw]);
  assert.equal(hd.items[0].status, STATUS.return);
  assert.equal(hd.items[0].verifiedQty, 0);
  assert.equal(hd.items[0].refund, null);
});

test('deleting a return receipt restores the previous status', () => {
  const { hd } = fixture();
  const ret = newReceipt({ kind: 'return', store: 'Home Depot', lines: [{ desc: 'HEAVY DUTY CABLE TIE 36IN', qty: 1, amount: 25.16 }] });
  const m = matchReturn(ret, [hd]);
  assert.equal(m[0].itemId, hd.items[2].id);
  assert.equal(hd.items[2].status, STATUS.consumed);
  applyReturn(ret, m, [hd]);
  assert.equal(hd.items[2].status, STATUS.returned);
  unapplyReturn(ret, [hd]);
  assert.equal(hd.items[2].status, STATUS.consumed, 'back to consumed, not "to return"');
  assert.equal(hd.items[2].returnQty, 1);
  assert.equal(hd.items[2].before, undefined);
});

test('returns never match another shop', () => {
  const { hd, lw } = fixture();
  const ret = newReceipt({ kind: 'return', store: 'Home Depot', lines: [{ desc: 'INSULATION BOARD 2IN', qty: 1, amount: 59.98 }] });
  assert.equal(matchReturn(ret, [hd, lw])[0].itemId, null);
});

test('csv export', () => {
  const { hd } = fixture();
  const csv = toCSV([hd]);
  assert.match(csv.split('\n')[1], /^Home Depot,2026-10-01,"1-1\/2"" DWV SANI TEE",076174507132,4,3.76,15.04,consumed,0,,no$/);
});
