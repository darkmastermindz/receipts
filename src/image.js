// Image pipeline. Photos are decoded and redrawn onto a canvas, which throws
// away EXIF (GPS, device, timestamps), XMP, ICC and maker notes. Only the
// redrawn pixels move on; the original file is never stored.

import { stripJpegMetadata, metadataMarkers } from './jpeg.js';

const MAX_OCR_DIM = 2400;

async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Safari < 17 and some formats need an <img> round trip.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/** Describes the metadata found in an uploaded file (shown, never stored). */
export async function inspectMetadata(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
    if (head[0] === 0xff && head[1] === 0xd8) {
      return metadataMarkers(head).map((m) => {
        const tag = m.split(':')[1] || '';
        if (/^Exif/i.test(tag)) return 'EXIF (camera, time, GPS)';
        if (/^http/i.test(tag)) return 'XMP';
        if (/^ICC/i.test(tag)) return 'ICC profile';
        if (/^Phot|^8BIM/i.test(tag)) return 'IPTC';
        if (m.startsWith('fe')) return 'comment';
        return `APP segment ${m.split(':')[0]}`;
      });
    }
    return file.type && file.type !== 'image/jpeg' ? [`${file.type} metadata (if any)`] : [];
  } catch {
    return [];
  }
}

/** Decodes one or more photos (a long receipt in parts) into one clean canvas. */
export async function loadPhotos(files) {
  const bitmaps = [];
  for (const f of files) bitmaps.push(await decode(f));
  const width = Math.min(MAX_OCR_DIM, Math.max(...bitmaps.map((b) => b.width)));
  const parts = bitmaps.map((b) => {
    const s = Math.min(1, width / b.width);
    return { b, w: Math.round(b.width * s), h: Math.round(b.height * s) };
  });
  let height = parts.reduce((s, p) => s + p.h, 0);
  // Keep the canvas within mobile limits.
  const shrink = Math.min(1, 12000 / height);
  height = Math.round(height * shrink);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * shrink);
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let y = 0;
  for (const p of parts) {
    const w = Math.round(p.w * shrink), h = Math.round(p.h * shrink);
    ctx.drawImage(p.b, 0, y, w, h);
    y += h;
    p.b.close?.();
  }
  return canvas;
}

export function cloneCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

/** Blacks out boxes ({x0,y0,x1,y1} in canvas pixels) on a copy of the canvas. */
export function redactedCopy(src, boxes, pad = 6) {
  const c = cloneCanvas(src);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  for (const b of boxes) {
    const x = Math.max(0, Math.min(b.x0, b.x1) - pad);
    const y = Math.max(0, Math.min(b.y0, b.y1) - pad);
    ctx.fillRect(x, y, Math.abs(b.x1 - b.x0) + pad * 2, Math.abs(b.y1 - b.y0) + pad * 2);
  }
  return c;
}

/** Downscales and encodes a canvas as a metadata-free JPEG Blob. */
export async function toCleanJpeg(canvas, maxDim = 1600, quality = 0.75) {
  const s = Math.min(1, maxDim / Math.max(canvas.width, canvas.height));
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * s);
  c.height = Math.round(canvas.height * s);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, c.width, c.height);
  const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Encode failed'))), 'image/jpeg', quality));
  const bytes = stripJpegMetadata(new Uint8Array(await blob.arrayBuffer()));
  return new Blob([bytes], { type: 'image/jpeg' });
}

export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
