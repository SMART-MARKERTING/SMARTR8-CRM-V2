import { createHmac } from "crypto";
import { config } from "../config";

/**
 * Lightweight signed token for unsubscribe links (so the link can't be guessed or
 * enumerated). Keyed off a server secret; not reversible, just verifiable.
 */
function secret(): string {
  return config.app.passcode || config.crm.leadWebhookSecret || "smartr8-fallback-secret";
}

export function signToken(id: string): string {
  return createHmac("sha256", secret()).update(id).digest("hex").slice(0, 24);
}

export function verifyToken(id: string, token: string): boolean {
  if (!token) return false;
  const expected = signToken(id);
  // Constant-ish comparison (length already fixed at 24 hex chars).
  return token.length === expected.length && token === expected;
}
