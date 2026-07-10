import { test } from "node:test";
import assert from "node:assert/strict";
import type { MortgageCallSummary } from "./callSummary";
import type { Lead } from "./leads";
import { buildCallFollowUpRecommendation } from "./callFollowUp";

const baseSummary: MortgageCallSummary = {
  lead_temperature: "Warm", call_direction: "Inbound", short_summary: "Borrower discussed a HELOC.", detailed_summary: "Connected call.",
  borrower_goal: "Home improvements", loan_type: "HELOC", property_address: null, property_state: "AZ", property_type: "Single Family",
  occupancy: "Primary Residence", estimated_value: null, current_mortgage_balance: null, desired_loan_amount: null, desired_cash_out: null,
  credit_score_mentioned: null, income_type: null, documents_requested: [], borrower_questions: [], objections_or_concerns: [], important_dates: [],
  next_steps: [], follow_up_needed: false, follow_up_date: null, compliance_flags: [], missing_information: [], crm_note: "Connected call",
};

const lead = {
  id: "lead-1", consent: 1, sms_consent: 0, email_unsubscribed: 0, email: "borrower@example.com", phone: "+16025550100",
} as Lead;

test("explicit opt-out blocks every follow-up channel", () => {
  const result = buildCallFollowUpRecommendation(
    { ...baseSummary, objections_or_concerns: ["Borrower said do not call again"] },
    { ...lead, sms_consent: 1 },
    { duration_seconds: 90 },
    1_700_000_000_000,
  );
  assert.equal(result.outcome, "do_not_contact");
  assert.equal(result.priority, "urgent_review");
  assert.deepEqual(result.permittedChannels, []);
  assert.equal(result.consumerContactedAutomatically, false);
});

test("document request recommends a human-reviewed task and consent-aware channels", () => {
  const result = buildCallFollowUpRecommendation(
    { ...baseSummary, documents_requested: ["Bank statements"], follow_up_needed: true },
    lead,
    { duration_seconds: 420 },
    1_700_000_000_000,
  );
  assert.equal(result.outcome, "documents_requested");
  assert.equal(result.taskTitle, "Review requested borrower documents");
  assert.deepEqual(result.permittedChannels, ["manual_phone_review", "email"]);
  assert.ok(result.blockedAutomations.includes("autonomous_email"));
});

test("compliance flags always take precedence over routine callback", () => {
  const result = buildCallFollowUpRecommendation(
    { ...baseSummary, follow_up_needed: true, compliance_flags: ["Possible licensing issue"] },
    lead,
    { duration_seconds: 300 },
  );
  assert.equal(result.outcome, "needs_review");
  assert.equal(result.priority, "urgent_review");
});
