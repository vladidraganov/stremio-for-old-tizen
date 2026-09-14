/*
 * FIX 5 - solid-js mergeProps().
 *
 * <Index> hands its children the item as a FUNCTION. The Proxy path resolves
 * such sources through lA(); the non-Proxy fallback did not, so every property
 * of the item (deepLinks, title, poster) was dropped - blank episode rows, and
 * "Cannot read property 'player' of undefined" when one was pressed.
 *
 * Extracts the injected loop from a BUILT package and checks it converts a
 * function source into live getters.
 *
 *   node test/mergeprops.test.js [path/to/built.wgt]
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

(async () => {
  const zip = await JSZip.loadAsync(fs.readFileSync(WGT));
  const js = await zip.file('bundle.js').async('string');

  // Identifier-agnostic: capture the sources array and the resolver name.
  const head = js.match(/for\(var _mi=0;_mi<(\w+)\.length;_mi\+\+\)\{if\("function"==typeof \1\[_mi\]\)\{/);
  assert.ok(head, 'injected mergeProps loop not found in ' + WGT);
  const sourcesVar = head[1];

  const tail = js.indexOf('return _o;}(' + sourcesVar + '[_mi]);}}', head.index);
  assert.notStrictEqual(tail, -1, 'injected loop is truncated');
  const injected = js.slice(head.index, tail + ('return _o;}(' + sourcesVar + '[_mi]);}}').length);

  // Anchor on _snap= so we don't capture the `function` keyword from `=function(_fn)`.
  const resolverName = (injected.match(/_snap=(\w+)\(_fn\)/) || [])[1];
  assert.ok(resolverName, 'could not determine the resolver name');

  // Stand in for solid's lA(): call a function source, pass objects through.
  const resolver = function (x) { return (x = typeof x === 'function' ? x() : x) ? x : {}; };

  let episode = {
    id: 'tt0903747:1:5',
    title: 'English, Fitz or Percy',
    deepLinks: { player: '#/player/abc', metaDetailsStreams: '#/detail/x' },
    watched: false,
  };
  const itemAccessor = function () { return episode; };   // what <Index> passes
  const plainSource = { index: 4, onFocus: function () {} };

  // Reproduce the fallback's locals, then run the injected loop over them.
  const scope = { [sourcesVar]: [itemAccessor, plainSource], [resolverName]: resolver };
  const run = new Function(sourcesVar, resolverName, injected + '; return ' + sourcesVar + ';');
  const result = run(scope[sourcesVar], scope[resolverName]);

  assert.strictEqual(typeof result[0], 'object', 'function source must become an object');
  assert.strictEqual(typeof result[0].deepLinks, 'object', 'deepLinks must be visible');
  assert.strictEqual(result[0].deepLinks.player, '#/player/abc');
  assert.strictEqual(result[0].title, 'English, Fitz or Percy');
  assert.strictEqual(result[1], plainSource, 'plain object sources must be untouched');

  // <Index> reuses rows, so reads must stay live rather than snapshot.
  episode = {
    id: 'tt0903747:1:6',
    title: 'Riots, Drills and the Devil',
    deepLinks: { player: '#/player/NEW', metaDetailsStreams: '#/detail/y' },
    watched: true,
  };
  assert.strictEqual(result[0].title, 'Riots, Drills and the Devil', 'getters must be LIVE, not a snapshot');
  assert.strictEqual(result[0].deepLinks.player, '#/player/NEW');
  assert.strictEqual(result[0].watched, true);

  console.log('FIX 5 mergeProps(): function sources resolved, values live (' + resolverName + '())');
})().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
