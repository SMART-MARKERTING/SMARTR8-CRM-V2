import { Request, Response, NextFunction } from "express";
import { getSessionUser, adminFromPasscode, isSessionPortalVerified, User } from "../services/auth";
import { featureForRequest, userHasFeature } from "../services/permissions";

// Attach the authenticated user to the request for downstream handlers (lead scoping, etc.).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUser?: User;
    }
  }
}

/** Pull a session token from the secure cookie or explicit API headers. Tokens are
 * intentionally not accepted in URLs or request bodies because those are commonly logged. */
export function tokenFrom(req: Request): string | undefined {
  const cookieHeader = req.get("cookie") || "";
  const sessionCookie = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("lg_session="));
  if (sessionCookie) return decodeURIComponent(sessionCookie.slice("lg_session=".length));
  const h = req.get("x-session-token");
  if (h) return h;
  const bearer = req.get("authorization");
  if (bearer && bearer.toLowerCase().startsWith("bearer ")) return bearer.slice(7).trim();
  return undefined;
}

/**
 * Resolve the request's user from a session token, or the legacy APP_PASSCODE (which acts
 * as a break-glass admin login). Returns null when unauthenticated.
 */
export function resolveUser(req: Request): User | null {
  const token = tokenFrom(req);
  if (token) {
    const u = getSessionUser(token);
    if (u) return u;
  }
  const provided =
    req.get("x-app-passcode");
  return adminFromPasscode(provided);
}

/**
 * Gate behind a valid login. On success attaches `req.authUser` and returns true; otherwise
 * sends 401 and returns false so callers can early-return. (Name kept as `checkPass` so the
 * many existing call sites keep working — it now accepts session tokens too.)
 */
export function checkPass(req: Request, res: Response): boolean {
  const user = resolveUser(req);
  if (!user) {
    res.status(401).json({ error: "sign in required" });
    return false;
  }
  req.authUser = user;
  return true;
}

/** Express middleware form of the login gate. */
export function requirePass(req: Request, res: Response, next: NextFunction): void {
  if (checkPass(req, res)) next();
}

/** Sensitive Portal / Apps APIs require the recent server-side step-up check. */
export function requirePortalVerified(req: Request, res: Response, next: NextFunction): void {
  if (!checkPass(req, res)) return;
  if (!isSessionPortalVerified(tokenFrom(req))) {
    res.status(403).json({ error: "portal verification required" });
    return;
  }
  next();
}

/** Like requirePass, but requires an admin. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!checkPass(req, res)) return;
  if (req.authUser?.role !== "admin") {
    res.status(403).json({ error: "admin only" });
    return;
  }
  next();
}

/**
 * High-risk cross-user and provider-configuration mutations require a real
 * server session, an administrator role, and a recent portal step-up. The
 * legacy APP_PASSCODE remains a break-glass login elsewhere but cannot satisfy
 * this stronger gate.
 */
export function requireVerifiedAdmin(req: Request, res: Response, next: NextFunction): void {
  const token = tokenFrom(req);
  const user = token ? getSessionUser(token) : null;
  if (!user) {
    res.status(401).json({ error: "verified administrator session required" });
    return;
  }
  req.authUser = user;
  if (user.role !== "admin") {
    res.status(403).json({ error: "admin only" });
    return;
  }
  if (!isSessionPortalVerified(token)) {
    res.status(403).json({ error: "portal verification required" });
    return;
  }
  next();
}

const CLIENT_IDENTITY_FIELDS = new Set([
  "actor",
  "provider",
  "recipient",
  "recipientid",
  "role",
  "userid",
  "ownerid",
]);

/** Prevent callers from supplying identities that must come from the session. */
export function rejectClientSuppliedIdentity(req: Request, res: Response, next: NextFunction): void {
  const inputs = [req.body, req.query];
  for (const input of inputs) {
    if (!input || typeof input !== "object" || Array.isArray(input)) continue;
    for (const key of Object.keys(input)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (CLIENT_IDENTITY_FIELDS.has(normalized)) {
        res.status(400).json({ error: "actor, ownership, provider, and recipient identities are derived by the server" });
        return;
      }
    }
  }
  next();
}

/** Gate APIs by the signed-in user's feature checklist. Public/webhook routes return null. */
export function requireFeatureForCurrentPath(req: Request, res: Response, next: NextFunction): void {
  const feature = featureForRequest(req);
  if (!feature) {
    next();
    return;
  }
  if (!checkPass(req, res)) return;
  if (!userHasFeature(req.authUser, feature)) {
    res.status(403).json({ error: `feature not allowed: ${feature}` });
    return;
  }
  next();
}
