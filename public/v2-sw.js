/* SmartR8 V2 service worker: push only. It intentionally does not cache CRM HTML,
   authenticated APIs, borrower data, messages, email, faxes, or documents. */
const FALLBACK_URL = "/v2?page=notifications";

function safePayload(event) {
  try {
    const data = event.data ? event.data.json() : {};
    return data && typeof data === "object" ? data : {};
  } catch (_error) {
    return {};
  }
}

function safeDeepLink(value) {
  try {
    const url = new URL(typeof value === "string" ? value : FALLBACK_URL, self.location.origin);
    if (url.origin !== self.location.origin || (url.pathname !== "/v2" && url.pathname !== "/v2/")) return FALLBACK_URL;
    return url.pathname + url.search;
  } catch (_error) {
    return FALLBACK_URL;
  }
}

async function updateBadge(count) {
  try {
    if (self.navigator && typeof self.navigator.setAppBadge === "function") {
      if (Number(count) > 0) await self.navigator.setAppBadge(Number(count));
      else if (typeof self.navigator.clearAppBadge === "function") await self.navigator.clearAppBadge();
    }
  } catch (_error) {
    // Badging is optional and is not supported by every Web Push implementation.
  }
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  const data = safePayload(event);
  const title = typeof data.title === "string" && data.title ? data.title.slice(0, 80) : "SmartR8 CRM";
  const body = typeof data.body === "string" && data.body ? data.body.slice(0, 160) : "New activity in SmartR8";
  const tag = typeof data.tag === "string" && data.tag ? data.tag.slice(0, 200) : "smartr8:update";
  const eventId = typeof data.eventId === "string" ? data.eventId.slice(0, 128) : "";
  const deepLink = safeDeepLink(data.deepLink);
  const options = {
    body,
    tag,
    renotify: false,
    icon: "/v2/public/icons/app-192.png",
    badge: "/v2/public/icons/app-192.png",
    data: { eventId, deepLink },
  };
  event.waitUntil(Promise.all([
    self.registration.showNotification(title, options),
    data.badge === false ? updateBadge(0) : updateBadge(data.badgeCount || 1),
  ]));
});

async function recordReceipt(eventId, action) {
  if (!eventId) return;
  try {
    await fetch(`/v2/api/notifications/${encodeURIComponent(eventId)}/${action}`, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
    });
  } catch (_error) {
    // Opening the CRM remains more important than receipt telemetry.
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const targetPath = safeDeepLink(data.deepLink);
  const targetUrl = new URL(targetPath, self.location.origin).href;
  event.waitUntil((async () => {
    await recordReceipt(data.eventId, "opened");
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => {
      try { return new URL(client.url).origin === self.location.origin; } catch (_error) { return false; }
    });
    if (existing) {
      if (typeof existing.navigate === "function") await existing.navigate(targetUrl);
      await existing.focus();
      return;
    }
    await self.clients.openWindow(targetUrl);
  })());
});

self.addEventListener("notificationclose", (event) => {
  const data = event.notification.data || {};
  event.waitUntil(recordReceipt(data.eventId, "dismiss"));
});
