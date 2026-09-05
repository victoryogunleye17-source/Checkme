const autocannon = require('autocannon');
const crypto = require('crypto');

const MAX_CONNECTIONS = 80;
const MAX_ROUND_SECONDS = 6;
const MAX_ROUNDS = 5;

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

function summarize(result) {
  const total = result.requests.total || 0;
  const errorCount = (result.errors || 0) + (result.timeouts || 0) + (result.non2xx || 0);
  return {
    connections: result.connections,
    requestsPerSec: Math.round(result.requests.average || 0),
    latencyP90: Math.round(result.latency.p90 || 0),
    latencyAvg: Math.round(result.latency.average || 0),
    errorRatePct: total ? +((errorCount / total) * 100).toFixed(2) : 0,
    totalRequests: total,
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
      stepSeconds = 5,
      errorThresholdPct = 5,
      latencyThresholdMs = 1200,
      allowPrivate = false,
    } = req.body || {};

    if (!url) return res.status(400).json({ error: 'url is required' });

    const u = assertSafeUrl(url, allowPrivate);
    const maxConn = Math.min(parseInt(maxConnections, 10) || 60, MAX_CONNECTIONS);
    const roundDur = Math.min(Math.max(3, parseInt(stepSeconds, 10) || 5), MAX_ROUND_SECONDS);

    let level = Math.max(5, parseInt(startConnections, 10) || 10);
    let lastStable = 0;
    const rounds = [];
    let round = 0;

    while (level <= maxConn && round < MAX_ROUNDS) {
      round++;
      const result = await runOne(u.href, level, roundDur);
      const s = summarize(result);
      rounds.push({ level, ...s });

      const breached = s.errorRatePct > errorThresholdPct || s.latencyP90 > latencyThresholdMs;
      if (breached) break;

      lastStable = level;
      level = Math.min(level * 2, maxConn + 1);
    }

    return res.status(200).json({
      success: true,
      real: true,
      maxStableConnections: lastStable,
      rounds,
      message: lastStable > 0
        ? `Maximum stable concurrency measured: ${lastStable} connections`
        : 'Even the starting load exceeded your thresholds. Try lower startConnections.',
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Capacity test failed' });
  }
};
