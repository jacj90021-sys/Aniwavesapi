/**
 * Media edge proxy helpers.
 *
 * Video bytes must NEVER flow through Render. The browser talks to a
 * Cloudflare Worker (CF_MEDIA_PROXY_URL); Render only returns small JSON.
 *
 * Fallback order for proxiedM3u8:
 *   1. CF_MEDIA_PROXY_URL  (Cloudflare Worker — preferred, $0 Render egress)
 *   2. Absolute self /api/proxy  (dev / emergency only — costs Render bandwidth)
 */

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/**
 * Normalise a worker origin so it is always a valid absolute URL base.
 * Accepts "https://x.workers.dev", "x.workers.dev", or "" (unset).
 */
function normaliseWorkerOrigin(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withProto);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

/** Base URL of the CF media worker, or empty if unset. */
export function mediaProxyBase(): string {
  return normaliseWorkerOrigin(process.env["CF_MEDIA_PROXY_URL"] ?? "");
}

export function mediaProxyEnabled(): boolean {
  return mediaProxyBase().length > 0;
}

/** Optional shared secret matching Worker env PROXY_SECRET. */
export function mediaProxySecret(): string {
  return (process.env["CF_MEDIA_PROXY_SECRET"] ?? process.env["PROXY_SECRET"] ?? "").trim();
}

/**
 * Pick the right Referer for a CDN host (matches Worker + /api/proxy logic).
 */
export function refererForUrl(targetUrl: string, fallback = "https://play.echovideo.ru/"): string {
  try {
    const host = new URL(targetUrl).hostname.toLowerCase();
    if (host.includes("echovideo") || host.includes("echo")) {
      return "https://play.echovideo.ru/";
    }
    if (
      host.includes("owphbf") ||
      host.includes("sprintcdn") ||
      host.includes("weneverbeenfree") ||
      host.includes("myvidplay") ||
      host.includes("wnbf") ||
      host.includes("playmogo") ||
      host.includes("gn1r5n") ||
      host.includes("dood")
    ) {
      return "https://aniwaves.ru/";
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/**
 * Build a fully-qualified media-proxy URL for an m3u8 (or any CDN asset).
 *
 * When CF_MEDIA_PROXY_URL is set → Worker URL (zero Render bandwidth).
 * Otherwise → relative /api/proxy (works on same origin but burns Render egress).
 *
 * @param publicApiOrigin  optional absolute origin for /api/proxy fallback
 *                         (e.g. https://aniwavesapi-w5ex.onrender.com). If omitted,
 *                         returns a relative path for same-origin clients.
 */
/**
 * Some CDN hosts (BYFMS / owphbf / sprintcdn family) block Cloudflare Worker
 * egress IPs (return 404/403). For those we must route through Render's
 * /api/proxy (which has an allowed egress IP) instead of the Worker.
 */
const WORKER_BLOCKED_HOSTS = [
  "owphbf",
  "sprintcdn",
  "weneverbeenfree",
  "myvidplay",
  "wnbf",
  "playmogo",
  "gn1r5n",
  "dood",
  "byfms",
];

export function isWorkerBlockedHost(targetUrl: string): boolean {
  try {
    const host = new URL(targetUrl).hostname.toLowerCase();
    return WORKER_BLOCKED_HOSTS.some((d) => host.includes(d));
  } catch {
    return false;
  }
}

export function buildMediaProxyUrl(
  targetUrl: string,
  opts?: { referer?: string; publicApiOrigin?: string }
): string {
  const referer = opts?.referer ?? refererForUrl(targetUrl);
  const secret = mediaProxySecret();
  const cf = mediaProxyBase();

  // BYFMS / owphbf family blocks Worker egress → use Render /api/proxy instead.
  if (cf && !isWorkerBlockedHost(targetUrl)) {
    const u = new URL(cf.includes("?") ? cf : cf + "/");
    u.searchParams.set("url", targetUrl);
    u.searchParams.set("r", referer);
    if (secret && !u.searchParams.get("k")) {
      u.searchParams.set("k", secret);
    }
    return u.toString();
  }

  // Emergency / local fallback — Render proxy (also used for Worker-blocked hosts)
  const path = `/api/proxy?url=${encodeURIComponent(targetUrl)}&referer=${encodeURIComponent(referer)}`;
  const origin = (opts?.publicApiOrigin ?? "").replace(/\/+$/, "");
  return origin ? `${origin}${path}` : path;
}

/**
 * Rewrite subtitle / thumbnail absolute CDN URLs through the media proxy
 * so the browser can load them without CORS issues and without hitting Render
 * when CF is configured.
 */
export function proxyAssetUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("/") || url.startsWith("blob:")) return url;
  try {
    new URL(url);
  } catch {
    return url;
  }
  return buildMediaProxyUrl(url);
}
