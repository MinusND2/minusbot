const reliabilityDatabase = require('../database/reliabilityDatabase.json');

/**
 * Ermittelt die statistische Zuverlässigkeitsbewertung für Motor, Getriebe und Plattform
 */
function evaluateReliability(vehicle) {
  const { vehicle_data, engine_data } = vehicle;
  const engineCode = engine_data.detectedEngineCode;
  const make = vehicle_data.make || '';
  const transmission = engine_data.transmission || 'Automatik';

  let reliabilityScore = 78;
  let subScores = { motor: 78, getriebe: 80, elektronik: 76, verschleiss: 78 };
  let knownIssues = [];
  let recommendation = '';
  let source = 'TÜV Report & ADAC Pannenstatistik';
  let sourceDate = '2025';
  let confidence = 'medium';
  let confidenceNote = '';

  // 1. Motor-Bewertung aus Wissensdatenbank
  if (engineCode && reliabilityDatabase.engines[engineCode]) {
    const engineEntry = reliabilityDatabase.engines[engineCode];
    reliabilityScore = engineEntry.reliabilityScore;
    subScores = { ...engineEntry.subScores };
    knownIssues = [...engineEntry.knownIssues];
    recommendation = engineEntry.recommendation;
    source = engineEntry.source;
    sourceDate = engineEntry.sourceDate;
    confidence = 'high';
  } else if (reliabilityDatabase.defaultsByMake[make]) {
    const makeEntry = reliabilityDatabase.defaultsByMake[make];
    reliabilityScore = makeEntry.reliabilityScore;
    subScores = {
      motor: reliabilityScore + 1,
      getriebe: reliabilityScore,
      elektronik: reliabilityScore - 3,
      verschleiss: reliabilityScore
    };
    source = makeEntry.source;
    confidence = makeEntry.confidence || 'medium';
    confidenceNote = `Allgemeiner Marken-Benchmark für ${make} (spezifischer Motorcode nicht eindeutig identifiziert).`;
  } else {
    reliabilityScore = reliabilityDatabase.benchmarkFallback.reliabilityScore;
    subScores = { motor: 75, getriebe: 75, elektronik: 72, verschleiss: 74 };
    source = 'Allgemeine Automobil-Benchmark-Daten';
    confidence = 'low';
    confidenceNote = reliabilityDatabase.benchmarkFallback.notes;
  }

  // 2. Getriebe-Einfluss
  if (transmission === 'Schaltgetriebe') {
    subScores.getriebe = Math.max(subScores.getriebe, 88);
  } else if (engine_data.gears === 8 && make === 'BMW') {
    // ZF 8HP Wandler
    subScores.getriebe = 93;
  } else if (transmission === 'Doppelkupplung' && engine_data.torque <= 250 && (make === 'Volkswagen' || make === 'Audi' || make === 'Seat' || make === 'Skoda')) {
    // Verdacht auf Trockenkupplung DQ200
    subScores.getriebe = Math.min(subScores.getriebe, 68);
    knownIssues.push('DSG 7-Gang (Trockenkupplung): Kupplungspaket und Mechatronik neigen bei Stop-and-Go zu früherem Verschleiß');
  }

  // 3. Alters- und Kilometer-Degression bei Zuverlässigkeit
  const mileage = vehicle_data.mileage || 60000;
  if (mileage > 160000) {
    subScores.verschleiss = Math.max(50, subScores.verschleiss - 12);
    knownIssues.push('Laufleistung > 160.000 km: Fahrwerksbuchsen, Stoßdämpfer und Nebenaggregate typischerweise revisionsbedürftig');
  } else if (mileage > 110000) {
    subScores.verschleiss = Math.max(58, subScores.verschleiss - 6);
  }

  // Gesamt-Zuverlässigkeitsscore neu mitteln
  const calculatedOverall = Math.round(
    subScores.motor * 0.40 +
    subScores.getriebe * 0.25 +
    subScores.elektronik * 0.15 +
    subScores.verschleiss * 0.20
  );

  return {
    score: calculatedOverall,
    subScores,
    knownIssues,
    recommendation,
    confidence,
    confidenceNote,
    source: `${source} (${sourceDate})`
  };
}

module.exports = {
  evaluateReliability
};
