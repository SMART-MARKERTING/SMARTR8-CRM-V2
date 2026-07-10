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
  role: Role;
  permissions: string[];
  disabled: boolean;
  created_at: number;
}

interface UserRow {
  id: string;
  username: string;
  name: string | null;
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

/** First admin (oldest) — the owner of unassigned leads / legacy-passcode sessions. */
export function primaryAdmin(): User | null {
  const r = db.prepare(`SELECT * FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1`).get() as UserRow | undefined;
  return r ? toUser(r) : null;
}

export class UserError extends Error {}

export function createUser(opts: { username: string; password: string; name?: string; role?: Role; permissions?: unknown }): User {
  const username = opts.username.trim();
  if (!username) throw new UserError("username is required");
  if (!opts.password || opts.password.length < 6) throw new UserError("password must be at least 6 characters");
  if (getUserRowByUsername(username)) throw new UserError("that username is taken");
  const id = crypto.randomUUID();
  const salt = crypto.randomBytes(16).toString("hex");
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (id, username, name, role, password_hash, password_salt, permissions, disabled, created_at)
     VALUES (@id, @username, @name, @role, @hash, @salt, @permissions, 0, @now)`,
  ).run({
    id,
    username,
    name: opts.name?.trim() || null,
    role: opts.role === "admin" ? "admin" : "user",
    hash: hashPassword(opts.password, salt),
    salt,
    permissions: opts.role === "admin" || opts.permissions === undefined ? null : serializePermissions(opts.permissions),
    now,
  });
  log.info("user created", { id, username, role: opts.role ?? "user" });
  return getUser(id)!;
}

export function setPassword(userId: string, password: string): void {
  if (!password || password.length < 6) throw new UserError("password must be at least 6 characters");
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

export function getSessionUser(token: string): User | null {
  if (!token) return null;
  const s = db.prepare(`SELECT user_id, expires_at FROM sessions WHERE token = ?`).get(token) as
    | { user_id: string; expires_at: number }
    | undefined;
  if (!s) return null;
  if (s.expires_at < Date.now()) {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
    return null;
  }
  const u = getUser(s.user_id);
  return u && !u.disabled ? u : null;
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
 * "admin", password = the passcode) so the owner isn't locked out on first deploy — then
 * assign every existing lead to that admin. After this the console uses per-user logins;
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
  const r = db.prepare(`UPDATE leads SET owner_user_id = ? WHERE owner_user_id IS NULL`).run(admin.id);
  log.info("auth: seeded first admin from APP_PASSCODE and assigned existing leads", { adminId: admin.id, leads: r.changes });
}

/** Resolve the legacy APP_PASSCODE to the primary admin user (break-glass login). */
export function adminFromPasscode(provided: string | undefined): User | null {
  if (!provided || !config.app.passcode || provided !== config.app.passcode) return null;
  return primaryAdmin();
}
