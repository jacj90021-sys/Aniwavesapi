# Zero Render video bandwidth — 10-minute setup

You do **not** need to send secrets in chat. Do this yourself in the dashboards.

## What you already have in the repo

| File | Purpose |
|---|---|
| `cf_media_worker.js` | **Deploy this** — HLS proxy + edge cache |
| `cf_worker_proxy.js` | Optional scrape bot-bypass only |
| API changes | `/api/stream` returns Worker `proxiedM3u8` |
| Frontend | Plays `proxiedM3u8` (Worker), not Render |

## Step 1 — Cloudflare Worker (required)

1. Open https://dash.cloudflare.com → **Workers & Pages** → **Create application** → **Create Worker**
2. Name it e.g. `aniwaves-media`
3. Click **Edit code** → **select-all + delete** the Hello World stub (must be empty)
4. Paste the **entire** contents of `cf_media_worker.js` from GitHub `main`
   - File must keep `export default { … }` (Module Worker)
   - Do **not** mix in `addEventListener("fetch", …)` or leftover Hello World
5. **Save and Deploy** (top-right). Wait until it says Deployed.
6. **Settings → Variables and Secrets** → add:
   - `PROXY_SECRET` = generate one (`openssl rand -hex 24`)
7. Copy your URL: `https://aniwaves-media.<account>.workers.dev`

Quick test in browser:

```
https://aniwaves-media.<account>.workers.dev/
```

Should return JSON `{"ok":true,"service":"aniwaves-media-proxy",...}`.

### If you see “Uncaught …” in the Worker editor / logs

| Symptom | Fix |
|---|---|
| `Unexpected token 'export'` | You are on a **legacy Service Worker** template. Create a **new** Worker (default is modules) and paste again. |
| `Unexpected token` / red squiggles after paste | You left Hello World code above/below the paste. Clear the file completely first. |
| Worker deploys but every request is `500` with `"error":"uncaught"` | Open Workers → **Logs** → **Begin log stream**, hit the worker URL, read the `message` field — usually a bad host allowlist or upstream block. |
| `forbidden` | `PROXY_SECRET` on the Worker does not match `CF_MEDIA_PROXY_SECRET` / `k=` on the API. |
| `host not allowed: …` | CDN host is missing from `ALLOWED_HOST_SUFFIXES` in `cf_media_worker.js` — add it, redeploy Worker. |

**GitHub does not auto-update your Worker.** Editing the repo only updates the source. You must paste + **Save and Deploy** in the Cloudflare dashboard (or use Wrangler).

## Step 2 — Render: env + redeploy latest `main` (required)

As of the CF media commit, `/api/health` **must** include a `mediaProxy` object.
If live health has **no** `mediaProxy` key, Render is still running an **old build**.

1. Confirm GitHub `main` has commit *Zero Render video bandwidth…* (`cf_media_worker.js` present).
2. Render dashboard → your service → **Environment** → add/update:

```
CF_MEDIA_PROXY_URL=https://aniwaves-media.<account>.workers.dev
CF_MEDIA_PROXY_SECRET=<same value as Worker PROXY_SECRET>
```

3. **Manual Deploy** (or clear build cache + deploy) from branch `main`.
4. Wait until deploy is **Live**, then re-check health.

## Step 3 — Verify

```
GET https://<your-api>.onrender.com/api/health
```

Expect **both** fields (old deploys are missing these entirely):

```json
"mediaProxy": { "enabled": true, "mode": "cloudflare" },
"redis": { "enabled": false }
```

If `mediaProxy.enabled` is `false`, `CF_MEDIA_PROXY_URL` is not set on Render.

Play any episode. In DevTools → Network:

- m3u8 / `.ts` should hit `*.workers.dev`
- **Not** `onrender.com/api/proxy`

Render **Bandwidth** graph should stay flat while people watch.

## Step 4 — Optional Redis (Upstash)

Only reduces **extraction** load (PoW / decrypt), not video GB.

1. https://upstash.com → Create database → REST API
2. Render env:

```
UPSTASH_REDIS_REST_URL=https://….upstash.io
UPSTASH_REDIS_REST_TOKEN=…
```

Health will show `"redis": { "enabled": true }`.

## Step 5 — Optional scrape worker

If aniwaves blocks Render IPs, deploy `cf_worker_proxy.js` and set:

```
ANIWAVES_PROXY_URL=https://<scrape-worker>.workers.dev/?k=<secret>
```

## What you should give me (only if stuck)

Usually **nothing**. If something fails, paste (redact secrets):

1. `/api/health` JSON  
2. One `/api/stream?serverId=…` JSON (`proxiedM3u8` field)  
3. Browser Network screenshot of a failing `.m3u8` request  
4. Worker URL host only (no secret)

**Never** paste GitHub PATs, Cloudflare API tokens, or Redis tokens in chat.
