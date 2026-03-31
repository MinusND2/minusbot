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
        updatedAt: Date.now()
    };

    const channel = db.channels[broadcasterId];
    channel.mods[moderatorId] ||= {
        moderatorId,
        moderatorName,
        bans: 0,
        timeouts: 0,
        lastActionAt: null
    };

    const mod = channel.mods[moderatorId];
    mod.moderatorName = moderatorName;
    mod.lastActionAt = new Date().toISOString();

    if (isTimeout) {
        mod.timeouts += 1;
        channel.totals.timeouts += 1;
    } else {
        mod.bans += 1;
        channel.totals.bans += 1;
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
    if (!channelId) {
        return res.json({
            channels: Object.values(db.channels),
            updatedAt: db.updatedAt
        });
    }
    return res.json({
        channel: db.channels[channelId] || null,
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
