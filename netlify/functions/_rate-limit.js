// Rate limiting basique partagé entre les fonctions Netlify.
// Utilise Netlify Blobs comme compteur (best-effort : pas garanti
// atomique sous forte concurrence, mais largement suffisant pour
// stopper le scraping/brute-force et les abus de coût API).

const { getStore } = require('@netlify/blobs');

// ─── Contournement d'un bug connu sur certains sites Netlify où le contexte
// Blobs (siteID/token) n'est pas injecté automatiquement à l'exécution
// (MissingBlobsEnvironmentError). Si les variables d'environnement
// NETLIFY_BLOBS_SITE_ID et NETLIFY_BLOBS_TOKEN sont définies (Site settings
// → Environment variables), on les utilise en configuration explicite ;
// sinon on retombe sur l'auto-détection normale. ───
function getConfiguredStore(name) {
  const { NETLIFY_BLOBS_SITE_ID: siteID, NETLIFY_BLOBS_TOKEN: token } = process.env;
  if (siteID && token) return getStore({ name, siteID, token });
  return getStore(name);
}

function getClientIp(event) {
  const h = event.headers || {};
  return (
    h['x-nf-client-connection-ip'] ||
    (h['x-forwarded-for'] || '').split(',')[0].trim() ||
    'unknown'
  );
}

// Vérifie et incrémente le compteur pour `key`. Renvoie { allowed, remaining, resetAt }.
async function checkRateLimit(key, { limit, windowSeconds }) {
  const store = getConfiguredStore('medidoc-ratelimit');
  const now = Date.now();

  let entry;
  try {
    entry = await store.get(key, { type: 'json' });
  } catch {
    entry = null;
  }

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + windowSeconds * 1000 };
  }

  entry.count += 1;

  try {
    await store.setJSON(key, entry);
  } catch {
    // Si le store est indisponible, on n'échoue pas la requête pour autant :
    // on autorise par défaut plutôt que de casser le service.
    return { allowed: true, remaining: limit, resetAt: entry.resetAt };
  }

  return {
    allowed: entry.count <= limit,
    remaining: Math.max(0, limit - entry.count),
    resetAt: entry.resetAt
  };
}

function rateLimitResponse(resetAt) {
  const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  return {
    statusCode: 429,
    headers: { 'Retry-After': String(retryAfter) },
    body: JSON.stringify({ error: 'Trop de requêtes, réessayez plus tard.' })
  };
}

module.exports = { getClientIp, checkRateLimit, rateLimitResponse, getConfiguredStore };
