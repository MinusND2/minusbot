require('dotenv').config({ path: 'd:/bingo/.env' });
const { Client } = require('ssh2');
const path = require('path');
const fs = require('fs');

const keyPath = path.join(process.env.USERPROFILE || '', '.ssh', 'id_ed25519');
const config = {
    host: process.env.DEPLOY_HOST,
    port: 22,
    username: process.env.DEPLOY_USER
};

if (fs.existsSync(keyPath)) {
    config.privateKey = fs.readFileSync(keyPath);
} else {
    config.password = process.env.DEPLOY_PASS;
}

console.log(`Connecting to ${config.host} via SSH...`);
const conn = new Client();
conn.on('ready', () => {
    console.log('SSH Connected! Fetching PM2 logs...');
    // We run the command and close the stream after receiving data
    conn.exec('pm2 logs SpotifyBot --raw --lines 100', (err, stream) => {
        if (err) {
            console.error(err);
            conn.end();
            return;
        }
        let output = '';
        stream.on('close', (code, signal) => {
            console.log(output);
            console.log(`PM2 log fetch closed with code: ${code}`);
            conn.end();
        }).on('data', (data) => {
            output += data.toString();
            // If we have collected enough data, we can end it
            if (output.split('\n').length > 100) {
                conn.end();
            }
        }).stderr.on('data', (data) => {
            console.error('STDERR: ' + data.toString());
        });
    });
}).on('error', (err) => {
    console.error('Connection error:', err);
}).connect(config);
