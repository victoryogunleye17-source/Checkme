import * as cheerio from 'cheerio';

function isUrlSafe(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }

  // Only allow http/https — blocks file:, ftp:, gopher:, etc.
  if (!['http:', 'https:'].includes(u.protocol)) return false;

  const hostname = u.hostname.toLowerCase();

  // Block obvious loopback / metadata hosts
  const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254.169.254'];
  if (blockedHosts.includes(hostname)) return false;

  // Block private IPv4 ranges (10.x, 172.16-31.x, 192.168.x)
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return false;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return false;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(hostname)) return false;

  // Block link-local (169.254.x.x) beyond the metadata IP already caught above
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(hostname)) return false;

  return true;
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
      throw new Error('response body too large');
    }
    result += decoder.decode(value, { stream: true });
  }

  return result;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  if (!isUrlSafe(url)) {
    return res.status(400).json({ error: 'invalid or disallowed url' });
  }

  const start = Date.now();
  let response, html;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': 'CheckMe-Inspector/1.0' },
      signal: AbortSignal.timeout(8000), // leaves headroom under Vercel's function timeout
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
          name: $(inp).attr('name'),
          type: $(inp).attr('type') || $(inp).prop('tagName'),
        });
      });
    forms.push({ action: $(el).attr('action'), method: $(el).attr('method'), inputs });
  });

  const bodyText = $('body').text();
  const emails = [...new Set(bodyText.match(/[\w.-]+@[\w.-]+\.\w+/g) || [])];
  const phones = [...new Set(bodyText.match(/\+?\d[\d\s-]{8,}\d/g) || [])];

  res.status(200).json({
    ok: true,
    status: response.status,
    loadTimeMs,
    title: $('title').text(),
    description: $('meta[name="description"]').attr('content') || null,
    headings: $('h1, h2')
      .map((_, el) => $(el).text().trim())
      .get(),
    linkCount: links.length,
    links: links.slice(0, 50),
    forms,
    images: $('img').length,
    socials: links.filter((l) => /facebook|instagram|twitter|x\.com|tiktok|linkedin/.test(l)),
    contact: { emails, phones },
  });
}
