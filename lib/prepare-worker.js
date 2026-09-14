/*
 * Extracts the stremio-core worker that upstream embeds inside bundle.js as a
 * string literal, and transpiles it from ES2017 to ES5.
 *
 * The main bundle is transpiled by upstream, but this worker is not: it uses
 * arrow functions and async/await, which Chromium 47 cannot parse. Because it
 * lives inside a string, the failure is invisible - a SyntaxError raised in a
 * worker never reaches window.onerror.
 *
 * Exposed as a function so `build.js` can run it automatically.
 */
'use strict';

const fs = require('fs');
const JSZip = require('jszip');
const acorn = require('acorn');

const WORKER_MARKER = ',"Worker",void 0,void 0)';

function extractWorkerSource(js) {
  const marker = js.indexOf(WORKER_MARKER);
  if (marker === -1) throw new Error('worker marker not found in bundle.js');
  const closeQ = marker - 1;
  const quote = js[closeQ];
  if (quote !== "'" && quote !== '"') throw new Error('expected a quote before the worker marker');
  for (let i = closeQ - 1; i > 0; i--) {
    if (js[i] !== quote) continue;
    let slashes = 0, j = i - 1;
    while (j >= 0 && js[j] === '\\') { slashes++; j--; }
    if (slashes % 2 === 0) return (0, eval)(js.slice(i, closeQ + 1));
  }
  throw new Error('unterminated worker string literal');
}

function ecmaLevel(code) {
  for (const v of [5, 2015, 2016, 2017, 2018, 2020, 2022]) {
    try { acorn.parse(code, { ecmaVersion: v, sourceType: 'script' }); return v; }
    catch (e) { /* keep climbing */ }
  }
  return null;
}

/**
 * @param {string} wgtPath  Source Stremio Theater .wgt
 * @param {string} outPath  Where to write the ES5 worker
 */
async function prepareWorker(wgtPath, outPath, log) {
  log = log || function () {};
  const zip = await JSZip.loadAsync(fs.readFileSync(wgtPath));
  if (!zip.file('bundle.js')) throw new Error('bundle.js not found in ' + wgtPath);

  const js = await zip.file('bundle.js').async('string');
  const source = extractWorkerSource(js);
  log('    extracted ' + (source.length / 1048576).toFixed(2) + ' MB (needs ES' + ecmaLevel(source) + ')');

  if (ecmaLevel(source) === 5) {
    fs.writeFileSync(outPath, source);
    log('    already ES5 - no transpile needed');
    return outPath;
  }

  const babel = require('@babel/core');
  log('    transpiling to ES5 (this takes ~20-30s)...');
  const res = babel.transformSync(source, {
    babelrc: false, configFile: false,
    compact: true, comments: false, sourceMaps: false, sourceType: 'script',
    presets: [[require.resolve('@babel/preset-env'), {
      targets: { ie: '11' }, useBuiltIns: false, modules: false,
    }]],
  });

  let code = res.code;

  // Older Babel emits bare `regeneratorRuntime` references for async/await;
  // newer Babel inlines its own helper. Supply the runtime only if needed.
  if (/regeneratorRuntime/.test(code)) {
    const rt = fs.readFileSync(require.resolve('regenerator-runtime/runtime.js'), 'utf8');
    code = 'var self_ = typeof self !== "undefined" ? self : this;\n' + rt +
      '\ntry{ if(typeof regeneratorRuntime !== "undefined"){ self_.regeneratorRuntime = regeneratorRuntime; } }catch(e){}\n' +
      code;
    log('    prepended regenerator-runtime');
  }

  const level = ecmaLevel(code);
  if (level !== 5) throw new Error('transpiled worker still needs ES' + level + ', not ES5');

  fs.writeFileSync(outPath, code);
  log('    wrote ' + (code.length / 1048576).toFixed(2) + ' MB of ES5');
  return outPath;
}

module.exports = prepareWorker;
module.exports.extractWorkerSource = extractWorkerSource;
module.exports.ecmaLevel = ecmaLevel;
