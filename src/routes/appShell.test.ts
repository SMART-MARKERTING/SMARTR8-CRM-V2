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

test("V2 is an isolated installable PWA with explicit notification permission", async () => {
  const html = await v2Shell();
  const manifest = JSON.parse(await readFile(path.resolve(process.cwd(), "public", "v2-manifest.webmanifest"), "utf8")) as Record<string, unknown>;
  const worker = await readFile(path.resolve(process.cwd(), "public", "v2-sw.js"), "utf8");
  assert.equal(manifest.start_url, "/v2");
  assert.equal(manifest.scope, "/v2/");
  assert.equal(manifest.display, "standalone");
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /rel="manifest" href="\/v2\/manifest\.webmanifest"/);
  assert.match(html, /apple-touch-icon/);
  assert.match(html, /data-action="push-enable"/);
  const permissionRequest = html.indexOf("Notification.requestPermission()");
  const enableHandler = html.indexOf("async function enablePushNotifications()");
  const disableHandler = html.indexOf("async function disablePushNotifications()");
  assert.ok(permissionRequest > enableHandler && permissionRequest < disableHandler, "permission request must only be in the direct enable action");
  assert.match(worker, /addEventListener\("push"/);
  assert.match(worker, /addEventListener\("notificationclick"/);
  assert.doesNotMatch(worker, /caches\.open|cache\.put|respondWith/);
});

test("V2 deep links survive login and support browser history", async () => {
  const html = await v2Shell();
  assert.match(html, /new URLSearchParams\(location\.search\)\.get\("page"\)/);
  assert.match(html, /history\[replace \? "replaceState" : "pushState"\]/);
  assert.match(html, /window\.addEventListener\("popstate"/);
  assert.match(html, /route\(requestedPage\(\), \{ fromHistory: true \}\)\.then\(applyDeepLink\)/);
});

test("mobile pipeline has a non-drag stage control and Telnyx cell fallback remains", async () => {
  const html = await v2Shell();
  const inboundRouter = await readFile(path.resolve(process.cwd(), "src", "services", "inboundRouter.ts"), "utf8");
  const voiceRoute = await readFile(path.resolve(process.cwd(), "src", "routes", "voice.ts"), "utf8");
  assert.match(html, /class="mobileStageSelect"/);
  assert.match(html, /data-action="lead-stage-quick"/);
  assert.match(inboundRouter, /dialLeg\(config\.voice\.myCell/);
  assert.match(inboundRouter, /falling back to cell/);
  assert.match(voiceRoute, /onInboundLegHangup\(ccid\)/);
});
