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

/**
 * ---------------------------------------------------------------------------
 * ERROR / SUCCESS ACCOUNTING — READ BEFORE CHANGING
 * ---------------------------------------------------------------------------
 * Autocannon's raw result object has categories that OVERLAP, and blindly
 * summing them (as the old code did: errors + timeouts + non2xx) double
 * counts failures. Here is how the categories actually relate:
 *
 *   result.requests.total  -> requests that completed and received an HTTP
 *                             response (any status code: 2xx/3xx/4xx/5xx).
 *                             Connection failures that never got a response
 *                             are NOT included in this number.
 *   result.non2xx          -> subset of requests.total: responses received
 *                             with a status code outside the 2xx range.
 *   result.errors          -> connection/socket-level failures (e.g. ECONNRESET,
 *                             ECONNREFUSED, socket hang up) where no HTTP
 *                             response was ever received. Autocannon counts a
 *                             timeout AS an error, so...
 *   result.timeouts        -> ...is a SUBSET of result.errors, not an
 *                             additional/separate bucket. Adding it to
 *                             result.errors again double-counts it.
 *
 * So the correct picture is:
 *
 *   totalAttempted   = requests.total + errors   (completed responses + connections
 *                                                  that never got a response)
 *   successful       = requests.total - non2xx   (2xx responses only)
 *   httpFailures     = non2xx                    (got a response, bad status)
 *   connectionErrors = errors - timeouts         (socket/connection errors that were NOT a timeout)
 *   timeouts         = timeouts                  (already reflected inside `errors`, shown separately for visibility)
 *   unsuccessful     = non2xx + errors           (httpFailures + ALL connection-level failures, timeouts included once)
 *   errorRatePct     = unsuccessful / totalAttempted * 100
 *
 * No category is counted twice: `errors` already contains `timeouts`, so
 * `timeouts` is never added into a total a second time.
 * ---------------------------------------------------------------------------
 */
function getStatusCodeBuckets(result) {
  const buckets = { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  const stats = result.statusCodeStats;
  if (stats && typeof stats === 'object') {
    for (const codeStr of Object.keys(stats)) {
      const code = parseInt(codeStr, 10);
      if (Number.isNaN(code)) continue;
      const entry = stats[codeStr];
      const count = typeof entry === 'object' && entry !== null ? (entry.count || 0) : (entry || 0);
      if (code >= 100 && code < 200) buckets['1xx'] += count;
      else if (code >= 200 && code < 300) buckets['2xx'] += count;
      else if (code >= 300 && code < 400) buckets['3xx'] += count;
      else if (code >= 400 && code < 500) buckets['4xx'] += count;
      else if (code >= 500 && code < 600) buckets['5xx'] += count;
    }
  }
  const bucketSum = buckets['1xx'] + buckets['2xx'] + buckets['3xx'] + buckets['4xx'] + buckets['5xx'];
  if (bucketSum === 0) {
    // This autocannon build didn't populate statusCodeStats — fall back to the
    // top-level fields it exposes instead (never invent numbers).
    buckets['1xx'] = result['1xx'] || 0;
    buckets['2xx'] = result['2xx'] || 0;
    buckets['3xx'] = result['3xx'] || 0;
    buckets['4xx'] = result['4xx'] || 0;
    buckets['5xx'] = result['5xx'] || 0;
  }
  return buckets;
}

function summarize(result) {
  const requestsCompleted = result.requests.total || 0; // got an HTTP response (any status)
  const errorsRaw = result.errors || 0;                 // connection-level failures; INCLUDES timeouts
  const timeouts = result.timeouts || 0;                // subset of errorsRaw
  const connectionOnlyErrors = Math.max(0, errorsRaw - timeouts);

  const buckets = getStatusCodeBuckets(result);
  let successful = buckets['2xx'];
  let non2xx = buckets['1xx'] + buckets['3xx'] + buckets['4xx'] + buckets['5xx'];
  if (successful === 0 && non2xx === 0 && requestsCompleted > 0) {
    // Neither statusCodeStats nor the 1xx/2xx/3xx/4xx/5xx fields were populated
    // by this autocannon version — derive from the one field we know we have.
    non2xx = result.non2xx || 0;
    successful = Math.max(0, requestsCompleted - non2xx);
  }

  const totalAttempted = requestsCompleted + errorsRaw;
  const unsuccessful = non2xx + errorsRaw; // errorsRaw already contains timeouts once
  const errorRatePct = totalAttempted ? +((unsuccessful / totalAttempted) * 100).toFixed(2) : 0;
  const successRatePct = totalAttempted ? +((successful / totalAttempted) * 100).toFixed(2) : 0;

  const durationS = result.duration || 0;
  const successfulPerSec = durationS ? Math.round(successful / durationS) : 0;

  return {
    durationS,
    connections: result.connections,
    requests: {
      total: totalAttempted, // successful + HTTP failures + connection errors/timeouts
      completed: requestsCompleted, // requests that got any HTTP response
      perSecondAvg: Math.round(result.requests.average || 0), // throughput of COMPLETED requests, not just successful
      perSecondMax: Math.round(result.requests.max || 0),
    },
    successful: {
      count: successful,
      ratePct: successRatePct,
      perSecondAvg: successfulPerSec,
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
      // "count"/"ratePct" here are the PRIMARY failure metric: any request
      // that did not end in a 2xx response, whether or not it got a response.
      count: unsuccessful,
      ratePct: errorRatePct,
      httpNon2xx: non2xx,
      connectionErrors: connectionOnlyErrors,
      timeouts,
    },
    statusCodes: buckets,
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

    // Rule-based insights (no external AI). Accuracy over vibes: never call
    // raw throughput "sustained" or "stable" if most of it was failures.
    const insights = [];

    if (summary.errors.ratePct > 5) {
      insights.push(
        `High failure rate detected (${summary.errors.ratePct}% of ${summary.requests.total.toLocaleString()} attempted requests). ` +
        `Although the test generated ~${summary.requests.perSecondAvg.toLocaleString()} requests/sec, only ` +
        `${summary.successful.count.toLocaleString()} requests actually succeeded (~${summary.successful.perSecondAvg.toLocaleString()} successful/sec). ` +
        `This throughput should not be interpreted as stable application capacity.`
      );
      if (summary.errors.httpNon2xx > 0) {
        insights.push(`${summary.errors.httpNon2xx.toLocaleString()} requests received a non-2xx HTTP response.`);
      }
      if (summary.errors.connectionErrors > 0 || summary.errors.timeouts > 0) {
        insights.push(`${summary.errors.connectionErrors.toLocaleString()} connection errors and ${summary.errors.timeouts.toLocaleString()} timeouts occurred — the target may be rejecting or dropping connections under this load.`);
      }
    } else if (summary.errors.ratePct > 0) {
      insights.push(`Stable throughput of approximately ${summary.successful.perSecondAvg.toLocaleString()} successful requests/sec at ${conn} concurrent HTTP connections (low error rate of ${summary.errors.ratePct}%).`);
    } else {
      insights.push(`Stable throughput of approximately ${summary.successful.perSecondAvg.toLocaleString()} successful requests/sec at ${conn} concurrent HTTP connections. No errors recorded.`);
    }

    if (summary.latencyMs.p90 > 1000) {
      insights.push(`p90 latency is high (${summary.latencyMs.p90}ms). Consider caching or optimizing slow endpoints.`);
    } else if (summary.latencyMs.average > 400) {
      insights.push(`Average latency of ${summary.latencyMs.average}ms is elevated under load.`);
    } else {
      insights.push(`Latency looks healthy (avg ${summary.latencyMs.average}ms, p90 ${summary.latencyMs.p90}ms).`);
    }

    return res.status(200).json({
      success: true,
      real: true,
      limitsApplied: { maxConnections: MAX_CONNECTIONS, maxDuration: MAX_DURATION },
      vercelNote: `This tool runs inside a single Vercel serverless function (max ${MAX_DURATION}s test duration, ${MAX_CONNECTIONS} connections per run here). It measures HTTP-level load from one function instance, not your server's true maximum capacity under unlimited concurrency.`,
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
