# Twitch Modstats Quickstart

This bot backend can already run without a domain.
You can test it via server IP first, then connect a domain later.

## 1) Start server

On VPS:

```bash
cd /var/www/html
npm install
export TWITCH_EVENTSUB_SECRET="replace_with_long_secret"
npm run modstats:start
```

Health endpoint:

```bash
curl http://127.0.0.1:8787/health
```

## 2) API endpoints

- `GET /health`
- `GET /api/modstats/summary?broadcaster_id=...&from=...&to=...`
- `GET /api/modstats/events?broadcaster_id=...&limit=100`
- `POST /webhooks/twitch/eventsub`

## 3) Public stats page

Open:

- `http://SERVER_IP/public/modstats.html`

Set API base to:

- `http://SERVER_IP:8787`

## 4) Data file

Bot events are saved to:

- `data/modstats-events.json`

## 5) Later with domain

When you have a domain + TLS, use the webhook URL:

- `https://YOUR_DOMAIN/webhooks/twitch/eventsub`

Until then, build and test everything else locally/on IP.

## 6) Chat bot (real Twitch chat commands)

Install dependency:

```bash
cd /var/www/html
npm install
```

Set env vars (example):

```bash
export TWITCH_BOT_USERNAME="minusbot"
export TWITCH_BOT_OAUTH="oauth_xxxxxxxxxxxxxxxxx"
export TWITCH_CHANNELS="streamer1,streamer2"
export MODSTATS_COMMAND_PREFIX="!"
```

Start chat bot:

```bash
npm run modstats:chat
```

Commands in chat:

- `!modstats`
- `!topmods`
- `!modstats streamername`
