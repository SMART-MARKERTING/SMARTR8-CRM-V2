import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { config } from "../config";
import { log } from "../logger";

/**
 * The CRM's system of record: a single SQLite file on the persistent disk (same
 * disk that holds the GHL tokens + DNC list). Synchronous (better-sqlite3), which
 * is fine for this single-process, low-volume service and keeps the call sites simple.
 *
 * Tables: leads, notes, activities, automations, automation_runs, automation_jobs.
 */
const DB_PATH = path.resolve(process.cwd(), config.tokenDir, config.crm.dbFile);
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL"); // better concurrency + durability across restarts
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id              TEXT PRIMARY KEY,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    first_name      TEXT,
    last_name       TEXT,
    email           TEXT,
    phone           TEXT,                       -- E.164
    source          TEXT,                       -- "website", "manual", "import", …
    status          TEXT NOT NULL DEFAULT 'new',-- new|contacted|qualified|nurturing|won|lost
    stage           TEXT,
    owner           TEXT,
    score           INTEGER NOT NULL DEFAULT 0,
    timezone        TEXT,                        -- IANA tz (calling-hours gate for voicemail)
    consent         INTEGER NOT NULL DEFAULT 0,  -- 1 = gave contact consent (website opt-in)
    ghl_contact_id  TEXT,                        -- linked GHL contact, if mirrored
    tags            TEXT NOT NULL DEFAULT '[]',  -- JSON array
    custom          TEXT NOT NULL DEFAULT '{}',  -- JSON object (extra form fields)
    last_activity_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_leads_phone   ON leads(phone);
  CREATE INDEX IF NOT EXISTS idx_leads_email   ON leads(email);
  CREATE INDEX IF NOT EXISTS idx_leads_status  ON leads(status);
  CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);

  CREATE TABLE IF NOT EXISTS notes (
    id          TEXT PRIMARY KEY,
    lead_id     TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    author      TEXT,
    body        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_notes_lead ON notes(lead_id, created_at);

  CREATE TABLE IF NOT EXISTS activities (
    id          TEXT PRIMARY KEY,
    lead_id     TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    type        TEXT NOT NULL,   -- lead_created|note|sms|imessage|call|email|voicemail|status_change|automation|tag
    direction   TEXT,            -- inbound|outbound|system
    channel     TEXT,            -- sms|imessage|email|voice|system
    subject     TEXT,
    body        TEXT,
    status      TEXT,
    meta        TEXT             -- JSON
  );
  CREATE INDEX IF NOT EXISTS idx_activities_lead ON activities(lead_id, created_at);

  CREATE TABLE IF NOT EXISTS automations (
    id          TEXT PRIMARY KEY,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    name        TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    trigger     TEXT NOT NULL,   -- "lead_created" (only trigger for now)
    filter      TEXT NOT NULL DEFAULT '{}', -- JSON: optional { source: "website" }
    steps       TEXT NOT NULL DEFAULT '[]'  -- JSON array of step objects
  );

  CREATE TABLE IF NOT EXISTS automation_runs (
    id            TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL,
    lead_id       TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    status        TEXT NOT NULL DEFAULT 'running' -- running|done|stopped|error
  );
  CREATE INDEX IF NOT EXISTS idx_runs_lead ON automation_runs(lead_id);

  CREATE TABLE IF NOT EXISTS automation_jobs (
    id            TEXT PRIMARY KEY,
    run_id        TEXT NOT NULL,
    automation_id TEXT NOT NULL,
    lead_id       TEXT NOT NULL,
    step_index    INTEGER NOT NULL,
    step          TEXT NOT NULL,   -- JSON of the single step
    run_at        INTEGER NOT NULL,-- epoch ms when due
    status        TEXT NOT NULL DEFAULT 'pending', -- pending|done|error|skipped
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_due ON automation_jobs(status, run_at);

  -- Small key/value store for service-internal markers (e.g. one-time migrations that
  -- must run exactly once against the live disk, not on every boot).
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  -- Console-side hidden messages: a signature per GHL-sourced message that the operator
  -- chose to delete from the Smartr8 thread view. GHL remains the system of record (it has
  -- no reliable per-message delete API), so this only suppresses the message in the console.
  CREATE TABLE IF NOT EXISTS hidden_messages (
    contact_id TEXT NOT NULL,
    sig        TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (contact_id, sig)
  );

  -- Console-side hidden CONVERSATIONS: a contact whose whole thread the operator removed
  -- from the Messages inbox. Console-only — the lead's own activity timeline keeps every
  -- message exactly as-is; this just suppresses the conversation in the Messages tab.
  CREATE TABLE IF NOT EXISTS hidden_conversations (
    contact_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );

  -- Inbound/outbound call log (the Dialer's "Call log" / missed-calls panel). Every inbound
  -- call is recorded here with its outcome (missed | answered | forwarded). Operator can
  -- delete individual entries or clear them.
  CREATE TABLE IF NOT EXISTS call_log (
    id           TEXT PRIMARY KEY,
    created_at   INTEGER NOT NULL,
    direction    TEXT NOT NULL,
    phone        TEXT,
    name         TEXT,
    contact_id   TEXT,
    lead_id      TEXT,
    outcome      TEXT,
    duration_sec INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_call_log_created ON call_log(created_at);

  -- GHL contacts the operator removed from the Contacts list. Keyed by the last 10 phone
  -- digits so a hidden contact stays hidden across reloads (GHL re-serves them otherwise).
  CREATE TABLE IF NOT EXISTS hidden_contacts (
    phone10    TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );

  -- Dashboard "clear" dismissals: a row hides one item (reply/lead) from a dashboard panel
  -- without deleting the underlying record. kind = 'reply' (ref = activity id) | 'lead' (ref = lead id).
  CREATE TABLE IF NOT EXISTS dashboard_dismissed (
    kind       TEXT NOT NULL,
    ref_id     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (kind, ref_id)
  );

  -- MISMO export audit log. The XML itself can contain DOB/SSN, so the CRM stores a
  -- digest plus validation metadata instead of retaining another plaintext copy.
  CREATE TABLE IF NOT EXISTS mismo_exports (
    id                 TEXT PRIMARY KEY,
    lead_id            TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    created_at         INTEGER NOT NULL,
    created_by         TEXT,
    filename           TEXT NOT NULL,
    map_version        TEXT,
    xml_sha256         TEXT NOT NULL,
    validation_status  TEXT NOT NULL,
    validation_score   INTEGER NOT NULL DEFAULT 0,
    issues             TEXT NOT NULL DEFAULT '[]',
    contains_sensitive INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_mismo_exports_lead ON mismo_exports(lead_id, created_at DESC);

  -- Internal AUS-style preview runs and findings. This is the local underwriting/rules
  -- preview layer, not a Fannie/Freddie agency submission.
  CREATE TABLE IF NOT EXISTS aus_submissions (
    id          TEXT PRIMARY KEY,
    lead_id     TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    created_by  TEXT,
    provider    TEXT NOT NULL,
    decision    TEXT NOT NULL,
    status      TEXT NOT NULL,
    score       INTEGER NOT NULL DEFAULT 0,
    summary     TEXT,
    ratios      TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_aus_submissions_lead ON aus_submissions(lead_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS aus_findings (
    id             TEXT PRIMARY KEY,
    submission_id  TEXT NOT NULL REFERENCES aus_submissions(id) ON DELETE CASCADE,
    lead_id        TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    created_at     INTEGER NOT NULL,
    severity       TEXT NOT NULL,
    category       TEXT NOT NULL,
    title          TEXT NOT NULL,
    detail         TEXT,
    status         TEXT NOT NULL DEFAULT 'open'
  );
  CREATE INDEX IF NOT EXISTS idx_aus_findings_lead ON aus_findings(lead_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS audit_events (
    id          TEXT PRIMARY KEY,
    created_at  INTEGER NOT NULL,
    user_id     TEXT,
    username    TEXT,
    role        TEXT,
    ip          TEXT,
    method      TEXT NOT NULL,
    path        TEXT NOT NULL,
    action      TEXT NOT NULL,
    status_code INTEGER,
    detail      TEXT,
    meta        TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_events_user ON audit_events(user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id                  TEXT PRIMARY KEY,
    contact_id          TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    channel             TEXT NOT NULL DEFAULT 'whatsapp',
    direction           TEXT NOT NULL,
    provider            TEXT NOT NULL,
    provider_message_id TEXT,
    body                TEXT,
    template_name       TEXT,
    status              TEXT NOT NULL,
    error_code          TEXT,
    created_at          INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_contact ON whatsapp_messages(contact_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_provider_id ON whatsapp_messages(provider_message_id);

  CREATE TABLE IF NOT EXISTS power_dialer_lists (
    id            TEXT PRIMARY KEY,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    created_by    TEXT,
    owner_user_id TEXT,
    name          TEXT NOT NULL,
    source        TEXT,
    lead_ids      TEXT NOT NULL DEFAULT '[]',
    filters       TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_power_dialer_lists_owner ON power_dialer_lists(owner_user_id, updated_at DESC);
`);

// ── Multi-user accounts ──────────────────────────────────────────────────────
// Per-user logins (admin | user). Admins see everything and manage users; a user sees
// only the leads assigned to them. Passwords are scrypt-hashed (salt + hash). Sessions
// are opaque bearer tokens stored here and sent as the x-session-token header.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL,
    name          TEXT,
    role          TEXT NOT NULL DEFAULT 'user',   -- 'admin' | 'user'
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    portal_verified_until INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS lead_sensitive_data (
    lead_id     TEXT PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    expires_at  INTEGER,
    key_id      TEXT NOT NULL,
    iv          TEXT NOT NULL,
    auth_tag    TEXT NOT NULL,
    ciphertext  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sensitive_expires ON lead_sensitive_data(expires_at);

  CREATE TABLE IF NOT EXISTS lead_documents (
    id            TEXT PRIMARY KEY,
    lead_id       TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    created_at    INTEGER NOT NULL,
    uploaded_by   TEXT,
    original_name TEXT NOT NULL,
    display_name  TEXT,
    folder_name   TEXT NOT NULL DEFAULT 'General',
    stored_name   TEXT NOT NULL,
    mime          TEXT NOT NULL,
    size          INTEGER NOT NULL,
    doc_type      TEXT NOT NULL,
    notes         TEXT,
    deleted_at    INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_lead_documents_lead ON lead_documents(lead_id, created_at DESC);
`);

// Idempotent column migrations (the leads table may predate these fields). SQLite has
// no "ADD COLUMN IF NOT EXISTS", so we check the existing columns first.
function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    log.info("CRM migration: added column", { table, column });
  }
}

ensureColumn("leads", "category", "category TEXT");
ensureColumn("leads", "category_reason", "category_reason TEXT");
ensureColumn("leads", "campaign", "campaign TEXT");
ensureColumn("leads", "sms_consent", "sms_consent INTEGER NOT NULL DEFAULT 0");
ensureColumn("leads", "email_unsubscribed", "email_unsubscribed INTEGER NOT NULL DEFAULT 0");
ensureColumn("leads", "consent_at", "consent_at INTEGER");
// Soft-delete: a non-null deleted_at hides the lead from normal lists; Restore clears it.
ensureColumn("leads", "deleted_at", "deleted_at INTEGER");
// Past-client segment: 1 = a closed/repeat client (Past Clients view + remarketing trigger).
ensureColumn("leads", "past_client", "past_client INTEGER NOT NULL DEFAULT 0");
// Lead ownership: which user the lead is assigned to. NULL = unassigned (admins still see it;
// a non-admin sees only leads whose owner_user_id is their own id). Backfilled to the first
// admin on rollout (see seedAdminIfEmpty()).
ensureColumn("leads", "owner_user_id", "owner_user_id TEXT");
db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_owner ON leads(owner_user_id)`);
// Contact-only: 1 = a person kept in the Contacts tab but NOT in the active Leads pipeline.
// The Leads tab hides these; the "Move to Leads / Move to Contacts" button flips it.
ensureColumn("leads", "contact_only", "contact_only INTEGER NOT NULL DEFAULT 0");
// Per-lead to-do checklist: JSON array of { id, text, done, created_at }.
ensureColumn("leads", "todos", "todos TEXT NOT NULL DEFAULT '[]'");
ensureColumn("leads", "whatsapp_phone", "whatsapp_phone TEXT");
ensureColumn("leads", "whatsapp_opt_in_status", "whatsapp_opt_in_status INTEGER NOT NULL DEFAULT 0");
ensureColumn("leads", "whatsapp_opt_in_source", "whatsapp_opt_in_source TEXT");
ensureColumn("leads", "whatsapp_opt_in_timestamp", "whatsapp_opt_in_timestamp INTEGER");
ensureColumn("leads", "whatsapp_last_inbound_at", "whatsapp_last_inbound_at INTEGER");
ensureColumn("leads", "whatsapp_last_outbound_at", "whatsapp_last_outbound_at INTEGER");
ensureColumn("leads", "preferred_channel", "preferred_channel TEXT");
// Timeline items are recoverable too. A non-null deleted_at hides them from the normal
// activity feed but keeps them available in the Deleted workspace.
ensureColumn("activities", "deleted_at", "deleted_at INTEGER");
ensureColumn("lead_documents", "display_name", "display_name TEXT");
ensureColumn("lead_documents", "folder_name", "folder_name TEXT NOT NULL DEFAULT 'General'");
// Call-log deletes/clears are recoverable too.
ensureColumn("call_log", "deleted_at", "deleted_at INTEGER");
// Server-side Portal / Apps step-up state. Sensitive borrower APIs require this.
ensureColumn("sessions", "portal_verified_until", "portal_verified_until INTEGER");

// Per-flow override: when set, the flow's send_text / voicemail_drop skip the TCPA
// sending-hours reschedule and fire immediately (testing / transactional use).
ensureColumn("automations", "bypass_hours", "bypass_hours INTEGER NOT NULL DEFAULT 0");
ensureColumn("automation_jobs", "updated_at", "updated_at INTEGER");
db.exec(`UPDATE automation_jobs SET updated_at = created_at WHERE updated_at IS NULL`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_updated ON automation_jobs(status, updated_at DESC)`);

// Pipeline column: each lead's kanban stage lives in its own `pipeline_stage` field
// (defaults to 'Lead-In' so new inquiries enter the board's first column). On first
// add, backfill from the older freeform `stage` value when it's a real pipeline stage.
{
  const cols = db.prepare(`PRAGMA table_info(leads)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "pipeline_stage")) {
    db.exec(`ALTER TABLE leads ADD COLUMN pipeline_stage TEXT NOT NULL DEFAULT 'Lead-In'`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_pipeline ON leads(pipeline_stage)`);
    const KNOWN = "('Lead-In','Replied','On Hold','Quote Sent','App Completed','Docs In','Processing','Funded')";
    db.exec(`UPDATE leads SET pipeline_stage = stage WHERE stage IS NOT NULL AND stage IN ${KNOWN}`);
    log.info("CRM migration: added leads.pipeline_stage (default 'Lead-In', backfilled from stage)");
  }
}

// Stage renames (owner decision): "On Hold" → "Not Replying", "Docs In" → "Suspended".
// Idempotent — once renamed no rows match, so it's safe to run on every boot. Runs after the
// backfill above so freshly-migrated rows pick up the new names too.
{
  const renamed = db
    .prepare(
      `UPDATE leads SET pipeline_stage = CASE pipeline_stage
          WHEN 'On Hold' THEN 'Not Replying'
          WHEN 'Docs In' THEN 'Suspended'
          ELSE pipeline_stage END
        WHERE pipeline_stage IN ('On Hold', 'Docs In')`,
    )
    .run();
  if (renamed.changes > 0) log.info(`CRM migration: renamed ${renamed.changes} lead stage(s) (On Hold→Not Replying, Docs In→Suspended)`);
}

// Speed up the Leads list: it orders by COALESCE(last_activity_at, created_at) DESC, which
// can't use a plain column index. An expression index on that exact key lets SQLite satisfy
// the ORDER BY ... LIMIT without a full table sort (matters once the book is thousands deep).
db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_recent ON leads(COALESCE(last_activity_at, created_at) DESC)`);

// One-time backfill (owner decision): texting is on for every existing record — the
// per-number DNC list is the only suppression. sms_consent stays as the opt-in *record*
// going forward (consent_at is NOT fabricated here; only the textable flag is set).
{
  const MARKER = "migration:sms_textable_backfill:v1";
  if (!getMeta(MARKER)) {
    const r = db.prepare(`UPDATE leads SET sms_consent = 1 WHERE sms_consent = 0`).run();
    setMeta(MARKER, String(Date.now()));
    if ((r.changes ?? 0) > 0) log.info("CRM migration: marked existing leads textable", { updated: r.changes });
  }
}

// One-time switch to SMS as the outbound texting lane (owner decision: BlueBubbles/the Mac
// isn't reliable, so iMessage can't be the primary path). Runs ONCE (versioned marker), so
// it overrides a prior "auto"/"imessage" choice on the next deploy, but the console toggle
// still wins for any change made after this.
{
  const MARKER = "migration:force_sms_mode:v1";
  if (!getMeta(MARKER)) {
    setMeta("messaging_mode", "sms");
    setMeta(MARKER, String(Date.now()));
    log.info("CRM migration: set outbound texting channel to SMS (BlueBubbles unreliable)");
  }
}

// BlueBubbles is back online, so switch the lane to "auto" (iMessage-first → SMS fallback).
// Runs ONCE (its own marker) so it supersedes the earlier SMS force on the next deploy; the
// console's "Outbound texting channel" toggle still wins for any change made afterward.
{
  const MARKER = "migration:set_auto_mode:v2";
  if (!getMeta(MARKER)) {
    setMeta("messaging_mode", "auto");
    setMeta(MARKER, String(Date.now()));
    log.info("CRM migration: set outbound texting channel to AUTO (iMessage-first, SMS fallback)");
  }
}

// Owner requested iMessage-first again after SMS-only behavior showed up in CRM activity.
// Runs once on deploy; the Dialer toggle can still change the mode after this.
{
  const MARKER = "migration:set_auto_mode:v3";
  if (!getMeta(MARKER)) {
    setMeta("messaging_mode", "auto");
    setMeta(MARKER, String(Date.now()));
    log.info("CRM migration: restored outbound texting channel to AUTO (iMessage-first, SMS fallback)");
  }
}

// Restore iMessage-first after BlueBubbles Private API was installed and SMS-only behavior
// was observed on live contacts. Runs once; the Dialer toggle remains the runtime override.
{
  const MARKER = "migration:set_auto_mode:v4";
  if (!getMeta(MARKER)) {
    setMeta("messaging_mode", "auto");
    setMeta(MARKER, String(Date.now()));
    log.info("CRM migration: restored outbound texting channel to AUTO after Private API setup");
  }
}

// Ensure live sends use iMessage-first after moving SMS caller-ID selection behind the
// BlueBubbles attempt. Runs once; the Dialer toggle remains available afterward.
{
  const MARKER = "migration:set_auto_mode:v5";
  if (!getMeta(MARKER)) {
    setMeta("messaging_mode", "auto");
    setMeta(MARKER, String(Date.now()));
    log.info("CRM migration: restored outbound texting channel to AUTO after SMS fallback ordering fix");
  }
}

// The live router should try BlueBubbles first on every normal outbound message, then
// fall back to Telnyx only after BlueBubbles returns a concrete non-success outcome.
// Runs once on deploy to clear any old SMS-only console state.
{
  const MARKER = "migration:set_auto_mode:v6";
  if (!getMeta(MARKER)) {
    setMeta("messaging_mode", "auto");
    setMeta(MARKER, String(Date.now()));
    log.info("CRM migration: restored outbound texting channel to AUTO for /v2 launch");
  }
}

/** Read a service-internal marker (or null if unset). */
export function getMeta(key: string): string | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

/** Write a service-internal marker (upsert). */
export function setMeta(key: string, value: string): void {
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

/** Hide a GHL message from the console thread for a contact (console-side only; GHL keeps it). */
export function hideMessage(contactId: string, sig: string): void {
  db.prepare(`INSERT OR IGNORE INTO hidden_messages (contact_id, sig, created_at) VALUES (?, ?, ?)`).run(contactId, sig, Date.now());
}

/** The set of message signatures the operator has hidden for a contact. */
export function hiddenMessageSigs(contactId: string): Set<string> {
  const rows = db.prepare(`SELECT sig FROM hidden_messages WHERE contact_id = ?`).all(contactId) as Array<{ sig: string }>;
  return new Set(rows.map((r) => r.sig));
}

/** Remove a whole conversation from the Messages inbox (console-side only; the lead's
 *  activity timeline is untouched). */
export function hideConversation(contactId: string): void {
  db.prepare(`INSERT OR IGNORE INTO hidden_conversations (contact_id, created_at) VALUES (?, ?)`).run(contactId, Date.now());
}

/** Restore a previously hidden conversation to the inbox. */
export function unhideConversation(contactId: string): void {
  db.prepare(`DELETE FROM hidden_conversations WHERE contact_id = ?`).run(contactId);
}

/** The set of contact ids whose conversations are hidden from the inbox. */
export function hiddenConversationIds(): Set<string> {
  const rows = db.prepare(`SELECT contact_id FROM hidden_conversations`).all() as Array<{ contact_id: string }>;
  return new Set(rows.map((r) => r.contact_id));
}

/* ── Call log (Dialer missed-calls panel) ─────────────────────────────────── */

export interface CallLogRow {
  id: string;
  created_at: number;
  direction: string;
  phone: string | null;
  name: string | null;
  contact_id: string | null;
  lead_id: string | null;
  outcome: string | null;
  duration_sec: number;
  deleted_at: number | null;
}

/** Record a call in the call log. */
export function insertCallLog(e: {
  direction: string;
  phone?: string | null;
  name?: string | null;
  contactId?: string | null;
  leadId?: string | null;
  outcome?: string | null;
  durationSec?: number;
}): void {
  db.prepare(
    `INSERT INTO call_log (id, created_at, direction, phone, name, contact_id, lead_id, outcome, duration_sec)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(), Date.now(), e.direction, e.phone ?? null, e.name ?? null,
    e.contactId ?? null, e.leadId ?? null, e.outcome ?? null, e.durationSec ?? 0,
  );
}

/** Recent call-log entries, newest first. */
export function listCallLog(limit = 100): CallLogRow[] {
  return db.prepare(`SELECT * FROM call_log WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`).all(Math.min(limit, 500)) as CallLogRow[];
}

export function deleteCallLog(id: string): void {
  db.prepare(`UPDATE call_log SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ?`).run(Date.now(), id);
}

/** Clear the call log. Pass `outcome` to clear only that kind (e.g. "missed"). */
export function clearCallLog(outcome?: string): void {
  const now = Date.now();
  if (outcome) db.prepare(`UPDATE call_log SET deleted_at = COALESCE(deleted_at, ?) WHERE deleted_at IS NULL AND outcome = ?`).run(now, outcome);
  else db.prepare(`UPDATE call_log SET deleted_at = COALESCE(deleted_at, ?) WHERE deleted_at IS NULL`).run(now);
}

/** Deleted call-log entries for the Deleted workspace. */
export function listDeletedCallLog(limit = 200): CallLogRow[] {
  return db.prepare(`SELECT * FROM call_log WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, created_at DESC LIMIT ?`).all(Math.min(limit, 500)) as CallLogRow[];
}

/** Restore a call-log entry back to the Dialer / dashboard call panels. */
export function restoreCallLog(id: string): void {
  db.prepare(`UPDATE call_log SET deleted_at = NULL WHERE id = ?`).run(id);
}

/* ── Hidden GHL contacts (Contacts list suppression) ──────────────────────── */

/** Last 10 digits of a phone, for stable matching of a GHL contact across reloads. */
function phone10(p?: string | null): string {
  const d = String(p || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
}

/** Hide one or more GHL contacts (by phone) from the Contacts list. */
export function hideContacts(phones: string[]): void {
  const stmt = db.prepare(`INSERT OR IGNORE INTO hidden_contacts (phone10, created_at) VALUES (?, ?)`);
  const now = Date.now();
  for (const p of phones) {
    const k = phone10(p);
    if (k) stmt.run(k, now);
  }
}

/** Set of hidden contact phone keys (last 10 digits). */
export function hiddenContactPhones(): Set<string> {
  const rows = db.prepare(`SELECT phone10 FROM hidden_contacts`).all() as Array<{ phone10: string }>;
  return new Set(rows.map((r) => r.phone10));
}

/** True if this phone is a hidden GHL contact. */
export function isContactHidden(phone?: string | null): boolean {
  const k = phone10(phone);
  return k ? hiddenContactPhones().has(k) : false;
}

// ── Dashboard panel "clear" dismissals (non-destructive: hides from the panel only) ──

/** Hide one item (reply/lead) from its dashboard panel. */
export function dismissDashboardItem(kind: string, refId: string): void {
  db.prepare(`INSERT OR IGNORE INTO dashboard_dismissed (kind, ref_id, created_at) VALUES (?,?,?)`).run(kind, refId, Date.now());
}

/** "Clear all" for a panel: stamp a cutoff so every item up to now is hidden. */
export function clearDashboardKind(kind: string): void {
  setMeta(`db_cleared_${kind}_at`, String(Date.now()));
}

/** The cutoff time (ms) for a panel's "clear all", or 0 if never cleared. */
export function dashboardClearedAt(kind: string): number {
  return parseInt(getMeta(`db_cleared_${kind}_at`) || "0", 10) || 0;
}

/** Set of individually-dismissed ref ids for a panel. */
export function dismissedDashboardIds(kind: string): Set<string> {
  const rows = db.prepare(`SELECT ref_id FROM dashboard_dismissed WHERE kind = ?`).all(kind) as Array<{ ref_id: string }>;
  return new Set(rows.map((r) => r.ref_id));
}

log.info("CRM SQLite ready", { path: DB_PATH });
