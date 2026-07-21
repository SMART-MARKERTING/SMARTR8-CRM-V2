import crypto from "crypto";
import { db } from "../store/db";
import { config } from "../config";
import { log } from "../logger";
import { parseStoredPermissions, serializePermissions } from "./permissions";

/**
 * Multi-user accounts + sessions. Passwords are scrypt-hashed with a per-user salt (no extra
 * deps, matching the rest of the service). Sessions are opaque bearer tokens stored in the DB
 * and sent as the `x-session-token` header. Roles: 'admin' sees/manages everything; 'user'
 * sees only the leads assigned to them.
 */

export type Role = "admin" | "user";

export interface User {
  id: string;
  username: string;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  role: Role;
  permissions: string[];
  disabled: boolean;
  created_at: number;
}

interface UserRow {
  id: string;
  username: string;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  role: string;
  password_hash: string;
  password_salt: string;
  permissions: string | null;
  disabled: number;
  created_at: number;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function toUser(r: UserRow): User {
  return {
    id: r.id,
    username: r.username,
    name: r.name,
    first_name: r.first_name,
    last_name: r.last_name,
    email: r.email,
    role: r.role === "admin" ? "admin" : "user",
    permissions: parseStoredPermissions(r.permissions, r.role),
    disabled: !!r.disabled,
    created_at: r.created_at,
  };
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

/** Constant-time compare of two hex hashes. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export function userCount(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n;
}

export function listUsers(): User[] {
  return (db.prepare(`SELECT * FROM users ORDER BY created_at ASC`).all() as UserRow[]).map(toUser);
}

export function getUser(id: string): User | null {
  const r = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined;
  return r ? toUser(r) : null;
}

function getUserRowByUsername(username: string): UserRow | undefined {
  return db.prepare(`SELECT * FROM users WHERE username = ? COLLATE NOCASE`).get(username) as UserRow | undefined;
}

export function getUserByEmail(email: string): User | null {
  const value = String(email || "").trim();
  if (!value) return null;
  const row = db.prepare(`SELECT * FROM users WHERE email = ? COLLATE NOCASE`).get(value) as UserRow | undefined;
  return row ? toUser(row) : null;
}

/** First admin (oldest) — the owner of unassigned leads / legacy-passcode sessions. */
export function primaryAdmin(): User | null {
  const r = db.prepare(`SELECT * FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1`).get() as UserRow | undefined;
  return r ? toUser(r) : null;
}

export class UserError extends Error {}

function cleanPersonName(value: unknown): string {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function accountLocalPart(firstName: string, lastName: string): string {
  const first = firstName.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]/g, "");
  const last = lastName.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]/g, "");
  if (!first || !last) return "";
  return `${first[0]}${last}`.toLowerCase().slice(0, 64);
}

function validUsername(value: string): boolean {
  return /^[A-Za-z0-9._-]{2,80}$/.test(value);
}

function validEmail(value: string): boolean {
  const at = value.indexOf("@");
  return at > 0 && at === value.lastIndexOf("@") && value.slice(at + 1).includes(".") && !/\s/.test(value);
}

function splitLegacyName(value: string): { firstName: string; lastName: string } {
  const parts = cleanPersonName(value).split(" ").filter(Boolean);
  return { firstName: parts.shift() || "", lastName: parts.join(" ") };
}

export function generatedUserIdentity(firstName: string, lastName: string): { username: string; email: string; name: string } {
  const first = cleanPersonName(firstName);
  const last = cleanPersonName(lastName);
  const username = accountLocalPart(first, last);
  if (!first || !last || !username) throw new UserError("first and last name are required");
  return {
    username,
    email: `${username}@${config.email.userDomain || "smartr8.com"}`,
    name: `${first} ${last}`,
  };
}

function ensureIdentityAvailable(username: string, email: string, exceptUserId = ""): void {
  const usernameRow = getUserRowByUsername(username);
  if (usernameRow && usernameRow.id !== exceptUserId) throw new UserError("that username is taken");
  const emailRow = db.prepare(`SELECT id FROM users WHERE email = ? COLLATE NOCASE`).get(email) as { id: string } | undefined;
  if (emailRow && emailRow.id !== exceptUserId) throw new UserError("that email address is taken");
}

export function createUser(opts: {
  username?: string;
  password: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  role?: Role;
  permissions?: unknown;
}): User {
  const legacy = splitLegacyName(opts.name || "");
  const firstName = cleanPersonName(opts.firstName || legacy.firstName);
  const lastName = cleanPersonName(opts.lastName || legacy.lastName);
  const generated = firstName && lastName ? generatedUserIdentity(firstName, lastName) : null;
  const username = String(opts.username || generated?.username || "").trim().toLowerCase();
  const email = String(opts.email || generated?.email || "").trim().toLowerCase();
  if (!username) throw new UserError("username is required");
  if (!validUsername(username)) throw new UserError("username can use letters, numbers, dots, dashes, and underscores");
  if (email && !validEmail(email)) throw new UserError("enter a valid email address");
  if (!opts.password || opts.password.length < 12) throw new UserError("password must be at least 12 characters");
  ensureIdentityAvailable(username, email);
  const id = crypto.randomUUID();
  const salt = crypto.randomBytes(16).toString("hex");
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (id, username, name, first_name, last_name, email, role, password_hash, password_salt, permissions, disabled, created_at)
     VALUES (@id, @username, @name, @firstName, @lastName, @email, @role, @hash, @salt, @permissions, 0, @now)`,
  ).run({
    id,
    username,
    name: generated?.name || cleanPersonName(opts.name) || null,
    firstName: firstName || null,
    lastName: lastName || null,
    email: email || null,
    role: opts.role === "admin" ? "admin" : "user",
    hash: hashPassword(opts.password, salt),
    salt,
    permissions: opts.role === "admin" || opts.permissions === undefined ? null : serializePermissions(opts.permissions),
    now,
  });
  log.info("user created", { id, username, role: opts.role ?? "user" });
  return getUser(id)!;
}

export function setIdentity(userId: string, input: {
  firstName?: string;
  lastName?: string;
  username?: string;
  email?: string;
}): User {
  const current = getUser(userId);
  if (!current) throw new UserError("user not found");
  const firstName = cleanPersonName(input.firstName ?? current.first_name ?? "");
  const lastName = cleanPersonName(input.lastName ?? current.last_name ?? "");
  const generated = generatedUserIdentity(firstName, lastName);
  const username = String(input.username || generated.username).trim().toLowerCase();
  const email = String(input.email || generated.email).trim().toLowerCase();
  if (current.username.toLowerCase() === "admin" && username !== "admin") {
    throw new UserError("the super admin username cannot be changed");
  }
  if (!validUsername(username)) throw new UserError("username can use letters, numbers, dots, dashes, and underscores");
  if (!validEmail(email)) throw new UserError("enter a valid email address");
  ensureIdentityAvailable(username, email, userId);
  db.prepare(`UPDATE users SET username = ?, name = ?, first_name = ?, last_name = ?, email = ? WHERE id = ?`).run(
    username,
    `${firstName} ${lastName}`,
    firstName,
    lastName,
    email,
    userId,
  );
  log.info("user identity updated", { id: userId, username, email });
  return getUser(userId)!;
}

export function setPassword(userId: string, password: string): void {
  if (!password || password.length < 12) throw new UserError("password must be at least 12 characters");
  const salt = crypto.randomBytes(16).toString("hex");
  db.prepare(`UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?`).run(hashPassword(password, salt), salt, userId);
}

export function setDisabled(userId: string, disabled: boolean): void {
  db.prepare(`UPDATE users SET disabled = ? WHERE id = ?`).run(disabled ? 1 : 0, userId);
  if (disabled) db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId); // kill active logins
}

export function setRole(userId: string, role: Role): void {
  db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(role === "admin" ? "admin" : "user", userId);
}

export function setPermissions(userId: string, permissions: unknown): void {
  db.prepare(`UPDATE users SET permissions = ? WHERE id = ?`).run(serializePermissions(permissions), userId);
}

/** Verify username + password; returns the user or null. */
export function verifyLogin(username: string, password: string): User | null {
  const r = getUserRowByUsername((username || "").trim());
  if (!r || r.disabled) return null;
  if (!safeEqual(r.password_hash, hashPassword(password, r.password_salt))) return null;
  return toUser(r);
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export function createSession(userId: string): string {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  db.prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).run(
    token,
    userId,
    now,
    now + SESSION_TTL_MS,
  );
  return token;
}

export function isSuperAdmin(user: User | null | undefined): boolean {
  return Boolean(user && user.role === "admin" && user.username.trim().toLowerCase() === "admin");
}

export interface SessionContext {
  user: User;
  impersonator: User | null;
}

export function getSessionContext(token: string): SessionContext | null {
  if (!token) return null;
  const s = db.prepare(`SELECT user_id, impersonator_user_id, expires_at FROM sessions WHERE token = ?`).get(token) as
    | { user_id: string; impersonator_user_id: string | null; expires_at: number }
    | undefined;
  if (!s) return null;
  if (s.expires_at < Date.now()) {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
    return null;
  }
  const user = getUser(s.user_id);
  if (!user || user.disabled) return null;
  const impersonator = s.impersonator_user_id ? getUser(s.impersonator_user_id) : null;
  if (s.impersonator_user_id && (!impersonator || impersonator.disabled || !isSuperAdmin(impersonator))) return null;
  return { user, impersonator };
}

export function getSessionUser(token: string): User | null {
  return getSessionContext(token)?.user || null;
}

export function startSessionImpersonation(token: string, adminUserId: string, targetUserId: string): SessionContext {
  if (!token) throw new UserError("administrator session required");
  const context = getSessionContext(token);
  if (!context || context.impersonator || context.user.id !== adminUserId || !isSuperAdmin(context.user)) {
    throw new UserError("active administrator session required");
  }
  const target = getUser(targetUserId);
  if (!target || target.disabled) throw new UserError("user is unavailable");
  if (target.id === adminUserId) throw new UserError("you are already viewing your own account");
  if (target.role === "admin") throw new UserError("choose a general user account");
  const result = db.prepare(
    `UPDATE sessions
     SET user_id = ?, impersonator_user_id = ?, portal_verified_until = NULL
     WHERE token = ? AND user_id = ? AND impersonator_user_id IS NULL`,
  ).run(target.id, adminUserId, token, adminUserId);
  if (result.changes !== 1) throw new UserError("could not start user view");
  return { user: target, impersonator: context.user };
}

export function stopSessionImpersonation(token: string): SessionContext {
  if (!token) throw new UserError("impersonated session required");
  const row = db.prepare(`SELECT impersonator_user_id FROM sessions WHERE token = ?`).get(token) as
    | { impersonator_user_id: string | null }
    | undefined;
  const admin = row?.impersonator_user_id ? getUser(row.impersonator_user_id) : null;
  if (!admin || admin.disabled || !isSuperAdmin(admin)) throw new UserError("impersonated session is unavailable");
  const result = db.prepare(
    `UPDATE sessions
     SET user_id = ?, impersonator_user_id = NULL, portal_verified_until = NULL
     WHERE token = ? AND impersonator_user_id = ?`,
  ).run(admin.id, token, admin.id);
  if (result.changes !== 1) throw new UserError("could not restore administrator account");
  return { user: admin, impersonator: null };
}

export function deleteSession(token: string): void {
  if (token) db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

export function markSessionPortalVerified(token: string, verifiedUntil: number): void {
  if (!token) return;
  db.prepare(`UPDATE sessions SET portal_verified_until = ? WHERE token = ?`).run(verifiedUntil, token);
}

export function isSessionPortalVerified(token: string | undefined): boolean {
  if (!token) return false;
  const row = db.prepare(`SELECT expires_at, portal_verified_until FROM sessions WHERE token = ?`).get(token) as
    | { expires_at: number; portal_verified_until: number | null }
    | undefined;
  if (!row || row.expires_at < Date.now()) return false;
  return Boolean(row.portal_verified_until && row.portal_verified_until > Date.now());
}

/**
 * Bootstrap: if there are no users yet, seed the first admin from APP_PASSCODE (username
 * "admin", password = the passcode) so the owner isn't locked out on first deploy. Existing
 * records remain unassigned until the super admin explicitly assigns them.
 * the passcode also still works as a break-glass admin login (resolves to this admin).
 */
export function seedAdminIfEmpty(): void {
  if (userCount() > 0) return;
  const pass = config.app.passcode;
  if (!pass) {
    log.warn("auth: no users and no APP_PASSCODE — set APP_PASSCODE once to seed the first admin");
    return;
  }
  const admin = createUser({ username: "admin", password: pass, name: "Admin", role: "admin" });
  log.info("auth: seeded first admin from APP_PASSCODE", { adminId: admin.id });
}

/** Resolve the legacy APP_PASSCODE to the primary admin user (break-glass login). */
export function adminFromPasscode(provided: string | undefined): User | null {
  if (!provided || !config.app.passcode || provided !== config.app.passcode) return null;
  return primaryAdmin();
}
