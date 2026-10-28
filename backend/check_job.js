const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://bingo-overlay-default-rtdb.europe-west1.firebasedatabase.app"
});

const db = admin.database();

async function run() {
    console.log("Resetting job -OvlpJF-wN4h_ZN1ptXQ to pending...");
    await db.ref('clipper/youtube_queue/-OvlpJF-wN4h_ZN1ptXQ').update({
        status: 'pending',
        caption: 'Test mit Hashtags',
        progressMessage: 'Bereit zum Testen...',
        error: null,
        postedAt: null
    });
    console.log("Done resetting!");
    process.exit(0);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
