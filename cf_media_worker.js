/**
 * Cloudflare Worker — HLS media edge proxy (SERVICE WORKER syntax)
 * Deployed via API with body_part (matches the worker's registered format).
 *
 * Browser -> this Worker -> CDN (echovideo / byfms / vidplay / …)
 * Segments cached at the CF edge via caches.default.
 */

const ALLOWED_HOST_SUFFIXES = [
  "echovideo.ru", "echovideo.to", "play.echovideo.ru",
  "myvidplay.com", "weneverbeenfree.com", "playmogo.com",
  "gn1r5n.org", "owphbf.com", "sprintcdn.com", "vidplay.online",
  "vidplay.lol", "vidcloud.lol", "mcloud.bz", "megacloud.tv",
  "rapid-cloud.co", "rabbitstream.net", "aniwaves.ru",
  "cloudfront.net", "bunnycdn.ru", "b-cdn.net", "cdn.jsdelivr.net",
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const SEGMENT_CACHE_TTL = 3600;
const PLAYLIST_CACHE_TTL = 10;

function hostAllowed(hostname) {
  const h = hostname.toLowerCase();
  if (
    ALLOWED_HOST_SUFFIXES.some(
      (d) => h === d || h.endsWith("." + d) || d.endsWith("." + h)
    )
  ) {
    return true;
  }
  // Echovideo routes segments through rotating random hosts:
  //   px.<random>.store   and   ru-cdn*.echovideo.to / ru-ri-cdn*.echovideo.to
  if (h.includes("echovideo")) return true;
  if (h.endsWith(".store")) return true;
  // BYFMS / owphbf family (edge1-moscow-sprintcdn.owphbf24.com etc.)
  if (h.includes("owphbf") || h.includes("sprintcdn")) return true;
  if (h.includes("byfms") || h.includes("byf")) return true;
  return false;
}

// Hosts that REQUIRE a specific referer regardless of what the API passes.
function forcedReferer(host) {
  const h = host.toLowerCase();
  if (
    h.includes("owphbf") || h.includes("sprintcdn") ||
    h.includes("weneverbeenfree") || h.includes("myvidplay") ||
    h.includes("wnbf") || h.includes("playmogo") ||
    h.includes("gn1r5n") || h.includes("dood") || h.includes("byfms")
  ) {
    return "https://aniwaves.ru/";
  }
  if (h.includes("echovideo") || h.includes("echo")) {
    return "https://play.echovideo.ru/";
  }
  return null; // no forced referer — fall back to explicit or default
}

function pickReferer(targetUrl, explicit) {
  const forced = forcedReferer(targetUrl.hostname);
  if (forced) return forced; // host requires this referer; ignore what the API sent
  if (explicit) return explicit;
  return "https://play.echovideo.ru/";
}

function corsHeaders(extra) {
  return Object.assign({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type, Accept",
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Accept-Ranges, Content-Type",
    "Access-Control-Max-Age": "86400",
  }, extra || {});
}

function buildProxyUrl(workerOrigin, absUrl, referer, secret) {
  const u = new URL(workerOrigin);
  u.search = "";
  u.pathname = "/";
  u.searchParams.set("url", absUrl);
  u.searchParams.set("r", referer);
  if (secret) u.searchParams.set("k", secret);
  return u.toString();
}

function rewritePlaylist(body, targetUrl, workerOrigin, referer, secret) {
  const origin = targetUrl.protocol + "//" + targetUrl.host;
  const baseUrl = targetUrl.href.substring(0, targetUrl.href.lastIndexOf("/") + 1);
  const toAbs = (raw) => {
    if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
    if (raw.startsWith("//")) return targetUrl.protocol + raw;
    if (raw.startsWith("/")) return origin + raw;
    return baseUrl + raw;
  };
  const toProxy = (raw) => buildProxyUrl(workerOrigin, toAbs(raw.trim()), referer, secret);
  return body
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
        return trimmed.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${toProxy(uri)}"`);
      }
      if (trimmed.startsWith("#")) return line;
      return toProxy(trimmed);
    })
    .join("\n");
}

function isPlaylistBody(buf, urlHint) {
  const head = new TextDecoder().decode(buf.slice(0, 64));
  if (/^#EXTM3U/.test(head)) return true;
  if (urlHint.includes(".m3u8")) return true;
  return false;
}

function getSecret() {
  try {
    return typeof PROXY_SECRET !== "undefined" && PROXY_SECRET ? PROXY_SECRET : "";
  } catch (e) {
    return "";
  }
}

async function handleRequest(req, ctx) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("method not allowed", { status: 405, headers: corsHeaders() });
  }

  const reqUrl = new URL(req.url);
  const targetRaw = reqUrl.searchParams.get("url");
  const secret = reqUrl.searchParams.get("k") || "";
  const refererParam = reqUrl.searchParams.get("r") || reqUrl.searchParams.get("referer");
  const proxySecret = getSecret();

  if (proxySecret && secret !== proxySecret) {
    return new Response("forbidden", { status: 403, headers: corsHeaders() });
  }

  if (!targetRaw) {
    return new Response(
      JSON.stringify({
        ok: true,
        service: "aniwaves-media-proxy",
        usage: "/?url=<encoded>&r=<referer>[&k=secret]",
      }),
      { status: 200, headers: corsHeaders({ "Content-Type": "application/json" }) }
    );
  }

  let target;
  try {
    target = new URL(targetRaw);
  } catch (e) {
    return new Response("bad url", { status: 400, headers: corsHeaders() });
  }

  if (!["http:", "https:"].includes(target.protocol)) {
    return new Response("bad protocol", { status: 400, headers: corsHeaders() });
  }

  if (!hostAllowed(target.hostname)) {
    return new Response("host not allowed: " + target.hostname, {
      status: 403,
      headers: corsHeaders(),
    });
  }

  const referer = pickReferer(target, refererParam || null);
  let originHeader = "https://play.echovideo.ru";
  try {
    originHeader = new URL(referer).origin;
  } catch (e) {
    /* keep default */
  }
  const range = req.headers.get("Range");

  const cacheKeyUrl = new URL("https://media-cache.internal/v1");
  cacheKeyUrl.searchParams.set("u", target.toString());
  if (range) cacheKeyUrl.searchParams.set("range", range);
  const cacheReq = new Request(cacheKeyUrl.toString(), { method: "GET" });

  const cache = caches.default;
  if (!range) {
    try {
      const hit = await cache.match(cacheReq);
      if (hit) {
        const out = new Response(hit.body, hit);
        const h = corsHeaders();
        for (const k in h) out.headers.set(k, h[k]);
        out.headers.set("X-Media-Cache", "HIT");
        return out;
      }
    } catch (e) {
      /* cache miss path continues */
    }
  }

  const upstreamHeaders = {
    "User-Agent": UA,
    Referer: referer,
    Origin: originHeader,
    Accept: "*/*",
    "Accept-Encoding": "identity",
  };
  if (range) upstreamHeaders["Range"] = range;

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      method: "GET",
      headers: upstreamHeaders,
      redirect: "follow",
    });
  } catch (err) {
    return new Response("upstream fetch failed: " + (err && err.message), {
      status: 502,
      headers: corsHeaders(),
    });
  }

  if (upstream.status >= 400) {
    return new Response("upstream " + upstream.status, {
      status: upstream.status,
      headers: corsHeaders({ "X-Upstream-Status": String(upstream.status) }),
    });
  }

  const buf = new Uint8Array(await upstream.arrayBuffer());
  const playlist = isPlaylistBody(buf, target.toString());

  if (playlist) {
    const text = new TextDecoder().decode(buf);
    const rewritten = rewritePlaylist(
      text, target, reqUrl.origin, referer, proxySecret || secret || ""
    );
    const headers = corsHeaders({
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "public, max-age=" + PLAYLIST_CACHE_TTL,
      "X-Media-Cache": "MISS-PLAYLIST",
    });
    const resp = new Response(rewritten, { status: 200, headers });
    if (PLAYLIST_CACHE_TTL > 0 && ctx && typeof ctx.waitUntil === "function") {
      try {
        const toCache = resp.clone();
        toCache.headers.set("Cache-Control", "public, max-age=" + PLAYLIST_CACHE_TTL);
        ctx.waitUntil(cache.put(cacheReq, toCache).catch(function () {}));
      } catch (e) {
        /* ignore */
      }
    }
    return resp;
  }

  const ct =
    upstream.headers.get("Content-Type") ||
    (target.pathname.endsWith(".vtt")
      ? "text/vtt"
      : target.pathname.endsWith(".srt")
        ? "text/plain"
        : "video/MP2T");

  const headers = corsHeaders({
    "Content-Type":
      ct.indexOf("jpeg") >= 0 || ct.indexOf("png") >= 0 ? "video/MP2T" : ct,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=" + SEGMENT_CACHE_TTL,
    "X-Media-Cache": "MISS",
  });
  const cr = upstream.headers.get("Content-Range");
  if (cr) headers["Content-Range"] = cr;
  const cl = upstream.headers.get("Content-Length");
  if (cl) headers["Content-Length"] = cl;
  else headers["Content-Length"] = String(buf.byteLength);

  const status = upstream.status === 206 ? 206 : 200;
  const resp = new Response(buf, { status, headers });
  if (status === 200 && !range && ctx && typeof ctx.waitUntil === "function") {
    try {
      const toCache = resp.clone();
      ctx.waitUntil(cache.put(cacheReq, toCache).catch(function () {}));
    } catch (e) {
      /* ignore */
    }
  }
  return resp;
}

addEventListener("fetch", (event) => {
  try {
    event.respondWith(handleRequest(event.request, event));
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    event.respondWith(
      new Response(
        JSON.stringify({
          ok: false, service: "aniwaves-media-proxy",
          error: "uncaught", message: msg.slice(0, 300),
        }),
        { status: 500, headers: corsHeaders({ "Content-Type": "application/json" }) }
      )
    );
  }
});
