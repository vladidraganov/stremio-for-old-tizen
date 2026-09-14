# Technical notes

Why each patch exists, and the evidence behind it. Everything here was
confirmed on a Samsung **UE43MU6172** (2017, Tizen 3.0) — nothing is inferred
from documentation alone.

## The platform

Tizen 3.0 reports a legacy WebKit user agent:

```
Mozilla/5.0 (SMART-TV; LINUX; Tizen 3.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/3.0 TV Safari/538.1
```

There is no Chrome token, so feature detection by UA is useless. Probing the
engine directly gives an exact fingerprint:

| Feature | Result | Shipped in |
|---|---|---|
| `fetch`, `Promise`, Web Workers, MSE, IndexedDB | ✅ | ≤ Chrome 42 |
| `Proxy` | ❌ | Chrome 49 |
| `Reflect` | ❌ | Chrome 49 |
| CSS custom properties | ❌ | Chrome 49 |
| CSS Grid | ❌ | Chrome 57 |
| WebAssembly | ❌ | Chrome 57 |
| `async` / `await` | ❌ | Chrome 55 |
| RegExp lookbehind | ❌ | Chrome 62 |

That is **Chromium 47** (December 2015) exactly.

---

## FIX 1 — RegExp lookbehind

`bundle.js` contains one ES2018 lookbehind, in platform detection:

```js
var n = navigator.userAgent.match(/NETTV\/(\d+\.\d+.\d+.\d+)/i);
return n && n[1] ? parseFloat(n[1].replace(/(?<=\..*)\./g, "")) : 0;
```

Three things make this fatal:

1. **Regex literals are validated when the script is parsed**, not when
   executed. The engine never reaches the code.
2. It is therefore irrelevant that this is the NETTV (Philips) branch, which is
   unreachable on a Samsung TV. A dead branch killed the live app.
3. `index.html` loads a single `<script src="bundle.js">`, so one SyntaxError
   means *nothing* runs.

Verification: `acorn` parses the bundle only at `ecmaVersion: 2018`; neutralise
this one literal and the whole 10 MB parses as **ES5**.

The replacement strips every `.` after the first, identically:

```js
.split(".").reduce(function (p, c, i) { return i ? (1 === i ? p + "." + c : p + c) : c })
```

## FIX 2 — the embedded core worker

`bundle.js` embeds the entire stremio-core worker as an **8.6 MB string
literal**, launched with `new Worker(URL.createObjectURL(blob))`. Upstream
transpiles the main bundle but not this string, which ends with:

```js
self.init = async ({appVersion, shellVersion}) => {
  ...
  await (0, r.initialize_runtime)((e => b.call(["onCoreEvent"], [e])))
}
```

Arrow functions and `async`/`await` — ES2017. Because it lives inside a string,
an ES5 parse check of `bundle.js` sees straight through it.

The failure is silent by construction:

- a worker's SyntaxError **never reaches `window.onerror`**
- the core never starts, so there are **no network requests and no logs**
- `bridge.call(['init'])` never settles, so `CoreProvider` hits neither `.then`
  nor `.catch` and renders neither the app nor an error

Symptom: loading screen forever, zero errors. `lib/prepare-worker.js` extracts
the string, transpiles it with Babel (`targets: { ie: "11" }`), and re-embeds it.

## FIX 3 — `Reflect` in the worker

wasm-bindgen populates web_sys's `RequestInit` through `Reflect.set`:

```js
__wbg_set_… = function (a, b, c) { return Reflect.set(i(a), i(b), i(c)); }
```

`Reflect` is Chrome 49. The worker bundles core-js for **`Promise` only**, so
nothing supplies it. Worse, web_sys's setters wrap the result in
`debug_assert!`, which is **compiled out in release builds** — the throw is
discarded, `init` stays `{}`, and `new Request(url, {})` defaults to **GET**.

Confirmed against the live API:

| Method | `api.strem.io/api/login` |
|---|---|
| GET | **405** ← what the TV sent |
| POST | 200 |
| OPTIONS (preflight) | 200 — CORS was never the issue |

This also explains the split observed on-device: the GET that fetches a login
link code worked, while the POST that completes authentication returned 405.

`lib/worker-prelude.js` provides a small `Reflect` implementation, prepended so
it runs before any core code.

## FIX 4 — solid-js `destructure()`

The Theater frontend bundles solid-js. `@solid-primitives/destructure` builds a
`new Proxy` on a path gated only on the caller's `lazy` option:

```js
if (b.lazy) { ... return new Proxy({}, { get: ..., set: ... }) }
```

Everywhere else solid guards with `s = "function" == typeof Proxy`; this call
site does not. Opening Details threw `ReferenceError: Proxy is not defined`.

The subtlety: the Proxy synthesised an accessor for **any** key, including keys
absent from the source. The one lazy call site destructures optional route
params:

```js
var k = destructure(params, {lazy: true}), e = k.type, a = k.metaId, b = k.videoId;
```

On a series page with no episode chosen, `videoId` is not a key at all, so a
keys-present-only fallback returns `undefined` and `!b()` throws
`b is not a function`. `type` and `metaId` worked because they exist — which is
why the error named `b`.

The patch keeps the Proxy where available and otherwise builds the same object
from **per-key lazy getters**, over the source's own keys plus the property
names harvested from the call site at build time. Over-defining is safe: the
accessor is `function () { return A[key] }`, so an absent key simply yields
`undefined`.

## FIX 5 — solid-js `mergeProps()`

Episode rows are rendered with `<Index>`, which hands its children the item as a
**function**:

```js
children: function (item, i) { return createComponent(Row, mergeProps(item, { index: i, ... })) }
```

`mergeProps` wraps function sources in a memo and resolves them with
`lA(x) = "function" == typeof x ? x() : x` — but **only on the Proxy path**. The
fallback does `var n = k[t]` and enumerates the *function's* own property names,
so every property of the item is dropped.

Result on Tizen 3: blank episode rows, and pressing one threw
`Cannot read property 'player' of undefined` because `A.deepLinks` was gone.
`index`/`autoFocus`/`onFocus` worked because they came from a plain object.

The patch converts function sources into objects of **live getters** before the
fallback runs. Getters re-resolve on every read, so `<Index>` rows — which are
reused rather than recreated — still update in place. A snapshot would go stale.

## FIX 6 — `/tracks/` helper

`stremio-video`'s extended-track helper is hardcoded to
`http://127.0.0.1:11470/tracks/`. `TizenVideo` only calls it when the detected
Tizen version is ≥ 6, so it never runs here; it is repointed for coherence when
`--server` is given.

---

## Why the streaming server cannot run on the TV

Stremio converts torrents to HTTP with its **streaming server**, a Node.js
program. On webOS that ships inside the app as a Node service (see
[kieranbrown/stremio-webos](https://github.com/kieranbrown/stremio-webos), which
downloads `dl.strem.io/server/v4.20.17/webos/server.js` plus static arm64
ffmpeg). Samsung does not allow that in a Tizen *web* app.

Three independent blockers, each verified on-device over SDB:

**1. No code execution.**

```
intershell_support:disabled
rootonoff_support:disabled
appcmd_support:disabled
```

`shell:id`, `shell:uname -m` and `shell:ls /` all return nothing. The whitelisted
`shell:0 execute` is not a process launcher:

```
$ shell:0 execute ls /
/usr/bin/app_launcher: unrecognized option '--timeout=/'
The app with ID: ls is not avaible for the user 5001
```

It launches **installed apps by ID**. `filesync_support:push` lets you put files
on the TV, but nothing can run them.

**2. No native app model on Tizen 3.0.** Every community `.tpk` is
`type="dotnet"` with minimum `api-version="4.0"`, because Tizen .NET debuted in
Tizen 4.0. Samsung provides no public native C/C++ TV SDK. Third-party apps on
these sets are web apps only — and a web app has no sockets.

**3. Wrong architecture anyway.** `cpu_arch:armv7` (32-bit); the native binaries
in those packages are aarch64.

A from-scratch JavaScript torrent client does not help either. The blocker is
transport, not language: BitTorrent needs raw TCP/uTP to arbitrary peers, and a
web app has only `fetch`/XHR (HTTP servers), WebSocket (WebSocket servers) and
WebRTC (other WebRTC peers). WebTorrent reaches browsers, not normal swarms.

Hence: the server runs elsewhere on the LAN, or you use direct-link streams.

Official store builds on newer Samsung TVs work because Samsung signs them with
privileges sideloading cannot obtain — which is also why Stremio publishes a
`dl.strem.io/server/v4.20.17/tizen/server.js` at all.

## Talking to the TV without Tizen Studio

`tools/sdb.js` is a minimal SDB client. SDB reuses the ADB wire format — a
24-byte header of six little-endian uint32s (command, arg0, arg1, data_length,
data_crc32, magic = command XOR 0xffffffff) — and Tizen's variant skips the RSA
auth handshake:

```sh
node tools/sdb-probe.js 192.168.1.20
```

`capability:` is the useful one; it reports `cpu_arch`, `platform_version`,
`intershell_support` and more. Developer Mode must be on, and port 26101 open.

## Verifying a build

`verify.js` inspects only the packaged artifact:

- `bundle.js` parses as ES5
- the embedded worker round-trips and parses as ES5, with 0 arrows and 0 `async`
- the core's exported functions are still present
- the `Reflect` shim precedes the first `Reflect.set`
- both signatures are removed (the installer re-signs)

`npm test` then exercises the patched FIX 4 and FIX 5 code paths pulled out of
the built package, with `Proxy` deleted to emulate Chromium 47.
