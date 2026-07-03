import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

process.env.TOKEN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "smartr8-loan-services-"));
process.env.CRM_DB_FILE = "crm.db";

function readRequest(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

test("live title orders POST to the configured vendor endpoint and persist the provider reference", async () => {
  const received: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  const server = http.createServer(async (req, res) => {
    const raw = await readRequest(req);
    received.push({ headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ orderId: "TITLE-123", status: "accepted" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const endpoint = `http://127.0.0.1:${(address as AddressInfo).port}/orders/title`;
    const { createLead, getLead } = await import("./leads");
    const { saveSettlementVendorSettings } = await import("./loanServiceSettings");
    const { requestTitleOrder } = await import("./loanServices");

    saveSettlementVendorSettings("title", {
      enabled: true,
      mode: "live",
      vendorName: "Test Title Vendor",
      apiBase: endpoint,
      apiKey: "title-secret",
      accountId: "acct-1",
      defaultProduct: "title_commitment",
    });

    const lead = createLead({
      first_name: "Wesley",
      last_name: "Smith",
      phone: "+16232808351",
      source: "test",
      custom: {
        address: "123 Main St",
        city: "Mesa",
        state: "AZ",
        zip: "85201",
        loan_purpose: "heloc",
        loan_amount: "125000",
      },
    });

    const result = await requestTitleOrder(lead, "Admin", {
      transactionType: "heloc",
      priority: "rush",
      notes: "Test order",
      requestedFrom: "portal",
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "submitted");
    assert.equal(result.vendorSubmission?.providerId, "TITLE-123");
    assert.equal(result.vendorSubmission?.providerStatus, "accepted");
    assert.equal(received.length, 1);
    assert.equal(received[0].headers.authorization, "Bearer title-secret");
    assert.equal(received[0].headers["x-api-key"], "title-secret");
    assert.equal(received[0].headers["x-account-id"], "acct-1");
    assert.equal(received[0].body.service, "title");
    assert.equal((received[0].body.borrower as Record<string, unknown>).phone, "+16232808351");
    assert.equal((received[0].body.property as Record<string, unknown>).state, "AZ");

    const updated = getLead(lead.id);
    assert.equal(updated?.custom.title_order_status, "submitted");
    assert.equal(updated?.custom.title_order_provider_id, "TITLE-123");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
