# Bingo Overlay auf STRATO Webhosting (ohne Node)

Dieses Projekt laeuft als statische Website mit Firebase Realtime Database + Firebase Auth.

## 1) Firebase Projekt anlegen

1. [Firebase Console](https://console.firebase.google.com/) -> Projekt erstellen
2. "Realtime Database" aktivieren
3. Region waehlen (z. B. `europe-west1`)
4. Unter "Authentication" -> "Anmeldemethode" -> `E-Mail/Passwort` aktivieren
5. Datenbank-Regeln setzen:

```json
{
  "rules": {
    "streams": {
      ".indexOn": ["meta/ownerUid"],
      ".read": "auth != null",
      "$streamId": {
        ".write": "auth != null && (!data.exists() ? newData.child('meta/ownerUid').val() === auth.uid : data.child('meta/ownerUid').val() === auth.uid)",
        "meta": {
          ".read": "auth != null && data.child('ownerUid').val() === auth.uid",
          ".write": "auth != null && (!data.exists() || data.child('ownerUid').val() === auth.uid)"
        },
        "data": {
          ".read": true,
          ".write": "auth != null && root.child('streams/' + $streamId + '/meta/ownerUid').val() === auth.uid"
        }
      }
    }
  }
}
```

## 2) Web-App Config holen

1. Firebase -> Projekteinstellungen -> "Ihre Apps" -> Web-App erstellen
2. Config-Daten kopieren (`apiKey`, `authDomain`, `databaseURL`, ...)
3. Datei `public/app-config.js` ausfuellen

## 3) Stream-ID setzen

In `public/app-config.js` einen Fallback setzen, z. B.:

```js
streamId: "default-stream"
```

Im Betrieb nutzt du pro Overlay einen Link mit Query-Parameter:

`/public/index.html?stream=<STREAM_ID>`

## 4) Auf STRATO hochladen

Nur statische Dateien hochladen:

- `public/`
- `protected/`
- `index.html`

(`server.js` wird nicht mehr benoetigt)

## 5) URLs

- Zentrale Verwaltung (Login + Overlay erstellen): `/protected/panel.html`
- Root-Weiterleitung: `/` -> `/protected/panel.html`

- Overlay Bingo: `/public/index.html?stream=<STREAM_ID>`
- Overlay Scoreboard: `/public/scoreboard.html?stream=<STREAM_ID>`
- Admin Bingo: `/protected/admin.html?stream=<STREAM_ID>`
- Admin Scoreboard: `/protected/scoreboard-admin.html?stream=<STREAM_ID>`

## Hinweis zu Sicherheit

Mit den obigen Regeln kann nur der eingeloggte Besitzer schreiben.
Streamer bekommen nur die Overlay-Links (read-only).
