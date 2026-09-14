#!/usr/bin/env node
/*
 * stremio-for-old-tizen
 *
 * Patches a Stremio Theater WGT (built for Tizen 4+) so it runs on Tizen 3.0,
 * i.e. Chromium 47. See docs/TECHNICAL.md for why each fix is needed.
 *
 *   node build.js <input.wgt> [output.wgt] [--server=http://host:port/] [--build=N]
 *
 * Patch anchors are matched with identifier-agnostic regexes wherever the
 * upstream code is minified, so a re-minified upstream release still matches.
 * Every anchor must match EXACTLY ONCE or the build fails loudly - it will
 * never produce a package that silently skipped a fix.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const acorn = require('acorn');

const HERE = __dirname;
const WORKER_ES5 = path.join(HERE, 'worker.es5.js');
const PRELUDE = path.join(HERE, 'lib', 'worker-prelude.js');
const APP_HTML = path.join(HERE, 'index.html');

// ---------------------------------------------------------------- arguments
function parseArgs(argv) {
  const out = { positional: [], server: null, build: null };
  for (const a of argv) {
    if (a.startsWith('--server=')) out.server = a.slice(9);
    else if (a.startsWith('--build=')) out.build = a.slice(8);
    else if (a.startsWith('--')) die('unknown option: ' + a);
    else out.positional.push(a);
  }
  return out;
}

function die(msg) {
  console.error('\n  BUILD FAILED: ' + msg + '\n');
  process.exit(1);
}

function anchorHelp(label) {
  return 'could not locate the ' + label + ' anchor.\n' +
    '  The upstream package has probably changed shape. Open docs/TECHNICAL.md,\n' +
    '  find the section for this fix, and re-derive the pattern from the new\n' +
    '  bundle.js. Nothing was written.';
}

/* Finds exactly one regex match, or fails with an actionable message. */
function matchOne(js, re, label) {
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  const hits = [];
  let m;
  while ((m = rx.exec(js)) !== null) {
    hits.push(m);
    if (hits.length > 1) break;
  }
  if (hits.length === 0) die(anchorHelp(label));
  if (hits.length > 1) die(label + ': expected 1 match, found several. Refusing to guess.');
  return hits[0];
}

function countOf(js, str) { return js.split(str).length - 1; }

// ------------------------------------------------------------------ anchors

// FIX 1 - ES2018 lookbehind literal (no minified identifiers; stable).
const LOOKBEHIND = '.replace(/(?<=\\..*)\\./g,"")';
const LOOKBEHIND_ES5 =
  '.split(".").reduce(function(p,c,i){return i?(1===i?p+"."+c:p+c):c})';

// FIX 2 - the embedded core worker string, emitted by webpack's worker plugin.
const WORKER_MARKER = ',"Worker",void 0,void 0)';

// FIX 4 - solid-js destructure(): `new Proxy` gated only on the caller's lazy
// option. Identifiers are captured so re-minification does not break us.
const DESTRUCTURE_RE = new RegExp(
  'function\\((\\w+),(\\w+)\\)\\{return new Proxy\\(\\{\\},\\{' +
  'get:function\\((\\w+),(\\w+)\\)\\{' +
  'if\\(\\4===Symbol\\.iterator\\|\\|"length"===\\4\\)return Reflect\\.get\\(\\1,\\4\\);' +
  'var (\\w+)=Reflect\\.get\\(\\3,\\4\\);if\\(\\5\\)return \\5;' +
  'var (\\w+)=\\2\\(\\4\\);return Reflect\\.set\\(\\3,\\4,\\6\\),\\6\\},' +
  'set:function\\(\\)\\{return!1\\}\\}\\)\\}'
);

// FIX 5 - solid-js mergeProps() non-Proxy fallback; it reads k[t] without
// resolving function sources through the lA() helper.
const MERGE_RE = new RegExp(
  'for\\(var (\\w+)=\\{\\},(\\w+)=Object\\.create\\(null\\),(\\w+)=(\\w+)\\.length-1;' +
  '\\3>=0;\\3--\\)\\{var (\\w+)=\\4\\[\\3\\];' +
  'if\\(\\5\\)for\\(var (\\w+)=Object\\.getOwnPropertyNames\\(\\5\\),'
);

// The resolver: function X(A){return(A="function"==typeof A?A():A)?A:{}}
const RESOLVER_RE = new RegExp(
  'function (\\w+)\\((\\w+)\\)\\{return\\(\\2="function"==typeof \\2\\?\\2\\(\\):\\2\\)\\?\\2:\\{\\}\\}'
);

// FIX 6 - cosmetic: extended-tracks helper hardcoded to loopback.
const TRACKS = 'fetch("http://127.0.0.1:11470/tracks/"';

// ------------------------------------------------------------------ helpers

/* Locates the embedded worker string literal and returns its bounds. */
function findWorkerLiteral(js) {
  const marker = js.indexOf(WORKER_MARKER);
  if (marker === -1) die(anchorHelp('embedded core worker'));
  const closeQ = marker - 1;
  const quote = js[closeQ];
  if (quote !== "'" && quote !== '"') die('expected a quote before the worker marker');
  for (let i = closeQ - 1; i > 0; i--) {
    if (js[i] !== quote) continue;
    let slashes = 0, j = i - 1;
    while (j >= 0 && js[j] === '\\') { slashes++; j--; }
    if (slashes % 2 === 0) return { start: i, end: closeQ };
  }
  die('unterminated worker string literal');
}

function toLiteral(code) {
  const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
  return JSON.stringify(code).split(LS).join('\\u2028').split(PS).join('\\u2029');
}

/* Property names read off a destructure({lazy:true}) result. */
function harvestDestructureKeys(js) {
  const found = Object.create(null);
  const re = /\{lazy:!0\}\)/g;
  let m;
  while ((m = re.exec(js)) !== null) {
    const after = js.slice(m.index + m[0].length, m.index + m[0].length + 600);
    const first = after.match(/^,[A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/);
    if (!first) continue;
    const v = first[1].replace(/\$/g, '\\$');
    const propRe = new RegExp('\\b' + v + '\\.([A-Za-z_$][\\w$]*)', 'g');
    let p;
    while ((p = propRe.exec(after)) !== null) found[p[1]] = true;
  }
  return Object.keys(found);
}

function parsesAsEs5(code) {
  try { acorn.parse(code, { ecmaVersion: 5, sourceType: 'script' }); return true; }
  catch (e) { return e.message; }
}

// --------------------------------------------------------------------- main
(async function main() {
  const args = parseArgs(process.argv.slice(2));
  const SRC = args.positional[0] || path.join(HERE, '..', 'Stremio-Tizen4.wgt');
  const OUT = args.positional[1] || path.join(HERE, 'Stremio-Tizen3.wgt');

  const serverUrl = args.server || process.env.STREMIO_SERVER || '';
  if (serverUrl && !/^https?:\/\/[^\s/]+(:\d+)?\/$/.test(serverUrl)) {
    die('--server must look like http://host:port/ (trailing slash) - got ' + serverUrl);
  }

  if (!fs.existsSync(SRC)) die('input package not found: ' + SRC);
  console.log('  input      : ' + SRC);

  // The ES5 worker is derived from this exact input, so rebuild it whenever it
  // is missing or older than the package it came from.
  const stale = !fs.existsSync(WORKER_ES5) ||
    fs.statSync(WORKER_ES5).mtimeMs < fs.statSync(SRC).mtimeMs;
  if (stale) {
    console.log('  worker     : preparing ES5 worker from this package');
    await require(path.join(HERE, 'lib', 'prepare-worker'))(
      SRC, WORKER_ES5, (m) => console.log(m));
  }

  const zip = await JSZip.loadAsync(fs.readFileSync(SRC));
  if (!zip.file('bundle.js')) die('bundle.js not found - is this a Stremio Theater WGT?');
  if (!zip.file('config.xml')) die('config.xml not found - not a valid WGT');
  let js = await zip.file('bundle.js').async('string');

  // -- FIX 1 --------------------------------------------------------------
  const lbHits = countOf(js, LOOKBEHIND);
  if (lbHits !== 1) die('FIX 1: expected 1 lookbehind literal, found ' + lbHits);
  js = js.split(LOOKBEHIND).join(LOOKBEHIND_ES5);
  if (js.indexOf('(?<=') !== -1) die('FIX 1: a lookbehind remains after patching');
  console.log('  FIX 1      : RegExp lookbehind -> ES5');

  // -- FIX 4 --------------------------------------------------------------
  const keys = harvestDestructureKeys(js);
  if (!keys.length) die(anchorHelp('destructure() call site (no keys harvested)'));
  const d = matchOne(js, DESTRUCTURE_RE, 'solid-js destructure() Proxy factory');
  const [src, acc, tgt, key, cached, made] = [d[1], d[2], d[3], d[4], d[5], d[6]];
  const destructureFixed =
    'function(' + src + ',' + acc + '){' +
    'if("function"==typeof Proxy)return new Proxy({},{get:function(' + tgt + ',' + key + '){' +
    'if(' + key + '===Symbol.iterator||"length"===' + key + ')return Reflect.get(' + src + ',' + key + ');' +
    'var ' + cached + '=Reflect.get(' + tgt + ',' + key + ');if(' + cached + ')return ' + cached + ';' +
    'var ' + made + '=' + acc + '(' + key + ');return Reflect.set(' + tgt + ',' + key + ',' + made + '),' + made + '},' +
    'set:function(){return!1}});' +
    'var _src=Object(' + src + '),_out={},_memo={},_extra=' + JSON.stringify(keys) + ',' +
    '_def=function(_k){Object.defineProperty(_out,_k,{enumerable:!0,configurable:!0,' +
    'get:function(){if(!(_k in _memo)){_memo[_k]=' + acc + '(_k);}return _memo[_k];},set:function(){}});},' +
    '_ks=Object.keys(_src),_i=0;' +
    'for(;_i<_ks.length;_i++){_def(_ks[_i]);}' +
    'for(_i=0;_i<_extra.length;_i++){if(!(_extra[_i] in _out)){_def(_extra[_i]);}}' +
    'if("length" in _src){try{Object.defineProperty(_out,"length",{enumerable:!1,configurable:!0,' +
    'get:function(){return _src.length;}});}catch(_e){}}' +
    'if(typeof Symbol!=="undefined"&&Symbol.iterator&&_src[Symbol.iterator]){' +
    'try{_out[Symbol.iterator]=_src[Symbol.iterator];}catch(_e2){}}' +
    'return _out;}';
  js = js.slice(0, d.index) + destructureFixed + js.slice(d.index + d[0].length);
  console.log('  FIX 4      : destructure() Proxy -> lazy getters   keys=[' + keys.join(', ') + ']');

  // -- FIX 5 --------------------------------------------------------------
  const r = matchOne(js, RESOLVER_RE, 'solid-js lA() source resolver');
  const resolver = r[1];
  const mp = matchOne(js, MERGE_RE, 'solid-js mergeProps() fallback loop');
  const sources = mp[4];
  const preLoop =
    'for(var _mi=0;_mi<' + sources + '.length;_mi++){if("function"==typeof ' + sources + '[_mi]){' +
    sources + '[_mi]=function(_fn){var _snap=' + resolver + '(_fn),_o={},_ks2=Object.keys(_snap),' +
    '_d2=function(_k2){Object.defineProperty(_o,_k2,{enumerable:!0,configurable:!0,' +
    'get:function(){return ' + resolver + '(_fn)[_k2];}});};' +
    'for(var _j=0;_j<_ks2.length;_j++){_d2(_ks2[_j]);}return _o;}(' + sources + '[_mi]);}}';
  js = js.slice(0, mp.index) + preLoop + js.slice(mp.index);
  console.log('  FIX 5      : mergeProps() resolves function sources (via ' + resolver + '())');

  // -- FIX 2 + 3 ----------------------------------------------------------
  const loc = findWorkerLiteral(js);
  const originalWorker = (0, eval)(js.slice(loc.start, loc.end + 1));
  let level = '?';
  for (const v of [5, 2015, 2016, 2017, 2018, 2020]) {
    try { acorn.parse(originalWorker, { ecmaVersion: v, sourceType: 'script' }); level = String(v); break; }
    catch (e) { /* keep climbing */ }
  }
  console.log('  worker     : embedded ' + (originalWorker.length / 1048576).toFixed(2) + ' MB, needs ES' + level);

  const prelude = fs.readFileSync(PRELUDE, 'utf8');
  const es5Worker = prelude + '\n' + fs.readFileSync(WORKER_ES5, 'utf8');
  const workerEs5 = parsesAsEs5(es5Worker);
  if (workerEs5 !== true) die('worker (with prelude) is not ES5: ' + workerEs5);
  for (const needle of ['initialize_runtime', 'onCoreEvent', 'local_storage_get_item']) {
    if (es5Worker.indexOf(needle) === -1) die('worker.es5.js is missing "' + needle + '" - wrong file?');
  }
  js = js.slice(0, loc.start) + toLiteral(es5Worker) + js.slice(loc.end + 1);
  console.log('  FIX 3      : Reflect shim prepended to worker');
  console.log('  FIX 2      : worker replaced with ES5 build (' + (es5Worker.length / 1048576).toFixed(2) + ' MB)');

  // -- FIX 6 --------------------------------------------------------------
  if (serverUrl && countOf(js, TRACKS) === 1) {
    js = js.split(TRACKS).join('fetch("' + serverUrl.replace(/\/$/, '') + '/tracks/"');
    console.log('  FIX 6      : /tracks/ helper -> ' + serverUrl.replace(/\/$/, ''));
  }

  // -- verify -------------------------------------------------------------
  const bundleEs5 = parsesAsEs5(js);
  if (bundleEs5 !== true) die('patched bundle.js is not ES5: ' + bundleEs5);
  const rt = (0, eval)(js.slice(findWorkerLiteral(js).start, findWorkerLiteral(js).end + 1));
  if (rt !== es5Worker) die('worker round-trip mismatch after embedding');
  console.log('  VERIFIED   : bundle.js and embedded worker both parse as ES5');

  // -- app shell ----------------------------------------------------------
  let html = fs.readFileSync(APP_HTML, 'utf8');
  const buildNo = args.build ||
    (path.basename(OUT).match(/v(\d+)/) || [])[1] ||
    String(Math.floor(Date.now() / 60000) % 1000);
  const stamp = 'v' + buildNo + ' ' + new Date().toISOString().slice(11, 16);
  if (html.indexOf('__BUILD_ID__') === -1) die('index.html lost its __BUILD_ID__ placeholder');
  if (html.indexOf('__SERVER_URL__') === -1) die('index.html lost its __SERVER_URL__ placeholder');
  html = html.split('__BUILD_ID__').join(stamp).split('__SERVER_URL__').join(serverUrl);
  const htmlScript = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const shellEs5 = parsesAsEs5(htmlScript);
  if (shellEs5 !== true) die('index.html script is not ES5: ' + shellEs5);

  // -- assemble -----------------------------------------------------------
  const out = new JSZip();
  const drop = ['signature1.xml', 'author-signature.xml'];
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue;
    if (drop.indexOf(name) !== -1) continue;
    if (name === 'bundle.js' || name === 'index.html' || name === 'config.xml') continue;
    out.file(name, await zip.file(name).async('nodebuffer'));
  }
  out.file('bundle.js', js);
  out.file('index.html', html);

  let cfg = await zip.file('config.xml').async('string');
  const ver = cfg.match(/(<widget[^>]*\sversion=")([0-9.]+)(")/);
  if (!ver) die('could not find the widget version in config.xml');
  const newVer = '1.5.' + buildNo;
  cfg = cfg.replace(ver[0], ver[1] + newVer + ver[3]);
  out.file('config.xml', cfg);

  const buf = await out.generateAsync({
    type: 'nodebuffer', compression: 'DEFLATE',
    compressionOptions: { level: 9 }, platform: 'UNIX',
  });
  fs.writeFileSync(OUT, buf);

  console.log('  build      : ' + stamp + '   widget version ' + ver[2] + ' -> ' + newVer);
  console.log('  server     : ' + (serverUrl || '(none baked in - set it in Settings)'));
  console.log('\n  OUTPUT: ' + OUT + '  (' + (buf.length / 1048576).toFixed(2) + ' MB)');
  console.log('  Install with Apps2Samsung -> custom WGT (it re-signs).\n');
})().catch((e) => die(e.stack || e.message));
