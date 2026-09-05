const autocannon = require('autocannon');
const crypto = require('crypto');

// Strict limits so the function can finish on Vercel
const MAX_CONNECTIONS = 100;
const MAX_DURATION = 12; // seconds – keep short for serverless

function isPrivateHost(hostname) {
  const patterns = [
    /^localhost$/i, /^127\./, /^0\.0\.0\.0$/, /^10\./, /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[0-1])\./, /^169\.254\./, /^::1$/i
  ];
  return patterns.some((re) => re.test(hostname));
}

function assertSafeUrl(rawUrl, allowPrivate = false) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new Error('Only http and https URLs are allowed');
  }
  if (!allowPrivate && isPrivateHost(u.hostname)) {
    throw new Error('Private/localhost addresses are blocked. Enable "allow private" only for local testing.');
  }
  return u;
}

function summarize(result) {
  const total = result.requests.total || 0;
  const errorCount = (result.errors || 0) + (result.timeouts || 0) + (result.non2xx || 0);
  const errorRatePct = total ? +((errorCount / total) * 100).toFixed(2) : 0;

  return {
    durationS: result.duration,
    connections: result.connections,
    requests: {
      total,
      perSecondAvg: Math.round(result.requests.average || 0),
      perSecondMax: Math.round(result.requests.max || 0),
    },
    latencyMs: {
      average: Math.round(result.latency.average || 0),
      p50: Math.round(result.latency.p50 || 0),
      p90: Math.round(result.latency.p90 || 0),
      p99: Math.round(result.latency.p99 || 0),
      max: Math.round(result.latency.max || 0),
    },
    throughputBytesPerSec: Math.round(result.throughput.average || 0),
    errors: {
      count: errorCount,
      ratePct: errorRatePct,
      timeouts: result.timeouts || 0,
      non2xx: result.non2xx || 0,
    },
    statusCodes: result.statusCodeStats || {},
  };
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      url,
      connections = 20,
      duration = 8,
      pipelining = 1,
      allowPrivate = false,
      headers = {},
    } = req.body || {};

    if (!url) {
      return res.status(400).json({ error: 'url is required' });
    }

    const u = assertSafeUrl(url, allowPrivate);

    const conn = Math.min(Math.max(1, parseInt(connections, 10) || 1), MAX_CONNECTIONS);
    const dur = Math.min(Math.max(3, parseInt(duration, 10) || 5), MAX_DURATION);

    const result = await new Promise((resolve, reject) => {
      const instance = autocannon(
        {
          url: u.href,
          connections: conn,
          duration: dur,
          pipelining: Math.min(pipelining, 10),
          headers: {
            'User-Agent': 'CheckMe-LoadTest/1.0',
            'X-CheckMe-Test': crypto.randomUUID(),
            ...headers,
          },
          timeout: 10,
        },
        (err, res) => {
          if (err) reject(err);
          else resolve(res);
        }
      );

      // Safety: force kill if something hangs
      setTimeout(() => {
        try {
          instance.stop();
        } catch {}
      }, (dur + 5) * 1000);
    });

    const summary = summarize(result);

    // Simple rule-based insights (no external AI)
    const insights = [];
    if (summary.errors.ratePct > 5) {
      insights.push(`High error rate (${summary.errors.ratePct}%). Check server logs and database connections.`);
    } else if (summary.errors.ratePct > 0) {
      insights.push(`Low error rate (${summary.errors.ratePct}%) observed.`);
    } else {
      insights.push('No errors recorded at this load level.');
    }

    if (summary.latencyMs.p90 > 1000) {
      insights.push(`p90 latency is high (${summary.latencyMs.p90}ms). Consider caching or optimizing slow endpoints.`);
    } else if (summary.latencyMs.average > 400) {
      insights.push(`Average latency of ${summary.latencyMs.average}ms is elevated under load.`);
    } else {
      insights.push(`Latency looks healthy (avg ${summary.latencyMs.average}ms, p90 ${summary.latencyMs.p90}ms).`);
    }

    if (summary.requests.perSecondAvg > 0) {
      insights.push(`Sustained ~${summary.requests.perSecondAvg} requests/sec with ${conn} concurrent connections.`);
    }

    return res.status(200).json({
      success: true,
      real: true,
      limitsApplied: { maxConnections: MAX_CONNECTIONS, maxDuration: MAX_DURATION },
      config: { url: u.href, connections: conn, duration: dur },
      result: summary,
      insights,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: err.message || 'Load test failed',
      real: true,
    });
  }
};
