import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";

process.env.TOKEN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "loangenius-fax-"));
process.env.CRM_DB_FILE = "crm.db";
process.env.TELNYX_API_KEY = "test-key";
process.env.TELNYX_PUBLIC_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.TELNYX_FAX_APPLICATION_ID = "fax-app-123";
process.env.TELNYX_FAX_FROM_NUMBER = "+18888150027";

const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF", "ascii");

test("outbound fax uses the dedicated application and an expiring CRM media URL", async () => {
  const originalFetch = global.fetch;
  let requestBody: Record<string, unknown> = {};
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), "https://api.telnyx.com/v2/faxes");
    requestBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({ data: { id: "provider-fax-1", status: "queued" } }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const { sendFax, getFaxFilePath, getFaxRecordByMediaToken } = await import("./fax");
    const record = await sendFax({
      to: "+16025550100",
      buffer: pdf,
      filename: "borrower-package.pdf",
      baseUrl: "https://loangenius-v2.onrender.com",
      author: "Admin",
    });
    assert.equal(record.provider_fax_id, "provider-fax-1");
    assert.equal(record.from_number, "+18888150027");
    assert.equal(record.to_number, "+16025550100");
    assert.equal(requestBody.connection_id, "fax-app-123");
    assert.equal(requestBody.from, "+18888150027");
    assert.match(String(requestBody.media_url), /^https:\/\/loangenius-v2\.onrender\.com\/api\/fax\/media\/[a-f0-9]{64}$/);
    assert.ok(record.access_token);
    assert.equal(getFaxRecordByMediaToken(record.access_token!)?.id, record.id);
    assert.ok(getFaxFilePath(record));
  } finally {
    global.fetch = originalFetch;
  }
});

test("received fax is matched, stored in the lead Fax folder, and webhook retries are idempotent", async () => {
  const originalFetch = global.fetch;
  let downloads = 0;
  global.fetch = (async (input: string | URL | Request) => {
    assert.equal(String(input), "https://media.telnyx.example/inbound.pdf");
    downloads += 1;
    return new Response(pdf, { status: 200, headers: { "content-type": "application/pdf" } });
  }) as typeof fetch;

  try {
    const { createLead } = await import("./leads");
    const { listLeadDocuments } = await import("./documents");
    const { handleFaxWebhook } = await import("./fax");
    const lead = createLead({ first_name: "Fax", last_name: "Borrower", phone: "+16025550101", source: "test" });
    const event = {
      data: {
        id: "fax-event-1",
        event_type: "fax.received",
        payload: {
          fax_id: "provider-inbound-1",
          direction: "inbound",
          from: "+16025550101",
          to: "+18888150027",
          status: "received",
          page_count: 2,
          media_url: "https://media.telnyx.example/inbound.pdf",
        },
      },
    };
    const first = await handleFaxWebhook(event);
    const second = await handleFaxWebhook(event);
    assert.equal(first.record?.lead_id, lead.id);
    assert.equal(first.record?.status, "received");
    assert.equal(first.record?.page_count, 2);
    assert.ok(first.record?.document_id);
    assert.equal(second.duplicate, true);
    assert.equal(downloads, 1);
    const documents = listLeadDocuments(lead.id);
    assert.equal(documents.length, 1);
    assert.equal(documents[0].folder_name, "Fax");
    assert.equal(documents[0].doc_type, "fax");
  } finally {
    global.fetch = originalFetch;
  }
});

test("fax router falls through to unrelated API routes", async () => {
  const { faxRouter } = await import("../routes/fax");
  const app = express();
  app.use(express.json());
  app.use(faxRouter);
  app.post("/api/test-fallthrough", (_req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/test-fallthrough`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ test: true }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
