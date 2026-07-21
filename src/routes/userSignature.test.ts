import assert from "node:assert/strict";
import fs from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import express from "express";

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "smartr8-user-signature-"));
process.env.TOKEN_DIR = testDir;
process.env.CRM_DB_FILE = "crm.db";
after(() => fs.rmSync(testDir, { recursive: true, force: true }));

function patch(port: number, path: string, token: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        cookie: `lg_session=${token}`,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode || 0, body: text ? JSON.parse(text) : {} });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

test("only the super admin can update another user's saved email signature and the change is audited", async () => {
  const [{ usersRouter }, auth, store] = await Promise.all([import("./users"), import("../services/auth"), import("../store/db")]);
  const { createSession, createUser, getUser } = auth;
  const { db } = store;
  let server: ReturnType<typeof express.application.listen> | null = null;
  try {
    const suffix = `${Date.now()}${Math.random().toString(16).slice(2)}`;
    const admin = createUser({ username: "admin", password: "signature-admin-test-password", name: "Admin", role: "admin" });
    const regular = createUser({ username: `regular-${suffix}`, password: "signature-user-test-password", firstName: "Regular", lastName: suffix });
    const target = createUser({ username: `target-${suffix}`, password: "signature-target-test-password", firstName: "Jane", lastName: `Doe${suffix}` });
    const adminToken = createSession(admin.id);
    const regularToken = createSession(regular.id);

    const app = express();
    app.use(express.json());
    app.use(usersRouter);
    server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");

    const denied = await patch(address.port, `/api/users/${target.id}`, regularToken, { emailSignature: "Spoofed signature" });
    assert.equal(denied.status, 403);
    assert.equal(getUser(target.id)?.email_signature, null);

    const signature = "Jane Doe\nSenior Loan Officer\n(555) 555-0100";
    const updated = await patch(address.port, `/api/users/${target.id}`, adminToken, { emailSignature: signature });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.user.email_signature, signature);
    assert.equal(getUser(target.id)?.email_signature, signature);

    const audit = db.prepare(`SELECT action, meta FROM audit_events WHERE action = 'admin.user.signature.update' ORDER BY created_at DESC LIMIT 1`).get() as { action: string; meta: string };
    assert.equal(audit.action, "admin.user.signature.update");
    assert.equal(JSON.parse(audit.meta).target_user_id, target.id);
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
});
