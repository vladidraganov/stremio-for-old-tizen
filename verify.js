/* End-to-end verification of a built WGT, reading only the packaged artifact. */
'use strict';
const JSZip = require('jszip');
const fs = require('fs');
const acorn = require('acorn');

const WGT = process.argv[2] || 'Stremio-Tizen3-v3.wgt';
const MARKER = ',"Worker",void 0,void 0)';

function extractWorker(js) {
  const m = js.indexOf(MARKER);
  if (m === -1) throw new Error('worker marker not found');
  const cq = m - 1;
  const q = js[cq];
  for (let i = cq - 1; i > 0; i--) {
    if (js[i] !== q) continue;
    let bs = 0, j = i - 1;
    while (j >= 0 && js[j] === '\\') { bs++; j--; }
    if (bs % 2 === 0) return (0, eval)(js.slice(i, cq + 1));
  }
  throw new Error('opening quote not found');
}

(async () => {
  const zip = await JSZip.loadAsync(fs.readFileSync(WGT));
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const js = await zip.file('bundle.js').async('string');
  const html = await zip.file('index.html').async('string');
  const cfg = await zip.file('config.xml').async('string');

  console.log('files in wgt          : ' + names.length);
  console.log('  ' + names.join(', '));
  console.log('signatures removed    : ' +
    (names.indexOf('signature1.xml') === -1 && names.indexOf('author-signature.xml') === -1));
  console.log('app id                : ' + (cfg.match(/tizen:application id="([^"]+)"/) || [])[1]);
  console.log('required_version      : ' + (cfg.match(/required_version="([^"]+)"/) || [])[1]);

  console.log('lookbehind present    : ' + (js.indexOf('(?<=') !== -1));
  acorn.parse(js, { ecmaVersion: 5, sourceType: 'script' });
  console.log('bundle.js parses ES5  : OK');

  const w = extractWorker(js);
  acorn.parse(w, { ecmaVersion: 5, sourceType: 'script' });
  console.log('worker parses ES5     : OK  (' + (w.length / 1048576).toFixed(2) + ' MB)');
  console.log('worker core fns intact: ' +
    (w.indexOf('initialize_runtime') !== -1 && w.indexOf('onCoreEvent') !== -1));
  console.log('worker arrow count    : ' + (w.match(/=>/g) || []).length);
  console.log('worker async count    : ' + (w.match(/async /g) || []).length);
  // The real worker bundle starts at its webpack license banner; the shim is
  // prepended ahead of it. (Careful: the shim's own comment mentions __wbg_set_.)
  // Minified wasm-bindgen emits Reflect.set(i(A),i(e),i(a)) with no spaces;
  // the shim's explanatory comment writes it spaced, so this matches only code.
  const shimAt = w.indexOf('g.Reflect = {}');
  const realWbg = w.indexOf('Reflect.set(i(A),i(e),i(a))');
  console.log('Reflect shim present  : ' + (shimAt !== -1) + '  (offset ' + shimAt + ')');
  console.log('real Reflect.set use  : offset ' + realWbg);
  console.log('shim runs first       : ' + (shimAt !== -1 && realWbg !== -1 && shimAt < realWbg));

  const inline = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  acorn.parse(inline, { ecmaVersion: 5, sourceType: 'script' });
  console.log('diagnostic parses ES5 : OK');
  console.log('diagnostic worker hook: ' + (html.indexOf('WORKER ERROR') !== -1));
})().catch((e) => { console.error('FAIL: ' + e.message); process.exit(1); });
