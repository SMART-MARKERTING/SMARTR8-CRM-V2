import { randomUUID } from "crypto";
import { resolveMx } from "dns/promises";
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
  listLeadPoolLeads,
  repairLeadPoolVisibility,
  listDuplicateLeadGroups,
  bulkCreateContacts,
  contactsDiag,
  LeadInput,
  Lead,
  LeadStatus,
  resolveLeadTimezone,
} from "../services/leads";
import { listAllContacts } from "../services/ghl";
import {
  sendEmail,
  emailConfigured,
  listReceivedEmails,
  listResendWebhooks,
  retrieveResendWebhook,
  retrieveReceivedEmail,
  retrieveSentEmail,
  retrieveSentEmailAttachment,
  sendBatchEmails,
  listSentEmails,
  listSentEmailAttachments,
  updateScheduledEmail,
  cancelScheduledEmail,
} from "../services/email";
import { getRecentResendInboundWebhookHits, selfTestResendWebhookSignature, storeReceivedEmail } from "../services/resendInbound";
import { brand, renderBrandedEmailHtml, emailSignatureText, emailFooterText } from "../brand";
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
import { getLeadDocument, getLeadDocumentPath, listLeadDocuments, saveLeadDocument, softDeleteLeadDocument, updateLeadDocumentMetadata, type LeadDocument } from "../services/documents";
import { listSettlementVendorSettings, saveSettlementVendorSettings, SettlementVendorKind } from "../services/loanServiceSettings";
import { mimeForExt, publicMediaUrl, supportedMediaExt, writeMediaFile } from "../services/media";
import { applyLegacyCrmSync } from "../services/legacyCrmSync";
import {
  generateVoicemailAudio,
  publicElevenLabsSettings,
  saveElevenLabsSettings,
} from "../services/elevenLabs";
import { verifyToken } from "../util/token";
import { PIPELINE_STAGES, DEFAULT_STAGE, isPipelineStage } from "../pipeline";
import { getContactMessages } from "../services/ghl";
import { sendLeadEvent } from "../services/metaCapi";
import { recordAudit, listAuditEvents } from "../services/audit";
import { buildCrmReport, reportPdfBuffer } from "../services/reports";
import { listCallSummaries, processCallSummary } from "../services/callSummary";
import {
  handleInboundWhatsAppWebhook,
  listWhatsAppMessages,
  sendWhatsAppTemplate,
  sendWhatsAppText,
  simulateInboundWhatsApp,
  whatsAppProviderStatus,
  whatsappTemplateOptions,
} from "../services/whatsapp";

export const crmRouter = Router();

crmRouter.use((req, res, next) => {
  const method = req.method.toUpperCase();
  const shouldAudit = method !== "GET" && !req.path.startsWith("/sync/legacy-crm");
  if (shouldAudit) {
    res.on("finish", () => {
      if (!req.authUser) return;
      recordAudit({
        req,
        action: `${method} ${req.path}`,
        statusCode: res.statusCode,
        detail: res.statusCode >= 400 ? "failed" : "completed",
      });
    });
  }
  next();
});

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

/** Top-bar notification feed: recent missed calls, inbound texts/iMessages/WhatsApp,
 *  and inbound Resend emails. */
crmRouter.get("/api/notifications", requirePass, (req, res) => {
  try {
    const parsedLimit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 75;
    const limit = Math.min(Math.max(parsedLimit || 75, 1), 150);
    const owner = ownerScope(req);
    const ownerWhere = owner ? "AND l.owner_user_id = @owner" : "";
    const ownerCallWhere = owner ? "AND c.lead_id IN (SELECT id FROM leads WHERE owner_user_id = @owner)" : "";
    const dismissedNotifications = dismissedDashboardIds("notification");
    const missedCalls = db
      .prepare(
        `SELECT c.id, c.created_at, c.phone, c.name, c.lead_id, l.first_name, l.last_name, l.email
           FROM call_log c
           LEFT JOIN leads l ON l.id = c.lead_id
          WHERE c.deleted_at IS NULL
            AND c.direction = 'inbound'
            AND c.outcome = 'missed'
            ${ownerCallWhere}
          ORDER BY c.created_at DESC
          LIMIT @limit`,
      )
      .all({ owner: owner || "", limit }) as Array<{ id: string; created_at: number; phone: string | null; name: string | null; lead_id: string | null; first_name: string | null; last_name: string | null; email: string | null }>;
    const inboundMessages = db
      .prepare(
        `SELECT a.id, a.lead_id, a.type, a.channel, a.body, a.subject, a.created_at,
                l.first_name, l.last_name, l.phone, l.email
           FROM activities a
           JOIN leads l ON l.id = a.lead_id
          WHERE a.deleted_at IS NULL
            AND l.deleted_at IS NULL
            AND a.direction = 'inbound'
            AND (
              a.type IN ('sms','imessage','whatsapp')
              OR a.channel IN ('sms','imessage','whatsapp')
              OR a.type = 'email'
              OR a.channel = 'email'
            )
            ${ownerWhere}
          ORDER BY a.created_at DESC
          LIMIT @limit`,
      )
      .all({ owner: owner || "", limit }) as Array<{ id: string; lead_id: string; type: string; channel: string | null; body: string | null; subject: string | null; created_at: number; first_name: string | null; last_name: string | null; phone: string | null; email: string | null }>;
    const notifications = [
      ...missedCalls.map((c) => ({
        id: `call:${c.id}`,
        kind: "missed_call",
        title: "Missed call",
        at: c.created_at,
        leadId: c.lead_id,
        name: c.name || [c.first_name, c.last_name].filter(Boolean).join(" ") || c.phone || "Unknown caller",
        contact: c.phone || c.email || "",
        preview: "Inbound call was missed.",
      })),
      ...inboundMessages.map((a) => {
        const isEmail = a.type === "email" || a.channel === "email";
        const channel = a.channel || a.type || (isEmail ? "email" : "message");
        return {
          id: `${isEmail ? "email" : "message"}:${a.id}`,
          kind: isEmail ? "email" : "text",
          title: isEmail ? "Incoming email" : `Incoming ${channel}`,
          at: a.created_at,
          leadId: a.lead_id,
          name: [a.first_name, a.last_name].filter(Boolean).join(" ") || a.phone || a.email || "Lead",
          contact: isEmail ? a.email || a.phone || "" : a.phone || a.email || "",
          preview: isEmail ? a.subject || a.body || "" : a.body || a.subject || "",
        };
      }),
    ]
      .filter((n) => !dismissedNotifications.has(n.id))
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
    res.json({ ok: true, count: notifications.length, notifications });
  } catch (err) {
    log.error("notifications error", { err: String(err) });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** True when a generated Notification Center item still exists and belongs to this user. */
function notificationVisibleToRequest(req: Request, notificationId: string): boolean {
  const [kind, sourceId] = notificationId.split(":");
  if (!kind || !sourceId || !/^(call|email|message)$/.test(kind)) return false;
  const owner = ownerScope(req);
  if (kind === "call") {
    const row = db
      .prepare(
        `SELECT c.id
           FROM call_log c
           LEFT JOIN leads l ON l.id = c.lead_id
          WHERE c.id = @id
            AND c.deleted_at IS NULL
            AND c.direction = 'inbound'
            AND c.outcome = 'missed'
            ${owner ? "AND c.lead_id IN (SELECT id FROM leads WHERE owner_user_id = @owner)" : ""}
          LIMIT 1`,
      )
      .get({ id: sourceId, owner: owner || "" }) as { id: string } | undefined;
    return Boolean(row);
  }
  const row = db
    .prepare(
      `SELECT a.id
         FROM activities a
         JOIN leads l ON l.id = a.lead_id
        WHERE a.id = @id
          AND a.deleted_at IS NULL
          AND l.deleted_at IS NULL
          AND a.direction = 'inbound'
          AND (
            a.type IN ('sms','imessage','whatsapp')
            OR a.channel IN ('sms','imessage','whatsapp')
            OR a.type = 'email'
            OR a.channel = 'email'
          )
          ${owner ? "AND l.owner_user_id = @owner" : ""}
        LIMIT 1`,
    )
    .get({ id: sourceId, owner: owner || "" }) as { id: string } | undefined;
  return Boolean(row);
}

crmRouter.delete("/api/notifications/:notificationId", requirePass, (req, res) => {
  const notificationId = cleanText(req.params.notificationId);
  if (!notificationId) {
    res.status(400).json({ error: "notification id required" });
    return;
  }
  if (!notificationVisibleToRequest(req, notificationId)) {
    res.status(404).json({ error: "notification not found" });
    return;
  }
  dismissDashboardItem("notification", notificationId);
  res.json({ ok: true, id: notificationId });
});

crmRouter.get("/api/call-summaries", requirePass, (req, res) => {
  const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 100;
  res.json({ ok: true, call_summaries: listCallSummaries(limit) });
});

crmRouter.post("/api/call-summaries/:id/retry", requirePass, async (req, res) => {
  try {
    const row = await processCallSummary(req.params.id);
    if (!row) {
      res.status(404).json({ error: "call summary not found" });
      return;
    }
    res.json({ ok: true, call_summary: row });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
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

function accessibleLeadById(req: Request, res: Response, id: string): Lead | null {
  const lead = getLead(id);
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

crmRouter.get("/api/whatsapp/status", requirePass, (_req, res) => {
  res.json({ ok: true, ...whatsAppProviderStatus() });
});

crmRouter.post("/api/whatsapp/send", requirePass, async (req, res) => {
  const body = (req.body ?? {}) as {
    contactId?: string;
    leadId?: string;
    phone?: string;
    message?: string;
    body?: string;
    templateName?: string;
    template_name?: string;
    templateVariables?: Record<string, string | number | null | undefined>;
    variables?: Record<string, string | number | null | undefined>;
    aiAutoSend?: boolean;
  };
  const contactId = cleanText(body.contactId || body.leadId);
  if (contactId && !accessibleLeadById(req, res, contactId)) return;
  if (!contactId && !body.phone) {
    res.status(400).json({ error: "pass contactId/leadId or phone" });
    return;
  }
  try {
    const templateName = cleanText(body.templateName || body.template_name);
    const messageBody = cleanText(body.message || body.body);
    if (!templateName && !messageBody) {
      res.status(400).json({ error: "pass message/body or templateName" });
      return;
    }
    const actor = leadActionAuthor(req);
    const result = templateName
      ? await sendWhatsAppTemplate({
          contactId: contactId || undefined,
          phone: body.phone,
          templateName,
          variables: body.templateVariables || body.variables || {},
          actor,
          aiAutoSend: body.aiAutoSend === true,
        })
      : await sendWhatsAppText({
          contactId: contactId || undefined,
          phone: body.phone,
          body: messageBody,
          actor,
          aiAutoSend: body.aiAutoSend === true,
        });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    log.error("WhatsApp send failed", { err: String(err) });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

crmRouter.get("/api/webhooks/whatsapp", (req, res) => {
  const mode = cleanText(req.query["hub.mode"]);
  const token = cleanText(req.query["hub.verify_token"]);
  const challenge = cleanText(req.query["hub.challenge"]);
  if (mode === "subscribe" && token && token === config.whatsapp.verifyToken) {
    res.status(200).send(challenge);
    return;
  }
  res.status(403).send("verification failed");
});

crmRouter.post("/api/webhooks/whatsapp", async (req, res) => {
  try {
    const result = await handleInboundWhatsAppWebhook(req);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

crmRouter.get("/api/whatsapp/debug", requireAdmin, (_req, res) => {
  res.json({
    ok: true,
    status: whatsAppProviderStatus(),
    templates: whatsappTemplateOptions(),
    recent: listWhatsAppMessages(undefined, 25),
  });
});

crmRouter.post("/api/whatsapp/debug/simulate-inbound", requireAdmin, (req, res) => {
  const body = (req.body ?? {}) as { phone?: string; body?: string; message?: string };
  if (!body.phone || !(body.body || body.message)) {
    res.status(400).json({ error: "pass phone and body/message" });
    return;
  }
  const result = simulateInboundWhatsApp({ phone: body.phone, body: body.body || body.message || "" });
  res.json({ ok: true, leadId: result.lead.id, message: result.message });
});

crmRouter.get("/debug/whatsapp", requireAdmin, (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp Debug</title>
<style>
body{font-family:Arial,sans-serif;background:#f5f7fb;color:#111827;margin:0;padding:24px}main{max-width:980px;margin:auto}
.card{background:#fff;border:1px solid #d8e0ec;border-radius:10px;padding:16px;margin:0 0 16px;box-shadow:0 1px 2px rgba(15,23,42,.06)}
label{display:block;font-weight:700;margin:10px 0 4px}input,textarea,select{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:10px;font:inherit}
button{border:1px solid #cbd5e1;border-radius:8px;background:#fff;padding:9px 12px;font-weight:800;cursor:pointer}button.primary{background:#1d4ed8;color:#fff;border-color:#1d4ed8}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.ok{color:#047857}.bad{color:#b91c1c}pre{white-space:pre-wrap;background:#0f172a;color:#e2e8f0;border-radius:8px;padding:12px;overflow:auto}
</style></head><body><main>
<h1>WhatsApp Debug</h1>
<section class="card"><h2>Status</h2><div id="status">Loading...</div><div class="toolbar"><button onclick="loadDebug()">Refresh</button></div></section>
<section class="card"><h2>Send Test</h2><label>Lead ID or phone</label><input id="target" placeholder="Lead id or +1623..."><label>Message</label><textarea id="msg" rows="4">Hi {{first_name}}, Mykoal with Adaxa Home here. I can help you check home equity options. Subject to approval.</textarea><div class="toolbar"><button class="primary" onclick="sendTest()">Send free-form</button><button onclick="sendTemplate()">Send HELOC template</button></div><div id="sendOut"></div></section>
<section class="card"><h2>Simulate Inbound</h2><label>Phone</label><input id="simPhone" placeholder="+1623..."><label>Inbound body</label><textarea id="simBody" rows="3">HELOC</textarea><div class="toolbar"><button class="primary" onclick="simulateInbound()">Simulate inbound webhook</button></div><div id="simOut"></div></section>
<section class="card"><h2>Recent WhatsApp log</h2><pre id="log"></pre></section>
</main><script>
const token=localStorage.getItem("sp_token")||"";
function headers(){return {"content-type":"application/json","x-session-token":token};}
async function api(path,opts={}){opts.headers=Object.assign(headers(),opts.headers||{});const r=await fetch(path,opts);const t=await r.text();let j={};try{j=JSON.parse(t)}catch{j={raw:t}}if(!r.ok)throw new Error(j.error||t||r.statusText);return j;}
async function loadDebug(){try{const j=await api("/api/whatsapp/debug");document.getElementById("status").innerHTML="<b>Provider:</b> "+j.status.provider+"<br><b>Configured:</b> "+j.status.configured+"<br><b>Warnings:</b> "+(j.status.warnings||[]).join("; ");document.getElementById("log").textContent=JSON.stringify(j.recent,null,2);}catch(e){document.getElementById("status").innerHTML='<span class="bad">'+e.message+"</span>";}}
async function sendTest(){const target=document.getElementById("target").value.trim();const body={message:document.getElementById("msg").value};if(target.startsWith("+"))body.phone=target;else body.contactId=target;try{document.getElementById("sendOut").textContent=JSON.stringify(await api("/api/whatsapp/send",{method:"POST",body:JSON.stringify(body)}),null,2);await loadDebug();}catch(e){document.getElementById("sendOut").innerHTML='<span class="bad">'+e.message+"</span>";}}
async function sendTemplate(){const target=document.getElementById("target").value.trim();const body={templateName:"heloc_follow_up",templateVariables:{}};if(target.startsWith("+"))body.phone=target;else body.contactId=target;try{document.getElementById("sendOut").textContent=JSON.stringify(await api("/api/whatsapp/send",{method:"POST",body:JSON.stringify(body)}),null,2);await loadDebug();}catch(e){document.getElementById("sendOut").innerHTML='<span class="bad">'+e.message+"</span>";}}
async function simulateInbound(){try{document.getElementById("simOut").textContent=JSON.stringify(await api("/api/whatsapp/debug/simulate-inbound",{method:"POST",body:JSON.stringify({phone:document.getElementById("simPhone").value,body:document.getElementById("simBody").value})}),null,2);await loadDebug();}catch(e){document.getElementById("simOut").innerHTML='<span class="bad">'+e.message+"</span>";}}
loadDebug();
</script></body></html>`);
});

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

function requestMountedBase(req: Request): string {
  const base = requestPublicBase(req).replace(/\/+$/, "");
  const mount = req.baseUrl || "";
  return mount && !base.endsWith(mount) ? `${base}${mount}` : base;
}

function cleanText(value: unknown, fallback = ""): string {
  const s = value === null || value === undefined ? "" : String(value).trim();
  return s || fallback;
}

function safeMeta(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return { raw: value };
  }
}

function leadDisplayName(lead: Lead): string {
  return [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.email || lead.phone || "Lead";
}

function leadContactScope(lead: Lead): string {
  if (isLeadPoolLead(lead)) return "Lead Pool";
  if (lead.past_client) return "Past Client";
  if (lead.contact_only) return "Contact";
  return "Lead";
}

function leadContactAddress(lead: Lead): string {
  const c = lead.custom || {};
  const street = cleanText(c.property_address || c.address || c.street);
  const city = cleanText(c.city || c.property_city);
  const state = cleanText(c.state || c.property_state || c.lead_pool_state);
  const zip = cleanText(c.zip || c.property_zip || c.postal_code);
  return [street, city, state, zip].filter(Boolean).join(", ");
}

function calendarStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function icsEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function calendarEventLinks(
  req: Request,
  event: { title: string; start: number; end: number; description?: string; location?: string },
) {
  const dates = `${calendarStamp(event.start)}/${calendarStamp(event.end)}`;
  const details = event.description || "";
  const location = event.location || "";
  const icsParams = new URLSearchParams({
    title: event.title,
    start: String(event.start),
    end: String(event.end),
    description: details,
    location,
  });
  const google = new URL("https://calendar.google.com/calendar/render");
  google.searchParams.set("action", "TEMPLATE");
  google.searchParams.set("text", event.title);
  google.searchParams.set("dates", dates);
  google.searchParams.set("details", details);
  google.searchParams.set("location", location);
  const outlook = new URL("https://outlook.office.com/calendar/0/deeplink/compose");
  outlook.searchParams.set("path", "/calendar/action/compose");
  outlook.searchParams.set("rru", "addevent");
  outlook.searchParams.set("subject", event.title);
  outlook.searchParams.set("startdt", new Date(event.start).toISOString());
  outlook.searchParams.set("enddt", new Date(event.end).toISOString());
  outlook.searchParams.set("body", details);
  outlook.searchParams.set("location", location);
  return {
    google: google.toString(),
    microsoft: outlook.toString(),
    outlook: outlook.toString(),
    apple: `${requestMountedBase(req)}/calendar.ics?${icsParams.toString()}`,
    ics: `${requestMountedBase(req)}/calendar.ics?${icsParams.toString()}`,
  };
}

function appointmentInviteBody(lead: Lead, event: { title: string; start: number; end: number; description?: string; location?: string }, links: Record<string, string>): string {
  const when = new Date(event.start).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return [
    `Hi ${lead.first_name || "there"},`,
    "",
    `Here is the appointment link for ${event.title}.`,
    `When: ${when}`,
    event.location ? `Where: ${event.location}` : "",
    event.description || "",
    "Add it to your calendar:",
    `Google/Gmail: ${links.google}`,
    `Microsoft/Outlook: ${links.microsoft}`,
    `Apple/iCloud/ICS: ${links.ics}`,
  ].filter((line) => line !== "").join("\n");
}

crmRouter.get("/calendar.ics", (req, res) => {
  const title = cleanText(req.query.title, "Appointment");
  const start = Number(req.query.start);
  const end = Number(req.query.end) || start + 30 * 60_000;
  if (!Number.isFinite(start) || start <= 0) {
    res.status(400).send("Missing valid start");
    return;
  }
  const description = cleanText(req.query.description);
  const location = cleanText(req.query.location);
  const uid = `${Buffer.from(`${title}:${start}:${end}`).toString("base64url")}@loangenius`;
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//LoanGenius//CRM Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${calendarStamp(Date.now())}`,
    `DTSTART:${calendarStamp(start)}`,
    `DTEND:${calendarStamp(end)}`,
    `SUMMARY:${icsEscape(title)}`,
    description ? `DESCRIPTION:${icsEscape(description)}` : "",
    location ? `LOCATION:${icsEscape(location)}` : "",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean).join("\r\n");
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60) || "appointment"}.ics"`);
  res.send(ics);
});

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
  const displayName =
    (typeof req.query.name === "string" && req.query.name) ||
    req.get("x-document-name") ||
    filename;
  const folderName =
    (typeof req.query.folder === "string" && req.query.folder) ||
    req.get("x-document-folder") ||
    "General";
  try {
    const doc = saveLeadDocument({
      lead,
      buffer,
      filename,
      docType,
      notes,
      displayName,
      folderName,
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

crmRouter.patch("/api/documents/:docId", requirePass, (req, res) => {
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
  const updated = updateLeadDocumentMetadata(doc, {
    displayName: typeof req.body?.display_name === "string" ? req.body.display_name : undefined,
    folderName: typeof req.body?.folder_name === "string" ? req.body.folder_name : undefined,
    notes: typeof req.body?.notes === "string" ? req.body.notes : undefined,
    author: leadActionAuthor(req),
  });
  res.json({
    ok: true,
    document: { ...updated, downloadUrl: publicDocumentUrl(updated.id) },
    documents: listLeadDocuments(doc.lead_id).map((item) => ({ ...item, downloadUrl: publicDocumentUrl(item.id) })),
  });
});

crmRouter.get("/api/documents/cabinet", requirePass, (req, res) => {
  const q = cleanText(req.query.q).toLowerCase();
  const ownerUserId = ownerScope(req);
  const leads = listLeads({
    limit: 20000,
    includePastClients: true,
    includeContactOnly: true,
    excludeLeadPool: false,
    ownerUserId,
  });
  const docsSql = `SELECT d.*
     FROM lead_documents d
     JOIN leads l ON l.id = d.lead_id
    WHERE d.deleted_at IS NULL
      AND l.deleted_at IS NULL
      ${ownerUserId ? "AND l.owner_user_id = @owner" : ""}
    ORDER BY d.lead_id ASC, COALESCE(d.folder_name, 'General') ASC, d.created_at DESC`;
  const docs = ownerUserId
    ? db.prepare(docsSql).all({ owner: ownerUserId }) as LeadDocument[]
    : db.prepare(docsSql).all() as LeadDocument[];
  const docsByLead = new Map<string, Array<LeadDocument & { downloadUrl: string }>>();
  for (const doc of docs) {
    const row = { ...doc, downloadUrl: publicDocumentUrl(doc.id) };
    const list = docsByLead.get(doc.lead_id) || [];
    list.push(row);
    docsByLead.set(doc.lead_id, list);
  }
  const qMatchesDocs = (leadId: string): boolean => {
    if (!q) return true;
    return (docsByLead.get(leadId) || []).some((doc) =>
      [
        doc.display_name,
        doc.original_name,
        doc.folder_name,
        doc.doc_type,
        doc.notes,
      ].join(" ").toLowerCase().includes(q),
    );
  };
  const rows = leads
    .filter((lead) => !q || qMatchesDocs(lead.id) || [
      leadDisplayName(lead),
      lead.email,
      lead.phone,
      leadContactAddress(lead),
      lead.source,
      lead.pipeline_stage,
      lead.status,
      lead.tags.join(" "),
    ].join(" ").toLowerCase().includes(q))
    .map((lead) => {
      const documents = docsByLead.get(lead.id) || [];
      return {
        id: lead.id,
        name: leadDisplayName(lead),
        first_name: lead.first_name,
        last_name: lead.last_name,
        phone: lead.phone,
        email: lead.email,
        source: lead.source,
        status: lead.status,
        pipeline_stage: lead.pipeline_stage,
        scope: leadContactScope(lead),
        address: leadContactAddress(lead),
        document_count: documents.length,
        latest_document_at: documents.reduce((latest, doc) => Math.max(latest, Number(doc.created_at || 0)), 0),
        documents,
      };
    });
  const folders = Array.from(new Set(docs.map((doc) => doc.folder_name || "General"))).sort((a, b) => a.localeCompare(b));
  const types = Array.from(new Set(docs.map((doc) => doc.doc_type || "other"))).sort((a, b) => a.localeCompare(b));
  res.json({
    ok: true,
    summary: {
      leads: rows.length,
      leads_with_files: rows.filter((row) => row.document_count > 0).length,
      files: rows.reduce((sum, row) => sum + row.document_count, 0),
      folders: folders.length,
      types: types.length,
    },
    folders,
    types,
    rows,
  });
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
  const includePastClients = req.query.includePastClients === "1" || req.query.includePastClients === "true";
  const contactOnly =
    req.query.contactOnly === "1" || req.query.contactOnly === "true"
      ? true
      : req.query.contactOnly === "0" || req.query.contactOnly === "false"
        ? false
        : undefined;
  // The Contacts tab passes includeContacts=1 to also get contact-only records; the Leads
  // tab omits it, so contact-only people stay out of the active pipeline.
  const includeContactOnly = req.query.includeContacts === "1" || req.query.includeContacts === "true";
  const excludeLeadPool = !(req.query.includeLeadPool === "1" || req.query.includeLeadPool === "true");
  const ownerUserId = ownerScope(req);
  res.json({
    leads: listLeads({
      q,
      status,
      stage,
      limit,
      deleted,
      pastClient,
      includePastClients,
      contactOnly,
      includeContactOnly,
      excludeLeadPool,
      ownerUserId,
    }),
    stats: leadStats(ownerUserId),
  });
});

crmRouter.get("/api/contacts/all", requirePass, (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 20000;
  const ownerUserId = ownerScope(req);
  const leads = listLeads({
    q,
    limit,
    includePastClients: true,
    includeContactOnly: true,
    excludeLeadPool: false,
    ownerUserId,
  });
  const contacts = leads.map((lead) => ({
    id: lead.id,
    name: leadDisplayName(lead),
    first_name: lead.first_name,
    last_name: lead.last_name,
    phone: lead.phone,
    email: lead.email,
    source: lead.source,
    scope: leadContactScope(lead),
    status: lead.pipeline_stage || lead.status,
    address: leadContactAddress(lead),
    last_contact_at: lead.last_activity_at || lead.updated_at || lead.created_at,
    sms_consent: lead.sms_consent,
    email_unsubscribed: lead.email_unsubscribed,
  }));
  const counts = contacts.reduce<Record<string, number>>((acc, item) => {
    acc[item.scope] = (acc[item.scope] || 0) + 1;
    acc.All = (acc.All || 0) + 1;
    return acc;
  }, {});
  res.json({ ok: true, contacts, counts });
});

crmRouter.get("/api/duplicates", requirePass, (req, res) => {
  const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
  const includeDeleted = req.query.includeDeleted === "1" || req.query.includeDeleted === "true";
  const ownerUserId = ownerScope(req);
  const groups = listDuplicateLeadGroups({ limit, includeDeleted, ownerUserId });
  res.json({
    ok: true,
    groups,
    groupCount: groups.length,
    duplicateRecordCount: groups.reduce((sum, group) => sum + group.count, 0),
  });
});

function mergeDuplicateLeads(req: Request, keepId: string, removeIds: string[]): { merged: number; keepId: string } {
  const keep = getLead(keepId);
  if (!keep || keep.deleted_at) throw new Error("keeper lead not found");
  const owner = ownerScope(req);
  if (owner && keep.owner_user_id !== owner) throw new Error("keeper lead is assigned to another user");
  const removes = removeIds.map((id) => getLead(id)).filter(Boolean) as Lead[];
  if (!removes.length) throw new Error("choose at least one duplicate to merge");
  for (const lead of removes) {
    if (lead.id === keepId) throw new Error("keeper cannot also be removed");
    if (owner && lead.owner_user_id !== owner) throw new Error("one duplicate is assigned to another user");
  }

  const now = Date.now();
  const moveActivities = db.prepare(`UPDATE activities SET lead_id = ? WHERE lead_id = ?`);
  const moveNotes = db.prepare(`UPDATE notes SET lead_id = ? WHERE lead_id = ?`);
  const moveDocs = db.prepare(`UPDATE lead_documents SET lead_id = ? WHERE lead_id = ?`);
  const moveJobs = db.prepare(`UPDATE automation_jobs SET lead_id = ? WHERE lead_id = ?`);
  const moveSensitive = db.prepare(`UPDATE lead_sensitive_data SET lead_id = ? WHERE lead_id = ?`);
  const softDelete = db.prepare(`UPDATE leads SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`);
  const sensitiveExists = db.prepare(`SELECT 1 FROM lead_sensitive_data WHERE lead_id = ? LIMIT 1`);

  const tx = db.transaction(() => {
    const tags = new Set(keep.tags || []);
    const custom: Record<string, unknown> = { ...(keep.custom || {}) };
    let first = keep.first_name;
    let last = keep.last_name;
    let email = keep.email;
    let phone = keep.phone;
    let ownerUserId = keep.owner_user_id;
    let lastActivity = keep.last_activity_at || 0;
    for (const lead of removes) {
      (lead.tags || []).forEach((tag) => tag && tags.add(tag));
      for (const [key, value] of Object.entries(lead.custom || {})) {
        if (custom[key] === undefined || custom[key] === null || String(custom[key]).trim() === "") custom[key] = value;
      }
      first = first || lead.first_name;
      last = last || lead.last_name;
      email = email || lead.email;
      phone = phone || lead.phone;
      ownerUserId = ownerUserId || lead.owner_user_id;
      lastActivity = Math.max(lastActivity, lead.last_activity_at || lead.updated_at || lead.created_at || 0);
      moveActivities.run(keepId, lead.id);
      moveNotes.run(keepId, lead.id);
      moveDocs.run(keepId, lead.id);
      moveJobs.run(keepId, lead.id);
      if (!sensitiveExists.get(keepId) && sensitiveExists.get(lead.id)) moveSensitive.run(keepId, lead.id);
      softDelete.run(now, now, lead.id);
    }
    updateLead(keepId, { first_name: first || undefined, last_name: last || undefined, email: email || undefined, phone: phone || undefined, owner_user_id: ownerUserId || undefined, tags: [...tags], custom });
    db.prepare(`UPDATE leads SET last_activity_at = COALESCE(NULLIF(?, 0), last_activity_at), updated_at = ? WHERE id = ?`).run(lastActivity, now, keepId);
  });
  tx();
  logActivity(keepId, {
    type: "duplicate_merge",
    direction: "system",
    channel: "system",
    subject: "Duplicate leads merged",
    body: `Merged ${removes.length} duplicate record${removes.length === 1 ? "" : "s"} into this lead.`,
    status: "merged",
    meta: { mergedIds: removes.map((lead) => lead.id), author: leadActionAuthor(req) },
  });
  recordAudit({ req, action: "duplicate_merge", detail: `Merged ${removes.length} leads into ${keepId}`, meta: { keepId, removeIds } });
  return { merged: removes.length, keepId };
}

crmRouter.post("/api/duplicates/merge", requirePass, (req, res) => {
  try {
    const keepId = String(req.body?.keepId || "");
    const removeIds = Array.isArray(req.body?.removeIds) ? req.body.removeIds.map(String).filter(Boolean) : [];
    res.json({ ok: true, ...mergeDuplicateLeads(req, keepId, removeIds) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

crmRouter.post("/api/duplicates/delete", requirePass, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : [];
  if (!ids.length) {
    res.status(400).json({ error: "pass ids: string[]" });
    return;
  }
  const owner = ownerScope(req);
  let deleted = 0;
  for (const id of ids) {
    const lead = getLead(id);
    if (!lead || (owner && lead.owner_user_id !== owner)) continue;
    if (deleteLead(id)) deleted++;
  }
  recordAudit({ req, action: "duplicate_delete", detail: `Deleted ${deleted} duplicate leads`, meta: { ids } });
  res.json({ ok: true, deleted });
});

function reportOptions(req: Request): { from?: number; to?: number; type?: string } {
  const from = typeof req.query.from === "string" ? Date.parse(req.query.from) : Number(req.body?.fromDate || req.body?.from || 0);
  const to = typeof req.query.to === "string" ? Date.parse(req.query.to) : Number(req.body?.toDate || 0);
  const type = (typeof req.query.type === "string" ? req.query.type : req.body?.type) || "all";
  return {
    from: Number.isFinite(from) && from > 0 ? from : undefined,
    to: Number.isFinite(to) && to > 0 ? to : undefined,
    type: String(type),
  };
}

crmRouter.get("/api/reports/summary", requirePass, (req, res) => {
  const report = buildCrmReport(reportOptions(req));
  recordAudit({ req, action: "report_preview", detail: report.title });
  res.json({ ok: true, report });
});

crmRouter.get("/api/reports/summary.pdf", requirePass, (req, res) => {
  const report = buildCrmReport(reportOptions(req));
  const pdf = reportPdfBuffer(report);
  recordAudit({ req, action: "report_pdf_download", detail: report.title });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="loangenius-report-${new Date(report.created_at).toISOString().slice(0, 10)}.pdf"`);
  res.send(pdf);
});

crmRouter.post("/api/reports/email", requirePass, async (req, res) => {
  const to = parseEmailList(req.body?.to);
  if (!to.length) {
    res.status(400).json({ error: "enter at least one recipient email" });
    return;
  }
  const report = buildCrmReport(reportOptions(req));
  const pdf = reportPdfBuffer(report);
  const subject = String(req.body?.subject || report.title);
  const body = String(req.body?.body || `Attached is the ${report.title}.`);
  const results = [];
  for (const recipient of to) {
    const result = await sendEmail({
      to: recipient,
      subject,
      text: body,
      attachments: [{ filename: `loangenius-report-${new Date(report.created_at).toISOString().slice(0, 10)}.pdf`, content: pdf.toString("base64") }],
    });
    results.push({ to: recipient, ...result });
  }
  recordAudit({ req, action: "report_email", detail: `Report emailed to ${to.join(", ")}`, meta: { count: to.length } });
  res.json({ ok: results.every((r) => r.ok), results });
});

crmRouter.get("/api/audit-events", requireAdmin, (req, res) => {
  const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 250;
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const since = typeof req.query.since === "string" ? Date.parse(req.query.since) : 0;
  res.json({ ok: true, events: listAuditEvents({ limit, q, since: Number.isFinite(since) && since > 0 ? since : undefined }) });
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

crmRouter.post("/api/admin/repair-lead-pool", requireAdmin, (_req, res) => {
  res.json({ ok: true, ...repairLeadPoolVisibility() });
});

crmRouter.post("/api/sync/legacy-crm", (req, res) => {
  const expected = config.crm.legacySyncSecret;
  if (!expected) {
    res.status(503).json({ error: "legacy CRM sync is not configured" });
    return;
  }
  const provided =
    req.get("x-crm-sync-secret") ||
    req.get("x-legacy-sync-secret") ||
    (typeof req.query.key === "string" ? req.query.key : undefined) ||
    (req.body && typeof req.body.secret === "string" ? req.body.secret : undefined);
  if (provided !== expected) {
    res.status(401).json({ error: "bad sync secret" });
    return;
  }
  try {
    const result = applyLegacyCrmSync(req.body);
    log.info("legacy CRM sync applied", result);
    res.json({ ok: true, ...result });
  } catch (err) {
    log.error("legacy CRM sync failed", { err: String(err) });
    res.status(400).json({ error: String(err) });
  }
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

function csvHeaderKey(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function csvHeaderCompact(value: string): string {
  return csvHeaderKey(value).replace(/_/g, "");
}

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
  const headers = rows[0].map((h) => {
    const raw = h.replace(/^\uFEFF/, "").trim().toLowerCase();
    return {
      raw,
      key: csvHeaderKey(raw),
      compact: csvHeaderCompact(raw),
    };
  });
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    headers.forEach((h, idx) => {
      const value = (r[idx] ?? "").trim();
      if (h.raw) o[h.raw] = value;
      if (h.key && o[h.key] === undefined) o[h.key] = value;
      if (h.compact && o[h.compact] === undefined) o[h.compact] = value;
    });
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

const LEAD_IMPORT_SAMPLE_CSV = [
  "First Name,Last Name,Phone Number,Email,Status,Source,Property Address,City,State,Zip,DOB,Credit Score,Home Value,Mortgage Balance,Loan Purpose,Tags,Notes,SMS Consent",
  "Wesley,Smith,+14694417338,wesley@example.com,new,website,4915 Sandy Ct,Manassas,VA,20110,1984-05-15,680,525000,315000,HELOC,\"hot;heloc\",\"Asked for updated equity options\",yes",
  "Nikolao,Kollas,+17203000000,nikolao@example.com,nurturing,import,88 Market St,San Diego,CA,92101,1979-09-10,720,650000,402000,Cash-out refi,\"nurture;refi\",\"Follow up next week\",no",
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
    const candidates = Array.from(new Set([key, csvHeaderKey(key), csvHeaderCompact(key), key.replace(/\s+/g, "_")].filter(Boolean)));
    for (const candidate of candidates) {
      const value = row[candidate];
      if (value) return value;
    }
  }
  return "";
}

function splitImportName(value: string): { first: string; last: string } {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return { first: parts.shift() || "", last: parts.join(" ") };
}

function normalizeSsnLast4(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : value.trim();
}

function truthyCell(value: string | undefined): boolean {
  return /^(1|true|yes|y)$/i.test((value || "").trim());
}

function isLeadPoolLead(lead: Lead): boolean {
  const marker = lead.custom?.lead_pool;
  return marker === true || marker === "true";
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
  dob: "dob", date_of_birth: "dob", dateofbirth: "dob", birth_date: "dob", birthdate: "dob",
  ssn: "ssn_last4", ssn_last4: "ssn_last4", last4ssn: "ssn_last4", ssnlast4: "ssn_last4",
  employer: "employer", employer_name: "employer", employername: "employer",
  employment: "employment", employment_status: "employment", employmentstatus: "employment",
  income: "income", monthly_income: "income", monthlyincome: "income", annual_income: "income", annualincome: "income",
  creditscore: "credit", credit_score: "credit", credit: "credit", creditband: "credit", credit_band: "credit",
  homevalue: "home_value", home_value: "home_value", estimated_home_value: "home_value", estimatedhomevalue: "home_value",
  mortgagebalance: "mortgage_balance", mortgage_balance: "mortgage_balance", loan_balance_remaining: "mortgage_balance",
  loanamount: "loan_amount", loan_amount: "loan_amount", requested_amount: "loan_amount", requestedamount: "loan_amount",
  loanpurpose: "loan_goal", loan_purpose: "loan_goal", loan_goal: "loan_goal", goal: "loan_goal", purpose: "loan_goal",
  propertyaddress: "address", property_address: "address", address: "address", address1: "address", street: "address", street_address: "address", mortgage_address: "address",
  city: "city", property_city: "city", state: "state", property_state: "state", mortgage_state: "state",
  zip: "zip", zipcode: "zip", postal_code: "zip", postalcode: "zip", property_zip: "zip", mortgage_zipcode: "zip",
  loantype: "loan_type", loan_type: "loan_type", mortgage_type: "loan_type",
  loan_start_date: "funded_date", funded_date: "funded_date", funding_date: "funded_date",
  lead_type: "lead_type", leadtype: "lead_type", contact_type: "lead_type",
};

/** Lead statuses accepted on import (CSV `status` column). Anything else falls back to default. */
const IMPORT_STATUSES = new Set(["new", "contacted", "qualified", "nurturing", "won", "lost"]);

function importChoiceKey(value: string | undefined): string {
  return (value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function importLeadStatus(value: string | undefined, fallback?: LeadStatus): LeadStatus | undefined {
  const raw = (value || "").trim().toLowerCase();
  if (IMPORT_STATUSES.has(raw)) return raw as LeadStatus;
  const aliases: Record<string, LeadStatus> = {
    leadin: "new",
    replied: "contacted",
    contacted: "contacted",
    notreplying: "nurturing",
    noresponse: "nurturing",
    quotesent: "qualified",
    appcompleted: "qualified",
    applicationcompleted: "qualified",
    processing: "qualified",
    underwriting: "qualified",
    funded: "won",
    closed: "won",
    won: "won",
    lost: "lost",
    dead: "lost",
  };
  return aliases[importChoiceKey(value)] || fallback;
}

function importPipelineStage(value: string | undefined): string | undefined {
  const key = importChoiceKey(value);
  if (!key) return undefined;
  const match = PIPELINE_STAGES.find((s) => importChoiceKey(s.name) === key);
  if (match) return match.name;
  const aliases: Record<string, string> = {
    lead: "Lead-In",
    leadin: "Lead-In",
    new: "Lead-In",
    replied: "Replied",
    contacted: "Replied",
    notreplying: "Not Replying",
    noresponse: "Not Replying",
    nurture: "Not Replying",
    nurturing: "Not Replying",
    quotesent: "Quote Sent",
    qualified: "Quote Sent",
    appcompleted: "App Completed",
    applicationcompleted: "App Completed",
    suspended: "Suspended",
    paused: "Suspended",
    processing: "Processing",
    underwriting: "Processing",
    funded: "Funded",
    closed: "Funded",
    won: "Funded",
    lost: "Lost",
    dead: "Lost",
  };
  return aliases[key];
}

crmRouter.get("/api/leads/sample.csv", requirePass, (_req, res) => {
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", 'attachment; filename="active-leads-sample.csv"');
  res.send(LEAD_IMPORT_SAMPLE_CSV);
});

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
    defaultStage?: string;
  };
  const csv = typeof body.csv === "string" ? body.csv : "";
  if (!csv.trim()) {
    res.status(400).json({ error: "no CSV provided" });
    return;
  }
  const toPastClients = body.destination === "past_clients" || Boolean(body.markPastClients);
  const defaultStatusRaw = (body.defaultStatus || "").trim().toLowerCase();
  const defaultStatus = IMPORT_STATUSES.has(defaultStatusRaw) ? (defaultStatusRaw as LeadStatus) : undefined;
  const defaultStage = importPipelineStage(body.defaultStage);
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
    const fullName = rowValue(r, ["full_name", "full name", "name", "contact_name", "contact name", "borrower", "borrower_name"]);
    const split = splitImportName(fullName);
    const first = rowValue(r, ["first_name", "first name", "first", "firstname", "given_name"]) || split.first;
    const last = rowValue(r, ["last_name", "last name", "last", "lastname", "surname", "family_name"]) || split.last;
    // Accept singular OR plural column names (Shape/Jungo/etc. export `emails`/`phones`).
    const email = firstOf(rowValue(r, ["email", "emails", "email_address", "email address", "primary_email"]));
    const phone = firstOf(rowValue(r, ["phone", "phones", "phone_number", "phone number", "mobile", "cell", "primary_phone"]));
    if (!first && !last && !email && !phone) {
      skipped++;
      continue;
    }
    // Map only a curated set of useful columns into the lead's custom (canonical keys that
    // the Quote/loan-details + DOB fields display) — so a 120-column export doesn't bloat it.
    const custom: Record<string, unknown> = {};
    for (const k of Object.keys(r)) {
      const canon = IMPORT_CUSTOM_ALIASES[k] || IMPORT_CUSTOM_ALIASES[csvHeaderKey(k)] || IMPORT_CUSTOM_ALIASES[csvHeaderCompact(k)];
      if (canon && r[k]) custom[canon] = canon === "dob" ? normalizeDob(r[k]) : canon === "ssn_last4" ? normalizeSsnLast4(r[k]) : r[k];
    }
    const tags = splitImportTags(rowValue(r, ["tags", "tag", "labels"]));
    // A row's own `status` column wins; otherwise fall back to the import's defaultStatus
    // (e.g. "nurturing" for a nurture/contacts upload). Only known statuses are honored.
    const pipelineStage = importPipelineStage(rowValue(r, ["pipeline_stage", "pipeline status", "pipeline", "stage", "status", "lead status"])) || defaultStage;
    const rowStatus = rowValue(r, ["status", "lead_status", "lead status"]);
    const status = importLeadStatus(rowStatus || pipelineStage, defaultStatus);
    const rowPast = toPastClients || truthyCell(rowValue(r, ["past_client", "past client", "closed_client", "funded"]));
    const existing = findLead({ phone: phone || undefined, email: email || undefined });
    let leadId: string;
    if (existing) {
      const patch: Record<string, unknown> = {};
      if (first) patch.first_name = first;
      if (last) patch.last_name = last;
      if (email) patch.email = email;
      if (phone) patch.phone = phone;
      if (status) patch.status = status;
      if (pipelineStage) patch.pipeline_stage = pipelineStage;
      if (tags) patch.tags = Array.from(new Set([...existing.tags, ...tags]));
      if (Object.keys(custom).length) patch.custom = { ...existing.custom, ...custom };
      if (req.authUser && !existing.owner_user_id) patch.owner_user_id = req.authUser.id;
      if (Object.keys(patch).length) updateLead(existing.id, patch);
      leadId = existing.id;
      updated++;
    } else {
      const lead = createLead({ first_name: first, last_name: last, name: fullName, email, phone, source: rowValue(r, ["source", "lead_source", "lead source"]) || "import", status, pipeline_stage: pipelineStage || DEFAULT_STAGE, tags, custom });
      leadId = lead.id;
      if (req.authUser) updateLead(lead.id, { owner_user_id: req.authUser.id });
      // A `notes` column becomes a real timeline note (visible) — e.g. funded date / loan summary.
      const notes = rowValue(r, ["notes", "note", "last_note", "description"]);
      if (notes) addNote(leadId, notes, "import");
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
  repairLeadPoolVisibility();
  const allPool = listLeadPoolLeads({ limit: 20000, ownerUserId }).filter(isLeadPoolLead);
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

function voicemailConfigMissing(audioUrl?: string): string[] {
  const settings = publicVoicemailAudioSettings();
  const missing: string[] = [];
  if (!audioUrl && !settings.url) missing.push("default voicemail audio or ElevenLabs-generated audio");
  if (!settings.telnyxVoiceAppSet) missing.push("TELNYX_VOICE_APP_ID/TELNYX_CONNECTION_ID");
  if (!settings.telnyxApiKeySet) missing.push("TELNYX_API_KEY");
  if (!settings.telnyxFromNumberSet) missing.push("TELNYX_FROM_NUMBER/TELNYX_NUMBERS");
  return missing;
}

function voicemailConfigError(audioUrl?: string): string {
  const missing = voicemailConfigMissing(audioUrl);
  return missing.length ? `voicemail not configured: missing ${missing.join(", ")}` : VOICEMAIL_CONFIG_ERROR;
}

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
  if (!voicemailConfigured(audioUrl)) return { skipped: true, reason: voicemailConfigError(audioUrl) };
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
  const missing = voicemailConfigMissing();
  res.status(400).json({ error: voicemailConfigError(), missing });
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
  try {
    return (await generateVoicemailAudio(script, { baseUrl })).url;
  } catch (err) {
    const fallbackAudioUrl = getDefaultVoicemailAudioUrl();
    if (fallbackAudioUrl) {
      log.warn("voicemail audio generation failed; using default audio", { leadId: lead.id, err: String(err) });
      return fallbackAudioUrl;
    }
    throw err;
  }
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
      note(`audio generation failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 220));
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
        else { textFailed++; note(`text failed: ${text.error}`.slice(0, 220)); }
      }
    } else if ("skipped" in voicemail) {
      skipped++;
      note(voicemail.reason);
      if (sendText) textSkipped++;
    } else {
      failed++;
      note(`provider error: ${voicemail.error}`.slice(0, 220));
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
  const body = (req.body ?? {}) as {
    text?: string;
    title?: string;
    due_date?: string | number | null;
    cc_email?: string | null;
    duration_minutes?: string | number | null;
    location?: string | null;
    description?: string | null;
  };
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
    duration_minutes: Number.isFinite(Number(body.duration_minutes)) ? Number(body.duration_minutes) : null,
    location: typeof body.location === "string" && body.location.trim() ? body.location.trim() : null,
    description: typeof body.description === "string" && body.description.trim() ? body.description.trim() : null,
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
crmRouter.post("/api/leads/:id/calendar-invite", requirePass, async (req, res) => {
  const lead = accessibleLead(req, res);
  if (!lead) return;
  const body = (req.body ?? {}) as {
    todoId?: string;
    title?: string;
    start?: string | number;
    durationMinutes?: string | number;
    location?: string;
    description?: string;
    cc_email?: string;
    via?: string;
  };
  const todo = body.todoId ? lead.todos.find((t) => t.id === body.todoId && !t.deleted_at) : undefined;
  const start = Number(body.start || todo?.due_date || 0);
  if (!Number.isFinite(start) || start <= 0) {
    res.status(400).json({ error: "calendar invite needs a start date/time" });
    return;
  }
  const duration = Number(body.durationMinutes || todo?.duration_minutes || 30);
  const event = {
    title: cleanText(body.title || todo?.text, "Appointment"),
    start,
    end: start + Math.max(5, Math.min(480, Number.isFinite(duration) ? duration : 30)) * 60_000,
    location: cleanText(body.location || todo?.location),
    description: cleanText(body.description || todo?.description || `Appointment with ${leadDisplayName(lead)}`),
  };
  const links = calendarEventLinks(req, event);
  const inviteBody = appointmentInviteBody(lead, event, links);
  const via = cleanText(body.via, "email").toLowerCase();
  const cc = parseCc(body.cc_email || todo?.cc_email || "");
  const result = { email: "skipped", text: "skipped" };
  const author = leadActionAuthor(req);

  if (via === "email" || via === "both") {
    if (!lead.email) result.email = "skipped:no email";
    else if (isEmailUnsubscribed(lead)) result.email = "skipped:unsubscribed";
    else if (!emailConfigured()) result.email = "skipped:email not configured";
    else {
      const { html, text } = buildBrandedEmail(inviteBody, unsubscribeUrl(lead.id));
      const sent = await sendEmail({ to: lead.email, subject: `Appointment: ${event.title}`, html, text, cc });
      result.email = sent.ok ? "sent" : `failed:${sent.detail || "send failed"}`;
      logActivity(lead.id, {
        type: "email",
        direction: "outbound",
        channel: "email",
        subject: `Appointment: ${event.title}`,
        body: inviteBody,
        status: sent.ok ? "calendar-invite-sent" : result.email,
        meta: { id: sent.id, detail: sent.detail, author, calendarInvite: true, links, cc: cc.length ? cc : undefined },
      });
    }
  }

  if (via === "text" || via === "both") {
    if (!lead.phone) result.text = "skipped:no phone";
    else if (await isOnDnc(lead.phone)) result.text = "skipped:dnc";
    else {
      const sent = await sendOutbound({ phone: lead.phone, message: inviteBody });
      const channel = sent.path.startsWith("imessage") ? "imessage" : "sms";
      result.text = sent.ok ? `sent:${sent.path}` : `failed:${sent.detail || sent.path}`;
      logActivity(lead.id, {
        type: channel,
        direction: "outbound",
        channel,
        body: inviteBody,
        status: sent.ok ? "calendar-invite-sent" : result.text,
        meta: { detail: sent.detail, author, calendarInvite: true, links },
      });
    }
  }

  logActivity(lead.id, {
    type: "calendar",
    direction: "system",
    channel: "system",
    body: `Calendar invite prepared: ${event.title}`,
    status: "prepared",
    meta: { author, event, links, result, cc: cc.length ? cc : undefined },
  });
  res.json({ ok: true, event, links, result });
});

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
function parseEmailList(raw: unknown): string[] {
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

function parseCc(raw: unknown): string[] {
  return parseEmailList(raw);
}

const MANUAL_INITIATED_EMAIL_CC = "mykoal@adaxahome.com";

function withManualInitiatedCc(raw: unknown): string[] {
  const out = parseEmailList(raw);
  const key = MANUAL_INITIATED_EMAIL_CC.toLowerCase();
  if (!out.some((email) => email.toLowerCase() === key)) out.push(MANUAL_INITIATED_EMAIL_CC);
  return out;
}

function emailFromChoices(): string[] {
  const raw = [config.email.fromEmail, config.email.fromAliases, ...brand.sendingEmails].filter(Boolean).join(",");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,\n;]+/)) {
    const value = part.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(value);
    }
  }
  return out;
}

function selectedEmailFrom(raw: unknown): string | undefined {
  const requested = String(raw || "").trim();
  if (!requested) return undefined;
  const allowed = emailFromChoices();
  return allowed.some((item) => item.toLowerCase() === requested.toLowerCase()) ? requested : undefined;
}

function emailDomainsFromText(raw: unknown): string[] {
  const matches = String(raw || "").match(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi) || [];
  return matches
    .map((email) => email.split("@").pop()?.toLowerCase().replace(/[>\])}.,;:]+$/g, "") || "")
    .filter(Boolean);
}

function configuredEmailDomains(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const source of [config.email.fromEmail, config.email.fromAliases, config.email.replyTo, ...brand.sendingEmails]) {
    for (const domain of emailDomainsFromText(source)) {
      if (!seen.has(domain)) {
        seen.add(domain);
        out.push(domain);
      }
    }
  }
  return out;
}

async function emailMxDiagnostics(domains: string[]): Promise<Array<{
  domain: string;
  records: Array<{ exchange: string; priority: number }>;
  resendInbound: boolean;
  error?: string;
}>> {
  return Promise.all(
    domains.map(async (domain) => {
      try {
        const records = (await resolveMx(domain))
          .map((row) => ({ exchange: row.exchange.toLowerCase(), priority: row.priority }))
          .sort((a, b) => a.priority - b.priority || a.exchange.localeCompare(b.exchange));
        return {
          domain,
          records,
          resendInbound: records.some((row) => row.exchange === "inbound-smtp.us-east-1.amazonaws.com"),
        };
      } catch (err) {
        return { domain, records: [], resendInbound: false, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
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

function parseResendTags(raw: unknown): Array<{ name: string; value: string }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((tag) => tag && typeof tag === "object" ? tag as Record<string, unknown> : null)
    .filter((tag): tag is Record<string, unknown> => Boolean(tag))
    .map((tag) => ({ name: String(tag.name || "").trim(), value: String(tag.value || "").trim() }))
    .filter((tag) => tag.name && tag.value);
}

function parseResendTemplate(raw: unknown): { id: string; variables?: Record<string, string | number> } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Record<string, unknown>;
  const id = String(row.id || "").trim();
  if (!id) return undefined;
  const variables: Record<string, string | number> = {};
  if (row.variables && typeof row.variables === "object") {
    for (const [key, value] of Object.entries(row.variables as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9_]{1,50}$/.test(key)) continue;
      if (typeof value === "number" && Number.isFinite(value)) variables[key] = value;
      else if (typeof value === "string" && value.length <= 2000) variables[key] = value;
    }
  }
  return { id, ...(Object.keys(variables).length ? { variables } : {}) };
}

function resendSendOptions(req: Request): {
  scheduledAt?: string;
  topicId?: string;
  tags?: Array<{ name: string; value: string }>;
  idempotencyKey?: string;
  replyTo?: string[];
} {
  const scheduledAt = cleanText(req.body?.scheduled_at || req.body?.scheduledAt);
  const topicId = cleanText(req.body?.topic_id || req.body?.topicId);
  const idempotencyKey = cleanText(req.body?.idempotency_key || req.body?.idempotencyKey || req.get("Idempotency-Key"));
  const replyTo = parseEmailList(req.body?.reply_to || req.body?.replyTo);
  const tags = parseResendTags(req.body?.tags);
  return {
    ...(scheduledAt ? { scheduledAt } : {}),
    ...(topicId ? { topicId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(replyTo.length ? { replyTo } : {}),
    ...(tags.length ? { tags } : {}),
  };
}

function scheduledAtFromBody(body: unknown): string {
  const raw = body && typeof body === "object"
    ? cleanText((body as Record<string, unknown>).scheduled_at || (body as Record<string, unknown>).scheduledAt)
    : "";
  if (!raw) return "";
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : raw;
}

function resendListQuery(req: Request): { limit: number; after?: string; before?: string } {
  const parsedLimit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 20;
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 100)) : 20;
  const after = cleanText(req.query.after);
  const before = cleanText(req.query.before);
  return {
    limit,
    ...(after ? { after } : {}),
    ...(before ? { before } : {}),
  };
}

function resendReceivedHtmlFormat(req: Request): "data_uri" | "cid" {
  return cleanText(req.query.html_format || req.query.htmlFormat) === "cid" ? "cid" : "data_uri";
}

function textFromHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
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
  const cc = withManualInitiatedCc(req.body?.cc);
  const bcc = parseEmailList(req.body?.bcc);
  const from = selectedEmailFrom(req.body?.from);
  const scheduledAt = scheduledAtFromBody(req.body);
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
  const r = await sendEmail({
    to: lead.email,
    subject,
    from,
    html,
    text,
    cc,
    bcc,
    attachments: parseAttachments(req.body?.attachments),
    ...resendSendOptions(req),
    ...(scheduledAt ? { scheduledAt } : {}),
  });
  logActivity(lead.id, {
    type: "email",
    direction: "outbound",
    channel: "email",
    subject,
    body: bodyText,
    status: r.ok ? (scheduledAt ? "scheduled" : "sent") : `failed:${r.detail ?? "send failed"}`,
    meta: { id: r.id, detail: r.detail, from: from || config.email.fromEmail, scheduled_at: scheduledAt || undefined, cc: cc.length ? cc : undefined, bcc: bcc.length ? bcc : undefined, author: req.body?.author },
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
  const to = parseEmailList(req.body?.to);
  const subject = (req.body?.subject ?? "").toString().trim();
  const bodyText = (req.body?.body ?? "").toString().trim();
  const cc = withManualInitiatedCc(req.body?.cc);
  const bcc = parseEmailList(req.body?.bcc);
  const from = selectedEmailFrom(req.body?.from);
  const scheduledAt = scheduledAtFromBody(req.body);
  const template = parseResendTemplate(
    req.body?.template ||
      (req.body?.template_id || req.body?.templateId
        ? { id: req.body.template_id || req.body.templateId, variables: req.body?.variables || req.body?.templateVariables }
        : undefined),
  );
  if (!to.length) {
    res.status(400).json({ error: "pass a recipient (to)" });
    return;
  }
  if (!subject) {
    res.status(400).json({ error: "pass a subject" });
    return;
  }
  if (!bodyText && !template) {
    res.status(400).json({ error: "pass a body" });
    return;
  }
  const lead = to.length === 1 ? findLead({ email: to[0] }) : null;
  if (lead && isEmailUnsubscribed(lead)) {
    res.status(400).json({ error: "this address unsubscribed from email" });
    return;
  }
  const unsubUrl = lead
    ? unsubscribeUrl(lead.id)
    : `mailto:${config.email.fromEmail || "unsubscribe"}?subject=${encodeURIComponent("Unsubscribe")}`;
  const renderedSubject = lead ? renderLeadMergeTemplate(subject, lead) : subject;
  const renderedBody = lead ? renderLeadMergeTemplate(bodyText, lead) : bodyText;
  const { html, text } = buildBrandedEmail(renderedBody, unsubUrl);
  const r = await sendEmail({
    to,
    subject: renderedSubject,
    from,
    ...(template ? { template } : { html, text }),
    cc,
    bcc,
    attachments: parseAttachments(req.body?.attachments),
    ...resendSendOptions(req),
    ...(scheduledAt ? { scheduledAt } : {}),
  });
  if (lead) {
    logActivity(lead.id, {
      type: "email",
      direction: "outbound",
      channel: "email",
      subject: renderedSubject,
      body: renderedBody,
      status: r.ok ? (scheduledAt ? "scheduled" : "sent") : `failed:${r.detail ?? "send failed"}`,
      meta: { id: r.id, detail: r.detail, from: from || config.email.fromEmail, to, scheduled_at: scheduledAt || undefined, cc: cc.length ? cc : undefined, bcc: bcc.length ? bcc : undefined, author: req.body?.author },
    });
  }
  res.json({ ok: r.ok, id: r.id, detail: r.detail, leadId: lead?.id ?? null });
});

crmRouter.post("/api/email/batch-send", requirePass, async (req, res) => {
  if (!emailConfigured()) {
    res.status(400).json({ error: "email not configured (set RESEND_API_KEY + EMAIL_FROM)" });
    return;
  }
  const rows = Array.isArray(req.body?.emails) ? req.body.emails as Array<Record<string, unknown>> : [];
  if (!rows.length) {
    res.status(400).json({ error: "pass { emails: [...] }" });
    return;
  }
  const defaultFrom = selectedEmailFrom(req.body?.from);
  const emails = rows.slice(0, 100).map((row) => {
    const bodyText = cleanText(row.body || row.text);
    const template = parseResendTemplate(
      row.template ||
        (row.template_id || row.templateId
          ? { id: row.template_id || row.templateId, variables: row.variables || row.templateVariables }
          : undefined),
    );
    const unsubUrl = `mailto:${config.email.fromEmail || "unsubscribe"}?subject=${encodeURIComponent("Unsubscribe")}`;
    const branded = template ? null : buildBrandedEmail(bodyText || cleanText(row.subject, "Email"), unsubUrl);
    return {
      to: parseEmailList(row.to),
      subject: cleanText(row.subject, "Email"),
      from: selectedEmailFrom(row.from) || defaultFrom,
      ...(template ? { template } : { html: branded?.html, text: branded?.text }),
      cc: parseEmailList(row.cc),
      bcc: parseEmailList(row.bcc),
      replyTo: parseEmailList(row.reply_to || row.replyTo),
      topicId: cleanText(row.topic_id || row.topicId),
      tags: parseResendTags(row.tags),
      headers: row.headers && typeof row.headers === "object" ? row.headers as Record<string, string> : undefined,
    };
  });
  const result = await sendBatchEmails(emails, {
    idempotencyKey: cleanText(req.body?.idempotency_key || req.body?.idempotencyKey || req.get("Idempotency-Key")),
  });
  res.status(result.ok ? 200 : 400).json(result);
});

crmRouter.get("/api/email/sent", requirePass, async (req, res) => {
  const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 20;
  const after = cleanText(req.query.after);
  const before = cleanText(req.query.before);
  const result = await listSentEmails({
    limit,
    after: after || undefined,
    before: before || undefined,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.detail || "could not list sent email from Resend" });
    return;
  }
  res.json(result);
});

crmRouter.get("/api/email/received", requirePass, async (req, res) => {
  const result = await listReceivedEmails(resendListQuery(req));
  if (!result.ok) {
    res.status(400).json({ error: result.detail || "could not list received email from Resend" });
    return;
  }
  res.json(result);
});

crmRouter.post("/api/email/received/sync", requireAdmin, async (req, res) => {
  const bodyLimit = typeof req.body?.limit === "number" ? req.body.limit : Number(req.body?.limit || 50);
  const limit = Number.isFinite(bodyLimit) ? Math.max(1, Math.min(bodyLimit, 100)) : 50;
  const listed = await listReceivedEmails({ limit });
  if (!listed.ok) {
    res.status(400).json({ ok: false, error: listed.detail || "could not list received email from Resend" });
    return;
  }
  let stored = 0;
  let duplicates = 0;
  const failed: Array<{ emailId: string | null; error: string }> = [];
  for (const email of listed.emails) {
    const result = await storeReceivedEmail(email as Record<string, unknown>, { verified: false });
    if (result.stored) stored += 1;
    else if (result.duplicate) duplicates += 1;
    else if (!result.ok) failed.push({ emailId: result.emailId || email.id || email.email_id || null, error: result.error || "unknown error" });
  }
  res.json({
    ok: true,
    checked: listed.emails.length,
    stored,
    duplicates,
    failed,
    has_more: listed.has_more,
  });
});

crmRouter.get("/api/email/received/:emailId", requirePass, async (req, res) => {
  const email = await retrieveReceivedEmail(req.params.emailId, resendReceivedHtmlFormat(req));
  if (!email) {
    res.status(404).json({ error: "received email not found in Resend" });
    return;
  }
  res.json({ ok: true, email });
});

crmRouter.get("/api/email/sent/:emailId/attachments", requirePass, async (req, res) => {
  const result = await listSentEmailAttachments(req.params.emailId, resendListQuery(req));
  if (!result.ok) {
    res.status(400).json({ error: result.detail || "could not list sent email attachments from Resend" });
    return;
  }
  res.json(result);
});

crmRouter.get("/api/email/sent/:emailId/attachments/:attachmentId", requirePass, async (req, res) => {
  const attachment = await retrieveSentEmailAttachment(req.params.emailId, req.params.attachmentId);
  if (!attachment) {
    res.status(404).json({ error: "sent email attachment not found in Resend" });
    return;
  }
  res.json({ ok: true, attachment });
});

crmRouter.get("/api/email/sent/:emailId", requirePass, async (req, res) => {
  const email = await retrieveSentEmail(req.params.emailId);
  if (!email) {
    res.status(404).json({ error: "sent email not found in Resend" });
    return;
  }
  res.json({ ok: true, email });
});

crmRouter.patch("/api/email/sent/:emailId", requirePass, async (req, res) => {
  const scheduledAt = scheduledAtFromBody(req.body);
  if (!scheduledAt) {
    res.status(400).json({ error: "scheduled_at must be a valid ISO 8601 date" });
    return;
  }
  const result = await updateScheduledEmail(req.params.emailId, scheduledAt);
  if (!result.ok) {
    res.status(400).json({ ok: false, error: result.detail || "could not update scheduled email" });
    return;
  }
  res.json({ ok: true, id: result.id, scheduled_at: scheduledAt });
});

crmRouter.post("/api/email/sent/:emailId/cancel", requirePass, async (req, res) => {
  const result = await cancelScheduledEmail(req.params.emailId);
  if (!result.ok) {
    res.status(400).json({ ok: false, error: result.detail || "could not cancel scheduled email" });
    return;
  }
  res.json({ ok: true, id: result.id, status: "canceled" });
});

crmRouter.get("/api/email/settings", requirePass, (_req, res) => {
  res.json({
    ok: true,
    from: emailFromChoices(),
    defaultFrom: config.email.fromEmail || "",
    defaultReplyTo: config.email.replyTo || "",
    folders: [
      "General",
      "Borrower discussion",
      "Loan application",
      "Credit",
      "Title",
      "Flood",
      "Conditions",
      "Closing",
    ],
  });
});

crmRouter.get("/api/email/resend-diagnostics", requireAdmin, async (req, res) => {
  const mountedBase = requestMountedBase(req);
  const expectedWebhook = "https://loangenius-v2.onrender.com/api/webhooks/resend";
  const mountedWebhook = `${mountedBase}/api/webhooks/resend`;
  const rootWebhook = `${req.protocol}://${req.get("host")}/api/webhooks/resend`;
  const domains = configuredEmailDomains();
  const list = await listResendWebhooks();
  const enriched = await Promise.all(
    list.webhooks.slice(0, 25).map(async (hook) => {
      const detail = await retrieveResendWebhook(hook.id);
      const row = detail || hook;
      const signingSecret = typeof row.signing_secret === "string" ? row.signing_secret : "";
      const endpoint = typeof row.endpoint === "string" ? row.endpoint : "";
      const events = Array.isArray(row.events) ? row.events : [];
      return {
        id: row.id,
        status: row.status || "",
        endpoint,
        events,
        has_email_received: events.includes("email.received"),
        endpoint_matches_this_app: endpoint === expectedWebhook || endpoint === mountedWebhook || endpoint === rootWebhook,
        signing_secret_present: Boolean(signingSecret),
        signing_secret_matches_env: Boolean(config.email.resendWebhookSecret && signingSecret && signingSecret === config.email.resendWebhookSecret),
      };
    }),
  );
  const received = await listReceivedEmails(10);
  const sent = await listSentEmails({ limit: 10 });
  const mx = await emailMxDiagnostics(domains);
  res.json({
    ok: true,
    resend_api_key_set: Boolean(config.email.resendApiKey),
    resend_webhook_secret_set: Boolean(config.email.resendWebhookSecret),
    resend_webhook_secret_self_test: selfTestResendWebhookSignature(),
    email_from: config.email.fromEmail || "",
    email_reply_to: config.email.replyTo || "",
    configured_email_domains: domains,
    inbound_mx: mx,
    expected_webhook_url: expectedWebhook,
    alternate_webhook_urls: [mountedWebhook, rootWebhook].filter((url, index, list) => url && list.indexOf(url) === index && url !== expectedWebhook),
    root_webhook_url: rootWebhook,
    webhooks_ok: list.ok,
    webhooks_error: list.detail || null,
    webhooks: enriched,
    received_ok: received.ok,
    received_error: received.detail || null,
    recent_received_count: received.emails.length,
    recent_received: received.emails.map((email) => ({
      id: email.id || email.email_id || "",
      from: email.from || "",
      to: email.to || [],
      subject: email.subject || "",
      created_at: email.created_at || "",
    })),
    sent_ok: sent.ok,
    sent_error: sent.detail || null,
    recent_sent_count: sent.emails.length,
    recent_sent: sent.emails.map((email) => ({
      id: email.id || "",
      from: email.from || "",
      to: email.to || [],
      subject: email.subject || "",
      last_event: email.last_event || "",
      created_at: email.created_at || "",
    })),
    recent_webhook_hits: getRecentResendInboundWebhookHits(),
  });
});

const EMAIL_MESSAGE_STATE_META_KEY = "email_message_state_v1";
const EMAIL_BOXES = new Set(["inbox", "sent", "archived", "trash", "all"]);

type EmailMessageStateRecord = {
  archived_at?: string;
  deleted_at?: string;
  updated_at?: string;
  by?: string;
};

type EmailActivityRow = {
  id: string;
  lead_id: string;
  type: string;
  direction: string | null;
  subject: string | null;
  body: string | null;
  status: string | null;
  meta: string | null;
  deleted_at: number | null;
};

function emailMessageStateMap(): Record<string, EmailMessageStateRecord> {
  const raw = getMeta(EMAIL_MESSAGE_STATE_META_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, EmailMessageStateRecord>)
      : {};
  } catch {
    return {};
  }
}

function saveEmailMessageStateMap(map: Record<string, EmailMessageStateRecord>): void {
  setMeta(EMAIL_MESSAGE_STATE_META_KEY, JSON.stringify(map));
}

function resendMailboxStateId(value: unknown): string {
  return cleanText(value).slice(0, 220);
}

function isResendMailboxStateId(id: string): boolean {
  return id.startsWith("resend:") || id.startsWith("resend-received:");
}

function setResendMailboxState(req: Request, id: string, action: string): EmailMessageStateRecord {
  const map = emailMessageStateMap();
  const now = new Date().toISOString();
  const current: EmailMessageStateRecord = { ...(map[id] || {}) };
  if (action === "archive") {
    current.archived_at = current.archived_at || now;
    delete current.deleted_at;
  } else if (action === "unarchive") {
    delete current.archived_at;
  } else if (action === "delete") {
    current.deleted_at = current.deleted_at || now;
  } else if (action === "restore") {
    delete current.deleted_at;
  }
  current.updated_at = now;
  current.by = leadActionAuthor(req);
  if (!current.archived_at && !current.deleted_at) delete map[id];
  else map[id] = current;
  saveEmailMessageStateMap(map);
  return current;
}

function emailActivityForRequest(req: Request, res: Response, allowDeleted = false): { row: EmailActivityRow; meta: Record<string, unknown>; lead: Lead } | null {
  const row = db
    .prepare(`SELECT * FROM activities WHERE id = ? ${allowDeleted ? "" : "AND deleted_at IS NULL"}`)
    .get(req.params.activityId) as EmailActivityRow | undefined;
  if (!row || row.type !== "email") {
    res.status(404).json({ error: "email activity not found" });
    return null;
  }
  const lead = getLead(row.lead_id);
  if (!lead) {
    res.status(404).json({ error: "lead not found" });
    return null;
  }
  const owner = ownerScope(req);
  if (owner && lead.owner_user_id !== owner) {
    res.status(403).json({ error: "this lead is assigned to another user" });
    return null;
  }
  return { row, meta: safeMeta(row.meta) || {}, lead };
}

crmRouter.get("/api/email/message-state", requirePass, (_req, res) => {
  res.json({ ok: true, state: emailMessageStateMap() });
});

crmRouter.post("/api/email/message-state", requirePass, (req, res) => {
  const id = resendMailboxStateId(req.body?.id);
  const action = cleanText(req.body?.action).toLowerCase();
  if (!id || !isResendMailboxStateId(id)) {
    res.status(400).json({ error: "message id must be a Resend mailbox id" });
    return;
  }
  if (!["archive", "unarchive", "delete", "restore"].includes(action)) {
    res.status(400).json({ error: "action must be archive, unarchive, delete, or restore" });
    return;
  }
  const state = setResendMailboxState(req, id, action);
  res.json({ ok: true, id, action, state });
});

crmRouter.get("/api/email/activity", requirePass, (req, res) => {
  const parsedLimit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 100;
  const limit = Math.min(Math.max(parsedLimit || 100, 1), 500);
  const requestedBox = typeof req.query.box === "string" ? req.query.box : "all";
  const box = EMAIL_BOXES.has(requestedBox) ? requestedBox : "all";
  const directionWhere = box === "inbox" ? "AND a.direction = 'inbound'" : box === "sent" ? "AND a.direction = 'outbound'" : "";
  const scanLimit = Math.min(Math.max(limit * 8, 500), 2500);
  const owner = ownerScope(req);
  const rows = db
    .prepare(
      `SELECT a.id, a.created_at, a.subject, a.body, a.status, a.meta, a.direction, a.channel, a.deleted_at,
              l.id AS lead_id, l.first_name, l.last_name, l.email, l.phone
         FROM activities a LEFT JOIN leads l ON l.id = a.lead_id
        WHERE a.type = 'email'
          ${directionWhere}
          ${owner ? "AND l.owner_user_id = @owner" : ""}
        ORDER BY a.created_at DESC
        LIMIT @scanLimit`,
    )
    .all({ owner: owner || "", scanLimit }) as Array<{
    id: string;
    created_at: number;
    subject: string | null;
    body: string | null;
    status: string | null;
    meta: string | null;
    direction: string | null;
    channel: string | null;
    deleted_at: number | null;
    lead_id: string | null;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
  }>;
  const visibleRows = rows
    .filter((row) => {
      const meta = safeMeta(row.meta);
      const archived = typeof meta?.email_archived_at === "string" && Boolean(meta.email_archived_at);
      const deleted = row.deleted_at !== null && row.deleted_at !== undefined;
      if (box === "trash") return deleted;
      if (deleted) return false;
      if (box === "archived") return archived;
      if (box === "inbox") return row.direction === "inbound" && !archived;
      if (box === "sent") return row.direction === "outbound" && !archived;
      return true;
    })
    .slice(0, limit);
  res.json({
    ok: true,
    box,
    emails: visibleRows.map((row) => {
      const meta = safeMeta(row.meta);
      const inbound = row.direction === "inbound";
      const toList = Array.isArray(meta?.to) ? meta.to.map((v) => String(v)).filter(Boolean) : [];
      const ccList = Array.isArray(meta?.cc) ? meta.cc.map((v) => String(v)).filter(Boolean) : [];
      const bccList = Array.isArray(meta?.bcc) ? meta.bcc.map((v) => String(v)).filter(Boolean) : [];
      const from = inbound
        ? String(meta?.from || meta?.from_email || row.email || "")
        : String(meta?.from || config.email.fromEmail || "CRM");
      const to = inbound
        ? toList.join(", ") || config.email.fromEmail || ""
        : toList.join(", ") || row.email || "";
      const resendId = cleanText(meta?.resend_id || meta?.id || meta?.resend_email_id);
      return {
        id: row.id,
        created_at: row.created_at,
        subject: row.subject,
        body: row.body,
        status: row.status,
        direction: row.direction,
        channel: row.channel,
        lead_id: row.lead_id,
        lead_name: [row.first_name, row.last_name].filter(Boolean).join(" ") || row.email || row.phone || "Lead",
        email: row.email,
        from,
        to,
        cc: ccList,
        bcc: bccList,
        resend_id: resendId,
        message_id: typeof meta?.message_id === "string" ? meta.message_id : "",
        last_event: typeof meta?.last_event === "string" ? meta.last_event : "",
        resend_refreshed_at: typeof meta?.resend_refreshed_at === "string" ? meta.resend_refreshed_at : "",
        scheduled_at: typeof meta?.scheduled_at === "string" ? meta.scheduled_at : "",
        email_archived_at: typeof meta?.email_archived_at === "string" ? meta.email_archived_at : "",
        deleted_at: row.deleted_at,
        file_folder: typeof meta?.file_folder === "string" ? meta.file_folder : "",
        discussion_file: typeof meta?.discussion_file === "string" ? meta.discussion_file : "",
        attachments: Array.isArray(meta?.attachments) ? meta.attachments : [],
        html: typeof meta?.html === "string" ? meta.html : null,
        meta,
      };
    }),
  });
});

crmRouter.post("/api/email/activity/:activityId/archive", requirePass, (req, res) => {
  const found = emailActivityForRequest(req, res);
  if (!found) return;
  const meta = { ...found.meta };
  const now = new Date().toISOString();
  meta.email_archived_at = typeof meta.email_archived_at === "string" ? meta.email_archived_at : now;
  meta.email_archived_by = leadActionAuthor(req);
  delete meta.email_unarchived_at;
  db.prepare(`UPDATE activities SET meta = ? WHERE id = ?`).run(JSON.stringify(meta), found.row.id);
  logActivity(found.lead.id, {
    type: "email_archived",
    direction: "system",
    channel: "email",
    subject: "Email archived",
    body: found.row.subject ? `Archived email: ${found.row.subject}` : "Archived email.",
    status: "archived",
    meta: { sourceActivityId: found.row.id },
  });
  res.json({ ok: true, activityId: found.row.id, archived_at: meta.email_archived_at });
});

crmRouter.post("/api/email/activity/:activityId/unarchive", requirePass, (req, res) => {
  const found = emailActivityForRequest(req, res);
  if (!found) return;
  const meta = { ...found.meta };
  delete meta.email_archived_at;
  delete meta.email_archived_by;
  meta.email_unarchived_at = new Date().toISOString();
  meta.email_unarchived_by = leadActionAuthor(req);
  db.prepare(`UPDATE activities SET meta = ? WHERE id = ?`).run(JSON.stringify(meta), found.row.id);
  logActivity(found.lead.id, {
    type: "email_unarchived",
    direction: "system",
    channel: "email",
    subject: "Email unarchived",
    body: found.row.subject ? `Moved email back: ${found.row.subject}` : "Moved email back from archive.",
    status: "active",
    meta: { sourceActivityId: found.row.id },
  });
  res.json({ ok: true, activityId: found.row.id });
});

crmRouter.delete("/api/email/activity/:activityId", requirePass, (req, res) => {
  const found = emailActivityForRequest(req, res);
  if (!found) return;
  const deletedAt = Date.now();
  db.prepare(`UPDATE activities SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ?`).run(deletedAt, found.row.id);
  logActivity(found.lead.id, {
    type: "email_deleted",
    direction: "system",
    channel: "email",
    subject: "Email moved to Trash",
    body: found.row.subject ? `Moved email to Trash: ${found.row.subject}` : "Moved email to Trash.",
    status: "deleted",
    meta: { sourceActivityId: found.row.id, deleted_at: deletedAt, deleted_by: leadActionAuthor(req) },
  });
  res.json({ ok: true, activityId: found.row.id, deleted_at: deletedAt });
});

crmRouter.post("/api/email/activity/:activityId/restore", requirePass, (req, res) => {
  const found = emailActivityForRequest(req, res, true);
  if (!found) return;
  db.prepare(`UPDATE activities SET deleted_at = NULL WHERE id = ?`).run(found.row.id);
  logActivity(found.lead.id, {
    type: "email_restored",
    direction: "system",
    channel: "email",
    subject: "Email restored",
    body: found.row.subject ? `Restored email: ${found.row.subject}` : "Restored email from Trash.",
    status: "restored",
    meta: { sourceActivityId: found.row.id, restored_by: leadActionAuthor(req) },
  });
  res.json({ ok: true, activityId: found.row.id });
});

crmRouter.patch("/api/email/activity/:activityId", requirePass, (req, res) => {
  const row = db.prepare(`SELECT * FROM activities WHERE id = ? AND deleted_at IS NULL`).get(req.params.activityId) as
    | { id: string; lead_id: string; type: string; meta: string | null }
    | undefined;
  const activity = row ? { ...row, meta: safeMeta(row.meta) } : null;
  if (!activity || activity.type !== "email") {
    res.status(404).json({ error: "email activity not found" });
    return;
  }
  const lead = getLead(activity.lead_id);
  if (!lead) {
    res.status(404).json({ error: "lead not found" });
    return;
  }
  const owner = ownerScope(req);
  if (owner && lead.owner_user_id !== owner) {
    res.status(403).json({ error: "this lead is assigned to another user" });
    return;
  }
  const fileFolder = cleanText(req.body?.file_folder, "General").slice(0, 120);
  const discussionFile = cleanText(req.body?.discussion_file, "").slice(0, 120);
  const meta = { ...(activity.meta || {}) };
  meta.file_folder = fileFolder;
  meta.discussion_file = discussionFile;
  meta.filed_by = leadActionAuthor(req);
  meta.filed_at = new Date().toISOString();
  db.prepare(`UPDATE activities SET meta = ? WHERE id = ?`).run(JSON.stringify(meta), activity.id);
  logActivity(lead.id, {
    type: "email_filed",
    direction: "system",
    channel: "email",
    subject: "Email filed",
    body: `Email filed in ${fileFolder}${discussionFile ? ` / ${discussionFile}` : ""}`,
    status: "filed",
    meta: { sourceActivityId: activity.id, file_folder: fileFolder, discussion_file: discussionFile },
  });
  res.json({ ok: true, activityId: activity.id, file_folder: fileFolder, discussion_file: discussionFile });
});

crmRouter.post("/api/email/activity/:activityId/resend-refresh", requirePass, async (req, res) => {
  const row = db.prepare(`SELECT * FROM activities WHERE id = ? AND deleted_at IS NULL`).get(req.params.activityId) as
    | { id: string; lead_id: string; type: string; direction: string | null; subject: string | null; body: string | null; status: string | null; meta: string | null }
    | undefined;
  const activity = row ? { ...row, meta: safeMeta(row.meta) } : null;
  if (!activity || activity.type !== "email") {
    res.status(404).json({ error: "email activity not found" });
    return;
  }
  const lead = getLead(activity.lead_id);
  if (!lead) {
    res.status(404).json({ error: "lead not found" });
    return;
  }
  const owner = ownerScope(req);
  if (owner && lead.owner_user_id !== owner) {
    res.status(403).json({ error: "this lead is assigned to another user" });
    return;
  }
  const meta = { ...(activity.meta || {}) };
  const resendId = cleanText(meta.id || meta.resend_id || meta.resend_email_id);
  if (!resendId) {
    res.status(400).json({ error: "this email activity has no Resend id to refresh" });
    return;
  }
  if (activity.direction === "inbound") {
    const received = await retrieveReceivedEmail(resendId, resendReceivedHtmlFormat(req));
    if (!received) {
      res.status(404).json({ error: "received email not found in Resend" });
      return;
    }
    const body = received.text || (received.html ? textFromHtml(received.html) : "") || activity.body || "Inbound email received via Resend.";
    const subject = received.subject || activity.subject || "(no subject)";
    meta.resend_email_id = received.id || received.email_id || resendId;
    meta.message_id = received.message_id || meta.message_id || null;
    meta.received_email = received;
    meta.resend_refreshed_at = new Date().toISOString();
    meta.html = received.html || meta.html || null;
    meta.html_format = received.html_format || meta.html_format || null;
    meta.raw = received.raw || meta.raw || null;
    if (received.from) meta.from = received.from;
    if (received.to) meta.to = received.to;
    if (received.cc) meta.cc = received.cc;
    if (received.bcc) meta.bcc = received.bcc;
    if (received.reply_to) meta.reply_to = received.reply_to;
    if (received.received_for) meta.received_for = received.received_for;
    if (received.headers) meta.headers = received.headers;
    if (received.attachments) meta.attachments = received.attachments;
    db.prepare(`UPDATE activities SET subject = ?, body = ?, status = ?, meta = ? WHERE id = ?`).run(
      subject,
      body,
      "received",
      JSON.stringify(meta),
      activity.id,
    );
    res.json({
      ok: true,
      activityId: activity.id,
      status: "received",
      email: received,
      meta,
      subject,
      body,
    });
    return;
  }
  const sent = await retrieveSentEmail(resendId);
  if (!sent) {
    res.status(404).json({ error: "sent email not found in Resend" });
    return;
  }
  meta.resend_id = sent.id || resendId;
  meta.message_id = sent.message_id || meta.message_id || null;
  meta.last_event = sent.last_event || meta.last_event || null;
  meta.scheduled_at = sent.scheduled_at || meta.scheduled_at || null;
  meta.resend_email = sent;
  meta.resend_refreshed_at = new Date().toISOString();
  if (sent.to) meta.to = sent.to;
  if (sent.from) meta.from = sent.from;
  if (sent.cc) meta.cc = sent.cc;
  if (sent.bcc) meta.bcc = sent.bcc;
  if (sent.reply_to) meta.reply_to = sent.reply_to;
  if (sent.tags) meta.tags = sent.tags;
  const status = sent.last_event || activity.status || "sent";
  db.prepare(`UPDATE activities SET status = ?, meta = ? WHERE id = ?`).run(status, JSON.stringify(meta), activity.id);
  res.json({
    ok: true,
    activityId: activity.id,
    status,
    email: sent,
    meta,
  });
});

crmRouter.patch("/api/email/activity/:activityId/reschedule", requirePass, async (req, res) => {
  const row = db.prepare(`SELECT * FROM activities WHERE id = ? AND deleted_at IS NULL`).get(req.params.activityId) as
    | { id: string; lead_id: string; type: string; direction: string | null; subject: string | null; body: string | null; status: string | null; meta: string | null }
    | undefined;
  const activity = row ? { ...row, meta: safeMeta(row.meta) } : null;
  if (!activity || activity.type !== "email") {
    res.status(404).json({ error: "email activity not found" });
    return;
  }
  const lead = getLead(activity.lead_id);
  if (!lead) {
    res.status(404).json({ error: "lead not found" });
    return;
  }
  const owner = ownerScope(req);
  if (owner && lead.owner_user_id !== owner) {
    res.status(403).json({ error: "this lead is assigned to another user" });
    return;
  }
  const scheduledAt = scheduledAtFromBody(req.body);
  if (!scheduledAt) {
    res.status(400).json({ error: "scheduled_at must be a valid ISO 8601 date" });
    return;
  }
  const meta = { ...(activity.meta || {}) };
  const resendId = cleanText(meta.id || meta.resend_id || meta.resend_email_id);
  if (!resendId) {
    res.status(400).json({ error: "this email activity has no Resend id to reschedule" });
    return;
  }
  const result = await updateScheduledEmail(resendId, scheduledAt);
  if (!result.ok) {
    res.status(400).json({ ok: false, error: result.detail || "could not update scheduled email" });
    return;
  }
  meta.resend_id = result.id || resendId;
  meta.scheduled_at = scheduledAt;
  meta.last_event = "scheduled";
  meta.rescheduled_at = new Date().toISOString();
  meta.rescheduled_by = leadActionAuthor(req);
  db.prepare(`UPDATE activities SET status = ?, meta = ? WHERE id = ?`).run("scheduled", JSON.stringify(meta), activity.id);
  logActivity(lead.id, {
    type: "email_rescheduled",
    direction: "system",
    channel: "email",
    subject: "Scheduled email updated",
    body: `Email rescheduled for ${scheduledAt}`,
    status: "scheduled",
    meta: { sourceActivityId: activity.id, resend_id: result.id || resendId, scheduled_at: scheduledAt },
  });
  res.json({ ok: true, activityId: activity.id, id: result.id || resendId, scheduled_at: scheduledAt });
});

crmRouter.get("/api/email/activity/:activityId/attachments", requirePass, async (req, res) => {
  const row = db.prepare(`SELECT * FROM activities WHERE id = ? AND deleted_at IS NULL`).get(req.params.activityId) as
    | { id: string; lead_id: string; type: string; direction: string | null; subject: string | null; body: string | null; status: string | null; meta: string | null }
    | undefined;
  const activity = row ? { ...row, meta: safeMeta(row.meta) } : null;
  if (!activity || activity.type !== "email") {
    res.status(404).json({ error: "email activity not found" });
    return;
  }
  const lead = getLead(activity.lead_id);
  if (!lead) {
    res.status(404).json({ error: "lead not found" });
    return;
  }
  const owner = ownerScope(req);
  if (owner && lead.owner_user_id !== owner) {
    res.status(403).json({ error: "this lead is assigned to another user" });
    return;
  }
  const meta = { ...(activity.meta || {}) };
  const resendId = cleanText(meta.id || meta.resend_id || meta.resend_email_id);
  if (!resendId) {
    res.status(400).json({ error: "this email activity has no Resend id for attachments" });
    return;
  }
  const result = await listSentEmailAttachments(resendId, resendListQuery(req));
  if (!result.ok) {
    res.status(400).json({ error: result.detail || "could not list sent email attachments from Resend" });
    return;
  }
  res.json(result);
});

crmRouter.get("/api/email/activity/:activityId/attachments/:attachmentId", requirePass, async (req, res) => {
  const row = db.prepare(`SELECT * FROM activities WHERE id = ? AND deleted_at IS NULL`).get(req.params.activityId) as
    | { id: string; lead_id: string; type: string; direction: string | null; subject: string | null; body: string | null; status: string | null; meta: string | null }
    | undefined;
  const activity = row ? { ...row, meta: safeMeta(row.meta) } : null;
  if (!activity || activity.type !== "email") {
    res.status(404).json({ error: "email activity not found" });
    return;
  }
  const lead = getLead(activity.lead_id);
  if (!lead) {
    res.status(404).json({ error: "lead not found" });
    return;
  }
  const owner = ownerScope(req);
  if (owner && lead.owner_user_id !== owner) {
    res.status(403).json({ error: "this lead is assigned to another user" });
    return;
  }
  const meta = { ...(activity.meta || {}) };
  const resendId = cleanText(meta.id || meta.resend_id || meta.resend_email_id);
  if (!resendId) {
    res.status(400).json({ error: "this email activity has no Resend id for attachments" });
    return;
  }
  const attachment = await retrieveSentEmailAttachment(resendId, req.params.attachmentId);
  if (!attachment) {
    res.status(404).json({ error: "sent email attachment not found in Resend" });
    return;
  }
  res.json({ ok: true, attachment });
});

crmRouter.post("/api/email/activity/:activityId/cancel", requirePass, async (req, res) => {
  const row = db.prepare(`SELECT * FROM activities WHERE id = ? AND deleted_at IS NULL`).get(req.params.activityId) as
    | { id: string; lead_id: string; type: string; direction: string | null; subject: string | null; body: string | null; status: string | null; meta: string | null }
    | undefined;
  const activity = row ? { ...row, meta: safeMeta(row.meta) } : null;
  if (!activity || activity.type !== "email") {
    res.status(404).json({ error: "email activity not found" });
    return;
  }
  const lead = getLead(activity.lead_id);
  if (!lead) {
    res.status(404).json({ error: "lead not found" });
    return;
  }
  const owner = ownerScope(req);
  if (owner && lead.owner_user_id !== owner) {
    res.status(403).json({ error: "this lead is assigned to another user" });
    return;
  }
  const meta = { ...(activity.meta || {}) };
  const resendId = cleanText(meta.id || meta.resend_id || meta.resend_email_id);
  if (!resendId) {
    res.status(400).json({ error: "this email activity has no Resend id to cancel" });
    return;
  }
  const result = await cancelScheduledEmail(resendId);
  if (!result.ok) {
    res.status(400).json({ ok: false, error: result.detail || "could not cancel scheduled email" });
    return;
  }
  meta.resend_id = result.id || resendId;
  meta.last_event = "canceled";
  meta.canceled_at = new Date().toISOString();
  meta.canceled_by = leadActionAuthor(req);
  db.prepare(`UPDATE activities SET status = ?, meta = ? WHERE id = ?`).run("canceled", JSON.stringify(meta), activity.id);
  logActivity(lead.id, {
    type: "email_canceled",
    direction: "system",
    channel: "email",
    subject: "Scheduled email canceled",
    body: "Scheduled email canceled before send.",
    status: "canceled",
    meta: { sourceActivityId: activity.id, resend_id: result.id || resendId },
  });
  res.json({ ok: true, activityId: activity.id, id: result.id || resendId, status: "canceled" });
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

crmRouter.get("/api/campaigns/successes", requirePass, (req, res) => {
  const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 200;
  const owner = ownerScope(req);
  const rows = db
    .prepare(
      `SELECT j.id, j.step, j.updated_at, j.created_at, a.name AS automation_name,
              l.id AS lead_id, l.first_name, l.last_name, l.phone, l.email, l.pipeline_stage
         FROM automation_jobs j
         JOIN automations a ON a.id = j.automation_id
         LEFT JOIN leads l ON l.id = j.lead_id
        WHERE j.status = 'done'
          ${owner ? "AND l.owner_user_id = @owner" : ""}
        ORDER BY COALESCE(j.updated_at, j.created_at) DESC
        LIMIT @limit`,
    )
    .all({ owner: owner || "", limit: Math.min((limit || 200) * 3, 1000) }) as Array<{
    id: string;
    step: string;
    updated_at: number | null;
    created_at: number;
    automation_name: string | null;
    lead_id: string | null;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    email: string | null;
    pipeline_stage: string | null;
  }>;
  const sends = rows
    .map((row) => {
      let step: Step = { type: "wait" };
      try {
        step = JSON.parse(row.step) as Step;
      } catch {
        step = { type: "wait" };
      }
      return {
        id: row.id,
        automation_name: row.automation_name || "Automation",
        step_type: step.type,
        lead_id: row.lead_id,
        lead_name: [row.first_name, row.last_name].filter(Boolean).join(" ") || row.email || row.phone || "Lead",
        phone: row.phone,
        email: row.email,
        pipeline_stage: row.pipeline_stage,
        sent_at: row.updated_at || row.created_at,
        preview: "message" in step ? step.message : "subject" in step ? step.subject : "voicemailText" in step ? step.voicemailText : "",
      };
    })
    .filter((row) => ["send_text", "send_email", "voicemail_drop"].includes(row.step_type))
    .slice(0, Math.min(limit || 200, 500));
  res.json({ ok: true, sends });
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
