# BMW 4er Deal-Finder

Findet BMW-4er-Angebote, die deutlich **unter Marktwert** liegen – mit Gewinnrechnung für den Weiterverkauf.

- Seite: `/public/car-deals.html` (auf dem Bot-Server auch `/deals`)
- API: `/api/car-analyzer/deals/...`
- Daten: `backend/car_analyzer/data/dealfinder.json` (wird automatisch angelegt, **nicht** per Deploy überschrieben)

## Was es kann (Phase 1)

| Funktion | Status |
|---|---|
| Inserate importieren: kopierter Text, CSV, Formular | ✅ |
| BMW 4er Generationen erkennen (F32/F33/F36, G22/G23/G26, M4 F8x/G8x), Varianten, Motorcode | ✅ |
| Marktwert aus Vergleichsinseraten (gewichteter Median, Ausreißer, Spanne, Konfidenz) | ✅ |
| Wertverlust pro Jahr / pro km wird ab 10 Vergleichsautos aus den eigenen Daten gelernt | ✅ |
| Deal-Score 0–100 + separate Risikobewertung (Unfall, Betrugsmerkmale, Motor-Schwachstellen …) | ✅ |
| Gewinnrechnung (Kosten, Marge, max. Einkaufspreis) | ✅ |
| Preisverlauf (gleiches Inserat erneut einfügen) und Dubletten-Hinweis | ✅ |
| Status: aktiv / beobachten / gekauft / weg / ignoriert, Notizen, Korrekturen | ✅ |
| Benutzerkonten & Suchprofile | ❌ nicht implementiert (Phase 2) |
| Automatische Benachrichtigung bei neuem Top-Deal | ❌ nicht implementiert (Phase 2) |
| Automatischer Abruf von mobile.de / AutoScout24 | ❌ bewusst nicht – deren AGB verbieten Scraping; Händler-APIs sind nur für den eigenen Bestand |
| Echte Verkaufspreise (DAT/Schwacke) | ❌ braucht kostenpflichtige Lizenz; Adapter-Platz in `sources.js` |

## Wichtige Ehrlichkeit

- Der Marktwert basiert auf **Angebotspreisen** der Inserate, die ihr erfasst – nicht auf echten Verkaufspreisen und nicht auf dem gesamten Markt.
- Ohne Vergleichsautos wird **kein** Marktwert angezeigt. Ab ca. 5 Inseraten derselben Variante wird es brauchbar, ab 10+ gut.

## Zugangsschutz (empfohlen)

In `backend/.env` eine Zeile ergänzen (eigenes langes Passwort ausdenken):

```
CARDEAL_KEY=hier-ein-langes-geheimes-passwort
```

Danach Backend neu deployen und auf der Seite unter „Kosten & Zugang“ denselben Schlüssel eintragen.
Ohne Schlüssel kann jeder, der die Seite kennt, Inserate hinzufügen/löschen.

## Testen (lokal, in `D:\bingo`)

```
node backend/car_analyzer/test_dealfinder.js
```

## Online stellen

```
node deploy_backend.js     (Backend + Deal-Finder-Code, startet den Server neu)
node deploy.js             (Webseite inkl. car-deals.html)
```

## Dateien

```
dealfinder/
  catalog.js       BMW-4er-Stammdaten (Generationen, Varianten, Motoren)
  parseListing.js  liest Inserat-Text / CSV
  store.js         Speicher (JSON-Datei), Preisverlauf
  valuation.js     Marktwert aus Vergleichsautos, Dubletten
  scoring.js       Deal-Score + Risiko
  sources.js       Datenquellen-Adapter + Status
  router.js        API-Routen
```
