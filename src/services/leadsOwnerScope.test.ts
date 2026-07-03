import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.TOKEN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "smartr8-owner-scope-"));
process.env.CRM_DB_FILE = "crm.db";

test("message threads can be scoped to a sub-account owner", async () => {
  const { createLead, updateLead, logActivity, listMessageThreads } = await import("./leads");

  const adminLead = createLead({ first_name: "Admin", last_name: "Lead", phone: "+15550001001", source: "test" });
  updateLead(adminLead.id, { owner_user_id: "admin-user" });
  logActivity(adminLead.id, {
    type: "sms",
    direction: "inbound",
    channel: "sms",
    body: "admin-only thread",
  });

  const subLead = createLead({ first_name: "Sub", last_name: "Lead", phone: "+15550001002", source: "test" });
  updateLead(subLead.id, { owner_user_id: "sub-user" });
  logActivity(subLead.id, {
    type: "imessage",
    direction: "inbound",
    channel: "imessage",
    body: "sub-account thread",
  });

  assert.deepEqual(
    listMessageThreads(50, "sub-user").map((thread) => thread.contactId),
    [subLead.id],
  );
  assert.deepEqual(
    listMessageThreads(50, "admin-user").map((thread) => thread.contactId),
    [adminLead.id],
  );
  assert.equal(listMessageThreads(50).length, 2);
});
