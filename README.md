# BOB Returns: receipts PWA

A phone-first web app for tracking what the [BOB](https://github.com/darkmastermindz/bob)
boat build bought, what got used, and what goes back to the store.

- **Scan receipts.** Take a photo or upload one or more photos of a long
  receipt. Line items (description, SKU, qty, unit price, line total),
  subtotal, tax, total, shop and date are read **on the device** with
  Tesseract OCR. You can fix anything before saving.
- **Consumed vs returned, by shop.** Every item is *Consumed*, *To return* or
  *Returned* (with a partial quantity when only some go back). The Summary
  shows spent / consumed / to return / refunded / net cost for each shop,
  pre-tax or with each receipt's tax.
- **Verify with the return receipt.** Scan the refund receipt and each line is
  matched to the purchase it came from (SKU, price, description, same shop).
  The app flags refunds that are lower than what you paid. Matched items
  become ✓ verified. Items marked returned without a receipt stay
  "not verified".
- **To take back.** A per-shop checklist of everything marked *To return*.
- **BOB import.** Loads the receipts already logged in the bob repo's
  `data/build.json` (snapshot in `data/bob-receipts.json`), or import a
  newer `build.json` from Settings.
- Works offline once loaded (service worker caches the app and OCR model).
  CSV export, JSON backup and restore.

## Privacy

| What | How |
|---|---|
| Photo metadata (EXIF, GPS, device, timestamps, XMP, ICC, IPTC, comments) | The photo is decoded and redrawn on a canvas, so only pixels survive. The saved JPEG then goes through `stripJpegMetadata`, which removes every APPn/COM segment (`src/jpeg.js`). The original file is never stored. |
| Card numbers, auth/approval codes, AID/TVR, entry method, signatures | Lines are flagged by `src/pii.js` (masked numbers, Luhn-valid digit runs, payment keywords) and dropped from the text before parsing. |
| Addresses, phone numbers, emails, cashier/customer names, loyalty/member IDs | Same, and each flagged line is **blacked out** on the saved image. You can drag on the preview to black out anything else. |
| Storage | IndexedDB in your browser only. No server and no account. "Keep redacted image" can be turned off. |
| Network | OCR engine and model are self-hosted (`vendor/tesseract`); the CSP only allows this site plus `api.anthropic.com`. |

**Optional: Claude extraction.** On-device OCR has trouble with crumpled or
faded receipts. In Settings you can add your own Anthropic API key. After the
on-device redaction, the **redacted, metadata-free** image is sent to Claude
(`claude-opus-5-5`, structured JSON output) to read the items. Whatever comes
back is scrubbed for PII again. This is off by default, and the key is stored
only in the browser. A key stored in a browser can be read by anyone with
access to the device, so use a key with a low spend limit.

## Develop

```bash
npm install
npm test            # unit tests: parser, PII rules, matching, summary, JPEG stripping
npm run dev         # build → dist/ and serve at http://localhost:8080
npm run test:e2e    # with the server running: full scan → redact → return-verify flow in Chromium
```

`npm run build` bundles `src/` with esbuild, copies the Tesseract engine and
English model from `node_modules` into `dist/vendor/`, and writes the service
worker's precache list.

Deploy: `netlify.toml` builds with `npm test && npm run build` and publishes
`dist/`. Camera capture needs HTTPS (or localhost).

## Layout

```
src/app.js      UI (hash routes: summary, receipts, scan, returns, settings)
src/parse.js    receipt text → store, date, totals, line items
src/pii.js      PII line classifier and redaction
src/model.js    item status, per-shop summary, return matching
src/image.js    canvas pipeline: decode, stitch, redact, clean JPEG
src/jpeg.js     JPEG metadata segment stripper
src/ocr.js      on-device Tesseract worker
src/claude.js   optional Claude extraction
src/db.js       IndexedDB
src/bob.js      import from bob's build.json
```
