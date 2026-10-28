const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://bingo-overlay-default-rtdb.europe-west1.firebasedatabase.app"
});

const db = admin.database();

db.ref('clipper/channels').once('value').then((snap) => {
    console.log("All channels config:", JSON.stringify(snap.val(), null, 4));
    process.exit(0);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
