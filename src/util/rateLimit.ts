import { Request, Response, NextFunction } from "express";

interface Hit {
  count: number;
  resetAt: number;
}

/**
 * Tiny in-memory fixed-window rate limiter, keyed by client IP + a bucket name. Enough to
 * blunt brute-force / abuse on the auth routes (the service runs single-instance on Render,
 * so a shared store isn't needed). Expired buckets are pruned lazily.
 */
export function rateLimit(opts: { name: string; max: number; windowMs: number }) {
  const hits = new Map<string, Hit>();
  return function (req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();
    // Occasional sweep so the map can't grow unbounded across many distinct IPs.
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
    }
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const key = `${opts.name}:${ip}`;
    const h = hits.get(key);
    if (!h || h.resetAt < now) {
      hits.set(key, { count: 1, resetAt: now + opts.windowMs });
    } else {
      h.count++;
      if (h.count > opts.max) {
        res.set("Retry-After", String(Math.ceil((h.resetAt - now) / 1000)));
        res.status(429).json({ error: "too many attempts — try again in a bit" });
        return;
      }
    }
    next();
  };
}
