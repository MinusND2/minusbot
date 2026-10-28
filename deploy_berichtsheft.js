// Lädt den Berichtsheft-Assistenten (public/berichtsheft.html) und das Panel (protected/panel.html) auf minusnd.de hoch.
// Nutzt dieselben Zugangsdaten wie deploy.js (.env bzw. SSH-Key). Kein Backend-Upload, kein PM2-Neustart.
require('dotenv').config();
const SftpClient = require('ssh2-sftp-client');
const path = require('path');
const fs = require('fs');

async function deploy() {
    const sftp = new SftpClient();
    const keyPath = path.join(process.env.USERPROFILE || '', '.ssh', 'id_ed25519');
    const config = { host: process.env.DEPLOY_HOST, port: 22, username: process.env.DEPLOY_USER };
    if (fs.existsSync(keyPath)) config.privateKey = fs.readFileSync(keyPath);
    else config.password = process.env.DEPLOY_PASS;
    const remoteBase = process.env.DEPLOY_PATH || '/var/www/html';

    try {
        console.log(`Verbinde zu ${config.host}...`);
        await sftp.connect(config);
        const files = ['public/berichtsheft.html', 'protected/panel.html'];
        for (const rel of files) {
            const remoteDir = path.posix.join(remoteBase, path.posix.dirname(rel));
            if (!(await sftp.exists(remoteDir))) await sftp.mkdir(remoteDir, true);
            const remote = path.posix.join(remoteBase, rel);
            console.log(`Lade hoch: ${rel} -> ${remote}`);
            await sftp.put(path.join(__dirname, ...rel.split('/')), remote);
        }
        console.log('\nFertig! Im Panel unter Ausbildung > Berichtsheft, oder direkt: https://minusnd.de/public/berichtsheft.html');
    } catch (err) {
        console.error('Fehler beim Hochladen:', err.message);
    } finally {
        await sftp.end();
    }
}
deploy();
