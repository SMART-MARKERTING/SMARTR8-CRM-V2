import { randomUUID } from "crypto";
import { readFile } from "fs/promises";
import { config } from "../config";

function endpoint(p: string): string {
  // Uses BLUEBUBBLES_URL (host only) + BLUEBUBBLES_PASSWORD (as a query param).
  const u = new URL(`${config.bluebubbles.url}${p}`);
  u.searchParams.set("password", config.bluebubbles.password);
  return u.toString();
}

export async function ping(): Promise<boolean> {
  if (!config.bluebubbles.url) return false;
  // Hard timeout so a hung Mac/Cloudflare tunnel can't make this (and therefore
  // /health) hang forever — a hanging /health fails Render's health check → 502.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(endpoint("/api/v1/ping"), { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** List webhooks currently registered on the BlueBubbles server (tries both paths). */
export async function listWebhooks(): Promise<unknown> {
  if (!config.bluebubbles.url) throw new Error("BLUEBUBBLES_URL not set");
  const paths = ["/api/v1/webhook", "/api/v1/server/webhook"];
  const errors: string[] = [];
  for (const p of paths) {
    try {
      const res = await fetch(endpoint(p));
      const raw = await res.text().catch(() => "");
      if (res.ok) return raw ? JSON.parse(raw) : {};
      errors.push(`${p} -> ${res.status}: ${raw.slice(0, 200)}`);
    } catch (err) {
      errors.push(`${p} -> ${String(err)}`);
    }
  }
  throw new Error(`BlueBubbles list webhooks failed. ${errors.join(" | ")}`);
}

/**
 * Register a webhook so BlueBubbles POSTs inbound events to us. BlueBubbles
 * versions differ on the path (/api/v1/webhook vs /api/v1/server/webhook) and the
 * event name; we try the combinations and return the first that succeeds, or throw
 * with the full status+body of every attempt so the real cause is visible.
 */
export async function registerWebhook(url: string): Promise<unknown> {
  if (!config.bluebubbles.url) throw new Error("BLUEBUBBLES_URL not set");
  const paths = ["/api/v1/webhook", "/api/v1/server/webhook"];
  const eventSets = [["new-message"], ["new-messages"]];
  const errors: string[] = [];
  for (const p of paths) {
    for (const events of eventSets) {
      try {
        const res = await fetch(endpoint(p), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, events }),
        });
        const raw = await res.text().catch(() => "");
        if (res.ok) return { path: p, events, result: raw ? JSON.parse(raw) : {} };
        errors.push(`POST ${p} ${JSON.stringify(events)} -> ${res.status}: ${raw.slice(0, 200)}`);
      } catch (err) {
        errors.push(`POST ${p} ${JSON.stringify(events)} -> ${String(err)}`);
      }
    }
  }
  throw new Error(`BlueBubbles register webhook failed. Tried: ${errors.join(" | ")}`);
}

export type BlueBubblesOutcome = "success" | "timeout" | "failed" | "unreachable";

export interface BlueBubblesResult {
  outcome: BlueBubblesOutcome;
  /** HTTP status when BlueBubbles actually responded. */
  status?: number;
  /** Raw response body or error string — always surfaced to the logs. */
  raw: string;
}

/**
 * Attempt an iMessage send via BlueBubbles. Returns a granular outcome. Uses
 * BLUEBUBBLES_URL (host only) and BLUEBUBBLES_PASSWORD.
 *
 *   success     -> 2xx. Delivered.
 *   timeout     -> 524/504 or client abort. BlueBubbles usually sent it but didn't
 *                  respond in time -> PROBABLY DELIVERED.
 *   failed      -> server responded with a non-2xx error (e.g. 500): a real send
 *                  failure — the message did NOT go out.
 *   unreachable -> couldn't reach BlueBubbles at all (URL unset / connection error /
 *                  tunnel down): capability is UNKNOWN, nothing sent.
 *
 * Outbound treats both `failed` and `unreachable` as "send failure -> SMS fallback".
 * The probe treats them differently: `failed` = not iMessage-capable (tag it),
 * `unreachable` = inconclusive (don't tag, re-probe later).
 */
export async function sendImessage(toE164: string, message: string): Promise<BlueBubblesResult> {
  if (!config.bluebubbles.url) {
    return { outcome: "unreachable", raw: "BLUEBUBBLES_URL is not set" };
  }

  const failures: string[] = [];
  for (const chatGuid of imessageChatGuids(toE164)) {
    const result = await postTextMessage(chatGuid, message);
    if (result.outcome === "success" || result.outcome === "timeout") return result;
    failures.push(`${chatGuid} -> ${result.status ?? "no-status"}: ${result.raw}`);
    if (result.outcome === "unreachable") return result;
  }
  return { outcome: "failed", raw: failures.join(" | ") || "BlueBubbles text send failed" };
}

function imessageChatGuids(toE164: string): string[] {
  const clean = toE164.trim();
  const digits = clean.replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return Array.from(new Set([
    `iMessage;-;${clean}`,
    digits ? `iMessage;-;${digits}` : "",
    local ? `iMessage;-;${local}` : "",
    `any;-;${clean}`,
    digits ? `any;-;${digits}` : "",
    local ? `any;-;${local}` : "",
  ].filter(Boolean)));
}

async function postTextMessage(chatGuid: string, message: string): Promise<BlueBubblesResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(endpoint("/api/v1/message/text"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatGuid,
        tempGuid: `smartr8-${randomUUID()}`,
        message,
        // Force iMessage-only delivery. BlueBubbles must never choose Mac SMS;
        // if iMessage fails, services/router.ts falls back through Telnyx.
        method: "private-api",
      }),
      signal: controller.signal,
    });
    const raw = await res.text().catch(() => "");
    if (res.ok) return { outcome: "success", status: res.status, raw };
    if (res.status === 524 || res.status === 504) {
      return { outcome: "timeout", status: res.status, raw };
    }
    // Server responded with an error (e.g. 500) -> a real send failure.
    return { outcome: "failed", status: res.status, raw };
  } catch (err) {
    // Client-side abort (no response in the window): request was accepted but silent
    // -> treat like a 524 (probably delivered) so we don't double-send.
    if ((err as { name?: string } | null)?.name === "AbortError") {
      return { outcome: "timeout", raw: "client timeout (no response in time)" };
    }
    // Connection refused / DNS / TLS / tunnel down -> couldn't reach the Mac at all.
    return { outcome: "unreachable", raw: `unreachable: ${String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send an iMessage ATTACHMENT (image/file) via BlueBubbles. Same outcome semantics as
 * sendImessage. NOTE(verify): attachment sending requires the BlueBubbles Private API;
 * without it BlueBubbles returns an error (-> outcome "failed") and the caller falls
 * back to Telnyx MMS.
 */
export async function sendImessageAttachment(
  toE164: string,
  filePath: string,
  name: string,
  mime: string,
  message = "",
): Promise<BlueBubblesResult> {
  if (!config.bluebubbles.url) {
    return { outcome: "unreachable", raw: "BLUEBUBBLES_URL is not set" };
  }

  try {
    const buf = await readFile(filePath);
    return await postAttachment({ toE164, buf, name, mime, message });
  } catch (err) {
    return { outcome: "failed", raw: `could not send attachment: ${String(err)}` };
  }
}

async function postAttachment(opts: {
  toE164: string;
  buf: Buffer;
  name: string;
  mime: string;
  message: string;
}): Promise<BlueBubblesResult> {
  const form = new FormData();
  form.append("chatGuid", `iMessage;-;${opts.toE164}`);
  form.append("tempGuid", `smartr8-${randomUUID()}`);
  form.append("name", opts.name);
  if (opts.message) form.append("message", opts.message);
  form.append("method", "private-api");
  form.append("attachment", new Blob([new Uint8Array(opts.buf)], { type: opts.mime || "application/octet-stream" }), opts.name);
  const controller = new AbortController();
  // Attachments need the BlueBubbles Private API; if it isn't active the call stalls.
  // Tighter window than text (120s) so we fail over to MMS quickly instead of hanging.
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    // No explicit Content-Type: fetch sets the multipart boundary from the FormData.
    const res = await fetch(endpoint("/api/v1/message/attachment"), {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    const raw = await res.text().catch(() => "");
    if (res.ok) return { outcome: "success", status: res.status, raw };
    if (res.status === 524 || res.status === 504) {
      return { outcome: "timeout", status: res.status, raw };
    }
    return { outcome: "failed", status: res.status, raw };
  } catch (err) {
    if ((err as { name?: string } | null)?.name === "AbortError") {
      return { outcome: "timeout", raw: "client timeout (no response in time)" };
    }
    return { outcome: "unreachable", raw: `unreachable: ${String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

export type BlueBubblesReaction =
  | "love"
  | "like"
  | "dislike"
  | "laugh"
  | "emphasize"
  | "question"
  | "-love"
  | "-like"
  | "-dislike"
  | "-laugh"
  | "-emphasize"
  | "-question";

export async function reactToMessage(
  chatGuid: string,
  selectedMessageGuid: string,
  reaction: BlueBubblesReaction,
): Promise<BlueBubblesResult> {
  if (!config.bluebubbles.url) {
    return { outcome: "unreachable", raw: "BLUEBUBBLES_URL is not set" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(endpoint("/api/v1/message/react"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatGuid, selectedMessageGuid, reaction }),
      signal: controller.signal,
    });
    const raw = await res.text().catch(() => "");
    if (res.ok) return { outcome: "success", status: res.status, raw };
    if (res.status === 524 || res.status === 504) return { outcome: "timeout", status: res.status, raw };
    return { outcome: "failed", status: res.status, raw };
  } catch (err) {
    if ((err as { name?: string } | null)?.name === "AbortError") {
      return { outcome: "timeout", raw: "client timeout (no response in time)" };
    }
    return { outcome: "unreachable", raw: `unreachable: ${String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}
