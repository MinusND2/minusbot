require('dotenv').config();
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const conn = new Client();
const keyPath = path.join(process.env.USERPROFILE || '', '.ssh', 'id_ed25519');
conn.on('ready', () => {
    conn.exec('which convert; which magick; ffmpeg -version | head -n 1; cd /var/www/bot && node -e "try { require(\'sharp\'); console.log(\'sharp ok\'); } catch(e) { console.log(\'no sharp\'); }"', (err, stream) => {
        let out = '';
        stream.on('data', d => out += d);
        stream.stderr.on('data', d => out += d);
        stream.on('close', () => {
            console.log(out);
            conn.end();
        });
    });
}).connect({
    host: process.env.DEPLOY_HOST,
    port: 22,
    username: process.env.DEPLOY_USER,
    privateKey: fs.readFileSync(keyPath)
});
