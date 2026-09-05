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

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB cap so a huge page can't blow up the function

async function readBodyWithLimit(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let result = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > MAX_BODY_BYTES) {
      reader.cancel();
      throw new Error('Response body too large (over 5MB)');
    }
    result += decoder.decode(value, { stream: true });
  }

  return result;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed — use POST' });
  }

  const cheerio = require('cheerio');
  const { url, allowPrivate } = req.body || {};

  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  let target;
  try {
    target = assertSafeUrl(url, !!allowPrivate);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const start = Date.now();
  let response, html;
  try {
    response = await fetch(target.href, {
      headers: { 'User-Agent': 'CheckMe-Inspector/1.0' },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    html = await readBodyWithLimit(response);
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message });
  }
  const loadTimeMs = Date.now() - start;

  const $ = cheerio.load(html);

  const links = [];
  $('a[href]').each((_, el) => links.push($(el).attr('href')));

  const forms = [];
  $('form').each((_, el) => {
    const inputs = [];
    $(el)
      .find('input, textarea, select')
      .each((_, inp) => {
        inputs.push({
          name: $(inp).attr('name') || null,
          type: $(inp).attr('type') || $(inp).prop('tagName'),
        });
      });
    forms.push({
      action: $(el).attr('action') || null,
      method: ($(el).attr('method') || 'GET').toUpperCase(),
      inputs,
    });
  });

  const bodyText = $('body').text();
  const emails = [...new Set(bodyText.match(/[\w.-]+@[\w.-]+\.\w+/g) || [])];
  const phones = [...new Set(bodyText.match(/\+?\d[\d\s-]{8,}\d/g) || [])];

  return res.status(200).json({
    ok: true,
    result: {
      finalUrl: response.url || target.href,
      status: response.status,
      loadTimeMs,
      title: $('title').text().trim() || null,
      description: $('meta[name="description"]').attr('content') || null,
      headings: $('h1, h2')
        .map((_, el) => $(el).text().trim())
        .get()
        .filter(Boolean),
      linkCount: links.length,
      links: links.slice(0, 50),
      forms,
      imageCount: $('img').length,
      socials: links.filter((l) => /facebook|instagram|twitter|x\.com|tiktok|linkedin/i.test(l)),
      contact: { emails, phones },
    },
  });
};
