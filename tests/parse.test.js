import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReceipt, detectDate, storeKey, checkTotals } from '../src/parse.js';
import { redactText } from '../src/pii.js';

const HOME_DEPOT = `THE HOME DEPOT
1234 Fake Ridge Rd
Charlotte, NC 28277 (704) 555-0123
4521 00041 52718 10/01/26 02:14 PM
SALE SELF CHECKOUT
076174507132 1-1/2" DWV SANI TEE <A> 4@3.76 15.04
076174507156 DWV 45 ELBOW HXH <A> 5@2.56 12.80
611942084839 1-1/2" X 10' PVC40-DWV PE 5@11.96 59.80
070798182329 DWV HUB CAP <A> 4@2.09 8.36
SUBTOTAL 96.00
SALES TAX 6.96
TOTAL $102.96
XXXXXXXXXXXX4321 VISA USD$ 102.96
AUTH CODE 012345/1234567 TA
Chip Read
AID A0000000031010 VISA CREDIT
`;

test('parses Home Depot items with inline quantities and drops PII', () => {
  const red = redactText(HOME_DEPOT);
  assert.ok(red.count >= 5, `expected PII lines, got ${red.count}`);
  assert.doesNotMatch(red.text, /4321|Fake Ridge|555-0123|012345|A0000000031010|28277/);
  const r = parseReceipt(red.text);
  assert.equal(r.store, 'Home Depot');
  assert.equal(r.date, '2026-10-01');
  assert.equal(r.subtotal, 96);
  assert.equal(r.tax, 6.96);
  assert.equal(r.total, 102.96);
  assert.equal(r.items.length, 4);
  assert.deepEqual(r.items[0], { desc: '1-1/2" DWV SANI TEE', sku: '076174507132', qty: 4, unitPrice: 3.76, total: 15.04 });
  assert.equal(r.items[2].qty, 5);
  assert.equal(r.items[2].unitPrice, 11.96);
  assert.equal(r.isReturn, false);
  assert.deepEqual(checkTotals(r), []);
});

const LOWES = `LOWE'S HOME CENTERS, LLC
999 MADE UP BLVD
CHARLOTTE, NC 28202
SALE
SALES #: S0123 1234567 TRANS #: 9876543 10-03-26
5023883 KRYLON FUSION 12OZ MATTE RED 7.48
1187654 RUST-OLEUM TEXTURED STONE 23.96
  2 @ 11.98
22134 OATEY 16OZ PVC CEMENT 10.28
INSTANT SAVINGS -1.00
SUBTOTAL: 40.72
TAX: 2.85
INVOICE 12345 TOTAL: 43.57
MC: 43.57
MASTERCARD ************9876
CUSTOMER COPY
MYLOWE'S # 1234567890
`;

test("parses Lowe's quantity-under-item lines and discounts", () => {
  const red = redactText(LOWES);
  assert.doesNotMatch(red.text, /\*{4,}9876|MADE UP|28202|1234567890/);
  const r = parseReceipt(red.text);
  assert.equal(r.store, "Lowe's");
  assert.equal(r.date, '2026-10-03');
  assert.equal(r.items.length, 3);
  assert.equal(r.items[1].qty, 2);
  assert.equal(r.items[1].unitPrice, 11.98);
  assert.equal(r.items[2].total, 9.28, 'instant savings applied to the item above');
  assert.equal(r.items[2].discount, 1);
  assert.equal(r.subtotal, 40.72);
  assert.equal(r.total, 43.57);
});

const RETURN = `THE HOME DEPOT
1234 Fake Ridge Rd
REFUND
10/12/26 09:01 AM
076174507132 1-1/2" DWV SANI TEE <A> 2@3.76 7.52-
611942084839 1-1/2" X 10' PVC40-DWV PE 11.96-
SUBTOTAL -19.48
SALES TAX -1.41
TOTAL -20.89
VISA REFUND ************4321
`;

test('detects a return receipt and reads refund lines', () => {
  const r = parseReceipt(redactText(RETURN).text);
  assert.equal(r.isReturn, true);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].qty, 2);
  assert.equal(r.items[0].total, 7.52);
  assert.equal(r.items[1].total, 11.96);
  assert.equal(r.total, 20.89);
});

test('walmart style quantity line before the item', () => {
  const r = parseReceipt(`WALMART\n2 AT 1 FOR 3.58\nPOOL NOODLE 007123456789 7.16 N\nTOTAL 7.16`);
  assert.equal(r.store, 'Walmart');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].qty, 2);
  assert.equal(r.items[0].unitPrice, 3.58);
});

test('dates and store keys', () => {
  assert.equal(detectDate('10/05/2026'), '2026-10-05');
  assert.equal(detectDate('Oct 3, 2026'), '2026-10-03');
  assert.equal(detectDate('2026-10-01T10:00'), '2026-10-01');
  assert.equal(storeKey("LOWE'S #1234"), storeKey('Lowes'));
  assert.equal(storeKey('The Home Depot'), storeKey('HOME DEPOT #4521'));
});
