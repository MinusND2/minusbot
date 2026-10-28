const marketCoefficients = require('../database/marketCoefficients.json');

/**
 * Berechnet die exakte deutsche Kfz-Steuer nach KraftStG
 */
function calculateGermanKfzSteuer(engineData) {
  const fuelType = engineData.fuelType || 'Benzin';
  const displacement = engineData.displacement || 1998;
  const co2 = engineData.co2 || 135;

  if (fuelType === 'Elektro') {
    return 0; // 10 Jahre steuerbefreit
  }

  // 1. Hubraum-Sockelbetrag (je angefangene 100 cm³)
  const started100Ccm = Math.ceil(displacement / 100);
  let baseRatePer100Ccm = marketCoefficients.kfzSteuer.ottoPer100ccm; // 2.00 €
  if (fuelType === 'Diesel') {
    baseRatePer100Ccm = marketCoefficients.kfzSteuer.dieselPer100ccm; // 9.50 €
  }
  const displacementTax = started100Ccm * baseRatePer100Ccm;

  // 2. CO2-Staffeltarif (ab 96 g/km)
  let co2Tax = 0;
  if (co2 > 95) {
    for (const bracket of marketCoefficients.kfzSteuer.co2TaxRates) {
      if (co2 >= bracket.from) {
        const taxableGramsInBracket = Math.min(co2, bracket.to) - bracket.from + 1;
        co2Tax += taxableGramsInBracket * bracket.ratePerGram;
      }
    }
  }

  return Math.round(displacementTax + co2Tax);
}

/**
 * Berechnet die gesamten jährlichen Betriebskosten und die 5-Jahres-TCO
 */
function calculateRunningCosts(vehicle, options = {}) {
  const annualKm = options.annualKm || marketCoefficients.annualKmBenchmark;
  const customFuelPrices = options.fuelPrices || {};
  const fuelPrices = { ...marketCoefficients.defaultFuelPrices, ...customFuelPrices };

  const { vehicle_data, engine_data, price_data } = vehicle;
  const fuelType = engine_data.fuelType || 'Benzin';
  const fuelPricePerUnit = fuelPrices[fuelType] || 1.75;
  const consumption = engine_data.consumptionCombined || 6.5;

  // 1. Jährliche Kraftstoff- / Stromkosten
  const annualFuelCost = Math.round((consumption / 100) * annualKm * fuelPricePerUnit);

  // 2. Jährliche Kfz-Steuer (nach KraftStG)
  const annualTax = calculateGermanKfzSteuer(engine_data);

  // 3. Versicherungsschätzung (Vollkasko + Haftpflicht, mittlere SF-Klasse)
  const segment = vehicle_data.segment || 'mittelklasse';
  const insuranceData = marketCoefficients.insuranceEstimates[segment] || marketCoefficients.insuranceEstimates['mittelklasse'];
  // Leistungsanpassung: Fahrzeuge mit mehr PS haben etwas höhere Typklassen
  const hpInsuranceFactor = Math.max(0.85, Math.min(1.4, 0.9 + (engine_data.powerHp - 150) * 0.002));
  const annualInsurance = Math.round((insuranceData.liabilityAnnual + insuranceData.comprehensiveAnnual) * hpInsuranceFactor);

  // 4. Wartung, Verschleiß & Inspektionen (Reifen, Bremsen, Öl, Verschleißteile)
  const baseMaintPer10k = marketCoefficients.maintenanceCostPer10000Km[segment] || 550;
  // Alters- und Kilometerzuschlag: Fahrzeuge über 100.000 km haben leicht höhere Wartungskosten
  const currentKm = vehicle_data.mileage || 60000;
  let kmWearFactor = 1.0;
  if (currentKm > 150000) kmWearFactor = 1.35;
  else if (currentKm > 100000) kmWearFactor = 1.20;
  else if (currentKm > 60000) kmWearFactor = 1.08;

  const annualMaintenance = Math.round((baseMaintPer10k * (annualKm / 10000)) * kmWearFactor);

  // 5. Gesamte jährliche laufende Kosten
  const totalAnnualCost = annualFuelCost + annualTax + annualInsurance + annualMaintenance;
  const monthlyCost = Math.round(totalAnnualCost / 12);

  // 6. 5-Jahres-Kosten
  const fiveYearRunningCosts = totalAnnualCost * 5;

  return {
    annualKm,
    annualFuelCost,
    annualTax,
    annualInsurance,
    annualMaintenance,
    totalAnnualCost,
    monthlyCost,
    fiveYearRunningCosts,
    fuelPriceUsed: fuelPricePerUnit,
    fuelTypeUsed: fuelType,
    consumptionUsed: consumption,
    breakdown: [
      { item: 'Kraftstoff / Energie', annualEur: annualFuelCost, note: `${consumption} ${fuelType === 'Elektro' ? 'kWh' : 'l'}/100km @ ${fuelPricePerUnit.toFixed(2)} €` },
      { item: 'Kfz-Steuer (KraftStG)', annualEur: annualTax, note: `${engine_data.displacement} cm³, ${engine_data.co2} g CO₂/km` },
      { item: 'Kfz-Versicherung (HP+VK)', annualEur: annualInsurance, note: `Schätzung für Segment ${segment}` },
      { item: 'Wartung, Reifen & Verschleiß', annualEur: annualMaintenance, note: `Inspektionen, Bremsen, Reifen auf ${annualKm.toLocaleString('de-DE')} km/Jahr` }
    ]
  };
}

module.exports = {
  calculateGermanKfzSteuer,
  calculateRunningCosts
};
