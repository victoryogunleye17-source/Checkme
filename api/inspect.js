import * as cheerio from 'cheerio';

export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  const start = Date.now();
  let response, html;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': 'CheckMe-Inspector/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    html = await response.text();
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
    $(el).find('input, textarea, select').each((_, inp) => {
      inputs.push({ name: $(inp).attr('name'), type: $(inp).attr('type') || $(inp).prop('tagName') });
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
    headings: $('h1, h2').map((_, el) => $(el).text().trim()).get(),
    linkCount: links.length,
    links: links.slice(0, 50),
    forms,
    images: $('img').length,
    socials: links.filter(l => /facebook|instagram|twitter|x\.com|tiktok|linkedin/.test(l)),
    contact: { emails, phones },
  });
}
