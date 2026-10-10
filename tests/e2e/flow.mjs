// End-to-end check in Chromium: scan a purchase receipt photo (with fake GPS
// EXIF, card number and address), confirm items are read, PII is not stored
// and metadata is gone; then verify a return receipt against it.
// Usage: npm run build && node scripts/serve.js & node tests/e2e/flow.mjs
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/node-tools/node_modules/playwright'); }
const { chromium } = pw;

const BASE = process.env.BASE || 'http://localhost:8080/';
const OUT = process.env.OUT || 'tests/e2e/out';
mkdirSync(OUT, { recursive: true });

const receiptHtml = (lines) => `<html><body style="margin:0;background:#fff"><pre style="font:22px/1.5 'DejaVu Sans Mono',monospace;padding:30px 40px;width:640px;color:#111">${lines.join('\n')}</pre></body></html>`;

const PURCHASE = [
  '        THE HOME DEPOT',
  '     1234 Fake Ridge Rd',
  '   Charlotte, NC 28277',
  '      (704) 555-0123',
  '',
  '10/01/26  02:14 PM',
  '',
  '076174507132 DWV SANI TEE    15.04',
  '      4 @ 3.76',
  '611942084839 PVC PIPE 10FT   59.80',
  '      5 @ 11.96',
  '070798182329 DWV HUB CAP      8.36',
  '      4 @ 2.09',
  '',
  'SUBTOTAL                     83.20',
  'SALES TAX                     6.03',
  'TOTAL                       $89.23',
  '',
  'XXXXXXXXXXXX4321 VISA',
  'AUTH CODE 012345',
  'Cashier: Jordan',
];
const RETURN = [
  '        THE HOME DEPOT',
  '     1234 Fake Ridge Rd',
  '          REFUND',
  '10/12/26  09:01 AM',
  '',
  '076174507132 DWV SANI TEE     7.52-',
  '      2 @ 3.76',
  '611942084839 PVC PIPE 10FT   11.96-',
  '',
  'SUBTOTAL                    -19.48',
  'TOTAL                       -20.93',
  'VISA REFUND XXXXXXXXXXXX4321',
];

function addExif(jpeg) {
  const payload = Buffer.from('Exif\0\0GPSLatitude 35.2271 N GPSLongitude 80.8431 W Pixel 9 Pro');
  const len = payload.length + 2;
  const seg = Buffer.concat([Buffer.from([0xff, 0xe1, len >> 8, len & 0xff]), payload]);
  return Buffer.concat([jpeg.subarray(0, 2), seg, jpeg.subarray(2)]);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

async function photo(lines, name) {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 720, height: 40 + lines.length * 33 + 60 });
  await p.setContent(receiptHtml(lines));
  const jpg = addExif(await p.screenshot({ type: 'jpeg', quality: 92 }));
  await p.close();
  const path = `${OUT}/${name}.jpg`;
  writeFileSync(path, jpg);
  return path;
}

const check = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok -', msg); };

await page.goto(BASE);
await page.waitForSelector('text=No receipts yet');
await page.screenshot({ path: `${OUT}/0-empty.png` });

// Purchase
await page.goto(BASE + '#/add/purchase');
const p1 = await photo(PURCHASE, 'purchase');
await page.locator('input[type=file]:not([capture])').setInputFiles(p1);
await page.waitForSelector('text=Save receipt', { timeout: 120000 });
await page.screenshot({ path: `${OUT}/1-review.png`, fullPage: true });
const descs = await page.$$eval('.item .desc', (els) => els.map((e) => e.value));
console.log('items:', descs);
check(descs.length === 3, 'three line items read from the photo');
const chips = await page.textContent('.privacy-chips');
console.log('privacy:', chips);
check(/EXIF/.test(chips), 'EXIF metadata detected and removed');
check(/Redacted [3-9] lines/.test(chips), 'PII lines redacted');
const ocr = await page.textContent('details pre');
check(!/4321|Fake Ridge|28277|555-0123|012345|Jordan/.test(ocr), 'OCR text shown has no PII');
// Mark pipe as "To return", 1 of 5; tees to return 2 of 4.
const items = page.locator('.item');
await items.nth(0).locator('button', { hasText: 'To return' }).click();
await page.locator('.item').nth(0).locator('.rq input').fill('2');
await page.locator('.item').nth(0).locator('.rq input').dispatchEvent('change');
await page.locator('.item').nth(1).locator('button', { hasText: 'To return' }).click();
await page.locator('.item').nth(1).locator('.rq input').fill('1');
await page.locator('.item').nth(1).locator('.rq input').dispatchEvent('change');
await page.click('text=Save receipt');
await page.waitForSelector('text=Line items');

// Stored data check
const stored = await page.evaluate(async () => {
  const db = await new Promise((r) => { const q = indexedDB.open('receipts'); q.onsuccess = () => r(q.result); });
  const all = await new Promise((r) => { const q = db.transaction('receipts').objectStore('receipts').getAll(); q.onsuccess = () => r(q.result); });
  const rec = all[0];
  const bytes = rec.image ? [...new Uint8Array(await rec.image.arrayBuffer())] : [];
  const { image, ...rest } = rec;
  return { json: JSON.stringify(rest), bytes, rec: rest };
});
check(!/4321|Fake Ridge|28277|555|012345|Jordan|VISA/i.test(stored.json), 'stored record has no PII');
const imgStr = Buffer.from(stored.bytes).toString('latin1');
check(stored.bytes.length > 1000 && !/Exif|GPS|Pixel/.test(imgStr), 'stored image has no EXIF/GPS');
check(!stored.bytes.slice(2, 40).some((b, i, a) => b === 0xff && a[i + 1] === 0xe1), 'no APP1 segment in stored JPEG');
console.log('items stored:', stored.rec.items.map((i) => [i.desc, i.qty, i.total, i.status, i.returnQty].join(' ')));
console.log('stored:', stored.rec.store, stored.rec.date, stored.rec.subtotal, stored.rec.tax, stored.rec.total);

await page.goto(BASE + '#/');
await page.waitForSelector('.shop');
await page.screenshot({ path: `${OUT}/2-summary.png`, fullPage: true });
const pending = await page.textContent('.kpi.pending strong');
check(pending === '$19.48', `to-return total is $19.48 (got ${pending})`);

await page.goto(BASE + '#/todo');
await page.waitForSelector('text=Verify with return receipt');
await page.screenshot({ path: `${OUT}/3-todo.png`, fullPage: true });

// Return receipt
await page.click('text=Verify with return receipt');
const p2 = await photo(RETURN, 'return');
await page.locator('input[type=file]:not([capture])').setInputFiles(p2);
await page.waitForSelector('text=Save & verify', { timeout: 120000 });
await page.screenshot({ path: `${OUT}/4-return-review.png`, fullPage: true });
const verdicts = await page.$$eval('.match .badge', (els) => els.map((e) => e.textContent));
console.log('verdicts:', verdicts);
check(verdicts.length === 2 && verdicts.every((v) => v.includes('refund matches')), 'both return lines matched with refunds equal to paid price');
await page.click('text=Save & verify');
await page.waitForSelector('text=Return');
await page.goto(BASE + '#/');
await page.waitForSelector('.shop');
await page.screenshot({ path: `${OUT}/5-summary-after.png`, fullPage: true });
const refunded = await page.textContent('.kpi.returned strong');
check(refunded === '$19.48', `refunded total $19.48 (got ${refunded})`);
check(/2 verified/.test(await page.textContent('.shop')), 'shop shows 2 verified returns');

// BOB import
await page.goto(BASE + '#/settings');
await page.click('text=Import BOB receipts');
await page.waitForSelector('text=Imported');
await page.goto(BASE + '#/');
await page.waitForSelector('text=Amazon');
await page.screenshot({ path: `${OUT}/6-with-bob.png`, fullPage: true });

// Leaving the scan screen while OCR runs must not raise an error.
await page.goto(BASE + '#/add/purchase');
await page.locator('input[type=file]:not([capture])').setInputFiles(p1);
await page.waitForSelector('.working');
await page.goto(BASE + '#/');
await page.waitForTimeout(8000);
check(!(await page.locator('.toast.error').count()), 'no error after leaving a scan mid-OCR');

// Dark mode render
await page.emulateMedia({ colorScheme: 'dark' });
await page.screenshot({ path: `${OUT}/7-dark.png`, fullPage: true });

check(errors.length === 0, `no console errors ${errors.join(' | ')}`);
await browser.close();
