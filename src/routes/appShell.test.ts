import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import express from "express";
import { appRouter } from "./app";

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
  const manifest = JSON.parse(await readFile(path.resolve(process.cwd(), "public", "v2-manifest.webmanifest"), "utf8")) as {
    id: string;
    start_url: string;
    scope: string;
    display: string;
    icons: Array<{ src: string }>;
    shortcuts: Array<{ url: string }>;
  };
  const consoleManifest = JSON.parse(await readFile(path.resolve(process.cwd(), "public", "manifest.webmanifest"), "utf8")) as { start_url: string; scope: string };
  const worker = await readFile(path.resolve(process.cwd(), "public", "v2-sw.js"), "utf8");
  assert.equal(manifest.id, "/v2/");
  assert.equal(manifest.start_url, "/v2/");
  assert.equal(manifest.scope, "/v2/");
  assert.equal(manifest.display, "standalone");
  for (const shortcut of manifest.shortcuts) {
    assert.ok(new URL(shortcut.url, "https://crm.smartr8.com").pathname.startsWith(manifest.scope), `${shortcut.url} must remain inside ${manifest.scope}`);
  }
  for (const icon of manifest.icons) {
    assert.ok(new URL(icon.src, "https://crm.smartr8.com").pathname.startsWith(manifest.scope), `${icon.src} must remain inside ${manifest.scope}`);
  }
  assert.equal(consoleManifest.start_url, "/console");
  assert.equal(consoleManifest.scope, "/");
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /rel="manifest" href="\/v2\/manifest\.webmanifest"/);
  assert.match(
    html,
    /navigator\.serviceWorker\.register\("\/v2\/sw\.js", \{ scope: "\/v2\/" \}\)/,
  );
  assert.match(html, /apple-touch-icon/);
  assert.match(html, /data-action="push-enable"/);
  const permissionRequest = html.indexOf("Notification.requestPermission()");
  const enableHandler = html.indexOf("async function enablePushNotifications()");
  const disableHandler = html.indexOf("async function disablePushNotifications()");
  assert.ok(permissionRequest > enableHandler && permissionRequest < disableHandler, "permission request must only be in the direct enable action");
  assert.match(worker, /addEventListener\("push"/);
  assert.match(worker, /addEventListener\("notificationclick"/);
  assert.match(worker, /FALLBACK_URL = "\/v2\/\?page=notifications"/);
  assert.doesNotMatch(worker, /caches\.open|cache\.put|respondWith/);
});

test("V2 routes canonicalize into service-worker scope without changing console PWA routes", async () => {
  const app = express();
  app.use(appRouter);
  app.use("/v2", appRouter);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const base = `http://127.0.0.1:${address.port}`;

    const redirect = await fetch(`${base}/v2?page=notifications&lead=lead_123&token=secret`, { redirect: "manual" });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get("location"), "/v2/?page=notifications&lead=lead_123");

    const shell = await fetch(`${base}/v2/`);
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /<title>SmartR8 CRM<\/title>/);

    const v2Worker = await fetch(`${base}/v2/sw.js`);
    assert.equal(v2Worker.status, 200);
    assert.equal(v2Worker.headers.get("service-worker-allowed"), "/v2/");
    assert.match(await v2Worker.text(), /addEventListener\("push"/);

    const console = await fetch(`${base}/console`);
    assert.equal(console.status, 200);
    assert.match(await console.text(), /rel="manifest" href="\/public\/manifest\.webmanifest"/);
    const consoleWorker = await fetch(`${base}/sw.js`);
    assert.equal(consoleWorker.headers.get("service-worker-allowed"), "/");
    assert.doesNotMatch(await consoleWorker.text(), /addEventListener\("push"/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("V2 deep links survive login and support browser history", async () => {
  const html = await v2Shell();
  assert.match(html, /new URLSearchParams\(location\.search\)\.get\("page"\)/);
  assert.match(html, /history\[replace \? "replaceState" : "pushState"\]/);
  assert.match(html, /url\.pathname = "\/v2\/"/);
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
