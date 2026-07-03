import { randomUUID } from "crypto";
import { config } from "../config";
import { Lead, getLead, logActivity, updateLead } from "./leads";
import { LosReadiness, getLosReadiness, hasBorrowerAuthorization, seedLosDocumentTodos } from "./losReadiness";
import {
  SettlementVendorKind,
  SettlementVendorSettings,
  getSettlementVendorSettings,
  liveReady,
  serviceConfigured,
} from "./loanServiceSettings";

export type LoanServiceAction = "application" | "credit" | "title" | "flood";

export interface LoanServiceResult {
  ok: boolean;
  configured: boolean;
  action: LoanServiceAction;
  status: "started" | "submitted" | "blocked" | "failed" | "not_configured";
  message: string;
  checklistAdded?: number;
  documentReadiness?: LosReadiness;
  vendorSubmission?: {
    requestId: string;
    vendorName: string;
    providerId?: string;
    providerStatus?: string;
    responsePreview?: string;
  };
}

export interface LoanServiceRequestOptions {
  product?: string;
  transactionType?: string;
  priority?: string;
  notes?: string;
  requestedFrom?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function hasBorrowerBasics(lead: Lead): boolean {
  return Boolean((lead.first_name || lead.last_name) && lead.phone);
}

function hasPropertyBasics(lead: Lead): boolean {
  const custom = lead.custom || {};
  return Boolean(
    (custom.address || custom.street || custom.street_address || custom.streetAddress || custom.address1) &&
      (custom.state || custom.property_state || custom.State || custom.region || custom.Region),
  );
}

function cleanOption(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  return clean ? clean.slice(0, 220) : undefined;
}

function leadDisplayName(lead: Lead): string {
  return [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.email || lead.phone || lead.id;
}

function firstCustomString(lead: Lead, keys: string[]): string | undefined {
  const custom = lead.custom || {};
  for (const key of keys) {
    const value = custom[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function cleanOptions(opts?: LoanServiceRequestOptions): Record<string, string> {
  return {
    ...(cleanOption(opts?.product) ? { product: cleanOption(opts?.product)! } : {}),
    ...(cleanOption(opts?.transactionType) ? { transactionType: cleanOption(opts?.transactionType)! } : {}),
    ...(cleanOption(opts?.priority) ? { priority: cleanOption(opts?.priority)! } : {}),
    ...(cleanOption(opts?.notes) ? { notes: cleanOption(opts?.notes)! } : {}),
    ...(cleanOption(opts?.requestedFrom) ? { requestedFrom: cleanOption(opts?.requestedFrom)! } : {}),
  };
}

function persistOrderFlag(lead: Lead, key: string, extra?: Record<string, unknown>): void {
  const custom = {
    ...(lead.custom || {}),
    [key]: nowIso(),
    ...(extra || {}),
  };
  updateLead(lead.id, { custom });
}

function trimResponsePreview(value: unknown): string | undefined {
  if (value == null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 900 ? `${text.slice(0, 897)}...` : text;
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const item = (value as Record<string, unknown>)[key];
  return item && typeof item === "object" ? (item as Record<string, unknown>) : null;
}

function providerValue(body: unknown, keys: string[]): string | undefined {
  const roots = [
    body && typeof body === "object" ? (body as Record<string, unknown>) : null,
    nestedRecord(body, "data"),
    nestedRecord(body, "order"),
    nestedRecord(body, "result"),
  ].filter(Boolean) as Record<string, unknown>[];
  for (const root of roots) {
    for (const key of keys) {
      const value = root[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
  }
  return undefined;
}

function vendorHeaders(settings: SettlementVendorSettings, requestId: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Smartr8-Request-Id": requestId,
  };
  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
    headers["X-API-Key"] = settings.apiKey;
  } else if (settings.username && settings.password) {
    headers.Authorization = `Basic ${Buffer.from(`${settings.username}:${settings.password}`).toString("base64")}`;
  }
  if (settings.accountId) headers["X-Account-Id"] = settings.accountId;
  return headers;
}

function settlementPayload(
  kind: SettlementVendorKind,
  lead: Lead,
  settings: SettlementVendorSettings,
  options: Record<string, string>,
  author?: string,
  requestId = randomUUID(),
): Record<string, unknown> {
  const product = options.product || settings.defaultProduct || (kind === "title" ? "title_commitment" : "flood_determination");
  return {
    requestId,
    service: kind,
    product,
    transactionType: options.transactionType || firstCustomString(lead, ["loan_purpose", "loanType", "loan_type", "purpose"]),
    priority: options.priority || "standard",
    notes: options.notes || settings.notes || undefined,
    requestedFrom: options.requestedFrom || "crm",
    requestedBy: author || undefined,
    requestedAt: nowIso(),
    accountId: settings.accountId || undefined,
    borrower: {
      id: lead.id,
      firstName: lead.first_name || undefined,
      lastName: lead.last_name || undefined,
      name: leadDisplayName(lead),
      email: lead.email || undefined,
      phone: lead.phone || undefined,
    },
    property: {
      address: firstCustomString(lead, ["address", "street", "street_address", "streetAddress", "address1"]),
      city: firstCustomString(lead, ["city", "property_city", "City"]),
      state: firstCustomString(lead, ["state", "property_state", "State", "region", "Region"]),
      zip: firstCustomString(lead, ["zip", "zipcode", "postal_code", "property_zip", "Postal Code"]),
      value: firstCustomString(lead, ["property_value", "home_value", "homeValue", "estimated_value"]),
    },
    loan: {
      purpose: firstCustomString(lead, ["loan_purpose", "loan_goal", "loanGoal", "purpose", "loanType", "loan_type"]),
      program: firstCustomString(lead, ["loan_program", "program", "mortgageType"]),
      amount: firstCustomString(lead, ["loan_amount", "loanAmount", "Loan Amount", "heloc_line", "helocLine"]),
      balance: firstCustomString(lead, ["balance", "mortgage_balance", "current_balance"]),
    },
  };
}

async function submitSettlementOrder(
  kind: SettlementVendorKind,
  lead: Lead,
  settings: SettlementVendorSettings,
  options: Record<string, string>,
  author?: string,
) {
  const requestId = randomUUID();
  let endpoint: URL;
  try {
    endpoint = new URL(settings.apiBase);
  } catch {
    throw new Error(`${settings.vendorName} API URL is invalid`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const payload = settlementPayload(kind, lead, settings, options, author, requestId);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: vendorHeaders(settings, requestId),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = text;
    }
    if (!response.ok) {
      const preview = trimResponsePreview(body) || response.statusText;
      throw new Error(`${settings.vendorName} rejected ${kind} order (${response.status}): ${preview}`);
    }
    return {
      requestId,
      vendorName: settings.vendorName,
      providerId: providerValue(body, ["id", "orderId", "order_id", "providerId", "reference", "referenceId", "requestId"]),
      providerStatus: providerValue(body, ["status", "state", "orderStatus"]) || "submitted",
      responsePreview: trimResponsePreview(body),
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`${settings.vendorName} ${kind} order timed out after 20 seconds`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function notConfigured(action: LoanServiceAction, vendor: string): LoanServiceResult {
  return {
    ok: false,
    configured: false,
    action,
    status: "not_configured",
    message: `${vendor} integration is not configured yet. Add vendor credentials and compliance controls before enabling live orders.`,
  };
}

export function startApplication(lead: Lead, author?: string, opts: { seedChecklist?: boolean } = {}): LoanServiceResult {
  persistOrderFlag(lead, "application_started_at", {
    application_status: String((lead.custom || {}).application_status || "app_taken"),
    application_status_at: nowIso(),
  });
  const seeded = opts.seedChecklist === false ? { added: 0, requiredCount: getLosReadiness(getLead(lead.id) || lead).requiredCount } : seedLosDocumentTodos(getLead(lead.id) || lead, author);
  const refreshed = getLead(lead.id) || lead;
  logActivity(lead.id, {
    type: "application",
    direction: "system",
    channel: "system",
    body: "Application started from CRM",
    status: "started",
    meta: { author: author ?? null, source: "crm", losChecklistAdded: seeded.added, seedChecklist: opts.seedChecklist !== false },
  });
  return {
    ok: true,
    configured: true,
    action: "application",
    status: "started",
    message: seeded.added
      ? `Application started. Added ${seeded.added} LOS document task${seeded.added === 1 ? "" : "s"}.`
      : "Application started. LOS document tasks are already in place.",
    checklistAdded: seeded.added,
    documentReadiness: getLosReadiness(refreshed),
  };
}

export function requestCreditPull(lead: Lead, author?: string): LoanServiceResult {
  if (!hasBorrowerBasics(lead)) {
    return {
      ok: false,
      configured: Boolean(config.loanServices.xactusApiBase && config.loanServices.xactusApiKey),
      action: "credit",
      status: "blocked",
      message: "Credit pull blocked: borrower name and phone are required first.",
      documentReadiness: getLosReadiness(lead),
    };
  }
  if (!hasBorrowerAuthorization(lead)) {
    const seeded = seedLosDocumentTodos(lead, author);
    return {
      ok: false,
      configured: Boolean(config.loanServices.xactusApiBase && config.loanServices.xactusApiKey),
      action: "credit",
      status: "blocked",
      message: "Credit request blocked: complete Borrower Authorization in the LOS checklist first.",
      checklistAdded: seeded.added,
      documentReadiness: getLosReadiness(getLead(lead.id) || lead),
    };
  }
  persistOrderFlag(lead, "credit_requested_at");
  logActivity(lead.id, {
    type: "credit_order",
    direction: "system",
    channel: "system",
    body: "Xactus credit pull requested",
    status: "blocked:not_configured",
    meta: { author: author ?? null, vendor: "xactus", permissiblePurposeRequired: true },
  });
  if (!config.loanServices.xactusApiBase || !config.loanServices.xactusApiKey) return notConfigured("credit", "Xactus credit");
  return notConfigured("credit", "Xactus credit");
}

async function requestSettlementOrder(
  kind: SettlementVendorKind,
  lead: Lead,
  author?: string,
  opts?: LoanServiceRequestOptions,
): Promise<LoanServiceResult> {
  const activeSettings = getSettlementVendorSettings(kind);
  const action: LoanServiceAction = kind;
  const activityType = kind === "title" ? "title_order" : "flood_order";
  const requestedKey = kind === "title" ? "title_order_requested_at" : "flood_report_requested_at";
  const statusKey = kind === "title" ? "title_order_status" : "flood_report_status";
  const optionsKey = kind === "title" ? "title_order_options" : "flood_report_options";
  const vendorKey = kind === "title" ? "title_order_vendor" : "flood_report_vendor";
  const providerIdKey = kind === "title" ? "title_order_provider_id" : "flood_report_provider_id";
  const providerStatusKey = kind === "title" ? "title_order_provider_status" : "flood_report_provider_status";
  const requestIdKey = kind === "title" ? "title_order_request_id" : "flood_report_request_id";
  const noun = kind === "title" ? "Title order" : "Flood report";
  const liveVerb = kind === "title" ? "title order" : "flood report";
  const configured = serviceConfigured(activeSettings);
  const live = liveReady(activeSettings);
  const options = cleanOptions(opts);

  if (!hasPropertyBasics(lead)) {
    const seeded = seedLosDocumentTodos(lead, author);
    persistOrderFlag(lead, requestedKey, {
      [statusKey]: "queued_pending_property",
      [optionsKey]: options,
    });
    logActivity(lead.id, {
      type: activityType,
      direction: "system",
      channel: "system",
      body: `${noun} queued; property details still need review`,
      status: "queued:needs_property",
      meta: { author: author ?? null, vendor: activeSettings.vendorName, configured, liveReady: live, options },
    });
    return {
      ok: true,
      configured,
      action,
      status: "started",
      message: `${noun} queued. Add/confirm property street address and state before live vendor submission.`,
      checklistAdded: seeded.added,
      documentReadiness: getLosReadiness(getLead(lead.id) || lead),
    };
  }

  if (!live) {
    persistOrderFlag(lead, requestedKey, {
      [statusKey]: configured ? "manual_vendor_handoff" : "queued_needs_vendor_credentials",
      [optionsKey]: options,
      [vendorKey]: activeSettings.vendorName,
    });
    logActivity(lead.id, {
      type: activityType,
      direction: "system",
      channel: "system",
      body: `${noun} requested`,
      status: configured ? "queued:manual_handoff" : "queued:needs_vendor_credentials",
      meta: { author: author ?? null, vendor: activeSettings.vendorName, configured, liveReady: live, options },
    });
    return {
      ok: true,
      configured,
      action,
      status: "started",
      message: configured
        ? `${noun} queued for ${activeSettings.vendorName}. Manual handoff is ready from saved settings.`
        : `${noun} queued. Add ${kind} vendor credentials in Settings > Integrations before live submission.`,
      documentReadiness: getLosReadiness(getLead(lead.id) || lead),
    };
  }

  try {
    const submission = await submitSettlementOrder(kind, lead, activeSettings, options, author);
    persistOrderFlag(lead, requestedKey, {
      [statusKey]: "submitted",
      [optionsKey]: options,
      [vendorKey]: activeSettings.vendorName,
      [providerIdKey]: submission.providerId,
      [providerStatusKey]: submission.providerStatus,
      [requestIdKey]: submission.requestId,
    });
    logActivity(lead.id, {
      type: activityType,
      direction: "system",
      channel: "system",
      body: `${noun} submitted to ${activeSettings.vendorName}`,
      status: "submitted",
      meta: { author: author ?? null, vendor: activeSettings.vendorName, options, submission },
    });
    return {
      ok: true,
      configured: true,
      action,
      status: "submitted",
      message: `${noun} submitted to ${activeSettings.vendorName}${submission.providerId ? ` (${submission.providerId})` : ""}.`,
      vendorSubmission: submission,
      documentReadiness: getLosReadiness(getLead(lead.id) || lead),
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    persistOrderFlag(lead, requestedKey, {
      [statusKey]: "vendor_submission_failed",
      [optionsKey]: options,
      [vendorKey]: activeSettings.vendorName,
      [`${kind}_order_error`]: error,
    });
    logActivity(lead.id, {
      type: activityType,
      direction: "system",
      channel: "system",
      body: `${noun} submission failed`,
      status: "failed",
      meta: { author: author ?? null, vendor: activeSettings.vendorName, options, error },
    });
    return {
      ok: false,
      configured: true,
      action,
      status: "failed",
      message: `Live ${liveVerb} submission failed: ${error}`,
      documentReadiness: getLosReadiness(getLead(lead.id) || lead),
    };
  }
}

export function requestTitleOrder(lead: Lead, author?: string, opts?: LoanServiceRequestOptions): Promise<LoanServiceResult> {
  return requestSettlementOrder("title", lead, author, opts);
}

export function requestFloodReport(lead: Lead, author?: string, opts?: LoanServiceRequestOptions): Promise<LoanServiceResult> {
  return requestSettlementOrder("flood", lead, author, opts);
}
