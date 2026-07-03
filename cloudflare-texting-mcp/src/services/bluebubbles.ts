import type { Env } from "../env";

/** Granular iMessage send outcome — see the Render service's bluebubbles.ts for the
 *  same semantics this is ported from:
 *    success     -> 2xx, delivered.
 *    timeout     -> 524/504 or client abort. BlueBubbles usually sent it but didn't
 *                   respond in time -> PROBABLY DELIVERED (do NOT fall back to SMS).
 *    failed      -> non-2xx error (e.g. 500): a real send failure -> fall back.
 *    unreachable -> couldn't reach the Mac/tunnel at all -> fall back. */
export type BlueBubblesOutcome = "success" | "timeout" | "failed" | "unreachable";

export interface BlueBubblesResult {
  outcome: BlueBubblesOutcome;
  status?: number;
  raw: string;
  /** The tempGuid we sent (so the caller can persist it on the message row). */
  tempGuid: string;
}

function endpoint(env: Env, path: string): string {
  const u = new URL(`${env.BLUEBUBBLES_URL}${path}`);
  /* BlueBubbles auth via query param (aliases: guid | password | token). */
  u.searchParams.set("password", env.BLUEBUBBLES_PASSWORD);
  return u.toString();
}

/** Reachability check with a hard 3s timeout (a hung tunnel must not hang us). */
export async function ping(env: Env): Promise<boolean> {
  if (!env.BLUEBUBBLES_URL) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(endpoint(env, "/api/v1/ping"), { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Attempt an iMessage send. Unique tempGuid per send. Mirrors the proven Render
 *  integration: POST /api/v1/message/text with { chatGuid, tempGuid, message }. */
export async function sendImessage(env: Env, toE164: string, message: string): Promise<BlueBubblesResult> {
  const tempGuid = `smartr8-${crypto.randomUUID()}`;
  if (!env.BLUEBUBBLES_URL) {
    return { outcome: "unreachable", raw: "BLUEBUBBLES_URL is not set", tempGuid };
  }
  const body = { chatGuid: `iMessage;-;${toE164}`, tempGuid, message };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(endpoint(env, "/api/v1/message/text"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await res.text().catch(() => "");
    if (res.ok) return { outcome: "success", status: res.status, raw, tempGuid };
    if (res.status === 524 || res.status === 504) {
      return { outcome: "timeout", status: res.status, raw, tempGuid };
    }
    return { outcome: "failed", status: res.status, raw, tempGuid };
  } catch (err) {
    if ((err as { name?: string } | null)?.name === "AbortError") {
      return { outcome: "timeout", raw: "client timeout (no response in time)", tempGuid };
    }
    return { outcome: "unreachable", raw: `unreachable: ${String(err)}`, tempGuid };
  } finally {
    clearTimeout(timer);
  }
}
