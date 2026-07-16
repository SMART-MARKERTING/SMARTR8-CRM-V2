import express from "express";
import path from "path";
import { config, reportMissingConfig } from "./config";
import { log } from "./logger";
import { ping } from "./services/bluebubbles";
import { oauthRouter } from "./routes/oauth";
import { providerRouter } from "./routes/provider";
import { webhooksRouter } from "./routes/webhooks";
import { voiceRouter } from "./routes/voice";
import { appRouter } from "./routes/app";
import { ghlWorkflowRouter } from "./routes/ghlWorkflow";
import { adminRouter } from "./routes/admin";
import { crmRouter } from "./routes/crm";
import { faxRouter } from "./routes/fax";
import { usersRouter } from "./routes/users";
import { pushRouter } from "./routes/push";
import { productionSafetyRouter } from "./routes/productionSafety";
import { startCallNowPoller } from "./services/callNowPoller";
import { seedCampaigns, startAutomationWorker } from "./services/automations";
import { seedAdminIfEmpty } from "./services/auth";
import { handleResendInboundWebhook } from "./services/resendInbound";
import { db } from "./store/db";
import { startClassicCrmReconcileWorker } from "./services/classicCrmReconcile";
import { startNotificationWorker, stopNotificationWorker } from "./services/notificationWorker";

const app = express();
const publicDir = path.resolve(process.cwd(), "public");
app.set("trust proxy", true); // behind Render's proxy: req.protocol reflects https (for media URLs)
app.use((_req, res, next) => {
  // Practical baseline for the current inline-script console. Tighten CSP once
  // public/*.html is moved to bundled assets or nonce-based scripts.
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), geolocation=(), payment=(), usb=(), display-capture=(), microphone=(self)");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://connect.facebook.net",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://www.facebook.com",
      "font-src 'self' data:",
      "connect-src 'self' https://api.telnyx.com https://*.telnyx.com wss://*.telnyx.com",
      "media-src 'self' blob: data:",
      "worker-src 'self'",
      "manifest-src 'self'",
    ].join("; ")
  );
  next();
});
// Security tombstones must run before raw/JSON/urlencoded body parsing. The retired
// GHL bridge and test/simulator routes never inspect or log attacker-controlled bodies.
app.use(productionSafetyRouter);
app.use("/providers/ghl", providerRouter);
app.use("/v2/providers/ghl", providerRouter);
app.post(
  ["/api/webhooks/resend", "/v2/api/webhooks/resend"],
  express.raw({ type: "application/json", limit: "16mb" }),
  handleResendInboundWebhook,
);
app.get(["/api/webhooks/resend", "/v2/api/webhooks/resend"], (_req, res) => {
  res.json({
    ok: true,
    route: "/api/webhooks/resend",
    method: "POST",
    event: "email.received",
    time: new Date().toISOString(),
  });
});
app.use(express.json({
  limit: "16mb",
  verify: (req, _res, buf) => {
    (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
  },
})); // CSV imports post the whole file as JSON — allow large exports
app.use(express.urlencoded({ extended: true }));

app.get(["/health", "/v2/health"], async (_req, res) => {
  // Always 200 so Render keeps the service live; BlueBubbles is reported as a
  // sub-status, never a reason to fail the health check (avoids tunnel-down 502s).
  let bluebubbles = false;
  try {
    bluebubbles = await ping();
  } catch {
    bluebubbles = false;
  }
  let database = false;
  try {
    database = Boolean(db.prepare("SELECT 1 AS ok").get());
  } catch {
    database = false;
  }
  res.status(database ? 200 : 503).json({
    ok: database,
    database,
    bluebubbles,
    time: new Date().toISOString(),
    commit: process.env.RENDER_GIT_COMMIT || process.env.SOURCE_VERSION || null,
  });
});

app.get("/", (_req, res) => {
  res.redirect(302, "/v2/");
});

app.get(["/logo.svg", "/v2/logo.svg"], (_req, res) => {
  res.sendFile(path.join(publicDir, "logo.svg"));
});

function publicStatic() {
  return express.static(publicDir, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".webmanifest")) res.set("Cache-Control", "no-store");
    },
  });
}

app.use("/oauth", oauthRouter);
app.use("/webhooks", webhooksRouter);
app.use(voiceRouter); // /calls/*, /dnc, /webhooks/telnyx-voice
app.use(
  "/public",
  express.static(path.resolve(process.cwd(), "public"), {
    setHeaders: (res, filePath) => {
      // Never cache the PWA manifest: it drives the install start_url/icon, so a stale
      // copy pins an old start_url (e.g. "/app") on phones after we change it. Icons/JS
      // can cache normally.
      if (filePath.endsWith(".webmanifest")) res.set("Cache-Control", "no-store");
    },
  })
);
app.use(appRouter); // /app (softphone UI), /webrtc/token
app.use(ghlWorkflowRouter); // /ghl/workflow/* — GHL custom workflow actions
app.use(adminRouter); // /admin/deploy, /admin/redeploy
app.use(usersRouter); // /api/auth/* (login, me, logout, change-password) + /api/users (admin)
app.use(pushRouter); // authenticated Web Push subscriptions, preferences, receipts, Notification Center
app.use(faxRouter); // /api/fax + /api/webhooks/telnyx/fax
app.use(crmRouter); // /webhooks/lead (intake) + /api/leads, /api/automations

app.use("/v2/oauth", oauthRouter);
app.use("/v2/webhooks", webhooksRouter);
app.use("/v2", voiceRouter);
app.use("/v2/public", publicStatic());
app.use("/v2", appRouter);
app.use("/v2", ghlWorkflowRouter);
app.use("/v2", adminRouter);
app.use("/v2", usersRouter);
app.use("/v2", pushRouter);
app.use("/v2", faxRouter);
app.use("/v2", crmRouter);

app.use((_req, res) => res.status(404).json({ error: "not found" }));

const server = app.listen(config.port, () => {
  log.info(`LoanGenius v2 CRM app listening on :${config.port}`);
  reportMissingConfig((m) => log.warn(m));
  seedAdminIfEmpty(); // one-time: seed the first admin from APP_PASSCODE + assign existing leads
  startCallNowPoller(); // watch GHL for the `call-now` tag → click-to-dial
  seedCampaigns(); // one-time: seed the 5 category nurture campaigns (disabled)
  startAutomationWorker(); // run due CRM automation steps (email/text/voicemail)
  startClassicCrmReconcileWorker(); // continuously repair missed Classic <-> V2 lead changes
  startNotificationWorker(); // deliver durable Web Push outbox rows
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("server shutdown requested", { signal });
  stopNotificationWorker();
  server.close((err) => {
    if (err) log.error("server shutdown error", { error: err.message });
    db.close();
    process.exit(err ? 1 : 0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
