import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { config } from "../config";
import { db } from "../store/db";
import { createLead, Lead } from "./leads";
import { buildDeterministicRecommendation, recommendOwner, runLeadAgent } from "./leadAgent";
import { User } from "./auth";

function lead(overrides: Partial<Lead> = {}): Lead {
  const now = Date.now();
  return {
    id: randomUUID(),
    created_at: now,
    updated_at: now,
    first_name: "Test",
    last_name: "Lead",
    email: "test@example.com",
    phone: "+16025550101",
    source: "facebook",
    status: "new",
    pipeline_stage: "Lead-In",
    owner: null,
    score: 0,
    timezone: "America/Phoenix",
    consent: 1,
    ghl_contact_id: null,
    tags: [],
    custom: { state: "AZ", timeline: "ASAP" },
    last_activity_at: now,
    category: "HELOC",
    category_reason: "test",
    campaign: null,
    sms_consent: 0,
    email_unsubscribed: 0,
    consent_at: now,
    deleted_at: null,
    past_client: 0,
    contact_only: 0,
    owner_user_id: null,
    whatsapp_phone: null,
    whatsapp_opt_in_status: 0,
    whatsapp_opt_in_source: null,
    whatsapp_opt_in_timestamp: null,
    whatsapp_last_inbound_at: null,
    whatsapp_last_outbound_at: null,
    preferred_channel: null,
    todos: [],
    ...overrides,
  };
}

test("deterministic recommendation requires review and blocks autonomous lending actions", () => {
  const recommendation = buildDeterministicRecommendation(lead(), [], null);
  assert.equal(recommendation.priority, "high");
  assert.equal(recommendation.humanReviewRequired, true);
  assert.ok(recommendation.prohibitedActions.includes("approve_or_deny_credit"));
  assert.ok(recommendation.prohibitedActions.includes("send_message"));
  assert.match(recommendation.reasons.join(" "), /SMS consent/i);
});

test("routing selects the first matching active owner", () => {
  const previous = config.leadAgent.routingRulesJson;
  config.leadAgent.routingRulesJson = JSON.stringify([{ state: "AZ", category: "HELOC", owner: "az-owner" }]);
  const users: User[] = [
    { id: "admin", username: "admin", name: "Admin", role: "admin", permissions: [], disabled: false, created_at: 1 },
    { id: "owner-1", username: "az-owner", name: "Arizona Owner", role: "user", permissions: [], disabled: false, created_at: 2 },
  ];
  try {
    assert.equal(recommendOwner(lead(), users)?.id, "owner-1");
  } finally {
    config.leadAgent.routingRulesJson = previous;
  }
});

test("recommendation-only run records duplicates without mutating owner or tasks", async () => {
  const previous = { ...config.leadAgent };
  const suffix = String(Date.now()).slice(-7);
  const phone = `+1602${suffix}`;
  const first = createLead({ name: "Agent Duplicate One", phone, source: "test", category: "HELOC" });
  const second = createLead({ name: "Agent Duplicate Two", phone, source: "test", category: "HELOC" });
  config.leadAgent.enabled = true;
  config.leadAgent.mode = "recommend";
  config.leadAgent.applySafeActions = false;
  config.leadAgent.createTasks = false;
  config.leadAgent.apiKey = "";
  try {
    const run = await runLeadAgent(second.id, "test");
    assert.equal(run.status, "completed");
    assert.equal(run.mode, "recommend");
    assert.equal(run.duplicates.some((item) => item.leadId === first.id), true);
    assert.deepEqual(run.appliedActions, []);
    const stored = db.prepare(`SELECT owner_user_id, todos FROM leads WHERE id = ?`).get(second.id) as { owner_user_id: string | null; todos: string };
    assert.equal(stored.owner_user_id, null);
    assert.deepEqual(JSON.parse(stored.todos), []);
  } finally {
    Object.assign(config.leadAgent, previous);
    db.prepare(`DELETE FROM leads WHERE id IN (?, ?)`).run(first.id, second.id);
  }
});
