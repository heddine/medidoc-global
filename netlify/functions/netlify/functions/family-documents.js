
// Netlify Function — Stockage partagé "famille" pour MediDoc
// Tous les documents d'un même "code famille" sont stockés ensemble et
// visibles par quiconque utilise ce code, sur n'importe quel appareil.
//
// Utilise Netlify Blobs (stockage clé/valeur intégré à Netlify, aucune
// base de données externe à configurer).
//
// ⚠️ Le code famille est la SEULE barrière d'accès : on limite donc le
//    débit par IP pour rendre le brute-force du code impraticable, et on
//    valide strictement son format avant toute lecture/écriture.

const { getClientIp, checkRateLimit, rateLimitResponse, getConfiguredStore } = require('./_rate-limit');

const CODE_RE = /^[A-Z0-9]{4,8}$/;

function normaliserCode(code) {
  return (code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

exports.handler = async function (event) {
  const ip = getClientIp(event);

  // Limite globale par IP : 60 requêtes / 5 minutes suffisent largement à un
  // usage familial normal (plusieurs appareils) tout en cassant le scan de codes.
  const rl = await checkRateLimit(`family:${ip}`, { limit: 60, windowSeconds: 300 });
  if (!rl.allowed) return rateLimitResponse(rl.resetAt);

  try {
    const store = getConfiguredStore('medidoc-familles');

    // ─── GET : récupérer tous les documents d'un code famille ───
    if (event.httpMethod === 'GET') {
      const code = normaliserCode(event.queryStringParameters?.code);
      if (!code || !CODE_RE.test(code)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Code famille invalide' }) };
      }

      const documents = await store.get(code, { type: 'json' });
      return { statusCode: 200, body: JSON.stringify({ documents: documents || [] }) };
    }

    // ─── POST : ajouter ou mettre à jour un document ───
    if (event.httpMethod === 'POST') {
      const { code: rawCode, document } = JSON.parse(event.body);
      const code = normaliserCode(rawCode);
      if (!code || !CODE_RE.test(code) || !document) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Données manquantes ou invalides' }) };
      }

      const documents = (await store.get(code, { type: 'json' })) || [];

      if (document.id) {
        const index = documents.findIndex(d => d.id === document.id);
        if (index >= 0) documents[index] = document;
        else documents.push(document);
      } else {
        document.id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        documents.push(document);
      }

      await store.setJSON(code, documents);
      return { statusCode: 200, body: JSON.stringify({ documents }) };
    }

    // ─── DELETE : supprimer un document, ou vider toute la famille ───
    if (event.httpMethod === 'DELETE') {
      const { code: rawCode, id, viderTout, confirm } = JSON.parse(event.body);
      const code = normaliserCode(rawCode);
      if (!code || !CODE_RE.test(code)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Code famille invalide' }) };
      }

      if (viderTout) {
        if (confirm !== true) {
          return { statusCode: 400, body: JSON.stringify({ error: 'Confirmation requise pour tout supprimer' }) };
        }
        await store.setJSON(code, []);
        return { statusCode: 200, body: JSON.stringify({ documents: [] }) };
      }

      const documents = (await store.get(code, { type: 'json' })) || [];
      const nouvelleListe = documents.filter(d => d.id !== id);
      await store.setJSON(code, nouvelleListe);
      return { statusCode: 200, body: JSON.stringify({ documents: nouvelleListe }) };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };

  } catch (err) {
    console.error('Erreur stockage famille :', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
