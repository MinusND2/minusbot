const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://bingo-overlay-default-rtdb.europe-west1.firebasedatabase.app"
});
const db = admin.database();
db.ref('streams/-OxO1wqCWF4WRslKA8RL/data/subathon').once('value').then(snap => {
    console.log("DB VALUES:", JSON.stringify(snap.val(), null, 2));
    process.exit(0);
}).catch(err => {
    console.error("ERR:", err);
    process.exit(1);
});
