import { randomUUID } from "crypto";
import { config } from "../config";
import { log } from "../logger";
import { db } from "../store/db";
import { buildPushPayload, getNotificationPreferences, quietHoursUntil, type NotificationEventRow, type NotificationKind } from "./notifications";
import { sendWebPush, type PushSendResult, type StoredPushSubscription } from "./push";

interface DeliveryWork extends StoredPushSubscription {
  delivery_id: string;
  event_id: string;
  user_id: string;
  attempt_count: number;
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

export type PushSender = (subscription: StoredPushSubscription, payload: string) => Promise<PushSendResult>;

let timer: NodeJS.Timeout | null = null;
let running = false;
const MAX_ATTEMPTS = 5;
const STALE_CLAIM_MS = 5 * 60_000;

function claimPendingDeliveries(limit: number, onlyUserId?: string): DeliveryWork[] {
  const now = Date.now();
  const claimToken = randomUUID();
  const claim = db.transaction(() => {
    db.prepare(
      `UPDATE notification_deliveries
          SET status = 'retry', claim_token = NULL, claimed_at = NULL, updated_at = ?
        WHERE status = 'inflight' AND claimed_at < ?`,
    ).run(now, now - STALE_CLAIM_MS);
    const rows = db.prepare(
      `SELECT id FROM notification_deliveries
        WHERE status IN ('pending','retry')
          AND next_attempt_at <= @now
          AND (@userId = '' OR user_id = @userId)
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT @limit`,
    ).all({ now, userId: onlyUserId || "", limit }) as Array<{ id: string }>;
    const update = db.prepare(
      `UPDATE notification_deliveries
          SET status = 'inflight', claim_token = ?, claimed_at = ?, last_attempt_at = ?,
              attempt_count = attempt_count + 1, updated_at = ?
        WHERE id = ? AND status IN ('pending','retry')`,
    );
    for (const row of rows) update.run(claimToken, now, now, now, row.id);
  });
  claim();
  return db.prepare(
    `SELECT d.id AS delivery_id, d.event_id, d.user_id, d.attempt_count,
            s.id, s.endpoint, s.p256dh_key, s.auth_key,
            e.kind AS event_kind, e.provider AS event_provider,
            e.provider_event_id AS event_provider_event_id,
            e.source_type AS event_source_type, e.source_record_id AS event_source_record_id,
            e.lead_id AS event_lead_id, e.generic_title AS event_generic_title,
            e.generic_body AS event_generic_body, e.enhanced_body AS event_enhanced_body,
            e.deep_link AS event_deep_link, e.notification_tag AS event_notification_tag,
            e.created_at AS event_created_at, u.disabled AS user_disabled
       FROM notification_deliveries d
       JOIN push_subscriptions s ON s.id = d.subscription_id
       JOIN notification_events e ON e.id = d.event_id
       JOIN users u ON u.id = d.user_id
      WHERE d.claim_token = ? AND d.status = 'inflight'
      ORDER BY d.created_at ASC`,
  ).all(claimToken) as DeliveryWork[];
}

function eventFromWork(work: DeliveryWork): NotificationEventRow {
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

function finish(deliveryId: string, values: {
  status: string;
  deliveredAt?: number | null;
  responseStatus?: number | null;
  responseBody?: string | null;
  error?: string | null;
  nextAttemptAt?: number;
}): void {
  const now = Date.now();
  db.prepare(
    `UPDATE notification_deliveries
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

export async function processNotificationBatch(
  sender: PushSender = sendWebPush,
  opts: { limit?: number; onlyUserId?: string } = {},
): Promise<{ claimed: number; delivered: number; retried: number; expired: number; failed: number; suppressed: number }> {
  const result = { claimed: 0, delivered: 0, retried: 0, expired: 0, failed: 0, suppressed: 0 };
  const work = claimPendingDeliveries(Math.min(Math.max(opts.limit || 25, 1), 100), opts.onlyUserId);
  result.claimed = work.length;
  for (const item of work) {
    if (item.user_disabled || !channelEnabled(item.event_kind, item.user_id)) {
      finish(item.delivery_id, { status: "suppressed", error: item.user_disabled ? "user disabled" : "channel preference disabled" });
      result.suppressed++;
      continue;
    }
    const quietUntil = quietHoursUntil(getNotificationPreferences(item.user_id));
    if (quietUntil) {
      finish(item.delivery_id, { status: "retry", nextAttemptAt: quietUntil, error: "quiet hours" });
      result.retried++;
      continue;
    }
    const response = await sender(item, buildPushPayload(eventFromWork(item), item.user_id));
    if (response.ok) {
      finish(item.delivery_id, { status: "delivered", deliveredAt: Date.now(), responseStatus: response.statusCode });
      result.delivered++;
      continue;
    }
    if (response.expired) {
      const now = Date.now();
      const expire = db.transaction(() => {
        db.prepare(`UPDATE push_subscriptions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE id = ?`).run(now, now, item.id);
        db.prepare(
          `UPDATE notification_deliveries SET status = 'expired', response_status = ?, response_body = ?, last_error = ?,
                  claim_token = NULL, claimed_at = NULL, updated_at = ?
            WHERE subscription_id = ? AND status IN ('pending','retry','inflight')`,
        ).run(response.statusCode, response.responseBody.slice(0, 1_000), (response.error || "endpoint expired").slice(0, 1_000), now, item.id);
      });
      expire();
      result.expired++;
      continue;
    }
    if (response.retryable && item.attempt_count < MAX_ATTEMPTS) {
      finish(item.delivery_id, {
        status: "retry",
        responseStatus: response.statusCode,
        responseBody: response.responseBody,
        error: response.error,
        nextAttemptAt: retryAt(item.attempt_count),
      });
      result.retried++;
      continue;
    }
    finish(item.delivery_id, {
      status: "failed",
      responseStatus: response.statusCode,
      responseBody: response.responseBody,
      error: response.error || "permanent Web Push failure",
    });
    result.failed++;
  }
  return result;
}

async function poll(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await processNotificationBatch();
    if (result.claimed) log.info("notification delivery batch", result);
  } catch (err) {
    log.error("notification worker error", { error: err instanceof Error ? err.message : String(err) });
  } finally {
    running = false;
  }
}

export function startNotificationWorker(): void {
  if (timer) return;
  timer = setInterval(() => void poll(), config.push.workerPollMs);
  timer.unref();
  void poll();
  log.info("notification worker started", { pollMs: config.push.workerPollMs });
}

export function stopNotificationWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
