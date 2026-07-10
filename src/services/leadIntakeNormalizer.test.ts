import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLeadIntakePayload } from "./leadIntakeNormalizer";

test("normalizes hydrated Facebook Lead Ads fields and attribution", () => {
  const result = normalizeLeadIntakePayload({
    leadgen_id: "lead-123",
    form_id: "form-456",
    ad_id: "ad-789",
    campaign_id: "campaign-10",
    field_data: [
      { name: "full_name", values: ["Jane Borrower"] },
      { name: "email", values: ["jane@example.com"] },
      { name: "phone_number", values: ["(602) 555-0101"] },
      { name: "loan_type", values: ["HELOC"] },
      { name: "estimated_home_value", values: ["650000"] },
      { name: "sms_opt_in", values: ["yes"] },
    ],
  });
  assert.equal(result.name, "Jane Borrower");
  assert.equal(result.phone, "(602) 555-0101");
  assert.equal(result.loanType, "HELOC");
  assert.equal(result.home_value, "650000");
  assert.equal(result.smsOptIn, "yes");
  assert.equal(result.source, "facebook-lead-ad");
  assert.equal(result.meta_lead_id, "lead-123");
  assert.equal(result.meta_campaign_id, "campaign-10");
});

test("does not invent SMS consent when a Meta payload has no explicit opt-in", () => {
  const result = normalizeLeadIntakePayload({
    platform: "facebook",
    field_data: [{ name: "phone_number", values: ["+16025550101"] }],
  });
  assert.equal(result.phone, "+16025550101");
  assert.equal(result.smsOptIn, undefined);
});

test("preserves website canonical values while collecting nested attribution", () => {
  const result = normalizeLeadIntakePayload({
    name: "Existing Name",
    phone: "+14805550101",
    source: "website",
    data: { utm_campaign: "summer-heloc", fbclid: "click-1" },
    field_data: [{ name: "full_name", values: ["Should Not Replace"] }],
  });
  assert.equal(result.name, "Existing Name");
  assert.equal(result.source, "website");
  assert.equal(result.utm_campaign, "summer-heloc");
  assert.equal(result.fbclid, "click-1");
});

