const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
}
const puppeteer = require('puppeteer');
const multer = require('multer');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 4001;
const CONFIG_FILE = path.join(__dirname, 'config.json');

// TikTok Auto-Uploader Config & State
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, 'tiktok_' + Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

let tiktokStatus = {
    state: 'idle',
    message: 'Bereit für Upload.',
    error: null
};

function updateTiktokStatus(state, message, error = null) {
    tiktokStatus = { state, message, error };
    console.log(`[TikTok Status: ${state}] ${message}`);
}

// Memory logs cache
let logs = [];
function addLog(msg) {
    const time = new Date().toLocaleTimeString('de-DE');
    const entry = `[${time}] ${msg}`;
    logs.push(entry);
    if (logs.length > 100) logs.shift();
    console.log(entry);
}

// Load / Save Config with Multi-Account support
function loadConfig() {
    let conf = {
        accounts: [],
        twitchToken: '',
        targetChannel: '',
        claimPoints: true,
        optimizeBandwidth: true
    };
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = fs.readFileSync(CONFIG_FILE, 'utf8');
            const parsed = JSON.parse(data);
            conf = { ...conf, ...parsed };
        }
    } catch (err) {
        addLog(`Fehler beim Laden der config.json: ${err.message}`);
    }

    if (!Array.isArray(conf.accounts)) {
        conf.accounts = [];
    }

    return conf;
}

function saveConfig(config) {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    } catch (err) {
        addLog(`Fehler beim Schreiben der config.json: ${err.message}`);
    }
}

// Active Farmer State
let farmerState = {
    isRunning: false,
    channel: '',
    status: 'Inaktiv',
    startTime: null,
    isLive: false,
    totalPointsClaimed: 0,
    pointsByChannel: {},
    pointsByAccount: {},
    channelsStatus: {}
};

let activeBrowser = null;
let accountContexts = {}; // Maps account.login -> Isolated BrowserContext
let activePages = {}; // Maps `${account.login}_${channel}` -> Puppeteer Page
let streamSessions = {}; // Maps `${account.login}_${channel}` -> { startTime, lastBeaconTime, streakClaimed, reloadCount }
let checkInterval = null;

// Guided Login Globals
let loginBrowser = null;
let loginPage = null;
let loginTimeout = null;

function clearLoginSession() {
    if (loginTimeout) {
        clearTimeout(loginTimeout);
        loginTimeout = null;
    }
    if (loginBrowser) {
        loginBrowser.close().catch(() => {});
        loginBrowser = null;
    }
    loginPage = null;
}

// Twitch GQL Client configuration & resilient fetcher
const TWITCH_GQL_HEADERS = {
    'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Origin': 'https://www.twitch.tv',
    'Referer': 'https://www.twitch.tv/',
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*'
};

async function fetchTwitchGQL(body, extraHeaders = {}, retries = 1) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000);
        try {
            const response = await fetch('https://gql.twitch.tv/gql', {
                method: 'POST',
                headers: {
                    ...TWITCH_GQL_HEADERS,
                    ...extraHeaders
                },
                body: JSON.stringify(body),
                signal: controller.signal
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status} (${response.statusText || 'Error'})`);
            }

            const contentType = response.headers.get('content-type') || '';
            if (!contentType.includes('application/json')) {
                throw new Error(`Ungültige Serverantwort (Content-Type: ${contentType || 'unbekannt'})`);
            }

            return await response.json();
        } catch (err) {
            if (attempt < retries) {
                await new Promise(r => setTimeout(r, 600));
                continue;
            }
            const detailedMsg = err.cause?.message ? `${err.message} (${err.cause.message})` : err.message;
            const enhancedError = new Error(detailedMsg);
            throw enhancedError;
        } finally {
            clearTimeout(timeoutId);
        }
    }
}

// Twitch GQL User Details Fetcher
async function fetchTwitchUserDetails(token) {
    let tokenValue = (token || '').trim();
    if (tokenValue.startsWith('oauth:')) {
        tokenValue = tokenValue.substring(6);
    }
    if (!tokenValue) return null;

    try {
        const data = await fetchTwitchGQL([{
            operationName: 'DashboardHelper_User',
            variables: {},
            query: 'query DashboardHelper_User { currentUser { id login displayName profileImageURL(width: 150) } }'
        }], {
            'Authorization': `OAuth ${tokenValue}`
        });

        const user = data?.[0]?.data?.currentUser;
        if (user && user.id) {
            return {
                id: user.id,
                login: user.login,
                displayName: user.displayName,
                profileImage: user.profileImageURL
            };
        }
    } catch (e) {
        addLog(`[Twitch Auth] Fehler beim Abrufen der Benutzerdaten: ${e.message}`);
    }
    return null;
}

// GQL Helper to check stream status & rich metadata for channels in a single request
let lastGqlErrorTime = 0;
async function checkChannelsLiveGQL(channels) {
    if (!channels || channels.length === 0) return {};
    try {
        const data = await fetchTwitchGQL(channels.map(ch => ({
            operationName: 'ChannelShell',
            variables: { login: ch },
            query: 'query ChannelShell($login: String!) { user(login: $login) { login displayName profileImageURL(width: 150) stream { id type viewersCount game { id name } title } } }'
        })));

        if (!Array.isArray(data)) {
            throw new Error('Unerwartetes Antwortformat von Twitch');
        }

        const result = {};
        channels.forEach((ch, idx) => {
            const user = data[idx]?.data?.user;
            const stream = user?.stream;
            result[ch] = {
                isLive: !!stream,
                displayName: user?.displayName || ch,
                profileImage: user?.profileImageURL || '',
                title: stream?.title || '',
                game: stream?.game?.name || '',
                viewers: stream?.viewersCount || 0
            };
        });
        return result;
    } catch (err) {
        const now = Date.now();
        // Log at most once every 60 seconds to avoid flooding the log when Twitch has a momentary hiccup
        if (now - lastGqlErrorTime > 60000) {
            addLog(`[System] Twitch GQL Live-Check temporär nicht erreichbar: ${err.message}`);
            lastGqlErrorTime = now;
        }
        return null;
    }
}

// Helper to open a Puppeteer tab for an account + channel combination with sound and auto-claim
async function openAccountChannelTab(account, channel, config) {
    const accLogin = (account.login || 'acc').toLowerCase();
    const chName = channel.toLowerCase();
    const key = `${accLogin}_${chName}`;

    // If an actual Puppeteer page is already open and valid, skip
    if (activePages[key] && typeof activePages[key].screenshot === 'function' && !activePages[key].isClosed?.()) {
        return;
    }

    try {
        addLog(`[${account.displayName || accLogin} -> #${channel}] Öffne isolierte Sitzung mit Sound & Chat...`);
        
        // Create an isolated BrowserContext for this account so cookies/sessions never collide
        if (!accountContexts[accLogin]) {
            if (typeof activeBrowser.createBrowserContext === 'function') {
                accountContexts[accLogin] = await activeBrowser.createBrowserContext();
            } else if (typeof activeBrowser.createIncognitoBrowserContext === 'function') {
                accountContexts[accLogin] = await activeBrowser.createIncognitoBrowserContext();
            } else {
                accountContexts[accLogin] = activeBrowser.defaultBrowserContext();
            }
        }

        const context = accountContexts[accLogin];
        const page = await context.newPage();
        
        page._accountLogin = accLogin;
        page._channelName = channel.toLowerCase();
        page._accountDisplayName = account.displayName || accLogin;

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1920, height: 1080 });
        
        // Initialize session telemetry tracker for 100% check & watchtime verification
        streamSessions[key] = {
            account: accLogin,
            channel: channel.toLowerCase(),
            startTime: Date.now(),
            lastBeaconTime: Date.now(),
            streakClaimed: false,
            reloadCount: 0
        };

        // Listen to console logs of the page to catch claimed points, streak sharing, and recovery events
        page.on('console', msg => {
            const txt = msg.text();
            if (txt.includes('CLAIM_EVENT_BONUS_POINTS') || txt.includes('Claimed points')) {
                farmerState.totalPointsClaimed = (farmerState.totalPointsClaimed || 0) + 50;
                farmerState.pointsByChannel[channel] = (farmerState.pointsByChannel[channel] || 0) + 50;
                farmerState.pointsByAccount[accLogin] = (farmerState.pointsByAccount[accLogin] || 0) + 50;
                
                // Update points in config
                const cfg = loadConfig();
                const accObj = cfg.accounts.find(a => a.login.toLowerCase() === accLogin);
                if (accObj) {
                    accObj.pointsClaimed = (accObj.pointsClaimed || 0) + 50;
                    saveConfig(cfg);
                }

                if (farmerState.channelsStatus[channel]) {
                    farmerState.channelsStatus[channel].lastBonusTime = Date.now();
                }
                addLog(`[${account.displayName || accLogin} -> #${channel}] 🎁 Kanalpunkte-Bonus eingesammelt! (+50 Pkt | Gesamt: ${farmerState.totalPointsClaimed})`);
            } else if (txt.includes('CLAIM_EVENT_STREAK_SHARED')) {
                if (!farmerState.channelsStatus[channel]) farmerState.channelsStatus[channel] = {};
                farmerState.channelsStatus[channel].streakSecured = true;
                farmerState.channelsStatus[channel].lastStreakTime = Date.now();
                if (streamSessions[key]) streamSessions[key].streakClaimed = true;
                addLog(`[${account.displayName || accLogin} -> #${channel}] 🔥 STREAK-BONUS GESICHERT! (Offizielle Watch-Serie im Stream bestätigt & geteilt)`);
            } else if (txt.includes('PLAYER_ERROR_RELOAD_CLICKED')) {
                if (streamSessions[key]) streamSessions[key].reloadCount = (streamSessions[key].reloadCount || 0) + 1;
                addLog(`[${account.displayName || accLogin} -> #${channel}] 🔄 Player-Fehler erkannt & Stream automatisch wiederhergestellt.`);
            } else if (txt.includes('CLICK_STILL_WATCHING')) {
                addLog(`[${account.displayName || accLogin} -> #${channel}] 👁️ 'Schaust du noch zu?' bestätigt.`);
            }
        });

        // Track telemetry and save bandwidth if enabled without blocking Twitch telemetry/spade beacons
        if (config.optimizeBandwidth) {
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                const url = req.url();
                const resourceType = req.resourceType();
                if (url.includes('spade.twitch.tv') || url.includes('gql.twitch.tv')) {
                    if (streamSessions[key]) streamSessions[key].lastBeaconTime = Date.now();
                }
                // Never block telemetry/tracking beacons or scripts
                if (url.includes('spade.twitch.tv') || url.includes('gql.twitch.tv') || url.includes('usher.ttvnw.net') || url.includes('chat')) {
                    req.continue();
                } else if (resourceType === 'font') {
                    req.abort();
                } else {
                    req.continue();
                }
            });
        } else {
            page.on('request', (req) => {
                const url = req.url();
                if (url.includes('spade.twitch.tv') || url.includes('gql.twitch.tv')) {
                    if (streamSessions[key]) streamSessions[key].lastBeaconTime = Date.now();
                }
            });
        }

        // Set auth-token cookie for this specific account
        const cleanToken = account.token ? account.token.trim() : '';
        if (cleanToken) {
            await page.setCookie({
                name: 'auth-token',
                value: cleanToken,
                url: 'https://www.twitch.tv',
                domain: '.twitch.tv',
                path: '/',
                secure: true,
                httpOnly: false,
                sameSite: 'Lax'
            });

            try {
                const client = await page.target().createCDPSession();
                await client.send('Network.setCookie', {
                    name: 'auth-token',
                    value: cleanToken,
                    domain: '.twitch.tv',
                    path: '/',
                    secure: true,
                    httpOnly: false
                });
            } catch (cdpErr) {}
        }

        // Pre-configure twitch player parameters: UNMUTED, VOLUME 0.5, 160p resolution, bypass visibility API & focus
        await page.evaluateOnNewDocument(() => {
            try {
                localStorage.setItem('video-quality', JSON.stringify({ default: '160p30' }));
                localStorage.setItem('volume', '0.5');
                localStorage.setItem('muted', 'false');
            } catch (e) {}

            Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
            Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
            document.hasFocus = () => true;
            window.onblur = null;
            window.blurred = false;
            
            // Continuous loop to guarantee audio is active, video is playing, and rewards/prompts/streaks are auto-claimed
            setInterval(() => {
                const videos = document.querySelectorAll('video');
                videos.forEach(v => {
                    if (v.muted) v.muted = false;
                    if (v.volume < 0.2) v.volume = 0.5;
                    if (v.paused) v.play().catch(() => {});
                });

                // Auto-click Bonus / Claim Buttons
                const claimSelectors = [
                    'button[aria-label="Claim Bonus"]',
                    'button[aria-label="Bonus beanspruchen"]',
                    '.claimable-bonus__icon',
                    '.community-points-summary button.tw-button--success',
                    'button.tw-button--success',
                    'button[data-test-selector="DropsCampaignInProgressDescription-claim-button"]',
                    'button[data-a-target="drops-claim-button"]'
                ];
                for (const s of claimSelectors) {
                    const el = document.querySelector(s);
                    if (el) {
                        const btn = el.tagName === 'BUTTON' ? el : el.closest('button');
                        if (btn && !btn.disabled) {
                            btn.click();
                            console.log('CLAIM_EVENT_BONUS_POINTS');
                            break;
                        }
                    }
                }

                // Auto-click Official Watch-Streak Milestone / "Serie teilen" Buttons
                const streakSelectors = [
                    'button[data-a-target="chat-streak-share-button"]',
                    'button[data-test-selector="streak-share-button"]',
                    'button[data-test-selector="chat-streak-claim-button"]',
                    'button[data-a-target="chat-streak-claim-button"]'
                ];
                for (const s of streakSelectors) {
                    const el = document.querySelector(s);
                    if (el) {
                        const btn = el.tagName === 'BUTTON' ? el : el.closest('button');
                        if (btn && !btn.disabled) {
                            btn.click();
                            console.log('CLAIM_EVENT_STREAK_SHARED');
                            break;
                        }
                    }
                }

                // Fallback: Check for official streak text buttons (without sending chat text)
                const streakTextButtons = Array.from(document.querySelectorAll('.chat-room button, .chat-notification button, div[data-test-selector="chat-notification"] button, button.tw-button--success'));
                for (const b of streakTextButtons) {
                    const t = (b.textContent || '').toLowerCase().trim();
                    if (t.includes('serie teilen') || t.includes('share streak') || t.includes('serie fortsetzen') || t.includes('streak teilen') || t.includes('keep streak')) {
                        if (!b.disabled) {
                            b.click();
                            console.log('CLAIM_EVENT_STREAK_SHARED');
                            break;
                        }
                    }
                }

                // Auto-recover from Player Errors (Error #2000, #3000, Buffering Stalls)
                const errorReloadSelectors = [
                    'button[data-a-target="player-overlay-reload-button"]',
                    'button[data-a-target="tw-player-reload-button"]',
                    '.player-overlay-reload-button',
                    'button[data-a-target="content-classification-gate-overlay-start-watching-button"]'
                ];
                for (const s of errorReloadSelectors) {
                    const el = document.querySelector(s);
                    if (el) {
                        const btn = el.tagName === 'BUTTON' ? el : el.closest('button');
                        if (btn && !btn.disabled) {
                            btn.click();
                            console.log('PLAYER_ERROR_RELOAD_CLICKED');
                            break;
                        }
                    }
                }

                // Auto-confirm "Still watching?" prompt
                const stillWatching = document.querySelector('button[data-a-target="player-overlay-still-watching-button"]');
                if (stillWatching && !stillWatching.disabled) {
                    stillWatching.click();
                    console.log('CLICK_STILL_WATCHING');
                }

                // Auto-accept 18+ Mature warning & Audience Classification
                const matureSelectors = [
                    'button[data-a-target="player-overlay-mature-accept"]',
                    'button[data-a-target="content-classification-gate-overlay-start-watching-button"]',
                    '.content-classification-gate-overlay button'
                ];
                for (const s of matureSelectors) {
                    const el = document.querySelector(s);
                    if (el && !el.disabled) { el.click(); break; }
                }

                // Auto-accept Cookie Banner
                const cookieSelectors = [
                    'button[data-a-target="consent-banner-accept"]',
                    'button[data-test-selector="cookie-banner__accept-button"]',
                    '.consent-banner button.tw-button--primary',
                    '.cookie-banner button'
                ];
                for (const s of cookieSelectors) {
                    const el = document.querySelector(s);
                    if (el && !el.disabled) { el.click(); break; }
                }

                // Auto-dismiss in-stream popovers & balloons (e.g. animated emotes info)
                const dismissBtns = document.querySelectorAll('button[aria-label="Dismiss"], button[aria-label="Schließen"], .tw-balloon button.tw-button--subtle');
                dismissBtns.forEach(b => { if (!b.disabled) b.click(); });

                // Natural Heartbeat / Anti-AFK every 30s
                if (!window._lastAfkTick || Date.now() - window._lastAfkTick > 30000) {
                    window._lastAfkTick = Date.now();
                    const playerContainer = document.querySelector('.video-player__container, .video-player, video');
                    if (playerContainer) {
                        playerContainer.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 200, clientY: 200 }));
                    }
                }
            }, 2500);
        });

        // Open channel URL
        const url = `https://www.twitch.tv/${channel}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await new Promise(r => setTimeout(r, 5000));

        // Connect to chat and ensure session active
        try {
            await page.waitForSelector('[data-a-target="chat-input"], .chat-room', { timeout: 8000 });
            await page.evaluate(() => {
                const chat = document.querySelector('[data-a-target="chat-input"]');
                if (chat) {
                    chat.focus();
                    chat.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                }
            });
        } catch (e) {}

        const isLoggedIn = await page.evaluate(() => {
            return !!document.querySelector('[data-a-target="user-menu-toggle"]');
        });

        if (!isLoggedIn) {
            addLog(`[${account.displayName || accLogin} -> #${channel}] ⚠️ Kein Login erkannt! Token überprüfen.`);
        } else {
            addLog(`[${account.displayName || accLogin} -> #${channel}] ✅ Eingeloggt & Stream aktiv mit Sound.`);
        }
        activePages[key] = page;
    } catch (err) {
        addLog(`[${account.displayName || accLogin} -> #${channel}] FEHLER beim Öffnen: ${err.message}`);
        delete activePages[key];
    }
}

// Helper to close a Puppeteer tab for an account + channel
async function closeAccountChannelTab(account, channel) {
    const accLogin = (account.login || 'acc').toLowerCase();
    const chName = channel.toLowerCase();
    const key = `${accLogin}_${chName}`;

    const targetPage = activePages[key];
    if (!targetPage) return;
    delete activePages[key];
    delete streamSessions[key];

    if (targetPage && typeof targetPage.close === 'function') {
        try {
            addLog(`[${account.displayName || accLogin} -> #${channel}] Stream offline. Schließe Tab.`);
            await targetPage.close().catch(() => {});
        } catch (err) {
            addLog(`[${account.displayName || accLogin} -> #${channel}] Fehler beim Schließen: ${err.message}`);
        }
    }
}

// Standalone periodic metadata updater for UI live status, titles & avatars
async function updateAllChannelsMetadata() {
    const config = loadConfig();
    const channels = (config.targetChannel || '').split(',')
        .map(c => c.trim().toLowerCase())
        .filter(c => c.length > 0);
    
    if (channels.length === 0) return;

    const liveMap = await checkChannelsLiveGQL(channels);
    if (!liveMap) return;

    for (const channel of channels) {
        const meta = liveMap[channel] || { isLive: false };
        farmerState.channelsStatus[channel] = {
            isLive: meta.isLive,
            status: meta.isLive ? 'LIVE' : 'Offline',
            displayName: meta.displayName || channel,
            profileImage: meta.profileImage || '',
            title: meta.title || '',
            game: meta.game || '',
            viewers: meta.viewers || 0,
            pointsClaimed: farmerState.pointsByChannel[channel] || 0,
            lastBonusTime: farmerState.channelsStatus[channel]?.lastBonusTime || null,
            lastCheck: Date.now()
        };
    }
}

// Dynamic check and lifecycle manager across all active accounts and live channels
async function runFarmerCheck(channels, config) {
    if (!farmerState.isRunning || !activeBrowser) return;

    const liveMap = await checkChannelsLiveGQL(channels);
    if (!liveMap) return;

    const activeAccounts = (config.accounts || []).filter(a => a.active !== false && a.token);

    if (activeAccounts.length === 0) {
        addLog('[Farmer] Keine aktiven Twitch-Accounts vorhanden.');
        farmerState.status = 'Keine aktiven Accounts';
        return;
    }

    for (const channel of channels) {
        const channelMeta = liveMap[channel] || { isLive: false };
        const isLive = channelMeta.isLive;

        for (const account of activeAccounts) {
            const accLogin = (account.login || 'acc').toLowerCase();
            const key = `${accLogin}_${channel.toLowerCase()}`;
            let pageObj = activePages[key];
            let wasLive = !!pageObj && typeof pageObj.screenshot === 'function';

            if (wasLive && typeof pageObj.isClosed === 'function' && pageObj.isClosed()) {
                delete activePages[key];
                wasLive = false;
            }

            if (isLive && !wasLive) {
                activePages[key] = { opening: true };
                await openAccountChannelTab(account, channel, config);
            } else if (!isLive && wasLive) {
                await closeAccountChannelTab(account, channel);
            }
        }

        farmerState.channelsStatus[channel] = {
            isLive: isLive,
            status: isLive ? 'LIVE' : 'Offline',
            displayName: channelMeta.displayName || channel,
            profileImage: channelMeta.profileImage || '',
            title: channelMeta.title || '',
            game: channelMeta.game || '',
            viewers: channelMeta.viewers || 0,
            pointsClaimed: farmerState.pointsByChannel[channel] || 0,
            lastBonusTime: farmerState.channelsStatus[channel]?.lastBonusTime || null,
            lastCheck: Date.now()
        };
    }

    const openCount = Object.values(activePages).filter(p => p && typeof p.screenshot === 'function' && !p.isClosed?.()).length;
    farmerState.status = `Aktiv: ${openCount} Streams (${activeAccounts.length} Accs, ${channels.length} Kanäle)`;
    farmerState.isLive = openCount > 0;
}

let isStartingFarmer = false;

// Start Farmer
async function startFarmer(config) {
    if (isStartingFarmer) {
        addLog('[Farmer] Startvorgang läuft bereits, bitte einen Moment gedulden...');
        return;
    }
    isStartingFarmer = true;

    try {
        if (activeBrowser) {
            await stopFarmer();
        }

        const channels = config.targetChannel.split(',')
            .map(c => c.trim().toLowerCase())
            .filter(c => c.length > 0);

        const activeAccounts = (config.accounts || []).filter(a => a.active !== false && a.token);

        if (channels.length === 0) {
            addLog('FEHLER beim Starten: Keine Zielkanäle konfiguriert.');
            farmerState.status = 'Fehler (Keine Kanäle)';
            return;
        }

        if (activeAccounts.length === 0) {
            addLog('FEHLER beim Starten: Keine aktiven Twitch-Accounts vorhanden.');
            farmerState.status = 'Fehler (Keine Accounts)';
            return;
        }

        addLog(`Starte Multi-Account 24/7 Farmer: ${activeAccounts.length} Account(s) für Kanäle: ${channels.map(c => `#${c}`).join(', ')}...`);
        farmerState.isRunning = true;
        farmerState.channel = config.targetChannel;
        farmerState.status = 'Startet...';
        farmerState.startTime = Date.now();
        farmerState.isLive = false;
        farmerState.channelsStatus = {};

        addLog('Initialisiere Puppeteer (Stealth, Audio Unmuted)...');
        activeBrowser = await puppeteerExtra.launch({
            headless: 'shell',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--autoplay-policy=no-user-gesture-required',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--window-size=1280,720',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-breakpad',
                '--disable-client-side-phishing-detection',
                '--disable-component-update',
                '--disable-default-apps',
                '--disable-domain-reliability',
                '--disable-hang-monitor',
                '--disable-ipc-flooding-protection',
                '--disable-popup-blocking',
                '--disable-prompt-on-repost',
                '--disable-renderer-backgrounding',
                '--disable-sync',
                '--metrics-recording-only',
                '--no-first-run',
                '--no-default-browser-check',
                '--js-flags="--max-old-space-size=256"'
            ]
        });

        for (const channel of channels) {
            farmerState.channelsStatus[channel] = { isLive: false, status: 'Prüfe...' };
        }

        await runFarmerCheck(channels, config);

        if (checkInterval) clearInterval(checkInterval);
        checkInterval = setInterval(async () => {
            await runFarmerCheck(channels, config);
        }, 45000);

    } catch (err) {
        addLog(`FEHLER beim Starten des Farmers: ${err.message}`);
        farmerState.status = 'Fehler';
        farmerState.isRunning = false;
        await stopFarmer();
    } finally {
        isStartingFarmer = false;
    }
}

// Stop Farmer
async function stopFarmer() {
    addLog('Stoppe Watchtime-Farmer...');
    if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
    }

    for (const key of Object.keys(activePages)) {
        const page = activePages[key];
        if (page && typeof page.close === 'function') {
            try { await page.close().catch(() => {}); } catch(e) {}
        }
    }
    activePages = {};
    streamSessions = {};

    for (const acc of Object.keys(accountContexts)) {
        const ctx = accountContexts[acc];
        if (ctx && typeof ctx.close === 'function') {
            try { await ctx.close().catch(() => {}); } catch(e) {}
        }
    }
    accountContexts = {};

    if (activeBrowser) {
        try {
            await activeBrowser.close();
        } catch (err) {
            addLog(`Fehler beim Schließen des Browsers: ${err.message}`);
        }
    }
    activeBrowser = null;

    farmerState.isRunning = false;
    farmerState.status = 'Inaktiv';
    farmerState.isLive = false;
    updateAllChannelsMetadata().catch(() => {});
    addLog('Farmer gestoppt.');
}

const WATCHTIME_PIN = process.env.WATCHTIME_PIN || '2026';

// Strict Twitch Channel Name Sanitizer (Letters, numbers, underscores, 3-25 chars)
function sanitizeChannelName(name) {
    if (!name || typeof name !== 'string') return '';
    const clean = name.trim().toLowerCase().replace(/^#/, '');
    if (/^[a-z0-9_]{3,25}$/.test(clean)) {
        return clean;
    }
    return '';
}

function sanitizeChannelList(str) {
    if (!str || typeof str !== 'string') return '';
    return str
        .split(',')
        .map(c => sanitizeChannelName(c))
        .filter(c => c.length > 0)
        .join(', ');
}

// 1. Public Auth Route: Verify PIN
app.post('/api/auth/unlock', (req, res) => {
    const { pin } = req.body;
    if (pin && String(pin).trim() === String(WATCHTIME_PIN).trim()) {
        return res.json({ success: true, message: 'Erfolgreich entsperrt' });
    }
    return res.status(401).json({ success: false, error: 'Falsche PIN / Falsches Passwort.' });
});

// 2. Auth Middleware: Protect ALL other /api/* endpoints
app.use('/api', (req, res, next) => {
    const clientPin = req.headers['x-watchtime-pin'] || req.query.pin;
    if (clientPin && String(clientPin).trim() === String(WATCHTIME_PIN).trim()) {
        return next();
    }
    return res.status(401).json({ success: false, error: 'Zugriff verweigert. Bitte PIN eingeben.', code: 'AUTH_REQUIRED' });
});

// API Endpoints: Account Management & Config
app.get('/api/config', (req, res) => {
    const config = loadConfig();
    const safeAccounts = (config.accounts || []).map(a => ({
        id: a.id,
        login: a.login,
        displayName: a.displayName,
        profileImage: a.profileImage,
        active: a.active !== false,
        pointsClaimed: a.pointsClaimed || 0,
        tokenMasked: a.token ? `${a.token.substring(0, 4)}...${a.token.slice(-4)}` : '',
        addedAt: a.addedAt || null
    }));
    const maskedConfig = {
        accounts: safeAccounts,
        twitchToken: config.twitchToken ? `${config.twitchToken.substring(0, 4)}...${config.twitchToken.slice(-4)}` : '',
        targetChannel: config.targetChannel || '',
        claimPoints: config.claimPoints !== false,
        optimizeBandwidth: config.optimizeBandwidth !== false
    };
    res.json(maskedConfig);
});

async function validateTokenCache(token) {
    if (!token) return false;
    try {
        const res = await fetch('https://id.twitch.tv/oauth2/validate', {
            headers: { 'Authorization': 'OAuth ' + token.trim() }
        });
        const data = await res.json();
        return res.ok && !!data.user_id;
    } catch (e) {
        return false;
    }
}

app.get('/api/accounts', async (req, res) => {
    const config = loadConfig();
    let accountsList = config.accounts || [];
    // If real accounts exist, filter out dummy legacy_ accounts
    if (accountsList.some(a => !a.id.startsWith('legacy_'))) {
        accountsList = accountsList.filter(a => !a.id.startsWith('legacy_'));
    }
    const accounts = await Promise.all(accountsList.map(async a => {
        const isValid = await validateTokenCache(a.token);
        return {
            id: a.id,
            login: a.login,
            displayName: a.displayName,
            profileImage: a.profileImage,
            active: a.active !== false,
            pointsClaimed: a.pointsClaimed || 0,
            tokenMasked: a.token ? `${a.token.substring(0, 4)}...${a.token.slice(-4)}` : '',
            isValid,
            addedAt: a.addedAt || Date.now()
        };
    }));
    res.json(accounts);
});

app.post('/api/accounts/add', async (req, res) => {
    let { token } = req.body;
    if (!token) {
        return res.status(400).json({ success: false, error: 'Kein Token bereitgestellt.' });
    }

    const user = await fetchTwitchUserDetails(token);
    if (!user) {
        return res.status(400).json({ success: false, error: 'Ungültiger Token oder Twitch-Sitzung abgelaufen.' });
    }

    const config = loadConfig();
    if (!Array.isArray(config.accounts)) config.accounts = [];

    const existingIndex = config.accounts.findIndex(a => a.id === user.id || a.login.toLowerCase() === user.login.toLowerCase());
    
    if (existingIndex >= 0) {
        config.accounts[existingIndex].token = token.trim();
        config.accounts[existingIndex].displayName = user.displayName;
        config.accounts[existingIndex].profileImage = user.profileImage;
        config.accounts[existingIndex].active = true;
        addLog(`[Account Manager] Account aktualisiert: @${user.displayName}`);
    } else {
        config.accounts.push({
            id: user.id,
            login: user.login,
            displayName: user.displayName,
            profileImage: user.profileImage,
            token: token.trim(),
            active: true,
            pointsClaimed: 0,
            addedAt: Date.now()
        });
        addLog(`[Account Manager] Neuer Account hinzugefügt: @${user.displayName} (Gesamt: ${config.accounts.length})`);
    }

    // Also update legacy field for fallback
    config.twitchToken = token.trim();
    saveConfig(config);

    if (farmerState.isRunning && activeBrowser) {
        const channels = config.targetChannel.split(',').map(c => c.trim().toLowerCase()).filter(c => c.length > 0);
        runFarmerCheck(channels, config).catch(() => {});
    }

    res.json({ success: true, user, totalAccounts: config.accounts.length });
});

app.post('/api/accounts/remove', async (req, res) => {
    const { login, id } = req.body;
    if (!login && !id) return res.status(400).json({ error: 'Account-Identifikator fehlt' });

    const config = loadConfig();
    const target = config.accounts.find(a => a.id === id || a.login.toLowerCase() === (login || '').toLowerCase());
    if (!target) return res.status(404).json({ error: 'Account nicht gefunden' });

    for (const key of Object.keys(activePages)) {
        if (key.startsWith(`${target.login.toLowerCase()}_`)) {
            try { await activePages[key].close(); } catch(e) {}
            delete activePages[key];
        }
    }

    config.accounts = config.accounts.filter(a => a.id !== target.id);
    saveConfig(config);
    addLog(`[Account Manager] Account entfernt: @${target.displayName}`);

    res.json({ success: true, totalAccounts: config.accounts.length });
});

app.post('/api/accounts/toggle', async (req, res) => {
    const { login, id, active } = req.body;
    const config = loadConfig();
    const target = config.accounts.find(a => a.id === id || a.login.toLowerCase() === (login || '').toLowerCase());
    if (!target) return res.status(404).json({ error: 'Account nicht gefunden' });

    target.active = active !== false;
    saveConfig(config);

    if (!target.active) {
        for (const key of Object.keys(activePages)) {
            if (key.startsWith(`${target.login.toLowerCase()}_`)) {
                try { await activePages[key].close(); } catch(e) {}
                delete activePages[key];
            }
        }
    } else if (farmerState.isRunning && activeBrowser) {
        const channels = config.targetChannel.split(',').map(c => c.trim().toLowerCase()).filter(c => c.length > 0);
        runFarmerCheck(channels, config).catch(() => {});
    }

    res.json({ success: true, account: target });
});

// Backward-compatible verify-token
app.post('/api/verify-token', async (req, res) => {
    let { twitchToken } = req.body;
    const user = await fetchTwitchUserDetails(twitchToken);
    if (user) {
        res.json({ success: true, user });
    } else {
        res.status(400).json({ success: false, error: 'Token ungültig' });
    }
});

app.post('/api/login/start', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Username und Passwort erforderlich.' });
    }

    clearLoginSession();

    try {
        addLog(`Starte geführten Login für Benutzer: ${username}...`);
        loginBrowser = await puppeteerExtra.launch({
            headless: 'shell',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--window-size=1280,720'
            ]
        });

        loginPage = await loginBrowser.newPage();
        await loginPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await loginPage.setViewport({ width: 1280, height: 720 });

        await loginPage.goto('https://www.twitch.tv/login', { waitUntil: 'networkidle2', timeout: 60000 });

        // Wait for username & password fields
        await loginPage.waitForSelector('input#login-username', { timeout: 15000 });
        await loginPage.type('input#login-username', username.trim(), { delay: 50 });
        await loginPage.type('input#password-input', password, { delay: 50 });

        // Click login button
        await loginPage.click('button[data-a-target="passport-login-button"]');
        addLog('Login-Daten abgeschickt. Warte auf Antwort von Twitch...');

        // Wait a few seconds to see if 2FA or Captcha appears
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Check if there is an error message visible on page
        const errorMessage = await loginPage.evaluate(() => {
            const errEl = document.querySelector('.tw-error-message, [data-a-target="passport-error-text"]');
            return errEl ? errEl.textContent.trim() : null;
        });

        if (errorMessage) {
            addLog(`Twitch Login-Fehler: ${errorMessage}`);
            clearLoginSession();
            return res.json({ success: false, error: errorMessage });
        }

        // Check if 2FA is required
        const is2FA = await loginPage.evaluate(() => {
            return !!document.querySelector('input[data-a-target="tw-input"], [autocomplete="one-time-code"]');
        });

        if (is2FA) {
            addLog('Twitch fordert einen 2FA-Code (E-Mail oder Authenticator-App) an.');
            
            // Auto close login browser after 5 minutes if not completed
            loginTimeout = setTimeout(() => {
                addLog('Login-Sitzung wegen Inaktivität abgelaufen.');
                clearLoginSession();
            }, 300000);

            return res.json({ success: true, status: 'requires_2fa', message: '2FA Code benötigt.' });
        }

        // Check if already logged in (no 2FA, successfully authenticated)
        const cookies = await loginPage.cookies();
        const authTokenCookie = cookies.find(c => c.name === 'auth-token');

        if (authTokenCookie) {
            const token = authTokenCookie.value;
            const current = loadConfig();
            current.twitchToken = token;

            const user = await fetchTwitchUserDetails(token);
            if (user) {
                const existingIndex = current.accounts.findIndex(a => a.id === user.id || a.login.toLowerCase() === user.login.toLowerCase());
                if (existingIndex >= 0) {
                    current.accounts[existingIndex].token = token.trim();
                    current.accounts[existingIndex].displayName = user.displayName;
                    current.accounts[existingIndex].profileImage = user.profileImage;
                    current.accounts[existingIndex].active = true;
                } else {
                    current.accounts.push({
                        id: user.id,
                        login: user.login,
                        displayName: user.displayName,
                        profileImage: user.profileImage,
                        token: token.trim(),
                        active: true,
                        pointsClaimed: 0,
                        addedAt: Date.now()
                    });
                }
            }
            saveConfig(current);
            
            addLog(`Login ohne 2FA erfolgreich! Account: @${user ? user.displayName : 'Twitch'}`);
            clearLoginSession();
            return res.json({ success: true, status: 'logged_in', token, user });
        }

        // Captcha or unknown screen
        addLog('WARNUNG: Unbekannter Zustand oder Captcha gefordert.');
        clearLoginSession();
        return res.json({ success: false, error: 'Ein Sicherheits-Captcha wird gefordert. Bitte nutze die manuelle Token-Eingabe.' });

    } catch (err) {
        addLog(`Fehler beim automatischen Login-Start: ${err.message}`);
        clearLoginSession();
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/login/2fa', async (req, res) => {
    const { code } = req.body;
    if (!code || code.length !== 6) {
        return res.status(400).json({ success: false, error: 'Ungültiger 2FA-Code (muss 6-stellig sein).' });
    }

    if (!loginBrowser || !loginPage) {
        return res.status(400).json({ success: false, error: 'Keine aktive Login-Sitzung gefunden.' });
    }

    try {
        addLog('Gebe 2FA-Code bei Twitch ein...');
        
        const firstInput = await loginPage.$('input[data-a-target="tw-input"], input[autocomplete="one-time-code"], input[type="text"]');
        if (firstInput) {
            await firstInput.focus();
            await firstInput.click({ clickCount: 3 });
            await loginPage.keyboard.press('Backspace');
            
            // Type the entire 6-digit code with delay between keypresses.
            // This lets Twitch's auto-advance script jump the focus naturally.
            await loginPage.keyboard.type(code, { delay: 150 });
        } else {
            addLog('WARNUNG: Kein 2FA-Eingabefeld gefunden.');
        }

        try {
            const submitBtn = await loginPage.$('button[data-a-target="passport-2fa-submit-button"]');
            if (submitBtn) {
                await submitBtn.click();
            }
        } catch (e) {}

        // Wait a few seconds for redirection/cookies to update
        await new Promise(resolve => setTimeout(resolve, 6000));

        // Check if still on the same page or if we have the cookie
        const cookies = await loginPage.cookies();
        const authTokenCookie = cookies.find(c => c.name === 'auth-token');

        if (authTokenCookie) {
            const token = authTokenCookie.value;
            const current = loadConfig();
            current.twitchToken = token;

            const user = await fetchTwitchUserDetails(token);
            if (user) {
                const existingIndex = current.accounts.findIndex(a => a.id === user.id || a.login.toLowerCase() === user.login.toLowerCase());
                if (existingIndex >= 0) {
                    current.accounts[existingIndex].token = token.trim();
                    current.accounts[existingIndex].displayName = user.displayName;
                    current.accounts[existingIndex].profileImage = user.profileImage;
                    current.accounts[existingIndex].active = true;
                } else {
                    current.accounts.push({
                        id: user.id,
                        login: user.login,
                        displayName: user.displayName,
                        profileImage: user.profileImage,
                        token: token.trim(),
                        active: true,
                        pointsClaimed: 0,
                        addedAt: Date.now()
                    });
                }
            }
            saveConfig(current);

            addLog(`Login nach 2FA erfolgreich! Account: @${user ? user.displayName : 'Twitch'}`);
            clearLoginSession();
            return res.json({ success: true, status: 'logged_in', token, user });
        }

        // Verify if there's an error message
        const errorMessage = await loginPage.evaluate(() => {
            const errEl = document.querySelector('.tw-error-message, [data-a-target="passport-error-text"]');
            return errEl ? errEl.textContent.trim() : null;
        });

        if (errorMessage) {
            addLog(`2FA-Verifikationsfehler: ${errorMessage}`);
            return res.json({ success: false, error: errorMessage });
        }

        addLog('2FA-Verifikation fehlgeschlagen (Falscher Code oder Timeout).');
        return res.json({ success: false, error: 'Der eingegebene Code ist ungültig oder abgelaufen.' });

    } catch (err) {
        addLog(`Fehler bei der 2FA-Verarbeitung: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});


app.post('/api/verify-channel', async (req, res) => {
    const { channel } = req.body;
    const cleanCh = sanitizeChannelName(channel);
    if (!cleanCh) {
        return res.status(400).json({ success: false, error: 'Ungültiger Twitch-Kanalname. Nur Buchstaben, Zahlen und _ erlaubt (3-25 Zeichen).' });
    }

    try {
        const data = await fetchTwitchGQL([{
            operationName: 'ChannelShell',
            variables: { login: cleanCh },
            query: 'query ChannelShell($login: String!) { user(login: $login) { id displayName profileImageURL(width: 70) stream { id type } } }'
        }]);

        const user = data?.[0]?.data?.user;

        if (user) {
            res.json({
                success: true,
                channel: {
                    id: user.id,
                    displayName: user.displayName,
                    profileImage: user.profileImageURL,
                    isLive: !!user.stream
                }
            });
        } else {
            res.status(404).json({ success: false, error: 'Kanal nicht gefunden.' });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: `Verbindungsfehler: ${err.message}` });
    }
});

app.post('/api/config', (req, res) => {
    const { twitchToken, targetChannel, claimPoints, optimizeBandwidth } = req.body;
    const current = loadConfig();

    let cleanedChannels = current.targetChannel;
    if (targetChannel !== undefined) {
        cleanedChannels = sanitizeChannelList(targetChannel);
    }

    const newConfig = {
        ...current,
        accounts: current.accounts || [], // ALWAYS preserve server accounts with raw tokens
        twitchToken: (twitchToken && !twitchToken.includes('...')) ? twitchToken : current.twitchToken,
        targetChannel: cleanedChannels,
        claimPoints: claimPoints !== undefined ? claimPoints : current.claimPoints,
        optimizeBandwidth: optimizeBandwidth !== undefined ? optimizeBandwidth : current.optimizeBandwidth
    };

    saveConfig(newConfig);
    addLog('Konfiguration aktualisiert.');

    // Update metadata for new channels immediately
    updateAllChannelsMetadata().catch(() => {});

    // Auto-restart running farmer to apply new channel list immediately
    if (farmerState.isRunning) {
        addLog('Farmer ist aktiv. Starte neu mit aktualisierter Konfiguration...');
        startFarmer(newConfig).catch(err => {
            addLog(`[Fehler] Auto-Neustart fehlgeschlagen: ${err.message}`);
        });
    }

    res.json({ success: true, message: 'Konfiguration gespeichert' });
});

app.post('/api/start', async (req, res) => {
    const config = loadConfig();
    const activeAccounts = (config.accounts || []).filter(a => a.active !== false && a.token);
    if (activeAccounts.length === 0) {
        return res.status(400).json({ error: 'Keine aktiven Twitch-Accounts verbunden! Bitte verbinde zuerst einen Account.' });
    }
    if (!config.targetChannel || config.targetChannel.trim().length === 0) {
        return res.status(400).json({ error: 'Keine Zielkanäle konfiguriert!' });
    }
    // Start im Hintergrund
    startFarmer(config);
    res.json({ success: true, message: 'Farmer wird gestartet' });
});

app.post('/api/stop', async (req, res) => {
    await stopFarmer();
    res.json({ success: true, message: 'Farmer wird gestoppt' });
});

app.get('/api/status', (req, res) => {
    const uptimeSeconds = (farmerState.isRunning && farmerState.startTime) ? Math.floor((Date.now() - farmerState.startTime) / 1000) : 0;
    res.json({
        state: {
            ...farmerState,
            uptimeSeconds
        },
        logs: logs.slice().reverse() // Zeige die neuesten Logs zuerst
    });
});

// 📸 Live-Beweis & 100% Diagnostic Endpoint (Echter Browser-Screenshot & Live-Telemetrie)
app.get('/api/stream/screenshot', async (req, res) => {
    try {
        const requestedChannel = (req.query.channel || '').toLowerCase().trim();
        const requestedAccount = (req.query.account || '').toLowerCase().trim();

        const openKeys = Object.keys(activePages);
        if (openKeys.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Keine aktiven Stream-Tabs geöffnet. Der Farmer ist entweder gestoppt oder die Zielkanäle sind aktuell offline.'
            });
        }

        let targetKey = null;
        let targetPage = null;

        for (const [key, page] of Object.entries(activePages)) {
            if (page && typeof page.screenshot === 'function') {
                if (page.isClosed && page.isClosed()) continue;
                const pageChannel = (page._channelName || (streamSessions[key]?.channel) || '').toLowerCase();
                const pageAccount = (page._accountLogin || (streamSessions[key]?.account) || '').toLowerCase();
                
                if (requestedChannel && (pageChannel === requestedChannel || key.toLowerCase().endsWith(`_${requestedChannel}`))) {
                    if (!requestedAccount || pageAccount === requestedAccount || key.toLowerCase().startsWith(`${requestedAccount}_`)) {
                        targetKey = key;
                        targetPage = page;
                        break;
                    }
                } else if (!requestedChannel && !targetPage) {
                    targetKey = key;
                    targetPage = page;
                }
            }
        }

        if (!targetPage) {
            return res.status(404).json({
                success: false,
                error: requestedChannel 
                    ? `Kein aktiver Stream-Tab für #${requestedChannel} geöffnet. Der Stream ist momentan offline oder wird gerade geladen.`
                    : 'Kein aktiver Stream-Tab gefunden.'
            });
        }

        const channelName = targetPage._channelName || streamSessions[targetKey]?.channel || requestedChannel;
        const accLogin = targetPage._accountLogin || streamSessions[targetKey]?.account || 'account';

        // Screenshot capture
        const screenshotBuffer = await targetPage.screenshot({
            type: 'jpeg',
            quality: 75
        });

        // Live Telemetry from the browser DOM
        const telemetry = await targetPage.evaluate(() => {
            const video = document.querySelector('video');
            const userToggle = document.querySelector('[data-a-target="user-menu-toggle"]');
            const userAvatar = userToggle ? (userToggle.querySelector('img')?.src || null) : null;
            const userName = userToggle ? (userToggle.querySelector('img')?.alt || null) : null;
            const pointsEl = document.querySelector('[data-test-selector="community-points-summary"]');
            const pointsText = pointsEl ? pointsEl.textContent.trim().replace(/\s+/g, ' ') : '';
            const isPaused = video ? video.paused : true;
            const readyState = video ? video.readyState : 0;
            const currentTime = video ? Math.floor(video.currentTime) : 0;
            const volume = video ? Math.round(video.volume * 100) : 0;
            const isMuted = video ? video.muted : true;
            const hasError = !!document.querySelector('.player-overlay-reload-button, [data-a-target="player-overlay-reload-button"], .tw-player-error-overlay');
            const chatReady = !!document.querySelector('[data-a-target="chat-input"], .chat-room');
            const channelTitle = document.querySelector('[data-a-target="stream-title"]')?.textContent?.trim() || '';

            return {
                isLoggedIn: !!userToggle,
                userName: userName || null,
                userAvatar: userAvatar || null,
                hasVideo: !!video,
                isPlaying: !!video && !isPaused && readyState >= 2,
                readyState,
                currentTime,
                volume,
                isMuted,
                hasError,
                chatReady,
                pointsText,
                channelTitle
            };
        }).catch(() => ({}));

        const session = streamSessions[targetKey] || {};
        const uptimeSec = session.startTime ? Math.floor((Date.now() - session.startTime) / 1000) : 0;
        const beaconAgoSec = session.lastBeaconTime ? Math.floor((Date.now() - session.lastBeaconTime) / 1000) : null;

        res.json({
            success: true,
            channel: channelName,
            account: accLogin,
            activeChannels: openKeys.map(k => {
                const p = activePages[k];
                const channel = p?._channelName || streamSessions[k]?.channel || k.split('_').slice(1).join('_');
                const account = p?._accountLogin || streamSessions[k]?.account || k.split('_')[0];
                return { account, channel, key: k };
            }),
            image: 'data:image/jpeg;base64,' + screenshotBuffer.toString('base64'),
            telemetry: {
                ...telemetry,
                uptimeSec,
                beaconAgoSec,
                streakClaimed: session.streakClaimed || (farmerState.channelsStatus[channelName]?.streakSecured || false),
                reloadCount: session.reloadCount || 0
            },
            timestamp: Date.now()
        });

    } catch (err) {
        res.status(500).json({ success: false, error: 'Screenshot-Fehler: ' + err.message });
    }
});

// ==========================================
// TikTok Auto-Uploader Endpoints
// ==========================================

// QR Login Session State
const qrLoginBrowsers = {};
const qrLoginPages = {};
const qrLoginTimeouts = {};

app.post('/api/tiktok/qr/start', async (req, res) => {
    const account = (req.query.account || req.body.account || 'default').replace(/[^a-zA-Z0-9_]/g, '');
    
    // Clean up any existing session for this account
    await cleanQrSession(account);

    try {
        console.log(`[TikTok QR] Starte Browser für ${account}...`);
        const browser = await puppeteerExtra.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage'
            ]
        });

        const page = await browser.newPage();
        await page.bringToFront();
        await page.setViewport({ width: 1280, height: 800 });
        // Set User-Agent and Language to simulate a normal user browser
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7' });

        console.log(`[TikTok QR] Navigiere zu Login für ${account}...`);
        await page.goto('https://www.tiktok.com/login', { waitUntil: 'networkidle2' });
        await new Promise(resolve => setTimeout(resolve, 5000));

        console.log(`[TikTok QR] Klicke QR-Code-Login für ${account}...`);
        try {
            // Find div[data-e2e="channel-item"] containing "QR" or "qr" (very precise, matches "QR-Code verwenden", "Use QR code" etc. inside the specific button)
            const qrBtn = await page.waitForSelector('xpath///div[@data-e2e="channel-item" and (contains(., "QR") or contains(., "qr"))]', { timeout: 4000 });
            if (qrBtn) {
                await qrBtn.click();
                console.log(`[TikTok QR] QR-Button geklickt via XPath data-e2e="channel-item" for ${account}`);
            } else {
                throw new Error('XPath-Selector fand kein Element');
            }
        } catch (e) {
            console.log(`[TikTok QR] Fallback-Klick-Suche gestartet für ${account}:`, e.message);
            const channelItems = await page.$$('div[data-e2e="channel-item"]');
            let clicked = false;
            for (let el of channelItems) {
                let text = await page.evaluate(el => el.textContent, el);
                if (text && (text.includes('QR') || text.includes('qr') || text.includes('Code') || text.includes('code'))) {
                    try {
                        await el.click();
                        console.log(`[TikTok QR] Fallback: data-e2e="channel-item" geklickt mit Text:`, text.trim());
                        clicked = true;
                        break;
                    } catch (clickErr) {
                        // ignore and try next element
                    }
                }
            }
            if (!clicked) {
                throw new Error('QR-Login Button konnte nicht gefunden oder geklickt werden.');
            }
        }

        console.log(`[TikTok QR] Warte auf QR-Code Canvas für ${account}...`);
        await page.waitForSelector('div[data-e2e="qr-code"] canvas', { timeout: 10000 });

        // Get QR code data URL
        const qrDataUrl = await page.evaluate(() => {
            const canvas = document.querySelector('div[data-e2e="qr-code"] canvas');
            return canvas ? canvas.toDataURL() : null;
        });

        if (!qrDataUrl) {
            throw new Error('QR-Code Bild konnte nicht ausgelesen werden.');
        }

        qrLoginBrowsers[account] = browser;
        qrLoginPages[account] = page;

        // Set auto-cleanup timeout (10 minutes max session)
        qrLoginTimeouts[account] = setTimeout(async () => {
            console.log(`[TikTok QR] Session für ${account} abgelaufen.`);
            await cleanQrSession(account);
        }, 10 * 60 * 1000);

        console.log(`[TikTok QR] QR-Code für ${account} erfolgreich generiert.`);
        res.json({ success: true, qrCode: qrDataUrl });

    } catch (err) {
        console.error(`[TikTok QR] Fehler beim Generieren für ${account}:`, err);
        if (qrLoginPages[account]) {
            try {
                const debugPath = path.join(__dirname, 'public', `debug_qr_fail_${account}.png`);
                await qrLoginPages[account].screenshot({ path: debugPath });
                console.log(`[TikTok QR] Debug-Screenshot gespeichert unter:`, debugPath);
            } catch (e) {
                console.error(`[TikTok QR] Fehler beim Speichern des Debug-Screenshots:`, e);
            }
        }
        await cleanQrSession(account);
        res.status(500).json({ error: `Fehler beim Generieren des QR-Codes für ${account}: ` + err.message });
    }
});

app.get('/api/tiktok/qr/status', async (req, res) => {
    const account = (req.query.account || 'default').replace(/[^a-zA-Z0-9_]/g, '');
    const page = qrLoginPages[account];
    const browser = qrLoginBrowsers[account];

    if (!browser || !page) {
        return res.json({ success: true, status: 'inactive' });
    }

    try {
        // Simuliere Aktivität, um Inaktivitäts-Blockaden der Skripte zu umgehen
        try {
            await page.bringToFront();
            const x = Math.floor(Math.random() * 800) + 100;
            const y = Math.floor(Math.random() * 600) + 100;
            await page.mouse.move(x, y);
            // Klick in neutrale obere linke Ecke
            await page.mouse.click(10, 10);
        } catch (actErr) {
            console.warn(`[TikTok QR] Konnte Aktivität nicht simulieren:`, actErr.message);
        }

        // Get all cookies
        const cookies = await page.cookies();
        const currentUrl = page.url();
        const sessionIdCookie = cookies.find(c => c.name === 'sessionid' || c.name === 'sessionid_ss');
        const isRedirected = !currentUrl.includes('/login') && !currentUrl.includes('unlogin') && currentUrl !== 'about:blank' && !currentUrl.includes('feedback');

        console.log(`[TikTok QR] Status Check für ${account}: URL=${currentUrl}, Cookies=${cookies.length}, HasSessionId=${!!sessionIdCookie}`);

        if ((sessionIdCookie && sessionIdCookie.value) || isRedirected) {
            const bestCookie = sessionIdCookie || cookies.find(c => c.name.toLowerCase().includes('session'));
            if (bestCookie && bestCookie.value) {
                console.log(`[TikTok QR] Login erfolgreich für ${account}! Speichere SessionID (${bestCookie.name})...`);
                
                // Save to config
                const config = loadConfig();
                config.tiktokAccounts = config.tiktokAccounts || {};
                config.tiktokAccounts[account] = bestCookie.value;
                if (account === 'default') {
                    config.tiktokSessionId = bestCookie.value;
                }
                saveConfig(config);

                // Wait to ensure disk persistence
                await new Promise(resolve => setTimeout(resolve, 2000));
                await cleanQrSession(account);

                return res.json({ success: true, status: 'logged_in' });
            } else if (isRedirected) {
                console.log('[TikTok QR] Redirected, aber SessionID Cookie noch nicht geladen. Warte auf nächsten Poll...');
            }
        }

        res.json({ success: true, status: 'waiting' });
    } catch (err) {
        console.error(`[TikTok QR] Status-Fehler für ${account}:`, err);
        res.json({ success: true, status: 'error', message: err.message });
    }
});

app.get('/api/tiktok/qr/screenshot', async (req, res) => {
    const account = (req.query.account || 'default').replace(/[^a-zA-Z0-9_]/g, '');
    const page = qrLoginPages[account];
    if (!page) {
        return res.status(400).json({ error: `Keine aktive Login-Sitzung für ${account}.` });
    }
    try {
        const screenshot = await page.screenshot({ encoding: 'base64' });
        res.json({ success: true, image: 'data:image/png;base64,' + screenshot, url: page.url() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tiktok/qr/stop', async (req, res) => {
    const account = (req.query.account || req.body.account || 'default').replace(/[^a-zA-Z0-9_]/g, '');
    await cleanQrSession(account);
    res.json({ success: true });
});

async function cleanQrSession(account) {
    if (qrLoginTimeouts[account]) {
        clearTimeout(qrLoginTimeouts[account]);
        delete qrLoginTimeouts[account];
    }
    if (qrLoginBrowsers[account]) {
        try {
            await qrLoginBrowsers[account].close();
        } catch (e) {}
        delete qrLoginBrowsers[account];
        delete qrLoginPages[account];
    }
}

app.post('/api/tiktok/config', (req, res) => {
    const { tiktokSessionId } = req.body;
    const account = (req.body.account || 'default').replace(/[^a-zA-Z0-9_]/g, '');
    const current = loadConfig();
    current.tiktokAccounts = current.tiktokAccounts || {};
    
    if (tiktokSessionId) {
        current.tiktokAccounts[account] = tiktokSessionId.trim();
        if (account === 'default') {
            current.tiktokSessionId = tiktokSessionId.trim();
        }
    }
    saveConfig(current);
    res.json({ success: true, message: `TikTok SessionID für ${account} gespeichert.` });
});

app.get('/api/tiktok/config', (req, res) => {
    const account = (req.query.account || 'default').replace(/[^a-zA-Z0-9_]/g, '');
    const current = loadConfig();
    current.tiktokAccounts = current.tiktokAccounts || {};
    
    // Sync backward compatibility
    if (current.tiktokSessionId && !current.tiktokAccounts['default']) {
        current.tiktokAccounts['default'] = current.tiktokSessionId;
    }
    
    const hasSession = !!current.tiktokAccounts[account];
    res.json({
        success: true,
        hasSession,
        tiktokSessionId: hasSession ? '••••••••' + current.tiktokAccounts[account].slice(-4) : ''
    });
});

app.get('/api/tiktok/accounts', (req, res) => {
    const current = loadConfig();
    current.tiktokAccounts = current.tiktokAccounts || {};
    
    // Sync backward compatibility
    if (current.tiktokSessionId && !current.tiktokAccounts['default']) {
        current.tiktokAccounts['default'] = current.tiktokSessionId;
    }
    
    const accounts = Object.keys(current.tiktokAccounts);
    if (accounts.length === 0) {
        accounts.push('default');
    }
    res.json({ success: true, accounts });
});

app.post('/api/tiktok/disconnect', (req, res) => {
    const account = (req.body.account || 'default').replace(/[^a-zA-Z0-9_]/g, '');
    const current = loadConfig();
    current.tiktokAccounts = current.tiktokAccounts || {};
    
    if (current.tiktokAccounts[account]) {
        delete current.tiktokAccounts[account];
    }
    if (account === 'default' && current.tiktokSessionId) {
        delete current.tiktokSessionId;
    }
    saveConfig(current);
    res.json({ success: true, message: `TikTok-Verbindung für ${account} getrennt.` });
});

app.get('/api/tiktok/status', (req, res) => {
    res.json(tiktokStatus);
});

app.post('/api/tiktok/upload', upload.single('video'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Keine Videodatei hochgeladen.' });
    }
    const account = (req.body.tiktokAccount || 'default').replace(/[^a-zA-Z0-9_]/g, '');
    const config = loadConfig();
    config.tiktokAccounts = config.tiktokAccounts || {};
    
    if (config.tiktokSessionId && !config.tiktokAccounts['default']) {
        config.tiktokAccounts['default'] = config.tiktokSessionId;
    }

    const sessionId = config.tiktokAccounts[account];
    if (!sessionId) {
        try {
            fs.unlinkSync(req.file.path);
        } catch (unlinkErr) {}
        return res.status(400).json({ error: `Keine TikTok SessionID für ${account} konfiguriert.` });
    }

    const videoPath = req.file.path;
    const caption = req.body.caption || '';
    const hashtags = JSON.parse(req.body.hashtags || '[]');
    const autoPublish = req.body.autoPublish === 'true';

    res.json({ success: true, message: 'Upload-Prozess gestartet.' });
    runTikTokUpload(videoPath, caption, hashtags, autoPublish, sessionId);
});

async function runTikTokUpload(videoPath, caption, hashtags, autoPublish, sessionId) {
    let browser = null;
    try {
        updateTiktokStatus('starting', 'Starte Chrome-Instanz auf dem Server...');
        browser = await puppeteerExtra.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage'
            ]
        });

        const page = await browser.newPage();
        await page.bringToFront();
        
        updateTiktokStatus('starting', 'Injiziere Session-Cookie...');
        await page.goto('https://www.tiktok.com', { waitUntil: 'domcontentloaded' });
        
        await page.setCookie(
            {
                name: 'sessionid',
                value: sessionId,
                domain: '.tiktok.com',
                path: '/',
                httpOnly: true,
                secure: true
            },
            {
                name: 'sessionid_ss',
                value: sessionId,
                domain: '.tiktok.com',
                path: '/',
                httpOnly: true,
                secure: true
            }
        );

        updateTiktokStatus('starting', 'Navigiere zu TikTok Studio Upload...');
        await page.goto('https://www.tiktok.com/tiktokstudio/upload', { waitUntil: 'networkidle2' });

        const hasFileInput = await page.$('input[type="file"]');
        if (!hasFileInput) {
            const currentUrl = page.url();
            if (currentUrl.includes('login')) {
                throw new Error('TikTok-Sitzung ist ungültig oder abgelaufen. Bitte erneuere deine SessionID.');
            } else {
                throw new Error('Upload-Feld konnte nicht geladen werden. SessionID prüfen.');
            }
        }

        updateTiktokStatus('uploading', 'Videodatei wird hochgeladen...');
        const fileInput = await page.$('input[type="file"]');
        await fileInput.uploadFile(videoPath);

        updateTiktokStatus('uploading', 'Video hochgeladen. Warte auf Verarbeitung...');
        await page.waitForSelector('div[contenteditable="true"]', { timeout: 300000 });
        
        await new Promise(r => setTimeout(r, 5000));

        updateTiktokStatus('typing', 'Beschreibung und Hashtags werden eingetragen...');
        await page.evaluate(() => {
            const el = document.querySelector('div[contenteditable="true"]');
            if (el) {
                el.focus();
                const range = document.createRange();
                range.selectNodeContents(el);
                const selObj = window.getSelection();
                selObj.removeAllRanges();
                selObj.addRange(range);
                document.execCommand('delete', false, null);
            }
        });

        await new Promise(r => setTimeout(r, 500));

        const fullCaption = `${caption} ${hashtags.map(tag => tag.startsWith('#') ? tag : '#' + tag).join(' ')}`;
        await page.keyboard.type(fullCaption, { delay: 50 });

        if (autoPublish) {
            updateTiktokStatus('posting', 'Bereite Veröffentlichung vor (Warte 15s)...');
            await new Promise(r => setTimeout(r, 15000));

            const postBtn = await page.evaluateHandle(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                return buttons.find(btn => {
                    const txt = btn.textContent.toLowerCase();
                    return txt.includes('post') || txt.includes('veröffentlichen') || txt.includes('teilen') || txt.includes('publish');
                });
            });

            if (postBtn) {
                updateTiktokStatus('posting', 'Klicke auf "Veröffentlichen"...');
                await postBtn.click();
                
                updateTiktokStatus('posting', 'Verarbeitung auf TikTok läuft...');
                await new Promise(r => setTimeout(r, 10000));
                updateTiktokStatus('done', 'Video wurde erfolgreich auf TikTok veröffentlicht!');
            } else {
                throw new Error('Veröffentlichen-Button nicht gefunden.');
            }
        } else {
            updateTiktokStatus('done', 'Video wurde erfolgreich als Entwurf vorbereitet!');
        }

    } catch (err) {
        updateTiktokStatus('error', `Fehler beim Upload: ${err.message}`, err.message);
    } finally {
        try {
            if (fs.existsSync(videoPath)) {
                fs.unlinkSync(videoPath);
            }
        } catch (unlinkErr) {}

        setTimeout(async () => {
            if (browser) {
                try {
                    await browser.close();
                } catch (closeErr) {}
            }
        }, 15000);
    }
}

app.listen(PORT, () => {
    addLog(`🚀 Minus Watchtime Server läuft auf Port ${PORT}`);
    
    // Verwaiste Chrome-Prozesse beim Serverstart bereinigen (verhindert Ressourcen-Lecks)
    const { exec } = require('child_process');
    exec('pkill -f chrome || true', (err) => {
        if (!err) {
            addLog('Alte Chrome-Prozesse erfolgreich bereinigt.');
        }
        
        // Initial metadata check & periodic background metadata refresh
        updateAllChannelsMetadata().catch(() => {});
        setInterval(() => {
            updateAllChannelsMetadata().catch(() => {});
        }, 30000);

        // Auto-start farmer if configured
        try {
            const config = loadConfig();
            const activeAccounts = (config.accounts || []).filter(a => a.active !== false && a.token);
            if (activeAccounts.length > 0 && config.targetChannel) {
                addLog(`Auto-Start: Starte Watchtime-Farmer für ${activeAccounts.length} Account(s)...`);
                startFarmer(config);
            } else {
                addLog('Auto-Start übersprungen: Keine aktiven Accounts oder Kanäle vorhanden.');
            }
        } catch (e) {
            addLog(`Fehler beim Auto-Start des Farmers: ${e.message}`);
        }
    });
});
