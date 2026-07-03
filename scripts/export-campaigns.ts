/* eslint-disable no-console */
// Generates the importable drip-campaign blocks + a human-readable reference from the
// single source of truth in src/services/campaigns.ts.
//
//   npx tsx scripts/export-campaigns.ts
//
// Writes, under docs/drip-campaigns/:
//   <CATEGORY>.json   importable block (channel, dayOffset, subject?, body, cta?, optOut?)
//                     + the exact POST /api/automations payload (crmAutomation).
//   README.md         SMS tables (with char + segment counts) and email blocks.
//
// NOTE: the day-0 email is intentionally omitted here and from the seeded steps — the
// funnel sends a branded transactional welcome (functions/_lib/leadEmail.ts on smartr8),
// so the drip's own emails start later to avoid two welcome emails. The day-0 SMS stays.
//
// SMS counts assume GSM-7 (the copy uses only GSM-7 characters) and render
// {{first_name}} as a representative 6-character first name ("Jordan").

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { CAMPAIGNS, campaignToSteps } from "../src/services/campaigns";
import type { Campaign } from "../src/services/campaigns";

const OUT_DIR = join(process.cwd(), "docs", "drip-campaigns");
const SAMPLE_NAME = "Jordan"; // 6 chars, representative

function render(t: string): string {
  return t.replace(/\{\{\s*first(_name)?\s*\}\}/g, SAMPLE_NAME);
}
function smsCounts(text: string): { chars: number; segments: number } {
  const chars = render(text).length;
  const segments = chars <= 160 ? 1 : Math.ceil(chars / 153);
  return { chars, segments };
}
function hasOptOut(text: string): boolean {
  return /reply stop/i.test(text);
}

interface Row {
  channel: "sms" | "email";
  dayOffset: number;
  subject?: string;
  preheader?: string;
  body: string;
  cta?: { label: string; url?: string };
  optOut: boolean;
  charCount?: number;
  segments?: number;
}

function rowsFor(c: Campaign): Row[] {
  const rows: Row[] = [];
  for (const s of c.sms) {
    const { chars, segments } = smsCounts(s.text);
    rows.push({ channel: "sms", dayOffset: s.day, body: s.text, optOut: hasOptOut(s.text), charCount: chars, segments });
  }
  for (const e of c.emails) {
    // Mirror campaignToSteps: the day-0 email is the funnel's welcome, not a drip step.
    if (e.day === 0) continue;
    rows.push({ channel: "email", dayOffset: e.day, subject: e.subject, preheader: e.preheader, body: e.body, cta: e.cta, optOut: true });
  }
  // email before sms when they share a day
  rows.sort((a, b) => a.dayOffset - b.dayOffset || (a.channel === b.channel ? 0 : a.channel === "email" ? -1 : 1));
  return rows;
}

mkdirSync(OUT_DIR, { recursive: true });

let md = "# Drip Campaigns (importable)\n\n";
md +=
  "Source of truth: `src/services/campaigns.ts`. These campaigns are seeded into the CRM " +
  "as DISABLED `lead_created` automations (one per category) by `seedCampaigns()`; enable " +
  "and edit them in the Flows tab. Each `<CATEGORY>.json` here is the portable block and " +
  "also embeds the exact `POST /api/automations` payload (`crmAutomation`).\n\n";
md += "Categories (a funnel `loanType` or a message keyword maps to one): PURCHASE, CASHOUT_REFI, HELOC, RATE_TERM_REFI, DSCR, GENERAL.\n\n";
md +=
  "The day-0 EMAIL is intentionally not part of the drip: the funnel sends a branded " +
  "transactional welcome (smartr8 `functions/_lib/leadEmail.ts`), so the drip's own emails " +
  "start later. The day-0 SMS still sends (to consented leads).\n\n";
md += `SMS counts assume GSM-7 and render {{first_name}} as "${SAMPLE_NAME}" (6 chars).\n\n`;

let maxSeg = 0;
for (const c of CAMPAIGNS) {
  const rows = rowsFor(c);
  const steps = campaignToSteps(c);
  const block = {
    category: c.key,
    campaign: c.name,
    enrollFilter: { category: c.key },
    rows,
    crmAutomation: {
      name: c.name,
      trigger: "lead_created",
      enabled: false,
      filter: { category: c.key },
      steps,
    },
  };
  writeFileSync(join(OUT_DIR, `${c.key}.json`), JSON.stringify(block, null, 2) + "\n");

  md += `## ${c.name} (category: \`${c.key}\`)\n\n`;
  md += "### SMS\n\n| Day | Chars | Segs | Opt-out | Message |\n|----:|------:|-----:|:-------:|---------|\n";
  for (const r of rows.filter((x) => x.channel === "sms")) {
    maxSeg = Math.max(maxSeg, r.segments ?? 1);
    md += `| ${r.dayOffset} | ${r.charCount} | ${r.segments} | ${r.optOut ? "yes" : ""} | ${r.body.replace(/\n/g, " ")} |\n`;
  }
  md += "\n### Email (drip; day-0 welcome is sent by the funnel)\n\n";
  for (const r of rows.filter((x) => x.channel === "email")) {
    md += `**Day ${r.dayOffset}: ${r.subject}**\n\n`;
    md += `- Preheader: ${r.preheader}\n`;
    md += `- CTA: ${r.cta?.label}${r.cta?.url ? ` (${r.cta.url})` : ""}\n\n`;
    md += "```\n" + r.body + "\n```\n\n";
  }
  md += "\n";
}

writeFileSync(join(OUT_DIR, "README.md"), md);
console.log(`Wrote ${CAMPAIGNS.length} campaign blocks + README to ${OUT_DIR}`);
console.log(`Max SMS segment count across all messages: ${maxSeg}`);
