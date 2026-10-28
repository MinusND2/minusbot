const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://bingo-overlay-default-rtdb.europe-west1.firebasedatabase.app"
});

const db = admin.database();

async function run() {
    const jobId = '-Ovm3nSMex8qUii2O-n3';
    console.log(`Resetting job ${jobId} to pending...`);
    await db.ref(`clipper/youtube_queue/${jobId}`).update({
        status: 'pending',
        error: null,
        progressMessage: 'Ready to retry upload...',
        postedAt: null
    });
    console.log("Job reset successfully!");
    process.exit(0);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
