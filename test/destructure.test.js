/*
 * FIX 4 - solid-js destructure().
 *
 * Pulls the patched factory out of a BUILT package and exercises it with
 * `Proxy` deleted, the way Chromium 47 sees it. Checks that it stays lazy,
 * caches, and - the bug that broke the Details screen - still returns an
 * accessor for keys that are absent from the source object.
 *
 *   node test/destructure.test.js [path/to/built.wgt]
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const WGT = process.argv[2] || findBuilt();

function findBuilt() {
  const root = path.join(__dirname, '..');
  const hit = fs.readdirSync(root).filter((f) => /\.wgt$/i.test(f) && /tizen3/i.test(f)).sort().pop();
  if (!hit) {
    console.error('No built .wgt found. Build one first, or pass a path.');
    process.exit(1);
  }
  return path.join(root, hit);
}

const MARK = 'if("function"==typeof Proxy)return new Proxy({},{get:function(';
const END = 'return _out;}';

(async () => {
  const zip = await JSZip.loadAsync(fs.readFileSync(WGT));
  const js = await zip.file('bundle.js').async('string');

  const at = js.indexOf(MARK);
  assert.notStrictEqual(at, -1, 'patched destructure factory not found in ' + WGT);
  const start = js.lastIndexOf('function(', at);
  const end = js.indexOf(END, at) + END.length;
  const factory = (0, eval)('(' + js.slice(start, end) + ')');

  const RealProxy = global.Proxy;
  delete global.Proxy;                     // simulate Chromium 47
  try {
    // A series route with no episode selected: `videoId` is simply absent.
    const params = { type: 'series', metaId: 'tt0903747' };
    const calls = [];
    const accessor = (key) => { calls.push(key); return () => params[key]; };

    const out = factory(params, accessor);

    assert.strictEqual(calls.length, 0, 'must be lazy: nothing evaluated at construction');
    assert.strictEqual(typeof out.type, 'function', 'present key should be an accessor');
    assert.strictEqual(typeof out.metaId, 'function', 'present key should be an accessor');
    assert.strictEqual(typeof out.videoId, 'function',
      'ABSENT key must still be an accessor - this is what broke Details');

    assert.strictEqual(out.type(), 'series');
    assert.strictEqual(out.videoId(), undefined, 'absent key resolves to undefined');
    assert.strictEqual(!out.videoId(), true, 'the expression that used to throw');

    out.type();
    assert.strictEqual(calls.filter((c) => c === 'type').length, 1, 'accessor must be cached');
  } finally {
    global.Proxy = RealProxy;
  }

  // With a real Proxy the original path must still be taken.
  const params2 = { title: 'Bleach' };
  const out2 = factory(params2, (k) => () => params2[k]);
  assert.strictEqual(out2.title(), 'Bleach', 'native Proxy path still works');

  console.log('FIX 4 destructure(): lazy, cached, absent keys handled, Proxy path intact');
})().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
