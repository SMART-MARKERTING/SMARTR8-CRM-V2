import { createHash } from "crypto";
import webPush from "web-push";
import { config } from "../config";
import { log } from "../logger";

export interface StoredPushSubscription {
  id: string;
  endpoint: string;
  p256dh_key: string;
  auth_key: string;
}

export interface PushSendResult {
  ok: boolean;
  statusCode: number;
  responseBody: string;
  expired: boolean;
  retryable: boolean;
  error?: string;
}

export function pushConfigured(): boolean {
  return Boolean(config.push.vapidPublicKey && config.push.vapidPrivateKey && config.push.contact);
}

export function endpointFingerprint(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 16);
}

function configureVapid(): void {
  if (!pushConfigured()) throw new Error("Web Push VAPID is not configured");
  webPush.setVapidDetails(config.push.contact, config.push.vapidPublicKey, config.push.vapidPrivateKey);
}

export async function sendWebPush(subscription: StoredPushSubscription, payload: string): Promise<PushSendResult> {
  const fingerprint = endpointFingerprint(subscription.endpoint);
  try {
    configureVapid();
    const response = await webPush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh_key, auth: subscription.auth_key },
      },
      payload,
      { TTL: 300, urgency: "high" },
    );
    const statusCode = Number(response.statusCode || 201);
    log.info("web push delivered", { subscription: fingerprint, statusCode });
    return { ok: true, statusCode, responseBody: "", expired: false, retryable: false };
  } catch (error) {
    const err = error as Error & { statusCode?: number; body?: string };
    const statusCode = Number(err.statusCode || 0);
    const expired = statusCode === 404 || statusCode === 410;
    const retryable = !expired && (statusCode === 0 || statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500);
    const responseBody = String(err.body || "").slice(0, 1_000);
    const message = err.message.slice(0, 1_000);
    log.warn("web push failed", { subscription: fingerprint, statusCode, expired, retryable, error: message });
    return { ok: false, statusCode, responseBody, expired, retryable, error: message };
  }
}
