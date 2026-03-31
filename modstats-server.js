const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8787);
const EVENTSUB_SECRET = process.env.TWITCH_EVENTSUB_SECRET || "";
const ALLOWED_ORIGIN = process.env.PUBLIC_SITE_ORIGIN || "*";
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "modstats.json");

const app = express();
const seenMessageIds = new Map();

function toDayKey(date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function normalizeDayInput(value) {
    const raw = (value || "").toString().trim();
    if (!raw) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return null;
    return toDayKey(parsed);
}

function isDayInRange(day, fromDay, toDay) {
    if (fromDay && day < fromDay) return false;
    if (toDay && day > toDay) return false;
    return true;
}

function filterChannelByDate(channel, fromDay, toDay) {
    const filtered = {
        broadcasterId: channel.broadcasterId,
        broadcasterName: channel.broadcasterName,
        mods: {},
        totals: { bans: 0, timeouts: 0 },
        updatedAt: channel.updatedAt
    };

    const mods = Object.values(channel.mods || {});
    for (const mod of mods) {
        const result = {
            moderatorId: mod.moderatorId,
            moderatorName: mod.moderatorName,
            bans: 0,
            timeouts: 0,
            lastActionAt: mod.lastActionAt || null
        };
        const byDay = mod.byDay || {};
        for (const [day, values] of Object.entries(byDay)) {
            if (!isDayInRange(day, fromDay, toDay)) continue;
            result.timeouts += Number(values.timeouts || 0);
            result.bans += Number(values.bans || 0);
        }

        if (result.timeouts === 0 && result.bans === 0) continue;
        filtered.mods[mod.moderatorId] = result;
        filtered.totals.timeouts += result.timeouts;
        filtered.totals.bans += result.bans;
    }

    return filtered;
}

function ensureDataFile() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) {
        fs.writeFileSync(
            DATA_FILE,
            JSON.stringify({ channels: {}, updatedAt: Date.now() }, null, 2),
            "utf8"
        );
    }
}

function loadDb() {
    ensureDataFile();
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw);
}

function saveDb(data) {
    ensureDataFile();
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

function setCors(res) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function verifyEventSubSignature(req) {
    if (!EVENTSUB_SECRET) return false;
    const msgId = req.get("Twitch-Eventsub-Message-Id") || "";
    const timestamp = req.get("Twitch-Eventsub-Message-Timestamp") || "";
    const provided = req.get("Twitch-Eventsub-Message-Signature") || "";
    const body = req.body || Buffer.from("");
    const payload = msgId + timestamp + body.toString("utf8");
    const expected =
        "sha256=" +
        crypto.createHmac("sha256", EVENTSUB_SECRET).update(payload).digest("hex");
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

function isDuplicateMessage(messageId) {
    const now = Date.now();
    for (const [id, ts] of seenMessageIds.entries()) {
        if (now - ts > 10 * 60 * 1000) {
            seenMessageIds.delete(id);
        }
    }
    if (seenMessageIds.has(messageId)) return true;
    seenMessageIds.set(messageId, now);
    return false;
}

function incrementModerationCounter(event) {
    const broadcasterId = event.broadcaster_user_id;
    const broadcasterName = event.broadcaster_user_name || event.broadcaster_user_login || broadcasterId;
    const moderatorId = event.moderator_user_id || "unknown";
    const moderatorName = event.moderator_user_name || event.moderator_user_login || "Unknown Mod";
    const isTimeout = !!event.ends_at;

    const db = loadDb();
    db.channels[broadcasterId] ||= {
        broadcasterId,
        broadcasterName,
        mods: {},
        totals: { bans: 0, timeouts: 0 },
        byDay: {},
        updatedAt: Date.now()
    };

    const channel = db.channels[broadcasterId];
    channel.mods[moderatorId] ||= {
        moderatorId,
        moderatorName,
        bans: 0,
        timeouts: 0,
        byDay: {},
        lastActionAt: null
    };

    const mod = channel.mods[moderatorId];
    mod.moderatorName = moderatorName;
    mod.lastActionAt = new Date().toISOString();
    const day = toDayKey(new Date());
    mod.byDay ||= {};
    mod.byDay[day] ||= { bans: 0, timeouts: 0 };
    channel.byDay ||= {};
    channel.byDay[day] ||= { bans: 0, timeouts: 0 };

    if (isTimeout) {
        mod.timeouts += 1;
        mod.byDay[day].timeouts += 1;
        channel.totals.timeouts += 1;
        channel.byDay[day].timeouts += 1;
    } else {
        mod.bans += 1;
        mod.byDay[day].bans += 1;
        channel.totals.bans += 1;
        channel.byDay[day].bans += 1;
    }

    channel.updatedAt = Date.now();
    db.updatedAt = Date.now();
    saveDb(db);
}

app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "twitch-modstats", ts: Date.now() });
});

app.get("/api/public/modstats", (req, res) => {
    setCors(res);
    const db = loadDb();
    const channelId = (req.query.channelId || "").toString().trim();
    const fromDay = normalizeDayInput(req.query.from);
    const toDay = normalizeDayInput(req.query.to);
    const hasRange = !!(fromDay || toDay);
    if (!channelId) {
        const channels = Object.values(db.channels || {})
            .map((channel) => (hasRange ? filterChannelByDate(channel, fromDay, toDay) : channel))
            .filter((channel) => {
                if (!hasRange) return true;
                return (channel.totals?.bans || 0) + (channel.totals?.timeouts || 0) > 0;
            });
        return res.json({
            channels,
            updatedAt: db.updatedAt
        });
    }
    const channel = db.channels[channelId] || null;
    return res.json({
        channel: !channel ? null : (hasRange ? filterChannelByDate(channel, fromDay, toDay) : channel),
        updatedAt: db.updatedAt
    });
});

app.options("/api/public/modstats", (_req, res) => {
    setCors(res);
    res.status(204).send();
});

app.post(
    "/twitch/eventsub",
    express.raw({ type: "application/json" }),
    (req, res) => {
        const msgType = req.get("Twitch-Eventsub-Message-Type");
        const msgId = req.get("Twitch-Eventsub-Message-Id") || "";

        if (!verifyEventSubSignature(req)) {
            return res.status(403).send("invalid signature");
        }
        if (isDuplicateMessage(msgId)) {
            return res.status(200).send("ok");
        }

        const body = JSON.parse((req.body || Buffer.from("{}")).toString("utf8"));

        if (msgType === "webhook_callback_verification") {
            return res.status(200).send(body.challenge);
        }

        if (msgType === "notification") {
            if (body.subscription?.type === "channel.ban" && body.event) {
                incrementModerationCounter(body.event);
            }
            return res.status(204).send();
        }

        return res.status(204).send();
    }
);

ensureDataFile();
app.listen(PORT, () => {
    console.log(`Modstats server listening on ${PORT}`);
});
