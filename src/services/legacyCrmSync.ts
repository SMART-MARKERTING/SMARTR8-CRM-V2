import { db } from "../store/db";
import { DEFAULT_STAGE, isPipelineStage } from "../pipeline";
import { toE164 } from "../util/phone";
import { LeadStatus } from "./leads";

type JsonObject = Record<string, unknown>;
type SyncLeadRow = JsonObject & { id: string; custom?: string | null; owner_user_id?: string | null };
const LEAD_POOL_MARKER_SQL = `(custom LIKE '%"lead_pool":true%' OR custom LIKE '%"lead_pool":"true"%')`;
const LEGACY_OLD_LIST_SQL =
  `(LOWER(COALESCE(source, '')) IN ('lead-pool', 'lead pool', 'leadpool', 'old lead', 'old leads', 'open lead') ` +
  `OR (LOWER(COALESCE(source, '')) = 'lead' AND (LOWER(COALESCE(tags, '')) LIKE '%open lead%' OR LOWER(COALESCE(custom, '')) LIKE '%open lead%' OR contact_only = 1)))`;
const NOT_LEAD_POOL_CANDIDATE_SQL = `(past_client = 1 OR NOT (${LEAD_POOL_MARKER_SQL} OR ${LEGACY_OLD_LIST_SQL}))`;

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
  leadApplied: boolean;
  duplicate: boolean;
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

function containsOpenLead(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => containsOpenLead(item));
  if (value && typeof value === "object") return Object.values(value as JsonObject).some((item) => containsOpenLead(item));
  return String(value || "").toLowerCase().includes("open lead");
}

function isLegacyLeadPoolCandidate(source: unknown, tags: unknown, custom: JsonObject, contactOnly: unknown): boolean {
  const src = String(source || "").trim().toLowerCase();
  if (["lead-pool", "lead pool", "leadpool", "old lead", "old leads", "open lead"].includes(src)) return true;
  if (src === "lead" && (containsOpenLead(tags) || containsOpenLead(custom) || boolInt(contactOnly) === 1)) return true;
  return false;
}

function isLegacyPastClient(lead: JsonObject, tags: string[], custom: JsonObject): boolean {
  if (boolInt(lead.past_client ?? lead.pastClient ?? lead.is_past_client ?? lead.isPastClient) === 1) return true;
  if (boolInt(lead.closed_client ?? lead.closedClient ?? lead.funded) === 1) return true;
  const stage = String(lead.pipeline_stage || lead.stage || lead.status || "").trim().toLowerCase();
  if (["funded", "closed", "won", "past client", "past-client"].includes(stage)) return true;
  if (tags.some((tag) => /^(past[-\s_]*client|funded|closed)$/i.test(tag))) return true;
  if (boolInt(custom.past_client ?? custom.pastClient ?? custom.closed_client ?? custom.closedClient ?? custom.funded) === 1) return true;
  return false;
}

function isLeadPoolRow(row: SyncLeadRow | null | undefined): boolean {
  if (!row) return false;
  if (boolInt(row.past_client) === 1) return false;
  const custom = readCustom(row);
  return custom.lead_pool === true || custom.lead_pool === "true" || isLegacyLeadPoolCandidate(row.source, row.tags, custom, row.contact_only);
}

function getLeadRow(id: string): SyncLeadRow | null {
  return (db.prepare(`SELECT * FROM leads WHERE id = ?`).get(id) as SyncLeadRow | undefined) || null;
}

function findByLegacyId(legacyLeadId: string): SyncLeadRow | null {
  return (
    db
      .prepare(
        `SELECT * FROM leads
         WHERE custom LIKE ? AND ${NOT_LEAD_POOL_CANDIDATE_SQL}
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
         WHERE phone = ? AND ${NOT_LEAD_POOL_CANDIDATE_SQL}
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(phone) as SyncLeadRow | undefined;
    if (byPhone && !isLeadPoolRow(byPhone)) return byPhone;
  }
  if (email) {
    const byEmail = db
      .prepare(
        `SELECT * FROM leads
         WHERE email = ? COLLATE NOCASE AND ${NOT_LEAD_POOL_CANDIDATE_SQL}
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(email) as SyncLeadRow | undefined;
    if (byEmail && !isLeadPoolRow(byEmail)) return byEmail;
  }
  return null;
}

function applyLead(payload: LegacyCrmSyncPayload): { id: string; legacyLeadId: string; created: boolean; applied: boolean } {
  const lead = payload.lead || {};
  const legacyLeadId = asString(lead.id);
  if (!legacyLeadId) throw new Error("sync payload missing lead.id");

  const phone = asString(lead.phone) ? toE164(String(lead.phone)) : null;
  const email = asString(lead.email);
  const existing = findTargetLead(legacyLeadId, phone, email);
  const now = Date.now();
  const id = existing?.id || legacyLeadId;
  const incomingUpdatedAt = asNumber(lead.updated_at, asNumber(payload.sentAt, now));
  const existingUpdatedAt = asNumber(existing?.updated_at, 0);
  const existingCustom = readCustom(existing);
  const existingIsLeadPool = isLeadPoolRow(existing);
  const incomingCustom = normalizeObject(lead.custom);
  const incomingTags = normalizeTags(lead.tags);
  const source = asString(lead.source) || "legacy-crm-sync";
  const incomingIsLeadPool = isLegacyLeadPoolCandidate(source, incomingTags, incomingCustom, lead.contact_only);
  const incomingPastClient = isLegacyPastClient(lead, incomingTags, incomingCustom);
  const incomingIsCurrent = !existing || incomingUpdatedAt >= existingUpdatedAt;
  const shouldPromotePastClient = Boolean(existing && incomingPastClient && boolInt(existing.past_client) === 0);
  if (existing && !incomingIsCurrent && !shouldPromotePastClient) {
    return { id, legacyLeadId, created: false, applied: false };
  }
  const shouldBePastClient = incomingPastClient;
  const shouldBeLeadPool = !shouldBePastClient && (existingIsLeadPool || incomingIsLeadPool);
  const custom: JsonObject = {
    ...existingCustom,
    ...incomingCustom,
    legacy_crm_id: legacyLeadId,
    legacy_crm_source: payload.source || "crm.smartr8.com",
    legacy_crm_synced_at: new Date(now).toISOString(),
    legacy_crm_sync_reason: payload.reason || null,
    legacy_crm_owner_user_id: asString(lead.owner_user_id),
  };
  if (shouldBeLeadPool) {
    custom.lead_pool = true;
    custom.lead_pool_synced_at = new Date(now).toISOString();
    custom.lead_pool_sync_reason = incomingIsLeadPool ? "legacy-open-lead" : "existing-lead-pool";
  }
  if (shouldBePastClient) {
    delete custom.lead_pool;
    delete custom.lead_pool_sync_reason;
    custom.legacy_past_client_synced_at = new Date(now).toISOString();
  }
  if (existing && !incomingIsCurrent && shouldPromotePastClient) {
    db.prepare(`UPDATE leads SET past_client = 1, contact_only = 0, custom = ? WHERE id = ?`).run(JSON.stringify(custom), id);
    return { id, legacyLeadId, created: false, applied: true };
  }
  const row = {
    id,
    created_at: asNumber(lead.created_at, now),
    updated_at: incomingUpdatedAt,
    first_name: asString(lead.first_name),
    last_name: asString(lead.last_name),
    email,
    phone,
    source,
    status: normalizeStatus(lead.status),
    pipeline_stage: normalizeStage(lead.pipeline_stage || lead.stage),
    owner: asString(lead.owner),
    score: asNumber(lead.score, 0),
    timezone: asString(lead.timezone),
    consent: boolInt(lead.consent),
    ghl_contact_id: asString(lead.ghl_contact_id),
    tags: JSON.stringify(incomingTags),
    custom: JSON.stringify(custom),
    last_activity_at: nullableNumber(lead.last_activity_at),
    category: asString(lead.category),
    category_reason: asString(lead.category_reason),
    campaign: asString(lead.campaign),
    sms_consent: boolInt(lead.sms_consent ?? lead.smsConsent),
    email_unsubscribed: boolInt(lead.email_unsubscribed ?? lead.emailUnsubscribed),
    consent_at: nullableNumber(lead.consent_at ?? lead.consentAt),
    deleted_at: nullableNumber(lead.deleted_at ?? lead.deletedAt),
    past_client: shouldBePastClient ? 1 : 0,
    contact_only: shouldBePastClient ? 0 : shouldBeLeadPool ? 1 : boolInt(lead.contact_only ?? lead.contactOnly),
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
  return { id, legacyLeadId, created: !existing, applied: true };
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
  const eventId = asString(payload.eventId);
  if (eventId && db.prepare(`SELECT 1 FROM crm_sync_events WHERE event_id = ?`).get(eventId)) {
    return {
      leadId: asString(payload.lead?.id) || "unknown",
      legacyLeadId: asString(payload.lead?.id) || "unknown",
      created: false,
      leadApplied: false,
      duplicate: true,
      notesUpserted: 0,
      activitiesUpserted: 0,
    };
  }
  const run = db.transaction(() => {
    const leadResult = applyLead(payload);
    const notesUpserted = upsertNotes(leadResult.id, payload.notes);
    const activitiesUpserted = upsertActivities(leadResult.id, payload.activities);
    if (eventId) {
      db.prepare(
        `INSERT INTO crm_sync_events (event_id, source, lead_id, direction, status, detail, created_at)
         VALUES (?, ?, ?, 'inbound', 'applied', ?, ?)`,
      ).run(eventId, payload.source || "crm.smartr8.com", leadResult.id, payload.reason || null, Date.now());
    }
    return {
      leadId: leadResult.id,
      legacyLeadId: leadResult.legacyLeadId,
      created: leadResult.created,
      leadApplied: leadResult.applied,
      duplicate: false,
      notesUpserted,
      activitiesUpserted,
    };
  });
  return run();
}
