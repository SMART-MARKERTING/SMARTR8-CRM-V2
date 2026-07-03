# Security Headers Baseline

The main CRM service is an Express app deployed through Render. The Cloudflare Worker in `cloudflare-texting-mcp` serves the MCP connector and inbound webhooks separately. Cloudflare can add or override headers at the edge, but the application should still send a safe baseline itself.

## Starter Headers

- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), geolocation=(), payment=(), usb=(), display-capture=(), microphone=(self)`
- `Content-Security-Policy` with a practical baseline that allows the current inline console scripts, Telnyx WebRTC CDN, Facebook pixel, same-origin API calls, and websocket/media needs.

## CSP Notes

This repo currently uses inline scripts/styles in `public/console.html` and `public/softphone.html`, so a strict nonce-based CSP would break the app without a frontend refactor. The current baseline keeps `'unsafe-inline'` for scripts/styles and should be tightened later by moving inline JavaScript/CSS into bundled assets or adding nonces.

If Cloudflare Transform Rules, Pages headers, or Worker middleware are added later, keep them consistent with the Express headers and test the console, softphone, OAuth install, webhooks, and file download flows.

## Manual Review

- Confirm HSTS is safe for every subdomain before adding `preload`.
- Confirm any new CDN, analytics, websocket, image, or media domain is added intentionally.
- Do not allow `frame-ancestors *`; use `'none'` unless embedding is a real requirement.
