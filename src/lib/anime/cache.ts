/**
 * Two-tier cache: in-memory (NodeCache) + optional Upstash Redis.
 *
 * Redis is for METADATA only (search, details, servers, resolved stream URLs).
 * Never store video bytes in Redis — that belongs on the Cloudflare Worker edge.
 *
 * Env (all optional — without them we stay in-memory only):
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *
 * TTLs (seconds):
 *   search     300
 *   details   1800
 *   episodes   600
 *   servers    300
 *   numericId  86400
 *   stream     180   (CDN tokens die fast — short TTL)
 */
import NodeCache from "node-cache";

const mem = new NodeCache({ stdTTL: 300, checkperiod: 60 });

const REDIS_URL = (process.env["UPSTASH_REDIS_REST_URL"] ?? "").trim();
const REDIS_TOKEN = (process.env["UPSTASH_REDIS_REST_TOKEN"] ?? "").trim();

export function redisEnabled(): boolean {
  return REDIS_URL.length > 0 && REDIS_TOKEN.length > 0;
}

/** Upstash REST command API — safe for arbitrary JSON values. */
async function redisCmd(args: Array<string | number>): Promise<unknown> {
  const res = await fetch(REDIS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(2500),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { result?: unknown };
  return data.result ?? null;
}

async function redisGet(key: string): Promise<string | null> {
  if (!redisEnabled()) return null;
  try {
    const result = await redisCmd(["GET", key]);
    return typeof result === "string" ? result : null;
  } catch {
    return null;
  }
}

async function redisSet(key: string, value: string, ttlSec: number): Promise<void> {
  if (!redisEnabled()) return;
  try {
    await redisCmd(["SET", key, value, "EX", Math.max(1, Math.floor(ttlSec))]);
  } catch {
    // ignore — memory cache still works
  }
}

async function redisDel(key: string): Promise<void> {
  if (!redisEnabled()) return;
  try {
    await redisCmd(["DEL", key]);
  } catch {
    // ignore
  }
}

/** Sync memory get (fast path used by existing scraper code). */
export function cacheGet<T>(key: string): T | undefined {
  return mem.get<T>(key);
}

/** Sync memory set. Also best-effort mirrors to Redis when configured. */
export function cacheSet<T>(key: string, value: T, ttl = 300): void {
  mem.set(key, value, ttl);
  if (redisEnabled()) {
    const payload = JSON.stringify(value);
    void redisSet(key, payload, ttl);
  }
}

export function cacheDel(key: string): void {
  mem.del(key);
  void redisDel(key);
}

/**
 * Async get: memory first, then Redis (hydrates memory on hit).
 * Use for stream resolution and any hot path that benefits from cross-instance cache.
 */
export async function cacheGetAsync<T>(key: string): Promise<T | undefined> {
  const local = mem.get<T>(key);
  if (local !== undefined) return local;

  const raw = await redisGet(key);
  if (raw == null) return undefined;
  try {
    const parsed = JSON.parse(raw) as T;
    // Re-hydrate memory with a short TTL; Redis owns the real expiry.
    mem.set(key, parsed, 60);
    return parsed;
  } catch {
    return undefined;
  }
}

export async function cacheSetAsync<T>(key: string, value: T, ttl = 300): Promise<void> {
  mem.set(key, value, ttl);
  if (redisEnabled()) {
    await redisSet(key, JSON.stringify(value), ttl);
  }
}

/** TTL constants (seconds) for callers that want explicit values */
export const TTL = {
  SEARCH: 300,       // 5 min
  DETAILS: 1800,     // 30 min
  EPISODES: 600,     // 10 min
  SERVERS: 300,      // 5 min
  NUMERIC_ID: 86400, // 24 h
  STREAM: 180,       // 3 min — CDN tokens expire
} as const;
