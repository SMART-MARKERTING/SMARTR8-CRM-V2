import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  apnsEnvironmentForDevice,
  classifyApnsResponse,
  sanitizeApnsCollapseId,
  sendNativeApnsAlert,
  type ApnsDeliveryRequest,
  type ApnsSendResult,
} from "./apns";
import { createUser, setDisabled } from "./auth";
import { log } from "../logger";
import { db } from "../store/db";
import { registerNativePushDevice, revokeNativePushDevicesForUser, safeNativeDeepLink } from "./nativePush";
import {
  buildNativeApnsPayload,
  processNativeNotificationBatch,
  resolveNativeApnsEnvironmentForDevice,
  type NativeApnsSender,
} from "./nativeNotificationWorker";
import { createNotificationEvent, markNotificationReceipt, updateNotificationPreferences, type NotificationKind } from "./notifications";

const run = `native-apns-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const users: string[] = [];

function user(name: string) {
  const created = createUser({
    username: `${run}-${name}`,
    password: "native-apns-test-password",
    name,
    role: "user",
    permissions: ["dashboard", "messages", "email", "fax", "dialer", "settings"],
  });
  users.push(created.id);
  return created;
}

function token(suffix: string): string {
  return `${run}-token-${suffix}-${"a".repeat(64)}`;
}

function register(userId: string, suffix: string, environment: "development" | "production" = "production") {
  return registerNativePushDevice(userId, {
    platform: "ios",
    deviceId: `${run}-device-${suffix}`,
    token: token(suffix),
    environment,
    appVersion: "0.2.0",
    buildNumber: "2",
    deviceLabel: "Test iPhone",
  });
}

function event(
  userId: string,
  suffix: string,
  opts: { kind?: NotificationKind; deepLink?: string; tag?: string; firstName?: string } = {},
) {
  const kind = opts.kind || "test";
  const created = createNotificationEvent({
    kind,
    provider: run,
    providerEventId: `${run}:provider:${suffix}`,
    sourceType: "native-apns-test",
    sourceRecordId: `${run}:source:${suffix}`,
    deepLink: opts.deepLink || "/v2/?page=notifications",
    notificationTag: opts.tag,
    explicitUserId: userId,
    contactFirstName: opts.firstName || "Alice Sensitive",
  });
  assert.ok(created);
  return created.event;
}

function ok(apnsId = "apns-id"): ApnsSendResult {
  return {
    ok: true,
    statusCode: 200,
    apnsId,
    reason: null,
    retryable: false,
    expired: false,
    invalidToken: false,
    throttled: false,
    authenticationFailure: false,
    configurationFailure: false,
    responseBody: "",
  };
}

function failed(overrides: Partial<ApnsSendResult>): ApnsSendResult {
  return {
    ok: false,
    statusCode: 500,
    apnsId: null,
    reason: null,
    retryable: true,
    expired: false,
    invalidToken: false,
    throttled: false,
    authenticationFailure: false,
    configurationFailure: false,
    responseBody: "",
    error: "APNs transient delivery failure",
    ...overrides,
  };
}

function deliveryRows(eventId: string): Array<{ status: string; attempt_count: number; native_device_id: string }> {
  return db.prepare(
    `SELECT status, attempt_count, native_device_id
       FROM native_push_deliveries
      WHERE event_id = ?
      ORDER BY created_at ASC`,
  ).all(eventId) as Array<{ status: string; attempt_count: number; native_device_id: string }>;
}

after(() => {
  db.prepare(`DELETE FROM notification_events WHERE provider = ?`).run(run);
  if (users.length) {
    const placeholders = users.map(() => "?").join(",");
    db.prepare(`DELETE FROM native_push_devices WHERE user_id IN (${placeholders})`).run(...users);
    db.prepare(`DELETE FROM push_subscriptions WHERE user_id IN (${placeholders})`).run(...users);
    db.prepare(`DELETE FROM sessions WHERE user_id IN (${placeholders})`).run(...users);
    db.prepare(`DELETE FROM notification_preferences WHERE user_id IN (${placeholders})`).run(...users);
    db.prepare(`DELETE FROM users WHERE id IN (${placeholders})`).run(...users);
  }
});

test("APNs adapter classifies responses and refuses missing configuration without network access", async () => {
  assert.equal(apnsEnvironmentForDevice("development", { keyId: "", teamId: "", topic: "", privateKey: "", environment: "auto", expirationSeconds: 600 }), "sandbox");
  assert.equal(apnsEnvironmentForDevice("production", { keyId: "", teamId: "", topic: "", privateKey: "", environment: "auto", expirationSeconds: 600 }), "production");
  assert.equal(resolveNativeApnsEnvironmentForDevice("development"), "production");
  assert.equal(sanitizeApnsCollapseId("call:abc !@#$%^&*".repeat(10)).length <= 64, true);

  assert.equal(classifyApnsResponse(200).ok, true);
  assert.equal(classifyApnsResponse(410, JSON.stringify({ reason: "Unregistered", timestamp: 1 })).expired, true);
  assert.equal(classifyApnsResponse(400, JSON.stringify({ reason: "BadDeviceToken" })).invalidToken, true);
  assert.equal(classifyApnsResponse(403, JSON.stringify({ reason: "InvalidProviderToken" })).authenticationFailure, true);
  assert.equal(classifyApnsResponse(429, JSON.stringify({ reason: "TooManyRequests" })).retryable, true);
  assert.equal(classifyApnsResponse(503, JSON.stringify({ reason: "Shutdown" })).retryable, true);

  let called = false;
  const request: ApnsDeliveryRequest = {
    deviceToken: `${run}-raw-apns-token-${"b".repeat(48)}`,
    deviceTokenFingerprint: "fingerprint",
    deviceEnvironment: "production",
    apnsId: "11111111-1111-4111-8111-111111111111",
    collapseId: "test:missing-config",
    payload: { aps: { alert: { title: "SmartR8 CRM", body: "Generic alert" } } },
  };
  const result = await sendNativeApnsAlert(request, {
    apns: { keyId: "", teamId: "TEAMID", topic: "com.smartr8.crm", privateKey: "not-a-private-key", environment: "production", expirationSeconds: 600 },
    transport: async () => {
      called = true;
      throw new Error("network should not be reached");
    },
  });
  assert.equal(called, false);
  assert.equal(result.configurationFailure, true);
  assert.doesNotMatch(result.error || "", new RegExp(request.deviceToken));
});

test("native APNs worker sends generic payloads with badge and collapse metadata", async () => {
  const owner = user("generic");
  register(owner.id, "generic");
  const created = event(owner.id, "generic", {
    kind: "incoming_email",
    deepLink: "/v2/?page=email&lead=lead_123&token=secret",
    tag: "email:generic",
    firstName: "Alice",
  });

  const captured: ApnsDeliveryRequest[] = [];
  const sender: NativeApnsSender = async (request) => {
    captured.push(request);
    return ok(request.apnsId);
  };
  const result = await processNativeNotificationBatch(sender, { onlyUserId: owner.id });
  assert.equal(result.delivered, 1);
  assert.equal(captured.length, 1);
  const request = captured[0];
  assert.equal(request.collapseId, "email:generic");
  assert.equal(request.deviceEnvironment, "production");
  assert.equal((request.payload as { aps: { badge: number } }).aps.badge, 1);
  assert.equal((request.payload as { deepLink: string }).deepLink, "/v2/?page=notifications");
  const serialized = JSON.stringify(request.payload);
  assert.match(serialized, /New borrower email/);
  assert.doesNotMatch(serialized, /Alice|secret|lead_123|token|phone|SSN|loan/i);
  assert.equal(deliveryRows(created.id)[0].status, "delivered");
});

test("native APNs routing keeps sandbox and production devices separate", async () => {
  const owner = user("environments");
  register(owner.id, "sandbox", "development");
  register(owner.id, "production", "production");
  const created = event(owner.id, "environments");
  const environments: string[] = [];
  const sender: NativeApnsSender = async (request) => {
    environments.push(request.deviceEnvironment);
    return ok(request.apnsId);
  };
  const result = await processNativeNotificationBatch(sender, { onlyUserId: owner.id });
  assert.equal(result.delivered, 2);
  assert.deepEqual(environments.sort(), ["development", "production"]);
  assert.equal(apnsEnvironmentForDevice("development", { keyId: "", teamId: "", topic: "", privateKey: "", environment: "sandbox", expirationSeconds: 600 }), "sandbox");
  assert.equal(apnsEnvironmentForDevice("development", { keyId: "", teamId: "", topic: "", privateKey: "", environment: "production", expirationSeconds: 600 }), "production");
  assert.equal(deliveryRows(created.id).every((row) => row.status === "delivered"), true);
});

test("native deep links reject external origins, API routes, console paths, and unapproved parameters", () => {
  assert.equal(safeNativeDeepLink("https://evil.example/v2/?page=notifications").ok, false);
  assert.equal(safeNativeDeepLink("/v2/api/notifications").ok, false);
  assert.equal(safeNativeDeepLink("/console?page=notifications").ok, false);
  assert.equal(safeNativeDeepLink("/api/native/push/status").ok, false);
  assert.equal(safeNativeDeepLink("/v2/?page=notifications&token=secret").ok, false);
  assert.deepEqual(safeNativeDeepLink("/v2/?page=dialer&call=call_1"), { ok: true, path: "/v2/?page=dialer&call=call_1" });
});

test("native APNs worker retries transient failures and stops at the permanent limit", async () => {
  const owner = user("retry");
  register(owner.id, "retry");
  const created = event(owner.id, "retry");
  const temporary: NativeApnsSender = async () => failed({ statusCode: 503, retryable: true, error: "APNs transient delivery failure" });
  const first = await processNativeNotificationBatch(temporary, { onlyUserId: owner.id });
  assert.equal(first.retried, 1);
  let row = deliveryRows(created.id)[0];
  assert.equal(row.status, "retry");
  assert.equal(row.attempt_count, 1);

  db.prepare(`UPDATE native_push_deliveries SET status = 'pending', attempt_count = 4, next_attempt_at = 0 WHERE event_id = ?`).run(created.id);
  const last = await processNativeNotificationBatch(temporary, { onlyUserId: owner.id });
  assert.equal(last.failed, 1);
  row = deliveryRows(created.id)[0];
  assert.equal(row.status, "failed");
  assert.equal(row.attempt_count, 5);
});

test("expired or unregistered APNs tokens revoke the native device", async () => {
  const owner = user("expired");
  const registered = register(owner.id, "expired");
  const created = event(owner.id, "expired");
  const gone: NativeApnsSender = async () => failed({
    statusCode: 410,
    reason: "Unregistered",
    retryable: false,
    expired: true,
    invalidToken: true,
    responseBody: "Unregistered",
    error: "APNs rejected device token",
  });
  const result = await processNativeNotificationBatch(gone, { onlyUserId: owner.id });
  assert.equal(result.expired, 1);
  const device = db.prepare(`SELECT revoked_at FROM native_push_devices WHERE id = ?`).get(registered.device.id) as { revoked_at: number | null };
  assert.ok(device.revoked_at);
  assert.equal(deliveryRows(created.id)[0].status, "expired");
});

test("native APNs delivery isolates users, supports multiple devices, and stays separate from Web Push", async () => {
  const owner = user("multi-owner");
  const other = user("multi-other");
  register(owner.id, "multi-1");
  register(owner.id, "multi-2");
  register(other.id, "multi-other");
  assert.throws(
    () => registerNativePushDevice(other.id, { platform: "ios", deviceId: `${run}-conflict-device`, token: token("multi-1") }),
    /belongs to another signed-in user/,
  );
  const created = event(owner.id, "multi");
  const calledUsers = new Set<string>();
  const sender: NativeApnsSender = async (request) => {
    assert.notEqual(request.deviceToken, token("multi-other"));
    calledUsers.add(request.deviceToken);
    return ok(request.apnsId);
  };
  const result = await processNativeNotificationBatch(sender, { onlyUserId: owner.id });
  assert.equal(result.delivered, 2);
  assert.equal(calledUsers.size, 2);
  const nativeCount = (db.prepare(`SELECT COUNT(*) AS count FROM native_push_deliveries WHERE event_id = ?`).get(created.id) as { count: number }).count;
  const webCount = (db.prepare(`SELECT COUNT(*) AS count FROM notification_deliveries WHERE event_id = ?`).get(created.id) as { count: number }).count;
  assert.equal(nativeCount, 2);
  assert.equal(webCount, 0);
});

test("logout and account disablement prevent native APNs sends", async () => {
  const logoutUser = user("logout");
  register(logoutUser.id, "logout");
  const logoutEvent = event(logoutUser.id, "logout");
  revokeNativePushDevicesForUser(logoutUser.id, `${run}-device-logout`);
  let called = false;
  const sender: NativeApnsSender = async () => {
    called = true;
    return ok();
  };
  const logoutResult = await processNativeNotificationBatch(sender, { onlyUserId: logoutUser.id });
  assert.equal(logoutResult.suppressed, 1);
  assert.equal(called, false);
  assert.equal(deliveryRows(logoutEvent.id)[0].status, "suppressed");

  const disabled = user("disabled");
  register(disabled.id, "disabled");
  const disabledEvent = event(disabled.id, "disabled");
  setDisabled(disabled.id, true);
  const disabledResult = await processNativeNotificationBatch(sender, { onlyUserId: disabled.id });
  assert.equal(disabledResult.suppressed, 1);
  assert.equal(deliveryRows(disabledEvent.id)[0].status, "suppressed");
});

test("badge counts, read receipts, and notification collapse behavior stay server-derived", async () => {
  const owner = user("badge");
  register(owner.id, "badge");
  const first = event(owner.id, "badge-1", { tag: "call:same-call" });
  const second = event(owner.id, "badge-2", { kind: "missed_call", deepLink: "/v2/?page=dialer&call=same-call", tag: "call:same-call" });
  markNotificationReceipt(first.id, owner.id, "read_at");
  const captured: ApnsDeliveryRequest[] = [];
  const sender: NativeApnsSender = async (request) => {
    captured.push(request);
    return ok(request.apnsId);
  };
  await processNativeNotificationBatch(sender, { onlyUserId: owner.id, limit: 1 });
  assert.equal(captured.length, 1);
  assert.equal((captured[0].payload as { aps: { badge: number } }).aps.badge, 1);
  assert.equal(captured[0].collapseId, "call:same-call");

  const duplicate = createNotificationEvent({
    kind: "missed_call",
    provider: run,
    providerEventId: `${run}:provider:badge-2`,
    sourceType: "native-apns-test",
    sourceRecordId: `${run}:source:badge-2-duplicate`,
    deepLink: "/v2/?page=dialer&call=same-call",
    notificationTag: "call:same-call",
    explicitUserId: owner.id,
  });
  assert.equal(duplicate?.duplicate, true);
  assert.equal(deliveryRows(second.id).length, 1);
});

test("native APNs log and provider error surfaces redact tokens, payloads, contact data, and bodies", () => {
  const lines: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join(" "));
  };
  try {
    log.warn("native APNs delivery failed for +15551234567 and borrower@example.com", {
      deviceToken: "raw-apns-token-secret",
      authorization: "Bearer raw-provider-token",
      payload: { aps: { alert: { body: "private borrower body" } } },
      providerError: "BadDeviceToken private detail",
      responseBody: "provider response body",
      phone: "+15551234567",
      email: "borrower@example.com",
    });
  } finally {
    console.warn = originalWarn;
  }
  const output = lines.join("\n");
  assert.doesNotMatch(output, /raw-apns-token-secret|raw-provider-token|private borrower body|borrower@example\.com|\+15551234567|provider response body/);
});

test("concurrent native APNs workers cannot claim the same delivery twice", async () => {
  const owner = user("concurrent");
  register(owner.id, "concurrent");
  const created = event(owner.id, "concurrent");
  let calls = 0;
  const sender: NativeApnsSender = async (request) => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return ok(request.apnsId);
  };
  const [first, second] = await Promise.all([
    processNativeNotificationBatch(sender, { onlyUserId: owner.id }),
    processNativeNotificationBatch(sender, { onlyUserId: owner.id }),
  ]);
  assert.equal(first.claimed + second.claimed, 1);
  assert.equal(first.delivered + second.delivered, 1);
  assert.equal(calls, 1);
  assert.equal(deliveryRows(created.id)[0].status, "delivered");
});

test("native APNs payload builder never includes enhanced previews or private source data", () => {
  const owner = user("payload-builder");
  updateNotificationPreferences(owner.id, { previewLevel: "enhanced" });
  const created = event(owner.id, "payload-builder", {
    kind: "incoming_message",
    deepLink: "/v2/?page=conversations&lead=lead_private&event=event_1",
    firstName: "Charlie",
  });
  const payload = buildNativeApnsPayload(created, owner.id);
  const serialized = JSON.stringify(payload);
  assert.equal(payload.deepLink, "/v2/?page=messages&lead=lead_private&event=event_1");
  assert.match(serialized, /New text message in SmartR8/);
  assert.doesNotMatch(serialized, /Charlie|phone|email|fax|filename|loan|credential|token/i);
});
