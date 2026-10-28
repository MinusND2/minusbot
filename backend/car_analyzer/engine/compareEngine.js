const { analyzeSingleVehicle } = require('./scoringEngine');
const marketCoefficients = require('../database/marketCoefficients.json');

/**
 * Vergleicht zwei Fahrzeuge präzise im Detail (besonders für gleiches Modell mit unterschiedlichen Preisen)
 * Analysiert:
 * - Welche Ausstattungen hat Auto A vs. Auto B?
 * - Was ist der rechnerische Wert der Ausstattungsdifferenz?
 * - Wie schlagen Laufleistung, Alter, Historie und TCO zu Buche?
 * - Warum ist das teurere Auto teurer, und ist dieser Aufpreis gerechtfertigt?
 */
function compareTwoVehicles(carA, carB, options = {}) {
  if (!carA || !carB) {
    throw new Error('Zwei Fahrzeuge für den Vergleich erforderlich.');
  }

  // 1. Beide Fahrzeuge vollständig analysieren
  const analyzedA = carA.scores && carA.market_analysis ? carA : analyzeSingleVehicle(carA, options);
  const analyzedB = carB.scores && carB.market_analysis ? carB : analyzeSingleVehicle(carB, options);

  const priceA = analyzedA.price_data?.askingPrice || 0;
  const priceB = analyzedB.price_data?.askingPrice || 0;
  const priceDelta = priceA - priceB;
  const priceDeltaAbs = Math.abs(priceDelta);

  // Wer ist das teurere Fahrzeug?
  const expensiveIsA = priceA >= priceB;
  const expensiveCar = expensiveIsA ? analyzedA : analyzedB;
  const cheaperCar = expensiveIsA ? analyzedB : analyzedA;

  // 2. Ausstattungsvergleich (Erkannte Features)
  const featuresA = analyzedA.equipment?.recognized || [];
  const featuresB = analyzedB.equipment?.recognized || [];

  const mapA = new Map(featuresA.map(f => [f.id, f]));
  const mapB = new Map(featuresB.map(f => [f.id, f]));

  const onlyInA = [];
  const onlyInB = [];
  const common = [];

  for (const [id, item] of mapA.entries()) {
    if (mapB.has(id)) {
      common.push(item);
    } else {
      onlyInA.push(item);
    }
  }

  for (const [id, item] of mapB.entries()) {
    if (!mapA.has(id)) {
      onlyInB.push(item);
    }
  }

  // Marktbonus der exklusiven Ausstattungen
  const bonusOnlyInA = onlyInA.reduce((sum, item) => sum + (item.marketBonusEur || 0), 0);
  const bonusOnlyInB = onlyInB.reduce((sum, item) => sum + (item.marketBonusEur || 0), 0);
  const netEquipmentDeltaForA = bonusOnlyInA - bonusOnlyInB; // Positiv = A hat wertvollere Mehrausstattung

  // 3. Laufleistungsvergleich
  const kmA = analyzedA.vehicle_data?.mileage || 0;
  const kmB = analyzedB.vehicle_data?.mileage || 0;
  const kmDiff = kmB - kmA; // Positiv = A hat WENIGER Kilometer (Vorteil A)
  // DAT/Schwacke Richtwert: ca. 45 € pro 1.000 km in der Mittelklasse
  const kmValueDeltaForA = Math.round((kmDiff / 1000) * 45);

  // 4. Alters- / Baujahrvergleich
  const ageA = analyzedA.vehicle_data?.ageYears || 1;
  const ageB = analyzedB.vehicle_data?.ageYears || 1;
  const ageDiffYears = Math.round((ageB - ageA) * 10) / 10; // Positiv = A ist JÜNGER
  // Wertverlust ~8% des Marktwerts pro Jahr
  const baseValue = ((analyzedA.market_analysis?.estimatedMarketPrice || 20000) + (analyzedB.market_analysis?.estimatedMarketPrice || 20000)) / 2;
  const ageValueDeltaForA = Math.round(ageDiffYears * (baseValue * 0.08));

  // 5. Leistung / PS
  const hpA = analyzedA.engine_data?.powerHp || 0;
  const hpB = analyzedB.engine_data?.powerHp || 0;
  const hpDiff = hpA - hpB; // Positiv = A hat mehr PS
  const hpValueDeltaForA = hpDiff !== 0 ? Math.round(hpDiff * 35) : 0;

  // 6. Wartungshistorie / Scheckheft
  const histA = Boolean(analyzedA.vehicle_data?.serviceHistoryComplete);
  const histB = Boolean(analyzedB.vehicle_data?.serviceHistoryComplete);
  let historyValueDeltaForA = 0;
  if (histA && !histB) historyValueDeltaForA = 750;
  else if (!histA && histB) historyValueDeltaForA = -750;

  // 7. Gesamt-Mehrwert für Fahrzeug A gegenüber Fahrzeug B
  const totalJustifiedValueForA = netEquipmentDeltaForA + kmValueDeltaForA + ageValueDeltaForA + hpValueDeltaForA + historyValueDeltaForA;

  // Aus Sicht des TEUREREN Fahrzeugs berechnen:
  const expensiveValueAdvantage = expensiveIsA ? totalJustifiedValueForA : -totalJustifiedValueForA;
  const netSurplusForExpensive = expensiveValueAdvantage - priceDeltaAbs;
  const coverageRatio = priceDeltaAbs > 0 ? (expensiveValueAdvantage / priceDeltaAbs) : 1;

  // 8. Urteil & Preis-Begründung ermitteln
  let verdictType = 'EQUAL';
  let verdictTitle = '';
  let verdictBadge = '';
  let verdictRecommendation = '';
  let winner = '';
  const summaryBulletPoints = [];

  if (priceDeltaAbs === 0) {
    if (totalJustifiedValueForA > 500) {
      verdictType = 'SAME_PRICE_A_BETTER';
      verdictTitle = `${analyzedA.title} bietet deutlich mehr Gegenwert zum selben Preis`;
      verdictBadge = '🏆 Fahrzeug A klar überlegen';
      verdictRecommendation = `Beide Fahrzeuge kosten genau ${priceA.toLocaleString('de-DE')} €. Allerdings bietet Fahrzeug A durch Mehrausstattung und Fahrzeugdaten einen rechnerischen Mehrwert von ca. ${Math.abs(totalJustifiedValueForA).toLocaleString('de-DE')} €. Fahrzeug A ist der eindeutige Sieger!`;
      winner = 'A';
    } else if (totalJustifiedValueForA < -500) {
      verdictType = 'SAME_PRICE_B_BETTER';
      verdictTitle = `${analyzedB.title} bietet deutlich mehr Gegenwert zum selben Preis`;
      verdictBadge = '🏆 Fahrzeug B klar überlegen';
      verdictRecommendation = `Beide Fahrzeuge kosten genau ${priceB.toLocaleString('de-DE')} €. Allerdings bietet Fahrzeug B durch Mehrausstattung und Fahrzeugdaten einen rechnerischen Mehrwert von ca. ${Math.abs(totalJustifiedValueForA).toLocaleString('de-DE')} €. Fahrzeug B ist der eindeutige Sieger!`;
      winner = 'B';
    } else {
      verdictType = 'BALANCED';
      verdictTitle = 'Beide Fahrzeuge sind nahezu gleichwertig aufgestellt';
      verdictBadge = '⚖️ Gleichwertiges Angebot';
      verdictRecommendation = `Beide Fahrzeuge liegen preislich und ausstattungstechnisch auf Augenhöhe. Wähle nach persönlichem Geschmack bezüglich Farbe, Standort oder Händlerauftritt.`;
      winner = 'TIE';
    }
  } else {
    // Es gibt eine Preisdifferenz
    const moreExpTitle = expensiveCar.title;
    const cheaperTitle = cheaperCar.title;
    const winnerIsExpensive = coverageRatio >= 1.0;

    if (coverageRatio >= 1.25) {
      verdictType = 'HIGHLY_JUSTIFIED';
      verdictTitle = `Aufpreis von ${priceDeltaAbs.toLocaleString('de-DE')} € ist VOLLKOMMEN GERECHTFERTIGT`;
      verdictBadge = '🔥 Exzellenter Mehrwert – Teureres Auto lohnt sich definitiv';
      verdictRecommendation = `${moreExpTitle} kostet zwar ${priceDeltaAbs.toLocaleString('de-DE')} € mehr als ${cheaperTitle}, liefert dafür aber einen objektiven Mehrwert von ca. ${Math.abs(expensiveValueAdvantage).toLocaleString('de-DE')} € (Mehrwert-Quote: ${Math.round(coverageRatio * 100)} %). Der Aufpreis zahlt sich durch ${onlyInA.length > 0 || onlyInB.length > 0 ? 'hochwertige Mehrausstattung' : ''} und bessere Fahrzeugdaten mehr als aus!`;
      winner = expensiveIsA ? 'A' : 'B';
    } else if (coverageRatio >= 0.85) {
      verdictType = 'FAIR_UPGRADE';
      verdictTitle = `Aufpreis von ${priceDeltaAbs.toLocaleString('de-DE')} € ist FAIR und MARKTGERECHT`;
      verdictBadge = '⚖️ Fairer Aufpreis – Beide Optionen vertretbar';
      verdictRecommendation = `Der Preisunterschied von ${priceDeltaAbs.toLocaleString('de-DE')} € entspricht ziemlich genau dem errechneten Mehrwert von ca. ${Math.abs(expensiveValueAdvantage).toLocaleString('de-DE')} € (Mehrwert-Quote: ${Math.round(coverageRatio * 100)} %). Wer das Extra an Komfort und Ausstattung wünscht, kann bedenkenlos zum teureren Modell greifen.`;
      winner = expensiveCar.scores?.overall >= cheaperCar.scores?.overall ? (expensiveIsA ? 'A' : 'B') : (expensiveIsA ? 'B' : 'A');
    } else if (coverageRatio >= 0.40) {
      verdictType = 'PARTIALLY_JUSTIFIED';
      verdictTitle = `Aufpreis von ${priceDeltaAbs.toLocaleString('de-DE')} € ist TEILWEISE ÜBERZOGEN`;
      verdictBadge = '🟡 Eher zum günstigeren Fahrzeug greifen';
      verdictRecommendation = `${moreExpTitle} verlangt einen Aufpreis von ${priceDeltaAbs.toLocaleString('de-DE')} €, bietet jedoch nur einen nachweisbaren Mehrwert von ca. ${Math.abs(expensiveValueAdvantage).toLocaleString('de-DE')} €. ${cheaperTitle} bietet das spürbar vernünftigere Preis-Leistungs-Verhältnis.`;
      winner = expensiveIsA ? 'B' : 'A';
    } else {
      verdictType = 'OVERPRICED';
      verdictTitle = `Aufpreis von ${priceDeltaAbs.toLocaleString('de-DE')} € ist NICHT GERECHTFERTIGT (Überteuert)`;
      verdictBadge = '⛔ Überteuert – Klares Votum für die günstigere Alternative';
      verdictRecommendation = `Der Aufpreis von ${priceDeltaAbs.toLocaleString('de-DE')} € für ${moreExpTitle} ist objektiv nicht zu rechtfertigen. Das teurere Auto bietet kaum nennenswerte Mehrausstattung oder hat sogar ungünstigere Eckdaten (KM/Alter). Greife klar zu ${cheaperTitle}!`;
      winner = expensiveIsA ? 'B' : 'A';
    }
  }

  // Zusammenfassende Stichpunkte generieren
  if (bonusOnlyInA > 0) {
    summaryBulletPoints.push(`${analyzedA.title} hat exklusive Ausstattung im Wert von ca. ${bonusOnlyInA.toLocaleString('de-DE')} € (${onlyInA.slice(0, 3).map(e => e.name).join(', ')}${onlyInA.length > 3 ? ' uvm.' : ''}).`);
  }
  if (bonusOnlyInB > 0) {
    summaryBulletPoints.push(`${analyzedB.title} hat exklusive Ausstattung im Wert von ca. ${bonusOnlyInB.toLocaleString('de-DE')} € (${onlyInB.slice(0, 3).map(e => e.name).join(', ')}${onlyInB.length > 3 ? ' uvm.' : ''}).`);
  }
  if (Math.abs(kmDiff) >= 10000) {
    const kmLeader = kmDiff > 0 ? analyzedA.title : analyzedB.title;
    summaryBulletPoints.push(`${kmLeader} hat ${Math.abs(kmDiff).toLocaleString('de-DE')} km weniger Laufleistung (geschätzter Wertvorteil: ca. ${Math.abs(kmValueDeltaForA).toLocaleString('de-DE')} €).`);
  }
  if (Math.abs(ageDiffYears) >= 0.8) {
    const ageLeader = ageDiffYears > 0 ? analyzedA.title : analyzedB.title;
    summaryBulletPoints.push(`${ageLeader} ist ca. ${Math.abs(ageDiffYears)} Jahr(e) jünger (geschätzter Wertvorteil: ca. ${Math.abs(ageValueDeltaForA).toLocaleString('de-DE')} €).`);
  }
  if (histA !== histB) {
    const histLeader = histA ? analyzedA.title : analyzedB.title;
    summaryBulletPoints.push(`${histLeader} verfügt über ein lückenlos nachweisbares Scheckheft (geringeres Pannenrisiko & besserer Werterhalt).`);
  }

  // 9. Detaillierte Tabellenzeilen für UI
  const breakdownRows = [
    {
      category: 'Kaufpreis',
      label: 'Angebotspreis',
      carAValue: `${priceA.toLocaleString('de-DE')} €`,
      carBValue: `${priceB.toLocaleString('de-DE')} €`,
      deltaText: priceDelta > 0 ? `+${priceDelta.toLocaleString('de-DE')} € teurer (A)` : (priceDelta < 0 ? `+${Math.abs(priceDelta).toLocaleString('de-DE')} € teurer (B)` : 'Gleicher Preis'),
      valueDeltaEur: -priceDelta,
      advantage: priceDelta < 0 ? 'A' : (priceDelta > 0 ? 'B' : 'EQUAL')
    },
    {
      category: 'Ausstattung',
      label: 'Sonderausstattung & Pakete',
      carAValue: `${featuresA.length} Extras (ca. ${analyzedA.equipment?.marketBonusEur?.toLocaleString('de-DE') || 0} € Wert)`,
      carBValue: `${featuresB.length} Extras (ca. ${analyzedB.equipment?.marketBonusEur?.toLocaleString('de-DE') || 0} € Wert)`,
      deltaText: netEquipmentDeltaForA >= 0 ? `+${netEquipmentDeltaForA.toLocaleString('de-DE')} € Mehrwert für A` : `+${Math.abs(netEquipmentDeltaForA).toLocaleString('de-DE')} € Mehrwert für B`,
      valueDeltaEur: netEquipmentDeltaForA,
      advantage: netEquipmentDeltaForA > 0 ? 'A' : (netEquipmentDeltaForA < 0 ? 'B' : 'EQUAL')
    },
    {
      category: 'Laufleistung',
      label: 'Kilometerstand',
      carAValue: `${kmA.toLocaleString('de-DE')} km`,
      carBValue: `${kmB.toLocaleString('de-DE')} km`,
      deltaText: kmDiff > 0 ? `${kmDiff.toLocaleString('de-DE')} km weniger bei A` : (kmDiff < 0 ? `${Math.abs(kmDiff).toLocaleString('de-DE')} km weniger bei B` : 'Identisch'),
      valueDeltaEur: kmValueDeltaForA,
      advantage: kmDiff > 0 ? 'A' : (kmDiff < 0 ? 'B' : 'EQUAL')
    },
    {
      category: 'Alter & Baujahr',
      label: 'Erstzulassung / Alter',
      carAValue: `EZ ${analyzedA.vehicle_data?.firstRegistration || '-'} (${ageA} J.)`,
      carBValue: `EZ ${analyzedB.vehicle_data?.firstRegistration || '-'} (${ageB} J.)`,
      deltaText: ageDiffYears > 0 ? `${ageDiffYears} Jahre jünger (A)` : (ageDiffYears < 0 ? `${Math.abs(ageDiffYears)} Jahre jünger (B)` : 'Gleich alt'),
      valueDeltaEur: ageValueDeltaForA,
      advantage: ageDiffYears > 0 ? 'A' : (ageDiffYears < 0 ? 'B' : 'EQUAL')
    },
    {
      category: 'Motor & Antrieb',
      label: 'Leistung & Getriebe',
      carAValue: `${hpA} PS (${analyzedA.engine_data?.transmission || 'Auto.'})`,
      carBValue: `${hpB} PS (${analyzedB.engine_data?.transmission || 'Auto.'})`,
      deltaText: hpDiff > 0 ? `+${hpDiff} PS mehr bei A` : (hpDiff < 0 ? `+${Math.abs(hpDiff)} PS mehr bei B` : 'Gleiche Leistung'),
      valueDeltaEur: hpValueDeltaForA,
      advantage: hpDiff > 0 ? 'A' : (hpDiff < 0 ? 'B' : 'EQUAL')
    },
    {
      category: 'Unterhalt (TCO)',
      label: 'Laufende Kosten / Jahr',
      carAValue: `${(analyzedA.running_costs?.totalAnnualCost || 0).toLocaleString('de-DE')} €/J.`,
      carBValue: `${(analyzedB.running_costs?.totalAnnualCost || 0).toLocaleString('de-DE')} €/J.`,
      deltaText: (analyzedB.running_costs?.totalAnnualCost || 0) > (analyzedA.running_costs?.totalAnnualCost || 0) ? `A spart ${((analyzedB.running_costs?.totalAnnualCost || 0) - (analyzedA.running_costs?.totalAnnualCost || 0)).toLocaleString('de-DE')} €/Jahr` : `B spart ${((analyzedA.running_costs?.totalAnnualCost || 0) - (analyzedB.running_costs?.totalAnnualCost || 0)).toLocaleString('de-DE')} €/Jahr`,
      valueDeltaEur: (analyzedB.running_costs?.totalAnnualCost || 0) - (analyzedA.running_costs?.totalAnnualCost || 0),
      advantage: (analyzedA.running_costs?.totalAnnualCost || 0) < (analyzedB.running_costs?.totalAnnualCost || 0) ? 'A' : 'B'
    },
    {
      category: 'Wartungshistorie',
      label: 'Scheckheftgepflegt',
      carAValue: histA ? 'Lückenlos vorhanden ✓' : 'Nicht belegt ✗',
      carBValue: histB ? 'Lückenlos vorhanden ✓' : 'Nicht belegt ✗',
      deltaText: historyValueDeltaForA > 0 ? 'Vorteil Scheckheft (A)' : (historyValueDeltaForA < 0 ? 'Vorteil Scheckheft (B)' : 'Beide gleich'),
      valueDeltaEur: historyValueDeltaForA,
      advantage: historyValueDeltaForA > 0 ? 'A' : (historyValueDeltaForA < 0 ? 'B' : 'EQUAL')
    }
  ];

  return {
    vehicleA: analyzedA,
    vehicleB: analyzedB,
    comparison: {
      priceA,
      priceB,
      priceDelta,
      priceDeltaAbs,
      moreExpensive: priceDelta > 0 ? 'A' : (priceDelta < 0 ? 'B' : 'EQUAL'),
      totalJustifiedValueForA,
      expensiveValueAdvantage,
      netSurplusForExpensive,
      coverageRatio: Math.round(coverageRatio * 100),
      verdict: {
        type: verdictType,
        title: verdictTitle,
        badge: verdictBadge,
        recommendation: verdictRecommendation,
        winner,
        summaryBulletPoints
      },
      equipment: {
        onlyInA,
        onlyInB,
        common,
        bonusOnlyInA,
        bonusOnlyInB,
        netEquipmentDeltaForA
      },
      breakdownRows
    }
  };
}

/**
 * Durchsucht eine Liste von Fahrzeugen nach Paaren mit identischem Modell
 */
function findSameModelPairs(vehiclesList) {
  if (!vehiclesList || vehiclesList.length < 2) return [];
  const pairs = [];

  for (let i = 0; i < vehiclesList.length; i++) {
    for (let j = i + 1; j < vehiclesList.length; j++) {
      const a = vehiclesList[i];
      const b = vehiclesList[j];
      const makeA = (a.vehicle_data?.make || a.make || '').toLowerCase();
      const makeB = (b.vehicle_data?.make || b.make || '').toLowerCase();
      const modelA = (a.vehicle_data?.model || a.model || '').toLowerCase();
      const modelB = (b.vehicle_data?.model || b.model || '').toLowerCase();

      // Gleiche Marke und ähnliches Modell
      if (makeA && makeB && makeA === makeB && (modelA.includes(modelB) || modelB.includes(modelA) || modelA === modelB)) {
        pairs.push({
          indexA: i,
          indexB: j,
          idA: a.id,
          idB: b.id,
          titleA: a.title,
          titleB: b.title,
          make: a.vehicle_data?.make || a.make,
          model: a.vehicle_data?.model || a.model
        });
      }
    }
  }

  return pairs;
}

module.exports = {
  compareTwoVehicles,
  findSameModelPairs
};
