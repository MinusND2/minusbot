const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
if (!fs.existsSync(serviceAccountPath)) {
    console.error("Firebase Key nicht gefunden!");
    process.exit(1);
}

const serviceAccount = require(serviceAccountPath);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://bingo-overlay-default-rtdb.europe-west1.firebasedatabase.app"
});

const db = admin.database();

async function run() {
    console.log("=== RESETTING TIKTOK QUEUE ===");
    const ttSnap = await db.ref('clipper/tiktok_queue').once('value');
    const ttQueue = ttSnap.val() || {};
    let ttCount = 0;
    for (const [id, job] of Object.entries(ttQueue)) {
        if (job.status !== 'done') {
            console.log(`Setze TikTok Job ${id} (${job.streamerName}, Status: ${job.status}) -> pending`);
            await db.ref(`clipper/tiktok_queue/${id}`).update({
                status: 'pending',
                progressMessage: 'Bereit zum erneuten Hochladen...',
                error: null
            });
            ttCount++;
        }
    }
    console.log(`TikTok: ${ttCount} Jobs zurückgesetzt.`);

    console.log("\n=== RESETTING YOUTUBE QUEUE ===");
    const ytSnap = await db.ref('clipper/youtube_queue').once('value');
    const ytQueue = ytSnap.val() || {};
    let ytCount = 0;
    for (const [id, job] of Object.entries(ytQueue)) {
        if (job.status !== 'done') {
            console.log(`Setze YouTube Job ${id} (${job.streamerName}, Status: ${job.status}) -> pending`);
            await db.ref(`clipper/youtube_queue/${id}`).update({
                status: 'pending',
                progressMessage: 'Bereit zum erneuten Hochladen...',
                error: null
            });
            ytCount++;
        }
    }
    console.log(`YouTube: ${ytCount} Jobs zurückgesetzt.`);
    
    process.exit(0);
}

run();
