/**
 * API des BMW-4er-Deal-Finders
 * Eingehängt unter /api/car-analyzer/deals (siehe ../routes.js)
 *
 *  GET    /                Alle Inserate mit Marktwert, Deal-Score, Risiko
 *  GET    /stats           Zahlen für die Übersicht
 *  GET    /sources         Status der Datenquellen
 *  GET    /catalog         Generationen & Varianten (für Formulare)
 *  GET    /:id             Ein Inserat mit allen Details + Vergleichsautos
 *  POST   /import          Inserate importieren { text } | { csv } | { manual: {...} }
 *  PATCH  /:id             Status/Notiz/Korrektur ändern
 *  DELETE /:id             Inserat löschen
 *
 * Schreibzugriffe brauchen den Header  x-cardeal-key: <CARDEAL_KEY aus backend/.env>,
 * sobald CARDEAL_KEY gesetzt ist.
 */
const express = require('express');
const router = express.Router();
const store = require('./store');
const catalog = require('./catalog');
const { parseListingText, splitListings, parseCsv } = require('./parseListing');
const { estimateMarketValue } = require('./valuation');
const { evaluateRisk, computeDealScore } = require('./scoring');
const { sourceStatus } = require('./sources');

const MAX_PER_IMPORT = 200;

// ---------- Schutz für Schreibzugriffe ----------
function requireKey(req, res, next) {
  const key = process.env.CARDEAL_KEY;
  if (!key) return next(); // kein Schlüssel gesetzt -> offen (Seite zeigt Warnung)
  if (req.get('x-cardeal-key') === key) return next();
  return res.status(401).json({ success: false, error: 'Zugangsschlüssel fehlt oder ist falsch.' });
}

// ---------- Bewertung (mit Cache) ----------
let cache = { version: -1, day: null, results: null };

function evaluateAll() {
  const today = new Date().toISOString().slice(0, 10);
  if (cache.version === store.getVersion() && cache.day === today && cache.results) return cache.results;
  const pool = store.all();
  const now = new Date();
  const results = new Map();
  for (const l of pool) {
    const valuation = estimateMarketValue(l, pool, now);
    const risk = evaluateRisk(l, valuation, now);
    const score = computeDealScore(l, valuation, risk, now);
    results.set(l.id, { valuation, risk, score });
  }
  cache = { version: store.getVersion(), day: today, results };
  return results;
}

function publicListing(l, ev, full = false) {
  const { description, textHash, ...rest } = l;
  const out = {
    ...rest,
    market: {
      status: ev.valuation.status,
      estimate: ev.valuation.estimate,
      low: ev.valuation.low,
      high: ev.valuation.high,
      deviationPct: ev.valuation.deviationPct,
      discountEur: ev.valuation.discountEur,
      nUsed: ev.valuation.nUsed,
      confidence: ev.valuation.confidence,
      confidenceLabel: ev.valuation.confidenceLabel
    },
    dealScore: ev.score.dealScore,
    dealLabel: ev.score.label,
    recommendation: ev.score.recommendation,
    risk: { score: ev.risk.score, level: ev.risk.level, count: ev.risk.flags.filter(f => f.level !== 'info').length },
    duplicateCount: ev.valuation.duplicates.length
  };
  if (full) {
    out.description = description;
    out.valuation = ev.valuation;
    out.riskDetails = ev.risk;
    out.scoreDetails = ev.score;
  }
  return out;
}

// ---------- Routen ----------

router.get('/', (req, res) => {
  try {
    const ev = evaluateAll();
    const list = store.all().map(l => publicListing(l, ev.get(l.id)));
    res.json({ success: true, count: list.length, listings: list, protected: !!process.env.CARDEAL_KEY });
  } catch (e) {
    console.error('[DealFinder] GET /', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/stats', (req, res) => {
  const ev = evaluateAll();
  const all = store.all();
  const byVariant = {};
  for (const l of all) {
    const k = `${l.generation || '?'} ${l.variant || '?'}`;
    byVariant[k] = (byVariant[k] || 0) + 1;
  }
  const valued = all.filter(l => ev.get(l.id).valuation.status === 'ok');
  res.json({
    success: true,
    total: all.length,
    valued: valued.length,
    topDeals: all.filter(l => /Top-Deal/.test(ev.get(l.id).score.recommendation)).length,
    lastImport: store.imports()[0] || null,
    byVariant,
    protected: !!process.env.CARDEAL_KEY
  });
});

router.get('/sources', (req, res) => {
  res.json({ success: true, sources: sourceStatus(), imports: store.imports().slice(0, 20), protected: !!process.env.CARDEAL_KEY });
});

router.get('/catalog', (req, res) => {
  res.json({ success: true, generations: catalog.GENERATIONS, variants: catalog.VARIANTS, statuses: store.STATUSES });
});

router.post('/import', requireKey, (req, res) => {
  try {
    const { text, csv, manual } = req.body || {};
    let items = [];
    let sourceLabel = 'manuell';
    if (manual && typeof manual === 'object') {
      items = [{ text: [manual.title, manual.description].filter(Boolean).join('\n') || 'BMW 4er', overrides: manual }];
      sourceLabel = 'formular';
    } else if (csv && typeof csv === 'string') {
      items = parseCsv(csv);
      sourceLabel = 'csv';
    } else if (text && typeof text === 'string') {
      items = splitListings(text).map(t => ({ text: t, overrides: {} }));
      sourceLabel = 'text';
    } else {
      return res.status(400).json({ success: false, error: 'Bitte Text, CSV oder Formulardaten senden.' });
    }
    if (!items.length) return res.status(400).json({ success: false, error: 'Kein Inserat im Text gefunden.' });
    if (items.length > MAX_PER_IMPORT) return res.status(400).json({ success: false, error: `Maximal ${MAX_PER_IMPORT} Inserate pro Import.` });

    const results = [];
    for (const [idx, it] of items.entries()) {
      const parsed = parseListingText(it.text, it.overrides || {});
      const problems = [];
      if (!parsed.isBmw4 && !parsed.variant) problems.push('Kein BMW 4er / M4 erkannt');
      if (!parsed.price) problems.push('Kein Preis erkannt');
      if (problems.length) {
        results.push({ index: idx + 1, ok: false, title: parsed.title, problems });
        continue;
      }
      const { action, listing } = store.upsert(parsed, sourceLabel);
      const warnings = [];
      if (!parsed.variant) warnings.push('Variante nicht erkannt – bitte im Detail korrigieren');
      if (!parsed.year) warnings.push('Erstzulassung nicht erkannt');
      if (parsed.mileage === null) warnings.push('Kilometerstand nicht erkannt');
      results.push({ index: idx + 1, ok: true, action, id: listing.id, title: listing.title, variant: listing.variant, price: listing.price, warnings });
    }
    const created = results.filter(r => r.action === 'created').length;
    const updated = results.filter(r => r.action === 'updated').length;
    const rejected = results.filter(r => !r.ok).length;
    store.logImport({ source: sourceLabel, total: items.length, created, updated, rejected });
    store.save();
    res.json({ success: true, created, updated, rejected, results });
  } catch (e) {
    console.error('[DealFinder] POST /import', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/:id', (req, res) => {
  const l = store.getById(req.params.id);
  if (!l) return res.status(404).json({ success: false, error: 'Inserat nicht gefunden' });
  const ev = evaluateAll();
  res.json({ success: true, listing: publicListing(l, ev.get(l.id), true) });
});

router.patch('/:id', requireKey, (req, res) => {
  try {
    const patch = { ...(req.body || {}) };
    if (patch.variant !== undefined) patch.variant = catalog.detectVariant(String(patch.variant)) || null;
    for (const k of ['price', 'mileage', 'year', 'month', 'powerHp', 'owners']) {
      if (patch[k] !== undefined) patch[k] = patch[k] === '' || patch[k] === null ? null : parseInt(String(patch[k]).replace(/[^\d]/g, ''), 10) || null;
    }
    if (patch.generation !== undefined && patch.generation !== null && !catalog.GENERATIONS[patch.generation]) {
      return res.status(400).json({ success: false, error: 'Unbekannte Generation' });
    }
    const l = store.update(req.params.id, patch);
    if (!l) return res.status(404).json({ success: false, error: 'Inserat nicht gefunden' });
    // Motorcode neu bestimmen, falls Variante/Jahr korrigiert wurde
    if (patch.variant !== undefined || patch.year !== undefined || patch.generation !== undefined) {
      if (patch.generation === undefined) {
        const g = catalog.detectGeneration({ variant: l.variant, year: l.year, powerHp: l.powerHp, text: `${l.title || ''}\n${l.description || ''}` });
        l.generation = g.generation; l.generationCertain = g.certain; l.generationReason = g.reason;
      }
      if (patch.variant !== undefined && l.variant) l.fuel = catalog.fuelForVariant(l.variant);
      l.engineCode = l.generation ? catalog.engineCodeFor(l.generation, l.variant, l.year) : null;
      store.save();
    }
    const ev = evaluateAll();
    res.json({ success: true, listing: publicListing(l, ev.get(l.id), true) });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

router.delete('/:id', requireKey, (req, res) => {
  const ok = store.remove(req.params.id);
  res.status(ok ? 200 : 404).json({ success: ok });
});

module.exports = router;
