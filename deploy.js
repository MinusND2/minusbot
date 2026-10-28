require('dotenv').config();
const SftpClient = require('ssh2-sftp-client');
const path = require('path');
const fs = require('fs');

async function deploy() {
    const sftp = new SftpClient();
    
    const keyPath = path.join(process.env.USERPROFILE || '', '.ssh', 'id_ed25519');
    const config = {
        host: process.env.DEPLOY_HOST,
        port: 22,
        username: process.env.DEPLOY_USER
    };

    if (fs.existsSync(keyPath)) {
        console.log(`Using SSH private key: ${keyPath}`);
        config.privateKey = fs.readFileSync(keyPath);
    } else {
        console.log('SSH key not found, using password fallback.');
        config.password = process.env.DEPLOY_PASS;
    }

    const remoteBase = process.env.DEPLOY_PATH || '/var/www/html';
    
    console.log(`Verbinde zu ${config.host}...`);

    try {
        await sftp.connect(config);
        console.log('Verbunden!');

        // Ensure remote directories exist
        const dirs = ['public', 'protected', 'public/general', 'public/statue'];
        for (const dir of dirs) {
            const remoteDir = path.posix.join(remoteBase, dir);
            const exists = await sftp.exists(remoteDir);
            if (!exists) {
                console.log(`Erstelle Verzeichnis: ${remoteDir}`);
                await sftp.mkdir(remoteDir, true);
            }
        }

        // Files to upload
        const filesToUpload = [
            { local: 'index.html', remote: 'index.html' },
            { local: 'public/index.html', remote: 'public/index.html' },
            { local: 'public/logo_minusnd.png', remote: 'public/logo_minusnd.png' },
            { local: 'public/logo_rushclipzquick.png', remote: 'public/logo_rushclipzquick.png' },
            { local: 'public/logo_lacy.png', remote: 'public/logo_lacy.png' },
            { local: 'public/scoreboard.html', remote: 'public/scoreboard.html' },
            { local: 'public/scoreboard-wm2026.html', remote: 'public/scoreboard-wm2026.html' },
            { local: 'public/scoreboard-wm-neu.html', remote: 'public/scoreboard-wm-neu.html' },
            { local: 'public/scoreboard-football.html', remote: 'public/scoreboard-football.html' },
            { local: 'public/scoreboard-wm26-real.html', remote: 'public/scoreboard-wm26-real.html' },
            { local: 'public/test-wm26-real.html', remote: 'public/test-wm26-real.html' },
            { local: 'public/fifa-badge.png', remote: 'public/fifa-badge.png' },
            { local: 'public/fifa2026.svg', remote: 'public/fifa2026.svg' },
            { local: 'public/trophy.png', remote: 'public/trophy.png' },
            { local: 'public/style.css', remote: 'public/style.css' },
            { local: 'public/realtime-store.js', remote: 'public/realtime-store.js' },
            { local: 'public/app-config.js', remote: 'public/app-config.js' },
            { local: 'public/tmi.min.js', remote: 'public/tmi.min.js' },
            { local: 'public/wordgame.html', remote: 'public/wordgame.html' },
            { local: 'public/flaggame.html', remote: 'public/flaggame.html' },
            { local: 'public/mapgame.html', remote: 'public/mapgame.html' },
            { local: 'public/bingo-data.js', remote: 'public/bingo-data.js' },
            { local: 'public/modstats.html', remote: 'public/modstats.html' },
            { local: 'public/bot-setup-mod.html', remote: 'public/bot-setup-mod.html' },
            { local: 'public/bot-setup.html', remote: 'public/bot-setup.html' },
            { local: 'public/cutter-trainer.html', remote: 'public/cutter-trainer.html' },
            { local: 'public/car-analyzer.html', remote: 'public/car-analyzer.html' },
            { local: 'public/car-deals.html', remote: 'public/car-deals.html' },
            { local: 'public/scoreboard-control.html', remote: 'public/scoreboard-control.html' },
            { local: 'public/scoreboard-2v2v2.html', remote: 'public/scoreboard-2v2v2.html' },
            { local: 'public/scoreboard-control-2v2v2.html', remote: 'public/scoreboard-control-2v2v2.html' },
            { local: 'public/scoreboard-control-2v2v2.html', remote: 'public/scoreboard-control-2v2v2.html' },
            { local: 'public/scoreboard-2v2v2.html', remote: 'public/scoreboard-2v2v2.html' },
            { local: 'public/general/countdown.html', remote: 'public/general/countdown.html' },
            { local: 'public/general/chat.html', remote: 'public/general/chat.html' },
            { local: 'public/general/goal.html', remote: 'public/general/goal.html' },
            { local: 'public/general/social.html', remote: 'public/general/social.html' },
            { local: 'public/general/hearts.html', remote: 'public/general/hearts.html' },
            { local: 'public/general/stopwatch.html', remote: 'public/general/stopwatch.html' },
            { local: 'public/wheel.html', remote: 'public/wheel.html' },
            { local: 'public/wheel-control.html', remote: 'public/wheel-control.html' },
            { local: 'public/wheel.css', remote: 'public/wheel.css' },
            { local: 'public/challenge.html', remote: 'public/challenge.html' },
            { local: 'public/challenge-control.html', remote: 'public/challenge-control.html' },
            { local: 'public/subathon.html', remote: 'public/subathon.html' },
            { local: 'public/minecraft-baustelle-overlay.html', remote: 'public/minecraft-baustelle-overlay.html' },
            { local: 'public/minecraft-baustelle-admin.html', remote: 'public/minecraft-baustelle-admin.html' },
            { local: 'public/statue/index.html', remote: 'public/statue/index.html' },
            { local: 'public/statue/three.min.js', remote: 'public/statue/three.min.js' },
            { local: 'public/statue/model.js', remote: 'public/statue/model.js' },
            { local: 'public/statue/app.js', remote: 'public/statue/app.js' },
            { local: 'public/statue/reference.png', remote: 'public/statue/reference.png' },
            { local: 'public/statue/head-reference.png', remote: 'public/statue/head-reference.png' },
            { local: 'public/statue/face-reference.png', remote: 'public/statue/face-reference.png' },
            { local: 'public/statue/favicon.ico', remote: 'public/statue/favicon.ico' },
            { local: 'public/overlay-maker.html', remote: 'public/overlay-maker.html' },
            { local: 'public/custom-overlay.html', remote: 'public/custom-overlay.html' },
            { local: 'protected/admin.html', remote: 'protected/admin.html' },
            { local: 'protected/panel.html', remote: 'protected/panel.html' },
            { local: 'protected/clipper.html', remote: 'protected/clipper.html' },
            { local: 'protected/scoreboard-admin.html', remote: 'protected/scoreboard-admin.html' },
            { local: 'protected/scoreboard-2v2v2-admin.html', remote: 'protected/scoreboard-2v2v2-admin.html' },
            { local: 'protected/challenge-admin.html', remote: 'protected/challenge-admin.html' },
            { local: 'protected/subathon-admin.html', remote: 'protected/subathon-admin.html' },
            { local: 'protected/wordgame-admin.html', remote: 'protected/wordgame-admin.html' },
            { local: 'protected/flaggame-admin.html', remote: 'protected/flaggame-admin.html' },
            { local: 'protected/mapgame-admin.html', remote: 'protected/mapgame-admin.html' },
            { local: 'protected/clipper-team-admin.html', remote: 'protected/clipper-team-admin.html' },
            { local: 'public/clipper-leaderboard.html', remote: 'public/clipper-leaderboard.html' },
            { local: 'public/video-overlay.html', remote: 'public/video-overlay.html' },
            { local: 'protected/video-admin.html', remote: 'protected/video-admin.html' },
            { local: 'public/berichtsheft.html', remote: 'public/berichtsheft.html' },
            { local: 'public/ariblk.ttf', remote: 'public/ariblk.ttf' },
            { local: 'public/logo_ahawasistdas.png', remote: 'public/logo_ahawasistdas.png' },
            { local: 'backend/server.js', remote: '/var/www/bot/server.js' },
            { local: 'backend/clipper.js', remote: '/var/www/bot/clipper.js' },
            { local: 'backend/game_data.js', remote: '/var/www/bot/game_data.js' }
        ];

        for (const file of filesToUpload) {
            const localPath = path.join(__dirname, file.local);
            const remotePath = file.remote.startsWith('/') 
                ? file.remote 
                : path.posix.join(remoteBase, file.remote);
            
            if (fs.existsSync(localPath)) {
                console.log(`Lade hoch: ${file.local} -> ${remotePath}`);
                await sftp.put(localPath, remotePath);
            }
        }

        // Restart PM2 server to apply backend changes
        console.log('Starte PM2 Server neu...');
        const ssh = sftp.client;
        await new Promise((resolve) => {
            ssh.exec('pm2 restart all', (err, stream) => {
                if (err) {
                    console.error('Fehler beim Ausführen von pm2 restart:', err.message);
                    return resolve();
                }
                stream.on('close', (code, signal) => {
                    resolve();
                }).on('data', (data) => {
                    console.log('PM2: ' + data.toString().trim());
                }).stderr.on('data', (data) => {
                    console.error('PM2 Error: ' + data.toString().trim());
                });
            });
        });

        console.log('\n=======================================');
        console.log('DEPLOIMENT ERFOLGREICH!');
        console.log(`URL: https://minusnd.de`);
        console.log('=======================================');

    } catch (err) {
        console.error('Fehler beim Deployment:', err.message);
    } finally {
        await sftp.end();
    }
}

deploy();
