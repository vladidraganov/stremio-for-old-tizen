# Contributing

Bug reports from other TV models are especially useful — this is verified on a
UE43MU6172, and Tizen 2.x / other 3.0 sets may behave differently.

## Reporting a problem

Press **BLUE** on the TV and attach a **photo of the overlay**. It shows the
engine fingerprint, errors with stack traces, every network request, worker
state and the player's real stream URL — which is usually enough to diagnose
without owning the TV.

Also include your TV model, the build stamp in the overlay header, and whether
you use a LAN server or direct links.

## Development setup

```sh
npm install
curl -L -o upstream.wgt \
  "https://github.com/Apps2Samsung/tizen-community-packages/releases/latest/download/Stremio-Tizen4.wgt"
npm run build -- upstream.wgt out-v1.wgt
npm run verify -- out-v1.wgt
npm test
```

Bump the output filename or `--build=N` every time. Tizen skips installing a
package whose version matches what is already installed, and you will spend an
hour debugging a build that never landed. (Ask how we know.)

## How the patcher works

`build.js` rewrites specific constructs inside the upstream bundle. Two rules
keep it honest:

1. **Every anchor must match exactly once.** Zero matches or several, and the
   build aborts without writing a file. It must never ship a package with a fix
   silently missing.
2. **Anchors are identifier-agnostic.** Upstream is minified, so patterns
   capture variable names rather than hardcoding them. `\w+` with backreferences
   instead of the literal `A`, `k`, `e` you happen to see today.

Both gates exist so a future upstream release either builds correctly or fails
visibly.

## Adding a fix

1. Reproduce on device and capture the overlay output.
2. Find the construct in the upstream `bundle.js`. Working from a pretty-printed
   copy helps; patch against the minified original.
3. Write an **identifier-agnostic** regex anchor, then add it to `build.js` via
   `matchOne()`.
4. Add a test under `test/` that pulls the patched code out of a **built**
   package and exercises it with the relevant feature removed — see
   `test/destructure.test.js`, which deletes `Proxy` to emulate Chromium 47.
5. Document it in `docs/TECHNICAL.md`: what broke, which Chrome version
   introduced the feature, and how the symptom presented.

## Style

- The app shell (`index.html`) is **strict ES5** — no arrow functions, `let`,
  template literals, or modern regex syntax. It runs on Chromium 47 and the
  build refuses to package it otherwise. That gate has already caught several
  mistakes.
- Build scripts are Node and may use modern syntax freely.
- Comments should explain *why*, especially where code looks odd because a 2015
  browser demanded it.

## What not to commit

`.wgt` files (upstream or built), `worker.es5.js`, `node_modules/`. All
gitignored. This repo ships no Stremio code, and published builds must never
carry anyone's LAN address — release builds are made without `--server`.
