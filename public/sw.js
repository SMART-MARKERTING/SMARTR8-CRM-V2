// Minimal service worker — just enough to make the console installable as a PWA.
// We intentionally do NOT cache app HTML/API (calls + tokens must always be fresh);
// it's a network passthrough so installability works without stale-content risk.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // no-op: let the network handle everything (no offline cache by design)
});
