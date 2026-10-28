const assert = require('assert');
const { standardizeVehicle } = require('./extractor/standardizer');
const { parseRawAdText } = require('./extractor/mobileDeExtractor');
const { calculateGermanKfzSteuer, calculateRunningCosts } = require('./engine/runningCostsEngine');
const { calculateMarketPrice } = require('./engine/marketPriceEngine');
const { calculateDepreciation } = require('./engine/depreciationEngine');
const { evaluateReliability } = require('./engine/reliabilityEngine');
const { evaluateRisk } = require('./engine/riskEngine');
const { analyzeSingleVehicle, rankVehicles } = require('./engine/scoringEngine');

console.log('==============================================');
console.log('🧪 STARTE CAR ANALYZER UNIT TESTS');
console.log('==============================================\n');

// TEST 1: KraftStG Kfz-Steuer Test
console.log('Test 1: Deutsche Kfz-Steuer Berechnung...');
const taxBenzin = calculateGermanKfzSteuer({ fuelType: 'Benzin', displacement: 1998, co2: 135 });
console.log(`- Benzin 1.998 cm³, 135g CO2: ${taxBenzin} € (Erwartet: 124 €)`);
assert.strictEqual(taxBenzin, 124, 'Benzin Kfz-Steuer stimmt nicht exakt mit KraftStG überein');

const taxElektro = calculateGermanKfzSteuer({ fuelType: 'Elektro', displacement: 0, co2: 0 });
console.log(`- Elektro: ${taxElektro} € (Erwartet: 0 €)`);
assert.strictEqual(taxElektro, 0, 'Elektroauto muss nach KraftStG 0 € Steuer betragen');

const taxDiesel = calculateGermanKfzSteuer({ fuelType: 'Diesel', displacement: 1968, co2: 125 });
console.log(`- Diesel 1.968 cm³, 125g CO2: ${taxDiesel} € (Erwartet: 252 €)`);
assert.strictEqual(taxDiesel, 252, 'Diesel Kfz-Steuer stimmt nicht exakt mit KraftStG überein');
console.log('✅ Test 1 bestanden!\n');

// TEST 2: Text-Parser & Standardizer
console.log('Test 2: Text-Extraktion & Standardisierung...');
const sampleAdText = `
BMW 320i M Sport Aut. Live Cockpit Matrix LED ACC Panorama
Preis: 22.490 €
Kilometerstand: 72.000 km
Erstzulassung: 06/2020
Leistung: 135 kW (184 PS)
Kraftstoff: Benzin
Getriebe: Automatik
Hubraum: 1.998 cm³
Scheckheftgepflegt bei BMW, unfallfrei, Nichtraucher.
Ausstattung: M-Sportpaket, Matrix LED Scheinwerfer, Panorama-Glasdach, Head-Up Display, Abstandsregeltempomat (ACC), Harman Kardon Soundsystem, Sitzheizung, Rückfahrkamera.
`;

const parsed = parseRawAdText(sampleAdText, 'https://suchen.mobile.de/auto-inserat/bmw-320i/12345.html');
const standardized = standardizeVehicle(parsed);

assert.strictEqual(standardized.vehicle_data.make, 'BMW');
assert.strictEqual(standardized.price_data.askingPrice, 22490);
assert.strictEqual(standardized.vehicle_data.mileage, 72000);
assert.strictEqual(standardized.vehicle_data.year, 2020);
assert.strictEqual(standardized.engine_data.powerHp, 184);
assert.strictEqual(standardized.engine_data.fuelType, 'Benzin');
assert.strictEqual(standardized.engine_data.detectedEngineCode, 'BMW_B48');
assert.strictEqual(standardized.vehicle_data.serviceHistoryComplete, true);
assert(standardized.equipment.scorePoints >= 50, 'Ausstattungspunkte sollten über 50 liegen');
console.log(`- Erkanntes Modell: ${standardized.title}`);
console.log(`- Erkannter Motor: ${standardized.engine_data.detectedEngineCode}`);
console.log(`- Ausstattungs-Scorepunkte: ${standardized.equipment.scorePoints} Pkt`);
console.log(`- Ausstattungs-Marktbonus: ${standardized.equipment.marketBonusEur} €`);
console.log('✅ Test 2 bestanden!\n');

// TEST 3: Zuverlässigkeits-Engine (B48 vs N20)
console.log('Test 3: Zuverlässigkeits-Engine (Standfest vs Schwachstelle)...');
const vehB48 = standardizeVehicle({ make: 'BMW', model: '320i', year: 2020, powerHp: 184, fuelType: 'Benzin' });
const vehN20 = standardizeVehicle({ make: 'BMW', model: '320i', year: 2013, powerHp: 184, fuelType: 'Benzin' });

const relB48 = evaluateReliability(vehB48);
const relN20 = evaluateReliability(vehN20);

console.log(`- BMW B48 (2020) Score: ${relB48.score}/100, Motor-Teilscore: ${relB48.subScores.motor}/100`);
console.log(`- BMW N20 (2013) Score: ${relN20.score}/100, Motor-Teilscore: ${relN20.subScores.motor}/100`);
assert(relB48.score > relN20.score, 'B48 Motor muss statistisch zuverlässiger sein als N20');
assert(relN20.knownIssues.some(i => i.includes('Steuerkette')), 'N20 muss Steuerketten-Warnung enthalten');
console.log('✅ Test 3 bestanden!\n');

// TEST 4: Risiko-Engine & Warnungen
console.log('Test 4: Risiko-Engine...');
const suspiciousVehicle = standardizeVehicle({
  make: 'BMW',
  model: '320i',
  year: 2020,
  mileage: 18000, // nur 18k km in 6 Jahren
  price: 13000,   // Viel zu billig (Markt ~ 23.000 €)
  isImport: true,
  serviceHistoryComplete: false
});
const marketSusp = calculateMarketPrice(suspiciousVehicle);
const relSusp = evaluateReliability(suspiciousVehicle);
const riskSusp = evaluateRisk(suspiciousVehicle, marketSusp, relSusp);

console.log(`- Risiko-Score: ${riskSusp.score}/100 (Level: ${riskSusp.level})`);
console.log(`- Generierte Warnungen (${riskSusp.warnings.length}):`);
riskSusp.warnings.forEach(w => console.log(`  ${w}`));
assert(riskSusp.score >= 50, 'Verdächtiges Fahrzeug muss hohen Risikoscore haben');
assert(riskSusp.warnings.length >= 3, 'Mindestens 3 Warnungen erwartet');
console.log('✅ Test 4 bestanden!\n');

// TEST 5: Ranking von 3 Testfahrzeugen
console.log('Test 5: Ranking von 3 Fahrzeugen...');
const cars = [
  standardizeVehicle({
    id: 'car_1',
    title: 'BMW 320i M Sport',
    make: 'BMW',
    model: '320i',
    year: 2020,
    mileage: 72000,
    powerHp: 184,
    fuelType: 'Benzin',
    price: 22490,
    rawText: 'M Sportpaket Matrix LED Panorama HUD ACC Harman Kardon Scheckheft'
  }),
  standardizeVehicle({
    id: 'car_2',
    title: 'BMW 318i Advantage',
    make: 'BMW',
    model: '318i',
    year: 2019,
    mileage: 95000,
    powerHp: 156,
    fuelType: 'Benzin',
    price: 21900,
    rawText: 'PDC Sitzheizung Klimaautomatik'
  }),
  standardizeVehicle({
    id: 'car_3',
    title: 'Audi A4 40 TFSI S line',
    make: 'Audi',
    model: 'A4',
    year: 2020,
    mileage: 80000,
    powerHp: 190,
    fuelType: 'Benzin',
    price: 24500,
    rawText: 'S line Matrix LED Virtual Cockpit ACC MMI Navigation'
  })
];

const ranked = rankVehicles(cars, { annualKm: 15000 });
console.log('--- ERGEBNIS-RANKING ---');
ranked.forEach(r => {
  console.log(`${r.ranking.medal} Platz ${r.ranking.rank}: ${r.title}`);
  console.log(`   Preis-Leistungs-Score: ${r.scores.overall}/100`);
  console.log(`   Deal Score: ${r.scores.dealScore}/100 | Risiko: ${r.scores.riskScore}/100 (${r.scores.riskLevel})`);
  console.log(`   Fair-Price Spanne: ${r.market_analysis.fairPriceMin.toLocaleString('de-DE')} € - ${r.market_analysis.fairPriceMax.toLocaleString('de-DE')} €`);
  console.log(`   Laufende Kosten: ${r.running_costs.totalAnnualCost.toLocaleString('de-DE')} €/Jahr`);
  console.log(`   Begründung: ${r.explanation.summary}\n`);
});

assert.strictEqual(ranked.length, 3);
assert.strictEqual(ranked[0].ranking.rank, 1);
assert(ranked[0].scores.overall >= ranked[1].scores.overall);
assert(ranked[1].scores.overall >= ranked[2].scores.overall);
console.log('✅ Test 5 bestanden!\n');

// TEST 6: Gleiches Modell Duell & Preis-Begründung (Car Comparison Engine)
console.log('Test 6: Gleiches Modell Duell & Warum ist eins teurer als das andere?...');
const { compareTwoVehicles, findSameModelPairs } = require('./engine/compareEngine');

const bmwExpensive = standardizeVehicle({
  title: 'BMW 320i M Sport (Teurer, Top-Ausstattung)',
  make: 'BMW',
  model: '320i',
  year: 2021,
  mileage: 60000,
  powerHp: 184,
  price: 25500,
  rawText: 'M Sportpaket Matrix LED Panorama HUD Harman Kardon ACC Rückfahrkamera Scheckheft'
});

const bmwCheaper = standardizeVehicle({
  title: 'BMW 320i Advantage (Günstiger, Basis)',
  make: 'BMW',
  model: '320i',
  year: 2019,
  mileage: 95000,
  powerHp: 184,
  price: 21900,
  rawText: 'PDC Sitzheizung Klimaautomatik'
});

const pairResult = compareTwoVehicles(bmwExpensive, bmwCheaper);
console.log(`- Preisdifferenz: ${pairResult.comparison.priceDelta} € (Teureres Auto: ${pairResult.comparison.moreExpensive})`);
console.log(`- Exklusive Ausstattung in Auto A: ${pairResult.comparison.equipment.onlyInA.length} Extras (Wert: +${pairResult.comparison.equipment.bonusOnlyInA} €)`);
console.log(`- Exklusive Ausstattung in Auto B: ${pairResult.comparison.equipment.onlyInB.length} Extras (Wert: +${pairResult.comparison.equipment.bonusOnlyInB} €)`);
console.log(`- Netto-Ausstattungsvorteil Auto A: +${pairResult.comparison.equipment.netEquipmentDeltaForA} €`);
console.log(`- Errechneter Gesamtwertvorteil Auto A: +${pairResult.comparison.totalJustifiedValueForA} €`);
console.log(`- Urteil / Verdict: "${pairResult.comparison.verdict.title}"`);
console.log(`- Empfehlung: "${pairResult.comparison.verdict.recommendation}"`);

assert.strictEqual(pairResult.comparison.moreExpensive, 'A');
assert.strictEqual(pairResult.comparison.priceDelta, 3600);
assert(pairResult.comparison.equipment.onlyInA.length >= 4, 'Auto A muss mindestens 4 exklusive Extras haben');
assert(pairResult.comparison.totalJustifiedValueForA > pairResult.comparison.priceDelta, 'Gesamter Mehrwert von A muss über dem Aufpreis liegen');
assert.strictEqual(pairResult.comparison.verdict.winner, 'A', 'Auto A muss trotz höherem Preis gewinnen, weil es mehr Mehrwert bietet');

// Test Same Model Pairs Erkennung
const pairs = findSameModelPairs([bmwExpensive, bmwCheaper, cars[2]]);
console.log(`- Gefundene Modell-Paare im Pool: ${pairs.length} (Modell: ${pairs[0]?.model})`);
assert.strictEqual(pairs.length, 1);
assert.strictEqual(pairs[0].model, '320i');
console.log('✅ Test 6 bestanden!\n');

console.log('==============================================');
console.log('🎉 ALLE UNIT TESTS ERFOLGREICH BESTANDEN!');
console.log('==============================================');
