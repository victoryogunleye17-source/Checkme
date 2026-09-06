function isPrivateHost(hostname) {
  const patterns = [
    /^localhost$/i, /^127\./, /^0\.0\.0\.0$/, /^10\./, /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[0-1])\./, /^169\.254\./, /^::1$/i
  ];
  return patterns.some((re) => re.test(hostname));
}

function assertSafeUrl(rawUrl, allowPrivate = false) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http/https allowed');
  if (!allowPrivate && isPrivateHost(u.hostname)) {
    throw new Error('Private/localhost addresses are blocked unless allowPrivate is true');
  }
  return u;
}

const MAX_HOPS = 15;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { url, allowPrivate = false } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url is required' });

    let current = assertSafeUrl(url, allowPrivate).href;
    const hops = [];
    let finalReachedAt2xx = false;

    for (let i = 0; i < MAX_HOPS; i++) {
      const start = Date.now();
      let response;
      try {
        response = await fetch(current, {
          method: 'GET',
          redirect: 'manual', // we want to see EACH hop, not have fetch silently follow them
          headers: { 'User-Agent': 'CheckMe-RedirectViewer/1.0' },
          signal: AbortSignal.timeout(8000),
        });
      } catch (err) {
        hops.push({ hop: i + 1, url: current, error: err.message, timeMs: Date.now() - start });
        break;
      }

      const timeMs = Date.now() - start;
      const isRedirect = response.status >= 300 && response.status < 400;
      const location = response.headers.get('location');

      hops.push({
        hop: i + 1,
        url: current,
        status: response.status,
        timeMs,
        isRedirect,
        location: location || null,
      });

      if (!isRedirect) {
        finalReachedAt2xx = response.status >= 200 && response.status < 300;
        break;
      }
      if (!location) break; // redirect with no Location header — dead end

      // Resolve relative redirects against the current URL
      try {
        current = new URL(location, current).href;
      } catch {
        break;
      }

      // Re-validate each hop — a redirect chain could legitimately try to
      // bounce somewhere private; same protection as every other route.
      try {
        assertSafeUrl(current, allowPrivate);
      } catch (err) {
        hops.push({ hop: i + 2, url: current, error: `Blocked: ${err.message}` });
        break;
      }
    }

    return res.status(200).json({
      ok: true,
      startUrl: url,
      finalUrl: hops.length ? hops[hops.length - 1].url : url,
      hopCount: hops.filter(h => h.isRedirect).length,
      reachedSuccessfully: finalReachedAt2xx,
      truncated: hops.length >= MAX_HOPS,
      hops,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Redirect check failed' });
  }
};
