import { createHash, randomUUID } from "crypto";
import { db } from "../store/db";

export interface NativePushDevice {
  id: string;
  user_id: string;
  platform: "ios";
  device_id: string;
  token_sha256: string;
  environment: "development" | "production";
  app_version: string | null;
  build_number: string | null;
  device_label: string | null;
  created_at: number;
  updated_at: number;
  last_seen_at: number;
  disabled_at: number | null;
  revoked_at: number | null;
}

export interface NativePushRegistrationInput {
  platform?: unknown;
  deviceId?: unknown;
  token?: unknown;
  environment?: unknown;
  appVersion?: unknown;
  buildNumber?: unknown;
  deviceLabel?: unknown;
}

export class NativePushInputError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

const FALLBACK_NATIVE_LINK = "/v2/?page=notifications";
const APPROVED_NATIVE_PAGES = new Set(["notifications", "messages", "conversations", "dialer"]);

function cleanString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function safeIdentifier(value: string | null | undefined, max = 160): string {
  return String(value || "").trim().replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, max);
}

function normalizePlatform(value: unknown): "ios" {
  if (value !== "ios") throw new NativePushInputError("only ios native push devices are supported in this phase");
  return "ios";
}

function normalizeEnvironment(value: unknown): "development" | "production" {
  if (value === "development") return "development";
  if (value === "production" || value === undefined || value === null || value === "") return "production";
  throw new NativePushInputError("invalid APNs environment");
}

function normalizeDeviceId(value: unknown): string {
  const deviceId = cleanString(value, 128);
  if (!deviceId || !/^[A-Za-z0-9_.:-]{8,128}$/.test(deviceId)) throw new NativePushInputError("invalid native device id");
  return deviceId;
}

function normalizeToken(value: unknown): string {
  const token = cleanString(value, 4096);
  if (!token || !/^[A-Za-z0-9:_=./+-]{16,4096}$/.test(token)) throw new NativePushInputError("invalid APNs device token");
  return token;
}

export function nativeTokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function nativeTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function safeNativeDeepLink(value: string | null | undefined): { ok: boolean; path: string; reason?: string } {
  try {
    const parsed = new URL(String(value || FALLBACK_NATIVE_LINK), "https://crm.smartr8.com");
    if (parsed.origin !== "https://crm.smartr8.com") {
      return { ok: false, path: FALLBACK_NATIVE_LINK, reason: "external origin" };
    }
    if (parsed.pathname !== "/v2" && parsed.pathname !== "/v2/") {
      return { ok: false, path: FALLBACK_NATIVE_LINK, reason: "unapproved path" };
    }
    if (parsed.hash) {
      return { ok: false, path: FALLBACK_NATIVE_LINK, reason: "fragments are not allowed" };
    }

    const rawPage = safeIdentifier(parsed.searchParams.get("page"), 40) || "notifications";
    const page = rawPage === "conversations" ? "messages" : rawPage;
    if (!APPROVED_NATIVE_PAGES.has(rawPage) || !["notifications", "messages", "dialer"].includes(page)) {
      return { ok: false, path: FALLBACK_NATIVE_LINK, reason: "unapproved page" };
    }

    const allowedParams = new Set(page === "dialer" ? ["page", "call", "lead"] : page === "messages" ? ["page", "lead", "event"] : ["page", "event"]);
    for (const key of parsed.searchParams.keys()) {
      if (!allowedParams.has(key)) return { ok: false, path: FALLBACK_NATIVE_LINK, reason: "unapproved parameter" };
    }

    const output = new URL("https://crm.smartr8.com/v2/");
    output.searchParams.set("page", page);
    for (const key of allowedParams) {
      if (key === "page") continue;
      if (!parsed.searchParams.has(key)) continue;
      const item = safeIdentifier(parsed.searchParams.get(key), 128);
      if (!item) return { ok: false, path: FALLBACK_NATIVE_LINK, reason: "invalid parameter value" };
      output.searchParams.set(key, item);
    }
    return { ok: true, path: `${output.pathname}${output.search}` };
  } catch {
    return { ok: false, path: FALLBACK_NATIVE_LINK, reason: "invalid url" };
  }
}

export function registerNativePushDevice(userId: string, input: NativePushRegistrationInput): { device: NativePushDevice; created: boolean; tokenFingerprint: string } {
  const platform = normalizePlatform(input.platform);
  const deviceId = normalizeDeviceId(input.deviceId);
  const token = normalizeToken(input.token);
  const tokenHash = nativeTokenHash(token);
  const tokenFingerprint = nativeTokenFingerprint(token);
  const environment = normalizeEnvironment(input.environment);
  const appVersion = cleanString(input.appVersion, 64);
  const buildNumber = cleanString(input.buildNumber, 64);
  const deviceLabel = cleanString(input.deviceLabel, 120);
  const conflicting = db.prepare(
    `SELECT id, user_id FROM native_push_devices
      WHERE token_sha256 = ? AND user_id <> ? AND revoked_at IS NULL`,
  ).get(tokenHash, userId) as { id: string; user_id: string } | undefined;
  if (conflicting) {
    throw new NativePushInputError("this native push token belongs to another signed-in user; sign out there before registering it here", 409);
  }

  const now = Date.now();
  const existing = db.prepare(
    `SELECT id FROM native_push_devices WHERE user_id = ? AND device_id = ?`,
  ).get(userId, deviceId) as { id: string } | undefined;
  const id = existing?.id || randomUUID();
  if (existing) {
    db.prepare(
      `UPDATE native_push_devices
          SET token = ?, token_sha256 = ?, environment = ?, app_version = ?, build_number = ?,
              device_label = ?, updated_at = ?, last_seen_at = ?, disabled_at = NULL, revoked_at = NULL
        WHERE id = ? AND user_id = ?`,
    ).run(token, tokenHash, environment, appVersion, buildNumber, deviceLabel, now, now, id, userId);
  } else {
    db.prepare(
      `INSERT INTO native_push_devices
        (id, user_id, platform, device_id, token, token_sha256, environment,
         app_version, build_number, device_label, created_at, updated_at, last_seen_at,
         disabled_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(id, userId, platform, deviceId, token, tokenHash, environment, appVersion, buildNumber, deviceLabel, now, now, now);
  }
  return {
    device: db.prepare(`SELECT id, user_id, platform, device_id, token_sha256, environment, app_version, build_number, device_label, created_at, updated_at, last_seen_at, disabled_at, revoked_at FROM native_push_devices WHERE id = ?`).get(id) as NativePushDevice,
    created: !existing,
    tokenFingerprint,
  };
}

export function disableNativePushDevice(userId: string, input: { deviceId?: unknown; token?: unknown }): { changed: number; tokenFingerprint?: string } {
  const deviceId = input.deviceId === undefined ? null : normalizeDeviceId(input.deviceId);
  const token = input.token === undefined ? null : normalizeToken(input.token);
  if (!deviceId && !token) throw new NativePushInputError("native device id or token is required");
  const now = Date.now();
  const tokenHash = token ? nativeTokenHash(token) : null;
  const result = db.prepare(
    `UPDATE native_push_devices
        SET disabled_at = COALESCE(disabled_at, @now), updated_at = @now
      WHERE user_id = @userId
        AND revoked_at IS NULL
        AND (@deviceId IS NULL OR device_id = @deviceId)
        AND (@tokenHash IS NULL OR token_sha256 = @tokenHash)`,
  ).run({ now, userId, deviceId, tokenHash });
  return { changed: result.changes, tokenFingerprint: token ? nativeTokenFingerprint(token) : undefined };
}

export function revokeNativePushDevicesForUser(userId: string, deviceId?: string | null): number {
  const now = Date.now();
  const normalizedDeviceId = deviceId ? normalizeDeviceId(deviceId) : null;
  const result = db.prepare(
    `UPDATE native_push_devices
        SET revoked_at = COALESCE(revoked_at, @now), updated_at = @now
      WHERE user_id = @userId
        AND revoked_at IS NULL
        AND (@deviceId IS NULL OR device_id = @deviceId)`,
  ).run({ now, userId, deviceId: normalizedDeviceId });
  return result.changes;
}

export function nativePushStatus(userId: string): {
  configured: boolean;
  deliveryConfigured: boolean;
  activeDeviceCount: number;
  disabledDeviceCount: number;
  lastRegisteredAt: number | null;
  lastSeenAt: number | null;
  devices: Array<{ id: string; platform: string; deviceId: string; environment: string; appVersion: string | null; buildNumber: string | null; deviceLabel: string | null; lastSeenAt: number; disabled: boolean }>;
} {
  const rows = db.prepare(
    `SELECT id, platform, device_id, environment, app_version, build_number, device_label, created_at, last_seen_at, disabled_at
       FROM native_push_devices
      WHERE user_id = ? AND revoked_at IS NULL
      ORDER BY updated_at DESC`,
  ).all(userId) as Array<{
    id: string;
    platform: string;
    device_id: string;
    environment: string;
    app_version: string | null;
    build_number: string | null;
    device_label: string | null;
    created_at: number;
    last_seen_at: number;
    disabled_at: number | null;
  }>;
  const active = rows.filter((row) => !row.disabled_at);
  return {
    configured: true,
    deliveryConfigured: false,
    activeDeviceCount: active.length,
    disabledDeviceCount: rows.length - active.length,
    lastRegisteredAt: rows.reduce<number | null>((max, row) => max === null || row.created_at > max ? row.created_at : max, null),
    lastSeenAt: rows.reduce<number | null>((max, row) => max === null || row.last_seen_at > max ? row.last_seen_at : max, null),
    devices: rows.map((row) => ({
      id: row.id,
      platform: row.platform,
      deviceId: row.device_id,
      environment: row.environment,
      appVersion: row.app_version,
      buildNumber: row.build_number,
      deviceLabel: row.device_label,
      lastSeenAt: row.last_seen_at,
      disabled: Boolean(row.disabled_at),
    })),
  };
}

export function nativeBadgeState(userId: string): { badgeEnabled: boolean; unreadCount: number; badgeCount: number } {
  const pref = db.prepare(`SELECT app_badges FROM notification_preferences WHERE user_id = ?`).get(userId) as { app_badges: number } | undefined;
  const unread = db.prepare(
    `SELECT COUNT(*) AS count FROM notification_receipts WHERE user_id = ? AND dismissed_at IS NULL AND read_at IS NULL`,
  ).get(userId) as { count: number };
  const badgeEnabled = pref ? Boolean(pref.app_badges) : true;
  return { badgeEnabled, unreadCount: unread.count, badgeCount: badgeEnabled ? unread.count : 0 };
}

export function enqueueNativePushDeliveries(input: { eventId: string; userId: string; nextAttemptAt: number; now: number }): number {
  const devices = db.prepare(
    `SELECT id FROM native_push_devices
      WHERE user_id = ? AND revoked_at IS NULL AND disabled_at IS NULL
      ORDER BY updated_at DESC`,
  ).all(input.userId) as Array<{ id: string }>;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO native_push_deliveries
      (id, event_id, user_id, native_device_id, status, attempt_count, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
  );
  let changed = 0;
  for (const device of devices) {
    const result = insert.run(randomUUID(), input.eventId, input.userId, device.id, input.nextAttemptAt, input.now, input.now);
    changed += result.changes;
  }
  return changed;
}
