import { Lead } from "./leads";
import { getMismoReadiness } from "./mismoReadiness";

export type MismoIssueSeverity = "error" | "warning" | "info";

export interface MismoValidationIssue {
  severity: MismoIssueSeverity;
  field: string;
  message: string;
}

export interface MismoValidationReport {
  ok: boolean;
  status: "ready" | "warnings" | "issues";
  score: number;
  mapVersion: string;
  issues: MismoValidationIssue[];
}

function tagPresent(xml: string, tag: string): boolean {
  return new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "i").test(xml);
}

function anyTagPresent(xml: string, tags: string[]): boolean {
  return tags.some((tag) => tagPresent(xml, tag));
}

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

function hasFullSsn(value: string): boolean {
  return value.replace(/\D/g, "").length === 9;
}

export function validateMismoExport(
  lead: Lead,
  xml: string,
  opts: { includeSensitive?: boolean } = {},
): MismoValidationReport {
  const readiness = getMismoReadiness(lead);
  const issues: MismoValidationIssue[] = [];

  for (const missing of readiness.missingRequired || []) {
    issues.push({ severity: "error", field: missing, message: `${missing} is required before the LOS/MISMO handoff.` });
  }

  if (!xml.trim().startsWith("<?xml")) {
    issues.push({ severity: "error", field: "xml", message: "MISMO export is missing an XML declaration." });
  }
  if (!/<MESSAGE\b/i.test(xml) || !/MISMOReferenceModelIdentifier="3\.4\.0"/i.test(xml)) {
    issues.push({ severity: "error", field: "MESSAGE", message: "MISMO 3.4 MESSAGE root was not generated." });
  }
  for (const tag of ["DEAL_SETS", "DEAL", "PARTIES", "PARTY", "ROLES", "ROLE", "BORROWER", "LOANS", "LOAN", "TERMS_OF_LOAN"]) {
    if (!tagPresent(xml, tag)) {
      issues.push({ severity: "error", field: tag, message: `MISMO export is missing ${tag}.` });
    }
  }
  if (!tagPresent(xml, "FirstName") || !tagPresent(xml, "LastName")) {
    issues.push({ severity: "error", field: "borrower.name", message: "Borrower first and last name did not map into MISMO." });
  }
  if (!anyTagPresent(xml, ["BaseLoanAmount", "HELOCLineAmount"]) && !cf(lead, ["loan_amount", "loanAmount", "heloc_line", "helocLine"])) {
    issues.push({ severity: "warning", field: "loan.amount", message: "No requested loan amount was found for the export." });
  }

  if (opts.includeSensitive) {
    const borrowerDob = cf(lead, ["dob", "borrower_dob", "date_of_birth", "dateOfBirth", "DOB"]);
    const borrowerSsn = cf(lead, ["ssn", "ssn_full", "borrower_ssn", "social_security_number", "taxpayer_identifier"]);
    const employer = cf(lead, ["employer", "employer_name", "employment_employer", "current_employer", "income_source"]);
    const income = cf(lead, ["monthly_income", "monthlyIncome", "gross_monthly_income", "income"]);
    if (borrowerDob && !tagPresent(xml, "BorrowerBirthDate")) {
      issues.push({ severity: "error", field: "borrower.dob", message: "Borrower DOB exists but did not map into MISMO." });
    } else if (!borrowerDob) {
      issues.push({ severity: "warning", field: "borrower.dob", message: "Borrower DOB is not on the verified application file." });
    }
    if (borrowerSsn && !tagPresent(xml, "TaxpayerIdentifierValue")) {
      issues.push({ severity: "error", field: "borrower.ssn", message: "Borrower SSN exists but did not map into MISMO." });
    } else if (!hasFullSsn(borrowerSsn)) {
      issues.push({ severity: "warning", field: "borrower.ssn", message: "Full 9-digit borrower SSN is not on the verified application file." });
    }
    if (employer && !tagPresent(xml, "EMPLOYERS")) {
      issues.push({ severity: "error", field: "borrower.employer", message: "Employer exists but did not map into MISMO." });
    } else if (!employer) {
      issues.push({ severity: "warning", field: "borrower.employer", message: "Employer / income source is not on the verified application file." });
    }
    if (income && !tagPresent(xml, "CURRENT_INCOME")) {
      issues.push({ severity: "error", field: "borrower.income", message: "Monthly income exists but did not map into MISMO." });
    }

    const coFirst = cf(lead, ["co_borrower_first_name", "coborrower_first_name", "coBorrowerFirstName"]);
    const coLast = cf(lead, ["co_borrower_last_name", "coborrower_last_name", "coBorrowerLastName"]);
    if ((coFirst || coLast) && !/PartyRoleType>CoBorrower</i.test(xml)) {
      issues.push({ severity: "error", field: "coborrower", message: "Co-borrower exists but did not map as a CoBorrower party." });
    }
  }

  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const scorePenalty = errors * 18 + warnings * 7;
  const score = Math.max(0, Math.min(100, Math.round((readiness.score || 0) - scorePenalty)));
  return {
    ok: errors === 0,
    status: errors ? "issues" : warnings ? "warnings" : "ready",
    score,
    mapVersion: readiness.mapVersion,
    issues,
  };
}
