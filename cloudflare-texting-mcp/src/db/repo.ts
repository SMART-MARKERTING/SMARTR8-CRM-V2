import type { Env } from "../env";

/* ── Row shapes ─────────────────────────────────────────────────────────── */

export interface LeadRow {
  lead_id: string;
  created_at: number;
  funnel: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone_e164: string | null;
  property_state: string | null;
  loan_request: string | null;
  source: string | null;
}

export interface ContactTexting {
  lead_id: string;
  imessage_capable: number | null;
  probed: number;
  probed_at: number | null;
  tags: string | null;
  lead_status: string | null;
  updated_at: number | null;
}

export interface MessageRow {
  message_id: string;
  conversation_id: string | null;
  lead_id: string | null;
  phone_e164: string;
  direction: "in" | "out";
  channel: "imessage" | "sms";
  body: string | null;
  status: string | null;
  provider_id: string | null;
  temp_guid: string | null;
  error: string | null;
  created_at: number;
}

export interface ConversationRow {
  conversation_id: string;
  lead_id: string | null;
  phone_e164: string;
  last_message_at: number | null;
  last_message_preview: string | null;
  unread: number;
  status: string;
  created_at: number;
  updated_at: number;
}

/* ── Leads / consent (read-only against Pages-owned tables) ─────────────── */

const LEAD_COLS =
  "lead_id, created_at, funnel, first_name, last_name, email, phone_e164, property_state, loan_request, source";

export function getLeadById(env: Env, leadId: string): Promise<LeadRow | null> {
  return env.LEADS_DB.prepare(`SELECT ${LEAD_COLS} FROM leads WHERE lead_id = ?`)
    .bind(leadId)
    .first<LeadRow>();
}

export function findLeadByPhone(env: Env, e164: string): Promise<LeadRow | null> {
  return env.LEADS_DB.prepare(
    `SELECT ${LEAD_COLS} FROM leads WHERE phone_e164 = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(e164)
    .first<LeadRow>();
}

/** A tcpa_consents row for this lead = consent captured at the funnel. */
export async function hasConsent(env: Env, leadId: string): Promise<boolean> {
  const r = await env.LEADS_DB.prepare("SELECT 1 AS x FROM tcpa_consents WHERE lead_id = ? LIMIT 1")
    .bind(leadId)
    .first<{ x: number }>();
  return !!r;
}

/** Leads with a phone but NO outbound message yet. */
export async function listNewLeads(env: Env, limit: number): Promise<LeadRow[]> {
  const res = await env.LEADS_DB.prepare(
    `SELECT ${LEAD_COLS} FROM leads l
     WHERE l.phone_e164 IS NOT NULL AND l.phone_e164 <> ''
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = l.lead_id AND m.direction = 'out')
     ORDER BY l.created_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all<LeadRow>();
  return res.results ?? [];
}

/* ── Conversations + messages (our additive tables) ─────────────────────── */

export async function getOrCreateConversation(
  env: Env,
  opts: { leadId: string | null; phone: string },
): Promise<string> {
  const existing = await env.LEADS_DB.prepare(
    "SELECT conversation_id, lead_id FROM conversations WHERE phone_e164 = ?",
  )
    .bind(opts.phone)
    .first<{ conversation_id: string; lead_id: string | null }>();
  if (existing) {
    /* Backfill the lead link if we only learned it later (e.g. inbound first). */
    if (opts.leadId && !existing.lead_id) {
      await env.LEADS_DB.prepare("UPDATE conversations SET lead_id = ? WHERE conversation_id = ?")
        .bind(opts.leadId, existing.conversation_id)
        .run();
    }
    return existing.conversation_id;
  }
  const id = `conv_${crypto.randomUUID()}`;
  const now = Date.now();
  await env.LEADS_DB.prepare(
    `INSERT INTO conversations (conversation_id, lead_id, phone_e164, unread, status, created_at, updated_at)
     VALUES (?, ?, ?, 0, 'open', ?, ?)`,
  )
    .bind(id, opts.leadId, opts.phone, now, now)
    .run();
  return id;
}

export async function recordMessage(
  env: Env,
  m: Omit<MessageRow, "message_id"> & { message_id?: string },
): Promise<string> {
  const id = m.message_id ?? `msg_${crypto.randomUUID()}`;
  await env.LEADS_DB.prepare(
    `INSERT INTO messages
       (message_id, conversation_id, lead_id, phone_e164, direction, channel, body, status, provider_id, temp_guid, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id, m.conversation_id, m.lead_id, m.phone_e164, m.direction, m.channel,
      m.body ?? null, m.status ?? null, m.provider_id ?? null, m.temp_guid ?? null,
      m.error ?? null, m.created_at,
    )
    .run();

  if (m.conversation_id) {
    const preview = (m.body ?? "").slice(0, 140);
    /* Inbound bumps unread; outbound (a reply) clears it. */
    await env.LEADS_DB.prepare(
      `UPDATE conversations
         SET last_message_at = ?, last_message_preview = ?, updated_at = ?,
             unread = CASE WHEN ? = 'in' THEN unread + 1 ELSE 0 END
       WHERE conversation_id = ?`,
    )
      .bind(m.created_at, preview, m.created_at, m.direction, m.conversation_id)
      .run();
  }
  return id;
}

export async function listConversations(
  env: Env,
  opts: { unreadOnly?: boolean; status?: string; limit: number },
): Promise<(ConversationRow & { first_name: string | null; last_name: string | null; property_state: string | null })[]> {
  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (opts.unreadOnly) where.push("c.unread > 0");
  if (opts.status) {
    where.push("c.status = ?");
    binds.push(opts.status);
  }
  const sql =
    `SELECT c.*, l.first_name, l.last_name, l.property_state
       FROM conversations c LEFT JOIN leads l ON l.lead_id = c.lead_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY COALESCE(c.last_message_at, c.created_at) DESC LIMIT ?`;
  binds.push(opts.limit);
  const res = await env.LEADS_DB.prepare(sql).bind(...binds).all();
  return (res.results ?? []) as never;
}

export async function getConversationMessages(
  env: Env,
  leadId: string,
  limit: number,
): Promise<MessageRow[]> {
  const res = await env.LEADS_DB.prepare(
    `SELECT * FROM messages WHERE lead_id = ? ORDER BY created_at ASC LIMIT ?`,
  )
    .bind(leadId, limit)
    .all<MessageRow>();
  return res.results ?? [];
}

/** True if the contact has ever texted US (an existing inbound thread). */
export async function hasInboundThread(env: Env, leadId: string): Promise<boolean> {
  const r = await env.LEADS_DB.prepare(
    "SELECT 1 AS x FROM messages WHERE lead_id = ? AND direction = 'in' LIMIT 1",
  )
    .bind(leadId)
    .first<{ x: number }>();
  return !!r;
}

export async function hasOutbound(env: Env, leadId: string): Promise<boolean> {
  const r = await env.LEADS_DB.prepare(
    "SELECT 1 AS x FROM messages WHERE lead_id = ? AND direction = 'out' LIMIT 1",
  )
    .bind(leadId)
    .first<{ x: number }>();
  return !!r;
}

export async function recentOutboundBodies(env: Env, leadId: string, sinceTs: number): Promise<string[]> {
  const res = await env.LEADS_DB.prepare(
    "SELECT body FROM messages WHERE lead_id = ? AND direction = 'out' AND created_at >= ?",
  )
    .bind(leadId, sinceTs)
    .all<{ body: string | null }>();
  return (res.results ?? []).map((r) => r.body ?? "");
}

export async function outboundCountSince(env: Env, leadId: string, sinceTs: number): Promise<number> {
  const r = await env.LEADS_DB.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE lead_id = ? AND direction = 'out' AND created_at >= ?",
  )
    .bind(leadId, sinceTs)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/* ── Opt-out (shared suppression) ───────────────────────────────────────── */

export async function isOptedOut(env: Env, e164: string): Promise<boolean> {
  const r = await env.LEADS_DB.prepare("SELECT 1 AS x FROM opt_out WHERE phone_e164 = ? LIMIT 1")
    .bind(e164)
    .first<{ x: number }>();
  return !!r;
}

export async function insertOptOut(
  env: Env,
  o: { phone: string; leadId?: string | null; reason?: string; keyword?: string; source: string },
): Promise<void> {
  await env.LEADS_DB.prepare(
    `INSERT INTO opt_out (phone_e164, lead_id, reason, keyword, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(phone_e164) DO UPDATE SET
       reason = excluded.reason, keyword = excluded.keyword, source = excluded.source`,
  )
    .bind(o.phone, o.leadId ?? null, o.reason ?? null, o.keyword ?? null, o.source, Date.now())
    .run();
}

/* ── Send audit ─────────────────────────────────────────────────────────── */

export async function insertAudit(
  env: Env,
  a: { leadId: string | null; phone: string | null; channel: string | null; body: string | null; status: string; reason: string },
): Promise<void> {
  await env.LEADS_DB.prepare(
    `INSERT INTO send_audit (audit_id, lead_id, phone_e164, channel, body, status, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(`aud_${crypto.randomUUID()}`, a.leadId, a.phone, a.channel, a.body, a.status, a.reason, Date.now())
    .run();
}

/* ── contact_texting sidecar ────────────────────────────────────────────── */

export function getContactTexting(env: Env, leadId: string): Promise<ContactTexting | null> {
  return env.LEADS_DB.prepare("SELECT * FROM contact_texting WHERE lead_id = ?")
    .bind(leadId)
    .first<ContactTexting>();
}

export async function upsertContactTexting(
  env: Env,
  leadId: string,
  patch: Partial<Omit<ContactTexting, "lead_id">>,
): Promise<void> {
  const now = Date.now();
  const existing = await getContactTexting(env, leadId);
  const merged: ContactTexting = {
    lead_id: leadId,
    imessage_capable: patch.imessage_capable ?? existing?.imessage_capable ?? null,
    probed: patch.probed ?? existing?.probed ?? 0,
    probed_at: patch.probed_at ?? existing?.probed_at ?? null,
    tags: patch.tags ?? existing?.tags ?? null,
    lead_status: patch.lead_status ?? existing?.lead_status ?? null,
    updated_at: now,
  };
  await env.LEADS_DB.prepare(
    `INSERT INTO contact_texting (lead_id, imessage_capable, probed, probed_at, tags, lead_status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(lead_id) DO UPDATE SET
       imessage_capable = excluded.imessage_capable,
       probed = excluded.probed,
       probed_at = excluded.probed_at,
       tags = excluded.tags,
       lead_status = excluded.lead_status,
       updated_at = excluded.updated_at`,
  )
    .bind(
      merged.lead_id, merged.imessage_capable, merged.probed, merged.probed_at,
      merged.tags, merged.lead_status, merged.updated_at,
    )
    .run();
}
