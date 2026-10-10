import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLine, luhnValid, redactText } from '../src/pii.js';

test('flags payment, contact and address lines', () => {
  const pii = [
    'VISA ************1234',
    'XXXX XXXX XXXX 9876',
    'Card #: 4111 1111 1111 1111',
    '4111-1111-1111-1111',
    'AUTH CODE: 0A1B2C',
    'APPROVAL # 123456',
    'AID: A0000000041010',
    'Entry Method: Contactless',
    'Cardholder signature',
    '(704) 555-0199',
    '704.555.0199',
    'jane.doe@example.com',
    '123 Main Street',
    '4510 N Tryon St',
    'Charlotte, NC 28206',
    'PO Box 42',
    'Cashier: Pat',
    'Your server: Sam',
    'Member #: 99887766',
    "MyLowe's # 1234567890",
  ];
  for (const line of pii) assert.ok(classifyLine(line).length, `should flag: ${line}`);
});

test('keeps item, total and store lines', () => {
  const clean = [
    'THE HOME DEPOT',
    "LOWE'S HOME CENTERS, LLC",
    '1-1/2" DWV SANI TEE <A> 4@3.76 15.04',
    '5 Way PVC Fittings 1-1/2", 4-pack 22.46',
    'BATTERY AA 4 CT 5.98',
    '2 in x 4 ft x 8 ft insulation board 59.98',
    'PAINT GLOSS BK 12345 7.48',
    '076174507132 DWV TEE 3.76',
    'SUBTOTAL 96.00',
    'TOTAL 102.96',
    '10/01/26 02:14 PM',
  ];
  for (const line of clean) assert.deepEqual(classifyLine(line), [], `should keep: ${line}`);
});

test('luhn', () => {
  assert.equal(luhnValid('4111111111111111'), true);
  assert.equal(luhnValid('4111111111111112'), false);
});

test('redactText replaces flagged lines and counts them', () => {
  const r = redactText('HOME DEPOT\n123 Main St\nTEE 3.76\nVISA ****1234');
  assert.equal(r.count, 2);
  assert.equal(r.lines[0], 'HOME DEPOT');
  assert.match(r.lines[1], /^\[redacted\] \(address\)/);
  assert.equal(r.lines[2], 'TEE 3.76');
});
