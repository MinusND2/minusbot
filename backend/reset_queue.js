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
    console.log("Lese TikTok Queue aus...");
    const snap = await db.ref('clipper/tiktok_queue').once('value');
    const queue = snap.val() || {};
    
    let resetCount = 0;
    for (const [id, job] of Object.entries(queue)) {
        if (job.status !== 'done') {
            console.log(`Setze Job ${id} (${job.streamerName}, Status: ${job.status}) zurück auf 'pending'...`);
            await db.ref(`clipper/tiktok_queue/${id}`).update({
                status: 'pending',
                progressMessage: 'Bereit zum erneuten Hochladen...',
                error: null
            });
            resetCount++;
        }
    }
    
    console.log(`Erfolgreich ${resetCount} Jobs zurückgesetzt.`);
    process.exit(0);
}

run();
