// Rate limiting basique partagé entre les fonctions Netlify.
// Utilise Netlify Blobs comme compteur (best-effort : pas garanti
// atomique sous forte concurrence, mais largement suffisant pour
// stopper le scraping/brute-force et les abus de coût API).

const { getStore } = require('@netlify/blobs');

