/**
 * Berechnet den Risiko-Score (0-100, je niedriger desto besser) und erzeugt sachliche Warnhinweise
 */
function evaluateRisk(vehicle, marketData, reliabilityData) {
  const { vehicle_data, engine_data, price_data } = vehicle;
  const warnings = [];
  const riskFactors = [];
  let riskScore = 15; // Basis-Risiko für jeden Gebrauchtwagenkauf

  const mileage = vehicle_data.mileage || 60000;
  const ageYears = vehicle_data.ageYears || 4;
  const annualKmActual = mileage / Math.max(0.5, ageYears);

  // 1. Verdächtig niedriger Preis
  if (marketData.priceDeviationPercent < -22) {
    riskScore += 24;
    const warn = '⚠️ Angebotspreis liegt über 20 % unter dem geschätzten Marktwert. Prüfe das Fahrzeug vor Ort zwingend auf verdeckte Mängel, Vorschäden oder unvollständige Historie.';
    warnings.push(warn);
    riskFactors.push({ factor: 'Auffällig niedriger Marktpreis', points: 24, note: warn });
  } else if (marketData.priceDeviationPercent < -14) {
    riskScore += 8;
    riskFactors.push({ factor: 'Deutlicher Preisabschlag zum Markt', points: 8, note: 'Gutes Schnäppchenpotenzial, jedoch Zustand genau verifizieren.' });
  }

  // 2. Ungewöhnliche Laufleistung zum Alter
  if (ageYears >= 5 && annualKmActual < 5000) {
    riskScore += 14;
    const warn = '⚠️ Sehr geringe Jahreslaufleistung (< 5.000 km/Jahr). Verdacht auf extremen Kurzstreckenbetrieb oder Tachomanipulation nicht auszuschließen.';
    warnings.push(warn);
    riskFactors.push({ factor: 'Atypisch niedrige Laufleistung', points: 14, note: warn });
  } else if (annualKmActual > 35000) {
    riskScore += 16;
    const warn = '⚠️ Sehr hohe Jahresfahrleistung (> 35.000 km/Jahr). Verschleiß an Langstreckenbauteilen (DPF, Fahrwerk, Steinschläge) beachten.';
    warnings.push(warn);
    riskFactors.push({ factor: 'Überdurchschnittliche Langstreckenbelastung', points: 16, note: warn });
  }

  // 3. Absolute Laufleistung
  if (mileage > 180000) {
    riskScore += 20;
    const warn = '⚠️ Hohe Gesamtlaufleistung (> 180.000 km). Zeitnaher Tausch von Verschleißteilen (Turbolader, Partikelfilter, Fahrwerkslager) statistisch wahrscheinlich.';
    warnings.push(warn);
    riskFactors.push({ factor: 'Hohe Laufleistung', points: 20, note: warn });
  } else if (mileage > 120000) {
    riskScore += 10;
    riskFactors.push({ factor: 'Fortgeschrittene Laufleistung (> 120.000 km)', points: 10, note: 'Größere Wartungsintervalle prüfen.' });
  }

  // 4. Bekannte Motoren- / Getriebeschwachstellen
  if (reliabilityData.score < 70) {
    riskScore += 22;
    const warn = `⚠️ Modell/Motor weist unterdurchschnittliche statistische Zuverlässigkeit auf (${reliabilityData.score}/100). Bekannte Schwachstellen beachten.`;
    warnings.push(warn);
    riskFactors.push({ factor: 'Bekannte Motorschwachstelle', points: 22, note: warn });
  } else if (reliabilityData.knownIssues && reliabilityData.knownIssues.length > 0) {
    for (const issue of reliabilityData.knownIssues) {
      if (issue.toLowerCase().includes('steuerkette') || issue.toLowerCase().includes('ölverbrauch') || issue.toLowerCase().includes('kolben')) {
        riskScore += 15;
        const warn = `⚠️ Technische Schwachstelle: ${issue}.`;
        warnings.push(warn);
        riskFactors.push({ factor: 'Kritische Bauteil-Schwachstelle', points: 15, note: warn });
        break;
      }
    }
  }

  // 5. Fehlendes Scheckheft / Wartungshistorie
  if (!vehicle_data.serviceHistoryComplete) {
    riskScore += 18;
    const warn = '⚠️ Kein Nachweis über lückenloses Scheckheft bzw. Wartungshistorie vorhanden. Wartungsstau oder überzogene Intervalle möglich.';
    warnings.push(warn);
    riskFactors.push({ factor: 'Fehlendes lückenloses Scheckheft', points: 18, note: warn });
  }

  // 6. Importfahrzeug / Re-Import
  if (vehicle_data.isImport) {
    riskScore += 16;
    const warn = '⚠️ Importfahrzeug bzw. Re-Import. Bei US-Modellen Carfax-Bericht (Totalschaden/Salvage) anfordern; Ausstattung kann von DE-Serienstand abweichen.';
    warnings.push(warn);
    riskFactors.push({ factor: 'Importfahrzeug', points: 16, note: warn });
  }

  // 7. Unfallschaden / Vorschaden
  if (vehicle_data.accidentDamaged) {
    riskScore += 28;
    const warn = '⚠️ Fahrzeug als beschädigt oder reparierter Unfallschaden ausgewiesen. Fachgerechte Reparaturrechnungen und Vermessungsprotokoll prüfen.';
    warnings.push(warn);
    riskFactors.push({ factor: 'Vorschaden / Unfallschaden', points: 28, note: warn });
  }

  // 8. Viele Vorbesitzer
  if (vehicle_data.previousOwners >= 3 && ageYears <= 6) {
    riskScore += 12;
    const warn = `⚠️ Bereits ${vehicle_data.previousOwners} Vorbesitzer bei einem Fahrzeugalter von nur ${Math.round(ageYears)} Jahren.`;
    warnings.push(warn);
    riskFactors.push({ factor: 'Häufiger Besitzerwechsel', points: 12, note: warn });
  }

  // Begrenzen auf 0 - 100
  riskScore = Math.max(5, Math.min(95, riskScore));

  let riskLevel = 'niedrig';
  if (riskScore >= 60) riskLevel = 'hoch';
  else if (riskScore >= 35) riskLevel = 'mittel';

  return {
    score: riskScore,
    level: riskLevel,
    warnings,
    riskFactors
  };
}

module.exports = {
  evaluateRisk
};
