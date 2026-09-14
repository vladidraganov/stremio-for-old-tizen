/* Checks the subnet-detection helpers used by the on-TV LAN scanner. */
'use strict';
const assert = require('assert');

function prefixFromIp(ip) {
  return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip.replace(/\.\d+$/, '.') : null;
}

function prefixFromServerUrl(url) {
  if (!url) return null;
  const m = url.match(/^https?:\/\/(\d+\.\d+\.\d+)\./);
  return m ? m[1] + '.' : null;
}

function chooseBase(detected, serverUrl) {
  return detected || prefixFromServerUrl(serverUrl) || '192.168.1.';
}

assert.strictEqual(prefixFromIp('192.168.100.5'), '192.168.100.');
assert.strictEqual(prefixFromIp('10.0.0.42'), '10.0.0.');
assert.strictEqual(prefixFromIp('not-an-ip'), null);

assert.strictEqual(prefixFromServerUrl('http://192.168.100.15:11470/'), '192.168.100.');
assert.strictEqual(prefixFromServerUrl('http://10.1.2.3:11470/'), '10.1.2.');
assert.strictEqual(prefixFromServerUrl('http://my-nas.local:11470/'), null);
assert.strictEqual(prefixFromServerUrl(''), null);

assert.strictEqual(chooseBase('172.16.4.', 'http://192.168.100.15:11470/'), '172.16.4.');
assert.strictEqual(chooseBase(null, 'http://192.168.100.15:11470/'), '192.168.100.');
assert.strictEqual(chooseBase(null, ''), '192.168.1.');

console.log('subnet detection: all cases pass');
