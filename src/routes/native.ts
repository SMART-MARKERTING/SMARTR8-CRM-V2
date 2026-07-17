import { randomUUID } from "crypto";
import { Router, type Request } from "express";
import { nativeApnsConfigured } from "../services/apns";
import { recordAudit } from "../services/audit";
import { createNotificationEvent } from "../services/notifications";
import {
  disableNativePushDevice,
  nativeBadgeState,
  nativePushStatus,
  NativePushInputError,
  registerNativePushDevice,
  revokeNativePushDevicesForUser,
  safeNativeDeepLink,
} from "../services/nativePush";
import { requirePass, rejectClientSuppliedIdentity } from "../util/auth";
import { rateLimit } from "../util/rateLimit";

export const nativeRouter = Router();

const nativeReadLimit = rateLimit({ name: "native-read", max: 180, windowMs: 60_000 });
const nativeWriteLimit = rateLimit({ name: "native-write", max: 40, windowMs: 60_000 });
const nativeTestLimit = rateLimit({ name: "native-test", max: 5, windowMs: 10 * 60_000 });

function userId(req: Request): string {
  if (!req.authUser) throw new Error("authenticated user missing");
  return req.authUser.id;
}

function bodySize(req: Request): number {
  try {
    return Buffer.byteLength(JSON.stringify(req.body ?? {}), "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function nativeDeviceId(req: Request): string | null {
  const header = req.get("x-smart-r8-native-device-id");
  if (header) return header.trim().slice(0, 128);
  const bodyValue = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  return bodyValue ? bodyValue.slice(0, 128) : null;
}

function handleNativeError(req: Request, res: { status: (code: number) => { json: (body: unknown) => void } }, error: unknown): void {
  if (error instanceof NativePushInputError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  recordAudit({ req, action: "native.error", statusCode: 500, detail: "Native mobile API failed" });
  res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
}

nativeRouter.get("/api/native/push/status", requirePass, nativeReadLimit, (req, res) => {
  res.set("Cache-Control", "private, no-store");
  res.json(nativePushStatus(userId(req)));
});

nativeRouter.post("/api/native/push/register", requirePass, nativeWriteLimit, rejectClientSuppliedIdentity, (req, res) => {
  if (bodySize(req) > 8_192) {
    res.status(413).json({ error: "native push registration payload is too large" });
    return;
  }
  try {
    const registered = registerNativePushDevice(userId(req), req.body ?? {});
    recordAudit({
      req,
      action: "native.push.register",
      statusCode: 200,
      detail: registered.created ? "Native push device registered" : "Native push device refreshed",
      meta: { deviceId: registered.device.device_id, token: registered.tokenFingerprint },
    });
    res.json({
      ok: true,
      deviceId: registered.device.device_id,
      nativeDeviceId: registered.device.id,
      created: registered.created,
      lastSeenAt: registered.device.last_seen_at,
    });
  } catch (error) {
    handleNativeError(req, res, error);
  }
});

nativeRouter.post("/api/native/push/disable", requirePass, nativeWriteLimit, rejectClientSuppliedIdentity, (req, res) => {
  if (bodySize(req) > 4_096) {
    res.status(413).json({ error: "native push disable payload is too large" });
    return;
  }
  try {
    const result = disableNativePushDevice(userId(req), req.body ?? {});
    if (!result.changed) {
      res.status(404).json({ error: "native device not found for this user" });
      return;
    }
    recordAudit({
      req,
      action: "native.push.disable",
      statusCode: 200,
      detail: "Native push device disabled",
      meta: { deviceId: nativeDeviceId(req), token: result.tokenFingerprint },
    });
    res.json({ ok: true, changed: result.changed });
  } catch (error) {
    handleNativeError(req, res, error);
  }
});

nativeRouter.post("/api/native/push/logout", requirePass, nativeWriteLimit, rejectClientSuppliedIdentity, (req, res) => {
  try {
    const changed = revokeNativePushDevicesForUser(userId(req), nativeDeviceId(req));
    recordAudit({
      req,
      action: "native.push.logout",
      statusCode: 200,
      detail: "Native push device revoked for logout",
      meta: { deviceId: nativeDeviceId(req), changed },
    });
    res.json({ ok: true, changed });
  } catch (error) {
    handleNativeError(req, res, error);
  }
});

nativeRouter.post("/api/native/push/test", requirePass, nativeTestLimit, (req, res) => {
  const sourceId = randomUUID();
  const created = createNotificationEvent({
    kind: "test",
    provider: "smartr8-native",
    providerEventId: `native-test:${sourceId}`,
    sourceType: "native-test",
    sourceRecordId: sourceId,
    deepLink: "/v2/?page=notifications",
    explicitUserId: userId(req),
  });
  if (!created) {
    res.status(409).json({ error: "test notification was suppressed by user settings" });
    return;
  }
  recordAudit({ req, action: "native.push.test", statusCode: 200, detail: "Native push test queued", meta: { eventId: created.event.id } });
  res.json({
    ok: true,
    eventId: created.event.id,
    queued: true,
    deliveryConfigured: nativeApnsConfigured(),
    message: nativeApnsConfigured()
      ? "Native APNs delivery was queued."
      : "Native APNs delivery was queued but APNs provider credentials are not configured.",
  });
});

nativeRouter.get("/api/native/badge", requirePass, nativeReadLimit, (req, res) => {
  res.set("Cache-Control", "private, no-store");
  res.json(nativeBadgeState(userId(req)));
});

nativeRouter.post("/api/native/deep-link/resolve", requirePass, nativeReadLimit, (req, res) => {
  if (bodySize(req) > 2_048) {
    res.status(413).json({ error: "deep link payload is too large" });
    return;
  }
  const input = typeof req.body?.url === "string" ? req.body.url : typeof req.body?.path === "string" ? req.body.path : "";
  const resolved = safeNativeDeepLink(input);
  if (!resolved.ok) {
    res.status(400).json({ error: "native deep link is not allowed", reason: resolved.reason, fallback: resolved.path });
    return;
  }
  res.json({ ok: true, path: resolved.path });
});
