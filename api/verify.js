const crypto = require('crypto');

// Simple in-memory store (resets on cold start – fine for demo)
// In production you would use Vercel KV or a database
const tokens = globalThis.__checkmeTokens || (globalThis.__checkmeTokens = new Map());

function isPrivateHost(hostname) {
  return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|0\.0\.0\.0)/i.test(hostname);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { action, url, method = 'meta', allowPrivate = false } = req.body || {};

    if (!url) return res.status(400).json({ error: 'url is required' });

    let u;
    try { u = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

    if (!['http:', 'https:'].includes(u.protocol)) {
      return res.status(400).json({ error: 'Only http/https allowed' });
    }

    if (!allowPrivate && isPrivateHost(u.hostname)) {
      return res.status(400).json({ error: 'Private addresses blocked' });
    }

    const origin = u.origin;

    if (action === 'start') {
      const token = 'cm_' + crypto.randomBytes(6).toString('hex');
      tokens.set(origin, { token, method, verified: false });

      let instructions = '';
      if (method === 'meta') {
        instructions = `Add this meta tag inside the <head> of your homepage:\n\n<meta name="checkme-verify" content="${token}" />`;
      } else if (method === 'file') {
        instructions = `Create this file on your server:\n\nhttps://${u.hostname}/.well-known/checkme-${token}.txt\n\nContent (exactly):\n${token}`;
      } else {
        instructions = `Add a DNS TXT record:\nName: _checkme.${u.hostname}\nValue: checkme-verify=${token}`;
      }

      return res.json({ origin, token, instructions, method });
    }

    if (action === 'check') {
      const rec = tokens.get(origin);
      if (!rec) {
        return res.status(404).json({ error: 'No verification started for this origin. Call action=start first.' });
      }

      let ok = false;

      if (rec.method === 'meta') {
        const r = await fetch(origin, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
        const html = await r.text();
        ok = html.includes(rec.token);
      } else if (rec.method === 'file') {
        const r = await fetch(`${origin}/.well-known/checkme-${rec.token}.txt`, {
          signal: AbortSignal.timeout(8000),
        });
        const body = (await r.text()).trim();
        ok = r.ok && body === rec.token;
      } else {
        // DNS is harder on serverless without extra packages – fall back to message
        return res.json({
          verified: false,
          message: 'DNS verification is limited on Vercel serverless. Prefer meta or file method.',
        });
      }

      if (ok) {
        rec.verified = true;
        tokens.set(origin, rec);
      }

      return res.json({ verified: ok, origin });
    }

    return res.status(400).json({ error: 'action must be "start" or "check"' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
