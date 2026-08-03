/**
 * Generic fallback extractor that shells out to the Python curl_cffi scraper
 * (aniwaves_scraper.py). curl_cffi impersonates Chrome's TLS + HTTP/2
 * fingerprint, which bypasses Cloudflare's JA3/JA4 checks on datacenter IPs
 * (Render). This is what makes DGHG work and is now the fallback for
 * Echovideo / Byse when the direct axios path gets CF-challenged.
 */
import { execFileSync } from "child_process";
import { logger } from "../../logger.js";
import type { StreamSource, SkipTime } from "../types.js";

type PyScriptResult =
  | { ok: true; m3u8: string; referer: string; expiry?: number }
  | { ok: false; error: string };

export async function extractViaPythonScraper(
  embedUrl: string,
  providerName: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource | null> {
  logger.info({ embedUrl: embedUrl.slice(0, 100), providerName }, "[PythonScraper] start");

  const envPath = process.env["ANIWAVES_SCRAPER_PATH"];
  const candidatePaths = [
    envPath,
    "/app/aniwaves_scraper.py",
    "/opt/render/project/src/aniwaves_scraper.py",
    "aniwaves_scraper.py",
  ].filter(Boolean) as string[];

  let scraperPath = candidatePaths[0] ?? "/app/aniwaves_scraper.py";
  for (const p of candidatePaths) {
    try {
      execFileSync("test", ["-f", p], { timeout: 3000 });
      scraperPath = p;
      logger.info({ scraperPath }, "[PythonScraper] found scraper at");
      break;
    } catch {
      continue;
    }
  }

  try {
    const env = { ...process.env };
    if (process.env["ANIWAVES_PROXY_URL"]) {
      env["ANIWAVES_PROXY_URL"] = process.env["ANIWAVES_PROXY_URL"];
    }
    const result = execFileSync(
      "python3",
      [scraperPath, "--server", embedUrl],
      { timeout: 20_000, encoding: "utf8", env }
    ).trim();

    const parsed = JSON.parse(result) as PyScriptResult;

    if (!parsed.ok) {
      logger.warn({ error: parsed.error }, "[PythonScraper] failed");
      return null;
    }

    logger.info(
      { m3u8: parsed.m3u8.slice(0, 80), providerName },
      "[PythonScraper] OK"
    );

    let intro: SkipTime | null = null;
    let outro: SkipTime | null = null;
    if (skipData?.intro && (skipData.intro[0] !== 0 || skipData.intro[1] !== 0)) {
      intro = { start: skipData.intro[0], end: skipData.intro[1] };
    }
    if (skipData?.outro && (skipData.outro[0] !== 0 || skipData.outro[1] !== 0)) {
      outro = { start: skipData.outro[0], end: skipData.outro[1] };
    }

    return {
      type: "direct",
      provider: providerName,
      m3u8: parsed.m3u8,
      subtitles: [],
      thumbnails: null,
      intro,
      outro,
    };
  } catch (err) {
    const e = err as Error & { stderr?: Buffer; status?: number };
    logger.warn(
      { error: e.message.slice(0, 160), stderr: e.stderr?.toString().slice(0, 200) },
      "[PythonScraper] error, skipping"
    );
    return null;
  }
}
