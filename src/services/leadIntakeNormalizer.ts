type UnknownRecord = Record<string, unknown>;

interface MetaField {
  name?: unknown;
  values?: unknown;
  value?: unknown;
}

const FIELD_ALIASES: Record<string, string> = {
  fullname: "name",
  full_name: "name",
  first_name: "first_name",
  firstname: "first_name",
  last_name: "last_name",
  lastname: "last_name",
  email: "email",
  email_address: "email",
  phone: "phone",
  phone_number: "phone",
  phonenumber: "phone",
  mobile_phone: "phone",
  loan_type: "loanType",
  loantype: "loanType",
  product: "loanType",
  product_interest: "loanType",
  timeline: "timeline",
  purchase_timeline: "timeline",
  sms_opt_in: "smsOptIn",
  sms_consent: "smsOptIn",
  text_opt_in: "smsOptIn",
  home_value: "home_value",
  estimated_home_value: "home_value",
  mortgage_balance: "mortgage_balance",
  current_mortgage_balance: "mortgage_balance",
  credit_score: "credit",
  credit_range: "credit",
  property_state: "state",
  state: "state",
  city: "city",
  zip: "zip",
  zip_code: "zip",
  postal_code: "zip",
  street_address: "address",
  address: "address",
};

const META_ATTRIBUTION_ALIASES: Record<string, string[]> = {
  meta_lead_id: ["leadgen_id", "lead_id", "id"],
  meta_form_id: ["form_id"],
  meta_page_id: ["page_id"],
  meta_ad_id: ["ad_id"],
  meta_adset_id: ["adset_id"],
  meta_campaign_id: ["campaign_id"],
  meta_created_time: ["created_time"],
};

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function cleanKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function firstValue(field: MetaField): unknown {
  if (Array.isArray(field.values)) return field.values.find((value) => value !== undefined && value !== null && String(value).trim() !== "");
  return field.value;
}

function findMetaFields(body: UnknownRecord): MetaField[] {
  const candidates = [body.field_data, record(body.data).field_data, record(body.lead).field_data, record(body.value).field_data];
  return (candidates.find(Array.isArray) as MetaField[] | undefined) ?? [];
}

function firstPresent(sources: UnknownRecord[], keys: string[]): unknown {
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined && value !== null && String(value).trim() !== "") return value;
    }
  }
  return undefined;
}

function looksLikeMetaLead(body: UnknownRecord, fields: MetaField[], sources: UnknownRecord[]): boolean {
  if (fields.length) return true;
  return Boolean(firstPresent(sources, ["leadgen_id", "form_id", "ad_id", "adset_id", "campaign_id"])) ||
    /facebook|meta|instagram/i.test(String(body.source ?? body.platform ?? ""));
}

/**
 * Converts website forms and hydrated Meta Lead Ads payloads into the flexible
 * canonical body consumed by POST /webhooks/lead. It deliberately does not infer
 * SMS consent from a Facebook form submission; only an explicit opt-in field is
 * mapped to smsOptIn.
 */
export function normalizeLeadIntakePayload(raw: UnknownRecord): UnknownRecord {
  const body = { ...raw };
  const data = record(raw.data);
  const lead = record(raw.lead);
  const value = record(raw.value);
  const sources = [raw, data, lead, value];
  const fields = findMetaFields(raw);

  for (const field of fields) {
    const originalName = cleanKey(field.name);
    if (!originalName) continue;
    const canonical = FIELD_ALIASES[originalName] ?? originalName;
    const fieldValue = firstValue(field);
    if (fieldValue === undefined || fieldValue === null || String(fieldValue).trim() === "") continue;
    if (body[canonical] === undefined || body[canonical] === null || String(body[canonical]).trim() === "") {
      body[canonical] = fieldValue;
    }
  }

  const meta = looksLikeMetaLead(raw, fields, sources);
  if (meta && !body.source) body.source = /instagram/i.test(String(raw.platform ?? value.platform ?? "")) ? "instagram-lead-ad" : "facebook-lead-ad";

  if (meta) {
    for (const [canonical, aliases] of Object.entries(META_ATTRIBUTION_ALIASES)) {
      if (body[canonical] !== undefined) continue;
      const found = firstPresent(sources, aliases);
      if (found !== undefined) body[canonical] = found;
    }
    // The canonical fields and attribution above are sufficient for CRM use.
    // Avoid retaining a second nested copy of the complete ad form submission.
    delete body.field_data;
    delete body.data;
    delete body.lead;
    delete body.value;
  }

  // Standard campaign query parameters are intentionally retained as custom
  // fields by the CRM so reporting can connect a lead back to its ad or funnel.
  for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "fbc", "fbp"]) {
    if (body[key] !== undefined) continue;
    const found = firstPresent(sources, [key]);
    if (found !== undefined) body[key] = found;
  }

  return body;
}
