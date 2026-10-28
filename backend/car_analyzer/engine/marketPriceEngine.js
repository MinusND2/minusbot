const marketCoefficients = require('../database/marketCoefficients.json');

/**
 * Berechnet den geschätzten Marktwert, die Fair-Price-Spanne und den Deal-Score
 */
function calculateMarketPrice(vehicle) {
  const { vehicle_data, engine_data, equipment, price_data } = vehicle;
  const askingPrice = price_data.askingPrice || 20000;
  const ageYears = vehicle_data.ageYears || 4;
  const mileage = vehicle_data.mileage || 60000;
  const segmentKey = vehicle_data.segment || 'mittelklasse';
  const segmentConfig = marketCoefficients.depreciationRates.segments[segmentKey] || marketCoefficients.depreciationRates.segments['mittelklasse'];

  // 1. Geschätzter Neuwagen-Listenpreis (MSRP) inkl. Motor- und Ausstattungsaufschlag
  let baseMsrp = segmentConfig.initialMsrp;
  // Leistungszuschlag: über 150 PS steigt der Neuwagenpreis spürbar
  const hpBonus = Math.max(0, (engine_data.powerHp - 150) * 120);
  // Getriebezuschlag
  const transBonus = engine_data.transmission === 'Automatik' || engine_data.transmission === 'Doppelkupplung' ? 2200 : 0;
  // Allradzuschlag
  const driveBonus = engine_data.driveType === 'Allrad' ? 2600 : 0;
  // Ausstattungs-Listenpreis (ca. das 2-fache des Gebrauchtwagen-Bonus)
  const equipmentMsrp = (equipment.marketBonusEur || 0) * 2.2;

  const estimatedNewPrice = Math.round(baseMsrp + hpBonus + transBonus + driveBonus + equipmentMsrp);

  // 2. Marktwert-Degression nach Alter & Laufleistung (exponentielle Degression nach DAT/Schwacke)
  // Jahr 1: z.B. (1 - 0.24) = 0.76 des Neupreises; danach ca. 8-10% pro weiterem Jahr
  let remainingFactor = Math.pow(1 - segmentConfig.year1, Math.min(1.0, ageYears));
  if (ageYears > 1.0) {
    remainingFactor *= Math.pow(1 - segmentConfig.subsequentPerYear, ageYears - 1.0);
  }
  // Mindestrestwert-Boden (Fahrzeuge fallen selten unter 18% des Neupreises bei fahrbereitem Zustand)
  remainingFactor = Math.max(0.20, remainingFactor);

  // Laufleistungs-Korrektur: Standard ~15.000 km/Jahr
  const expectedKm = ageYears * marketCoefficients.annualKmBenchmark;
  const kmDifference = mileage - expectedKm;
  // Pro 10.000 km Mehr-/Minderleistung ca. 2.0% bis 2.5% Preisanpassung
  const kmAdjustmentFactor = 1.0 - (kmDifference / 10000) * 0.022;

  // Basis-Gebrauchtwagenwert berechnen
  let rawMarketPrice = estimatedNewPrice * remainingFactor * kmAdjustmentFactor;

  // Gebrauchtwagen-Bonus für gesuchte Sonderausstattung (M-Paket, Matrix, Pano etc.)
  const equipmentUsedBonus = equipment.marketBonusEur || 0;
  rawMarketPrice += equipmentUsedBonus * Math.max(0.3, remainingFactor);

  // Runden auf sinnvolle 100er Schritte
  const estimatedMarketPrice = Math.max(2500, Math.round(rawMarketPrice / 100) * 100);

  // 3. Fair-Price-Spanne (ca. +/- 3.5% bis 4.5% um den Marktwert)
  const spread = Math.round((estimatedMarketPrice * 0.04) / 100) * 100;
  const fairPriceMin = Math.max(2000, estimatedMarketPrice - spread);
  const fairPriceMax = estimatedMarketPrice + spread;

  // 4. Preisabweichung in %
  const priceDifference = askingPrice - estimatedMarketPrice;
  const priceDeviationPercent = Math.round(((askingPrice - estimatedMarketPrice) / estimatedMarketPrice) * 1000) / 10;

  // 5. Deal Score (0-100)
  // 0% Abweichung (exakt am Markt) = 75 Punkte
  // Günstiger als Markt (+ Punkte bis max 98 bei -18% bis -20%)
  // Extrem billig (>-30%) führt zu Vorsichtsabzug wegen Betrugs-/Schadensrisiko
  let dealScore = 75;
  if (priceDeviationPercent <= 0) {
    // Fahrzeug ist günstiger als Markt
    const discount = Math.abs(priceDeviationPercent);
    if (discount <= 22) {
      dealScore = Math.min(98, Math.round(75 + discount * 1.05));
    } else {
      // Zu billig? Leichter Abzug für Plausibilität
      dealScore = Math.max(70, Math.round(98 - (discount - 22) * 1.5));
    }
  } else {
    // Fahrzeug ist teurer als Markt
    const premium = priceDeviationPercent;
    dealScore = Math.max(15, Math.round(75 - premium * 1.4));
  }

  let dealRating = 'Fairer Preis';
  if (dealScore >= 90) dealRating = 'Hervorragender Deal';
  else if (dealScore >= 80) dealRating = 'Guter Deal';
  else if (dealScore >= 65) dealRating = 'Marktgerecht';
  else if (dealScore >= 50) dealRating = 'Leicht überteuert';
  else dealRating = 'Deutlich überteuert';

  return {
    estimatedMarketPrice,
    fairPriceMin,
    fairPriceMax,
    priceDeviationPercent,
    priceDifference,
    dealScore,
    dealRating,
    estimatedNewPrice
  };
}

module.exports = {
  calculateMarketPrice
};
