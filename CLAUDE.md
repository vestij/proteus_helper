# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Proteus POS Helper is an Electron-based desktop companion application for the Proteus ERP web-based SaaS POS system. It bridges the gap between web applications and local hardware devices (printers, cash drawers, document scanners) via WebSocket communication on port 8012.

## Build & Development Commands

```bash
# Development
npm start              # Run the Electron app
npm run dev            # Run in dev mode
npm start -- --hidden  # Start minimized to system tray

# Scanner testing (no physical hardware needed)
ENABLE_TEST_SCANNER=true npm start

# Production builds
npm run build          # Build for current platform
npm run build-win      # Windows NSIS installer
npm run build-mac      # macOS DMG
npm run build-linux    # Linux AppImage
npm run pack           # Build without installer (for testing)
```

## Architecture

### Core Components

- **main.js**: Electron main process - WebSocket server, IPC handlers, system tray, all hardware communication logic
- **index.html**: Single-page renderer UI with embedded JavaScript - configuration interface for printer/drawer/scanner selection
- **scanner-service.js**: ScannerService class - multi-platform scanner detection (WIA/TWAIN/SANE) and image processing with Sharp

### Communication Flow

```
Web SaaS App <--WebSocket:8012--> main.js <--IPC--> index.html (UI)
                                    |
                            PowerShell/exec
                                    |
                    Printers, Cash Drawers, Scanners
```

### WebSocket API Actions

The WebSocket server (`port 8012`) accepts JSON messages with these actions:

| Action | Purpose |
|--------|---------|
| `print` | Print content (HTML or plain text) to thermal printer |
| `openCashDrawer` | Send ESC/POS drawer kick command |
| `getPrinters` | List available system printers |
| `getConfiguration` | Return saved printer/drawer/scanner settings |
| `getStatus` | Health check |
| `getScanners` | Detect available scanning devices |
| `scan` | Scan document to temp file |
| `scanAndUpload` | Scan and POST to SaaS API |
| `scanToFolder` | Scan with folder context metadata |
| `getScanSettings` / `updateScanSettings` | Manage scan defaults |
| `submitTransaction` | Submit transaction (queues if offline) |
| `getQueueStatus` | Get pending/synced transaction counts |
| `retryQueue` | Force retry of queued transactions |
| `getQueuedTransactions` | List queued transaction details |
| `cancelTransaction` | Cancel a queued transaction |

### Configuration Storage

- **localStorage** (renderer): User selections persisted in Electron's localStorage
- **config.json** (app directory): Exported settings including API key for main process access
- Settings sync: UI saves to both localStorage and config.json via `save-config` IPC

### Printing Implementation

HTML content is printed via hidden BrowserWindow with `webContents.print()`. Plain text uses PowerShell `Out-Printer` on Windows. Cash drawer opens via ESC/POS binary command `[0x1B, 0x70, 0x00, 0x19, 0xFA]`.

### Scanner Implementation

ScannerService uses cascading detection: WIA -> TWAIN -> Network MFP -> PnP -> USB -> Generic services. Virtual scanner available for testing without hardware. Image processing uses Sharp for auto-orient, normalize, and format conversion.

### Offline Transaction Queue

TransactionQueueService provides offline resilience for POS transactions:
- Uses NeDB for local storage in `{userData}/transaction-queue.db`
- Automatically queues transactions when network is unavailable
- Auto-retries with exponential backoff when connection restores
- Idempotency keys prevent duplicate submissions
- Test mode available: `TEST_QUEUE=true npm start` or `npm start -- --test-queue`

## Key Files

| File | Lines | Purpose |
|------|-------|---------|
| main.js | ~2350 | All main process logic, WebSocket server, IPC handlers |
| index.html | ~1250 | Complete UI with embedded CSS and JavaScript |
| scanner-service.js | ~1250 | Scanner detection and acquisition |
| transaction-queue-service.js | ~650 | Offline transaction queue with NeDB |
| config.json | Runtime | Current hardware selections and API config |

## Platform-Specific Notes

- **Windows**: Uses PowerShell for printer detection, WIA/TWAIN for scanners, NSIS installer
- **Linux**: Uses `lpr` for printing, SANE for scanners, requires `sane-utils` package
- **macOS**: Uses `lpr` for printing, basic scanner support via system_profiler

## App Behavior

- Runs in system tray by default (minimizes to tray on close)
- Single instance enforced via `requestSingleInstanceLock()`
- Auto-starts on Windows login with `--hidden` flag
- Certificate errors bypassed for development environments
