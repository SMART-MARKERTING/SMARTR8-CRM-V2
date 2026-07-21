import assert from "node:assert/strict";
import test from "node:test";

process.env.RESEND_API_KEY = "re_test_sender_fallback";
process.env.EMAIL_FROM = "info@mykoal.com";
process.env.EMAIL_REPLY_TO = "info@mykoal.com";

test("a Resend unverified user domain retries once through the configured default sender", async (t) => {
  const originalFetch = global.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  global.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
    });
    if (requests.length === 1) {
      return new Response(JSON.stringify({
        statusCode: 403,
        message: "The smartr8.com domain is not verified. Please, add and verify your domain on https://resend.com/domains",
        name: "validation_error",
      }), { status: 403, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ id: "email-fallback-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => { global.fetch = originalFetch; });

  const { sendEmail } = await import("./email");
  const result = await sendEmail({
    from: "jdoe@smartr8.com",
    replyTo: "jdoe@smartr8.com",
    to: "borrower@example.com",
    subject: "Test",
    text: "Hello",
  });

  assert.equal(result.ok, true);
  assert.equal(result.id, "email-fallback-1");
  assert.equal(result.from, "info@mykoal.com");
  assert.equal(result.usedDefaultSender, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.from, "jdoe@smartr8.com");
  assert.equal(requests[1].body.from, "info@mykoal.com");
  assert.equal(requests[1].body.reply_to, "jdoe@smartr8.com");
});
