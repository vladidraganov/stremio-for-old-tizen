## Stremio for old Tizen

A ready-to-install build for **2017-era Samsung TVs (Tizen 3.0)**, where the
standard community package installs but hangs forever on the loading screen.

### Install

1. Enable **Developer Mode** on the TV
   (Apps → press `1` `2` `3` `4` `5` on the remote → Developer mode → On → enter your PC's IP)
2. Download the `.wgt` below
3. Install it with [Apps2Samsung](https://github.com/Apps2Samsung) → **custom WGT**
   (it re-signs the package for you — Tizen Studio is not required)
4. Launch Stremio from the TV's app list and sign in

### Playing torrents

A Tizen web app cannot run a BitTorrent engine — these TVs allow no sockets and
will not start a process ([why](../blob/main/docs/TECHNICAL.md#why-the-streaming-server-cannot-run-on-the-tv)).
Pick one:

- **Point at a Stremio server on your network.** Anything already running
  Stremio works — an LG webOS TV, a NAS, a Raspberry Pi, a PC.
  Press **YELLOW** in the app to scan your network and find it, then enter the
  address in **Settings → SERVER → EDIT_URL**.
  Watch the `:` — on the TV keyboard it lives on the symbols page, and typing
  `/` instead silently points at port 80.
- **Use direct links.** With a debrid service (Real-Debrid, AllDebrid,
  Premiumize) set up in an addon like Torrentio, streams arrive as plain HTTPS
  URLs and play with no server at all.

Prefer well-seeded **x264** releases; HEVC 10-bit is less reliable on these sets.

### On-screen diagnostics

These TVs refuse to start the web inspector, so the app carries its own.

| Button | Action |
|---|---|
| **BLUE** | Toggle the diagnostic overlay |
| **GREEN** | Player self-test — cycles 5 direct streams |
| **YELLOW** | Scan your network for a Stremio server |
| **RED** | Re-apply the configured server URL |

Reporting a problem? Press BLUE and attach a photo of the screen — it shows the
engine version, errors with stack traces, network requests and the player state.

### Build it yourself

Prefer to bake in your own server URL, or build from a specific upstream
version? See the [README](../blob/main/README.md):

```sh
npm install
npm run build -- Stremio-Tizen4.wgt out.wgt --server=http://192.168.1.50:11470/
```

### Credits

Built on [Stremio](https://www.stremio.com/), the
[Stremio Theater frontend](https://github.com/NoobyGains/stremio-vidaa-tv) and
the [Apps2Samsung community packages](https://github.com/Apps2Samsung/tizen-community-packages).
This project contains no Stremio code — it patches the upstream package so it
runs on older hardware.
