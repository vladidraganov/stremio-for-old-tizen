/*
 * Minimal SDB (Samsung/Tizen Debug Bridge) client.
 *
 * SDB reuses the ADB wire format: a 24-byte header of six little-endian
 * uint32s -- command, arg0, arg1, data_length, data_crc32, magic -- where
 * magic = command XOR 0xffffffff. Tizen's variant historically skips the
 * RSA auth handshake that modern adb requires.
 *
 * Usage: node sdb.js <host> "<shell command>"
 */
'use strict';
const net = require('net');

const HOST = process.argv[2] || '192.168.100.5';
const PORT = 26101;
const CMD = process.argv[3] || 'uname -a';

const A_CNXN = 0x4e584e43;
const A_OPEN = 0x4e45504f;
const A_OKAY = 0x59414b4f;
const A_CLSE = 0x45534c43;
const A_WRTE = 0x45545257;
const A_AUTH = 0x48545541;

const NAMES = {
  [A_CNXN]: 'CNXN', [A_OPEN]: 'OPEN', [A_OKAY]: 'OKAY',
  [A_CLSE]: 'CLSE', [A_WRTE]: 'WRTE', [A_AUTH]: 'AUTH',
};

function crc32sum(buf) { let s = 0; for (let i = 0; i < buf.length; i++) s = (s + buf[i]) >>> 0; return s; }

function packet(command, arg0, arg1, payload) {
  const data = payload ? Buffer.from(payload) : Buffer.alloc(0);
  const h = Buffer.alloc(24);
  h.writeUInt32LE(command >>> 0, 0);
  h.writeUInt32LE(arg0 >>> 0, 4);
  h.writeUInt32LE(arg1 >>> 0, 8);
  h.writeUInt32LE(data.length, 12);
  h.writeUInt32LE(crc32sum(data), 16);
  h.writeUInt32LE((command ^ 0xffffffff) >>> 0, 20);
  return Buffer.concat([h, data]);
}

const sock = net.connect(PORT, HOST);
let buf = Buffer.alloc(0);
let localId = 1;
let out = '';
let connected = false;

sock.setTimeout(20000);

sock.on('connect', () => {
  console.log('TCP connected to ' + HOST + ':' + PORT);
  // ADB-style banner. "host::" identifies us; version 0x01000000, maxdata 4096.
  sock.write(packet(A_CNXN, 0x01000000, 4096, 'host::\0'));
});

sock.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 24) {
    const command = buf.readUInt32LE(0);
    const arg0 = buf.readUInt32LE(4);
    const arg1 = buf.readUInt32LE(8);
    const len = buf.readUInt32LE(12);
    if (buf.length < 24 + len) return;
    const payload = buf.slice(24, 24 + len);
    buf = buf.slice(24 + len);

    const name = NAMES[command] || ('0x' + command.toString(16));
    if (command === A_CNXN) {
      console.log('<< CNXN banner: ' + payload.toString().replace(/\0/g, ''));
      connected = true;
      console.log('>> OPEN shell:' + CMD);
      sock.write(packet(A_OPEN, localId, 0, 'shell:' + CMD + '\0'));
    } else if (command === A_AUTH) {
      console.log('<< AUTH requested (type ' + arg0 + ') - this TV wants RSA auth; ' +
                  'Tizen Studio sdb keys would be required.');
      sock.end();
    } else if (command === A_OKAY) {
      // stream opened; remote id in arg0
    } else if (command === A_WRTE) {
      out += payload.toString();
      sock.write(packet(A_OKAY, arg1, arg0, null));
    } else if (command === A_CLSE) {
      console.log('\n===== OUTPUT =====\n' + out.trim() + '\n==================');
      sock.end();
    } else {
      console.log('<< ' + name + ' arg0=' + arg0 + ' arg1=' + arg1 +
                  (len ? ' payload=' + JSON.stringify(payload.toString().slice(0, 200)) : ''));
    }
  }
});

sock.on('timeout', () => {
  console.log('timeout' + (connected ? '' : ' before handshake'));
  if (out) console.log('\n===== PARTIAL OUTPUT =====\n' + out.trim());
  sock.destroy();
});
sock.on('error', (e) => console.log('socket error: ' + e.message));
sock.on('close', () => { if (out && !/OUTPUT/.test('')) { /* printed on CLSE */ } });
