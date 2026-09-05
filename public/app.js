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

    renderResult(data.result, data.insights, data.vercelNote);
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

function renderResult(r, insights, vercelNote) {
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
