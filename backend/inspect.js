const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://bingo-overlay-default-rtdb.europe-west1.firebasedatabase.app"
});

const db = admin.database();

async function run() {
    const snap = await db.ref('streams/-OvCLACxiD2lLEHlZiSx/liveMatch').once('value');
    console.log("Firebase streams/-OvCLACxiD2lLEHlZiSx/liveMatch data:");
    console.log(JSON.stringify(snap.val(), null, 4));
    process.exit(0);
}
run();
