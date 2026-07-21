import { randomUUID } from "crypto";
import type { Request } from "express";
import { db } from "../store/db";
import type { User } from "./auth";

export interface AuditEvent {
  id: string;
  created_at: number;
  user_id: string | null;
  username: string | null;
  role: string | null;
  ip: string | null;
  method: string;
  path: string;
  action: string;
  status_code: number | null;
  detail: string | null;
  meta: Record<string, unknown>;
}

function clientIp(req: Request): string {
  const forwarded = req.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.ip || req.socket.remoteAddress || "";
}

export function recordAudit(opts: {
  req?: Request;
  user?: User | null;
  action: string;
  detail?: string;
  statusCode?: number;
  meta?: Record<string, unknown>;
}): void {
  const req = opts.req;
  const actingAs = req?.impersonatorUser ? req.authUser || null : null;
  const user = opts.user || req?.impersonatorUser || req?.authUser || null;
  const meta = {
    ...(opts.meta || {}),
    ...(actingAs ? {
      impersonation: {
        acting_as_user_id: actingAs.id,
        acting_as_username: actingAs.username,
      },
    } : {}),
  };
  db.prepare(
    `INSERT INTO audit_events
      (id, created_at, user_id, username, role, ip, method, path, action, status_code, detail, meta)
     VALUES
      (@id, @created_at, @user_id, @username, @role, @ip, @method, @path, @action, @status_code, @detail, @meta)`,
  ).run({
    id: randomUUID(),
    created_at: Date.now(),
    user_id: user?.id ?? null,
    username: user?.username ?? user?.name ?? null,
    role: user?.role ?? null,
    ip: req ? clientIp(req) : null,
    method: req?.method || "SYSTEM",
    path: req?.originalUrl || req?.url || "",
    action: opts.action,
    status_code: opts.statusCode ?? null,
    detail: opts.detail ?? null,
    meta: JSON.stringify(meta),
  });
}

export function listAuditEvents(opts: { limit?: number; q?: string; since?: number } = {}): AuditEvent[] {
  const where = ["1 = 1"];
  const params: Record<string, unknown> = { limit: Math.max(1, Math.min(opts.limit || 250, 1000)) };
  if (opts.since) {
    where.push("created_at >= @since");
    params.since = opts.since;
  }
  if (opts.q) {
    where.push("(LOWER(COALESCE(username,'')) LIKE @q OR LOWER(action) LIKE @q OR LOWER(path) LIKE @q OR LOWER(COALESCE(detail,'')) LIKE @q OR COALESCE(ip,'') LIKE @q)");
    params.q = `%${opts.q.toLowerCase()}%`;
  }
  const rows = db
    .prepare(
      `SELECT * FROM audit_events
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT @limit`,
    )
    .all(params) as Array<Omit<AuditEvent, "meta"> & { meta: string }>;
  return rows.map((row) => {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(row.meta || "{}") as Record<string, unknown>;
    } catch {
      meta = { raw: row.meta };
    }
    return { ...row, meta };
  });
}
