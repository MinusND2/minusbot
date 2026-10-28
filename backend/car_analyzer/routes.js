const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const { extractFromMobileDe, parseRawAdText } = require('./extractor/mobileDeExtractor');
const { standardizeVehicle } = require('./extractor/standardizer');
const { rankVehicles, analyzeSingleVehicle } = require('./engine/scoringEngine');
const { compareTwoVehicles, findSameModelPairs } = require('./engine/compareEngine');
const marketCoefficients = require('./database/marketCoefficients.json');
const reliabilityDatabase = require('./database/reliabilityDatabase.json');

// In-Memory Speicher für Preisverlauf & Analysen (optional persistent)
const priceHistoryStore = new Map();

/**
 * POST /api/car-analyzer/extract
 * Extrahiert Fahrzeugdaten aus einer Mobile.de URL oder reinem Inseratstext / Formular
 */
router.post('/extract', async (req, res) => {
  try {
    const { url, rawText, manualData } = req.body;

    if (manualData) {
      const standardized = standardizeVehicle(manualData);
      return res.json({
        success: true,
        method: 'manual',
        vehicle: standardized
      });
    }

    if (rawText && typeof rawText === 'string' && rawText.trim().length > 0) {
      const parsed = parseRawAdText(rawText, url || '');
      const standardized = standardizeVehicle(parsed);
      return res.json({
        success: true,
        method: 'text_parse',
        vehicle: standardized
      });
    }

    if (url && typeof url === 'string') {
      const extractResult = await extractFromMobileDe(url);
      return res.json({
        success: extractResult.success,
        method: 'url_scrape',
        blocked: extractResult.blocked || false,
        message: extractResult.message,
        vehicle: extractResult.data
      });
    }

    return res.status(400).json({
      success: false,
      error: 'Weder URL, Text noch Formulardaten übermittelt.'
    });
  } catch (err) {
    console.error('[Car Analyzer] Fehler in /extract:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/car-analyzer/analyze
 * Führt die vollständige deterministische Preis-Leistungs-Analyse für N Fahrzeuge durch
 */
router.post('/analyze', (req, res) => {
  try {
    const { vehicles, options } = req.body;

    if (!vehicles || !Array.isArray(vehicles) || vehicles.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Keine Fahrzeugdaten zum Analysieren übergeben.'
      });
    }

    // Standardisieren, falls rohe Fahrzeuge übergeben wurden
    const standardizedList = vehicles.map(v => {
      // Wenn bereits standardisiert (hat vehicle_data)
      if (v.vehicle_data && v.engine_data) return v;
      return standardizeVehicle(v);
    });

    // Preisänderungs-Check
    for (const veh of standardizedList) {
      const idKey = veh.source_data?.url || veh.title;
      const currentPrice = veh.price_data.askingPrice;
      const today = new Date().toISOString().split('T')[0];

      if (priceHistoryStore.has(idKey)) {
        const history = priceHistoryStore.get(idKey);
        const lastEntry = history[history.length - 1];
        if (lastEntry && lastEntry.price !== currentPrice) {
          history.push({ date: today, price: currentPrice });
          veh.price_data.priceHistory = history;
          veh.price_data.priceDropEur = lastEntry.price - currentPrice;
        }
      } else {
        priceHistoryStore.set(idKey, [{ date: today, price: currentPrice }]);
      }
    }

    const ranking = rankVehicles(standardizedList, options || {});
    const sameModelPairs = findSameModelPairs(ranking);

    res.json({
      success: true,
      count: ranking.length,
      ranking,
      sameModelPairs,
      calculatedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('[Car Analyzer] Fehler in /analyze:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/car-analyzer/compare
 * Führt einen direkten 1-zu-1 Detailvergleich durch (Ausstattungs-Differenz & Preisbegründung)
 */
router.post('/compare', (req, res) => {
  try {
    const { vehicleA, vehicleB, options } = req.body;

    if (!vehicleA || !vehicleB) {
      return res.status(400).json({
        success: false,
        error: 'Es müssen zwei Fahrzeuge für den Vergleich übergeben werden.'
      });
    }

    const stdA = vehicleA.vehicle_data && vehicleA.engine_data ? vehicleA : standardizeVehicle(vehicleA);
    const stdB = vehicleB.vehicle_data && vehicleB.engine_data ? vehicleB : standardizeVehicle(vehicleB);

    const comparisonResult = compareTwoVehicles(stdA, stdB, options || {});

    res.json({
      success: true,
      ...comparisonResult,
      comparedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('[Car Analyzer] Fehler in /compare:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/car-analyzer/config
 * Gibt Standardgewichte, Ausstattungsliste, Kraftstoffpreise und Wissensdatenbank zurück
 */
router.get('/config', (req, res) => {
  try {
    res.json({
      success: true,
      defaultWeights: marketCoefficients.defaultWeights,
      equipmentWeights: marketCoefficients.equipmentWeights,
      defaultFuelPrices: marketCoefficients.defaultFuelPrices,
      annualKmBenchmark: marketCoefficients.annualKmBenchmark,
      depreciationRates: marketCoefficients.depreciationRates,
      reliabilityEngines: Object.keys(reliabilityDatabase.engines).map(k => ({
        code: k,
        name: reliabilityDatabase.engines[k].name,
        score: reliabilityDatabase.engines[k].reliabilityScore,
        make: reliabilityDatabase.engines[k].make
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * BMW-4er-Deal-Finder (Marktwert aus Vergleichsinseraten, Deal-Score, Risiko)
 * -> /api/car-analyzer/deals/...
 */
try {
  router.use('/deals', require('./dealfinder/router'));
} catch (e) {
  console.error('[Car Analyzer] Deal-Finder konnte nicht geladen werden:', e.message);
}

module.exports = router;
