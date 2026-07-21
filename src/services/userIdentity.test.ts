import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../config";
import { db } from "../store/db";
import { createUser, generatedUserIdentity, isSuperAdmin, type User } from "./auth";
import { getLead } from "./leads";
import { storeReceivedEmail } from "./resendInbound";
import { personalizeSenderTemplate, senderIdentityForUser, userEmailIsSendable } from "./senderIdentity";

test("SmartR8 identities use first initial plus last name", () => {
  const identity = generatedUserIdentity("Jane", "De Soto");
  assert.equal(identity.username, "jdesoto");
  assert.equal(identity.email, `jdesoto@${config.email.userDomain}`);
  assert.equal(identity.name, "Jane De Soto");
});

test("only the exact admin username has workspace-wide authority", () => {
  const base: User = {
    id: "admin-test",
    username: "admin",
    name: "Admin",
    first_name: "Admin",
    last_name: "",
    email: "admin@example.com",
    role: "admin",
    permissions: [],
    disabled: false,
    created_at: Date.now(),
  };
  assert.equal(isSuperAdmin(base), true);
  assert.equal(isSuperAdmin({ ...base, username: "manager" }), false);
  assert.equal(isSuperAdmin({ ...base, role: "user" }), false);
});

test("assigned user identity personalizes automation copy and sender mailbox", () => {
  const user: User = {
    id: "user-1",
    username: "jdoe",
    name: "Jane Doe",
    first_name: "Jane",
    last_name: "Doe",
    email: `jdoe@${config.email.userDomain}`,
    role: "user",
    permissions: [],
    disabled: false,
    created_at: Date.now(),
  };
  const sender = senderIdentityForUser(user);
  assert.equal(sender.name, "Jane Doe");
  assert.equal(sender.email, user.email);
  assert.equal(personalizeSenderTemplate("Hi {{first_name}}, Mykoal with Adaxa Home here. Reply to {{user_email}}.", sender),
    `Hi {{first_name}}, Jane with Adaxa Home here. Reply to ${user.email}.`);
  assert.equal(userEmailIsSendable(user.email), true);
});

test("Resend inbound records the personal mailbox without auto-assigning the contact", async (t) => {
  const suffix = `${Date.now()}${Math.random().toString(16).slice(2)}`;
  const user = createUser({
    username: `mailbox-${suffix}`,
    password: "mailbox-routing-test-password",
    firstName: "Jane",
    lastName: `Doe${suffix}`,
  });
  const result = await storeReceivedEmail({
    email_id: `received-${suffix}`,
    from: `Borrower ${suffix} <borrower-${suffix}@example.com>`,
    to: [user.email!],
    subject: "Personal mailbox routing",
    text: "Please follow up.",
  }, { fetchFull: false, verified: true });
  assert.equal(result.ok, true);
  assert.ok(result.leadId);
  assert.equal(getLead(result.leadId!)?.owner_user_id, null);

  t.after(() => {
    if (result.activityId) db.prepare(`DELETE FROM notification_events WHERE source_record_id = ?`).run(result.activityId);
    if (result.leadId) {
      db.prepare(`DELETE FROM activities WHERE lead_id = ?`).run(result.leadId);
      db.prepare(`DELETE FROM leads WHERE id = ?`).run(result.leadId);
    }
    db.prepare(`DELETE FROM users WHERE id = ?`).run(user.id);
  });
});
