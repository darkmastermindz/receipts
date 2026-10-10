// On-device OCR with Tesseract (WebAssembly in a Web Worker). The engine and
// English model are served from this site (vendor/tesseract), so photos never
// leave the phone for text recognition.

let workerPromise = null;
let progressCb = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (globalThis.Tesseract) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the OCR engine. Open the app once while online so it can cache it.'));
    document.head.append(s);
  });
}

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const base = new URL('vendor/tesseract/', document.baseURI).href;
      await loadScript(base + 'tesseract.min.js');
      const worker = await globalThis.Tesseract.createWorker('eng', 1, {
        workerPath: base + 'worker.min.js',
        corePath: base,
        langPath: base + 'lang',
        gzip: true,
        workerBlobURL: false,
        logger: (m) => progressCb?.(m),
      });
      await worker.setParameters({
        tessedit_pageseg_mode: '4', // single column of variable-size text
        preserve_interword_spaces: '1',
      });
      return worker;
    })().catch((e) => {
      workerPromise = null;
      throw e;
    });
  }
  return workerPromise;
}

/**
 * Recognizes text on a canvas.
 * @returns {Promise<{lines: {text: string, bbox: {x0,y0,x1,y1}, confidence: number}[]}>}
 */
export async function recognize(canvas, onProgress) {
  progressCb = onProgress;
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(canvas);
    const lines = (data.lines || [])
      .map((l) => ({ text: l.text.replace(/\s+$/, ''), bbox: l.bbox, confidence: l.confidence }))
      .filter((l) => l.text.trim());
    return { lines };
  } finally {
    progressCb = null;
  }
}
