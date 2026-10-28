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
    console.log("Analyzing past renders...");
    const rendersSnap = await db.ref('clipper/renders').once('value');
    const renders = rendersSnap.val() || {};
    
    const streamerCams = {};

    for (const [id, job] of Object.entries(renders)) {
        if (job.status === 'done' && job.layout && job.layout !== 'blur-bg' && job.layout !== 'blur-bg-logo') {
            const streamer = job.streamerName || 'unknown';
            if (!streamerCams[streamer]) {
                streamerCams[streamer] = [];
            }
            streamerCams[streamer].push({
                clip: job.filename,
                layout: job.layout,
                cam: job.camCrop,
                game: job.gameCrop
            });
        }
    }
    
    console.log("\n=== DETECTED CAMERAS BY STREAMER ===");
    console.log(JSON.stringify(streamerCams, null, 2));
    
    process.exit(0);
}

run();
