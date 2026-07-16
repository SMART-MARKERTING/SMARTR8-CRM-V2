import { randomUUID } from "crypto";
import { Router, type Request } from "express";
import { config } from "../config";
import { db } from "../store/db";
import { requirePass } from "../util/auth";
import { rateLimit } from "../util/rateLimit";
import { recordAudit } from "../services/audit";
import { processNotificationBatch } from "../services/notificationWorker";
import {
  createNotificationEvent,
  getEventForUser,
  getNotificationPreferences,
  listUserNotifications,
  markAllNotifications,
  markNotificationReceipt,
  updateNotificationPreferences,
} from "../services/notifications";
import { endpointFingerprint, pushConfigured } from "../services/push";

export const pushRouter = Router();

const pushReadLimit = rateLimit({ name: "push-read", max: 180, windowMs: 60_000 });
const pushWriteLimit = rateLimit({ name: "push-write", max: 30, windowMs: 60_000 });
const pushTestLimit = rateLimit({ name: "push-test", max: 5, windowMs: 10 * 60_000 });

function userId(req: Request): string {
  if (!req.authUser) throw new Error("authenticated user missing");
  return req.authUser.id;
}

function bodySize(req: Request): number {
  try { return Buffer.byteLength(JSON.stringify(req.body ?? {}), "utf8"); } catch { return Number.MAX_SAFE_INTEGER; }
}

function subscriptionInput(body: unknown): { endpoint: string; p256dh: string; auth: string; platform: string | null; appVersion: string | null } | null {
  if (!body || typeof body !== "object") return null;
  const row = body as Record<string, unknown>;
  const subscription = row.subscription && typeof row.subscription === "object" ? row.subscription as Record<string, unknown> : row;
  const keys = subscription.keys && typeof subscription.keys === "object" ? subscription.keys as Record<string, unknown> : {};
  const endpoint = typeof subscription.endpoint === "string" ? subscription.endpoint.trim() : "";
  const p256dh = typeof keys.p256dh === "string" ? keys.p256dh.trim() : "";
  const auth = typeof keys.auth === "string" ? keys.auth.trim() : "";
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || endpoint.length > 2_048) return null;
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,100}$/.test(auth)) return null;
  return {
    endpoint,
    p256dh,
    auth,
    platform: typeof row.platform === "string" ? row.platform.trim().slice(0, 80) || null : null,
    appVersion: typeof row.appVersion === "string" ? row.appVersion.trim().slice(0, 64) || null : null,
  };
}

pushRouter.get("/api/push/public-key", requirePass, pushReadLimit, (_req, res) => {
  res.set("Cache-Control", "private, no-store");
  if (!pushConfigured()) {
    res.status(503).json({ error: "Web Push is not configured on the server" });
    return;
  }
  res.json({ publicKey: config.push.vapidPublicKey });
});

pushRouter.get("/api/push/status", requirePass, pushReadLimit, (req, res) => {
  const row = db.prepare(
    `SELECT COUNT(*) AS count, MAX(created_at) AS last_subscribed_at, MAX(last_seen_at) AS last_seen_at
       FROM push_subscriptions WHERE user_id = ? AND revoked_at IS NULL`,
  ).get(userId(req)) as { count: number; last_subscribed_at: number | null; last_seen_at: number | null };
  res.set("Cache-Control", "private, no-store");
  res.json({
    configured: pushConfigured(),
    subscribed: row.count > 0,
    subscriptionCount: row.count,
    lastSuccessfulSubscriptionTime: row.last_subscribed_at,
    lastSeenAt: row.last_seen_at,
  });
});

pushRouter.post("/api/push/subscribe", requirePass, pushWriteLimit, (req, res) => {
  if (bodySize(req) > 4_096) {
    res.status(413).json({ error: "push subscription payload is too large" });
    return;
  }
  if (!pushConfigured()) {
    res.status(503).json({ error: "Web Push is not configured on the server" });
    return;
  }
  const input = subscriptionInput(req.body);
  if (!input) {
    res.status(400).json({ error: "invalid Web Push subscription" });
    return;
  }
  const existing = db.prepare(`SELECT id, user_id FROM push_subscriptions WHERE endpoint = ?`).get(input.endpoint) as { id: string; user_id: string } | undefined;
  if (existing && existing.user_id !== userId(req)) {
    res.status(409).json({ error: "this device subscription belongs to another signed-in user; disable notifications from that account first" });
    return;
  }
  const now = Date.now();
  const id = existing?.id || randomUUID();
  if (existing) {
    db.prepare(
      `UPDATE push_subscriptions
          SET p256dh_key = ?, auth_key = ?, user_agent = ?, platform = ?, app_version = ?,
              updated_at = ?, last_seen_at = ?, revoked_at = NULL
        WHERE id = ? AND user_id = ?`,
    ).run(input.p256dh, input.auth, req.get("user-agent")?.slice(0, 500) || null, input.platform, input.appVersion || config.push.appVersion, now, now, id, userId(req));
  } else {
    db.prepare(
      `INSERT INTO push_subscriptions
        (id, user_id, endpoint, p256dh_key, auth_key, user_agent, platform, app_version,
         created_at, updated_at, last_seen_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(id, userId(req), input.endpoint, input.p256dh, input.auth, req.get("user-agent")?.slice(0, 500) || null, input.platform, input.appVersion || config.push.appVersion, now, now, now);
  }
  recordAudit({ req, action: "push.subscribe", statusCode: 200, detail: "Web Push device registered", meta: { subscription: endpointFingerprint(input.endpoint) } });
  res.json({ ok: true, subscriptionId: id, subscribedAt: now });
});

pushRouter.delete("/api/push/subscribe", requirePass, pushWriteLimit, (req, res) => {
  const endpoint = typeof req.body?.endpoint === "string"
    ? req.body.endpoint.trim()
    : typeof req.body?.subscription?.endpoint === "string" ? req.body.subscription.endpoint.trim() : "";
  if (!endpoint || endpoint.length > 2_048) {
    res.status(400).json({ error: "subscription endpoint is required" });
    return;
  }
  const now = Date.now();
  const result = db.prepare(
    `UPDATE push_subscriptions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
      WHERE endpoint = ? AND user_id = ?`,
  ).run(now, now, endpoint, userId(req));
  if (!result.changes) {
    res.status(404).json({ error: "subscription not found for this user" });
    return;
  }
  recordAudit({ req, action: "push.unsubscribe", statusCode: 200, detail: "Web Push device removed", meta: { subscription: endpointFingerprint(endpoint) } });
  res.json({ ok: true });
});

pushRouter.post("/api/push/test", requirePass, pushTestLimit, async (req, res) => {
  if (!pushConfigured()) {
    res.status(503).json({ error: "Web Push is not configured on the server" });
    return;
  }
  const active = db.prepare(`SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ? AND revoked_at IS NULL`).get(userId(req)) as { count: number };
  if (!active.count) {
    res.status(409).json({ error: "this user has no active device subscription" });
    return;
  }
  const sourceId = randomUUID();
  const created = createNotificationEvent({
    kind: "test",
    provider: "smartr8",
    providerEventId: `test:${sourceId}`,
    sourceType: "test",
    sourceRecordId: sourceId,
    deepLink: "/v2?page=settings",
    explicitUserId: userId(req),
  });
  if (!created) {
    res.status(409).json({ error: "test notification was suppressed by user settings" });
    return;
  }
  const delivery = await processNotificationBatch(undefined, { onlyUserId: userId(req), limit: 10 });
  recordAudit({ req, action: "push.test", statusCode: 200, detail: "Test Web Push requested", meta: { eventId: created.event.id, delivery } });
  res.json({ ok: true, eventId: created.event.id, delivery });
});

pushRouter.get("/api/notification-preferences", requirePass, pushReadLimit, (req, res) => {
  res.set("Cache-Control", "private, no-store");
  res.json({ preferences: getNotificationPreferences(userId(req)) });
});

pushRouter.patch("/api/notification-preferences", requirePass, pushWriteLimit, (req, res) => {
  if (bodySize(req) > 4_096 || !req.body || typeof req.body !== "object") {
    res.status(400).json({ error: "invalid notification preferences" });
    return;
  }
  const preferences = updateNotificationPreferences(userId(req), req.body as Record<string, unknown>);
  recordAudit({ req, action: "notification.preferences", statusCode: 200, detail: "Notification preferences updated" });
  res.json({ ok: true, preferences });
});

pushRouter.get("/api/notifications", requirePass, pushReadLimit, (req, res) => {
  const parsed = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 75;
  res.set("Cache-Control", "private, no-store");
  res.json(listUserNotifications(userId(req), Number.isFinite(parsed) ? parsed : 75));
});

pushRouter.post("/api/notifications/read-all", requirePass, pushWriteLimit, (req, res) => {
  res.json({ ok: true, changed: markAllNotifications(userId(req), "read_at") });
});

pushRouter.post("/api/notifications/clear", requirePass, pushWriteLimit, (req, res) => {
  res.json({ ok: true, changed: markAllNotifications(userId(req), "dismissed_at"), clearedAt: Date.now() });
});

for (const [path, field] of [
  ["read", "read_at"],
  ["opened", "opened_at"],
  ["dismiss", "dismissed_at"],
] as const) {
  pushRouter.post(`/api/notifications/:id/${path}`, requirePass, pushWriteLimit, (req, res) => {
    const ok = markNotificationReceipt(req.params.id, userId(req), field);
    if (!ok) res.status(404).json({ error: "notification not found" });
    else res.json({ ok: true });
  });
}

// Backward-compatible V2 action used by the existing Notification Center button.
pushRouter.post("/api/notifications/:id/clear", requirePass, pushWriteLimit, (req, res) => {
  const ok = markNotificationReceipt(req.params.id, userId(req), "dismissed_at");
  if (!ok) res.status(404).json({ error: "notification not found" });
  else res.json({ ok: true, id: req.params.id, sourceDeleted: false });
});

function mayAccessLead(req: Request, leadId: string | null): boolean {
  if (!leadId || req.authUser?.role === "admin") return Boolean(req.authUser);
  const row = db.prepare(`SELECT owner_user_id FROM leads WHERE id = ? AND deleted_at IS NULL`).get(leadId) as { owner_user_id: string | null } | undefined;
  return Boolean(row && row.owner_user_id === userId(req));
}

pushRouter.delete("/api/notifications/:id", requirePass, pushWriteLimit, (req, res) => {
  const event = getEventForUser(req.params.id, userId(req));
  if (!event || !mayAccessLead(req, event.lead_id)) {
    res.status(404).json({ error: "notification not found" });
    return;
  }
  const now = Date.now();
  if (event.source_type === "activity") {
    db.prepare(`UPDATE activities SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ? AND lead_id = ?`).run(now, event.source_record_id, event.lead_id);
  } else if (event.source_type === "fax") {
    db.prepare(`UPDATE fax_records SET deleted_at = COALESCE(deleted_at, ?), updated_at = ? WHERE id = ?`).run(now, now, event.source_record_id);
  } else if (event.source_type === "call") {
    db.prepare(`UPDATE call_log SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ?`).run(now, event.source_record_id);
  }
  markNotificationReceipt(event.id, userId(req), "dismissed_at");
  recordAudit({ req, action: "notification.delete_source", statusCode: 200, detail: "Notification source moved to Trash", meta: { eventId: event.id, sourceType: event.source_type } });
  res.json({ ok: true, id: event.id, sourceDeleted: true, sourceKind: event.source_type });
});
