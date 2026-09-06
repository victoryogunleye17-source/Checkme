const { kv, keyFor } = require('./_lib/kv');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url is required' });

    const key = keyFor(url);
    const raw = await kv.lrange(`history:${key}`, 0, -1);
    const history = raw
      .map((s) => {
        try { return JSON.parse(s); } catch { return null; }
      })
      .filter(Boolean)
      .reverse(); // oldest first, for a left-to-right chart

    if (history.length === 0) {
      return res.status(200).json({
        ok: true,
        history: [],
        message: 'No scheduled-check history yet for this URL. Either it isn\'t in your WATCH_URLS env var, or the cron hasn\'t run yet.',
      });
    }

    return res.status(200).json({ ok: true, history });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'History lookup failed' });
  }
};
