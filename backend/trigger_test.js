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
    const jobId = "-Ov8v-7Asd4fQevF0h_M";
    console.log(`Setze Job ${jobId} zurück auf 'pending'...`);
    await db.ref(`clipper/tiktok_queue/${jobId}`).update({
        status: 'pending',
        progressMessage: 'Wiederholen...',
        error: null
    });
    console.log("Erfolgreich zurückgesetzt!");
    process.exit(0);
}

run();
