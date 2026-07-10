import assert from "node:assert/strict";
import test from "node:test";
import { hasAffirmativeSmsConsent } from "./compliance";

test("SMS consent requires both an affirmative flag and audit timestamp", () => {
  assert.equal(hasAffirmativeSmsConsent({ sms_consent: 1, consent_at: Date.now() }), true);
  assert.equal(hasAffirmativeSmsConsent({ sms_consent: true, consent_at: Date.now() }), true);
  assert.equal(hasAffirmativeSmsConsent({ sms_consent: 1, consent_at: null }), false);
  assert.equal(hasAffirmativeSmsConsent({ sms_consent: 0, consent_at: Date.now() }), false);
  assert.equal(hasAffirmativeSmsConsent({ sms_consent: null, consent_at: null }), false);
});

test("zero and invalid consent timestamps are rejected", () => {
  assert.equal(hasAffirmativeSmsConsent({ sms_consent: 1, consent_at: 0 }), false);
  assert.equal(hasAffirmativeSmsConsent({ sms_consent: 1, consent_at: -1 }), false);
});
