const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://bingo-overlay-default-rtdb.europe-west1.firebasedatabase.app"
});

const db = admin.database();

db.ref('clipper/youtube_queue/-Ovm3nSMex8qUii2O-n3').once('value').then((snap) => {
    console.log("Job details:", JSON.stringify(snap.val(), null, 4));
    process.exit(0);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
