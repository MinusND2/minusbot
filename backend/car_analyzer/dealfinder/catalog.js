/**
 * BMW 4er Katalog
 * ----------------
 * Feste Fahrzeug-Stammdaten (Generationen, Varianten, Motoren).
 * Das sind KEINE Preisdaten – nur technische Fakten, mit denen ein Inserat
 * richtig eingeordnet wird (z. B. "420d, 2018" -> F32/F33/F36, Motor B47).
 *
 * Preise und Marktwerte kommen ausschließlich aus den erfassten Inseraten.
 */

// Generationen. "from"/"to" = Produktionsjahre (gerundet; Übergangsjahre sind unscharf).
const GENERATIONS = {
  F3x: {
    id: 'F3x',
    label: '4er F32/F33/F36 (2013–2020)',
    from: 2013,
    to: 2020,
    bodies: { 'Coupé': 'F32', 'Cabrio': 'F33', 'Gran Coupé': 'F36' }
  },
  G2x: {
    id: 'G2x',
    label: '4er G22/G23/G26 (seit 2020)',
    from: 2020,
    to: 2099,
    bodies: { 'Coupé': 'G22', 'Cabrio': 'G23', 'Gran Coupé': 'G26' }
  },
  F8x: {
    id: 'F8x',
    label: 'M4 F82/F83 (2014–2020)',
    from: 2014,
    to: 2020,
    bodies: { 'Coupé': 'F82', 'Cabrio': 'F83' }
  },
  G8x: {
    id: 'G8x',
    label: 'M4 G82/G83 (seit 2021)',
    from: 2021,
    to: 2099,
    bodies: { 'Coupé': 'G82', 'Cabrio': 'G83' }
  }
};

/**
 * Varianten je Generation. engine = Motorcode (passt zu reliabilityDatabase.json, falls vorhanden).
 * hp = typische Leistung(en) in PS. Wird zur Plausibilitätsprüfung und Generationserkennung genutzt.
 */
const VARIANTS = {
  F3x: {
    '418i': { fuel: 'Benzin', hp: [136], engine: 'BMW_B38' },
    '420i': { fuel: 'Benzin', hp: [184], engine: null, engineByYear: [{ to: 2016, code: 'BMW_N20' }, { from: 2016, code: 'BMW_B48' }] },
    '428i': { fuel: 'Benzin', hp: [245], engine: 'BMW_N20' },
    '430i': { fuel: 'Benzin', hp: [252], engine: 'BMW_B48' },
    '435i': { fuel: 'Benzin', hp: [306], engine: 'BMW_N55' },
    '440i': { fuel: 'Benzin', hp: [326], engine: 'BMW_B58' },
    '418d': { fuel: 'Diesel', hp: [143, 150], engine: null, engineByYear: [{ to: 2015, code: 'BMW_N47' }, { from: 2015, code: 'BMW_B47' }] },
    '420d': { fuel: 'Diesel', hp: [184, 190], engine: null, engineByYear: [{ to: 2015, code: 'BMW_N47' }, { from: 2015, code: 'BMW_B47' }] },
    '425d': { fuel: 'Diesel', hp: [218, 224], engine: null },
    '430d': { fuel: 'Diesel', hp: [258], engine: 'BMW_N57' },
    '435d': { fuel: 'Diesel', hp: [313], engine: 'BMW_N57' }
  },
  G2x: {
    '420i': { fuel: 'Benzin', hp: [184], engine: 'BMW_B48' },
    '430i': { fuel: 'Benzin', hp: [245, 258], engine: 'BMW_B48' },
    'M440i': { fuel: 'Benzin', hp: [374], engine: 'BMW_B58' },
    '420d': { fuel: 'Diesel', hp: [190], engine: 'BMW_B47' },
    '430d': { fuel: 'Diesel', hp: [286], engine: 'BMW_B57' },
    'M440d': { fuel: 'Diesel', hp: [340], engine: 'BMW_B57' }
  },
  F8x: {
    'M4': { fuel: 'Benzin', hp: [431, 450, 460, 500], engine: 'BMW_S55' }
  },
  G8x: {
    'M4': { fuel: 'Benzin', hp: [480, 510, 530, 550], engine: 'BMW_S58' }
  }
};

// Varianten, die es NUR in einer Generation gab -> eindeutige Zuordnung
function generationsForVariant(variant) {
  return Object.keys(VARIANTS).filter(g => VARIANTS[g][variant]);
}

/**
 * Erkennt die Variante (420d, M440i, M4 ...) aus einem Text.
 */
function detectVariant(text) {
  const t = ` ${text || ''} `;
  // M440i / M440d (vor "440i" prüfen)
  let m = t.match(/\bM\s?440\s?([id])\b/i);
  if (m) return `M440${m[1].toLowerCase()}`;
  // M4 (nicht "M4-Paket", nicht "M440")
  if (/\bM4\b(?!\s*-?\s*(paket|optik|look|style|lenkrad|felgen?))/i.test(t) && !/\bM4\s?40/i.test(t)) return 'M4';
  // 418i ... 440i, 418d ... 435d (auch "420 d", "420dA", "420d xDrive")
  m = t.match(/\b4(18|20|25|28|30|35|40)\s?([id])(?:a|\b|x)/i);
  if (m) return `4${m[1]}${m[2].toLowerCase()}`;
  return null;
}

function detectBody(text) {
  const t = (text || '').toLowerCase();
  if (/gran\s*coup[eé]|\bgc\b|f36\b|g26\b/.test(t)) return 'Gran Coupé';
  if (/cabrio|cabriolet|f33\b|g23\b|f83\b|g83\b/.test(t)) return 'Cabrio';
  if (/coup[eé]|f32\b|g22\b|f82\b|g82\b/.test(t)) return 'Coupé';
  return null;
}

function isBmw4Series(text) {
  const t = (text || '');
  return /\bbmw\b/i.test(t) && (/\b4er\b|\b4\s?-?\s?er\b|\b4\s?series\b/i.test(t) || !!detectVariant(t) || /\b(f3[236]|g2[236]|f8[23]|g8[23])\b/i.test(t));
}

/**
 * Ordnet Variante + Baujahr + Leistung einer Generation zu.
 * Gibt { generation, certain, reason } zurück.
 */
function detectGeneration({ variant, year, powerHp, text }) {
  const t = (text || '').toLowerCase();
  // 1. Expliziter Code im Text
  if (/\b(f32|f33|f36)\b/.test(t)) return { generation: 'F3x', certain: true, reason: 'Baureihencode im Inserat' };
  if (/\b(g22|g23|g26)\b/.test(t)) return { generation: variant === 'M4' ? 'G8x' : 'G2x', certain: true, reason: 'Baureihencode im Inserat' };
  if (/\b(f82|f83)\b/.test(t)) return { generation: 'F8x', certain: true, reason: 'Baureihencode im Inserat' };
  if (/\b(g82|g83)\b/.test(t)) return { generation: 'G8x', certain: true, reason: 'Baureihencode im Inserat' };

  if (variant === 'M4') {
    if (year && year <= 2020) return { generation: 'F8x', certain: year < 2020, reason: 'Baujahr' };
    if (year && year >= 2021) return { generation: 'G8x', certain: true, reason: 'Baujahr' };
    if (powerHp >= 480) return { generation: 'G8x', certain: true, reason: 'Leistung' };
    if (powerHp && powerHp <= 460) return { generation: 'F8x', certain: true, reason: 'Leistung' };
    return { generation: null, certain: false, reason: 'Baujahr fehlt' };
  }

  const gens = variant ? generationsForVariant(variant).filter(g => g === 'F3x' || g === 'G2x') : [];
  if (gens.length === 1) return { generation: gens[0], certain: true, reason: `Variante ${variant} gab es nur in dieser Generation` };

  // Leistung passt nur zu einer Generation?
  if (variant && powerHp) {
    const byHp = gens.filter(g => VARIANTS[g][variant].hp.some(h => Math.abs(h - powerHp) <= 4));
    if (byHp.length === 1) return { generation: byHp[0], certain: true, reason: 'Leistung passt eindeutig' };
  }
  if (year) {
    if (year <= 2019) return { generation: 'F3x', certain: true, reason: 'Baujahr' };
    if (year >= 2021) return { generation: 'G2x', certain: true, reason: 'Baujahr' };
    return { generation: 'G2x', certain: false, reason: 'Baujahr 2020 = Generationswechsel, unsicher' };
  }
  return { generation: null, certain: false, reason: 'Baujahr fehlt' };
}

function engineCodeFor(generation, variant, year) {
  const v = VARIANTS[generation] && VARIANTS[generation][variant];
  if (!v) return null;
  if (v.engine) return v.engine;
  if (v.engineByYear && year) {
    // Übergangsjahr: wir nehmen den älteren Motor nur, wenn eindeutig davor
    const hit = v.engineByYear.find(e => (e.from ? year > e.from : true) && (e.to ? year < e.to : true));
    if (hit) return hit.code;
  }
  return null; // unbekannt / Übergangsjahr
}

function fuelForVariant(variant) {
  if (!variant) return null;
  if (variant === 'M4') return 'Benzin';
  return /d$/.test(variant) ? 'Diesel' : 'Benzin';
}

function allVariants() {
  const set = new Set();
  Object.values(VARIANTS).forEach(g => Object.keys(g).forEach(v => set.add(v)));
  return [...set];
}

module.exports = {
  GENERATIONS,
  VARIANTS,
  detectVariant,
  detectBody,
  detectGeneration,
  isBmw4Series,
  engineCodeFor,
  fuelForVariant,
  allVariants
};
