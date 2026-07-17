(function () {
  "use strict";

  var cap = window.Capacitor;
  var isNative = Boolean(cap && cap.isNativePlatform && cap.isNativePlatform());
  var apiOrigin = String(window.SMARTR8_NATIVE_API_ORIGIN || "https://crm.smartr8.com").replace(/\/+$/, "");
  var securePrefix = "smartr8.crm.";
  var sessionKey = "sessionToken";
  var deviceKey = "deviceId";
  var tokenKey = "apnsToken";
  var originalFetch = window.fetch ? window.fetch.bind(window) : null;
  var listenersInstalled = false;
  var registering = false;

  function plugin(name) {
    return cap && cap.Plugins ? cap.Plugins[name] : null;
  }

  function randomId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    var bytes = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    return Array.from(bytes, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  async function secureGet(key) {
    var storage = plugin("SecureStorage");
    if (!storage || !storage.internalGetItem) return null;
    try {
      var result = await storage.internalGetItem({ prefixedKey: securePrefix + key, sync: false });
      return result && typeof result.data === "string" && result.data ? result.data : null;
    } catch (_error) {
      return null;
    }
  }

  async function secureSet(key, value) {
    var storage = plugin("SecureStorage");
    if (!storage || !storage.internalSetItem) return;
    await storage.internalSetItem({
      prefixedKey: securePrefix + key,
      data: String(value || ""),
      sync: false,
      access: 1
    });
  }

  async function secureRemove(key) {
    var storage = plugin("SecureStorage");
    if (!storage || !storage.internalRemoveItem) return;
    try {
      await storage.internalRemoveItem({ prefixedKey: securePrefix + key, sync: false });
    } catch (_error) {}
  }

  async function deviceId() {
    var existing = await secureGet(deviceKey);
    if (existing) return existing;
    var created = randomId();
    await secureSet(deviceKey, created);
    return created;
  }

  function nativePath(path) {
    var raw = String(path || "");
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw)) {
      try {
        var parsed = new URL(raw);
        if (parsed.origin !== apiOrigin) return null;
        raw = parsed.pathname + parsed.search;
      } catch (_error) {
        return null;
      }
    }
    if (raw.indexOf("/v2/") === 0 || raw === "/v2") return raw;
    if (/^\/(api|webrtc|calls|dnc|admin|ghl|oauth|providers|webhooks|media|calendar\.ics)(\/|$|\?)/.test(raw)) return "/v2" + raw;
    return null;
  }

  function headersObject(headers) {
    var out = {};
    if (!headers) return out;
    new Headers(headers).forEach(function (value, key) { out[key] = value; });
    return out;
  }

  async function nativeHeaders(headers) {
    var out = headersObject(headers);
    out["x-smart-r8-native"] = "ios";
    out["x-smart-r8-native-device-id"] = await deviceId();
    var token = await secureGet(sessionKey);
    if (token) out["x-session-token"] = token;
    return out;
  }

  function responseFromNative(result) {
    var data = result && result.data != null ? result.data : "";
    var body = typeof data === "string" ? data : JSON.stringify(data);
    return new Response(body, {
      status: result && result.status ? result.status : 200,
      headers: result && result.headers ? result.headers : {}
    });
  }

  async function rememberLoginToken(response, url, method) {
    if (!/\/api\/auth\/login$/.test(url) || method !== "POST") return;
    try {
      var data = await response.clone().json();
      if (data && data.nativeSessionToken) {
        await secureSet(sessionKey, data.nativeSessionToken);
        await syncNativeRegistration();
        await syncBadge();
      }
    } catch (_error) {}
  }

  async function forgetSessionAfterLogout(response, url) {
    if (!/\/api\/auth\/logout$/.test(url)) return;
    if (response.ok || response.status === 401) {
      await secureRemove(sessionKey);
      await secureRemove(tokenKey);
      await clearBadge();
    }
  }

  async function nativeFetch(input, opts) {
    if (!isNative || !originalFetch) return originalFetch(input, opts);
    opts = opts || {};
    if (typeof input !== "string" && !(input instanceof URL)) return originalFetch(input, opts);
    var path = nativePath(String(input));
    if (!path) return originalFetch(input, opts);
    var url = apiOrigin + path;
    var method = String(opts.method || "GET").toUpperCase();
    var headers = await nativeHeaders(opts.headers);
    var http = plugin("CapacitorHttp");
    if (!http || !http.request) return originalFetch(url, Object.assign({}, opts, { headers: headers }));
    var result = await http.request({
      url: url,
      method: method,
      headers: headers,
      data: opts.body,
      responseType: "text"
    });
    var response = responseFromNative(result);
    await rememberLoginToken(response, url, method);
    await forgetSessionAfterLogout(response, url);
    if (response.status === 401 && (/\/api\/auth\/me$/.test(url) || /\/api\/native\//.test(url))) await secureRemove(sessionKey);
    return response;
  }

  function approvedNativeLink(value) {
    try {
      var parsed = new URL(String(value || "/v2/?page=notifications"), "https://crm.smartr8.com");
      if (parsed.origin !== "https://crm.smartr8.com") return "/v2/?page=notifications";
      if (parsed.pathname !== "/v2" && parsed.pathname !== "/v2/") return "/v2/?page=notifications";
      if (parsed.hash) return "/v2/?page=notifications";
      var rawPage = (parsed.searchParams.get("page") || "notifications").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 40);
      var page = rawPage === "conversations" ? "messages" : rawPage;
      if (["notifications", "messages", "dialer"].indexOf(page) < 0) return "/v2/?page=notifications";
      var allowed = page === "dialer" ? ["page", "call", "lead"] : page === "messages" ? ["page", "lead", "event"] : ["page", "event"];
      var keys = Array.from(parsed.searchParams.keys());
      if (keys.some(function (key) { return allowed.indexOf(key) < 0; })) return "/v2/?page=notifications";
      var output = new URL("https://crm.smartr8.com/v2/");
      output.searchParams.set("page", page);
      allowed.forEach(function (key) {
        if (key === "page" || !parsed.searchParams.has(key)) return;
        var value = (parsed.searchParams.get(key) || "").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 128);
        if (value) output.searchParams.set(key, value);
      });
      return output.pathname + output.search;
    } catch (_error) {
      return "/v2/?page=notifications";
    }
  }

  function goToNativeLink(value) {
    var path = approvedNativeLink(value);
    if (location.pathname + location.search === path) {
      window.dispatchEvent(new PopStateEvent("popstate"));
      return;
    }
    location.assign(path);
  }

  async function syncNativeRegistration() {
    var token = await secureGet(tokenKey);
    var session = await secureGet(sessionKey);
    if (!token || !session) return false;
    var body = {
      platform: "ios",
      deviceId: await deviceId(),
      token: token,
      environment: window.SMARTR8_NATIVE_APNS_ENVIRONMENT || "production",
      appVersion: window.SMARTR8_NATIVE_APP_VERSION || "0.1.0",
      buildNumber: window.SMARTR8_NATIVE_BUILD_NUMBER || "1",
      deviceLabel: window.SMARTR8_NATIVE_DEVICE_LABEL || "iPhone"
    };
    var response = await nativeFetch("/api/native/push/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (response.status === 409 || response.status === 401) await secureRemove(tokenKey);
    return response.ok;
  }

  async function recordNotificationOpened(eventId) {
    var id = String(eventId || "").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 128);
    if (!id) return;
    await nativeFetch("/api/notifications/" + encodeURIComponent(id) + "/opened", { method: "POST" }).catch(function () {});
  }

  async function installNativeListeners() {
    if (!isNative || listenersInstalled) return;
    listenersInstalled = true;
    var push = plugin("PushNotifications");
    if (push && push.addListener) {
      await push.addListener("registration", async function (token) {
        if (token && token.value) {
          await secureSet(tokenKey, token.value);
          await syncNativeRegistration();
        }
      });
      await push.addListener("registrationError", function (_error) {});
      await push.addListener("pushNotificationActionPerformed", function (event) {
        var data = event && event.notification && event.notification.data ? event.notification.data : {};
        if (data.eventId) recordNotificationOpened(data.eventId);
        goToNativeLink(data.deepLink || data.url || "/v2/?page=notifications");
      });
      await push.addListener("pushNotificationReceived", function (event) {
        var data = event && event.data ? event.data : {};
        if (data.badgeCount != null) syncBadge(Number(data.badgeCount));
      });
    }
    var app = plugin("App");
    if (app && app.addListener) {
      await app.addListener("appUrlOpen", function (event) {
        if (event && event.url) goToNativeLink(event.url);
      });
    }
  }

  async function enableNotifications() {
    if (!isNative) throw new Error("Native notifications are available only in the iOS app.");
    if (registering) return localPushState();
    registering = true;
    try {
      await installNativeListeners();
      var push = plugin("PushNotifications");
      if (!push || !push.requestPermissions || !push.register) throw new Error("Native push plugin is unavailable.");
      var permission = await push.requestPermissions();
      if (!permission || permission.receive !== "granted") throw new Error("Notifications are not allowed for this iPhone.");
      var badge = plugin("Badge");
      if (badge && badge.requestPermissions) await badge.requestPermissions().catch(function () {});
      await push.register();
      await syncNativeRegistration();
      await syncBadge();
      return localPushState();
    } finally {
      registering = false;
    }
  }

  async function disableNotifications() {
    var id = await deviceId();
    await nativeFetch("/api/native/push/disable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: id })
    }).catch(function () {});
    var push = plugin("PushNotifications");
    if (push && push.unregister) await push.unregister().catch(function () {});
    await secureRemove(tokenKey);
    await clearBadge();
  }

  async function sendTestNotification() {
    var response = await nativeFetch("/api/native/push/test", { method: "POST" });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(data.error || "Native notification test failed.");
    await syncBadge();
    return data;
  }

  async function clearBadge() {
    var badge = plugin("Badge");
    if (badge && badge.clear) await badge.clear().catch(function () {});
  }

  async function syncBadge(forcedCount) {
    if (!isNative) return;
    var count = Number(forcedCount);
    if (!Number.isFinite(count)) {
      var response = await nativeFetch("/api/native/badge", { method: "GET" });
      var data = await response.json().catch(function () { return {}; });
      count = Number(data.badgeCount || 0);
    }
    var badge = plugin("Badge");
    if (!badge) return;
    if (count > 0 && badge.set) await badge.set({ count: count }).catch(function () {});
    else if (badge.clear) await badge.clear().catch(function () {});
  }

  async function localPushState() {
    if (!isNative) return { supported: false, installed: false, permission: "unsupported", subscription: null, native: false };
    await installNativeListeners();
    var permission = "prompt";
    var push = plugin("PushNotifications");
    if (push && push.checkPermissions) {
      var checked = await push.checkPermissions().catch(function () { return {}; });
      permission = checked.receive || "prompt";
    }
    var statusResponse = await nativeFetch("/api/native/push/status", { method: "GET" }).catch(function () { return null; });
    var status = statusResponse ? await statusResponse.json().catch(function () { return {}; }) : {};
    return {
      supported: true,
      installed: true,
      permission: permission,
      subscription: status.activeDeviceCount > 0 ? { native: true } : null,
      native: true,
      deliveryConfigured: Boolean(status.deliveryConfigured),
      error: status.error || ""
    };
  }

  async function afterLogin(data) {
    if (data && data.nativeSessionToken) await secureSet(sessionKey, data.nativeSessionToken);
    await syncNativeRegistration();
    await syncBadge();
  }

  async function afterLogout() {
    await secureRemove(sessionKey);
    await secureRemove(tokenKey);
    await clearBadge();
  }

  window.SmartR8Native = {
    isNative: isNative,
    localPushState: localPushState,
    enableNotifications: enableNotifications,
    disableNotifications: disableNotifications,
    sendTestNotification: sendTestNotification,
    afterLogin: afterLogin,
    afterSessionRestored: async function () {
      await syncNativeRegistration();
      return syncBadge();
    },
    afterLogout: afterLogout,
    syncBadge: syncBadge,
    sanitizeDeepLink: approvedNativeLink
  };

  if (isNative) {
    window.fetch = nativeFetch;
    installNativeListeners().catch(function () {});
  }
})();
