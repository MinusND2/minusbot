/**
 * Liest ein Inserat aus kopiertem Text (mobile.de, AutoScout24, Kleinanzeigen, Händlerseite ...)
 * oder aus einer CSV-Zeile und macht daraus einen einheitlichen Datensatz.
 *
 * Grundregel: Was nicht sicher im Text steht, bleibt null (= unbekannt).
 * Unbekannt wird NIE als "gut" gewertet.
 */
const catalog = require('./catalog');

const CURRENT_YEAR = () => new Date().getFullYear();

function toInt(str) {
  if (str === null || str === undefined) return null;
  const n = parseInt(String(str).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

// ---------- Einzelne Felder ----------

function findPrice(text) {
  // Zahlen wie 32.990 €, € 32.990,-, 32990 EUR, 32.990,00 €
  const re = /(?:€\s*)?(\d{1,3}(?:[.\s]\d{3})+|\d{4,6})(?:,\d{2}|,-)?\s*(€|eur\b|euro\b)?/gi;
  const candidates = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const hasEuroBefore = /€\s*$/.test(text.slice(Math.max(0, m.index - 2), m.index + 1)) || m[0].trim().startsWith('€');
    const hasEuroAfter = !!m[2];
    if (!hasEuroBefore && !hasEuroAfter) continue;
    const value = toInt(m[1]);
    if (!value || value < 1000 || value > 400000) continue;
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 25).toLowerCase();
    const before = text.slice(Math.max(0, m.index - 40), m.index).toLowerCase();
    // Monatsraten, Neupreise, Anzahlungen, Netto-Preise usw. überspringen
    if (/^\s*(\/|pro|mtl|monat|im monat|p\.\s?m)/.test(after)) continue;
    if (/(rate|monatlich|anzahlung|schlussrate|neupreis|listenpreis|np\b|uvp|netto|ersparnis|sie sparen|leasing)[^\n]{0,25}$/.test(before)) continue;
    // Preis direkt nach "Preis"/"Kaufpreis" bevorzugen
    const labelled = /(preis|kaufpreis|barpreis|verkaufspreis|vb|festpreis)[^\n]{0,15}$/.test(before);
    candidates.push({ value, labelled, index: m.index });
  }
  if (!candidates.length) return null;
  const labelled = candidates.find(c => c.labelled);
  return (labelled || candidates[0]).value;
}

function findMileage(text) {
  const labelled = text.match(/(?:kilometerstand|laufleistung|km-stand|kilometer)[\s:]*?(\d{1,3}(?:[.\s]\d{3})+|\d{1,6})\s*km\b/i);
  if (labelled) return toInt(labelled[1]);
  const re = /(\d{1,3}(?:[.\s]\d{3})+|\d{3,6})\s*km\b(?!\s*\/\s*h)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 30), m.index).toLowerCase();
    if (/(reichweite|umkreis|entfernt|entfernung|radius|garantie|bis zu|alle|intervall|service)/.test(before)) continue;
    const v = toInt(m[1]);
    if (v !== null && v <= 999999) return v;
  }
  return null;
}

function findFirstRegistration(text) {
  // Gibt { year, month } zurück
  const labelled = text.match(/(?:erstzulassung|\bez\b|baujahr|zulassung)[\s:.]*?(\d{1,2})\s*[\/.\-]\s*((?:19|20)\d{2})/i);
  if (labelled) return { month: toInt(labelled[1]), year: toInt(labelled[2]) };
  const labelledYearOnly = text.match(/(?:erstzulassung|\bez\b|baujahr)[\s:.]*?((?:19|20)\d{2})\b/i);
  if (labelledYearOnly) return { month: null, year: toInt(labelledYearOnly[1]) };
  const any = text.match(/\b(0?[1-9]|1[0-2])\s*\/\s*((?:20)[0-3]\d)\b/);
  if (any) return { month: toInt(any[1]), year: toInt(any[2]) };
  return { month: null, year: null };
}

function findPower(text) {
  let m = text.match(/(\d{2,3})\s*kw\s*\(\s*(\d{2,3})\s*ps\s*\)/i);
  if (m) return { kw: toInt(m[1]), hp: toInt(m[2]) };
  m = text.match(/(\d{2,3})\s*ps\s*\(\s*(\d{2,3})\s*kw\s*\)/i);
  if (m) return { hp: toInt(m[1]), kw: toInt(m[2]) };
  m = text.match(/(\d{2,3})\s*ps\b/i);
  if (m) return { hp: toInt(m[1]), kw: Math.round(toInt(m[1]) / 1.35962) };
  m = text.match(/(\d{2,3})\s*kw\b/i);
  if (m) return { kw: toInt(m[1]), hp: Math.round(toInt(m[1]) * 1.35962) };
  return { hp: null, kw: null };
}

function findOwners(text) {
  let m = text.match(/(?:anzahl der fahrzeughalter|fahrzeughalter|vorbesitzer|halter)[\s:]*?(\d{1,2})\b/i);
  if (m) return toInt(m[1]);
  m = text.match(/\b(\d)\s*\.?\s*hand\b/i);
  if (m) return toInt(m[1]);
  if (/\berste hand\b|\berster hand\b/i.test(text)) return 1;
  return null;
}

function findAccident(text) {
  const t = text.toLowerCase();
  if (/nicht unfallfrei|unfallfrei[\s:]*nein/.test(t)) return { accidentFree: false, note: 'nicht unfallfrei' };
  const damage = /(unfallwagen|unfallfahrzeug|unfallschaden|unfallschäden|vorschaden|vorschäden|hagelschaden|reparierte[rn]?\s+(unfall|schaden)|unfall\s*-?\s*instandgesetzt|repariert(er)? unfall|(?<!un)beschädigt)/g;
  let m;
  while ((m = damage.exec(t)) !== null) {
    const before = t.slice(Math.max(0, m.index - 18), m.index);
    // "keine Vorschäden", "ohne Unfallschaden", "kein Unfallwagen" sind KEIN Schaden
    if (/(kein|keine|keinen|ohne|frei von|nie)\s*$/.test(before)) continue;
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 8);
    if (/^[\s:]*(nein|keine?)\b/.test(after)) continue;
    return { accidentFree: false, note: m[0] };
  }
  if (/\bunfallfrei\b/.test(t)) return { accidentFree: true, note: 'unfallfrei' };
  return { accidentFree: null, note: null };
}

function findSellerType(text) {
  const t = text.toLowerCase();
  if (/privatanbieter|privatverkauf|privater anbieter|von privat|\bprivat\b/.test(t)) return 'privat';
  if (/händler|haendler|autohaus|gmbh|\bag\b|\bkg\b|gewerblich|mwst\.? ausweisbar|niederlassung/.test(t)) return 'haendler';
  return null;
}

function findZip(text) {
  const re = /\b(?:DE[- ])?(\d{5})[ \t]+([A-ZÄÖÜ][a-zäöüß]+(?:(?: |-)(?:am|an|im|bei|ob|[A-ZÄÖÜ][a-zäöüß]+)(?:(?: |-)[A-ZÄÖÜ][a-zäöüß]+)?)?)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (/^(Euro|EUR|Km|Kilometer|Ps|Kw)$/i.test(m[2])) continue;
    return { zip: m[1], city: m[2] };
  }
  return { zip: null, city: null };
}

function findTransmission(text) {
  const t = text.toLowerCase();
  if (/automatik|steptronic|automatic|\bat\b|sportautomatik/.test(t)) return 'Automatik';
  if (/schaltgetriebe|handschalter|manuell|6-gang|6 gang/.test(t)) return 'Schaltgetriebe';
  return null;
}

function findFuel(text) {
  const t = text.toLowerCase();
  if (/kraftstoff(art)?[\s:]*diesel|\bdiesel\b/.test(t)) return 'Diesel';
  if (/kraftstoff(art)?[\s:]*(benzin|super)|\bbenzin\b|\bsuper plus\b/.test(t)) return 'Benzin';
  if (/hybrid/.test(t)) return 'Hybrid';
  return null;
}

const FEATURE_PATTERNS = [
  ['M Sportpaket', /m[\s-]?sport(?:paket)?\b|m[\s-]paket|m sport pro/i],
  ['Head-Up Display', /head[\s-]?up|\bhud\b/i],
  ['Harman Kardon', /harman/i],
  ['Laserlicht / Adaptive LED', /laserlicht|adaptive[sr]? led|laser light/i],
  ['Glas-/Schiebedach', /schiebedach|glasdach|panorama/i],
  ['Live Cockpit Professional', /live cockpit professional|navigation(ssystem)? professional|navi prof/i],
  ['Aktive Geschwindigkeitsregelung (ACC)', /aktive geschwindigkeitsregelung|\bacc\b|abstandstempomat|driving assistant prof/i],
  ['Anhängerkupplung', /anhängerkupplung|\bahk\b/i],
  ['Leder', /\bleder\b|vernasca|dakota/i],
  ['Rückfahrkamera', /rückfahrkamera|surround view|parking assistant/i],
  ['Sitzheizung', /sitzheizung/i],
  ['Scheckheft', /scheckheft/i],
  ['Garantie', /garantie|gewährleistung/i],
  ['xDrive (Allrad)', /xdrive/i]
];

const RISK_WORDS = [
  { re: /motorschaden|motor defekt|getriebeschaden|getriebe defekt/i, label: 'Motor-/Getriebeschaden erwähnt', level: 'hoch' },
  { re: /nicht fahrbereit|fahruntüchtig|bastlerfahrzeug|\bbastler\b|für bastler/i, label: 'Nicht fahrbereit / Bastlerfahrzeug', level: 'hoch' },
  { re: /\bexport\b|gewerbe\s*\/\s*export|nur export|händler\s*\/\s*export/i, label: 'Export-/Gewerbeangebot (oft ohne Gewährleistung, Zustand unklar)', level: 'mittel' },
  { re: /\bdefekt\b|startet nicht|warnleuchte|motorkontrollleuchte|ölverlust|steuerkette (rasselt|defekt|geräusch)/i, label: 'Defekt / Störung im Text erwähnt', level: 'mittel' },
  { re: /ohne tüv|tüv abgelaufen|hu abgelaufen|ohne hu/i, label: 'Ohne gültige HU/TÜV', level: 'mittel' },
  { re: /wasserschaden|überschwemm|flutschaden|brandschaden/i, label: 'Wasser-/Brandschaden erwähnt', level: 'hoch' },
  { re: /kilometerstand nicht garantiert|tacho (getauscht|manipul)|km nicht garantiert/i, label: 'Kilometerstand nicht garantiert', level: 'hoch' },
  { re: /\breimport\b|eu-?fahrzeug|eu-?neuwagen|importfahrzeug/i, label: 'Re-/EU-Import (Ausstattung & Historie genau prüfen)', level: 'niedrig' },
  { re: /zahlung (nur )?(per|über) (western union|paypal freunde)|nur vorkasse|fahrzeug (steht|befindet sich) im ausland|spedition liefert/i, label: 'Typische Betrugsmerkmale (Vorkasse/Ausland/Spedition)', level: 'hoch' }
];

function detectPlatform(url) {
  if (!url) return 'manuell';
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (host.includes('mobile.de')) return 'mobile.de';
    if (host.includes('autoscout24')) return 'AutoScout24';
    if (host.includes('kleinanzeigen')) return 'Kleinanzeigen';
    if (host.includes('autouncle')) return 'AutoUncle';
    if (host.includes('pkw.de')) return 'pkw.de';
    if (host.includes('bmw')) return 'BMW Händler';
    return host;
  } catch (e) {
    return 'manuell';
  }
}

/**
 * Normalisiert eine URL, damit dasselbe Inserat nicht doppelt gespeichert wird.
 * Behält nur Parameter, die das Inserat identifizieren (z. B. ?id=).
 */
function normalizeUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    const keep = new URLSearchParams();
    if (u.searchParams.get('id')) keep.set('id', u.searchParams.get('id'));
    const qs = keep.toString();
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${qs ? '?' + qs : ''}`.toLowerCase();
  } catch (e) {
    return null;
  }
}

function extractExternalId(url) {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    if (u.searchParams.get('id')) return u.searchParams.get('id');
    const m = u.pathname.match(/(\d{6,})/) || u.pathname.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

function findUrl(text) {
  const m = (text || '').match(/https?:\/\/[^\s"'<>]+/i);
  return m ? m[0].replace(/[),.;]+$/, '') : null;
}

function findTitle(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const hit = lines.find(l => /bmw|\b4er\b|\bm4\b|\b4[1-4][0-9][id]\b|m440/i.test(l) && l.length <= 140 && !/^https?:/i.test(l));
  return hit || (lines[0] || '').slice(0, 140);
}

/**
 * Hauptfunktion: Text -> Datensatz
 * overrides: Felder, die der Benutzer im Formular gesetzt hat (haben Vorrang)
 */
function parseListingText(rawText, overrides = {}) {
  const text = String(rawText || '');
  const url = overrides.url || findUrl(text);
  const title = overrides.title || findTitle(text);
  const fullText = `${title}\n${text}`;

  const ez = findFirstRegistration(text);
  const power = findPower(text);
  const variant = overrides.variant || catalog.detectVariant(fullText);
  const year = toInt(overrides.year) || ez.year;
  const powerHp = toInt(overrides.powerHp) || power.hp;
  const genInfo = overrides.generation
    ? { generation: overrides.generation, certain: true, reason: 'manuell gesetzt' }
    : catalog.detectGeneration({ variant, year, powerHp, text: fullText });
  const accident = findAccident(text);
  const zip = findZip(text);
  const features = FEATURE_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
  const riskHints = RISK_WORDS.filter(r => r.re.test(text)).map(r => ({ label: r.label, level: r.level }));

  const listing = {
    title: title || null,
    url: url || null,
    platform: overrides.platform || detectPlatform(url),
    externalId: overrides.externalId || extractExternalId(url),
    isBmw4: catalog.isBmw4Series(fullText) || !!overrides.variant,
    variant: variant || null,
    generation: genInfo.generation,
    generationCertain: genInfo.certain,
    generationReason: genInfo.reason,
    body: overrides.body || catalog.detectBody(fullText),
    price: toInt(overrides.price) || findPrice(text),
    mileage: overrides.mileage !== undefined && overrides.mileage !== '' && overrides.mileage !== null ? toInt(overrides.mileage) : findMileage(text),
    year: year || null,
    month: toInt(overrides.month) || ez.month || null,
    powerHp: powerHp || null,
    powerKw: toInt(overrides.powerKw) || power.kw || (powerHp ? Math.round(powerHp / 1.35962) : null),
    fuel: overrides.fuel || findFuel(text) || catalog.fuelForVariant(variant),
    transmission: overrides.transmission || findTransmission(text),
    xDrive: /xdrive/i.test(fullText) || variant === 'M440i' || variant === 'M440d' ? true : (/\bsdrive\b/i.test(fullText) ? false : null),
    mSport: /m[\s-]?sport(?:paket)?\b|m[\s-]paket/i.test(text) ? true : null,
    owners: overrides.owners !== undefined && overrides.owners !== '' && overrides.owners !== null ? toInt(overrides.owners) : findOwners(text),
    accidentFree: overrides.accidentFree !== undefined && overrides.accidentFree !== null && overrides.accidentFree !== '' ? overrides.accidentFree === true || overrides.accidentFree === 'true' : accident.accidentFree,
    accidentNote: accident.note,
    serviceHistory: /scheckheft|lückenlos(e)? (wartung|historie)|bmw service historie|servicenachweis/i.test(text) ? true : null,
    sellerType: overrides.sellerType || findSellerType(text),
    zip: overrides.zip || zip.zip,
    city: overrides.city || zip.city,
    features,
    riskHints,
    description: text.slice(0, 4000)
  };

  // Plausibilität
  const now = CURRENT_YEAR();
  if (listing.year && (listing.year < 2013 || listing.year > now + 1)) listing.year = null;
  if (listing.mileage !== null && listing.mileage > 600000) listing.mileage = null;
  if (listing.powerHp && (listing.powerHp < 100 || listing.powerHp > 700)) { listing.powerHp = null; listing.powerKw = null; }
  if (listing.engineCode === undefined) listing.engineCode = listing.generation ? catalog.engineCodeFor(listing.generation, listing.variant, listing.year) : null;

  return listing;
}

/**
 * Trennt eingefügten Text in mehrere Inserate.
 * Trenner: eine Zeile mit --- oder === (mind. 3 Zeichen).
 */
function splitListings(text) {
  return String(text || '')
    .split(/^\s*(?:-{3,}|={3,})\s*$/m)
    .map(s => s.trim())
    .filter(s => s.length > 10);
}

// ---------- CSV ----------

const CSV_HEADERS = {
  title: ['titel', 'title', 'name', 'bezeichnung'],
  price: ['preis', 'price', 'kaufpreis', 'angebotspreis'],
  mileage: ['km', 'kilometer', 'kilometerstand', 'laufleistung', 'mileage'],
  firstRegistration: ['ez', 'erstzulassung', 'first_registration', 'firstregistration'],
  year: ['baujahr', 'jahr', 'year'],
  powerHp: ['ps', 'leistung', 'hp', 'leistung_ps'],
  variant: ['variante', 'variant', 'modell', 'model', 'motor'],
  body: ['karosserie', 'body', 'aufbau'],
  fuel: ['kraftstoff', 'fuel'],
  transmission: ['getriebe', 'transmission'],
  owners: ['vorbesitzer', 'halter', 'owners'],
  accidentFree: ['unfallfrei', 'accident_free'],
  sellerType: ['verkaeufer', 'verkäufer', 'anbieter', 'seller'],
  zip: ['plz', 'zip', 'postleitzahl'],
  city: ['ort', 'stadt', 'city'],
  url: ['url', 'link', 'inserat'],
  description: ['beschreibung', 'description', 'text']
};

function parseCsvLine(line, sep) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
    } else if (c === sep && !q) {
      out.push(cur); cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function parseCsv(csvText) {
  const lines = String(csvText || '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const sep = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
  const header = parseCsvLine(lines[0], sep).map(h => h.toLowerCase());
  const map = {};
  header.forEach((h, idx) => {
    for (const [field, names] of Object.entries(CSV_HEADERS)) {
      if (names.includes(h)) map[idx] = field;
    }
  });
  return lines.slice(1).map(line => {
    const cells = parseCsvLine(line, sep);
    const row = {};
    cells.forEach((c, idx) => { if (map[idx] && c !== '') row[map[idx]] = c; });
    // Als Text zusammensetzen, damit derselbe Parser greift; CSV-Werte haben Vorrang
    const ez = row.firstRegistration ? String(row.firstRegistration).match(/(\d{1,2})\s*[\/.\-]\s*(\d{4})/) : null;
    const overrides = {
      title: row.title,
      price: row.price,
      mileage: row.mileage,
      year: ez ? ez[2] : (row.year || (row.firstRegistration && String(row.firstRegistration).match(/\d{4}/) ? String(row.firstRegistration).match(/\d{4}/)[0] : undefined)),
      month: ez ? ez[1] : undefined,
      powerHp: row.powerHp,
      variant: row.variant ? catalog.detectVariant(row.variant) || undefined : undefined,
      body: row.body ? catalog.detectBody(row.body) || undefined : undefined,
      fuel: row.fuel,
      transmission: row.transmission,
      owners: row.owners,
      accidentFree: row.accidentFree !== undefined ? /^(ja|yes|true|1|x)$/i.test(row.accidentFree) : undefined,
      sellerType: row.sellerType ? (/priv/i.test(row.sellerType) ? 'privat' : 'haendler') : undefined,
      zip: row.zip,
      city: row.city,
      url: row.url
    };
    Object.keys(overrides).forEach(k => overrides[k] === undefined && delete overrides[k]);
    const text = [row.title, row.variant, row.body, row.description].filter(Boolean).join('\n');
    return { text: text || line, overrides };
  });
}

module.exports = {
  parseListingText,
  splitListings,
  parseCsv,
  normalizeUrl,
  extractExternalId,
  detectPlatform,
  _internals: { findPrice, findMileage, findFirstRegistration, findPower, findOwners, findAccident, findZip }
};
