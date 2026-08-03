# Aniwaves API

Anime streaming API for aniwaves.ru — search, details, episodes, servers, and stream extraction.

## Servers Supported

| Server | Method | Status |
|---|---|---|
| Vidplay | HTTP (RC4/AES decryption) | ✅ |
| BYFMS (WeneverBeenFree) | Pure Node PoW + AES-GCM | ✅ |
| DGHG (PlayMogo/DoodStream) | HTTP (pass_md5) | ✅ |
| Echovideo | getSources (+ Python curl_cffi fallback) | ✅ |

## Bandwidth architecture (important)

**Problem:** Proxying HLS through Render (`/api/proxy`) bills you for every `.ts` segment.

**Solution:** Video bytes go through a **Cloudflare Worker**. Render only returns small JSON.

```
Browser ──JSON──► Render API   (/api/search, /api/stream, …)
Browser ──HLS───► Cloudflare Worker  ──► CDN (echovideo / byfms / …)
                     ▲ Cache API (segments at edge)
```

| Piece | File / env | Role |
|---|---|---|
| Media Worker | `cf_media_worker.js` | CORS, Referer, m3u8 rewrite, edge cache |
| Scrape Worker (optional) | `cf_worker_proxy.js` | Bypass CF bot challenges when scraping |
| Stream wiring | `CF_MEDIA_PROXY_URL` | API builds `proxiedM3u8` → Worker |
| Metadata cache | Upstash Redis (optional) | Cache stream URLs / search (not video) |

### Deploy the media Worker (required for $0 Render video egress)

1. [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → Worker
2. Paste contents of `cf_media_worker.js`
3. **Settings → Variables**
   - `PROXY_SECRET` = a long random string (recommended)
4. Deploy → copy `https://<name>.workers.dev`
5. On **Render** → Environment:
   ```
   CF_MEDIA_PROXY_URL=https://<name>.workers.dev
   CF_MEDIA_PROXY_SECRET=<same as PROXY_SECRET>
   ```
6. Redeploy the API. Check `GET /api/health` → `mediaProxy.mode` should be `"cloudflare"`.

### Optional: Upstash Redis (cuts extraction CPU, not bandwidth)

1. Create a free DB at [upstash.com](https://upstash.com)
2. Copy REST URL + token to Render:
   ```
   UPSTASH_REDIS_REST_URL=https://….upstash.io
   UPSTASH_REDIS_REST_TOKEN=…
   ```
3. Stream results cache ~3 minutes; search/details use the same layer.

### Optional: scrape proxy (bot challenges)

Deploy `cf_worker_proxy.js` and set:

```
ANIWAVES_PROXY_URL=https://<scrape-worker>.workers.dev
```

This is **not** the media path — it only helps server-side fetches of aniwaves/CDN HTML APIs.

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/search?q=naruto` | Search anime |
| `GET /api/details?id=naruto-76396` | Get anime details |
| `GET /api/episodes?id=naruto-76396` | Get episode list |
| `GET /api/servers?id=naruto-76396&ep=1&type=sub` | Get servers for episode |
| `GET /api/stream?serverId=…` | Extract stream; returns `proxiedM3u8` (CF Worker URL) |
| `GET /api/proxy?url=…&referer=…` | **Emergency only** — proxies via Render (costs bandwidth) |
| `GET /api/health` | Health + mediaProxy / redis status |

### Stream response shape

```json
{
  "m3u8": "https://cdn…/master.m3u8",
  "proxiedM3u8": "https://your-worker.workers.dev/?url=…&r=…",
  "mediaProxy": "cloudflare",
  "subtitles": [],
  "provider": "…"
}
```

Players should load **`proxiedM3u8`**, never the raw CDN URL, and never Render `/api/proxy` in production.

## Deploy on Render

1. Create new Web Service, connect this repo
2. Build Command: `npm install && npm run build`  
   (or use `render.yaml` which also installs Python deps)
3. Start Command: `npm start`
4. Env vars:
   - `PORT=3000` (Render usually sets this)
   - `CF_MEDIA_PROXY_URL` ← **set this**
   - `CF_MEDIA_PROXY_SECRET`
   - `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (optional)
   - `ANIWAVES_PROXY_URL` (optional scrape worker)
   - `ANIWAVES_SCRAPER_PATH` (Python fallback path)

## Local dev

```bash
npm install
export PORT=3000
# optional:
# export CF_MEDIA_PROXY_URL=https://….workers.dev
npm run dev
```

Without `CF_MEDIA_PROXY_URL`, the API falls back to relative `/api/proxy` so local play still works — but that path is expensive on Render.
