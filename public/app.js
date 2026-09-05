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

    renderResult(data.result, data.insights);
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

function renderResult(r, insights) {
  document.getElementById('resultTable').innerHTML = `
    <tr><th>Metric</th><th>Value</th></tr>
    <tr><td>Total requests</td><td>${r.requests.total.toLocaleString()}</td></tr>
    <tr><td>Requests / sec (avg)</td><td>${r.requests.perSecondAvg}</td></tr>
    <tr><td>Latency average</td><td>${r.latencyMs.average} ms</td></tr>
    <tr><td>Latency p50 / p90 / p99</td><td>${r.latencyMs.p50} / ${r.latencyMs.p90} / ${r.latencyMs.p99} ms</td></tr>
    <tr><td>Max latency</td><td>${r.latencyMs.max} ms</td></tr>
    <tr><td>Error rate</td><td>${r.errors.ratePct}% (${r.errors.count} errors)</td></tr>
    <tr><td>Timeouts / non-2xx</td><td>${r.errors.timeouts} / ${r.errors.non2xx}</td></tr>
  `;

  const insightsEl = document.getElementById('insights');
  if (insights && insights.length) {
    insightsEl.innerHTML = '<strong>Insights</strong><ul>' +
      insights.map(i => `<li>${i}</li>`).join('') + '</ul>';
  } else {
    insightsEl.innerHTML = '';
  }
}

async function startCapacity() {
  const btn = document.getElementById('capBtn');
  const table = document.getElementById('capacityTable');
  const resultEl = document.getElementById('capacityResult');

  table.innerHTML = '<tr><th>Connections</th><th>Req/s</th><th>p90 latency</th><th>Error %</th></tr>';
  resultEl.textContent = 'Running capacity ramp with real traffic…';
  btn.disabled = true;

  try {
    const data = await api('/api/capacity', {
      url: val('url'),
      startConnections: +val('startConnections'),
      maxConnections: +val('maxConnections'),
      stepSeconds: +val('stepSeconds'),
      errorThresholdPct: +val('errorThresholdPct'),
      latencyThresholdMs: +val('latencyThresholdMs'),
      allowPrivate: checked('allowPrivate'),
    });

    data.rounds.forEach(r => {
      table.insertAdjacentHTML('beforeend',
        `<tr>
          <td>${r.level}</td>
          <td>${r.requestsPerSec}</td>
          <td>${r.latencyP90} ms</td>
          <td>${r.errorRatePct}%</td>
        </tr>`
      );
    });

    resultEl.textContent = data.message;
  } catch (e) {
    resultEl.textContent = 'Failed: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}
