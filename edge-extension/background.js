// Clicking the toolbar icon opens the full Smartr8 Console as its own app window
// (calls + texts + contacts). The console page runs the Telnyx WebRTC client and
// audio directly — no offscreen document needed when it lives in a real window.
const CONSOLE_URL = "https://smartr8-texting-1wx7.onrender.com/console";

chrome.action.onClicked.addListener(async () => {
  // Reuse an existing console window/tab if one is already open.
  const tabs = await chrome.tabs.query({ url: CONSOLE_URL + "*" });
  if (tabs.length && tabs[0].windowId != null) {
    await chrome.windows.update(tabs[0].windowId, { focused: true });
    await chrome.tabs.update(tabs[0].id, { active: true });
    return;
  }
  await chrome.windows.create({ url: CONSOLE_URL, type: "popup", width: 480, height: 820 });
});
