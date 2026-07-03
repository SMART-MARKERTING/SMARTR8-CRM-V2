import { promises as fs } from "fs";
import path from "path";
import { config } from "../config";
import { toE164 } from "../util/phone";
import { log } from "../logger";

// Internal Do-Not-Call suppression list, persisted on the disk (survives restarts).
const FILE = path.resolve(process.cwd(), config.tokenDir, "dnc.json");

let cache: Set<string> | null = null;

async function load(): Promise<Set<string>> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const data = JSON.parse(raw) as { numbers?: string[] };
    cache = new Set(data.numbers ?? []);
  } catch {
    cache = new Set();
  }
  return cache;
}

async function persist(set: Set<string>): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify({ numbers: [...set] }, null, 2), "utf8");
}

export async function isOnDnc(phone: string): Promise<boolean> {
  if (!phone) return false;
  return (await load()).has(toE164(phone));
}

export async function addToDnc(phone: string, reason: string): Promise<void> {
  const set = await load();
  const e164 = toE164(phone);
  if (!e164) return;
  if (!set.has(e164)) {
    set.add(e164);
    await persist(set);
    log.info("DNC added", { phone: e164, reason });
  }
}

/** Remove a number from the DNC list (e.g. an SMS START re-subscribe). Best-effort. */
export async function removeFromDnc(phone: string): Promise<void> {
  const set = await load();
  const e164 = toE164(phone);
  if (e164 && set.delete(e164)) {
    await persist(set);
    log.info("DNC removed", { phone: e164 });
  }
}

export async function listDnc(): Promise<string[]> {
  return [...(await load())];
}
