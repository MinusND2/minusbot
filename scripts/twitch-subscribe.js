const required = [
    "TWITCH_CLIENT_ID",
    "TWITCH_USER_ACCESS_TOKEN",
    "TWITCH_EVENTSUB_CALLBACK_URL",
    "TWITCH_EVENTSUB_SECRET",
    "TWITCH_BROADCASTER_IDS"
];

for (const key of required) {
    if (!process.env[key]) {
        console.error(`Missing env: ${key}`);
        process.exit(1);
    }
}

const clientId = process.env.TWITCH_CLIENT_ID;
const userToken = process.env.TWITCH_USER_ACCESS_TOKEN;
const callback = process.env.TWITCH_EVENTSUB_CALLBACK_URL;
const secret = process.env.TWITCH_EVENTSUB_SECRET;
const broadcasterIds = process.env.TWITCH_BROADCASTER_IDS.split(",").map((s) => s.trim()).filter(Boolean);

async function createSubscription(broadcasterId) {
    const payload = {
        type: "channel.ban",
        version: "1",
        condition: {
            broadcaster_user_id: broadcasterId
        },
        transport: {
            method: "webhook",
            callback,
            secret
        }
    };

    const response = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
        method: "POST",
        headers: {
            "Client-Id": clientId,
            Authorization: `Bearer ${userToken}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
    });

    const body = await response.text();
    if (!response.ok) {
        throw new Error(`Subscription failed for ${broadcasterId}: ${response.status} ${body}`);
    }
    console.log(`Subscribed channel.ban for broadcaster ${broadcasterId}`);
}

async function main() {
    for (const id of broadcasterIds) {
        await createSubscription(id);
    }
    console.log("All subscriptions created.");
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
