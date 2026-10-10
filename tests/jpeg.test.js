import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripJpegMetadata, metadataMarkers } from '../src/jpeg.js';

const seg = (marker, payload) => {
  const len = payload.length + 2;
  return [0xff, marker, len >> 8, len & 0xff, ...payload];
};
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

test('strips EXIF, XMP, ICC and comments but keeps image data', () => {
  const jfif = seg(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const exif = seg(0xe1, [...ascii('Exif'), 0, 0, ...ascii('GPS 35.2271N 80.8431W')]);
  const xmp = seg(0xe1, ascii('http://ns.adobe.com/xap/1.0/ <x:xmpmeta>'));
  const icc = seg(0xe2, ascii('ICC_PROFILE'));
  const com = seg(0xfe, ascii('shot on Pixel'));
  const dqt = seg(0xdb, new Array(65).fill(1));
  const sos = [0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0x12, 0x34, 0x56, 0xff, 0xd9];
  const bytes = new Uint8Array([0xff, 0xd8, ...jfif, ...exif, ...xmp, ...icc, ...com, ...dqt, ...sos]);
  assert.equal(metadataMarkers(bytes).length, 4);
  const out = stripJpegMetadata(bytes);
  assert.deepEqual(metadataMarkers(out), []);
  const s = String.fromCharCode(...out);
  assert.doesNotMatch(s, /Exif|GPS|xmpmeta|ICC_PROFILE|Pixel/);
  assert.match(s, /JFIF/);
  assert.deepEqual([...out.slice(-5)], [0x12, 0x34, 0x56, 0xff, 0xd9]);
});
