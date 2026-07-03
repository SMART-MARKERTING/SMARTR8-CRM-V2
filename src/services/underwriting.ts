import { Lead } from "./leads";
import { LeadDocument } from "./documents";
import { MismoValidationReport } from "./mismoValidation";

export type UnderwritingDecision = "approve" | "approve_with_conditions" | "suspend" | "decline";

export interface UnderwritingCondition {
  severity: "condition" | "warning" | "blocker";
  category: "borrower" | "credit" | "property" | "income" | "assets" | "documents" | "mismo";
  title: string;
  detail: string;
}

export interface UnderwritingPreview {
  provider: "internal_aus_preview";
  decision: UnderwritingDecision;
  decisionLabel: string;
  score: number;
  ratios: {
    ltv: number | null;
    cltv: number | null;
    dti: number | null;
    creditScore: number | null;
    loanAmount: number | null;
    propertyValue: number | null;
    monthlyIncome: number | null;
  };
  summary: string;
  conditions: UnderwritingCondition[];
}

const REQUIRED_DOCS = [
  { type: "photo_id", title: "Photo ID", category: "documents" as const },
  { type: "borrower_authorization", title: "Borrower authorization", category: "documents" as const },
  { type: "loan_application", title: "Loan application / URLA summary", category: "documents" as const },
  { type: "income_assets", title: "Income / assets documentation", category: "income" as const },
  { type: "property_insurance", title: "Property insurance", category: "property" as const },
];

function cf(lead: Lead, keys: string[]): string {
  for (const key of keys) {
    const value = key === "first_name" ? lead.first_name
      : key === "last_name" ? lead.last_name
      : key === "email" ? lead.email
      : key === "phone" ? lead.phone
      : lead.custom?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function money(raw: string): number | null {
  const n = parseFloat(raw.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function percent(raw: string): number | null {
  const n = parseFloat(raw.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function int(raw: string): number | null {
  const match = raw.match(/\d{2,}/) || raw.match(/\d+/);
  const n = match ? parseInt(match[0], 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (!numerator || !denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function decisionLabel(decision: UnderwritingDecision): string {
  return ({
    approve: "Approve",
    approve_with_conditions: "Approve with conditions",
    suspend: "Suspended / needs review",
    decline: "Decline",
  } as Record<UnderwritingDecision, string>)[decision];
}

export function buildUnderwritingPreview(
  lead: Lead,
  documents: LeadDocument[] = [],
  mismo?: MismoValidationReport,
): UnderwritingPreview {
  const homeValue = money(cf(lead, ["home_value", "homeValue", "estimated_value", "property_value", "propertyValue"]));
  const loanAmount = money(cf(lead, ["loan_amount", "loanAmount", "heloc_line", "helocLine", "heloc_line_available"]));
  const mortgageBalance = money(cf(lead, ["mortgage_balance", "mortgageBalance", "current_balance"]));
  const monthlyPayment = money(cf(lead, ["monthly_payment", "monthlyPayment", "housing_payment", "debt_payment"]));
  const monthlyIncome = money(cf(lead, ["monthly_income", "monthlyIncome", "gross_monthly_income", "income"]));
  const creditScore = int(cf(lead, ["credit_score", "creditScore", "fico", "FICO", "credit"]));
  const ltv = ratio(loanAmount, homeValue);
  const cltv = ratio((mortgageBalance || 0) + (loanAmount || 0), homeValue);
  const dti = ratio(monthlyPayment, monthlyIncome);
  const conditions: UnderwritingCondition[] = [];
  const docTypes = new Set(documents.map((doc) => doc.doc_type));

  for (const doc of REQUIRED_DOCS) {
    if (!docTypes.has(doc.type)) {
      conditions.push({
        severity: doc.type === "borrower_authorization" ? "blocker" : "condition",
        category: doc.category,
        title: `${doc.title} missing`,
        detail: `${doc.title} should be uploaded before live underwriting or vendor ordering.`,
      });
    }
  }

  if (!cf(lead, ["address", "street", "street_address", "property_address"])) {
    conditions.push({ severity: "condition", category: "property", title: "Property address missing", detail: "Add the subject property street address." });
  }
  if (!cf(lead, ["state", "property_state", "lead_pool_state"])) {
    conditions.push({ severity: "condition", category: "property", title: "Property state missing", detail: "Add the subject property state for compliance and pricing context." });
  }
  if (!homeValue) {
    conditions.push({ severity: "condition", category: "property", title: "Property value missing", detail: "Add estimated value or appraised value." });
  }
  if (!loanAmount) {
    conditions.push({ severity: "condition", category: "borrower", title: "Loan request missing", detail: "Add requested loan amount or HELOC line." });
  }
  if (!monthlyIncome) {
    conditions.push({ severity: "condition", category: "income", title: "Monthly income missing", detail: "Add verified gross monthly income behind Portal / Apps." });
  }
  if (!creditScore) {
    conditions.push({ severity: "condition", category: "credit", title: "Credit score missing", detail: "Add the borrower credit score or pull credit once authorized." });
  } else if (creditScore < 580) {
    conditions.push({ severity: "blocker", category: "credit", title: "Credit score below minimum", detail: `Credit score ${creditScore} needs manual review.` });
  } else if (creditScore < 620) {
    conditions.push({ severity: "condition", category: "credit", title: "Credit score condition", detail: `Credit score ${creditScore} may need compensating factors.` });
  }
  if (cltv !== null && cltv > 100) {
    conditions.push({ severity: "blocker", category: "property", title: "CLTV exceeds property value", detail: `Estimated CLTV is ${cltv}%.` });
  } else if (cltv !== null && cltv > 90) {
    conditions.push({ severity: "condition", category: "property", title: "High CLTV", detail: `Estimated CLTV is ${cltv}%.` });
  }
  if (dti !== null && dti > 50) {
    conditions.push({ severity: "condition", category: "income", title: "High DTI", detail: `Estimated DTI is ${dti}%.` });
  }
  if (mismo && !mismo.ok) {
    const first = mismo.issues.find((issue) => issue.severity === "error") || mismo.issues[0];
    conditions.push({
      severity: "condition",
      category: "mismo",
      title: "MISMO export has issues",
      detail: first ? first.message : "Review MISMO validation warnings before export.",
    });
  }

  const blockers = conditions.filter((c) => c.severity === "blocker").length;
  const openConditions = conditions.filter((c) => c.severity === "condition").length;
  let decision: UnderwritingDecision = "approve";
  if (blockers > 0) decision = "decline";
  else if (!docTypes.has("borrower_authorization") || openConditions >= 4) decision = "suspend";
  else if (openConditions > 0) decision = "approve_with_conditions";

  const score = Math.max(0, Math.min(100, 100 - blockers * 30 - openConditions * 8 - conditions.filter((c) => c.severity === "warning").length * 4));
  return {
    provider: "internal_aus_preview",
    decision,
    decisionLabel: decisionLabel(decision),
    score,
    ratios: { ltv, cltv, dti, creditScore, loanAmount, propertyValue: homeValue, monthlyIncome },
    summary: `${decisionLabel(decision)}. ${conditions.length ? `${conditions.length} item(s) need review.` : "Ready for the next underwriting step."}`,
    conditions,
  };
}
