# Proteus 420 Companion

The **Proteus 420 Companion** is a small desktop app that lets your ProteusERP point-of-sale
print receipts and labels, open the cash drawer, scan documents, and keep working even if the
internet drops. Install it once on each POS computer.

---

## Download

**[Download the latest version](../../releases/latest)**

| Your computer | Download this |
|---|---|
| **Windows** | the `.exe` installer (e.g. `Proteus-420-Companion-Setup-x.y.z.exe`) |
| **Mac** | the `.dmg` file |

> The app **updates itself** automatically after that - you only have to install it once.

---

## Install

### Windows
1. Download the `.exe` installer above and run it.
2. If Windows shows a blue "Windows protected your PC" box, click **More info -> Run anyway**.
3. Follow the prompts. When it finishes, the Companion starts and lives in your system tray
   (bottom-right, by the clock).

### Mac
1. Download the `.dmg`, open it, and drag **Proteus 420 Companion** into your **Applications** folder.
2. Open it from Applications. (The app is signed and notarized by Apple, so it should open normally.)
3. It runs in your menu bar at the top of the screen.

---

## First-time setup

1. Make sure you're logged into your ProteusERP POS in your browser as usual.
2. Open the Companion (tray/menu-bar icon) and enter your **store URL** and **API key** if asked -
   it will then connect to your store automatically.
3. **Enable silent printing:** if you see a banner that says *"Printer setup required"* (or you
   get an *"unknown certificate" / "untrusted website"* message when printing), click
   **Install Silent Printing**. Approve the one Windows/Mac security prompt. That's it - receipts
   will print without any pop-up from then on.

---

## What it does

- **Prints receipts and labels** directly to your local printer.
- **Opens the cash drawer.**
- **Scans documents** (IDs, intake forms, compliance paperwork).
- **Keeps selling if the internet drops** - transactions are saved and sent automatically once
  you're back online.
- **Shows notifications** for incoming texts and chat messages.
- **Sets up secure printing** so QZ Tray trusts your store's certificate (no repeated pop-ups).

---

## Troubleshooting

- **"Untrusted website" / "unknown certificate" when printing**
  Open the Companion and click **Install Silent Printing**, then approve the prompt. If it still
  appears, fully quit QZ Tray (right-click its tray icon -> Exit) and reopen it, then try again.

- **The POS says it can't reach the Companion**
  Make sure the Companion is running (look for its tray / menu-bar icon). On Windows/Chrome you
  may need to allow **"Apps on your device"** for your store's site: click the icon at the left
  of the address bar -> Site settings -> set "Apps on your device" to **Allow**, then refresh.

- **Nothing prints**
  Open the Companion and make sure the correct printer is selected, then try a test print.

- **It didn't update**
  Quit the Companion completely (tray icon -> Exit) and reopen it; it checks for updates on start.

---

## Support

Need help? Contact ProteusERP support at **support@proteuserp.com**.
