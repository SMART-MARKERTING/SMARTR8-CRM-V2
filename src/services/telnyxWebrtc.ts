import { promises as fs } from "fs";
import path from "path";
import { config } from "../config";
import { log } from "../logger";

// Mints short-lived WebRTC access tokens (JWTs) for the browser softphone, so a
// SIP password never reaches the client. A single telephony credential is created
// once on the SIP connection and reused; tokens are minted per session from it.
const TELNYX_V2 = `${config.telnyx.apiBase}/v2`;
const CRED_FILE = path.resolve(process.cwd(), config.tokenDir, "telnyx-webrtc.json");

function jsonHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.telnyx.apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function readCredId(): Promise<string | null> {
  try {
    const raw = await fs.readFile(CRED_FILE, "utf8");
    return (JSON.parse(raw) as { id?: string }).id ?? null;
  } catch {
    return null;
  }
}

async function writeCredId(id: string): Promise<void> {
  await fs.mkdir(path.dirname(CRED_FILE), { recursive: true });
  await fs.writeFile(CRED_FILE, JSON.stringify({ id }, null, 2), "utf8");
}

/** Reusable telephony-credential id, created on the SIP connection if we don't have one. */
async function getOrCreateCredentialId(): Promise<string> {
  const existing = await readCredId();
  if (existing) return existing;
  if (!config.webrtc.sipConnectionId) throw new Error("TELNYX_SIP_CONNECTION_ID not set");
  const res = await fetch(`${TELNYX_V2}/telephony_credentials`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ connection_id: config.webrtc.sipConnectionId, name: "smartr8-softphone" }),
  });
  const raw = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`Telnyx create credential failed ${res.status}: ${raw}`);
  const id = (JSON.parse(raw) as { data?: { id?: string } }).data?.id;
  if (!id) throw new Error(`Telnyx create credential: no id in response: ${raw}`);
  await writeCredId(id);
  log.info("created Telnyx telephony credential for softphone", { id });
  return id;
}

/**
 * The credential's SIP username, used to build the dial target for ringing the
 * registered WebRTC app: sip:<username>@sip.telnyx.com. Cached alongside the id.
 */
export async function getWebrtcSipUri(): Promise<string | null> {
  try {
    const credId = await getOrCreateCredentialId();
    const res = await fetch(`${TELNYX_V2}/telephony_credentials/${credId}`, { headers: jsonHeaders() });
    if (!res.ok) {
      log.warn(`Telnyx get credential failed ${res.status}: ${await res.text().catch(() => "")}`);
      return null;
    }
    const data = (await res.json()) as { data?: { sip_username?: string } };
    const user = data.data?.sip_username;
    return user ? `sip:${user}@sip.telnyx.com` : null;
  } catch (err) {
    log.warn("getWebrtcSipUri error", { err: String(err) });
    return null;
  }
}

/**
 * Ensure the SIP connection allows inbound SIP URI calls, so our Call Control leg
 * dialing sip:<user>@sip.telnyx.com actually rings the registered console.
 * Sets sip_uri_calling_preference = "unrestricted". Returns the resulting value.
 */
export async function ensureSipUriCalling(): Promise<{ ok: boolean; preference?: string; detail?: string }> {
  const connId = config.webrtc.sipConnectionId;
  if (!connId) return { ok: false, detail: "TELNYX_SIP_CONNECTION_ID not set" };
  try {
    const res = await fetch(`${TELNYX_V2}/credential_connections/${connId}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ sip_uri_calling_preference: "unrestricted" }),
    });
    const raw = await res.text().catch(() => "");
    if (!res.ok) return { ok: false, detail: `PATCH ${res.status}: ${raw.slice(0, 200)}` };
    const data = JSON.parse(raw) as { data?: { sip_uri_calling_preference?: string } };
    return { ok: true, preference: data.data?.sip_uri_calling_preference };
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
}

/** Read the SIP connection's current sip_uri_calling_preference (for diag). */
export async function getSipUriCallingPref(): Promise<string | null> {
  const connId = config.webrtc.sipConnectionId;
  if (!connId) return null;
  try {
    const res = await fetch(`${TELNYX_V2}/credential_connections/${connId}`, { headers: jsonHeaders() });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: { sip_uri_calling_preference?: string } };
    return data.data?.sip_uri_calling_preference ?? null;
  } catch {
    return null;
  }
}

/** Mint a short-lived WebRTC access token (JWT) for the browser SDK to log in with. */
export async function mintWebrtcToken(): Promise<string> {
  const credId = await getOrCreateCredentialId();
  const res = await fetch(`${TELNYX_V2}/telephony_credentials/${credId}/token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.telnyx.apiKey}`, Accept: "text/plain" },
  });
  const raw = await res.text().catch(() => "");
  if (!res.ok) {
    // Stored credential was deleted on Telnyx → forget it so the next call recreates one.
    if (res.status === 404 || res.status === 422) await fs.rm(CRED_FILE, { force: true }).catch(() => {});
    throw new Error(`Telnyx mint token failed ${res.status}: ${raw}`);
  }
  const t = raw.trim();
  // Telnyx returns the JWT as plain text; tolerate a JSON-wrapped body just in case.
  if (t.startsWith("{")) {
    const obj = JSON.parse(t) as { data?: string; token?: string };
    return obj.data ?? obj.token ?? t;
  }
  return t;
}
