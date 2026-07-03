import { test } from "node:test";
import assert from "node:assert/strict";
import { seedCampaigns, listAutomations, updateAutomation, createAutomation } from "./automations";
import { CAMPAIGNS, REMARKETING } from "./campaigns";

// These tests share one in-process SQLite db (TOKEN_DIR is set by the test runner to a
// temp dir), so they run in order: heal first (before the marker is set), then idempotency.

test("one-time heal enables a website drip that an older deploy left disabled", () => {
  // Simulate an install seeded by the prior version: the drip exists but is OFF.
  const legacy = CAMPAIGNS[0];
  createAutomation({
    name: legacy.name,
    trigger: "lead_created",
    enabled: false,
    filter: { category: legacy.key },
    steps: [],
  });

  seedCampaigns();

  const autos = listAutomations();
  // The pre-existing disabled drip is healed On...
  assert.equal(autos.find((a) => a.name === legacy.name)!.enabled, true, `${legacy.name} should be healed On`);
  // ...and every canonical website drip is enabled and category-keyed on lead_created.
  for (const c of CAMPAIGNS) {
    const a = autos.find((x) => x.name === c.name);
    assert.ok(a, `missing campaign ${c.name}`);
    assert.equal(a!.enabled, true, `${c.name} should be enabled`);
    assert.equal(a!.trigger, "lead_created");
    assert.deepEqual(a!.filter, { category: c.key });
  }
  // Past-client remarketing stays Off — it targets prior clients, not website intake.
  assert.equal(autos.find((a) => a.name === REMARKETING.name)!.enabled, false);
});

test("heal runs exactly once: a deliberate disable survives a re-seed", () => {
  const target = listAutomations().find((a) => a.trigger === "lead_created")!;
  updateAutomation(target.id, { enabled: false });
  seedCampaigns(); // marker already set by the first run → heal must NOT re-enable it
  assert.equal(
    listAutomations().find((a) => a.id === target.id)!.enabled,
    false,
    "a manually disabled drip must stay off after re-seed",
  );
});
