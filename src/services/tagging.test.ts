import { test } from "node:test";
import assert from "node:assert/strict";
import { categorize } from "./tagging";

test("Purchase loanType → PURCHASE / Purchase Path", () => {
  const r = categorize({ loanType: "Purchase" });
  assert.equal(r.category, "PURCHASE");
  assert.equal(r.campaign, "Purchase Path");
});

test("VA Loan loanType → PURCHASE", () => {
  assert.equal(categorize({ loanType: "VA Loan" }).category, "PURCHASE");
});

test("purchase keyword in a General Inquiry → PURCHASE", () => {
  assert.equal(categorize({ loanType: "General Inquiry", message: "looking to buy a new home" }).category, "PURCHASE");
  assert.equal(categorize({ message: "need a pre approval" }).category, "PURCHASE");
});

test("Refinance + cash-out intent → CASHOUT_REFI", () => {
  const r = categorize({ loanType: "Refinance", message: "want to pull equity for a renovation" });
  assert.equal(r.category, "CASHOUT_REFI");
  assert.equal(r.campaign, "Cash Out Refi");
});

test("cash-out keyword without loanType → CASHOUT_REFI", () => {
  assert.equal(categorize({ message: "interested in debt consolidation" }).category, "CASHOUT_REFI");
});

test("HELOC loanType → HELOC", () => {
  assert.equal(categorize({ loanType: "HELOC" }).category, "HELOC");
});

test("line of credit keyword → HELOC", () => {
  assert.equal(categorize({ message: "do you offer a line of credit" }).category, "HELOC");
});

test("Refinance WITHOUT cash intent → RATE_TERM_REFI", () => {
  const r = categorize({ loanType: "Refinance", message: "just want a lower payment" });
  assert.equal(r.category, "RATE_TERM_REFI");
  assert.equal(r.campaign, "Rate and Term Refi");
});

test("plain refinance keyword → RATE_TERM_REFI", () => {
  assert.equal(categorize({ message: "thinking about a refinance" }).category, "RATE_TERM_REFI");
});

test("Investor/DSCR → DSCR / DSCR Investor", () => {
  const r = categorize({ loanType: "Investor/DSCR" });
  assert.equal(r.category, "DSCR");
  assert.equal(r.campaign, "DSCR Investor");
});

test("General Inquiry with no keywords → GENERAL", () => {
  assert.equal(categorize({ loanType: "General Inquiry", message: "just have a question" }).category, "GENERAL");
});

test("unmatched empty input → GENERAL", () => {
  assert.equal(categorize({}).category, "GENERAL");
});

// smartr8.com funnels post uppercase loanType codes; each must route to its campaign.
test("funnel code PURCHASE → PURCHASE", () => {
  assert.equal(categorize({ loanType: "PURCHASE" }).category, "PURCHASE");
});
test("funnel code CASHOUT_REFI → CASHOUT_REFI", () => {
  assert.equal(categorize({ loanType: "CASHOUT_REFI" }).category, "CASHOUT_REFI");
});
test("funnel code RT_REFI → RATE_TERM_REFI", () => {
  assert.equal(categorize({ loanType: "RT_REFI" }).category, "RATE_TERM_REFI");
});
test("funnel code DSCR → DSCR / DSCR Investor", () => {
  const r = categorize({ loanType: "DSCR" });
  assert.equal(r.category, "DSCR");
  assert.equal(r.campaign, "DSCR Investor");
});
test("funnel code HELOC → HELOC", () => {
  assert.equal(categorize({ loanType: "HELOC" }).category, "HELOC");
});

test("DSCR keyword in message → DSCR", () => {
  assert.equal(categorize({ message: "financing a rental property" }).category, "DSCR");
});

// smartr8.com capture worker posts the product page as `funnel` with NO loanType.
// Each FunnelId must route to its campaign instead of falling to GENERAL.
test("funnel purchase → PURCHASE", () => {
  const r = categorize({ funnel: "purchase" });
  assert.equal(r.category, "PURCHASE");
  assert.equal(r.campaign, "Purchase Path");
});
test("funnel cash-out / cashout → CASHOUT_REFI", () => {
  assert.equal(categorize({ funnel: "cash-out" }).category, "CASHOUT_REFI");
  assert.equal(categorize({ funnel: "cashout" }).category, "CASHOUT_REFI");
});
test("funnel rate-reduction → RATE_TERM_REFI", () => {
  assert.equal(categorize({ funnel: "rate-reduction" }).category, "RATE_TERM_REFI");
});
test("every heloc-prefixed funnel → HELOC", () => {
  for (const f of ["heloc", "heloc-v2", "heloc-quick", "heloc-quick-v2"]) {
    assert.equal(categorize({ funnel: f }).category, "HELOC", `funnel ${f}`);
  }
});
test("funnel worksheet / other → GENERAL (no product signal)", () => {
  assert.equal(categorize({ funnel: "worksheet" }).category, "GENERAL");
  assert.equal(categorize({ funnel: "other" }).category, "GENERAL");
});
test("explicit loanType still wins over funnel", () => {
  // A human-selected loanType is the stronger signal if both are somehow present.
  assert.equal(categorize({ loanType: "Purchase", funnel: "heloc" }).category, "PURCHASE");
});

test("PRECEDENCE: purchase keyword beats a refinance keyword", () => {
  assert.equal(categorize({ message: "buying a home, might refinance later" }).category, "PURCHASE");
});

test("PRECEDENCE: cash-out beats plain refinance keyword", () => {
  assert.equal(categorize({ loanType: "Refinance", message: "refinance to pull equity" }).category, "CASHOUT_REFI");
});

test("PRECEDENCE: HELOC beats generic refinance keyword", () => {
  assert.equal(categorize({ message: "want a heloc, not a full refinance" }).category, "HELOC");
});
