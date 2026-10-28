const admin = require('firebase-admin');
const { getDatabase } = require('firebase-admin/database');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://bingo-overlay-default-rtdb.europe-west1.firebasedatabase.app"
});

const db = getDatabase();

db.ref('clipper/youtube_queue').limitToLast(10).once('value').then((snap) => {
    const val = snap.val() || {};
    console.log("=== LATEST 10 YOUTUBE QUEUE JOBS ===");
    for (const [id, job] of Object.entries(val)) {
        console.log(`Job ID: ${id}`);
        console.log(`  Streamer: ${job.streamerName}`);
        console.log(`  Status: ${job.status}`);
        console.log(`  Caption: ${job.caption}`);
        console.log(`  ProgressMsg: ${job.progressMessage}`);
        console.log(`  Error: ${job.error}`);
        console.log(`  PostedAt: ${job.postedAt ? new Date(job.postedAt).toISOString() : 'N/A'}`);
        console.log(`  Timestamp: ${job.timestamp ? new Date(job.timestamp).toISOString() : 'N/A'}`);
        console.log("-----------------------------------------");
    }
    process.exit(0);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
