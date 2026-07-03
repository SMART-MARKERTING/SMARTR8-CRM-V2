import { Router } from "express";
import { config } from "../config";
import { exchangeCode, loadTokens } from "../store/tokenStore";
import { log } from "../logger";

export const oauthRouter = Router();

/**
 * Read-only: shows which GHL location/company the stored token is bound to vs. the
 * GHL_LOCATION_ID we send on requests. A mismatch is the cause of
 * "token does not have access to this location" (403) on contact/message calls.
 * Tokens themselves are NOT exposed.
 */
oauthRouter.get("/whoami", async (_req, res) => {
  const t = await loadTokens();
  if (!t) {
    res.json({
      authorized: false,
      configuredLocationId: config.ghl.locationId,
      note: "No OAuth tokens on file — install via /oauth/install.",
    });
    return;
  }
  const tokenLocation = t.locationId ?? null;
  res.json({
    authorized: true,
    tokenUserType: t.userType ?? null, // "Location" is what contact/message calls need
    tokenLocationId: tokenLocation, // who the token is actually for
    tokenCompanyId: t.companyId ?? null,
    configuredLocationId: config.ghl.locationId, // what we send on requests
    locationMatches: tokenLocation ? tokenLocation === config.ghl.locationId : null,
    expiresAt: new Date(t.expires_at).toISOString(),
  });
});

/** Kicks off the GHL OAuth install — visit this URL in a browser once. */
oauthRouter.get("/install", (_req, res) => {
  const params = new URLSearchParams({
    response_type: "code",
    redirect_uri: config.ghl.redirectUri,
    client_id: config.ghl.clientId,
    scope: config.ghl.scopes.join(" "),
  });
  res.redirect(`${config.ghl.oauthBase}/oauth/chooselocation?${params.toString()}`);
});

/** GHL redirects here with ?code=... after the user authorizes. */
oauthRouter.get("/callback", async (req, res) => {
  const code = String(req.query.code ?? "");
  if (!code) {
    res.status(400).send("Missing ?code");
    return;
  }
  try {
    await exchangeCode(code);
    log.info("OAuth install complete");
    res.send("Smartr8 texting app authorized. You can close this tab.");
  } catch (err) {
    log.error("OAuth callback failed", { err: String(err) });
    res.status(500).send(`OAuth exchange failed: ${String(err)}`);
  }
});
