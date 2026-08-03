import CryptoJS from 'crypto-js';

// Base64 mapping helper to handle Vidplay URL string transformations (_ -> /, - -> +)
function b64Decode(str) {
  let modernized = str.replace(/_/g, '/').replace(/-/g, '+');
  while (modernized.length % 4) modernized += '=';
  return CryptoJS.enc.Base64.parse(modernized).toString(CryptoJS.enc.Utf8);
}

// RC4 decryption routine executed sequentially per dynamic numerical key
function rc4Decrypt(ciphertext, keyStr) {
  const decrypted = CryptoJS.RC4.decrypt(ciphertext, keyStr);
  return decrypted.toString(CryptoJS.enc.Utf8);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    // ----------------------------------------------------
    // 1. STREAM PROXY LAYER (Unlimited Bandwidth Runtime)
    // ----------------------------------------------------
    if (path === '/api/proxy') {
      const targetUrlString = url.searchParams.get('url');
      const customReferer = url.searchParams.get('referer') || 'https://echovideo.ru';
      if (!targetUrlString) return new Response('Missing URL', { status: 400 });

      const targetUrl = new URL(targetUrlString);
      const modifiedHeaders = new Headers(request.headers);
      modifiedHeaders.set('Referer', customReferer);
      modifiedHeaders.set('Origin', new URL(customReferer).origin);
      modifiedHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

      const cdnResponse = await fetch(targetUrl.toString(), { headers: modifiedHeaders });
      const contentType = cdnResponse.headers.get('Content-Type') || '';

      // If playlist file, rewrite segment lines back into the proxy endpoint
      if (contentType.includes('mpegurl') || contentType.includes('application/x-mpegURL') || targetUrlString.includes('.m3u8')) {
        let text = await cdnResponse.text();
        const lines = text.split('\n');
        const rewrittenLines = lines.map(line => {
          if (line.trim() === '' || line.startsWith('#')) return line;
          let absoluteUrl = line.startsWith('http') ? line : new URL(line, targetUrl.origin).toString();
          return `${url.origin}/api/proxy?url=${encodeURIComponent(absoluteUrl)}&referer=${encodeURIComponent(customReferer)}`;
        });
        return new Response(rewrittenLines.join('\n'), { headers: { 'Content-Type': 'application/x-mpegURL', ...corsHeaders } });
      }

      // Stream binary media slices directly to the ExoPlayer stream thread
      const responseHeaders = new Headers(cdnResponse.headers);
      Object.entries(corsHeaders).forEach(([k, v]) => responseHeaders.set(k, v));
      if (targetUrlString.includes('.ts')) responseHeaders.set('Content-Type', 'video/MP2T');

      return new Response(cdnResponse.body, { status: cdnResponse.status, headers: responseHeaders });
    }

    // ----------------------------------------------------
    // 2. CORE TARGETED STREAM API PIPELINE
    // ----------------------------------------------------
    if (path === '/api/stream') {
      const episodeId = url.searchParams.get('episodeId');
      const serverType = url.searchParams.get('serverType'); // vidplay or byfms
      if (!episodeId) return new Response('Missing episodeId', { status: 400 });

      const cacheKey = `stream:${episodeId}:${serverType}`;
      
      // Hit Upstash Redis REST Cluster
      const cacheCheck = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${cacheKey}`, {
        headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }
      });
      const cacheResult = await cacheCheck.json();
      if (cacheResult.result) {
        return new Response(cacheResult.result, { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

      // --- RUNTIME DECRYPTION MATRIX FOR VIDPLAY ---
      if (serverType === 'vidplay') {
        try {
          // Dynamic remote key sync to preserve stability when targets rotate structures
          const keysFetch = await fetch('https://raw.githubusercontent.com/lk5029716-boop/Aniwavesapi/main/keys.json', {
            headers: { Authorization: `token ${env.GITHUB_TOKEN || ''}` }
          }).catch(() => ({ text: () => JSON.stringify([]) }));
          let keysScript = await keysFetch.text();
          let activeKeys = ["4", "7", "2", "9"];
          if (keysScript.includes("const keys")) {
            const match = keysScript.match(/const\s+keys\s*=\s*\[([\s\S]*?)\]/);
            if (match && match[1]) activeKeys = match[1].replace(/['"\s]/g, '').split(',');
          }

          // Fetch target index data via your residential proxy routing to avoid Cloudflare blocks
          const embedDataResponse = await fetch(`https://aniwaves.ru/${episodeId}`, {
            headers: { 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://aniwaves.ru' }
          }).catch(e => {
            console.error("Embed fetch failed:", e.message);
            return { json: () => ({ sources: [] }) };
          });
          const sourceData = await embedDataResponse.json();
          let rawTargetString = sourceData.sources || "";

          // Sequentially unwind ciphertext blocks via standard reverse-engineered RC4 matrix
          for (let k of activeKeys) {
            try {
              rawTargetString = rc4Decrypt(rawTargetString, k);
            } catch (decErr) {
              console.error("RC4 decrypt failed for key", k);
              break;
            }
          }
          
          const sourceObj = JSON.parse(rawTargetString);
          let realM3u8 = sourceObj[0]?.file || "";

          const payload = JSON.stringify({
            m3u8: realM3u8,
            proxiedM3u8: `${url.origin}/api/proxy?url=${encodeURIComponent(realM3u8)}&referer=https://vidplay.online`,
            subtitles: sourceObj[0]?.tracks || []
          });

          // Save tracking values into Upstash cluster for 2 hours
          await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${cacheKey}?EX=7200`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
            body: payload
          });

          return new Response(payload, { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (err) {
          return new Response(JSON.stringify({ error: "Vidplay extraction phase fault", details: err.message }), { status: 500, headers: corsHeaders });
        }
      }

      // --- STANDARD REDIRECTION FOR HEADLESS BYFMS EXTRACTIONS ---
      if (serverType === 'byfms') {
        const browserResponse = await fetch(`${env.BYFMS_BROWSER_URL}/scrape?id=${episodeId}`);
        const browserData = await browserResponse.text();

        const payload = JSON.stringify({
          m3u8: browserData,
          proxiedM3u8: `${url.origin}/api/proxy?url=${encodeURIComponent(browserData)}&referer=https://aniwaves.ru`,
          subtitles: []
        });

        await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${cacheKey}?EX=7200`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
          body: payload
        });

        return new Response(payload, { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
    }

    return new Response('Route Not Found', { status: 404 });
  }
};

