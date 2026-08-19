// Rate limiting basique partagé entre les fonctions Netlify.
// Utilise Netlify Blobs comme compteur (best-effort : pas garanti
// atomique sous forte concurrence, mais largement suffisant pour
// stopper le scraping/brute-force et les abus de coût API).
//
// ⚠️ Toute la logique est enveloppée dans un try/catch, y compris la
// création du store — si Netlify Blobs est indisponible ou mal configuré
// sur ce site (bug connu MissingBlobsEnvironmentError), on AUTORISE la
// requête plutôt que de faire planter toute la fonction appelante. La
// limitation de débit est une protection en plus, jamais une dépendance
// dont la panne doit bloquer le service.

const { getStore } = require('@netlify/blobs');

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
// Ne lève JAMAIS d'exception : toute panne interne (Blobs indisponible,
// erreur réseau...) se traduit par un accès autorisé par défaut.
async function checkRateLimit(key, { limit, windowSeconds }) {
  const now = Date.now();
  const repliAutorise = { allowed: true, remaining: limit, resetAt: now + windowSeconds * 1000 };

  try {
    const store = getConfiguredStore('medidoc-ratelimit');

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
      return repliAutorise;
    }

    return {
      allowed: entry.count <= limit,
      remaining: Math.max(0, limit - entry.count),
      resetAt: entry.resetAt
    };
  } catch (err) {
    console.error('Rate limit indisponible, requête autorisée par défaut :', err);
    return repliAutorise;
  }
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
