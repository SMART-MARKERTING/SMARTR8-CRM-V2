import { randomUUID } from "crypto";
import { config } from "../config";
import { log } from "../logger";
import { db } from "../store/db";
import {
  apnsEnvironmentForDevice,
  nativeApnsConfigured,
  sanitizeApnsCollapseId,
  sendNativeApnsAlert,
  type ApnsDeliveryRequest,
  type ApnsSendResult,
} from "./apns";
import { nativeBadgeState, safeNativeDeepLink } from "./nativePush";
import { getNotificationPreferences, quietHoursUntil, type NotificationEventRow, type NotificationKind } from "./notifications";

interface NativeDeliveryWork {
  delivery_id: string;
  event_id: string;
  user_id: string;
  native_device_id: string;
  attempt_count: number;
  token: string;
  token_sha256: string;
  device_environment: "development" | "production";
  device_disabled_at: number | null;
  device_revoked_at: number | null;
  event_kind: NotificationKind;
  event_provider: string;
  event_provider_event_id: string | null;
  event_source_type: string;
  event_source_record_id: string;
  event_lead_id: string | null;
  event_generic_title: string;
  event_generic_body: string;
  event_enhanced_body: string | null;
  event_deep_link: string;
  event_notification_tag: string;
  event_created_at: number;
  user_disabled: number;
}

export interface NativeApnsPayload {
  aps: {
    alert: { title: string; body: string };
    badge: number;
    sound: "default";
    "thread-id": string;
  };
  eventId: string;
  kind: NotificationKind;
  deepLink: string;
  tag: string;
  badgeCount: number;
}

export type NativeApnsSender = (request: ApnsDeliveryRequest) => Promise<ApnsSendResult>;

let timer: NodeJS.Timeout | null = null;
let running = false;
const MAX_ATTEMPTS = 5;
const STALE_CLAIM_MS = 5 * 60_000;

function claimPendingNativeDeliveries(limit: number, onlyUserId?: string): NativeDeliveryWork[] {
  const now = Date.now();
  const claimToken = randomUUID();
  const claim = db.transaction(() => {
    db.prepare(
      `UPDATE native_push_deliveries
          SET status = 'retry', claim_token = NULL, claimed_at = NULL, updated_at = ?
        WHERE status = 'inflight' AND claimed_at < ?`,
    ).run(now, now - STALE_CLAIM_MS);
    const rows = db.prepare(
      `SELECT id FROM native_push_deliveries
        WHERE status IN ('pending','retry')
          AND next_attempt_at <= @now
          AND (@userId = '' OR user_id = @userId)
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT @limit`,
    ).all({ now, userId: onlyUserId || "", limit }) as Array<{ id: string }>;
    const update = db.prepare(
      `UPDATE native_push_deliveries
          SET status = 'inflight', claim_token = ?, claimed_at = ?, last_attempt_at = ?,
              attempt_count = attempt_count + 1, updated_at = ?
        WHERE id = ? AND status IN ('pending','retry')`,
    );
    for (const row of rows) update.run(claimToken, now, now, now, row.id);
  });
  claim();
  return db.prepare(
    `SELECT d.id AS delivery_id, d.event_id, d.user_id, d.native_device_id, d.attempt_count,
            n.token, n.token_sha256, n.environment AS device_environment,
            n.disabled_at AS device_disabled_at, n.revoked_at AS device_revoked_at,
            e.kind AS event_kind, e.provider AS event_provider,
            e.provider_event_id AS event_provider_event_id,
            e.source_type AS event_source_type, e.source_record_id AS event_source_record_id,
            e.lead_id AS event_lead_id, e.generic_title AS event_generic_title,
            e.generic_body AS event_generic_body, e.enhanced_body AS event_enhanced_body,
            e.deep_link AS event_deep_link, e.notification_tag AS event_notification_tag,
            e.created_at AS event_created_at, u.disabled AS user_disabled
       FROM native_push_deliveries d
       JOIN native_push_devices n ON n.id = d.native_device_id
       JOIN notification_events e ON e.id = d.event_id
       JOIN users u ON u.id = d.user_id
      WHERE d.claim_token = ? AND d.status = 'inflight'
      ORDER BY d.created_at ASC`,
  ).all(claimToken) as NativeDeliveryWork[];
}

function eventFromWork(work: NativeDeliveryWork): NotificationEventRow {
  return {
    id: work.event_id,
    kind: work.event_kind,
    provider: work.event_provider,
    provider_event_id: work.event_provider_event_id,
    source_type: work.event_source_type,
    source_record_id: work.event_source_record_id,
    lead_id: work.event_lead_id,
    generic_title: work.event_generic_title,
    generic_body: work.event_generic_body,
    enhanced_body: work.event_enhanced_body,
    deep_link: work.event_deep_link,
    notification_tag: work.event_notification_tag,
    created_at: work.event_created_at,
  };
}

function channelEnabled(kind: NotificationKind, userId: string): boolean {
  const preferences = getNotificationPreferences(userId);
  if (kind === "incoming_message") return preferences.incomingMessages;
  if (kind === "incoming_email") return preferences.incomingEmail;
  if (kind === "incoming_fax") return preferences.incomingFax;
  if (kind === "incoming_call") return preferences.incomingCalls;
  if (kind === "missed_call") return preferences.missedCalls;
  return true;
}

function finishNativeDelivery(deliveryId: string, values: {
  status: string;
  deliveredAt?: number | null;
  responseStatus?: number | null;
  responseBody?: string | null;
  error?: string | null;
  nextAttemptAt?: number;
}): void {
  const now = Date.now();
  db.prepare(
    `UPDATE native_push_deliveries
        SET status = @status,
            delivered_at = @deliveredAt,
            response_status = @responseStatus,
            response_body = @responseBody,
            last_error = @error,
            next_attempt_at = @nextAttemptAt,
            claim_token = NULL,
            claimed_at = NULL,
            updated_at = @now
      WHERE id = @deliveryId`,
  ).run({
    deliveryId,
    status: values.status,
    deliveredAt: values.deliveredAt ?? null,
    responseStatus: values.responseStatus ?? null,
    responseBody: values.responseBody?.slice(0, 1_000) ?? null,
    error: values.error?.slice(0, 1_000) ?? null,
    nextAttemptAt: values.nextAttemptAt ?? now,
    now,
  });
}

function retryAt(attemptCount: number): number {
  const delay = Math.min(15 * 60_000, 5_000 * (2 ** Math.max(0, attemptCount - 1)));
  return Date.now() + delay + Math.floor(Math.random() * 1_000);
}

function revokeInvalidNativeDevice(item: NativeDeliveryWork, response: ApnsSendResult): void {
  const now = Date.now();
  const expire = db.transaction(() => {
    db.prepare(
      `UPDATE native_push_devices
          SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
        WHERE id = ?`,
    ).run(now, now, item.native_device_id);
    db.prepare(
      `UPDATE native_push_deliveries
          SET status = 'expired',
              response_status = ?,
              response_body = ?,
              last_error = ?,
              claim_token = NULL,
              claimed_at = NULL,
              updated_at = ?
        WHERE native_device_id = ? AND status IN ('pending','retry','inflight')`,
    ).run(
      response.statusCode,
      response.responseBody.slice(0, 1_000),
      (response.error || "APNs rejected device token").slice(0, 1_000),
      now,
      item.native_device_id,
    );
  });
  expire();
}

export function buildNativeApnsPayload(event: NotificationEventRow, userId: string): NativeApnsPayload {
  const link = safeNativeDeepLink(event.deep_link).path;
  const badge = nativeBadgeState(userId).badgeCount;
  const tag = sanitizeApnsCollapseId(event.notification_tag);
  return {
    aps: {
      alert: {
        title: event.generic_title,
        body: event.generic_body,
      },
      badge,
      sound: "default",
      "thread-id": tag,
    },
    eventId: event.id,
    kind: event.kind,
    deepLink: link,
    tag,
    badgeCount: badge,
  };
}

function deliveryRequest(item: NativeDeliveryWork): ApnsDeliveryRequest {
  const event = eventFromWork(item);
  const payload = buildNativeApnsPayload(event, item.user_id);
  return {
    deviceToken: item.token,
    deviceTokenFingerprint: item.token_sha256.slice(0, 16),
    deviceEnvironment: item.device_environment,
    apnsId: item.delivery_id,
    collapseId: payload.tag,
    payload,
    expirationSeconds: config.apns.expirationSeconds,
  };
}

export async function processNativeNotificationBatch(
  sender: NativeApnsSender = sendNativeApnsAlert,
  opts: { limit?: number; onlyUserId?: string } = {},
): Promise<{
  claimed: number;
  delivered: number;
  retried: number;
  expired: number;
  failed: number;
  suppressed: number;
  configurationErrors: number;
  authenticationFailures: number;
  throttled: number;
}> {
  const result = { claimed: 0, delivered: 0, retried: 0, expired: 0, failed: 0, suppressed: 0, configurationErrors: 0, authenticationFailures: 0, throttled: 0 };
  const work = claimPendingNativeDeliveries(Math.min(Math.max(opts.limit || 25, 1), 100), opts.onlyUserId);
  result.claimed = work.length;
  for (const item of work) {
    if (item.user_disabled || item.device_disabled_at || item.device_revoked_at || !channelEnabled(item.event_kind, item.user_id)) {
      finishNativeDelivery(item.delivery_id, {
        status: "suppressed",
        error: item.user_disabled
          ? "user disabled"
          : item.device_revoked_at
            ? "native device revoked"
            : item.device_disabled_at
              ? "native device disabled"
              : "channel preference disabled",
      });
      result.suppressed++;
      continue;
    }
    const quietUntil = quietHoursUntil(getNotificationPreferences(item.user_id));
    if (quietUntil) {
      finishNativeDelivery(item.delivery_id, { status: "retry", nextAttemptAt: quietUntil, error: "quiet hours" });
      result.retried++;
      continue;
    }

    const response = await sender(deliveryRequest(item));
    if (response.ok) {
      finishNativeDelivery(item.delivery_id, { status: "delivered", deliveredAt: Date.now(), responseStatus: response.statusCode });
      result.delivered++;
      continue;
    }
    if (response.configurationFailure) result.configurationErrors++;
    if (response.authenticationFailure) result.authenticationFailures++;
    if (response.throttled) result.throttled++;
    if (response.expired || response.invalidToken) {
      revokeInvalidNativeDevice(item, response);
      result.expired++;
      continue;
    }
    if ((response.retryable || response.configurationFailure || response.authenticationFailure) && item.attempt_count < MAX_ATTEMPTS) {
      finishNativeDelivery(item.delivery_id, {
        status: "retry",
        responseStatus: response.statusCode,
        responseBody: response.responseBody,
        error: response.error,
        nextAttemptAt: retryAt(item.attempt_count),
      });
      result.retried++;
      continue;
    }
    finishNativeDelivery(item.delivery_id, {
      status: response.configurationFailure || response.authenticationFailure ? "configuration_error" : "failed",
      responseStatus: response.statusCode,
      responseBody: response.responseBody,
      error: response.error || "permanent APNs failure",
    });
    result.failed++;
  }
  return result;
}

async function poll(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await processNativeNotificationBatch();
    if (result.claimed) log.info("native notification delivery batch", result);
  } catch (err) {
    log.error("native notification worker error", { error: err instanceof Error ? err.message : String(err) });
  } finally {
    running = false;
  }
}

export function startNativeNotificationWorker(): void {
  if (timer) return;
  if (!nativeApnsConfigured()) {
    log.warn("native notification worker not started: APNs credentials are not configured", { configured: false });
    return;
  }
  timer = setInterval(() => void poll(), config.apns.workerPollMs);
  timer.unref();
  void poll();
  log.info("native notification worker started", {
    pollMs: config.apns.workerPollMs,
    apnsEnvironment: config.apns.environment,
    configured: Boolean(config.apns.keyId && config.apns.teamId && config.apns.topic && config.apns.privateKey),
  });
}

export function stopNativeNotificationWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function resolveNativeApnsEnvironmentForDevice(environment: "development" | "production"): "sandbox" | "production" {
  return apnsEnvironmentForDevice(environment);
}
