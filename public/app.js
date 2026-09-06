function val(id) {
  return document.getElementById(id).value;
}
function checked(id) {
  return document.getElementById(id).checked;
}

async function api(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function startTest() {
  const runBtn = document.getElementById('runBtn');
  const runPanel = document.getElementById('runPanel');
  const resultPanel = document.getElementById('resultPanel');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');

  resultPanel.style.display = 'none';
  runPanel.style.display = '';
  progressFill.style.width = '5%';
  progressFill.style.background = '';
  progressText.textContent = 'Starting real load test…';
  runBtn.disabled = true;

  // Fake smooth progress while the real test runs on the server
  let pct = 5;
  const timer = setInterval(() => {
    pct = Math.min(92, pct + 3);
    progressFill.style.width = pct + '%';
  }, 400);

  try {
    const data = await api('/api/test', {
      url: val('url'),
      connections: +val('connections'),
      duration: +val('duration'),
      pipelining: +val('pipelining'),
      allowPrivate: checked('allowPrivate'),
    });

    clearInterval(timer);
    progressFill.style.width = '100%';
    progressText.textContent = 'Done — real results received';

    renderResult(data.result, data.insights, data.vercelNote, data.classification);
    resultPanel.style.display = '';
  } catch (e) {
    clearInterval(timer);
    progressText.textContent = 'Failed: ' + e.message;
    progressFill.style.width = '100%';
    progressFill.style.background = '#FF6B6B';
  } finally {
    runBtn.disabled = false;
  }
}

function renderResult(r, insights, vercelNote, classification) {
  const sc = r.statusCodes || {};
  document.getElementById('resultTable').innerHTML = `
    <tr><th>Metric</th><th>Value</th></tr>
    <tr><td>Total requests (attempted)</td><td>${r.requests.total.toLocaleString()}</td></tr>
    <tr><td>Successful requests (2xx)</td><td>${r.successful.count.toLocaleString()}</td></tr>
    <tr><td>HTTP non-2xx</td><td>${r.errors.httpNon2xx.toLocaleString()}</td></tr>
    <tr><td>Connection errors</td><td>${r.errors.connectionErrors.toLocaleString()}</td></tr>
    <tr><td>Timeouts</td><td>${r.errors.timeouts.toLocaleString()}</td></tr>
    <tr><td>Success rate</td><td>${r.successful.ratePct}%</td></tr>
    <tr><td>Error rate</td><td>${r.errors.ratePct}%</td></tr>
    <tr><td>Requests / sec (all completed)</td><td>${r.requests.perSecondAvg.toLocaleString()}</td></tr>
    <tr><td>Successful requests / sec</td><td>${r.successful.perSecondAvg.toLocaleString()}</td></tr>
    <tr><td>Latency average</td><td>${r.latencyMs.average} ms</td></tr>
    <tr><td>Latency p50</td><td>${r.latencyMs.p50} ms</td></tr>
    <tr><td>Latency p90</td><td>${r.latencyMs.p90} ms</td></tr>
    <tr><td>Latency p99</td><td>${r.latencyMs.p99} ms</td></tr>
    <tr><td>Maximum latency</td><td>${r.latencyMs.max} ms</td></tr>
    <tr><td>Status codes (1xx/2xx/3xx/4xx/5xx)</td><td>${sc['1xx']||0} / ${sc['2xx']||0} / ${sc['3xx']||0} / ${sc['4xx']||0} / ${sc['5xx']||0}</td></tr>
  `;

  renderStatusChart(sc, 'statusChart');
  renderClassificationBadge(classification, 'classificationBadge');

  const insightsEl = document.getElementById('insights');
  if (insights && insights.length) {
    insightsEl.innerHTML = '<strong>Insights</strong><ul>' +
      insights.map(i => `<li>${i}</li>`).join('') + '</ul>';
  } else {
    insightsEl.innerHTML = '';
  }

  const noteEl = document.getElementById('resultVercelNote');
  noteEl.textContent = vercelNote || '';
  noteEl.style.display = vercelNote ? '' : 'none';
}

// Simple CSS-bar status code chart — no chart library needed.
function renderStatusChart(sc, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;

  const buckets = [
    { key: '1xx', color: '#6b7280' },
    { key: '2xx', color: '#2dd4bf' },
    { key: '3xx', color: '#60a5fa' },
    { key: '4xx', color: '#f59e0b' },
    { key: '5xx', color: '#ef4444' },
  ];
  const values = buckets.map(b => sc[b.key] || 0);
  const max = Math.max(1, ...values);

  el.innerHTML = '<div class="status-chart-title">Status code breakdown</div>' +
    '<div class="status-chart-bars">' +
    buckets.map((b, i) => {
      const v = values[i];
      const heightPct = Math.round((v / max) * 100);
      return `
        <div class="status-chart-col">
          <div class="status-chart-value">${v.toLocaleString()}</div>
          <div class="status-chart-track">
            <div class="status-chart-fill" style="height:${heightPct}%;background:${b.color};"></div>
          </div>
          <div class="status-chart-label">${b.key}</div>
        </div>`;
    }).join('') +
    '</div>';
}

// Small colored badge explaining "rate limited" vs "real outage" vs "healthy".
function renderClassificationBadge(classification, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!classification || classification.label === 'HEALTHY') {
    el.innerHTML = '';
    return;
  }

  const styles = {
    LIKELY_RATE_LIMITED: { color: '#f59e0b', label: 'Likely rate-limited (edge gatekeeper)' },
    LIKELY_REAL_OUTAGE: { color: '#ef4444', label: 'Likely a real outage/struggling backend' },
    MIXED: { color: '#a855f7', label: 'Mixed signals — rate limiting + real strain' },
    UNCLEAR: { color: '#6b7280', label: 'Unclear pattern' },
  };
  const s = styles[classification.label] || styles.UNCLEAR;

  el.innerHTML = `
    <div class="classification-badge" style="border-color:${s.color};">
      <span class="classification-dot" style="background:${s.color};"></span>
      <strong style="color:${s.color};">${s.label}</strong>
      <p class="mono small">${classification.explanation}</p>
    </div>`;
}

async function startCapacity() {
  const btn = document.getElementById('capBtn');
  const table = document.getElementById('capacityTable');
  const resultEl = document.getElementById('capacityResult');
  const noteEl = document.getElementById('capacityVercelNote');

  table.innerHTML = '<tr><th>Connections</th><th>Total req</th><th>Success</th><th>Req/s</th><th>P90</th><th>Error %</th><th>Status</th></tr>';
  resultEl.textContent = 'Running capacity ramp with real traffic…';
  noteEl.style.display = 'none';
  btn.disabled = true;

  try {
    const data = await api('/api/capacity', {
      url: val('url'),
      startConnections: +val('startConnections'),
      maxConnections: +val('maxConnections'),
      connectionStep: +val('connectionStep'),
      stepSeconds: +val('stepSeconds'),
      errorThresholdPct: +val('errorThresholdPct'),
      latencyThresholdMs: +val('latencyThresholdMs'),
      allowPrivate: checked('allowPrivate'),
    });

    data.rounds.forEach(r => {
      const badgeClass = r.status === 'STABLE' ? 'stable' : 'breaking';
      table.insertAdjacentHTML('beforeend',
        `<tr>
          <td>${r.level}</td>
          <td>${r.totalRequests.toLocaleString()}</td>
          <td>${r.successfulRequests.toLocaleString()}</td>
          <td>${r.requestsPerSec.toLocaleString()}</td>
          <td>${r.latencyP90} ms</td>
          <td>${r.errorRatePct}%</td>
          <td><span class="status-badge ${badgeClass}">${r.status}</span></td>
        </tr>`
      );
      if (r.classification && r.classification.label !== 'HEALTHY') {
        table.insertAdjacentHTML('beforeend',
          `<tr><td colspan="7"><p class="mono small" style="opacity:0.85;">↳ At ${r.level} connections: ${r.classification.explanation}</p></td></tr>`
        );
      }
    });

    resultEl.textContent = data.message;

    if (data.vercelNote) {
      noteEl.textContent = data.vercelNote;
      noteEl.style.display = '';
    }
  } catch (e) {
    resultEl.textContent = 'Failed: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}
// -----------------------------------------------------------------------
// Paste this whole block onto the end of public/app.js
// Reuses the existing val(), checked(), and api() helpers already defined
// at the top of app.js — no changes needed there.
// -----------------------------------------------------------------------

async function startInspect() {
  const btn = document.getElementById('inspectBtn');
  const panel = document.getElementById('inspectPanel');
  const statusEl = document.getElementById('inspectStatus');
  const resultPanel = document.getElementById('inspectResultPanel');

  resultPanel.style.display = 'none';
  panel.style.display = '';
  statusEl.textContent = 'Fetching page…';
  btn.disabled = true;

  try {
    const data = await api('/api/inspect', {
      url: val('url'),
      allowPrivate: checked('allowPrivate'),
    });

    if (!data.ok) {
      throw new Error(data.error || 'Fetch failed');
    }

    statusEl.textContent = 'Done — page fetched and parsed';
    renderInspectResult(data.result);
    resultPanel.style.display = '';
  } catch (e) {
    statusEl.textContent = 'Failed: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

function renderInspectResult(r) {
  document.getElementById('inspectTable').innerHTML = `
    <tr><th>Field</th><th>Value</th></tr>
    <tr><td>Final URL</td><td>${escapeHtml(r.finalUrl)}</td></tr>
    <tr><td>Status</td><td>${r.status}</td></tr>
    <tr><td>Load time</td><td>${r.loadTimeMs} ms</td></tr>
    <tr><td>Title</td><td>${escapeHtml(r.title || '—')}</td></tr>
    <tr><td>Description</td><td>${escapeHtml(r.description || '—')}</td></tr>
    <tr><td>Headings found</td><td>${r.headings.length ? r.headings.map(escapeHtml).join('; ') : '—'}</td></tr>
    <tr><td>Links found</td><td>${r.linkCount.toLocaleString()}</td></tr>
    <tr><td>Images</td><td>${r.imageCount.toLocaleString()}</td></tr>
  `;

  const formsBlock = document.getElementById('inspectFormsBlock');
  if (r.forms.length) {
    formsBlock.innerHTML = '<strong>Forms found</strong><ul>' +
      r.forms.map((f, i) => {
        const fields = f.inputs.map(inp => `${escapeHtml(inp.name || '(unnamed)')} [${escapeHtml(inp.type || '?')}]`).join(', ');
        return `<li>Form ${i + 1} — ${f.method} ${escapeHtml(f.action || '(no action set)')}<br><span class="mono small">${fields || 'no fields detected'}</span></li>`;
      }).join('') + '</ul>';
  } else {
    formsBlock.innerHTML = '<strong>Forms found</strong><p class="mono small">None detected on this page.</p>';
  }

  const linksBlock = document.getElementById('inspectLinksBlock');
  if (r.socials.length) {
    linksBlock.innerHTML = '<strong>Social links</strong><ul>' +
      r.socials.map(l => `<li><span class="mono small">${escapeHtml(l)}</span></li>`).join('') + '</ul>';
  } else {
    linksBlock.innerHTML = '<strong>Social links</strong><p class="mono small">None detected.</p>';
  }

  const contactBlock = document.getElementById('inspectContactBlock');
  const emails = r.contact.emails.length ? r.contact.emails.map(escapeHtml).join(', ') : '—';
  const phones = r.contact.phones.length ? r.contact.phones.map(escapeHtml).join(', ') : '—';
  contactBlock.innerHTML = `
    <strong>Contact info found on page</strong>
    <p class="mono small">Emails: ${emails}</p>
    <p class="mono small">Phones: ${phones}</p>
  `;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// -----------------------------------------------------------------------
// Redirect chain viewer
// -----------------------------------------------------------------------
async function startRedirectCheck() {
  const btn = document.getElementById('redirectBtn');
  const panel = document.getElementById('redirectPanel');
  const statusEl = document.getElementById('redirectStatus');
  const resultPanel = document.getElementById('redirectResultPanel');
  const hopsEl = document.getElementById('redirectHops');

  resultPanel.style.display = 'none';
  panel.style.display = '';
  statusEl.textContent = 'Tracing redirect chain…';
  btn.disabled = true;

  try {
    const data = await api('/api/redirects', {
      url: val('url'),
      allowPrivate: checked('allowPrivate'),
    });

    if (!data.ok) throw new Error(data.error || 'Redirect check failed');

    statusEl.textContent = `Done — ${data.hopCount} redirect${data.hopCount === 1 ? '' : 's'} followed`;

    hopsEl.innerHTML = data.hops.map(h => {
      if (h.error) {
        return `<div class="redirect-hop redirect-hop-error">
          <strong>Hop ${h.hop}</strong> — ${escapeHtml(h.url)}<br>
          <span class="mono small">Error: ${escapeHtml(h.error)}</span>
        </div>`;
      }
      const arrow = h.isRedirect ? `→ redirects to ${escapeHtml(h.location || '(no location header)')}` : '(final destination)';
      return `<div class="redirect-hop ${h.isRedirect ? '' : 'redirect-hop-final'}">
        <strong>Hop ${h.hop}</strong> — ${escapeHtml(h.url)}<br>
        <span class="mono small">Status ${h.status} · ${h.timeMs}ms ${arrow}</span>
      </div>`;
    }).join('');

    if (data.truncated) {
      hopsEl.insertAdjacentHTML('beforeend',
        `<p class="mono small" style="opacity:0.8;">Stopped after ${data.hops.length} hops (safety limit) — this chain may continue further.</p>`);
    }

    resultPanel.style.display = '';
  } catch (e) {
    statusEl.textContent = 'Failed: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

// -----------------------------------------------------------------------
// Monitoring history (scheduled Vercel Cron checks stored in Vercel KV)
// -----------------------------------------------------------------------
async function loadHistory() {
  const btn = document.getElementById('historyBtn');
  const panel = document.getElementById('historyPanel');
  const statusEl = document.getElementById('historyStatus');
  const resultPanel = document.getElementById('historyResultPanel');
  const chartEl = document.getElementById('historyChart');
  const tableEl = document.getElementById('historyTable');

  resultPanel.style.display = 'none';
  panel.style.display = '';
  statusEl.textContent = 'Loading history…';
  btn.disabled = true;

  try {
    const data = await api('/api/history', { url: val('url') });
    if (!data.ok) throw new Error(data.error || 'History lookup failed');

    if (!data.history.length) {
      statusEl.textContent = data.message || 'No history yet for this URL.';
      btn.disabled = false;
      return;
    }

    statusEl.textContent = `Done — ${data.history.length} recorded check${data.history.length === 1 ? '' : 's'}`;

    // Simple latency sparkline using the same bar-chart CSS as status codes
    const maxLatency = Math.max(1, ...data.history.map(h => h.latencyMs));
    chartEl.innerHTML = '<div class="status-chart-title">Latency over time (most recent checks)</div>' +
      '<div class="status-chart-bars">' +
      data.history.slice(-12).map(h => {
        const heightPct = Math.round((h.latencyMs / maxLatency) * 100);
        const color = h.ok ? '#2dd4bf' : '#ef4444';
        return `
          <div class="status-chart-col">
            <div class="status-chart-value">${h.latencyMs}ms</div>
            <div class="status-chart-track">
              <div class="status-chart-fill" style="height:${heightPct}%;background:${color};"></div>
            </div>
            <div class="status-chart-label">${new Date(h.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
          </div>`;
      }).join('') +
      '</div>';

    tableEl.innerHTML = '<tr><th>Time</th><th>Status</th><th>Latency</th></tr>' +
      data.history.slice().reverse().slice(0, 20).map(h => `
        <tr>
          <td>${new Date(h.timestamp).toLocaleString()}</td>
          <td>${h.ok ? '<span class="status-badge stable">UP</span>' : '<span class="status-badge breaking">DOWN</span>'} ${h.status || ''}</td>
          <td>${h.latencyMs} ms</td>
        </tr>`).join('');

    resultPanel.style.display = '';
  } catch (e) {
    statusEl.textContent = 'Failed: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}
