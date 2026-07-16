import assert from "node:assert/strict";
import { after, test } from "node:test";
import express from "express";
import { config } from "../config";
import { pushRouter } from "../routes/push";
import { webhooksRouter } from "../routes/webhooks";
import { db } from "../store/db";
import { createSession, createUser, setDisabled } from "./auth";
import { createLead, updateLead } from "./leads";
import { processNotificationBatch, type PushSender } from "./notificationWorker";
import {
  buildPushPayload,
  createNotificationEvent,
  getNotificationPreferences,
  listUserNotifications,
  markAllNotifications,
  markNotificationReceipt,
  quietHoursUntil,
  resolveNotificationRecipients,
  safeDeepLink,
  updateNotificationPreferences,
  type NotificationPreferences,
} from "./notifications";

const run = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const users: string[] = [];
const leads: string[] = [];
const previousDefaultUser = config.push.defaultNotificationUserId;
const previousTelnyxPublicKey = config.telnyx.publicKey;
const previousBlueBubblesSecret = config.bluebubbles.webhookSecret;

function user(name: string, role: "admin" | "user" = "user", permissions: string[] = ["dashboard", "messages", "email", "fax", "dialer", "settings"]) {
  const created = createUser({ username: `${run}-${name}`, password: "notification-test-password", name, role, permissions });
  users.push(created.id);
  return created;
}

function lead(name: string, ownerUserId?: string) {
  const created = createLead({ name, phone: `+1${String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000)}`, source: run });
  leads.push(created.id);
  if (ownerUserId) return updateLead(created.id, { owner_user_id: ownerUserId })!;
  return created;
}

function addSubscription(userId: string, suffix: string): string {
  const id = `${run}-sub-${suffix}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO push_subscriptions
      (id, user_id, endpoint, p256dh_key, auth_key, created_at, updated_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, `https://push.example.test/${run}/${suffix}`, "p".repeat(87), "a".repeat(22), now, now, now);
  return id;
}

function eventFor(userId: string, suffix: string, kind: "test" | "incoming_email" = "test") {
  return createNotificationEvent({
    kind,
    provider: run,
    providerEventId: `${run}:provider:${suffix}`,
    sourceType: "test",
    sourceRecordId: `${run}:${suffix}`,
    deepLink: kind === "incoming_email" ? `/v2?page=email&event=${suffix}` : "/v2?page=settings",
    explicitUserId: userId,
    contactFirstName: "Alice",
  });
}

after(() => {
  config.push.defaultNotificationUserId = previousDefaultUser;
  config.telnyx.publicKey = previousTelnyxPublicKey;
  config.bluebubbles.webhookSecret = previousBlueBubblesSecret;
  const placeholders = users.map(() => "?").join(",");
  db.prepare(`DELETE FROM notification_events WHERE provider = ?`).run(run);
  if (users.length) {
    db.prepare(`DELETE FROM push_subscriptions WHERE user_id IN (${placeholders})`).run(...users);
    db.prepare(`DELETE FROM sessions WHERE user_id IN (${placeholders})`).run(...users);
    db.prepare(`DELETE FROM notification_preferences WHERE user_id IN (${placeholders})`).run(...users);
  }
  for (const id of leads) db.prepare(`DELETE FROM leads WHERE id = ?`).run(id);
  if (users.length) db.prepare(`DELETE FROM users WHERE id IN (${placeholders})`).run(...users);
});

test("Phase 1 notification subsystem", async (t) => {
  const admin = user("Admin", "admin");
  const owner = user("Owner");
  const other = user("Other");

  await t.test("database migration creates all durable notification tables", () => {
    const names = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((row) => row.name));
    for (const name of ["push_subscriptions", "notification_events", "notification_deliveries", "notification_receipts", "notification_preferences"]) {
      assert.equal(names.has(name), true, `${name} should exist`);
    }
  });

  await t.test("assigned lead owner is selected and feature permissions are enforced", () => {
    const assigned = lead("Assigned", owner.id);
    const recipients = resolveNotificationRecipients({ kind: "incoming_message", leadId: assigned.id });
    assert.deepEqual(recipients.map((row) => row.user.id), [owner.id]);

    const restricted = user("Restricted", "user", ["leads"]);
    const restrictedLead = lead("Restricted lead", restricted.id);
    const filtered = resolveNotificationRecipients({ kind: "incoming_fax", leadId: restrictedLead.id });
    assert.equal(filtered.some((row) => row.user.id === restricted.id), false);
  });

  await t.test("unassigned records route to and become accessible to the configured fallback", () => {
    const fallback = user("Inbox", "user", ["messages"]);
    config.push.defaultNotificationUserId = fallback.id;
    const unassigned = lead("Unassigned");
    const recipients = resolveNotificationRecipients({ kind: "incoming_message", leadId: unassigned.id });
    assert.deepEqual(recipients.map((row) => row.user.id), [fallback.id]);
    const stored = db.prepare(`SELECT owner_user_id FROM leads WHERE id = ?`).get(unassigned.id) as { owner_user_id: string | null };
    assert.equal(stored.owner_user_id, fallback.id);
    config.push.defaultNotificationUserId = previousDefaultUser;
  });

  await t.test("disabled users and disabled channel preferences are suppressed", () => {
    const disabled = user("Disabled");
    const assigned = lead("Disabled owner", disabled.id);
    setDisabled(disabled.id, true);
    const recipients = resolveNotificationRecipients({ kind: "incoming_email", leadId: assigned.id });
    assert.equal(recipients.some((row) => row.user.id === disabled.id), false);

    updateNotificationPreferences(owner.id, { incomingMessages: false });
    const optedOutLead = lead("Opted out owner", owner.id);
    assert.equal(resolveNotificationRecipients({ kind: "incoming_message", leadId: optedOutLead.id }).length, 0);
    updateNotificationPreferences(owner.id, { incomingMessages: true });
  });

  await t.test("provider events deduplicate and payloads redact private content", () => {
    const first = eventFor(owner.id, "dedupe", "incoming_email");
    assert.ok(first && !first.duplicate);
    const second = createNotificationEvent({
      kind: "incoming_email",
      provider: run,
      providerEventId: `${run}:provider:dedupe`,
      sourceType: "activity",
      sourceRecordId: `${run}:different-source`,
      deepLink: "/v2?page=email&token=secret&lead=lead_1",
      explicitUserId: owner.id,
      contactFirstName: "Alice SSN 123-45-6789",
    });
    assert.ok(second?.duplicate);
    const payload = buildPushPayload(first.event, owner.id);
    assert.match(payload, /New borrower email/);
    assert.doesNotMatch(payload, /SSN|123-45-6789|loan amount|income|token/i);
    assert.equal(safeDeepLink("/v2?page=email&lead=abc&token=secret"), "/v2/?page=email&lead=abc");
    assert.equal(safeDeepLink("/v2/?page=email&lead=abc"), "/v2/?page=email&lead=abc");
    assert.equal(safeDeepLink("https://evil.example/v2?page=email"), "/v2/?page=notifications");
  });

  await t.test("invalid webhook authentication cannot create notification events", async () => {
    config.telnyx.publicKey = "not-a-valid-ed25519-public-key";
    config.bluebubbles.webhookSecret = `${run}-bluebubbles-secret`;
    const app = express();
    app.use(express.json({
      verify: (req, _res, buffer) => { (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer); },
    }));
    app.use("/webhooks", webhooksRouter);
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind");
      const before = (db.prepare(`SELECT COUNT(*) AS count FROM notification_events WHERE provider = ?`).get(run) as { count: number }).count;
      const telnyx = await fetch(`http://127.0.0.1:${address.port}/webhooks/telnyx`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "telnyx-timestamp": String(Math.floor(Date.now() / 1000)),
          "telnyx-signature-ed25519": Buffer.from("invalid").toString("base64"),
        },
        body: JSON.stringify({ data: { id: `${run}-invalid-telnyx`, event_type: "message.received", payload: { from: { phone_number: "+15550000000" }, text: "private text" } } }),
      });
      assert.equal(telnyx.status, 401);
      const blueBubbles = await fetch(`http://127.0.0.1:${address.port}/webhooks/bluebubbles`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bluebubbles-secret": "wrong-secret" },
        body: JSON.stringify({ type: "new-message", data: { guid: `${run}-invalid-bb`, handle: { address: "+15550000001" }, text: "private text" } }),
      });
      assert.equal(blueBubbles.status, 401);
      const afterCount = (db.prepare(`SELECT COUNT(*) AS count FROM notification_events WHERE provider = ?`).get(run) as { count: number }).count;
      assert.equal(afterCount, before);
    } finally {
      config.telnyx.publicKey = previousTelnyxPublicKey;
      config.bluebubbles.webhookSecret = previousBlueBubblesSecret;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  await t.test("notification receipts and read-all are isolated per user", () => {
    const created = eventFor(owner.id, "isolation");
    assert.ok(created);
    assert.equal(markNotificationReceipt(created.event.id, other.id, "dismissed_at"), false);
    assert.equal(listUserNotifications(other.id).notifications.some((row) => row.id === created.event.id), false);
    assert.equal(markAllNotifications(owner.id, "read_at") > 0, true);
    assert.equal(listUserNotifications(owner.id).count, 0);
    assert.equal(markNotificationReceipt(created.event.id, owner.id, "dismissed_at"), true);
  });

  await t.test("subscription ownership API never lets another user remove a device", async () => {
    const endpoint = `https://push.example.test/${run}/ownership`;
    const now = Date.now();
    db.prepare(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh_key, auth_key, created_at, updated_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`${run}-ownership`, owner.id, endpoint, "p".repeat(87), "a".repeat(22), now, now, now);
    const ownerToken = createSession(owner.id);
    const otherToken = createSession(other.id);
    const app = express();
    app.use(express.json());
    app.use(pushRouter);
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind");
      const url = `http://127.0.0.1:${address.port}/api/push/subscribe`;
      const denied = await fetch(url, { method: "DELETE", headers: { "content-type": "application/json", "x-session-token": otherToken }, body: JSON.stringify({ endpoint }) });
      assert.equal(denied.status, 404);
      const active = db.prepare(`SELECT revoked_at FROM push_subscriptions WHERE endpoint = ?`).get(endpoint) as { revoked_at: number | null };
      assert.equal(active.revoked_at, null);
      const allowed = await fetch(url, { method: "DELETE", headers: { "content-type": "application/json", "x-session-token": ownerToken }, body: JSON.stringify({ endpoint }) });
      assert.equal(allowed.status, 200);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  await t.test("Web Push success, temporary retry, and expired endpoint handling are durable", async () => {
    addSubscription(owner.id, "success");
    const successEvent = eventFor(owner.id, "success-delivery");
    assert.ok(successEvent);
    let capturedPayload = "";
    const success: PushSender = async (_subscription, payload) => {
      capturedPayload = payload;
      return { ok: true, statusCode: 201, responseBody: "", expired: false, retryable: false };
    };
    const successResult = await processNotificationBatch(success, { onlyUserId: owner.id });
    assert.equal(successResult.delivered >= 1, true);
    assert.doesNotMatch(capturedPayload, /p256dh|auth_key|SSN|date of birth/i);

    addSubscription(other.id, "retry");
    const retryEvent = eventFor(other.id, "temporary-delivery");
    assert.ok(retryEvent);
    const temporary: PushSender = async () => ({ ok: false, statusCode: 503, responseBody: "temporary", expired: false, retryable: true, error: "temporary" });
    const retryResult = await processNotificationBatch(temporary, { onlyUserId: other.id });
    assert.equal(retryResult.retried >= 1, true);
    const retryRow = db.prepare(`SELECT status, attempt_count FROM notification_deliveries WHERE event_id = ?`).get(retryEvent.event.id) as { status: string; attempt_count: number };
    assert.equal(retryRow.status, "retry");
    assert.equal(retryRow.attempt_count, 1);

    const expiredUser = user("Expired endpoint");
    const subscriptionId = addSubscription(expiredUser.id, "expired");
    const expiredEvent = eventFor(expiredUser.id, "expired-delivery");
    assert.ok(expiredEvent);
    const gone: PushSender = async () => ({ ok: false, statusCode: 410, responseBody: "gone", expired: true, retryable: false, error: "gone" });
    const expiredResult = await processNotificationBatch(gone, { onlyUserId: expiredUser.id });
    assert.equal(expiredResult.expired, 1);
    const revoked = db.prepare(`SELECT revoked_at FROM push_subscriptions WHERE id = ?`).get(subscriptionId) as { revoked_at: number | null };
    assert.ok(revoked.revoked_at);

    const notFoundUser = user("Missing endpoint");
    const notFoundSubscriptionId = addSubscription(notFoundUser.id, "not-found");
    const notFoundEvent = eventFor(notFoundUser.id, "not-found-delivery");
    assert.ok(notFoundEvent);
    const notFound: PushSender = async () => ({ ok: false, statusCode: 404, responseBody: "not found", expired: true, retryable: false, error: "not found" });
    const notFoundResult = await processNotificationBatch(notFound, { onlyUserId: notFoundUser.id });
    assert.equal(notFoundResult.expired, 1);
    const notFoundRevoked = db.prepare(`SELECT revoked_at FROM push_subscriptions WHERE id = ?`).get(notFoundSubscriptionId) as { revoked_at: number | null };
    assert.ok(notFoundRevoked.revoked_at);
  });

  await t.test("quiet hours delay delivery and call tags replace incoming with missed", () => {
    const preferences: NotificationPreferences = {
      ...getNotificationPreferences(owner.id),
      quietHoursEnabled: true,
      quietHoursStart: "21:00",
      quietHoursEnd: "07:00",
      quietHoursTz: "UTC",
    };
    const at = Date.parse("2026-07-15T22:00:00Z");
    assert.ok((quietHoursUntil(preferences, at) || 0) > at);

    const incoming = createNotificationEvent({
      kind: "incoming_call", provider: run, providerEventId: `${run}:incoming-call`, sourceType: "call_invitation",
      sourceRecordId: `${run}:call-control`, deepLink: "/v2?page=dialer&call=call-control", notificationTag: "call:call-control", explicitUserId: owner.id,
    });
    const missed = createNotificationEvent({
      kind: "missed_call", provider: run, providerEventId: `${run}:missed-call`, sourceType: "call",
      sourceRecordId: `${run}:call-log`, deepLink: "/v2?page=dialer&call=call-log", notificationTag: "call:call-control", explicitUserId: owner.id,
    });
    assert.equal(incoming?.event.notification_tag, "call:call-control");
    assert.equal(missed?.event.notification_tag, "call:call-control");
  });

  await t.test("disabled user pending deliveries are suppressed by the worker", async () => {
    const disabledDeliveryUser = user("Disabled delivery");
    addSubscription(disabledDeliveryUser.id, "disabled-delivery");
    const created = eventFor(disabledDeliveryUser.id, "disabled-worker");
    assert.ok(created);
    setDisabled(disabledDeliveryUser.id, true);
    let called = false;
    const sender: PushSender = async () => {
      called = true;
      return { ok: true, statusCode: 201, responseBody: "", expired: false, retryable: false };
    };
    const result = await processNotificationBatch(sender, { onlyUserId: disabledDeliveryUser.id });
    assert.equal(result.suppressed, 1);
    assert.equal(called, false);
  });
});
