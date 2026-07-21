import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "..");
const publicDir = path.join(root, "public");
const webDir = path.join(root, "mobile", "www");
const v2Dir = path.join(webDir, "v2");
const v2PublicDir = path.join(v2Dir, "public");

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

fs.rmSync(webDir, { recursive: true, force: true });
fs.mkdirSync(v2PublicDir, { recursive: true });

let html = fs.readFileSync(path.join(publicDir, "v2.html"), "utf8");
html = html.replace(
  '<script src="/v2/public/mobile/native-runtime.js"></script>',
  '<script src="/capacitor.js"></script>\n  <script src="/v2/public/mobile/native-config.js"></script>\n  <script src="/v2/public/mobile/native-runtime.js"></script>',
);
copyFile(path.join(publicDir, "logo.svg"), path.join(webDir, "logo.svg"));
copyFile(path.join(publicDir, "logo.png"), path.join(webDir, "logo.png"));
copyFile(path.join(publicDir, "v2-manifest.webmanifest"), path.join(v2Dir, "manifest.webmanifest"));
copyDir(path.join(publicDir, "icons"), path.join(v2PublicDir, "icons"));
copyDir(path.join(publicDir, "mobile"), path.join(v2PublicDir, "mobile"));
copyFile(path.join(publicDir, "v2-sw.js"), path.join(v2Dir, "sw.js"));
copyFile(path.join(publicDir, "manifest.webmanifest"), path.join(webDir, "manifest.webmanifest"));
fs.writeFileSync(path.join(v2Dir, "index.html"), html);
fs.writeFileSync(path.join(webDir, "index.html"), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>SmartR8 CRM</title>
  <script>location.replace("/v2/" + location.search);</script>
</head>
<body></body>
</html>
`);
fs.writeFileSync(path.join(v2PublicDir, "mobile", "native-config.js"), `window.SMARTR8_NATIVE_API_ORIGIN = "https://crm.smartr8.com";
window.SMARTR8_NATIVE_APNS_ENVIRONMENT = "production";
window.SMARTR8_NATIVE_APP_VERSION = "0.1.0";
window.SMARTR8_NATIVE_BUILD_NUMBER = "1";
`);

console.log(`Prepared Capacitor web assets in ${path.relative(root, webDir)}`);
