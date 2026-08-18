// Netlify Function — Classification automatique de documents médicaux
// Utilise l'API Claude (Anthropic) en vision pour déterminer la catégorie
// d'un document médical à partir d'une photo, la spécialité du médecin
// prescripteur si c'est une ordonnance, et le type d'examen concerné si
// c'est un compte-rendu.
//
// ⚠️ Nécessite une variable d'environnement ANTHROPIC_API_KEY définie dans
//    Netlify (Site settings → Environment variables), jamais exposée au client.

const CATEGORY_DESCRIPTIONS = {
  vitale:      "Carte Vitale française (carte verte de l'Assurance Maladie avec puce et numéro de sécurité sociale)",
  mutuelle:    "Carte ou attestation de mutuelle / assurance complémentaire santé (carte de tiers payant, attestation de droits)",
  radio:       "Radiographie (image en noir et blanc d'os, poumons, dents...)",
  irm:         "Compte-rendu ou image d'IRM (Imagerie par Résonance Magnétique)",
  scanner:     "Compte-rendu ou image de scanner / TDM (tomodensitométrie)",
  analyse:     "Résultats d'analyse de sang ou de biologie médicale (tableau de valeurs, laboratoire)",
  ordonnance:  "Ordonnance médicale (prescription de médicaments ou d'examens)",
  compterendu: "Compte-rendu médical écrit par un médecin (texte d'interprétation d'un examen : IRM, scanner, radio, échographie...)",
  echo:        "Compte-rendu ou image d'échographie",
  autre:       "Tout autre document médical qui ne correspond à aucune catégorie ci-dessus"
};

const SPECIALITE_DESCRIPTIONS = {
  traitant:      "Médecin généraliste / médecin traitant",
  rhumatologue:  "Rhumatologue (articulations, os, dos)",
  gynecologue:   "Gynécologue",
  cardiologue:   "Cardiologue (cœur)",
  dermatologue:  "Dermatologue (peau)",
  ophtalmologue: "Ophtalmologue (yeux)",
  orl:           "ORL (oreilles, nez, gorge)",
  dentiste:      "Dentiste / chirurgien-dentiste",
  pediatre:      "Pédiatre (enfants)",
  psychiatre:    "Psychiatre",
  kine:          "Kinésithérapeute",
  autre_spe:     "Spécialité non identifiable ou non listée ci-dessus"
};

const TYPE_CR_DESCRIPTIONS = {
  irm:      "Le compte-rendu concerne une IRM",
  scanner:  "Le compte-rendu concerne un scanner / TDM",
  radio:    "Le compte-rendu concerne une radiographie",
  echo:     "Le compte-rendu concerne une échographie",
  autre_cr: "Type d'examen non identifiable ou non listé ci-dessus"
};

const { getClientIp, checkRateLimit, rateLimitResponse } = require('./_rate-limit');

// Taille max d'une image encodée en base64 (~6 Mo de photo réelle une fois décodée).
const MAX_BASE64_LENGTH = 8 * 1024 * 1024;

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Chaque appel coûte un appel à l'API Anthropic (facturé). On limite donc
  // fortement le débit par IP pour empêcher qu'un tiers non authentifié
  // fasse exploser la facture.
  const ip = getClientIp(event);
  const rl = await checkRateLimit(`classify:${ip}`, { limit: 20, windowSeconds: 600 });
  if (!rl.allowed) return rateLimitResponse(rl.resetAt);

  try {
    const { image, mimeType, categories, specialites, typesCompteRendu } = JSON.parse(event.body);

    if (!image || !mimeType) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Image manquante' }) };
    }

    if (image.length > MAX_BASE64_LENGTH) {
      return { statusCode: 413, body: JSON.stringify({ error: 'Image trop volumineuse' }) };
    }

    // Les PDF ne sont pas envoyés en vision ici (simplification) : on classe
    // en "autre" et l'utilisateur peut corriger manuellement.
    if (mimeType === 'application/pdf') {
      return { statusCode: 200, body: JSON.stringify({ categorie: 'autre', specialite: 'autre_spe', typeCompteRendu: 'autre_cr' }) };
    }

    const base64Data = image.split(',')[1];
    const catList = (categories || Object.keys(CATEGORY_DESCRIPTIONS));
    const speList = (specialites || Object.keys(SPECIALITE_DESCRIPTIONS));
    const typeCrList = (typesCompteRendu || Object.keys(TYPE_CR_DESCRIPTIONS));
    const catDescriptions = catList.map(c => `- "${c}" : ${CATEGORY_DESCRIPTIONS[c] || c}`).join('\n');
    const speDescriptions = speList.map(s => `- "${s}" : ${SPECIALITE_DESCRIPTIONS[s] || s}`).join('\n');
    const typeCrDescriptions = typeCrList.map(t => `- "${t}" : ${TYPE_CR_DESCRIPTIONS[t] || t}`).join('\n');

    const prompt = `Voici une photo d'un document médical. Analyse-la et réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte autour, au format exact :
{"categorie": "...", "specialite": "...", "typeCompteRendu": "..."}

Pour "categorie", choisis EXACTEMENT une de ces clés :
${catDescriptions}

Pour "specialite" : UNIQUEMENT si categorie = "ordonnance", détermine la spécialité du médecin prescripteur (regarde l'en-tête, le cachet, le titre du praticien) parmi EXACTEMENT ces clés :
${speDescriptions}
Si categorie n'est pas "ordonnance", mets "specialite": "autre_spe".

Pour "typeCompteRendu" : UNIQUEMENT si categorie = "compterendu", détermine à quel type d'examen ce compte-rendu se rapporte (regarde le titre du document, les mots-clés comme "IRM", "scanner", "radiographie", "échographie") parmi EXACTEMENT ces clés :
${typeCrDescriptions}
Si categorie n'est pas "compterendu", mets "typeCompteRendu": "autre_cr".

Réponds uniquement avec le JSON, rien d'autre.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 80,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Data } },
            { type: 'text', text: prompt }
          ]
        }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Erreur API Anthropic:', errText);
      return { statusCode: 200, body: JSON.stringify({ categorie: 'autre', specialite: 'autre_spe', typeCompteRendu: 'autre_cr' }) };
    }

    const data = await response.json();
    const rawText = (data.content?.[0]?.text || '').trim();

    let categorie = 'autre';
    let specialite = 'autre_spe';
    let typeCompteRendu = 'autre_cr';
    try {
      // On extrait le premier objet JSON trouvé dans la réponse, au cas où
      // le modèle ajouterait du texte parasite malgré la consigne.
      const match = rawText.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match ? match[0] : rawText);
      if (parsed.categorie && catList.includes(parsed.categorie)) categorie = parsed.categorie;
      if (parsed.specialite && speList.includes(parsed.specialite)) specialite = parsed.specialite;
      if (parsed.typeCompteRendu && typeCrList.includes(parsed.typeCompteRendu)) typeCompteRendu = parsed.typeCompteRendu;
    } catch (parseErr) {
      console.error('Réponse IA non-JSON, repli sur "autre" :', rawText);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ categorie, specialite, typeCompteRendu })
    };

  } catch (err) {
    console.error('Erreur classification:', err);
    return { statusCode: 200, body: JSON.stringify({ categorie: 'autre', specialite: 'autre_spe', typeCompteRendu: 'autre_cr' }) };
  }
};
