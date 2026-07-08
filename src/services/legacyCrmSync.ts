import { db } from "../store/db";
import { DEFAULT_STAGE, isPipelineStage } from "../pipeline";
import { toE164 } from "../util/phone";
import { LeadStatus } from "./leads";

type JsonObject = Record<string, unknown>;
type SyncLeadRow = JsonObject & { id: string; custom?: string | null; owner_user_id?: string | null };

export interface LegacyCrmSyncPayload {
  eventId?: string;
  reason?: string;
  source?: string;
  sentAt?: number;
  lead?: JsonObject;
  notes?: JsonObject[];
  activities?: JsonObject[];
}

export interface LegacyCrmSyncResult {
  leadId: string;
  legacyLeadId: string;
  created: boolean;
  notesUpserted: number;
  activitiesUpserted: number;
}

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function asNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function boolInt(value: unknown): number {
  if (value === true) return 1;
  if (value === false || value === null || value === undefined) return 0;
  if (typeof value === "number") return value ? 1 : 0;
  return /^(1|true|yes|y)$/i.test(String(value).trim()) ? 1 : 0;
}

function parseJsonish<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeStatus(value: unknown): LeadStatus {
  const raw = String(value || "new").toLowerCase();
  return ["new", "contacted", "qualified", "nurturing", "won", "lost"].includes(raw)
    ? (raw as LeadStatus)
    : "new";
}

function normalizeStage(value: unknown): string {
  const stage = asString(value);
  return stage && isPipelineStage(stage) ? stage : DEFAULT_STAGE;
}

function normalizeTags(value: unknown): string[] {
  const tags = parseJsonish<unknown>(value, []);
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean);
  if (typeof tags === "string") return tags.split(/[;,|]/).map((t) => t.trim()).filter(Boolean);
  return [];
}

function normalizeTodos(value: unknown): unknown[] {
  const todos = parseJsonish<unknown>(value, []);
  return Array.isArray(todos) ? todos : [];
}

function normalizeObject(value: unknown): JsonObject {
  const obj = parseJsonish<unknown>(value, {});
  return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as JsonObject) : {};
}

function readCustom(row: { custom?: string | null } | null | undefined): JsonObject {
  return normalizeObject(row?.custom || "{}");
}

function isLeadPoolRow(row: SyncLeadRow | null | undefined): boolean {
  if (!row) return false;
  const custom = readCustom(row);
  return custom.lead_pool === true || custom.lead_pool === "true" || asString(row.source) === "lead-pool";
}

function getLeadRow(id: string): SyncLeadRow | null {
  return (db.prepare(`SELECT * FROM leads WHERE id = ?`).get(id) as SyncLeadRow | undefined) || null;
}

function findByLegacyId(legacyLeadId: string): SyncLeadRow | null {
  return (
    db
      .prepare(
        `SELECT * FROM leads
         WHERE custom LIKE ? AND custom NOT LIKE '%"lead_pool":true%' AND custom NOT LIKE '%"lead_pool":"true"%'
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(`%"legacy_crm_id":"${legacyLeadId}"%`) as SyncLeadRow | undefined
  ) || null;
}

function findTargetLead(legacyLeadId: string, phone: string | null, email: string | null) {
  const byId = getLeadRow(legacyLeadId);
  if (byId) return byId;
  const byLegacy = findByLegacyId(legacyLeadId);
  if (byLegacy) return byLegacy;
  if (phone) {
    const byPhone = db
      .prepare(
        `SELECT * FROM leads
         WHERE phone = ? AND custom NOT LIKE '%"lead_pool":true%' AND custom NOT LIKE '%"lead_pool":"true"%'
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(phone) as SyncLeadRow | undefined;
    if (byPhone && !isLeadPoolRow(byPhone)) return byPhone;
  }
  if (email) {
    const byEmail = db
      .prepare(
        `SELECT * FROM leads
         WHERE email = ? COLLATE NOCASE AND custom NOT LIKE '%"lead_pool":true%' AND custom NOT LIKE '%"lead_pool":"true"%'
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(email) as SyncLeadRow | undefined;
    if (byEmail && !isLeadPoolRow(byEmail)) return byEmail;
  }
  return null;
}

function applyLead(payload: LegacyCrmSyncPayload): { id: string; legacyLeadId: string; created: boolean } {
  const lead = payload.lead || {};
  const legacyLeadId = asString(lead.id);
  if (!legacyLeadId) throw new Error("sync payload missing lead.id");

  const phone = asString(lead.phone) ? toE164(String(lead.phone)) : null;
  const email = asString(lead.email);
  const existing = findTargetLead(legacyLeadId, phone, email);
  const now = Date.now();
  const id = existing?.id || legacyLeadId;
  const existingCustom = readCustom(existing);
  const existingIsLeadPool = isLeadPoolRow(existing);
  const incomingCustom = normalizeObject(lead.custom);
  const custom = {
    ...existingCustom,
    ...incomingCustom,
    legacy_crm_id: legacyLeadId,
    legacy_crm_source: payload.source || "crm.smartr8.com",
    legacy_crm_synced_at: new Date(now).toISOString(),
    legacy_crm_sync_reason: payload.reason || null,
    legacy_crm_owner_user_id: asString(lead.owner_user_id),
  };
  const row = {
    id,
    created_at: asNumber(lead.created_at, now),
    updated_at: asNumber(lead.updated_at, now),
    first_name: asString(lead.first_name),
    last_name: asString(lead.last_name),
    email,
    phone,
    source: asString(lead.source) || "legacy-crm-sync",
    status: normalizeStatus(lead.status),
    pipeline_stage: normalizeStage(lead.pipeline_stage || lead.stage),
    owner: asString(lead.owner),
    score: asNumber(lead.score, 0),
    timezone: asString(lead.timezone),
    consent: boolInt(lead.consent),
    ghl_contact_id: asString(lead.ghl_contact_id),
    tags: JSON.stringify(normalizeTags(lead.tags)),
    custom: JSON.stringify(custom),
    last_activity_at: nullableNumber(lead.last_activity_at),
    category: asString(lead.category),
    category_reason: asString(lead.category_reason),
    campaign: asString(lead.campaign),
    sms_consent: boolInt(lead.sms_consent),
    email_unsubscribed: boolInt(lead.email_unsubscribed),
    consent_at: nullableNumber(lead.consent_at),
    deleted_at: nullableNumber(lead.deleted_at),
    past_client: existingIsLeadPool ? 0 : boolInt(lead.past_client),
    contact_only: existingIsLeadPool ? 1 : boolInt(lead.contact_only),
    owner_user_id: existing?.owner_user_id || null,
    todos: JSON.stringify(normalizeTodos(lead.todos)),
  };

  if (existing) {
    db.prepare(
      `UPDATE leads SET
        created_at = @created_at, updated_at = @updated_at, first_name = @first_name, last_name = @last_name,
        email = @email, phone = @phone, source = @source, status = @status, pipeline_stage = @pipeline_stage,
        owner = @owner, score = @score, timezone = @timezone, consent = @consent, ghl_contact_id = @ghl_contact_id,
        tags = @tags, custom = @custom, last_activity_at = @last_activity_at, category = @category,
        category_reason = @category_reason, campaign = @campaign, sms_consent = @sms_consent,
        email_unsubscribed = @email_unsubscribed, consent_at = @consent_at, deleted_at = @deleted_at,
        past_client = @past_client, contact_only = @contact_only, owner_user_id = @owner_user_id, todos = @todos
       WHERE id = @id`,
    ).run(row);
  } else {
    db.prepare(
      `INSERT INTO leads (id, created_at, updated_at, first_name, last_name, email, phone, source,
        status, pipeline_stage, owner, score, timezone, consent, ghl_contact_id, tags, custom, last_activity_at,
        category, category_reason, campaign, sms_consent, email_unsubscribed, consent_at, deleted_at,
        past_client, contact_only, owner_user_id, todos)
       VALUES (@id, @created_at, @updated_at, @first_name, @last_name, @email, @phone, @source,
        @status, @pipeline_stage, @owner, @score, @timezone, @consent, @ghl_contact_id, @tags, @custom,
        @last_activity_at, @category, @category_reason, @campaign, @sms_consent, @email_unsubscribed,
        @consent_at, @deleted_at, @past_client, @contact_only, @owner_user_id, @todos)`,
    ).run(row);
  }
  return { id, legacyLeadId, created: !existing };
}

function upsertNotes(leadId: string, notes: JsonObject[] | undefined): number {
  const rows = Array.isArray(notes) ? notes : [];
  const stmt = db.prepare(
    `INSERT INTO notes (id, lead_id, created_at, author, body)
     VALUES (@id, @lead_id, @created_at, @author, @body)
     ON CONFLICT(id) DO UPDATE SET
       lead_id = excluded.lead_id,
       created_at = excluded.created_at,
       author = excluded.author,
       body = excluded.body`,
  );
  let count = 0;
  for (const note of rows) {
    const id = asString(note.id);
    const body = asString(note.body);
    if (!id || !body) continue;
    stmt.run({
      id,
      lead_id: leadId,
      created_at: asNumber(note.created_at, Date.now()),
      author: asString(note.author),
      body,
    });
    count++;
  }
  return count;
}

function metaValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function upsertActivities(leadId: string, activities: JsonObject[] | undefined): number {
  const rows = Array.isArray(activities) ? activities : [];
  const stmt = db.prepare(
    `INSERT INTO activities (id, lead_id, created_at, type, direction, channel, subject, body, status, meta, deleted_at)
     VALUES (@id, @lead_id, @created_at, @type, @direction, @channel, @subject, @body, @status, @meta, @deleted_at)
     ON CONFLICT(id) DO UPDATE SET
       lead_id = excluded.lead_id,
       created_at = excluded.created_at,
       type = excluded.type,
       direction = excluded.direction,
       channel = excluded.channel,
       subject = excluded.subject,
       body = excluded.body,
       status = excluded.status,
       meta = excluded.meta,
       deleted_at = excluded.deleted_at`,
  );
  let count = 0;
  for (const activity of rows) {
    const id = asString(activity.id);
    const type = asString(activity.type);
    if (!id || !type) continue;
    stmt.run({
      id,
      lead_id: leadId,
      created_at: asNumber(activity.created_at, Date.now()),
      type,
      direction: asString(activity.direction),
      channel: asString(activity.channel),
      subject: asString(activity.subject),
      body: asString(activity.body),
      status: asString(activity.status),
      meta: metaValue(activity.meta),
      deleted_at: nullableNumber(activity.deleted_at),
    });
    count++;
  }
  return count;
}

export function applyLegacyCrmSync(payload: LegacyCrmSyncPayload): LegacyCrmSyncResult {
  if (!payload || typeof payload !== "object") throw new Error("invalid sync payload");
  const run = db.transaction(() => {
    const leadResult = applyLead(payload);
    const notesUpserted = upsertNotes(leadResult.id, payload.notes);
    const activitiesUpserted = upsertActivities(leadResult.id, payload.activities);
    return {
      leadId: leadResult.id,
      legacyLeadId: leadResult.legacyLeadId,
      created: leadResult.created,
      notesUpserted,
      activitiesUpserted,
    };
  });
  return run();
}
