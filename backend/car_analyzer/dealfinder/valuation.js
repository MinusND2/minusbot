/**
 * Marktwert-Schätzung aus Vergleichsfahrzeugen
 * ---------------------------------------------
 * So funktioniert es (vereinfacht):
 *  1. Suche alle erfassten Inserate derselben Generation + Variante (z. B. F3x 420d),
 *     Baujahr ±2 Jahre. Gibt es zu wenige, wird auf ähnliche Leistung erweitert.
 *  2. Jedes Vergleichsauto wird auf "unser" Auto umgerechnet:
 *     mehr km -> billiger, älter -> billiger. Die Raten dafür lernt das System
 *     aus den erfassten Daten selbst (ab 10 Vergleichsautos), sonst Standardwerte.
 *  3. Ausreißer (z. B. Unfallwagen zum halben Preis) werden entfernt.
 *  4. Der gewichtete Median = geschätzter Marktwert. Ähnlichere Autos zählen mehr.
 *
 * WICHTIG: Das sind ANGEBOTSPREISE, keine echten Verkaufspreise.
 * Ohne Vergleichsdaten gibt es bewusst KEINEN Marktwert.
 */

const DEFAULT_AGE_RATE = Math.log(1 - 0.085);  // ≈ -8,5 % pro Jahr
const DEFAULT_KM_RATE = Math.log(1 - 0.02);    // ≈ -2 % pro 10.000 km
const MIN_COMPS_FOR_LEARNING = 10;

function ageYears(l, now = new Date()) {
  if (!l.year) return null;
  const month = l.month || 6;
  return Math.max(0, (now.getFullYear() - l.year) + (now.getMonth() + 1 - month) / 12);
}

function daysSince(iso, now = new Date()) {
  if (!iso) return null;
  return Math.max(0, (now - new Date(iso)) / 86400000);
}

function isDamaged(l) {
  return l.accidentFree === false || (l.riskHints || []).some(h => h.level === 'hoch');
}

function weightedQuantile(items, q) {
  // items: [{ value, weight }]
  const sorted = [...items].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, i) => s + i.weight, 0);
  if (!total) return null;
  let acc = 0;
  for (const it of sorted) {
    acc += it.weight;
    if (acc >= q * total) return it.value;
  }
  return sorted[sorted.length - 1].value;
}

function quantile(values, q) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return null;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function bodyFactor(a, b) {
  if (!a || !b) return 0.8;
  if (a === b) return 1;
  if (a === 'Cabrio' || b === 'Cabrio') return 0.55;
  return 0.85; // Coupé <-> Gran Coupé liegen preislich nah
}

/**
 * Gleiches Auto doppelt (andere Plattform / anderer Händler)?
 */
function duplicateScore(a, b) {
  if (a.id === b.id) return 0;
  if (a.variant !== b.variant || a.generation !== b.generation) return 0;
  if (a.year && b.year && a.year !== b.year) return 0;
  if (a.mileage === null || b.mileage === null || a.mileage === undefined || b.mileage === undefined) return 0;
  const dkm = Math.abs(a.mileage - b.mileage);
  if (dkm > 1500) return 0;
  const dp = a.price && b.price ? Math.abs(a.price - b.price) / Math.max(a.price, b.price) : 1;
  if (dp > 0.15) return 0;
  let s = 0.4;
  if (dkm <= 200) s += 0.25; else if (dkm <= 700) s += 0.1;
  if (a.month && b.month && a.month === b.month) s += 0.15;
  if (a.zip && b.zip) s += a.zip === b.zip ? 0.15 : -0.3;
  if (a.powerHp && b.powerHp && a.powerHp !== b.powerHp) s -= 0.3;
  if (a.body && b.body && a.body !== b.body) s -= 0.5;
  if (dp <= 0.03) s += 0.05;
  return Math.max(0, Math.min(1, s));
}

function findDuplicates(target, pool) {
  return pool
    .map(o => ({ o, s: duplicateScore(target, o) }))
    .filter(x => x.s >= 0.5)
    .sort((a, b) => b.s - a.s)
    .slice(0, 5)
    .map(x => ({
      id: x.o.id,
      title: x.o.title,
      platform: x.o.platform,
      price: x.o.price,
      mileage: x.o.mileage,
      url: x.o.url,
      certainty: x.s >= 0.8 ? 'wahrscheinlich' : 'möglich',
      score: Math.round(x.s * 100)
    }));
}

/**
 * Gewichtete lineare Regression ln(preis) = a + b*alter + c*(km/10000)
 */
function fitRates(points) {
  // points: [{ age, km10, lnp, w }]
  const n = points.length;
  if (n < MIN_COMPS_FOR_LEARNING) return null;
  const ages = points.map(p => p.age), kms = points.map(p => p.km10);
  const ageSpread = Math.max(...ages) - Math.min(...ages);
  const kmSpread = Math.max(...kms) - Math.min(...kms);
  if (ageSpread < 1.5 || kmSpread < 3) return null; // zu wenig Streuung zum Lernen

  // Normalgleichungen (3x3) lösen
  let S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], T = [0, 0, 0];
  for (const p of points) {
    const x = [1, p.age, p.km10];
    for (let i = 0; i < 3; i++) {
      T[i] += p.w * x[i] * p.lnp;
      for (let j = 0; j < 3; j++) S[i][j] += p.w * x[i] * x[j];
    }
  }
  const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(S);
  if (Math.abs(D) < 1e-9) return null;
  const solve = col => det(S.map((row, i) => row.map((v, j) => (j === col ? T[i] : v)))) / D;
  const b = solve(1), c = solve(2);
  if (!Number.isFinite(b) || !Number.isFinite(c)) return null;
  // Auf plausible Bereiche begrenzen (Schutz gegen schlechte Daten)
  return {
    ageRate: Math.min(Math.log(1 - 0.03), Math.max(Math.log(1 - 0.22), b)),
    kmRate: Math.min(Math.log(1 - 0.004), Math.max(Math.log(1 - 0.06), c))
  };
}

/**
 * Hauptfunktion
 * @param target  Inserat, das bewertet werden soll
 * @param pool    alle erfassten Inserate
 */
function estimateMarketValue(target, pool, now = new Date()) {
  const result = {
    status: 'nicht_bewertbar',
    basis: 'Angebotspreise erfasster Inserate (keine echten Verkaufspreise)',
    estimate: null, low: null, high: null,
    nCandidates: 0, nUsed: 0, outliersRemoved: 0,
    criteria: [], warnings: [],
    rates: null,
    medianDataAgeDays: null,
    confidence: 0, confidenceLabel: 'keine',
    deviationPct: null, discountEur: null,
    comps: [],
    duplicates: []
  };

  result.duplicates = findDuplicates(target, pool);

  if (!target.price) { result.warnings.push('Kein Preis im Inserat erkannt.'); return result; }
  if (!target.variant) { result.warnings.push('Variante (z. B. 420d) nicht erkannt – bitte korrigieren.'); return result; }
  if (!target.generation) { result.warnings.push('Generation nicht bestimmbar (Erstzulassung fehlt).'); return result; }

  const tAge = ageYears(target, now);
  const tKm = target.mileage;
  if (tAge === null) result.warnings.push('Erstzulassung unbekannt – Alter kann nicht verglichen werden.');
  if (tKm === null || tKm === undefined) result.warnings.push('Kilometerstand unbekannt – km können nicht verglichen werden.');
  if (!target.generationCertain) result.warnings.push(`Generation unsicher: ${target.generationReason || ''}`);

  const dupIds = new Set(result.duplicates.map(d => d.id));
  const targetDamaged = isDamaged(target);

  const base = pool.filter(o =>
    o.id !== target.id &&
    !dupIds.has(o.id) &&
    o.price && o.generation === target.generation &&
    (targetDamaged || !isDamaged(o))
  );

  // Stufe 1: gleiche Variante
  let tier = 1;
  let cands = base.filter(o => o.variant === target.variant && (!target.year || !o.year || Math.abs(o.year - target.year) <= 2));
  result.criteria = [
    `Generation: ${target.generation}`,
    `Variante: ${target.variant}`,
    target.year ? `Baujahr ${target.year} ±2` : 'Baujahr: unbekannt',
    targetDamaged ? 'inkl. Unfall-/Schadenfahrzeuge (weil dieses Auto auch einen Schaden hat)' : 'ohne Unfall-/Schadenfahrzeuge'
  ];
  // Stufe 2: erweitern auf ähnliche Leistung & gleichen Kraftstoff
  if (cands.length < 5 && target.powerHp) {
    const wider = base.filter(o => o.fuel === target.fuel && o.powerHp && Math.abs(o.powerHp - target.powerHp) / target.powerHp <= 0.2 && (!target.year || !o.year || Math.abs(o.year - target.year) <= 3));
    if (wider.length > cands.length) {
      tier = 2;
      cands = wider;
      result.criteria[1] = `Ähnliche Leistung (${Math.round(target.powerHp * 0.8)}–${Math.round(target.powerHp * 1.2)} PS, ${target.fuel || '?'}) – zu wenige ${target.variant}`;
      result.criteria[2] = target.year ? `Baujahr ${target.year} ±3` : 'Baujahr: unbekannt';
    }
  }

  // Dubletten innerhalb der Vergleichsautos nur einmal zählen
  const seen = new Set();
  cands = cands.filter(o => {
    const key = `${o.variant}|${o.year}|${o.mileage !== null && o.mileage !== undefined ? Math.round(o.mileage / 1000) : '?'}|${o.zip || '?'}|${o.powerHp || '?'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  result.nCandidates = cands.length;
  if (!cands.length) {
    result.status = 'zu_wenig_daten';
    result.warnings.push(`Noch keine vergleichbaren ${target.variant} (${target.generation}) erfasst. Füge mehr Inserate hinzu – dann entsteht ein Marktwert.`);
    return result;
  }

  // Gewichte
  const pts = cands.map(o => {
    const oAge = ageYears(o, now);
    let w = 1;
    if (tAge !== null && oAge !== null) w *= Math.exp(-0.5 * Math.abs(tAge - oAge));
    if (tKm !== null && tKm !== undefined && o.mileage !== null && o.mileage !== undefined) w *= Math.exp(-Math.abs(tKm - o.mileage) / 60000);
    w *= bodyFactor(target.body, o.body);
    if (o.variant !== target.variant) w *= 0.6;
    if (target.xDrive !== null && o.xDrive !== null && target.xDrive !== undefined && o.xDrive !== undefined && target.xDrive !== o.xDrive) w *= 0.85;
    if (target.mSport === true && o.mSport !== true) w *= 0.9;
    if (target.sellerType && o.sellerType && target.sellerType !== o.sellerType) w *= 0.85;
    const d = daysSince(o.lastSeenAt || o.firstSeenAt, now);
    if (d !== null) w *= Math.exp(-d / 120); // ältere Beobachtungen zählen weniger
    return { o, age: oAge, w: Math.max(w, 1e-4) };
  });

  // Raten lernen
  const learnPts = pts.filter(p => p.age !== null && p.o.mileage !== null && p.o.mileage !== undefined)
    .map(p => ({ age: p.age, km10: p.o.mileage / 10000, lnp: Math.log(p.o.price), w: p.w }));
  const learned = fitRates(learnPts);
  const ageRate = learned ? learned.ageRate : DEFAULT_AGE_RATE;
  const kmRate = learned ? learned.kmRate : DEFAULT_KM_RATE;
  result.rates = {
    agePctPerYear: Math.round((1 - Math.exp(ageRate)) * 1000) / 10,
    kmPctPer10k: Math.round((1 - Math.exp(kmRate)) * 1000) / 10,
    source: learned ? `aus ${learnPts.length} erfassten Inseraten gelernt` : 'Standardwerte (zu wenige Daten zum Lernen)'
  };

  // Auf Zielauto umrechnen
  let adj = pts.map(p => {
    let factor = 0;
    if (tAge !== null && p.age !== null) factor += ageRate * (tAge - p.age);
    if (tKm !== null && tKm !== undefined && p.o.mileage !== null && p.o.mileage !== undefined) factor += kmRate * (tKm - p.o.mileage) / 10000;
    // Umrechnung begrenzen: Auto, das man um mehr als ±40 % "umbiegen" muss, ist kein guter Vergleich
    factor = Math.max(Math.log(0.6), Math.min(Math.log(1.4), factor));
    return { ...p, adjusted: p.o.price * Math.exp(factor) };
  });

  // Ausreißer entfernen (IQR-Regel)
  if (adj.length >= 5) {
    const vals = adj.map(a => a.adjusted);
    const q1 = quantile(vals, 0.25), q3 = quantile(vals, 0.75), iqr = q3 - q1;
    const lo = q1 - 1.5 * iqr, hi = q3 + 1.5 * iqr;
    const kept = adj.filter(a => a.adjusted >= lo && a.adjusted <= hi);
    result.outliersRemoved = adj.length - kept.length;
    adj = kept;
  }

  const items = adj.map(a => ({ value: a.adjusted, weight: a.w }));
  const est = weightedQuantile(items, 0.5);
  let low, high;
  if (adj.length >= 3) {
    low = weightedQuantile(items, 0.25);
    high = weightedQuantile(items, 0.75);
  } else {
    low = est * 0.9; high = est * 1.1; // bei 1–2 Vergleichsautos breite Spanne
  }
  const round100 = v => Math.round(v / 100) * 100;
  result.estimate = round100(est);
  result.low = round100(Math.min(low, est));
  result.high = round100(Math.max(high, est));
  result.nUsed = adj.length;
  result.status = 'ok';

  // Datenalter
  const ages = adj.map(a => daysSince(a.o.lastSeenAt || a.o.firstSeenAt, now)).filter(v => v !== null);
  result.medianDataAgeDays = ages.length ? Math.round(quantile(ages, 0.5)) : null;

  // Konfidenz
  const sw = adj.reduce((s, a) => s + a.w, 0), sw2 = adj.reduce((s, a) => s + a.w * a.w, 0);
  const nEff = sw2 ? (sw * sw) / sw2 : 0;
  let conf = 90 * (1 - Math.exp(-nEff / 6));
  const relSpread = est ? (result.high - result.low) / est : 1;
  if (relSpread > 0.12) conf -= Math.min(25, (relSpread - 0.12) * 120);
  if (tier === 2) conf -= 10;
  if (tAge === null) conf -= 20;
  if (tKm === null || tKm === undefined) conf -= 15;
  if (!target.generationCertain) conf -= 10;
  if (result.medianDataAgeDays !== null && result.medianDataAgeDays > 60) conf -= 10;
  if (adj.length < 3) conf = Math.min(conf, 30);
  conf = Math.max(5, Math.min(95, Math.round(conf)));
  result.confidence = conf;
  result.confidenceLabel = conf >= 65 ? 'hoch' : conf >= 40 ? 'mittel' : 'niedrig';
  result.effectiveComps = Math.round(nEff * 10) / 10;

  result.discountEur = result.estimate - target.price;               // positiv = günstiger als Markt
  result.deviationPct = Math.round(((target.price - est) / est) * 1000) / 10; // negativ = günstiger

  result.comps = adj
    .sort((a, b) => b.w - a.w)
    .slice(0, 20)
    .map(a => ({
      id: a.o.id,
      title: a.o.title,
      variant: a.o.variant,
      body: a.o.body,
      year: a.o.year,
      mileage: a.o.mileage,
      price: a.o.price,
      adjustedPrice: round100(a.adjusted),
      weightPct: Math.round((a.w / sw) * 1000) / 10,
      platform: a.o.platform,
      url: a.o.url
    }));

  return result;
}

module.exports = { estimateMarketValue, duplicateScore, ageYears, _internals: { fitRates, weightedQuantile } };
