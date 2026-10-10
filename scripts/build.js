// Assembles dist/: bundles the app with esbuild, copies static files, and
// self-hosts the OCR engine + English model so no third-party CDN is used.

import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const dist = join(root, 'dist');
const nm = join(root, 'node_modules');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [join(root, 'src/app.js')],
  outdir: join(dist, 'assets'),
  bundle: true,
  splitting: true,
  format: 'esm',
  minify: true,
  sourcemap: true,
  target: ['es2020', 'safari15'],
  chunkNames: 'chunk-[hash]',
  logLevel: 'warning',
});

for (const f of ['index.html', 'styles.css', 'manifest.webmanifest']) await cp(join(root, f), join(dist, f));
await cp(join(root, 'icons'), join(dist, 'icons'), { recursive: true });
await cp(join(root, 'data'), join(dist, 'data'), { recursive: true });

const vendor = join(dist, 'vendor/tesseract');
await mkdir(join(vendor, 'lang'), { recursive: true });
await cp(join(nm, 'tesseract.js/dist/tesseract.min.js'), join(vendor, 'tesseract.min.js'));
await cp(join(nm, 'tesseract.js/dist/worker.min.js'), join(vendor, 'worker.min.js'));
for (const f of ['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js']) await cp(join(nm, 'tesseract.js-core', f), join(vendor, f));
await cp(join(nm, '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'), join(vendor, 'lang/eng.traineddata.gz'));

async function walk(dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    if ((await stat(p)).isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}
const files = (await walk(dist)).map((p) => relative(dist, p)).filter((p) => !p.endsWith('.map')).sort();
const shell = ['./', ...files.filter((p) => !p.startsWith('vendor/'))];
// Precache the SIMD core (nearly all phones); the fallback core loads on demand.
const ocr = files.filter((p) => p.startsWith('vendor/') && !p.endsWith('tesseract-core-lstm.wasm.js'));

const hash = createHash('sha256');
for (const f of files) hash.update(f).update(await readFile(join(dist, f)));
const version = hash.digest('hex').slice(0, 12);

const sw = (await readFile(join(root, 'sw.js'), 'utf8'))
  .replace('__VERSION__', version)
  .replace('__SHELL__', JSON.stringify(shell))
  .replace('__OCR__', JSON.stringify(ocr));
await writeFile(join(dist, 'sw.js'), sw);

console.log(`Built dist/ (version ${version}, ${files.length + 1} files)`);
