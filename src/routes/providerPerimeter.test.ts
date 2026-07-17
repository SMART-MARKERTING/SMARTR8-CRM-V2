import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import express from "express";

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "smartr8-provider-perimeter-"));
process.env.TOKEN_DIR = testDir;
process.env.CRM_DB_FILE = "crm.db";
process.env.APP_PASSCODE = "phase1-breakglass-passphrase";

interface TestResponse {
  status: number;
  body: string;
}

function request(
  port: number,
  requestPath: string,
  opts: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method: opts.method || "GET",
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return { server, port: address.port };
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("retired GHL outbound aliases return 410 before body parsing or provider delivery", async () => {
  const { providerRouter } = await import("./provider");
  const source = await readFile(path.resolve(process.cwd(), "src", "routes", "provider.ts"), "utf8");
  assert.doesNotMatch(source, /sendOutbound|getContact|updateMessageStatus|services\/telnyx|services\/bluebubbles/);

  let parsed = 0;
  let fallthrough = 0;
  const app = express();
  app.use("/providers/ghl", providerRouter);
  app.use("/v2/providers/ghl", providerRouter);
  app.use(express.json({ verify: () => { parsed += 1; } }));
  app.use((_req, res) => {
    fallthrough += 1;
    res.status(500).json({ error: "unsafe fallthrough" });
  });

  const captured: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args: unknown[]) => { captured.push(JSON.stringify(args)); };
  console.warn = (...args: unknown[]) => { captured.push(JSON.stringify(args)); };
  console.error = (...args: unknown[]) => { captured.push(JSON.stringify(args)); };
  const { server, port } = await listen(app);
  try {
    const body = "{\"phone\":\"+15550001111\",\"message\":\"private-provider-marker\"}";
    for (const route of ["/providers/ghl/messages", "/v2/providers/ghl/messages"]) {
      const response = await request(port, route, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
        body,
      });
      assert.equal(response.status, 410);
      assert.deepEqual(JSON.parse(response.body), { error: "gone" });
    }
    assert.equal(parsed, 0);
    assert.equal(fallthrough, 0);
    assert.doesNotMatch(captured.join("\n"), /private-provider-marker|15550001111/);
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
    await close(server);
  }
});

test("retired mutating diagnostics are unconditional 404 tombstones with no side effects", async () => {
  process.env.NODE_ENV = "production";
  process.env.ALLOW_PRODUCTION_SIMULATORS = "true";
  const { productionSafetyRouter } = await import("./productionSafety");
  const source = await readFile(path.resolve(process.cwd(), "src", "routes", "productionSafety.ts"), "utf8");
  assert.doesNotMatch(source, /ALLOW_PRODUCTION_SIMULATORS|NODE_ENV|sendSms|placeCall|generateVoicemailAudio|simulateInboundWhatsApp/);

  let parsed = 0;
  let sideEffects = 0;
  const app = express();
  app.use(productionSafetyRouter);
  app.use(express.json({ verify: () => { parsed += 1; } }));
  app.use((_req, res) => {
    sideEffects += 1;
    res.status(204).end();
  });
  const { server, port } = await listen(app);
  try {
    const blocked = [
      { method: "POST", path: "/api/whatsapp/debug/simulate-inbound" },
      { method: "POST", path: "/v2/api/whatsapp/debug/simulate-inbound" },
      { method: "GET", path: "/api/telnyx/test-send?to=%2B15550001111" },
      { method: "GET", path: "/v2/api/telnyx/test-send?to=%2B15550001111" },
      { method: "GET", path: "/calls/diag?place=1" },
      { method: "GET", path: "/v2/calls/diag?place=1" },
    ];
    for (const item of blocked) {
      const body = item.method === "POST" ? "{invalid-json-that-must-not-be-parsed" : undefined;
      const response = await request(port, item.path, {
        method: item.method,
        headers: {
          "x-app-passcode": process.env.APP_PASSCODE || "",
          ...(body ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}),
        },
        body,
      });
      assert.equal(response.status, 404, item.path);
    }
    assert.equal(parsed, 0);
    assert.equal(sideEffects, 0);

    const readOnly = await request(port, "/calls/diag");
    assert.equal(readOnly.status, 204);
    assert.equal(sideEffects, 1);
  } finally {
    await close(server);
  }
});

test("logger redacts provider payloads, contact data, signatures, and secret-bearing URLs", async () => {
  const { log } = await import("../logger");
  const captured: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { captured.push(JSON.stringify(args)); };
  try {
    log.info("provider diagnostic", {
      payload: { body: "private-log-marker", phone: "+15550001111" },
      signature: "signature-marker",
      callbackUrl: "https://example.test/webhook?token=token-marker",
      ok: true,
    });
  } finally {
    console.log = original;
  }
  const output = captured.join("\n");
  assert.doesNotMatch(output, /private-log-marker|15550001111|signature-marker|token-marker/);
  assert.match(output, /provider diagnostic/);
});

test("read-only WebRTC diagnostics never create a Telnyx credential", async () => {
  const { config } = await import("../config");
  const { getWebrtcDiagnostic } = await import("../services/telnyxWebrtc");
  const previous = {
    apiKey: config.telnyx.apiKey,
    sipConnectionId: config.webrtc.sipConnectionId,
    fetch: globalThis.fetch,
  };
  const methods: string[] = [];
  config.telnyx.apiKey = "fixture-api-key";
  config.webrtc.sipConnectionId = "fixture-sip-connection";
  globalThis.fetch = async (_input, init) => {
    methods.push((init?.method || "GET").toUpperCase());
    return new Response(JSON.stringify({ data: { sip_uri_calling_preference: "disabled" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const result = await getWebrtcDiagnostic();
    assert.equal(result.credentialCached, false);
    assert.equal(result.ok, false);
    assert.deepEqual(methods, ["GET"]);
  } finally {
    config.telnyx.apiKey = previous.apiKey;
    config.webrtc.sipConnectionId = previous.sipConnectionId;
    globalThis.fetch = previous.fetch;
  }
});

test("global cleanup requires a step-up verified admin and derives actor identity from the session", async () => {
  const { crmRouter } = await import("./crm");
  const { createSession, createUser, markSessionPortalVerified } = await import("../services/auth");
  const { createLead, getLead, updateLead } = await import("../services/leads");
  const { db } = await import("../store/db");

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const admin = createUser({ username: `phase1-admin-${suffix}`, password: "phase1-admin-password", role: "admin" });
  const user = createUser({ username: `phase1-user-${suffix}`, password: "phase1-user-password", role: "user", permissions: ["settings", "contacts"] });
  const adminToken = createSession(admin.id);
  const userToken = createSession(user.id);
  const unverifiedAdminToken = createSession(admin.id);
  markSessionPortalVerified(adminToken, Date.now() + 5 * 60_000);

  const source = `phase1-import-${suffix}`;
  const lead = createLead({ name: "Provider perimeter fixture", phone: "+15550002222", source });
  updateLead(lead.id, { owner_user_id: admin.id });

  const app = express();
  app.use(express.json());
  app.use(crmRouter);
  app.use("/v2", crmRouter);
  app.use((_req, res) => res.status(404).json({ error: "not found" }));
  const { server, port } = await listen(app);
  const post = (requestPath: string, token: string | undefined, body: Record<string, unknown>, passcode?: string) => {
    const serialized = JSON.stringify(body);
    return request(port, requestPath, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(serialized)),
        ...(token ? { "x-session-token": token } : {}),
        ...(passcode ? { "x-app-passcode": passcode } : {}),
      },
      body: serialized,
    });
  };

  try {
    const requestBody = { sources: [source], since: Date.now() - 60_000, dryRun: false };
    assert.equal((await post("/api/admin/purge-imports", userToken, requestBody)).status, 403);
    assert.equal((await post("/api/contacts/import-ghl", userToken, {})).status, 403);
    assert.equal((await post("/api/admin/revert-import", userToken, { importSources: [source], dryRun: false })).status, 403);
    assert.equal((await post("/api/admin/dedupe-contacts", userToken, { dryRun: false })).status, 403);
    assert.equal((await post("/v2/api/admin/purge-imports", unverifiedAdminToken, requestBody)).status, 403);
    assert.equal((await post("/api/admin/purge-imports", undefined, requestBody, process.env.APP_PASSCODE)).status, 401);
    assert.equal(getLead(lead.id)?.deleted_at, null);

    assert.equal((await post("/api/admin/purge-imports", adminToken, { ...requestBody, actor: "client-admin" })).status, 400);
    assert.equal((await post("/api/admin/dedupe-contacts", adminToken, { dryRun: true, ownerId: user.id })).status, 400);
    assert.equal(getLead(lead.id)?.deleted_at, null);

    const retained = await post("/v2/api/admin/dedupe-contacts", adminToken, { dryRun: true });
    assert.equal(retained.status, 200);
    assert.equal((JSON.parse(retained.body) as { dryRun: boolean }).dryRun, true);

    const allowed = await post("/api/admin/purge-imports", adminToken, requestBody);
    assert.equal(allowed.status, 200);
    assert.ok(getLead(lead.id)?.deleted_at);
    const audit = db.prepare(`SELECT user_id, role FROM audit_events WHERE action = 'admin.imports.purge' ORDER BY created_at DESC LIMIT 1`).get() as { user_id: string; role: string } | undefined;
    assert.deepEqual(audit, { user_id: admin.id, role: "admin" });
  } finally {
    await close(server);
    db.prepare(`DELETE FROM audit_events WHERE user_id IN (?, ?)`).run(admin.id, user.id);
    db.prepare(`DELETE FROM sessions WHERE user_id IN (?, ?)`).run(admin.id, user.id);
    db.prepare(`DELETE FROM leads WHERE id = ?`).run(lead.id);
    db.prepare(`DELETE FROM users WHERE id IN (?, ?)`).run(admin.id, user.id);
  }
});

after(() => {
  delete process.env.ALLOW_PRODUCTION_SIMULATORS;
});
