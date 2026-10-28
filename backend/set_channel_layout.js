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
    console.log("Setting layout overrides for channels...");
    
    // Config for eliasn97 (Webcam bottom-right, perfect snap coordinates)
    await db.ref('clipper/channels/eliasn97').update({
        layout: "35",
        camCrop: {
            x: 76,
            y: 68,
            w: 24,
            h: 32
        },
        gameCrop: {
            x: 15,
            y: 0,
            w: 50,
            h: 100
        }
    });
    console.log("✓ eliasn97 updated (bottom-right coordinates).");
    
    // Clear overrides for xrohat so it uses automatic Mediapipe face detection
    await db.ref('clipper/channels/xrohat').update({
        layout: null,
        camCrop: null,
        gameCrop: null
    });
    console.log("✓ xrohat cleared (falling back to auto-detection).");

    // Clear overrides for zarbex so it uses automatic Mediapipe face detection
    await db.ref('clipper/channels/zarbex').update({
        layout: null,
        camCrop: null,
        gameCrop: null
    });
    console.log("✓ zarbex cleared (falling back to auto-detection).");

    console.log("All channels successfully updated in Firebase Realtime Database!");
    process.exit(0);
}

run();
