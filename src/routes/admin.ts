import { Router } from "express";
import { config } from "../config";
import { log } from "../logger";
import { requireAdmin } from "../util/auth";

export const adminRouter = Router();

const RENDER_API = "https://api.render.com/v1";

/**
 * What commit is actually running, and (if RENDER_API_TOKEN + RENDER_SERVICE_ID are
 * set) the latest deploy's status. Lets us see from the browser whether a push has
 * gone live without digging through the Render dashboard.
 */
adminRouter.get("/admin/deploy", requireAdmin, async (_req, res) => {
  const out: Record<string, unknown> = {
    runningCommit: config.render.gitCommit || "(RENDER_GIT_COMMIT not set)",
    hasApiToken: Boolean(config.render.apiToken),
    serviceId: config.render.serviceId || "(RENDER_SERVICE_ID not set)",
  };
  if (config.render.apiToken && config.render.serviceId) {
    try {
      const r = await fetch(`${RENDER_API}/services/${config.render.serviceId}/deploys?limit=3`, {
        headers: { Authorization: `Bearer ${config.render.apiToken}`, Accept: "application/json" },
      });
      const raw = await r.text().catch(() => "");
      if (r.ok) {
        const list = JSON.parse(raw) as Array<{ deploy?: { id?: string; status?: string; commit?: { id?: string; message?: string } } }>;
        out.recentDeploys = list.map((d) => ({
          id: d.deploy?.id,
          status: d.deploy?.status,
          commit: d.deploy?.commit?.id?.slice(0, 7),
          message: d.deploy?.commit?.message?.split("\n")[0],
        }));
      } else {
        out.deployError = `${r.status}: ${raw.slice(0, 200)}`;
      }
    } catch (err) {
      out.deployError = String(err);
    }
  }
  res.json(out);
});

/** Trigger a fresh deploy of the latest commit (clears build cache off). */
adminRouter.post("/admin/redeploy", requireAdmin, async (_req, res) => {
  if (!config.render.apiToken || !config.render.serviceId) {
    res.status(503).json({ error: "RENDER_API_TOKEN / RENDER_SERVICE_ID not set" });
    return;
  }
  try {
    const r = await fetch(`${RENDER_API}/services/${config.render.serviceId}/deploys`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.render.apiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ clearCache: "do_not_clear" }),
    });
    const raw = await r.text().catch(() => "");
    if (!r.ok) {
      res.status(502).json({ error: `${r.status}: ${raw.slice(0, 300)}` });
      return;
    }
    const d = JSON.parse(raw) as { id?: string; status?: string; commit?: { id?: string } };
    log.info("triggered Render redeploy", { id: d.id, commit: d.commit?.id });
    res.json({ ok: true, deployId: d.id, status: d.status, commit: d.commit?.id?.slice(0, 7) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
