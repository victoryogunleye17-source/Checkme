const autocannon = require('autocannon');
const crypto = require('crypto');

const MAX_CONNECTIONS = 80;
const MAX_ROUND_SECONDS = 6;
const ABSOLUTE_MAX_ROUNDS = 12; // sanity cap regardless of time budget

// vercel.json sets functions."api/**/*.js".maxDuration = 60. Keep a buffer
// under that for cold start + JSON serialization + the setTimeout safety
// margin each round already uses, so the function always returns before
// Vercel kills it.
const VERCEL_MAX_DURATION_S = 60;
const TIME_BUDGET_S = 50;
const PER_ROUND_OVERHEAD_S = 2; // connection setup/teardown beyond pure test duration

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
    throw new Error('Private addresses blocked unless allowPrivate is true');
  }
  return u;
}

/**
 * Same accounting rules as api/test.js — KEEP THESE TWO FILES IN SYNC.
 * See the long comment in api/test.js for the full explanation of why
 * `errors` and `timeouts` are NOT added together (timeouts is a subset
 * of errors, not a separate bucket), and why `non2xx` is derived from
 * status-code buckets first, falling back to result.non2xx only if the
 * autocannon build doesn't expose per-code stats.
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
    buckets['1xx'] = result['1xx'] || 0;
    buckets['2xx'] = result['2xx'] || 0;
    buckets['3xx'] = result['3xx'] || 0;
    buckets['4xx'] = result['4xx'] || 0;
    buckets['5xx'] = result['5xx'] || 0;
  }
  return buckets;
}

function summarize(result, errorThresholdPct, latencyThresholdMs) {
  const requestsCompleted = result.requests.total || 0;
  const errorsRaw = result.errors || 0;   // includes timeouts
  const timeouts = result.timeouts || 0;  // subset of errorsRaw
  const connectionOnlyErrors = Math.max(0, errorsRaw - timeouts);

  const buckets = getStatusCodeBuckets(result);
  let successful = buckets['2xx'];
  let non2xx = buckets['1xx'] + buckets['3xx'] + buckets['4xx'] + buckets['5xx'];
  if (successful === 0 && non2xx === 0 && requestsCompleted > 0) {
    non2xx = result.non2xx || 0;
    successful = Math.max(0, requestsCompleted - non2xx);
  }

  const totalAttempted = requestsCompleted + errorsRaw;
  const unsuccessful = non2xx + errorsRaw; // no double count: errorsRaw already contains timeouts
  const errorRatePct = totalAttempted ? +((unsuccessful / totalAttempted) * 100).toFixed(2) : 0;
  const latencyP90 = Math.round(result.latency.p90 || 0);

  // STABLE requires BOTH: error rate within threshold AND p90 latency within threshold.
  const errorBreach = errorRatePct > errorThresholdPct;
  const latencyBreach = latencyP90 > latencyThresholdMs;
  let status = 'STABLE';
  let breachReason = null;
  if (errorBreach && latencyBreach) {
    status = 'BREAKING';
    breachReason = 'error rate and p90 latency both exceeded threshold';
  } else if (errorBreach) {
    status = 'BREAKING';
    breachReason = 'error rate exceeded threshold';
  } else if (latencyBreach) {
    status = 'BREAKING';
    breachReason = 'p90 latency exceeded threshold';
  }

  return {
    connections: result.connections,
    totalRequests: totalAttempted,
    successfulRequests: successful,
    httpNon2xx: non2xx,
    connectionErrors: connectionOnlyErrors,
    timeouts,
    requestsPerSec: Math.round(result.requests.average || 0),
    latencyP90,
    latencyAvg: Math.round(result.latency.average || 0),
    errorRatePct,
    status,
    breachReason,
  };
}

function runOne(url, connections, duration) {
  return new Promise((resolve, reject) => {
    const instance = autocannon({
      url,
      connections,
      duration,
      headers: { 'User-Agent': 'CheckMe-Capacity/1.0', 'X-CheckMe-Test': crypto.randomUUID() },
      timeout: 8,
    }, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
    setTimeout(() => { try { instance.stop(); } catch {} }, (duration + 4) * 1000);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      url,
      startConnections = 10,
      maxConnections = 60,
      connectionStep, // optional; defaults to startConnections (10 -> 20 -> 30 ...)
      stepSeconds = 5,
      errorThresholdPct = 5,
      latencyThresholdMs = 1200,
      allowPrivate = false,
    } = req.body || {};

    if (!url) return res.status(400).json({ error: 'url is required' });

    const u = assertSafeUrl(url, allowPrivate);
    const maxConn = Math.min(parseInt(maxConnections, 10) || 60, MAX_CONNECTIONS);
    const roundDur = Math.min(Math.max(3, parseInt(stepSeconds, 10) || 5), MAX_ROUND_SECONDS);
    const start = Math.max(1, parseInt(startConnections, 10) || 10);
    // Ramp by a fixed additive increment (not doubling). Default increment
    // equals the starting concurrency, matching the classic 10 -> 20 -> 30 ramp.
    const step = Math.max(1, parseInt(connectionStep, 10) || start);
    const errThreshold = Number(errorThresholdPct);
    const latThreshold = Number(latencyThresholdMs);

    // How many steps the user actually configured, vs. how many we can fit
    // in this serverless function's execution window.
    const configuredRounds = Math.max(1, Math.floor((maxConn - start) / step) + 1);
    const maxRoundsByBudget = Math.max(1, Math.floor(TIME_BUDGET_S / (roundDur + PER_ROUND_OVERHEAD_S)));
    const roundsToRun = Math.min(configuredRounds, maxRoundsByBudget, ABSOLUTE_MAX_ROUNDS);
    const truncatedByVercel = roundsToRun < configuredRounds;

    let level = start;
    let lastStable = 0;
    const rounds = [];

    for (let i = 0; i < roundsToRun && level <= maxConn; i++) {
      const result = await runOne(u.href, level, roundDur);
      const s = summarize(result, errThreshold, latThreshold);
      rounds.push({ level, ...s });

      if (s.status === 'BREAKING') break;

      lastStable = level;
      level += step;
    }

    // Note this is about how many levels COULD fit in the execution window,
    // not how many actually ran — the ramp may also stop earlier than that
    // on its own if it hits the error/latency thresholds, which is expected
    // behavior and not a Vercel limitation.
    const vercelNote = truncatedByVercel
      ? `Only ${roundsToRun} of ${configuredRounds} configured concurrency levels could fit in this run (Vercel serverless functions here are capped at ${VERCEL_MAX_DURATION_S}s). Lower "seconds per round" or reduce the range/step to cover the full ramp in one run.`
      : `The full configured range (${configuredRounds} levels) fits within Vercel's ${VERCEL_MAX_DURATION_S}s serverless execution limit; the ramp only stops earlier than that if it hits your error-rate or latency thresholds first.`;

    return res.status(200).json({
      success: true,
      real: true,
      maxStableConnections: lastStable,
      rounds,
      truncatedByVercel,
      vercelNote,
      message: lastStable > 0
        ? `Maximum stable concurrency measured: ${lastStable} concurrent HTTP connections.`
        : 'Even the starting load exceeded your thresholds. Try a lower "start connections" value.',
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Capacity test failed' });
  }
};
