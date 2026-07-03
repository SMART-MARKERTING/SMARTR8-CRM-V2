import { randomUUID } from "crypto";
import { db, getMeta, setMeta } from "../store/db";
import { config } from "../config";
import { log } from "../logger";
import { Lead, getLead, findLead, leadName, logActivity, logActivityOnce, addLeadTag, updateLead, resolveLeadTimezone } from "./leads";
import { sendOutbound } from "./router";
import { isOnDnc } from "./dnc";
import { sendEmail, emailConfigured } from "./email";
import { dropVoicemail, voicemailConfigured } from "./voicemail";
import { getDefaultVoicemailAudioUrl } from "./voicemailSettings";
import { generateVoicemailAudio } from "./elevenLabs";
import { withinCallingHours } from "./compliance";
import { smsWindowForTz } from "../util/areaCodeTz";
import { signToken } from "../util/token";
import { emailSignatureText, emailFooterText, renderBrandedEmailHtml } from "../brand";
import { CAMPAIGNS, REMARKETING, campaignToSteps } from "./campaigns";
import { logMessage } from "./ghl";

const PUBLIC_BASE = config.publicBaseUrl || config.crm.publicBaseUrl || "https://crm.smartr8.com";
let tickQueued = false;

// ── Types ───────────────────────────────────────────────────────────────────

export type StepType =
  | "send_email"
  | "send_text"
  | "voicemail_drop"
  | "add_tag"
  | "set_status"
  | "set_stage"
  | "wait";

export interface Step {
  type: StepType;
  delayMinutes?: number; // wait this long (from the previous step) before running
  // send_email
  subject?: string;
  preheader?: string;
  html?: string; // body (signature + CAN-SPAM footer appended at send)
  text?: string; // body
  ctaLabel?: string;
  ctaUrl?: string;
  // send_text
  message?: string;
  // voicemail_drop
  voicemailText?: string;
  voicemailAudioUrl?: string;
  followupText?: string;
  // add_tag
  tag?: string;
  // set_status
  status?: string;
  // set_stage (pipeline)
  stage?: string;
}

export interface Automation {
  id: string;
  created_at: number;
  updated_at: number;
  name: string;
  enabled: boolean;
  /** When true, this flow's send_text/voicemail_drop ignore the TCPA sending-hours
   *  window and fire immediately. Default false — for testing/transactional sends. */
  bypassHours: boolean;
  trigger: string;
  filter: Record<string, unknown>;
  steps: Step[];
}

interface AutomationRow {
  id: string;
  created_at: number;
  updated_at: number;
  name: string;
  enabled: number;
  bypass_hours: number;
  trigger: string;
  filter: string;
  steps: string;
}

interface JobRow {
  id: string;
  run_id: string;
  automation_id: string;
  lead_id: string;
  step_index: number;
  step: string;
  run_at: number;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number | null;
}

function rowToAutomation(r: AutomationRow): Automation {
  return {
    id: r.id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    name: r.name,
    enabled: r.enabled === 1,
    bypassHours: r.bypass_hours === 1,
    trigger: r.trigger,
    filter: safeParse<Record<string, unknown>>(r.filter, {}),
    steps: safeParse<Step[]>(r.steps, []),
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

// ── CRUD ────────────────────────────────────────────────────────────────────

export function listAutomations(): Automation[] {
  return (db.prepare(`SELECT * FROM automations ORDER BY created_at`).all() as AutomationRow[]).map(rowToAutomation);
}

export function getAutomation(id: string): Automation | null {
  const r = db.prepare(`SELECT * FROM automations WHERE id = ?`).get(id) as AutomationRow | undefined;
  return r ? rowToAutomation(r) : null;
}

export function createAutomation(input: {
  name: string;
  trigger?: string;
  enabled?: boolean;
  filter?: Record<string, unknown>;
  steps?: Step[];
}): Automation {
  const now = Date.now();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO automations (id, created_at, updated_at, name, enabled, trigger, filter, steps)
     VALUES (@id, @created_at, @updated_at, @name, @enabled, @trigger, @filter, @steps)`,
  ).run({
    id,
    created_at: now,
    updated_at: now,
    name: input.name,
    enabled: input.enabled === false ? 0 : 1,
    trigger: input.trigger ?? "lead_created",
    filter: JSON.stringify(input.filter ?? {}),
    steps: JSON.stringify(input.steps ?? []),
  });
  return getAutomation(id)!;
}

export function updateAutomation(
  id: string,
  patch: { name?: string; enabled?: boolean; bypassHours?: boolean; trigger?: string; filter?: Record<string, unknown>; steps?: Step[] },
): Automation | null {
  const existing = getAutomation(id);
  if (!existing) return null;
  db.prepare(
    `UPDATE automations SET name=@name, enabled=@enabled, bypass_hours=@bypass_hours, trigger=@trigger, filter=@filter, steps=@steps, updated_at=@updated_at WHERE id=@id`,
  ).run({
    id,
    name: patch.name ?? existing.name,
    enabled: (patch.enabled ?? existing.enabled) ? 1 : 0,
    bypass_hours: (patch.bypassHours ?? existing.bypassHours) ? 1 : 0,
    trigger: patch.trigger ?? existing.trigger,
    filter: JSON.stringify(patch.filter ?? existing.filter),
    steps: JSON.stringify(patch.steps ?? existing.steps),
    updated_at: Date.now(),
  });
  return getAutomation(id);
}

// ── Trigger → schedule jobs ─────────────────────────────────────────────────

/** True if the lead matches an automation's optional filter (`source` and/or `category`). */
function leadMatchesFilter(lead: Lead, filter: Record<string, unknown>): boolean {
  if (filter.source && String(filter.source).toLowerCase() !== String(lead.source ?? "").toLowerCase()) {
    return false;
  }
  if (filter.category && String(filter.category) !== String(lead.category ?? "")) {
    return false;
  }
  return true;
}

function matchingAutomationsForTrigger(trigger: string, lead: Lead): Automation[] {
  const matched = listAutomations().filter((a) => a.enabled && a.trigger === trigger && leadMatchesFilter(lead, a.filter));
  if (trigger !== "lead_created") return matched;
  const categoryMatched = matched.filter((a) => a.filter.category && String(a.filter.category) === String(lead.category ?? ""));
  const broadMatched = matched.filter((a) => !a.filter.category);
  return categoryMatched.length ? [...categoryMatched, ...broadMatched] : matched;
}

/**
 * Fire a trigger for a lead: every enabled automation on that trigger schedules its
 * steps as jobs (run_at staggered by each step's cumulative delayMinutes). Returns the
 * number of automations started.
 */
export function fireTrigger(trigger: string, lead: Lead): number {
  const autos = matchingAutomationsForTrigger(trigger, lead);
  let started = 0;
  for (const auto of autos) {
    if (!auto.steps.length) continue;
    // Idempotency — block overlapping runs, but allow a fresh website re-submit to
    // restart after intake stops the prior pending jobs.
    const phone = lead.phone;
    const prior = phone
      ? db
          .prepare(
            `SELECT 1 FROM automation_runs r JOIN leads l ON l.id = r.lead_id
              WHERE r.automation_id = ? AND r.status = 'running' AND (r.lead_id = ? OR l.phone = ?) LIMIT 1`,
          )
          .get(auto.id, lead.id, phone)
      : db.prepare(`SELECT 1 FROM automation_runs WHERE automation_id = ? AND lead_id = ? AND status = 'running' LIMIT 1`).get(auto.id, lead.id);
    if (prior) {
      log.info("automation enroll skipped (already running for this lead/number)", { automation: auto.name, leadId: lead.id });
      continue;
    }
    const runId = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO automation_runs (id, automation_id, lead_id, created_at, status) VALUES (?,?,?,?, 'running')`,
    ).run(runId, auto.id, lead.id, now);
    let cumulative = 0;
    const insert = db.prepare(
      `INSERT INTO automation_jobs (id, run_id, automation_id, lead_id, step_index, step, run_at, status, attempts, created_at, updated_at)
       VALUES (@id, @run_id, @automation_id, @lead_id, @step_index, @step, @run_at, 'pending', 0, @created_at, @created_at)`,
    );
    auto.steps.forEach((step, idx) => {
      cumulative += Math.max(0, step.delayMinutes ?? 0);
      insert.run({
        id: randomUUID(),
        run_id: runId,
        automation_id: auto.id,
        lead_id: lead.id,
        step_index: idx,
        step: JSON.stringify(step),
        run_at: now + cumulative * 60_000,
        created_at: now,
      });
    });
    logActivity(lead.id, {
      type: "automation",
      direction: "system",
      channel: "system",
      body: `Automation started: ${auto.name}`,
      meta: { automationId: auto.id, runId, steps: auto.steps.length },
    });
    started++;
    log.info("automation started", { automation: auto.name, leadId: lead.id, steps: auto.steps.length });
  }
  if (started > 0) queueAutomationTick();
  return started;
}

/**
 * Manually enroll a lead in a SPECIFIC automation from the console (the lead-detail Campaign
 * picker). This is an explicit operator action, so it bypasses fireTrigger's "once ever" guard
 * and its trigger/filter matching. Any currently-running flow for the lead is stopped first, so
 * switching campaigns doesn't stack two drips. Returns false if the lead/automation is missing.
 */
export function enrollLeadInAutomation(leadId: string, automationId: string): boolean {
  const lead = getLead(leadId);
  const auto = getAutomation(automationId);
  if (!lead || !auto || !auto.steps.length) return false;
  stopLeadAutomations(leadId, `switched to campaign: ${auto.name}`);
  const runId = randomUUID();
  const now = Date.now();
  db.prepare(`INSERT INTO automation_runs (id, automation_id, lead_id, created_at, status) VALUES (?,?,?,?, 'running')`).run(
    runId, auto.id, lead.id, now,
  );
  let cumulative = 0;
  const insert = db.prepare(
    `INSERT INTO automation_jobs (id, run_id, automation_id, lead_id, step_index, step, run_at, status, attempts, created_at, updated_at)
     VALUES (@id, @run_id, @automation_id, @lead_id, @step_index, @step, @run_at, 'pending', 0, @created_at, @created_at)`,
  );
  auto.steps.forEach((step, idx) => {
    cumulative += Math.max(0, step.delayMinutes ?? 0);
    insert.run({
      id: randomUUID(), run_id: runId, automation_id: auto.id, lead_id: lead.id,
      step_index: idx, step: JSON.stringify(step), run_at: now + cumulative * 60_000, created_at: now,
    });
  });
  logActivity(lead.id, {
    type: "automation", direction: "system", channel: "system",
    body: `Enrolled in campaign: ${auto.name}`, meta: { automationId: auto.id, runId, steps: auto.steps.length, manual: true },
  });
  log.info("manual campaign enroll", { automation: auto.name, leadId: lead.id });
  queueAutomationTick();
  return true;
}

export interface EnrollmentDiagnostics {
  /** Enabled automations on this trigger (regardless of filter). */
  enabledOnTrigger: number;
  /** Of those, how many matched this lead's filter. */
  matched: number;
  matchedNames: string[];
  /** Plain-English reason a website lead won't enroll, or null if it should. */
  note: string | null;
}

/**
 * Explain whether a lead will actually get the sequence — turning the silent
 * "nothing happened" into an actionable reason. Mirrors fireTrigger's matching
 * exactly (same trigger + source/category filter). SMS consent no longer gates
 * sends (only DNC does, at send time), so the only enrollment failures are "no
 * enabled flow" and "filter mismatch". Used by the lead-intake webhook and the
 * manual run-automation action so the cause is visible without reading logs.
 */
export function diagnoseEnrollment(trigger: string, lead: Lead): EnrollmentDiagnostics {
  const onTrigger = listAutomations().filter((a) => a.enabled && a.trigger === trigger);
  const matched = matchingAutomationsForTrigger(trigger, lead);

  let note: string | null = null;
  if (onTrigger.length === 0) {
    note = `No enabled automations on "${trigger}". Turn a drip On in the Flows tab so leads enroll.`;
  } else if (matched.length === 0) {
    note =
      `${onTrigger.length} enabled flow(s) exist but none matched this lead ` +
      `(category="${lead.category ?? "—"}", source="${lead.source ?? "—"}"). ` +
      `Check the campaign's category/source filter matches what intake assigns.`;
  }

  return {
    enabledOnTrigger: onTrigger.length,
    matched: matched.length,
    matchedNames: matched.map((a) => a.name),
    note,
  };
}

// ── Lead reply handling (auto-advance + pause drip) ──────────────────────────

/** Cancel a lead's pending automation steps (e.g. once a human is engaged). Returns count. */
export function stopLeadAutomations(leadId: string, reason = "lead replied"): number {
  const now = Date.now();
  const r = db
    .prepare(`UPDATE automation_jobs SET status='paused', last_error=?, updated_at=? WHERE lead_id=? AND status='pending'`)
    .run(reason, now, leadId);
  db.prepare(`UPDATE automation_runs SET status='stopped' WHERE lead_id=? AND status='running'`).run(leadId);
  return r.changes ?? 0;
}

/** Resume a paused campaign: paused steps -> pending, re-staggered from now so the next
 *  step fires ~immediately and the rest keep their original cadence. */
export function resumeLeadAutomations(leadId: string): number {
  const paused = db
    .prepare(`SELECT * FROM automation_jobs WHERE lead_id=? AND status='paused' ORDER BY step_index`)
    .all(leadId) as JobRow[];
  if (!paused.length) return 0;
  const now = Date.now();
  const earliest = Math.min(...paused.map((j) => j.run_at));
  const delta = now - earliest; // shift the whole remaining schedule forward to "now"
  const upd = db.prepare(`UPDATE automation_jobs SET status='pending', run_at=?, last_error=NULL, updated_at=? WHERE id=?`);
  for (const j of paused) upd.run(Math.max(now, j.run_at + delta), now, j.id);
  for (const runId of Array.from(new Set(paused.map((j) => j.run_id)))) {
    db.prepare(`UPDATE automation_runs SET status='running' WHERE id=? AND status='stopped'`).run(runId);
  }
  queueAutomationTick();
  return paused.length;
}

export interface CampaignState {
  enrolled: boolean;
  runId?: string;
  name?: string;
  status?: string;
  paused: boolean;
  stepDone: number;
  stepTotal: number;
  nextStepType?: string;
  nextRunAt?: number;
}

/** Snapshot of a lead's most recent campaign run for the console (phase + status). */
export function leadCampaignState(leadId: string): CampaignState {
  const run = db
    .prepare(`SELECT id, automation_id, status FROM automation_runs WHERE lead_id=? ORDER BY created_at DESC LIMIT 1`)
    .get(leadId) as { id: string; automation_id: string; status: string } | undefined;
  if (!run) return { enrolled: false, paused: false, stepDone: 0, stepTotal: 0 };
  const jobs = db.prepare(`SELECT * FROM automation_jobs WHERE run_id=? ORDER BY step_index`).all(run.id) as JobRow[];
  const done = jobs.filter((j) => j.status === "done" || j.status === "skipped" || j.status === "error").length;
  const next = jobs.find((j) => j.status === "pending" || j.status === "paused");
  let nextStepType: string | undefined;
  if (next) {
    try { nextStepType = (JSON.parse(next.step) as Step).type; } catch { /* ignore */ }
  }
  return {
    enrolled: true,
    runId: run.id,
    name: getAutomation(run.automation_id)?.name,
    status: run.status,
    paused: jobs.some((j) => j.status === "paused"),
    stepDone: done,
    stepTotal: jobs.length,
    nextStepType,
    nextRunAt: next?.run_at,
  };
}

/** Skip ahead: run the next pending/paused step now. */
export function advancePhase(leadId: string): boolean {
  const run = db.prepare(`SELECT id FROM automation_runs WHERE lead_id=? ORDER BY created_at DESC LIMIT 1`).get(leadId) as { id: string } | undefined;
  if (!run) return false;
  const next = db.prepare(`SELECT id FROM automation_jobs WHERE run_id=? AND status IN ('pending','paused') ORDER BY step_index LIMIT 1`).get(run.id) as { id: string } | undefined;
  if (!next) return false;
  const now = Date.now();
  db.prepare(`UPDATE automation_jobs SET status='pending', run_at=?, updated_at=? WHERE id=?`).run(now, now, next.id);
  db.prepare(`UPDATE automation_runs SET status='running' WHERE id=? AND status='stopped'`).run(run.id);
  queueAutomationTick();
  return true;
}

/** Go back: re-queue the most recent completed step to run now. */
export function rewindPhase(leadId: string): boolean {
  const run = db.prepare(`SELECT id FROM automation_runs WHERE lead_id=? ORDER BY created_at DESC LIMIT 1`).get(leadId) as { id: string } | undefined;
  if (!run) return false;
  const last = db.prepare(`SELECT id FROM automation_jobs WHERE run_id=? AND status IN ('done','skipped','error') ORDER BY step_index DESC LIMIT 1`).get(run.id) as { id: string } | undefined;
  if (!last) return false;
  const now = Date.now();
  db.prepare(`UPDATE automation_jobs SET status='pending', run_at=?, attempts=0, last_error=NULL, updated_at=? WHERE id=?`).run(now, now, last.id);
  db.prepare(`UPDATE automation_runs SET status='running' WHERE id=? AND status IN ('stopped','done')`).run(run.id);
  queueAutomationTick();
  return true;
}

/**
 * Flag a lead as a past client and, on the 0→1 transition, fire the `past_client`
 * trigger so the Remarketing campaign (if enabled) enrolls it. Idempotent: a lead that's
 * already a past client isn't re-flagged or re-enrolled.
 */
export function markPastClient(leadId: string): boolean {
  const lead = getLead(leadId);
  if (!lead || lead.past_client) return false;
  updateLead(leadId, { past_client: true });
  // Attach a visible "past-client" tag too (so a lead moved to Funded is tagged, not just flagged).
  addLeadTag(leadId, "past-client");
  const updated = getLead(leadId);
  if (updated) fireTrigger("past_client", updated);
  return true;
}

/**
 * An inbound reply from a lead (text/iMessage that is not a STOP/HELP keyword): advance
 * a fresh lead from Lead-In to Replied and pause any running drip so we stop auto-texting
 * once they have engaged. No-op if the number is not a known lead.
 */
export function handleLeadReply(phone: string): void {
  const lead = findLead({ phone });
  if (!lead) return;
  const advance = lead.pipeline_stage === "Lead-In";
  if (advance) updateLead(lead.id, { pipeline_stage: "Replied" }); // logs the stage_change itself
  const stopped = stopLeadAutomations(lead.id, "lead replied");
  if (stopped > 0) {
    logActivity(lead.id, {
      type: "automation",
      direction: "system",
      channel: "system",
      body: `Paused drip after reply (${stopped} step${stopped === 1 ? "" : "s"} cancelled)`,
      status: "stopped",
    });
    log.info("paused drip after lead reply", { leadId: lead.id, stopped });
  }
}

// ── Template rendering ──────────────────────────────────────────────────────

const MONEY_TEMPLATE_FIELDS = new Set([
  "home_value",
  "mortgage_balance",
  "loan_amount",
  "cash_out",
  "monthly_payment",
  "heloc_line",
]);

function renderTemplateValue(key: string, value: unknown): string {
  if (value == null) return MONEY_TEMPLATE_FIELDS.has(key) ? "not listed" : "";
  const raw = String(value).trim();
  if (!raw) return MONEY_TEMPLATE_FIELDS.has(key) ? "not listed" : "";
  if (!MONEY_TEMPLATE_FIELDS.has(key)) return raw;

  const numeric = Number(raw.replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(numeric)) return raw;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(numeric);
}

function render(tpl: string | undefined, lead: Lead): string {
  if (!tpl) return "";
  const custom = (lead.custom ?? {}) as Record<string, unknown>;
  const vars: Record<string, string> = {
    first_name: lead.first_name ?? "",
    last_name: lead.last_name ?? "",
    name: leadName(lead),
    email: lead.email ?? "",
    phone: lead.phone ?? "",
  };
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return vars[key] ?? "";
    return renderTemplateValue(key, custom[key]);
  });
}

// ── Step execution ──────────────────────────────────────────────────────────

type StepOutcome =
  | { status: "done"; detail?: string }
  | { status: "skipped"; detail: string }
  | { status: "reschedule"; runAt: number; detail: string };

async function executeStep(lead: Lead, step: Step, bypassHours = false): Promise<StepOutcome> {
  switch (step.type) {
    case "wait":
      return { status: "done" };

    case "add_tag": {
      if (!step.tag) return { status: "skipped", detail: "no tag" };
      addLeadTag(lead.id, step.tag);
      return { status: "done", detail: step.tag };
    }

    case "set_status": {
      if (!step.status) return { status: "skipped", detail: "no status" };
      updateLead(lead.id, { status: step.status });
      return { status: "done", detail: step.status };
    }

    case "set_stage": {
      if (!step.stage) return { status: "skipped", detail: "no stage" };
      updateLead(lead.id, { pipeline_stage: step.stage });
      return { status: "done", detail: step.stage };
    }

    case "send_email": {
      if (!lead.email) return { status: "skipped", detail: "lead has no email" };
      if (lead.email_unsubscribed) return { status: "skipped", detail: "email unsubscribed" };
      if (!emailConfigured()) return { status: "skipped", detail: "email not configured" };
      const subject = render(step.subject, lead) || `A note from ${"Mykoal DeShazo"}`;
      const unsubUrl = `${PUBLIC_BASE}/unsubscribe?lead=${lead.id}&t=${signToken(lead.id)}`;
      const bodyHtml = render(step.html, lead);
      const bodyText = render(step.text, lead);
      const ctaHtml = step.ctaLabel
        ? `<p style="margin:18px 0"><a href="${step.ctaUrl || PUBLIC_BASE}" style="background:#1f9d55;color:#fff;padding:11px 18px;border-radius:8px;text-decoration:none;font-weight:600">${step.ctaLabel}</a></p>`
        : "";
      const ctaText = step.ctaLabel ? `\n\n${step.ctaLabel}${step.ctaUrl ? `: ${step.ctaUrl}` : ""}` : "";
      const preheader = step.preheader
        ? `<span style="display:none;max-height:0;overflow:hidden;opacity:0">${render(step.preheader, lead)}</span>`
        : "";
      const paragraphsHtml = bodyHtml
        .split("\n\n")
        .map((p) => `<p style="margin:0 0 16px;">${p.replace(/\n/g, "<br>")}</p>`)
        .join("");
      // Branded shell (logo, contact box, signature, EHO + CAN-SPAM footer) wraps the
      // per-step copy, so every drip email — including the day-0 welcome — looks identical
      // to the smartr8.com transactional email instead of a plain text block.
      const html = renderBrandedEmailHtml({ preheaderHtml: preheader, bodyHtml: paragraphsHtml, ctaHtml, unsubUrl });
      const text = `${bodyText}${ctaText}\n\n${emailSignatureText()}${emailFooterText(unsubUrl)}`;
      const r = await sendEmail({ to: lead.email, subject, html, text });
      logActivity(lead.id, {
        type: "email",
        direction: "outbound",
        channel: "email",
        subject,
        body: text || html || "",
        status: r.ok ? "sent" : "failed",
        meta: { id: r.id, detail: r.detail },
      });
      return r.ok ? { status: "done", detail: r.id } : { status: "skipped", detail: r.detail ?? "send failed" };
    }

    case "send_text": {
      if (!lead.phone) return { status: "skipped", detail: "lead has no phone" };
      // SMS consent is recorded on the lead (sms_consent / consent_at / timeline) but no
      // longer gates drip texts — the owner texts every lead unless they're on the
      // Do-Not-Contact list. DNC (STOP keyword, IVR opt-out, or the console's DNC button)
      // is the one hard suppression; surface the skip on the timeline so it's visible.
      if (await isOnDnc(lead.phone)) {
        logActivity(lead.id, {
          type: "sms",
          direction: "outbound",
          channel: "sms",
          body: render(step.message, lead),
          status: "skipped:dnc",
        });
        return { status: "skipped", detail: "on Do-Not-Contact list" };
      }
      const message = render(step.message, lead);
      if (!message) return { status: "skipped", detail: "empty message" };
      // TCPA quiet hours: 8 AM..9 PM in the lead's timezone (address first, then area
      // code, then conservative). Outside the window → reschedule to the next start.
      const tz = resolveLeadTimezone(lead);
      const win = smsWindowForTz(tz);
      if (!win.allowed && !bypassHours) {
        return { status: "reschedule", runAt: win.nextStartMs ?? Date.now() + 60 * 60 * 1000, detail: "SMS quiet hours" };
      }
      if (!win.allowed && bypassHours) {
        log.warn("send_text: flow override — sending outside TCPA quiet hours", { leadId: lead.id });
      }
      const r = await sendOutbound({ phone: lead.phone, message });
      const channel = r.path.startsWith("imessage") ? "imessage" : "sms";
      // The send already happened — never let post-send bookkeeping throw, or runJob would
      // retry the whole step and re-send the SAME text to the lead (up to MAX_ATTEMPTS).
      try {
        logActivityOnce(lead.id, {
          type: channel,
          direction: "outbound",
          channel,
          body: message,
          status: r.ok ? r.path : `failed:${r.path}`,
          meta: { detail: r.detail },
        });
      } catch (err) {
        log.warn("send_text: post-send logActivity failed (not retrying send)", { leadId: lead.id, err: String(err) });
      }
      // Best-effort mirror into GHL so the conversation still threads there if enabled.
      if (config.crm.mirrorToGhl && lead.ghl_contact_id) {
        try {
          await logMessage({ contactId: lead.ghl_contact_id, message, direction: "outbound" });
        } catch (err) {
          log.warn("automation text: GHL mirror failed", { err: String(err) });
        }
      }
      return r.ok ? { status: "done", detail: r.path } : { status: "skipped", detail: r.detail };
    }

    case "voicemail_drop": {
      if (!lead.phone) return { status: "skipped", detail: "lead has no phone" };
      const renderedScript = render(step.voicemailText, lead).trim();
      let audioUrl = (step.voicemailAudioUrl || "").trim() || undefined;
      if (renderedScript) {
        try {
          audioUrl = (await generateVoicemailAudio(renderedScript, { baseUrl: PUBLIC_BASE })).url;
        } catch (err) {
          logActivity(lead.id, {
            type: "voicemail",
            direction: "outbound",
            channel: "voice",
            body: "Voicemail drop not placed",
            status: "skipped:elevenlabs",
            meta: { error: String(err) },
          });
          return { status: "skipped", detail: `ElevenLabs audio failed: ${String(err)}` };
        }
      }
      if (!voicemailConfigured(audioUrl)) return { status: "skipped", detail: "voicemail not configured" };
      // Calling-hours gate: enforce when we know a timezone (lead's or the configured
      // default). Outside the window → reschedule to the next window start, not skip.
      const tz = lead.timezone || config.crm.defaultTimezone || undefined;
      if (tz) {
        const gate = withinCallingHours(tz);
        if (!gate.allowed && gate.reason === "outside-hours" && !bypassHours) {
          return { status: "reschedule", runAt: nextWindowStart(tz), detail: "outside calling hours" };
        }
      }
      const r = await dropVoicemail({ phone: lead.phone, leadId: lead.id, audioUrl });
      if ("ok" in r) {
        const resolvedAudioUrl = audioUrl || getDefaultVoicemailAudioUrl();
        logActivity(lead.id, {
          type: "voicemail",
          direction: "outbound",
          channel: "voice",
          body: `Voicemail drop initiated to ${lead.phone}`,
          status: "initiated",
          meta: { ccid: r.ccid, audioUrl: resolvedAudioUrl || undefined },
        });
        const followup = render(step.followupText || step.message, lead).trim();
        if (followup) {
          const sr = await sendOutbound({ phone: lead.phone, message: followup });
          const channel = sr.path.startsWith("imessage") ? "imessage" : "sms";
          try {
            logActivityOnce(lead.id, {
              type: channel,
              direction: "outbound",
              channel,
              body: followup,
              status: sr.ok ? "voicemail-followup-sent" : `failed:${sr.path}`,
              meta: { detail: sr.detail, voicemailFollowup: true },
            });
          } catch (err) {
            log.warn("voicemail_drop: follow-up logActivity failed (not retrying voicemail)", { leadId: lead.id, err: String(err) });
          }
        }
        return { status: "done", detail: r.ccid };
      }
      const reason = "skipped" in r ? r.reason : r.error;
      logActivity(lead.id, {
        type: "voicemail",
        direction: "outbound",
        channel: "voice",
        body: `Voicemail drop not placed to ${lead.phone}`,
        status: `skipped:${reason}`,
      });
      return { status: "skipped", detail: reason };
    }

    default:
      return { status: "skipped", detail: `unknown step type ${(step as Step).type}` };
  }
}

/** Epoch ms of the next calling-window start in the given tz (today if not yet started, else tomorrow). */
function nextWindowStart(tz: string): number {
  const start = config.compliance.callHoursStart;
  try {
    const now = new Date();
    const hourStr = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(now);
    const localHour = parseInt(hourStr, 10) % 24;
    // Minutes until the window opens (next start boundary), then convert to an absolute time.
    const hoursUntil = localHour < start ? start - localHour : 24 - localHour + start;
    return Date.now() + hoursUntil * 60 * 60 * 1000;
  } catch {
    return Date.now() + 60 * 60 * 1000; // unknown tz: just back off an hour
  }
}

// ── Worker ──────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 3;
let working = false;

export function queueAutomationTick(delayMs = 0): void {
  if (tickQueued) return;
  tickQueued = true;
  setTimeout(() => {
    tickQueued = false;
    void tick();
  }, Math.max(0, delayMs));
}

async function runJob(job: JobRow): Promise<void> {
  const lead = getLead(job.lead_id);
  if (!lead) {
    db.prepare(`UPDATE automation_jobs SET status='skipped', last_error='lead gone', updated_at=? WHERE id=?`).run(Date.now(), job.id);
    maybeFinishRun(job.run_id);
    return;
  }
  const step = safeParse<Step>(job.step, { type: "wait" });
  const bypassHours = getAutomation(job.automation_id)?.bypassHours ?? false;
  try {
    const outcome = await executeStep(lead, step, bypassHours);
    if (outcome.status === "reschedule") {
      db.prepare(`UPDATE automation_jobs SET run_at=?, last_error=?, updated_at=? WHERE id=?`).run(outcome.runAt, outcome.detail, Date.now(), job.id);
      log.info("automation step rescheduled", { leadId: lead.id, step: step.type, runAt: new Date(outcome.runAt).toISOString() });
      return;
    }
    db.prepare(`UPDATE automation_jobs SET status=?, last_error=?, updated_at=? WHERE id=?`).run(
      outcome.status === "done" ? "done" : "skipped",
      outcome.status === "skipped" ? outcome.detail : null,
      Date.now(),
      job.id,
    );
  } catch (err) {
    const attempts = job.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      db.prepare(`UPDATE automation_jobs SET status='error', attempts=?, last_error=?, updated_at=? WHERE id=?`).run(
        attempts,
        String(err),
        Date.now(),
        job.id,
      );
      logActivity(lead.id, {
        type: "automation",
        direction: "system",
        channel: "system",
        body: `Step failed (${step.type}): ${String(err)}`,
        status: "error",
      });
    } else {
      db.prepare(`UPDATE automation_jobs SET attempts=?, run_at=?, last_error=?, updated_at=? WHERE id=?`).run(
        attempts,
        Date.now() + 2 * 60_000, // retry in 2 min
        String(err),
        Date.now(),
        job.id,
      );
    }
    log.error("automation step threw", { leadId: lead.id, step: step.type, attempts, err: String(err) });
  }
  maybeFinishRun(job.run_id);
}

/** Mark a run done once it has no more pending jobs. */
function maybeFinishRun(runId: string): void {
  const pending = db
    .prepare(`SELECT COUNT(*) AS n FROM automation_jobs WHERE run_id=? AND status IN ('pending','paused')`)
    .get(runId) as { n: number };
  if (pending.n === 0) {
    db.prepare(`UPDATE automation_runs SET status='done' WHERE id=? AND status='running'`).run(runId);
  }
}

async function tick(): Promise<void> {
  if (working) return; // don't overlap ticks
  working = true;
  try {
    const due = db
      .prepare(`SELECT * FROM automation_jobs WHERE status='pending' AND run_at <= ? ORDER BY run_at LIMIT 25`)
      .all(Date.now()) as JobRow[];
    for (const job of due) await runJob(job);
  } catch (err) {
    log.error("automation tick error", { err: String(err) });
  } finally {
    working = false;
  }
}

/** Start the background worker that runs due automation steps. */
export function startAutomationWorker(): void {
  const ms = config.crm.automationPollMs;
  setInterval(() => {
    void tick();
  }, ms);
  queueAutomationTick();
  log.info("automation worker started", { pollMs: ms });
}

// ── Diagnostics (Flows tab health panel) ─────────────────────────────────────

export interface AutomationHealth {
  email: { configured: boolean; from: string | null };
  sms: { telnyx: boolean; imessage: boolean };
  worker: { pollMs: number; pending: number; dueNow: number };
  flows: { total: number; enabledOnLeadCreated: number; names: string[] };
}

/** Config + worker snapshot so the operator can see at a glance why sends do/don't happen. */
export function getAutomationHealth(): AutomationHealth {
  const autos = listAutomations();
  const onLeadCreated = autos.filter((a) => a.enabled && a.trigger === "lead_created");
  const pending = (db.prepare(`SELECT COUNT(*) AS n FROM automation_jobs WHERE status='pending'`).get() as { n: number }).n;
  const dueNow = (
    db.prepare(`SELECT COUNT(*) AS n FROM automation_jobs WHERE status='pending' AND run_at<=?`).get(Date.now()) as { n: number }
  ).n;
  return {
    email: { configured: emailConfigured(), from: config.email.fromEmail || null },
    sms: { telnyx: Boolean(config.telnyx.apiKey && config.telnyx.fromNumber), imessage: Boolean(config.bluebubbles.url) },
    worker: { pollMs: config.crm.automationPollMs, pending, dueNow },
    flows: { total: autos.length, enabledOnLeadCreated: onLeadCreated.length, names: onLeadCreated.map((a) => a.name) },
  };
}

export interface ActivityRow {
  lead: string;
  step: string;
  status: string;
  error: string | null;
  at: number;
  count: number;
}

/** Recent automation job outcomes (newest first) — shows exactly what sent vs skipped + why. */
export function recentAutomationActivity(limit = 40): ActivityRow[] {
  const rows = db
    .prepare(
      `SELECT j.step AS step, j.status AS status, j.last_error AS last_error,
              COALESCE(j.updated_at, j.created_at) AS at,
              l.first_name AS first_name, l.last_name AS last_name, l.phone AS phone, l.email AS email
         FROM automation_jobs j LEFT JOIN leads l ON l.id = j.lead_id
        WHERE j.status <> 'pending'
        ORDER BY COALESCE(j.updated_at, j.created_at) DESC LIMIT ?`,
    )
    .all(Math.min(limit * 4, 400)) as Array<{
    step: string;
    status: string;
    last_error: string | null;
    at: number;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    email: string | null;
  }>;
  const collapsed: ActivityRow[] = [];
  for (const r of rows) {
    let stepType = "step";
    try {
      stepType = (JSON.parse(r.step) as Step).type;
    } catch {
      /* keep default */
    }
    const row: ActivityRow = {
      lead: [r.first_name, r.last_name].filter(Boolean).join(" ") || r.email || r.phone || "(lead)",
      step: stepType,
      status: r.status,
      error: r.last_error,
      at: r.at,
      count: 1,
    };
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.lead === row.lead && prev.step === row.step && prev.status === row.status && prev.error === row.error) {
      prev.count += 1;
      prev.at = Math.max(prev.at, row.at);
    } else {
      collapsed.push(row);
    }
    if (collapsed.length >= limit) break;
  }
  return collapsed;
}

// ── Campaign automations (seeded once per category) ──────────────────────────

/** One-time migration marker: the heal that turns the website drips On runs exactly once. */
const AUTO_ENABLE_DRIPS_MARKER = "migration:auto_enable_website_drips:v1";
/** One-time migration marker: prepend the day-0 welcome email to existing website drips. */
const ADD_DAY0_EMAIL_MARKER = "migration:add_day0_email:v1";
/** One-time migration marker: add HELOC quote-detail confirmation SMS to existing installs. */
const ADD_HELOC_CONFIRM_SMS_MARKER = "migration:add_heloc_confirm_sms:v1";

const HELOC_INITIAL_SMS_PREFIX = "Hi {{first_name}}, Mykoal DeShazo with Adaxa Home (NMLS 1912347). You asked about a HELOC";
const HELOC_CONFIRM_SMS =
  "{{first_name}}, I just wanted to confirm the information I received is correct. The current mortgage balance we have is {{mortgage_balance}}, and the estimated home value we have is {{home_value}}. Is that correct? I also just sent an email with the quote based on that information, but I want to make sure we have the right details so you receive the correct quote.";

/**
 * Seed the 6 category campaigns (Purchase Path, Cash Out Refi, HELOC, Rate and Term Refi,
 * DSCR Investor, General Nurture) the first time the service runs. Each is keyed to its
 * category via the filter and fires on `lead_created`, so a website lead is enrolled the
 * moment it arrives. The DNC list + TCPA quiet hours are still enforced at send time
 * (see `send_text` in executeStep), so this never texts an opted-out number.
 *
 * Idempotent: a campaign whose name already exists is left untouched (so re-deploys don't
 * duplicate or overwrite edited copy). To repair installs seeded by an earlier version that
 * defaulted these to disabled, a ONE-TIME heal (guarded by AUTO_ENABLE_DRIPS_MARKER) flips
 * the existing canonical drips On. After that, manual On/Off toggles in the Flows tab win —
 * the heal never runs again, so it won't fight a deliberately disabled flow.
 */
export function seedCampaigns(): void {
  const existing = new Set(listAutomations().map((a) => a.name));
  for (const c of CAMPAIGNS) {
    if (existing.has(c.name)) continue;
    createAutomation({
      name: c.name,
      trigger: "lead_created",
      enabled: true, // website drips are live by default; consent + quiet hours still gate every send
      filter: { category: c.key },
      steps: campaignToSteps(c, true), // include the day-0 welcome email so a new lead is emailed immediately
    });
    log.info("seeded campaign (enabled)", { name: c.name, category: c.key });
  }
  // Past-client remarketing: fires on the `past_client` trigger (not category-keyed) and
  // keeps its own day-0 email (no funnel welcome for past clients). Seeded disabled — it
  // targets prior clients, not website intake, so the team enables it deliberately.
  if (!existing.has(REMARKETING.name)) {
    createAutomation({
      name: REMARKETING.name,
      trigger: "past_client",
      enabled: false,
      filter: {},
      steps: campaignToSteps(REMARKETING, true),
    });
    log.info("seeded campaign (disabled)", { name: REMARKETING.name, trigger: "past_client" });
  }

  // One-time heal: enable any canonical website drip that a prior deploy seeded disabled,
  // so existing installs start enrolling without a manual toggle. Runs exactly once.
  if (!getMeta(AUTO_ENABLE_DRIPS_MARKER)) {
    const canonical = new Set(CAMPAIGNS.map((c) => c.name));
    let healed = 0;
    for (const a of listAutomations()) {
      if (a.trigger === "lead_created" && canonical.has(a.name) && !a.enabled) {
        updateAutomation(a.id, { enabled: true });
        healed++;
        log.info("auto-enabled website drip (one-time heal)", { name: a.name });
      }
    }
    setMeta(AUTO_ENABLE_DRIPS_MARKER, String(Date.now()));
    if (healed > 0) log.info("auto-enable website drips: heal complete", { enabled: healed });
  }

  // One-time heal: older installs seeded their website drips WITHOUT a day-0 email (the
  // day-0 welcome was expected from the website itself). So a new lead got no immediate
  // email. Prepend the campaign's day-0 welcome email to any canonical drip missing it, so
  // every new lead is emailed right away. Runs once; respects flows that already have it.
  if (!getMeta(ADD_DAY0_EMAIL_MARKER)) {
    let added = 0;
    for (const c of CAMPAIGNS) {
      const e = c.emails.find((m) => m.day === 0);
      if (!e) continue;
      const a = listAutomations().find((x) => x.name === c.name);
      if (!a) continue;
      const hasDay0 = a.steps.some((s) => s.type === "send_email" && s.subject === e.subject);
      if (hasDay0) continue;
      const day0: Step = {
        type: "send_email",
        subject: e.subject,
        preheader: e.preheader,
        html: e.body,
        text: e.body,
        ctaLabel: e.cta.label,
        ctaUrl: e.cta.url,
        delayMinutes: 0,
      };
      updateAutomation(a.id, { steps: [day0, ...a.steps] });
      added++;
      log.info("added day-0 welcome email to website drip", { name: c.name });
    }
    setMeta(ADD_DAY0_EMAIL_MARKER, String(Date.now()));
    if (added > 0) log.info("day-0 email heal complete", { added });
  }

  // One-time heal: add the quote-detail confirmation text to the existing HELOC drip.
  // Existing flows are preserved rather than rebuilt because operators can edit copy in
  // the Flows tab. The next step's delay is reduced by 4 minutes so the rest of the
  // cadence stays on its original timing.
  if (!getMeta(ADD_HELOC_CONFIRM_SMS_MARKER)) {
    const a = listAutomations().find((x) => x.name === "HELOC");
    let added = false;
    if (a && !a.steps.some((s) => s.type === "send_text" && s.message === HELOC_CONFIRM_SMS)) {
      const steps = [...a.steps];
      const initialIdx = steps.findIndex((s) => s.type === "send_text" && (s.message ?? "").startsWith(HELOC_INITIAL_SMS_PREFIX));
      if (initialIdx >= 0) {
        steps.splice(initialIdx + 1, 0, { type: "send_text", message: HELOC_CONFIRM_SMS, delayMinutes: 4 });
        const next = steps[initialIdx + 2];
        if (next) next.delayMinutes = Math.max(0, (next.delayMinutes ?? 0) - 4);
        updateAutomation(a.id, { steps });
        added = true;
        log.info("added HELOC quote-detail confirmation SMS", { name: a.name });
      } else {
        log.warn("HELOC confirmation SMS heal skipped: initial HELOC SMS not found");
      }
    }
    setMeta(ADD_HELOC_CONFIRM_SMS_MARKER, String(Date.now()));
    if (added) log.info("HELOC confirmation SMS heal complete");
  }
}
