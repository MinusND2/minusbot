const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://bingo-overlay-default-rtdb.europe-west1.firebasedatabase.app"
});

const db = admin.database();

async function check() {
    const [ytSnap, ttSnap] = await Promise.all([
        db.ref('clipper/youtube_queue').limitToLast(20).once('value'),
        db.ref('clipper/tiktok_queue').limitToLast(20).once('value')
    ]);

    const yt = ytSnap.val() || {};
    const tt = ttSnap.val() || {};

    console.log("=== LATEST YOUTUBE QUEUE JOBS ===");
    for (const [id, job] of Object.entries(yt)) {
        console.log(`Job ID: ${id} | Streamer: ${job.streamerName} | Status: ${job.status}`);
        console.log(`  Progress: ${job.progressMessage}`);
        if (job.error) console.log(`  Error: ${job.error}`);
    }

    console.log("\n=== LATEST TIKTOK QUEUE JOBS ===");
    for (const [id, job] of Object.entries(tt)) {
        console.log(`Job ID: ${id} | Streamer: ${job.streamerName} | Status: ${job.status}`);
        console.log(`  Progress: ${job.progressMessage}`);
        if (job.error) console.log(`  Error: ${job.error}`);
    }
    process.exit(0);
}

check().catch(err => {
    console.error(err);
    process.exit(1);
});
