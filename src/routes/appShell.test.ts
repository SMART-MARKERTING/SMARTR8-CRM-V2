import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import { runInNewContext } from "node:vm";
import express from "express";
import { appRouter } from "./app";

interface TestResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function get(port: number, requestPath: string): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: requestPath, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

function pngDimensions(data: Buffer): { width: number; height: number } {
  assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

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

test("V2 inline application scripts remain syntactically valid", async () => {
  const html = await v2Shell();
  const scripts = Array.from(html.matchAll(/<script(?![^>]+\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi), (match) => match[1]);
  assert.ok(scripts.length > 0);
  for (const source of scripts) new Script(source);
});

test("dialers handle secure repair and terminal Telnyx states without exposing SDK internals", async () => {
  const html = await v2Shell();
  assert.match(html, /data-action="verify-repair-crm-line"/);
  assert.match(html, /\/api\/auth\/portal-verify/);
  assert.match(html, /Microphone access is blocked/);
  assert.match(html, /CRM line ready\. Call ended\./);
  assert.match(html, /preparePowerDialerCrmLine/);
  assert.doesNotMatch(html, /setCrmLineStatus\("Call: " \+ st/);
});

test("V2 exposes self-service passwords and admin-managed structured identities", async () => {
  const html = await v2Shell();
  assert.match(html, /data-action="change-own-password"/);
  assert.match(html, /\/api\/auth\/change-password/);
  assert.match(html, /id="adminUserFirst"/);
  assert.match(html, /id="adminUserLast"/);
  assert.match(html, /data-action="admin-save-identity"/);
  assert.match(html, /@smartr8\.com/);
});

test("V2 is an isolated installable PWA with explicit notification permission", async () => {
  const html = await v2Shell();
  const manifest = JSON.parse(await readFile(path.resolve(process.cwd(), "public", "v2-manifest.webmanifest"), "utf8")) as {
    id: string;
    start_url: string;
    scope: string;
    display: string;
    icons: Array<{ src: string; sizes: string }>;
    shortcuts: Array<{ url: string }>;
  };
  const consoleManifest = JSON.parse(await readFile(path.resolve(process.cwd(), "public", "manifest.webmanifest"), "utf8")) as {
    start_url: string;
    scope: string;
  };
  const worker = await readFile(path.resolve(process.cwd(), "public", "v2-sw.js"), "utf8");
  assert.equal(manifest.id, "/v2");
  assert.equal(manifest.start_url, "/v2/");
  assert.equal(manifest.scope, "/v2/");
  assert.equal(manifest.display, "standalone");
  assert.deepEqual(manifest.shortcuts.map((shortcut) => shortcut.url), [
    "/v2/?page=messages",
    "/v2/?page=dialer",
    "/v2/?page=notifications",
  ]);
  for (const item of manifest.icons) {
    const url = new URL(item.src, "https://crm.smartr8.com");
    assert.equal(url.origin, "https://crm.smartr8.com");
    assert.ok(url.pathname.startsWith(manifest.scope), `${url.pathname} must remain inside ${manifest.scope}`);
  }
  for (const item of manifest.shortcuts) {
    const url = new URL(item.url, "https://crm.smartr8.com");
    assert.equal(url.origin, "https://crm.smartr8.com");
    assert.ok(url.pathname.startsWith(manifest.scope), `${url.pathname} must remain inside ${manifest.scope}`);
  }
  assert.equal(consoleManifest.start_url, "/console");
  assert.equal(consoleManifest.scope, "/");
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /rel="manifest" href="\/v2\/manifest\.webmanifest"/);
  assert.match(html, /navigator\.serviceWorker\.register\("\/v2\/sw\.js", \{ scope: "\/v2\/" \}\)/);
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

  const workerContext: {
    URL: typeof URL;
    self: Record<string, unknown>;
    normalize?: (value?: string) => string;
  } = {
    URL,
    self: {
      location: { origin: "https://crm.smartr8.com" },
      navigator: {},
      clients: {},
      addEventListener: () => undefined,
      skipWaiting: () => undefined,
    },
  };
  runInNewContext(`${worker}\nglobalThis.normalize = safeDeepLink;`, workerContext);
  assert.ok(workerContext.normalize);
  assert.equal(workerContext.normalize("/v2?page=messages&lead=legacy"), "/v2/?page=messages&lead=legacy");
  assert.equal(workerContext.normalize("/v2"), "/v2/");
  assert.equal(workerContext.normalize("/v2/?page=dialer"), "/v2/?page=dialer");
  assert.equal(workerContext.normalize("https://evil.example/v2?page=messages"), "/v2/?page=notifications");
  assert.equal(workerContext.normalize("/console?page=messages"), "/v2/?page=notifications");
  assert.equal(workerContext.normalize("/v2/api/notifications"), "/v2/?page=notifications");
});

test("V2 routes canonicalize only the exact application path and preserve raw queries", async () => {
  const app = express();
  app.use(appRouter);
  app.use("/v2/public", express.static(path.resolve(process.cwd(), "public")));
  app.use("/v2", appRouter);
  app.use((_req, res) => res.status(404).end());
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const port = address.port;

    const bare = await get(port, "/v2");
    assert.equal(bare.status, 308);
    assert.equal(bare.headers.location, "/v2/");

    const notification = await get(port, "/v2?page=notifications&probe=1");
    assert.equal(notification.status, 308);
    assert.equal(notification.headers.location, "/v2/?page=notifications&probe=1");

    const rawQuery = "tag=first&tag=second&encoded=%2Fv2%3Fpage%3Dmessages&space=hello%20world&plus=a+b";
    const encoded = await get(port, `/v2?${rawQuery}`);
    assert.equal(encoded.status, 308);
    assert.equal(encoded.headers.location, `/v2/?${rawQuery}`);

    const shell = await get(port, "/v2/");
    assert.equal(shell.status, 200);
    assert.match(shell.body.toString("utf8"), /<title>SmartR8 CRM<\/title>/);

    const manifest = await get(port, "/v2/manifest.webmanifest");
    assert.equal(manifest.status, 200);
    assert.match(String(manifest.headers["content-type"]), /^application\/manifest\+json/);
    assert.equal(manifest.headers.location, undefined);

    const worker = await get(port, "/v2/sw.js");
    assert.equal(worker.status, 200);
    assert.match(String(worker.headers["content-type"]), /javascript/);
    assert.equal(worker.headers["service-worker-allowed"], "/v2/");
    assert.equal(worker.headers.location, undefined);

    const expectedIcons = new Map([
      ["app-180.png", 180],
      ["app-192.png", 192],
      ["app-512.png", 512],
      ["app-maskable-512.png", 512],
    ]);
    for (const [name, size] of expectedIcons) {
      const icon = await get(port, `/v2/public/icons/${name}`);
      assert.equal(icon.status, 200, name);
      assert.match(String(icon.headers["content-type"]), /^image\/png/);
      assert.deepEqual(pngDimensions(icon.body), { width: size, height: size });
      assert.equal(icon.headers.location, undefined);
    }

    const api = await get(port, "/v2/api/ping");
    assert.notEqual(api.status, 308);
    assert.equal(api.headers.location, undefined);

    const consoleShell = await get(port, "/console");
    assert.equal(consoleShell.status, 200);
    assert.match(consoleShell.body.toString("utf8"), /rel="manifest" href="\/public\/manifest\.webmanifest"/);
    const consoleWorker = await get(port, "/sw.js");
    assert.equal(consoleWorker.status, 200);
    assert.equal(consoleWorker.headers["service-worker-allowed"], "/");
    assert.doesNotMatch(consoleWorker.body.toString("utf8"), /addEventListener\("push"/);
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
