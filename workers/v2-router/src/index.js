const DEFAULT_V2_ORIGIN = "https://loangenius-v2.onrender.com";
const DEFAULT_FALLBACK_ORIGIN = "https://smartr8-texting-1wx7.onrender.com";

function upstreamUrl(requestUrl, origin) {
  const incoming = new URL(requestUrl);
  const target = new URL(origin);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  return target.toString();
}

function proxiedRequest(request, targetUrl, incomingHost) {
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.set("x-forwarded-host", incomingHost);
  headers.set("x-forwarded-proto", "https");

  return new Request(targetUrl, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  });
}

async function fetchOrigin(request, origin) {
  const incoming = new URL(request.url);
  const target = upstreamUrl(request.url, origin);
  return fetch(proxiedRequest(request, target, incoming.host));
}

function shouldFallback(response) {
  return response.status === 404 && response.headers.get("x-render-routing") === "no-server";
}

export default {
  async fetch(request, env) {
    const primary = (env.V2_ORIGIN || DEFAULT_V2_ORIGIN).replace(/\/+$/, "");
    const fallback = (env.FALLBACK_ORIGIN || DEFAULT_FALLBACK_ORIGIN).replace(/\/+$/, "");

    const primaryResponse = await fetchOrigin(request, primary);
    if (!shouldFallback(primaryResponse) || !fallback) return primaryResponse;

    const fallbackResponse = await fetchOrigin(request, fallback);
    const headers = new Headers(fallbackResponse.headers);
    headers.set("x-loangenius-v2-fallback", "active");
    return new Response(fallbackResponse.body, {
      status: fallbackResponse.status,
      statusText: fallbackResponse.statusText,
      headers,
    });
  },
};
