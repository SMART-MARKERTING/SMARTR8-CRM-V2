import { Router } from "express";

export const providerRouter = Router();

/**
 * The retired GHL conversation-provider delivery bridge used to accept an
 * unauthenticated recipient and message body, then invoke the live outbound
 * provider router. Keep a deterministic tombstone so every historical mount
 * alias is safe while provider dashboards are cleaned up.
 *
 * This handler deliberately does not read or log the request body and this
 * router is mounted before body parsing in index.ts.
 */
providerRouter.all("/messages", (_req, res) => {
  res.status(410).json({ error: "gone" });
});
