const admin = require('firebase-admin');
const sa = require('./serviceAccountKey.json');
admin.initializeApp({
    credential: admin.credential.cert(sa),
    databaseURL: 'https://minusbingo-default-rtdb.europe-west1.firebasedatabase.app'
});
const db = admin.database();

async function check() {
    const [tq, r, c] = await Promise.all([
        db.ref('clipper/tiktok_queue').once('value'),
        db.ref('clipper/renders').once('value'),
        db.ref('clipper/config').once('value')
    ]);
    
    console.log('=== CONFIG ===');
    console.log(JSON.stringify(c.val(), null, 2));
    
    const queue = tq.val() || {};
    console.log('\n=== TIKTOK QUEUE (' + Object.keys(queue).length + ' Jobs) ===');
    Object.entries(queue).forEach(([k, v]) => {
        console.log(`  ${k}: status=${v.status}, streamer=${v.streamerName}`);
    });
    
    const renders = r.val() || {};
    console.log('\n=== RENDERS (' + Object.keys(renders).length + ' Jobs) ===');
    Object.entries(renders).forEach(([k, v]) => {
        console.log(`  ${k}: status=${v.status}, file=${v.filename || 'n/a'}`);
    });
    
    process.exit(0);
}
check();
