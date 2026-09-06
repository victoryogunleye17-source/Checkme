const crypto = require('crypto');

// Vercel KV client — requires the KV integration to be added to the project
// in the Vercel dashboard (Storage tab). Once added, Vercel auto-injects
// KV_REST_API_URL and KV_REST_API_TOKEN as env vars — no manual config needed
// beyond clicking "Connect" in the dashboard.
const { kv } = require('@vercel/kv');

function keyFor(url) {
  return crypto.createHash('sha1').update(url).digest('hex');
}

module.exports = { kv, keyFor };
