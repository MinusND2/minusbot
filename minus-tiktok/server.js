const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = 4002;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR);
}

// Connect to Firebase Realtime Database
const admin = require('firebase-admin');
try {
    const serviceAccountPath = path.join(__dirname, '..', 'backend', 'serviceAccountKey.json');
    if (fs.existsSync(serviceAccountPath)) {
        admin.initializeApp({
            credential: admin.credential.cert(require(serviceAccountPath)),
            databaseURL: "https://bingo-overlay-default-rtdb.europe-west1.firebasedatabase.app"
        });
        const db = admin.database();
        console.log("🔥 Firebase Admin erfolgreich initialisiert.");
        
        // Start the queue listener
        startTiktokQueueListener(db);
    } else {
        console.warn("⚠️ backend/serviceAccountKey.json nicht gefunden. Firebase Queue Listener wird nicht gestartet.");
    }
} catch (err) {
    console.error("❌ Fehler bei der Initialisierung von Firebase Admin:", err.message);
}

let isProcessingQueue = false;

function startTiktokQueueListener(db) {
    console.log("🌐 Starte Firebase Realtime Database Queue-Listener für TikTok...");
    
    db.ref('clipper/tiktok_queue').on('value', async (snapshot) => {
        if (isProcessingQueue) return;
        isProcessingQueue = true;
        
        try {
            const queue = snapshot.val() || {};
            const pendingJobs = Object.values(queue)
                .filter(job => job.status === 'pending')
                .sort((a, b) => a.timestamp - b.timestamp); // Process oldest first
                
            if (pendingJobs.length > 0) {
                const job = pendingJobs[0];
                console.log(`[Queue] Verarbeite TikTok-Job ${job.id} für Streamer ${job.streamerName}`);
                
                // Update status to uploading immediately
                await db.ref(`clipper/tiktok_queue/${job.id}`).update({
                    status: 'uploading',
                    progressMessage: 'Lade Video herunter...'
                });
                
                const tempFilename = `download_${Date.now()}.mp4`;
                const tempPath = path.join(UPLOADS_DIR, tempFilename);
                
                try {
                    await downloadFile(job.url, tempPath);
                    
                    // Update status
                    await db.ref(`clipper/tiktok_queue/${job.id}`).update({
                        status: 'uploading',
                        progressMessage: 'Starte Chrome...'
                    });
                    
                    // Define a custom status callback to sync progress to Firebase
                    const firebaseStatusCallback = async (state, message) => {
                        await db.ref(`clipper/tiktok_queue/${job.id}`).update({
                            status: state,
                            progressMessage: message
                        });
                        uploadStatus = { state, message, error: null };
                    };
                    
                    // Run upload with status updates
                    await runTikTokUploadWithCallback(
                        tempPath,
                        job.caption || '',
                        job.hashtags ? job.hashtags.split(' ').filter(t => t) : [],
                        true, // Always auto publish for queue jobs
                        job.tiktokAccount || 'default',
                        firebaseStatusCallback
                    );
                    
                    // Mark as done
                    await db.ref(`clipper/tiktok_queue/${job.id}`).update({
                        status: 'done',
                        progressMessage: 'Erfolgreich gepostet!',
                        postedAt: Date.now()
                    });
                    
                } catch (err) {
                    console.error(`[Queue] Fehler bei TikTok-Job ${job.id}:`, err.message);
                    await db.ref(`clipper/tiktok_queue/${job.id}`).update({
                        status: 'failed',
                        error: err.message,
                        progressMessage: `Fehlgeschlagen: ${err.message}`
                    });
                } finally {
                    if (fs.existsSync(tempPath)) {
                        try { fs.unlinkSync(tempPath); } catch(e) {}
                    }
                }
            }
        } catch (err) {
            console.error("[Queue] Fehler im Queue-Handler:", err);
        } finally {
            isProcessingQueue = false;
        }
    });
}

// Multer Config
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

const http = require('http');
const https = require('https');

function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(destPath);
        client.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download: Status Code ${response.statusCode}`));
                return;
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
        }).on('error', (err) => {
            fs.unlink(destPath, () => reject(err));
        });
    });
}

// Real-time status
let uploadStatus = {
    state: 'idle', // 'idle', 'starting', 'awaiting_login', 'uploading', 'typing', 'posting', 'done', 'error'
    message: 'Bereit für Upload.',
    error: null
};

const connectionStatuses = {
    default: { state: 'disconnected', message: 'Prüfe Sitzung...' }
};

// Async session status checker helper
async function checkSessionStatusAsync(account) {
    let sessionDirName = 'tiktok_session';
    if (account && account !== 'default') {
        sessionDirName = `tiktok_session_${account.replace(/[^a-zA-Z0-9_]/g, '')}`;
    }
    const sessionDir = path.join(__dirname, sessionDirName);
    if (!fs.existsSync(sessionDir)) {
        connectionStatuses[account] = { state: 'disconnected', message: 'Nicht verbunden.' };
        return;
    }
    
    // Lösche stale Lock-Dateien
    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    for (const file of lockFiles) {
        const filePath = path.join(sessionDir, file);
        try {
            fs.unlinkSync(filePath);
        } catch (e) {}
    }

    let browser = null;
    try {
        connectionStatuses[account] = { state: 'connecting', message: 'Prüfe bestehende Sitzung...' };
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-web-security'],
            userDataDir: sessionDir
        });
        const page = await browser.newPage();
        await page.goto('https://www.tiktok.com/tiktokstudio/upload', { waitUntil: 'networkidle2', timeout: 20000 });
        await new Promise(r => setTimeout(r, 3000));
        
        const currentUrl = page.url();
        const hasFileInput = await page.$('input[type="file"]');
        
        if (hasFileInput && !currentUrl.includes('login')) {
            connectionStatuses[account] = { state: 'connected', message: 'Erfolgreich verbunden.' };
        } else {
            connectionStatuses[account] = { state: 'disconnected', message: 'Nicht verbunden.' };
        }
    } catch (e) {
        connectionStatuses[account] = { state: 'disconnected', message: 'Nicht verbunden.' };
    } finally {
        if (browser) {
            try { await browser.close(); } catch(e) {}
        }
    }
}

// Run an async check after startup
setTimeout(async () => {
    await checkSessionStatusAsync('default');
}, 3000);

function updateStatus(state, message, error = null) {
    uploadStatus = { state, message, error };
    console.log(`[Status: ${state}] ${message}`);
}

app.get('/api/status', (req, res) => {
    res.json(uploadStatus);
});

app.get('/api/tiktok/connect-status', (req, res) => {
    const account = (req.query.account || 'default').replace(/[^a-zA-Z0-9_]/g, '');
    if (!connectionStatuses[account]) {
        checkSessionStatusAsync(account);
        return res.json({ state: 'connecting', message: 'Prüfe Sitzung...' });
    }
    res.json(connectionStatuses[account]);
});

app.post('/api/tiktok/connect', async (req, res) => {
    const account = (req.body.account || 'default').replace(/[^a-zA-Z0-9_]/g, '');
    res.json({ success: true, message: 'Browser-Login gestartet.' });
    
    let sessionDirName = 'tiktok_session';
    if (account && account !== 'default') {
        sessionDirName = `tiktok_session_${account}`;
    }
    const sessionDir = path.join(__dirname, sessionDirName);
    
    // Lösche stale Lock-Dateien
    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    for (const file of lockFiles) {
        const filePath = path.join(sessionDir, file);
        try {
            fs.unlinkSync(filePath);
        } catch (e) {}
    }

    let browser = null;
    try {
        connectionStatuses[account] = { state: 'connecting', message: 'Öffne TikTok-Login-Fenster...' };
        browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: [
                '--start-maximized',
                '--disable-web-security',
                '--no-sandbox'
            ],
            userDataDir: sessionDir
        });
        
        const pages = await browser.pages();
        const page = pages.length > 0 ? pages[0] : await browser.newPage();
        
        await page.goto('https://www.tiktok.com/tiktokstudio/upload', { waitUntil: 'networkidle2' });
        
        connectionStatuses[account] = { state: 'awaiting_login', message: 'Bitte logge dich im geöffneten Chrome-Fenster bei TikTok ein.' };
        
        let loggedIn = false;
        // Wait up to 10 minutes (120 * 5s) for user to log in
        for (let i = 0; i < 120; i++) {
            if (browser.disconnected || page.isClosed()) {
                throw new Error('Browser oder Seite wurde geschlossen.');
            }
            
            const hasFileInput = await page.$('input[type="file"]');
            if (hasFileInput && !page.url().includes('login')) {
                loggedIn = true;
                break;
            }
            await new Promise(r => setTimeout(r, 5000));
        }
        
        if (loggedIn) {
            connectionStatuses[account] = { state: 'connected', message: 'Erfolgreich verbunden!' };
        } else {
            throw new Error('Login-Timeout oder fehlgeschlagen.');
        }
    } catch (err) {
        connectionStatuses[account] = { state: 'error', message: `Fehler: ${err.message}` };
    } finally {
        setTimeout(async () => {
            if (browser && !browser.disconnected) {
                try { await browser.close(); } catch(e) {}
            }
        }, 5000);
    }
});

app.post('/api/tiktok/disconnect', async (req, res) => {
    const account = (req.body.account || 'default').replace(/[^a-zA-Z0-9_]/g, '');
    let sessionDirName = 'tiktok_session';
    if (account && account !== 'default') {
        sessionDirName = `tiktok_session_${account}`;
    }
    const sessionDir = path.join(__dirname, sessionDirName);
    if (fs.existsSync(sessionDir)) {
        try {
            fs.rmSync(sessionDir, { recursive: true, force: true });
            connectionStatuses[account] = { state: 'disconnected', message: 'Verbindung getrennt.' };
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: `Konnte Sitzung nicht löschen: ${err.message}` });
        }
    } else {
        connectionStatuses[account] = { state: 'disconnected', message: 'Verbindung getrennt.' };
        res.json({ success: true });
    }
});

app.get('/api/tiktok/accounts', (req, res) => {
    const accounts = ['default'];
    try {
        const files = fs.readdirSync(__dirname);
        for (const file of files) {
            if (file.startsWith('tiktok_session_') && fs.statSync(path.join(__dirname, file)).isDirectory()) {
                const acc = file.substring('tiktok_session_'.length);
                if (acc && !accounts.includes(acc)) {
                    accounts.push(acc);
                }
            }
        }
    } catch (e) {
        console.error('Failed to read accounts directories:', e);
    }
    res.json({ success: true, accounts });
});

app.post('/api/upload-url', async (req, res) => {
    const { url, caption, hashtags, autoPublish, tiktokAccount } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'URL fehlt.' });
    }
    
    // Respond immediately to allow the front-end to poll progress via status API
    res.json({ success: true, message: 'Video-Download von URL gestartet.' });

    const videoPath = path.join(UPLOADS_DIR, Date.now() + '.mp4');
    try {
        updateStatus('starting', 'Lade Video von Remote-Server herunter...');
        await downloadFile(url, videoPath);
        updateStatus('starting', 'Download abgeschlossen. Starte TikTok Uploader...');
        
        runTikTokUpload(
            videoPath, 
            caption || '', 
            hashtags || [], 
            autoPublish === true || autoPublish === 'true',
            tiktokAccount
        );
    } catch (err) {
        updateStatus('error', `Download failed: ${err.message}`, err.message);
        try {
            if (fs.existsSync(videoPath)) {
                fs.unlinkSync(videoPath);
            }
        } catch (e) {}
    }
});

app.post('/api/upload', upload.single('video'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Keine Videodatei hochgeladen.' });
    }

    const videoPath = req.file.path;
    const caption = req.body.caption || '';
    const hashtags = JSON.parse(req.body.hashtags || '[]');
    const autoPublish = req.body.autoPublish === 'true';
    const tiktokAccount = req.body.tiktokAccount || 'default';

    // Start Puppeteer in the background (but visible window)
    res.json({ success: true, message: 'Upload-Prozess gestartet.' });
    runTikTokUpload(videoPath, caption, hashtags, autoPublish, tiktokAccount);
});

async function runTikTokUpload(videoPath, caption, hashtags, autoPublish, tiktokAccount = 'default') {
    return runTikTokUploadWithCallback(videoPath, caption, hashtags, autoPublish, tiktokAccount, updateStatus);
}

async function runTikTokUploadWithCallback(videoPath, caption, hashtags, autoPublish, tiktokAccount = 'default', statusCallback = updateStatus) {
    let browser = null;
    try {
        statusCallback('starting', 'Initialisiere Chrome (Sichtbarer Modus)...');
        
        let sessionDirName = 'tiktok_session';
        if (tiktokAccount && tiktokAccount !== 'default' && tiktokAccount !== '') {
            sessionDirName = `tiktok_session_${tiktokAccount.replace(/[^a-zA-Z0-9_]/g, '')}`;
        }
        const sessionDir = path.join(__dirname, sessionDirName);

        // Lösche stale Lock-Dateien
        const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
        for (const file of lockFiles) {
            const filePath = path.join(sessionDir, file);
            try {
                fs.unlinkSync(filePath);
                console.log(`[TikTok Uploader] Stale ${file} gelöscht für ${tiktokAccount}`);
            } catch (e) {
                if (e.code !== 'ENOENT') {
                    console.warn(`[TikTok Uploader] Fehler beim Löschen von ${file} für ${tiktokAccount}:`, e.message);
                }
            }
        }

        browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: [
                '--start-maximized',
                '--disable-web-security',
                '--no-sandbox'
            ],
            userDataDir: sessionDir
        });

        const pages = await browser.pages();
        const page = pages.length > 0 ? pages[0] : await browser.newPage();
        
        statusCallback('starting', 'Öffne TikTok Studio Upload...');
        // Use networkidle0 or domcontentloaded as fallback
        await page.goto('https://www.tiktok.com/tiktokstudio/upload', { 
            waitUntil: 'domcontentloaded',
            timeout: 60000 
        });
        // Wait a bit for scripts to settle
        await new Promise(r => setTimeout(r, 3000));

        // Check if we are on the login page or if the file input is missing
        statusCallback('awaiting_login', 'Prüfe Login-Sitzung. Bitte logge dich ein, falls nötig...');

        let loggedIn = false;
        // Wait up to 10 minutes (120 * 5s) for the user to log in manually if needed
        for (let i = 0; i < 120; i++) {
            // Check if page is closed
            if (browser.disconnected || page.isClosed()) {
                throw new Error('Browser oder Seite wurde vom Benutzer geschlossen.');
            }

            // Try multiple selectors for file input (TikTok sometimes changes this!)
            let fileInput = null;
            const fileInputSelectors = [
                'input[type="file"]',
                'input[accept*="video"]',
                'input[name="video"]'
            ];
            for (const sel of fileInputSelectors) {
                fileInput = await page.$(sel);
                if (fileInput) break;
            }
            
            if (fileInput) {
                loggedIn = true;
                break;
            }
            
            // Still waiting for login
            const currentUrl = page.url();
            if (currentUrl.includes('login')) {
                statusCallback('awaiting_login', 'Sitzung abgelaufen: Bitte logge dich im Chrome-Fenster ein (z.B. per QR-Code).');
            } else {
                statusCallback('awaiting_login', 'Lade TikTok Upload-Bereich...');
            }
            await new Promise(r => setTimeout(r, 5000));
        }

        if (!loggedIn) {
            throw new Error('Login-Timeout überschritten. Bitte starte den Upload erneut.');
        }

        statusCallback('uploading', 'Wähle Videodatei aus und starte Upload...');
        // Re-find file input with fallback selectors
        let fileInput = null;
        const fileInputSelectors = [
            'input[type="file"]',
            'input[accept*="video"]',
            'input[name="video"]'
        ];
        for (const sel of fileInputSelectors) {
            fileInput = await page.$(sel);
            if (fileInput) break;
        }
        if (!fileInput) {
            throw new Error('Konnte das Upload-Dateifeld nicht finden.');
        }
        
        await fileInput.uploadFile(videoPath);

        statusCallback('uploading', 'Video wird hochgeladen und verarbeitet. Bitte warten...');

        // Wait for the description field to become available with multiple selectors in a loop
        let descriptionSelector = null;
        const descSelectors = [
            'div[contenteditable="true"]',
            '[data-testid="caption-input"]',
            'textarea[placeholder*="beschreibung"]',
            'textarea[placeholder*="caption"]'
        ];
        
        statusCallback('uploading', 'Warte auf Upload-Fortschritt...');
        // Check every 2 seconds, up to 150 times (5 minutes total)
        for (let attempt = 0; attempt < 150; attempt++) {
            for (const sel of descSelectors) {
                const el = await page.$(sel);
                if (el) {
                    descriptionSelector = sel;
                    break;
                }
            }
            if (descriptionSelector) {
                console.log(`[TikTok Uploader] Beschreibungsfeld gefunden nach ${attempt * 2}s.`);
                break;
            }
            await new Promise(r => setTimeout(r, 2000));
        }
        
        if (!descriptionSelector) {
            throw new Error('Konnte das Beschreibungsfeld nicht finden.');
        }
        
        // Wait another 10 seconds for safety (TikTok needs time to process the upload)
        statusCallback('uploading', 'Upload abgeschlossen, verarbeite Video...');
        await new Promise(r => setTimeout(r, 10000));

        statusCallback('typing', 'Trage Beschreibung und Hashtags ein...');
        await page.evaluate((selector) => {
            const el = document.querySelector(selector);
            if (el) {
                el.focus();
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                    el.value = '';
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                } else {
                    const range = document.createRange();
                    range.selectNodeContents(el);
                    const selObj = window.getSelection();
                    selObj.removeAllRanges();
                    selObj.addRange(range);
                    document.execCommand('delete', false, null);
                }
            }
        }, descriptionSelector);

        await new Promise(r => setTimeout(r, 500));

        // Form full caption text
        const fullCaption = `${caption} ${hashtags.map(tag => tag.startsWith('#') ? tag : '#' + tag).join(' ')}`;
        await page.keyboard.type(fullCaption, { delay: 50 });

        // Wait for upload progress to complete or process bar to clear if auto-publish is active
        if (autoPublish) {
            statusCallback('posting', 'Bereite Veröffentlichung vor. Warte auf Upload-Abschluss...');
            
            // Sleep for 20 seconds to let video metadata load completely
            await new Promise(r => setTimeout(r, 20000));

            const postBtn = await page.evaluateHandle(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                return buttons.find(btn => {
                    const txt = btn.textContent.toLowerCase();
                    // More possible button texts
                    return txt.includes('post') || txt.includes('veröffentlichen') || 
                           txt.includes('teilen') || txt.includes('publish') ||
                           txt.includes('upload') || txt.includes('hochladen');
                });
            });

            if (postBtn) {
                statusCallback('posting', 'Klicke auf "Veröffentlichen"...');
                await postBtn.click();
                
                // Wait for redirect or success modal
                statusCallback('posting', 'Verarbeitung auf TikTok läuft...');
                await new Promise(r => setTimeout(r, 15000));
                statusCallback('done', 'Video wurde erfolgreich auf TikTok veröffentlicht!');
            } else {
                // If button not found, show helpful message instead of failing
                statusCallback('done', 'Video wurde vorbereitet! Bitte prüfe im Chrome-Fenster und klicke manuell auf "Veröffentlichen".');
            }
        } else {
            statusCallback('done', 'Video wurde vorbereitet! Du kannst es jetzt im geöffneten Chrome-Fenster prüfen und manuell posten.');
        }

    } catch (err) {
        statusCallback('error', `Fehler beim Upload: ${err.message}`, err.message);
        throw err;
    } finally {
        // Clean up local temp video file
        try {
            if (fs.existsSync(videoPath)) {
                fs.unlinkSync(videoPath);
            }
        } catch (unlinkErr) {
            console.error('Failed to delete temp video file:', unlinkErr);
        }

        // Close browser after 30 seconds on success/failure so user can see what happened
        setTimeout(async () => {
            if (browser && !browser.disconnected) {
                try {
                    await browser.close();
                } catch (closeErr) {}
            }
        }, 30000);
    }
}

app.listen(PORT, () => {
    console.log(`🚀 TikTok Auto-Uploader läuft auf http://localhost:${PORT}`);
});
