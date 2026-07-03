import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./env";
import { render, seg } from "./services/renderApi";

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(message: string, hint?: string) {
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: message, hint }, null, 2) }] };
}
/** Run a Render call and wrap success/error into a structured tool result. */
async function run(fn: () => Promise<unknown>) {
  try {
    return json(await fn());
  } catch (err) {
    return fail(String(err instanceof Error ? err.message : err));
  }
}

/**
 * Register the crm_* tools that proxy the Render console API. These operate on the
 * RENDER CRM (the same data as your /console: leads, pipeline, todos, contacts,
 * messages, flows, calling) — which is a DIFFERENT store than the website
 * lead-capture (D1) that the non-crm_ tools use. Only registered when the Render
 * base URL + passcode are configured.
 */
export function registerRenderTools(server: McpServer, env: Env): void {
  /* ── Find (the primary "look someone up" entry point) ────────────────── */

  server.tool(
    "find_contacts",
    "PRIMARY way to find/look up a person. Use this whenever the user asks to find, look up, search, or pull up a contact or lead BY NAME, phone, or email. Searches the CRM leads AND the GHL contacts and returns matches with name, phone, email, status, pipeline stage, and a contactId. If the match isLead, use its contactId with crm_get_lead / crm_send_message / get_conversation. (Do NOT use get_contact for this — that needs an exact id, not a name.)",
    { query: z.string().min(1).describe("Name, phone, or email — partial is fine.") },
    async ({ query }) => {
      try {
        const enc = encodeURIComponent(query);
        const norm = (p?: string) => { const d = String(p || "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : ""; };
        const leadsResp = (await render.get(env, `/api/leads?limit=200&q=${enc}`)) as { leads?: any[] };
        let ghlResp: { contacts?: any[] } = {};
        try { ghlResp = (await render.get(env, `/api/contacts?q=${enc}`)) as { contacts?: any[] }; } catch { /* GHL search is best-effort */ }
        const seen: Record<string, boolean> = {};
        const out: any[] = [];
        for (const l of leadsResp.leads ?? []) {
          const np = norm(l.phone); if (np) seen[np] = true;
          out.push({
            contactId: l.id,
            isLead: true,
            name: [l.first_name, l.last_name].filter(Boolean).join(" ") || l.email || l.phone || "(no name)",
            phone: l.phone, email: l.email, status: l.status, stage: l.pipeline_stage,
          });
        }
        for (const c of ghlResp.contacts ?? []) {
          const np = norm(c.phone); if (np && seen[np]) continue;
          out.push({ contactId: c.id, isLead: false, name: c.name, phone: c.phone, source: "ghl" });
        }
        return json({ query, count: out.length, contacts: out });
      } catch (err) {
        return fail(String(err instanceof Error ? err.message : err), "Is the Render API configured/awake?");
      }
    },
  );

  /* ── Leads / Pipeline / Past clients ─────────────────────────────────── */

  server.tool(
    "crm_list_leads",
    "List/search leads in the Render CRM (the Leads tab). Optional q (name/phone/email search), status, stage (pipeline stage), pastClient (true = Past Clients segment), deleted, limit. Returns leads + status counts.",
    {
      q: z.string().optional().describe("Search by name, phone, or email."),
      status: z.string().optional().describe("Filter by lead status."),
      stage: z.string().optional().describe("Filter by pipeline stage name."),
      pastClient: z.boolean().optional().describe("True = only the Past Clients segment."),
      deleted: z.boolean().optional().describe("True = show soft-deleted leads."),
      limit: z.number().int().min(1).max(500).optional(),
    },
    async ({ q, status, stage, pastClient, deleted, limit }) => {
      const p = new URLSearchParams();
      if (q) p.set("q", q);
      if (status) p.set("status", status);
      if (stage) p.set("stage", stage);
      if (pastClient) p.set("pastClient", "1");
      if (deleted) p.set("deleted", "1");
      if (limit) p.set("limit", String(limit));
      const qs = p.toString();
      return run(() => render.get(env, `/api/leads${qs ? `?${qs}` : ""}`));
    },
  );

  server.tool(
    "crm_get_lead",
    "Get a Render CRM lead's full detail by id: the lead record, DNC (do-not-contact) status, notes, and the activity timeline.",
    { leadId: z.string().describe("The Render CRM lead id.") },
    async ({ leadId }) => run(() => render.get(env, `/api/leads/${seg(leadId)}`)),
  );

  server.tool(
    "crm_pipeline",
    "Get the pipeline board: the ordered stage definitions and every lead with a last-message snippet (the Pipeline tab).",
    {},
    async () => run(() => render.get(env, "/api/pipeline")),
  );

  server.tool(
    "crm_update_lead",
    "Update a Render CRM lead: set status, move pipeline_stage, set owner, or flag past_client. (pipeline_stage must be a valid board stage — the error lists allowed values.)",
    {
      leadId: z.string().describe("The Render CRM lead id."),
      status: z.string().optional(),
      pipeline_stage: z.string().optional().describe("Move the lead to this pipeline stage."),
      owner: z.string().optional(),
      past_client: z.boolean().optional().describe("Flag/unflag as a past client."),
    },
    async ({ leadId, ...patch }) => {
      const body = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      if (!Object.keys(body).length) return fail("Nothing to update.", "Pass at least one of status, pipeline_stage, owner, past_client.");
      return run(() => render.patch(env, `/api/leads/${seg(leadId)}`, body));
    },
  );

  server.tool(
    "crm_add_note",
    "Add a note to a Render CRM lead's timeline.",
    {
      leadId: z.string(),
      body: z.string().min(1).describe("The note text."),
      author: z.string().optional().describe("Who wrote it (defaults to the system)."),
    },
    async ({ leadId, body, author }) => run(() => render.post(env, `/api/leads/${seg(leadId)}/notes`, { body, author })),
  );

  server.tool(
    "crm_set_dnc",
    "Add or remove a lead's phone on the Do-Not-Contact list (suppresses all texts, calls, and voicemail). Adding also pauses any in-flight drip.",
    {
      leadId: z.string(),
      on: z.boolean().optional().describe("true (default) = add to DNC; false = remove."),
      note: z.string().optional(),
    },
    async ({ leadId, on, note }) => run(() => render.post(env, `/api/leads/${seg(leadId)}/dnc`, { on: on ?? true, note })),
  );

  /* ── To-Do / tasks ───────────────────────────────────────────────────── */

  server.tool(
    "crm_list_todos",
    "List all open to-do tasks across leads, newest first (the To-Do tab). Pass done=true to include completed items.",
    { done: z.boolean().optional() },
    async ({ done }) => run(() => render.get(env, `/api/todos${done ? "?done=1" : ""}`)),
  );

  server.tool(
    "crm_add_todo",
    "Add a to-do task to a lead.",
    { leadId: z.string(), text: z.string().min(1).describe("The task text.") },
    async ({ leadId, text }) => run(() => render.post(env, `/api/leads/${seg(leadId)}/todos`, { text })),
  );

  server.tool(
    "crm_complete_todo",
    "Mark a lead's to-do task done (or not done).",
    { leadId: z.string(), todoId: z.string(), done: z.boolean().describe("true = completed, false = reopen.") },
    async ({ leadId, todoId, done }) => run(() => render.patch(env, `/api/leads/${seg(leadId)}/todos/${seg(todoId)}`, { done })),
  );

  /* ── Contacts + Messages ─────────────────────────────────────────────── */

  server.tool(
    "crm_search_contacts",
    "Search contacts (the Contacts tab). q matches name/phone/email; returns up to 25.",
    { q: z.string().optional().describe("Search query.") },
    async ({ q }) => run(() => render.get(env, `/api/contacts${q ? `?q=${encodeURIComponent(q)}` : ""}`)),
  );

  server.tool(
    "crm_get_thread",
    "Get the recent message thread for a contact id (the Messages tab thread view).",
    { contactId: z.string().describe("The contact id (from crm_search_contacts / crm_list_conversations).") },
    async ({ contactId }) => run(() => render.get(env, `/api/messages/${seg(contactId)}`)),
  );

  server.tool(
    "crm_list_conversations",
    "List recent conversations across all contacts (the Messages inbox).",
    {},
    async () => run(() => render.get(env, "/api/conversations")),
  );

  server.tool(
    "crm_send_message",
    "Send a text via the Render service (iMessage-first -> SMS, DNC-checked). Provide leadId (logs to the lead timeline) OR a contactId/phone. NOTE: this uses Render's send path (DNC gate), NOT the stricter TCPA compliance engine in the non-crm_ send_message tool.",
    {
      leadId: z.string().optional().describe("Render CRM lead id (preferred — logs to the timeline)."),
      contactId: z.string().optional().describe("Contact id (if not sending by leadId)."),
      phone: z.string().optional().describe("E.164 phone (if no leadId/contactId)."),
      message: z.string().min(1),
    },
    async ({ leadId, contactId, phone, message }) => {
      if (leadId) return run(() => render.post(env, `/api/leads/${seg(leadId)}/message`, { message }));
      if (contactId || phone) return run(() => render.post(env, "/api/messages/send", { contactId, phone, message }));
      return fail("Pass leadId, contactId, or phone.");
    },
  );

  /* ── Flows (automations) ─────────────────────────────────────────────── */

  server.tool(
    "crm_list_automations",
    "List the automation flows (the Flows tab): name, trigger, enabled state, steps.",
    {},
    async () => run(() => render.get(env, "/api/automations")),
  );

  server.tool(
    "crm_automation_activity",
    "Recent automation step outcomes (what sent vs skipped, and why) — flow diagnostics.",
    { limit: z.number().int().min(1).max(200).optional() },
    async ({ limit }) => run(() => render.get(env, `/api/automations/activity${limit ? `?limit=${limit}` : ""}`)),
  );

  server.tool(
    "crm_toggle_automation",
    "Enable or disable an automation flow by id.",
    { automationId: z.string(), enabled: z.boolean() },
    async ({ automationId, enabled }) => run(() => render.patch(env, `/api/automations/${seg(automationId)}`, { enabled })),
  );

  server.tool(
    "crm_enroll_lead",
    "Enroll a lead into the new-lead automation sequence (fires the lead_created trigger). Returns how many steps started.",
    { leadId: z.string() },
    async ({ leadId }) => run(() => render.post(env, `/api/leads/${seg(leadId)}/run-automation`, {})),
  );

  /* ── Calling (manual click-to-call only) ─────────────────────────────── */

  server.tool(
    "crm_click_to_call",
    "Place a manual click-to-call for a lead: it rings YOUR cell first, then dials the lead and bridges. DNC-checked. (Does not expose the bulk auto-dialer.)",
    { leadId: z.string() },
    async ({ leadId }) => run(() => render.post(env, `/api/leads/${seg(leadId)}/call`, {})),
  );

  server.tool(
    "crm_call_queue",
    "View the current automated-call queue (read-only).",
    {},
    async () => run(() => render.get(env, "/calls/queue")),
  );
}
