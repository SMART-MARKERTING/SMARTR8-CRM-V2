import { randomUUID } from "crypto";
import path from "path";
import { Router, Request, Response, raw } from "express";
import { config } from "../config";
import { log } from "../logger";
import { requirePass, requireAdmin, requirePortalVerified } from "../util/auth";
import { getUser, listUsers } from "../services/auth";
import { sendOutbound } from "../services/router";
import { startClickToCall } from "../services/clickToCall";
import {
  createLead,
  getLead,
  listLeads,
  updateLead,
  setSmsConsent,
  deleteLead,
  restoreLead,
  findLead,
  addNote,
  listNotes,
  listActivities,
  getActivity,
  deleteActivity,
  restoreActivity,
  listDeletedActivities,
  addTodo,
  setTodoDone,
  deleteTodo,
  restoreTodo,
  listAllTodos,
  listDeletedTodos,
  logActivity,
  leadStats,
  listPipeline,
  bulkCreateContacts,
  contactsDiag,
  LeadInput,
  Lead,
  LeadStatus,
  resolveLeadTimezone,
} from "../services/leads";
import { listAllContacts } from "../services/ghl";
import { sendEmail, emailConfigured } from "../services/email";
import { renderBrandedEmailHtml, emailSignatureText, emailFooterText } from "../brand";
import { unsubscribeUrl, isEmailUnsubscribed } from "../services/unsubscribe";
import { getMeta, setMeta, listCallLog, dismissDashboardItem, clearDashboardKind, dashboardClearedAt, dismissedDashboardIds } from "../store/db";
import { db } from "../store/db";
import {
  listAutomations,
  getAutomation,
  createAutomation,
  updateAutomation,
  fireTrigger,
  stopLeadAutomations,
  resumeLeadAutomations,
  leadCampaignState,
  enrollLeadInAutomation,
  advancePhase,
  rewindPhase,
  diagnoseEnrollment,
  markPastClient,
  getAutomationHealth,
  recentAutomationActivity,
  Step,
} from "../services/automations";
import { categorize } from "../services/tagging";
import { addToDnc, removeFromDnc, isOnDnc } from "../services/dnc";
import { withinCallingHours } from "../services/compliance";
import { auditSources, purgeImported, revertImportDamage, dedupeContacts } from "../services/importCleanup";
import { reactToMessage, BlueBubblesReaction } from "../services/bluebubbles";
import { buildMismo34, mismoFilename } from "../services/mismo";
import { getMismoReadiness } from "../services/mismoReadiness";
import { validateMismoExport } from "../services/mismoValidation";
import { recordMismoExport, listMismoExports } from "../services/mismoAudit";
import { latestAusPreview, listAusSubmissions, runAusPreview } from "../services/aus";
import { getLosReadiness } from "../services/losReadiness";
import { dropVoicemail, voicemailConfigured } from "../services/voicemail";
import {
  getDefaultVoicemailAudioUrl,
  publicVoicemailAudioSettings,
  saveDefaultVoicemailAudio,
} from "../services/voicemailSettings";
import {
  borrowerSensitiveConfigured,
  getBorrowerSensitiveData,
  saveBorrowerSensitiveData,
  BorrowerSensitiveData,
} from "../services/borrowerSensitive";
import {
  startApplication,
  requestCreditPull,
  requestTitleOrder,
  requestFloodReport,
  LoanServiceResult,
  LoanServiceRequestOptions,
} from "../services/loanServices";
import { getLeadDocument, getLeadDocumentPath, listLeadDocuments, saveLeadDocument, softDeleteLeadDocument } from "../services/documents";
import { listSettlementVendorSettings, saveSettlementVendorSettings, SettlementVendorKind } from "../services/loanServiceSettings";
import { mimeForExt, publicMediaUrl, supportedMediaExt, writeMediaFile } from "../services/media";
import {
  generateVoicemailAudio,
  publicElevenLabsSettings,
  saveElevenLabsSettings,
} from "../services/elevenLabs";
import { verifyToken } from "../util/token";
import { PIPELINE_STAGES, DEFAULT_STAGE, isPipelineStage } from "../pipeline";
import { getContactMessages } from "../services/ghl";
import { sendLeadEvent } from "../services/metaCapi";

export const crmRouter = Router();

// ── Public website lead intake ───────────────────────────────────────────────
// Point your site's form/webhook at:  POST https://<host>/webhooks/lead?key=SECRET
// Body is flexible: first_name/last_name (or name), email, phone, source, plus any
// extra fields (captured into `custom`). Creates the lead and fires `lead_created`.

const KNOWN_FIELDS = new Set([
  "first_name",
  "firstName",
  "last_name",
  "lastName",
  "name",
  "full_name",
  "fullName",
  "email",
  "phone",
  "phone_number",
  "phoneNumber",
  "source",
  "timezone",
  "consent",
  "tags",
  "key",
  "pass",
  "loanType",
  "loan_type",
  "message",
  "smsOptIn",
  "sms_opt_in",
  "timeline",
]);

function pickStr(body: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/** Anything not a known field is preserved as a custom field on the lead. */
function customFrom(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!KNOWN_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

// The website funnels post the qualifying criteria inside a `notes` blob, e.g.
//   Home Value: 500000
//   Mortgage Balance: 100000
//   Credit Score: Excellent (740+)
//   DOB: 06/29/1978
// Map those labels onto the lead's custom quote-detail keys so the CRM's
// Quote/loan-details panel (and the Contact-details DOB field) pre-fill.
const NOTE_LABEL_MAP: Record<string, string> = {
  "home value": "home_value",
  "mortgage balance": "mortgage_balance",
  "credit score": "credit",
  "credit band": "credit",
  credit: "credit",
  "loan amount": "loan_amount",
  "cash out": "cash_out",
  "cash-out": "cash_out",
  "cash-out amount": "cash_out",
  "monthly payment": "monthly_payment",
  "loan purpose": "loan_goal",
  "loan goal": "loan_goal",
  purpose: "loan_goal",
  goal: "loan_goal",
  "use of funds": "loan_goal",
  dob: "dob",
  "date of birth": "dob",
};

/** Normalize a date of birth to YYYY-MM-DD (so the <input type=date> shows it). */
function normalizeDob(s: string): string {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // MM/DD/YYYY
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return s.trim(); // already ISO, or unknown format — preserved as-is
}

/** Pull known quote/DOB fields out of a freeform notes/message blob. */
function quoteFieldsFromNotes(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text) return out;
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = NOTE_LABEL_MAP[line.slice(0, idx).trim().toLowerCase()];
    const value = line.slice(idx + 1).trim();
    if (!key || !value) continue;
    out[key] = key === "dob" ? normalizeDob(value) : value;
  }
  return out;
}

function firstCustomValue(custom: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = custom[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return undefined;
}

function applyQuoteAliases(custom: Record<string, unknown>): void {
  const aliases: Record<string, string[]> = {
    home_value: [
      "homeValue",
      "Home Value",
      "estimated_home_value",
      "estimatedHomeValue",
      "estimated_value",
      "estimatedValue",
      "property_value",
      "propertyValue",
      "home_estimate",
      "homeEstimate",
    ],
    mortgage_balance: [
      "mortgageBalance",
      "Mortgage Balance",
      "loan_balance_remaining",
      "loanBalanceRemaining",
      "current_balance",
      "currentBalance",
      "current_mortgage_balance",
      "currentMortgageBalance",
      "payoff",
      "payoff_amount",
      "payoffAmount",
    ],
  };
  for (const [canonical, keys] of Object.entries(aliases)) {
    if (custom[canonical] !== undefined && String(custom[canonical]).trim() !== "") continue;
    const value = firstCustomValue(custom, keys);
    if (value !== undefined) custom[canonical] = value;
  }
}

crmRouter.post("/webhooks/lead", (req: Request, res: Response) => {
  // Secret gate (separate from APP_PASSCODE so the website can post without it).
  const expected = config.crm.leadWebhookSecret;
  if (!expected) {
    res.status(503).json({ error: "LEAD_WEBHOOK_SECRET not set on the server" });
    return;
  }
  const provided =
    (typeof req.query.key === "string" ? req.query.key : undefined) ||
    req.get("x-lead-secret") ||
    (req.body && typeof req.body.key === "string" ? req.body.key : undefined);
  if (provided !== expected) {
    res.status(401).json({ error: "bad lead secret" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  log.info("lead intake received", {
    source: typeof body.source === "string" ? body.source : undefined,
    hasEmail: typeof body.email === "string" && body.email.trim().length > 0,
    hasPhone: typeof body.phone === "string" && body.phone.trim().length > 0,
    fieldCount: Object.keys(body).length,
  });
  const phone = pickStr(body, ["phone", "phone_number", "phoneNumber"]);
  const loanType = pickStr(body, ["loanType", "loan_type"]);
  // The smartr8.com capture worker (submit-lead → orchestrate) posts the product page as
  // `funnel` and sends NO loanType, so without this every funnel lead fell to GENERAL.
  const funnel = pickStr(body, ["funnel"]);
  const message = pickStr(body, ["message"]);
  const timeline = pickStr(body, ["timeline"]);
  const smsOptIn = (pickStr(body, ["smsOptIn", "sms_opt_in"]) ?? "").toLowerCase() === "yes";

  // Step 1 + 2: tag by intent and pick the campaign.
  const tag = categorize({ loanType, message, funnel });

  const custom = customFrom(body);
  if (loanType) custom.loanType = loanType;
  if (funnel) custom.funnel = funnel;
  if (timeline) custom.timeline = timeline;
  if (message) custom.message = message;
  // Keep the form's raw SMS opt-in answer on file (record only — it no longer gates sends).
  const smsOptInRaw = pickStr(body, ["smsOptIn", "sms_opt_in"]);
  if (smsOptInRaw) custom.smsOptIn = smsOptInRaw;

  // Pull Home Value / Mortgage Balance / Credit / DOB out of the notes (or message)
  // blob into the canonical quote keys — without overwriting any explicit structured
  // field the funnel already sent. DOB is normalized so the date picker shows it.
  const parsedQuote = quoteFieldsFromNotes(pickStr(body, ["notes"]) ?? message);
  for (const [k, v] of Object.entries(parsedQuote)) {
    if (custom[k] === undefined || custom[k] === "") custom[k] = v;
  }
  applyQuoteAliases(custom);
  if (typeof custom.dob === "string") custom.dob = normalizeDob(custom.dob);

  const input: LeadInput = {
    first_name: pickStr(body, ["first_name", "firstName"]),
    last_name: pickStr(body, ["last_name", "lastName"]),
    name: pickStr(body, ["name", "full_name", "fullName"]),
    email: pickStr(body, ["email"]),
    phone,
    source: pickStr(body, ["source"]) ?? "website",
    timezone: pickStr(body, ["timezone"]),
    consent: body.consent === undefined ? true : Boolean(body.consent), // website opt-in implies email consent
    // Texting is on by default (suppression = the DNC list). An explicit smsOptIn:"yes"
    // additionally stamps consent_at so the express-consent record is kept on file.
    sms_consent: smsOptIn && Boolean(phone) ? true : undefined,
    category: tag.category,
    category_reason: tag.reason,
    campaign: tag.campaign,
    custom,
  };
  if (!input.phone && !input.email) {
    res.status(400).json({ error: "lead needs at least a phone or an email" });
    return;
  }

  try {
    // Dedup: an existing lead with the same phone/email is updated (and re-submission
    // noted) rather than duplicated — and we do NOT re-fire the automation for it.
    const existing = findLead({ phone: input.phone, email: input.email });
    if (existing) {
      updateLead(existing.id, {
        first_name: input.first_name ?? existing.first_name ?? undefined,
        last_name: input.last_name ?? existing.last_name ?? undefined,
        email: input.email ?? existing.email ?? undefined,
        phone: input.phone ?? existing.phone ?? undefined,
        category: input.category,
        category_reason: input.category_reason,
        campaign: input.campaign,
        // Merge the latest quote details / DOB in (re-submits refresh the panel) while
        // keeping anything previously captured.
        custom: { ...(existing.custom ?? {}), ...custom },
        // Only ever UPGRADE SMS consent on a re-submit — never revoke prior consent.
        ...(input.sms_consent ? { sms_consent: true } : {}),
      });
      logActivity(existing.id, {
        type: "lead_created",
        direction: "inbound",
        channel: "system",
        body: `Re-submitted via ${input.source}`,
        meta: input.custom,
      });
      // Fire the drip even for a duplicate so the text/email goes out regardless of
      // duplicate status. Cancel any in-flight steps first so the sequence restarts
      // cleanly instead of stacking concurrent drips. (send_text still gates on the
      // DNC list + quiet hours — this never bypasses those.)
      stopLeadAutomations(existing.id, "re-submitted — restarting drip");
      const fresh = getLead(existing.id)!;
      const restarted = fireTrigger("lead_created", fresh);
      const diag = diagnoseEnrollment("lead_created", fresh);
      res.json({ ok: true, leadId: existing.id, duplicate: true, automationStarted: restarted, note: diag.note ?? undefined });
      return;
    }

    const lead = createLead(input);
    // Fire a server-side Meta "Lead" conversion (best-effort, never blocks intake). Pull the
    // browser match signals the funnel forwarded (cookies/IP/UA/page URL); fall back to the
    // request's own headers. No-op when META_CAPI_TOKEN is unset.
    const xff = (req.get("x-forwarded-for") || "").split(",")[0].trim();
    void sendLeadEvent(lead, {
      fbp: pickStr(body, ["fbp", "_fbp"]),
      fbc: pickStr(body, ["fbc", "_fbc"]),
      clientIp: pickStr(body, ["client_ip", "clientIp", "ip"]) || xff || req.ip,
      clientUserAgent: pickStr(body, ["client_user_agent", "userAgent"]) || req.get("user-agent") || undefined,
      eventSourceUrl: pickStr(body, ["page_url", "pageUrl", "url", "source_url"]) || (funnel || undefined),
    }).catch(() => {});
    const started = fireTrigger("lead_created", lead);
    // Explain a 0-enrollment right in the response + logs, so "nothing texted"
    // comes with the reason instead of being silent.
    const diag = diagnoseEnrollment("lead_created", lead);
    if (diag.note) log.warn("lead intake: enrollment caveat", { leadId: lead.id, started, note: diag.note });
    res.json({
      ok: true,
      leadId: lead.id,
      duplicate: false,
      category: tag.category,
      campaign: tag.campaign,
      smsConsent: input.sms_consent,
      automationStarted: started,
      note: diag.note ?? undefined,
    });
  } catch (err) {
    log.error("lead intake error", { err: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

// ── Email unsubscribe (CAN-SPAM) ─────────────────────────────────────────────
// Public link embedded in every nurture email: /unsubscribe?lead=<id>&t=<token>.
// Honored immediately (sets email_unsubscribed); GET and POST both work.
crmRouter.all("/unsubscribe", (req, res) => {
  const leadId = (typeof req.query.lead === "string" ? req.query.lead : "") || (req.body?.lead ?? "");
  const token = (typeof req.query.t === "string" ? req.query.t : "") || (req.body?.t ?? "");
  const page = (msg: string) =>
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<body style="font-family:system-ui;text-align:center;padding:2.5rem;max-width:34rem;margin:auto">` +
    `<h2>Mykoal DeShazo</h2><p style="font-size:1.05rem;color:#333">${msg}</p></body>`;
  if (!leadId || !verifyToken(leadId, token)) {
    res.status(400).send(page("This unsubscribe link is invalid or expired."));
    return;
  }
  const lead = getLead(leadId);
  if (!lead) {
    res.status(404).send(page("We could not find that subscription."));
    return;
  }
  updateLead(leadId, { email_unsubscribed: true });
  logActivity(leadId, { type: "email", direction: "inbound", channel: "email", body: "Unsubscribed from emails", status: "unsubscribed" });
  res.send(page("You have been unsubscribed from our emails. You will not receive further messages."));
});

// ── Console API (passcode-gated) ─────────────────────────────────────────────

/** Pipeline board: stage definitions (name + color) + all leads with a last-message snippet. */
crmRouter.get("/api/pipeline", requirePass, (req, res) => {
  res.json({ stages: PIPELINE_STAGES, leads: listPipeline(1000, ownerScope(req)) });
});

/** Stage DEFINITIONS only (no lead query). The Leads tab, lead detail, and dashboard only
 *  need the stage names/colors, so they hit this instead of /api/pipeline — which would
 *  otherwise run a 1000-lead correlated subquery on every load and made the Leads tab slow. */
crmRouter.get("/api/pipeline/stages", requirePass, (_req, res) => {
  res.json({ stages: PIPELINE_STAGES });
});

/** One-shot snapshot for the landing Dashboard: today's messaging + call volume, missed-call
 *  list, lead status / stage counts, recent inbound replies, and the commission roll-up. Every
 *  item carries a leadId where applicable so the console can deep-link straight to the lead. */
crmRouter.get("/api/dashboard", requirePass, (req, res) => {
  try {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const startOfYear = new Date(now.getFullYear(), 0, 1).getTime();
    const one = (sql: string, ...params: unknown[]): number =>
      ((db.prepare(sql).get(...params) as { n: number } | undefined)?.n) ?? 0;

    // Non-admins see only their own leads' numbers. These fragments append an owner filter
    // (and an extra positional arg) to each panel's query; admins get empty fragments = all.
    const owner = ownerScope(req);
    const leadOwn = owner ? ` AND owner_user_id = ?` : ""; // leads table
    const actOwn = owner ? ` AND lead_id IN (SELECT id FROM leads WHERE owner_user_id = ?)` : ""; // activities / call_log
    const ownArg: unknown[] = owner ? [owner] : [];
    const ownedIds = owner
      ? new Set((db.prepare(`SELECT id FROM leads WHERE owner_user_id = ?`).all(owner) as Array<{ id: string }>).map((x) => x.id))
      : null;

    // Dashboard "clear" state: per-item dismissals + a "clear all" cutoff per panel.
    const dismissedReplies = dismissedDashboardIds("reply");
    const repliesClearedAt = dashboardClearedAt("reply");
    const dismissedLeads = dismissedDashboardIds("lead");
    const leadsClearedAt = dashboardClearedAt("lead");

    const textsSentToday = one(
      `SELECT COUNT(*) n FROM (
         SELECT lead_id, type, COALESCE(channel, '') channel, TRIM(COALESCE(body, '')) body
           FROM activities
          WHERE deleted_at IS NULL
            AND type IN ('sms','imessage')
            AND direction='outbound'
            AND created_at >= ?
            AND status IN ('sent','imessage-success','imessage-timeout','fellback-to-sms')${actOwn}
          GROUP BY lead_id, type, COALESCE(channel, ''), TRIM(COALESCE(body, ''))
       )`,
      startOfDay,
      ...ownArg,
    );
    const textsReceivedToday = one(
      `SELECT COUNT(*) n FROM activities WHERE deleted_at IS NULL AND type IN ('sms','imessage') AND direction='inbound' AND created_at >= ?${actOwn}`,
      startOfDay,
      ...ownArg,
    );
    const callsInToday = one(`SELECT COUNT(*) n FROM call_log WHERE deleted_at IS NULL AND direction='inbound' AND created_at >= ?${actOwn}`, startOfDay, ...ownArg);
    const callsOutToday = one(`SELECT COUNT(*) n FROM call_log WHERE deleted_at IS NULL AND direction='outbound' AND created_at >= ?${actOwn}`, startOfDay, ...ownArg);
    const callsMissedToday = one(
      `SELECT COUNT(*) n FROM call_log WHERE deleted_at IS NULL AND direction='inbound' AND outcome='missed' AND created_at >= ?${actOwn}`,
      startOfDay,
      ...ownArg,
    );
    const newLeadsToday = one(
      `SELECT COUNT(*) n FROM leads WHERE deleted_at IS NULL AND contact_only = 0 AND created_at >= ?${leadOwn}`,
      startOfDay,
      ...ownArg,
    );
    const newLeadsThisWeek = one(
      `SELECT COUNT(*) n FROM leads WHERE deleted_at IS NULL AND contact_only = 0 AND created_at >= ?${leadOwn}`,
      startOfDay - 6 * 86_400_000,
      ...ownArg,
    );

    // Missed-call panel (last 25). leadId is carried so the dashboard row → lead detail.
    const missedCalls = listCallLog(200)
      .filter((c) => c.direction === "inbound" && c.outcome === "missed")
      .filter((c) => !ownedIds || (c.lead_id != null && ownedIds.has(c.lead_id)))
      .slice(0, 25)
      .map((c) => ({
        id: c.id,
        at: c.created_at,
        phone: c.phone,
        name: c.name,
        leadId: c.lead_id,
      }));

    // Status + stage rollups (active pipeline only — past clients & contact-only excluded).
    const statusRows = db
      .prepare(
        `SELECT status, COUNT(*) n FROM leads
         WHERE deleted_at IS NULL AND past_client = 0 AND contact_only = 0${leadOwn} GROUP BY status`,
      )
      .all(...ownArg) as Array<{ status: string; n: number }>;
    const stageRows = db
      .prepare(
        `SELECT pipeline_stage stage, COUNT(*) n FROM leads
         WHERE deleted_at IS NULL AND past_client = 0 AND contact_only = 0${leadOwn} GROUP BY pipeline_stage`,
      )
      .all(...ownArg) as Array<{ stage: string; n: number }>;
    const byStatus: Record<string, number> = {};
    statusRows.forEach((r) => { byStatus[r.status] = r.n; });
    const byStage: Record<string, number> = {};
    stageRows.forEach((r) => { byStage[r.stage] = r.n; });

    // Recent inbound replies (last 15) — each one clickable straight to the lead.
    const replyRows = db
      .prepare(
        `SELECT a.id, a.lead_id, a.body, a.created_at, l.first_name, l.last_name, l.phone, l.email
           FROM activities a JOIN leads l ON l.id = a.lead_id
          WHERE a.type IN ('sms','imessage') AND a.direction='inbound' AND l.deleted_at IS NULL${owner ? " AND l.owner_user_id = ?" : ""}
          ORDER BY a.created_at DESC LIMIT 60`,
      )
      .all(...ownArg) as Array<{ id: string; lead_id: string; body: string | null; created_at: number; first_name: string | null; last_name: string | null; phone: string | null; email: string | null }>;
    const recentReplies = replyRows
      .filter((r) => !dismissedReplies.has(r.id) && r.created_at > repliesClearedAt)
      .slice(0, 25)
      .map((r) => ({
        id: r.id,
        leadId: r.lead_id,
        name: [r.first_name, r.last_name].filter(Boolean).join(" ") || r.phone || r.email || "(no name)",
        body: r.body || "",
        at: r.created_at,
      }));

    // Newest leads = the fresh "Lead-In" queue (every untouched new lead), newest first.
    // Dismissed/"cleared" ones drop off the panel (the lead itself is untouched).
    const recentLeadRows = db
      .prepare(
        `SELECT id, first_name, last_name, phone, email, source, created_at, pipeline_stage, status
           FROM leads WHERE deleted_at IS NULL AND contact_only = 0 AND past_client = 0 AND pipeline_stage = 'Lead-In'${leadOwn}
          ORDER BY created_at DESC LIMIT 300`,
      )
      .all(...ownArg) as Array<{ id: string; first_name: string | null; last_name: string | null; phone: string | null; email: string | null; source: string | null; created_at: number; pipeline_stage: string; status: string }>;
    const recentLeads = recentLeadRows
      .filter((r) => !dismissedLeads.has(r.id) && r.created_at > leadsClearedAt)
      .slice(0, 100)
      .map((r) => ({
        leadId: r.id,
        name: [r.first_name, r.last_name].filter(Boolean).join(" ") || r.phone || r.email || "(no name)",
        source: r.source,
        stage: r.pipeline_stage,
        status: r.status,
        at: r.created_at,
      }));

    // Commission roll-up. Stored at lead.custom.commission as a string (formatted with $/,);
    // we strip those and sum. Bucketed by lead created_at (good enough until a separate
    // funded_at exists). Past clients are INCLUDED so historical commission still shows.
    const commissionRows = db
      .prepare(
        `SELECT id, first_name, last_name, custom, created_at, past_client, pipeline_stage
           FROM leads WHERE deleted_at IS NULL
            AND custom LIKE '%"commission"%'
            AND (@owner IS NULL OR owner_user_id = @owner)`,
      )
      .all({ owner: owner || null }) as Array<{ id: string; first_name: string | null; last_name: string | null; custom: string; created_at: number; past_client: number; pipeline_stage: string }>;
    // When did each lead fund? Use the latest "Stage: … → Funded" timeline entry; that's the
    // funded date. (Leads set straight to Funded without a logged stage change fall back to
    // created_at below.) Lets us bucket "funded this month" by the actual funding date.
    const fundedAtRows = db
      .prepare(
        `SELECT lead_id, MAX(created_at) at FROM activities
           WHERE type = 'stage_change' AND body LIKE '%Funded'
           GROUP BY lead_id`,
      )
      .all() as Array<{ lead_id: string; at: number }>;
    const fundedAt = new Map<string, number>(fundedAtRows.map((r) => [r.lead_id, r.at]));
    const parseAmount = (raw: unknown): number => {
      if (raw == null) return 0;
      const s = String(raw).replace(/[^0-9.\-]/g, "");
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : 0;
    };
    let totalCommission = 0;
    let monthCommission = 0; // commission on deals FUNDED this calendar month
    let monthFundedCount = 0;
    let ytdCommission = 0;
    let processingCommission = 0; // commission on deals not yet funded (and not lost)
    let processingCount = 0;
    const commissionLeads: Array<{ leadId: string; name: string; amount: number; at: number }> = [];
    for (const r of commissionRows) {
      let custom: Record<string, unknown> = {};
      try { custom = JSON.parse(r.custom) as Record<string, unknown>; } catch { /* skip bad row */ }
      const amount = parseAmount(custom.commission);
      if (amount <= 0) continue;
      totalCommission += amount;
      if (r.created_at >= startOfYear) ytdCommission += amount;
      if (r.pipeline_stage === "Funded") {
        // "Funded this month" — bucket by the date the deal funded, not when the lead came in.
        const at = fundedAt.get(r.id) ?? r.created_at;
        if (at >= startOfMonth) {
          monthCommission += amount;
          monthFundedCount += 1;
        }
      } else if (r.pipeline_stage !== "Lost") {
        // "In processing" = the deal hasn't funded yet (still being worked) and isn't lost.
        processingCommission += amount;
        processingCount += 1;
      }
      commissionLeads.push({
        leadId: r.id,
        name: [r.first_name, r.last_name].filter(Boolean).join(" ") || "(no name)",
        amount,
        at: r.created_at,
      });
    }
    commissionLeads.sort((a, b) => b.at - a.at);

    res.json({
      today: {
        textsSent: textsSentToday,
        textsReceived: textsReceivedToday,
        callsInbound: callsInToday,
        callsOutbound: callsOutToday,
        callsMissed: callsMissedToday,
        newLeads: newLeadsToday,
      },
      week: { newLeads: newLeadsThisWeek },
      missedCalls,
      todos: listAllTodos({ ownerUserId: owner }).slice(0, 25),
      byStatus,
      byStage,
      recentReplies,
      recentLeads,
      commission: {
        total: totalCommission,
        thisMonth: monthCommission,
        thisMonthCount: monthFundedCount,
        ytd: ytdCommission,
        processing: processingCommission,
        processingCount: processingCount,
        count: commissionLeads.length,
        recent: commissionLeads.slice(0, 10),
      },
      serverTime: now.toISOString(),
    });
  } catch (err) {
    log.error("dashboard error", { err: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

/** Dismiss one dashboard item (reply/lead) from its panel — non-destructive.
 *  Body: { kind: 'reply'|'lead', id }. */
crmRouter.post("/api/dashboard/dismiss", requirePass, (req, res) => {
  const body = (req.body ?? {}) as { kind?: string; id?: string };
  if ((body.kind !== "reply" && body.kind !== "lead") || !body.id) {
    res.status(400).json({ error: "pass { kind: 'reply'|'lead', id }" });
    return;
  }
  dismissDashboardItem(body.kind, body.id);
  res.json({ ok: true });
});

/** Clear all items from a dashboard panel (sets a cutoff; underlying records untouched).
 *  Body: { kind: 'reply'|'lead' }. */
crmRouter.post("/api/dashboard/clear", requirePass, (req, res) => {
  const body = (req.body ?? {}) as { kind?: string };
  if (body.kind !== "reply" && body.kind !== "lead") {
    res.status(400).json({ error: "pass { kind: 'reply'|'lead' }" });
    return;
  }
  clearDashboardKind(body.kind);
  res.json({ ok: true });
});

/** Set or clear a lead's commission from the dashboard (merge-safe — keeps other custom
 *  fields). Body: { amount } — blank/0/missing clears it. */
crmRouter.post("/api/leads/:id/commission", requirePass, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  const raw = (req.body ?? {}).amount;
  const custom: Record<string, unknown> = { ...(lead.custom || {}) };
  const cleaned = raw == null ? "" : String(raw).replace(/[^0-9.\-]/g, "");
  const n = parseFloat(cleaned);
  if (!cleaned || !Number.isFinite(n) || n <= 0) delete custom.commission;
  else custom.commission = cleaned;
  const updated = updateLead(lead.id, { custom });
  res.json({ ok: true, lead: updated });
});

/** Lead list + status counts for the CRM tab. */
/** Owner filter for the requester: admins see all leads (undefined); a non-admin user sees
 *  only the leads assigned to them. */
function ownerScope(req: Request): string | undefined {
  return req.authUser && req.authUser.role !== "admin" ? req.authUser.id : undefined;
}

function accessibleLead(req: Request, res: Response): Lead | null {
  const lead = getLead(req.params.id);
  if (!lead) {
    res.status(404).json({ error: "lead not found" });
    return null;
  }
  const owner = ownerScope(req);
  if (owner && lead.owner_user_id !== owner) {
    res.status(403).json({ error: "this lead is assigned to another user" });
    return null;
  }
  return lead;
}

function publicDocumentUrl(docId: string): string {
  return `/api/documents/${encodeURIComponent(docId)}/download`;
}

const APPLICATION_STATUSES = new Set(["app_taken", "processing", "underwriting", "approved", "suspended"]);

function applicationStatusLabel(status: string): string {
  return (
    {
      app_taken: "App taken",
      processing: "Processing",
      underwriting: "Underwriting",
      approved: "Approved",
      suspended: "Suspended",
    } as Record<string, string>
  )[status] || "App taken";
}

function applicationSummary(lead: Lead) {
  const custom = lead.custom || {};
  const status = typeof custom.application_status === "string" && APPLICATION_STATUSES.has(custom.application_status)
    ? custom.application_status
    : "app_taken";
  return {
    id: lead.id,
    first_name: lead.first_name,
    last_name: lead.last_name,
    email: lead.email,
    phone: lead.phone,
    pipeline_stage: lead.pipeline_stage,
    status,
    statusLabel: applicationStatusLabel(status),
    startedAt: custom.application_started_at || null,
    statusAt: custom.application_status_at || null,
    loanPurpose: custom.loan_purpose || custom.loan_goal || custom.purpose || null,
    loanAmount: custom.loan_amount || custom.heloc_line || null,
  };
}

function leadWithPortalSensitiveForMismo(lead: Lead): Lead {
  const sensitive = getBorrowerSensitiveData(lead.id, { audit: true, author: "portal-mismo-export" }).data || {};
  const co = sensitive.coBorrower || {};
  return {
    ...lead,
    custom: {
      ...(lead.custom || {}),
      dob: sensitive.dob,
      ssn: sensitive.ssn,
      ssn_last4: sensitive.ssnLast4,
      credit_score: sensitive.creditScore,
      creditScore: sensitive.creditScore,
      monthly_income: sensitive.monthlyIncome,
      monthlyIncome: sensitive.monthlyIncome,
      asset_summary: sensitive.assetSummary,
      employer: sensitive.employer,
      borrower_ssn: sensitive.ssn,
      borrower_dob: sensitive.dob,
      current_employer: sensitive.employer,
      co_borrower_first_name: co.firstName,
      co_borrower_last_name: co.lastName,
      co_borrower_email: co.email,
      co_borrower_phone: co.phone,
      co_borrower_dob: co.dob,
      co_borrower_ssn: co.ssn,
      co_borrower_ssn_last4: co.ssnLast4,
      co_borrower_credit_score: co.creditScore,
      coBorrowerCreditScore: co.creditScore,
      co_borrower_monthly_income: co.monthlyIncome,
      coBorrowerMonthlyIncome: co.monthlyIncome,
      co_borrower_asset_summary: co.assetSummary,
      co_borrower_employer: co.employer,
      coBorrowerEmployer: co.employer,
    },
  };
}

crmRouter.get("/api/settings/loan-services", requireAdmin, (_req, res) => {
  res.json({ ok: true, settings: listSettlementVendorSettings() });
});

crmRouter.post("/api/settings/loan-services/:kind", requireAdmin, (req, res) => {
  const kind = req.params.kind === "title" || req.params.kind === "flood" ? (req.params.kind as SettlementVendorKind) : null;
  if (!kind) {
    res.status(400).json({ error: "unknown loan service kind" });
    return;
  }
  try {
    const settings = saveSettlementVendorSettings(kind, (req.body ?? {}) as Record<string, unknown>, leadActionAuthor(req));
    res.json({ ok: true, settings });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

crmRouter.get("/api/settings/elevenlabs", requireAdmin, (_req, res) => {
  res.json({ ok: true, settings: publicElevenLabsSettings() });
});

crmRouter.post("/api/settings/elevenlabs", requireAdmin, (req, res) => {
  try {
    const settings = saveElevenLabsSettings((req.body ?? {}) as Record<string, unknown>, leadActionAuthor(req));
    res.json({ ok: true, settings });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function requestPublicBase(req: Request): string {
  return config.publicBaseUrl || config.crm.publicBaseUrl || `${req.protocol}://${req.get("host")}`;
}

crmRouter.get("/api/settings/voicemail-audio", requireAdmin, (_req, res) => {
  res.json({ ok: true, settings: publicVoicemailAudioSettings() });
});

const VOICEMAIL_AUDIO_EXTS = new Set([".mp3", ".m4a", ".wav", ".webm", ".ogg"]);

crmRouter.post("/api/settings/voicemail-audio", requireAdmin, raw({ type: () => true, limit: "16mb" }), async (req, res) => {
  const buf = req.body as Buffer;
  if (!buf || !buf.length) {
    res.status(400).json({ error: "empty audio upload" });
    return;
  }

  const rawName = req.get("x-filename") || "voicemail.mp3";
  const ext = path.extname(rawName).toLowerCase();
  if (!ext || !VOICEMAIL_AUDIO_EXTS.has(ext) || !supportedMediaExt(ext)) {
    res.status(400).json({ error: "upload an mp3, m4a, wav, webm, or ogg file" });
    return;
  }

  const file = `voicemail-default-${randomUUID()}${ext}`;
  try {
    await writeMediaFile(file, buf);
    const url = publicMediaUrl(file, requestPublicBase(req));
    const settings = saveDefaultVoicemailAudio(
      { url, file, mime: mimeForExt(ext), size: buf.length },
      leadActionAuthor(req),
    );
    res.json({ ok: true, settings });
  } catch (err) {
    log.error("voicemail audio upload failed", { err: String(err) });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

crmRouter.post("/api/settings/elevenlabs/test", requireAdmin, async (req, res) => {
  const text = (req.body?.text ?? "").toString().trim();
  if (!text) {
    res.status(400).json({ error: "pass test text" });
    return;
  }
  try {
    const audio = await generateVoicemailAudio(text, { baseUrl: requestPublicBase(req) });
    res.json({ ok: true, audio });
  } catch (err) {
    log.warn("elevenlabs test generation failed", { err: String(err) });
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

crmRouter.get("/api/leads/:id/documents", requirePass, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  res.json({
    ok: true,
    documents: listLeadDocuments(lead.id).map((doc) => ({
      ...doc,
      downloadUrl: publicDocumentUrl(doc.id),
    })),
  });
});

crmRouter.post("/api/leads/:id/documents", requirePass, raw({ type: () => true, limit: "25mb" }), (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  const buffer = req.body as Buffer;
  const filename = req.get("x-filename") || "document";
  const docType =
    (typeof req.query.type === "string" && req.query.type) ||
    req.get("x-document-type") ||
    "other";
  const notes =
    (typeof req.query.notes === "string" && req.query.notes) ||
    req.get("x-document-notes") ||
    "";
  try {
    const doc = saveLeadDocument({
      lead,
      buffer,
      filename,
      docType,
      notes,
      uploadedBy: leadActionAuthor(req),
    });
    res.json({
      ok: true,
      document: { ...doc, downloadUrl: publicDocumentUrl(doc.id) },
      lead: getLead(lead.id),
      documents: listLeadDocuments(lead.id).map((item) => ({ ...item, downloadUrl: publicDocumentUrl(item.id) })),
      documentReadiness: getLosReadiness(getLead(lead.id) || lead),
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

crmRouter.get("/api/documents/:docId/download", requirePass, (req, res) => {
  const doc = getLeadDocument(req.params.docId);
  if (!doc) {
    res.status(404).json({ error: "document not found" });
    return;
  }
  const lead = getLead(doc.lead_id);
  if (!lead) {
    res.status(404).json({ error: "lead not found" });
    return;
  }
  const owner = ownerScope(req);
  if (owner && lead.owner_user_id !== owner) {
    res.status(403).json({ error: "this lead is assigned to another user" });
    return;
  }
  const full = getLeadDocumentPath(doc);
  if (!full) {
    res.status(404).json({ error: "document file missing" });
    return;
  }
  res.download(full, doc.original_name);
});

crmRouter.delete("/api/documents/:docId", requirePass, (req, res) => {
  const doc = getLeadDocument(req.params.docId);
  if (!doc) {
    res.status(404).json({ error: "document not found" });
    return;
  }
  const lead = getLead(doc.lead_id);
  if (!lead) {
    res.status(404).json({ error: "lead not found" });
    return;
  }
  const owner = ownerScope(req);
  if (owner && lead.owner_user_id !== owner) {
    res.status(403).json({ error: "this lead is assigned to another user" });
    return;
  }
  softDeleteLeadDocument(doc, leadActionAuthor(req));
  res.json({ ok: true, documents: listLeadDocuments(doc.lead_id).map((item) => ({ ...item, downloadUrl: publicDocumentUrl(item.id) })) });
});

crmRouter.get("/api/applications", requirePass, (req, res) => {
  const ownerUserId = ownerScope(req);
  const applications = listLeads({ limit: 20000, includeContactOnly: true, ownerUserId })
    .filter((lead) => Boolean((lead.custom || {}).application_started_at))
    .map(applicationSummary);
  res.json({ ok: true, applications });
});

crmRouter.get("/api/leads", requirePass, (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const stage = typeof req.query.stage === "string" ? req.query.stage : undefined;
  const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
  const deleted = req.query.deleted === "1" || req.query.deleted === "true";
  const pastClient = req.query.pastClient === "1" || req.query.pastClient === "true";
  // The Contacts tab passes includeContacts=1 to also get contact-only records; the Leads
  // tab omits it, so contact-only people stay out of the active pipeline.
  const includeContactOnly = req.query.includeContacts === "1" || req.query.includeContacts === "true";
  const ownerUserId = ownerScope(req);
  res.json({ leads: listLeads({ q, status, stage, limit, deleted, pastClient, includeContactOnly, ownerUserId }), stats: leadStats(ownerUserId) });
});

/** Materialize a contact (e.g. a GHL contact) into an editable record so it can be opened
 *  in the contact detail. Reuses an existing lead by phone; otherwise creates a CONTACT-ONLY
 *  record (kept out of the active Leads tab until "Move to Leads" is pressed). */
crmRouter.post("/api/contacts/materialize", requirePass, (req, res) => {
  const b = (req.body ?? {}) as { name?: string; phone?: string; email?: string; ghlId?: string };
  const existing = b.phone || b.email ? findLead({ phone: b.phone || undefined, email: b.email || undefined }) : null;
  if (existing) {
    res.json({ ok: true, lead: existing, created: false });
    return;
  }
  if (!b.name && !b.phone && !b.email) {
    res.status(400).json({ error: "pass a name, phone, or email" });
    return;
  }
  const lead = createLead({
    name: b.name,
    phone: b.phone,
    email: b.email,
    source: b.ghlId ? "ghl-contact" : "contact",
    contact_only: true,
  });
  res.json({ ok: true, lead, created: true });
});

// ── One-time GHL contact import (pull all GHL contacts into the local DB) ────────
// Runs in the background (a full pull is thousands of contacts); progress is stored in
// `meta` under `ghl_import` and polled via GET /api/contacts/import-ghl/status. After this,
// the Contacts tab reads only the local DB (no live GHL pull), so deletes are permanent.
let ghlImporting = false;
crmRouter.post("/api/contacts/import-ghl", requirePass, (_req, res) => {
  if (ghlImporting) {
    res.json({ ok: true, status: "running", message: getMeta("ghl_import") ?? "running" });
    return;
  }
  ghlImporting = true;
  setMeta("ghl_import", "running");
  res.json({ ok: true, status: "started" });
  // Fire-and-forget: keep working after the response is sent.
  (async () => {
    try {
      const all = await listAllContacts(20000);
      const r = bulkCreateContacts(all.map((c) => ({ name: c.name, phone: c.phone, tags: c.tags })));
      setMeta("ghl_import", `done: pulled ${all.length}, imported ${r.imported}, already had ${r.skipped}`);
      log.info("GHL contact import complete", { pulled: all.length, imported: r.imported, skipped: r.skipped });
    } catch (err) {
      setMeta("ghl_import", `error: ${String(err)}`);
      log.error("GHL contact import failed", { err: String(err) });
    } finally {
      ghlImporting = false;
    }
  })();
});

crmRouter.get("/api/contacts/import-ghl/status", requirePass, (_req, res) => {
  res.json({ running: ghlImporting, status: getMeta("ghl_import") ?? "never run" });
});

/** Read-only diagnostic: row counts + where the duplicates are (no mutation). */
crmRouter.get("/api/contacts/diag", requirePass, (_req, res) => {
  res.json(contactsDiag());
});

// ── Import cleanup (undo a bad bulk import) ──────────────────────────────────
// All passcode-gated. Soft-delete only (reversible from the Deleted view). The mutating
// routes default to dryRun TRUE — the caller must send dryRun:false to actually change data.

/** Leads grouped by source with today vs total counts (to choose what to remove). */
crmRouter.get("/api/admin/source-audit", requirePass, (req, res) => {
  const since = parseInt(String(req.query.since ?? ""), 10) || Date.now() - 86_400_000;
  res.json({ since, sources: auditSources(since) });
});

/** Soft-delete imported leads: body { sources:[], since?:ms, dryRun?:bool(=true) }. */
crmRouter.post("/api/admin/purge-imports", requirePass, (req, res) => {
  const body = (req.body ?? {}) as { sources?: unknown; since?: unknown; dryRun?: unknown };
  if (!Array.isArray(body.sources) || !body.sources.length) {
    res.status(400).json({ error: "pass sources: string[]" });
    return;
  }
  const since = Number(body.since) || Date.now() - 86_400_000;
  res.json(purgeImported(body.sources.map(String), since, body.dryRun !== false));
});

/** Revert status/stage/past-client damage the import did to real (non-import) leads.
 *  body { importSources:[], since?:ms, dryRun?:bool(=true) }. */
crmRouter.post("/api/admin/revert-import", requirePass, (req, res) => {
  const body = (req.body ?? {}) as { importSources?: unknown; since?: unknown; dryRun?: unknown };
  const since = Number(body.since) || Date.now() - 86_400_000;
  const importSources = Array.isArray(body.importSources) ? body.importSources.map(String) : [];
  res.json(revertImportDamage(since, importSources, body.dryRun !== false));
});

/** Merge-dedupe duplicate contacts (by phone, then email). Keeps the richest record, moves
 *  the others' messages/notes/automations onto it, unions tags, soft-deletes the extras.
 *  DRY RUN by default — send { dryRun: false } to actually merge. */
crmRouter.post("/api/admin/dedupe-contacts", requirePass, (req, res) => {
  const body = (req.body ?? {}) as { dryRun?: unknown };
  res.json(dedupeContacts(body.dryRun === false ? false : true));
});

/** Create a lead by hand. Lead-created automations run by default; set body.runAutomation=false to only save. */
crmRouter.post("/api/leads", requirePass, (req, res) => {
  const body = (req.body ?? {}) as LeadInput & { runAutomation?: boolean; loanType?: string };
  if (!body.phone && !body.email && !body.name && !body.first_name) {
    res.status(400).json({ error: "pass at least a name, phone, or email" });
    return;
  }
  try {
    // Tag manual leads too (uses loanType / message if provided, else GENERAL).
    const msg = typeof body.custom?.message === "string" ? body.custom.message : undefined;
    const tag = body.category ? null : categorize({ loanType: body.loanType, message: msg });
    const lead = createLead({
      ...body,
      source: body.source ?? "manual",
      category: body.category ?? tag?.category,
      category_reason: body.category_reason ?? tag?.reason,
      campaign: body.campaign ?? tag?.campaign,
    });
    // A lead created from the console is owned by its creator (admins can reassign later).
    if (req.authUser) {
      updateLead(lead.id, { owner_user_id: req.authUser.id });
      lead.owner_user_id = req.authUser.id;
    }
    const shouldRunAutomation = body.runAutomation !== false;
    let started = 0;
    let note: string | undefined;
    if (shouldRunAutomation) {
      started = fireTrigger("lead_created", lead);
      note = diagnoseEnrollment("lead_created", lead).note ?? undefined;
      if (note) log.warn("manual lead: enrollment caveat", { leadId: lead.id, started, note });
    }
    res.json({ ok: true, lead, automationStarted: started, note });
  } catch (err) {
    log.error("create lead error", { err: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

/** Minimal CSV parser: row objects keyed by lowercased header. Handles quoted fields
 *  (commas/newlines inside quotes, "" escaping). */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((x) => x.trim() !== "")) rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    headers.forEach((h, idx) => { o[h] = (r[idx] ?? "").trim(); });
    return o;
  });
}

/** First non-empty value from a possibly multi-value cell (e.g. an `emails`/`phones` export column). */
function firstOf(v: string | undefined): string {
  return (v || "").split(/[;,\n]/).map((s) => s.trim()).filter(Boolean)[0] || "";
}

const STATE_ALIASES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT",
  delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI",
  minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH",
  "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY",
};

const LEAD_POOL_SAMPLE_CSV = [
  "first_name,last_name,phone,email,state,tags,source,loan_type,property_address,city,zip,notes,sms_consent",
  "Jane,Smith,+16025550100,jane@example.com,AZ,\"old HELOC;nurture\",2024-old-list,HELOC,123 Main St,Phoenix,85001,\"Asked for equity options last year\",yes",
  "Chris,Johnson,+14805550125,chris@example.com,CA,\"cashout;spanish\",referral,Cash-out refi,88 Market St,San Diego,92101,\"Send updated numbers\",no",
].join("\n") + "\n";

function csvEscapeCell(value: unknown): string {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvLine(values: unknown[]): string {
  return values.map(csvEscapeCell).join(",");
}

function normalizeStateCell(value: string | undefined): string {
  const raw = (value || "").trim();
  if (!raw) return "";
  if (/^[a-z]{2}$/i.test(raw)) return raw.toUpperCase();
  return STATE_ALIASES[raw.toLowerCase()] || raw;
}

function splitImportTags(value: string | undefined): string[] | undefined {
  const tags = (value || "").split(/[;|,]/).map((s) => s.trim()).filter(Boolean);
  return tags.length ? Array.from(new Set(tags)) : undefined;
}

function rowValue(row: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const direct = row[key];
    if (direct) return direct;
    const compact = row[key.replace(/\s+/g, "_")];
    if (compact) return compact;
  }
  return "";
}

function truthyCell(value: string | undefined): boolean {
  return /^(1|true|yes|y)$/i.test((value || "").trim());
}

function isLeadPoolLead(lead: Lead): boolean {
  const marker = lead.custom?.lead_pool;
  return Boolean(lead.contact_only && (marker === true || marker === "true"));
}

function leadPoolState(lead: Lead): string {
  const custom = lead.custom || {};
  return normalizeStateCell(
    [custom.lead_pool_state, custom.state, custom.mortgage_state]
      .map((v) => (typeof v === "string" ? v : ""))
      .find(Boolean),
  );
}

function leadPoolSearchBlob(lead: Lead): string {
  const custom = lead.custom || {};
  return [
    lead.first_name, lead.last_name, lead.email, lead.phone, lead.source,
    lead.tags.join(" "), custom.city, custom.zip, custom.address, custom.property_address,
    custom.notes, custom.loan_type, custom.loan_goal,
  ].map((v) => String(v || "").toLowerCase()).join(" ");
}

/** CSV header (lowercased) → canonical custom key. Only these extra columns are kept on import,
 *  so a 100+ column CRM export doesn't bloat each lead's custom data. Keys match the Quote panel. */
const IMPORT_CUSTOM_ALIASES: Record<string, string> = {
  dob: "dob", date_of_birth: "dob",
  creditscore: "credit", credit_score: "credit", credit: "credit", creditband: "credit", credit_band: "credit",
  homevalue: "home_value", home_value: "home_value", estimated_home_value: "home_value", estimatedhomevalue: "home_value",
  mortgagebalance: "mortgage_balance", mortgage_balance: "mortgage_balance", loan_balance_remaining: "mortgage_balance",
  loanamount: "loan_amount", loan_amount: "loan_amount",
  loanpurpose: "loan_goal", loan_purpose: "loan_goal", loan_goal: "loan_goal", goal: "loan_goal",
  address: "address", address1: "address", street: "address", mortgage_address: "address",
  city: "city", state: "state", mortgage_state: "state",
  zip: "zip", zipcode: "zip", postal_code: "zip", postalcode: "zip", mortgage_zipcode: "zip",
  loantype: "loan_type", loan_type: "loan_type", mortgage_type: "loan_type",
  loan_start_date: "funded_date", funded_date: "funded_date", funding_date: "funded_date",
  lead_type: "lead_type", leadtype: "lead_type", contact_type: "lead_type",
};

/** Lead statuses accepted on import (CSV `status` column). Anything else falls back to default. */
const IMPORT_STATUSES = new Set(["new", "contacted", "qualified", "nurturing", "won", "lost"]);

/** Bulk-import leads from CSV (header row + rows). Dedups by phone/email (updates instead
 *  of duplicating). `destination` picks where the rows land:
 *   - "past_clients" → flag every lead past-client (lives under Past Clients, enrolls Remarketing).
 *   - "leads" (default) → the active pipeline; `defaultStatus` (e.g. "nurturing") seeds rows
 *      that have no own `status` column.
 *  `markPastClients` is still accepted as the legacy alias for destination "past_clients". */
crmRouter.post("/api/leads/import", requirePass, (req, res) => {
  const body = (req.body ?? {}) as {
    csv?: string;
    markPastClients?: boolean;
    destination?: string;
    defaultStatus?: string;
  };
  const csv = typeof body.csv === "string" ? body.csv : "";
  if (!csv.trim()) {
    res.status(400).json({ error: "no CSV provided" });
    return;
  }
  const toPastClients = body.destination === "past_clients" || Boolean(body.markPastClients);
  const defaultStatusRaw = (body.defaultStatus || "").trim().toLowerCase();
  const defaultStatus = IMPORT_STATUSES.has(defaultStatusRaw) ? (defaultStatusRaw as LeadStatus) : undefined;
  let rows: Record<string, string>[];
  try {
    rows = parseCsv(csv);
  } catch (e) {
    res.status(400).json({ error: "could not parse CSV: " + String(e) });
    return;
  }
  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const r of rows) {
    const first = r.first_name || r.first || r.firstname || "";
    const last = r.last_name || r.last || r.lastname || "";
    // Accept singular OR plural column names (Shape/Jungo/etc. export `emails`/`phones`).
    const email = r.email || firstOf(r.emails) || "";
    const phone = r.phone || firstOf(r.phones) || "";
    if (!first && !last && !email && !phone) {
      skipped++;
      continue;
    }
    // Map only a curated set of useful columns into the lead's custom (canonical keys that
    // the Quote/loan-details + DOB fields display) — so a 120-column export doesn't bloat it.
    const custom: Record<string, unknown> = {};
    for (const k of Object.keys(r)) {
      const canon = IMPORT_CUSTOM_ALIASES[k] || IMPORT_CUSTOM_ALIASES[k.replace(/\s+/g, "_")];
      if (canon && r[k]) custom[canon] = canon === "dob" ? normalizeDob(r[k]) : r[k];
    }
    const tags = r.tags ? r.tags.split(/[;|]/).map((t) => t.trim()).filter(Boolean) : undefined;
    // A row's own `status` column wins; otherwise fall back to the import's defaultStatus
    // (e.g. "nurturing" for a nurture/contacts upload). Only known statuses are honored.
    const statusRaw = (r.status || "").trim().toLowerCase();
    const status = IMPORT_STATUSES.has(statusRaw) ? (statusRaw as LeadStatus) : defaultStatus;
    const rowPast = toPastClients || /^(1|true|yes|y)$/i.test(r.past_client || "");
    const existing = findLead({ phone: phone || undefined, email: email || undefined });
    let leadId: string;
    if (existing) {
      const patch: Record<string, unknown> = {};
      if (first) patch.first_name = first;
      if (last) patch.last_name = last;
      if (email) patch.email = email;
      if (phone) patch.phone = phone;
      if (status) patch.status = status;
      if (tags) patch.tags = Array.from(new Set([...existing.tags, ...tags]));
      if (Object.keys(custom).length) patch.custom = { ...existing.custom, ...custom };
      if (Object.keys(patch).length) updateLead(existing.id, patch);
      leadId = existing.id;
      updated++;
    } else {
      const lead = createLead({ first_name: first, last_name: last, email, phone, source: r.source || "import", status, tags, custom });
      leadId = lead.id;
      // A `notes` column becomes a real timeline note (visible) — e.g. funded date / loan summary.
      if (r.notes) addNote(leadId, r.notes, "import");
      created++;
    }
    if (rowPast) markPastClient(leadId);
  }
  res.json({ ok: true, created, updated, skipped, total: rows.length });
});

crmRouter.get("/api/lead-pool/sample.csv", requirePass, (_req, res) => {
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", 'attachment; filename="lead-pool-sample.csv"');
  res.send(LEAD_POOL_SAMPLE_CSV);
});

crmRouter.get("/api/lead-pool", requirePass, (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
  const stateFilter = normalizeStateCell(typeof req.query.state === "string" ? req.query.state : "");
  const tagFilter = typeof req.query.tag === "string" ? req.query.tag.trim().toLowerCase() : "";
  const limit = Math.min(parseInt(String(req.query.limit || "500"), 10) || 500, 20000);
  const ownerUserId = ownerScope(req);
  const allPool = listLeads({ includeContactOnly: true, limit: 20000, ownerUserId }).filter(isLeadPoolLead);
  const states = Array.from(new Set(allPool.map(leadPoolState).filter(Boolean))).sort();
  const tags = Array.from(new Set(allPool.flatMap((l) => l.tags || []))).sort((a, b) => a.localeCompare(b));
  const leads = allPool
    .filter((lead) => !q || leadPoolSearchBlob(lead).includes(q))
    .filter((lead) => !stateFilter || leadPoolState(lead) === stateFilter)
    .filter((lead) => !tagFilter || (lead.tags || []).some((t) => t.toLowerCase() === tagFilter))
    .slice(0, limit);
  res.json({ ok: true, leads, count: leads.length, total: allPool.length, states, tags });
});

crmRouter.post("/api/lead-pool/import", requirePass, (req, res) => {
  const body = (req.body ?? {}) as { csv?: string };
  const csv = typeof body.csv === "string" ? body.csv : "";
  if (!csv.trim()) {
    res.status(400).json({ error: "no CSV provided" });
    return;
  }
  let rows: Record<string, string>[];
  try {
    rows = parseCsv(csv);
  } catch (e) {
    res.status(400).json({ error: "could not parse CSV: " + String(e) });
    return;
  }

  let created = 0;
  let duplicates = 0;
  let skipped = 0;
  const duplicateRows: string[] = [];
  for (const r of rows) {
    const first = rowValue(r, ["first_name", "first", "firstname"]);
    const last = rowValue(r, ["last_name", "last", "lastname"]);
    const email = firstOf(rowValue(r, ["email", "emails"]));
    const phone = firstOf(rowValue(r, ["phone", "phones"]));
    if (!first && !last && !email && !phone) {
      skipped++;
      continue;
    }
    const existing = findLead({ phone: phone || undefined, email: email || undefined });
    if (existing) {
      duplicates++;
      duplicateRows.push([first, last, email, phone].filter(Boolean).join(" ") || existing.id);
      continue;
    }

    const state = normalizeStateCell(rowValue(r, ["state", "mortgage_state", "property_state"]));
    const notes = rowValue(r, ["notes", "note", "last_note"]);
    const tags = splitImportTags(rowValue(r, ["tags", "tag"]));
    const address = rowValue(r, ["property_address", "address", "street", "mortgage_address"]);
    const custom: Record<string, unknown> = {
      lead_pool: true,
      lead_pool_uploaded_at: new Date().toISOString(),
      lead_pool_state: state,
      state,
      city: rowValue(r, ["city", "property_city", "mortgage_city"]),
      zip: rowValue(r, ["zip", "zipcode", "postal_code", "property_zip", "mortgage_zipcode"]),
      address,
      property_address: address,
      loan_type: rowValue(r, ["loan_type", "loantype", "mortgage_type"]),
      loan_goal: rowValue(r, ["loan_goal", "loan_purpose", "purpose"]),
      notes,
    };
    for (const k of Object.keys(custom)) {
      if (custom[k] === "") delete custom[k];
    }

    const lead = createLead({
      first_name: first,
      last_name: last,
      email,
      phone,
      source: rowValue(r, ["source"]) || "lead-pool",
      status: "nurturing",
      tags,
      custom,
      contact_only: true,
      sms_consent: truthyCell(rowValue(r, ["sms_consent", "consent", "opt_in"])),
    });
    if (req.authUser) updateLead(lead.id, { owner_user_id: req.authUser.id });
    if (notes) addNote(lead.id, notes, "lead-pool-import");
    logActivity(lead.id, {
      type: "lead_pool_import",
      direction: "system",
      channel: "system",
      body: "Imported into Lead Pool",
    });
    created++;
  }

  res.json({ ok: true, created, duplicates, skipped, total: rows.length, duplicateRows: duplicateRows.slice(0, 25) });
});

crmRouter.post("/api/lead-pool/:id/promote", requirePass, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  if (!isLeadPoolLead(lead)) {
    res.status(400).json({ error: "lead is not in the Lead Pool" });
    return;
  }
  const custom = {
    ...lead.custom,
    lead_pool: false,
    lead_pool_promoted_at: new Date().toISOString(),
  };
  const updated = updateLead(lead.id, {
    contact_only: false,
    custom,
    pipeline_stage: typeof req.body?.pipeline_stage === "string" ? req.body.pipeline_stage : DEFAULT_STAGE,
  });
  logActivity(lead.id, {
    type: "lead_pool_promote",
    direction: "system",
    channel: "system",
    body: "Moved from Lead Pool to active Leads",
    status: "active",
  });
  res.json({ ok: true, lead: updated });
});

crmRouter.post("/api/lead-pool/enroll", requirePass, (req, res) => {
  const body = (req.body ?? {}) as { ids?: string[]; automationId?: string };
  const ids = Array.isArray(body.ids) ? body.ids.slice(0, 250) : [];
  const automationId = typeof body.automationId === "string" ? body.automationId : "";
  if (!ids.length) {
    res.status(400).json({ error: "no Lead Pool records selected" });
    return;
  }
  if (!automationId) {
    res.status(400).json({ error: "choose a campaign" });
    return;
  }
  let enrolled = 0;
  let skipped = 0;
  for (const id of ids) {
    const lead = getLead(id);
    if (!lead || !isLeadPoolLead(lead)) {
      skipped++;
      continue;
    }
    const owner = ownerScope(req);
    if (owner && lead.owner_user_id !== owner) {
      skipped++;
      continue;
    }
    if (enrollLeadInAutomation(lead.id, automationId)) enrolled++;
    else skipped++;
  }
  res.json({ ok: true, enrolled, skipped });
});

/** Bulk text blast to selected leads (manual operator action). Skips no-phone and opted-out/DNC.
 *  Personalizes lead merge fields. Paced; capped per request. */
crmRouter.post("/api/leads/blast", requirePass, async (req, res) => {
  const body = (req.body ?? {}) as { ids?: string[]; message?: string };
  const ids = Array.isArray(body.ids) ? body.ids.slice(0, 250) : [];
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!ids.length) { res.status(400).json({ error: "no leads selected" }); return; }
  if (!message) { res.status(400).json({ error: "message is empty" }); return; }
  let sent = 0, skipped = 0, failed = 0;
  const reasons: Record<string, number> = {};
  const note = (k: string) => { reasons[k] = (reasons[k] || 0) + 1; };
  // Guard against texting the same person twice in one blast when duplicate lead records
  // share a phone number (last-10-digit key). One number → one message per request.
  const sentPhones = new Set<string>();
  const phoneKey = (p: string | null) => { const d = String(p || "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : ""; };
  for (const id of ids) {
    const lead = getLead(id);
    if (!lead) { skipped++; note("not found"); continue; }
    if (!lead.phone) { skipped++; note("no phone"); continue; }
    const pk = phoneKey(lead.phone);
    if (pk && sentPhones.has(pk)) { skipped++; note("duplicate number"); continue; }
    if ((lead.tags || []).some((t) => /opt[_-]?out|dnc|do[_-]?not[_-]?contact|^stop$/i.test(t))) { skipped++; note("opted out / DNC"); continue; }
    const personalized = renderLeadMergeTemplate(message, lead);
    try {
      const result = await sendOutbound({ phone: lead.phone, message: personalized });
      const channel = result.path.startsWith("imessage") ? "imessage" : "sms";
      logActivity(lead.id, {
        type: channel,
        direction: "outbound",
        channel,
        body: personalized,
        status: result.ok ? `blast:${result.path}` : `failed:${result.path}`,
        meta: { detail: result.detail, blast: true },
      });
      if (result.ok) {
        if (pk) sentPhones.add(pk);
        sent++;
      } else {
        failed++;
        note(result.path);
      }
    } catch (err) {
      failed++;
      log.warn("blast send failed", { leadId: id, err: String(err) });
    }
    await new Promise((r) => setTimeout(r, 120)); // gentle pacing for carrier/provider health
  }
  res.json({ ok: true, sent, skipped, failed, reasons });
});

function renderLeadMergeTemplate(template: string, lead: Lead): string {
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || "there";
  return template
    .replace(/\{\{\s*first_name\s*\}\}/gi, lead.first_name || "there")
    .replace(/\{\{\s*last_name\s*\}\}/gi, lead.last_name || "")
    .replace(/\{\{\s*name\s*\}\}/gi, name)
    .replace(/\{\{\s*email\s*\}\}/gi, lead.email || "")
    .replace(/\{\{\s*phone\s*\}\}/gi, lead.phone || "");
}

const VOICEMAIL_CONFIG_ERROR = "voicemail not configured (upload default audio in Settings > Voicemail AI or set VOICEMAIL_AUDIO_URL; TELNYX_VOICE_APP_ID/TELNYX_CONNECTION_ID, TELNYX_API_KEY, and a Telnyx from number are required)";

function leadPhoneKey(phone: string | null | undefined): string {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
}

type LeadTextFollowupResult =
  | { ok: true; path: string; detail: string }
  | { skipped: true; reason: string }
  | { error: string };

async function sendLeadTextFollowup(
  lead: Lead,
  template: string,
  author?: string,
  blast = false,
): Promise<LeadTextFollowupResult> {
  if (!lead.phone) return { skipped: true, reason: "no phone" };
  const message = renderLeadMergeTemplate(template, lead).trim();
  if (!message) return { skipped: true, reason: "empty message" };
  try {
    const result = await sendOutbound({ phone: lead.phone, message });
    const channel = result.path.startsWith("imessage") ? "imessage" : "sms";
    logActivity(lead.id, {
      type: channel,
      direction: "outbound",
      channel,
      body: message,
      status: result.ok ? "voicemail-followup-sent" : `failed:${result.path}`,
      meta: { detail: result.detail, author, voicemailFollowup: true, blast },
    });
    return result.ok
      ? { ok: true, path: result.path, detail: result.detail }
      : { error: result.detail || result.path };
  } catch (err) {
    log.error("voicemail follow-up text failed", { leadId: lead.id, err: String(err) });
    return { error: String(err) };
  }
}

type LeadVoicemailStartResult =
  | { ok: true; ccid: string; timezone: string }
  | { skipped: true; reason: string }
  | { error: string };

async function startLeadVoicemailDrop(
  lead: Lead,
  author?: string,
  blast = false,
  audioUrl?: string,
): Promise<LeadVoicemailStartResult> {
  if (!lead.phone) return { skipped: true, reason: "no phone" };
  if (!voicemailConfigured(audioUrl)) return { skipped: true, reason: "voicemail not configured" };
  if (await isOnDnc(lead.phone)) return { skipped: true, reason: "on-DNC" };

  const timezone = resolveLeadTimezone(lead) || config.crm.defaultTimezone || "";
  const hoursGate = withinCallingHours(timezone || undefined);
  if (!hoursGate.allowed) {
    return { skipped: true, reason: hoursGate.reason || "outside-hours" };
  }

  const result = await dropVoicemail({ phone: lead.phone, leadId: lead.id, audioUrl });
  if ("ok" in result) {
    const resolvedAudioUrl = audioUrl || getDefaultVoicemailAudioUrl();
    logActivity(lead.id, {
      type: "voicemail",
      direction: "outbound",
      channel: "voice",
      body: `Voicemail drop initiated to ${lead.phone}`,
      status: "initiated",
      meta: { ccid: result.ccid, author, timezone, blast, audioUrl: resolvedAudioUrl || undefined },
    });
    return { ok: true, ccid: result.ccid, timezone };
  }

  if ("skipped" in result) return { skipped: true, reason: result.reason };
  logActivity(lead.id, {
    type: "voicemail",
    direction: "outbound",
    channel: "voice",
    body: `Voicemail drop failed to ${lead.phone}`,
    status: "failed",
    meta: { error: result.error, author, blast },
  });
  return { error: result.error };
}

function requireVoicemailConfigured(res: Response): boolean {
  if (voicemailConfigured()) return true;
  res.status(400).json({ error: VOICEMAIL_CONFIG_ERROR });
  return false;
}

async function resolveLeadVoicemailAudioUrl(
  lead: Lead,
  scriptTemplate: string,
  explicitAudioUrl: string,
  baseUrl: string,
): Promise<string | undefined> {
  if (explicitAudioUrl) return explicitAudioUrl;
  const script = renderLeadMergeTemplate(scriptTemplate, lead).trim();
  if (!script) return undefined;
  return (await generateVoicemailAudio(script, { baseUrl })).url;
}

crmRouter.post("/api/leads/:id/voicemail-drop", requirePass, async (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;

  const sendText = Boolean(req.body?.sendText);
  const textTemplate = (req.body?.text ?? "").toString().trim();
  const voicemailText = (req.body?.voicemailText ?? "").toString().trim();
  const audioUrlInput = (req.body?.audioUrl ?? "").toString().trim();
  if (sendText && !textTemplate) {
    res.status(400).json({ error: "follow-up text is empty" });
    return;
  }

  let audioUrl: string | undefined;
  try {
    audioUrl = await resolveLeadVoicemailAudioUrl(lead, voicemailText, audioUrlInput, requestPublicBase(req));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!audioUrl && !requireVoicemailConfigured(res)) return;

  const voicemail = await startLeadVoicemailDrop(lead, leadActionAuthor(req), false, audioUrl);
  let text: LeadTextFollowupResult | null = null;
  if ("ok" in voicemail && sendText) {
    text = await sendLeadTextFollowup(lead, textTemplate, leadActionAuthor(req), false);
  }

  res.json({ ok: "ok" in voicemail && (!sendText || Boolean(text && "ok" in text)), voicemail, text });
});

crmRouter.post("/api/leads/voicemail-blast", requirePass, async (req, res) => {
  const body = (req.body ?? {}) as { ids?: string[]; sendText?: boolean; text?: string; voicemailText?: string; audioUrl?: string };
  const ids = Array.isArray(body.ids) ? body.ids.slice(0, 250) : [];
  const sendText = Boolean(body.sendText);
  const textTemplate = typeof body.text === "string" ? body.text.trim() : "";
  const voicemailText = typeof body.voicemailText === "string" ? body.voicemailText.trim() : "";
  const audioUrlInput = typeof body.audioUrl === "string" ? body.audioUrl.trim() : "";
  if (!ids.length) { res.status(400).json({ error: "no leads selected" }); return; }
  if (sendText && !textTemplate) { res.status(400).json({ error: "follow-up text is empty" }); return; }
  if (!voicemailText && !audioUrlInput && !voicemailConfigured() && !requireVoicemailConfigured(res)) return;

  let initiated = 0, skipped = 0, failed = 0, textSent = 0, textSkipped = 0, textFailed = 0;
  const reasons: Record<string, number> = {};
  const note = (k: string) => { reasons[k] = (reasons[k] || 0) + 1; };
  const dialedPhones = new Set<string>();
  const owner = ownerScope(req);

  for (const id of ids) {
    const lead = getLead(id);
    if (!lead) { skipped++; note("not found"); if (sendText) textSkipped++; continue; }
    if (owner && lead.owner_user_id !== owner) { skipped++; note("not assigned"); if (sendText) textSkipped++; continue; }
    if (!lead.phone) { skipped++; note("no phone"); if (sendText) textSkipped++; continue; }
    const pk = leadPhoneKey(lead.phone);
    if (pk && dialedPhones.has(pk)) { skipped++; note("duplicate number"); if (sendText) textSkipped++; continue; }
    if (pk) dialedPhones.add(pk);

    let audioUrl: string | undefined;
    try {
      audioUrl = await resolveLeadVoicemailAudioUrl(lead, voicemailText, audioUrlInput, requestPublicBase(req));
    } catch (err) {
      failed++;
      note("audio generation failed");
      if (sendText) textSkipped++;
      log.warn("voicemail blast audio generation failed", { leadId: lead.id, err: String(err) });
      continue;
    }

    const voicemail = await startLeadVoicemailDrop(lead, leadActionAuthor(req), true, audioUrl);
    if ("ok" in voicemail) {
      initiated++;
      if (sendText) {
        const text = await sendLeadTextFollowup(lead, textTemplate, leadActionAuthor(req), true);
        if ("ok" in text) textSent++;
        else if ("skipped" in text) { textSkipped++; note(`text ${text.reason}`); }
        else { textFailed++; note("text failed"); }
      }
    } else if ("skipped" in voicemail) {
      skipped++;
      note(voicemail.reason);
      if (sendText) textSkipped++;
    } else {
      failed++;
      note("provider error");
      if (sendText) textSkipped++;
    }

    await new Promise((r) => setTimeout(r, 350));
  }

  res.json({ ok: true, initiated, skipped, failed, textSent, textSkipped, textFailed, reasons });
});

/** Bulk branded email blast to selected leads. Skips no-email, duplicate emails, and unsubscribed leads.
 *  Personalizes {{first_name}}, {{last_name}}, {{name}}, {{email}}, and {{phone}}. */
crmRouter.post("/api/leads/email-blast", requirePass, async (req, res) => {
  if (!emailConfigured()) {
    res.status(400).json({ error: "email not configured (set RESEND_API_KEY + EMAIL_FROM)" });
    return;
  }
  const body = (req.body ?? {}) as { ids?: string[]; subject?: string; body?: string };
  const ids = Array.isArray(body.ids) ? body.ids.slice(0, 250) : [];
  const subjectTemplate = typeof body.subject === "string" ? body.subject.trim() : "";
  const bodyTemplate = typeof body.body === "string" ? body.body.trim() : "";
  if (!ids.length) { res.status(400).json({ error: "no leads selected" }); return; }
  if (!subjectTemplate) { res.status(400).json({ error: "subject is empty" }); return; }
  if (!bodyTemplate) { res.status(400).json({ error: "message is empty" }); return; }

  let sent = 0, skipped = 0, failed = 0;
  const reasons: Record<string, number> = {};
  const note = (k: string) => { reasons[k] = (reasons[k] || 0) + 1; };
  const emailed = new Set<string>();

  for (const id of ids) {
    const lead = getLead(id);
    if (!lead) { skipped++; note("not found"); continue; }
    const email = (lead.email || "").trim();
    if (!email) { skipped++; note("no email"); continue; }
    const emailKey = email.toLowerCase();
    if (emailed.has(emailKey)) { skipped++; note("duplicate email"); continue; }
    emailed.add(emailKey);
    if (isEmailUnsubscribed(lead)) { skipped++; note("email unsubscribed"); continue; }

    const subject = renderLeadMergeTemplate(subjectTemplate, lead);
    const message = renderLeadMergeTemplate(bodyTemplate, lead);
    const { html, text } = buildBrandedEmail(message, unsubscribeUrl(lead.id));
    const result = await sendEmail({ to: email, subject, html, text });
    logActivity(lead.id, {
      type: "email",
      direction: "outbound",
      channel: "email",
      subject,
      body: message,
      status: result.ok ? "blast-sent" : `failed:${result.detail ?? "send failed"}`,
      meta: { id: result.id, detail: result.detail, author: req.authUser?.username, blast: true },
    });
    if (result.ok) sent++;
    else failed++;
    await new Promise((r) => setTimeout(r, 120));
  }

  res.json({ ok: true, sent, skipped, failed, reasons });
});

/** Bulk soft-delete selected leads (e.g. clearing an import). */
crmRouter.post("/api/leads/bulk-delete", requirePass, (req, res) => {
  const body = (req.body ?? {}) as { ids?: string[] };
  const ids = Array.isArray(body.ids) ? body.ids : [];
  let deleted = 0;
  for (const id of ids) {
    if (!getLead(id)) continue;
    deleteLead(id);
    deleted++;
  }
  res.json({ ok: true, deleted });
});

/** Lead detail: lead + notes + activity timeline. */
crmRouter.get("/api/leads/:id", requirePass, async (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) {
    res.status(404).json({ error: "lead not found" });
    return;
  }
  const owner = ownerScope(req);
  if (owner && lead.owner_user_id !== owner) {
    res.status(403).json({ error: "this lead is assigned to another user" });
    return;
  }
  // dnc: is this lead's number on the Do-Not-Contact list (texts, calls, voicemail all
  // suppressed)? Drives the console's ✅ / ❌ contactability badge.
  const dnc = lead.phone ? await isOnDnc(lead.phone) : false;
  res.json({ lead, dnc, notes: listNotes(lead.id), activities: listActivities(lead.id) });
});

/** Assign / reassign a lead to a user (admin only). Body: { userId } ("" or null = unassign). */
crmRouter.post("/api/leads/:id/assign", requireAdmin, (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) {
    res.status(404).json({ error: "lead not found" });
    return;
  }
  const userId = (req.body?.userId ?? "").toString().trim() || null;
  if (userId && !getUser(userId)) {
    res.status(400).json({ error: "unknown user" });
    return;
  }
  updateLead(lead.id, { owner_user_id: userId });
  res.json({ ok: true, lead: getLead(lead.id) });
});

/** Owners the console can assign leads to (admin only) — drives the assignment dropdown. */
crmRouter.get("/api/lead-owners", requireAdmin, (_req, res) => {
  res.json({ users: listUsers().filter((u) => !u.disabled).map((u) => ({ id: u.id, username: u.username, name: u.name, role: u.role })) });
});

/** Download the lead as a MISMO 3.4 XML file (partial 1003 - the fields we collect). */
crmRouter.get("/api/leads/:id/mismo/readiness", requirePass, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  const xml = buildMismo34(lead);
  res.json({
    ...getMismoReadiness(lead),
    validation: validateMismoExport(lead, xml),
  });
});

crmRouter.get("/api/leads/:id/mismo", requirePass, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  const xml = buildMismo34(lead);
  const filename = mismoFilename(lead);
  const validation = validateMismoExport(lead, xml);
  recordMismoExport({ lead, xml, filename, report: validation, author: leadActionAuthor(req), containsSensitive: false });
  res.set("Content-Type", "application/xml; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(xml);
});

crmRouter.get("/api/leads/:id/mismo/portal/readiness", requirePortalVerified, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  const exportLead = leadWithPortalSensitiveForMismo(lead);
  const xml = buildMismo34(exportLead);
  res.json({
    ...getMismoReadiness(exportLead),
    validation: validateMismoExport(exportLead, xml, { includeSensitive: true }),
    exports: listMismoExports(lead.id, 5),
  });
});

crmRouter.get("/api/leads/:id/mismo/portal", requirePortalVerified, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  const exportLead = leadWithPortalSensitiveForMismo(lead);
  const xml = buildMismo34(exportLead);
  const filename = mismoFilename(lead);
  const validation = validateMismoExport(exportLead, xml, { includeSensitive: true });
  const audit = recordMismoExport({
    lead,
    xml,
    filename,
    report: validation,
    author: leadActionAuthor(req),
    containsSensitive: true,
  });
  logActivity(lead.id, {
    type: "mismo_export",
    direction: "system",
    channel: "portal",
    body: "Portal MISMO 3.4 export generated with encrypted borrower application details",
    status: validation.ok ? "exported" : "exported-with-warnings",
    meta: { author: leadActionAuthor(req) ?? null, includesPortalSensitiveData: true, auditId: audit.id, validationStatus: validation.status },
  });
  res.set("Content-Type", "application/xml; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(xml);
});

crmRouter.get("/api/leads/:id/mismo/exports", requirePortalVerified, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  res.json({ ok: true, exports: listMismoExports(lead.id, 25) });
});

crmRouter.get("/api/leads/:id/underwriting/preview", requirePortalVerified, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  const exportLead = leadWithPortalSensitiveForMismo(lead);
  const current = latestAusPreview(exportLead);
  res.json({ ok: true, preview: current.preview, latestSubmission: current.submission, submissions: listAusSubmissions(lead.id, 5) });
});

crmRouter.post("/api/leads/:id/aus/run", requirePortalVerified, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  const exportLead = leadWithPortalSensitiveForMismo(lead);
  const result = runAusPreview(exportLead, leadActionAuthor(req));
  res.json({ ok: true, ...result });
});

crmRouter.get("/api/leads/:id/los/readiness", requirePass, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  res.json(getLosReadiness(lead));
});

function leadActionAuthor(req: Request): string | undefined {
  return req.authUser?.name || req.authUser?.username;
}

function serviceActionResponse(leadId: string, result: LoanServiceResult) {
  return { ...result, lead: getLead(leadId) };
}

function serviceOptions(req: Request): LoanServiceRequestOptions {
  const body = (req.body ?? {}) as Record<string, unknown>;
  return {
    product: typeof body.product === "string" ? body.product : undefined,
    transactionType: typeof body.transactionType === "string" ? body.transactionType : undefined,
    priority: typeof body.priority === "string" ? body.priority : undefined,
    notes: typeof body.notes === "string" ? body.notes : undefined,
    requestedFrom: typeof body.requestedFrom === "string" ? body.requestedFrom : undefined,
  };
}

crmRouter.post("/api/leads/:id/application/start", requirePass, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  const body = (req.body ?? {}) as { seedChecklist?: boolean };
  res.json(serviceActionResponse(lead.id, startApplication(lead, leadActionAuthor(req), { seedChecklist: body.seedChecklist })));
});

crmRouter.patch("/api/leads/:id/application", requirePass, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  const status = String((req.body ?? {}).status || "").trim();
  if (!APPLICATION_STATUSES.has(status)) {
    res.status(400).json({ error: "status must be one of: app_taken, processing, underwriting, approved, suspended" });
    return;
  }
  const custom = {
    ...(lead.custom || {}),
    application_status: status,
    application_status_at: new Date().toISOString(),
  };
  const updated = updateLead(lead.id, { custom });
  logActivity(lead.id, {
    type: "application_status",
    direction: "system",
    channel: "portal",
    body: `Application status set to ${applicationStatusLabel(status)}`,
    status,
    meta: { author: leadActionAuthor(req) ?? null },
  });
  res.json({ ok: true, lead: updated, application: updated ? applicationSummary(updated) : null });
});

crmRouter.post("/api/leads/:id/orders/credit", requirePass, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  res.status(501).json(serviceActionResponse(lead.id, requestCreditPull(lead, leadActionAuthor(req))));
});

crmRouter.post("/api/leads/:id/orders/title", requirePass, async (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  const result = await requestTitleOrder(lead, leadActionAuthor(req), serviceOptions(req));
  res.status(result.ok ? 200 : 400).json(serviceActionResponse(lead.id, result));
});

crmRouter.post("/api/leads/:id/orders/flood", requirePass, async (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  const result = await requestFloodReport(lead, leadActionAuthor(req), serviceOptions(req));
  res.status(result.ok ? 200 : 400).json(serviceActionResponse(lead.id, result));
});

// ── Per-lead to-do checklist ───────────────────────────────────────────────────
/** Workspace-wide to-do list: every lead's open tasks, newest first (?done=1 includes completed). */
crmRouter.get("/api/todos", requirePass, (req, res) => {
  const includeDone = req.query.done === "1" || req.query.done === "true";
  res.json({ todos: listAllTodos({ includeDone, ownerUserId: ownerScope(req) }) });
});

crmRouter.get("/api/deleted/todos", requirePass, (req, res) => {
  res.json({ todos: listDeletedTodos({ ownerUserId: ownerScope(req) }) });
});

crmRouter.get("/api/deleted/activities", requirePass, (req, res) => {
  const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 200;
  res.json({ activities: listDeletedActivities({ ownerUserId: ownerScope(req), limit }) });
});

/** Add a to-do item to a lead. Body: { text|title, due_date?, cc_email? }. Returns the full updated list. */
crmRouter.post("/api/leads/:id/todos", requirePass, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  const body = (req.body ?? {}) as { text?: string; title?: string; due_date?: string | number | null; cc_email?: string | null };
  const text = body.text || body.title;
  if (!text || !text.trim()) {
    res.status(400).json({ error: "pass { text } or { title }" });
    return;
  }
  const due = body.due_date === null || body.due_date === undefined || body.due_date === ""
    ? null
    : Number.isFinite(Number(body.due_date))
      ? Number(body.due_date)
      : Date.parse(String(body.due_date));
  const todos = addTodo(lead.id, {
    text,
    due_date: due && Number.isFinite(due) ? due : null,
    cc_email: typeof body.cc_email === "string" && body.cc_email.trim() ? body.cc_email.trim() : null,
  });
  if (!todos) {
    res.status(404).json({ error: "lead not found" });
    return;
  }
  res.json({ ok: true, todos });
});

/** Toggle a to-do item's done state. Body: { done: boolean }. */
crmRouter.patch("/api/leads/:id/todos/:todoId", requirePass, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  const done = (req.body as { done?: boolean } | undefined)?.done;
  if (typeof done !== "boolean") {
    res.status(400).json({ error: "pass { done: boolean }" });
    return;
  }
  const todos = setTodoDone(lead.id, req.params.todoId, done);
  if (!todos) {
    res.status(404).json({ error: "lead not found" });
    return;
  }
  res.json({ ok: true, todos });
});

/** Delete a to-do item from a lead. */
crmRouter.delete("/api/leads/:id/todos/:todoId", requirePass, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  const todos = deleteTodo(lead.id, req.params.todoId);
  if (!todos) {
    res.status(404).json({ error: "lead not found" });
    return;
  }
  res.json({ ok: true, todos });
});

crmRouter.post("/api/leads/:id/todos/:todoId/restore", requirePass, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  const todos = restoreTodo(lead.id, req.params.todoId);
  if (!todos) {
    res.status(404).json({ error: "lead not found" });
    return;
  }
  res.json({ ok: true, todos });
});

/** Update a lead (status, pipeline_stage, owner, fields, tags…). */
crmRouter.get("/api/leads/:id/sensitive", requirePortalVerified, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  try {
    const sensitive = getBorrowerSensitiveData(lead.id, { audit: true, author: req.authUser?.username });
    res.json({ ok: true, configured: borrowerSensitiveConfigured(), sensitive });
  } catch (err) {
    res.status(500).json({ error: `sensitive data could not be opened: ${err instanceof Error ? err.message : String(err)}` });
  }
});

crmRouter.post("/api/leads/:id/sensitive", requirePortalVerified, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  if (!borrowerSensitiveConfigured()) {
    res.status(503).json({ error: "BORROWER_DATA_KEY is required before saving sensitive borrower data" });
    return;
  }
  try {
    const body = (req.body ?? {}) as { data?: BorrowerSensitiveData };
    const sensitive = saveBorrowerSensitiveData(lead, body.data ?? {}, req.authUser?.username);
    res.json({ ok: true, lead: getLead(lead.id), sensitive });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

crmRouter.patch("/api/leads/:id", requirePass, (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const existing = accessibleLead(req, res);
  if (!existing) return;
  if (ownerScope(req)) delete body.owner_user_id;
  // Guard the kanban column so a bad drop/typo can't write an off-board stage.
  if (body.pipeline_stage !== undefined && !isPipelineStage(body.pipeline_stage as string)) {
    res.status(400).json({ error: `pipeline_stage must be one of: ${PIPELINE_STAGES.map((s) => s.name).join(", ")}` });
    return;
  }
  // Past-client flag is routed through markPastClient so the remarketing trigger fires on
  // the 0->1 transition — strip it here so updateLead doesn't also set it silently.
  const pastClientReq = body.past_client;
  delete body.past_client;
  const lead = updateLead(existing.id, body);
  if (!lead) {
    res.status(404).json({ error: "lead not found" });
    return;
  }
  if (pastClientReq === false) {
    updateLead(existing.id, { past_client: false });
  } else if (pastClientReq === true || lead.pipeline_stage === "Funded") {
    markPastClient(existing.id); // sets the flag + fires the past_client trigger once (0->1)
  }
  res.json({ ok: true, lead: getLead(existing.id) });
});

/** Delete a lead (notes + activity timeline cascade; pending automation steps cancelled). */
crmRouter.delete("/api/leads/:id", requirePass, (req, res) => {
  // 404 only when the lead truly doesn't exist; deleting an already-deleted lead is
  // idempotent (still returns ok) so a stale view never shows a spurious "lead not found".
  const lead = accessibleLead(req, res);
  if (!lead) return;
  deleteLead(lead.id);
  res.json({ ok: true, deleted: lead.id, permanent: false });
});

/** Restore a soft-deleted lead back into the active list. */
crmRouter.post("/api/leads/:id/restore", requirePass, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  if (!restoreLead(lead.id)) {
    res.status(404).json({ error: "lead not found" });
    return;
  }
  res.json({ ok: true, restored: lead.id });
});

/** Add a note to a lead. */
crmRouter.post("/api/leads/:id/notes", requirePass, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  const body = (req.body ?? {}) as { body?: string; author?: string };
  if (!body.body || !body.body.trim()) {
    res.status(400).json({ error: "pass a note body" });
    return;
  }
  res.json({ ok: true, note: addNote(lead.id, body.body.trim(), body.author) });
});

/** Send a text to a lead (iMessage-first → SMS) and log it on the timeline. */
crmRouter.post("/api/leads/:id/message", requirePass, async (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  if (!lead.phone) {
    res.status(400).json({ error: "lead has no phone" });
    return;
  }
  const messageTemplate = (req.body?.message ?? "").toString().trim();
  if (!messageTemplate) {
    res.status(400).json({ error: "pass a message" });
    return;
  }
  try {
    const message = renderLeadMergeTemplate(messageTemplate, lead);
    const r = await sendOutbound({ phone: lead.phone, message, smsFrom: req.body?.from });
    const channel = r.path.startsWith("imessage") ? "imessage" : "sms";
    logActivity(lead.id, {
      type: channel,
      direction: "outbound",
      channel,
      body: message,
      status: r.ok ? r.path : `failed:${r.path}`,
      meta: { detail: r.detail, author: req.body?.author },
    });
    res.json({ ok: r.ok, path: r.path, detail: r.detail });
  } catch (err) {
    log.error("lead message error", { err: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

// ── Email composer (per-lead + standalone) ──────────────────────────────────
// Manual one-off emails (NOT drip automations). Both send through the same branded
// Resend shell as the drip + welcome emails, so everything looks identical, and support
// a Subject line and CC recipients (e.g. a co-borrower or a partner).

/** HTML-escape a manually typed body so a stray < or & can't break the markup. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Does this look like a single email address? Linear string checks (no backtracking regex,
 *  so no ReDoS): exactly one '@', non-empty space-free local part, and a domain with a dot
 *  that isn't first/last and no spaces. */
function looksLikeEmail(s: string): boolean {
  const at = s.indexOf("@");
  if (at <= 0 || at !== s.lastIndexOf("@")) return false;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (!local || /\s/.test(local) || /\s/.test(domain)) return false;
  const dot = domain.lastIndexOf(".");
  return dot > 0 && dot < domain.length - 1;
}

/** Accept CC as a string ("a@x.com, b@y.com" — also space/newline separated) or an array;
 *  return a clean, de-duped list of things that look like email addresses. Dropping junk
 *  entries matters because one malformed CC makes Resend reject the whole send. */
function parseCc(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,;\s]+/) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const s = String(p).trim();
    if (!looksLikeEmail(s)) continue;
    const key = s.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(s); }
  }
  return out;
}

/** Validate attachments: [{ filename, content(base64) }]. Caps total size (~10MB base64). */
function parseAttachments(raw: unknown): Array<{ filename: string; content: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ filename: string; content: string }> = [];
  let total = 0;
  for (const a of raw) {
    const filename = a && typeof a.filename === "string" ? a.filename.trim() : "";
    const content = a && typeof a.content === "string" ? a.content : "";
    if (!filename || !content) continue;
    total += content.length;
    if (total > 14_000_000) break; // ~10MB of binary once base64-decoded
    out.push({ filename, content });
  }
  return out;
}

/** Wrap a plain-text body in the branded email shell (HTML + text variants). */
function buildBrandedEmail(bodyText: string, unsubUrl: string): { html: string; text: string } {
  const paragraphsHtml = bodyText
    .split("\n\n")
    .map((p) => `<p style="margin:0 0 16px;">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const html = renderBrandedEmailHtml({ bodyHtml: paragraphsHtml, unsubUrl });
  const text = `${bodyText}\n\n${emailSignatureText()}${emailFooterText(unsubUrl)}`;
  return { html, text };
}

/** Send a one-off branded email to a lead (Subject + optional CC) and log it. */
crmRouter.post("/api/leads/:id/email", requirePass, async (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  if (!lead.email) {
    res.status(400).json({ error: "lead has no email" });
    return;
  }
  if (!emailConfigured()) {
    res.status(400).json({ error: "email not configured (set RESEND_API_KEY + EMAIL_FROM)" });
    return;
  }
  if (isEmailUnsubscribed(lead)) {
    res.status(400).json({ error: "this lead unsubscribed from email" });
    return;
  }
  const subjectTemplate = (req.body?.subject ?? "").toString().trim();
  const bodyTemplate = (req.body?.body ?? "").toString().trim();
  const cc = parseCc(req.body?.cc);
  if (!subjectTemplate) {
    res.status(400).json({ error: "pass a subject" });
    return;
  }
  if (!bodyTemplate) {
    res.status(400).json({ error: "pass a body" });
    return;
  }
  const subject = renderLeadMergeTemplate(subjectTemplate, lead);
  const bodyText = renderLeadMergeTemplate(bodyTemplate, lead);
  const { html, text } = buildBrandedEmail(bodyText, unsubscribeUrl(lead.id));
  const r = await sendEmail({ to: lead.email, subject, html, text, cc, attachments: parseAttachments(req.body?.attachments) });
  logActivity(lead.id, {
    type: "email",
    direction: "outbound",
    channel: "email",
    subject,
    body: bodyText,
    status: r.ok ? "sent" : `failed:${r.detail ?? "send failed"}`,
    meta: { id: r.id, detail: r.detail, cc: cc.length ? cc : undefined, author: req.body?.author },
  });
  res.json({ ok: r.ok, id: r.id, detail: r.detail });
});

/** Standalone email composer: send to any address (Subject + optional CC). If the
 *  recipient matches a known lead, thread the email onto that lead's timeline and use
 *  their one-click unsubscribe link; otherwise fall back to a mailto unsubscribe. */
crmRouter.post("/api/email/send", requirePass, async (req, res) => {
  if (!emailConfigured()) {
    res.status(400).json({ error: "email not configured (set RESEND_API_KEY + EMAIL_FROM)" });
    return;
  }
  const to = (req.body?.to ?? "").toString().trim();
  const subject = (req.body?.subject ?? "").toString().trim();
  const bodyText = (req.body?.body ?? "").toString().trim();
  const cc = parseCc(req.body?.cc);
  if (!to) {
    res.status(400).json({ error: "pass a recipient (to)" });
    return;
  }
  if (!subject) {
    res.status(400).json({ error: "pass a subject" });
    return;
  }
  if (!bodyText) {
    res.status(400).json({ error: "pass a body" });
    return;
  }
  const lead = findLead({ email: to });
  if (lead && isEmailUnsubscribed(lead)) {
    res.status(400).json({ error: "this address unsubscribed from email" });
    return;
  }
  const unsubUrl = lead
    ? unsubscribeUrl(lead.id)
    : `mailto:${config.email.fromEmail || "unsubscribe"}?subject=${encodeURIComponent("Unsubscribe")}`;
  const { html, text } = buildBrandedEmail(bodyText, unsubUrl);
  const r = await sendEmail({ to, subject, html, text, cc, attachments: parseAttachments(req.body?.attachments) });
  if (lead) {
    logActivity(lead.id, {
      type: "email",
      direction: "outbound",
      channel: "email",
      subject,
      body: bodyText,
      status: r.ok ? "sent" : `failed:${r.detail ?? "send failed"}`,
      meta: { id: r.id, detail: r.detail, cc: cc.length ? cc : undefined, author: req.body?.author },
    });
  }
  res.json({ ok: r.ok, id: r.id, detail: r.detail, leadId: lead?.id ?? null });
});

/** Admin-only: record (or withdraw) SMS consent for a lead. Audited on the timeline.
 *  Body: { on?, note?, author? }. */
crmRouter.post("/api/leads/:id/sms-consent", requireAdmin, (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) {
    res.status(404).json({ error: "lead not found" });
    return;
  }
  const on = req.body?.on !== false; // default true (recording consent)
  const note = (req.body?.note ?? "").toString().trim() || undefined;
  const author = (req.body?.author ?? "").toString().trim() || undefined;
  const updated = setSmsConsent(lead.id, on, { note, author });
  res.json({ ok: true, lead: updated });
});

/** Add / remove a lead's number on the Do-Not-Contact list. DNC is the one hard
 *  suppression: drip texts, manual router sends, calls, and voicemail drops all check it.
 *  Audited on the timeline. Body: { on: boolean, note?, author? }. */
crmRouter.post("/api/leads/:id/dnc", requirePass, async (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  if (!lead.phone) {
    res.status(400).json({ error: "lead has no phone number to suppress" });
    return;
  }
  const on = req.body?.on !== false; // default true (adding to DNC)
  const note = (req.body?.note ?? "").toString().trim();
  const author = (req.body?.author ?? "").toString().trim() || "console";
  try {
    if (on) {
      await addToDnc(lead.phone, note || "console-manual");
      // Pause any in-flight drip immediately — DNC would skip each step anyway, but
      // stopping the run keeps the campaign panel honest ("stopped", not "running").
      stopLeadAutomations(lead.id, "added to DNC");
    } else {
      await removeFromDnc(lead.phone);
    }
    logActivity(lead.id, {
      type: "dnc",
      direction: "system",
      channel: "system",
      body: on
        ? `Added to Do-Not-Contact list${note ? `: ${note}` : ""}`
        : `Removed from Do-Not-Contact list${note ? `: ${note}` : ""}`,
      status: on ? "dnc-on" : "dnc-off",
      meta: { author, phone: lead.phone },
    });
    res.json({ ok: true, dnc: on, lead: getLead(lead.id) });
  } catch (err) {
    log.error("lead dnc toggle error", { err: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

/** Resend the Quick Quote (email via the website quote engine) + a text with the
 *  options link. The email's two options are built from the lead's stored quote fields. */
crmRouter.post("/api/leads/:id/resend-quote", requirePass, async (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  if (!lead.email) {
    res.status(400).json({ error: "lead has no email" });
    return;
  }
  const c = lead.custom || {};
  const f = (k: string): string => (c[k] != null ? String(c[k]) : "");
  const benefits = [
    "Lower your rate or monthly payment",
    "Consolidate higher-interest debt into one payment",
    "Tap your equity with no second monthly payment (cash-out)",
    "Soft credit review only — no obligation",
  ];
  const payload = {
    clientEmail: lead.email,
    clientName: [lead.first_name, lead.last_name].filter(Boolean).join(" ").trim(),
    clientPhone: lead.phone || "",
    source: "crm-resend",
    benefits,
    options: {
      loanType: f("loan_goal") || "CASHOUT_REFI",
      a: { termLabel: f("term"), loanAmount: f("loan_amount"), payoff: f("mortgage_balance"), cashOut: f("cash_out"), rate: f("rate"), apr: f("apr"), payment: f("monthly_payment") },
      b: { termLabel: f("term"), lineAmount: f("heloc_line"), draw: "", rate: f("rate"), apr: f("apr"), payment: f("monthly_payment") },
    },
  };
  // 1. Email via the website Quick-Quote engine (reuses its template + Resend send).
  let emailOk = false;
  let emailError: string | undefined;
  try {
    const r = await fetch(config.quoteSendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = (await r.json().catch(() => ({}))) as { success?: boolean; emailOk?: boolean; error?: string; emailError?: string };
    emailOk = r.ok && j.success !== false && j.emailOk !== false;
    if (!emailOk) emailError = j.emailError || j.error || `HTTP ${r.status}`;
  } catch (e) {
    emailError = e instanceof Error ? e.message : String(e);
  }
  logActivity(lead.id, {
    type: "email",
    direction: "outbound",
    channel: "email",
    body: "Quick Quote + benefits resent",
    status: emailOk ? "sent" : `failed:${emailError}`,
  });
  // 2. Text the options link (LO-initiated; the router still suppresses DNC numbers).
  let textPath = "skipped: no phone";
  if (lead.phone) {
    const msg = `Hi ${lead.first_name || "there"}, here are your loan options from Adaxa: ${config.optionsLinkUrl} — reply with any questions.`;
    const sr = await sendOutbound({ phone: lead.phone, message: msg });
    textPath = sr.path;
    const channel = sr.path.startsWith("imessage") ? "imessage" : "sms";
    logActivity(lead.id, {
      type: channel,
      direction: "outbound",
      channel,
      body: msg,
      status: sr.ok ? sr.path : `failed:${sr.path}`,
      meta: { detail: sr.detail, kind: "quote-link" },
    });
  }
  res.json({ ok: true, emailOk, emailError, textPath });
});

/** Click-to-call a lead (rings your cell, bridges to the lead). DNC-gated. */
crmRouter.post("/api/leads/:id/call", requirePass, async (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  if (!lead.phone) {
    res.status(400).json({ error: "lead has no phone" });
    return;
  }
  try {
    const r = await startClickToCall({ phone: lead.phone });
    logActivity(lead.id, {
      type: "call",
      direction: "outbound",
      channel: "voice",
      body: `Click-to-call ${lead.phone}`,
      status: "ok" in r ? "placed" : "skipped" in r ? `skipped:${r.reason}` : "error",
    });
    res.json(r);
  } catch (err) {
    log.error("lead call error", { err: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

/** Manually run the new-lead automation(s) against a lead (testing / re-engage). */
crmRouter.post("/api/leads/:id/run-automation", requirePass, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  const started = fireTrigger("lead_created", lead);
  const diag = diagnoseEnrollment("lead_created", lead);
  res.json({ ok: true, automationStarted: started, note: diag.note ?? undefined });
});

/** Per-lead campaign controls (the compact ⚙ panel in the console lead detail). */
crmRouter.get("/api/leads/:id/campaign", requirePass, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  res.json(leadCampaignState(lead.id));
});
crmRouter.post("/api/leads/:id/campaign/stop", requirePass, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  res.json({ ok: true, paused: stopLeadAutomations(lead.id, "stopped from console") });
});
crmRouter.post("/api/leads/:id/campaign/resume", requirePass, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  res.json({ ok: true, resumed: resumeLeadAutomations(lead.id) });
});
crmRouter.post("/api/leads/:id/campaign/next", requirePass, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  res.json({ ok: advancePhase(lead.id) });
});
crmRouter.post("/api/leads/:id/campaign/back", requirePass, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  res.json({ ok: rewindPhase(lead.id) });
});
/** Manually enroll / switch the lead into a chosen campaign (stops any running flow first).
 *  Body: { automationId }. */
crmRouter.post("/api/leads/:id/campaign/enroll", requirePass, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  const automationId = (req.body ?? {}).automationId;
  if (typeof automationId !== "string" || !automationId) {
    res.status(400).json({ error: "pass { automationId }" });
    return;
  }
  const ok = enrollLeadInAutomation(lead.id, automationId);
  if (!ok) {
    res.status(400).json({ error: "could not enroll (lead or campaign not found, or campaign has no steps)" });
    return;
  }
  res.json({ ok: true });
});

/** Delete a single activity from a lead's timeline. */
crmRouter.delete("/api/leads/:id/activities/:activityId", requirePass, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  res.json({ ok: deleteActivity(lead.id, req.params.activityId) });
});

crmRouter.post("/api/leads/:id/activities/:activityId/restore", requirePass, (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  res.json({ ok: restoreActivity(lead.id, req.params.activityId) });
});

/** Send an iMessage tapback reaction through BlueBubbles Private API. */
crmRouter.post("/api/leads/:id/activities/:activityId/react", requirePass, async (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  const reaction = String(req.body?.reaction ?? "") as BlueBubblesReaction;
  const allowed = new Set(["love", "like", "dislike", "laugh", "emphasize", "question", "-love", "-like", "-dislike", "-laugh", "-emphasize", "-question"]);
  if (!allowed.has(reaction)) {
    res.status(400).json({ error: "pass a valid reaction" });
    return;
  }
  const activity = getActivity(lead.id, req.params.activityId);
  if (!activity) {
    res.status(404).json({ error: "activity not found" });
    return;
  }
  const meta = (activity.meta ?? {}) as Record<string, unknown>;
  const chatGuid = typeof meta.chatGuid === "string" ? meta.chatGuid : "";
  const messageGuid = typeof meta.messageGuid === "string" ? meta.messageGuid : "";
  if (!chatGuid || !messageGuid) {
    res.status(400).json({ error: "this message does not have BlueBubbles chat/message GUIDs yet" });
    return;
  }
  const result = await reactToMessage(chatGuid, messageGuid, reaction);
  if (result.outcome !== "success") {
    res.status(502).json({ error: result.raw || result.outcome, outcome: result.outcome, status: result.status });
    return;
  }
  logActivity(lead.id, {
    type: "imessage",
    direction: "outbound",
    channel: "imessage",
    body: `Reacted ${reaction} to: ${activity.body || activity.subject || "message"}`,
    status: "reaction-sent",
    meta: { reaction, activityId: activity.id, chatGuid, messageGuid },
  });
  res.json({ ok: true, reaction });
});

// ── Automations API (passcode-gated) ─────────────────────────────────────────

crmRouter.get("/api/automations", requirePass, (_req, res) => {
  res.json({ automations: listAutomations() });
});

/** Flows health: email/SMS config, worker backlog, enabled-flow count (diagnostics panel). */
crmRouter.get("/api/automations/health", requirePass, (_req, res) => {
  res.json(getAutomationHealth());
});

/** Recent automation step outcomes (what sent vs skipped, and why) — diagnostics. */
crmRouter.get("/api/automations/activity", requirePass, (req, res) => {
  const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 40;
  res.json({ activity: recentAutomationActivity(limit) });
});

crmRouter.post("/api/automations", requirePass, (req, res) => {
  const body = (req.body ?? {}) as { name?: string; trigger?: string; enabled?: boolean; steps?: Step[]; filter?: Record<string, unknown> };
  if (!body.name) {
    res.status(400).json({ error: "pass a name" });
    return;
  }
  res.json({ ok: true, automation: createAutomation({ name: body.name, trigger: body.trigger, enabled: body.enabled, steps: body.steps, filter: body.filter }) });
});

crmRouter.patch("/api/automations/:id", requirePass, (req, res) => {
  const updated = updateAutomation(req.params.id, (req.body ?? {}) as Record<string, unknown>);
  if (!updated) {
    res.status(404).json({ error: "automation not found" });
    return;
  }
  res.json({ ok: true, automation: updated });
});
