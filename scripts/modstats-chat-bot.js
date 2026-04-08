const fs = require("fs");
const path = require("path");
const tmi = require("tmi.js");

const STORE_FILE = path.join(__dirname, "..", "data", "modstats-events.json");
const TWITCH_BOT_USERNAME = (process.env.TWITCH_BOT_USERNAME || "").trim().toLowerCase();
const TWITCH_BOT_OAUTH_RAW = (process.env.TWITCH_BOT_OAUTH || "").trim();
const TWITCH_CHANNELS = (process.env.TWITCH_CHANNELS || "")
  .split(",")
  .map((v) => v.trim().toLowerCase())
  .filter(Boolean);
const COMMAND_PREFIX = (process.env.MODSTATS_COMMAND_PREFIX || "!").trim() || "!";

function normalizeOauthToken(input) {
  const token = String(input || "").trim();
  if (!token) return "";
  if (token.startsWith("oauth:")) return token;
  if (token.startsWith("oauth_")) return "oauth:" + token.slice("oauth_".length);
  return "oauth:" + token;
}

const TWITCH_BOT_OAUTH = normalizeOauthToken(TWITCH_BOT_OAUTH_RAW);

if (!TWITCH_BOT_USERNAME || !TWITCH_BOT_OAUTH || TWITCH_CHANNELS.length === 0) {
  console.error("Missing env vars: TWITCH_BOT_USERNAME, TWITCH_BOT_OAUTH, TWITCH_CHANNELS");
  process.exit(1);
}

function readStore() {
  try {
    const raw = fs.readFileSync(STORE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.events) ? parsed.events : [];
  } catch (_err) {
    return [];
  }
}

function summarizeByModerator(events, broadcasterLogin) {
  const rows = new Map();
  for (const evt of events) {
    if (!evt || !evt.moderator || !evt.broadcaster) continue;
    if (broadcasterLogin) {
      const bLogin = String(evt.broadcaster.login || "").toLowerCase();
      if (bLogin !== broadcasterLogin.toLowerCase()) continue;
    }
    const key = String(evt.moderator.id || evt.moderator.login || evt.moderator.name || "");
    if (!key) continue;
    if (!rows.has(key)) {
      rows.set(key, {
        name: evt.moderator.name || evt.moderator.login || evt.moderator.id,
        bans: 0,
        timeouts: 0
      });
    }
    const row = rows.get(key);
    if (evt.action === "ban") row.bans += 1;
    if (evt.action === "timeout") row.timeouts += 1;
  }
  return Array.from(rows.values()).sort((a, b) => {
    const at = a.bans + a.timeouts;
    const bt = b.bans + b.timeouts;
    return bt - at;
  });
}

function shortSummaryText(rows, topN = 3) {
  if (!rows.length) return "Keine Modstats-Daten vorhanden.";
  const top = rows.slice(0, topN);
  return top
    .map((r) => {
      const total = r.bans + r.timeouts;
      return `${r.name}: ${total} (${r.timeouts} TO, ${r.bans} Ban)`;
    })
    .join(" | ");
}

const client = new tmi.Client({
  identity: {
    username: TWITCH_BOT_USERNAME,
    password: TWITCH_BOT_OAUTH
  },
  channels: TWITCH_CHANNELS
});

client.on("message", async (channel, tags, message, self) => {
  if (self) return;
  if (!message || !message.startsWith(COMMAND_PREFIX)) return;

  const text = message.trim();
  const [cmdRaw, ...rest] = text.slice(COMMAND_PREFIX.length).split(/\s+/);
  const cmd = String(cmdRaw || "").toLowerCase();

  if (cmd !== "modstats" && cmd !== "topmods") return;

  const requestedChannel = String(rest[0] || "").replace(/^#/, "").toLowerCase();
  const activeChannel = String(channel || "").replace(/^#/, "").toLowerCase();
  const targetChannel = requestedChannel || activeChannel;

  const allEvents = readStore();
  const rows = summarizeByModerator(allEvents, targetChannel);
  const summary = shortSummaryText(rows, 3);

  try {
    await client.say(channel, `@${tags.username} Top Mods (${targetChannel}): ${summary}`);
  } catch (err) {
    console.error("send message failed:", err.message || err);
  }
});

client.on("connected", (addr, port) => {
  console.log(`modstats-chat-bot connected to ${addr}:${port}`);
  console.log(`channels: ${TWITCH_CHANNELS.join(", ")}`);
});

client.connect().catch((err) => {
  console.error("connect failed:", err.message || err);
  process.exit(1);
});
