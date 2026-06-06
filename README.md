# Proteus 420 Companion (ProteusERP POS Helper)

A cross-platform desktop companion for the ProteusERP web POS. It runs in the system tray
and bridges the browser-based POS to local hardware and services that a web page can't reach
on its own: receipt printers, cash drawers, document scanners, METRC/OMMA helpers, an offline
transaction queue, desktop notifications, and QZ Tray certificate setup.

The web POS talks to the Companion over a local WebSocket (`ws://localhost:8012`).

- **App id:** `com.proteuserp.pos-helper`
- **Platforms:** Windows (NSIS installer), macOS (signed + notarized DMG), Linux (AppImage)
- **Auto-update:** via `electron-updater` against GitHub Releases

---

## Features

- **Receipt printing** - direct ESC/POS printing through `node-thermal-printer` (no browser print dialog).
- **Cash drawer** - open the drawer attached to the receipt printer.
- **Document scanning** - scan, scan-and-upload, and scan-to-folder for intake/compliance docs.
- **QZ Tray certificate setup** *(v2.3.0)* - read-only check of the QZ Tray printing cert and a
  one-click, self-elevating install (see below). The Companion itself never needs to run as admin.
- **METRC helpers** - accept transfers and look up package history.
- **OMMA verification** - patient/caregiver verification lookups.
- **Offline transaction queue** - queues sales locally (NeDB) when the network is down and retries.
- **Product cache** - local product/package cache for fast lookups and the emergency POS.
- **Emergency POS** - a built-in offline point-of-sale page for when the web POS is unreachable.
- **Desktop notifications** - subscribes to the tenant's Ably realtime channel (over SSE) and
  surfaces OS notifications for incoming SMS / webchat; clicking opens the relevant Proteus page.

---

## How it works

```
  ProteusERP Web POS (browser)            Proteus 420 Companion (this app)
  --------------------------               --------------------------------
  fetch printers / print receipt   <--->   WebSocket server  ws://localhost:8012
  open cash drawer                          - node-thermal-printer (ESC/POS)
  scan a document                           - scanner service
  queue a transaction                       - offline queue (NeDB)
  ...                                        - METRC / OMMA / product cache
                                             - QZ Tray cert check/install
```

The Companion reads its server settings (`apiBaseUrl`, `apiKey`) from the web POS's
`localStorage`, so once the POS is configured the Companion follows the same tenant/server.

---

## WebSocket API

Connect to `ws://localhost:8012` and send a JSON message: `{ "action": "<name>", ...params }`.
The Companion replies with `{ "success": true|false, "data": {...} | "error": "..." }`.

| Action | Purpose |
|---|---|
| `getStatus` | Health/status, incl. `certInstalled` / `qzPresent` (QZ Tray cert state) |
| `getConfiguration` | Selected printer/drawer and config |
| `getPrinters` | List installed printers |
| `print` | Print receipt content to the selected printer |
| `openCashDrawer` | Kick the cash drawer |
| `getScanners` / `scan` / `scanAndUpload` / `scanToFolder` | Document scanning |
| `getScanSettings` / `updateScanSettings` | Scanner config |
| `submitTransaction` / `getQueueStatus` / `retryQueue` / `getQueuedTransactions` / `cancelTransaction` / `retryTransaction` | Offline transaction queue |
| `ommaVerify` | OMMA verification lookup |
| `metrcAcceptTransfer` / `metrcPackageHistory` | METRC helpers |

> Note: browsers treat `localhost` as a secure context, so the page may need Chrome's
> "Apps on your device" / Local Network Access permission allowed for the POS origin before
> it can reach `ws://localhost:8012`.

---

## QZ Tray certificate setup (v2.3.0)

ProteusERP prints through QZ Tray using a self-signed certificate. For silent printing (no
"untrusted website" prompt), QZ Tray must trust that cert via an `override.crt`. The Companion
makes this painless:

- **Check (read-only, no admin):** compares the installed `override.crt` against the live cert
  served at `https://<server>/proteus/webservices/qztray/cert.cfm`.
  - Windows: `C:\Program Files\QZ Tray\override.crt`
  - macOS: `/Applications/QZ Tray.app/Contents/Resources/override.crt`
- **Prompt:** if QZ Tray is installed but the cert is missing/outdated, the Companion shows an
  in-app banner ("Install Silent Printing") and a desktop notification.
- **Install (user-triggered, elevated):** clicking the button writes `override.crt`, sets
  `authcert.override` in `qz-tray.properties`, and restarts QZ Tray. Elevation happens only on
  that click (one UAC on Windows / one admin prompt on macOS) - the Companion process stays
  non-admin.

The server origin is taken from the web POS's configured `apiBaseUrl`. Implemented in
`qz-cert-service.js`.

---

## Configuration

Settings are entered in the Companion window (or inherited from the web POS `localStorage`):

- `apiBaseUrl` - tenant base URL, e.g. `https://cloud.proteuserp.com/yourcompany/`
- `apiKey` - API key for notifications/services
- selected printer / cash drawer

A `config.json` fallback is kept under the app's `userData` directory.

---

## Development

```bash
npm install
npm start            # run the app
npm run start-hidden # start minimized to tray
npm run dev          # run with --dev (DevTools, verbose logging)
```

Requires Node.js + Electron (see `devDependencies`). Logs are written to `app.log` in the
app's `userData` directory.

## Building / releasing

```bash
npm run build-win    # Windows NSIS installer
npm run build-mac    # macOS DMG (signed + notarized)
npm run build-linux  # Linux AppImage
npm run build        # current platform
```

Output goes to `dist/`. Releases publish to GitHub; installed Companions auto-update via
`electron-updater`. **Bump the `version` in `package.json` for every release** or clients won't
pick up the update.

### Platform notes
- **Windows:** NSIS installer (`oneClick: false`, installs to a chosen dir, runs after finish).
- **macOS:** hardened-runtime, signed, and notarized (`entitlements.mac.plist`). Required so
  Gatekeeper lets it run and so privileged actions (like the cert install) work cleanly.

---

## Troubleshooting

- **Web POS can't reach the Companion** - confirm the app is running (tray icon), and that the
  browser has granted "Apps on your device" / Local Network Access for the POS site. Verify the
  socket with the browser console: `new WebSocket('ws://localhost:8012')`.
- **"Untrusted website" / "unknown certificate" when printing** - open the Companion and click
  **Install Silent Printing** (approve the elevation prompt). If it still warns, fully quit and
  reopen QZ Tray, then retry.
- **Nothing prints** - check the selected printer in the Companion and that `node-thermal-printer`
  can reach it (`getPrinters` / test print).
- **No notifications** - confirm `apiBaseUrl` + `apiKey` are set and the status shows `listening`.
