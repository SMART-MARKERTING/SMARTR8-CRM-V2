#!/usr/bin/env node
/**
 * One-time backfill: populate `property_state` for existing leads that have a
 * blank state, by deriving it from the phone's area code.
 *
 * Standalone — no build step, no API token. Uses your local `wrangler` login to
 * read/write the smartr8-leads D1. Run it from this directory.
 *
 *   node scripts/backfill-property-state.mjs            # DRY RUN (default): prints a
 *                                                       # summary + writes backfill-property-state.sql
 *   node scripts/backfill-property-state.mjs --apply    # actually execute the UPDATEs
 *
 * After a dry run you can review backfill-property-state.sql and apply it yourself:
 *   npx wrangler d1 execute smartr8-leads --remote --file=backfill-property-state.sql
 *
 * Safety: each UPDATE is guarded with `AND (property_state IS NULL OR property_state='')`
 * so it can never overwrite a state that was set in the meantime, and it's idempotent.
 *
 * NOTE: the area-code map mirrors src/util/areaCodeState.ts (kept inline so this
 * script is fully self-contained).
 */

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const DB = "smartr8-leads";
const APPLY = process.argv.includes("--apply");
const OUT_SQL = "backfill-property-state.sql";

const AREA_CODE_STATE = {
  "205":"AL","251":"AL","256":"AL","334":"AL","659":"AL","938":"AL","907":"AK",
  "480":"AZ","520":"AZ","602":"AZ","623":"AZ","928":"AZ","327":"AR","479":"AR","501":"AR","870":"AR",
  "209":"CA","213":"CA","279":"CA","310":"CA","323":"CA","341":"CA","350":"CA","408":"CA","415":"CA","424":"CA","442":"CA","510":"CA","530":"CA","559":"CA","562":"CA","619":"CA","626":"CA","628":"CA","650":"CA","657":"CA","661":"CA","669":"CA","707":"CA","714":"CA","747":"CA","760":"CA","805":"CA","818":"CA","820":"CA","831":"CA","840":"CA","858":"CA","909":"CA","916":"CA","925":"CA","949":"CA","951":"CA",
  "303":"CO","719":"CO","720":"CO","970":"CO","983":"CO","203":"CT","475":"CT","860":"CT","959":"CT","302":"DE","202":"DC",
  "239":"FL","305":"FL","321":"FL","324":"FL","352":"FL","386":"FL","407":"FL","448":"FL","561":"FL","645":"FL","656":"FL","689":"FL","727":"FL","728":"FL","754":"FL","772":"FL","786":"FL","813":"FL","850":"FL","863":"FL","904":"FL","941":"FL","954":"FL",
  "229":"GA","404":"GA","470":"GA","478":"GA","678":"GA","706":"GA","762":"GA","770":"GA","912":"GA","943":"GA","808":"HI","208":"ID","986":"ID",
  "217":"IL","224":"IL","309":"IL","312":"IL","331":"IL","447":"IL","464":"IL","618":"IL","630":"IL","708":"IL","730":"IL","773":"IL","779":"IL","815":"IL","847":"IL","872":"IL",
  "219":"IN","260":"IN","317":"IN","463":"IN","574":"IN","765":"IN","812":"IN","930":"IN","319":"IA","515":"IA","563":"IA","641":"IA","712":"IA","316":"KS","620":"KS","785":"KS","913":"KS","270":"KY","364":"KY","502":"KY","606":"KY","859":"KY","225":"LA","318":"LA","337":"LA","504":"LA","985":"LA","207":"ME",
  "240":"MD","301":"MD","410":"MD","443":"MD","667":"MD","339":"MA","351":"MA","413":"MA","508":"MA","617":"MA","774":"MA","781":"MA","857":"MA","978":"MA",
  "231":"MI","248":"MI","269":"MI","313":"MI","517":"MI","586":"MI","616":"MI","679":"MI","734":"MI","810":"MI","906":"MI","947":"MI","989":"MI","218":"MN","320":"MN","507":"MN","612":"MN","651":"MN","763":"MN","952":"MN",
  "228":"MS","601":"MS","662":"MS","769":"MS","314":"MO","417":"MO","557":"MO","573":"MO","636":"MO","660":"MO","816":"MO","975":"MO","406":"MT","308":"NE","402":"NE","531":"NE","702":"NV","725":"NV","775":"NV","603":"NH",
  "201":"NJ","551":"NJ","609":"NJ","640":"NJ","732":"NJ","848":"NJ","856":"NJ","862":"NJ","908":"NJ","973":"NJ","505":"NM","575":"NM",
  "212":"NY","315":"NY","332":"NY","347":"NY","363":"NY","516":"NY","518":"NY","585":"NY","607":"NY","631":"NY","646":"NY","680":"NY","716":"NY","718":"NY","838":"NY","845":"NY","914":"NY","917":"NY","929":"NY","934":"NY",
  "252":"NC","336":"NC","472":"NC","704":"NC","743":"NC","828":"NC","910":"NC","919":"NC","980":"NC","984":"NC","701":"ND",
  "216":"OH","220":"OH","234":"OH","283":"OH","326":"OH","330":"OH","380":"OH","419":"OH","440":"OH","513":"OH","567":"OH","614":"OH","740":"OH","937":"OH","405":"OK","539":"OK","580":"OK","918":"OK","458":"OR","503":"OR","541":"OR","971":"OR",
  "215":"PA","223":"PA","267":"PA","272":"PA","412":"PA","445":"PA","484":"PA","570":"PA","582":"PA","610":"PA","717":"PA","724":"PA","814":"PA","835":"PA","878":"PA","401":"RI",
  "803":"SC","839":"SC","843":"SC","854":"SC","864":"SC","605":"SD","423":"TN","615":"TN","629":"TN","731":"TN","865":"TN","901":"TN","931":"TN",
  "210":"TX","214":"TX","254":"TX","281":"TX","325":"TX","346":"TX","361":"TX","409":"TX","430":"TX","432":"TX","469":"TX","512":"TX","682":"TX","713":"TX","726":"TX","737":"TX","806":"TX","817":"TX","830":"TX","832":"TX","903":"TX","915":"TX","936":"TX","940":"TX","945":"TX","956":"TX","972":"TX","979":"TX",
  "385":"UT","435":"UT","801":"UT","802":"VT","276":"VA","434":"VA","540":"VA","571":"VA","686":"VA","703":"VA","757":"VA","804":"VA","826":"VA","948":"VA",
  "206":"WA","253":"WA","360":"WA","425":"WA","509":"WA","564":"WA","304":"WV","681":"WV","262":"WI","274":"WI","414":"WI","534":"WI","608":"WI","715":"WI","920":"WI","307":"WY",
};

function stateFromPhone(phone) {
  if (!phone) return "";
  const d = String(phone).replace(/\D/g, "");
  let area = "";
  if (d.length === 11 && d.startsWith("1")) area = d.slice(1, 4);
  else if (d.length === 10) area = d.slice(0, 3);
  else return "";
  return AREA_CODE_STATE[area] ?? "";
}

function wrangler(args) {
  return execSync(`npx wrangler ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

/** Parse `wrangler d1 execute --json` output into an array of row objects. */
function parseRows(raw) {
  const data = JSON.parse(raw);
  const block = Array.isArray(data) ? data[0] : data;
  return block?.results ?? block?.result?.[0]?.results ?? [];
}

function sqlEscape(s) {
  return String(s).replace(/'/g, "''");
}

console.log(`[backfill] reading null/blank-state leads from D1 "${DB}" (mode: ${APPLY ? "APPLY" : "DRY RUN"})`);

const SELECT =
  "SELECT lead_id, phone_e164 FROM leads WHERE (property_state IS NULL OR property_state='') AND phone_e164 IS NOT NULL AND phone_e164 != ''";

let rows;
try {
  rows = parseRows(wrangler(`d1 execute ${DB} --remote --json --command "${SELECT}"`));
} catch (e) {
  console.error("[backfill] failed to read from D1. Are you logged in (`npx wrangler login`) and in cloudflare-texting-mcp/?");
  process.exit(1);
}

const updates = [];
const unmapped = [];
for (const r of rows) {
  const st = stateFromPhone(r.phone_e164);
  if (st) updates.push({ lead_id: r.lead_id, phone: r.phone_e164, state: st });
  else unmapped.push({ lead_id: r.lead_id, phone: r.phone_e164 });
}

console.log(`[backfill] candidates: ${rows.length} | will set: ${updates.length} | unmapped (no/odd area code): ${unmapped.length}`);
const byState = {};
for (const u of updates) byState[u.state] = (byState[u.state] ?? 0) + 1;
console.log("[backfill] by state:", JSON.stringify(byState));
for (const u of updates.slice(0, 10)) console.log(`   ${u.lead_id}  ${u.phone} -> ${u.state}`);
if (updates.length > 10) console.log(`   …and ${updates.length - 10} more`);
if (unmapped.length) console.log("[backfill] UNMAPPED (left as-is):", unmapped.map((u) => u.phone).join(", "));

const sql = updates
  .map((u) => `UPDATE leads SET property_state='${u.state}' WHERE lead_id='${sqlEscape(u.lead_id)}' AND (property_state IS NULL OR property_state='');`)
  .join("\n");
writeFileSync(OUT_SQL, sql + "\n");
console.log(`[backfill] wrote ${updates.length} UPDATE statements to ${OUT_SQL}`);

if (!APPLY) {
  console.log("\n[backfill] DRY RUN — nothing changed. To apply, either:");
  console.log(`   node scripts/backfill-property-state.mjs --apply`);
  console.log(`   …or review ${OUT_SQL} then:  npx wrangler d1 execute ${DB} --remote --file=${OUT_SQL}`);
  process.exit(0);
}

if (!updates.length) {
  console.log("[backfill] nothing to apply.");
  process.exit(0);
}
console.log(`[backfill] APPLYING ${updates.length} updates via wrangler…`);
wrangler(`d1 execute ${DB} --remote --file=${OUT_SQL}`);
console.log("[backfill] done.");
