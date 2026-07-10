import assert from "node:assert/strict";
import test from "node:test";
import {
  createConference,
  joinConference,
  leaveConference,
  updateConferenceParticipant,
} from "./telnyxVoice";

test("Power Dialer live listen uses Telnyx supervisor monitor commands", async () => {
  const originalFetch = global.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({ url, body });
    const responseBody = url.endsWith("/conferences")
      ? { data: { id: "conference-1" } }
      : { data: { result: "ok" } };
    return new Response(JSON.stringify(responseBody), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const conferenceId = await createConference("power-test", "customer-call");
    await joinConference(conferenceId, "monitor-call", { supervisorRole: "monitor" });
    await updateConferenceParticipant(conferenceId, "monitor-call", "barge");
    await leaveConference(conferenceId, "customer-call");
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(requests.length, 4);
  assert.equal(requests[0].body.beep_enabled, "never");
  assert.equal(requests[1].body.supervisor_role, "monitor");
  assert.equal(requests[1].body.beep_enabled, "never");
  assert.equal(requests[2].body.supervisor_role, "barge");
  assert.equal(requests[3].body.call_control_id, "customer-call");
});
