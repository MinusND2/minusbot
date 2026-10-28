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

const clipId = 'LongDeliciousButterSuperVinlin-5UwLfBElrWG-xDBW';

console.log(`Deleting processed clip entry ${clipId} from Firebase...`);

db.ref(`clipper/processed_clips/${clipId}`).remove()
    .then(() => {
        console.log("SUCCESS! Clip has been deleted. Ready to be reprocessed by the agent.");
        process.exit(0);
    })
    .catch((err) => {
        console.error("FAILED to delete clip:", err.message);
        process.exit(1);
    });
