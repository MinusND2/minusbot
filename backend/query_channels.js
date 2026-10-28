const admin = require('firebase-admin');
const { getDatabase } = require('firebase-admin/database');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://bingo-overlay-default-rtdb.europe-west1.firebasedatabase.app"
});

const db = getDatabase();

db.ref('clipper/channels').once('value').then((snap) => {
    const val = snap.val() || {};
    console.log("=== CHANNELS CONFIG ===");
    for (const [name, config] of Object.entries(val)) {
        console.log(`Channel: ${name}`);
        console.log(`  YouTube Account: ${config.youtubeAccount}`);
        console.log(`  TikTok Account: ${config.tiktokAccount}`);
        console.log(`  AutoPublish YT: ${config.autoPublishYoutube}`);
        console.log(`  AutoPublish TT: ${config.autoPublish}`);
        console.log(`  Agent Active: ${config.isAgentActive}`);
    }
    process.exit(0);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
