/* Tries a list of SDB services and reports which ones return data. */
'use strict';
const net = require('net');

const HOST = process.argv[2];
if (!HOST) {
  console.error('Usage: node ' + require('path').basename(process.argv[1]) + ' <tv-ip> [args]');
  console.error('Enable Developer Mode on the TV first; port 26101 must be open.');
  process.exit(1);
}
const PORT = 26101;

const SERVICES = process.argv.slice(3).length ? process.argv.slice(3) : [
  'capability:',
  'shell:id',
  'shell:uname -m',
  'shell:0 applist',
  'shell:0 vd_applist',
  'sysinfo:',
  'host:version',
  'shell:ls /',
];

const A_CNXN = 0x4e584e43, A_OPEN = 0x4e45504f, A_OKAY = 0x59414b4f,
      A_CLSE = 0x45534c43, A_WRTE = 0x45545257, A_AUTH = 0x48545541;

function sum(b) { let s = 0; for (let i = 0; i < b.length; i++) s = (s + b[i]) >>> 0; return s; }
function pkt(cmd, a0, a1, pl) {
  const d = pl ? Buffer.from(pl) : Buffer.alloc(0);
  const h = Buffer.alloc(24);
  h.writeUInt32LE(cmd >>> 0, 0); h.writeUInt32LE(a0 >>> 0, 4); h.writeUInt32LE(a1 >>> 0, 8);
  h.writeUInt32LE(d.length, 12); h.writeUInt32LE(sum(d), 16);
  h.writeUInt32LE((cmd ^ 0xffffffff) >>> 0, 20);
  return Buffer.concat([h, d]);
}

function tryService(service) {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, HOST);
    let buf = Buffer.alloc(0), out = '', closed = false;
    const done = (note) => {
      if (closed) return; closed = true;
      try { sock.destroy(); } catch (e) {}
      resolve({ service, out: out.trim(), note: note || '' });
    };
    sock.setTimeout(8000);
    sock.on('connect', () => sock.write(pkt(A_CNXN, 0x01000000, 4096, 'host::\0')));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 24) {
        const cmd = buf.readUInt32LE(0), a0 = buf.readUInt32LE(4), a1 = buf.readUInt32LE(8);
        const len = buf.readUInt32LE(12);
        if (buf.length < 24 + len) return;
        const pl = buf.slice(24, 24 + len); buf = buf.slice(24 + len);
        if (cmd === A_CNXN) { sock.write(pkt(A_OPEN, 1, 0, service + '\0')); }
        else if (cmd === A_AUTH) { done('AUTH required'); return; }
        else if (cmd === A_WRTE) { out += pl.toString(); sock.write(pkt(A_OKAY, a1, a0, null)); }
        else if (cmd === A_CLSE) { done(out ? '' : 'closed with no data'); return; }
      }
    });
    sock.on('timeout', () => done('timeout'));
    sock.on('error', (e) => done('err: ' + e.message));
  });
}

(async () => {
  for (const s of SERVICES) {
    const r = await tryService(s);
    console.log('--- ' + r.service + (r.note ? '   [' + r.note + ']' : '') + ' ---');
    if (r.out) { console.log(r.out.split('\n').slice(0, 25).join('\n')); }
    console.log();
  }
})();
