const { standardizeVehicle } = require('./standardizer');

/**
 * Extrahiert Fahrzeugdaten aus Text / HTML-Snippet (Regex-Parser)
 */
function parseRawAdText(rawText, sourceUrl = '') {
  const text = rawText || '';
  const result = {
    title: '',
    make: '',
    model: '',
    price: null,
    mileage: null,
    firstRegistration: '',
    powerHp: null,
    powerKw: null,
    fuelType: '',
    transmission: '',
    displacement: null,
    features: [],
    rawText: text,
    url: sourceUrl
  };

  // 1. Preis suchen (z. B. "22.490 €", "€ 22.490,-", "22490 EUR")
  const priceMatch = text.match(/(?:preis|barpreis|angebotspreis)?[:\s]*([0-9]{1,3}(?:\.[0-9]{3})+|[0-9]{4,6})\s*(?:€|eur)/i) ||
                     text.match(/€\s*([0-9]{1,3}(?:\.[0-9]{3})+|[0-9]{4,6})/i);
  if (priceMatch) {
    result.price = parseInt(priceMatch[1].replace(/\./g, ''), 10);
  }

  // 2. Kilometerstand suchen (z. B. "72.500 km", "Laufleistung: 80000 km")
  const kmMatch = text.match(/(?:laufleistung|kilometerstand|km)?[:\s]*([0-9]{1,3}(?:\.[0-9]{3})+|[0-9]{4,6})\s*km\b/i);
  if (kmMatch) {
    result.mileage = parseInt(kmMatch[1].replace(/\./g, ''), 10);
  }

  // 3. Erstzulassung / Baujahr (z. B. "EZ 06/2020", "Erstzulassung: 2020/06", "03/2019")
  const ezMatch = text.match(/(?:ez|erstzulassung|baujahr)[:\s]*([0-1]?[0-9][\/\.-][1-2][0-9]{3})/i) ||
                  text.match(/(?:ez|erstzulassung)[:\s]*([1-2][0-9]{3}[\/\.-][0-1]?[0-9])/i) ||
                  text.match(/\b([0-1][0-9][\/][1-2][0-9]{3})\b/);
  if (ezMatch) {
    result.firstRegistration = ezMatch[1];
  }

  // 4. Leistung suchen (z. B. "140 kW (190 PS)", "190 PS", "140 kW")
  const hpKwMatch = text.match(/([0-9]{2,4})\s*kw\s*\(([0-9]{2,4})\s*ps\)/i) ||
                    text.match(/([0-9]{2,4})\s*ps\s*\(([0-9]{2,4})\s*kw\)/i);
  if (hpKwMatch) {
    if (hpKwMatch[0].toLowerCase().includes('kw (')) {
      result.powerKw = parseInt(hpKwMatch[1], 10);
      result.powerHp = parseInt(hpKwMatch[2], 10);
    } else {
      result.powerHp = parseInt(hpKwMatch[1], 10);
      result.powerKw = parseInt(hpKwMatch[2], 10);
    }
  } else {
    const psOnly = text.match(/([0-9]{2,4})\s*ps\b/i);
    if (psOnly) result.powerHp = parseInt(psOnly[1], 10);
    const kwOnly = text.match(/([0-9]{2,4})\s*kw\b/i);
    if (kwOnly) result.powerKw = parseInt(kwOnly[1], 10);
  }

  // 5. Kraftstoff
  if (/\bdiesel\b/i.test(text)) result.fuelType = 'Diesel';
  else if (/\belektro|electric\b/i.test(text)) result.fuelType = 'Elektro';
  else if (/\bhybrid|plug-in\b/i.test(text)) result.fuelType = 'Hybrid';
  else if (/\bbenzin|petrol|otto\b/i.test(text)) result.fuelType = 'Benzin';

  // 6. Getriebe
  if (/\bautomatik|tiptronic|steptronic|s-tronic|7g-tronic|9g-tronic|dsg|doppelkupplung\b/i.test(text)) {
    result.transmission = 'Automatik';
  } else if (/\bschaltgetriebe|handschalter|manuell\b/i.test(text)) {
    result.transmission = 'Schaltgetriebe';
  }

  // 7. Hubraum (z. B. "1.998 cm³", "1995 ccm")
  const dispMatch = text.match(/([0-9]{1,2}(?:\.[0-9]{3})|[0-9]{3,4})\s*(?:cm³|ccm)/i);
  if (dispMatch) {
    result.displacement = parseInt(dispMatch[1].replace(/\./g, ''), 10);
  }

  // 8. Marke & Modell aus Titel oder Header ermitteln
  const knownMakes = ['BMW', 'Audi', 'Mercedes-Benz', 'Mercedes', 'Volkswagen', 'VW', 'Porsche', 'Skoda', 'Seat', 'Ford', 'Toyota', 'Hyundai', 'Kia', 'Volvo', 'Mazda', 'Tesla', 'Opel', 'Renault'];
  for (const m of knownMakes) {
    const regex = new RegExp(`\\b${m}\\b`, 'i');
    if (regex.test(text)) {
      result.make = m === 'Mercedes' ? 'Mercedes-Benz' : (m === 'VW' ? 'Volkswagen' : m);
      // Modell nach der Marke suchen
      const modelRegex = new RegExp(`(?:\\b${m}\\b)\\s+([a-zA-Z0-9\\s\\-\\.]+?)(?:\\n|,|\\||–|-|\\d{2}\\/\\d{4}|\\b\\d+\\s*km\\b)`, 'i');
      const mMatch = text.match(modelRegex);
      if (mMatch && mMatch[1]) {
        result.model = mMatch[1].trim().slice(0, 30);
      }
      break;
    }
  }

  // 9. Ausstattung & Features extrahieren
  const featureList = [];
  const featSectionMatch = text.match(/(?:ausstattung|sonderausstattung|highlights|extras|komfort|sicherheit|innenausstattung|multimedia)[\s:]+([\s\S]+?)(?:(?:kontakt|telefon|standort|impressum|hinweis|weitere informationen|händler|finanzierung|verbrauch|$))/i);
  const featSourceText = featSectionMatch ? featSectionMatch[1] : text;

  const linesAndItems = featSourceText.split(/[\n\r,;•|–]+/).map(s => s.trim().replace(/^[-*•✓+]\s*/, '')).filter(s => s.length >= 3 && s.length <= 70);
  const ignoredWords = ['mwst', 'ausweisbar', 'fahrzeug', 'angebot', 'irrtümer', 'zwischenverkauf', 'vorbehalten', 'unfallfrei', 'scheckheftgepflegt', 'nichtraucher', 'hallo', 'händler', 'tüv neu', 'garantie', 'hu/au neu'];

  for (const item of linesAndItems) {
    const lower = item.toLowerCase();
    if (ignoredWords.some(w => lower === w || lower.startsWith('mwst'))) continue;
    if (item.match(/^\d+(\.\d+)?\s*(km|eur|€|ps|kw|cm³)/i)) continue;
    if (item.match(/^(benzin|diesel|elektro|hybrid|automatik|schaltgetriebe)$/i)) continue;
    if (!featureList.includes(item)) {
      featureList.push(item);
    }
  }
  result.features = featureList;

  // Falls Titel nicht gesetzt
  if (!result.title) {
    result.title = `${result.make || 'Fahrzeug'} ${result.model || ''}`.trim();
  }

  return result;
}

/**
 * Versucht, ein Mobile.de-Inserat per URL abzurufen und JSON-LD bzw. Metadaten zu parsen
 */
async function extractFromMobileDe(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('Ungültige URL übergeben');
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      },
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) {
      // Wenn HTTP-Fehler (z. B. 403 Forbidden durch Bot-Schutz von Mobile.de), Fallback vorbereiten
      console.warn(`[MobileDeExtractor] HTTP ${response.status} beim Abruf von ${url}`);
      return {
        success: false,
        blocked: true,
        statusCode: response.status,
        message: 'Der automatisierte Direktabruf wurde von Mobile.de geblockt (Bot-Schutz). Bitte nutze die Schnelleingabe / Inseratstext einfügen.',
        data: standardizeVehicle({ url, platform: 'mobile.de' })
      };
    }

    const html = await response.text();

    // 1. Suche nach JSON-LD Schema.org Metadaten
    let extractedData = {};
    const jsonLdMatches = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi);
    if (jsonLdMatches) {
      for (const tag of jsonLdMatches) {
        try {
          const jsonContent = tag.replace(/<script.*?>|<\/script>/gi, '').trim();
          const parsed = JSON.parse(jsonContent);
          const carObj = Array.isArray(parsed) ? parsed.find(i => i['@type'] === 'Car' || i['@type'] === 'Vehicle' || i['@type'] === 'Product') : (parsed['@type'] === 'Car' || parsed['@type'] === 'Vehicle' || parsed['@type'] === 'Product' ? parsed : null);
          if (carObj) {
            extractedData.title = carObj.name || '';
            extractedData.make = (carObj.brand && (carObj.brand.name || carObj.brand)) || '';
            extractedData.model = carObj.model || '';
            if (carObj.offers) {
              extractedData.price = carObj.offers.price || (carObj.offers[0] && carObj.offers[0].price);
            }
            if (carObj.mileageFromOdometer) {
              extractedData.mileage = carObj.mileageFromOdometer.value || carObj.mileageFromOdometer;
            }
            if (carObj.vehicleModelDate || carObj.dateVehicleFirstRegistered) {
              extractedData.firstRegistration = carObj.dateVehicleFirstRegistered || carObj.vehicleModelDate;
            }
            if (carObj.fuelType) extractedData.fuelType = carObj.fuelType;
            if (carObj.color) extractedData.color = carObj.color;
            if (carObj.image) extractedData.image = Array.isArray(carObj.image) ? carObj.image[0] : (carObj.image.url || carObj.image);
            break;
          }
        } catch (e) {
          // Ignoriere unpassendes JSON
        }
      }
    }

    // 2. OpenGraph Fallback
    const ogTitleMatch = html.match(/<meta property="og:title" content="([^"]+)"/i);
    const ogDescMatch = html.match(/<meta property="og:description" content="([^"]+)"/i);
    const ogImageMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);

    const ogText = `${ogTitleMatch ? ogTitleMatch[1] : ''} ${ogDescMatch ? ogDescMatch[1] : ''}`;
    const textParsed = parseRawAdText(ogText + ' ' + html.slice(0, 15000), url);

    // Zusammenführen
    const merged = {
      ...textParsed,
      ...extractedData,
      title: extractedData.title || (ogTitleMatch ? ogTitleMatch[1] : textParsed.title),
      image: extractedData.image || (ogImageMatch ? ogImageMatch[1] : null),
      url,
      platform: 'mobile.de'
    };

    const standardized = standardizeVehicle(merged);
    return {
      success: true,
      data: standardized
    };
  } catch (err) {
    console.warn(`[MobileDeExtractor] Fehler beim Abruf (${err.message}). Verwende Fallback.`);
    return {
      success: false,
      error: err.message,
      message: 'Mobile.de konnte nicht direkt abgerufen werden. Bitte Daten manuell eintragen oder Inseratstext einfügen.',
      data: standardizeVehicle({ url, platform: 'mobile.de' })
    };
  }
}

module.exports = {
  extractFromMobileDe,
  parseRawAdText
};
