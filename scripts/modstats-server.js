const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = Number(process.env.MODSTATS_PORT || 8787);
const EVENTSUB_SECRET = process.env.TWITCH_EVENTSUB_SECRET || "";
const STORE_FILE = path.join(__dirname, "..", "data", "modstats-events.json");

const TRUSTED_EVENT_TYPES = new Set(["channel.ban", "channel.moderate"]);

function ensureStore() {
  const dir = path.dirname(STORE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(
      STORE_FILE,
      JSON.stringify({ events: [], updatedAt: Date.now() }, null, 2),
      "utf8"
    );
  }
}

function readStore() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch (err) {
    return { events: [], updatedAt: Date.now() };
  }
}

function writeStore(next) {
  ensureStore();
  fs.writeFileSync(STORE_FILE, JSON.stringify(next, null, 2), "utf8");
}

function digestSignature(messageId, timestamp, rawBody, secret) {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(messageId + timestamp + rawBody, "utf8");
  return "sha256=" + hmac.digest("hex");
}

function safeDate(value) {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : Date.now();
}

function matchesTimeRange(eventTs, fromTs, toTs) {
  if (fromTs && eventTs < fromTs) return false;
  if (toTs && eventTs > toTs) return false;
  return true;
}

function parseBanLikeEvent(type, event) {
  if (!event) return null;
  const action =
    type === "channel.ban"
      ? event.is_permanent
        ? "ban"
        : "timeout"
      : event.action === "ban"
      ? "ban"
      : event.action === "timeout"
      ? "timeout"
      : null;
  if (!action) return null;

  const moderatorId = event.moderator_user_id || "";
  const broadcasterId = event.broadcaster_user_id || "";
  if (!moderatorId || !broadcasterId) return null;

  return {
    id: crypto.randomUUID(),
    ts: safeDate(event.created_at || Date.now()),
    sourceType: type,
    action,
    moderator: {
      id: moderatorId,
      login: event.moderator_user_login || "",
      name: event.moderator_user_name || event.moderator_user_login || moderatorId
    },
    broadcaster: {
      id: broadcasterId,
      login: event.broadcaster_user_login || "",
      name: event.broadcaster_user_name || event.broadcaster_user_login || broadcasterId
    },
    target: {
      id: event.user_id || "",
      login: event.user_login || "",
      name: event.user_name || event.user_login || event.user_id || ""
    }
  };
}

app.use(
  express.raw({
    type: "application/json",
    limit: "2mb"
  })
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "twitch-modstats", ts: Date.now() });
});

app.get("/api/modstats/summary", (req, res) => {
  const broadcasterId = String(req.query.broadcaster_id || "").trim();
  const fromTs = req.query.from ? safeDate(req.query.from) : 0;
  const toTs = req.query.to ? safeDate(req.query.to) : 0;
  const store = readStore();

  const rows = new Map();
  for (const evt of store.events || []) {
    if (broadcasterId && evt?.broadcaster?.id !== broadcasterId) continue;
    if (!matchesTimeRange(Number(evt.ts) || 0, fromTs, toTs)) continue;

    const key = evt.moderator.id;
    if (!rows.has(key)) {
      rows.set(key, {
        moderatorId: evt.moderator.id,
        moderatorLogin: evt.moderator.login || "",
        moderatorName: evt.moderator.name || evt.moderator.id,
        bans: 0,
        timeouts: 0
      });
    }
    const row = rows.get(key);
    if (evt.action === "ban") row.bans += 1;
    if (evt.action === "timeout") row.timeouts += 1;
  }

  res.json({
    ok: true,
    broadcasterId: broadcasterId || null,
    from: fromTs || null,
    to: toTs || null,
    totalModerators: rows.size,
    moderators: Array.from(rows.values()).sort((a, b) => {
      const av = a.bans + a.timeouts;
      const bv = b.bans + b.timeouts;
      return bv - av;
    })
  });
});

app.get("/api/modstats/events", (req, res) => {
  const broadcasterId = String(req.query.broadcaster_id || "").trim();
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
  const store = readStore();
  const events = (store.events || [])
    .filter((evt) => !broadcasterId || evt?.broadcaster?.id === broadcasterId)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, limit);
  res.json({ ok: true, count: events.length, events });
});

app.post("/webhooks/twitch/eventsub", (req, res) => {
  const messageId = req.get("Twitch-Eventsub-Message-Id") || "";
  const messageTs = req.get("Twitch-Eventsub-Message-Timestamp") || "";
  const messageType = req.get("Twitch-Eventsub-Message-Type") || "";
  const providedSig = req.get("Twitch-Eventsub-Message-Signature") || "";
  const rawBody = req.body ? req.body.toString("utf8") : "";

  if (!rawBody) return res.status(400).send("Missing body");
  if (!EVENTSUB_SECRET) return res.status(500).send("Missing TWITCH_EVENTSUB_SECRET");
  if (!messageId || !messageTs || !providedSig) return res.status(400).send("Missing headers");

  const expectedSig = digestSignature(messageId, messageTs, rawBody, EVENTSUB_SECRET);
  if (expectedSig !== providedSig) return res.status(403).send("Invalid signature");

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (_err) {
    return res.status(400).send("Bad JSON");
  }

  if (messageType === "webhook_callback_verification") {
    return res.status(200).send(payload.challenge || "");
  }
  if (messageType === "revocation") {
    return res.status(200).json({ ok: true, revoked: true });
  }

  const type = payload?.subscription?.type || "";
  if (!TRUSTED_EVENT_TYPES.has(type)) {
    return res.status(200).json({ ok: true, ignored: true, type });
  }

  const normalized = parseBanLikeEvent(type, payload.event);
  if (!normalized) return res.status(200).json({ ok: true, ignored: true, reason: "unsupported_action" });

  const store = readStore();
  store.events = store.events || [];
  store.events.push(normalized);
  if (store.events.length > 30000) {
    store.events = store.events.slice(store.events.length - 30000);
  }
  store.updatedAt = Date.now();
  writeStore(store);

  return res.status(200).json({ ok: true });
});

app.listen(PORT, () => {
  ensureStore();
  console.log(`modstats-server listening on :${PORT}`);
});
