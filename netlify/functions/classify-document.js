// Netlify Function — Classification automatique de documents médicaux
// Utilise l'API Claude (Anthropic) en vision pour déterminer la catégorie
// d'un document médical, la spécialité du médecin concerné, le type
// d'examen (compte-rendu/imagerie), la personne du foyer visée, les
// dates/heure/lieu d'un rendez-vous, et les coordonnées d'un médecin/cabinet
// détectées sur le document — en miroir exact du prompt utilisé côté client
// lorsqu'une clé API personnelle est configurée (voir construirePromptClassification()
// dans index.html), pour un comportement identique quel que soit le mode utilisé.
//
// ⚠️ Nécessite une variable d'environnement ANTHROPIC_API_KEY définie dans
//    Netlify (Site settings → Environment variables), jamais exposée au client.

// Valeurs par défaut si le client n'envoie pas ses propres listes (rétro-
// compatibilité) — tenues à jour avec les dictionnaires CATEGORIES/
// SPECIALITES_PAR_DEFAUT/TYPES_COMPTE_RENDU/TYPES_IMAGERIE de index.html.
const CATEGORY_DESCRIPTIONS = {
  vitale:      "Carte Vitale française (carte verte de l'Assurance Maladie avec puce et numéro de sécurité sociale)",
  mutuelle:    "Carte ou attestation de mutuelle / assurance complémentaire santé (carte de tiers payant, attestation de droits)",
  imagerie:    "Radiographie, IRM, scanner/TDM ou échographie — les clichés eux-mêmes ou le document qui les accompagne sans être un compte-rendu rédigé",
  analyse:     "Résultats d'analyse de sang ou de biologie médicale (tableau de valeurs, laboratoire)",
  ordonnance:  "Ordonnance médicale : prescription de médicaments ou d'examens, à venir (contient souvent une posologie et la signature du médecin)",
  compterendu: "Compte-rendu médical rédigé par un médecin décrivant les constatations/conclusions d'un examen déjà réalisé",
  rdv:         "Convocation ou confirmation d'un rendez-vous médical FUTUR (date à venir, créneau horaire)",
  mgen:        "Document émis par la mutuelle MGEN : relevé de remboursement, attestation de droits, courrier MGEN",
  medecin:     "Carte de visite d'un médecin/professionnel de santé ou plaque professionnelle — coordonnées du praticien uniquement, pas un acte médical",
  autre:       "Tout autre document médical qui ne correspond à aucune catégorie ci-dessus"
};

const SPECIALITE_DESCRIPTIONS = {
  traitant:       "Médecin généraliste / médecin traitant",
  rhumatologue:   "Rhumatologue (articulations, os, dos)",
  gynecologue:    "Gynécologue",
  cardiologue:    "Cardiologue (cœur)",
  dermatologue:   "Dermatologue (peau)",
  ophtalmologue:  "Ophtalmologue (yeux)",
  orl:            "ORL (oreilles, nez, gorge)",
  dentiste:       "Dentiste / chirurgien-dentiste",
  orthodontiste:  "Orthodontiste (alignement dentaire, appareils)",
  pediatre:       "Pédiatre (enfants)",
  psychiatre:     "Psychiatre",
  kine:           "Kinésithérapeute",
  angiologue:     "Angiologue (vaisseaux sanguins, veines)",
  podologue:      "Podologue (pieds)",
  endocrinologue: "Endocrinologue (hormones, diabète, thyroïde)",
  gastro:         "Gastro-entérologue (système digestif)",
  urologue:       "Urologue (appareil urinaire)",
  neurologue:     "Neurologue (système nerveux)",
  osteopathe:     "Ostéopathe",
  allergologue:   "Allergologue",
  pneumologue:    "Pneumologue (poumons, respiration)",
  nephrologue:    "Néphrologue (reins)",
  dieteticien:    "Diététicien / Nutritionniste",
  orthopediste:   "Chirurgien orthopédique",
  autre_spe:      "Spécialité non identifiable ou non listée ci-dessus"
};

const TYPE_CR_DESCRIPTIONS = {
  irm:      "Le compte-rendu concerne une IRM",
  scanner:  "Le compte-rendu concerne un scanner / TDM",
  radio:    "Le compte-rendu concerne une radiographie",
  echo:     "Le compte-rendu concerne une échographie",
  autre_cr: "Type d'examen non identifiable ou non listé ci-dessus"
};

const TYPE_IMAGERIE_DESCRIPTIONS = {
  irm:           "Le document concerne une IRM",
  echographie:   "Le document concerne une échographie",
  radiologie:    "Le document concerne une radiographie standard",
  mammographie:  "Le document concerne une mammographie",
  densitometrie: "Le document concerne une densitométrie osseuse",
  scanner:       "Le document concerne un scanner / TDM",
  autre_img:     "Type d'imagerie non identifiable ou non listé ci-dessus"
};

const { getClientIp, checkRateLimit, rateLimitResponse } = require('./_rate-limit');

// Taille max d'une image encodée en base64 (~6 Mo de photo réelle une fois décodée).
const MAX_BASE64_LENGTH = 8 * 1024 * 1024;

function construireDescriptions(dict, cles) {
  const liste = (cles && cles.length ? cles : Object.keys(dict));
  return liste.map(c => `  • "${c}" : ${dict[c] || c}`).join('\n');
}

function construirePrompt(catList, speList, typeCrList, typeImgList) {
  const descCategories = construireDescriptions(CATEGORY_DESCRIPTIONS, catList);
  const descSpecialites = construireDescriptions(SPECIALITE_DESCRIPTIONS, speList);
  const descTypeCr = construireDescriptions(TYPE_CR_DESCRIPTIONS, typeCrList);
  const descTypeImg = construireDescriptions(TYPE_IMAGERIE_DESCRIPTIONS, typeImgList);

  return `Tu es un assistant qui classe des documents médicaux français. Analyse ce document et réponds UNIQUEMENT avec un objet JSON, sans texte autour et sans balises markdown, au format exact :
{"categorie": "...", "specialite": "...", "typeCompteRendu": "...", "typeImagerie": "...", "personne": "...", "dateExamen": "...", "dateRdv": "...", "heureRdv": "...", "lieuRdv": "...", "nomMedecin": "...", "telephoneMedecin": "...", "adresseMedecin": "...", "adresseMedecin2": "...", "emailMedecin": "..."}

CATÉGORIE — choisis la valeur la plus précise parmi :
${descCategories}
Repères pour ne pas confondre les catégories proches :
- "ordonnance" = prescription du médecin : liste de médicaments/soins/examens PRESCRITS, à venir. Contient presque toujours le mot "Prescription" ou "Ordonnance", des noms de médicaments avec posologie (ex : "1 comprimé matin et soir"), et une signature de médecin. C'est une instruction pour la suite, pas un résultat.
- "compterendu" = rapport RÉDIGÉ décrivant les CONSTATATIONS ou conclusions d'un examen déjà réalisé (texte en paragraphes : "Conclusion :", "Résultat de l'examen :"). Si le document accompagne une imagerie (radio, IRM, scanner, écho) sous forme de texte médical interprétatif (pas des images), classe-le "compterendu", pas "imagerie" (qui est réservée aux images de l'examen lui-même).
- "imagerie" = radios, IRM, scanners/TDM, échographies — qu'il s'agisse des clichés eux-mêmes ou du document qui les accompagne sans être un compte-rendu rédigé.
- "analyse" = résultats chiffrés d'un laboratoire (tableau de valeurs biologiques, sang/urine).
- "vitale"/"mutuelle" = carte d'assuré (Carte Vitale, carte de mutuelle), pas un document médical.
- "rdv" = tout document qui annonce un rendez-vous/une convocation FUTURE : convocation papier, SMS/e-mail de confirmation imprimé, carton de rendez-vous, bon d'examen avec une date à venir. Repère les mots "convocation", "rendez-vous", "vous êtes attendu(e) le", "RDV", une date qui n'est pas encore passée, un créneau horaire. Priorise "rdv" sur les autres catégories dès que ces indices sont présents, même si le document mentionne aussi un type d'examen (IRM, scanner...) à venir — dans ce cas c'est quand même "rdv" (l'examen n'a pas encore eu lieu).
- "mgen" = tout document émis par la mutuelle MGEN : relevé de remboursement/décompte de prestations, attestation de droits, courrier ou notification MGEN. Repère le logo/nom "MGEN", "décompte", "remboursement mutuelle", "attestation de tiers payant".
- "medecin" = carte de visite d'un médecin/professionnel de santé, plaque professionnelle photographiée, ou tampon de cabinet isolé — un document dont le seul intérêt est les COORDONNÉES du praticien (nom, téléphone, adresse), pas un acte médical du patient. Priorise cette catégorie dès que le document est essentiellement une carte de visite ou une plaque, même s'il mentionne aussi une spécialité.

SPÉCIALITÉ — s'applique à TOUTE catégorie de document, pas seulement les ordonnances. Cherche partout où le nom d'un médecin/spécialiste apparaît : en-tête, tampon, signature, mention "Docteur demandé par", "Prescripteur", "Médecin traitant"... Mets "autre_spe" uniquement si vraiment aucun nom ni spécialité de médecin n'apparaît sur le document. Valeurs possibles :
${descSpecialites}

TYPE DE COMPTE-RENDU — ne s'applique que si categorie = "compterendu" (sinon mets "autre_cr"). Valeurs possibles :
${descTypeCr}

TYPE D'IMAGERIE — ne s'applique que si categorie = "imagerie" (sinon mets "autre_img"). Identifie précisément le type d'examen d'imagerie. Valeurs possibles :
${descTypeImg}

PERSONNE — le document est-il au nom d'un homme ou d'une femme ? Regarde la civilité du PATIENT (pas du médecin) écrite sur le document : "M.", "Monsieur" → "monsieur" ; "Mme", "Madame" → "madame". Si la civilité n'est pas identifiable avec certitude, mets "inconnu".

DATE DE L'EXAMEN — s'applique à TOUTE catégorie (sauf "rdv", voir plus bas ; sauf "vitale"/"mutuelle" qui n'ont pas de date). Cherche la date à laquelle l'examen/l'acte a réellement eu lieu (ou la date de rédaction pour une ordonnance) : "Date de l'examen :", "Réalisé le :", la date en haut du courrier, la date de signature... Format AAAA-MM-JJ. Déduis l'année si elle n'est pas écrite. Si aucune date claire n'est trouvée, mets "".

DATE/HEURE/LIEU DU RDV — ne s'appliquent que si categorie = "rdv" (sinon mets "" pour les trois, et utilise "dateExamen" ci-dessus à la place) :
- "dateRdv" : la date du rendez-vous au format AAAA-MM-JJ. Déduis l'année si elle n'est pas écrite (à partir du contexte, ou l'année en cours si rien d'autre n'indique le contraire). Si aucune date claire n'est trouvée, mets "".
- "heureRdv" : l'heure au format "14h30" ou "14:30" telle qu'écrite sur le document. Si absente, mets "".
- "lieuRdv" : le lieu/service/adresse du rendez-vous tel qu'écrit (ex : "Cabinet Dr Martin, 12 rue de la Paix" ou "Clinique Clairval, service Imagerie, 2ème étage"). Si absent, mets "".

COORDONNÉES DU MÉDECIN/CABINET — cherche partout sur le document (en-tête, tampon, pied de page, signature) les coordonnées du médecin ou du cabinet/centre identifié dans "specialite" ci-dessus. Si plusieurs médecins apparaissent (ex. prescripteur ET exécutant), privilégie celui qui correspond à la spécialité détectée.
- "nomMedecin" : nom complet du médecin ou du cabinet/centre (ex : "Dr Martin" ou "Cabinet Radiologie du Var"). Si absent, mets "".
- "telephoneMedecin" : numéro de téléphone tel qu'écrit. Si absent, mets "".
- "adresseMedecin" : adresse postale telle qu'écrite. Si absente, mets "".
- "adresseMedecin2" : si le document mentionne un DEUXIÈME cabinet/lieu de consultation pour ce même médecin (cas fréquent sur une carte de visite : "Cabinet principal" + "Consultations secondaires"), son adresse. Si un seul cabinet, mets "".
- "emailMedecin" : adresse email du médecin/cabinet si présente. Si absente, mets "".

Réponds uniquement avec le JSON, rien d'autre.`;
}

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

  const REPLI = { categorie: 'autre', specialite: 'autre_spe', typeCompteRendu: 'autre_cr', typeImagerie: 'autre_img', personne: '', dateExamen: '', dateRdv: '', heureRdv: '', lieuRdv: '', nomMedecin: '', telephoneMedecin: '', adresseMedecin: '', adresseMedecin2: '', emailMedecin: '' };

  try {
    const { image, mimeType, categories, specialites, typesCompteRendu, typesImagerie } = JSON.parse(event.body);

    if (!image || !mimeType) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Image manquante' }) };
    }

    if (image.length > MAX_BASE64_LENGTH) {
      return { statusCode: 413, body: JSON.stringify({ error: 'Document trop volumineux' }) };
    }

    const base64Data = image.split(',')[1];
    const estPdf = mimeType === 'application/pdf';
    const blocFichier = estPdf
      ? { type: 'document', source: { type: 'base64', media_type: mimeType, data: base64Data } }
      : { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Data } };

    const catList = categories || Object.keys(CATEGORY_DESCRIPTIONS);
    const speList = specialites || Object.keys(SPECIALITE_DESCRIPTIONS);
    const typeCrList = typesCompteRendu || Object.keys(TYPE_CR_DESCRIPTIONS);
    const typeImgList = typesImagerie || Object.keys(TYPE_IMAGERIE_DESCRIPTIONS);
    const prompt = construirePrompt(catList, speList, typeCrList, typeImgList);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [blocFichier, { type: 'text', text: prompt }]
        }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Erreur API Anthropic:', errText);
      return { statusCode: 200, body: JSON.stringify(REPLI) };
    }

    const data = await response.json();
    const rawText = (data.content?.[0]?.text || '').trim();

    let resultat = { ...REPLI };
    try {
      // On extrait le premier objet JSON trouvé dans la réponse, au cas où
      // le modèle ajouterait du texte parasite malgré la consigne.
      const match = rawText.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match ? match[0] : rawText);

      if (parsed.categorie && catList.includes(parsed.categorie)) resultat.categorie = parsed.categorie;
      if (parsed.specialite && speList.includes(parsed.specialite)) resultat.specialite = parsed.specialite;
      if (parsed.typeCompteRendu && typeCrList.includes(parsed.typeCompteRendu)) resultat.typeCompteRendu = parsed.typeCompteRendu;
      if (parsed.typeImagerie && typeImgList.includes(parsed.typeImagerie)) resultat.typeImagerie = parsed.typeImagerie;
      if (parsed.personne === 'monsieur' || parsed.personne === 'madame') resultat.personne = parsed.personne;
      if (/^\d{4}-\d{2}-\d{2}$/.test(parsed.dateExamen || '')) resultat.dateExamen = parsed.dateExamen;
      if (/^\d{4}-\d{2}-\d{2}$/.test(parsed.dateRdv || '')) resultat.dateRdv = parsed.dateRdv;
      if (parsed.heureRdv) resultat.heureRdv = String(parsed.heureRdv).trim();
      if (parsed.lieuRdv) resultat.lieuRdv = String(parsed.lieuRdv).trim();
      if (parsed.nomMedecin) resultat.nomMedecin = String(parsed.nomMedecin).trim();
      if (parsed.telephoneMedecin) resultat.telephoneMedecin = String(parsed.telephoneMedecin).trim();
      if (parsed.adresseMedecin) resultat.adresseMedecin = String(parsed.adresseMedecin).trim();
      if (parsed.adresseMedecin2) resultat.adresseMedecin2 = String(parsed.adresseMedecin2).trim();
      if (parsed.emailMedecin) resultat.emailMedecin = String(parsed.emailMedecin).trim();
    } catch (parseErr) {
      console.error('Réponse IA non-JSON, repli sur "autre" :', rawText);
    }

    return { statusCode: 200, body: JSON.stringify(resultat) };

  } catch (err) {
    console.error('Erreur classification:', err);
    return { statusCode: 200, body: JSON.stringify(REPLI) };
  }
};
