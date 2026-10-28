/**
 * Datenquellen ("Adapter")
 * ------------------------
 * Jede Quelle ist ein eigener Adapter. Heute ist nur der manuelle Import aktiv.
 * Neue Quellen (z. B. ein lizenzierter Datenanbieter mit offizieller API) bekommen
 * hier einen eigenen Eintrag mit fetchListings() – der Rest der App bleibt gleich.
 *
 * Bewusst NICHT eingebaut: automatisches Auslesen (Scraping) von mobile.de,
 * AutoScout24 usw. – das verbieten deren Nutzungsbedingungen, und deren
 * Händler-Schnittstellen sind nur für den eigenen Fahrzeugbestand.
 */
const store = require('./store');

const SOURCES = [
  {
    id: 'manual',
    name: 'Manueller Import (Text, CSV, Formular)',
    implemented: true,
    note: 'Inserate, die du oder dein Team findet, hier einfügen. Jedes Inserat macht den Marktwert genauer.'
  },
  {
    id: 'mobile_de',
    name: 'mobile.de',
    implemented: false,
    note: 'Nicht automatisch angebunden. Die Händler-AGB von mobile.de verbieten Scraping/Robots, und die Händler-Schnittstelle ist für eigene Inserate. Legaler Weg: Inserate manuell übernehmen oder über einen von mobile.de autorisierten Datendienstleister.'
  },
  {
    id: 'autoscout24',
    name: 'AutoScout24',
    implemented: false,
    note: 'Nicht automatisch angebunden. Die AutoScout24-Händler-API dient zum Übertragen des eigenen Bestands, nicht zur Marktsuche.'
  },
  {
    id: 'kleinanzeigen',
    name: 'Kleinanzeigen',
    implemented: false,
    note: 'Nicht angebunden. Inserate manuell übernehmen.'
  },
  {
    id: 'licensed',
    name: 'Lizenzierte Marktdaten (z. B. DAT, Schwacke)',
    implemented: false,
    note: 'Nicht angebunden. Echte Händler-Einkaufs-/Verkaufswerte gibt es nur kostenpflichtig von solchen Anbietern. Adapter kann hier ergänzt werden, sobald ein Vertrag + API-Zugang vorliegt.'
  }
];

function sourceStatus() {
  const listings = store.all();
  const imports = store.imports();
  return SOURCES.map(s => {
    if (s.id !== 'manual') return { ...s, status: 'nicht integriert', listings: 0, lastSuccess: null, errors: null };
    const last = imports[0] || null;
    return {
      ...s,
      status: 'aktiv',
      listings: listings.length,
      lastSuccess: last ? last.at : null,
      errors: last && last.rejected ? `${last.rejected} Inserat(e) beim letzten Import abgelehnt` : null
    };
  });
}

module.exports = { SOURCES, sourceStatus };
