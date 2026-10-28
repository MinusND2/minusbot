/**
 * Tests für den BMW-4er-Deal-Finder.
 * Start:  node backend/car_analyzer/test_dealfinder.js
 * Die Beispiel-Inserate hier sind ERFUNDENE TESTDATEN und landen nicht in der echten Datenbank.
 */
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.CARDEAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dealfinder-test-'));

const catalog = require('./dealfinder/catalog');
const { parseListingText, splitListings, parseCsv, normalizeUrl } = require('./dealfinder/parseListing');
const store = require('./dealfinder/store');
const { estimateMarketValue, _internals } = require('./dealfinder/valuation');
const { evaluateRisk, computeDealScore } = require('./dealfinder/scoring');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

console.log('Katalog');
test('Varianten erkennen', () => {
  assert.strictEqual(catalog.detectVariant('BMW 420d Gran Coupé M Sport'), '420d');
  assert.strictEqual(catalog.detectVariant('BMW M440i xDrive Cabrio'), 'M440i');
  assert.strictEqual(catalog.detectVariant('BMW M4 Competition'), 'M4');
  assert.strictEqual(catalog.detectVariant('BMW 420 d Coupe'), '420d');
  assert.strictEqual(catalog.detectVariant('BMW 430i xDrive'), '430i');
  assert.strictEqual(catalog.detectVariant('BMW 320d mit M4-Paket'), null);
});
test('Generation erkennen', () => {
  assert.strictEqual(catalog.detectGeneration({ variant: '420d', year: 2018 }).generation, 'F3x');
  assert.strictEqual(catalog.detectGeneration({ variant: '420d', year: 2022 }).generation, 'G2x');
  assert.strictEqual(catalog.detectGeneration({ variant: 'M440i', year: null }).generation, 'G2x');
  assert.strictEqual(catalog.detectGeneration({ variant: '435d', year: null }).generation, 'F3x');
  assert.strictEqual(catalog.detectGeneration({ variant: '430i', year: 2020, powerHp: 252 }).generation, 'F3x');
  assert.strictEqual(catalog.detectGeneration({ variant: 'M4', year: 2022 }).generation, 'G8x');
  assert.strictEqual(catalog.detectGeneration({ variant: '420d', year: 2020 }).certain, false);
});
test('Motorcode nach Baujahr', () => {
  assert.strictEqual(catalog.engineCodeFor('F3x', '420d', 2014), 'BMW_N47');
  assert.strictEqual(catalog.engineCodeFor('F3x', '420d', 2017), 'BMW_B47');
  assert.strictEqual(catalog.engineCodeFor('F3x', '420d', 2015), null); // Übergangsjahr
});

console.log('Inserat lesen');
const SAMPLE = `BMW 420d Gran Coupé M Sport
32.990 €
ab 389 € /Monat
Erstzulassung 06/2019
Kilometerstand 72.500 km
Leistung 140 kW (190 PS)
Kraftstoffart Diesel
Getriebe Automatik
Anzahl der Fahrzeughalter 1
Fahrzeugzustand Unfallfrei, Scheckheftgepflegt
Ausstattung: Head-Up Display, Harman Kardon, Live Cockpit Professional
Händler
Autohaus Beispiel GmbH
80331 München
https://suchen.mobile.de/fahrzeuge/details.html?id=123456789&lang=de&ref=srp`;

test('Hauptfelder aus mobile.de-ähnlichem Text', () => {
  const l = parseListingText(SAMPLE);
  assert.strictEqual(l.price, 32990);
  assert.strictEqual(l.mileage, 72500);
  assert.strictEqual(l.year, 2019);
  assert.strictEqual(l.month, 6);
  assert.strictEqual(l.powerHp, 190);
  assert.strictEqual(l.variant, '420d');
  assert.strictEqual(l.generation, 'F3x');
  assert.strictEqual(l.body, 'Gran Coupé');
  assert.strictEqual(l.fuel, 'Diesel');
  assert.strictEqual(l.transmission, 'Automatik');
  assert.strictEqual(l.owners, 1);
  assert.strictEqual(l.accidentFree, true);
  assert.strictEqual(l.serviceHistory, true);
  assert.strictEqual(l.sellerType, 'haendler');
  assert.strictEqual(l.zip, '80331');
  assert.strictEqual(l.platform, 'mobile.de');
  assert.strictEqual(l.externalId, '123456789');
  assert.strictEqual(l.mSport, true);
  assert.strictEqual(l.engineCode, 'BMW_B47');
});
test('Monatsrate wird nicht als Preis genommen', () => {
  const l = parseListingText('BMW 430i Coupé\nab 459 € mtl.\nPreis: 41.500 €\nEZ 03/2021');
  assert.strictEqual(l.price, 41500);
  assert.strictEqual(l.generation, 'G2x');
});
test('"keine Vorschäden" ist kein Schaden', () => {
  assert.strictEqual(parseListingText('BMW 420i 25.000 € keine Vorschäden').accidentFree, null);
  assert.strictEqual(parseListingText('BMW 420i 25.000 € Unfallschaden hinten, repariert').accidentFree, false);
  assert.strictEqual(parseListingText('BMW 420i 25.000 € unbeschädigt, unfallfrei').accidentFree, true);
});
test('Risiko-Wörter', () => {
  const l = parseListingText('BMW 435i 15.000 € Motorschaden, für Bastler, nur Export');
  assert.ok(l.riskHints.some(h => h.level === 'hoch'));
});
test('Mehrere Inserate trennen', () => {
  assert.strictEqual(splitListings('BMW 420d 20.000 € xxx\n---\nBMW 430i 30.000 € yyy\n===\nBMW M4 50.000 € zzz').length, 3);
});
test('CSV-Import', () => {
  const rows = parseCsv('titel;preis;km;ez;ps;url\nBMW 420d Coupé;24990;88000;04/2018;190;https://example.com/a/1\nBMW 440i Cabrio;39900;45000;2019;326;');
  assert.strictEqual(rows.length, 2);
  const a = parseListingText(rows[0].text, rows[0].overrides);
  assert.strictEqual(a.price, 24990);
  assert.strictEqual(a.mileage, 88000);
  assert.strictEqual(a.year, 2018);
  assert.strictEqual(a.month, 4);
  assert.strictEqual(a.variant, '420d');
  const b = parseListingText(rows[1].text, rows[1].overrides);
  assert.strictEqual(b.variant, '440i');
  assert.strictEqual(b.body, 'Cabrio');
});
test('URL-Normalisierung', () => {
  assert.strictEqual(normalizeUrl('https://suchen.mobile.de/fahrzeuge/details.html?id=1&ref=x'), normalizeUrl('https://www.suchen.mobile.de/fahrzeuge/details.html?ref=y&id=1'));
});

console.log('Speicher');
test('Upsert + Preisverlauf', () => {
  store._resetForTests();
  const l = parseListingText(SAMPLE);
  assert.strictEqual(store.upsert(l).action, 'created');
  assert.strictEqual(store.upsert(parseListingText(SAMPLE)).action, 'unchanged');
  const cheaper = parseListingText(SAMPLE.replace('32.990 €', '30.990 €'));
  const r = store.upsert(cheaper);
  assert.strictEqual(r.action, 'updated');
  assert.strictEqual(r.listing.priceHistory.length, 2);
  assert.strictEqual(store.all().length, 1);
  store.save();
  assert.ok(fs.existsSync(store.DB_FILE));
});

console.log('Marktwert & Score');
// Testmarkt erzeugen: 420d F3x mit klarer Preislogik (Basis 34.000 € neu-ish, -8 %/Jahr, -2 %/10tkm)
function fakeListing(i, { year, km, price, ...extra }) {
  return { id: 'T' + i, variant: '420d', generation: 'F3x', generationCertain: true, fuel: 'Diesel', powerHp: 190, body: 'Coupé', year, month: 6, mileage: km, price, accidentFree: true, owners: 1, serviceHistory: true, sellerType: 'haendler', zip: String(10000 + i), url: 'https://example.com/' + i, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), priceHistory: [{ price }], ...extra };
}
const now = new Date();
const pool = [];
let i = 0;
for (const year of [2016, 2017, 2018, 2019, 2020]) {
  for (const km of [40000, 70000, 100000, 130000]) {
    const age = now.getFullYear() - year;
    const p = Math.round(42000 * Math.pow(0.92, age) * Math.pow(0.98, km / 10000) * (0.97 + ((i * 7) % 7) / 100));
    pool.push(fakeListing(i++, { year, km, price: p }));
  }
}
const fairPrice = Math.round(42000 * Math.pow(0.92, now.getFullYear() - 2018) * Math.pow(0.98, 8.5));
const bargain = fakeListing(999, { year: 2018, km: 85000, price: Math.round(fairPrice * 0.85) });
const scam = fakeListing(998, { year: 2018, km: 85000, price: Math.round(fairPrice * 0.55), zip: '99999', powerHp: 190, mileage: 86500 });
pool.push(bargain, scam);

test('Marktwert nahe am wahren Wert', () => {
  const v = estimateMarketValue(bargain, pool, now);
  assert.strictEqual(v.status, 'ok');
  const err = Math.abs(v.estimate - fairPrice) / fairPrice;
  assert.ok(err < 0.06, `Abweichung ${(err * 100).toFixed(1)} % (Schätzung ${v.estimate}, wahr ${fairPrice})`);
  assert.ok(v.deviationPct < -10, `deviation ${v.deviationPct}`);
  assert.ok(/gelernt/.test(v.rates.source));
  assert.ok(v.confidenceLabel !== 'niedrig');
});
test('Schnäppchen = Top-Deal', () => {
  const v = estimateMarketValue(bargain, pool, now);
  const r = evaluateRisk(bargain, v, now);
  const s = computeDealScore(bargain, v, r, now);
  assert.ok(s.dealScore >= 75, `score ${s.dealScore}`);
  assert.ok(/Top-Deal/.test(s.recommendation), s.recommendation);
});
test('Viel zu billig = hohes Risiko, kein Top-Deal', () => {
  const v = estimateMarketValue(scam, pool, now);
  const r = evaluateRisk(scam, v, now);
  const s = computeDealScore(scam, v, r, now);
  assert.strictEqual(r.level, 'hoch');
  assert.ok(s.dealScore <= 55);
  assert.ok(!/Top-Deal/.test(s.recommendation));
});
test('Ohne Vergleichsautos KEIN erfundener Marktwert', () => {
  const lonely = fakeListing(1000, { year: 2022, km: 20000, price: 50000, variant: 'M440d', generation: 'G2x', powerHp: 340 });
  const v = estimateMarketValue(lonely, pool, now);
  assert.strictEqual(v.status, 'zu_wenig_daten');
  assert.strictEqual(v.estimate, null);
  const s = computeDealScore(lonely, v, evaluateRisk(lonely, v, now), now);
  assert.strictEqual(s.dealScore, null);
});
test('Wenige Vergleichsautos = niedrige Konfidenz', () => {
  const few = pool.slice(0, 2).concat([bargain]);
  const v = estimateMarketValue(bargain, few, now);
  assert.strictEqual(v.confidenceLabel, 'niedrig');
});
test('Dublette wird erkannt und nicht als Vergleich gezählt', () => {
  const twin = { ...bargain, id: 'TWIN', platform: 'AutoScout24', price: bargain.price + 300, url: 'https://example.com/twin', zip: bargain.zip };
  const v = estimateMarketValue(bargain, pool.concat([twin]), now);
  assert.ok(v.duplicates.some(d => d.id === 'TWIN'));
  assert.ok(!v.comps.some(c => c.id === 'TWIN'));
});
test('Gewichteter Median', () => {
  assert.strictEqual(_internals.weightedQuantile([{ value: 1, weight: 1 }, { value: 2, weight: 1 }, { value: 100, weight: 0.1 }], 0.5), 2);
});

console.log(`\n${passed} Tests bestanden${process.exitCode ? ' – ES GAB FEHLER' : ''}.`);
