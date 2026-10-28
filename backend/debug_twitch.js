const admin = require('firebase-admin');
require('dotenv').config({path: './.env'});
admin.initializeApp({
    credential: admin.credential.cert(require('./serviceAccountKey.json')),
    databaseURL: 'https://bingo-overlay-default-rtdb.europe-west1.firebasedatabase.app'
});
async function run() {
    const s = await admin.database().ref('bot_instances/-OuPVT2VC6yKttf2TmVh/twitch_tokens/userId').once('value');
    const userId = s.val();
    const master = await admin.database().ref('system/master_bot/accessToken').once('value');
    const res = await fetch('https://api.twitch.tv/helix/users?id=' + userId, {
        headers: {
            'Client-ID': process.env.TWITCH_CLIENT_ID,
            'Authorization': 'Bearer ' + master.val()
        }
    });
    const data = await res.json();
    console.log('Bot Twitch Account is:', data.data[0].login, 'ID:', userId);
    process.exit(0);
}
run();
