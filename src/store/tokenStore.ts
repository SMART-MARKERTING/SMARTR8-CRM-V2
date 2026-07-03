import { promises as fs } from "fs";
import path from "path";
import { config } from "../config";
import { log } from "../logger";

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  locationId?: string;
  companyId?: string;
  userType?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  locationId?: string;
  companyId?: string;
  userType?: string;
}

const FILE = path.resolve(process.cwd(), config.tokenDir, "ghl.json");

let cache: TokenSet | null = null;

async function readFromDisk(): Promise<TokenSet | null> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8")) as TokenSet;
  } catch {
    return null;
  }
}

export async function saveTokens(t: TokenSet): Promise<void> {
  cache = t;
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(t, null, 2), "utf8");
  log.info("GHL tokens saved", { expires_at: new Date(t.expires_at).toISOString() });
}

export async function loadTokens(): Promise<TokenSet | null> {
  if (cache) return cache;
  cache = await readFromDisk();
  return cache;
}

async function exchange(params: Record<string, string>): Promise<TokenSet> {
  const body = new URLSearchParams({
    client_id: config.ghl.clientId,
    client_secret: config.ghl.clientSecret,
    ...params,
  });
  const res = await fetch(`${config.ghl.apiBase}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`GHL token exchange failed ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as TokenResponse;
  const tokenSet: TokenSet = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    locationId: data.locationId,
    companyId: data.companyId,
    userType: data.userType,
  };
  await saveTokens(tokenSet);
  return tokenSet;
}

export function exchangeCode(code: string): Promise<TokenSet> {
  return exchange({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.ghl.redirectUri,
  });
}

export async function refresh(): Promise<TokenSet> {
  const current = await loadTokens();
  if (!current?.refresh_token) {
    throw new Error("No refresh token on file — install the app via /oauth/install first.");
  }
  return exchange({ grant_type: "refresh_token", refresh_token: current.refresh_token });
}

/** Returns a valid access token, refreshing when within 5 minutes of expiry. */
export async function getAccessToken(): Promise<string> {
  let t = await loadTokens();
  if (!t) {
    if (config.ghl.pit) return config.ghl.pit; // pre-OAuth fallback
    throw new Error("Not authorized: no GHL tokens on file and no GHL_PIT fallback set.");
  }
  if (Date.now() > t.expires_at - 5 * 60 * 1000) {
    log.info("GHL access token near expiry — refreshing");
    t = await refresh();
  }
  return t.access_token;
}
