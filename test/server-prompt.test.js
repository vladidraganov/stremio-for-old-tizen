/*
 * Streaming-server discovery and picker, exercised end to end.
 *
 * Loads the real index.html into jsdom with a simulated TV around it:
 *   - tizen.systeminfo reports the TV's own IP
 *   - XMLHttpRequest is a fake LAN where chosen hosts answer /settings
 *   - window.core is a fake Stremio core that records every dispatch
 * then drives it with remote-control key events and asserts on what the user
 * would see and what the core is told.
 *
 *   node test/server-prompt.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const KEY = { OK: 13, UP: 38, DOWN: 40, BACK: 10009, YELLOW: 405 };
const WEBOS_PATH = '/media/cryptofs/apps/usr/palm/services/io.strem.tv.server/.stremio-server';

function settingsJson(version, appPath) {
  return JSON.stringify({ options: [], values: { serverVersion: version, appPath: appPath }, baseUrl: '' });
}

/**
 * @param servers   { 'http://ip:11470/': {version, appPath} } hosts that answer
 * @param current   the streamingServerUrl the profile starts with
 * @param seed      optional localStorage contents
 */
function bootTv({ servers = {}, current = 'http://127.0.0.1:11470/', seed = {}, ownIp = '192.168.7.42',
                  latency = 4 } = {}) {
  let html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
    .split('__BUILD_ID__').join('test')
    .split('__SERVER_URL__').join('')
    .replace('<script src="bundle.js"></script>', '');

  const dispatched = [];
  const appKeys = [];
  const state = {
    settings: { streamingServerUrl: current, interfaceLanguage: 'eng', subtitlesSize: 100 },
    urls: [],
    stream: { selected: { transportUrl: current }, settings: { type: 'Err', content: 'down' } },
  };

  const dom = new JSDOM(html, {
    url: 'http://tv.local/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(win) {
      for (const k of Object.keys(seed)) win.localStorage.setItem(k, seed[k]);

      win.tizen = {
        systeminfo: { getPropertyValue(prop, ok) { setTimeout(() => ok({ ipAddress: ownIp }), 1); } },
        tvinputdevice: { registerKey() {} },
      };

      class FakeXHR {
        constructor() { this.listeners = {}; this.status = 0; this.responseText = ''; }
        addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
        fire(t) { if (this['on' + t]) this['on' + t](); (this.listeners[t] || []).forEach((f) => f()); }
        open(method, url) { this.url = url; }
        setRequestHeader() {}
        send() {
          setTimeout(() => {
            const base = this.url.replace(/settings$/, '');
            const s = servers[base];
            if (s) {
              this.status = 200;
              this.responseText = settingsJson(s.version, s.appPath);
              this.fire('load');
            } else {
              this.fire('error');                       // nothing listening
            }
          }, latency);
        }
      }
      win.XMLHttpRequest = FakeXHR;
    },
  });

  const win = dom.window;

  // The app's own key handling, registered after ours like the real bundle.
  win.document.addEventListener('keydown', (ev) => appKeys.push(ev.keyCode));

  // Fake core, published a moment after load the way CoreProvider does it.
  setTimeout(() => {
    win.core = {
      getState(model) {
        if (model === 'ctx') {
          return Promise.resolve({ profile: { settings: Object.assign({}, state.settings) },
                                   streamingServerUrls: state.urls.slice() });
        }
        if (model === 'streaming_server') return Promise.resolve(JSON.parse(JSON.stringify(state.stream)));
        return Promise.resolve({});
      },
      dispatch(action, model) {
        dispatched.push({ action, model });
        const a = action.args && action.args.action;
        if (a === 'AddServerUrl') state.urls.push({ url: action.args.args });
        if (a === 'UpdateSettings') state.settings = Object.assign({}, action.args.args);
        if (action.action === 'StreamingServer' && a === 'Reload') {
          const url = state.settings.streamingServerUrl;
          const up = !!servers[url];
          setTimeout(() => {
            state.stream = { selected: { transportUrl: url },
                             settings: up ? { type: 'Ready', content: { serverVersion: servers[url].version } }
                                          : { type: 'Err', content: 'down' } };
          }, 300);
        }
        return Promise.resolve();
      },
    };
  }, 200);

  function press(code) {
    const ev = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'keyCode', { get: () => code });
    win.document.body.dispatchEvent(ev);
  }

  const promptEl = () => win.document.getElementById('srvprompt');
  const isOpen = () => promptEl().className === 'open';
  const text = () => promptEl().textContent.replace(/\s+/g, ' ').trim();

  return { dom, win, dispatched, appKeys, state, press, isOpen, text, promptEl };
}

function waitFor(fn, ms, label) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    (function tick() {
      let v;
      try { v = fn(); } catch (e) { v = false; }
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error('timed out waiting for: ' + label));
      setTimeout(tick, 40);
    })();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function actionsOf(tv) {
  return tv.dispatched.map((d) => d.action.action + ':' + ((d.action.args && d.action.args.action) || '') +
                                  (d.model ? '@' + d.model : ''));
}

const scenarios = {

  async 'YELLOW finds servers, labels them, and switches on OK'() {
    const tv = bootTv({
      current: 'http://192.168.7.50:11470/',            // a working server already in use
      servers: {
        'http://192.168.7.50:11470/': { version: '4.20.8', appPath: 'C:\\Users\\me\\AppData\\Roaming\\stremio' },
        'http://192.168.7.100:11470/': { version: '4.20.11', appPath: WEBOS_PATH },
      },
    });
    await sleep(1500);                                   // core ready, auto-check sees .50 is up
    tv.press(KEY.YELLOW);
    assert.ok(tv.isOpen(), 'picker opens immediately on YELLOW');
    await waitFor(() => /Stremio server found/.test(tv.text()), 4000, 'choose state');

    const t = tv.text();
    assert.ok(/Windows PC/.test(t) && /LG TV \(webOS\)/.test(t), 'devices labelled from appPath: ' + t);
    assert.ok(/v4\.20\.11/.test(t), 'server version shown');
    assert.ok(/✓ in use/.test(t), 'the current server is marked in use');
    assert.ok(t.indexOf('192.168.7.50') < t.indexOf('192.168.7.100'), 'sorted by address');

    // The cursor starts on the server NOT already in use.
    const selected = () => tv.promptEl().querySelector('.sp-row.sel').textContent;
    assert.ok(/LG TV/.test(selected()), 'preselects the server not in use, got: ' + selected());

    // While open, the picker must own the remote - the app sees nothing.
    tv.appKeys.length = 0;
    tv.press(KEY.UP);
    assert.ok(/Windows PC/.test(selected()), 'UP moves the cursor');
    tv.press(KEY.DOWN);
    assert.deepStrictEqual(tv.appKeys, [], 'app must not receive keys while the picker is open');

    tv.press(KEY.OK);                                     // pick the LG
    await waitFor(() => /Connected/.test(tv.text()), 15000, 'connected');

    const acts = actionsOf(tv);
    assert.ok(acts.includes('Ctx:AddServerUrl'), 'adds to saved list: ' + acts);
    assert.ok(acts.includes('Ctx:UpdateSettings'), 'updates settings');
    assert.ok(acts.includes('StreamingServer:Reload@streaming_server'), 'reloads the streaming server');
    assert.strictEqual(tv.state.settings.streamingServerUrl, 'http://192.168.7.100:11470/');
    assert.strictEqual(tv.state.settings.subtitlesSize, 100, 'other settings preserved');

    tv.press(KEY.OK);
    assert.ok(!tv.isOpen(), 'OK closes the confirmation');
    tv.appKeys.length = 0;
    tv.press(KEY.DOWN);
    assert.deepStrictEqual(tv.appKeys, [KEY.DOWN], 'app gets keys back once closed');
    tv.dom.window.close();
  },

  async 'launch with a dead server auto-prompts with the replacement'() {
    const tv = bootTv({
      current: 'http://192.168.7.15:11470/',             // router moved the server
      servers: { 'http://192.168.7.100:11470/': { version: '4.20.11', appPath: WEBOS_PATH } },
    });
    await waitFor(() => tv.isOpen() && /Stremio server found/.test(tv.text()), 9000, 'auto prompt');
    assert.ok(/192\.168\.7\.15:11470\) isn't responding/.test(tv.text()), 'explains why: ' + tv.text());

    tv.press(KEY.OK);
    await waitFor(() => /Connected/.test(tv.text()), 15000, 'connected');
    assert.strictEqual(tv.state.settings.streamingServerUrl, 'http://192.168.7.100:11470/');
    tv.dom.window.close();
  },

  async '"Not now" on an automatic prompt is remembered'() {
    const tv = bootTv({ servers: { 'http://192.168.7.100:11470/': { version: '4.20.11', appPath: WEBOS_PATH } } });
    await waitFor(() => tv.isOpen() && /Stremio server found/.test(tv.text()), 9000, 'auto prompt');
    tv.press(KEY.BACK);
    assert.ok(!tv.isOpen(), 'BACK closes it');
    const stored = tv.win.localStorage.getItem('stremio-tizen3.dismissedServers');
    assert.ok(/192\.168\.7\.100/.test(stored), 'dismissal stored: ' + stored);
    assert.ok(!actionsOf(tv).includes('Ctx:UpdateSettings'), 'nothing changed');
    tv.dom.window.close();

    // Next launch: same server on the network, but no nagging.
    const again = bootTv({ seed: { 'stremio-tizen3.dismissedServers': stored },
                           servers: { 'http://192.168.7.100:11470/': { version: '4.20.11', appPath: WEBOS_PATH } } });
    await sleep(6500);
    assert.ok(!again.isOpen(), 'dismissed server is not offered again automatically');

    // ...but YELLOW still lists it.
    again.press(KEY.YELLOW);
    await waitFor(() => /Stremio server found/.test(again.text()), 4000, 'manual still offers it');
    again.dom.window.close();
  },

  async 'YELLOW with nothing on the network says so'() {
    const tv = bootTv({ servers: {} });
    await sleep(500);
    tv.press(KEY.YELLOW);
    await waitFor(() => /No Stremio server found/.test(tv.text()), 5000, 'none state');
    tv.press(KEY.BACK);
    assert.ok(!tv.isOpen());
    tv.dom.window.close();
  },

  async 'BACK during a search cancels it for good'() {
    const tv = bootTv({ latency: 25,
                        servers: { 'http://192.168.7.100:11470/': { version: '4.20.11', appPath: WEBOS_PATH } } });
    await sleep(500);
    tv.press(KEY.YELLOW);
    assert.ok(/Looking for Stremio/.test(tv.text()), 'searching state shown');
    tv.press(KEY.BACK);
    assert.ok(!tv.isOpen(), 'closed');
    await sleep(1500);                                   // scan completes in the background
    assert.ok(!tv.isOpen(), 'a finished scan must not reopen a cancelled picker');
    tv.dom.window.close();
  },

  async 'server-supplied text is escaped'() {
    const tv = bootTv({ servers: { 'http://192.168.7.100:11470/':
      { version: '<img src=x onerror="window.pwned=1">', appPath: WEBOS_PATH } } });
    await sleep(500);
    tv.press(KEY.YELLOW);
    await waitFor(() => /Stremio server found/.test(tv.text()), 5000, 'choose state');
    assert.strictEqual(tv.promptEl().querySelectorAll('img').length, 0, 'no element injected');
    assert.ok(/<img src=x/.test(tv.text()), 'shown as plain text');
    assert.ok(!tv.win.pwned);
    tv.dom.window.close();
  },
};

(async () => {
  const names = Object.keys(scenarios);
  const results = await Promise.all(names.map((n) =>
    scenarios[n]().then(() => ({ n, ok: true }), (e) => ({ n, ok: false, e }))));
  let failed = 0;
  for (const r of results) {
    console.log((r.ok ? '  ok    ' : '  FAIL  ') + r.n + (r.ok ? '' : '\n        ' + r.e.message));
    if (!r.ok) failed++;
  }
  if (failed) { console.error('\nserver picker: ' + failed + ' of ' + names.length + ' failed'); process.exit(1); }
  console.log('server picker: all ' + names.length + ' scenarios pass');
  process.exit(0);
})();
