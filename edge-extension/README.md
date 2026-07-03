# Smartr8 Console — Edge/Chrome extension

A one-click launcher: clicking the toolbar icon opens the full **Smartr8 Console**
(calls · texts · contacts) in its own app window. The console page itself runs the
Telnyx WebRTC client and audio, so there's no offscreen document or vendored SDK to
manage — the extension is just `manifest.json` + `background.js` + icons.

## Files
- `manifest.json` — MV3 manifest (action + service worker)
- `background.js` — on icon click, opens/focuses the console window
- `icons/` — toolbar/app icons

## Load it in Microsoft Edge (unpacked — no store needed)
1. On GitHub: **Code ▸ Download ZIP**, unzip. (Or `git clone`.)
2. Go to **edge://extensions** → turn on **Developer mode** (bottom-left).
3. Click **Load unpacked** → select the **`edge-extension`** folder.
4. Pin it (puzzle-piece icon → pin **Smartr8 Console**).
5. Click the icon → the console opens. Enter your passcode → allow the microphone
   when you first place/answer a call.

## Notes
- After editing files, return to **edge://extensions** and click **Reload** on the card.
- Works the same in Chrome (Chromium).
- The console is also reachable directly at
  `https://smartr8-texting-1wx7.onrender.com/console` (and installable as a PWA on phones).
