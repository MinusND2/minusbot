/**
 * Einfacher, dauerhafter Speicher für erfasste Inserate.
 * -----------------------------------------------------
 * Speichert alles in EINER JSON-Datei (data/dealfinder.json).
 * Vorteil: keine Datenbank-Installation auf dem Server nötig.
 * Reicht locker für einige tausend Inserate. Wenn es später deutlich mehr
 * werden, kann man diese Datei gegen SQLite/Postgres tauschen – die
 * restlichen Module sprechen nur über die Funktionen hier unten.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeUrl } = require('./parseListing');

const DATA_DIR = process.env.CARDEAL_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'dealfinder.json');
const MAX_LISTINGS = 20000;
const STATUSES = ['aktiv', 'beobachten', 'gekauft', 'weg', 'ignoriert'];

let db = null;
let version = 0; // steigt bei jeder Änderung (für Cache der Bewertungen)

function emptyDb() {
  return { schemaVersion: 1, listings: [], imports: [] };
}

function load() {
  if (db) return db;
  try {
    if (fs.existsSync(DB_FILE)) {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (!Array.isArray(db.listings)) db = emptyDb();
    } else {
      db = emptyDb();
    }
  } catch (e) {
    console.error('[DealFinder] Datenbank konnte nicht gelesen werden, starte leer:', e.message);
    // kaputte Datei sichern statt überschreiben
    try { fs.copyFileSync(DB_FILE, DB_FILE + '.defekt-' + Date.now()); } catch (_) {}
    db = emptyDb();
  }
  return db;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE); // atomar: nie halb geschriebene Datei
  version++;
}

function getVersion() { return version; }

function all() { return load().listings; }

function getById(id) { return load().listings.find(l => l.id === id) || null; }

function findExisting(listing) {
  const list = load().listings;
  const nUrl = normalizeUrl(listing.url);
  if (nUrl) {
    const hit = list.find(l => l.normalizedUrl === nUrl);
    if (hit) return hit;
  }
  if (listing.externalId && listing.platform && listing.platform !== 'manuell') {
    const hit = list.find(l => l.externalId === listing.externalId && l.platform === listing.platform);
    if (hit) return hit;
  }
  // Ohne URL: exakt gleicher Text = dasselbe Inserat
  if (!nUrl && listing.description) {
    const hash = textHash(listing.description);
    const hit = list.find(l => l.textHash === hash);
    if (hit) return hit;
  }
  return null;
}

function textHash(text) {
  return crypto.createHash('sha1').update(String(text).replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex');
}

/**
 * Fügt ein Inserat ein oder aktualisiert ein bestehendes (gleiche URL/ID).
 * Preisänderungen landen im Preisverlauf.
 * Gibt { action: 'created'|'updated'|'unchanged', listing } zurück.
 */
function upsert(listing, sourceLabel) {
  load();
  const now = new Date().toISOString();
  const existing = findExisting(listing);

  if (existing) {
    let changed = false;
    if (listing.price && listing.price !== existing.price) {
      existing.priceHistory = existing.priceHistory || [];
      existing.priceHistory.push({ at: now, price: listing.price });
      existing.price = listing.price;
      changed = true;
    }
    // Neue bekannte Werte übernehmen, unbekannte nicht überschreiben
    for (const [k, v] of Object.entries(listing)) {
      if (k === 'price' || v === null || v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      if (JSON.stringify(existing[k]) !== JSON.stringify(v)) { existing[k] = v; changed = true; }
    }
    existing.lastSeenAt = now;
    if (existing.status === 'weg') existing.status = 'aktiv';
    if (changed) existing.updatedAt = now;
    return { action: changed ? 'updated' : 'unchanged', listing: existing };
  }

  if (db.listings.length >= MAX_LISTINGS) {
    throw new Error(`Speicherlimit von ${MAX_LISTINGS} Inseraten erreicht. Bitte alte Inserate löschen.`);
  }

  const record = {
    id: crypto.randomUUID(),
    ...listing,
    normalizedUrl: normalizeUrl(listing.url),
    textHash: listing.description ? textHash(listing.description) : null,
    source: sourceLabel || 'manuell',
    status: 'aktiv',
    notes: '',
    firstSeenAt: now,
    lastSeenAt: now,
    updatedAt: now,
    priceHistory: [{ at: now, price: listing.price }]
  };
  db.listings.push(record);
  return { action: 'created', listing: record };
}

function logImport(entry) {
  load();
  db.imports.unshift({ at: new Date().toISOString(), ...entry });
  db.imports = db.imports.slice(0, 200);
}

function update(id, patch) {
  const l = getById(id);
  if (!l) return null;
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status)) throw new Error('Ungültiger Status');
    l.status = patch.status;
  }
  if (patch.notes !== undefined) l.notes = String(patch.notes).slice(0, 2000);
  // Korrekturen durch den Benutzer (z. B. falsch erkannte Variante)
  const editable = ['variant', 'generation', 'body', 'price', 'mileage', 'year', 'month', 'powerHp', 'owners', 'accidentFree', 'sellerType', 'zip', 'city', 'url', 'title', 'transmission', 'xDrive', 'mSport'];
  for (const k of editable) {
    if (patch[k] !== undefined) {
      if (k === 'price' && patch.price && patch.price !== l.price) {
        l.priceHistory = l.priceHistory || [];
        l.priceHistory.push({ at: new Date().toISOString(), price: Number(patch.price) });
      }
      l[k] = patch[k];
      if (k === 'generation') l.generationCertain = true;
      if (k === 'url') l.normalizedUrl = normalizeUrl(patch.url);
    }
  }
  l.updatedAt = new Date().toISOString();
  save();
  return l;
}

function remove(id) {
  load();
  const before = db.listings.length;
  db.listings = db.listings.filter(l => l.id !== id);
  if (db.listings.length !== before) { save(); return true; }
  return false;
}

function imports() { return load().imports; }

// Nur für Tests
function _resetForTests() { db = emptyDb(); version++; }

module.exports = { load, save, all, getById, upsert, update, remove, logImport, imports, getVersion, STATUSES, DB_FILE, _resetForTests };
