require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const SpotifyWebApi = require('spotify-web-api-node');
const { ApiClient } = require('@twurple/api');
const { RefreshingAuthProvider } = require('@twurple/auth');
const { EventSubWsListener } = require('@twurple/eventsub-ws');
const { ChatClient } = require('@twurple/chat');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, '../public')));
app.use('/protected', express.static(path.join(__dirname, '../protected')));
app.use('/index.html', express.static(path.join(__dirname, '../index.html')));

const PORT = process.env.PORT || 4000;

// 1. Firebase Admin Init
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://bingo-overlay-default-rtdb.europe-west1.firebasedatabase.app" // Passe dies ggf. an deine Firebase URL an
});
const db = admin.database();

// 2. Global State
const botInstances = new Map(); // Speichert aktive Listener pro User { uid: { listener, spotifyApi, apiClient } }
let masterBotUserId = null;

// Twitch Auth Provider (zentral)
const authProvider = new RefreshingAuthProvider({
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    onRefresh: async (userId, newTokenData) => {
        if (userId === masterBotUserId) {
            await db.ref('system/master_bot').update(newTokenData);
        }
        // Suche den passenden Firebase Bot-Eintrag für diese Twitch User ID
        const snapshot = await db.ref('bot_instances').once('value');
        snapshot.forEach(child => {
            const botId = child.key;
            const data = child.val();
            if (data.twitch_tokens && data.twitch_tokens.userId === userId) {
                db.ref(`bot_instances/${botId}/twitch_tokens`).update(newTokenData);
            }
        });
    }
});

const centralApiClient = new ApiClient({ authProvider });

// Dedicated AuthProvider for IRC ChatClient (so it doesn't connect anonymously)
const chatAuthProvider = new RefreshingAuthProvider({
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    onRefresh: async (userId, newTokenData) => {
        if (userId === masterBotUserId) {
            await db.ref('system/master_bot').update(newTokenData);
        }
    }
});

let globalChatClient = null;
const pendingChannelsToJoin = new Set();

// Load Master Bot tokens on startup
db.ref('system/master_bot').on('value', async (snap) => {
    const tokens = snap.val();
    if (tokens && tokens.userId) {
        masterBotUserId = tokens.userId;
        await authProvider.addUser(masterBotUserId, tokens);
        console.log(`[Master Bot] Token für zentralen Bot geladen (User ID: ${masterBotUserId})`);

        if (!globalChatClient) {
            try {
                // Den Masterbot explizit für Chat-Intents hinzufügen
                await chatAuthProvider.addUserForToken(tokens, ['chat']);

                globalChatClient = new ChatClient({ 
                    authProvider: chatAuthProvider,
                    channels: Array.from(pendingChannelsToJoin)
                });

                globalChatClient.connect();

                globalChatClient.onConnect(() => console.log('[CHAT DEBUG] Connected to Twitch IRC!'));
                globalChatClient.onJoin((c, u) => console.log(`[CHAT DEBUG] Joined ${c} as ${u}`));
                globalChatClient.onDisconnect((man, reason) => console.log(`[CHAT DEBUG] Disconnected: ${reason}`));

                globalChatClient.onMessage(async (channel, user, text, msg) => {
                    console.log(`[RAW CHAT] #${channel} | ${user}: ${text}`);
                    
                    const channelName = channel.replace('#', '').toLowerCase();
                    const broadcasterId = msg.channelId || msg.tags?.get('room-id') || msg.broadcasterId;
                    const chatterId = msg.userInfo?.userId || msg.userId;
                    const msgText = text || '';

                    console.log(`[CHAT DEBUG] channelName=${channelName}, broadcasterId=${broadcasterId}, chatterId=${chatterId}`);

                    for (const [botId, instance] of botInstances.entries()) {
                        const botUserId = instance.botData?.twitch_tokens?.userId?.toString();
                        const botLogin = instance.botData?.twitch_tokens?.login?.toLowerCase();
                        if (botUserId === broadcasterId?.toString() || botLogin === channelName) {
                            const chatBuffers = instance.chatBuffers || new Map();
                            instance.chatBuffers = chatBuffers;

                            const msgObj = { text: msgText, timestamp: Date.now() };
                            if (!chatBuffers.has(chatterId)) {
                                chatBuffers.set(chatterId, []);
                            }
                            const buffer = chatBuffers.get(chatterId);
                            buffer.push(msgObj);
                            if (buffer.length > 5) buffer.shift();

                            const type = instance.type;
                            const botData = instance.botData;
                            
                            if (type === 'spotify' && botData.config?.allowTestsong) {
                                const cleanMsg = msgText.trim();
                                if (cleanMsg.toLowerCase().startsWith("!testsong ")) {
                                    console.log(`[DEBUG_CHAT] Chat message from ${chatterId} in ${botId}: ${cleanMsg}`);
                                    try {
                                        const config = botData.config;
                                        if (config.testsongPermission === 'mods') {
                                            const isBroadcaster = (broadcasterId === chatterId) || (botUserId === chatterId);
                                            let isMod = isBroadcaster || msg.userInfo?.isMod || msg.tags?.get('badges')?.includes('moderator') || msg.tags?.get('badges')?.includes('broadcaster');
                                            if (!isMod) continue;
                                        }
                                    } catch(e) {}

                                    const query = cleanMsg.substring(10).trim();
                                    if (query && instance.processSongRequest) {
                                        await instance.processSongRequest(query, msg.userInfo?.displayName || user);
                                    }
                                }
                            }
                        }
                    }
                });

                pendingChannelsToJoin.clear();
            } catch(e) {
                console.error("Fehler beim Starten von ChatClient:", e);
            }
        }
    }
});

const centralListener = new EventSubWsListener({ apiClient: centralApiClient });
try {
    centralListener.start();
    console.log("🚀 Zentraler Twurple EventSub WebSocket Listener gestartet");
} catch (err) {
    console.error("❌ Fehler beim Starten des zentralen EventSub Listeners:", err.message);
}

async function fetchAndSaveModeratedChannels(botId, userId, accessToken) {
    try {
        console.log(`[ModLog] Rufe moderierte Kanäle ab für ${userId} (Bot ${botId})`);
        let allChannels = [];
        let cursor = '';
        
        do {
            const url = `https://api.twitch.tv/helix/moderation/channels?user_id=${userId}&first=100` + (cursor ? `&after=${cursor}` : '');
            const res = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Client-Id': process.env.TWITCH_CLIENT_ID
                }
            });
            const body = await res.json();
            if (!res.ok) {
                throw new Error(JSON.stringify(body));
            }
            if (body.data) {
                allChannels.push(...body.data.map(chan => ({
                    id: chan.broadcaster_id,
                    name: chan.broadcaster_login,
                    displayName: chan.broadcaster_name
                })));
            }
            cursor = body.pagination?.cursor;
        } while (cursor);

        await db.ref(`bot_instances/${botId}/moderated_channels`).set(allChannels);
        console.log(`[ModLog] ${allChannels.length} moderierte Kanäle für ${botId} in Firebase gespeichert.`);
    } catch (e) {
        console.error(`[ModLog] Fehler beim Laden der moderierten Kanäle für Bot ${botId}:`, e.message);
    }
}

// 3. OAuth Routes für das Dashboard
app.get('/bot/auth/masterbot', (req, res) => {
    const scopes = ['user:write:chat', 'user:read:chat', 'chat:read', 'chat:edit'];
    const url = `https://id.twitch.tv/oauth2/authorize?client_id=${process.env.TWITCH_CLIENT_ID}&redirect_uri=${process.env.TWITCH_REDIRECT_URI}&response_type=code&scope=${scopes.join('%20')}&state=masterbot&force_verify=true`;
    res.redirect(url);
});

app.get('/bot/auth/twitch', (req, res) => {
    const { botId } = req.query;
    if (!botId) return res.status(400).send("Missing Bot ID");
    const scopes = [
        'channel:read:redemptions',
        'user:read:chat',
        'user:write:chat',
        'channel:moderate',
        'user:read:moderated_channels',
        'moderator:read:banned_users',
        'moderator:read:chat_messages',
        'moderator:read:chat_settings',
        'moderator:read:moderators',
        'moderator:read:vips',
        'moderator:read:unban_requests',
        'moderator:read:blocked_terms',
        'moderator:read:warnings'
    ];
    const url = `https://id.twitch.tv/oauth2/authorize?client_id=${process.env.TWITCH_CLIENT_ID}&redirect_uri=${process.env.TWITCH_REDIRECT_URI}&response_type=code&scope=${scopes.join('%20')}&state=${botId}&force_verify=true`;
    res.redirect(url);
});

app.get('/bot/auth/twitch/callback', async (req, res) => {
    const { code, state: botId } = req.query;
    try {
        const response = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&code=${code}&grant_type=authorization_code&redirect_uri=${process.env.TWITCH_REDIRECT_URI}`, { method: 'POST' });
        const data = await response.json();
        
        if (!data.access_token) {
            throw new Error(`Twitch hat den Code abgelehnt: ${JSON.stringify(data)}`);
        }

        // Hole User Info
        const userRes = await fetch('https://api.twitch.tv/helix/users', {
            headers: { 'Authorization': `Bearer ${data.access_token}`, 'Client-Id': process.env.TWITCH_CLIENT_ID }
        });
        const userData = await userRes.json();
        
        if (!userData || !userData.data || userData.data.length === 0) {
            throw new Error(`Konnte Twitch User Profil nicht laden: ${JSON.stringify(userData)}`);
        }
        
        const userId = userData.data[0].id;
        const loginName = userData.data[0].login;

        const tokens = {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresIn: data.expires_in,
            obtainmentTimestamp: Date.now(),
            scope: data.scope,
            userId: userId,
            login: loginName
        };

        if (botId === 'masterbot') {
            await db.ref('system/master_bot').set(tokens);
            return res.send("<h1 style='color:green;font-family:sans-serif;'>Master Bot erfolgreich verbunden!</h1><p style='font-family:sans-serif;'>Die Tokens wurden in Firebase gespeichert. Du kannst dieses Fenster nun schliessen.</p>");
        }

        const botSnap = await db.ref('bot_instances').once('value');
        const updates = {};
        updates[`bot_instances/${botId}/config/twitchConnected`] = true;
        updates[`bot_instances/${botId}/twitch_tokens`] = tokens;
        
        botSnap.forEach(child => {
            if (child.key !== botId && child.val().twitch_tokens?.userId === userId) {
                updates[`bot_instances/${child.key}/twitch_tokens`] = tokens;
                updates[`bot_instances/${child.key}/config/twitchConnected`] = true;
            }
        });
        await db.ref().update(updates);

        // Fetch moderated channels immediately
        await fetchAndSaveModeratedChannels(botId, userId, data.access_token);

        // Get bot type to determine redirect page
        const botMetaSnap = await db.ref(`bot_instances/${botId}/meta`).once('value');
        const botMeta = botMetaSnap.val() || {};
        const botType = botMeta.type || 'spotify';

        if (botType === 'mod_tracker') {
            res.redirect(`https://minusnd.de/public/bot-setup-mod.html?botId=${botId}&success=twitch`);
        } else {
            res.redirect(`https://minusnd.de/public/bot-setup.html?botId=${botId}&success=twitch`);
        }
    } catch (error) {
        console.error('Error in Twitch OAuth callback:', error.response ? error.response.data : error.message);
        res.status(500).send("Authentifizierungsfehler");
    }
});

app.get('/bot/auth/spotify', (req, res) => {
    const { botId } = req.query;
    if (!botId) return res.status(400).send("Missing Bot ID");
    const spotifyApi = new SpotifyWebApi({
        clientId: process.env.SPOTIFY_CLIENT_ID,
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
        redirectUri: process.env.SPOTIFY_REDIRECT_URI
    });
    const url = spotifyApi.createAuthorizeURL(['user-modify-playback-state', 'user-read-playback-state'], botId, true); // true = showDialog
    res.redirect(url);
});

app.get('/bot/auth/spotify/callback', async (req, res) => {
    const { code, state: botId } = req.query;
    const spotifyApi = new SpotifyWebApi({
        clientId: process.env.SPOTIFY_CLIENT_ID,
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
        redirectUri: process.env.SPOTIFY_REDIRECT_URI
    });
    try {
        const data = await spotifyApi.authorizationCodeGrant(code);
        const tokens = {
            access_token: data.body.access_token,
            refresh_token: data.body.refresh_token,
            expires_at: Date.now() + data.body.expires_in * 1000
        };

        // Debug: Log info of the authorized user
        try {
            console.log(`[Spotify OAuth] Fetching profile for new token on bot ${botId}...`);
            const meRes = await fetch("https://api.spotify.com/v1/me", {
                headers: { "Authorization": `Bearer ${tokens.access_token}` }
            });
            console.log(`[Spotify OAuth] Status: ${meRes.status}`);
            const meBody = await meRes.text();
            console.log(`[Spotify OAuth] Body: ${meBody}`);
        } catch (err) {
            console.error(`[Spotify OAuth] Failed to fetch profile:`, err.message);
        }

        const updates = {};
        updates[`bot_instances/${botId}/config/spotifyConnected`] = true;
        updates[`bot_instances/${botId}/spotify_tokens`] = tokens;
        await db.ref().update(updates);

        // Redirect back to the setup page
        res.redirect(`https://minusnd.de/public/bot-setup.html?botId=${botId}&success=spotify`);
    } catch (error) {
        console.error('Error in Spotify callback:', error);
        res.status(500).send("Authentifizierungsfehler");
    }
});


// 3.5. Scoreboard Moderator API
app.post('/bot/api/scoreboard/validate', async (req, res) => {
    const { streamId, token } = req.body;
    if (!streamId || !token) {
        return res.status(400).json({ error: "Missing parameters" });
    }
    try {
        const guestTokenSnap = await db.ref(`streams/${streamId}/meta/guestToken`).once('value');
        if (guestTokenSnap.exists() && guestTokenSnap.val() === token) {
            return res.json({ valid: true });
        }
        const guestToken2v2v2Snap = await db.ref(`streams/${streamId}/meta/guestToken2v2v2`).once('value');
        if (guestToken2v2v2Snap.exists() && guestToken2v2v2Snap.val() === token) {
            return res.json({ valid: true });
        }
        res.json({ valid: false });
    } catch (err) {
        console.error("Scoreboard validation API error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/bot/api/scoreboard/update', async (req, res) => {
    const { streamId, token, path: dbPath, value } = req.body;
    if (!streamId || !token) {
        return res.status(400).json({ error: "Missing parameters" });
    }
    try {
        // 1. Verify guestToken (support both standard and 2v2v2 tokens)
        const guestTokenSnap = await db.ref(`streams/${streamId}/meta/guestToken`).once('value');
        const guestToken2v2v2Snap = await db.ref(`streams/${streamId}/meta/guestToken2v2v2`).once('value');
        
        let isValid = false;
        if (guestTokenSnap.exists() && guestTokenSnap.val() === token) {
            isValid = true;
        } else if (guestToken2v2v2Snap.exists() && guestToken2v2v2Snap.val() === token) {
            isValid = true;
        }
        
        if (!isValid) {
            return res.status(403).json({ error: "Invalid token" });
        }
        
        // 2. Perform write
        // Restrict writes to only paths under data/
        const cleanPath = String(dbPath || "").replace(/^\/+|\/+$/g, "");
        if (cleanPath.startsWith("meta") || cleanPath.includes("..")) {
            return res.status(400).json({ error: "Invalid path" });
        }
        
        const targetRef = db.ref(`streams/${streamId}/data`).child(cleanPath);
        if (value === null) {
            await targetRef.remove();
        } else {
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                // If it is an object (but not an array), update it
                await targetRef.update(value);
            } else {
                await targetRef.set(value);
            }
        }
        
        // Also update the updatedAt timestamp
        await db.ref(`streams/${streamId}/data/updatedAt`).set(Date.now());
        
        res.json({ success: true });
    } catch (err) {
        console.error("Scoreboard update API error:", err);
        res.status(500).json({ error: err.message });
    }
});


// 4. Bot Core Logic (Start/Stop per User)
function shouldBotRun(botData) {
    const config = botData.config || {};
    const type = botData.meta?.type || 'spotify';
    if (type === 'mod_tracker') {
        return !!(config.isActive && config.twitchConnected);
    }
    // Default to 'spotify' - start even if rewardTitle is not yet set (allows chat command testing)
    return !!(config.isActive && config.twitchConnected && config.spotifyConnected);
}

async function startBotInstance(botId, botData) {
    if (botInstances.has(botId)) return; // Schon aktiv
    
    const config = botData.config || {};
    const newHash = JSON.stringify(config) + JSON.stringify(botData.twitch_tokens || {}) + JSON.stringify(botData.spotify_tokens || {});
    const type = botData.meta?.type || 'spotify';
    
    console.log(`Starte Bot-Instanz ${botId} (${botData.meta?.name || botId}) vom Typ ${type}`);

    const instance = {
        hash: newHash,
        type: type,
        botData: botData,
        chatBuffers: new Map(),
        subscriptions: [],
        playbackInterval: null,
        commandsRef: null,
        commandsListener: null
    };
    botInstances.set(botId, instance);

    try {
        // Twitch Setup
        await authProvider.addUser(botData.twitch_tokens.userId, botData.twitch_tokens);

        // Join IRC Channel
        let channelName = botData.twitch_tokens.login;
        if (!channelName) {
            try {
                const twitchUser = await centralApiClient.users.getUserById(botData.twitch_tokens.userId);
                if (twitchUser) {
                    channelName = twitchUser.name;
                    botData.twitch_tokens.login = channelName;
                    await db.ref(`bot_instances/${botId}/twitch_tokens/login`).set(channelName);
                }
            } catch(e) {}
        }
        if (channelName) {
            if (globalChatClient) {
                globalChatClient.join(channelName);
                console.log(`[CHAT] Joined channel #${channelName} for bot ${botId}`);
            } else {
                pendingChannelsToJoin.add(channelName);
                console.log(`[CHAT] Queued channel #${channelName} for bot ${botId}`);
            }
        }

        // Fetch moderated channels and save to Firebase (only for mod tracker)
        if (type === 'mod_tracker') {
            try {
                const tokenData = await authProvider.getAccessTokenForUser(botData.twitch_tokens.userId);
                if (tokenData && tokenData.accessToken) {
                    await fetchAndSaveModeratedChannels(botId, botData.twitch_tokens.userId, tokenData.accessToken);
                }
            } catch (e) {
                console.error(`[ModLog] Fehler beim Laden der moderierten Kanäle beim Botstart für Bot ${botId}:`, e.message);
            }
        }

        // EventSub chat buffer is replaced by IRC ChatClient above.

        // processSongRequest definition (only for spotify bots)
        let processSongRequest = null;
        if (type === 'spotify') {
            const spotifyApi = new SpotifyWebApi({
                clientId: process.env.SPOTIFY_CLIENT_ID,
                clientSecret: process.env.SPOTIFY_CLIENT_SECRET
            });
            instance.spotifyApi = spotifyApi;

            instance.processSongRequest = async (query, userDisplayName, event = null) => {
                // Aktuelle Config neu laden (für Live-Änderungen an requestsStopped)
                const configSnap = await db.ref(`bot_instances/${botId}/config`).once('value');
                const currentConfig = configSnap.val() || botData.config;
                
                if (currentConfig.requestsStopped) {
                    console.log(`STOP aktiv: Songwunsch ignoriert für ${botId}`);
                    return;
                }

                // Offline-Schutz Prüfung
                if (currentConfig.onlyWhenLive) {
                    try {
                        const stream = await centralApiClient.streams.getStreamByUserId(botData.twitch_tokens.userId);
                        if (!stream) {
                            console.log(`Offline-Schutz aktiv: Stream ${botData.twitch_tokens.userId} ist offline. Songwunsch ignoriert.`);
                            if (event && typeof event.updateStatus === 'function') {
                                try {
                                    await event.updateStatus('CANCELED');
                                    console.log(`Twitch Punkte zurückerstattet.`);
                                } catch (err) {
                                    console.error(`Fehler bei Punkte-Rückerstattung:`, err.message);
                                }
                            }
                            return;
                        }
                    } catch (err) {
                        console.error(`Fehler bei der Twitch Stream Statusprüfung für ${botId}:`, err);
                    }
                }

                const cleanQuery = query.trim().replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '');
                if (!cleanQuery) return;

                const now = Date.now();
                if (cleanQuery === instance.lastRequestQuery && (now - instance.lastRequestTime) < 5000) {
                    console.log(`Dublette ignoriert für ${botId}: ${cleanQuery}`);
                    return;
                }
                instance.lastRequestTime = now;
                instance.lastRequestQuery = cleanQuery;

                console.log(`Songwunsch von ${userDisplayName}: ${cleanQuery}`);

                try {
                    // Spotify Tokens erneuern falls nötig
                    const tokensSnap = await db.ref(`bot_instances/${botId}/spotify_tokens`).once('value');
                    const tokens = tokensSnap.val();
                    if (!tokens) return;
                    
                    spotifyApi.setAccessToken(tokens.access_token);
                    spotifyApi.setRefreshToken(tokens.refresh_token);

                    if (Date.now() > tokens.expires_at) {
                        const data = await spotifyApi.refreshAccessToken();
                        tokens.access_token = data.body.access_token;
                        tokens.expires_at = Date.now() + data.body.expires_in * 1000;
                        await db.ref(`bot_instances/${botId}/spotify_tokens`).set(tokens);
                        spotifyApi.setAccessToken(data.body.access_token);
                    }

                    // Song suchen und abspielen
                    let trackUri = null;
                    let trackTitle = "";
                    let trackArtist = "";
                    const uriMatch = cleanQuery.match(/spotify:track:([a-zA-Z0-9]{22})/i) || cleanQuery.match(/track\/([a-zA-Z0-9]{22})/i);
                    
                    if (uriMatch) {
                        const trackId = uriMatch[1];
                        trackUri = `spotify:track:${trackId}`;
                        if (currentConfig.chatConfirmation) {
                            try {
                                const trackData = await spotifyApi.getTrack(trackId);
                                if (trackData.body) {
                                    trackTitle = trackData.body.name;
                                    trackArtist = trackData.body.artists.map(a => a.name).join(', ');
                                }
                            } catch (e) {}
                        }
                    } else {
                        const searchRes = await spotifyApi.searchTracks(cleanQuery);
                        if (searchRes.body.tracks.items.length > 0) {
                             const trackItem = searchRes.body.tracks.items[0];
                             trackUri = trackItem.uri;
                             trackTitle = trackItem.name;
                             trackArtist = trackItem.artists.map(a => a.name).join(', ');
                        }
                    }

                    if (trackUri) {
                        const isPlaying = instance.currentPlayback?.isPlaying || false;
                        
                        if (isPlaying && !currentConfig.playImmediately) {
                            await spotifyApi.addToQueue(trackUri);
                        } else {
                            await spotifyApi.play({ uris: [trackUri] });
                        }

                        // Erfolgreich!
                        if (currentConfig.chatConfirmation && trackTitle && trackArtist) {
                            try {
                                const senderId = masterBotUserId || botData.twitch_tokens.userId;
                                const userMention = userDisplayName ? ` (@${userDisplayName})` : '';
                                const msgText = `🎵 Songwunsch hinzugefügt: ${trackTitle} - ${trackArtist}${userMention}`;
                                
                                if (senderId !== botData.twitch_tokens.userId) {
                                    await centralApiClient.asUser(senderId, async ctx => {
                                        await ctx.chat.sendChatMessage(botData.twitch_tokens.userId, msgText);
                                    });
                                } else {
                                    await centralApiClient.chat.sendChatMessage(botData.twitch_tokens.userId, msgText);
                                }
                            } catch(e) {
                                console.error("Fehler beim Senden der Chat-Nachricht:", e.message);
                            }
                        }

                        if (event && typeof event.updateStatus === 'function') {
                            try { await event.updateStatus('FULFILLED'); } catch (e) {}
                        }
                    } else {
                        console.log(`Song nicht gefunden für ${botId}: ${cleanQuery}. Erstatte Punkte.`);
                        if (event && typeof event.updateStatus === 'function') {
                            try { await event.updateStatus('CANCELED'); } catch (e) {}
                        }
                    }
                } catch (err) {
                    console.error(`Spotify Action Error für ${botId}:`, err);
                    if (event && typeof event.updateStatus === 'function') {
                        try { await event.updateStatus('CANCELED'); } catch (e) {}
                    }
                }
            };

            // Kanalpunkte Listener
            const targetTitle = (botData.config.rewardTitle || "").trim().toLowerCase();
            const subRedemption = centralListener.onChannelRedemptionAdd(botData.twitch_tokens.userId, async (event) => {
                if (event.rewardTitle.trim().toLowerCase() !== targetTitle) return;
                
                const query = (event.input || event.userInput || "").trim();
                if (!query) return;

                await instance.processSongRequest(query, event.userDisplayName, event);
            });
            instance.subscriptions.push(subRedemption);
        }

        // Moderation Events (Bans / Timeouts / Deletions) - runs ONLY for mod_tracker
        if (type === 'mod_tracker') {
            const handleModerateEvent = async (event, defaultChannelName) => {
                if (event.moderationAction !== 'ban' && event.moderationAction !== 'timeout' && event.moderationAction !== 'delete') {
                    return; // Ignoriere andere Aktionen wie slow, warn, slowoff, etc.
                }
                try {
                    const targetId = event.userId;
                    const buffer = instance.chatBuffers.get(targetId) || [];
                    const lastMsg = buffer.length > 0 ? buffer[buffer.length - 1] : null;
                    
                    let duration = null;
                    if (event.moderationAction === 'timeout' && event.expiryDate) {
                        duration = Math.round((event.expiryDate.getTime() - Date.now()) / 1000);
                    }

                    const logData = {
                        timestamp: Date.now(),
                        action: event.moderationAction, // 'ban', 'timeout' or 'delete'
                        targetUserId: event.userId || "",
                        targetUserName: event.userName || "",
                        targetUserDisplayName: event.userDisplayName || "",
                        moderatorId: event.moderatorId || "",
                        moderatorName: event.moderatorName || "",
                        moderatorDisplayName: event.moderatorDisplayName || "",
                        reason: event.reason || "",
                        duration: duration,
                        triggerMessage: lastMsg ? lastMsg.text : "",
                        triggerMessageTimestamp: lastMsg ? lastMsg.timestamp : null,
                        channelName: event.broadcasterName || event.broadcasterDisplayName || defaultChannelName || ""
                    };

                    await db.ref(`bot_instances/${botId}/mod_logs`).push(logData);
                    console.log(`[ModLog] logged ${logData.action} in #${logData.channelName} against ${logData.targetUserDisplayName} by ${logData.moderatorDisplayName}`);
                } catch (err) {
                    console.error("Fehler beim Speichern des Moderations-Logs:", err);
                }
            };

            const subModSelf = centralListener.onChannelModerate(botData.twitch_tokens.userId, botData.twitch_tokens.userId, async (event) => {
                await handleModerateEvent(event, botData.meta?.name || botData.twitch_tokens.userId);
            });
            instance.subscriptions.push(subModSelf);

            // Drittkanäle Überwachung (Co-Moderation)
            const trackedChannelsStr = botData.config?.trackedChannels || "";
            const trackedNames = trackedChannelsStr
                .split(',')
                .map(n => n.trim().toLowerCase())
                .filter(n => n && n !== "");

            if (trackedNames.length > 0) {
                try {
                    console.log(`[ModLog] Löse Drittkanäle für Bot ${botId} auf:`, trackedNames);
                    const users = await centralApiClient.users.getUsersByNames(trackedNames);
                    
                    for (const user of users) {
                        // Verhindere doppeltes Abonnieren des eigenen Kanals
                        if (user.id === botData.twitch_tokens.userId) continue;

                        try {
                            console.log(`[ModLog] Abonniere Drittkanal: #${user.displayName} (${user.id})`);
                            
                            const subTrackedChat = centralListener.onChannelChatMessage(user.id, botData.twitch_tokens.userId, async (event) => {
                                const chatterId = event.chatterId;
                                const msgObj = { text: event.messageText, timestamp: Date.now() };
                                if (!instance.chatBuffers.has(chatterId)) {
                                    instance.chatBuffers.set(chatterId, []);
                                }
                                const buffer = instance.chatBuffers.get(chatterId);
                                buffer.push(msgObj);
                                if (buffer.length > 5) {
                                    buffer.shift();
                                }
                            });
                            instance.subscriptions.push(subTrackedChat);

                            const subTrackedMod = centralListener.onChannelModerate(user.id, botData.twitch_tokens.userId, async (event) => {
                                await handleModerateEvent(event, user.displayName);
                            });
                            instance.subscriptions.push(subTrackedMod);
                        } catch (chanErr) {
                            console.error(`[ModLog] Fehler beim Abonnieren von Drittkanal #${user.displayName}:`, chanErr.message);
                        }
                    }
                } catch (err) {
                    console.error(`[ModLog] Fehler beim Auflösen der Drittkanäle für Bot ${botId}:`, err.message);
                }
            }
        }

        // Spotify features only for type === 'spotify'
        if (type === 'spotify') {
            const spotifyApi = instance.spotifyApi;
            let isStreamLive = false;
            let nextAllowedPollTime = 0;

            const checkStreamStatus = async () => {
                try {
                    const stream = await centralApiClient.streams.getStreamByUserId(botData.twitch_tokens.userId);
                    isStreamLive = !!stream;
                } catch (err) {
                    console.error(`[Spotify Bot] Fehler bei Twitch-Statusprüfung für ${botId}:`, err.message);
                    isStreamLive = false; // Safe fallback on error
                }
            };

            // Run initial check immediately
            await checkStreamStatus();

            // Check live status every 2 minutes (120000ms)
            instance.liveCheckInterval = setInterval(checkStreamStatus, 120000);

            const pollSpotifyPlayback = async () => {
                if (!isStreamLive) return; // Skip polling if streamer is offline
                if (Date.now() < nextAllowedPollTime) return; // Skip polling if rate-limit back-off is active

                try {
                    // Token prüfen
                    const tokensSnap = await db.ref(`bot_instances/${botId}/spotify_tokens`).once('value');
                    const tks = tokensSnap.val();
                    if (!tks) return;
                    
                    spotifyApi.setAccessToken(tks.access_token);
                    spotifyApi.setRefreshToken(tks.refresh_token);
                    if (Date.now() > tks.expires_at) {
                        const data = await spotifyApi.refreshAccessToken();
                        tks.access_token = data.body.access_token;
                        tks.expires_at = Date.now() + data.body.expires_in * 1000;
                        await db.ref(`bot_instances/${botId}/spotify_tokens`).set(tks);
                        spotifyApi.setAccessToken(tks.access_token);
                    }

                    const pb = await spotifyApi.getMyCurrentPlaybackState();
                    if (pb.body && pb.body.item) {
                        const track = pb.body.item;
                        instance.currentPlayback = {
                            title: track.name,
                            artist: track.artists.map(a => a.name).join(', '),
                            image: track.album.images[0]?.url || "",
                            isPlaying: pb.body.is_playing
                        };
                        await db.ref(`bot_instances/${botId}/playback`).set(instance.currentPlayback);
                    } else {
                        instance.currentPlayback = null;
                        await db.ref(`bot_instances/${botId}/playback`).set(null);
                    }
                } catch (e) {
                    // Handle 429 rate limiting
                    if (e.statusCode === 429 || (e.headers && e.headers['retry-after']) || (e.response && e.response.headers && e.response.headers['retry-after'])) {
                        const retryHeader = e.headers?.['retry-after'] || e.response?.headers?.['retry-after'] || '60';
                        const retryAfter = parseInt(retryHeader, 10);
                        console.warn(`[Spotify Rate Limit] Bot ${botId} (User ID ${botData.twitch_tokens.userId}) got 429. Pausing polling for ${retryAfter}s.`);
                        nextAllowedPollTime = Date.now() + (retryAfter + 5) * 1000;
                        instance.currentPlayback = null;
                        // Set playback to null to avoid displaying stale content during block
                        await db.ref(`bot_instances/${botId}/playback`).set(null).catch(() => {});
                    }
                    // Fehler leise ignorieren, um Log-Spam zu verhindern (z.B. bei 401)
                }
            };

            // Spotify Wiedergabe-Anzeige (Polling alle 60s)
            instance.playbackInterval = setInterval(pollSpotifyPlayback, 60000);

            // Kommandos aus dem Dashboard empfangen (z.B. Skip)
            instance.commandsRef = db.ref(`bot_instances/${botId}/commands`);
            instance.commandsListener = instance.commandsRef.on('child_added', async (snap) => {
                const cmd = snap.val();
                if (cmd && cmd.action) {
                    try {
                        if (cmd.action === 'skip') {
                            await spotifyApi.skipToNext();
                            console.log(`Spotify: Skip ausgeführt für ${botId}`);
                        } else if (cmd.action === 'previous') {
                            await spotifyApi.skipToPrevious();
                            console.log(`Spotify: Previous ausgeführt für ${botId}`);
                        } else if (cmd.action === 'pause') {
                            await spotifyApi.pause();
                            console.log(`Spotify: Pause ausgeführt für ${botId}`);
                        } else if (cmd.action === 'play') {
                            await spotifyApi.play();
                            console.log(`Spotify: Play ausgeführt für ${botId}`);
                        }
                        // Poll immediately after a brief delay (1 second) to allow Spotify to update state
                        setTimeout(pollSpotifyPlayback, 1000);
                    } catch (e) {
                        console.error(`${cmd.action} Error:`, e.message);
                    }
                }
                snap.ref.remove(); // Befehl konsumieren
            });
        }

    } catch (err) {
        console.error(`Fehler beim Starten des Bots ${botId}:`, err);
        await db.ref(`bot_instances/${botId}/config`).update({ isActive: false });
        stopBotInstance(botId);
    }
}

async function stopBotInstance(botId) {
    if (!botInstances.has(botId)) return;
    console.log(`Stoppe Bot-Instanz ${botId}`);
    
    const instance = botInstances.get(botId);
    try {
        if (instance.subscriptions) {
            for (const sub of instance.subscriptions) {
                try {
                    await sub.stop();
                } catch (e) {
                    console.error(`[EventSub] Fehler beim Beenden eines Abonnements für Bot ${botId}:`, e.message);
                }
            }
            instance.subscriptions = [];
        }
        if (instance.playbackInterval) clearInterval(instance.playbackInterval);
        if (instance.liveCheckInterval) clearInterval(instance.liveCheckInterval);
        if (instance.commandsRef && instance.commandsListener) {
            instance.commandsRef.off('child_added', instance.commandsListener);
        }
    } catch (e) {}
    
    botInstances.delete(botId);
}

// 5. Firebase Listener Concurrency Serialization
const botOperations = new Map(); // Promise-Kette pro botId, um Race-Conditions bei Restarts zu vermeiden

function queueBotOperation(botId, operationFn) {
    if (!botOperations.has(botId)) {
        botOperations.set(botId, Promise.resolve());
    }
    const currentChain = botOperations.get(botId);
    const nextChain = currentChain.then(async () => {
        try {
            await operationFn();
        } catch (err) {
            console.error(`[Queue] Fehler bei Bot-Operation für ${botId}:`, err);
        }
    }).catch(err => {
        console.error(`[Queue] Unbehandelter Fehler bei Bot-Operation für ${botId}:`, err);
    });
    botOperations.set(botId, nextChain);
    return nextChain;
}

db.ref('bot_instances').on('child_added', (snap) => {
    const botId = snap.key;
    const botData = snap.val();
    queueBotOperation(botId, async () => {
        if (shouldBotRun(botData)) {
            await startBotInstance(botId, botData);
        }
    });
});

db.ref('bot_instances').on('child_changed', (snap) => {
    const botId = snap.key;
    const botData = snap.val();
    const config = botData.config || {};
    
    // Prüfe ob sich wirklich config oder tokens geändert haben (um endlose Restarts durch Playback-Updates zu vermeiden)
    const newHash = JSON.stringify(config) + JSON.stringify(botData.twitch_tokens || {}) + JSON.stringify(botData.spotify_tokens || {});
    
    queueBotOperation(botId, async () => {
        const instance = botInstances.get(botId);
        
        if (instance && instance.hash === newHash) {
            return; // Nur Playback oder State hat sich geändert, kein Restart nötig!
        }
        
        if (shouldBotRun(botData)) {
            // Neu starten
            await stopBotInstance(botId);
            await startBotInstance(botId, botData);
        } else {
            await stopBotInstance(botId);
        }
    });
});

db.ref('bot_instances').on('child_removed', (snap) => {
    const botId = snap.key;
    queueBotOperation(botId, async () => {
        await stopBotInstance(botId);
    });
});

// Modstats API summary endpoint
app.get('/api/modstats/summary', async (req, res) => {
    const { broadcaster_id, channel, botId, from, to } = req.query;
    try {
        let targetBotId = botId;

        // If no botId is provided, try to find the bot based on broadcaster_id or channel name
        if (!targetBotId) {
            const botsSnap = await db.ref('bot_instances').once('value');
            botsSnap.forEach(snap => {
                const botData = snap.val();
                if (botData.meta?.type === 'mod_tracker') {
                    if (broadcaster_id && botData.twitch_tokens?.userId === broadcaster_id) {
                        targetBotId = snap.key;
                    } else if (channel) {
                        const chanLower = channel.toLowerCase();
                        const tracked = (botData.config?.trackedChannels || "")
                            .split(',')
                            .map(c => c.trim().toLowerCase());
                        const mainChan = botData.twitch_tokens?.userName?.toLowerCase() || "";
                        if (mainChan === chanLower || tracked.includes(chanLower)) {
                            targetBotId = snap.key;
                        }
                    } else if (!broadcaster_id && !channel) {
                        if (!targetBotId) {
                            targetBotId = snap.key;
                        }
                    }
                }
            });
        }

        if (!targetBotId) {
            return res.status(404).json({ error: "No mod tracker bot found for the specified channel/broadcaster ID." });
        }

        const logsSnap = await db.ref(`bot_instances/${targetBotId}/mod_logs`).once('value');
        const logs = logsSnap.val() || {};

        const modStats = {}; // moderatorUserId -> { moderatorName, timeouts: 0, bans: 0, deletes: 0 }

        const fromTime = from ? new Date(from).getTime() : 0;
        const toTime = to ? new Date(to).getTime() : Infinity;
        const targetChannelLower = channel ? channel.toLowerCase() : null;

        Object.values(logs).forEach(log => {
            const logTime = log.timestamp || 0;
            if (logTime < fromTime || logTime > toTime) return;

            // Optional channel filter
            if (targetChannelLower) {
                const logChanLower = (log.channelName || "").toLowerCase();
                if (logChanLower !== targetChannelLower) return;
            }

            const modId = log.moderatorId || log.moderatorName || "Unknown";
            const modName = log.moderatorDisplayName || log.moderatorName || "Unknown";

            if (!modStats[modId]) {
                modStats[modId] = {
                    moderatorId: modId,
                    moderatorName: modName,
                    timeouts: 0,
                    bans: 0,
                    deletes: 0,
                    channels: []
                };
            }

            if (log.channelName) {
                const chanLower = log.channelName.toLowerCase();
                if (!modStats[modId].channels.includes(chanLower)) {
                    modStats[modId].channels.push(chanLower);
                }
            }

            if (log.action === 'ban') {
                modStats[modId].bans++;
            } else if (log.action === 'timeout') {
                modStats[modId].timeouts++;
            } else if (log.action === 'delete') {
                modStats[modId].deletes++;
            }
        });

        // Convert to array and sort by total actions descending
        const sortedMods = Object.values(modStats).sort((a, b) => {
            const totalA = a.timeouts + a.bans + a.deletes;
            const totalB = b.timeouts + b.bans + b.deletes;
            return totalB - totalA;
        });

        res.json({ moderators: sortedMods });
    } catch (error) {
        console.error("Error in /api/modstats/summary:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Modstats API detail endpoint
app.get('/api/modstats/detail', async (req, res) => {
    const { broadcaster_id, channel, botId, from, to, moderator } = req.query;
    if (!moderator) {
        return res.status(400).json({ error: "Missing required parameter 'moderator'" });
    }
    try {
        let targetBotId = botId;

        // If no botId is provided, try to find the bot based on broadcaster_id or channel name
        if (!targetBotId) {
            const botsSnap = await db.ref('bot_instances').once('value');
            botsSnap.forEach(snap => {
                const botData = snap.val();
                if (botData.meta?.type === 'mod_tracker') {
                    if (broadcaster_id && botData.twitch_tokens?.userId === broadcaster_id) {
                        targetBotId = snap.key;
                    } else if (channel) {
                        const chanLower = channel.toLowerCase();
                        const tracked = (botData.config?.trackedChannels || "")
                            .split(',')
                            .map(c => c.trim().toLowerCase());
                        const mainChan = botData.twitch_tokens?.userName?.toLowerCase() || "";
                        if (mainChan === chanLower || tracked.includes(chanLower)) {
                            targetBotId = snap.key;
                        }
                    } else if (!broadcaster_id && !channel) {
                        if (!targetBotId) {
                            targetBotId = snap.key;
                        }
                    }
                }
            });
        }

        if (!targetBotId) {
            return res.status(404).json({ error: "No mod tracker bot found for the specified channel/broadcaster ID." });
        }

        const logsSnap = await db.ref(`bot_instances/${targetBotId}/mod_logs`).once('value');
        const logs = logsSnap.val() || {};

        const fromTime = from ? new Date(from).getTime() : 0;
        const toTime = to ? new Date(to).getTime() : Infinity;
        const targetChannelLower = channel ? channel.toLowerCase() : null;
        const targetModLower = moderator.toLowerCase();

        const filteredLogs = [];

        Object.values(logs).forEach(log => {
            const logTime = log.timestamp || 0;
            if (logTime < fromTime || logTime > toTime) return;

            // Optional channel filter
            if (targetChannelLower) {
                const logChanLower = (log.channelName || "").toLowerCase();
                if (logChanLower !== targetChannelLower) return;
            }

            // Moderator filter
            const modId = (log.moderatorId || "").toLowerCase();
            const modName = (log.moderatorName || "").toLowerCase();
            const modDisplay = (log.moderatorDisplayName || "").toLowerCase();

            if (modId !== targetModLower && modName !== targetModLower && modDisplay !== targetModLower) {
                return;
            }

            filteredLogs.push(log);
        });

        // Sort descending by timestamp
        filteredLogs.sort((a, b) => b.timestamp - a.timestamp);

        res.json({ logs: filteredLogs });
    } catch (error) {
        console.error("Error in /api/modstats/detail:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Initialize Clipper Manager
const ClipperManager = require('./clipper');
const clipperManager = new ClipperManager(db);

// Helper to get valid Twitch master bot access token
async function getTwitchAccessToken() {
    if (!masterBotUserId) {
        throw new Error("Master Bot ist noch nicht geladen/konfiguriert.");
    }
    const tokenData = await authProvider.getAccessTokenForUser(masterBotUserId);
    if (!tokenData) {
        throw new Error("Konnte kein Access-Token für den Master Bot abrufen.");
    }
    return tokenData.accessToken;
}

// Automatically prune finished/failed renders, keeping only the single newest one
async function pruneOldRenders(db) {
    try {
        const snap = await db.ref('clipper/renders').once('value');
        const renders = snap.val() || {};
        const finishedJobs = Object.entries(renders).filter(([k, j]) => j.status === 'done' || j.status === 'failed');
        if (finishedJobs.length > 1) {
            finishedJobs.sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0));
            const updates = {};
            for (let i = 1; i < finishedJobs.length; i++) {
                updates[finishedJobs[i][0]] = null;
            }
            await db.ref('clipper/renders').update(updates);
            console.log(`[Clipper] Pruned ${Object.keys(updates).length} old finished/failed renders from server.`);
        }
    } catch (err) {
        console.error("[Clipper] Error pruning renders in server:", err.message);
    }
}

// Helper to extract MP4 download URL from a Twitch clip
// Supports the old "-preview-" format and the new "/thumb/" template format
function extractClipMp4Url(thumbnailUrl) {
    const thumb = thumbnailUrl || "";
    
    // Strategy 1: Legacy format - "https://.../<slug>-preview-480x272.jpg" -> "https://.../<slug>.mp4"
    const previewIndex = thumb.indexOf('-preview-');
    if (previewIndex !== -1) {
        return thumb.substring(0, previewIndex) + '.mp4';
    }
    
    // Strategy 2: New format - contains "/thumb/thumb0-" or similar thumb patterns
    // Example: "https://clips-media-assets2.twitch.tv/.../thumb/thumb0-%{width}x%{height}.jpg"
    // The MP4 is usually at the same base path without the /thumb/ segment
    const thumbDirIndex = thumb.indexOf('/thumb/');
    if (thumbDirIndex !== -1) {
        // Try constructing MP4 URL from the base path
        const basePath = thumb.substring(0, thumbDirIndex);
        return basePath + '.mp4';
    }
    
    // Strategy 3: Try removing the last path segment (any thumbnail filename) and append .mp4
    // Works for patterns like "https://.../<id>/thumb0-480x272.jpg"
    const lastSlash = thumb.lastIndexOf('/');
    if (lastSlash !== -1 && (thumb.endsWith('.jpg') || thumb.endsWith('.jpeg') || thumb.endsWith('.png'))) {
        const parentPath = thumb.substring(0, lastSlash);
        return parentPath + '.mp4';
    }
    
    return "";
}

// Fetch clip MP4 URL using the official Twitch API as fallback
async function getClipDownloadUrl(clipId, accessToken, broadcasterId) {
    try {
        // First try the official clips/downloads endpoint
        const url = `https://api.twitch.tv/helix/clips/downloads?broadcaster_id=${broadcasterId}&editor_id=${broadcasterId}&clip_id=${clipId}`;
        const res = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Client-Id': process.env.TWITCH_CLIENT_ID
            }
        });
        if (res.ok) {
            const data = await res.json();
            if (data.data && data.data.length > 0) {
                // Prefer landscape download URL for the rendering pipeline
                return data.data[0].landscape_download_url || data.data[0].portrait_download_url || "";
            }
        }
    } catch (err) {
        console.warn(`[Clipper] Official clips/downloads API failed for ${clipId}:`, err.message);
    }
    return "";
}

// Fetch clip MP4 URL using Twitch's internal GraphQL API (does not require editor scopes)
async function getClipMp4UrlGQL(clipId) {
    try {
        const response = await fetch('https://gql.twitch.tv/gql', {
            method: 'POST',
            headers: {
                'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                query: `query { clip(slug: "${clipId}") { videoQualities { sourceURL } playbackAccessToken(params: { platform: "web", playerType: "site", playerBackend: "mediaplayer" }) { signature value } } }`
            })
        });

        if (response.ok) {
            const gqlData = await response.json();
            const clip = gqlData.data ? gqlData.data.clip : null;
            if (clip && clip.videoQualities && clip.videoQualities.length > 0) {
                const bestQuality = clip.videoQualities[0];
                const sourceURL = bestQuality.sourceURL;
                const sig = clip.playbackAccessToken.signature;
                const token = clip.playbackAccessToken.value;
                if (sourceURL && sig && token) {
                    return `${sourceURL}?sig=${sig}&token=${encodeURIComponent(token)}`;
                }
            }
        }
    } catch (err) {
        console.warn(`[Clipper] GraphQL clip resolution failed for ${clipId}:`, err.message);
    }
    return "";
}

// Clipper API endpoints
app.get('/api/clipper/channels', async (req, res) => {
    try {
        const snap = await db.ref('clipper/channels').once('value');
        res.json(snap.val() || {});
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/clipper/channels', async (req, res) => {
    const { name, tiktokAccount, tiktokHashtags, tiktokCaption, isAgentActive, youtubeAccount, youtubeHashtags, youtubeCaption, autoPublishYoutube } = req.body;
    if (!name) return res.status(400).json({ error: "Name fehlt." });
    try {
        const cleanName = name.toLowerCase().trim();
        const snap = await db.ref(`clipper/channels/${cleanName}`).once('value');
        const currentData = snap.val() || {};
        
        const updateData = {
            ...currentData,
            name: cleanName,
            platform: currentData.platform || 'twitch',
            status: currentData.status || 'offline',
            isActive: currentData.isActive !== undefined ? currentData.isActive : true,
            addedAt: currentData.addedAt || Date.now()
        };
        
        if (tiktokAccount !== undefined) updateData.tiktokAccount = tiktokAccount;
        if (tiktokHashtags !== undefined) updateData.tiktokHashtags = tiktokHashtags;
        if (tiktokCaption !== undefined) updateData.tiktokCaption = tiktokCaption;
        if (isAgentActive !== undefined) updateData.isAgentActive = !!isAgentActive;
        if (youtubeAccount !== undefined) updateData.youtubeAccount = youtubeAccount;
        if (youtubeHashtags !== undefined) updateData.youtubeHashtags = youtubeHashtags;
        if (youtubeCaption !== undefined) updateData.youtubeCaption = youtubeCaption;
        if (autoPublishYoutube !== undefined) updateData.autoPublishYoutube = !!autoPublishYoutube;
        if (req.body.camCrop !== undefined) updateData.camCrop = req.body.camCrop;
        if (req.body.gameCrop !== undefined) updateData.gameCrop = req.body.gameCrop;
        if (req.body.layout !== undefined) updateData.layout = req.body.layout;
        
        await db.ref(`clipper/channels/${cleanName}`).set(updateData);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/clipper/channels/:name', async (req, res) => {
    const { name } = req.params;
    if (!name) return res.status(400).json({ error: "Name fehlt." });
    try {
        const cleanName = name.toLowerCase().trim();
        await db.ref(`clipper/channels/${cleanName}`).remove();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/clipper/config', async (req, res) => {
    try {
        const snap = await db.ref('clipper/config').once('value');
        res.json(snap.val() || { agentActive: false });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/clipper/config', async (req, res) => {
    const { agentActive } = req.body;
    try {
        await db.ref('clipper/config').update({ agentActive: !!agentActive });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/clipper/tiktok-queue', async (req, res) => {
    try {
        const snap = await db.ref('clipper/tiktok_queue').limitToLast(10).once('value');
        res.json(snap.val() || {});
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/clipper/tiktok-queue/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "ID fehlt." });
    try {
        await db.ref(`clipper/tiktok_queue/${id}`).remove();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/clipper/tiktok-queue/:id/approve', async (req, res) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "ID fehlt." });
    try {
        const ref = db.ref(`clipper/tiktok_queue/${id}`);
        const snap = await ref.once('value');
        if (!snap.exists()) {
            return res.status(404).json({ error: "Job nicht gefunden." });
        }
        await ref.update({
            status: 'pending',
            progressMessage: 'Freigegeben - wartet auf Upload.'
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/clipper/clips', async (req, res) => {
    try {
        const snap = await db.ref('clipper/clips').once('value');
        res.json(snap.val() || {});
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/clipper/clips', async (req, res) => {
    try {
        const clipsDir = clipperManager.clipsDir;
        if (fs.existsSync(clipsDir)) {
            const files = fs.readdirSync(clipsDir);
            for (const file of files) {
                const filePath = path.join(clipsDir, file);
                try {
                    if (fs.statSync(filePath).isFile()) {
                        fs.unlinkSync(filePath);
                    }
                } catch (e) {
                    console.error(`[Clipper] Fehler beim Löschen der Datei ${file}:`, e.message);
                }
            }
        }
        await db.ref('clipper/clips').remove();
        res.json({ success: true });
    } catch (err) {
        console.error(`[Clipper] Fehler beim Löschen aller Clips:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

const multer = require('multer');
const getClipsDir = () => {
    let dir = path.join(__dirname, '../public/clips');
    if (fs.existsSync('/var/www/bingo/public/clips')) {
        dir = '/var/www/bingo/public/clips';
    }
    return dir;
};
const clipperUploadStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const clipsDir = getClipsDir();
        if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });
        cb(null, clipsDir);
    },
    filename: (req, file, cb) => {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
        cb(null, 'upload_' + Date.now() + '_' + safeName);
    }
});
const clipperUpload = multer({
    storage: clipperUploadStorage,
    limits: { fileSize: 500 * 1024 * 1024 } // 500MB max
});

// Upload custom uncut clip to Clipper library
app.post('/api/clipper/upload', clipperUpload.single('clip'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Keine Datei hochgeladen.' });
    }
    try {
        const filename = req.file.filename;
        const clipId = db.ref('clipper/clips').push().key;
        const clipData = {
            id: clipId,
            filename: filename,
            channelName: 'Upload',
            timestamp: Date.now(),
            url: `/public/clips/${filename}`
        };
        await db.ref(`clipper/clips/${clipId}`).set(clipData);
        console.log(`[Clipper Upload] Datei erfolgreich hochgeladen und registriert: ${filename}`);
        res.json({ success: true, filename, clipId });
    } catch (err) {
        console.error(`[Clipper] Fehler beim Registrieren des hochgeladenen Clips:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/clipper/renders', async (req, res) => {
    try {
        const snap = await db.ref('clipper/renders').once('value');
        res.json(snap.val() || {});
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/clipper/renders', async (req, res) => {
    try {
        const snap = await db.ref('clipper/renders').once('value');
        const renders = snap.val() || {};
        const activeRenders = {};
        for (const [key, job] of Object.entries(renders)) {
            if (job.status === 'rendering' || job.status === 'downloading') {
                activeRenders[key] = job;
            }
        }
        await db.ref('clipper/renders').set(activeRenders);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/clipper/renders/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "ID fehlt." });
    try {
        await db.ref(`clipper/renders/${id}`).remove();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/clipper/clip', async (req, res) => {
    const { channelName, duration, startSecAgo, endSecAgo, autoRender, autoPublish } = req.body;
    if (!channelName) {
        return res.status(400).json({ error: "Kanalname fehlt." });
    }
    try {
        const durationSec = duration ? parseInt(duration, 10) : 120;
        const clipData = await clipperManager.createClip(
            channelName, 
            durationSec, 
            startSecAgo !== undefined ? parseInt(startSecAgo, 10) : undefined, 
            endSecAgo !== undefined ? parseInt(endSecAgo, 10) : undefined
        );

        // If autoRender is true, trigger portrait rendering in blur-bg layout
        if (autoRender) {
            const jobId = db.ref('clipper/renders').push().key;
            const jobData = {
                id: jobId,
                status: 'rendering',
                filename: clipData.filename,
                timestamp: Date.now(),
                autoPublish: !!autoPublish,
                streamerName: channelName,
                progress: 0
            };
            
            // Set job status
            await db.ref(`clipper/renders/${jobId}`).set(jobData);

            // Calculate duration to render
            const calculatedDuration = (startSecAgo !== undefined && endSecAgo !== undefined) 
                ? (parseInt(startSecAgo, 10) - parseInt(endSecAgo, 10)) 
                : durationSec;

            // Trigger asynchronously
            clipperManager.renderPortrait(
                jobId,
                clipData.filename,
                0,
                calculatedDuration,
                { x: 5, y: 10, w: 30, h: 40 }, // Default crop presets
                { x: 40, y: 10, w: 55, h: 80 },
                'blur-bg',
                null
            ).then(async (renderedClip) => {
                if (autoPublish) {
                    await queueTikTokUpload(renderedClip, channelName, '', null, 'blur-bg');
                }
            }).catch(err => {
                console.error(`[Clipper] Auto-Render-Portrait failed for job ${jobId}:`, err.message);
            });
        }

        res.json({ success: true, clip: clipData });
    } catch (err) {
        console.error(`[Clipper] Fehler beim Erstellen des Clips für ${channelName}:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET Twitch Clips for Streamer
app.get('/api/clipper/twitch-clips', async (req, res) => {
    const { channelName, range, minViews } = req.query;
    if (!channelName) {
        return res.status(400).json({ error: "Kanalname fehlt." });
    }

    try {
        const accessToken = await getTwitchAccessToken();

        // 1. Get broadcaster ID from channel name
        const userRes = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(channelName.toLowerCase().trim())}`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Client-Id': process.env.TWITCH_CLIENT_ID
            }
        });
        const userData = await userRes.json();
        if (!userData.data || userData.data.length === 0) {
            return res.status(404).json({ error: "Twitch-Kanal nicht gefunden." });
        }
        const broadcasterId = userData.data[0].id;

        // 2. Compute date range started_at
        let startedAt = "";
        const now = new Date();
        if (range === '24h') {
            startedAt = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
        } else if (range === '48h') {
            startedAt = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
        } else if (range === '72h') {
            startedAt = new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString();
        } else {
            // Default 7 Tage
            startedAt = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
        }

        // 3. Fetch Twitch clips
        const clipsUrl = `https://api.twitch.tv/helix/clips?broadcaster_id=${broadcasterId}&started_at=${startedAt}&first=100`;
        const clipsRes = await fetch(clipsUrl, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Client-Id': process.env.TWITCH_CLIENT_ID
            }
        });
        const clipsData = await clipsRes.json();
        if (!clipsData.data) {
            return res.json({ clips: [] });
        }

        // 4. Map & filter
        const minViewsNum = parseInt(minViews, 10) || 0;
        const filteredClips = clipsData.data
            .filter(c => c.view_count >= minViewsNum)
            .map(c => {
                let mp4Url = extractClipMp4Url(c.thumbnail_url);
                // Resolve thumbnail template placeholders (new Twitch format)
                let resolvedThumb = (c.thumbnail_url || '')
                    .replace('%{width}', '480')
                    .replace('%{height}', '272');
                return {
                    id: c.id,
                    title: c.title,
                    viewCount: c.view_count,
                    duration: Math.round(c.duration),
                    thumbnailUrl: resolvedThumb,
                    creatorName: c.creator_name,
                    createdAt: c.created_at,
                    broadcasterName: c.broadcaster_name,
                    mp4Url: mp4Url
                };
            });

        res.json({ clips: filteredClips });
    } catch (err) {
        console.error(`[Clipper] Fehler beim Abrufen der Twitch Clips für ${channelName}:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST Render Portrait Clip (supports local DVR or downloading Twitch clip MP4)
app.post('/api/clipper/render-portrait', async (req, res) => {
    const { filename, mp4Url, clipId, start, end, camCrop, gameCrop, layout, textOverlay, autoPublish, streamerName, tiktokAccount, tiktokCaption, autoPublishYoutube, youtubeAccount, youtubeCaption } = req.body;
    
    if ((!filename && !mp4Url) || start === undefined || end === undefined || !camCrop || !gameCrop) {
        return res.status(400).json({ error: "Fehlende Parameter für Hochformat-Rendering." });
    }

    try {
        const jobId = db.ref('clipper/renders').push().key;
        const fs = require('fs');
        const path = require('path');

        // Set initial job status with metadata
        const initialJobData = {
            id: jobId,
            status: mp4Url ? 'downloading' : 'rendering',
            filename: filename || `temp_twitch_${jobId}.mp4`,
            timestamp: Date.now(),
            autoPublish: !!autoPublish,
            autoPublishYoutube: !!autoPublishYoutube,
            streamerName: streamerName || 'Streamer',
            tiktokAccount: tiktokAccount || 'default',
            youtubeAccount: youtubeAccount || 'default',
            progress: 0
        };
        await db.ref(`clipper/renders/${jobId}`).set(initialJobData);

        if (mp4Url) {
            // Downloading Twitch clip MP4 before running the portrait render pipeline
            const targetFilename = `temp_twitch_${jobId}.mp4`;
            const tempPath = path.join(clipperManager.clipsDir, targetFilename);

            const runDownloadAndRender = async () => {
                try {
                    // Update job status to downloading
                    await db.ref(`clipper/renders/${jobId}`).update({ status: 'downloading', progress: 0 });
                    
                    let activeUrl = mp4Url;
                    let response = null;
                    
                    // Try GraphQL first if clipId is present
                    if (clipId) {
                        console.log(`[Clipper] Freshly resolving clip ${clipId} via GraphQL...`);
                        const gqlUrl = await getClipMp4UrlGQL(clipId);
                        if (gqlUrl) {
                            activeUrl = gqlUrl;
                        }
                    }
                    
                    response = await fetch(activeUrl);
                    
                    // Fallback: If download failed and we didn't have a clipId, try to extract it from mp4Url and resolve
                    if (!response.ok && !clipId) {
                        const match = mp4Url.match(/\/([A-Za-z0-9]+(?:-[A-Za-z0-9_-]+)*)(?:\.mp4|\/)/);
                        const extractedId = match ? match[1] : "";
                        if (extractedId && extractedId.length > 5 && !extractedId.includes('twitch') && !extractedId.includes('landscape')) {
                            console.log(`[Clipper] Extracted clip ID ${extractedId} from URL, attempting GraphQL resolution...`);
                            const gqlUrl = await getClipMp4UrlGQL(extractedId);
                            if (gqlUrl) {
                                response = await fetch(gqlUrl);
                            }
                        }
                    }
                    
                    // Final fallback: If GQL URL resolution failed, retry original mp4Url
                    if (clipId && !response.ok) {
                        console.log(`[Clipper] GQL fetch failed, retrying original mp4Url: ${mp4Url}`);
                        response = await fetch(mp4Url);
                    }

                    if (!response || !response.ok) {
                        throw new Error(`Fehler beim Herunterladen des Clips (HTTP Status ${response ? response.status : 'unbekannt'}).`);
                    }
                    
                    const buffer = await response.arrayBuffer();
                    fs.writeFileSync(tempPath, Buffer.from(buffer));
                    
                    // Render the downloaded file
                    const renderedClip = await clipperManager.renderPortrait(jobId, targetFilename, start, end, camCrop, gameCrop, layout, textOverlay);
                    if (autoPublish) {
                        const finalCaption = (tiktokCaption !== undefined && tiktokCaption !== null && tiktokCaption !== '') ? tiktokCaption : (textOverlay ? (textOverlay.text || textOverlay.content) : undefined);
                        await queueTikTokUpload(renderedClip, streamerName, finalCaption, tiktokAccount, layout);
                    }
                    if (autoPublishYoutube) {
                        const finalCaption = (youtubeCaption !== undefined && youtubeCaption !== null && youtubeCaption !== '') ? youtubeCaption : (textOverlay ? (textOverlay.text || textOverlay.content) : undefined);
                        await queueYoutubeUpload(renderedClip, streamerName, finalCaption, youtubeAccount, layout);
                    }
                } catch (err) {
                    console.error(`[Clipper] Download/Render Fehler für Job ${jobId}:`, err.message);
                    await db.ref(`clipper/renders/${jobId}`).update({ status: 'failed', error: err.message });
                    await pruneOldRenders(db);
                } finally {
                    // Always cleanup temporary file
                    if (fs.existsSync(tempPath)) {
                        try { fs.unlinkSync(tempPath); } catch(e) {}
                    }
                }
            };

            runDownloadAndRender();
        } else {
            // Direct local DVR clip rendering
            clipperManager.renderPortrait(jobId, filename, start, end, camCrop, gameCrop, layout, textOverlay)
                .then(async (renderedClip) => {
                    if (autoPublish) {
                        const finalCaption = (tiktokCaption !== undefined && tiktokCaption !== null && tiktokCaption !== '') ? tiktokCaption : (textOverlay ? (textOverlay.text || textOverlay.content) : undefined);
                        await queueTikTokUpload(renderedClip, streamerName, finalCaption, tiktokAccount, layout);
                    }
                    if (autoPublishYoutube) {
                        const finalCaption = (youtubeCaption !== undefined && youtubeCaption !== null && youtubeCaption !== '') ? youtubeCaption : (textOverlay ? (textOverlay.text || textOverlay.content) : undefined);
                        await queueYoutubeUpload(renderedClip, streamerName, finalCaption, youtubeAccount, layout);
                    }
                })
                .catch(err => console.error(`[Clipper] Asynchrones Rendering fehlgeschlagen für Job ${jobId}:`, err.message));
        }

        res.json({ success: true, jobId });
    } catch (err) {
        console.error(`[Clipper] Fehler beim Initiieren des Renderings:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/clipper/clip/:id', async (req, res) => {
    const clipId = req.params.id;
    const { filename } = req.query;
    if (!clipId || !filename) {
        return res.status(400).json({ error: "Ungültige Parameter." });
    }
    try {
        await clipperManager.deleteClip(clipId, filename);
        res.json({ success: true });
    } catch (err) {
        console.error(`[Clipper] Fehler beim Löschen des Clips ${clipId}:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// TikTok Upload Simulation
const tiktokUploads = {};

app.post('/api/clipper/upload-tiktok', (req, res) => {
    const { clipId, filename, caption, hashtags } = req.body;
    if (!filename) {
        return res.status(400).json({ error: "Dateiname fehlt." });
    }
    const uploadId = Math.random().toString(36).substr(2, 9);
    tiktokUploads[uploadId] = {
        status: 'connecting',
        progress: 0,
        statusText: 'Verbindung zu TikTok wird aufgebaut...',
        caption,
        hashtags
    };

    let currentProgress = 0;
    const interval = setInterval(() => {
        if (!tiktokUploads[uploadId]) {
            clearInterval(interval);
            return;
        }
        currentProgress += 10;
        if (currentProgress < 30) {
            tiktokUploads[uploadId].status = 'connecting';
            tiktokUploads[uploadId].progress = currentProgress;
            tiktokUploads[uploadId].statusText = 'Verbindung zu TikTok wird aufgebaut...';
        } else if (currentProgress < 80) {
            tiktokUploads[uploadId].status = 'uploading';
            tiktokUploads[uploadId].progress = currentProgress;
            tiktokUploads[uploadId].statusText = `Clip wird hochgeladen (${currentProgress}%)...`;
        } else if (currentProgress < 100) {
            tiktokUploads[uploadId].status = 'processing';
            tiktokUploads[uploadId].progress = currentProgress;
            tiktokUploads[uploadId].statusText = 'TikTok verarbeitet den Clip und wendet Hashtags an...';
        } else {
            tiktokUploads[uploadId].status = 'done';
            tiktokUploads[uploadId].progress = 100;
            tiktokUploads[uploadId].statusText = 'Clip erfolgreich veröffentlicht!';
            clearInterval(interval);
        }
    }, 500);

    res.json({ success: true, uploadId });
});

app.get('/api/clipper/upload-tiktok-status/:id', (req, res) => {
    const { id } = req.params;
    const upload = tiktokUploads[id];
    if (!upload) {
        return res.status(404).json({ error: "Upload nicht gefunden." });
    }
    res.json(upload);
});

// ============================================================================
// Server-Side Headless TikTok QR Login & Queue Upload Integration
// ============================================================================

const qrLoginBrowsers = {};
const qrLoginPages = {};
const qrLoginTimeouts = {};

app.post('/api/clipper/tiktok/qr/start', async (req, res) => {
    const account = (req.query.account || 'default').replace(/[^a-zA-Z0-9_]/g, '');
    
    // Clean up existing session for this account
    await cleanQrSession(account);

    try {
        console.log(`[TikTok QR Server] Starte Browser für Account: ${account}...`);
        const sessionDir = path.join(__dirname, 'tiktok_sessions', `tiktok_session_${account}`);
        
        // Clean session directory to force a fresh login (preventing automatic redirects to home feed)
        if (fs.existsSync(sessionDir)) {
            try {
                fs.rmSync(sessionDir, { recursive: true, force: true });
                console.log(`[TikTok QR Server] Deleted old session directory for ${account} to force fresh login.`);
            } catch (rmErr) {
                console.warn(`[TikTok QR Server] Could not delete session directory:`, rmErr.message);
            }
        }

        if (!fs.existsSync(path.join(__dirname, 'tiktok_sessions'))) {
            fs.mkdirSync(path.join(__dirname, 'tiktok_sessions'), { recursive: true });
        }
        
        const browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage'
            ],
            userDataDir: sessionDir
        });

        const page = await browser.newPage();
        await page.bringToFront();
        await page.setViewport({ width: 1280, height: 800 });
        // Set User-Agent and Language to simulate a normal user browser
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7' });

        // Clean cookies to ensure a fresh login screen
        try {
            const cookies = await page.cookies();
            if (cookies && cookies.length > 0) {
                await page.deleteCookie(...cookies);
                console.log(`[TikTok QR Server] Cleared ${cookies.length} old cookies for ${account}`);
            }
        } catch (cookieErr) {
            console.warn(`[TikTok QR Server] Failed to clear cookies:`, cookieErr.message);
        }

        qrLoginBrowsers[account] = browser;
        qrLoginPages[account] = page;

        console.log(`[TikTok QR Server] Navigiere zu Login für ${account}...`);
        await page.goto('https://www.tiktok.com/login', { waitUntil: 'networkidle2' });
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Schließe Cookie-Consent-Banner falls vorhanden
        console.log(`[TikTok QR Server] Schließe Cookie-Consent-Banner für ${account} falls vorhanden...`);
        try {
            await page.evaluate(() => {
                const findClickableByText = (txt, root = document) => {
                    const candidates = root.querySelectorAll('button, [role="button"], a, [class*="btn"], [class*="Button"]');
                    for (const el of candidates) {
                        if (el.textContent && el.textContent.trim().toLowerCase() === txt.toLowerCase()) {
                            return el;
                        }
                    }
                    for (const el of root.querySelectorAll('*')) {
                        if (el.shadowRoot) {
                            const found = findClickableByText(txt, el.shadowRoot);
                            if (found) return found;
                        }
                    }
                    return null;
                };

                const cookieBtn = findClickableByText('Alle zulassen') || 
                                  findClickableByText('Allow all') || 
                                  findClickableByText('Alle akzeptieren') || 
                                  findClickableByText('Accept all') || 
                                  findClickableByText('Alle erlauben') ||
                                  findClickableByText('Decline optional cookies') || 
                                  findClickableByText('Optionale Cookies ablehnen');
                if (cookieBtn && typeof cookieBtn.click === 'function') {
                    cookieBtn.click();
                }
            });
            await new Promise(r => setTimeout(r, 2000));
        } catch (cookieErr) {
            console.warn(`[TikTok QR Server] Fehler beim automatischen Cookie-Banner Schließen:`, cookieErr.message);
        }

        console.log(`[TikTok QR Server] Klicke QR-Code-Login...`);
        let qrClicked = false;
        try {
            // Find div[data-e2e="channel-item"] containing "QR" or "qr" (very precise)
            const qrBtn = await page.waitForSelector('xpath///div[@data-e2e="channel-item" and (contains(., "QR") or contains(., "qr"))]', { timeout: 4000 });
            if (qrBtn) {
                try {
                    await qrBtn.click();
                    console.log(`[TikTok QR Server] QR-Button geklickt nativ via XPath data-e2e="channel-item" for ${account}`);
                    qrClicked = true;
                } catch (clickErr) {
                    console.warn(`[TikTok QR Server] Nativer Klick auf XPath fehlgeschlagen, versuche evaluate Klick:`, clickErr.message);
                    await page.evaluate(el => el.click(), qrBtn);
                    qrClicked = true;
                }
            } else {
                throw new Error('XPath-Selector fand kein Element');
            }
        } catch (e) {
            console.log(`[TikTok QR Server] Fallback-Klick-Suche gestartet für ${account}:`, e.message);
            const channelItems = await page.$$('div[data-e2e="channel-item"]');
            for (let el of channelItems) {
                let text = await page.evaluate(el => el.textContent, el);
                if (text && (text.includes('QR') || text.includes('qr') || text.includes('Code') || text.includes('code'))) {
                    try {
                        await el.click();
                        console.log(`[TikTok QR Server] Fallback: data-e2e="channel-item" geklickt nativ mit Text:`, text.trim());
                        qrClicked = true;
                        break;
                    } catch (clickErr) {
                        try {
                            await page.evaluate(btn => btn.click(), el);
                            console.log(`[TikTok QR Server] Fallback: data-e2e="channel-item" geklickt via evaluate mit Text:`, text.trim());
                            qrClicked = true;
                            break;
                        } catch (evalErr) {
                            // ignore and try next
                        }
                    }
                }
            }
            
            // Zweites Fallback über Dokument-Weite Textsuche
            if (!qrClicked) {
                console.log(`[TikTok QR Server] Zweites Fallback über Dokument-Weite Textsuche für ${account}...`);
                try {
                    const clicked = await page.evaluate(() => {
                        const btns = Array.from(document.querySelectorAll('button, div, a'));
                        const btn = btns.find(b => {
                            const t = b.textContent || '';
                            return (t.includes('QR') || t.includes('qr') || t.includes('Code') || t.includes('code')) && 
                                   (b.tagName === 'BUTTON' || b.getAttribute('data-e2e') === 'channel-item' || b.className.includes('channel-item') || b.className.includes('button') || b.className.includes('btn'));
                        });
                        if (btn && typeof btn.click === 'function') {
                            btn.click();
                            return true;
                        }
                        return false;
                    });
                    if (clicked) {
                        qrClicked = true;
                        console.log(`[TikTok QR Server] QR-Button geklickt via zweitem evaluate Fallback.`);
                    }
                } catch (fallback2Err) {
                    console.warn(`[TikTok QR Server] Zweites Fallback fehlgeschlagen:`, fallback2Err.message);
                }
            }

            if (!qrClicked) {
                throw new Error('QR-Login Button konnte nicht gefunden oder geklickt werden.');
            }
        }

        console.log(`[TikTok QR Server] Warte auf QR-Code Canvas...`);
        await page.waitForSelector('div[data-e2e="qr-code"] canvas', { timeout: 10000 });

        const qrDataUrl = await page.evaluate(() => {
            const canvas = document.querySelector('div[data-e2e="qr-code"] canvas');
            return canvas ? canvas.toDataURL() : null;
        });

        if (!qrDataUrl) {
            throw new Error('QR-Code Bild konnte nicht ausgelesen werden.');
        }

        qrLoginTimeouts[account] = setTimeout(async () => {
            console.log(`[TikTok QR Server] Session Timeout für ${account}`);
            await cleanQrSession(account);
        }, 10 * 60 * 1000);

        console.log(`[TikTok QR Server] QR-Code für ${account} erfolgreich generiert.`);
        res.json({ success: true, qrCode: qrDataUrl });

    } catch (err) {
        console.error(`[TikTok QR Server] Fehler beim Generieren für ${account}:`, err);
        if (qrLoginPages[account]) {
            try {
                const debugPath = path.join(__dirname, '../public', 'debug_qr_fail.png');
                await qrLoginPages[account].screenshot({ path: debugPath });
                console.log(`[TikTok QR Server] Debug-Screenshot gespeichert unter:`, debugPath);
            } catch (e) {
                console.error(`[TikTok QR Server] Fehler beim Speichern des Debug-Screenshots:`, e);
            }
        }
        await cleanQrSession(account);
        res.status(500).json({ error: 'Fehler beim Generieren des QR-Codes: ' + err.message });
    }
});

app.get('/api/clipper/tiktok/qr/status', async (req, res) => {
    const account = (req.query.account || 'default').replace(/[^a-zA-Z0-9_]/g, '');
    const page = qrLoginPages[account];
    const browser = qrLoginBrowsers[account];

    if (!browser || !page) {
        try {
            const sessionDir = path.join(__dirname, 'tiktok_sessions', `tiktok_session_${account}`);
            const manualCookieFile = path.join(__dirname, 'tiktok_sessions', `tiktok_cookie_${account}.txt`);
            // Manuelles Cookie ist die zuverlässigste Methode
            if (fs.existsSync(manualCookieFile)) {
                const cookieVal = fs.readFileSync(manualCookieFile, 'utf8').trim();
                if (cookieVal) {
                    return res.json({ success: true, status: 'connected', method: 'cookie' });
                }
            }
            // Session-Verzeichnis existiert -> Wir betrachten es als verbunden
            if (fs.existsSync(sessionDir)) {
                return res.json({ success: true, status: 'connected', method: 'session' });
            }
        } catch (e) {}
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
            console.warn(`[TikTok QR Server] Konnte Aktivität nicht simulieren:`, actErr.message);
        }

        const cookies = await page.cookies();
        const currentUrl = page.url();
        const sessionIdCookie = cookies.find(c => c.name === 'sessionid' || c.name === 'sessionid_ss');
        const isRedirected = !currentUrl.includes('/login') && !currentUrl.includes('unlogin') && currentUrl !== 'about:blank' && !currentUrl.includes('feedback');

        console.log(`[TikTok QR Server] Status Check für ${account}: URL=${currentUrl}, Cookies=${cookies.length}, HasSessionId=${!!sessionIdCookie}`);

        if ((sessionIdCookie && sessionIdCookie.value) || isRedirected) {
            console.log(`[TikTok QR Server] Login erfolgreich für ${account}! (Cookie=${!!sessionIdCookie}, Redirected=${isRedirected}, URL=${currentUrl})`);
            
            // SessionID automatisch als Backup in Keksdatei speichern
            if (sessionIdCookie && sessionIdCookie.value) {
                try {
                    const sessionsDir = path.join(__dirname, 'tiktok_sessions');
                    if (!fs.existsSync(sessionsDir)) {
                        fs.mkdirSync(sessionsDir, { recursive: true });
                    }
                    const manualCookieFile = path.join(sessionsDir, `tiktok_cookie_${account}.txt`);
                    fs.writeFileSync(manualCookieFile, sessionIdCookie.value.trim(), 'utf8');
                    console.log(`[TikTok QR Server] SessionID für ${account} automatisch extrahiert und als Backup gespeichert.`);
                } catch (saveErr) {
                    console.error(`[TikTok QR Server] Fehler beim automatischen Speichern der SessionID:`, saveErr.message);
                }
            }

            // Warten, damit Chrome die Session auf Festplatte schreiben kann
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            await cleanQrSession(account);
            return res.json({ success: true, status: 'logged_in' });
        }
        res.json({ success: true, status: 'waiting' });
    } catch (err) {
        // Fallback to check files even if active browser check crashed or timed out
        try {
            const sessionDir = path.join(__dirname, 'tiktok_sessions', `tiktok_session_${account}`);
            const manualCookieFile = path.join(__dirname, 'tiktok_sessions', `tiktok_cookie_${account}.txt`);
            if (fs.existsSync(manualCookieFile)) {
                const cookieVal = fs.readFileSync(manualCookieFile, 'utf8').trim();
                if (cookieVal) {
                    return res.json({ success: true, status: 'connected', method: 'cookie' });
                }
            }
            if (fs.existsSync(sessionDir)) {
                return res.json({ success: true, status: 'connected', method: 'session' });
            }
        } catch (fallbackErr) {}
        res.json({ success: true, status: 'error', message: err.message });
    }
});

app.get('/api/clipper/tiktok/qr/screenshot', async (req, res) => {
    const account = (req.query.account || 'default').replace(/[^a-zA-Z0-9_]/g, '');
    const page = qrLoginPages[account];
    if (!page) {
        return res.status(400).json({ error: 'Keine aktive Login-Sitzung für diesen Account.' });
    }
    try {
        const screenshot = await page.screenshot({ encoding: 'base64' });
        res.json({ success: true, image: 'data:image/png;base64,' + screenshot, url: page.url() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/clipper/tiktok/qr/stop', async (req, res) => {
    const account = (req.query.account || 'default').replace(/[^a-zA-Z0-9_]/g, '');
    await cleanQrSession(account);
    res.json({ success: true });
});

app.post('/api/clipper/tiktok/manual-cookie', async (req, res) => {
    const account = (req.body.account || 'default').replace(/[^a-zA-Z0-9_]/g, '');
    const { sessionid } = req.body;
    if (!sessionid) {
        return res.status(400).json({ error: 'SessionID fehlt.' });
    }
    try {
        const sessionsDir = path.join(__dirname, 'tiktok_sessions');
        if (!fs.existsSync(sessionsDir)) {
            fs.mkdirSync(sessionsDir, { recursive: true });
        }
        const manualCookieFile = path.join(sessionsDir, `tiktok_cookie_${account}.txt`);
        fs.writeFileSync(manualCookieFile, sessionid.trim(), 'utf8');
        console.log(`[TikTok QR Server] Manuelle SessionID für ${account} gespeichert.`);
        res.json({ success: true, message: 'SessionID gespeichert.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/clipper/tiktok/manual-cookie', async (req, res) => {
    const account = (req.query.account || 'default').replace(/[^a-zA-Z0-9_]/g, '');
    try {
        const manualCookieFile = path.join(__dirname, 'tiktok_sessions', `tiktok_cookie_${account}.txt`);
        const hasCookie = fs.existsSync(manualCookieFile);
        let maskedCookie = '';
        if (hasCookie) {
            const val = fs.readFileSync(manualCookieFile, 'utf8').trim();
            maskedCookie = val ? '••••••••' + val.slice(-4) : '';
        }
        res.json({ success: true, hasCookie, sessionid: maskedCookie });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/clipper/tiktok/disconnect', async (req, res) => {
    const account = (req.body.account || 'default').replace(/[^a-zA-Z0-9_]/g, '');
    try {
        // Stop active QR login browser
        await cleanQrSession(account);
        
        // Remove manual cookie file
        const manualCookieFile = path.join(__dirname, 'tiktok_sessions', `tiktok_cookie_${account}.txt`);
        if (fs.existsSync(manualCookieFile)) {
            fs.unlinkSync(manualCookieFile);
        }
        
        // Remove Puppeteer session directory
        const sessionDir = path.join(__dirname, 'tiktok_sessions', `tiktok_session_${account}`);
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        
        console.log(`[TikTok QR Server] TikTok Verbindung für ${account} getrennt.`);
        res.json({ success: true, message: 'TikTok Verbindung getrennt.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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

app.post('/api/clipper/youtube/manual-cookie', async (req, res) => {
    const account = (req.body.account || 'default').replace(/[^a-zA-Z0-9_]/g, '');
    const { cookiesJson } = req.body;
    if (!cookiesJson) {
        return res.status(400).json({ error: 'Cookies fehlen.' });
    }
    try {
        let parsed;
        try {
            parsed = JSON.parse(cookiesJson);
            if (!Array.isArray(parsed)) throw new Error('Not an array');
        } catch (e) {
            return res.status(400).json({ error: 'Ungültiges JSON-Format. Erwartet wird ein Array von Cookie-Objekten.' });
        }

        const sessionsDir = path.join(__dirname, 'youtube_sessions');
        if (!fs.existsSync(sessionsDir)) {
            fs.mkdirSync(sessionsDir, { recursive: true });
        }
        const manualCookieFile = path.join(sessionsDir, `youtube_cookie_${account}.json`);
        fs.writeFileSync(manualCookieFile, JSON.stringify(parsed, null, 2), 'utf8');
        console.log(`[YouTube Server] Manuelle Cookies für ${account} gespeichert.`);
        res.json({ success: true, message: 'Cookies gespeichert.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/clipper/youtube/manual-cookie', async (req, res) => {
    const account = (req.query.account || 'default').replace(/[^a-zA-Z0-9_]/g, '');
    try {
        const manualCookieFile = path.join(__dirname, 'youtube_sessions', `youtube_cookie_${account}.json`);
        const hasCookie = fs.existsSync(manualCookieFile);
        res.json({ success: true, hasCookie });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/clipper/youtube/disconnect', async (req, res) => {
    const account = (req.body.account || 'default').replace(/[^a-zA-Z0-9_]/g, '');
    try {
        const manualCookieFile = path.join(__dirname, 'youtube_sessions', `youtube_cookie_${account}.json`);
        if (fs.existsSync(manualCookieFile)) {
            fs.unlinkSync(manualCookieFile);
        }
        const sessionDir = path.join(__dirname, 'youtube_sessions', `youtube_session_${account}`);
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        console.log(`[YouTube Server] YouTube Verbindung für ${account} getrennt.`);
        res.json({ success: true, message: 'YouTube Verbindung getrennt.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/clipper/youtube/status', async (req, res) => {
    const account = (req.query.account || 'default').replace(/[^a-zA-Z0-9_]/g, '');
    try {
        const manualCookieFile = path.join(__dirname, 'youtube_sessions', `youtube_cookie_${account}.json`);
        const hasCookie = fs.existsSync(manualCookieFile);
        if (!hasCookie) {
            return res.json({ status: 'disconnected', message: 'Keine Cookies hinterlegt.' });
        }
        res.json({ status: 'connected', message: 'Cookies hinterlegt.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/clipper/youtube-queue', async (req, res) => {
    try {
        const snap = await db.ref('clipper/youtube_queue').limitToLast(10).once('value');
        res.json(snap.val() || {});
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/clipper/youtube-queue/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "ID fehlt." });
    try {
        await db.ref(`clipper/youtube_queue/${id}`).remove();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/clipper/youtube-queue/:id/approve', async (req, res) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "ID fehlt." });
    try {
        const ref = db.ref(`clipper/youtube_queue/${id}`);
        const snap = await ref.once('value');
        if (!snap.exists()) {
            return res.status(404).json({ error: "Job nicht gefunden." });
        }
        await ref.update({
            status: 'pending',
            progressMessage: 'Freigegeben - wartet auf Upload.'
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

let isProcessingYoutubeQueue = false;

async function startYoutubeQueueListener(db, clipperManager) {
    console.log("[YouTube Server Queue] Starte Firebase Queue-Listener für YouTube...");
    
    // Auto-clean stuck jobs on startup
    try {
        const yqSnap = await db.ref('clipper/youtube_queue').once('value');
        const yq = yqSnap.val() || {};
        for (const [id, job] of Object.entries(yq)) {
            if (job.status === 'uploading' || job.status === 'starting' || job.status === 'posting' || job.status === 'typing') {
                console.log(`[YouTube Server Queue] Bereinige hängenden Job ${id} (Status: ${job.status}) auf 'failed'...`);
                await db.ref(`clipper/youtube_queue/${id}`).update({
                    status: 'failed',
                    error: 'Server wurde während des Uploads neu gestartet.',
                    progressMessage: 'Fehler: Server-Neustart.'
                });
            }
        }
    } catch (err) {
        console.error("[YouTube Server Queue] Fehler bei Startup-Bereinigung:", err.message);
    }
    
    db.ref('clipper/youtube_queue').on('value', async (snapshot) => {
        if (isProcessingYoutubeQueue) return;
        isProcessingYoutubeQueue = true;
        
        try {
            while (true) {
                const latestSnap = await db.ref('clipper/youtube_queue').once('value');
                const queue = latestSnap.val() || {};
                const pendingJobs = Object.values(queue)
                    .filter(job => job.status === 'pending')
                    .sort((a, b) => a.timestamp - b.timestamp);
                    
                if (pendingJobs.length === 0) {
                    break;
                }
                
                const job = pendingJobs[0];
                
                if (!job.id || !job.url) {
                    console.error(`[YouTube Server Queue] Job ungültig (fehlende id oder url), überspringe:`, JSON.stringify(job));
                    if (job.id) {
                        await db.ref(`clipper/youtube_queue/${job.id}`).update({
                            status: 'failed',
                            error: 'Job ungültig: URL oder ID fehlt.',
                            progressMessage: 'Fehler: URL/ID fehlt.'
                        });
                    }
                    continue;
                }
                
                console.log(`[YouTube Server Queue] Verarbeite Job ${job.id} für Streamer ${job.streamerName}`);
                
                try {
                    await db.ref(`clipper/youtube_queue/${job.id}`).update({
                        status: 'uploading',
                        progressMessage: 'Bereite Video vor...'
                    });
                    
                    const filename = job.url.substring(job.url.lastIndexOf('/') + 1);
                    const localPath = path.join(clipperManager.clipsDir, filename);
                    
                    let fileExists = fs.existsSync(localPath);
                    
                    if (!fileExists) {
                        try {
                            await db.ref(`clipper/youtube_queue/${job.id}`).update({
                                progressMessage: 'Lade Video von URL herunter...'
                            });
                            const response = await fetch(job.url);
                            if (!response.ok) throw new Error(`HTTP ${response.status}`);
                            const buffer = await response.arrayBuffer();
                            fs.writeFileSync(localPath, Buffer.from(buffer));
                            fileExists = true;
                        } catch (err) {
                            console.error("[YouTube Server Queue] Download failed:", err.message);
                        }
                    }
                    
                    if (!fileExists) {
                        throw new Error("Videodatei konnte nicht auf dem Server gefunden werden.");
                    }
                    
                    await db.ref(`clipper/youtube_queue/${job.id}`).update({
                        status: 'uploading',
                        progressMessage: 'Starte Chrome auf Server...'
                    });
                    
                    const firebaseStatusCallback = async (state, message) => {
                        await db.ref(`clipper/youtube_queue/${job.id}`).update({
                            status: state,
                            progressMessage: message
                        });
                    };
                    
                    await runYoutubeUploadOnServer(
                        localPath,
                        job.caption || '',
                        job.hashtags ? job.hashtags.split(' ').filter(t => t) : [],
                        true,
                        job.youtubeAccount || 'default',
                        firebaseStatusCallback
                    );
                    
                    const currentSnap = await db.ref(`clipper/youtube_queue/${job.id}/status`).once('value');
                    if (currentSnap.val() === 'done') {
                        await db.ref(`clipper/youtube_queue/${job.id}`).update({
                            postedAt: Date.now()
                        });
                    }
                } catch (jobErr) {
                    console.error(`[YouTube Server Queue] Fehler bei Job ${job.id}:`, jobErr.message);
                    await db.ref(`clipper/youtube_queue/${job.id}`).update({
                        status: 'failed',
                        error: jobErr.message,
                        progressMessage: `Fehler: ${jobErr.message}`
                    });
                }
            }
        } catch (globalErr) {
            console.error("[YouTube Server Queue] Globaler Schleifenfehler:", globalErr.message);
        } finally {
            isProcessingYoutubeQueue = false;
        }
    });
}

async function runYoutubeUploadOnServer(videoPath, caption, hashtags, autoPublish, youtubeAccount = 'default', statusCallback) {
    let browser = null;
    try {
        statusCallback('starting', 'Initialisiere Chrome...');
        
        let accountName = (youtubeAccount || 'default').replace(/[^a-zA-Z0-9_]/g, '');
        const sessionDir = path.join(__dirname, 'youtube_sessions', `youtube_session_${accountName}`);

        let publicClipsDir = path.join(__dirname, '../public/clips');
        if (fs.existsSync('/var/www/bingo/public/clips')) {
            publicClipsDir = '/var/www/bingo/public/clips';
        } else if (fs.existsSync(path.join(__dirname, '..', 'bingo', 'public', 'clips'))) {
            publicClipsDir = path.join(__dirname, '..', 'bingo', 'public', 'clips');
        }

        // Lösche stale SingletonLock etc. falls Chrome vorher abgestürzt ist
        const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
        for (const file of lockFiles) {
            const filePath = path.join(sessionDir, file);
            try {
                fs.unlinkSync(filePath);
                console.log(`[YouTube Uploader] Stale ${file} gelöscht für ${accountName}`);
            } catch (e) {
                if (e.code !== 'ENOENT') {
                    console.warn(`[YouTube Uploader] Fehler beim Löschen von ${file} für ${accountName}:`, e.message);
                }
            }
        }

        console.log(`[YouTube Uploader] Starte Puppeteer mit headless: new...`);
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security',
                '--disable-gpu',
                '--disable-dev-shm-usage'
            ],
            userDataDir: sessionDir
        });
        console.log(`[YouTube Uploader] Puppeteer erfolgreich gestartet.`);

        const pages = await browser.pages();
        const page = pages.length > 0 ? pages[0] : await browser.newPage();
        console.log(`[YouTube Uploader] Seite erstellt / geholt.`);
        
        await page.bringToFront();
        await page.setViewport({ width: 1280, height: 800 });
        
        // Set User-Agent and Language to simulate a normal user browser
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7' });
        
        // Load manual cookies if present
        const manualCookieFile = path.join(__dirname, 'youtube_sessions', `youtube_cookie_${accountName}.json`);
        if (fs.existsSync(manualCookieFile)) {
            try {
                const manualCookieVal = fs.readFileSync(manualCookieFile, 'utf8').trim();
                if (manualCookieVal) {
                    console.log(`[YouTube Uploader] Lade manuelle Session-Cookies für ${accountName}...`);
                    statusCallback('starting', 'Lade manuelle Session-Cookies...');
                    
                    const cookies = JSON.parse(manualCookieVal);
                    if (Array.isArray(cookies)) {
                        const cleanedCookies = cookies.map(c => {
                            const clean = {
                                name: c.name,
                                value: c.value,
                                domain: c.domain,
                                path: c.path || '/'
                            };
                            if (c.secure !== undefined) clean.secure = c.secure;
                            if (c.httpOnly !== undefined) clean.httpOnly = c.httpOnly;
                            if (c.sameSite) {
                                const ss = c.sameSite.toLowerCase();
                                if (ss === 'no_restriction' || ss === 'none') clean.sameSite = 'None';
                                else if (ss === 'lax') clean.sameSite = 'Lax';
                                else if (ss === 'strict') clean.sameSite = 'Strict';
                            }
                            if (typeof c.expirationDate === 'number') {
                                clean.expires = c.expirationDate;
                            } else if (typeof c.expires === 'number') {
                                clean.expires = c.expires;
                            }
                            return clean;
                        });
                        
                        // Navigate to youtube.com domain first so cookies can be set properly
                        await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded' });
                        await page.setCookie(...cleanedCookies);
                        console.log(`[YouTube Uploader] Session-Cookies erfolgreich gesetzt.`);
                    }
                }
            } catch (cookieErr) {
                console.error(`[YouTube Uploader] Fehler beim Laden/Setzen der Cookies:`, cookieErr.message);
            }
        }
        
        statusCallback('starting', 'Navigiere zu YouTube Studio...');
        console.log(`[YouTube Uploader] Navigiere zu YouTube Studio...`);
        await page.goto('https://studio.youtube.com', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });
        console.log(`[YouTube Uploader] Navigation zu YouTube Studio erfolgreich.`);
        await new Promise(r => setTimeout(r, 5000));
        
        // Check login state
        const currentUrl = page.url();
        if (currentUrl.includes('accounts.google.com') || currentUrl.includes('signin')) {
            try {
                await page.screenshot({ path: path.join(publicClipsDir, `youtube_debug_${accountName}_login_failed.png`) });
            } catch(e) {}
            throw new Error('Nicht eingeloggt. Bitte verbinde zuerst deinen YouTube-Account im Dashboard mit aktuellen Cookies.');
        }
        
        statusCallback('uploading', 'Initialisiere Upload...');
        
        // Wait for create icon or upload icon
        try {
            await page.waitForSelector('#create-icon, #upload-icon, ytcp-button#upload-button', { timeout: 30000 });
        } catch (selectorErr) {
            try {
                await page.screenshot({ path: path.join(publicClipsDir, `youtube_debug_${accountName}_dashboard_failed.png`) });
            } catch(e) {}
            throw new Error("Dashboard konnte nicht geladen werden. Login fehlgeschlagen oder Seite reagiert nicht.");
        }
        
        // Click Create or Upload button
        await page.evaluate(() => {
            const uploadIcon = document.querySelector('#upload-icon') || document.querySelector('ytcp-button#upload-button');
            if (uploadIcon) {
                uploadIcon.click();
            } else {
                const createBtn = document.querySelector('ytcp-button#create-icon') || document.querySelector('#create-icon');
                if (createBtn) {
                    if (createBtn.shadowRoot) {
                        const btn = createBtn.shadowRoot.querySelector('button');
                        if (btn) { btn.click(); return; }
                    }
                    createBtn.click();
                }
            }
        });
        
        await new Promise(r => setTimeout(r, 2000));
        
        // If upload dialog didn't open yet, try to click "Upload videos" dropdown option
        const dialogVisibleOnStart = await page.evaluate(() => !!document.querySelector('ytcp-uploads-dialog'));
        if (!dialogVisibleOnStart) {
            await page.evaluate(() => {
                const items = Array.from(document.querySelectorAll('paper-item, ytd-menu-navigation-item-renderer, ytcp-menu-navigation-item'));
                const uploadItem = items.find(el => {
                    const text = el.textContent.toLowerCase();
                    return text.includes('upload') || text.includes('hochladen');
                });
                if (uploadItem) {
                    uploadItem.click();
                } else {
                    const uploadBtn = document.querySelector('#text-item-0') || document.querySelector('ytcp-menu-navigation-item[label*="Upload"]');
                    if (uploadBtn) uploadBtn.click();
                }
            });
        }
        
        // Wait for upload dialog and input
        await page.waitForSelector('ytcp-uploads-dialog input[type="file"], input[type="file"]', { timeout: 30000 });
        const fileInput = await page.$('ytcp-uploads-dialog input[type="file"], input[type="file"]');
        if (!fileInput) {
            throw new Error("Dateiwähler für den Upload nicht gefunden.");
        }
        
        statusCallback('uploading', 'Videodatei wird zu YouTube hochgeladen...');
        await fileInput.uploadFile(videoPath);
        
        // Wait for details screen (Title textarea)
        console.log("[YouTube Uploader] Warte auf Details-Eingabefeld...");
        await page.waitForSelector('#title-textarea #textbox', { timeout: 60000 });
        
        // Wait a bit for interface to settle
        await new Promise(r => setTimeout(r, 3000));
        
        // Prepare title & description with #shorts
        let titleText = (caption || '').trim();
        if (titleText === 'undefined' || !titleText) {
            titleText = 'Stream Clip';
        }
        if (!titleText.toLowerCase().includes('#shorts')) {
            titleText = `${titleText} #shorts`;
        }
        if (titleText.length > 100) {
            titleText = titleText.substring(0, 92) + ' #shorts';
        }
        
        let descText = '';
        const tags = hashtags.map(tag => tag.startsWith('#') ? tag : '#' + tag).join(' ');
        if (tags) {
            descText = `${tags}\n\n#shorts`;
        } else {
            descText = '#shorts';
        }
        
        statusCallback('typing', 'Trage Titel, Beschreibung und Einstellungen ein...');
        
        // Fill Title
        await page.evaluate((text) => {
            const el = document.querySelector('#title-textarea #textbox');
            if (el) {
                el.innerText = text;
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, titleText);
        
        await new Promise(r => setTimeout(r, 1000));
        
        // Fill Description
        await page.evaluate((text) => {
            const el = document.querySelector('#description-textarea #textbox');
            if (el) {
                el.innerText = text;
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, descText);
        
        await new Promise(r => setTimeout(r, 1000));
        
        // Select No, it's not made for kids
        await page.evaluate(() => {
            const kidsRadio = document.querySelector('tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_FALSE"]') ||
                              document.querySelector('tp-yt-paper-radio-button[value="false"]') ||
                              Array.from(document.querySelectorAll('tp-yt-paper-radio-button')).find(el => el.textContent.toLowerCase().includes('no') || el.textContent.toLowerCase().includes('nein'));
            if (kidsRadio) {
                kidsRadio.click();
            }
        });
        
        await new Promise(r => setTimeout(r, 2000));
        
        // Save screenshot of Details
        try {
            await page.screenshot({ path: path.join(publicClipsDir, `youtube_debug_${accountName}_2_details.png`) });
        } catch (e) {}
        
        // Click Next until Visibility step is reached
        const clickNextButton = async () => {
            return page.evaluate(() => {
                const nextBtn = document.querySelector('#next-button') || document.querySelector('ytcp-button#next-button');
                if (nextBtn) {
                    if (nextBtn.shadowRoot) {
                        const btn = nextBtn.shadowRoot.querySelector('button');
                        if (btn) { btn.click(); return true; }
                    }
                    nextBtn.click();
                    return true;
                }
                return false;
            });
        };
        
        let visStepReached = false;
        for (let step = 0; step < 10; step++) {
            const isPublicRadioVisible = await page.evaluate(() => {
                const publicRadio = document.querySelector('tp-yt-paper-radio-button[name="PUBLIC"]') ||
                                    document.querySelector('#public-radio-button') ||
                                    Array.from(document.querySelectorAll('tp-yt-paper-radio-button')).find(el => el.textContent.toLowerCase().includes('public') || el.textContent.toLowerCase().includes('öffentlich'));
                if (publicRadio) {
                    const rect = publicRadio.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                }
                return false;
            });
            
            if (isPublicRadioVisible) {
                console.log(`[YouTube Uploader] Visibility-Schritt erreicht.`);
                visStepReached = true;
                break;
            }
            
            console.log(`[YouTube Uploader] Klicke Weiter-Button (Schritt ${step + 1})...`);
            statusCallback('uploading', `Navigiere durch Upload-Schritte... (Schritt ${step + 1})`);
            
            const clicked = await clickNextButton();
            if (!clicked) {
                console.warn(`[YouTube Uploader] Weiter-Button nicht gefunden.`);
            }
            await new Promise(r => setTimeout(r, 2500));
        }
        
        if (!visStepReached) {
            // Take screenshot to see what got stuck
            try {
                await page.screenshot({ path: path.join(publicClipsDir, `youtube_debug_${accountName}_step_failed.png`) });
            } catch(e) {}
            throw new Error("Visibility-Schritt konnte nicht erreicht werden.");
        }
        
        // Choose visibility: Public
        await page.evaluate(() => {
            const publicRadio = document.querySelector('tp-yt-paper-radio-button[name="PUBLIC"]') ||
                                document.querySelector('#public-radio-button') ||
                                Array.from(document.querySelectorAll('tp-yt-paper-radio-button')).find(el => el.textContent.toLowerCase().includes('public') || el.textContent.toLowerCase().includes('öffentlich'));
            if (publicRadio) {
                publicRadio.click();
                console.log("[YouTube Uploader] Visibility auf 'Public' gesetzt.");
            }
        });
        
        await new Promise(r => setTimeout(r, 1500));
        
        // Save screenshot of Visibility
        try {
            await page.screenshot({ path: path.join(publicClipsDir, `youtube_debug_${accountName}_3_visibility.png`) });
        } catch (e) {}
        
        // Check for Google identity verification blocking popup
        const isVerificationBlocked = await page.evaluate(() => {
            const bodyText = document.body.innerText;
            return bodyText.includes('Identität bestätigen') || 
                   bodyText.includes("Verify it's you") ||
                   bodyText.includes('Confirm your identity') ||
                   !!document.querySelector('ytcp-identity-verification-dialog') ||
                   !!document.querySelector('ytcp-paper-dialog') && document.querySelector('ytcp-paper-dialog').innerText.includes('Identität');
        });
        
        if (isVerificationBlocked) {
            try {
                await page.screenshot({ path: path.join(publicClipsDir, `youtube_debug_${accountName}_verification_blocked.png`) });
            } catch(e) {}
            throw new Error("Google-Identitätsprüfung erforderlich. Bitte aktualisiere deine YouTube-Cookies im Dashboard.");
        }

        if (autoPublish) {
            statusCallback('posting', 'Klicke auf "Veröffentlichen"...');
            
            const clickPublishButton = async () => {
                return page.evaluate(() => {
                    const doneBtn = document.querySelector('#done-button') || 
                                    document.querySelector('ytcp-button#done-button') || 
                                    document.querySelector('#publish-button');
                    if (doneBtn) {
                        // Check if disabled
                        if (doneBtn.hasAttribute('disabled') || doneBtn.disabled) {
                            return 'disabled';
                        }
                        if (doneBtn.shadowRoot) {
                            const btn = doneBtn.shadowRoot.querySelector('button');
                            if (btn && (btn.hasAttribute('disabled') || btn.disabled)) {
                                return 'disabled';
                            }
                            if (btn) { btn.click(); return true; }
                        }
                        doneBtn.click();
                        return true;
                    }
                    return false;
                });
            };
            
            const publishResult = await clickPublishButton();
            if (publishResult === 'disabled') {
                throw new Error("Veröffentlichen-Button ist deaktiviert (Google-Identitätsprüfung erforderlich oder Video-Verarbeitungsfehler).");
            }
            if (!publishResult) {
                throw new Error("Veröffentlichen-Button (#done-button) konnte nicht gefunden werden.");
            }
            
            statusCallback('posting', 'Warte auf Veröffentlichungsbestätigung...');
            
            let publishConfirmed = false;
            for (let check = 0; check < 15; check++) {
                await new Promise(r => setTimeout(r, 2000));
                const confirmed = await page.evaluate(() => {
                    const shareUrlInput = document.querySelector('#share-url') || document.querySelector('.share-url') || document.querySelector('a[href*="youtu.be"]');
                    const closeBtn = document.querySelector('#close-button') || document.querySelector('ytcp-button#close-button');
                    const dialogTitle = document.querySelector('ytcp-uploads-still-processing-dialog') || document.querySelector('ytcp-video-share-dialog');
                    return !!(shareUrlInput || closeBtn || dialogTitle);
                });
                if (confirmed) {
                    publishConfirmed = true;
                    break;
                }
            }
            
            // Save final screenshot
            try {
                await page.screenshot({ path: path.join(publicClipsDir, `youtube_debug_${accountName}_4_published.png`) });
            } catch (e) {}
            
            if (!publishConfirmed) {
                console.warn("[YouTube Uploader] Konnte Veröffentlichungs-Bestätigungsfenster nicht explizit finden, nehme Erfolg an.");
            }
            
            statusCallback('done', 'Video wurde erfolgreich auf YouTube Shorts veröffentlicht!');
        } else {
            statusCallback('done', 'Video wurde erfolgreich als Entwurf vorbereitet!');
        }
        
    } catch (err) {
        statusCallback('error', err.message);
        throw err;
    } finally {
        if (browser) {
            try {
                await browser.close();
            } catch (closeErr) {}
        }
    }
}

let isProcessingQueue = false;

async function startTiktokQueueListener(db, clipperManager) {
    console.log("[TikTok Server Queue] Starte Firebase Queue-Listener für TikTok...");
    
    // Auto-clean stuck jobs and renders on startup
    try {
        const tqSnap = await db.ref('clipper/tiktok_queue').once('value');
        const tq = tqSnap.val() || {};
        for (const [id, job] of Object.entries(tq)) {
            if (job.status === 'uploading' || job.status === 'starting' || job.status === 'posting' || job.status === 'typing') {
                console.log(`[TikTok Server Queue] Bereinige hängenden Job ${id} (Status: ${job.status}) auf 'failed'...`);
                await db.ref(`clipper/tiktok_queue/${id}`).update({
                    status: 'failed',
                    error: 'Server wurde während des Uploads neu gestartet.',
                    progressMessage: 'Fehler: Server-Neustart.'
                });
            }
        }
        
        const rendersSnap = await db.ref('clipper/renders').once('value');
        const renders = rendersSnap.val() || {};
        for (const [id, job] of Object.entries(renders)) {
            if (job.status === 'downloading' || job.status === 'rendering') {
                console.log(`[Clipper] Bereinige hängenden Render-Job ${id} (Status: ${job.status}) auf 'failed'...`);
                await db.ref(`clipper/renders/${id}`).update({
                    status: 'failed',
                    error: 'Server wurde während des Renderns neu gestartet.'
                });
            }
        }
    } catch (err) {
        console.error("[TikTok Server Queue] Fehler bei Startup-Bereinigung:", err.message);
    }
    
    db.ref('clipper/tiktok_queue').on('value', async (snapshot) => {
        if (isProcessingQueue) return;
        isProcessingQueue = true;
        
        try {
            while (true) {
                const latestSnap = await db.ref('clipper/tiktok_queue').once('value');
                const queue = latestSnap.val() || {};
                const pendingJobs = Object.values(queue)
                    .filter(job => job.status === 'pending')
                    .sort((a, b) => a.timestamp - b.timestamp);
                    
                if (pendingJobs.length === 0) {
                    break;
                }
                
                const job = pendingJobs[0];
                
                // Validate job data before processing
                if (!job.id || !job.url) {
                    console.error(`[TikTok Server Queue] Job ungültig (fehlende id oder url), überspringe:`, JSON.stringify(job));
                    if (job.id) {
                        await db.ref(`clipper/tiktok_queue/${job.id}`).update({
                            status: 'failed',
                            error: 'Job ungültig: URL oder ID fehlt.',
                            progressMessage: 'Fehler: URL/ID fehlt.'
                        });
                    }
                    continue;
                }
                
                console.log(`[TikTok Server Queue] Verarbeite Job ${job.id} für Streamer ${job.streamerName}`);
                
                try {
                    await db.ref(`clipper/tiktok_queue/${job.id}`).update({
                        status: 'uploading',
                        progressMessage: 'Bereite Video vor...'
                    });
                    
                    const filename = job.url.substring(job.url.lastIndexOf('/') + 1);
                    const localPath = path.join(clipperManager.clipsDir, filename);
                    
                    let fileExists = fs.existsSync(localPath);
                    
                    if (!fileExists) {
                        try {
                            await db.ref(`clipper/tiktok_queue/${job.id}`).update({
                                progressMessage: 'Lade Video von URL herunter...'
                            });
                            const response = await fetch(job.url);
                            if (!response.ok) throw new Error(`HTTP ${response.status}`);
                            const buffer = await response.arrayBuffer();
                            fs.writeFileSync(localPath, Buffer.from(buffer));
                            fileExists = true;
                        } catch (err) {
                            console.error("[TikTok Server Queue] Download failed:", err.message);
                        }
                    }
                    
                    if (!fileExists) {
                        throw new Error("Videodatei konnte nicht auf dem Server gefunden werden.");
                    }
                    
                    await db.ref(`clipper/tiktok_queue/${job.id}`).update({
                        status: 'uploading',
                        progressMessage: 'Starte Chrome auf Server...'
                    });
                    
                    const firebaseStatusCallback = async (state, message) => {
                        await db.ref(`clipper/tiktok_queue/${job.id}`).update({
                            status: state,
                            progressMessage: message
                        });
                    };
                    
                    await runTikTokUploadOnServer(
                        localPath,
                        job.caption || '',
                        job.hashtags ? job.hashtags.split(' ').filter(t => t) : [],
                        true,
                        job.tiktokAccount || 'default',
                        firebaseStatusCallback
                    );
                    
                    const currentSnap = await db.ref(`clipper/tiktok_queue/${job.id}/status`).once('value');
                    if (currentSnap.val() === 'done') {
                        await db.ref(`clipper/tiktok_queue/${job.id}`).update({
                            postedAt: Date.now()
                        });
                    }
                } catch (jobErr) {
                    console.error(`[TikTok Server Queue] Fehler bei Job ${job.id}:`, jobErr.message);
                    await db.ref(`clipper/tiktok_queue/${job.id}`).update({
                        status: 'failed',
                        error: jobErr.message,
                        progressMessage: `Fehler: ${jobErr.message}`
                    });
                }
            }
        } catch (globalErr) {
            console.error("[TikTok Server Queue] Globaler Schleifenfehler:", globalErr.message);
        } finally {
            isProcessingQueue = false;
        }
    });
}

async function runTikTokUploadOnServer(videoPath, caption, hashtags, autoPublish, tiktokAccount = 'default', statusCallback) {
    let browser = null;
    try {
        statusCallback('starting', 'Initialisiere Chrome...');
        
        let accountName = (tiktokAccount || 'default').replace(/[^a-zA-Z0-9_]/g, '');
        const sessionDir = path.join(__dirname, 'tiktok_sessions', `tiktok_session_${accountName}`);

        let publicClipsDir = path.join(__dirname, '../public/clips');
        if (fs.existsSync('/var/www/bingo/public/clips')) {
            publicClipsDir = '/var/www/bingo/public/clips';
        } else if (fs.existsSync(path.join(__dirname, '..', 'bingo', 'public', 'clips'))) {
            publicClipsDir = path.join(__dirname, '..', 'bingo', 'public', 'clips');
        }

        // Lösche stale SingletonLock, SingletonCookie und SingletonSocket, falls Chrome vorher abgestürzt ist
        const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
        for (const file of lockFiles) {
            const filePath = path.join(sessionDir, file);
            try {
                fs.unlinkSync(filePath);
                console.log(`[TikTok Uploader] Stale ${file} gelöscht für ${accountName}`);
            } catch (e) {
                if (e.code !== 'ENOENT') {
                    console.warn(`[TikTok Uploader] Fehler beim Löschen von ${file} für ${accountName}:`, e.message);
                }
            }
        }

        console.log(`[TikTok Uploader] Starte Puppeteer mit headless: new...`);
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security',
                '--disable-gpu',
                '--disable-dev-shm-usage'
            ],
            userDataDir: sessionDir
        });
        console.log(`[TikTok Uploader] Puppeteer erfolgreich gestartet.`);

        const pages = await browser.pages();
        const page = pages.length > 0 ? pages[0] : await browser.newPage();
        console.log(`[TikTok Uploader] Seite erstellt / geholt.`);
        
        await page.bringToFront();
        console.log(`[TikTok Uploader] page.bringToFront() erfolgreich.`);
        
        await page.setViewport({ width: 1280, height: 800 });
        console.log(`[TikTok Uploader] Viewport gesetzt.`);
        
        // Set User-Agent and Language to simulate a normal user browser
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7' });
        
        // Injiziere manuelles Cookie, falls vorhanden
        const manualCookieFile = path.join(__dirname, 'tiktok_sessions', `tiktok_cookie_${accountName}.txt`);
        if (fs.existsSync(manualCookieFile)) {
            const manualCookieVal = fs.readFileSync(manualCookieFile, 'utf8').trim();
            if (manualCookieVal) {
                console.log(`[TikTok Uploader] Lade manuelles Session-Cookie für ${accountName}...`);
                statusCallback('starting', 'Lade manuelles Session-Cookie...');
                
                console.log(`[TikTok Uploader] Navigiere zu tiktok.com für Cookie-Injektion...`);
                await page.goto('https://www.tiktok.com', { waitUntil: 'domcontentloaded' });
                console.log(`[TikTok Uploader] Navigation zu tiktok.com erfolgreich.`);
                
                console.log(`[TikTok Uploader] Setze Session-Cookies...`);
                await page.setCookie(
                    {
                        name: 'sessionid',
                        value: manualCookieVal,
                        domain: '.tiktok.com',
                        path: '/',
                        httpOnly: true,
                        secure: true
                    },
                    {
                        name: 'sessionid_ss',
                        value: manualCookieVal,
                        domain: '.tiktok.com',
                        path: '/',
                        httpOnly: true,
                        secure: true
                    }
                );
                console.log(`[TikTok Uploader] Session-Cookies erfolgreich gesetzt.`);
            }
        }
        
        statusCallback('starting', 'Navigiere zu TikTok Studio...');
        console.log(`[TikTok Uploader] Navigiere zu TikTok Studio Upload-Seite...`);
        // Use networkidle0 or domcontentloaded as fallback
        await page.goto('https://www.tiktok.com/tiktokstudio/upload', { 
            waitUntil: 'domcontentloaded',
            timeout: 60000 
        });
        console.log(`[TikTok Uploader] Navigation zu TikTok Studio Upload-Seite erfolgreich.`);
        // Wait a bit for scripts to settle
        await new Promise(r => setTimeout(r, 3000));

        // Check if page loaded into a crash screen
        const loadCrashMsg = await page.evaluate(() => {
            const bodyText = document.body.textContent.toLowerCase();
            if (bodyText.includes('something went wrong') || 
                bodyText.includes('please try again') || 
                bodyText.includes('etwas ist schiefgelaufen') ||
                bodyText.includes('versuche es später erneut') || 
                bodyText.includes('versuch es später erneut')) {
                // Look for a Retry button to see if we can click it
                const buttons = Array.from(document.querySelectorAll('button'));
                const retryBtn = buttons.find(b => {
                    const txt = b.textContent.toLowerCase().trim();
                    return txt.includes('retry') || txt.includes('erneut') || txt.includes('wiederholen');
                });
                if (retryBtn && typeof retryBtn.click === 'function') {
                    retryBtn.click();
                    return 'retry_clicked';
                }
                return 'crash_detected';
            }
            return null;
        });

        if (loadCrashMsg === 'retry_clicked') {
            console.log('[TikTok Uploader] Crash-Bildschirm beim Laden erkannt, "Retry"-Button geklickt. Warte 5s...');
            await new Promise(r => setTimeout(r, 5000));
        } else if (loadCrashMsg === 'crash_detected') {
            throw new Error('TikTok-Fehler beim Laden der Seite: "Something went wrong" (System-Crash-Bildschirm).');
        }

        // Deaktiviere beforeunload Warnungen, um hängende Exit-Dialoge beim Schließen zu verhindern
        await page.evaluate(() => {
            window.onbeforeunload = null;
        });

        let hasFileInput = false;
        const fileInputSelectors = ['input[type="file"]', 'input[accept*="video"]', 'input[name="video"]'];
        for (const sel of fileInputSelectors) {
            hasFileInput = !!(await page.$(sel));
            if (hasFileInput) break;
        }
        
        if (!hasFileInput) {
            try {
                await page.screenshot({ path: path.join(publicClipsDir, `tiktok_debug_${accountName}_login_failed.png`) });
            } catch(e) {}
            throw new Error('Nicht eingeloggt. Bitte verbinde zuerst deinen TikTok-Account im Dashboard.');
        }

        statusCallback('uploading', 'Videodatei wird hochgeladen...');
        let fileInput = null;
        for (const sel of fileInputSelectors) {
            fileInput = await page.$(sel);
            if (fileInput) break;
        }
        if (!fileInput) {
            throw new Error('Konnte das Upload-Dateifeld nicht finden.');
        }
        
        await fileInput.uploadFile(videoPath);

        statusCallback('uploading', 'Video hochgeladen. Warte auf Verarbeitung...');
        
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
            // Check for crash screen during upload
            const uploadCrashDetected = await page.evaluate(() => {
                const bodyText = document.body.textContent.toLowerCase();
                return bodyText.includes('something went wrong') || 
                       bodyText.includes('please try again') || 
                       bodyText.includes('etwas ist schiefgelaufen') ||
                       bodyText.includes('versuche es später erneut') || 
                       bodyText.includes('versuch es später erneut');
            });
            if (uploadCrashDetected) {
                throw new Error('TikTok-Fehler während des Uploads: "Something went wrong" (System-Crash-Bildschirm).');
            }

            await new Promise(r => setTimeout(r, 2000));
        }
        
        if (!descriptionSelector) {
            throw new Error('Konnte das Beschreibungsfeld nicht finden.');
        }
        
        // Wait another 10 seconds for safety (TikTok needs time to process upload)
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

        const fullCaption = `${caption} ${hashtags.map(tag => tag.startsWith('#') ? tag : '#' + tag).join(' ')}`;
        await page.keyboard.type(fullCaption, { delay: 50 });

        if (autoPublish) {
            statusCallback('posting', 'Bereite Veröffentlichung vor...');
            
            // Save debug screenshot before waiting/clicking
            try {
                await page.screenshot({ path: path.join(publicClipsDir, `tiktok_debug_${accountName}_1_before_post.png`) });
            } catch (e) {
                console.warn("[TikTok Upload] Screenshot failed:", e.message);
            }

            let isPostBtnEnabled = false;
            statusCallback('posting', 'Warte, bis der Veröffentlichen-Button aktiv ist...');
            
            // Wait up to 120 seconds for post button to be enabled (no disabled attribute, no disabled class)
            for (let i = 0; i < 120; i++) {
                // Programmatically close blocking modals (Cookie banner & dialog modals like Copyright check)
                await page.evaluate(() => {
                    window.onbeforeunload = null;
                    
                    // Helper to find clickable elements (buttons, links) matching text, including in shadow roots
                    const findClickableByText = (txt, root = document) => {
                        const candidates = root.querySelectorAll('button, [role="button"], a, [class*="btn"], [class*="Button"]');
                        for (const el of candidates) {
                            if (el.textContent && el.textContent.trim().toLowerCase() === txt.toLowerCase()) {
                                return el;
                            }
                        }
                        // Recurse into shadow roots
                        for (const el of root.querySelectorAll('*')) {
                            if (el.shadowRoot) {
                                const found = findClickableByText(txt, el.shadowRoot);
                                if (found) return found;
                            }
                        }
                        return null;
                    };
                    
                    // Helper to find all elements matching a selector, including in shadow roots
                    const findAllEls = (selector, root = document, results = []) => {
                        for (const el of root.querySelectorAll(selector)) {
                            results.push(el);
                        }
                        for (const el of root.querySelectorAll('*')) {
                            if (el.shadowRoot) {
                                findAllEls(selector, el.shadowRoot, results);
                            }
                        }
                        return results;
                    };

                    // Cookie-Consent click
                    const cookieBtn = findClickableByText('Allow all') || 
                                      findClickableByText('Alle zulassen') || 
                                      findClickableByText('Decline optional cookies') || 
                                      findClickableByText('Optionale Cookies ablehnen');
                    if (cookieBtn && typeof cookieBtn.click === 'function') {
                        cookieBtn.click();
                    }
                    
                    // Fallback: Lösche/Verberge Cookie-Banner per CSS falls der Klick nicht funktionierte oder das Banner noch da ist
                    try {
                        const divs = findAllEls('div');
                        for (const d of divs) {
                            const style = window.getComputedStyle(d);
                            if (style.position === 'fixed' && d.textContent && d.textContent.toLowerCase().includes('cookies from tiktok')) {
                                d.style.display = 'none';
                                d.style.visibility = 'hidden';
                                d.style.opacity = '0';
                                d.style.pointerEvents = 'none';
                            }
                        }
                    } catch(e) {}
                    
                    // Modale schließen (inklusive Joyride Tooltips / Alertdialogs)
                    const dialogs = findAllEls('[role="dialog"], [role="alertdialog"], dialog, [class*="modal"], [class*="tooltip"], [class*="joyride"]');
                    for (const dialog of dialogs) {
                        const btns = dialog.querySelectorAll('button, [role="button"]');
                        for (const btn of btns) {
                            const t = btn.textContent ? btn.textContent.trim().toLowerCase() : '';
                            if (t === 'cancel' || t === 'abbrechen' || t === 'close' || t === 'schließen' || t === 'got it' || t === 'verstanden' || t === 'ok' || t === 'alles klar') {
                                btn.click();
                                break;
                            }
                        }
                    }
                });

                // Check for crash screen during post wait loop
                const postCrashDetected = await page.evaluate(() => {
                    const bodyText = document.body.textContent.toLowerCase();
                    return bodyText.includes('something went wrong') || 
                           bodyText.includes('please try again') || 
                           bodyText.includes('etwas ist schiefgelaufen') ||
                           bodyText.includes('versuche es später erneut') || 
                           bodyText.includes('versuch es später erneut');
                });
                if (postCrashDetected) {
                    throw new Error('TikTok-Fehler beim Veröffentlichen: "Something went wrong" (System-Crash-Bildschirm).');
                }

                const btnState = await page.evaluate(() => {
                    const isSidebarOrHeader = (el) => {
                        return !!(
                            el.closest('header') || 
                            el.closest('aside') || 
                            el.closest('nav') || 
                            el.closest('[class*="header"]') || 
                            el.closest('[class*="sidebar"]') ||
                            el.closest('[data-tt*="Sidebar"]') ||
                            el.closest('[data-tt*="Header"]') ||
                            el.closest('[class*="css-77vl8h"]') ||
                            el.closest('[class*="ewmbf5a2"]')
                        );
                    };

                    // Methode 0: data-e2e selector (highly reliable)
                    let btn = document.querySelector('button[data-e2e="post_video_button"]');
                    
                    if (btn && isSidebarOrHeader(btn)) {
                        btn = null;
                    }

                    if (!btn) {
                        // Methode 1: TikTok nutzt 'Button__root--type-primary' für den Haupt-Action-Button
                        const primaryButtons = document.querySelectorAll('button.Button__root--type-primary, button[class*="Button__root--type-primary"]');
                        for (const b of primaryButtons) {
                            const txt = b.textContent.toLowerCase().trim();
                            // Überspringe den "Select video" Upload-Trigger-Button
                            if (txt.includes('select') || txt.includes('auswählen')) continue;
                            // Überspringe Header/Sidebar Upload Buttons (die haben oft aria-disabled="true")
                            if (isSidebarOrHeader(b)) continue;
                            
                            // Der echte Post-Button hat Text wie "Post", "Upload", "Veröffentlichen" etc.
                            if (txt === 'post' || txt === 'upload' || txt === 'veröffentlichen' || txt === 'publish' || txt === 'hochladen' || txt === 'teilen') {
                                btn = b;
                                break;
                            }
                        }
                    }
                    
                    if (!btn) {
                        // Methode 2: Fallback über Text-Matching (ohne Sidebar/Header)
                        const allBtns = Array.from(document.querySelectorAll('button'));
                        btn = allBtns.find(b => {
                            const txt = b.textContent.toLowerCase().trim();
                            // Sidebar-Buttons ignorieren
                            if (b.className.includes('e1rf0ws82') || isSidebarOrHeader(b)) return false;
                            if (txt.includes('posts')) return false;
                            return txt === 'post' || txt === 'upload' || txt === 'veröffentlichen' || txt === 'publish';
                        });
                    }
                    
                    if (!btn) return { exists: false, disabled: true, ariaDisabled: null };
                    const isDisabled = btn.disabled || btn.getAttribute('disabled') !== null || btn.classList.contains('disabled');
                    const ariaDisabled = btn.getAttribute('aria-disabled');
                    return { exists: true, disabled: isDisabled, ariaDisabled: ariaDisabled, text: btn.textContent.trim() };
                });
                
                if (btnState.exists && !btnState.disabled && btnState.ariaDisabled !== 'true') {
                    isPostBtnEnabled = true;
                    break;
                }
                
                if (i % 10 === 0) {
                    statusCallback('posting', `Warte auf Verarbeitung... (${i}s)`);
                }
                await new Promise(r => setTimeout(r, 1000));
            }

            // Save debug screenshot right before click
            try {
                await page.screenshot({ path: path.join(publicClipsDir, `tiktok_debug_${accountName}_2_ready_to_click.png`) });
            } catch (e) {
                console.warn("[TikTok Upload] Screenshot failed:", e.message);
            }

            if (!isPostBtnEnabled) {
                // HTML-Dump für Remote-Debugging speichern
                try {
                    const html = await page.content();
                    fs.writeFileSync(path.join(publicClipsDir, `tiktok_debug_${accountName}_dom_dump.html`), html);
                    console.log(`[TikTok Upload] DOM-Dump gespeichert für Debugging.`);
                } catch (e) {}
                throw new Error('Veröffentlichen-Button wurde nach 5 Minuten nicht aktiv (Video-Verarbeitung dauerte zu lange, Login-Fehler oder Button nicht gefunden).');
            }
            
            // Normaler Klick (Button war voll aktiv)
            statusCallback('posting', 'Klicke auf "Veröffentlichen"...');
            
            await page.evaluate(() => {
                let btn = document.querySelector('button[data-e2e="post_video_button"]');
                if (btn && typeof btn.click === 'function') {
                    btn.click();
                    return;
                }
                const primaryButtons = document.querySelectorAll('button.Button__root--type-primary, button[class*="Button__root--type-primary"]');
                for (const b of primaryButtons) {
                    const txt = b.textContent.toLowerCase().trim();
                    if (b.closest('header') || b.closest('aside') || b.closest('nav') || b.closest('[class*="header"]') || b.closest('[class*="sidebar"]') || b.closest('[data-tt*="Sidebar"]') || b.closest('[data-tt*="Header"]') || b.closest('[class*="css-77vl8h"]') || b.closest('[class*="ewmbf5a2"]')) continue;
                    if (txt === 'post' || txt === 'posten' || txt === 'upload' || txt === 'veröffentlichen' || txt === 'publish' || txt === 'hochladen' || txt === 'teilen') {
                        b.click();
                        break;
                    }
                }
            });

            statusCallback('posting', 'Veröffentlichung läuft...');
            await new Promise(r => setTimeout(r, 25000));

            // Finale Screenshot für Verifizierung
            try {
                await page.screenshot({ path: path.join(publicClipsDir, `tiktok_debug_${accountName}_3_after_click.png`) });
            } catch (e) {
                console.warn("[TikTok Upload] Screenshot failed:", e.message);
            }

            // Verifiziere, ob es wirklich erfolgreich war, indem wir checken ob der Post-Button weg ist oder die URL sich geändert hat
            const stillHasButton = await page.evaluate(() => {
                // Wenn die URL nicht mehr die Upload-Seite ist, war es 100% erfolgreich!
                if (!window.location.href.includes('/upload')) {
                    return false;
                }
                
                let btn = document.querySelector('button[data-e2e="post_video_button"]');
                if (btn) return true;
                
                const primaryButtons = document.querySelectorAll('button.Button__root--type-primary, button[class*="Button__root--type-primary"]');
                for (const b of primaryButtons) {
                    const txt = b.textContent.toLowerCase().trim();
                    if (b.closest('header') || b.closest('aside') || b.closest('nav') || b.closest('[class*="header"]') || b.closest('[class*="sidebar"]') || b.closest('[data-tt*="Sidebar"]') || b.closest('[data-tt*="Header"]') || b.closest('[class*="css-77vl8h"]') || b.closest('[class*="ewmbf5a2"]')) continue;
                    // Wir prüfen hier NICHT auf 'upload', um Falschmeldungen auf anderen Seiten zu vermeiden
                    if (txt === 'post' || txt === 'posten' || txt === 'veröffentlichen' || txt === 'publish' || txt === 'hochladen' || txt === 'teilen') {
                        return true;
                    }
                }
                return false;
            });

            if (stillHasButton) {
                // Mach einen finalen Screenshot für Fehlersuche
                try {
                    await page.screenshot({ path: path.join(publicClipsDir, `tiktok_debug_${accountName}_4_failed_click.png`) });
                } catch (e) {}
                throw new Error('TikTok hat den Klick ignoriert oder blockiert. Möglicherweise wird mehr Zeit für den Upload benötigt.');
            }

            statusCallback('done', 'Video wurde erfolgreich auf TikTok veröffentlicht!');
        } else {
            statusCallback('done', 'Video wurde erfolgreich als Entwurf vorbereitet!');
        }

    } catch (err) {
        statusCallback('error', err.message);
        throw err;
    } finally {
        if (browser) {
            try {
                await browser.close();
            } catch (closeErr) {}
        }
    }
}

function verifyFaceInRenderedClip(clipPath) {
    return new Promise((resolve) => {
        const { exec } = require('child_process');
        const scriptPath = path.join(__dirname, 'verify_face_in_render.py');
        const cascadeXml = path.join(__dirname, 'haarcascade_frontalface_default.xml');
        
        if (!fs.existsSync(scriptPath) || !fs.existsSync(cascadeXml)) {
            console.warn("[Face Gate] verify_face_in_render.py oder haarcascade XML fehlt, überspringe Verifikation.");
            return resolve(true); // Bypass if files missing
        }
        
        console.log(`[Face Gate] Verifiziere Gesicht in gerendertem Clip: ${clipPath}`);
        exec(`python3 "${scriptPath}" "${clipPath}" "${cascadeXml}"`, (err, stdout, stderr) => {
            if (err) {
                console.error("[Face Gate] Fehler bei Ausführung von verify_face_in_render.py:", err.message);
                return resolve(true); // Bypass on error to not block uploads entirely
            }
            try {
                const res = JSON.parse(stdout.trim());
                if (res && res.error) {
                    console.warn("[Face Gate] Python Skript Fehler:", res.error);
                    return resolve(true);
                }
                console.log(`[Face Gate] Verifikations-Ergebnis:`, res);
                resolve(res.face_detected);
            } catch (parseErr) {
                console.error("[Face Gate] JSON Parse Fehler:", parseErr.message, stdout);
                resolve(true); // Bypass on parse error
            }
        });
    });
}

// Helper to queue upload to TikTok in Firebase
async function queueTikTokUpload(clipData, streamerName, captionText, customTiktokAccount = null, layout = null) {
    try {
        const cleanStreamerName = (streamerName || 'Streamer').toLowerCase().trim();
        const chanSnap = await db.ref(`clipper/channels/${cleanStreamerName}`).once('value');
        const channelConfig = chanSnap.val() || {};
        
        const uploadJobId = db.ref('clipper/tiktok_queue').push().key;
        const clipUrl = `https://minusnd.de/public/clips/${clipData.filename}`;
        
        let initialStatus = 'pending';
        let progressMessage = 'Wartend...';
        
        const isFacecam = layout && layout !== 'blur-bg' && layout !== 'blur-bg-logo';
        if (isFacecam) {
            const localPath = path.join(clipperManager.clipsDir, clipData.filename);
            const faceDetected = await verifyFaceInRenderedClip(localPath);
            if (!faceDetected) {
                console.log(`[Face Gate] Kein Gesicht in der Facecam von ${clipData.filename} erkannt! Setze Job auf 'pending_verification'.`);
                initialStatus = 'pending_verification';
                progressMessage = 'Gesicht nicht in Facecam erkannt. Manuelle Freigabe erforderlich.';
            } else {
                console.log(`[Face Gate] Gesicht erfolgreich in der Facecam von ${clipData.filename} erkannt!`);
                progressMessage = 'Gesicht verifiziert. Bereit zum Upload.';
            }
        }
        
        await db.ref(`clipper/tiktok_queue/${uploadJobId}`).set({
            id: uploadJobId,
            url: clipUrl,
            caption: (captionText !== undefined && captionText !== null && captionText !== '') ? captionText : (channelConfig.tiktokCaption || ''),
            hashtags: channelConfig.tiktokHashtags || "#fyp #viral #twitch",
            tiktokAccount: customTiktokAccount || channelConfig.tiktokAccount || "default",
            status: initialStatus,
            progressMessage: progressMessage,
            timestamp: Date.now(),
            streamerName: cleanStreamerName,
            clipId: clipData.id || ''
        });
        console.log(`[TikTok Queue] Queued upload job ${uploadJobId} for ${cleanStreamerName} on account ${customTiktokAccount || channelConfig.tiktokAccount || "default"} with status ${initialStatus}`);
    } catch (err) {
        console.error("[TikTok Queue] Error queueing upload:", err.message);
    }
}

async function queueYoutubeUpload(clipData, streamerName, captionText, customYoutubeAccount = null, layout = null) {
    try {
        const cleanStreamerName = (streamerName || 'Streamer').toLowerCase().trim();
        const chanSnap = await db.ref(`clipper/channels/${cleanStreamerName}`).once('value');
        const channelConfig = chanSnap.val() || {};
        
        const uploadJobId = db.ref('clipper/youtube_queue').push().key;
        const clipUrl = `https://minusnd.de/public/clips/${clipData.filename}`;
        
        let initialStatus = 'pending';
        let progressMessage = 'Wartend...';
        
        const isFacecam = layout && layout !== 'blur-bg' && layout !== 'blur-bg-logo';
        if (isFacecam) {
            const localPath = path.join(clipperManager.clipsDir, clipData.filename);
            const faceDetected = await verifyFaceInRenderedClip(localPath);
            if (!faceDetected) {
                console.log(`[Face Gate] Kein Gesicht in der Facecam von ${clipData.filename} für YouTube erkannt! Setze Job auf 'pending_verification'.`);
                initialStatus = 'pending_verification';
                progressMessage = 'Gesicht nicht in Facecam erkannt. Manuelle Freigabe erforderlich.';
            } else {
                console.log(`[Face Gate] Gesicht erfolgreich in der Facecam von ${clipData.filename} für YouTube erkannt!`);
                progressMessage = 'Gesicht verifiziert. Bereit zum Upload.';
            }
        }
        
        await db.ref(`clipper/youtube_queue/${uploadJobId}`).set({
            id: uploadJobId,
            url: clipUrl,
            caption: (captionText !== undefined && captionText !== null && captionText !== '') ? captionText : (channelConfig.youtubeCaption || ''),
            hashtags: channelConfig.youtubeHashtags || "#shorts #viral",
            youtubeAccount: customYoutubeAccount || channelConfig.youtubeAccount || "default",
            status: initialStatus,
            progressMessage: progressMessage,
            timestamp: Date.now(),
            streamerName: cleanStreamerName,
            clipId: clipData.id || ''
        });
        console.log(`[YouTube Queue] Queued upload job ${uploadJobId} for ${cleanStreamerName} on account ${customYoutubeAccount || channelConfig.youtubeAccount || "default"} with status ${initialStatus}`);
    } catch (err) {
        console.error("[YouTube Queue] Error queueing upload:", err.message);
    }
}



// Background Twitch Clip Agent (24/7) poller
function startTwitchClipAgent(db, clipperManager) {
    console.log("[Agent] Starte automatischen Twitch Clip Agent Background-Poller (alle 3 Minuten)...");
    
    // Round-Robin: Merkt sich welcher Kanal zuletzt dran war
    let lastChannelIndex = -1;
    
    const runPoller = async () => {
        try {
            // Check global agent flag
            const configSnap = await db.ref('clipper/config').once('value');
            const config = configSnap.val() || {};
            if (!config.agentActive) {
                return;
            }
            
            // === SEQUENTIAL GATE: Don't start anything new if a render is in progress or TikTok uploads are pending ===
            const rendersSnap = await db.ref('clipper/renders').once('value');
            const renders = rendersSnap.val() || {};
            const hasActiveRender = Object.values(renders).some(j => j.status === 'rendering' || j.status === 'downloading');
            if (hasActiveRender) {
                console.log('[Agent] Überspringe Poll: Es läuft bereits ein Render-Vorgang.');
                return;
            }
            
            const tqSnap = await db.ref('clipper/tiktok_queue').once('value');
            const tqJobs = tqSnap.val() || {};
            const hasPendingUpload = Object.values(tqJobs).some(j => j.status === 'pending' || j.status === 'uploading' || j.status === 'starting' || j.status === 'posting' || j.status === 'typing');
            if (hasPendingUpload) {
                console.log('[Agent] Überspringe Poll: Es gibt noch ausstehende TikTok-Uploads.');
                return;
            }
            // === END SEQUENTIAL GATE ===
            
            const channelsSnap = await db.ref('clipper/channels').once('value');
            const channels = channelsSnap.val() || {};
            
            const activeChannels = Object.values(channels).filter(c => c.isActive !== false && c.isAgentActive === true);
            if (activeChannels.length === 0) return;
            
            const accessToken = await getTwitchAccessToken();
            
            const fs = require('fs');
            const path = require('path');
            
            // === ROUND-ROBIN: Starte beim nächsten Kanal nach dem zuletzt verarbeiteten ===
            const startIdx = (lastChannelIndex + 1) % activeChannels.length;
            const rotatedChannels = [
                ...activeChannels.slice(startIdx),
                ...activeChannels.slice(0, startIdx)
            ];
            console.log(`[Agent] Round-Robin: Starte bei Kanal ${startIdx + 1}/${activeChannels.length} (${rotatedChannels.map(c => c.name).join(', ')})`);
            
            for (const channel of rotatedChannels) {
                const channelName = channel.name.toLowerCase().trim();
                
                const userRes = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(channelName)}`, {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Client-Id': process.env.TWITCH_CLIENT_ID
                    }
                });
                const userData = await userRes.json();
                if (!userData.data || userData.data.length === 0) continue;
                const broadcasterId = userData.data[0].id;
                
                // Get clips created in the last 2 hours
                const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
                const clipsUrl = `https://api.twitch.tv/helix/clips?broadcaster_id=${broadcasterId}&started_at=${startedAt}&first=100`;
                
                const clipsRes = await fetch(clipsUrl, {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Client-Id': process.env.TWITCH_CLIENT_ID
                    }
                });
                const clipsData = await clipsRes.json();
                if (!clipsData.data || clipsData.data.length === 0) continue;
                
                // Process chronologically (oldest first)
                const clipsSorted = clipsData.data.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
                
                // --- Deduplizierung: Nur den besten unverarbeiteten Clip nehmen ---
                // Alle bereits verarbeiteten Clip-IDs sammeln
                const allUnprocessed = [];
                for (const clip of clipsSorted) {
                    const processedSnap = await db.ref(`clipper/processed_clips/${clip.id}`).once('value');
                    if (!processedSnap.exists()) {
                        allUnprocessed.push(clip);
                    }
                }
                
                if (allUnprocessed.length === 0) continue;
                
                // Den Clip mit den meisten Views aus allen unverarbeiteten nehmen
                const bestClip = allUnprocessed.reduce((best, clip) => 
                    (clip.view_count || 0) > (best.view_count || 0) ? clip : best
                , allUnprocessed[0]);
                
                // Alle Clips die zeitlich nah am besten sind (±60s) als Duplikate markieren
                const bestTime = new Date(bestClip.created_at).getTime();
                const nearbyMs = 60 * 1000;
                const skippedClips = allUnprocessed.filter(c => {
                    if (c.id === bestClip.id) return false;
                    const t = new Date(c.created_at).getTime();
                    return Math.abs(t - bestTime) <= nearbyMs;
                });
                
                for (const skipped of skippedClips) {
                    await db.ref(`clipper/processed_clips/${skipped.id}`).set({
                        id: skipped.id,
                        title: skipped.title,
                        channelName: channelName,
                        createdAt: skipped.created_at,
                        processedAt: Date.now(),
                        status: 'skipped_duplicate',
                        bestClipId: bestClip.id,
                        viewCount: skipped.view_count || 0
                    });
                }
                
                console.log(`[Agent] ${channelName}: ${clipsSorted.length} Clips total, ${allUnprocessed.length} unverarbeitet, Bester: "${bestClip.title}" (${bestClip.view_count || 0} Views, ${skippedClips.length} Duplikate übersprungen)`);
                
                const twitchClip = bestClip;
                
                // Reserve clip ID
                await db.ref(`clipper/processed_clips/${twitchClip.id}`).set({
                    id: twitchClip.id,
                    title: twitchClip.title,
                    channelName: channelName,
                    createdAt: twitchClip.created_at,
                    processedAt: Date.now(),
                    status: 'processing',
                    viewCount: twitchClip.view_count || 0
                });
                
                const jobId = db.ref('clipper/renders').push().key;
                const targetFilename = `twitch_${twitchClip.id}.mp4`;
                
                await db.ref(`clipper/renders/${jobId}`).set({
                    id: jobId,
                    status: 'downloading',
                    filename: targetFilename,
                    timestamp: Date.now(),
                    autoPublish: true,
                    streamerName: channelName,
                    progress: 0,
                    isAgentJob: true
                });
                
                // Sequentielle Verarbeitung: nur 1 Clip gleichzeitig, danach nächster Poll-Zyklus
                const tempPath = path.join(clipperManager.clipsDir, targetFilename);
                try {
                    let mp4Url = extractClipMp4Url(twitchClip.thumbnail_url);
                    
                    let response = null;
                    if (mp4Url) {
                        response = await fetch(mp4Url);
                        if (!response.ok) {
                            console.warn(`[Agent] Thumbnail-based MP4 URL returned HTTP ${response.status} for ${twitchClip.id}, trying GraphQL...`);
                            mp4Url = "";
                        }
                    }
                    
                    if (!mp4Url) {
                        console.log(`[Agent] Trying GraphQL MP4 resolution for ${twitchClip.id}...`);
                        mp4Url = await getClipMp4UrlGQL(twitchClip.id);
                        if (mp4Url) {
                            response = await fetch(mp4Url);
                            if (!response.ok) {
                                console.warn(`[Agent] GraphQL MP4 URL returned HTTP ${response.status} for ${twitchClip.id}, falling back to official API...`);
                                mp4Url = "";
                            }
                        }
                    }
                    
                    if (!mp4Url) {
                        console.log(`[Agent] Trying official clips/downloads API for ${twitchClip.id}...`);
                        mp4Url = await getClipDownloadUrl(twitchClip.id, accessToken, broadcasterId);
                        if (mp4Url) {
                            response = await fetch(mp4Url);
                            if (!response.ok) {
                                throw new Error(`Download fehlgeschlagen (Official API): HTTP ${response.status}`);
                            }
                        } else {
                            throw new Error("Keine MP4-URL gefunden (weder Thumbnail-Extraktion, GraphQL noch offizielle API).");
                        }
                    }
                    const buffer = await response.arrayBuffer();
                    fs.writeFileSync(tempPath, Buffer.from(buffer));
                    
                    await db.ref(`clipper/renders/${jobId}`).update({ status: 'rendering' });
                    
                    // === Hybrid-Layout-Entscheidung: Immer automatische Erkennung ausführen ===
                    let detectedLayout = 'blur-bg';
                    let detectedCamCrop = { x: 0, y: 0, w: 100, h: 100 };
                    let detectedGameCrop = { x: 0, y: 0, w: 100, h: 100 };
                    
                    try {
                        const { execSync } = require('child_process');
                        const analyzerScript = path.join(__dirname, 'analyze_clip.py');
                        const cascadeXml = path.join(__dirname, 'haarcascade_frontalface_default.xml');
                        
                        if (fs.existsSync(analyzerScript) && fs.existsSync(cascadeXml)) {
                            console.log(`[Agent] Starte automatische Layout-Erkennung für ${targetFilename}...`);
                            const analyzeCmd = `python3 "${analyzerScript}" "${tempPath}" "${cascadeXml}"`;
                            const stdout = execSync(analyzeCmd, { encoding: 'utf8', timeout: 30000 });
                            const result = JSON.parse(stdout.trim());
                            
                            if (result && !result.error) {
                                detectedLayout = result.layout;
                                if (detectedLayout === '35' && result.confidence !== undefined && result.confidence < 0.70) {
                                    console.log(`[Agent] Layout 35 has low confidence (${result.confidence} < 0.70). Falling back to blur-bg.`);
                                    detectedLayout = 'blur-bg';
                                }
                                if (detectedLayout === '3-way') {
                                    detectedCamCrop = result.camCrop;
                                    if (result.camCrop2) detectedCamCrop.cam2 = result.camCrop2;
                                    if (result.camCrop3) detectedCamCrop.cam3 = result.camCrop3;
                                    detectedGameCrop = result.gameCrop || detectedGameCrop;
                                } else {
                                    detectedCamCrop = result.camCrop || detectedCamCrop;
                                    detectedGameCrop = result.gameCrop || detectedGameCrop;
                                }
                                console.log(`[Agent] Layout-Erkennung: ${detectedLayout} | Cam=${JSON.stringify(detectedCamCrop)} | Game=${JSON.stringify(detectedGameCrop)}`);
                            } else if (result && result.error) {
                                console.warn(`[Agent] Layout-Erkennung Warnung: ${result.error}, Fallback auf blur-bg`);
                            }
                        } else {
                            console.warn('[Agent] analyze_clip.py oder haarcascade XML nicht gefunden, Fallback auf blur-bg');
                        }
                    } catch (analyzeErr) {
                        console.error('[Agent] Fehler bei Layout-Erkennung (Fallback auf blur-bg):', analyzeErr.message);
                    }
                    
                    // Fallback-Logik:
                    // Check for skip layout due to too many cams
                    if (detectedLayout === 'too-many-cams' || detectedLayout === 'skip') {
                        console.log(`[Agent] Clip hat mehr als 3 Facecams. Video wird ignoriert/abgebrochen.`);
                        throw new Error("Abgebrochen: Mehr als 3 Facecams erkannt (Discord/Groupchat).");
                    }

                    if (detectedLayout === '3-way') {
                        console.log(`[Agent] 3-way Facecam Layout erkannt. Renders mit 3 gestapelten Kameras.`);
                    } else if (detectedLayout === '35') {
                        console.log(`[Agent] Facecam dynamisch im Clip erkannt bei Cam=${JSON.stringify(detectedCamCrop)}. Nutze diese.`);
                    } else if (channel.layout && channel.layout === '35') {
                        console.log(`[Agent] Keine Facecam dynamisch erkannt, aber Kanal-Template ('35') für ${channel.name} gefunden. Nutze Template-Koordinaten als Backup.`);
                        detectedLayout = '35';
                        detectedCamCrop = channel.camCrop || { x: 0, y: 68, w: 24, h: 32 };
                        detectedGameCrop = channel.gameCrop || { x: 35, y: 0, w: 50, h: 100 };
                    } else {
                        console.log(`[Agent] Keine Facecam erkannt und kein Template vorhanden. Nutze standardmäßiges blur-bg Layout.`);
                        detectedLayout = 'blur-bg';
                        detectedCamCrop = { x: 0, y: 0, w: 100, h: 100 };
                        detectedGameCrop = { x: 0, y: 0, w: 100, h: 100 };
                    }
                    // === Ende Layout-Erkennung ===
                    
                    const clipData = await clipperManager.renderPortrait(
                        jobId,
                        targetFilename,
                        0,
                        Math.round(twitchClip.duration),
                        detectedCamCrop,
                        detectedGameCrop,
                        detectedLayout,
                        null
                    );
                    
                    await queueTikTokUpload(clipData, channelName, '', null, detectedLayout);
                    await queueYoutubeUpload(clipData, channelName, '', null, detectedLayout);
                    
                    await db.ref(`clipper/processed_clips/${twitchClip.id}`).update({
                        status: 'done',
                        renderJobId: jobId,
                        clipUrl: `https://minusnd.de/public/clips/${clipData.filename}`
                    });
                    
                    console.log(`[Agent] Clip ${twitchClip.id} erfolgreich gerendert und zur TikTok-Queue hinzugefügt!`);
                } catch (err) {
                    console.error(`[Agent] Fehler bei Verarbeitung von Clip ${twitchClip.id}:`, err.message);
                    await db.ref(`clipper/processed_clips/${twitchClip.id}`).update({
                        status: 'failed',
                        error: err.message
                    });
                    await db.ref(`clipper/renders/${jobId}`).update({
                        status: 'failed',
                        error: err.message
                    });
                    await pruneOldRenders(db);
                } finally {
                    if (fs.existsSync(tempPath)) {
                        try { fs.unlinkSync(tempPath); } catch(e) {}
                    }
                }
                
                // === SEQUENTIAL: Only process 1 clip per poll cycle, then wait for next interval ===
                // Round-Robin: Merke dir den Index des verarbeiteten Kanals
                lastChannelIndex = activeChannels.indexOf(channel);
                if (lastChannelIndex === -1) lastChannelIndex = activeChannels.findIndex(c => c.name.toLowerCase() === channel.name.toLowerCase());
                console.log(`[Agent] 1 Clip von "${channel.name}" verarbeitet (Index ${lastChannelIndex}) — nächster Kanal beim nächsten Zyklus.`);
                break;
            }
        } catch (err) {
            console.error("[Agent] Fehler im Poller-Durchlauf:", err.message);
        }
    };
    
    // Run once immediately on start
    runPoller();
    
    // Then run every 3 minutes
    setInterval(runPoller, 3 * 60 * 1000);
}

// Start Twitch Clip Agent background loop
startTwitchClipAgent(db, clipperManager);

// Start Server-Side TikTok Queue Listener
startTiktokQueueListener(db, clipperManager);

// Start Server-Side YouTube Queue Listener
startYoutubeQueueListener(db, clipperManager);

// Start API Server
app.listen(PORT, () => {
    console.log(`🚀 Zentraler Bot-Server läuft auf Port ${PORT}`);
});
