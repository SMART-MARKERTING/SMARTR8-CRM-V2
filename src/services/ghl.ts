import { config } from "../config";
import { getAccessToken } from "../store/tokenStore";
import { log } from "../logger";

// GHL is DISCONNECTED: the local SQLite CRM is the sole system of record. All GHL
// network calls below short-circuit to benign no-ops so nothing in the service hits
// GHL anymore (logging/upsert/search). The one exception is listAllContacts, kept live
// so the one-time "Import from GHL" migration can still pull contacts into the local DB.
const GHL_DISCONNECTED = true;

export interface GhlContact {
  id: string;
  phone?: string;
  tags?: string[];
  timezone?: string; // IANA tz (e.g. "America/Phoenix") — used for the calling-hours gate
  [k: string]: unknown;
}

export type Direction = "inbound" | "outbound";

async function authHeaders(version = config.ghl.apiVersion): Promise<Record<string, string>> {
  return {
    Authorization: `Bearer ${await getAccessToken()}`,
    Version: version,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/** Find-or-create a contact by phone. Returns the contact incl. tags + id.
 *  GHL_DISCONNECTED: no-op — returns a stub so callers (router) keep working
 *  without any GHL contact id. */
export async function upsertContact(phone: string): Promise<GhlContact> {
  if (GHL_DISCONNECTED) return { id: "", phone, tags: [] };
  const res = await fetch(`${config.ghl.apiBase}/contacts/upsert`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ locationId: config.ghl.locationId, phone }),
  });
  if (!res.ok) throw new Error(`GHL upsert failed ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { contact: GhlContact };
  return data.contact;
}

export async function getContact(contactId: string): Promise<GhlContact> {
  if (GHL_DISCONNECTED) return { id: contactId, tags: [] };
  const res = await fetch(`${config.ghl.apiBase}/contacts/${contactId}`, {
    method: "GET",
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`GHL getContact failed ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { contact: GhlContact };
  return data.contact;
}

/** Thread a message onto the contact's conversation (both directions via `direction`). */
export async function logMessage(opts: {
  contactId: string;
  message: string;
  direction: Direction;
}): Promise<{ messageId?: string; conversationId?: string }> {
  if (GHL_DISCONNECTED) return {};
  const res = await fetch(`${config.ghl.apiBase}/conversations/messages/inbound`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({
      type: "SMS",
      contactId: opts.contactId,
      message: opts.message,
      direction: opts.direction,
    }),
  });
  if (!res.ok) throw new Error(`GHL logMessage(${opts.direction}) failed ${res.status}: ${await res.text()}`);
  return (await res.json()) as { messageId?: string; conversationId?: string };
}

/**
 * Log a phone call onto the contact's conversation. GHL requires a conversation
 * provider whose **type is "Call"** for this (the SMS provider used by logMessage
 * is rejected as "Incorrect conversationProviderId/type", and omitting it fails
 * with "No conversationProviderId passed in body"). Outbound vs inbound use
 * different endpoints per the GHL API. Best-effort: returns the outcome, never throws.
 */
export async function logCall(opts: {
  contactId: string;
  direction: Direction;
  durationSec: number;
  status: string;
  /** The contact's phone, used to populate the call object's to/from for display. */
  contactPhone?: string;
}): Promise<{ ok: boolean; status?: number; detail?: string }> {
  if (GHL_DISCONNECTED) return { ok: false, detail: "GHL disconnected" };
  const providerId = config.ghl.callConversationProviderId;
  if (!providerId) {
    // GHL hard-requires a Call-type provider; without it every attempt 400s. Surface
    // an actionable reason (shown in /calls/diag) instead of a confusing API error.
    const detail = "GHL_CALL_CONVERSATION_PROVIDER_ID not set — create a Type: Call conversation provider in GHL and set its id";
    log.error(`GHL logCall skipped: ${detail}`);
    return { ok: false, detail };
  }
  const outbound = opts.direction === "outbound";
  const label = outbound ? "Outbound" : "Inbound";
  // to/from from the contact's perspective vs our Telnyx number.
  const ours = config.telnyx.fromNumber || undefined;
  const call: Record<string, unknown> = {
    to: outbound ? opts.contactPhone : ours,
    from: outbound ? ours : opts.contactPhone,
    status: opts.status,
    duration: opts.durationSec,
  };
  // Outbound calls log via the external-outbound-call endpoint; inbound via the
  // inbound-message endpoint. Both take type "Call" + the Call-type provider.
  const endpoint = outbound ? "outbound" : "inbound";
  const res = await fetch(`${config.ghl.apiBase}/conversations/messages/${endpoint}`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({
      type: "Call",
      contactId: opts.contactId,
      conversationProviderId: providerId,
      status: opts.status,
      message: `${label} call — ${opts.status}${opts.durationSec ? ` (${opts.durationSec}s)` : ""}`,
      call,
      date: new Date().toISOString(),
    }),
  });
  if (!res.ok) {
    // Surfaced at error level + returned (not a silent warn) so /calls/diag records it.
    await res.body?.cancel().catch(() => undefined);
    log.error("GHL logCall failed", { status: res.status });
    return { ok: false, status: res.status, detail: `GHL API error (${res.status})` };
  }
  return { ok: true, status: res.status };
}

/** Add tags to a contact WITHOUT overwriting existing ones (POST /contacts/{id}/tags). */
export async function addTags(contactId: string, tags: string[]): Promise<void> {
  if (GHL_DISCONNECTED) return;
  const res = await fetch(`${config.ghl.apiBase}/contacts/${contactId}/tags`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ tags }),
  });
  if (!res.ok) throw new Error(`GHL addTags failed (${res.status})`);
}

/** Remove tags from a contact (DELETE /contacts/{id}/tags). Best-effort. */
export async function removeTags(contactId: string, tags: string[]): Promise<void> {
  if (GHL_DISCONNECTED) return;
  const res = await fetch(`${config.ghl.apiBase}/contacts/${contactId}/tags`, {
    method: "DELETE",
    headers: await authHeaders(),
    body: JSON.stringify({ tags }),
  });
  if (!res.ok) log.warn("GHL removeTags failed", { status: res.status });
}

/** Find contacts carrying a tag (Search Contacts endpoint, version 2023-02-21). */
export async function searchByTag(tag: string, limit = 5): Promise<GhlContact[]> {
  if (GHL_DISCONNECTED) return [];
  const res = await fetch(`${config.ghl.apiBase}/contacts/search`, {
    method: "POST",
    headers: await authHeaders(config.ghl.searchApiVersion),
    body: JSON.stringify({
      locationId: config.ghl.locationId,
      page: 1,
      pageLimit: limit,
      filters: [{ field: "tags", operator: "contains", value: tag }],
    }),
  });
  if (!res.ok) throw new Error(`GHL searchByTag failed (${res.status})`);
  const data = (await res.json()) as { contacts?: GhlContact[] };
  return data.contacts ?? [];
}

/** Lightweight contact shape for the console UI. */
export interface ContactLite {
  id: string;
  name: string;
  phone?: string;
  tags?: string[];
}

/** Search/list contacts for the console (free-text over name/phone/email). */
export async function searchContacts(query: string, limit = 25): Promise<ContactLite[]> {
  if (GHL_DISCONNECTED) return [];
  const body: Record<string, unknown> = { locationId: config.ghl.locationId, page: 1, pageLimit: limit };
  if (query) body.query = query;
  const res = await fetch(`${config.ghl.apiBase}/contacts/search`, {
    method: "POST",
    headers: await authHeaders(config.ghl.searchApiVersion),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GHL searchContacts failed ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { contacts?: Array<Record<string, any>> };
  return (data.contacts ?? []).map((c) => ({
    id: c.id,
    name: c.contactName || [c.firstName, c.lastName].filter(Boolean).join(" ") || c.phone || "(no name)",
    phone: c.phone,
    tags: c.tags,
  }));
}

/** List ALL contacts via the GET /contacts/ endpoint with CURSOR pagination
 *  (startAfter + startAfterId from meta). The POST /contacts/search `page` param is
 *  unreliable for deep pagination (it re-serves the same results), so a full pull must use
 *  the cursor. Returns up to `max` contacts. */
export async function listAllContacts(max = 20000): Promise<ContactLite[]> {
  const out: ContactLite[] = [];
  const seen = new Set<string>(); // guard against any cursor stall serving dupes
  const limit = 100;
  let startAfter: string | undefined;
  let startAfterId: string | undefined;
  for (let i = 0; out.length < max && i < 400; i++) {
    const url = new URL(`${config.ghl.apiBase}/contacts/`);
    url.searchParams.set("locationId", config.ghl.locationId);
    url.searchParams.set("limit", String(limit));
    if (startAfter) url.searchParams.set("startAfter", startAfter);
    if (startAfterId) url.searchParams.set("startAfterId", startAfterId);
    const res = await fetch(url.toString(), { method: "GET", headers: await authHeaders(config.ghl.apiVersion) });
    if (!res.ok) throw new Error(`GHL listAllContacts failed ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      contacts?: Array<Record<string, any>>;
      meta?: { startAfter?: unknown; startAfterId?: string; nextPageUrl?: string };
    };
    const batch = data.contacts ?? [];
    if (!batch.length) break;
    let added = 0;
    for (const c of batch) {
      if (!c.id || seen.has(c.id)) continue;
      seen.add(c.id);
      added++;
      out.push({
        id: c.id,
        name: c.contactName || [c.firstName, c.lastName].filter(Boolean).join(" ") || c.phone || "(no name)",
        phone: c.phone,
        tags: c.tags,
      });
    }
    const meta = data.meta ?? {};
    startAfter = meta.startAfter != null ? String(meta.startAfter) : undefined;
    startAfterId = meta.startAfterId;
    // Stop when the page is short, the cursor didn't advance, or it served only dupes.
    if (batch.length < limit || (!startAfter && !startAfterId) || added === 0) break;
  }
  return out;
}

/** A single message normalized for the console. */
export interface MessageLite {
  direction: Direction;
  body: string;
  date?: string;
}

/**
 * Read a contact's recent conversation messages for the console.
 * TODO(verify): GHL conversation/message read shapes are unconfirmed; we log raw
 * and parse defensively, returning [] (never throwing) so the UI degrades gracefully.
 */
export async function getContactMessages(contactId: string, limit = 50): Promise<MessageLite[]> {
  if (GHL_DISCONNECTED) return [];
  try {
    const convRes = await fetch(
      `${config.ghl.apiBase}/conversations/search?locationId=${config.ghl.locationId}&contactId=${contactId}`,
      { headers: await authHeaders() },
    );
    const convRaw = await convRes.text();
    if (!convRes.ok) {
      log.warn("GHL conversations search failed", { status: convRes.status });
      return [];
    }
    const conv = JSON.parse(convRaw) as { conversations?: Array<{ id?: string }> };
    const conversationId = conv.conversations?.[0]?.id;
    if (!conversationId) return [];

    const msgRes = await fetch(
      `${config.ghl.apiBase}/conversations/${conversationId}/messages?limit=${limit}`,
      { headers: await authHeaders() },
    );
    const msgRaw = await msgRes.text();
    if (!msgRes.ok) {
      log.warn("GHL messages read failed", { status: msgRes.status });
      return [];
    }
    const parsed = JSON.parse(msgRaw) as any;
    const list: any[] = parsed?.messages?.messages ?? parsed?.messages ?? parsed?.data ?? [];
    return list
      .map((m) => ({
        direction: (m.direction === "inbound" ? "inbound" : "outbound") as Direction,
        body: m.body ?? m.message ?? m.text ?? "",
        date: m.dateAdded ?? m.dateCreated ?? m.createdAt,
      }))
      .filter((m) => m.body)
      .reverse(); // oldest first for a chat view
  } catch (err) {
    log.warn("getContactMessages error", { err: String(err) });
    return [];
  }
}

/** A conversation summary for the Messages inbox (recent convos across all contacts). */
export interface ConversationLite {
  id: string;
  contactId: string;
  name: string;
  phone?: string;
  lastMessage: string;
  lastMessageDate?: string;
  unread?: number;
}

/**
 * Recent conversations for the console inbox, newest activity first. Uses the same
 * conversations/search endpoint as getContactMessages but without a contact filter.
 * Parses defensively and returns [] (never throws) so the inbox degrades gracefully.
 */
export async function searchConversations(limit = 25): Promise<ConversationLite[]> {
  if (GHL_DISCONNECTED) return [];
  try {
    const res = await fetch(
      `${config.ghl.apiBase}/conversations/search?locationId=${config.ghl.locationId}&limit=${limit}&sortBy=last_message_date&sort=desc`,
      { headers: await authHeaders() },
    );
    const raw = await res.text();
    if (!res.ok) {
      log.warn("GHL conversations search failed", { status: res.status });
      return [];
    }
    const data = JSON.parse(raw) as { conversations?: Array<Record<string, any>> };
    return (data.conversations ?? []).map((c) => ({
      id: c.id ?? c.conversationId ?? "",
      contactId: c.contactId ?? c.contact_id ?? "",
      name:
        c.fullName ||
        c.contactName ||
        [c.firstName, c.lastName].filter(Boolean).join(" ") ||
        c.phone ||
        c.email ||
        "(no name)",
      phone: c.phone,
      lastMessage: c.lastMessageBody ?? c.lastMessage ?? "",
      lastMessageDate: c.lastMessageDate ?? c.dateUpdated ?? c.dateAdded,
      unread: typeof c.unreadCount === "number" ? c.unreadCount : undefined,
    }));
  } catch (err) {
    log.warn("searchConversations error", { err: String(err) });
    return [];
  }
}

/** Report delivery status of a provider (outbound) message back to GHL. */
export async function updateMessageStatus(
  messageId: string,
  status: "delivered" | "failed",
  error?: string,
): Promise<void> {
  if (GHL_DISCONNECTED) return;
  const body: Record<string, unknown> = { status };
  if (error) body.error = { code: "1", type: "message", message: error };
  const res = await fetch(`${config.ghl.apiBase}/conversations/messages/${messageId}/status`, {
    method: "PUT",
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    log.warn("GHL updateMessageStatus failed", { status: res.status, requestedStatus: status });
  }
}
