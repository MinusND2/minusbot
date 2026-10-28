require('dotenv').config();
const SftpClient = require('ssh2-sftp-client');
const { Client } = require('ssh2');
const path = require('path');
const fs = require('fs');

async function deployBackend() {
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

    const remoteBase = '/var/www/bot';
    console.log(`[Backend] Verbinde zu ${config.host}...`);

    try {
        await sftp.connect(config);
        console.log('[Backend] SFTP Verbunden!');

        // Ensure tiktok_sessions & car_analyzer directories exist
        const remoteDirs = [
            'tiktok_sessions',
            'car_analyzer',
            'car_analyzer/database',
            'car_analyzer/engine',
            'car_analyzer/extractor',
            'car_analyzer/dealfinder'
        ];
        for (const d of remoteDirs) {
            const remoteDir = path.posix.join(remoteBase, d);
            const exists = await sftp.exists(remoteDir);
            if (!exists) {
                console.log(`[Backend] Erstelle Verzeichnis: ${remoteDir}...`);
                await sftp.mkdir(remoteDir, true);
            }
        }

        const filesToUpload = [
            { local: 'backend/server.js', remote: 'server.js' },
            { local: 'backend/game_data.js', remote: 'game_data.js' },
            { local: 'backend/clipper.js', remote: 'clipper.js' },
            { local: 'backend/package.json', remote: 'package.json' },
            { local: 'backend/car_analyzer/routes.js', remote: 'car_analyzer/routes.js' },
            { local: 'backend/car_analyzer/database/reliabilityDatabase.json', remote: 'car_analyzer/database/reliabilityDatabase.json' },
            { local: 'backend/car_analyzer/database/marketCoefficients.json', remote: 'car_analyzer/database/marketCoefficients.json' },
            { local: 'backend/car_analyzer/extractor/standardizer.js', remote: 'car_analyzer/extractor/standardizer.js' },
            { local: 'backend/car_analyzer/extractor/mobileDeExtractor.js', remote: 'car_analyzer/extractor/mobileDeExtractor.js' },
            { local: 'backend/car_analyzer/engine/marketPriceEngine.js', remote: 'car_analyzer/engine/marketPriceEngine.js' },
            { local: 'backend/car_analyzer/engine/runningCostsEngine.js', remote: 'car_analyzer/engine/runningCostsEngine.js' },
            { local: 'backend/car_analyzer/engine/depreciationEngine.js', remote: 'car_analyzer/engine/depreciationEngine.js' },
            { local: 'backend/car_analyzer/engine/reliabilityEngine.js', remote: 'car_analyzer/engine/reliabilityEngine.js' },
            { local: 'backend/car_analyzer/engine/riskEngine.js', remote: 'car_analyzer/engine/riskEngine.js' },
            { local: 'backend/car_analyzer/engine/scoringEngine.js', remote: 'car_analyzer/engine/scoringEngine.js' },
            { local: 'backend/car_analyzer/engine/compareEngine.js', remote: 'car_analyzer/engine/compareEngine.js' },
            { local: 'backend/car_analyzer/dealfinder/catalog.js', remote: 'car_analyzer/dealfinder/catalog.js' },
            { local: 'backend/car_analyzer/dealfinder/parseListing.js', remote: 'car_analyzer/dealfinder/parseListing.js' },
            { local: 'backend/car_analyzer/dealfinder/store.js', remote: 'car_analyzer/dealfinder/store.js' },
            { local: 'backend/car_analyzer/dealfinder/valuation.js', remote: 'car_analyzer/dealfinder/valuation.js' },
            { local: 'backend/car_analyzer/dealfinder/scoring.js', remote: 'car_analyzer/dealfinder/scoring.js' },
            { local: 'backend/car_analyzer/dealfinder/sources.js', remote: 'car_analyzer/dealfinder/sources.js' },
            { local: 'backend/car_analyzer/dealfinder/router.js', remote: 'car_analyzer/dealfinder/router.js' },
            { local: 'backend/car_analyzer/test_dealfinder.js', remote: 'car_analyzer/test_dealfinder.js' },
            { local: 'backend/reset_queue.js', remote: 'reset_queue.js' },
            { local: 'backend/test_clip.js', remote: 'test_clip.js' },
            { local: 'backend/check.js', remote: 'check.js' },
            { local: 'backend/trigger_test.js', remote: 'trigger_test.js' },
            { local: 'backend/analyze_clip.py', remote: 'analyze_clip.py' },
            { local: 'backend/verify_face_in_render.py', remote: 'verify_face_in_render.py' },
            { local: 'backend/haarcascade_frontalface_default.xml', remote: 'haarcascade_frontalface_default.xml' },
            { local: 'backend/tiktok_sessions/tiktok_cookie_okkannsein.txt', remote: 'tiktok_sessions/tiktok_cookie_okkannsein.txt' },
            { local: 'backend/tiktok_sessions/tiktok_cookie_default.txt', remote: 'tiktok_sessions/tiktok_cookie_default.txt' },
            { local: 'backend/.env', remote: '.env' }
        ];

        for (const file of filesToUpload) {
            const localPath = path.join(__dirname, file.local);
            const remotePath = path.posix.join(remoteBase, file.remote);
            if (fs.existsSync(localPath)) {
                console.log(`[Backend] Lade hoch: ${file.local} -> ${remotePath}`);
                await sftp.put(localPath, remotePath);
            }
        }
        await sftp.end();
        console.log('[Backend] SFTP Übertragung beendet!');

        // Nun per SSH verbinden, um pm2 zu restart-en
        console.log('[Backend] Verbinde per SSH für Server-Neustart...');
        const conn = new Client();
        await new Promise((resolve, reject) => {
            conn.on('ready', () => {
                console.log('[Backend] SSH Verbunden!');
                conn.exec('npm install --prefix /var/www/bot/ && pm2 restart SpotifyBot', (err, stream) => {
                    if (err) return reject(err);
                    stream.on('close', (code, signal) => {
                        console.log(`[Backend] PM2 Restart abgeschlossen (Code: ${code})`);
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
        console.log('BACKEND ERFOLGREICH NEU GESTARTET!');
        console.log('=======================================');

    } catch (err) {
        console.error('[Backend] Fehler beim Deployment:', err.message);
    }
}

deployBackend();
