import type { Env } from "../env";

/** Thrown when the Render proxy is asked to run but isn't configured. */
export class RenderNotConfigured extends Error {}

/** True when both the Render base URL and passcode are present. */
export function renderConfigured(env: Env): boolean {
  return !!(env.RENDER_API_BASE && env.RENDER_APP_PASSCODE);
}

function base(env: Env): string {
  const b = env.RENDER_API_BASE?.replace(/\/+$/, "");
  if (!b || !env.RENDER_APP_PASSCODE) {
    throw new RenderNotConfigured(
      "Render API not configured — set RENDER_API_BASE and RENDER_APP_PASSCODE on the Worker.",
    );
  }
  return b;
}

/** URL-encode a path segment (lead ids, contact ids, etc.). */
export const seg = (s: string): string => encodeURIComponent(s);

async function call(env: Env, method: string, path: string, body?: unknown): Promise<unknown> {
  const url = `${base(env)}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        /* Render's requirePass accepts the passcode via this header. */
        "x-app-passcode": env.RENDER_APP_PASSCODE as string,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      /* leave as text */
    }
    if (!res.ok) {
      const msg = (data as { error?: string } | null)?.error ?? text ?? `HTTP ${res.status}`;
      throw new Error(`Render ${method} ${path} -> ${res.status}: ${msg}`);
    }
    return data;
  } catch (err) {
    if ((err as { name?: string } | null)?.name === "AbortError") {
      throw new Error(`Render ${method} ${path} timed out (is the Render service awake?)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Thin client over the Render console API (passcode-gated). */
export const render = {
  configured: renderConfigured,
  get: (env: Env, path: string) => call(env, "GET", path),
  post: (env: Env, path: string, body?: unknown) => call(env, "POST", path, body ?? {}),
  patch: (env: Env, path: string, body?: unknown) => call(env, "PATCH", path, body ?? {}),
};
