# Twitch Modstats Setup (Timeouts + Bans pro Mod)

Dieses Setup zaehlt pro Mod nur:

- `timeouts`
- `bans`

Keine Ziel-User, keine Gruende, keine Dauer.

## 1) Bot-Service starten

```bash
npm run modstats:start
```

Env vars:

- `PORT` (z. B. `8787`)
- `TWITCH_EVENTSUB_SECRET` (lange Zufallszeichenfolge)
- `PUBLIC_SITE_ORIGIN` (optional, z. B. `https://minusnd.com`)

EventSub Endpoint:

- `POST https://<dein-bot-host>/twitch/eventsub`

## 2) EventSub Subscriptions anlegen

Du brauchst:

- `TWITCH_CLIENT_ID`
- `TWITCH_USER_ACCESS_TOKEN` (dein OAuth-Token als Mod-Account)
- `TWITCH_EVENTSUB_CALLBACK_URL` (z. B. `https://bot.example.com/twitch/eventsub`)
- `TWITCH_EVENTSUB_SECRET` (muss gleich sein wie im Bot)
- `TWITCH_BROADCASTER_IDS` (CSV, z. B. `12345,67890`)

Dann:

```bash
npm run modstats:subscribe
```

## 3) Oeffentliche Seite

Datei:

- `public/mod-stats.html`

Aufrufbeispiel:

```text
https://minusnd.com/public/mod-stats.html?api=https://BOT-URL&channelId=TWITCH_CHANNEL_ID
```

## 4) Hinweise

- Channel muss in `TWITCH_BROADCASTER_IDS` eingetragen sein.
- Dein Account/Bot sollte in diesen Channels Mod sein.
- Fuer jede neue Streamer-ID einmal `modstats:subscribe` erneut ausfuehren.
