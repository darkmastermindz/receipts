// PII detection and redaction for receipt text.
//
// Receipts carry card digits, auth codes, addresses, phone numbers, emails,
// loyalty IDs and cashier names. None of it is needed to track returns, so any
// line that looks like PII is dropped before anything is parsed or stored, and
// its box is blacked out on the saved image.

const STREET_SUFFIX =
  'st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|hwy|highway|ln|lane|way|pkwy|parkway|ct|court|pl|place|cir|circle|ter|terrace|trl|trail|sq|square|loop|run|pike|tpke|expy|fwy';

const RULES = [
  // Payment cards: masked numbers ("************1234", "XXXX XXXX XXXX 1234").
  ['card', /[*xX#•]{4,}[\s-]*(?:[*xX#•]{4}[\s-]*)*\d{2,4}\b/],
  ['card', /\b(?:visa|master\s*card|mastercard|amex|american\s+express|discover|debit|credit|card|acct|account|chip|contactless|ebt)\b[^\n]*\d{4}/i],
  ['card', /\b(?:card|acct|account)\s*(?:#|no\.?|number|ending)/i],
  ['payment', /\b(?:auth(?:orization)?(?:\s*(?:code|#|no\.?|cd))?\s*[:#]|approval\s*(?:code|#|no)?|appr(?:oval)?\s*code|aid\s*[:#]|tvr\s*[:#]?|tsi\s*[:#]?|arqc|iad\s*[:#]|entry\s*method|cardholder|card\s*holder|signature|pin\s*verified|verified\s+by\s+pin|no\s+signature|mid\s*[:#]|tid\s*[:#]|terminal\s*(?:id|#)|seq\s*#|trace\s*#|batch\s*#|rrn\b|application\s+label)/i],
  ['payment', /\bauth(?:orization)?\b\s*(?:code|#|no\.?|cd)?\s*[:#]?\s*[A-Z0-9]{4,}/i],
  ['payment', /\bappr(?:oval|vl)?\b\s*(?:code|#|no\.?)?\s*[:#]?\s*[A-Z0-9]{4,}/i],
  ['payment', /\bA0{4}\d{5,}\b|\baid\b\s*[:#]?\s*[A-F0-9]{10,}/i],
  ['payment', /^\s*(?:chip\s*read|chip|swiped|tapped|contactless|inserted|mag\s*stripe|verified\s+by\s+pin)\s*$/i],
  ['email', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
  ['phone', /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/],
  ['address', new RegExp(`\\b\\d{1,6}\\s+(?:[NSEW]\\.?\\s+)?(?:[A-Za-z0-9.'-]+\\s+){1,4}(?:${STREET_SUFFIX})\\b\\.?`, 'i')],
  ['address', /\b[A-Za-z][A-Za-z .'-]+,?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/],
  ['address', /\b(?:p\.?\s*o\.?\s*box|suite|ste\.?|apt\.?|unit)\s*#?\s*\d+/i],
  ['address', /\b\d{5}-\d{4}\b/],
  ['person', /\b(?:customer|cust|member|cardmember|cashier|associate|served\s+by|your\s+server|server|operator|clerk|name|sold\s+to|ship\s+to|bill\s+to)\b\s*(?:name|#|id|no\.?)?\s*[:#]/i],
  ['loyalty', /\b(?:member(?:ship)?|rewards?|loyalty|mylowe'?s|pro\s*xtra|perks|circle|plenti)\s*(?:#|id|no\.?|number|card)/i],
];

// Luhn-valid runs of 13-19 digits are treated as card numbers wherever they
// appear, even inside a line that otherwise looks harmless.
const DIGIT_RUN = /\b(?:\d[ -]?){12,18}\d\b/g;

const ENDS_WITH_PRICE = /\d[.,]\d{2}\s*-?\s*[A-Z*]{0,2}\s*$/;

export function luhnValid(digits) {
  const d = digits.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

function hasCardNumber(line) {
  for (const m of line.matchAll(DIGIT_RUN)) {
    // UPC/EAN barcodes are 12-13 digits with their own check digit; only flag
    // runs that contain separators or are 14+ digits, as card numbers do.
    const raw = m[0];
    const digits = raw.replace(/\D/g, '');
    if (!luhnValid(digits)) continue;
    if (digits.length >= 14 || /[ -]/.test(raw)) return true;
  }
  return false;
}

/** Returns the PII categories found on one line (empty when clean). */
export function classifyLine(line) {
  const reasons = new Set();
  if (!line || !line.trim()) return [];
  if (hasCardNumber(line)) reasons.add('card');
  // Item lines end in a price; their sizes and SKUs ("5 Way PVC", "GLOSS BK
  // 12345") can look like street or ZIP fragments, so addresses are only
  // matched on lines without a trailing price.
  const priced = ENDS_WITH_PRICE.test(line);
  for (const [reason, re] of RULES) {
    if (reason === 'address' && priced) continue;
    if (re.test(line)) reasons.add(reason);
  }
  return [...reasons];
}

export const REDACTED = '[redacted]';

/**
 * Redacts PII lines from OCR text.
 * Returns { text, lines, flagged: [{index, reasons}], count }.
 */
export function redactText(text) {
  const src = String(text || '').split(/\r?\n/);
  const flagged = [];
  const lines = src.map((line, index) => {
    const reasons = classifyLine(line);
    if (reasons.length) {
      flagged.push({ index, reasons });
      return `${REDACTED} (${reasons.join(', ')})`;
    }
    return line;
  });
  return { text: lines.join('\n'), lines, flagged, count: flagged.length };
}

/** Scrubs a single free-text value (e.g. an item description) in place. */
export function scrubValue(value) {
  if (value == null) return value;
  const s = String(value);
  return classifyLine(s).length ? REDACTED : s;
}
