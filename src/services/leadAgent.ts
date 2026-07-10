import { randomUUID } from "crypto";
import { config } from "../config";
import { log } from "../logger";
import { db } from "../store/db";
import { addTodo, getLead, Lead, logActivity, updateLead } from "./leads";
import { listUsers, User } from "./auth";

export type LeadAgentMode = "recommend" | "apply_safe";
export type LeadAgentPriority = "low" | "normal" | "high";

export interface LeadAgentDuplicate {
  leadId: string;
  match: "phone" | "email";
  name: string;
  status: string;
  deleted: boolean;
}

export interface LeadAgentRecommendation {
  summary: string;
  priority: LeadAgentPriority;
  category: string;
  nextAction: string;
  reasons: string[];
  recommendedOwnerUserId: string | null;
  recommendedOwnerName: string | null;
  duplicateCount: number;
  humanReviewRequired: true;
  prohibitedActions: string[];
}

export interface LeadAgentRun {
  id: string;
  leadId: string;
  createdAt: number;
  updatedAt: number;
  trigger: string;
  mode: LeadAgentMode;
  status: "running" | "completed" | "error";
  provider: string | null;
  model: string | null;
  summary: string | null;
  duplicates: LeadAgentDuplicate[];
  recommendation: LeadAgentRecommendation | null;
  recommendedOwnerUserId: string | null;
  appliedActions: string[];
  errorMessage: string | null;
}

interface RunRow {
  id: string;
  lead_id: string;
  created_at: number;
  updated_at: number;
  trigger: string;
  mode: string;
  status: string;
  provider: string | null;
  model: string | null;
  summary: string | null;
  duplicate_json: string;
  recommendation_json: string;
  recommended_owner_user_id: string | null;
  applied_actions_json: string;
  error_message: string | null;
}

interface RoutingRule {
  state?: string;
  category?: string;
  source?: string;
  owner: string;
}

interface AiEnhancement {
  summary?: string;
  priority?: LeadAgentPriority;
  nextAction?: string;
  reasons?: string[];
}

const PROHIBITED_ACTIONS = [
  "send_message",
  "place_call",
  "quote_rate_or_payment",
  "approve_or_deny_credit",
  "change_lending_terms",
];

function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toRun(row: RunRow): LeadAgentRun {
  const recommendation = safeJson<LeadAgentRecommendation | null>(row.recommendation_json, null);
  return {
    id: row.id,
    leadId: row.lead_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    trigger: row.trigger,
    mode: row.mode === "apply_safe" ? "apply_safe" : "recommend",
    status: row.status === "error" ? "error" : row.status === "completed" ? "completed" : "running",
    provider: row.provider,
    model: row.model,
    summary: row.summary,
    duplicates: safeJson<LeadAgentDuplicate[]>(row.duplicate_json, []),
    recommendation,
    recommendedOwnerUserId: row.recommended_owner_user_id,
    appliedActions: safeJson<string[]>(row.applied_actions_json, []),
    errorMessage: row.error_message,
  };
}

function leadName(lead: Lead): string {
  return [lead.first_name, lead.last_name].filter(Boolean).join(" ").trim() || "Unnamed lead";
}

function stateForLead(lead: Lead): string {
  const custom = lead.custom || {};
  const raw = custom.property_state ?? custom.propertyState ?? custom.state ?? custom.address_state ?? custom.addressState;
  return typeof raw === "string" ? raw.trim().toUpperCase().slice(0, 2) : "";
}

function parseRoutingRules(): RoutingRule[] {
  const parsed = safeJson<unknown>(config.leadAgent.routingRulesJson, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    const owner = typeof row.owner === "string" ? row.owner.trim() : "";
    if (!owner) return [];
    return [{
      owner,
      state: typeof row.state === "string" ? row.state.trim().toUpperCase() : undefined,
      category: typeof row.category === "string" ? row.category.trim().toUpperCase() : undefined,
      source: typeof row.source === "string" ? row.source.trim().toLowerCase() : undefined,
    }];
  });
}

function resolveOwner(owner: string, users: User[]): User | null {
  const key = owner.trim().toLowerCase();
  return users.find((user) => !user.disabled && (
    user.id.toLowerCase() === key ||
    user.username.toLowerCase() === key ||
    (user.name || "").trim().toLowerCase() === key
  )) ?? null;
}

export function recommendOwner(lead: Lead, users = listUsers()): User | null {
  if (lead.owner_user_id) return users.find((user) => user.id === lead.owner_user_id && !user.disabled) ?? null;
  const state = stateForLead(lead);
  const category = (lead.category || "GENERAL").toUpperCase();
  const source = (lead.source || "").toLowerCase();
  for (const rule of parseRoutingRules()) {
    if (rule.state && rule.state !== state) continue;
    if (rule.category && rule.category !== category) continue;
    if (rule.source && rule.source !== source) continue;
    const owner = resolveOwner(rule.owner, users);
    if (owner) return owner;
  }
  return users.find((user) => !user.disabled && user.role === "admin") ?? users.find((user) => !user.disabled) ?? null;
}

export function findAgentDuplicates(lead: Lead): LeadAgentDuplicate[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = { id: lead.id };
  if (lead.phone) {
    clauses.push("phone = @phone");
    params.phone = lead.phone;
  }
  if (lead.email) {
    clauses.push("email = @email COLLATE NOCASE");
    params.email = lead.email;
  }
  if (!clauses.length) return [];
  const rows = db.prepare(
    `SELECT id, first_name, last_name, phone, email, status, deleted_at
       FROM leads WHERE id != @id AND (${clauses.join(" OR ")})
       ORDER BY created_at DESC LIMIT 20`,
  ).all(params) as Array<{
    id: string;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    email: string | null;
    status: string;
    deleted_at: number | null;
  }>;
  return rows.map((row) => ({
    leadId: row.id,
    match: lead.phone && row.phone === lead.phone ? "phone" : "email",
    name: [row.first_name, row.last_name].filter(Boolean).join(" ").trim() || "Unnamed lead",
    status: row.status,
    deleted: Boolean(row.deleted_at),
  }));
}

export function buildDeterministicRecommendation(
  lead: Lead,
  duplicates: LeadAgentDuplicate[],
  owner: User | null,
): LeadAgentRecommendation {
  const reasons: string[] = [];
  const category = (lead.category || "GENERAL").toUpperCase();
  const timeline = String(lead.custom?.timeline ?? "").toLowerCase();
  let priority: LeadAgentPriority = "normal";
  if (/asap|immediate|now|30 day|this month/.test(timeline) || lead.score >= 70) {
    priority = "high";
    reasons.push("Lead timing or existing score indicates near-term intent.");
  } else if (lead.score < 20 && !lead.phone && !lead.email) {
    priority = "low";
    reasons.push("The record has limited contact information.");
  }
  if (duplicates.length) reasons.push(`${duplicates.length} possible duplicate record(s) require review before outreach.`);
  if (!lead.owner_user_id && owner) reasons.push(`Routing rules recommend ${owner.name || owner.username}.`);
  if (lead.sms_consent !== 1) reasons.push("No recorded SMS consent; do not automate text outreach.");
  if (!reasons.length) reasons.push("Lead is ready for a normal human qualification review.");
  const nextAction = duplicates.length
    ? "Review and merge the matching records before contacting the lead."
    : "Review the inquiry, confirm product fit and consent, then choose the next compliant contact step.";
  const summary = `${leadName(lead)} is a ${priority}-priority ${category} lead from ${lead.source || "an unknown source"}. ${nextAction}`;
  return {
    summary,
    priority,
    category,
    nextAction,
    reasons,
    recommendedOwnerUserId: owner?.id ?? null,
    recommendedOwnerName: owner ? owner.name || owner.username : null,
    duplicateCount: duplicates.length,
    humanReviewRequired: true,
    prohibitedActions: [...PROHIBITED_ACTIONS],
  };
}

function aiInput(lead: Lead, base: LeadAgentRecommendation): Record<string, unknown> {
  // Intentionally excludes phone, email, full address, DOB, SSN, income, assets,
  // document contents, and free-form fields that may contain sensitive data.
  return {
    category: base.category,
    source: lead.source,
    state: stateForLead(lead) || null,
    timeline: typeof lead.custom?.timeline === "string" ? lead.custom.timeline.slice(0, 80) : null,
    consent: { email: lead.consent === 1, sms: lead.sms_consent === 1 },
    currentStatus: lead.status,
    pipelineStage: lead.pipeline_stage,
    score: lead.score,
    duplicateCount: base.duplicateCount,
    deterministicRecommendation: base,
  };
}

async function enhanceWithOpenAi(lead: Lead, base: LeadAgentRecommendation): Promise<AiEnhancement | null> {
  if (!config.leadAgent.apiKey || config.leadAgent.provider !== "openai") return null;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.leadAgent.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.leadAgent.model,
      instructions: [
        "You are a mortgage CRM lead-intelligence assistant.",
        "Return concise operational recommendations only.",
        "Never approve or deny credit, quote a rate/payment, infer protected traits, or recommend contacting without consent review.",
        "Do not override duplicate or compliance warnings. Human review is always required.",
      ].join(" "),
      input: JSON.stringify(aiInput(lead, base)),
      text: {
        format: {
          type: "json_schema",
          name: "lead_intelligence",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              summary: { type: "string" },
              priority: { type: "string", enum: ["low", "normal", "high"] },
              nextAction: { type: "string" },
              reasons: { type: "array", items: { type: "string" }, maxItems: 5 },
            },
            required: ["summary", "priority", "nextAction", "reasons"],
          },
        },
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`OpenAI Responses API returned ${response.status}`);
  const json = await response.json() as Record<string, unknown>;
  let output = typeof json.output_text === "string" ? json.output_text : "";
  if (!output && Array.isArray(json.output)) {
    for (const item of json.output as Array<Record<string, unknown>>) {
      if (!Array.isArray(item.content)) continue;
      for (const content of item.content as Array<Record<string, unknown>>) {
        if (typeof content.text === "string") output += content.text;
      }
    }
  }
  return safeJson<AiEnhancement | null>(output, null);
}

function mergeEnhancement(base: LeadAgentRecommendation, ai: AiEnhancement | null): LeadAgentRecommendation {
  if (!ai) return base;
  return {
    ...base,
    summary: typeof ai.summary === "string" && ai.summary.trim() ? ai.summary.trim().slice(0, 600) : base.summary,
    priority: ai.priority === "low" || ai.priority === "high" || ai.priority === "normal" ? ai.priority : base.priority,
    nextAction: typeof ai.nextAction === "string" && ai.nextAction.trim() ? ai.nextAction.trim().slice(0, 400) : base.nextAction,
    reasons: Array.isArray(ai.reasons)
      ? ai.reasons.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 5)
      : base.reasons,
    humanReviewRequired: true,
    prohibitedActions: [...PROHIBITED_ACTIONS],
  };
}

function safeMode(): LeadAgentMode {
  return config.leadAgent.mode === "apply_safe" && config.leadAgent.applySafeActions ? "apply_safe" : "recommend";
}

function applySafeActions(lead: Lead, recommendation: LeadAgentRecommendation): string[] {
  const actions: string[] = [];
  if (recommendation.recommendedOwnerUserId && !lead.owner_user_id) {
    updateLead(lead.id, { owner_user_id: recommendation.recommendedOwnerUserId });
    actions.push("assigned_owner");
  }
  if (config.leadAgent.createTasks) {
    const taskText = recommendation.duplicateCount
      ? "Review possible duplicate lead records"
      : "Review AI lead-intelligence recommendation";
    const fresh = getLead(lead.id);
    if (fresh && !fresh.todos.some((todo) => !todo.deleted_at && !todo.done && todo.text === taskText)) {
      addTodo(lead.id, { text: taskText, description: recommendation.nextAction });
      actions.push("created_review_task");
    }
  }
  return actions;
}

export async function runLeadAgent(leadId: string, trigger = "manual"): Promise<LeadAgentRun> {
  if (!config.leadAgent.enabled) throw new Error("lead agent is disabled");
  const lead = getLead(leadId);
  if (!lead || lead.deleted_at) throw new Error("lead not found");
  const now = Date.now();
  const id = randomUUID();
  const mode = safeMode();
  db.prepare(
    `INSERT INTO lead_agent_runs
      (id, lead_id, created_at, updated_at, trigger, mode, status, provider, model)
     VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
  ).run(id, lead.id, now, now, trigger.slice(0, 80), mode, config.leadAgent.provider || null, config.leadAgent.model || null);

  try {
    const duplicates = findAgentDuplicates(lead);
    const owner = recommendOwner(lead);
    const base = buildDeterministicRecommendation(lead, duplicates, owner);
    let ai: AiEnhancement | null = null;
    try {
      ai = await enhanceWithOpenAi(lead, base);
    } catch (error) {
      // AI enhancement is optional. A provider outage must not prevent a safe,
      // deterministic recommendation from being recorded.
      log.warn("lead agent AI enhancement failed; using deterministic result", { leadId, error: String(error) });
    }
    const recommendation = mergeEnhancement(base, ai);
    const appliedActions = mode === "apply_safe" ? applySafeActions(lead, recommendation) : [];
    const updatedAt = Date.now();
    db.prepare(
      `UPDATE lead_agent_runs SET updated_at = ?, status = 'completed', summary = ?, duplicate_json = ?,
        recommendation_json = ?, recommended_owner_user_id = ?, applied_actions_json = ? WHERE id = ?`,
    ).run(
      updatedAt,
      recommendation.summary,
      JSON.stringify(duplicates),
      JSON.stringify(recommendation),
      recommendation.recommendedOwnerUserId,
      JSON.stringify(appliedActions),
      id,
    );
    logActivity(lead.id, {
      type: "agent_analysis",
      direction: "system",
      channel: "ai",
      subject: "Lead intelligence recommendation",
      body: recommendation.summary,
      status: appliedActions.length ? "safe-actions-applied" : "review-required",
      meta: { runId: id, mode, priority: recommendation.priority, appliedActions },
    });
    return getLeadAgentRun(id)!;
  } catch (error) {
    const message = String(error).slice(0, 1000);
    db.prepare(`UPDATE lead_agent_runs SET updated_at = ?, status = 'error', error_message = ? WHERE id = ?`)
      .run(Date.now(), message, id);
    throw error;
  }
}

export function getLeadAgentRun(id: string): LeadAgentRun | null {
  const row = db.prepare(`SELECT * FROM lead_agent_runs WHERE id = ?`).get(id) as RunRow | undefined;
  return row ? toRun(row) : null;
}

export function listLeadAgentRuns(leadId: string, limit = 25): LeadAgentRun[] {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit) || 25));
  return (db.prepare(`SELECT * FROM lead_agent_runs WHERE lead_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(leadId, safeLimit) as RunRow[]).map(toRun);
}

export function leadAgentStatus() {
  return {
    enabled: config.leadAgent.enabled,
    mode: safeMode(),
    configuredMode: config.leadAgent.mode,
    applySafeActions: config.leadAgent.applySafeActions,
    createTasks: config.leadAgent.createTasks,
    provider: config.leadAgent.provider,
    model: config.leadAgent.model,
    aiConfigured: Boolean(config.leadAgent.apiKey),
    guarantees: {
      humanReviewRequired: true,
      contactsConsumers: false,
      makesCreditDecisions: false,
      quotesRatesOrPayments: false,
    },
  };
}

export function maybeRunLeadAgent(leadId: string, trigger: string): void {
  if (!config.leadAgent.enabled) return;
  void runLeadAgent(leadId, trigger).catch((error) => {
    log.error("lead agent background run failed", { leadId, trigger, error: String(error) });
  });
}
