/**
 * Deal-Score (0–100) und Risiko-Bewertung
 * ----------------------------------------
 * Zwei getrennte Zahlen:
 *   - Deal-Score: Wie attraktiv ist das Angebot (Preis vs. Markt, Datenlage)?
 *   - Risiko:     Wie wahrscheinlich steckt ein Haken dahinter?
 * Ein sehr billiges Auto mit hohem Risiko wird NIE als Top-Deal angezeigt.
 *
 * Fehlende Angaben zählen nie positiv.
 */
const { ageYears } = require('./valuation');
let reliabilityDb = { engines: {} };
try { reliabilityDb = require('../database/reliabilityDatabase.json'); } catch (_) {}

// Bekannte Schwachstellen von Motoren, die (noch) nicht in reliabilityDatabase.json stehen
const EXTRA_ENGINE_NOTES = {
  BMW_N47: { level: 'mittel', text: 'N47-Diesel: Steuerkette (hinten am Motor) längt sich – Nachweis über Kettenwechsel oder Geräuschprüfung verlangen.' },
  BMW_N55: { level: 'niedrig', text: 'N55: Ölverlust Ölfiltergehäuse/Ventildeckel und Wasserpumpe (elektrisch) prüfen.' },
  BMW_S55: { level: 'niedrig', text: 'M4 S55: Kurbelwellenrad-Thema bekannt; Historie (Tuning, Rennstrecke) genau prüfen.' },
  BMW_N57: { level: 'niedrig', text: 'N57-Diesel: AGR/Drallklappen und DPF-Historie prüfen.' }
};

const POINTS = { hoch: 35, mittel: 15, niedrig: 5, info: 0 };

function evaluateRisk(l, valuation, now = new Date()) {
  const flags = [];
  const add = (level, text) => flags.push({ level, text });

  if (l.accidentFree === false) add('hoch', `Unfall-/Vorschaden angegeben${l.accidentNote ? ` („${l.accidentNote}“)` : ''}`);
  else if (l.accidentFree === null || l.accidentFree === undefined) add('niedrig', 'Unfallfreiheit nicht angegeben');

  for (const h of l.riskHints || []) add(h.level, h.text || h.label);

  if (valuation && valuation.status === 'ok' && valuation.deviationPct !== null) {
    const disc = -valuation.deviationPct;
    if (disc > 35) add('hoch', `Preis ${Math.round(disc)} % unter Marktwert – Lockangebot, Betrug oder versteckter Schaden möglich`);
    else if (disc > 25) add('mittel', `Preis ${Math.round(disc)} % unter Marktwert – ungewöhnlich günstig, genau prüfen`);
  }

  const age = ageYears(l, now);
  if (age !== null && age >= 1 && l.mileage !== null && l.mileage !== undefined) {
    const perYear = l.mileage / age;
    if (perYear > 35000) add('mittel', `Sehr hohe Laufleistung (~${Math.round(perYear / 1000)}.000 km/Jahr)`);
    if (age > 3 && perYear < 3000) add('niedrig', `Auffällig wenig km (~${Math.round(perYear)} km/Jahr) – Nachweise prüfen`);
  }

  if (l.owners >= 4) add('mittel', `${l.owners} Vorbesitzer`);
  else if (l.owners === 3) add('niedrig', '3 Vorbesitzer');

  if (l.serviceHistory !== true) add('niedrig', 'Scheckheft/Servicenachweise nicht erwähnt');

  if (l.engineCode) {
    const rel = reliabilityDb.engines && reliabilityDb.engines[l.engineCode];
    if (rel && rel.reliabilityScore < 70) add('mittel', `${rel.name}: ${(rel.knownIssues || [])[0] || 'bekannte Schwachstellen'}`);
    else if (EXTRA_ENGINE_NOTES[l.engineCode]) add(EXTRA_ENGINE_NOTES[l.engineCode].level, EXTRA_ENGINE_NOTES[l.engineCode].text);
  } else if ((l.variant === '420d' || l.variant === '418d') && l.year === 2015) {
    add('niedrig', 'Baujahr 2015: N47 (Steuerkettenthema) oder schon B47 – Motorcode prüfen');
  } else if ((l.variant === '420i') && l.year === 2016) {
    add('niedrig', 'Baujahr 2016: N20 (Steuerkettenthema) oder schon B48 – Motorcode prüfen');
  }

  if (l.sellerType === 'privat') add('info', 'Privatverkauf: keine Gewährleistung, dafür oft verhandelbar');

  const score = Math.min(100, flags.reduce((s, f) => s + POINTS[f.level], 0));
  const level = score >= 50 || flags.some(f => f.level === 'hoch') ? 'hoch' : score >= 25 ? 'mittel' : 'niedrig';
  return { score, level, flags };
}

function dataQuality(l) {
  const checks = [
    ['Preis', !!l.price],
    ['Kilometerstand', l.mileage !== null && l.mileage !== undefined],
    ['Erstzulassung', !!l.year],
    ['Monat EZ', !!l.month],
    ['Leistung', !!l.powerHp],
    ['Variante', !!l.variant],
    ['Karosserie', !!l.body],
    ['Unfallangabe', l.accidentFree !== null && l.accidentFree !== undefined],
    ['Vorbesitzer', l.owners !== null && l.owners !== undefined],
    ['Servicenachweis', l.serviceHistory === true],
    ['Verkäuferart', !!l.sellerType],
    ['Standort', !!l.zip],
    ['Link zum Inserat', !!l.url]
  ];
  const known = checks.filter(c => c[1]).length;
  return {
    score: Math.round((known / checks.length) * 100),
    missing: checks.filter(c => !c[1]).map(c => c[0])
  };
}

function clamp(v, lo = 0, hi = 100) { return Math.max(lo, Math.min(hi, v)); }

const WEIGHTS = { price: 50, comps: 20, data: 15, freshness: 10, trend: 5, profile: 0 };

function computeDealScore(l, valuation, risk, now = new Date()) {
  const dq = dataQuality(l);
  const parts = {};

  if (!valuation || valuation.status !== 'ok') {
    return {
      dealScore: null,
      label: valuation && valuation.status === 'zu_wenig_daten' ? 'Zu wenig Vergleichsdaten' : 'Nicht bewertbar',
      recommendation: 'Noch kein Urteil möglich',
      parts: {},
      dataQuality: dq,
      weights: WEIGHTS
    };
  }

  const disc = -valuation.deviationPct; // + = günstiger als Markt
  parts.price = { score: Math.round(clamp(20 + disc * 5)), label: 'Preis vs. Marktwert', detail: `${disc >= 0 ? disc.toFixed(1) + ' % unter' : (-disc).toFixed(1) + ' % über'} Marktwert` };
  parts.comps = { score: valuation.confidence, label: 'Vergleichsqualität', detail: `${valuation.nUsed} Vergleichsautos, Konfidenz ${valuation.confidenceLabel}` };
  parts.data = { score: dq.score, label: 'Datenqualität', detail: dq.missing.length ? `fehlt: ${dq.missing.slice(0, 4).join(', ')}${dq.missing.length > 4 ? ' …' : ''}` : 'vollständig' };

  const d = l.firstSeenAt ? (now - new Date(l.firstSeenAt)) / 86400000 : null;
  const fresh = d === null ? 15 : d <= 2 ? 100 : d <= 7 ? 80 : d <= 14 ? 60 : d <= 30 ? 35 : 15;
  parts.freshness = { score: fresh, label: 'Aktualität', detail: d === null ? 'unbekannt' : `seit ${Math.floor(d)} Tagen erfasst` };

  const hist = l.priceHistory || [];
  let trend = 30, trendDetail = 'keine Preisänderung beobachtet';
  if (hist.length >= 2) {
    const first = hist[0].price, last = hist[hist.length - 1].price;
    if (last < first) { trend = 100; trendDetail = `Preis um ${(first - last).toLocaleString('de-DE')} € gesenkt`; }
    else if (last > first) { trend = 0; trendDetail = `Preis um ${(last - first).toLocaleString('de-DE')} € erhöht`; }
  }
  parts.trend = { score: trend, label: 'Preisentwicklung', detail: trendDetail };
  parts.profile = { score: null, label: 'Suchprofil-Passung', detail: 'noch nicht implementiert (Phase 2)' };

  let total = 0, wsum = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) {
    if (!w || parts[k].score === null) continue;
    total += parts[k].score * w; wsum += w;
  }
  let score = Math.round(total / wsum);
  const caps = [];
  if (valuation.confidenceLabel === 'niedrig') { score = Math.min(score, 70); caps.push('max. 70 wegen niedriger Konfidenz'); }
  if (risk.score >= 70) { score = Math.min(score, 35); caps.push('max. 35 wegen sehr hohem Risiko'); }
  else if (risk.level === 'hoch') { score = Math.min(score, 55); caps.push('max. 55 wegen hohem Risiko'); }

  const fraud = risk.flags.some(f => /Betrug/.test(f.text));
  let recommendation;
  if (fraud) recommendation = 'Vorsicht – Betrugsmerkmale';
  else if (disc >= 8 && risk.level === 'hoch') recommendation = 'Günstig, aber riskant – nur mit Prüfung';
  else if (score >= 75 && disc >= 8) recommendation = 'Top-Deal – sofort prüfen';
  else if (score >= 60 && disc >= 4) recommendation = 'Interessant';
  else if (disc >= -4) recommendation = 'Marktgerecht';
  else recommendation = 'Über Marktwert';

  const label = score >= 80 ? 'Hervorragend' : score >= 65 ? 'Gut' : score >= 45 ? 'Mittel' : 'Schwach';
  return { dealScore: score, label, recommendation, parts, caps, dataQuality: dq, weights: WEIGHTS };
}

module.exports = { evaluateRisk, computeDealScore, dataQuality, WEIGHTS };
