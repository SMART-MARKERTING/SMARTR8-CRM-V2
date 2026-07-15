import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function v2Shell(): Promise<string> {
  return readFile(path.resolve(process.cwd(), "public", "v2.html"), "utf8");
}

test("V2 CRM links to the standalone Content Studio without embedding it", async () => {
  const html = await v2Shell();
  assert.match(html, /<title>SmartR8 CRM<\/title>/);
  assert.match(html, /href="https:\/\/studio\.smartr8\.com"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /<iframe[^>]+studio\.smartr8\.com/i);
});

test("V2 Apps exposes the separated CRM product areas", async () => {
  const html = await v2Shell();
  for (const label of ["Conversations", "File Storage", "Campaigns", "Social Planner", "Reputation", "Settings"]) {
    assert.match(html, new RegExp(`label: "${label}"`));
  }
  assert.match(html, /groupOrder = \["Communication", "Sales & Operations", "Marketing & Growth", "Administration"\]/);
});
