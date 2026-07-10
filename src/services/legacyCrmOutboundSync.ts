import { randomUUID } from "crypto";
import { config } from "../config";
import { log } from "../logger";
import { db } from "../store/db";

const pending = new Map<string, NodeJS.Timeout>();
let configWarned = false;

function syncReady(): boolean {
  const enabled = Boolean(config.crm.legacyOutboundSyncEnabled);
  const ready = enabled && Boolean(config.crm.legacyOutboundSyncUrl && config.crm.legacyOutboundSyncSecret);
  if (enabled && !ready && !configWarned) {
    configWarned = true;
    log.warn("legacy CRM outbound sync disabled: set CRM_LEGACY_SYNC_URL and CRM_LEGACY_SYNC_SECRET");
  }
  return ready;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function snapshotLead(leadId: string) {
  const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(leadId) as Record<string, unknown> | undefined;
  if (!lead) return null;
  const notes = db
    .prepare(`SELECT * FROM notes WHERE lead_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(leadId, config.crm.legacyOutboundSyncNotesLimit) as Record<string, unknown>[];
  const activities = db
    .prepare(
      `SELECT * FROM activities
       WHERE lead_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(leadId, config.crm.legacyOutboundSyncActivitiesLimit) as Record<string, unknown>[];
  return {
    ...lead,
    tags: parseJson(String(lead.tags || ""), []),
    custom: parseJson(String(lead.custom || ""), {}),
    todos: parseJson(String(lead.todos || ""), []),
    notes,
    activities: activities.map((activity) => ({
      ...activity,
      meta: parseJson(String(activity.meta || ""), null),
    })),
  };
}

export async function sendLegacyCrmSyncNow(leadId: string, reason = "lead_updated"): Promise<boolean> {
  if (!syncReady()) return false;
  const snapshot = snapshotLead(leadId);
  if (!snapshot) return false;
  const { notes, activities, ...lead } = snapshot;
  const payload = {
    eventId: randomUUID(),
    source: "crm.smartr8.com/v2",
    reason,
    sentAt: Date.now(),
    lead,
    notes,
    activities,
  };
  try {
    const response = await fetch(config.crm.legacyOutboundSyncUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-crm-sync-secret": config.crm.legacyOutboundSyncSecret,
        "x-v2-sync-secret": config.crm.legacyOutboundSyncSecret,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      log.warn("legacy CRM outbound sync failed", { leadId, status: response.status, text: text.slice(0, 300) });
      return false;
    }
    log.info("legacy CRM outbound sync sent", { leadId, reason });
    return true;
  } catch (err) {
    log.warn("legacy CRM outbound sync error", { leadId, err: String(err) });
    return false;
  }
}

export function scheduleLegacyCrmSync(leadId: string, reason = "lead_updated"): void {
  if (!syncReady()) return;
  const existing = pending.get(leadId);
  if (existing) clearTimeout(existing);
  const timeout = setTimeout(() => {
    pending.delete(leadId);
    void sendLegacyCrmSyncNow(leadId, reason);
  }, config.crm.legacyOutboundSyncDebounceMs);
  pending.set(leadId, timeout);
}
