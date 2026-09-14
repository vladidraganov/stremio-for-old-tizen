# Stremio for old Tizen

Run **Stremio on 2017-era Samsung TVs** (Tizen 3.0), which the existing
community packages do not support.

The community `Stremio-Tizen4.wgt` installs on these sets but hangs forever on
the loading screen. This repo is a build tool that patches it so it actually
runs: it fixes six things the old browser engine cannot handle, and adds an
on-screen debugger, since these TVs refuse to start the web inspector.

> This repo contains **no Stremio code**. You supply the upstream `.wgt`; the
> tool patches your copy locally.

**Confirmed working** on a Samsung **UE43MU6172** (Tizen 3.0, Chromium 47):
login, library, catalogs, addons, Details, episode artwork, stream lists,
remote-control navigation, native AVPlay playback, subtitles, and torrent
streaming via a Stremio server on the LAN.

---

## Does my TV need this?

| Your TV | What to use |
|---|---|
| 2017 or older, **Tizen 3.0 / 2.x** | **This repo** |
| 2018+ (Tizen 4.0+) | The upstream `Stremio-Tizen4.wgt` works as-is |

Not sure? Sideload any build and press **BLUE** — the overlay prints your Tizen
version and engine capabilities.

## Requirements

- **Node.js 16+** on a PC (Windows/macOS/Linux)
- The upstream package: `Stremio-Tizen4.wgt` from
  [Apps2Samsung/tizen-community-packages](https://github.com/Apps2Samsung/tizen-community-packages/releases)
- A way to install it — [Apps2Samsung](https://github.com/Apps2Samsung) works
  well and **re-signs packages for you**, so Tizen Studio is not required
- Developer Mode enabled on the TV

## Quick start

```sh
git clone https://github.com/vladidraganov/stremio-for-old-tizen
cd stremio-for-old-tizen
npm install

# put Stremio-Tizen4.wgt in this folder, then:
npm run build -- Stremio-Tizen4.wgt Stremio-Tizen3-v1.wgt
```

Install the result with **Apps2Samsung → custom WGT**.

The first build extracts and transpiles an 8 MB worker and takes ~30 s.
Later builds reuse it.

### Playing torrents

A Tizen **web** app cannot run a BitTorrent engine — there are no sockets, and
these TVs will not start a process ([details](docs/TECHNICAL.md#why-the-streaming-server-cannot-run-on-the-tv)).
You have two options:

**1. Point at a Stremio server on your network** — any machine already running
Stremio works: an LG webOS TV, a NAS, a Raspberry Pi, a PC.

```sh
npm run build -- Stremio-Tizen4.wgt out.wgt --server=http://192.168.1.50:11470/
```

Don't know the address? Build without `--server`, install, then press
**YELLOW** on the TV — it scans your subnet and prints any Stremio server it
finds.

**2. Use direct-link streams** — with a debrid service (Real-Debrid, AllDebrid,
Premiumize) configured in an addon such as Torrentio, streams arrive as plain
HTTPS URLs. Those play natively with no server at all.

### Build options

| Option | Purpose |
|---|---|
| `--server=http://host:port/` | Bake in the streaming server URL |
| `--build=N` | Set the build number (default: taken from the output filename) |
| `STREMIO_SERVER=...` | Same as `--server`, via environment |

**Always change the output filename or `--build` between builds.** The widget
version is derived from it, and Tizen silently skips installing a package whose
version matches what is already installed.

## On-screen diagnostics

These TVs will not start the web inspector, so the app carries its own overlay.

| Button | Action |
|---|---|
| **BLUE** | Toggle the diagnostic overlay |
| **GREEN** | AVPlay self-test — cycles 5 direct streams (H.264 ×2, HLS, HEVC ×2) |
| **YELLOW** | Scan the local subnet for a Stremio server |
| **RED** | Re-apply the configured streaming server URL |

It opens by itself if the app is still loading after 45 s, and reports console
output, errors with stack traces, unhandled rejections, every network request,
**Web Worker errors** (which never reach `window.onerror`), and AVPlay's real
stream URL and prepare result.

## What gets patched

Tizen 3.0 advertises a legacy WebKit UA but is **Chromium 47** (December 2015).
Each fix targets a feature that shipped later:

| # | Fix | Needs | Symptom |
|---|-----|-------|---------|
| 1 | RegExp lookbehind → ES5 | Chrome 62 | Regex literals are validated at *parse* time, so all 10 MB of `bundle.js` died before running. Permanent splash screen. |
| 2 | Core worker transpiled ES2017 → ES5 | Chrome 55 | Worker threw a SyntaxError invisible to `window.onerror`; core init never settled. Loading screen forever, no errors, no network. |
| 3 | `Reflect` shim in the worker | Chrome 49 | wasm-bindgen sets `RequestInit` via `Reflect.set`; the failure is discarded in release builds, so every POST went out as GET → HTTP 405 on login. |
| 4 | solid-js `destructure()` Proxy fallback | Chrome 49 | `Proxy is not defined` when opening Details. |
| 5 | solid-js `mergeProps()` function sources | Chrome 49 | Blank episode rows; pressing one threw `Cannot read property 'player' of undefined`. |
| 6 | `/tracks/` helper off loopback | — | Cosmetic. |

Fixes 4 and 5 are bugs in solid-js's *non-Proxy fallback paths* — code no
browser has exercised since 2016.

Full write-up, including the device-level evidence: **[docs/TECHNICAL.md](docs/TECHNICAL.md)**

## Updating when a new upstream release ships

Re-run the build against the new `.wgt`. Nothing is forked or vendored, so new
Stremio Theater versions are supported by rebuilding:

```sh
npm run build -- Stremio-Tizen4-new.wgt Stremio-Tizen3-v2.wgt --server=...
```

Patch anchors are matched with **identifier-agnostic regexes**, so a re-minified
upstream (different variable names) still matches. If upstream restructures the
code so an anchor genuinely disappears, the build **fails loudly and writes
nothing**, naming the fix that needs re-deriving — it will never quietly ship a
package with a fix missing.

Run `npm test` after building to confirm the patches behave correctly.

## Project layout

```
build.js              patch + package pipeline
verify.js             checks a built .wgt (ES5, worker intact, shim ordering)
index.html            app shell + diagnostics overlay (strict ES5)
lib/prepare-worker.js extracts and transpiles the embedded core worker
lib/worker-prelude.js the Reflect shim
test/                 unit tests, run against a built package
tools/sdb.js          minimal SDB client - talk to the TV without Tizen Studio
docs/TECHNICAL.md     why each fix exists, with device evidence
```

## Troubleshooting

**Install seems to do nothing / old version still runs.** Change the output
filename or `--build=N`. Confirm by pressing BLUE — the header shows the build
stamp.

**Stuck on the loading screen.** Wait 45 s for the overlay, then read the
errors. Make sure you installed a *patched* build, not the upstream `.wgt`.

**Login fails with a 405.** The `Reflect` shim didn't apply — rebuild and check
for `FIX 3` in the output.

**Server shows Offline.** Press YELLOW to find a server, or RED to re-apply the
configured URL. The machine hosting it must be awake with Stremio running.
Careful typing `:` on the TV keyboard — it is on the symbols page, and a `/`
instead silently points at port 80.

**A torrent won't start but others work.** Usually the release, not the TV.
Prefer well-seeded **x264**; HEVC 10-bit is less reliable. Press GREEN and cycle
to the HEVC entries to test your set.

## Credits

- [Stremio](https://www.stremio.com/) — the app, the core, and the streaming server
- [NoobyGains/stremio-vidaa-tv](https://github.com/NoobyGains/stremio-vidaa-tv) — the Stremio Theater frontend
- [Apps2Samsung](https://github.com/Apps2Samsung/tizen-community-packages) — community packages and the installer that re-signs them
- [kieranbrown/stremio-webos](https://github.com/kieranbrown/stremio-webos) — the webOS build, which showed how the streaming server is meant to be hosted

## License

[MIT](LICENSE). Contains no Stremio code — it patches a package you supply.
