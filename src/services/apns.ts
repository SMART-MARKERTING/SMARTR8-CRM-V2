import { createHash, createPrivateKey, createSign } from "crypto";
import http2 from "http2";
import { config } from "../config";

export type ApnsEnvironment = "sandbox" | "production";

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  topic: string;
  privateKey: string;
  environment: "sandbox" | "production" | "auto";
  expirationSeconds: number;
}

export interface ApnsDeliveryRequest {
  deviceToken: string;
  deviceTokenFingerprint: string;
  deviceEnvironment: "development" | "production";
  apnsId: string;
  collapseId: string;
  payload: unknown;
  expirationSeconds?: number;
}

export interface ApnsSendResult {
  ok: boolean;
  statusCode: number;
  apnsId: string | null;
  reason: string | null;
  retryable: boolean;
  expired: boolean;
  invalidToken: boolean;
  throttled: boolean;
  authenticationFailure: boolean;
  configurationFailure: boolean;
  responseBody: string;
  error?: string;
}

interface ApnsTransportResult {
  statusCode: number;
  apnsId: string | null;
  body: string;
}

type ApnsTransport = (endpoint: string, headers: http2.OutgoingHttpHeaders, body: string, timeoutMs: number) => Promise<ApnsTransportResult>;

const APNS_PRODUCTION_ENDPOINT = "https://api.push.apple.com";
const APNS_SANDBOX_ENDPOINT = "https://api.sandbox.push.apple.com";
const AUTH_FAILURE_REASONS = new Set([
  "BadCertificate",
  "BadCertificateEnvironment",
  "ExpiredProviderToken",
  "Forbidden",
  "InvalidProviderToken",
  "MissingProviderToken",
  "TopicDisallowed",
]);
const INVALID_TOKEN_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]);
const CONFIG_FAILURE_REASONS = new Set([
  "BadCollapseId",
  "BadExpirationDate",
  "BadMessageId",
  "BadPriority",
  "BadTopic",
  "BadPath",
  "DeviceTokenNotForTopic",
  "PayloadEmpty",
  "PayloadTooLarge",
  "TopicDisallowed",
]);

let cachedJwt: { fingerprint: string; issuedAt: number; token: string } | null = null;

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function credentialFingerprint(apns: ApnsConfig): string {
  return createHash("sha256")
    .update(apns.keyId)
    .update("\0")
    .update(apns.teamId)
    .update("\0")
    .update(apns.privateKey)
    .digest("hex");
}

export function apnsConfigurationErrors(apns: ApnsConfig = config.apns): string[] {
  const errors: string[] = [];
  if (!/^[A-Za-z0-9]{4,64}$/.test(apns.keyId || "")) errors.push("APNS_KEY_ID");
  if (!/^[A-Za-z0-9]{4,64}$/.test(apns.teamId || "")) errors.push("APNS_TEAM_ID");
  if (!/^[A-Za-z0-9.-]{3,180}$/.test(apns.topic || "")) errors.push("APNS_TOPIC");
  if (!apns.privateKey || !/BEGIN (EC )?PRIVATE KEY/.test(apns.privateKey)) {
    errors.push("APNS_PRIVATE_KEY");
  } else {
    try {
      createPrivateKey(apns.privateKey);
    } catch {
      errors.push("APNS_PRIVATE_KEY");
    }
  }
  return errors;
}

export function nativeApnsConfigured(apns: ApnsConfig = config.apns): boolean {
  return apnsConfigurationErrors(apns).length === 0;
}

export function apnsEnvironmentForDevice(deviceEnvironment: "development" | "production", apns: ApnsConfig = config.apns): ApnsEnvironment {
  if (apns.environment === "sandbox") return "sandbox";
  if (apns.environment === "production") return "production";
  return deviceEnvironment === "development" ? "sandbox" : "production";
}

export function apnsEndpointForEnvironment(environment: ApnsEnvironment): string {
  return environment === "sandbox" ? APNS_SANDBOX_ENDPOINT : APNS_PRODUCTION_ENDPOINT;
}

export function sanitizeApnsCollapseId(value: string | null | undefined): string {
  const cleaned = String(value || "notification")
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, "")
    .slice(0, 64);
  return cleaned || "notification";
}

export function createApnsJwt(apns: ApnsConfig = config.apns, now = Date.now()): string {
  const errors = apnsConfigurationErrors(apns);
  if (errors.length) throw new Error(`APNs credentials are not configured: ${errors.join(", ")}`);
  const fingerprint = credentialFingerprint(apns);
  const issuedAt = Math.floor(now / 1000);
  if (cachedJwt && cachedJwt.fingerprint === fingerprint && issuedAt - cachedJwt.issuedAt < 50 * 60) {
    return cachedJwt.token;
  }
  const header = base64url(JSON.stringify({ alg: "ES256", kid: apns.keyId }));
  const claims = base64url(JSON.stringify({ iss: apns.teamId, iat: issuedAt }));
  const input = `${header}.${claims}`;
  const signature = createSign("SHA256")
    .update(input)
    .end()
    .sign({ key: apns.privateKey, dsaEncoding: "ieee-p1363" });
  const token = `${input}.${base64url(signature)}`;
  cachedJwt = { fingerprint, issuedAt, token };
  return token;
}

function safeReason(raw: string): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { reason?: unknown };
    if (typeof parsed.reason !== "string") return null;
    return parsed.reason.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 80) || null;
  } catch {
    return null;
  }
}

export function classifyApnsResponse(statusCode: number, rawBody = "", apnsId: string | null = null): ApnsSendResult {
  const reason = safeReason(rawBody);
  if (statusCode === 200) {
    return {
      ok: true,
      statusCode,
      apnsId,
      reason: null,
      retryable: false,
      expired: false,
      invalidToken: false,
      throttled: false,
      authenticationFailure: false,
      configurationFailure: false,
      responseBody: "",
    };
  }
  const invalidToken = Boolean(reason && INVALID_TOKEN_REASONS.has(reason));
  const authenticationFailure = statusCode === 403 || Boolean(reason && AUTH_FAILURE_REASONS.has(reason));
  const throttled = statusCode === 429;
  const transient = statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
  const configurationFailure = authenticationFailure || Boolean(reason && CONFIG_FAILURE_REASONS.has(reason));
  return {
    ok: false,
    statusCode,
    apnsId,
    reason,
    retryable: transient && !invalidToken,
    expired: invalidToken,
    invalidToken,
    throttled,
    authenticationFailure,
    configurationFailure,
    responseBody: reason || "",
    error: authenticationFailure
      ? "APNs authentication/configuration failure"
      : throttled
        ? "APNs throttled delivery"
        : invalidToken
          ? "APNs rejected device token"
          : transient
            ? "APNs transient delivery failure"
            : "APNs permanent delivery failure",
  };
}

async function http2Transport(endpoint: string, headers: http2.OutgoingHttpHeaders, body: string, timeoutMs: number): Promise<ApnsTransportResult> {
  return new Promise((resolve, reject) => {
    const session = http2.connect(endpoint);
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      session.close();
      callback();
    };
    session.setTimeout(timeoutMs, () => finish(() => reject(new Error("APNs request timed out"))));
    session.once("error", (error) => finish(() => reject(error)));
    const stream = session.request(headers);
    let statusCode = 0;
    let apnsId: string | null = null;
    let responseBody = "";
    stream.setEncoding("utf8");
    stream.once("response", (responseHeaders) => {
      statusCode = Number(responseHeaders[":status"] || 0);
      const returnedId = responseHeaders["apns-id"];
      apnsId = Array.isArray(returnedId) ? String(returnedId[0] || "") : returnedId ? String(returnedId) : null;
    });
    stream.on("data", (chunk) => {
      responseBody += String(chunk);
    });
    stream.once("error", (error) => finish(() => reject(error)));
    stream.once("end", () => finish(() => resolve({ statusCode, apnsId, body: responseBody })));
    stream.end(body);
  });
}

export async function sendNativeApnsAlert(
  request: ApnsDeliveryRequest,
  opts: { apns?: ApnsConfig; transport?: ApnsTransport; timeoutMs?: number } = {},
): Promise<ApnsSendResult> {
  const apns = opts.apns || config.apns;
  const errors = apnsConfigurationErrors(apns);
  if (errors.length) {
    return {
      ok: false,
      statusCode: 0,
      apnsId: request.apnsId,
      reason: null,
      retryable: true,
      expired: false,
      invalidToken: false,
      throttled: false,
      authenticationFailure: false,
      configurationFailure: true,
      responseBody: "",
      error: `APNs credentials are not configured: ${errors.join(", ")}`,
    };
  }

  try {
    const environment = apnsEnvironmentForDevice(request.deviceEnvironment, apns);
    const endpoint = apnsEndpointForEnvironment(environment);
    const body = JSON.stringify(request.payload);
    const expiration = Math.floor(Date.now() / 1000) + (request.expirationSeconds || apns.expirationSeconds);
    const headers: http2.OutgoingHttpHeaders = {
      ":method": "POST",
      ":path": `/3/device/${encodeURIComponent(request.deviceToken)}`,
      "authorization": `bearer ${createApnsJwt(apns)}`,
      "apns-topic": apns.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(expiration),
      "apns-collapse-id": sanitizeApnsCollapseId(request.collapseId),
      "apns-id": request.apnsId,
      "content-type": "application/json",
    };
    const response = await (opts.transport || http2Transport)(endpoint, headers, body, opts.timeoutMs || 15_000);
    return classifyApnsResponse(response.statusCode, response.body, response.apnsId || request.apnsId);
  } catch {
    return {
      ok: false,
      statusCode: 0,
      apnsId: request.apnsId,
      reason: null,
      retryable: true,
      expired: false,
      invalidToken: false,
      throttled: false,
      authenticationFailure: false,
      configurationFailure: false,
      responseBody: "",
      error: "APNs network delivery failure",
    };
  }
}
