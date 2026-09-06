/**
 * classifyFailure — turns raw status-code/latency data into the same
 * judgment call you were making by eye across the NYSC/WhatsApp/Netlify
 * tests: "is this a gatekeeper saying no fast, or a backend genuinely
 * struggling?"
 *
 * Signature pattern learned from real tests in this project:
 *   RATE_LIMITED   -> failures are 4xx, latency stays LOW even under
 *                      load, ~0 timeouts/connection errors. The edge
 *                      is rejecting instantly, not processing slowly.
 *   REAL_OUTAGE    -> failures are 5xx, and/or latency climbs high,
 *                      and/or timeouts/connection errors are present.
 *                      The backend is actually struggling or down.
 *   MIXED          -> both signatures present at once.
 *   HEALTHY        -> error rate is low/zero, nothing to classify.
 */
function classifyFailure(summary) {
  const { errors, latencyMs, statusCodes } = summary;

  if (errors.ratePct <= 5) {
    return {
      label: 'HEALTHY',
      explanation: 'Error rate is low. No failure pattern to classify.',
    };
  }

  const has5xx = statusCodes['5xx'] > 0;
  const has4xxOnly = statusCodes['4xx'] > 0 && statusCodes['5xx'] === 0;
  const hasConnIssues = errors.connectionErrors > 0 || errors.timeouts > 0;
  const latencyIsLow = latencyMs.p90 <= 300;
  const latencyIsHigh = latencyMs.p90 > 800;

  const rateLimitSignals = has4xxOnly && latencyIsLow && !hasConnIssues;
  const outageSignals = has5xx || latencyIsHigh || hasConnIssues;

  if (rateLimitSignals && !outageSignals) {
    return {
      label: 'LIKELY_RATE_LIMITED',
      explanation:
        `Failures are fast, consistent, and entirely ${statusCodes['4xx'].toLocaleString()} non-2xx responses ` +
        `(p90 latency only ${latencyMs.p90}ms, zero timeouts/connection errors). This is the signature of an edge ` +
        `gatekeeper (rate limiter, WAF, or bot protection) rejecting requests quickly — not the backend itself ` +
        `struggling. The application is very likely healthy; you're just exceeding a request-volume ceiling.`,
    };
  }

  if (outageSignals && !rateLimitSignals) {
    const reasons = [];
    if (has5xx) reasons.push(`${statusCodes['5xx'].toLocaleString()} server errors (5xx)`);
    if (latencyIsHigh) reasons.push(`high p90 latency (${latencyMs.p90}ms)`);
    if (hasConnIssues) reasons.push(`${(errors.connectionErrors + errors.timeouts).toLocaleString()} connection errors/timeouts`);

    return {
      label: 'LIKELY_REAL_OUTAGE',
      explanation:
        `This looks like a genuine backend problem, not a gatekeeper: ${reasons.join(', ')}. ` +
        `A server actually struggling under load typically shows rising latency, 5xx errors, or dropped ` +
        `connections — all present here.`,
    };
  }

  if (rateLimitSignals && outageSignals) {
    return {
      label: 'MIXED',
      explanation:
        `Both signatures are present — some fast 4xx rejections (edge-level gatekeeping) alongside signs of real ` +
        `strain (5xx errors, high latency, or connection issues). The target may be rate-limiting you while ALSO ` +
        `genuinely struggling under its own load.`,
    };
  }

  // High error rate but doesn't cleanly match either signature (e.g. mostly
  // 3xx, or 4xx with moderate latency) — say so plainly rather than guessing.
  return {
    label: 'UNCLEAR',
    explanation:
      `Error rate is high (${errors.ratePct}%) but the pattern doesn't cleanly match a known signature. ` +
      `Check the status code breakdown directly — status codes: 1xx ${statusCodes['1xx']}, 2xx ${statusCodes['2xx']}, ` +
      `3xx ${statusCodes['3xx']}, 4xx ${statusCodes['4xx']}, 5xx ${statusCodes['5xx']}.`,
  };
}

module.exports = { classifyFailure };
