import { Router, type Request, type Response } from "express";

/**
 * Permanent tombstones for historical debug/test actions that could mutate CRM
 * data or reach a live provider. Mount this router before all body parsers so a
 * request is rejected without parsing or logging its payload.
 *
 * These routes are intentionally unavailable in every environment. Local parser
 * and provider behavior is covered with fixtures/mocks instead.
 */
export const productionSafetyRouter = Router();

function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: "not found" });
}

productionSafetyRouter.all(
  [
    "/api/whatsapp/debug/simulate-inbound",
    "/v2/api/whatsapp/debug/simulate-inbound",
    "/api/telnyx/test-send",
    "/v2/api/telnyx/test-send",
  ],
  notFound,
);

productionSafetyRouter.all(["/calls/diag", "/v2/calls/diag"], (req, res, next) => {
  if (req.query.place === "1") {
    notFound(req, res);
    return;
  }
  next();
});
