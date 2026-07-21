import { Router } from "express";
import { config } from "../config";
import { requirePass, requireAdmin, tokenFrom } from "../util/auth";
import { rateLimit } from "../util/rateLimit";
import { log } from "../logger";
import {
  verifyLogin,
  createSession,
  deleteSession,
  listUsers,
  getUser,
  createUser,
  setPassword,
  setDisabled,
  setRole,
  setPermissions,
  setIdentity,
  markSessionPortalVerified,
  seedAdminIfEmpty,
  primaryAdmin,
  UserError,
  Role,
} from "../services/auth";
import { FEATURE_PERMISSION_CATALOG } from "../services/permissions";

export const usersRouter = Router();

// Brute-force guard on unauthenticated login, plus targeted guards on sensitive account
// routes. Session refreshes get a very generous bucket so normal page reloads cannot
// strand a signed-in user behind a "too many attempts" response.
const loginLimiter = rateLimit({ name: "login", max: 10, windowMs: 5 * 60_000 });
const sessionLimiter = rateLimit({ name: "auth-session", max: 1200, windowMs: 5 * 60_000 });
const accountLimiter = rateLimit({ name: "auth-account", max: 60, windowMs: 5 * 60_000 });
const adminUserLimiter = rateLimit({ name: "admin-users", max: 240, windowMs: 5 * 60_000 });

function sessionCookie(token: string, secure: boolean): string {
  return `lg_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${30 * 24 * 60 * 60}${secure ? "; Secure" : ""}`;
}

/** Sign in with username + password → creates a secure server session. */
usersRouter.post("/api/auth/login", loginLimiter, (req, res) => {
  const username = (req.body?.username ?? "").toString();
  const password = (req.body?.password ?? "").toString();
  let user = verifyLogin(username, password);
  // Break-glass: the app passcode always logs in as the primary admin (any username), and
  // self-seeds the admin if the one-time seed never ran. Guarantees the owner can get in.
  if (!user && config.app.passcode && password === config.app.passcode) {
    seedAdminIfEmpty();
    user = primaryAdmin();
    if (user) log.warn("login via break-glass passcode", { userId: user.id });
  }
  if (!user) {
    res.status(401).json({ error: "wrong username or password" });
    return;
  }
  const token = createSession(user.id);
  log.info("login", { userId: user.id, username: user.username });
  res.setHeader("Set-Cookie", sessionCookie(token, req.secure || process.env.NODE_ENV === "production"));
  res.json({ ok: true, user });
});

/** Who am I (validates the current session). */
usersRouter.get("/api/auth/me", sessionLimiter, requirePass, (req, res) => {
  res.json({ user: req.authUser });
});

/** Step-up verification for Portal / Apps. Re-checks the signed-in user's password before
 * showing document-sensitive borrower application fields in the console. */
usersRouter.post("/api/auth/portal-verify", accountLimiter, requirePass, (req, res) => {
  const me = req.authUser!;
  const password = (req.body?.password ?? "").toString();
  const ok = Boolean(verifyLogin(me.username, password)) || Boolean(config.app.passcode && password === config.app.passcode);
  if (!ok) {
    res.status(401).json({ error: "verification failed" });
    return;
  }
  const verifiedUntil = Date.now() + 15 * 60_000;
  const token = tokenFrom(req);
  if (!token) {
    res.status(400).json({ error: "session token required for portal verification" });
    return;
  }
  markSessionPortalVerified(token, verifiedUntil);
  log.info("portal step-up verified", { userId: me.id, username: me.username });
  res.json({ ok: true, verifiedUntil });
});

/** Sign out (invalidate the current session token). */
usersRouter.post("/api/auth/logout", sessionLimiter, requirePass, (req, res) => {
  const token = tokenFrom(req);
  if (token) deleteSession(token);
  res.setHeader("Set-Cookie", "lg_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
  res.json({ ok: true });
});

/** Change MY OWN password (any signed-in user). Requires the current password. */
usersRouter.post("/api/auth/change-password", accountLimiter, requirePass, (req, res) => {
  const me = req.authUser!;
  const current = (req.body?.current ?? "").toString();
  const next = (req.body?.password ?? "").toString();
  if (!verifyLogin(me.username, current)) {
    res.status(400).json({ error: "current password is incorrect" });
    return;
  }
  try {
    setPassword(me.id, next);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof UserError ? err.message : String(err) });
  }
});

// ── Admin-only user management ───────────────────────────────────────────────

usersRouter.get("/api/users", adminUserLimiter, requireAdmin, (_req, res) => {
  res.json({ users: listUsers(), permissionCatalog: FEATURE_PERMISSION_CATALOG });
});

usersRouter.post("/api/users", adminUserLimiter, requireAdmin, (req, res) => {
  const username = (req.body?.username ?? "").toString();
  const password = (req.body?.password ?? "").toString();
  const name = (req.body?.name ?? "").toString();
  const firstName = (req.body?.firstName ?? req.body?.first_name ?? "").toString();
  const lastName = (req.body?.lastName ?? req.body?.last_name ?? "").toString();
  const email = (req.body?.email ?? "").toString();
  const role: Role = req.body?.role === "admin" ? "admin" : "user";
  try {
    const user = createUser({ username, password, name, firstName, lastName, email, role, permissions: req.body?.permissions });
    res.json({ ok: true, user });
  } catch (err) {
    res.status(400).json({ error: err instanceof UserError ? err.message : String(err) });
  }
});

/** Admin: reset another user's password (no current-password needed). */
usersRouter.post("/api/users/:id/password", adminUserLimiter, requireAdmin, (req, res) => {
  const target = getUser(req.params.id);
  if (!target) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  try {
    setPassword(target.id, (req.body?.password ?? "").toString());
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof UserError ? err.message : String(err) });
  }
});

/** Admin: enable/disable a user, or change their role. */
usersRouter.patch("/api/users/:id", adminUserLimiter, requireAdmin, (req, res) => {
  const me = req.authUser!;
  const target = getUser(req.params.id);
  if (!target) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  if (target.id === me.id && (req.body?.disabled === true || req.body?.role === "user")) {
    res.status(400).json({ error: "you can't lock yourself out of admin" });
    return;
  }
  if (
    req.body?.firstName !== undefined || req.body?.first_name !== undefined ||
    req.body?.lastName !== undefined || req.body?.last_name !== undefined ||
    req.body?.username !== undefined || req.body?.email !== undefined
  ) {
    try {
      setIdentity(target.id, {
        firstName: req.body?.firstName ?? req.body?.first_name,
        lastName: req.body?.lastName ?? req.body?.last_name,
        username: req.body?.username,
        email: req.body?.email,
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof UserError ? err.message : String(err) });
      return;
    }
  }
  if (typeof req.body?.disabled === "boolean") setDisabled(target.id, req.body.disabled);
  if (req.body?.role === "admin" || req.body?.role === "user") setRole(target.id, req.body.role);
  if (Array.isArray(req.body?.permissions)) setPermissions(target.id, req.body.permissions);
  res.json({ ok: true, user: getUser(target.id) });
});
