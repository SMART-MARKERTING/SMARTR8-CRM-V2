import { db } from "../store/db";
import { log } from "../logger";
import { isPipelineStage } from "../pipeline";

/**
 * Emergency cleanup for a bad bulk import: it lets the operator (1) see leads grouped by
 * source, (2) soft-delete the leads a CSV import CREATED today, and (3) revert the
 * status/stage/past-client changes that the same import made to PRE-EXISTING real leads
 * (website/manual) it matched by phone/email.
 *
 * Why source is a safe discriminator: the importer only ever writes `source` on a NEW
 * lead (the CSV's source — "import", "past-fundings", a list filename, …). When it matches
 * an existing lead it updates status/tags/custom but never touches `source`, so genuine
 * website leads keep `source = "website"`. Deleting by source therefore removes only the
 * imported rows and never the real ones. Everything here is soft (reversible from Deleted).
 */

const KNOWN_STATUSES = new Set(["new", "contacted", "qualified", "nurturing", "won", "lost"]);

export interface SourceAudit {
  source: string;
  today: number;
  total: number;
}

/** Leads grouped by source: how many created since `sinceMs` vs total (non-deleted). */
export function auditSources(sinceMs: number): SourceAudit[] {
  return db
    .prepare(
      `SELECT COALESCE(NULLIF(source,''),'(none)') AS source,
              SUM(CASE WHEN created_at >= @since THEN 1 ELSE 0 END) AS today,
              COUNT(*) AS total
         FROM leads
        WHERE deleted_at IS NULL
        GROUP BY COALESCE(NULLIF(source,''),'(none)')
        ORDER BY today DESC, total DESC`,
    )
    .all({ since: sinceMs }) as SourceAudit[];
}

export interface PurgeResult {
  matched: number;
  deleted: number;
  dryRun: boolean;
  bySource: Record<string, number>;
}

/** Soft-delete leads whose source ∈ sources AND created_at ≥ sinceMs. dryRun only counts. */
export function purgeImported(sources: string[], sinceMs: number, dryRun: boolean): PurgeResult {
  if (!sources.length) return { matched: 0, deleted: 0, dryRun, bySource: {} };
  const ph = sources.map((_, i) => `@s${i}`).join(",");
  const params: Record<string, unknown> = { since: sinceMs };
  sources.forEach((s, i) => (params[`s${i}`] = s)); // match the audit's labels (incl. "(none)")
  const rows = db
    .prepare(
      `SELECT id, COALESCE(NULLIF(source,''),'(none)') AS source
         FROM leads
        WHERE deleted_at IS NULL AND created_at >= @since
          AND COALESCE(NULLIF(source,''),'(none)') IN (${ph})`,
    )
    .all(params) as Array<{ id: string; source: string }>;
  const bySource: Record<string, number> = {};
  for (const r of rows) bySource[r.source] = (bySource[r.source] || 0) + 1;
  if (!dryRun && rows.length) {
    const now = Date.now();
    const del = db.prepare(`UPDATE leads SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL`);
    const skip = db.prepare(
      `UPDATE automation_jobs SET status='skipped', last_error='import cleanup', updated_at=? WHERE lead_id=? AND status='pending'`,
    );
    const tx = db.transaction((items: Array<{ id: string }>) => {
      for (const it of items) {
        skip.run(now, it.id);
        del.run(now, now, it.id);
      }
    });
    tx(rows);
    log.warn("import cleanup: soft-deleted imported leads", { count: rows.length, sources });
  }
  return { matched: rows.length, deleted: dryRun ? 0 : rows.length, dryRun, bySource };
}

export interface RevertChange {
  id: string;
  name: string;
  statusFrom?: string;
  stageFrom?: string;
  removedPastClient?: boolean;
}
export interface RevertResult {
  scanned: number;
  reverted: number;
  dryRun: boolean;
  changes: RevertChange[];
}

/** Parse "Label: OLD → NEW" → { from, to } (arrow = U+2192, as written by updateLead). */
function parseChange(body: string | null): { from: string; to: string } | null {
  if (!body) return null;
  const m = body.replace(/^[^:]*:\s*/, "").split("→");
  if (m.length !== 2) return null;
  return { from: m[0].trim(), to: m[1].trim() };
}

/**
 * Undo the import's damage to PRE-EXISTING real leads (source NOT in importSources) that it
 * touched since `sinceMs`: restore status (if the import flipped it to nurturing/won) and
 * pipeline_stage (if it flipped to Funded) to the pre-change value recorded on the timeline,
 * and drop a `past-client` tag/flag the import added. Direct SQL (no re-trigger / re-log).
 */
export function revertImportDamage(sinceMs: number, importSources: string[], dryRun: boolean): RevertResult {
  const ph = importSources.length ? importSources.map((_, i) => `@s${i}`).join(",") : "''";
  const params: Record<string, unknown> = { since: sinceMs };
  importSources.forEach((s, i) => (params[`s${i}`] = s));
  const leads = db
    .prepare(
      `SELECT id, first_name, last_name, email, phone, status, pipeline_stage, tags, past_client
         FROM leads
        WHERE deleted_at IS NULL AND updated_at >= @since
          AND COALESCE(NULLIF(source,''),'(none)') NOT IN (${ph})`,
    )
    .all(params) as Array<{
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
    status: string;
    pipeline_stage: string;
    tags: string;
    past_client: number;
  }>;

  const firstStatus = db.prepare(
    `SELECT body FROM activities WHERE lead_id=? AND type='status_change' AND created_at>=? ORDER BY created_at ASC LIMIT 1`,
  );
  const firstStage = db.prepare(
    `SELECT body FROM activities WHERE lead_id=? AND type='stage_change' AND created_at>=? ORDER BY created_at ASC LIMIT 1`,
  );
  const taggedPast = db.prepare(
    `SELECT 1 FROM activities WHERE lead_id=? AND type='tag' AND body='Tagged: past-client' AND created_at>=? LIMIT 1`,
  );
  const setStatus = db.prepare(`UPDATE leads SET status=?, updated_at=? WHERE id=?`);
  const setStage = db.prepare(`UPDATE leads SET pipeline_stage=?, updated_at=? WHERE id=?`);
  const setTagsPast = db.prepare(`UPDATE leads SET tags=?, past_client=?, updated_at=? WHERE id=?`);

  const changes: RevertChange[] = [];
  for (const l of leads) {
    const chg: RevertChange = { id: l.id, name: [l.first_name, l.last_name].filter(Boolean).join(" ") || l.email || l.phone || "(no name)" };
    let touched = false;

    // Status: only undo if the import flipped it to nurturing/won and it still holds that value.
    if (l.status === "nurturing" || l.status === "won") {
      const sc = parseChange((firstStatus.get(l.id, sinceMs) as { body: string } | undefined)?.body ?? null);
      if (sc && sc.to === l.status && KNOWN_STATUSES.has(sc.from) && sc.from !== l.status) {
        chg.statusFrom = sc.from;
        touched = true;
        if (!dryRun) setStatus.run(sc.from, Date.now(), l.id);
      }
    }
    // Stage: only undo a flip to Funded.
    if (l.pipeline_stage === "Funded") {
      const st = parseChange((firstStage.get(l.id, sinceMs) as { body: string } | undefined)?.body ?? null);
      if (st && st.to === l.pipeline_stage && isPipelineStage(st.from) && st.from !== l.pipeline_stage) {
        chg.stageFrom = st.from;
        touched = true;
        if (!dryRun) setStage.run(st.from, Date.now(), l.id);
      }
    }
    // Past-client tag/flag added today → remove.
    if (l.past_client && taggedPast.get(l.id, sinceMs)) {
      const tags = (() => {
        try {
          return (JSON.parse(l.tags) as string[]).filter((t) => t !== "past-client");
        } catch {
          return [] as string[];
        }
      })();
      chg.removedPastClient = true;
      touched = true;
      if (!dryRun) setTagsPast.run(JSON.stringify(tags), 0, Date.now(), l.id);
    }

    if (touched) changes.push(chg);
  }
  if (!dryRun && changes.length) log.warn("import cleanup: reverted changes on real leads", { count: changes.length });
  return { scanned: leads.length, reverted: changes.length, dryRun, changes };
}

// ── Duplicate contact merge-dedupe ───────────────────────────────────────────

interface DedupeRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  tags: string;
  custom: string;
  owner_user_id: string | null;
  contact_only: number;
  created_at: number;
  last_activity_at: number | null;
  acts: number;
  notes: number;
  filled: number;
}

export interface DedupeResult {
  dryRun: boolean;
  scanned: number;
  groups: number; // duplicate groups found
  duplicates: number; // extra records beyond one-per-group (candidates to remove)
  removed: number; // actually soft-deleted (0 on dry run)
  skippedNoKey: number; // records with neither phone nor email (can't be matched)
  sample: Array<{ key: string; keep: string; keepName: string; remove: string[] }>;
}

/** Last-10-digit phone key (matches numbers that differ only by formatting/country code). */
function phoneKey(p: string | null): string {
  const d = String(p || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
}

/**
 * Merge-dedupe duplicate contacts. Records are grouped by phone (last 10 digits) or, when
 * there's no phone, by lowercased email. In each group the "richest" record is KEPT and the
 * others are merged into it — their notes, activities, and automation jobs are reassigned to
 * the keeper and their tags unioned in — then soft-deleted (reversible from the Deleted view).
 * Records with neither phone nor email are left alone (can't match safely). dryRun only counts.
 */
export function dedupeContacts(dryRun: boolean): DedupeResult {
  const rows = db
    .prepare(
      `SELECT l.id, l.first_name, l.last_name, l.email, l.phone, l.tags, l.custom, l.owner_user_id,
              l.contact_only, l.created_at, l.last_activity_at,
              (SELECT COUNT(*) FROM activities a WHERE a.lead_id = l.id) AS acts,
              (SELECT COUNT(*) FROM notes n WHERE n.lead_id = l.id) AS notes,
              ((l.first_name IS NOT NULL AND l.first_name<>'') + (l.last_name IS NOT NULL AND l.last_name<>'')
               + (l.email IS NOT NULL AND l.email<>'') + (l.phone IS NOT NULL AND l.phone<>'')) AS filled
         FROM leads l
        WHERE l.deleted_at IS NULL`,
    )
    .all() as DedupeRow[];

  const keyToIds = new Map<string, Set<string>>();
  const idToRow = new Map(rows.map((r) => [r.id, r]));
  let skippedNoKey = 0;
  for (const r of rows) {
    const pk = phoneKey(r.phone);
    const keys = [pk ? `p:${pk}` : "", r.email ? `e:${r.email.toLowerCase().trim()}` : ""].filter(Boolean);
    if (!keys.length) {
      skippedNoKey++;
      continue;
    }
    for (const key of keys) {
      const ids = keyToIds.get(key) ?? new Set<string>();
      ids.add(r.id);
      keyToIds.set(key, ids);
    }
  }

  // Keeper = most activities, then most notes, then most filled fields, then a real lead
  // over a contact-only record, then the oldest (established id). Higher score wins.
  const score = (r: DedupeRow): number =>
    r.acts * 1_000_000 + r.notes * 10_000 + r.filled * 100 + (r.contact_only ? 0 : 10);

  const dupGroups: Array<{ key: string; keep: DedupeRow; remove: DedupeRow[] }> = [];
  const seen = new Set<string>();
  for (const [key, ids] of keyToIds) {
    for (const root of ids) {
      if (seen.has(root)) continue;
      const stack = [root];
      const component = new Set<string>();
      seen.add(root);
      while (stack.length) {
        const id = stack.pop()!;
        component.add(id);
        const row = idToRow.get(id);
        if (!row) continue;
        const pk = phoneKey(row.phone);
        const keys = [pk ? `p:${pk}` : "", row.email ? `e:${row.email.toLowerCase().trim()}` : ""].filter(Boolean);
        for (const k of keys) {
          for (const next of keyToIds.get(k) ?? []) {
            if (!seen.has(next)) {
              seen.add(next);
              stack.push(next);
            }
          }
        }
      }
      if (component.size < 2) continue;
      const arr = [...component].map((id) => idToRow.get(id)).filter(Boolean) as DedupeRow[];
      const sorted = [...arr].sort((a, b) => score(b) - score(a) || a.created_at - b.created_at);
      dupGroups.push({ key, keep: sorted[0], remove: sorted.slice(1) });
    }
  }

  const duplicates = dupGroups.reduce((n, g) => n + g.remove.length, 0);
  const nameOf = (r: DedupeRow) =>
    [r.first_name, r.last_name].filter(Boolean).join(" ") || r.email || r.phone || "(no name)";

  if (!dryRun && duplicates) {
    const moveActs = db.prepare(`UPDATE activities SET lead_id=? WHERE lead_id=?`);
    const moveNotes = db.prepare(`UPDATE notes SET lead_id=? WHERE lead_id=?`);
    const moveJobs = db.prepare(`UPDATE automation_jobs SET status='skipped', last_error='deduped', updated_at=? WHERE lead_id=? AND status='pending'`);
    const updateKeep = db.prepare(
      `UPDATE leads SET first_name=?, last_name=?, email=?, phone=?, tags=?, custom=?, owner_user_id=?,
         last_activity_at=?, updated_at=? WHERE id=?`,
    );
    const softDel = db.prepare(`UPDATE leads SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL`);
    const parseTags = (s: string): string[] => {
      try {
        return JSON.parse(s) as string[];
      } catch {
        return [];
      }
    };
    const parseCustom = (s: string): Record<string, unknown> => {
      try {
        return JSON.parse(s) as Record<string, unknown>;
      } catch {
        return {};
      }
    };
    const prefer = (current: string | null, next: string | null): string | null => {
      const c = (current ?? "").trim();
      return c ? current : (next && next.trim() ? next : current);
    };
    const tx = db.transaction((gs: typeof dupGroups) => {
      const now = Date.now();
      for (const g of gs) {
        const merged = new Set(parseTags(g.keep.tags));
        const custom = parseCustom(g.keep.custom);
        let first = g.keep.first_name;
        let last = g.keep.last_name;
        let email = g.keep.email;
        let phone = g.keep.phone;
        let owner = g.keep.owner_user_id;
        let lastActivity = g.keep.last_activity_at;
        for (const r of g.remove) {
          moveActs.run(g.keep.id, r.id);
          moveNotes.run(g.keep.id, r.id);
          moveJobs.run(now, r.id);
          parseTags(r.tags).forEach((t) => t && merged.add(t));
          const rc = parseCustom(r.custom);
          for (const [k, v] of Object.entries(rc)) {
            if (custom[k] === undefined || custom[k] === null || String(custom[k]).trim() === "") custom[k] = v;
          }
          first = prefer(first, r.first_name);
          last = prefer(last, r.last_name);
          email = prefer(email, r.email);
          phone = prefer(phone, r.phone);
          owner = owner || r.owner_user_id;
          lastActivity = Math.max(lastActivity ?? 0, r.last_activity_at ?? 0) || null;
          softDel.run(now, now, r.id);
        }
        updateKeep.run(first, last, email, phone, JSON.stringify([...merged]), JSON.stringify(custom), owner, lastActivity, now, g.keep.id);
      }
    });
    tx(dupGroups);
    log.warn("contact dedupe: merged + soft-deleted duplicates", { groups: dupGroups.length, removed: duplicates });
  }

  return {
    dryRun,
    scanned: rows.length,
    groups: dupGroups.length,
    duplicates,
    removed: dryRun ? 0 : duplicates,
    skippedNoKey,
    sample: dupGroups.slice(0, 50).map((g) => ({
      key: g.key,
      keep: g.keep.id,
      keepName: nameOf(g.keep),
      remove: g.remove.map((r) => r.id),
    })),
  };
}
