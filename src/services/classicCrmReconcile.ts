import { config } from "../config";
import { log } from "../logger";
import { getMeta, setMeta } from "../store/db";
import { applyLegacyCrmSync, LegacyCrmSyncPayload } from "./legacyCrmSync";

interface SyncCursor {
  updatedAt: number;
  id: string;
}

interface ExportPage {
  ok?: boolean;
  items?: LegacyCrmSyncPayload[];
  nextCursor?: SyncCursor;
  hasMore?: boolean;
}

export interface ReconcileStatus {
  running: boolean;
  status: string;
  startedAt?: number;
  updatedAt?: number;
  finishedAt?: number;
  cursor?: SyncCursor;
  scanned?: number;
  applied?: number;
  stale?: number;
  duplicates?: number;
  notes?: number;
  activities?: number;
  pages?: number;
  error?: string;
}

const CURSOR_KEY = "classic_crm_reconcile_cursor_v1";
const STATUS_KEY = "classic_crm_reconcile_status_v1";
let running = false;
let pollerStarted = false;

function configured(): boolean {
  return Boolean(config.crm.legacyReconcileUrl && config.crm.legacyOutboundSyncSecret);
}

function readJson<T>(key: string, fallback: T): T {
  const raw = getMeta(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeStatus(status: ReconcileStatus): void {
  setMeta(STATUS_KEY, JSON.stringify(status));
}

export function getClassicCrmReconcileStatus(): ReconcileStatus & { configured: boolean; source: string } {
  return {
    ...readJson<ReconcileStatus>(STATUS_KEY, { running: false, status: "never_run" }),
    running,
    configured: configured(),
    source: config.crm.legacyReconcileUrl,
  };
}

function exportUrl(cursor: SyncCursor): string {
  const url = new URL(config.crm.legacyReconcileUrl);
  url.searchParams.set("updatedAt", String(cursor.updatedAt));
  url.searchParams.set("id", cursor.id);
  url.searchParams.set("limit", String(Math.max(1, Math.min(config.crm.legacyReconcileBatchSize || 50, 100))));
  return url.toString();
}

async function fetchPage(cursor: SyncCursor): Promise<ExportPage> {
  const response = await fetch(exportUrl(cursor), {
    headers: {
      "x-crm-sync-secret": config.crm.legacyOutboundSyncSecret,
      "x-v2-sync-secret": config.crm.legacyOutboundSyncSecret,
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Classic CRM export ${response.status}: ${detail.slice(0, 300)}`);
  }
  return await response.json() as ExportPage;
}

export async function runClassicCrmReconciliation(opts: { full?: boolean; maxPages?: number } = {}): Promise<ReconcileStatus> {
  if (!configured()) {
    const status: ReconcileStatus = { running: false, status: "not_configured", error: "Classic CRM sync URL or secret is missing" };
    writeStatus(status);
    return status;
  }
  if (running) return getClassicCrmReconcileStatus();
  running = true;
  const startedAt = Date.now();
  let cursor = opts.full ? { updatedAt: 0, id: "" } : readJson<SyncCursor>(CURSOR_KEY, { updatedAt: 0, id: "" });
  let scanned = 0;
  let applied = 0;
  let stale = 0;
  let duplicates = 0;
  let notes = 0;
  let activities = 0;
  let pages = 0;
  const maxPages = Math.max(1, Math.min(opts.maxPages || (opts.full ? 10000 : 20), 10000));
  writeStatus({ running: true, status: opts.full ? "full_reconciliation" : "incremental_reconciliation", startedAt, cursor });
  try {
    while (pages < maxPages) {
      const page = await fetchPage(cursor);
      const items = Array.isArray(page.items) ? page.items : [];
      for (const payload of items) {
        const result = applyLegacyCrmSync(payload);
        scanned++;
        if (result.duplicate) duplicates++;
        else if (result.leadApplied) applied++;
        else stale++;
        notes += result.notesUpserted;
        activities += result.activitiesUpserted;
      }
      pages++;
      const next = page.nextCursor;
      if (next && (next.updatedAt > cursor.updatedAt || next.id !== cursor.id)) {
        cursor = { updatedAt: Math.max(0, Number(next.updatedAt) || 0), id: String(next.id || "") };
        setMeta(CURSOR_KEY, JSON.stringify(cursor));
      }
      writeStatus({
        running: true,
        status: opts.full ? "full_reconciliation" : "incremental_reconciliation",
        startedAt,
        updatedAt: Date.now(),
        cursor,
        scanned,
        applied,
        stale,
        duplicates,
        notes,
        activities,
        pages,
      });
      if (!page.hasMore || !items.length) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const status: ReconcileStatus = {
      running: false,
      status: "complete",
      startedAt,
      finishedAt: Date.now(),
      cursor,
      scanned,
      applied,
      stale,
      duplicates,
      notes,
      activities,
      pages,
    };
    writeStatus(status);
    log.info("Classic CRM reconciliation complete", status);
    return status;
  } catch (err) {
    const status: ReconcileStatus = {
      running: false,
      status: "error",
      startedAt,
      finishedAt: Date.now(),
      cursor,
      scanned,
      applied,
      stale,
      duplicates,
      notes,
      activities,
      pages,
      error: String(err),
    };
    writeStatus(status);
    log.warn("Classic CRM reconciliation failed", status);
    return status;
  } finally {
    running = false;
  }
}

export function startClassicCrmReconcileWorker(): void {
  if (pollerStarted) return;
  pollerStarted = true;
  const interval = Math.max(30_000, Math.min(config.crm.legacyReconcileIntervalMs || 60_000, 60 * 60_000));
  const delay = Math.max(0, Math.min(config.crm.legacyReconcileStartDelayMs || 15_000, 5 * 60_000));
  setTimeout(() => {
    void runClassicCrmReconciliation({ maxPages: 10000 });
    setInterval(() => void runClassicCrmReconciliation(), interval).unref();
  }, delay).unref();
}
