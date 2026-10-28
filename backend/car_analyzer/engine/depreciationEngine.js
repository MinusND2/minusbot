const marketCoefficients = require('../database/marketCoefficients.json');

/**
 * Berechnet den erwarteten Wertverlust für die kommenden 3 Jahre
 */
function calculateDepreciation(vehicle, marketPriceData, annualKm = 15000) {
  const { vehicle_data, price_data } = vehicle;
  const currentPrice = price_data.askingPrice || marketPriceData.estimatedMarketPrice || 20000;
  const ageYears = vehicle_data.ageYears || 4;
  const segment = vehicle_data.segment || 'mittelklasse';
  const segmentConfig = marketCoefficients.depreciationRates.segments[segment] || marketCoefficients.depreciationRates.segments['mittelklasse'];

  // Ältere Fahrzeuge verlieren prozentual weniger an Wert als junge Gebrauchte
  let annualDepreciationPercent = 0.10; // Basis 10% / Jahr
  if (ageYears < 2) {
    annualDepreciationPercent = 0.14;
  } else if (ageYears < 4) {
    annualDepreciationPercent = 0.11;
  } else if (ageYears < 7) {
    annualDepreciationPercent = 0.085;
  } else if (ageYears < 10) {
    annualDepreciationPercent = 0.065;
  } else {
    annualDepreciationPercent = 0.045; // Bodenbildung bei soliden Fahrzeugen
  }

  // Kilometer-Korrektur: Wer mehr als 15.000 km/Jahr fährt, verliert mehr
  const kmAdjustment = ((annualKm - 15000) / 10000) * 0.015;
  annualDepreciationPercent = Math.max(0.035, Math.min(0.20, annualDepreciationPercent + kmAdjustment));

  // Wert nach 3 Jahren (Zinseszins-Formel)
  const remainingValueFactor3Years = Math.pow(1 - annualDepreciationPercent, 3);
  let estimatedValue3Years = Math.round((currentPrice * remainingValueFactor3Years) / 100) * 100;
  // Mindest-Restwert
  estimatedValue3Years = Math.max(1200, estimatedValue3Years);

  const projectedLoss3YearsEur = Math.max(0, currentPrice - estimatedValue3Years);
  const projectedLossPerYearEur = Math.round(projectedLoss3YearsEur / 3);

  return {
    annualDepreciationPercent: Math.round(annualDepreciationPercent * 1000) / 10,
    estimatedValue3Years,
    projectedLoss3YearsEur,
    projectedLossPerYearEur,
    residualPercentage3Years: Math.round(remainingValueFactor3Years * 1000) / 10
  };
}

module.exports = {
  calculateDepreciation
};
