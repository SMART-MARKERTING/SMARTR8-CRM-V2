import { existsSync, readFileSync } from "fs";
import path from "path";
import { Lead } from "./leads";

interface MismoMapField {
  canonical: string;
  label: string;
  required: boolean;
  aliases: string[];
  mismoPaths: string[];
}

interface MismoMap {
  version: string;
  fields: MismoMapField[];
}

export interface MismoFieldReadiness {
  canonical: string;
  label: string;
  required: boolean;
  present: boolean;
  valuePreview?: string;
  mismoPaths: string[];
}

const fallbackMap: MismoMap = {
  version: "fallback",
  fields: [
    { canonical: "borrower.first_name", label: "Borrower first name", required: true, aliases: ["first_name"], mismoPaths: [] },
    { canonical: "borrower.last_name", label: "Borrower last name", required: true, aliases: ["last_name"], mismoPaths: [] },
    { canonical: "borrower.phone", label: "Borrower phone", required: true, aliases: ["phone"], mismoPaths: [] },
    { canonical: "property.address", label: "Property street address", required: true, aliases: ["address", "street", "street_address", "streetAddress", "address1"], mismoPaths: [] },
    { canonical: "property.state", label: "Property state", required: true, aliases: ["state", "property_state", "State", "region", "Region"], mismoPaths: [] },
    { canonical: "loan.purpose", label: "Loan purpose", required: true, aliases: ["loan_purpose", "loan_goal", "loanGoal", "purpose", "loanType", "loan_type"], mismoPaths: [] },
    { canonical: "loan.amount", label: "Loan amount", required: true, aliases: ["loan_amount", "loanAmount", "Loan Amount", "heloc_line", "helocLine"], mismoPaths: [] },
  ],
};

let cachedMap: MismoMap | null = null;

export function loadMismoMap(): MismoMap {
  if (cachedMap) return cachedMap;
  const mapPath = path.resolve(process.cwd(), "mappings", "mismo34_canonical_map.json");
  if (!existsSync(mapPath)) {
    cachedMap = fallbackMap;
    return cachedMap;
  }
  try {
    const parsed = JSON.parse(readFileSync(mapPath, "utf8")) as MismoMap;
    cachedMap = parsed.fields?.length ? parsed : fallbackMap;
  } catch {
    cachedMap = fallbackMap;
  }
  return cachedMap;
}

function valueForAlias(lead: Lead, alias: string): unknown {
  if (alias === "first_name") return lead.first_name;
  if (alias === "last_name") return lead.last_name;
  if (alias === "email") return lead.email;
  if (alias === "phone") return lead.phone;
  if (alias === "pipeline_stage") return lead.pipeline_stage;
  return lead.custom?.[alias];
}

function presentValue(lead: Lead, aliases: string[]): string | undefined {
  for (const alias of aliases) {
    const value = valueForAlias(lead, alias);
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function preview(value: string): string {
  return value.length > 64 ? `${value.slice(0, 61)}...` : value;
}

export function getMismoReadiness(lead: Lead) {
  const map = loadMismoMap();
  const fields: MismoFieldReadiness[] = map.fields.map((field) => {
    const value = presentValue(lead, field.aliases);
    return {
      canonical: field.canonical,
      label: field.label,
      required: field.required,
      present: Boolean(value),
      valuePreview: value ? preview(value) : undefined,
      mismoPaths: field.mismoPaths,
    };
  });
  const required = fields.filter((field) => field.required);
  const missingRequired = required.filter((field) => !field.present);
  return {
    ok: missingRequired.length === 0,
    mapVersion: map.version,
    score: required.length ? Math.round(((required.length - missingRequired.length) / required.length) * 100) : 100,
    requiredCount: required.length,
    missingRequiredCount: missingRequired.length,
    missingRequired: missingRequired.map((field) => field.label),
    fields,
  };
}
