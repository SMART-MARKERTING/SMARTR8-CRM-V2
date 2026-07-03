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
  markSessionPortalVerified,
  seedAdminIfEmpty,
  primaryAdmin,
  UserError,
  Role,
} from "../services/auth";

export const usersRouter = Router();

// Brute-force guard on the unauthenticated login, plus a looser guard on the credential-
// changing endpoints (already auth-gated, but rate-limited too for defense in depth).
const loginLimiter = rateLimit({ name: "login", max: 10, windowMs: 5 * 60_000 });
// Every auth/user route is rate-limited (defense in depth; also satisfies CodeQL's
// "authorization without rate limiting" rule). Login gets an extra, stricter brute-force cap.
usersRouter.use(rateLimit({ name: "users", max: 120, windowMs: 5 * 60_000 }));

/** Sign in with username + password → returns a session token + the user. */
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
  res.json({ ok: true, token, user });
});

/** Who am I (validates the current session). */
usersRouter.get("/api/auth/me", requirePass, (req, res) => {
  res.json({ user: req.authUser });
});

/** Step-up verification for Portal / Apps. Re-checks the signed-in user's password before
 * showing document-sensitive borrower application fields in the console. */
usersRouter.post("/api/auth/portal-verify", requirePass, (req, res) => {
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
usersRouter.post("/api/auth/logout", requirePass, (req, res) => {
  const token =
    req.get("x-session-token") ||
    (req.get("authorization")?.toLowerCase().startsWith("bearer ") ? req.get("authorization")!.slice(7).trim() : "") ||
    (typeof req.body?.token === "string" ? req.body.token : "");
  if (token) deleteSession(token);
  res.json({ ok: true });
});

/** Change MY OWN password (any signed-in user). Requires the current password. */
usersRouter.post("/api/auth/change-password", requirePass, (req, res) => {
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

usersRouter.get("/api/users", requireAdmin, (_req, res) => {
  res.json({ users: listUsers() });
});

usersRouter.post("/api/users", requireAdmin, (req, res) => {
  const username = (req.body?.username ?? "").toString();
  const password = (req.body?.password ?? "").toString();
  const name = (req.body?.name ?? "").toString();
  const role: Role = req.body?.role === "admin" ? "admin" : "user";
  try {
    const user = createUser({ username, password, name, role });
    res.json({ ok: true, user });
  } catch (err) {
    res.status(400).json({ error: err instanceof UserError ? err.message : String(err) });
  }
});

/** Admin: reset another user's password (no current-password needed). */
usersRouter.post("/api/users/:id/password", requireAdmin, (req, res) => {
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
usersRouter.patch("/api/users/:id", requireAdmin, (req, res) => {
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
  if (typeof req.body?.disabled === "boolean") setDisabled(target.id, req.body.disabled);
  if (req.body?.role === "admin" || req.body?.role === "user") setRole(target.id, req.body.role);
  res.json({ ok: true, user: getUser(target.id) });
});
