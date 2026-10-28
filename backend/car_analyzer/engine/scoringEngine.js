const marketCoefficients = require('../database/marketCoefficients.json');
const { calculateMarketPrice } = require('./marketPriceEngine');
const { calculateRunningCosts } = require('./runningCostsEngine');
const { calculateDepreciation } = require('./depreciationEngine');
const { evaluateReliability } = require('./reliabilityEngine');
const { evaluateRisk } = require('./riskEngine');

/**
 * Berechnet alle 9 Subscores, den Gesamt-Score, Deal-Score, Risiko-Score und die Begründung
 */
function analyzeSingleVehicle(vehicle, userOptions = {}) {
  const annualKm = userOptions.annualKm || marketCoefficients.annualKmBenchmark;
  const weights = { ...marketCoefficients.defaultWeights, ...(userOptions.customWeights || {}) };

  // 1. Module berechnen
  const marketData = calculateMarketPrice(vehicle);
  const runningCostsData = calculateRunningCosts(vehicle, { annualKm, fuelPrices: userOptions.fuelPrices });
  const depreciationData = calculateDepreciation(vehicle, marketData, annualKm);
  const reliabilityData = evaluateReliability(vehicle);
  const riskData = evaluateRisk(vehicle, marketData, reliabilityData);

  const { vehicle_data, engine_data, equipment, price_data } = vehicle;
  const askingPrice = price_data.askingPrice || 20000;
  const mileage = vehicle_data.mileage || 60000;
  const ageYears = vehicle_data.ageYears || 4;

  // 2. Die 9 Sub-Scores (jeweils 0 bis 100) berechnen

  // Subscore 1: Preis / Marktwert (0-100)
  // -15% Abweichung = ~95 Pkt, 0% = 75 Pkt, +15% = 50 Pkt
  let priceScore = 75 - (marketData.priceDeviationPercent * 1.5);
  priceScore = Math.max(10, Math.min(99, Math.round(priceScore)));

  // Subscore 2: Zuverlässigkeit (0-100)
  const reliabilityScore = Math.max(10, Math.min(99, Math.round(reliabilityData.score)));

  // Subscore 3: Laufende Kosten (0-100)
  // Geringere Jahreskosten = höherer Score (Benchmark ~ 3.200 €/Jahr für Mittelklasse @ 15.000km)
  const costBenchmark = 3200 * (annualKm / 15000);
  let costScore = 80 - ((runningCostsData.totalAnnualCost - costBenchmark) / costBenchmark) * 45;
  costScore = Math.max(15, Math.min(98, Math.round(costScore)));

  // Subscore 4: Wertverlust / Werterhalt (0-100)
  // 3-Jahres-Restwertquote: z.B. 70% Restwert = 85 Pkt, 50% = 60 Pkt
  let depreciationScore = Math.round(depreciationData.residualPercentage3Years * 1.15);
  depreciationScore = Math.max(20, Math.min(98, depreciationScore));

  // Subscore 5: Ausstattungswert (0-100)
  // Max Punkte im System ca. 120, typisch gut ausgestattet ~ 60-80 Punkte
  let equipmentScore = Math.round((equipment.scorePoints / 85) * 100);
  equipmentScore = Math.max(20, Math.min(99, equipmentScore));

  // Subscore 6: Leistung (0-100)
  // PS pro 1.000 € Kaufpreis + absolute PS
  const hpPer1000Eur = Math.round((engine_data.powerHp / (askingPrice / 1000)) * 10) / 10;
  // z.B. 190 PS für 22.500 € = 8.4 PS/1.000 € (Sehr gut: >9, Gut: 7-9, Mäßig: <6)
  let performanceScore = Math.round(35 + hpPer1000Eur * 4.5 + Math.min(engine_data.powerHp, 350) * 0.08);
  performanceScore = Math.max(25, Math.min(99, performanceScore));

  // Subscore 7: Kilometerstand (0-100)
  // Berücksichtigt sowohl absolute km als auch Abweichung von der Jahresnorm
  const expectedKm = ageYears * annualKm;
  const kmRatio = mileage / Math.max(10000, expectedKm);
  let mileageScore = Math.round(85 - (kmRatio - 1.0) * 28 - (mileage / 200000) * 20);
  mileageScore = Math.max(15, Math.min(98, mileageScore));

  // Subscore 8: Baujahr / Alter (0-100)
  // Neuwagen / 1 Jahr = 98 Pkt, 5 Jahre = 75 Pkt, 10 Jahre = 45 Pkt
  let ageScore = Math.round(98 - ageYears * 5.2);
  ageScore = Math.max(15, Math.min(99, ageScore));

  // Subscore 9: Sicherheit & Assistenz (0-100)
  const safetyFeatures = equipment.recognized.filter(e => e.category === 'Sicherheit & Assistenz' || e.id.includes('led') || e.id.includes('camera'));
  let safetyScore = 55 + safetyFeatures.length * 8;
  safetyScore = Math.max(35, Math.min(98, safetyScore));

  const subScores = {
    price: priceScore,
    reliability: reliabilityScore,
    runningCosts: costScore,
    depreciation: depreciationScore,
    equipment: equipmentScore,
    performance: performanceScore,
    mileage: mileageScore,
    age: ageYearsScore = ageScore,
    safety: safetyScore
  };

  // 3. Gesamtscore berechnen (Gewichtetes arithmetisches Mittel)
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  let weightedSum = 0;
  for (const [key, weight] of Object.entries(weights)) {
    const scoreVal = subScores[key] || 70;
    weightedSum += scoreVal * weight;
  }
  const overallScore = Math.round((weightedSum / totalWeight) * 10) / 10;

  // 4. Positive und negative Faktoren transparent herausarbeiten
  const positiveFactors = [];
  const negativeFactors = [];

  // Preis
  if (marketData.priceDeviationPercent <= -4.0) {
    positiveFactors.push(`Günstiger Angebotspreis: ca. ${Math.abs(marketData.priceDeviationPercent)} % unter dem geschätzten Marktwert (Ersparnis ca. ${Math.abs(marketData.priceDifference).toLocaleString('de-DE')} €).`);
  } else if (marketData.priceDeviationPercent >= 5.0) {
    negativeFactors.push(`Angebotspreis liegt ca. ${marketData.priceDeviationPercent} % über dem Marktdurchschnitt vergleichbarer Fahrzeuge.`);
  }

  // Zuverlässigkeit
  if (reliabilityScore >= 85) {
    positiveFactors.push(`Hohe statistische Zuverlässigkeit (${reliabilityScore}/100) für Motor & Getriebestrang laut Prüforganisationen.`);
  } else if (reliabilityScore <= 68) {
    negativeFactors.push(`Unterdurchschnittliche Zuverlässigkeitsbewertung (${reliabilityScore}/100) mit bekannten Mängelschwerpunkten.`);
  }

  // Laufleistung
  if (mileageScore >= 86) {
    positiveFactors.push(`Geringe Gesamtlaufleistung (${mileage.toLocaleString('de-DE')} km) unterhalb des Klassendurchschnitts.`);
  } else if (mileage > 140000) {
    negativeFactors.push(`Hohe Gesamtlaufleistung (${mileage.toLocaleString('de-DE')} km) – erhöhtes Verschleiß- und Wartungsrisiko.`);
  }

  // Ausstattung
  const topEquipmentNames = equipment.recognized.slice(0, 3).map(e => e.name);
  if (equipmentScore >= 80) {
    positiveFactors.push(`Überdurchschnittliche Sonderausstattung (Highlights: ${topEquipmentNames.join(', ')}).`);
  } else if (equipmentScore <= 45) {
    negativeFactors.push('Eher zweckmäßige Basisausstattung; wichtige Komfort- oder Assistenzpakete fehlen.');
  }

  // Leistung / Effizienz
  if (hpPer1000Eur >= 8.5) {
    positiveFactors.push(`Hervorragendes Leistungs-Kaufpreis-Verhältnis (${hpPer1000Eur} PS pro 1.000 € Anschaffungskosten).`);
  }
  if (engine_data.consumptionCombined <= 5.2 && engine_data.fuelType !== 'Elektro') {
    positiveFactors.push(`Sehr verbrauchsgünstiger Antrieb (${engine_data.consumptionCombined} l/100km kombiniert).`);
  } else if (engine_data.consumptionCombined >= 8.8) {
    negativeFactors.push(`Erhöhter Kraftstoffverbrauch (${engine_data.consumptionCombined} l/100km) treibt die laufenden Betriebskosten nach oben.`);
  }

  // Historie
  if (vehicle_data.serviceHistoryComplete) {
    positiveFactors.push('Lückenlose Service- und Wartungshistorie nachweisbar.');
  }

  // 5. Verständliche Gesamterklärung formulieren ("Warum auf diesem Platz?")
  let summaryText = '';
  if (overallScore >= 85) {
    summaryText = `Hervorragendes Preis-Leistungs-Verhältnis. Das Fahrzeug überzeugt durch einen ${marketData.priceDeviationPercent < 0 ? 'attraktiven Preisvorteil gegenüber dem Markt' : 'fairen Einstiegspreis'} kombiniert mit ${reliabilityScore >= 80 ? 'hoher statistischer Standfestigkeit' : 'guter Substanz'} und starker Ausstattung.`;
  } else if (overallScore >= 75) {
    summaryText = `Solides und ausgewogenes Gesamtpaket mit marktgerechtem Preis. Punktabzüge entstehen punktuell bei ${negativeFactors.length > 0 ? negativeFactors[0].toLowerCase() : 'einzelnen laufenden Kostenfaktoren'}.`;
  } else {
    summaryText = `Unterdurchschnittliches Preis-Leistungs-Verhältnis. Das Fahrzeug ist entweder im Marktvergleich zu teuer eingepreist oder weist ungünstige Folgekosten/Risikofaktoren auf.`;
  }

  return {
    ...vehicle,
    scores: {
      overall: overallScore,
      dealScore: marketData.dealScore,
      riskScore: riskData.score,
      riskLevel: riskData.level,
      subScores,
      weightsUsed: weights
    },
    market_analysis: marketData,
    running_costs: runningCostsData,
    depreciation: depreciationData,
    reliability: reliabilityData,
    risk: riskData,
    explanation: {
      summary: summaryText,
      positiveFactors,
      negativeFactors,
      warnings: riskData.warnings
    },
    performance_metrics: {
      hpPer1000Eur,
      powerToWeightEstimate: Math.round((engine_data.powerHp / 1.55) * 10) / 10 // PS pro Tonne geschätzt
    }
  };
}

/**
 * Analysiert eine Liste von Fahrzeugen, sortiert sie und vergibt Ränge (1., 2., 3. ...)
 */
function rankVehicles(vehiclesList, userOptions = {}) {
  if (!vehiclesList || !Array.isArray(vehiclesList) || vehiclesList.length === 0) {
    return [];
  }

  // 1. Jedes Fahrzeug einzeln analysieren
  const analyzed = vehiclesList.map(v => analyzeSingleVehicle(v, userOptions));

  // 2. Sortieren nach Gesamt-Preis-Leistungs-Score absteigend (bei Gleichstand entscheidet der Deal-Score)
  analyzed.sort((a, b) => {
    if (b.scores.overall !== a.scores.overall) {
      return b.scores.overall - a.scores.overall;
    }
    return b.scores.dealScore - a.scores.dealScore;
  });

  // 3. Ränge und Medaillen zuweisen
  const medals = ['🥇', '🥈', '🥉'];
  return analyzed.map((item, index) => {
    const rank = index + 1;
    return {
      ...item,
      ranking: {
        rank,
        medal: medals[index] || `#${rank}`,
        isWinner: rank === 1,
        scoreLeadToNext: index < analyzed.length - 1 ? Math.round((item.scores.overall - analyzed[index + 1].scores.overall) * 10) / 10 : 0
      }
    };
  });
}

module.exports = {
  analyzeSingleVehicle,
  rankVehicles
};
