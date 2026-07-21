import { randomUUID } from "crypto";
import { config } from "../config";
import { db } from "../store/db";
import { getUser, isSuperAdmin, listUsers, type User } from "./auth";
import { userHasFeature } from "./permissions";

export type NotificationKind =
  | "incoming_message"
  | "incoming_email"
  | "incoming_fax"
  | "incoming_call"
  | "missed_call"
  | "test";

export interface NotificationPreferences {
  userId: string;
  incomingMessages: boolean;
  incomingEmail: boolean;
  incomingFax: boolean;
  incomingCalls: boolean;
  missedCalls: boolean;
  appBadges: boolean;
  previewLevel: "generic" | "enhanced";
  quietHoursEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  quietHoursTz: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface NotificationEventRow {
  id: string;
  kind: NotificationKind;
  provider: string;
  provider_event_id: string | null;
  source_type: string;
  source_record_id: string;
  lead_id: string | null;
  generic_title: string;
  generic_body: string;
  enhanced_body: string | null;
  deep_link: string;
  notification_tag: string;
  created_at: number;
}

interface PreferenceRow {
  user_id: string;
  incoming_messages: number;
  incoming_email: number;
  incoming_fax: number;
  incoming_calls: number;
  missed_calls: number;
  app_badges: number;
  preview_level: string;
  quiet_hours_enabled: number;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  quiet_hours_tz: string | null;
  created_at: number;
  updated_at: number;
}

const SAFE_TEXT: Record<NotificationKind, { title: string; body: string }> = {
  incoming_message: { title: "SmartR8 CRM", body: "New text message in SmartR8" },
  incoming_email: { title: "SmartR8 CRM", body: "New borrower email" },
  incoming_fax: { title: "SmartR8 CRM", body: "Incoming fax received" },
  incoming_call: { title: "SmartR8 CRM", body: "Incoming SmartR8 call" },
  missed_call: { title: "SmartR8 CRM", body: "Missed SmartR8 call" },
  test: { title: "SmartR8 CRM", body: "SmartR8 notifications are enabled" },
};

const SOURCE_FEATURE: Record<NotificationKind, string | null> = {
  incoming_message: "messages",
  incoming_email: "email",
  incoming_fax: "fax",
  incoming_call: "dialer",
  missed_call: "dialer",
  test: null,
};

function toPreferences(row: PreferenceRow): NotificationPreferences {
  return {
    userId: row.user_id,
    incomingMessages: Boolean(row.incoming_messages),
    incomingEmail: Boolean(row.incoming_email),
    incomingFax: Boolean(row.incoming_fax),
    incomingCalls: Boolean(row.incoming_calls),
    missedCalls: Boolean(row.missed_calls),
    appBadges: Boolean(row.app_badges),
    previewLevel: row.preview_level === "enhanced" ? "enhanced" : "generic",
    quietHoursEnabled: Boolean(row.quiet_hours_enabled),
    quietHoursStart: row.quiet_hours_start,
    quietHoursEnd: row.quiet_hours_end,
    quietHoursTz: row.quiet_hours_tz,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getNotificationPreferences(userId: string): NotificationPreferences {
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO notification_preferences (user_id, created_at, updated_at)
     VALUES (?, ?, ?)`,
  ).run(userId, now, now);
  const row = db.prepare(`SELECT * FROM notification_preferences WHERE user_id = ?`).get(userId) as PreferenceRow;
  return toPreferences(row);
}

function validTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function updateNotificationPreferences(userId: string, input: Record<string, unknown>): NotificationPreferences {
  const current = getNotificationPreferences(userId);
  const boolValue = (key: string, fallback: boolean) => typeof input[key] === "boolean" ? Boolean(input[key]) : fallback;
  const previewLevel = input.previewLevel === "enhanced" ? "enhanced" : input.previewLevel === "generic" ? "generic" : current.previewLevel;
  const quietHoursStart = input.quietHoursStart === null || input.quietHoursStart === ""
    ? null
    : validTime(input.quietHoursStart) ? input.quietHoursStart : current.quietHoursStart;
  const quietHoursEnd = input.quietHoursEnd === null || input.quietHoursEnd === ""
    ? null
    : validTime(input.quietHoursEnd) ? input.quietHoursEnd : current.quietHoursEnd;
  const requestedTz = typeof input.quietHoursTz === "string" ? input.quietHoursTz.trim().slice(0, 80) : current.quietHoursTz;
  const quietHoursTz = requestedTz && validTimeZone(requestedTz) ? requestedTz : current.quietHoursTz;
  const now = Date.now();
  db.prepare(
    `UPDATE notification_preferences
        SET incoming_messages = @incomingMessages,
            incoming_email = @incomingEmail,
            incoming_fax = @incomingFax,
            incoming_calls = @incomingCalls,
            missed_calls = @missedCalls,
            app_badges = @appBadges,
            preview_level = @previewLevel,
            quiet_hours_enabled = @quietHoursEnabled,
            quiet_hours_start = @quietHoursStart,
            quiet_hours_end = @quietHoursEnd,
            quiet_hours_tz = @quietHoursTz,
            updated_at = @now
      WHERE user_id = @userId`,
  ).run({
    userId,
    incomingMessages: boolValue("incomingMessages", current.incomingMessages) ? 1 : 0,
    incomingEmail: boolValue("incomingEmail", current.incomingEmail) ? 1 : 0,
    incomingFax: boolValue("incomingFax", current.incomingFax) ? 1 : 0,
    incomingCalls: boolValue("incomingCalls", current.incomingCalls) ? 1 : 0,
    missedCalls: boolValue("missedCalls", current.missedCalls) ? 1 : 0,
    appBadges: boolValue("appBadges", current.appBadges) ? 1 : 0,
    previewLevel,
    quietHoursEnabled: boolValue("quietHoursEnabled", current.quietHoursEnabled) ? 1 : 0,
    quietHoursStart,
    quietHoursEnd,
    quietHoursTz,
    now,
  });
  return getNotificationPreferences(userId);
}

function preferenceEnabled(kind: NotificationKind, preferences: NotificationPreferences): boolean {
  if (kind === "incoming_message") return preferences.incomingMessages;
  if (kind === "incoming_email") return preferences.incomingEmail;
  if (kind === "incoming_fax") return preferences.incomingFax;
  if (kind === "incoming_call") return preferences.incomingCalls;
  if (kind === "missed_call") return preferences.missedCalls;
  return true;
}

function minutesInZone(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value || 0);
  return hour * 60 + minute;
}

function timeMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

/** Returns a conservative next-at time; polling will re-evaluate after this point. */
export function quietHoursUntil(preferences: NotificationPreferences, now = Date.now()): number | null {
  if (!preferences.quietHoursEnabled || !preferences.quietHoursStart || !preferences.quietHoursEnd || !preferences.quietHoursTz) return null;
  if (!validTimeZone(preferences.quietHoursTz)) return null;
  const start = timeMinutes(preferences.quietHoursStart);
  const end = timeMinutes(preferences.quietHoursEnd);
  if (start === end) return null;
  const local = minutesInZone(now, preferences.quietHoursTz);
  const active = start < end ? local >= start && local < end : local >= start || local < end;
  if (!active) return null;
  const remainingMinutes = start < end || local < end ? end - local : (24 * 60 - local) + end;
  return now + Math.max(1, remainingMinutes) * 60_000;
}

function configuredDefaultUser(users: User[]): User | null {
  const wanted = config.push.defaultNotificationUserId.trim().toLowerCase();
  if (!wanted) return null;
  return users.find((user) => [user.id, user.username, user.name || ""].some((value) => value.toLowerCase() === wanted)) || null;
}

function userCanReceive(user: User | null | undefined, feature: string | null, leadOwnerId: string | null): user is User {
  if (!user || user.disabled) return false;
  if (feature && !userHasFeature(user, feature)) return false;
  return isSuperAdmin(user) || Boolean(leadOwnerId && user.id === leadOwnerId);
}

export interface NotificationRecipient {
  user: User;
  preferences: NotificationPreferences;
  nextAttemptAt: number;
}

export function resolveNotificationRecipients(input: {
  kind: NotificationKind;
  leadId?: string | null;
  explicitUserId?: string;
  now?: number;
}): NotificationRecipient[] {
  const now = input.now ?? Date.now();
  const feature = SOURCE_FEATURE[input.kind];
  if (input.explicitUserId) {
    const user = getUser(input.explicitUserId);
    if (!user || user.disabled || (feature && !userHasFeature(user, feature))) return [];
    const preferences = getNotificationPreferences(user.id);
    if (!preferenceEnabled(input.kind, preferences)) return [];
    return [{ user, preferences, nextAttemptAt: quietHoursUntil(preferences, now) || now }];
  }

  const users = listUsers();
  const lead = input.leadId
    ? db.prepare(`SELECT id, owner_user_id FROM leads WHERE id = ? AND deleted_at IS NULL`).get(input.leadId) as { id: string; owner_user_id: string | null } | undefined
    : undefined;
  const leadOwnerId = lead?.owner_user_id || null;
  let selected = leadOwnerId ? users.find((user) => user.id === leadOwnerId) || null : null;
  if (!userCanReceive(selected, feature, leadOwnerId)) selected = null;

  const fallback = configuredDefaultUser(users);
  if (!selected && fallback && !fallback.disabled) {
    if (userCanReceive(fallback, feature, leadOwnerId)) selected = fallback;
  }
  if (!selected) {
    selected = users.find((user) => isSuperAdmin(user) && userCanReceive(user, feature, leadOwnerId)) || null;
  }
  if (!selected) return [];

  const preferences = getNotificationPreferences(selected.id);
  if (!preferenceEnabled(input.kind, preferences)) return [];
  return [{ user: selected, preferences, nextAttemptAt: quietHoursUntil(preferences, now) || now }];
}

function safeIdentifier(value: string | null | undefined, max = 200): string {
  return String(value || "").trim().replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, max);
}

export function safeFirstName(value: string | null | undefined): string | null {
  const cleaned = String(value || "").trim().split(/\s+/)[0]?.replace(/[^\p{L}\p{M}'-]/gu, "").slice(0, 40);
  return cleaned || null;
}

export function safeDeepLink(value: string | null | undefined): string {
  const fallback = "/v2/?page=notifications";
  try {
    const parsed = new URL(String(value || fallback), "https://crm.smartr8.com");
    if (parsed.origin !== "https://crm.smartr8.com" || (parsed.pathname !== "/v2" && parsed.pathname !== "/v2/")) return fallback;
    const output = new URL("https://crm.smartr8.com/v2/");
    for (const key of ["page", "lead", "event", "fax", "call"]) {
      const item = safeIdentifier(parsed.searchParams.get(key), 128);
      if (item) output.searchParams.set(key, item);
    }
    if (!output.searchParams.size && !parsed.search) return output.pathname;
    if (!output.searchParams.get("page")) output.searchParams.set("page", "notifications");
    return `${output.pathname}${output.search}`;
  } catch {
    return fallback;
  }
}

function enhancedBody(kind: NotificationKind, firstName: string | null): string | null {
  if (!firstName) return null;
  if (kind === "incoming_message") return `New text message from ${firstName}`;
  if (kind === "incoming_email") return `New borrower email from ${firstName}`;
  if (kind === "incoming_fax") return `Incoming fax from ${firstName}`;
  if (kind === "incoming_call") return `Incoming SmartR8 call from ${firstName}`;
  if (kind === "missed_call") return `Missed SmartR8 call from ${firstName}`;
  return null;
}

function defaultTag(kind: NotificationKind, sourceRecordId: string): string {
  if (kind === "incoming_message") return `message:${sourceRecordId}`;
  if (kind === "incoming_email") return `email:${sourceRecordId}`;
  if (kind === "incoming_fax") return `fax:${sourceRecordId}`;
  if (kind === "incoming_call" || kind === "missed_call") return `call:${sourceRecordId}`;
  return `test:${sourceRecordId}`;
}

export function createNotificationEvent(input: {
  kind: NotificationKind;
  provider: string;
  providerEventId?: string | null;
  sourceType: string;
  sourceRecordId: string;
  leadId?: string | null;
  deepLink: string;
  notificationTag?: string;
  contactFirstName?: string | null;
  explicitUserId?: string;
  createdAt?: number;
}): { event: NotificationEventRow; duplicate: boolean; recipients: string[] } | null {
  const provider = safeIdentifier(input.provider, 80) || "internal";
  const providerEventId = safeIdentifier(input.providerEventId, 200) || null;
  const sourceType = safeIdentifier(input.sourceType, 80) || "unknown";
  const sourceRecordId = safeIdentifier(input.sourceRecordId, 200);
  if (!sourceRecordId) throw new Error("notification source record id is required");
  const existing = (providerEventId
    ? db.prepare(`SELECT * FROM notification_events WHERE provider = ? AND provider_event_id = ?`).get(provider, providerEventId)
    : db.prepare(`SELECT * FROM notification_events WHERE kind = ? AND source_type = ? AND source_record_id = ?`).get(input.kind, sourceType, sourceRecordId)) as NotificationEventRow | undefined;
  if (existing) return { event: existing, duplicate: true, recipients: [] };

  const recipients = resolveNotificationRecipients({
    kind: input.kind,
    leadId: input.leadId,
    explicitUserId: input.explicitUserId,
    now: input.createdAt,
  });
  if (!recipients.length) return null;
  const now = input.createdAt ?? Date.now();
  const id = randomUUID();
  const generic = SAFE_TEXT[input.kind];
  const tag = safeIdentifier(input.notificationTag, 200) || defaultTag(input.kind, sourceRecordId);
  const event: NotificationEventRow = {
    id,
    kind: input.kind,
    provider,
    provider_event_id: providerEventId,
    source_type: sourceType,
    source_record_id: sourceRecordId,
    lead_id: input.leadId || null,
    generic_title: generic.title,
    generic_body: generic.body,
    enhanced_body: enhancedBody(input.kind, safeFirstName(input.contactFirstName)),
    deep_link: safeDeepLink(input.deepLink),
    notification_tag: tag,
    created_at: now,
  };

  const insert = db.transaction(() => {
    db.prepare(
      `INSERT INTO notification_events
        (id, kind, provider, provider_event_id, source_type, source_record_id, lead_id,
         generic_title, generic_body, enhanced_body, deep_link, notification_tag, created_at)
       VALUES
        (@id, @kind, @provider, @provider_event_id, @source_type, @source_record_id, @lead_id,
         @generic_title, @generic_body, @enhanced_body, @deep_link, @notification_tag, @created_at)`,
    ).run(event);
    const receipt = db.prepare(`INSERT INTO notification_receipts (event_id, user_id) VALUES (?, ?)`);
    const delivery = db.prepare(
      `INSERT OR IGNORE INTO notification_deliveries
        (id, event_id, user_id, subscription_id, status, attempt_count, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    );
    const subscriptions = db.prepare(
      `SELECT id FROM push_subscriptions WHERE user_id = ? AND revoked_at IS NULL ORDER BY updated_at DESC`,
    );
    for (const recipient of recipients) {
      receipt.run(id, recipient.user.id);
      const rows = subscriptions.all(recipient.user.id) as Array<{ id: string }>;
      for (const subscription of rows) {
        delivery.run(randomUUID(), id, recipient.user.id, subscription.id, recipient.nextAttemptAt, now, now);
      }
    }
  });
  insert();
  return { event, duplicate: false, recipients: recipients.map((recipient) => recipient.user.id) };
}

export function getEventForUser(eventId: string, userId: string): NotificationEventRow | null {
  return db.prepare(
    `SELECT e.* FROM notification_events e
      JOIN notification_receipts r ON r.event_id = e.id
     WHERE e.id = ? AND r.user_id = ?`,
  ).get(eventId, userId) as NotificationEventRow | undefined || null;
}

function eventLabel(kind: NotificationKind): string {
  if (kind === "incoming_message") return "New message";
  if (kind === "incoming_email") return "New email";
  if (kind === "incoming_fax") return "Incoming fax";
  if (kind === "incoming_call") return "Incoming call";
  if (kind === "missed_call") return "Missed call";
  return "Test notification";
}

export function listUserNotifications(userId: string, limit = 75): { notifications: Array<Record<string, unknown>>; count: number } {
  const preferences = getNotificationPreferences(userId);
  const rows = db.prepare(
    `SELECT e.*, r.read_at, r.opened_at, r.dismissed_at, l.first_name
       FROM notification_events e
       JOIN notification_receipts r ON r.event_id = e.id AND r.user_id = @userId
       LEFT JOIN leads l ON l.id = e.lead_id
      WHERE r.dismissed_at IS NULL
      ORDER BY e.created_at DESC
      LIMIT @limit`,
  ).all({ userId, limit: Math.min(Math.max(limit, 1), 150) }) as Array<NotificationEventRow & {
    read_at: number | null;
    opened_at: number | null;
    dismissed_at: number | null;
    first_name: string | null;
  }>;
  const unread = db.prepare(
    `SELECT COUNT(*) AS count FROM notification_receipts WHERE user_id = ? AND dismissed_at IS NULL AND read_at IS NULL`,
  ).get(userId) as { count: number };
  return {
    count: unread.count,
    notifications: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: eventLabel(row.kind),
      at: row.created_at,
      leadId: row.lead_id,
      name: preferences.previewLevel === "enhanced" ? safeFirstName(row.first_name) : "",
      contact: "",
      preview: preferences.previewLevel === "enhanced" && row.enhanced_body ? row.enhanced_body : row.generic_body,
      deepLink: row.deep_link,
      read: Boolean(row.read_at),
      opened: Boolean(row.opened_at),
    })),
  };
}

export function markNotificationReceipt(eventId: string, userId: string, field: "read_at" | "opened_at" | "dismissed_at"): boolean {
  const now = Date.now();
  const result = db.prepare(
    `UPDATE notification_receipts SET ${field} = COALESCE(${field}, ?) WHERE event_id = ? AND user_id = ?`,
  ).run(now, eventId, userId);
  if (field === "opened_at" && result.changes) {
    db.prepare(`UPDATE notification_receipts SET read_at = COALESCE(read_at, ?) WHERE event_id = ? AND user_id = ?`).run(now, eventId, userId);
  }
  return Boolean(result.changes);
}

export function markAllNotifications(userId: string, field: "read_at" | "dismissed_at"): number {
  const result = db.prepare(
    `UPDATE notification_receipts SET ${field} = COALESCE(${field}, ?) WHERE user_id = ? AND dismissed_at IS NULL`,
  ).run(Date.now(), userId);
  return result.changes;
}

export function buildPushPayload(event: NotificationEventRow, userId: string): string {
  const preferences = getNotificationPreferences(userId);
  const unread = db.prepare(
    `SELECT COUNT(*) AS count FROM notification_receipts WHERE user_id = ? AND dismissed_at IS NULL AND read_at IS NULL`,
  ).get(userId) as { count: number };
  const payload = {
    title: event.generic_title,
    body: preferences.previewLevel === "enhanced" && event.enhanced_body ? event.enhanced_body : event.generic_body,
    tag: event.notification_tag,
    deepLink: event.deep_link,
    eventId: event.id,
    kind: event.kind,
    badge: preferences.appBadges,
    badgeCount: preferences.appBadges ? unread.count : 0,
  };
  return JSON.stringify(payload);
}
