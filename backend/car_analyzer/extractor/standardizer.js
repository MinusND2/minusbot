const marketCoefficients = require('../database/marketCoefficients.json');
const reliabilityDatabase = require('../database/reliabilityDatabase.json');

/**
 * Normalisiert rohe Fahrzeugdaten in ein einheitliches, standardisiertes Objekt
 */
function standardizeVehicle(raw) {
  const now = new Date();
  const currentYear = now.getFullYear();

  // 1. Marke & Modell
  let make = (raw.make || '').trim();
  let model = (raw.model || '').trim();
  let title = (raw.title || `${make} ${model}`).trim();

  // Marke normalisieren
  const lowerMake = make.toLowerCase();
  if (lowerMake.includes('bmw')) make = 'BMW';
  else if (lowerMake.includes('mercedes')) make = 'Mercedes-Benz';
  else if (lowerMake.includes('audi')) make = 'Audi';
  else if (lowerMake.includes('volkswagen') || lowerMake === 'vw') make = 'Volkswagen';
  else if (lowerMake.includes('porsche')) make = 'Porsche';
  else if (lowerMake.includes('skoda') || lowerMake.includes('škoda')) make = 'Skoda';
  else if (lowerMake.includes('seat') || lowerMake.includes('cupra')) make = 'Seat';
  else if (lowerMake.includes('toyota')) make = 'Toyota';
  else if (lowerMake.includes('ford')) make = 'Ford';
  else if (lowerMake.includes('hyundai')) make = 'Hyundai';
  else if (lowerMake.includes('kia')) make = 'Kia';
  else if (lowerMake.includes('volvo')) make = 'Volvo';
  else if (lowerMake.includes('mazda')) make = 'Mazda';

  // 2. Erstzulassung & Baujahr
  let year = parseInt(raw.year || 0, 10);
  let firstRegistration = (raw.firstRegistration || '').toString().trim();
  let registrationMonth = 6; // Default Juni

  if (firstRegistration) {
    const parts = firstRegistration.split(/[/.-]/);
    if (parts.length === 2) {
      const p0 = parseInt(parts[0], 10);
      const p1 = parseInt(parts[1], 10);
      if (p0 > 1990 && p0 <= currentYear + 1) {
        year = p0;
        registrationMonth = p1 || 6;
      } else if (p1 > 1990 && p1 <= currentYear + 1) {
        year = p1;
        registrationMonth = p0 || 6;
      }
    } else if (firstRegistration.match(/^\d{4}$/)) {
      year = parseInt(firstRegistration, 10);
    }
  }

  if (!year || isNaN(year)) {
    year = currentYear - 4; // Konservativer Fallback
  }
  const vehicleAgeYears = Math.max(0.2, (currentYear - year) + (now.getMonth() + 1 - registrationMonth) / 12);

  // 3. Kilometerstand
  let mileage = parseInt(String(raw.mileage || '').replace(/[^\d]/g, ''), 10);
  if (isNaN(mileage) || mileage < 0) {
    mileage = Math.round(vehicleAgeYears * marketCoefficients.annualKmBenchmark);
  }

  // 4. Leistung (PS / kW)
  let powerHp = parseInt(String(raw.powerHp || raw.ps || '').replace(/[^\d]/g, ''), 10);
  let powerKw = parseInt(String(raw.powerKw || raw.kw || '').replace(/[^\d]/g, ''), 10);

  if (powerHp && !powerKw) {
    powerKw = Math.round(powerHp / 1.35962);
  } else if (powerKw && !powerHp) {
    powerHp = Math.round(powerKw * 1.35962);
  }

  // 5. Kraftstoff
  let fuelType = (raw.fuelType || 'Benzin').trim();
  const lowerFuel = fuelType.toLowerCase();
  if (lowerFuel.includes('diesel')) fuelType = 'Diesel';
  else if (lowerFuel.includes('elektro') || lowerFuel.includes('electric')) fuelType = 'Elektro';
  else if (lowerFuel.includes('hybrid')) fuelType = 'Hybrid';
  else if (lowerFuel.includes('cng') || lowerFuel.includes('erdgas')) fuelType = 'Erdgas';
  else if (lowerFuel.includes('lpg') || lowerFuel.includes('autogas')) fuelType = 'Autogas';
  else fuelType = 'Benzin';

  // 6. Hubraum & Zylinder
  let displacement = parseInt(String(raw.displacement || '').replace(/[^\d]/g, ''), 10);
  if (isNaN(displacement) || displacement <= 0) {
    // Schätzung anhand Leistungsklasse
    if (fuelType === 'Elektro') {
      displacement = 0;
    } else if (powerHp > 280) {
      displacement = 2998;
    } else if (powerHp > 160) {
      displacement = 1998;
    } else {
      displacement = 1498;
    }
  }

  let cylinders = parseInt(raw.cylinders || 0, 10);
  if (!cylinders) {
    if (fuelType === 'Elektro') cylinders = 0;
    else if (displacement >= 2700) cylinders = 6;
    else cylinders = 4;
  }

  // 7. Getriebe & Antrieb
  let transmission = (raw.transmission || 'Automatik').trim();
  const lowerTrans = transmission.toLowerCase();
  if (lowerTrans.includes('schalt') || lowerTrans.includes('manuell') || lowerTrans.includes('hand')) {
    transmission = 'Schaltgetriebe';
  } else if (lowerTrans.includes('dsg') || lowerTrans.includes('doppelkupplung') || lowerTrans.includes('dkg')) {
    transmission = 'Doppelkupplung';
  } else {
    transmission = 'Automatik';
  }

  let driveType = (raw.driveType || '').trim();
  const lowerDrive = (driveType + ' ' + title + ' ' + (raw.rawText || '')).toLowerCase();
  if (lowerDrive.includes('allrad') || lowerDrive.includes('4motion') || lowerDrive.includes('xdrive') || lowerDrive.includes('quattro') || lowerDrive.includes('4matic') || lowerDrive.includes('awd') || lowerDrive.includes('4x4')) {
    driveType = 'Allrad';
  } else if (lowerDrive.includes('heck') || lowerDrive.includes('rwd') || (make === 'BMW' && !lowerDrive.includes('1er') && !lowerDrive.includes('2er active')) || make === 'Mercedes-Benz') {
    driveType = 'Hinterradantrieb';
  } else {
    driveType = 'Frontantrieb';
  }

  // 8. Verbrauch & CO2
  let consumptionCombined = parseFloat(String(raw.consumptionCombined || raw.consumption || '').replace(',', '.'));
  if (isNaN(consumptionCombined) || consumptionCombined <= 0) {
    // Realistischer Benchmark je nach Kraftstoff & PS
    if (fuelType === 'Elektro') consumptionCombined = 18.5; // kWh/100km
    else if (fuelType === 'Hybrid') consumptionCombined = Math.max(3.8, Math.round((powerHp * 0.022 + 2.0) * 10) / 10);
    else if (fuelType === 'Diesel') consumptionCombined = Math.max(4.5, Math.round((powerHp * 0.025 + 2.4) * 10) / 10);
    else consumptionCombined = Math.max(5.2, Math.round((powerHp * 0.032 + 3.0) * 10) / 10);
  }

  let co2 = parseInt(String(raw.co2 || '').replace(/[^\d]/g, ''), 10);
  if (isNaN(co2) || co2 <= 0) {
    if (fuelType === 'Elektro') co2 = 0;
    else if (fuelType === 'Diesel') co2 = Math.round(consumptionCombined * 26.5);
    else co2 = Math.round(consumptionCombined * 23.8);
  }

  // 9. Preis
  let askingPrice = parseInt(String(raw.price || raw.askingPrice || '').replace(/[^\d]/g, ''), 10);
  if (isNaN(askingPrice) || askingPrice <= 0) {
    askingPrice = 20000;
  }

  // 10. Ausstattungserkennung & Standardisierung
  const rawFeaturesText = [
    raw.features ? (Array.isArray(raw.features) ? raw.features.join(' ') : String(raw.features)) : '',
    raw.description || '',
    raw.title || '',
    raw.rawText || ''
  ].join(' ').toLowerCase();

  const recognizedEquipment = [];
  let equipmentScorePoints = 0;
  let equipmentMarketBonusEur = 0;

  for (const [key, eq] of Object.entries(marketCoefficients.equipmentWeights)) {
    let matched = false;
    // Schlüsselwort-Prüfung
    if (key === 'sportpaket' && (rawFeaturesText.includes('m sport') || rawFeaturesText.includes('m-paket') || rawFeaturesText.includes('m paket') || rawFeaturesText.includes('s line') || rawFeaturesText.includes('s-line') || rawFeaturesText.includes('amg line') || rawFeaturesText.includes('amg-line') || rawFeaturesText.includes('sportpaket') || rawFeaturesText.includes('r-line'))) {
      matched = true;
    } else if (key === 'led_matrix' && (rawFeaturesText.includes('matrix') || rawFeaturesText.includes('laser') || rawFeaturesText.includes('multibeam') || rawFeaturesText.includes('adaptive led') || rawFeaturesText.includes('adaptives kurvenlicht'))) {
      matched = true;
    } else if (key === 'led_standard' && (rawFeaturesText.includes('led') && !matched)) {
      matched = true;
    } else if (key === 'xenon' && (rawFeaturesText.includes('xenon') || rawFeaturesText.includes('bi-xenon'))) {
      matched = true;
    } else if (key === 'panorama' && (rawFeaturesText.includes('panorama') || rawFeaturesText.includes('schiebedach') || rawFeaturesText.includes('glasschiebedach'))) {
      matched = true;
    } else if (key === 'acc' && (rawFeaturesText.includes('acc') || rawFeaturesText.includes('abstandstempomat') || rawFeaturesText.includes('distronic') || rawFeaturesText.includes('adaptive cruise') || rawFeaturesText.includes('geschwindigkeitsregelung mit brems'))) {
      matched = true;
    } else if (key === 'lane_assist' && (rawFeaturesText.includes('spurhalte') || rawFeaturesText.includes('lane assist') || rawFeaturesText.includes('aktiver lenkassistent'))) {
      matched = true;
    } else if (key === 'blind_spot' && (rawFeaturesText.includes('totwinkel') || rawFeaturesText.includes('blind spot') || rawFeaturesText.includes('side assist'))) {
      matched = true;
    } else if (key === 'brake_assist' && (rawFeaturesText.includes('notbrems') || rawFeaturesText.includes('front assist') || rawFeaturesText.includes('collision prevention'))) {
      matched = true;
    } else if (key === 'camera_360' && (rawFeaturesText.includes('360') || rawFeaturesText.includes('surround view') || rawFeaturesText.includes('area view') || rawFeaturesText.includes('rundumkamera'))) {
      matched = true;
    } else if (key === 'camera_rear' && (rawFeaturesText.includes('rückfahrkamera') || rawFeaturesText.includes('reversing camera') || rawFeaturesText.includes('kamera hinten'))) {
      matched = true;
    } else if (key === 'park_sensors' && (rawFeaturesText.includes('pdc') || rawFeaturesText.includes('parksensor') || rawFeaturesText.includes('park distance control') || rawFeaturesText.includes('einparkhilfe'))) {
      matched = true;
    } else if (key === 'headup' && (rawFeaturesText.includes('head-up') || rawFeaturesText.includes('head up') || rawFeaturesText.includes('hud'))) {
      matched = true;
    } else if (key === 'digital_cockpit' && (rawFeaturesText.includes('digital cockpit') || rawFeaturesText.includes('virtual cockpit') || rawFeaturesText.includes('live cockpit') || rawFeaturesText.includes('widescreen'))) {
      matched = true;
    } else if (key === 'navigation' && (rawFeaturesText.includes('navi') || rawFeaturesText.includes('mmi') || rawFeaturesText.includes('command') || rawFeaturesText.includes('infotainment'))) {
      matched = true;
    } else if (key === 'carplay_android' && (rawFeaturesText.includes('carplay') || rawFeaturesText.includes('android auto') || rawFeaturesText.includes('smartphone interface'))) {
      matched = true;
    } else if (key === 'sound_premium' && (rawFeaturesText.includes('harman') || rawFeaturesText.includes('kardon') || rawFeaturesText.includes('bose') || rawFeaturesText.includes('bang') || rawFeaturesText.includes('olufsen') || rawFeaturesText.includes('burmester') || rawFeaturesText.includes('canton') || rawFeaturesText.includes('dynaudio'))) {
      matched = true;
    } else if (key === 'standheizung' && rawFeaturesText.includes('standheizung')) {
      matched = true;
    } else if (key === 'seats_heated' && (rawFeaturesText.includes('sitzheizung') || rawFeaturesText.includes('beheizbare sitze'))) {
      matched = true;
    } else if (key === 'seats_heated_rear' && (rawFeaturesText.includes('sitzheizung hinten') || rawFeaturesText.includes('sitzheizung im fond'))) {
      matched = true;
    } else if (key === 'steering_heated' && (rawFeaturesText.includes('lenkradheizung') || rawFeaturesText.includes('beheizbares lenkrad'))) {
      matched = true;
    } else if (key === 'seats_electric_memory' && (rawFeaturesText.includes('memory') || (rawFeaturesText.includes('elektr') && rawFeaturesText.includes('sitze')))) {
      matched = true;
    } else if (key === 'seats_sport' && (rawFeaturesText.includes('sportsitz') || rawFeaturesText.includes('schalensitz'))) {
      matched = true;
    } else if (key === 'leather' && (rawFeaturesText.includes('leder') || rawFeaturesText.includes('dakota') || rawFeaturesText.includes('nappa') || rawFeaturesText.includes('vernasca'))) {
      matched = true;
    } else if (key === 'trailer_hitch' && (rawFeaturesText.includes('anhängerkupplung') || rawFeaturesText.includes('ahk'))) {
      matched = true;
    } else if (key === 'aircon_auto' && (rawFeaturesText.includes('klimaautomatik') || rawFeaturesText.includes('climatronic') || rawFeaturesText.includes('thermotronic'))) {
      matched = true;
    } else if (key === 'allrad' && (rawFeaturesText.includes('allrad') || rawFeaturesText.includes('xdrive') || rawFeaturesText.includes('quattro') || rawFeaturesText.includes('4matic') || rawFeaturesText.includes('4motion') || rawFeaturesText.includes('awd') || rawFeaturesText.includes('4x4'))) {
      matched = true;
    } else if (key === 'keyless' && (rawFeaturesText.includes('keyless') || rawFeaturesText.includes('komfortzugang') || rawFeaturesText.includes('kessy') || rawFeaturesText.includes('schlüssellose'))) {
      matched = true;
    } else if (key === 'ambient_light' && (rawFeaturesText.includes('ambient') || rawFeaturesText.includes('ambiente') || rawFeaturesText.includes('konturbeleuchtung') || rawFeaturesText.includes('lichtpaket'))) {
      matched = true;
    } else if (key === 'adaptive_suspension' && (rawFeaturesText.includes('adaptiv') && (rawFeaturesText.includes('fahrwerk') || rawFeaturesText.includes('dämpfer')) || rawFeaturesText.includes('luftfederung') || rawFeaturesText.includes('airmatic') || rawFeaturesText.includes('dcc'))) {
      matched = true;
    } else if (key === 'highbeam_assist' && (rawFeaturesText.includes('fernlichtassistent') || rawFeaturesText.includes('light assist') || rawFeaturesText.includes('blendfreies fernlicht'))) {
      matched = true;
    } else if (key === 'wireless_charging' && (rawFeaturesText.includes('induktion') || rawFeaturesText.includes('kabellose') || rawFeaturesText.includes('wireless charge') || rawFeaturesText.includes('wireless charging'))) {
      matched = true;
    } else if (key === 'alarm_system' && (rawFeaturesText.includes('alarm') || rawFeaturesText.includes('diebstahlwarn'))) {
      matched = true;
    } else if (key === 'traffic_sign' && (rawFeaturesText.includes('verkehrszeichen') || rawFeaturesText.includes('speed limit') || rawFeaturesText.includes('verkehrsschild'))) {
      matched = true;
    } else if (key === 'seats_ventilated' && (rawFeaturesText.includes('sitzbelüftung') || rawFeaturesText.includes('klimatisierte sitze') || rawFeaturesText.includes('belüftete sitze'))) {
      matched = true;
    } else if (key === 'privacy_glass' && (rawFeaturesText.includes('privacy') || rawFeaturesText.includes('abgedunkelt') || rawFeaturesText.includes('sonnenschutzverglasung') || rawFeaturesText.includes('getönte scheiben'))) {
      matched = true;
    } else if (key === 'extra_wheels' && (rawFeaturesText.includes('8-fach') || rawFeaturesText.includes('winterräder') || rawFeaturesText.includes('winterreifen') || rawFeaturesText.includes('zweiter radsatz') || (rawFeaturesText.includes('sommer') && rawFeaturesText.includes('winter')))) {
      matched = true;
    }

    if (matched) {
      recognizedEquipment.push({
        id: key,
        name: eq.name,
        category: eq.category,
        points: eq.points,
        marketBonusEur: eq.marketBonusEur
      });
      equipmentScorePoints += eq.points;
      equipmentMarketBonusEur += eq.marketBonusEur;
    }
  }

  // 11. Motorcode & Erkennung
  let detectedEngineCode = null;
  const lowerTitle = (title + ' ' + (raw.description || '')).toLowerCase();
  if (make === 'BMW') {
    if (lowerTitle.includes('320i') || lowerTitle.includes('330i') || lowerTitle.includes('420i') || lowerTitle.includes('430i') || lowerTitle.includes('520i') || lowerTitle.includes('530i')) {
      if (year >= 2015) detectedEngineCode = 'BMW_B48';
      else detectedEngineCode = 'BMW_N20';
    } else if (lowerTitle.includes('340i') || lowerTitle.includes('m340i') || lowerTitle.includes('440i') || lowerTitle.includes('m440i') || lowerTitle.includes('540i') || lowerTitle.includes('m140i')) {
      detectedEngineCode = 'BMW_B58';
    } else if (lowerTitle.includes('320d') || lowerTitle.includes('318d') || lowerTitle.includes('520d') || lowerTitle.includes('420d') || lowerTitle.includes('118d') || lowerTitle.includes('120d')) {
      detectedEngineCode = 'BMW_B47';
    }
  } else if (make === 'Volkswagen' || make === 'Audi' || make === 'Seat' || make === 'Skoda') {
    if (fuelType === 'Benzin' && (displacement >= 1790 && displacement <= 2020)) {
      if (year >= 2013) detectedEngineCode = 'VAG_EA888_GEN3';
      else detectedEngineCode = 'VAG_EA888_GEN2';
    } else if (fuelType === 'Diesel' && (displacement >= 1900 && displacement <= 2010)) {
      detectedEngineCode = 'VAG_EA288';
    }
  } else if (make === 'Mercedes-Benz') {
    if (fuelType === 'Diesel' && (displacement >= 1940 && displacement <= 2150)) {
      detectedEngineCode = 'MERCEDES_OM654';
    } else if (fuelType === 'Benzin' && (displacement >= 1580 && displacement <= 2020)) {
      detectedEngineCode = 'MERCEDES_M274';
    }
  } else if (make === 'Toyota') {
    if (fuelType === 'Hybrid' || fuelType === 'Benzin') {
      detectedEngineCode = 'TOYOTA_HYBRID_18_20';
    }
  }

  // 12. Segmenterkennung (für Wertverlust & Versicherung)
  let segment = 'mittelklasse';
  const modelUpper = model.toUpperCase();
  if (['1ER', 'A1', 'A3', 'GOLF', 'POLO', 'FIESTA', 'FOCUS', 'COROLLA', 'YARIS', 'A-KLASSE'].some(m => modelUpper.includes(m) || title.toUpperCase().includes(m))) {
    segment = modelUpper.includes('POLO') || modelUpper.includes('FIESTA') || modelUpper.includes('YARIS') || modelUpper.includes('A1') ? 'kleinwagen' : 'kompakt';
  } else if (['3ER', 'A4', 'C-KLASSE', 'C 200', 'C 220', 'C 300', 'OCTAVIA', 'PASSAT', 'MONDEO'].some(m => modelUpper.includes(m) || title.toUpperCase().includes(m))) {
    segment = 'mittelklasse';
  } else if (['5ER', 'A6', 'E-KLASSE', 'E 220', 'E 300', 'A7', 'SUPERB'].some(m => modelUpper.includes(m) || title.toUpperCase().includes(m))) {
    segment = 'obere_mittelklasse';
  } else if (['X1', 'X3', 'X5', 'Q3', 'Q5', 'GLC', 'TIGUAN', 'T-ROC', 'RAV4', 'Kuga'].some(m => modelUpper.includes(m) || title.toUpperCase().includes(m))) {
    segment = 'suv';
  } else if (['911', 'CAYMAN', 'BOXSTER', 'M2', 'M3', 'M4', 'RS3', 'RS4', 'AMG GT', 'MUSTANG'].some(m => modelUpper.includes(m) || title.toUpperCase().includes(m))) {
    segment = 'sportwagen';
  }

  // 13. Datenqualität ermitteln
  const missingFields = [];
  if (!raw.price && !raw.askingPrice) missingFields.push('Preis');
  if (!raw.mileage) missingFields.push('Kilometerstand');
  if (!raw.firstRegistration && !raw.year) missingFields.push('Erstzulassung');
  if (!raw.powerHp && !raw.powerKw && !raw.ps && !raw.kw) missingFields.push('Leistung (PS/kW)');
  if (!raw.fuelType) missingFields.push('Kraftstoffart');

  let dataQualityLevel = 'high';
  let dataQualityText = '🟢 Hohe Datenqualität – Alle wesentlichen Fahrzeug- und Ausstattungsdaten vorhanden.';
  if (missingFields.length >= 3) {
    dataQualityLevel = 'low';
    dataQualityText = '🔴 Geringe Datenbasis – Bewertung mit erhöhter Unsicherheit (fehlende Pflichtangaben ergänzen).';
  } else if (missingFields.length > 0) {
    dataQualityLevel = 'medium';
    dataQualityText = `🟡 Mittlere Datenqualität – Folgende Daten wurden statistisch geschätzt: ${missingFields.join(', ')}.`;
  }

  return {
    id: raw.id || `veh_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    title: title || `${make} ${model}`,
    vehicle_data: {
      make,
      model,
      series: raw.series || model,
      generation: raw.generation || (year >= 2019 ? 'Aktuell / Letzte Generation' : 'Vorgänger-Generation'),
      variant: raw.variant || '',
      bodyType: raw.bodyType || (segment === 'suv' ? 'SUV' : 'Limousine/Kombi'),
      year,
      firstRegistration: firstRegistration || `${registrationMonth.toString().padStart(2, '0')}/${year}`,
      registrationMonth,
      ageYears: Math.round(vehicleAgeYears * 10) / 10,
      mileage,
      color: raw.color || 'Unbekannt',
      previousOwners: parseInt(raw.previousOwners || 1, 10),
      isImport: Boolean(raw.isImport || rawFeaturesText.includes('import') || rawFeaturesText.includes('reimport') || rawFeaturesText.includes('us-modell')),
      serviceHistoryComplete: Boolean(raw.serviceHistoryComplete !== false && (rawFeaturesText.includes('scheckheft') || rawFeaturesText.includes('lückenlos') || rawFeaturesText.includes('service gepflegt') || rawFeaturesText.includes('digitales serviceheft'))),
      accidentDamaged: Boolean(raw.accidentDamaged || rawFeaturesText.includes('unfall') || rawFeaturesText.includes('beschädigt')),
      segment
    },
    engine_data: {
      fuelType,
      displacement,
      cylinders,
      powerHp,
      powerKw,
      torque: parseInt(raw.torque || (powerHp * 1.6), 10),
      driveType,
      transmission,
      gears: parseInt(raw.gears || (transmission === 'Schaltgetriebe' ? 6 : (make === 'BMW' ? 8 : (make === 'Mercedes-Benz' ? 9 : 7))), 10),
      emissionsStandard: raw.emissionsStandard || (year >= 2021 ? 'Euro 6d' : (year >= 2018 ? 'Euro 6d-TEMP' : (year >= 2015 ? 'Euro 6' : 'Euro 5'))),
      co2,
      consumptionCombined: Math.round(consumptionCombined * 10) / 10,
      detectedEngineCode
    },
    equipment: {
      recognized: recognizedEquipment,
      rawFeatures: raw.features || [],
      scorePoints: equipmentScorePoints,
      marketBonusEur: equipmentMarketBonusEur
    },
    price_data: {
      askingPrice,
      currency: 'EUR',
      priceHistory: raw.priceHistory || [{ date: now.toISOString().split('T')[0], price: askingPrice }]
    },
    data_quality: {
      level: dataQualityLevel,
      text: dataQualityText,
      missingFields
    },
    source_data: {
      url: raw.url || '',
      platform: raw.platform || (raw.url && raw.url.includes('mobile.de') ? 'mobile.de' : 'manuell'),
      extractedAt: raw.extractedAt || now.toISOString()
    }
  };
}

module.exports = {
  standardizeVehicle
};
