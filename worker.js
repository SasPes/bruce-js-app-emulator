// Cloudflare Worker: serves the static emulator and relays wifi.httpFetch() requests
// (when "Proxy" is selected in the page), because browsers block most cross-origin
// requests that lack CORS headers.
const DROPPED_RESPONSE_HEADERS = ["content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie"];

function blockedHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") ||
    /^(127|10|0)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === "::1" || /^(fc|fd|fe80)/.test(host);
}

async function proxy(request) {
  // Only the emulator page itself may use the relay (header absent on very old browsers).
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin") {
    return new Response("Forbidden", {status: 403});
  }
  let target;
  try {
    target = new URL(new URL(request.url).searchParams.get("url"));
  } catch (e) {
    return new Response("Invalid url", {status: 400});
  }
  if (!/^https?:$/.test(target.protocol) || blockedHost(target.hostname)) {
    return new Response("Blocked url", {status: 400});
  }
  let headers = {};
  try {
    headers = JSON.parse(request.headers.get("X-Proxy-Headers") || "{}");
  } catch (e) {}
  const hasBody = !["GET", "HEAD"].includes(request.method);
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: "follow"
    });
    const responseHeaders = new Headers(upstream.headers);
    for (const name of DROPPED_RESPONSE_HEADERS) responseHeaders.delete(name);
    responseHeaders.set("Cache-Control", "no-store");
    return new Response(upstream.body, {status: upstream.status, headers: responseHeaders});
  } catch (e) {
    return new Response("Upstream request failed", {status: 502, headers: {"X-Proxy-Error": "1"}});
  }
}

export default {
  fetch(request, env) {
    if (new URL(request.url).pathname === "/proxy") return proxy(request);
    return env.ASSETS.fetch(request);
  }
};
