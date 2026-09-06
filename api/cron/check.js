const { kv, keyFor } = require('../../lib/kv');

const MAX_HISTORY_ENTRIES = 100;

/**
 * A lightweight single-request health check — deliberately NOT a load test.
 * Scheduled checks run automatically and repeatedly, so they must stay
 * cheap: one GET request per watched URL per run, nothing concurrent.
 */
async function pingOnce(url) {
  const start = Date.now();
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'CheckMe-Monitor/1.0' },
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    });
    return {
      ok: response.status >= 200 && response.status < 400,
      status: response.status,
      latencyMs: Date.now() - start,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      latencyMs: Date.now() - start,
      error: err.message,
    };
  }
}

async function sendAlert(webhookUrl, webhookType, url, previousOk, currentOk, detail) {
  if (!webhookUrl) return;

  const transition = currentOk ? 'RECOVERED ✅' : 'DOWN 🔴';
  const message = `CheckMe alert — ${transition}\nURL: ${url}\n${detail}`;

  const body = webhookType === 'slack'
    ? { text: message }
    : { content: message }; // Discord-compatible default

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    console.error('Failed to send alert webhook:', err.message);
  }
}

module.exports = async function handler(req, res) {
  // Vercel sends this header automatically when CRON_SECRET is set in your
  // project's env vars — this blocks randoms from POSTing this endpoint
  // directly and triggering checks/alerts on demand.
  const authHeader = req.headers['authorization'];
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const watchUrls = (process.env.WATCH_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (watchUrls.length === 0) {
    return res.status(200).json({ ok: true, message: 'No URLs configured in WATCH_URLS env var — nothing to check.' });
  }

  const webhookUrl = process.env.ALERT_WEBHOOK_URL || null;
  const webhookType = process.env.ALERT_WEBHOOK_TYPE || 'discord';

  const results = [];

  for (const url of watchUrls) {
    const key = keyFor(url);
    const ping = await pingOnce(url);
    const entry = { timestamp: Date.now(), ...ping };

    // Push newest entry, trim to keep storage bounded.
    await kv.lpush(`history:${key}`, JSON.stringify(entry));
    await kv.ltrim(`history:${key}`, 0, MAX_HISTORY_ENTRIES - 1);
    await kv.set(`url:${key}`, url); // so /api/history can resolve key -> original URL

    const previous = await kv.get(`laststatus:${key}`);
    const previousOk = previous === null ? null : previous === 'up';
    await kv.set(`laststatus:${key}`, ping.ok ? 'up' : 'down');

    // Only alert on a genuine state CHANGE, not every failing run — otherwise
    // a site that's been down for days spams the webhook every cron tick.
    if (previousOk !== null && previousOk !== ping.ok) {
      const detail = ping.ok
        ? `Responded ${ping.status} in ${ping.latencyMs}ms.`
        : `${ping.error || `HTTP ${ping.status}`} (after ${ping.latencyMs}ms).`;
      await sendAlert(webhookUrl, webhookType, url, previousOk, ping.ok, detail);
    }

    results.push({ url, ...ping, stateChanged: previousOk !== null && previousOk !== ping.ok });
  }

  return res.status(200).json({ ok: true, checkedAt: Date.now(), results });
};
