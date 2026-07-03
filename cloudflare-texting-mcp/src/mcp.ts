import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./env";
import { registerRenderTools } from "./renderTools";
import { renderConfigured } from "./services/renderApi";
import { toE164 } from "./util/phone";
import { stateFromPhone } from "./util/areaCodeState";
import { tzForState, normalizeState } from "./util/tz";
import { sendMessage } from "./services/compliance";
import {
  getLeadById,
  hasConsent,
  isOptedOut,
  listConversations,
  getConversationMessages,
  listNewLeads,
  getContactTexting,
  upsertContactTexting,
} from "./db/repo";

/** JSON text payload helper — every tool returns structured, pretty-printed JSON. */
function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(message: string, hint?: string) {
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: message, hint }, null, 2) }] };
}

function leadName(l: { first_name: string | null; last_name: string | null }): string {
  return [l.first_name, l.last_name].filter(Boolean).join(" ") || "(no name)";
}

/** Register the six texting tools on a server, bound to a given Env. */
export function registerTools(server: McpServer, env: Env): void {
  server.tool(
    "list_conversations",
    "List recent texting threads (one per lead/phone), newest activity first. Optionally filter to unread only or by status (e.g. 'open', 'closed'). Returns lead name, phone, last message preview, unread count, and timestamps.",
    {
      unread_only: z.boolean().optional().describe("If true, only threads with unread inbound messages."),
      status: z.string().optional().describe("Filter by conversation status, e.g. 'open' or 'closed'."),
      limit: z.number().int().min(1).max(100).optional().describe("Max threads to return (default 25)."),
    },
    async ({ unread_only, status, limit }) => {
      const rows = await listConversations(env, { unreadOnly: unread_only, status, limit: limit ?? 25 });
      return json({
        count: rows.length,
        conversations: rows.map((c) => ({
          contactId: c.lead_id,
          name: leadName(c),
          phone: c.phone_e164,
          property_state: c.property_state,
          unread: c.unread,
          status: c.status,
          last_message_at: c.last_message_at,
          last_message_preview: c.last_message_preview,
        })),
      });
    },
  );

  server.tool(
    "get_conversation",
    "Get the full message history for a contact (contactId = lead_id), oldest first. Each message includes direction (in/out), channel (imessage/sms), body, status, and timestamp.",
    {
      contactId: z.string().describe("The lead_id of the contact."),
      limit: z.number().int().min(1).max(500).optional().describe("Max messages (default 200)."),
    },
    async ({ contactId, limit }) => {
      const lead = await getLeadById(env, contactId);
      if (!lead) return fail(`No lead found for contactId "${contactId}".`, "Use list_conversations or list_new_leads to find valid contactIds.");
      const msgs = await getConversationMessages(env, contactId, limit ?? 200);
      return json({
        contactId,
        name: leadName(lead),
        phone: lead.phone_e164,
        count: msgs.length,
        messages: msgs.map((m) => ({
          at: m.created_at,
          direction: m.direction,
          channel: m.channel,
          body: m.body,
          status: m.status,
        })),
      });
    },
  );

  server.tool(
    "get_contact",
    "Get one contact's profile by EXACT contactId (lead_id): name, phone, property state, resolved timezone, TCPA consent flag, opt-out status, texting tags, lead status. Use before sending to check compliance posture. To FIND someone by name/phone/email, use find_contacts instead (this needs an exact id).",
    { contactId: z.string().describe("The lead_id of the contact.") },
    async ({ contactId }) => {
      const lead = await getLeadById(env, contactId);
      if (!lead) return fail(`No lead found for contactId "${contactId}".`, "Use list_new_leads or list_conversations to find valid contactIds.");
      const phone = toE164(lead.phone_e164);
      const [consent, optedOut, ct] = await Promise.all([
        hasConsent(env, contactId),
        phone ? isOptedOut(env, phone) : Promise.resolve(false),
        getContactTexting(env, contactId),
      ]);
      /* Effective state = recorded property_state, else derived from the phone's
         area code (same fallback send_message uses), so the timezone shown here
         matches what a send would actually resolve. */
      const rawState = normalizeState(lead.property_state);
      const effectiveState = rawState || stateFromPhone(phone);
      return json({
        contactId,
        name: leadName(lead),
        phone: phone || lead.phone_e164,
        property_state: rawState || null,
        state_derived_from_area_code: !rawState && effectiveState ? effectiveState : undefined,
        timezone: tzForState(effectiveState),
        loan_request: lead.loan_request,
        consent,
        opted_out: optedOut,
        imessage_capable: ct?.imessage_capable === 1 ? true : ct?.imessage_capable === 0 ? false : null,
        probed: !!ct?.probed,
        tags: ct?.tags ? ct.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
        lead_status: ct?.lead_status ?? null,
      });
    },
  );

  server.tool(
    "list_new_leads",
    "List recent leads that have a phone number but NO outbound message yet (i.e. nobody has texted them). Newest first. Use this to find leads awaiting a first touch.",
    { limit: z.number().int().min(1).max(100).optional().describe("Max leads (default 25).") },
    async ({ limit }) => {
      const rows = await listNewLeads(env, limit ?? 25);
      return json({
        count: rows.length,
        leads: rows.map((l) => ({
          contactId: l.lead_id,
          name: leadName(l),
          phone: l.phone_e164,
          property_state: l.property_state,
          loan_request: l.loan_request,
          source: l.source,
          created_at: l.created_at,
        })),
      });
    },
  );

  server.tool(
    "send_message",
    "Send a text to a contact (contactId = lead_id). Routes iMessage-first with automatic SMS fallback. ALL compliance is enforced here: business hours by property state (8am-9pm recipient local, stricter per-state windows), shared opt-out list, TCPA consent for first touch, GSM-7 hygiene, NMLS footer + STOP language on first message, 12h de-dupe, and a daily cap. Returns one of: sent_imessage, sent_sms, held_unknown_timezone, held_outside_hours, skipped_opted_out, needs_consent, deduped, rate_limited, blocked_hygiene, error — each with a human-readable reason. Never sends silently.",
    {
      contactId: z.string().describe("The lead_id of the contact to message."),
      body: z.string().min(1).describe("The message text. Footer/opt-out language is added automatically; keep the core under 160 chars for a single segment."),
    },
    async ({ contactId, body }) => {
      const outcome = await sendMessage(env, contactId, body);
      return json(outcome);
    },
  );

  server.tool(
    "update_contact",
    "Update a contact's texting tags and/or lead status. Writes ONLY to the contact_texting sidecar table — it never mutates the Pages-owned leads table. Tags are a comma-free list; passing tags replaces the existing set.",
    {
      contactId: z.string().describe("The lead_id of the contact."),
      tags: z.array(z.string()).optional().describe("Replace the contact's texting tags with this set."),
      lead_status: z.string().optional().describe("Set the contact's lead status, e.g. 'contacted', 'qualified', 'dead'."),
    },
    async ({ contactId, tags, lead_status }) => {
      const lead = await getLeadById(env, contactId);
      if (!lead) return fail(`No lead found for contactId "${contactId}".`, "Use list_conversations or list_new_leads to find valid contactIds.");
      if (tags === undefined && lead_status === undefined) {
        return fail("Nothing to update.", "Provide tags and/or lead_status.");
      }
      await upsertContactTexting(env, contactId, {
        ...(tags !== undefined ? { tags: tags.map((t) => t.trim()).filter(Boolean).join(",") } : {}),
        ...(lead_status !== undefined ? { lead_status } : {}),
      });
      const ct = await getContactTexting(env, contactId);
      return json({
        contactId,
        updated: true,
        tags: ct?.tags ? ct.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
        lead_status: ct?.lead_status ?? null,
      });
    },
  );

  /* When the Render service is configured, also expose the crm_* tools that proxy
     its console API (leads, pipeline, todos, contacts, messages, flows, calling). */
  if (renderConfigured(env)) registerRenderTools(server, env);
}

/** Durable-Object-backed MCP agent (Streamable HTTP transport). Stateless logic —
 *  every tool reads/writes D1 directly — but McpAgent provides the transport + session.
 *  Bound in wrangler.toml as the MCP_OBJECT durable object; served at /mcp. */
export class TextingMCP extends McpAgent<Env> {
  server = new McpServer({ name: "smartr8-texting", version: "0.1.0" });

  async init(): Promise<void> {
    registerTools(this.server, this.env);
  }
}
