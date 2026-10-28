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
    const [tqSnap, rSnap, cSnap] = await Promise.all([
        db.ref('clipper/tiktok_queue').once('value'),
        db.ref('clipper/renders').once('value'),
        db.ref('clipper/config').once('value')
    ]);
    
    console.log('=== CONFIG ===');
    console.log(JSON.stringify(cSnap.val(), null, 2));
    
    const queue = tqSnap.val() || {};
    console.log('\n=== TIKTOK QUEUE (' + Object.keys(queue).length + ' jobs) ===');
    for (const [k, v] of Object.entries(queue)) {
        console.log('  ' + k + ': status=' + v.status + ' streamer=' + v.streamerName);
    }
    
    const renders = rSnap.val() || {};
    console.log('\n=== RENDERS (' + Object.keys(renders).length + ' jobs) ===');
    for (const [k, v] of Object.entries(renders)) {
        console.log('  ' + k + ': status=' + v.status + ' file=' + (v.filename || 'n/a'));
    }
    
    const chSnap = await db.ref('clipper/channels').once('value');
    const channels = chSnap.val() || {};
    console.log('\n=== CHANNELS (' + Object.keys(channels).length + ') ===');
    for (const [k, v] of Object.entries(channels)) {
        console.log('  ' + k + ': isActive=' + v.isActive + ' isAgentActive=' + v.isAgentActive + ' status=' + (v.status || 'n/a'));
    }
    
    process.exit(0);
}
run();
