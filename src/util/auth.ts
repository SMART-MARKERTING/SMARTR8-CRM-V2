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
