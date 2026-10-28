require('dotenv').config();
const SftpClient = require('ssh2-sftp-client');
const { Client } = require('ssh2');
const path = require('path');
const fs = require('fs');

async function deployWatchtime() {
    const sftp = new SftpClient();
    const keyPath = path.join(process.env.USERPROFILE || '', '.ssh', 'id_ed25519');
    const config = {
        host: process.env.DEPLOY_HOST || '87.106.195.67',
        port: 22,
        username: process.env.DEPLOY_USER || 'root'
    };

    if (fs.existsSync(keyPath)) {
        console.log(`Using SSH private key: ${keyPath}`);
        config.privateKey = fs.readFileSync(keyPath);
    } else {
        console.log('SSH key not found, using password fallback.');
        config.password = process.env.DEPLOY_PASS;
    }

    const remoteBase = '/var/www/watchtime';
    console.log(`[Watchtime] Verbinde zu ${config.host}...`);

    try {
        await sftp.connect(config);
        console.log('[Watchtime] SFTP Verbunden!');

        // Ensure directories exist
        const remotePublicDir = path.posix.join(remoteBase, 'public');
        const existsBase = await sftp.exists(remoteBase);
        if (!existsBase) {
            await sftp.mkdir(remoteBase, true);
        }
        const existsPublic = await sftp.exists(remotePublicDir);
        if (!existsPublic) {
            await sftp.mkdir(remotePublicDir, true);
        }

        const filesToUpload = [
            { local: 'minus-watchtime/package.json', remote: 'package.json' },
            { local: 'minus-watchtime/server.js', remote: 'server.js' },
            { local: 'minus-watchtime/public/index.html', remote: 'public/index.html' },
            { local: 'minus-watchtime/public/style.css', remote: 'public/style.css' },
            { local: 'minus-watchtime/public/tiktok.html', remote: 'public/tiktok.html' }
        ];

        for (const file of filesToUpload) {
            const localPath = path.join(__dirname, file.local);
            const remotePath = path.posix.join(remoteBase, file.remote);
            if (fs.existsSync(localPath)) {
                console.log(`[Watchtime] Lade hoch: ${file.local} -> ${remotePath}`);
                await sftp.put(localPath, remotePath);
            }
        }
        await sftp.end();
        console.log('[Watchtime] SFTP Übertragung beendet!');

        // Connect per SSH to restart/start PM2
        console.log('[Watchtime] Verbinde per SSH für Service-Neustart...');
        const conn = new Client();
        await new Promise((resolve, reject) => {
            conn.on('ready', () => {
                console.log('[Watchtime] SSH Verbunden!');
                // Try restarting, or start if stopped/stopped
                conn.exec('pm2 restart MinusWatchtime || pm2 start /var/www/watchtime/server.js --name MinusWatchtime', (err, stream) => {
                    if (err) return reject(err);
                    stream.on('close', (code, signal) => {
                        console.log(`[Watchtime] PM2 Action abgeschlossen (Code: ${code})`);
                        conn.end();
                        resolve();
                    }).on('data', (data) => {
                        console.log('STDOUT: ' + data.toString().trim());
                    }).stderr.on('data', (data) => {
                        console.log('STDERR: ' + data.toString().trim());
                    });
                });
            }).on('error', reject).connect(config);
        });

        console.log('\n=======================================');
        console.log('WATCHTIME FARMER DEPLOYMENT ERFOLGREICH!');
        console.log('=======================================');

    } catch (err) {
        console.error('[Watchtime] Fehler beim Deployment:', err.message);
    }
}

deployWatchtime();
