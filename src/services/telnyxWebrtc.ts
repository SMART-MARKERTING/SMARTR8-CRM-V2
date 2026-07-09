import { promises as fs } from "fs";
import path from "path";
import { config } from "../config";
import { log } from "../logger";

// Mints short-lived WebRTC access tokens (JWTs) for the browser softphone, so a
// SIP password never reaches the client. A single telephony credential is created
// once on the SIP connection and reused; tokens are minted per session from it.
const TELNYX_V2 = `${config.telnyx.apiBase}/v2`;
const CRED_FILE = path.resolve(process.cwd(), config.tokenDir, "telnyx-webrtc.json");
const SIP_CONNECTION_HELP =
  "Set TELNYX_SIP_CONNECTION_ID to the Telnyx Credential/SIP Connection id. Do not use TELNYX_VOICE_APP_ID or TELNYX_CONNECTION_ID for WebRTC credentials.";

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
    const parsed = JSON.parse(raw) as { id?: string; connectionId?: string };
    if (parsed.connectionId && config.webrtc.sipConnectionId && parsed.connectionId !== config.webrtc.sipConnectionId) {
      return null;
    }
    return parsed.id ?? null;
  } catch {
    return null;
  }
}

async function writeCredId(id: string): Promise<void> {
  await fs.mkdir(path.dirname(CRED_FILE), { recursive: true });
  await fs.writeFile(CRED_FILE, JSON.stringify({ id, connectionId: config.webrtc.sipConnectionId || null }, null, 2), "utf8");
}

export async function resetWebrtcCredentialCache(): Promise<void> {
  await fs.rm(CRED_FILE, { force: true }).catch(() => {});
}

/** Reusable telephony-credential id, created on the SIP connection if we don't have one. */
async function getOrCreateCredentialId(): Promise<string> {
  const existing = await readCredId();
  if (existing) return existing;
  if (!config.webrtc.sipConnectionId) throw new Error(`TELNYX_SIP_CONNECTION_ID not set. ${SIP_CONNECTION_HELP}`);
  const res = await fetch(`${TELNYX_V2}/telephony_credentials`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ connection_id: config.webrtc.sipConnectionId, name: "smartr8-softphone" }),
  });
  const raw = await res.text().catch(() => "");
  if (!res.ok) {
    const invalidConnection = res.status === 422 && /invalid connection/i.test(raw);
    const setupHint = invalidConnection ? ` ${SIP_CONNECTION_HELP}` : "";
    throw new Error(`Telnyx create credential failed ${res.status}.${setupHint} Provider response: ${raw}`);
  }
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
async function buildWebrtcSipUri(): Promise<string | null> {
  const credId = await getOrCreateCredentialId();
  const res = await fetch(`${TELNYX_V2}/telephony_credentials/${credId}`, { headers: jsonHeaders() });
  const raw = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Telnyx get credential failed ${res.status}: ${raw}`);
  }
  const data = (raw ? JSON.parse(raw) : {}) as { data?: { sip_username?: string } };
  const user = data.data?.sip_username;
  return user ? `sip:${user}@sip.telnyx.com` : null;
}

export async function getWebrtcSipUri(): Promise<string | null> {
  try {
    return await buildWebrtcSipUri();
  } catch (err) {
    log.warn("getWebrtcSipUri error", { err: String(err) });
    return null;
  }
}

export async function getWebrtcDiagnostic(): Promise<Record<string, unknown>> {
  const cachedCredentialId = await readCredId();
  if (!config.telnyx.apiKey) return { ok: false, error: "TELNYX_API_KEY is not set" };
  if (!config.webrtc.sipConnectionId) return { ok: false, error: `TELNYX_SIP_CONNECTION_ID not set. ${SIP_CONNECTION_HELP}` };
  try {
    const sipUri = await buildWebrtcSipUri();
    return {
      ok: Boolean(sipUri),
      sipUri,
      sipUriCalling: await getSipUriCallingPref(),
      credentialCached: Boolean(cachedCredentialId),
      sipConnectionIdConfigured: true,
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err),
      credentialCached: Boolean(cachedCredentialId),
      sipConnectionIdConfigured: true,
    };
  }
}

/**
 * Ensure the SIP connection allows inbound SIP URI calls, so our Call Control leg
 * dialing sip:<user>@sip.telnyx.com actually rings the registered console.
 * Sets sip_uri_calling_preference = "unrestricted". Returns the resulting value.
 */
export async function ensureSipUriCalling(): Promise<{ ok: boolean; preference?: string; detail?: string }> {
  const connId = config.webrtc.sipConnectionId;
  if (!connId) return { ok: false, detail: `TELNYX_SIP_CONNECTION_ID not set. ${SIP_CONNECTION_HELP}` };
  try {
    const res = await fetch(`${TELNYX_V2}/credential_connections/${connId}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ sip_uri_calling_preference: "unrestricted" }),
    });
    const raw = await res.text().catch(() => "");
    if (!res.ok) {
      const setupHint = res.status === 422 && /invalid connection/i.test(raw) ? ` ${SIP_CONNECTION_HELP}` : "";
      return { ok: false, detail: `PATCH ${res.status}.${setupHint} ${raw.slice(0, 200)}` };
    }
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
