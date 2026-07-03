import { randomUUID } from "crypto";
import { db } from "../store/db";
import { toE164 } from "../util/phone";
import { cityTz, stateTz, tzForPhone } from "../util/areaCodeTz";
import { DEFAULT_STAGE, isPipelineStage } from "../pipeline";

export type LeadStatus = "new" | "contacted" | "qualified" | "nurturing" | "won" | "lost";

export interface Lead {
  id: string;
  created_at: number;
  updated_at: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  source: string | null;
  status: LeadStatus;
  pipeline_stage: string;
  owner: string | null;
  score: number;
  timezone: string | null;
  consent: number;
  ghl_contact_id: string | null;
  tags: string[];
  custom: Record<string, unknown>;
  last_activity_at: number | null;
  category: string | null;
  category_reason: string | null;
  campaign: string | null;
  sms_consent: number;
  email_unsubscribed: number;
  consent_at: number | null;
  deleted_at: number | null;
  past_client: number;
  contact_only: number;
  owner_user_id: string | null;
  todos: Todo[];
}

/** A single per-lead to-do item (checklist entry). */
export interface Todo {
  id: string;
  text: string;
  done: boolean;
  created_at: number;
  deleted_at?: number | null;
}

/** A to-do item joined with its owning lead (for the workspace-wide To-Do list). */
export interface TodoWithLead extends Todo {
  lead_id: string;
  lead_name: string;
  lead_phone: string | null;
}

export interface Note {
  id: string;
  lead_id: string;
  created_at: number;
  author: string | null;
  body: string;
}

export interface Activity {
  id: string;
  lead_id: string;
  created_at: number;
  type: string;
  direction: string | null;
  channel: string | null;
  subject: string | null;
  body: string | null;
  status: string | null;
  meta: Record<string, unknown> | null;
  deleted_at?: number | null;
}

interface LeadRow {
  id: string;
  created_at: number;
  updated_at: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  source: string | null;
  status: string;
  pipeline_stage: string;
  owner: string | null;
  score: number;
  timezone: string | null;
  consent: number;
  ghl_contact_id: string | null;
  tags: string;
  custom: string;
  last_activity_at: number | null;
  category: string | null;
  category_reason: string | null;
  campaign: string | null;
  sms_consent: number;
  email_unsubscribed: number;
  consent_at: number | null;
  deleted_at: number | null;
  past_client: number;
  contact_only: number;
  owner_user_id: string | null;
  todos: string;
}

function rowToLead(r: LeadRow): Lead {
  return {
    ...r,
    status: r.status as LeadStatus,
    tags: safeParse<string[]>(r.tags, []),
    custom: safeParse<Record<string, unknown>>(r.custom, {}),
    todos: safeParse<Todo[]>(r.todos, []),
  };
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export interface LeadInput {
  first_name?: string;
  last_name?: string;
  name?: string; // convenience: split into first/last if first/last not given
  email?: string;
  phone?: string;
  source?: string;
  status?: LeadStatus;
  pipeline_stage?: string;
  owner?: string;
  score?: number;
  timezone?: string;
  consent?: boolean;
  tags?: string[];
  custom?: Record<string, unknown>;
  category?: string;
  category_reason?: string;
  campaign?: string;
  sms_consent?: boolean;
  consent_at?: number;
  contact_only?: boolean;
}

function splitName(name?: string): { first?: string; last?: string } {
  if (!name) return {};
  const parts = name.trim().split(/\s+/);
  return { first: parts.shift(), last: parts.length ? parts.join(" ") : undefined };
}

/** Create a lead. Phone is normalized to E.164. Returns the stored lead. */
export function createLead(input: LeadInput): Lead {
  const now = Date.now();
  const id = randomUUID();
  const split = splitName(input.name);
  const first = input.first_name ?? split.first ?? null;
  const last = input.last_name ?? split.last ?? null;
  const phone = input.phone ? toE164(input.phone) : null;
  db.prepare(
    `INSERT INTO leads (id, created_at, updated_at, first_name, last_name, email, phone, source,
       status, pipeline_stage, owner, score, timezone, consent, tags, custom, last_activity_at,
       category, category_reason, campaign, sms_consent, email_unsubscribed, consent_at, contact_only)
     VALUES (@id, @created_at, @updated_at, @first_name, @last_name, @email, @phone, @source,
       @status, @pipeline_stage, @owner, @score, @timezone, @consent, @tags, @custom, @last_activity_at,
       @category, @category_reason, @campaign, @sms_consent, 0, @consent_at, @contact_only)`,
  ).run({
    id,
    created_at: now,
    updated_at: now,
    first_name: first,
    last_name: last,
    email: input.email ?? null,
    phone,
    source: input.source ?? null,
    status: input.status ?? "new",
    pipeline_stage: input.pipeline_stage ?? DEFAULT_STAGE, // every lead starts in the pipeline at "Lead-In"
    owner: input.owner ?? null,
    score: input.score ?? 0,
    timezone: input.timezone ?? null,
    consent: input.consent ? 1 : 0,
    tags: JSON.stringify(input.tags ?? []),
    custom: JSON.stringify(input.custom ?? {}),
    last_activity_at: now,
    category: input.category ?? null,
    category_reason: input.category_reason ?? null,
    campaign: input.campaign ?? null,
    // Texting is on by default; suppression is the per-number DNC list, not this flag.
    // sms_consent remains the *record* of an explicit opt-in (form / verbal / signed),
    // so consent_at is only stamped when consent was actually given.
    sms_consent: input.sms_consent === false ? 0 : 1,
    consent_at: input.consent_at ?? (input.consent || input.sms_consent === true ? now : null),
    contact_only: input.contact_only ? 1 : 0,
  });
  const lead = getLead(id)!;
  logActivity(id, {
    type: "lead_created",
    direction: "system",
    channel: "system",
    body: `Lead created${input.source ? ` from ${input.source}` : ""}`,
  });
  return lead;
}

/** Bulk-import contacts as CONTACT-ONLY records (one-time GHL import). Dedups by phone/email
 *  against existing leads; skips dupes. Single transaction; no per-row activity (keeps a 6k
 *  import fast and avoids flooding the timeline). */
export function bulkCreateContacts(
  contacts: Array<{ name?: string; phone?: string; email?: string; tags?: string[] }>,
): { imported: number; skipped: number } {
  let imported = 0;
  let skipped = 0;
  const insert = db.prepare(
    `INSERT INTO leads (id, created_at, updated_at, first_name, last_name, email, phone, source,
       status, pipeline_stage, owner, score, timezone, consent, tags, custom, last_activity_at,
       category, category_reason, campaign, sms_consent, email_unsubscribed, consent_at, contact_only)
     VALUES (@id, @created_at, @created_at, @first_name, @last_name, @email, @phone, 'ghl-import',
       'new', @pipeline_stage, NULL, 0, NULL, 0, @tags, '{}', @created_at,
       NULL, NULL, NULL, 1, 0, NULL, 1)`,
  );
  const byPhone = db.prepare(`SELECT 1 FROM leads WHERE phone = ? LIMIT 1`);
  const byEmail = db.prepare(`SELECT 1 FROM leads WHERE email = ? COLLATE NOCASE LIMIT 1`);
  const run = db.transaction((rows: typeof contacts) => {
    for (const c of rows) {
      const phone = c.phone ? toE164(c.phone) : null;
      const email = c.email || null;
      const exists = (phone && byPhone.get(phone)) || (email && byEmail.get(email));
      if (exists) { skipped++; continue; }
      const split = splitName(c.name);
      insert.run({
        id: randomUUID(),
        created_at: Date.now(),
        first_name: split.first ?? null,
        last_name: split.last ?? null,
        email,
        phone,
        pipeline_stage: DEFAULT_STAGE,
        tags: JSON.stringify(c.tags ?? []),
      });
      imported++;
    }
  });
  run(contacts);
  return { imported, skipped };
}

export function getLead(id: string): Lead | null {
  const row = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(id) as LeadRow | undefined;
  return row ? rowToLead(row) : null;
}

/**
 * Hard-delete a lead. Its notes + activities cascade (FK ON DELETE CASCADE, with
 * foreign_keys=ON); any pending automation steps are cancelled so the worker won't run
 * them against a missing lead. Returns true if a row was actually removed.
 */
/** Soft-delete: hide the lead from normal lists (Restore brings it back). Cancels pending jobs. */
export function deleteLead(id: string): boolean {
  const now = Date.now();
  db.prepare(
    `UPDATE automation_jobs SET status = 'skipped', last_error = 'lead deleted', updated_at = ? WHERE lead_id = ? AND status = 'pending'`,
  ).run(now, id);
  const r = db
    .prepare(`UPDATE leads SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
    .run(now, now, id);
  return (r.changes ?? 0) > 0;
}

/** Restore a soft-deleted lead back into the active list. */
export function restoreLead(id: string): boolean {
  const r = db.prepare(`UPDATE leads SET deleted_at = NULL, updated_at = ? WHERE id = ?`).run(Date.now(), id);
  return (r.changes ?? 0) > 0;
}

/** Find an existing lead by phone (E.164) or email, for dedup on intake. */
export function findLead(opts: { phone?: string; email?: string }): Lead | null {
  if (opts.phone) {
    const e164 = toE164(opts.phone);
    const row = db.prepare(`SELECT * FROM leads WHERE phone = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`).get(e164) as
      | LeadRow
      | undefined;
    if (row) return rowToLead(row);
  }
  if (opts.email) {
    const row = db
      .prepare(`SELECT * FROM leads WHERE email = ? COLLATE NOCASE AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`)
      .get(opts.email) as LeadRow | undefined;
    if (row) return rowToLead(row);
  }
  return null;
}

export interface ListLeadsOpts {
  q?: string;
  status?: string;
  stage?: string;
  limit?: number;
  offset?: number;
  deleted?: boolean;
  pastClient?: boolean;
  /** Include contact-only records (the Contacts tab). Default false = active Leads only. */
  includeContactOnly?: boolean;
  /** Restrict to leads owned by this user id (non-admins). Omit/undefined = no owner filter. */
  ownerUserId?: string;
}

export function listLeads(opts: ListLeadsOpts = {}): Lead[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  // Normal lists hide soft-deleted leads; the Deleted view asks for them explicitly.
  where.push(opts.deleted ? `deleted_at IS NOT NULL` : `deleted_at IS NULL`);
  // Past clients live ONLY under the Past Clients view — the active pipeline excludes them
  // so an imported/funded past client doesn't also clutter the regular Leads list.
  if (opts.pastClient) where.push(`past_client = 1`);
  else if (!opts.deleted) where.push(`past_client = 0`);
  // Contact-only records live in the Contacts tab, not the active Leads pipeline.
  if (!opts.includeContactOnly) where.push(`contact_only = 0`);
  // Non-admins see only the leads assigned to them.
  if (opts.ownerUserId) {
    where.push(`owner_user_id = @ownerUserId`);
    params.ownerUserId = opts.ownerUserId;
  }
  if (opts.status) {
    where.push(`status = @status`);
    params.status = opts.status;
  }
  if (opts.stage) {
    where.push(`pipeline_stage = @stage`);
    params.stage = opts.stage;
  }
  if (opts.q) {
    where.push(
      `(first_name LIKE @q OR last_name LIKE @q OR email LIKE @q OR phone LIKE @q OR source LIKE @q OR custom LIKE @q)`,
    );
    params.q = `%${opts.q}%`;
  }
  // Cap generously: the Contacts tab loads the full local book (thousands of records)
  // now that GHL is disconnected and SQLite is the only source.
  params.limit = Math.min(opts.limit ?? 100, 20000);
  params.offset = opts.offset ?? 0;
  const sql =
    `SELECT * FROM leads ${where.length ? "WHERE " + where.join(" AND ") : ""} ` +
    `ORDER BY COALESCE(last_activity_at, created_at) DESC LIMIT @limit OFFSET @offset`;
  return (db.prepare(sql).all(params) as LeadRow[]).map(rowToLead);
}

const UPDATABLE = [
  "first_name",
  "last_name",
  "email",
  "phone",
  "source",
  "status",
  "pipeline_stage",
  "owner",
  "score",
  "timezone",
  "ghl_contact_id",
  "category",
  "category_reason",
  "campaign",
  "owner_user_id",
] as const;

/** Patch a lead. Only known scalar columns + tags/custom/consent flags are applied. */
export function updateLead(
  id: string,
  patch: Partial<Record<(typeof UPDATABLE)[number], unknown>> & {
    tags?: string[];
    custom?: Record<string, unknown>;
    consent?: boolean;
    sms_consent?: boolean;
    email_unsubscribed?: boolean;
    past_client?: boolean;
    contact_only?: boolean;
  },
): Lead | null {
  const existing = getLead(id);
  if (!existing) return null;
  // Keep the coarse Status and the pipeline Stage in agreement on terminal outcomes, so
  // marking a lead Lost/Won in one control updates the other (Funded is the mortgage win).
  if (patch.status === "lost" && patch.pipeline_stage === undefined) patch.pipeline_stage = "Lost";
  else if (patch.status === "won" && patch.pipeline_stage === undefined) patch.pipeline_stage = "Funded";
  if (patch.pipeline_stage === "Lost" && patch.status === undefined) patch.status = "lost";
  else if (patch.pipeline_stage === "Funded" && patch.status === undefined) patch.status = "won";
  const sets: string[] = [];
  const params: Record<string, unknown> = { id, updated_at: Date.now() };
  for (const col of UPDATABLE) {
    if (patch[col] !== undefined) {
      let val = patch[col];
      if (col === "phone" && typeof val === "string") val = toE164(val);
      sets.push(`${col} = @${col}`);
      params[col] = val;
    }
  }
  if (patch.tags !== undefined) {
    sets.push(`tags = @tags`);
    params.tags = JSON.stringify(patch.tags);
  }
  if (patch.custom !== undefined) {
    sets.push(`custom = @custom`);
    params.custom = JSON.stringify(patch.custom);
  }
  if (patch.consent !== undefined) {
    sets.push(`consent = @consent`);
    params.consent = patch.consent ? 1 : 0;
  }
  if (patch.sms_consent !== undefined) {
    sets.push(`sms_consent = @sms_consent`);
    params.sms_consent = patch.sms_consent ? 1 : 0;
  }
  if (patch.email_unsubscribed !== undefined) {
    sets.push(`email_unsubscribed = @email_unsubscribed`);
    params.email_unsubscribed = patch.email_unsubscribed ? 1 : 0;
  }
  if (patch.past_client !== undefined) {
    sets.push(`past_client = @past_client`);
    params.past_client = patch.past_client ? 1 : 0;
  }
  if (patch.contact_only !== undefined) {
    sets.push(`contact_only = @contact_only`);
    params.contact_only = patch.contact_only ? 1 : 0;
  }
  if (sets.length) {
    db.prepare(`UPDATE leads SET ${sets.join(", ")}, updated_at = @updated_at WHERE id = @id`).run(params);
  }
  // Record status / pipeline-stage changes on the timeline so history is auditable.
  if (typeof patch.status === "string" && patch.status !== existing.status) {
    logActivity(id, {
      type: "status_change",
      direction: "system",
      channel: "system",
      body: `Status: ${existing.status} → ${patch.status}`,
    });
  }
  if (typeof patch.pipeline_stage === "string" && patch.pipeline_stage !== existing.pipeline_stage) {
    logActivity(id, {
      type: "stage_change",
      direction: "system",
      channel: "system",
      body: `Stage: ${existing.pipeline_stage} → ${patch.pipeline_stage}`,
    });
  }
  return getLead(id);
}

/**
 * Manually record (or withdraw) SMS consent for a lead, with an audit entry on the
 * timeline. Used by the console when the loan officer obtained express consent through
 * another channel (a signed form, or verbally on a call). Granting stamps `consent_at`;
 * withdrawing keeps the prior timestamp for the record. The `note` (how consent was
 * obtained) and `author` are logged so there's a TCPA paper trail.
 */
export function setSmsConsent(
  id: string,
  on: boolean,
  opts: { note?: string; author?: string } = {},
): Lead | null {
  const existing = getLead(id);
  if (!existing) return null;
  const now = Date.now();
  db.prepare(`UPDATE leads SET sms_consent = ?, consent_at = ?, updated_at = ? WHERE id = ?`).run(
    on ? 1 : 0,
    on ? now : existing.consent_at,
    now,
    id,
  );
  logActivity(id, {
    type: "consent",
    direction: "system",
    channel: "sms",
    body: on
      ? `SMS consent recorded${opts.note ? `: ${opts.note}` : ""}`
      : `SMS consent withdrawn${opts.note ? `: ${opts.note}` : ""}`,
    status: on ? "opted-in" : "opted-out",
    meta: { author: opts.author ?? null, source: "manual" },
  });
  return getLead(id);
}

/** Append a tag to a lead (no duplicates). */
export function addLeadTag(id: string, tag: string): Lead | null {
  const lead = getLead(id);
  if (!lead) return null;
  if (!lead.tags.includes(tag)) {
    const tags = [...lead.tags, tag];
    db.prepare(`UPDATE leads SET tags = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(tags), Date.now(), id);
    logActivity(id, { type: "tag", direction: "system", channel: "system", body: `Tagged: ${tag}` });
  }
  return getLead(id);
}

// ── To-do checklist (per lead) ─────────────────────────────────────────────────

/** Read a lead's to-do items (newest last). */
export function listTodos(leadId: string): Todo[] {
  const lead = getLead(leadId);
  return lead ? lead.todos.filter((t) => !t.deleted_at) : [];
}

/** All to-do items across every (non-deleted) lead, joined with the lead, newest first.
 *  Excludes completed items unless includeDone is set. Powers the workspace-wide To-Do list. */
export function listAllTodos(opts: { includeDone?: boolean; ownerUserId?: string } = {}): TodoWithLead[] {
  const rows = db
    .prepare(
      `SELECT id, first_name, last_name, email, phone, todos FROM leads
        WHERE deleted_at IS NULL AND todos IS NOT NULL AND todos != '[]'
        ${opts.ownerUserId ? "AND owner_user_id = @owner" : ""}`,
    )
    .all(opts.ownerUserId ? { owner: opts.ownerUserId } : {}) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null; todos: string }>;
  const out: TodoWithLead[] = [];
  for (const r of rows) {
    const name = [r.first_name, r.last_name].filter(Boolean).join(" ") || r.email || r.phone || "(no name)";
    for (const t of safeParse<Todo[]>(r.todos, [])) {
      if (t.deleted_at) continue;
      if (!opts.includeDone && t.done) continue;
      out.push({ ...t, lead_id: r.id, lead_name: name, lead_phone: r.phone });
    }
  }
  return out.sort((a, b) => b.created_at - a.created_at);
}

function saveTodos(leadId: string, todos: Todo[]): Todo[] {
  db.prepare(`UPDATE leads SET todos = ?, updated_at = ? WHERE id = ?`).run(
    JSON.stringify(todos),
    Date.now(),
    leadId,
  );
  return todos.filter((t) => !t.deleted_at);
}

/** Append a to-do item. Returns the updated list (or null if the lead is gone). */
export function addTodo(leadId: string, text: string): Todo[] | null {
  const lead = getLead(leadId);
  if (!lead) return null;
  const item: Todo = { id: randomUUID(), text: text.trim(), done: false, created_at: Date.now() };
  return saveTodos(leadId, [...lead.todos, item]);
}

/** Toggle (or set) a to-do item's done state. Returns the updated list (or null). */
export function setTodoDone(leadId: string, todoId: string, done: boolean): Todo[] | null {
  const lead = getLead(leadId);
  if (!lead) return null;
  return saveTodos(leadId, lead.todos.map((t) => (t.id === todoId && !t.deleted_at ? { ...t, done } : t)));
}

/** Soft-delete a to-do item. Returns the active updated list (or null if the lead is gone). */
export function deleteTodo(leadId: string, todoId: string): Todo[] | null {
  const lead = getLead(leadId);
  if (!lead) return null;
  const now = Date.now();
  return saveTodos(leadId, lead.todos.map((t) => (t.id === todoId ? { ...t, deleted_at: t.deleted_at ?? now } : t)));
}

export function restoreTodo(leadId: string, todoId: string): Todo[] | null {
  const lead = getLead(leadId);
  if (!lead) return null;
  return saveTodos(leadId, lead.todos.map((t) => (t.id === todoId ? { ...t, deleted_at: null } : t)));
}

export function listDeletedTodos(opts: { ownerUserId?: string } = {}): TodoWithLead[] {
  const rows = db
    .prepare(
      `SELECT id, first_name, last_name, email, phone, todos FROM leads
        WHERE todos IS NOT NULL AND todos != '[]'
        ${opts.ownerUserId ? "AND owner_user_id = @owner" : ""}`,
    )
    .all(opts.ownerUserId ? { owner: opts.ownerUserId } : {}) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null; todos: string }>;
  const out: TodoWithLead[] = [];
  for (const r of rows) {
    const name = [r.first_name, r.last_name].filter(Boolean).join(" ") || r.email || r.phone || "(no name)";
    for (const t of safeParse<Todo[]>(r.todos, [])) {
      if (!t.deleted_at) continue;
      out.push({ ...t, lead_id: r.id, lead_name: name, lead_phone: r.phone });
    }
  }
  return out.sort((a, b) => (b.deleted_at ?? 0) - (a.deleted_at ?? 0));
}

// ── Notes ─────────────────────────────────────────────────────────────────────

export function addNote(leadId: string, body: string, author?: string): Note {
  const note: Note = { id: randomUUID(), lead_id: leadId, created_at: Date.now(), author: author ?? null, body };
  db.prepare(
    `INSERT INTO notes (id, lead_id, created_at, author, body) VALUES (@id, @lead_id, @created_at, @author, @body)`,
  ).run(note);
  touchLead(leadId);
  logActivity(leadId, { type: "note", direction: "system", channel: "system", body, meta: { author } });
  return note;
}

export function listNotes(leadId: string): Note[] {
  return db.prepare(`SELECT * FROM notes WHERE lead_id = ? ORDER BY created_at DESC`).all(leadId) as Note[];
}

// ── Activities (timeline) ──────────────────────────────────────────────────────

export interface ActivityInput {
  type: string;
  direction?: string;
  channel?: string;
  subject?: string;
  body?: string;
  status?: string;
  meta?: Record<string, unknown>;
}

export function logActivity(leadId: string, a: ActivityInput): Activity {
  if ((a.type === "sms" || a.type === "imessage") && a.direction === "outbound" && a.body) {
    const existing = recentDuplicateTextActivity(leadId, a);
    if (existing) return existing;
  }
  const row = {
    id: randomUUID(),
    lead_id: leadId,
    created_at: Date.now(),
    type: a.type,
    direction: a.direction ?? null,
    channel: a.channel ?? null,
    subject: a.subject ?? null,
    body: a.body ?? null,
    status: a.status ?? null,
    meta: a.meta ? JSON.stringify(a.meta) : null,
  };
  db.prepare(
    `INSERT INTO activities (id, lead_id, created_at, type, direction, channel, subject, body, status, meta)
     VALUES (@id, @lead_id, @created_at, @type, @direction, @channel, @subject, @body, @status, @meta)`,
  ).run(row);
  touchLead(leadId);
  return { ...row, meta: a.meta ?? null };
}

function normalizedActivityBody(body: string | null | undefined): string {
  return String(body ?? "").replace(/\s+/g, " ").trim();
}

function recentDuplicateTextActivity(leadId: string, a: ActivityInput, windowMs = 48 * 60 * 60_000): Activity | null {
  const body = normalizedActivityBody(a.body);
  if (!body) return null;
  const since = Date.now() - windowMs;
  const row = db
    .prepare(
      `SELECT * FROM activities
       WHERE lead_id = ?
         AND type = ?
         AND direction = 'outbound'
         AND COALESCE(channel, '') = COALESCE(?, '')
         AND TRIM(REPLACE(REPLACE(REPLACE(body, char(13), ' '), char(10), ' '), char(9), ' ')) = ?
         AND created_at >= ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(leadId, a.type, a.channel ?? null, body, since) as (Omit<Activity, "meta"> & { meta: string | null }) | undefined;
  return row ? { ...row, meta: row.meta ? safeParse<Record<string, unknown>>(row.meta, {}) : null } : null;
}

/** Log an activity unless the same lead already has an identical recent row. */
export function logActivityOnce(leadId: string, a: ActivityInput, windowMs = 5 * 60_000): Activity | null {
  if ((a.type === "sms" || a.type === "imessage") && a.direction === "outbound" && a.body) {
    const existing = recentDuplicateTextActivity(leadId, a, Math.max(windowMs, 48 * 60 * 60_000));
    if (existing) return null;
  }
  const since = Date.now() - windowMs;
  const existing = db
    .prepare(
      `SELECT id FROM activities
       WHERE lead_id = ?
         AND type = ?
         AND COALESCE(direction, '') = COALESCE(?, '')
         AND COALESCE(channel, '') = COALESCE(?, '')
         AND COALESCE(body, '') = COALESCE(?, '')
         AND created_at >= ?
       LIMIT 1`,
    )
    .get(leadId, a.type, a.direction ?? null, a.channel ?? null, a.body ?? null, since);
  if (existing) return null;
  return logActivity(leadId, a);
}

export function listActivities(leadId: string, limit = 100): Activity[] {
  const rows = db
    .prepare(`SELECT * FROM activities WHERE lead_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`)
    .all(leadId, limit) as Array<Omit<Activity, "meta"> & { meta: string | null }>;
  const seen = new Set<string>();
  const out: Activity[] = [];
  for (const r of rows) {
    const isText = (r.type === "sms" || r.type === "imessage") && r.direction === "outbound";
    const key = isText ? [r.lead_id, r.type, r.direction ?? "", r.channel ?? "", normalizedActivityBody(r.body)].join("|") : "";
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push({ ...r, meta: r.meta ? safeParse<Record<string, unknown>>(r.meta, {}) : null });
  }
  return out;
}

/** Delete a single timeline activity from a lead. Returns true if a row was removed. */
export function deleteActivity(leadId: string, activityId: string): boolean {
  const r = db.prepare(`UPDATE activities SET deleted_at = ? WHERE id = ? AND lead_id = ? AND deleted_at IS NULL`).run(Date.now(), activityId, leadId);
  return (r.changes ?? 0) > 0;
}

export function restoreActivity(leadId: string, activityId: string): boolean {
  const r = db.prepare(`UPDATE activities SET deleted_at = NULL WHERE id = ? AND lead_id = ?`).run(activityId, leadId);
  return (r.changes ?? 0) > 0;
}

export function listDeletedActivities(opts: { ownerUserId?: string; limit?: number } = {}): Activity[] {
  const rows = db
    .prepare(
      `SELECT a.*, COALESCE(NULLIF(TRIM(l.first_name || ' ' || l.last_name), ''), l.email, l.phone, '(no name)') lead_name, l.phone lead_phone FROM activities a
        JOIN leads l ON l.id = a.lead_id
       WHERE a.deleted_at IS NOT NULL ${opts.ownerUserId ? "AND l.owner_user_id = @owner" : ""}
       ORDER BY a.deleted_at DESC LIMIT @limit`,
    )
    .all({ owner: opts.ownerUserId ?? "", limit: Math.min(opts.limit ?? 200, 1000) }) as Array<Omit<Activity, "meta"> & { meta: string | null }>;
  return rows.map((r) => ({ ...r, meta: r.meta ? safeParse<Record<string, unknown>>(r.meta, {}) : null }));
}

export function getActivity(leadId: string, activityId: string): Activity | null {
  const row = db
    .prepare(`SELECT * FROM activities WHERE id = ? AND lead_id = ? LIMIT 1`)
    .get(activityId, leadId) as (Omit<Activity, "meta"> & { meta: string | null }) | undefined;
  return row ? { ...row, meta: row.meta ? safeParse<Record<string, unknown>>(row.meta, {}) : null } : null;
}

function touchLead(leadId: string): void {
  db.prepare(`UPDATE leads SET last_activity_at = ? WHERE id = ?`).run(Date.now(), leadId);
}

// ── Local message threads (replaces GHL conversations for the Messages tab) ──────
// The Messages tab now reads the local `activities` table (text channels only) instead
// of GHL. GHL is disconnected; SQLite is the sole system of record.

/** A conversation summary for the Messages inbox, sourced from local activities. */
export interface MessageThread {
  id: string; // lead id (no separate conversation entity locally)
  contactId: string; // lead id — the Messages tab keys threads by this
  name: string;
  phone: string | null;
  email: string | null;
  lastMessage: string;
  lastMessageDate: string | null; // ISO string for the UI
  unread?: number;
}

/** A single message normalized for the Messages thread view. */
export interface ThreadMessage {
  direction: "inbound" | "outbound";
  body: string;
  date: string | null; // ISO string
  channel: "imessage" | "sms"; // the lane this message went/came on
  status: "sent" | "failed" | "received"; // normalized delivery status for the UI indicator
}

/**
 * Recent text conversations across all leads, newest activity first. Each lead with at
 * least one sms/imessage activity becomes one thread, carrying its most recent text.
 */
export function listMessageThreads(limit = 50, ownerUserId?: string): MessageThread[] {
  const rows = db
    .prepare(
      `SELECT l.id, l.first_name, l.last_name, l.phone, l.email,
              a.body AS last_body, a.created_at AS last_at
         FROM leads l
         JOIN activities a ON a.id = (
           SELECT a2.id FROM activities a2
           WHERE a2.lead_id = l.id AND a2.type IN ('sms','imessage')
             AND a2.body IS NOT NULL AND a2.body <> ''
             ORDER BY a2.created_at DESC LIMIT 1
         )
        WHERE l.deleted_at IS NULL ${ownerUserId ? "AND l.owner_user_id = ?" : ""}
        ORDER BY a.created_at DESC
        LIMIT ?`,
    )
    .all(...(ownerUserId ? [ownerUserId, limit] : [limit])) as Array<{
    id: string;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    email: string | null;
    last_body: string | null;
    last_at: number | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    contactId: r.id,
    name: [r.first_name, r.last_name].filter(Boolean).join(" ") || r.phone || r.email || "(no name)",
    phone: r.phone,
    email: r.email,
    lastMessage: r.last_body ?? "",
    lastMessageDate: r.last_at ? new Date(r.last_at).toISOString() : null,
  }));
}

/** A lead's text messages (sms/imessage) for the thread view, oldest first. */
export function getLeadMessages(leadId: string, limit = 100): ThreadMessage[] {
  const rows = db
    .prepare(
      `SELECT direction, body, created_at, type, status FROM activities
        WHERE lead_id = ? AND deleted_at IS NULL AND type IN ('sms','imessage') AND body IS NOT NULL AND body <> ''
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(leadId, limit) as Array<{
    direction: string | null;
    body: string | null;
    created_at: number;
    type: string;
    status: string | null;
  }>;
  const seen = new Set<string>();
  return rows
    .filter((r) => {
      if (r.direction !== "outbound") return true;
      const key = [r.type, r.direction ?? "", normalizedActivityBody(r.body)].join("|");
      if (!normalizedActivityBody(r.body) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((r) => {
      const direction = (r.direction === "inbound" ? "inbound" : "outbound") as "inbound" | "outbound";
      // The send handlers store status variably ("sent", a SendPath like "fellback-to-sms",
      // or "failed:sms-failed"); treat anything mentioning fail/suppress as a failed send.
      const failed = /fail|suppress/i.test(r.status || "");
      const status: "sent" | "failed" | "received" = direction === "inbound" ? "received" : failed ? "failed" : "sent";
      return {
        direction,
        body: r.body ?? "",
        date: r.created_at ? new Date(r.created_at).toISOString() : null,
        channel: (r.type === "imessage" ? "imessage" : "sms") as "imessage" | "sms",
        status,
      };
    })
    .reverse(); // oldest first for a chat view
}

/** Diagnostic snapshot of the contact/lead table — why counts look off + where dupes are. */
export function contactsDiag(): Record<string, unknown> {
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  const totals = {
    rows_total: one(`SELECT COUNT(*) n FROM leads`),
    active_shown_in_contacts: one(`SELECT COUNT(*) n FROM leads WHERE deleted_at IS NULL AND past_client = 0`),
    deleted: one(`SELECT COUNT(*) n FROM leads WHERE deleted_at IS NOT NULL`),
    past_client: one(`SELECT COUNT(*) n FROM leads WHERE past_client = 1`),
    contact_only: one(`SELECT COUNT(*) n FROM leads WHERE contact_only = 1`),
    phone_null_or_empty: one(`SELECT COUNT(*) n FROM leads WHERE phone IS NULL OR phone = ''`),
    // A normalized phone with fewer than 10 digits is junk (e.g. "+1" from a blank/garbage source).
    phone_too_short: one(`SELECT COUNT(*) n FROM leads WHERE phone IS NOT NULL AND phone <> '' AND LENGTH(REPLACE(phone,'+','')) < 10`),
    email_null_or_empty: one(`SELECT COUNT(*) n FROM leads WHERE email IS NULL OR email = ''`),
  };
  const bySource = db
    .prepare(`SELECT COALESCE(source,'(none)') source, COUNT(*) n FROM leads GROUP BY source ORDER BY n DESC LIMIT 20`)
    .all() as Array<{ source: string; n: number }>;
  const dupPhones = db
    .prepare(
      `SELECT phone, COUNT(*) n FROM leads WHERE phone IS NOT NULL AND phone <> ''
       GROUP BY phone HAVING n > 1 ORDER BY n DESC LIMIT 25`,
    )
    .all() as Array<{ phone: string; n: number }>;
  const dupNames = db
    .prepare(
      `SELECT TRIM(COALESCE(first_name,'')||' '||COALESCE(last_name,'')) name, COUNT(*) n FROM leads
       WHERE (first_name IS NOT NULL OR last_name IS NOT NULL)
       GROUP BY LOWER(COALESCE(first_name,'')), LOWER(COALESCE(last_name,'')) HAVING n > 1 ORDER BY n DESC LIMIT 25`,
    )
    .all() as Array<{ name: string; n: number }>;
  const dupEmails = db
    .prepare(
      `SELECT email, COUNT(*) n FROM leads WHERE email IS NOT NULL AND email <> ''
       GROUP BY LOWER(email) HAVING n > 1 ORDER BY n DESC LIMIT 25`,
    )
    .all() as Array<{ email: string; n: number }>;
  const dupPhoneRows = dupPhones.reduce((a, r) => a + r.n, 0);
  const dupNameRows = dupNames.reduce((a, r) => a + r.n, 0);
  return {
    totals,
    duplicate_phone_groups: dupPhones.length,
    duplicate_phone_rows_in_top25: dupPhoneRows,
    top_duplicate_phones: dupPhones,
    duplicate_name_groups: dupNames.length,
    duplicate_name_rows_in_top25: dupNameRows,
    top_duplicate_names: dupNames,
    top_duplicate_emails: dupEmails,
    by_source: bySource,
  };
}

/** Read a custom field by any of several key spellings. */
function customStr(lead: Lead, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = lead.custom?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Resolve a lead's timezone for quiet-hours gating. Precedence (per requirement):
 * an explicit timezone, then the address city/state if present, then the phone area
 * code, then null (caller treats null as the most conservative window).
 */
export function resolveLeadTimezone(lead: Lead): string | null {
  if (lead.timezone) return lead.timezone;
  const city = customStr(lead, ["city", "City", "CITY"]);
  const state = customStr(lead, ["state", "State", "STATE", "region", "Region"]);
  return cityTz(city) || stateTz(state) || (lead.phone ? tzForPhone(lead.phone) : null);
}

/** Convenience: full display name for templates / logs. */
export function leadName(lead: Lead): string {
  return [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.email || lead.phone || "Lead";
}

/** A pipeline card: a lead plus the latest text body, for the board's snippet line. */
export interface PipelineLead extends Lead {
  last_message: string | null;
}

/**
 * Active leads for the kanban board, newest-activity first, each enriched with the body of
 * its most recent text (in/out) for the card snippet. Stage is normalized to the canonical
 * set; anything unexpected falls back to DEFAULT_STAGE so no card is orphaned.
 *
 * Keep this aligned with listLeads() and the dashboard Lead-In queue: past clients and
 * contact-only records are not part of the active sales pipeline.
 */
export function listPipeline(limit = 1000, ownerUserId?: string): PipelineLead[] {
  const params: { limit: number; owner?: string } = { limit };
  if (ownerUserId) params.owner = ownerUserId;
  const rows = db
    .prepare(
      `SELECT l.*, (
         SELECT a.body FROM activities a
         WHERE a.lead_id = l.id AND a.type IN ('sms','imessage') AND a.body IS NOT NULL AND a.body <> ''
         ORDER BY a.created_at DESC LIMIT 1
       ) AS last_message
       FROM leads l
       WHERE l.deleted_at IS NULL
         AND l.past_client = 0
         AND l.contact_only = 0
         ${ownerUserId ? "AND l.owner_user_id = @owner" : ""}
       ORDER BY COALESCE(l.last_activity_at, l.created_at) DESC
       LIMIT @limit`,
    )
    .all(params) as Array<LeadRow & { last_message: string | null }>;
  return rows.map((r) => ({
    ...rowToLead(r),
    pipeline_stage: isPipelineStage(r.pipeline_stage) ? r.pipeline_stage : DEFAULT_STAGE,
    last_message: r.last_message ?? null,
  }));
}

/** Lightweight stats for the console header. */
export function leadStats(ownerUserId?: string): Record<string, number> {
  // Active-pipeline counts exclude past clients (they have their own view), so the Leads
  // header total matches the list, which also hides past clients. Non-admins are scoped
  // to the leads they own.
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM leads
       WHERE deleted_at IS NULL AND past_client = 0 ${ownerUserId ? "AND owner_user_id = @owner" : ""}
       GROUP BY status`,
    )
    .all(ownerUserId ? { owner: ownerUserId } : {}) as Array<{
    status: string;
    n: number;
  }>;
  const out: Record<string, number> = { total: 0 };
  for (const r of rows) {
    out[r.status] = r.n;
    out.total += r.n;
  }
  return out;
}
