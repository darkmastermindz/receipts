// Removes every metadata segment from a JPEG: EXIF/GPS (APP1), XMP, ICC
// profiles, IPTC (APP13), maker notes and comments. Images are re-encoded
// through a canvas first, which already drops metadata; this is the second
// guarantee and is what the tests check.

const SOI = 0xd8, SOS = 0xda, EOI = 0xd9, APP0 = 0xe0, COM = 0xfe;

/** @param {Uint8Array} bytes @returns {Uint8Array} */
export function stripJpegMetadata(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== SOI) throw new Error('Not a JPEG');
  const out = [bytes.subarray(0, 2)];
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) throw new Error('Corrupt JPEG marker');
    const marker = bytes[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte
    if (marker === EOI) { out.push(bytes.subarray(i, i + 2)); break; }
    if (marker >= 0xd0 && marker <= 0xd7) { out.push(bytes.subarray(i, i + 2)); i += 2; continue; }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    const seg = bytes.subarray(i, i + 2 + len);
    if (marker === SOS) { out.push(bytes.subarray(i)); break; } // scan data to end
    const isApp = marker >= APP0 && marker <= 0xef;
    // Keep APP0 only when it is the plain JFIF header (no thumbnail).
    const keepJfif = marker === APP0 && len === 16 && String.fromCharCode(...seg.subarray(4, 8)) === 'JFIF';
    if (!(isApp && !keepJfif) && marker !== COM) out.push(seg);
    i += 2 + len;
  }
  const size = out.reduce((s, b) => s + b.length, 0);
  const res = new Uint8Array(size);
  let o = 0;
  for (const b of out) { res.set(b, o); o += b.length; }
  return res;
}

/** Lists metadata segment markers still present (for tests and the UI). */
export function metadataMarkers(bytes) {
  const found = [];
  let i = 2;
  while (i < bytes.length - 3) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1];
    if (marker === SOS || marker === EOI) break;
    if (marker >= 0xd0 && marker <= 0xd7) { i += 2; continue; }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    const name = String.fromCharCode(...bytes.subarray(i + 4, i + 4 + Math.min(4, len - 2)));
    if ((marker > APP0 && marker <= 0xef) || marker === COM) found.push(`${marker.toString(16)}:${name}`);
    if (marker === APP0 && !(len === 16 && name === 'JFIF')) found.push(`e0:${name}`);
    i += 2 + len;
  }
  return found;
}
