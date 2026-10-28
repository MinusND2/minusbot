require('dotenv').config();
const { GERMAN_WORDS, COUNTRIES, GERMAN_CITIES } = require('./game_data');
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const SpotifyWebApi = require('spotify-web-api-node');
const { google } = require('googleapis');
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

app.get(['/car-analyzer', '/auto', '/autovergleich'], (req, res) => {
    res.sendFile(path.join(__dirname, '../public/car-analyzer.html'));
});
app.get(['/deals', '/deal-finder', '/autodeals'], (req, res) => {
    res.sendFile(path.join(__dirname, '../public/car-deals.html'));
});

// Öffentliche Routes für den Minecraft Statue Bauplan (ohne Anmeldung erreichbar)
app.get(['/statue', '/statue/', '/bauplan', '/statue-plan', '/minecraft-statue', '/statur', '/statur-bauplan', '/statue-bauplan'], (req, res) => {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.redirect('/public/statue/' + qs);
});

app.get('/', (req, res) => {
    res.sendFile(path.resolve(__dirname, '../index.html'));
});

const PORT = process.env.PORT || 4000;

// 1. Firebase Admin Init
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://bingo-overlay-default-rtdb.europe-west1.firebasedatabase.app" // Passe dies ggf. an deine Firebase URL an
});
const db = admin.database();

// Firebase Server Time Offset tracking to eliminate clock drift on the backend server
let firebaseTimeOffset = 0;
db.ref('.info/serverTimeOffset').on('value', (snap) => {
    firebaseTimeOffset = snap.val() || 0;
    console.log(`[Firebase] Server time offset updated: ${firebaseTimeOffset} ms`);
});

function getFirebaseNow() {
    return Date.now() + firebaseTimeOffset;
}

function findYoutubeSessionFile(account, type = 'cookie') {
    const dir = path.join(__dirname, 'youtube_sessions');
    if (!fs.existsSync(dir)) return null;
    const cleanAccount = (account || 'default').replace(/[^a-zA-Z0-9_]/g, '');
    const exactName = `youtube_${type}_${cleanAccount}.json`;
    const exactPath = path.join(dir, exactName);
    if (fs.existsSync(exactPath)) return exactPath;
    
    // Fallback: Case-insensitive search
    try {
        const files = fs.readdirSync(dir);
        const lowerName = exactName.toLowerCase();
        const match = files.find(f => f.toLowerCase() === lowerName);
        return match ? path.join(dir, match) : null;
    } catch (e) {
        console.error("[YouTube Session File] Error reading directory:", e.message);
        return null;
    }
}

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
const channelToStreamMap = new Map();
const wordgameJoinedChannels = new Set();
const flaggameJoinedChannels = new Set();
const mapgameJoinedChannels = new Set();

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

                    // Check Wordgame & Flaggame message triggers
                    const mappings = channelToStreamMap.get(channelName);
                    if (mappings) {
                        if (mappings.wordgameStreamId) {
                            handleWordgameMessage(mappings.wordgameStreamId, user, msgText);
                        }
                        if (mappings.flaggameStreamId) {
                            handleFlaggameMessage(mappings.flaggameStreamId, user, msgText);
                        }
                        if (mappings.mapgameStreamId) {
                            handleMapgameMessage(mappings.mapgameStreamId, user, msgText);
                        }
                    }

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

                globalChatClient.onSub((channel, user, subInfo, msg) => {
                    console.log(`[CHAT SUB] #${channel} | ${user} subscribed`);
                    handleServerSubEvent(channel, false, subInfo.plan);
                });
                globalChatClient.onResub((channel, user, subInfo, msg) => {
                    console.log(`[CHAT RESUB] #${channel} | ${user} resubscribed`);
                    handleServerSubEvent(channel, false, subInfo.plan);
                });
                globalChatClient.onSubGift((channel, user, subInfo, msg) => {
                    console.log(`[CHAT SUBGIFT] #${channel} | ${user} gifted a sub`);
                    handleServerSubEvent(channel, true, subInfo.plan);
                });

                pendingChannelsToJoin.clear();
            } catch(e) {
                console.error("Fehler beim Starten von ChatClient:", e);
            }
        }
    }
});

async function handleWordgameMessage(streamId, user, text) {
    try {
        const ref = db.ref(`streams/${streamId}/data/wordgame`);
        const snap = await ref.once('value');
        const wordgame = snap.val();
        if (!wordgame || wordgame.paused || wordgame.gameStatus !== 'guessing') return;

        const guess = text.trim().toLowerCase();
        const target = (wordgame.currentWord || "").trim().toLowerCase();

        if (guess === target && target.length > 0) {
            // Correct guess!
            const formattedWinner = user.startsWith('@') ? user : `@${user}`;
            const scores = wordgame.scores || {};
            scores[formattedWinner] = (scores[formattedWinner] || 0) + 1;

            await ref.update({
                scores: scores,
                lastWinner: formattedWinner,
                gameStatus: "winner",
                paused: true,
                transitionTime: Date.now()
            });
            console.log(`[Wordgame Server Bot] ${user} guessed the correct word "${wordgame.currentWord}" in stream ${streamId}`);
        } else {
            // Incorrect guess, log to lastGuesses
            let list = wordgame.lastGuesses || [];
            list.push({ user, guess: text.trim(), time: Date.now() });
            if (list.length > 5) {
                list.shift();
            }
            await ref.child('lastGuesses').set(list);
        }
    } catch (err) {
        console.error("[Wordgame Server Bot] Error in message handler:", err);
    }
}

async function handleFlaggameMessage(streamId, user, text) {
    try {
        const ref = db.ref(`streams/${streamId}/data/flaggame`);
        const snap = await ref.once('value');
        const flaggame = snap.val();
        if (!flaggame || flaggame.paused || flaggame.gameStatus !== 'guessing') return;

        const guess = text.trim().toLowerCase();
        const target = (flaggame.currentWord || "").trim().toLowerCase();

        if (guess === target && target.length > 0) {
            // Correct guess!
            const formattedWinner = user.startsWith('@') ? user : `@${user}`;
            const scores = flaggame.scores || {};
            scores[formattedWinner] = (scores[formattedWinner] || 0) + 1;

            await ref.update({
                scores: scores,
                lastWinner: formattedWinner,
                gameStatus: "winner",
                paused: true,
                transitionTime: Date.now()
            });
            console.log(`[Flaggame Server Bot] ${user} guessed the correct country "${flaggame.currentWord}" in stream ${streamId}`);
        } else {
            // Incorrect guess, log to lastGuesses
            let list = flaggame.lastGuesses || [];
            list.push({ user, guess: text.trim(), time: Date.now() });
            if (list.length > 5) {
                list.shift();
            }
            await ref.child('lastGuesses').set(list);
        }
    } catch (err) {
        console.error("[Flaggame Server Bot] Error in message handler:", err);
    }
}

async function startWordgameNextRound(streamId, wordgame) {
    const ref = db.ref(`streams/${streamId}/data/wordgame`);
    
    let round = (wordgame.currentRound || 1) + 1;
    let scores = wordgame.scores || {};
    
    if (round > (wordgame.totalRoundsMax || 10)) {
        scores = {};
        round = 1;
    }
    
    // Choose new word from GERMAN_WORDS
    let word = "";
    while (true) {
        const randomIndex = Math.floor(Math.random() * GERMAN_WORDS.length);
        word = GERMAN_WORDS[randomIndex].trim().toUpperCase();
        if (word.length >= 4) break;
    }
    
    const reveals = [0];
    if (word.length > 1) {
        const second = Math.floor(Math.random() * (word.length - 1)) + 1;
        reveals.push(second);
    }
    
    await ref.update({
        currentWord: word,
        revealedIndices: reveals,
        nextRevealTime: Date.now() + (wordgame.revealIntervalSec || 60) * 1000,
        currentRound: round,
        paused: false,
        gameStatus: "guessing",
        lastGuesses: [],
        scores: scores
    });
    console.log(`[Wordgame Server Bot] Started round ${round} for stream ${streamId} with word "${word}"`);
}

async function startFlaggameNextRound(streamId, flaggame) {
    const ref = db.ref(`streams/${streamId}/data/flaggame`);
    
    let round = (flaggame.currentRound || 1) + 1;
    let scores = flaggame.scores || {};
    
    if (round > (flaggame.totalRoundsMax || 10)) {
        scores = {};
        round = 1;
    }
    
    // Choose new country from COUNTRIES
    const randomIndex = Math.floor(Math.random() * COUNTRIES.length);
    const country = COUNTRIES[randomIndex];
    const word = country.name.trim().toUpperCase();
    
    const reveals = [0];
    if (word.length > 1) {
        const second = Math.floor(Math.random() * (word.length - 1)) + 1;
        reveals.push(second);
    }
    
    await ref.update({
        currentCode: country.code,
        currentWord: word,
        revealedIndices: reveals,
        nextRevealTime: Date.now() + (flaggame.revealIntervalSec || 60) * 1000,
        currentRound: round,
        paused: false,
        gameStatus: "guessing",
        lastGuesses: [],
        scores: scores
    });
    console.log(`[Flaggame Server Bot] Started round ${round} for stream ${streamId} with country "${word}" (${country.code})`);
}

async function processWordgameTicks(streamId, wordgame) {
    try {
        const ref = db.ref(`streams/${streamId}/data/wordgame`);
        const status = wordgame.gameStatus;
        
        if (status === 'guessing') {
            if (Date.now() >= (wordgame.nextRevealTime || 0)) {
                const word = wordgame.currentWord || "";
                const reveals = wordgame.revealedIndices || [];
                
                let hiddenIndices = [];
                for (let i = 0; i < word.length; i++) {
                    if (!reveals.includes(i)) hiddenIndices.push(i);
                }
                
                if (hiddenIndices.length > 0) {
                    const randIdx = hiddenIndices[Math.floor(Math.random() * hiddenIndices.length)];
                    reveals.push(randIdx);
                    await ref.update({
                        revealedIndices: reveals,
                        nextRevealTime: Date.now() + (wordgame.revealIntervalSec || 60) * 1000
                    });
                    console.log(`[Wordgame Server Bot] Revealed letter index ${randIdx} for stream ${streamId}`);
                } else {
                    // No letters left, timeout!
                    await ref.update({
                        gameStatus: "timeout",
                        paused: true,
                        transitionTime: Date.now()
                    });
                    console.log(`[Wordgame Server Bot] Word timed out for stream ${streamId}`);
                }
            }
        } else if (status === 'winner' || status === 'timeout') {
            const elapsed = Date.now() - (wordgame.transitionTime || Date.now());
            const waitTime = status === 'winner' ? 3000 : 5000;
            if (elapsed >= waitTime) {
                await ref.update({
                    gameStatus: "leaderboard",
                    transitionTime: Date.now()
                });
                console.log(`[Wordgame Server Bot] Transitioned to leaderboard for stream ${streamId}`);
            }
        } else if (status === 'leaderboard') {
            const elapsed = Date.now() - (wordgame.transitionTime || Date.now());
            if (elapsed >= 5000) {
                await startWordgameNextRound(streamId, wordgame);
            }
        }
    } catch (err) {
        console.error(`[Wordgame Server Bot] Error in processWordgameTicks for stream ${streamId}:`, err);
    }
}

async function processFlaggameTicks(streamId, flaggame) {
    try {
        const ref = db.ref(`streams/${streamId}/data/flaggame`);
        const status = flaggame.gameStatus;
        
        if (status === 'guessing') {
            if (Date.now() >= (flaggame.nextRevealTime || 0)) {
                const word = flaggame.currentWord || "";
                const reveals = flaggame.revealedIndices || [];
                
                let hiddenIndices = [];
                for (let i = 0; i < word.length; i++) {
                    if (!reveals.includes(i)) hiddenIndices.push(i);
                }
                
                if (hiddenIndices.length > 0) {
                    const randIdx = hiddenIndices[Math.floor(Math.random() * hiddenIndices.length)];
                    reveals.push(randIdx);
                    await ref.update({
                        revealedIndices: reveals,
                        nextRevealTime: Date.now() + (flaggame.revealIntervalSec || 60) * 1000
                    });
                    console.log(`[Flaggame Server Bot] Revealed letter index ${randIdx} for stream ${streamId}`);
                } else {
                    // No letters left, timeout!
                    await ref.update({
                        gameStatus: "timeout",
                        paused: true,
                        transitionTime: Date.now()
                    });
                    console.log(`[Flaggame Server Bot] Country timed out for stream ${streamId}`);
                }
            }
        } else if (status === 'winner' || status === 'timeout') {
            const elapsed = Date.now() - (flaggame.transitionTime || Date.now());
            const waitTime = status === 'winner' ? 3000 : 5000;
            if (elapsed >= waitTime) {
                await ref.update({
                    gameStatus: "leaderboard",
                    transitionTime: Date.now()
                });
                console.log(`[Flaggame Server Bot] Transitioned to leaderboard for stream ${streamId}`);
            }
        } else if (status === 'leaderboard') {
            const elapsed = Date.now() - (flaggame.transitionTime || Date.now());
            if (elapsed >= 5000) {
                await startFlaggameNextRound(streamId, flaggame);
            }
        }
    } catch (err) {
        console.error(`[Flaggame Server Bot] Error in processFlaggameTicks for stream ${streamId}:`, err);
    }
}

function parseCoordinateInput(text) {
    if (!text) return null;
    const cleaned = text.trim().toUpperCase();
    const matchLetterFirst = cleaned.match(/([A-N])\s*[-–]?\s*([1-9]|1[0-4])\b/);
    if (matchLetterFirst) {
        return `${matchLetterFirst[1]}${matchLetterFirst[2]}`;
    }
    const matchNumberFirst = cleaned.match(/\b([1-9]|1[0-4])\s*[-–]?\s*([A-N])\b/);
    if (matchNumberFirst) {
        return `${matchNumberFirst[2]}${matchNumberFirst[1]}`;
    }
    return null;
}

async function handleMapgameMessage(streamId, user, text) {
    try {
        const ref = db.ref(`streams/${streamId}/data/mapgame`);
        const snap = await ref.once('value');
        const mapgame = snap.val();
        if (!mapgame || mapgame.paused || mapgame.gameStatus !== 'guessing') return;

        const guess = parseCoordinateInput(text);
        if (!guess) return;

        const target = (mapgame.targetCoord || "").trim().toUpperCase();
        const cityMatch = GERMAN_CITIES.find(c => c.name.toLowerCase() === (mapgame.cityName || "").toLowerCase());
        const isCorrect = (guess === target) || (cityMatch && cityMatch.alt && cityMatch.alt.includes(guess));

        if (isCorrect && target.length > 0) {
            // Correct guess!
            const formattedWinner = user.startsWith('@') ? user : `@${user}`;
            const scores = mapgame.scores || {};
            scores[formattedWinner] = (scores[formattedWinner] || 0) + 1;

            await ref.update({
                scores: scores,
                lastWinner: formattedWinner,
                gameStatus: "winner",
                transitionTime: Date.now()
            });
            console.log(`[Mapgame Server Bot] ${user} guessed the correct coordinate "${guess}" for "${mapgame.cityName}" in stream ${streamId}`);
        } else {
            // Incorrect guess, log to lastGuesses
            let list = mapgame.lastGuesses || [];
            list.push({ user, guess: guess, time: Date.now() });
            if (list.length > 5) {
                list.shift();
            }
            await ref.child('lastGuesses').set(list);
        }
    } catch (err) {
        console.error("[Mapgame Server Bot] Error in message handler:", err);
    }
}

async function startMapgameNextRound(streamId, mapgame) {
    const ref = db.ref(`streams/${streamId}/data/mapgame`);
    
    let round = (mapgame.currentRound || 1) + 1;
    let scores = mapgame.scores || {};
    
    if (round > (mapgame.totalRoundsMax || 10)) {
        scores = {};
        round = 1;
    }
    
    // Choose new city from GERMAN_CITIES
    const randomIndex = Math.floor(Math.random() * GERMAN_CITIES.length);
    const city = GERMAN_CITIES[randomIndex];
    
    await ref.update({
        cityName: city.name,
        targetCoord: city.coord,
        nextTimeoutTime: Date.now() + (mapgame.roundTimeSec || 45) * 1000,
        currentRound: round,
        paused: false,
        gameStatus: "guessing",
        lastGuesses: [],
        scores: scores
    });
    console.log(`[Mapgame Server Bot] Started round ${round} for stream ${streamId} with city "${city.name}" (${city.coord})`);
}

async function processMapgameTicks(streamId, mapgame) {
    try {
        const ref = db.ref(`streams/${streamId}/data/mapgame`);
        const status = mapgame.gameStatus;

        if (status === 'guessing') {
            // Only freeze ticking if streamer explicitly paused the game
            if (mapgame.paused) {
                return;
            }

            const timeout = mapgame.nextTimeoutTime;
            // If nextTimeoutTime is not set yet, initialize it
            if (!timeout || timeout <= 0) {
                const roundSec = mapgame.roundTimeSec || 45;
                await ref.update({
                    nextTimeoutTime: Date.now() + (roundSec * 1000)
                });
                return;
            }
            if (Date.now() >= timeout) {
                await ref.update({
                    gameStatus: "timeout",
                    transitionTime: Date.now()
                });
                console.log(`[Mapgame Server Bot] City timed out for stream ${streamId}`);
            }
        } else if (status === 'winner' || status === 'timeout') {
            const elapsed = Date.now() - (mapgame.transitionTime || Date.now());
            const waitTime = status === 'winner' ? 3500 : 4500;
            if (elapsed >= waitTime) {
                await ref.update({
                    gameStatus: "leaderboard",
                    transitionTime: Date.now()
                });
                console.log(`[Mapgame Server Bot] Transitioned to leaderboard for stream ${streamId}`);
            }
        } else if (status === 'leaderboard') {
            const elapsed = Date.now() - (mapgame.transitionTime || Date.now());
            if (elapsed >= 5000) {
                await startMapgameNextRound(streamId, mapgame);
            }
        }
    } catch (err) {
        console.error(`[Mapgame Server Bot] Error in processMapgameTicks for stream ${streamId}:`, err);
    }
}

async function handleServerSubEvent(channel, isGift, plan) {
    const channelName = channel.replace('#', '').toLowerCase();
    try {
        const streamsSnap = await db.ref('streams').once('value');
        const streams = streamsSnap.val();
        if (!streams) return;
        
        for (const [streamId, stream] of Object.entries(streams)) {
            const subathon = stream.data?.subathon;
            if (subathon && subathon.twitchChannel && subathon.twitchChannel.trim().toLowerCase() === channelName) {
                // Found the matching subathon stream!
                
                // Read settings
                const timeT1 = parseInt(subathon.timeT1) ?? 30;
                const timeT2 = parseInt(subathon.timeT2) ?? 60;
                const timeT3 = parseInt(subathon.timeT3) ?? 120;
                const timeGift = parseInt(subathon.timeGift) ?? 30;
                
                let seconds = 0;
                if (isGift) {
                    seconds = timeGift;
                } else {
                    if (plan === '2000') {
                        seconds = timeT2;
                    } else if (plan === '3000') {
                        seconds = timeT3;
                    } else {
                        seconds = timeT1;
                    }
                }
                
                if (seconds <= 0) continue;
                
                // Calculate new addedTime
                let newAdded = (subathon.addedTime || 0) + seconds;
                
                // Check maxTime limit
                const maxTimeVal = parseInt(subathon.maxTime) || 0;
                if (maxTimeVal > 0) {
                    const maxSeconds = maxTimeVal * 3600;
                    const start = parseInt(subathon.startDuration) || 3600;
                    const total = start + newAdded;
                    let elapsed = 0;
                    if (subathon.running) {
                        elapsed = ((subathon.accumulatedTime || 0) + (Date.now() - (subathon.baseTime || 0))) / 1000;
                    } else {
                        elapsed = (subathon.accumulatedTime || 0) / 1000;
                    }
                    const remaining = total - elapsed;
                    if (remaining > maxSeconds) {
                        newAdded = maxSeconds + elapsed - start;
                    }
                }
                
                const nextTotalSubs = (subathon.totalSubs || 0) + 1;
                
                // Update database directly with full admin rights!
                await db.ref(`streams/${streamId}/data/subathon`).update({
                    addedTime: newAdded,
                    totalSubs: nextTotalSubs
                });
                
                console.log(`[Subathon Server Bot] Added ${seconds}s to stream ${streamId} for sub in #${channelName}`);
            }
        }
    } catch (err) {
        console.error("[Subathon Server Bot] Error handling sub event:", err);
    }
}

// Local cache of joined channels for subathons to avoid calling non-existent methods
const subathonJoinedChannels = new Set();

// Database watcher to join channels for active subathons, wordgames, and flaggames
db.ref('streams').on('value', (snap) => {
    const streams = snap.val();
    if (!streams) return;
    
    channelToStreamMap.clear();
    
    for (const [streamId, stream] of Object.entries(streams)) {
        // Subathon Watcher
        const subathon = stream.data?.subathon;
        if (subathon && subathon.twitchChannel) {
            const channelName = subathon.twitchChannel.trim().toLowerCase();
            if (channelName) {
                if (globalChatClient) {
                    if (!subathonJoinedChannels.has(channelName)) {
                        globalChatClient.join(channelName);
                        subathonJoinedChannels.add(channelName);
                        console.log(`[Subathon Watcher] Joined Twitch channel #${channelName} for stream ${streamId}`);
                    }
                } else {
                    pendingChannelsToJoin.add(channelName);
                }
            }
        }

        // Wordgame Watcher
        const wordgame = stream.data?.wordgame;
        if (wordgame && wordgame.twitchChannel) {
            const channelName = wordgame.twitchChannel.trim().toLowerCase();
            if (channelName) {
                if (!channelToStreamMap.has(channelName)) {
                    channelToStreamMap.set(channelName, {});
                }
                channelToStreamMap.get(channelName).wordgameStreamId = streamId;
                
                if (globalChatClient) {
                    if (!wordgameJoinedChannels.has(channelName)) {
                        globalChatClient.join(channelName);
                        wordgameJoinedChannels.add(channelName);
                        console.log(`[Wordgame Watcher] Joined Twitch channel #${channelName} for stream ${streamId}`);
                    }
                } else {
                    pendingChannelsToJoin.add(channelName);
                }
            }
        }

        // Flaggame Watcher
        const flaggame = stream.data?.flaggame;
        if (flaggame && flaggame.twitchChannel) {
            const channelName = flaggame.twitchChannel.trim().toLowerCase();
            if (channelName) {
                if (!channelToStreamMap.has(channelName)) {
                    channelToStreamMap.set(channelName, {});
                }
                channelToStreamMap.get(channelName).flaggameStreamId = streamId;
                
                if (globalChatClient) {
                    if (!flaggameJoinedChannels.has(channelName)) {
                        globalChatClient.join(channelName);
                        flaggameJoinedChannels.add(channelName);
                        console.log(`[Flaggame Watcher] Joined Twitch channel #${channelName} for stream ${streamId}`);
                    }
                } else {
                    pendingChannelsToJoin.add(channelName);
                }
            }
        }

        // Mapgame Watcher
        const mapgame = stream.data?.mapgame;
        if (mapgame && mapgame.twitchChannel) {
            const channelName = mapgame.twitchChannel.trim().toLowerCase();
            if (channelName) {
                if (!channelToStreamMap.has(channelName)) {
                    channelToStreamMap.set(channelName, {});
                }
                channelToStreamMap.get(channelName).mapgameStreamId = streamId;
                
                if (globalChatClient) {
                    if (!mapgameJoinedChannels.has(channelName)) {
                        globalChatClient.join(channelName);
                        mapgameJoinedChannels.add(channelName);
                        console.log(`[Mapgame Watcher] Joined Twitch channel #${channelName} for stream ${streamId}`);
                    }
                } else {
                    pendingChannelsToJoin.add(channelName);
                }
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


app.get('/bot/auth/youtube', (req, res) => {
    const account = (req.query.account || 'default').replace(/[^a-zA-Z0-9_]/g, '');
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        return res.status(400).send("Google OAuth-Zugangsdaten sind in der .env-Datei des Servers nicht konfiguriert.");
    }
    const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
    );
    const scopes = [
        'https://www.googleapis.com/auth/youtube.upload',
        'https://www.googleapis.com/auth/youtube.readonly'
    ];
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: scopes,
        state: account
    });
    res.redirect(url);
});

app.get('/bot/auth/youtube/callback', async (req, res) => {
    const { code, state: account } = req.query;
    if (!account) return res.status(400).send("Account name fehlt im Callback.");
    try {
        const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI
        );
        const { tokens } = await oauth2Client.getToken(code);
        
        if (!tokens.refresh_token) {
            console.warn(`[YouTube OAuth] Kein Refresh Token erhalten fuer ${account}. prompt=consent wurde eventuell ignoriert.`);
        }
        
        const sessionsDir = path.join(__dirname, 'youtube_sessions');
        if (!fs.existsSync(sessionsDir)) {
            fs.mkdirSync(sessionsDir, { recursive: true });
        }
        const tokenFile = path.join(sessionsDir, `youtube_oauth_${account}.json`);
        
        // Falls kein neuer Refresh-Token gesendet wurde, aber ein alter existiert, behalte den alten bei
        if (!tokens.refresh_token && fs.existsSync(tokenFile)) {
            try {
                const oldTokens = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
                if (oldTokens.refresh_token) {
                    tokens.refresh_token = oldTokens.refresh_token;
                    console.log(`[YouTube OAuth] Alten Refresh Token fuer ${account} wiederverwendet.`);
                }
            } catch (e) {
                console.error("[YouTube OAuth] Fehler beim Lesen der alten Tokens:", e.message);
            }
        }
        
        fs.writeFileSync(tokenFile, JSON.stringify(tokens, null, 2), 'utf8');
        console.log(`[YouTube OAuth] Tokens erfolgreich fuer ${account} gespeichert.`);
        
        res.redirect(`https://minusnd.de/protected/clipper.html?youtube_success=true&account=${account}`);
    } catch (err) {
        console.error('Error in YouTube OAuth callback:', err);
        res.redirect(`https://minusnd.de/protected/clipper.html?youtube_error=true&message=${encodeURIComponent(err.message)}`);
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

// Helper to get clips directory path dynamically on local/server
const getClipsDir = () => {
    let dir = path.join(__dirname, '../public/clips');
    if (fs.existsSync('/var/www/bingo/public/clips')) {
        dir = '/var/www/bingo/public/clips';
    }
    return dir;
};

// 1. List raw clip files
app.get('/api/cutter/clips', (req, res) => {
    const clipsDir = getClipsDir();
    if (!fs.existsSync(clipsDir)) {
        return res.json({ clips: [] });
    }
    fs.readdir(clipsDir, (err, files) => {
        if (err) return res.status(500).json({ error: err.message });
        const rawClips = files.filter(f => f.startsWith('twitch_') && f.endsWith('.mp4'));
        res.json({ clips: rawClips });
    });
});

// 1b. Upload custom test clips
const multer = require('multer');
const clipUploadStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const clipsDir = getClipsDir();
        if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });
        cb(null, clipsDir);
    },
    filename: (req, file, cb) => {
        // Ensure filename starts with twitch_ so it appears in the dropdown
        let safeName = file.originalname.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
        if (!safeName.startsWith('twitch_')) {
            safeName = 'twitch_' + safeName;
        }
        if (!safeName.endsWith('.mp4')) {
            safeName = safeName.replace(/\.[^.]+$/, '') + '.mp4';
        }
        cb(null, safeName);
    }
});
const clipUpload = multer({
    storage: clipUploadStorage,
    limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'video/mp4' || file.originalname.endsWith('.mp4')) {
            cb(null, true);
        } else {
            cb(new Error('Nur .mp4-Dateien erlaubt'));
        }
    }
});

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

app.post('/api/cutter/upload', clipUpload.single('clip'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Keine Datei hochgeladen' });
    }
    console.log(`[Cutter Upload] Datei hochgeladen: ${req.file.filename} (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`);
    res.json({
        success: true,
        filename: req.file.filename,
        size: req.file.size
    });
});

const getPublicDir = () => {
    let dir = path.join(__dirname, '../public');
    if (fs.existsSync('/var/www/bingo/public')) {
        dir = '/var/www/bingo/public';
    }
    return dir;
};

const logoUploadStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const destDir = getPublicDir();
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        cb(null, destDir);
    },
    filename: (req, file, cb) => {
        const identifier = (req.params.id || req.params.channel || 'default').toLowerCase().replace(/[^a-zA-Z0-9_]/g, '');
        cb(null, `logo_${identifier}.png`);
    }
});
const logoUpload = multer({
    storage: logoUploadStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'image/png' || file.originalname.endsWith('.png')) {
            cb(null, true);
        } else {
            cb(new Error('Nur .png-Bilder erlaubt'));
        }
    }
});

app.post('/api/clipper/channels/:channel/logo', logoUpload.single('logo'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Keine Datei hochgeladen' });
    }
    console.log(`[Logo Upload] Logo fuer Kanal ${req.params.channel} hochgeladen: ${req.file.filename}`);
    res.json({ success: true, filename: req.file.filename });
});

// 2. Run auto-detection analyzer on a clip
app.post('/api/cutter/analyze', async (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: "Filename is required" });
    
    const clipsDir = getClipsDir();
    const clipPath = path.join(clipsDir, filename);
    if (!fs.existsSync(clipPath)) {
        return res.status(404).json({ error: "Clip not found" });
    }
    
    const analyzerScript = path.join(__dirname, 'analyze_clip.py');
    const cascadeXml = path.join(__dirname, 'haarcascade_frontalface_default.xml');
    
    if (!fs.existsSync(analyzerScript) || !fs.existsSync(cascadeXml)) {
        return res.status(500).json({ error: "Analyzer script or XML cascade not found" });
    }
    
    try {
        const { exec } = require('child_process');
        const runCommandStr = (cmd) => {
            return new Promise((resolve, reject) => {
                exec(cmd, { encoding: 'utf8', timeout: 30000 }, (err, stdout, stderr) => {
                    if (err) return reject(new Error(stderr || err.message));
                    resolve(stdout);
                });
            });
        };
        
        let stdout;
        try {
            stdout = await runCommandStr(`python3 "${analyzerScript}" "${clipPath}" "${cascadeXml}"`);
        } catch (err3) {
            console.warn("[Cutter API] python3 failed, trying python:", err3.message);
            stdout = await runCommandStr(`python "${analyzerScript}" "${clipPath}" "${cascadeXml}"`);
        }
        
        const result = JSON.parse(stdout.trim());
        if (result && result.layout === '35' && result.confidence !== undefined && result.confidence < 0.70) {
            console.log(`[Cutter API] Layout 35 has low confidence (${result.confidence} < 0.70). Falling back to blur-bg.`);
            result.layout = 'blur-bg';
        }
        res.json(result);
    } catch (err) {
        console.error("[Cutter API] Error running analyzer:", err);
        res.status(500).json({ error: err.message });
    }
});

// 3. Trigger manual render test
app.post('/api/cutter/render', async (req, res) => {
    const { filename, start, end, camCrop, camCrop2, camCrop3, gameCrop, layout, textOverlay } = req.body;
    if (!filename) return res.status(400).json({ error: "Filename is required" });
    
    const clipsDir = getClipsDir();
    const clipPath = path.join(clipsDir, filename);
    if (!fs.existsSync(clipPath)) {
        return res.status(404).json({ error: "Clip not found" });
    }
    
    try {
        const jobId = db.ref('clipper/renders').push().key;
        
        let streamerName = "teststreamer";
        const parts = filename.split('_');
        if (parts.length >= 2) streamerName = parts[1];
        
        await db.ref(`clipper/renders/${jobId}`).set({
            id: jobId,
            status: 'rendering',
            filename: filename,
            timestamp: Date.now(),
            autoPublish: false,
            streamerName: streamerName,
            progress: 0,
            isAgentJob: false
        });
        
        // Structure camCrop to include cam2 and cam3 for 3-way layout support
        const formattedCamCrop = camCrop || { x: 0, y: 0, w: 100, h: 100 };
        if (camCrop2) formattedCamCrop.cam2 = camCrop2;
        if (camCrop3) formattedCamCrop.cam3 = camCrop3;

        // Trigger render asynchronously
        clipperManager.renderPortrait(
            jobId,
            filename,
            start || 0,
            end || 30,
            formattedCamCrop,
            gameCrop || { x: 0, y: 0, w: 100, h: 100 },
            layout || '35',
            textOverlay || null,
            streamerName
        ).then((clipData) => {
            console.log(`[Cutter API] Manual render completed successfully for job ${jobId}`);
        }).catch((err) => {
            console.error(`[Cutter API] Manual render failed for job ${jobId}:`, err.message);
        });
        
        res.json({ success: true, jobId });
    } catch (err) {
        console.error("[Cutter API] Render failed to spawn:", err);
        res.status(500).json({ error: err.message });
    }
});

// 4. Poll render status
app.get('/api/cutter/render-status/:jobId', async (req, res) => {
    const { jobId } = req.params;
    try {
        const snap = await db.ref(`clipper/renders/${jobId}`).once('value');
        if (!snap.exists()) {
            return res.status(404).json({ error: "Job not found" });
        }
        res.json(snap.val());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. Save coordinates override to Firebase
app.post('/api/cutter/save-override', async (req, res) => {
    let { streamerName, layout, camCrop, gameCrop } = req.body;
    if (!streamerName) return res.status(400).json({ error: "StreamerName is required" });
    
    try {
        // Strip file extensions and invalid Firebase path characters
        let cleanName = streamerName.replace(/\.mp4$/i, '').replace(/^twitch_/, '').toLowerCase().trim();
        cleanName = cleanName.replace(/[\.#$\[\]]/g, '');
        if (!cleanName) return res.status(400).json({ error: "Invalid StreamerName" });
        
        const updates = {
            layout: layout || "35",
            camCrop: camCrop || { x: 76, y: 68, w: 24, h: 32 },
            gameCrop: gameCrop || { x: 15, y: 0, w: 50, h: 100 }
        };
        await db.ref(`clipper/channels/${cleanName}`).update(updates);
        console.log(`[Cutter API] Saved manual coordinates override for ${cleanName}`);
        res.json({ success: true, message: `Override für ${cleanName} erfolgreich gespeichert!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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

// Clipper Profiles API endpoints
app.get('/api/clipper/profiles', async (req, res) => {
    try {
        const snap = await db.ref('clipper/profiles').once('value');
        let profiles = snap.val() || {};
        
        // Auto-seed initial default profile if none exists
        if (Object.keys(profiles).length === 0) {
            const chSnap = await db.ref('clipper/channels').once('value');
            const channels = chSnap.val() || {};
            const firstChannelKey = Object.keys(channels)[0] || 'alibumayetv';
            const firstChan = channels[firstChannelKey] || {};
            
            const defaultId = 'ali';
            const defaultProfile = {
                id: defaultId,
                name: 'Ali',
                twitchChannel: firstChan.name || 'alibumayetv',
                tiktokAccount: firstChan.tiktokAccount || 'MinusND',
                tiktokHashtags: firstChan.tiktokHashtags || '#alibumaye #ali #foryou #viral\n@Ali Bumaye #foryoupage #alibumaye',
                tiktokCaption: firstChan.tiktokCaption || 'Folgt für mehr tägliche clips',
                autoPublishTikTok: firstChan.autoPublish !== undefined ? firstChan.autoPublish : true,
                autoRenderTikTok: true,
                youtubeAccount: firstChan.youtubeAccount || 'alibumayetv',
                youtubeHashtags: firstChan.youtubeHashtags || '#shorts #alibumaye',
                youtubeCaption: firstChan.youtubeCaption || '',
                autoPublishYoutube: firstChan.autoPublishYoutube !== undefined ? firstChan.autoPublishYoutube : false,
                isAgentActive: firstChan.isAgentActive !== undefined ? firstChan.isAgentActive : true,
                isSemiAuto: firstChan.isSemiAuto !== undefined ? firstChan.isSemiAuto : true,
                camCrop: firstChan.camCrop || { x: 75, y: 3, w: 21, h: 21 },
                gameCrop: firstChan.gameCrop || { x: 27, y: 0, w: 45, h: 94 },
                layout: firstChan.layout || 'blur-bg',
                logoUrl: '',
                minViews: 100,
                timeRange: '7d',
                uploadCooldownSec: 240,
                customClipStart: 180,
                customClipEnd: 0,
                createdAt: Date.now(),
                updatedAt: Date.now()
            };
            await db.ref(`clipper/profiles/${defaultId}`).set(defaultProfile);
            profiles = { [defaultId]: defaultProfile };
        }
        
        res.json(profiles);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/clipper/profiles/:id', async (req, res) => {
    try {
        const id = req.params.id.toLowerCase().trim();
        const snap = await db.ref(`clipper/profiles/${id}`).once('value');
        if (!snap.exists()) return res.status(404).json({ error: "Profil nicht gefunden" });
        res.json(snap.val());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/clipper/profiles', async (req, res) => {
    try {
        let { id, name } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: "Name ist erforderlich" });
        
        if (!id) {
            id = name.toLowerCase().trim().replace(/[^a-z0-9_]/g, '_');
            if (!id) id = 'profile_' + Date.now();
        } else {
            id = id.toLowerCase().trim().replace(/[^a-z0-9_]/g, '_');
        }
        
        const snap = await db.ref(`clipper/profiles/${id}`).once('value');
        const existing = snap.val() || {};
        
        const profileData = {
            id,
            name: name.trim(),
            twitchChannel: req.body.twitchChannel !== undefined ? req.body.twitchChannel.trim().toLowerCase() : (existing.twitchChannel || ''),
            tiktokAccount: req.body.tiktokAccount !== undefined ? req.body.tiktokAccount.trim() : (existing.tiktokAccount !== undefined ? existing.tiktokAccount : name.trim()),
            tiktokHashtags: req.body.tiktokHashtags !== undefined ? req.body.tiktokHashtags : (existing.tiktokHashtags || ''),
            tiktokCaption: req.body.tiktokCaption !== undefined ? req.body.tiktokCaption : (existing.tiktokCaption || ''),
            autoPublishTikTok: req.body.autoPublishTikTok !== undefined ? !!req.body.autoPublishTikTok : (existing.autoPublishTikTok !== undefined ? existing.autoPublishTikTok : false),
            autoRenderTikTok: req.body.autoRenderTikTok !== undefined ? !!req.body.autoRenderTikTok : (existing.autoRenderTikTok !== undefined ? existing.autoRenderTikTok : false),
            youtubeAccount: req.body.youtubeAccount !== undefined ? req.body.youtubeAccount.trim() : (existing.youtubeAccount !== undefined ? existing.youtubeAccount : name.trim()),
            youtubeHashtags: req.body.youtubeHashtags !== undefined ? req.body.youtubeHashtags : (existing.youtubeHashtags || ''),
            youtubeCaption: req.body.youtubeCaption !== undefined ? req.body.youtubeCaption : (existing.youtubeCaption || ''),
            autoPublishYoutube: req.body.autoPublishYoutube !== undefined ? !!req.body.autoPublishYoutube : (existing.autoPublishYoutube !== undefined ? existing.autoPublishYoutube : false),
            isAgentActive: req.body.isAgentActive !== undefined ? !!req.body.isAgentActive : (existing.isAgentActive !== undefined ? existing.isAgentActive : false),
            isSemiAuto: req.body.isSemiAuto !== undefined ? !!req.body.isSemiAuto : (existing.isSemiAuto !== undefined ? existing.isSemiAuto : false),
            creatorFilter: req.body.creatorFilter !== undefined ? req.body.creatorFilter.trim() : (existing.creatorFilter !== undefined ? existing.creatorFilter : 'MinusND'),
            onlyCreatorClips: req.body.onlyCreatorClips !== undefined ? !!req.body.onlyCreatorClips : (existing.onlyCreatorClips !== undefined ? existing.onlyCreatorClips : true),
            autoTitleOverlay: req.body.autoTitleOverlay !== undefined ? !!req.body.autoTitleOverlay : (existing.autoTitleOverlay !== undefined ? existing.autoTitleOverlay : true),
            autoLogoOverlay: req.body.autoLogoOverlay !== undefined ? !!req.body.autoLogoOverlay : (existing.autoLogoOverlay !== undefined ? existing.autoLogoOverlay : false),
            camCrop: req.body.camCrop !== undefined ? req.body.camCrop : (existing.camCrop || { x: 75, y: 3, w: 21, h: 21 }),
            gameCrop: req.body.gameCrop !== undefined ? req.body.gameCrop : (existing.gameCrop || { x: 27, y: 0, w: 45, h: 94 }),
            layout: req.body.layout !== undefined ? req.body.layout : (existing.layout || 'blur-bg'),
            logoUrl: req.body.logoUrl !== undefined ? req.body.logoUrl : (existing.logoUrl || ''),
            minViews: req.body.minViews !== undefined ? (parseInt(req.body.minViews, 10) || 100) : (existing.minViews || 100),
            timeRange: req.body.timeRange !== undefined ? req.body.timeRange : (existing.timeRange || '7d'),
            uploadCooldownSec: req.body.uploadCooldownSec !== undefined ? (parseInt(req.body.uploadCooldownSec, 10) || 0) : (existing.uploadCooldownSec || 0),
            customClipStart: req.body.customClipStart !== undefined ? (parseInt(req.body.customClipStart, 10) || 180) : (existing.customClipStart || 180),
            customClipEnd: req.body.customClipEnd !== undefined ? (parseInt(req.body.customClipEnd, 10) || 0) : (existing.customClipEnd || 0),
            createdAt: existing.createdAt || Date.now(),
            updatedAt: Date.now()
        };
        
        await db.ref(`clipper/profiles/${id}`).set(profileData);
        
        // Sync channel to clipper/channels if twitchChannel is set
        if (profileData.twitchChannel) {
            const cleanChannel = profileData.twitchChannel.toLowerCase().trim();
            const chSnap = await db.ref(`clipper/channels/${cleanChannel}`).once('value');
            const chData = chSnap.val() || {};
            await db.ref(`clipper/channels/${cleanChannel}`).set({
                ...chData,
                name: cleanChannel,
                profileId: id,
                platform: 'twitch',
                status: chData.status || 'offline',
                isActive: true,
                tiktokAccount: profileData.tiktokAccount,
                tiktokHashtags: profileData.tiktokHashtags,
                tiktokCaption: profileData.tiktokCaption,
                youtubeAccount: profileData.youtubeAccount,
                youtubeHashtags: profileData.youtubeHashtags,
                youtubeCaption: profileData.youtubeCaption,
                isAgentActive: profileData.isAgentActive,
                isSemiAuto: profileData.isSemiAuto,
                autoPublish: profileData.autoPublishTikTok,
                autoPublishYoutube: profileData.autoPublishYoutube,
                creatorFilter: profileData.creatorFilter,
                onlyCreatorClips: profileData.onlyCreatorClips,
                autoTitleOverlay: profileData.autoTitleOverlay,
                autoLogoOverlay: profileData.autoLogoOverlay,
                camCrop: profileData.camCrop,
                gameCrop: profileData.gameCrop,
                layout: profileData.layout,
                addedAt: chData.addedAt || Date.now()
            });
        }
        
        res.json({ success: true, profile: profileData });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/clipper/profiles/:id/rename', async (req, res) => {
    try {
        const id = req.params.id.toLowerCase().trim();
        const { name } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: "Name ist erforderlich" });
        
        const snap = await db.ref(`clipper/profiles/${id}`).once('value');
        if (!snap.exists()) return res.status(404).json({ error: "Profil nicht gefunden" });
        
        await db.ref(`clipper/profiles/${id}`).update({
            name: name.trim(),
            updatedAt: Date.now()
        });
        res.json({ success: true, name: name.trim() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/clipper/profiles/:id', async (req, res) => {
    try {
        const id = req.params.id.toLowerCase().trim();
        const snap = await db.ref(`clipper/profiles/${id}`).once('value');
        if (!snap.exists()) return res.status(404).json({ error: "Profil nicht gefunden" });
        
        const profile = snap.val();
        await db.ref(`clipper/profiles/${id}`).remove();
        
        // If channel was attached, clean up channel if no other profile uses it
        if (profile && profile.twitchChannel) {
            const cleanChannel = profile.twitchChannel.toLowerCase().trim();
            const allProfilesSnap = await db.ref('clipper/profiles').once('value');
            const allProfiles = allProfilesSnap.val() || {};
            const stillUsed = Object.values(allProfiles).some(p => p.twitchChannel === cleanChannel);
            if (!stillUsed) {
                await db.ref(`clipper/channels/${cleanChannel}`).remove();
            }
        }
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/clipper/profiles/:id/logo', logoUpload.single('logo'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Keine Datei hochgeladen' });
    }
    const id = req.params.id.toLowerCase().trim();
    console.log(`[Logo Upload] Logo fuer Profil ${id} hochgeladen: ${req.file.filename}`);
    try {
        const logoUrl = `/public/${req.file.filename}`;
        await db.ref(`clipper/profiles/${id}`).update({
            logoUrl: logoUrl,
            updatedAt: Date.now()
        });
        res.json({ success: true, filename: req.file.filename, logoUrl: logoUrl });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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
    const { name, tiktokAccount, tiktokHashtags, tiktokCaption, isAgentActive, autoPublish, youtubeAccount, youtubeHashtags, youtubeCaption, autoPublishYoutube, isSemiAuto, creatorFilter, onlyCreatorClips, autoTitleOverlay, autoLogoOverlay } = req.body;
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
        if (youtubeAccount !== undefined) updateData.youtubeAccount = youtubeAccount;
        if (youtubeHashtags !== undefined) updateData.youtubeHashtags = youtubeHashtags;
        if (youtubeCaption !== undefined) updateData.youtubeCaption = youtubeCaption;
        if (isAgentActive !== undefined) updateData.isAgentActive = !!isAgentActive;
        if (isSemiAuto !== undefined) updateData.isSemiAuto = !!isSemiAuto;
        if (autoPublish !== undefined) updateData.autoPublish = !!autoPublish;
        if (req.body.autoPublishTikTok !== undefined) {
            updateData.autoPublish = !!req.body.autoPublishTikTok;
            updateData.autoPublishTikTok = !!req.body.autoPublishTikTok;
        }
        if (req.body.autoRender !== undefined) {
            updateData.autoRender = !!req.body.autoRender;
            updateData.autoRenderTikTok = !!req.body.autoRender;
        }
        if (autoPublishYoutube !== undefined) updateData.autoPublishYoutube = !!autoPublishYoutube;
        if (creatorFilter !== undefined) updateData.creatorFilter = creatorFilter.trim();
        if (onlyCreatorClips !== undefined) updateData.onlyCreatorClips = !!onlyCreatorClips;
        if (autoTitleOverlay !== undefined) updateData.autoTitleOverlay = !!autoTitleOverlay;
        if (autoLogoOverlay !== undefined) updateData.autoLogoOverlay = !!autoLogoOverlay;
        if (req.body.camCrop !== undefined) updateData.camCrop = req.body.camCrop;
        if (req.body.gameCrop !== undefined) updateData.gameCrop = req.body.gameCrop;
        if (req.body.layout !== undefined) updateData.layout = req.body.layout;
        
        await db.ref(`clipper/channels/${cleanName}`).set(updateData);
        if (currentData.profileId && autoLogoOverlay !== undefined) {
            await db.ref(`clipper/profiles/${currentData.profileId}`).update({ autoLogoOverlay: !!autoLogoOverlay }).catch(() => {});
        }
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
    const { agentActive, uploadCooldownSec } = req.body;
    try {
        const updateObj = {};
        if (typeof agentActive !== 'undefined') updateObj.agentActive = !!agentActive;
        if (typeof uploadCooldownSec !== 'undefined') updateObj.uploadCooldownSec = parseInt(uploadCooldownSec, 10) || 0;
        await db.ref('clipper/config').update(updateObj);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Pipeline status and toggle endpoints
app.get('/api/clipper/pipeline-status', async (req, res) => {
    try {
        const snap = await db.ref('clipper/pipeline_status').once('value');
        res.json(snap.val() || { stage: 'idle', statusText: 'Bereit & wartet auf Clips' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/clipper/pipeline-toggle', async (req, res) => {
    const { profileId, channelName, box, enabled } = req.body;
    try {
        const profId = profileId || 'ali';
        const pSnap = await db.ref(`clipper/profiles/${profId}`).once('value');
        const pData = pSnap.val() || {};
        
        const updateP = {};
        const updateC = {};
        
        if (box === 'scan') {
            updateP.isAgentActive = !!enabled;
            updateC.isAgentActive = !!enabled;
        } else if (box === 'cut') {
            updateP.autoRenderTikTok = !!enabled;
            updateC.autoRender = !!enabled;
            updateC.autoRenderTikTok = !!enabled;
        } else if (box === 'review') {
            updateP.isSemiAuto = !!enabled;
            updateC.isSemiAuto = !!enabled;
        } else if (box === 'tiktok') {
            updateP.autoPublishTikTok = !!enabled;
            updateC.autoPublish = !!enabled;
            updateC.autoPublishTikTok = !!enabled;
        } else if (box === 'youtube') {
            updateP.autoPublishYoutube = !!enabled;
            updateC.autoPublishYoutube = !!enabled;
        }
        
        updateP.updatedAt = Date.now();
        await db.ref(`clipper/profiles/${profId}`).update(updateP);
        
        const chan = (channelName || pData.twitchChannel || '').toLowerCase().trim();
        if (chan) {
            await db.ref(`clipper/channels/${chan}`).update(updateC);
        }
        
        await db.ref(`clipper/pipeline_status/toggles/${box}`).set(!!enabled).catch(() => {});
        
        res.json({ success: true, box, enabled: !!enabled, profileId: profId, channel: chan });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/clipper/hashtag-presets', async (req, res) => {
    try {
        const snap = await db.ref('clipper/hashtag_presets').once('value');
        res.json(snap.val() || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/clipper/hashtag-presets', async (req, res) => {
    const { presets } = req.body;
    if (!Array.isArray(presets)) {
        return res.status(400).json({ error: "Ungültiges Format für Presets." });
    }
    try {
        await db.ref('clipper/hashtag_presets').set(presets);
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

app.delete('/api/clipper/tiktok-queue', async (req, res) => {
    try {
        await db.ref('clipper/tiktok_queue').remove();
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

// Endpoint for direct manual 1-click posting from the queue or finished clips
app.post('/api/clipper/post-now', async (req, res) => {
    const { filename, jobId, clipId, streamerName, caption, tiktokAccount, platform } = req.body;
    if (!filename) {
        return res.status(400).json({ error: "Dateiname fehlt." });
    }
    try {
        const cleanStreamerName = (streamerName || 'Streamer').toLowerCase().trim();
        const clipData = { filename, id: clipId || jobId || '' };

        // If there's an associated review job, update it to done
        if (jobId) {
            await db.ref(`clipper/renders/${jobId}`).update({ status: 'done', progress: 100 });
        }

        const targetPlatform = platform || 'tiktok';
        if (targetPlatform === 'tiktok' || targetPlatform === 'all') {
            await queueTikTokUpload(clipData, cleanStreamerName, caption, tiktokAccount || null, 'manual', true);
        }
        if (targetPlatform === 'youtube' || targetPlatform === 'all') {
            await queueYoutubeUpload(clipData, cleanStreamerName, caption, null, 'manual', true);
        }

        res.json({ success: true, message: "Upload in Warteschlange eingereiht." });
    } catch (err) {
        console.error("[Clipper] Post-Now Fehler:", err.message);
        res.status(500).json({ error: err.message });
    }
});

let warmTikTokBrowser = null;


async function getWarmTikTokBrowser() {
    if (!warmTikTokBrowser || !warmTikTokBrowser.isConnected()) {
        warmTikTokBrowser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security',
                '--disable-gpu',
                '--disable-dev-shm-usage'
            ]
        });
    }
    return warmTikTokBrowser;
}

async function syncClipperTikTokData(streamId, clipperId, clipper) {
    let handle = clipper.tiktokHandle || '';
    if (!handle && clipper.tiktokUrl) {
        const match = clipper.tiktokUrl.match(/@([a-zA-Z0-9_\.]+)/);
        if (match) handle = match[1];
    }
    
    handle = handle.replace(/^@/, '').trim();
    if (!handle) {
        throw new Error("Kein TikTok Handle oder URL hinterlegt.");
    }

    console.log(`[TikTok Sync] Fast-Sync for clipper: ${handle} (ClipperId: ${clipperId}, StreamId: ${streamId})`);

    let page = null;
    try {
        const browser = await getWarmTikTokBrowser();
        page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 1000 });
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
                req.abort();
            } else {
                req.continue();
            }
        });
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7' });
        
        const targetUrl = `https://www.tiktok.com/@${handle}`;
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        
        await Promise.race([
            page.waitForSelector('a[href*="/video/"]', { timeout: 7000 }),
            page.waitForSelector('[data-e2e="user-post-item"]', { timeout: 7000 }),
            new Promise(r => setTimeout(r, 4000))
        ]).catch(() => {});
        await new Promise(r => setTimeout(r, 1200));

        const result = await page.evaluate(() => {
            let img = '';
            try {
                const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
                if (el) {
                    const uData = JSON.parse(el.textContent);
                    const user = uData['__DEFAULT_SCOPE__']?.['webapp.user-detail']?.userInfo?.user;
                    if (user?.avatarLarger) img = user.avatarLarger;
                    else if (user?.avatarMedium) img = user.avatarMedium;
                    else if (user?.avatarThumb) img = user.avatarThumb;
                }
            } catch(e) {}

            if (!img) {
                const domImg = document.querySelector('[data-e2e="user-avatar"] img') ||
                               document.querySelector('[data-e2e="user-avatar"]') ||
                               document.querySelector('img[class*="Avatar"]') ||
                               document.querySelector('div[class*="DivAvatar"] img');
                if (domImg && domImg.src && !domImg.src.includes('a67f9744439872cde91')) {
                    img = domImg.src;
                }
            }

            if (!img) {
                const og = document.querySelector('meta[property="og:image"]')?.content || '';
                if (og && !og.includes('a67f9744439872cde91')) img = og;
            }

            const list = [];
            const links = document.querySelectorAll('a[href*="/video/"]');
            const processed = new Set();

            for (const a of links) {
                try {
                    let href = a.href;
                    try {
                        const urlObj = new URL(href);
                        href = urlObj.origin + urlObj.pathname;
                    } catch(e) {}

                    if (processed.has(href)) continue;
                    processed.add(href);

                    let viewsText = '0';
                    let titleText = '';

                    const container = a.closest('[data-e2e="user-post-item"]') || a.parentElement;
                    if (container) {
                        const viewsEl = container.querySelector('[data-e2e="video-views"]') || container.querySelector('strong');
                        if (viewsEl) viewsText = viewsEl.textContent.trim();

                        const titleEl = container.querySelector('[data-e2e="user-post-item-desc"]') || container.querySelector('img');
                        if (titleEl) {
                            titleText = (typeof titleEl.getAttribute === 'function' ? titleEl.getAttribute('alt') : '') || titleEl.textContent.trim();
                        }
                    }

                    list.push({ videoUrl: href, title: titleText, viewsText });
                } catch(e) {}
            }
            return { profileImage: img, videos: list };
        });

        await page.close();
        page = null;

        if (!result.profileImage && result.videos.length === 0) {
            throw new Error("Konnte keine Profildaten laden. TikTok blockiert eventuell die Anfrage.");
        }

        const updates = {};
        if (result.profileImage) {
            updates.profileImage = result.profileImage;
        }
        updates.lastSync = Date.now();
        await db.ref(`streams/${streamId}/data/clipper_team/clippers/${clipperId}`).update(updates);

        const videosRef = db.ref(`streams/${streamId}/data/clipper_team/videos`);
        const existingVideosSnap = await videosRef.once('value');
        const existingVideos = existingVideosSnap.val() || {};

        const parseViews = (text) => {
            if (!text) return 0;
            text = text.toUpperCase().trim();
            let multiplier = 1;
            if (text.endsWith('K')) {
                multiplier = 1000;
                text = text.slice(0, -1);
            } else if (text.endsWith('M')) {
                multiplier = 1000000;
                text = text.slice(0, -1);
            }
            return Math.round(parseFloat(text.replace(',', '.')) * multiplier) || 0;
        };

        const syncedVideos = [];
        const bulkUpdates = {};

        for (const item of result.videos) {
            const views = parseViews(item.viewsText);
            
            let videoTimestamp = Date.now();
            try {
                const match = item.videoUrl.match(/video\/(\d+)/);
                if (match) {
                    videoTimestamp = Number(BigInt(match[1]) >> 32n) * 1000;
                }
            } catch(e) {}
            const uploadDate = new Date(videoTimestamp).toISOString().split('T')[0];

            let existingKey = null;
            Object.entries(existingVideos).forEach(([key, ev]) => {
                if (ev.videoUrl === item.videoUrl && ev.clipperId === clipperId) {
                    existingKey = key;
                }
            });

            if (existingKey) {
                bulkUpdates[`${existingKey}/views`] = views;
                bulkUpdates[`${existingKey}/title`] = item.title || existingVideos[existingKey].title || 'TikTok Clip';
                bulkUpdates[`${existingKey}/timestamp`] = videoTimestamp;
                bulkUpdates[`${existingKey}/uploadDate`] = uploadDate;
                bulkUpdates[`${existingKey}/verified`] = true;
                syncedVideos.push({ key: existingKey, ...item, views, timestamp: videoTimestamp, uploadDate });
            } else {
                const newKey = videosRef.push().key;
                const newVideo = {
                    clipperId,
                    clipperName: clipper.name,
                    videoUrl: item.videoUrl,
                    title: item.title || 'TikTok Clip',
                    views,
                    platform: 'tiktok',
                    timestamp: videoTimestamp,
                    uploadDate: uploadDate,
                    verified: true
                };
                bulkUpdates[newKey] = newVideo;
                syncedVideos.push({ key: newKey, ...newVideo });
            }
        }

        if (Object.keys(bulkUpdates).length > 0) {
            await videosRef.update(bulkUpdates);
        }

        console.log(`[TikTok Sync] Completed sync for ${handle}: ${syncedVideos.length} videos stored in Firebase.`);

        return {
            profileImage: result.profileImage,
            syncedVideosCount: syncedVideos.length,
            videos: syncedVideos
        };

    } catch (err) {
        if (page) {
            try { await page.close(); } catch(e) {}
        }
        throw err;
    }
}

// Queue for sequential lightning-fast syncs without concurrency conflicts
let activeSyncPromises = new Map();
let syncQueuePromise = Promise.resolve();

function executeQueuedSync(taskFn) {
    const run = () => taskFn();
    const queued = syncQueuePromise.then(run, run);
    syncQueuePromise = queued.catch(() => {});
    return queued;
}

app.post('/api/clipper/sync-tiktok', async (req, res) => {
    const { streamId, clipperId } = req.body;
    if (!streamId || !clipperId) {
        return res.status(400).json({ error: "streamId und clipperId fehlen." });
    }

    const key = `${streamId}_${clipperId}`;
    if (activeSyncPromises.has(key)) {
        try {
            const result = await activeSyncPromises.get(key);
            return res.json({ success: true, ...result });
        } catch(err) {
            return res.status(500).json({ error: err.message });
        }
    }

    const syncTask = async () => {
        const snap = await db.ref(`streams/${streamId}/data/clipper_team/clippers/${clipperId}`).once('value');
        if (!snap.exists()) {
            throw new Error("Clipper nicht gefunden.");
        }
        const clipper = snap.val();
        return await syncClipperTikTokData(streamId, clipperId, clipper);
    };

    const promise = executeQueuedSync(syncTask);
    activeSyncPromises.set(key, promise);

    try {
        const result = await promise;
        res.json({
            success: true,
            ...result
        });
    } catch (err) {
        console.error('[TikTok Sync Error]', err);
        res.status(500).json({ error: err.message });
    } finally {
        activeSyncPromises.delete(key);
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
                null,
                channelName
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
    const { channelName, range, minViews, onlyCreator, creatorFilter } = req.query;
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
        const reqOnlyCreator = onlyCreator === 'true' || onlyCreator === true || req.query.onlyMinusnd === 'true';
        const targetCreator = (creatorFilter || 'MinusND').trim().toLowerCase();

        const filteredClips = clipsData.data
            .filter(c => {
                if (c.view_count < minViewsNum) return false;
                // Strikte Ersteller-Filterung: Nur Clips von MinusND (bzw. dem angegebenen Ersteller)
                // Filtert niemals nach dem Titel, sondern strikt nach c.creator_name!
                if (reqOnlyCreator && targetCreator) {
                    return (c.creator_name || '').trim().toLowerCase() === targetCreator;
                }
                return true;
            })
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
    const { filename, mp4Url, clipId, start, end, camCrop, gameCrop, layout, textOverlay, audioHighPitch, autoPublish, streamerName, tiktokAccount, tiktokCaption, autoPublishYoutube, youtubeAccount, youtubeCaption, jobId, isAlreadyRendered, zoomEffect, logoConfig, isManual } = req.body;
    
    if (!isAlreadyRendered && ((!filename && !mp4Url) || start === undefined || end === undefined || !camCrop || !gameCrop)) {
        return res.status(400).json({ error: "Fehlende Parameter für Hochformat-Rendering." });
    }

    try {
        const finalJobId = jobId || db.ref('clipper/renders').push().key;
        const fs = require('fs');
        const path = require('path');

        if (isAlreadyRendered) {
            const handleFinalize = async () => {
                try {
                    await db.ref(`clipper/renders/${finalJobId}`).update({ status: 'rendering', progress: 50 });
                    
                    const jobSnap = await db.ref(`clipper/renders/${finalJobId}`).once('value');
                    const existingJob = jobSnap.val() || {};
                    let sourceFilename = filename;
                    if (existingJob.cleanFilename && fs.existsSync(path.join(clipperManager.clipsDir, existingJob.cleanFilename))) {
                        sourceFilename = existingJob.cleanFilename;
                    }

                    const finalClip = await clipperManager.renderPortrait(finalJobId, sourceFilename, start, end, camCrop, gameCrop, layout, textOverlay, streamerName, audioHighPitch, zoomEffect, logoConfig);
                    
                    const shouldDelete = filename.startsWith('twitch_');
                    const rawPath = path.join(clipperManager.clipsDir, filename);
                    if (shouldDelete && fs.existsSync(rawPath) && finalClip.filename !== filename && filename !== existingJob.cleanFilename) {
                        try { fs.unlinkSync(rawPath); } catch(e) {}
                    }
                    
                    await db.ref(`clipper/renders/${finalJobId}`).update({ 
                        status: 'done', 
                        progress: 100,
                        filename: finalClip.filename,
                        clip: {
                            id: finalClip.id,
                            filename: finalClip.filename,
                            url: finalClip.url
                        }
                    });
                    
                    if (clipId) {
                        await db.ref(`clipper/processed_clips/${clipId}`).update({
                            status: 'done',
                            renderJobId: finalJobId,
                            clipUrl: `https://minusnd.de/public/clips/${finalClip.filename}`
                        });
                    }

                    if (autoPublish) {
                        const finalCaption = (tiktokCaption !== undefined && tiktokCaption !== null && tiktokCaption !== '') ? tiktokCaption : (textOverlay ? (textOverlay.text || textOverlay.content) : undefined);
                        await queueTikTokUpload(finalClip, streamerName, finalCaption, tiktokAccount, layout, !!isManual);
                    }
                    if (autoPublishYoutube) {
                        const finalCaption = (youtubeCaption !== undefined && youtubeCaption !== null && youtubeCaption !== '') ? youtubeCaption : (textOverlay ? (textOverlay.text || textOverlay.content) : undefined);
                        await queueYoutubeUpload(finalClip, streamerName, finalCaption, youtubeAccount, layout, !!isManual);
                    }
                } catch (err) {
                    console.error(`[Clipper] Finalize Review Fehler für Job ${finalJobId}:`, err.message);
                    await db.ref(`clipper/renders/${finalJobId}`).update({ status: 'failed', error: err.message });
                }
            };
            
            handleFinalize();
            return res.json({ success: true, jobId: finalJobId });
        }

        // Set initial job status with metadata
        const initialJobData = {
            id: finalJobId,
            status: mp4Url ? 'downloading' : 'rendering',
            filename: filename || `temp_twitch_${finalJobId}.mp4`,
            timestamp: Date.now(),
            autoPublish: !!autoPublish,
            autoPublishYoutube: !!autoPublishYoutube,
            streamerName: streamerName || 'Streamer',
            tiktokAccount: tiktokAccount || 'default',
            youtubeAccount: youtubeAccount || 'default',
            audioHighPitch: !!audioHighPitch,
            progress: 0
        };
        await db.ref(`clipper/renders/${finalJobId}`).set(initialJobData);

        if (mp4Url) {
            // Downloading Twitch clip MP4 before running the portrait render pipeline
            const targetFilename = `temp_twitch_${finalJobId}.mp4`;
            const tempPath = path.join(clipperManager.clipsDir, targetFilename);

            const runDownloadAndRender = async () => {
                try {
                    // Update job status to downloading
                    await db.ref(`clipper/renders/${finalJobId}`).update({ status: 'downloading', progress: 0 });
                    
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
                    const renderedClip = await clipperManager.renderPortrait(finalJobId, targetFilename, start, end, camCrop, gameCrop, layout, textOverlay, streamerName, audioHighPitch, zoomEffect, logoConfig);
                    
                    if (clipId) {
                        await db.ref(`clipper/processed_clips/${clipId}`).update({
                            status: 'done',
                            renderJobId: finalJobId,
                            clipUrl: `https://minusnd.de/public/clips/${renderedClip.filename}`
                        });
                    }

                    if (autoPublish) {
                        const finalCaption = (tiktokCaption !== undefined && tiktokCaption !== null && tiktokCaption !== '') ? tiktokCaption : (textOverlay ? (textOverlay.text || textOverlay.content) : undefined);
                        await queueTikTokUpload(renderedClip, streamerName, finalCaption, tiktokAccount, layout, !!isManual);
                    }
                    if (autoPublishYoutube) {
                        const finalCaption = (youtubeCaption !== undefined && youtubeCaption !== null && youtubeCaption !== '') ? youtubeCaption : (textOverlay ? (textOverlay.text || textOverlay.content) : undefined);
                        await queueYoutubeUpload(renderedClip, streamerName, finalCaption, youtubeAccount, layout, !!isManual);
                    }
                } catch (err) {
                    console.error(`[Clipper] Download/Render Fehler für Job ${finalJobId}:`, err.message);
                    await db.ref(`clipper/renders/${finalJobId}`).update({ status: 'failed', error: err.message });
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
            // Direct local DVR clip rendering (or pre-downloaded clip in review mode)
            clipperManager.renderPortrait(finalJobId, filename, start, end, camCrop, gameCrop, layout, textOverlay, streamerName, audioHighPitch, zoomEffect, logoConfig)
                .then(async (renderedClip) => {
                    if (clipId) {
                        await db.ref(`clipper/processed_clips/${clipId}`).update({
                            status: 'done',
                            renderJobId: finalJobId,
                            clipUrl: `https://minusnd.de/public/clips/${renderedClip.filename}`
                        });
                    }

                    if (autoPublish) {
                        const finalCaption = (tiktokCaption !== undefined && tiktokCaption !== null && tiktokCaption !== '') ? tiktokCaption : (textOverlay ? (textOverlay.text || textOverlay.content) : undefined);
                        await queueTikTokUpload(renderedClip, streamerName, finalCaption, tiktokAccount, layout, !!isManual);
                    }
                    if (autoPublishYoutube) {
                        const finalCaption = (youtubeCaption !== undefined && youtubeCaption !== null && youtubeCaption !== '') ? youtubeCaption : (textOverlay ? (textOverlay.text || textOverlay.content) : undefined);
                        await queueYoutubeUpload(renderedClip, streamerName, finalCaption, youtubeAccount, layout, !!isManual);
                    }
                    
                    // If it is an agent-downloaded file (starts with twitch_), clean it up from clipsDir
                    if (filename.startsWith('twitch_')) {
                        const rawPath = path.join(clipperManager.clipsDir, filename);
                        if (fs.existsSync(rawPath)) {
                            try { fs.unlinkSync(rawPath); } catch(e) {}
                        }
                    }
                })
                .catch(err => console.error(`[Clipper] Asynchrones Rendering fehlgeschlagen für Job ${finalJobId}:`, err.message));
        }

        res.json({ success: true, jobId: finalJobId });
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
                '--disable-web-security',
                '--disable-gpu',
                '--disable-dev-shm-usage'
            ],
            userDataDir: sessionDir
        });

        const page = await browser.newPage();
        await page.bringToFront();
        await page.setViewport({ width: 1280, height: 800 });
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
        const manualCookieFile = findYoutubeSessionFile(account, 'cookie');
        if (manualCookieFile && fs.existsSync(manualCookieFile)) {
            fs.unlinkSync(manualCookieFile);
        }
        const manualOauthFile = findYoutubeSessionFile(account, 'oauth');
        if (manualOauthFile && fs.existsSync(manualOauthFile)) {
            fs.unlinkSync(manualOauthFile);
        }
        let sessionDir = path.join(__dirname, 'youtube_sessions', `youtube_session_${account}`);
        if (!fs.existsSync(sessionDir)) {
            const dir = path.join(__dirname, 'youtube_sessions');
            if (fs.existsSync(dir)) {
                const files = fs.readdirSync(dir);
                const lowerSessionName = `youtube_session_${account}`.toLowerCase();
                const match = files.find(f => f.toLowerCase() === lowerSessionName);
                if (match) sessionDir = path.join(dir, match);
            }
        }
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
        const hasCookie = !!findYoutubeSessionFile(account, 'cookie');
        const hasOauth = !!findYoutubeSessionFile(account, 'oauth');
        
        if (hasOauth) {
            return res.json({ status: 'connected', method: 'oauth', message: 'Mit YouTube API (OAuth2) verbunden.' });
        } else if (hasCookie) {
            return res.json({ status: 'connected', method: 'cookie', message: 'Cookies hinterlegt.' });
        } else {
            return res.json({ status: 'disconnected', message: 'Nicht verbunden.' });
        }
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

app.delete('/api/clipper/youtube-queue', async (req, res) => {
    try {
        await db.ref('clipper/youtube_queue').remove();
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

async function checkYoutubeVerificationBlocked(page) {
    try {
        const isBlocked = await page.evaluate(() => {
            function hasTextInShadow(node, text) {
                if (!node) return false;
                if (node.nodeType === Node.TEXT_NODE && node.textContent && node.textContent.includes(text)) {
                    const el = node.parentElement;
                    if (el) {
                        const rect = el.getBoundingClientRect();
                        return rect.width > 0 && rect.height > 0;
                    }
                    return true;
                }
                if (node.shadowRoot && hasTextInShadow(node.shadowRoot, text)) {
                    return true;
                }
                if (node.childNodes) {
                    for (let i = 0; i < node.childNodes.length; i++) {
                        if (hasTextInShadow(node.childNodes[i], text)) {
                            return true;
                        }
                    }
                }
                return false;
            }
            
            // Helper to get element visibility
            function isVisible(el) {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            }
            
            function hasSelectorInShadow(node, selector) {
                if (!node) return false;
                if (node instanceof Element && node.matches(selector)) {
                    return isVisible(node);
                }
                if (node.shadowRoot && hasSelectorInShadow(node.shadowRoot, selector)) {
                    return true;
                }
                if (node.children) {
                    for (let i = 0; i < node.children.length; i++) {
                        if (hasSelectorInShadow(node.children[i], selector)) {
                            return true;
                        }
                    }
                }
                return false;
            }

            const searchTexts = [
                'Identität bestätigen',
                "Verify it's you",
                'Confirm your identity',
                'Bestätige deine Identität',
                'Identitätsprüfung',
                'Identität prüfen'
            ];
            
            for (const text of searchTexts) {
                if (hasTextInShadow(document.body, text)) {
                    return true;
                }
            }
            
            const searchSelectors = [
                'ytcp-identity-verification-dialog',
                'ytcp-identity-verification'
            ];
            
            for (const selector of searchSelectors) {
                if (hasSelectorInShadow(document.body, selector)) {
                    return true;
                }
            }
            
            return false;
        });
        return !!isBlocked;
    } catch (e) {
        console.error("[YouTube Uploader] Fehler bei Verifikationsprüfung:", e.message);
        return false;
    }
}

async function handleYoutubeVerificationDialog(page, statusCallback, accountName, publicClipsDir) {
    console.log(`[YouTube Uploader] handleYoutubeVerificationDialog aufgerufen für ${accountName}`);
    
    // 1. Finde und klicke den "Weiter"-Button in der Identity-Verification-Box
    try {
        const clickedNext = await page.evaluate(() => {
            function findAndClickNextButton(node) {
                if (!node) return false;
                if (node instanceof Element && node.tagName.toLowerCase() === 'ytcp-button' && 
                    (node.textContent.includes('Weiter') || node.textContent.includes('Next') || node.textContent.includes('Proceed'))) {
                    if (node.shadowRoot) {
                        const btn = node.shadowRoot.querySelector('button');
                        if (btn) { btn.click(); return true; }
                    }
                    node.click();
                    return true;
                }
                if (node.shadowRoot) {
                    const result = findAndClickNextButton(node.shadowRoot);
                    if (result) return true;
                }
                if (node.childNodes) {
                    for (let i = 0; i < node.childNodes.length; i++) {
                        const result = findAndClickNextButton(node.childNodes[i]);
                        if (result) return true;
                    }
                }
                return false;
            }
            return findAndClickNextButton(document.body);
        });
        if (clickedNext) {
            console.log(`[YouTube Uploader] "Weiter"-Button der Verifikations-Box angeklickt.`);
            await new Promise(r => setTimeout(r, 4000));
        }
    } catch (clickErr) {
        console.error(`[YouTube Uploader] Fehler beim Klicken des "Weiter"-Buttons:`, clickErr.message);
    }
    
    // 2. Warte in einer Schleife (bis zu 3 Minuten) auf die manuelle Bestätigung des Nutzers
    const maxWaitTime = 180000; // 3 Minuten
    const intervalTime = 5000;  // alle 5 Sekunden
    let elapsed = 0;
    
    const screenshotPath = path.join(publicClipsDir, `youtube_verification_${accountName}.png`);
    const screenshotUrl = `/clips/youtube_verification_${accountName}.png`; // Relativer Pfad für den Nutzer
    
    statusCallback('verification', `Google-Verifizierung erforderlich. Bitte bestätige auf deinem Gerät. (Siehe Zahl auf Screenshot: ${screenshotUrl})`);
    
    while (elapsed < maxWaitTime) {
        try {
            await page.screenshot({ path: screenshotPath });
            console.log(`[YouTube Uploader] Verifikations-Screenshot gespeichert unter: ${screenshotPath}`);
        } catch (e) {
            console.warn(`[YouTube Uploader] Fehler beim Erstellen des Screenshots:`, e.message);
        }
        
        await new Promise(r => setTimeout(r, intervalTime));
        elapsed += intervalTime;
        
        const currentUrl = page.url();
        const stillBlocked = await checkYoutubeVerificationBlocked(page);
        const onGoogleAccountPage = currentUrl.includes('accounts.google.com') || currentUrl.includes('signin');
        
        if (!stillBlocked && !onGoogleAccountPage) {
            console.log(`[YouTube Uploader] Verifikation erfolgreich abgeschlossen!`);
            statusCallback('uploading', 'Verifikation erfolgreich! Setze Upload fort...');
            try {
                fs.unlinkSync(screenshotPath);
            } catch (unlinkErr) {}
            return true;
        }
        
        const secondsLeft = Math.round((maxWaitTime - elapsed) / 1000);
        statusCallback('verification', `Google-Verifizierung erforderlich. Bestätige auf deinem Smartphone. (${secondsLeft}s übrig, Zahl auf Screenshot: ${screenshotUrl})`);
    }
    
    throw new Error("Verifikations-Zeitlimit abgelaufen. Bitte bestätige die Identität rechtzeitig auf deinem Smartphone.");
}


async function runYoutubeUploadOnServer(videoPath, caption, hashtags, autoPublish, youtubeAccount = 'default', statusCallback) {
    let browser = null;
    let page = null;
    try {
        let accountName = (youtubeAccount || 'default').replace(/[^a-zA-Z0-9_]/g, '');
        const oauthFile = findYoutubeSessionFile(accountName, 'oauth');

        if (oauthFile && fs.existsSync(oauthFile)) {
            console.log(`[YouTube Uploader] Gefundene OAuth2-Anmeldedaten fuer ${accountName}. Verwende die offizielle YouTube API fuer den Upload.`);
            try {
                statusCallback('starting', 'Initialisiere YouTube API (OAuth2)...');
                const tokens = JSON.parse(fs.readFileSync(oauthFile, 'utf8'));
                
                const oauth2Client = new google.auth.OAuth2(
                    process.env.GOOGLE_CLIENT_ID,
                    process.env.GOOGLE_CLIENT_SECRET,
                    process.env.GOOGLE_REDIRECT_URI
                );
                oauth2Client.setCredentials(tokens);
                
                // Tokens automatisch speichern, wenn sie aktualisiert werden
                oauth2Client.on('tokens', (newTokens) => {
                    const updatedTokens = { ...tokens, ...newTokens };
                    fs.writeFileSync(oauthFile, JSON.stringify(updatedTokens, null, 2), 'utf8');
                    console.log(`[YouTube API] OAuth2 Tokens fuer ${accountName} wurden automatisch aktualisiert.`);
                });

                // Vorbereitung von Titel & Beschreibung mit #shorts und Hashtags
                let titleText = (caption || '').trim();
                if (titleText === 'undefined' || !titleText) {
                    titleText = 'Stream Clip';
                }
                const tagsString = hashtags.map(tag => tag.startsWith('#') ? tag : '#' + tag).join(' ');
                if (tagsString) {
                    titleText = `${titleText} ${tagsString}`;
                }
                if (!titleText.toLowerCase().includes('#shorts')) {
                    titleText = `${titleText} #shorts`;
                }
                if (titleText.length > 100) {
                    titleText = titleText.substring(0, 92) + ' #shorts';
                }
                
                let descText = '';
                if (tagsString) {
                    descText = `${tagsString}\n\n#shorts`;
                } else {
                    descText = '#shorts';
                }

                const youtube = google.youtube({
                    version: 'v3',
                    auth: oauth2Client
                });

                statusCallback('uploading', 'Videodatei wird ueber die YouTube API uebertragen (0%)...');
                const mediaSize = fs.statSync(videoPath).size;

                console.log(`[YouTube API] Starte Video-Upload fuer ${accountName}: Title = "${titleText}"`);
                
                const res = await youtube.videos.insert({
                    part: 'snippet,status',
                    requestBody: {
                        snippet: {
                            title: titleText,
                            description: descText,
                            categoryId: '22', // People & Blogs
                            defaultLanguage: 'de'
                        },
                        status: {
                            privacyStatus: autoPublish ? 'public' : 'private',
                            selfDeclaredMadeForKids: false
                        }
                    },
                    media: {
                        body: fs.createReadStream(videoPath)
                    }
                }, {
                    onUploadProgress: (evt) => {
                        const progress = Math.round((evt.bytesRead / mediaSize) * 100);
                        statusCallback('uploading', `Videodatei wird ueber die YouTube API uebertragen (${progress}%)...`);
                    }
                });

                console.log(`[YouTube API] Upload erfolgreich! Video ID: ${res.data.id}`);
                statusCallback('done', 'Upload ueber YouTube API erfolgreich abgeschlossen!');
                return res.data.id;
            } catch (apiErr) {
                console.error(`[YouTube API] API-Upload fehlgeschlagen, versuche Puppeteer-Fallback:`, apiErr);
                statusCallback('uploading', `API-Upload fehlgeschlagen (${apiErr.message}). Versuche Puppeteer-Fallback...`);
            }
        }

        statusCallback('starting', 'Initialisiere Chrome...');
        const sessionDir = path.join(__dirname, 'youtube_sessions', `youtube_session_${accountName}`);

        let publicClipsDir = path.join(__dirname, '../public/clips');
        if (fs.existsSync('/var/www/bingo/public/clips')) {
            publicClipsDir = '/var/www/bingo/public/clips';
        } else if (fs.existsSync(path.join(__dirname, '..', 'bingo', 'public', 'clips'))) {
            publicClipsDir = path.join(__dirname, '..', 'bingo', 'public', 'clips');
        }

        // Lösche das gesamte Session-Verzeichnis für einen sauberen Start ohne hängende Tabs oder Cache-Bloat
        if (fs.existsSync(sessionDir)) {
            try {
                fs.rmSync(sessionDir, { recursive: true, force: true });
                console.log(`[YouTube Uploader] Session-Verzeichnis komplett gelöscht für ${accountName}`);
            } catch (e) {
                console.warn(`[YouTube Uploader] Fehler beim Löschen des Session-Verzeichnisses für ${accountName}:`, e.message);
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
                '--disable-dev-shm-usage',
                '--disable-features=site-per-process'
            ],
            userDataDir: sessionDir
        });
        console.log(`[YouTube Uploader] Puppeteer erfolgreich gestartet.`);

        const pages = await browser.pages();
        page = pages.length > 0 ? pages[0] : await browser.newPage();
        try {
            await page.goto('about:blank');
        } catch (e) {
            console.log(`[YouTube Uploader] Fehler beim Zurücksetzen der Seite auf about:blank:`, e.message);
        }
        for (let i = 1; i < pages.length; i++) {
            try {
                await pages[i].goto('about:blank');
                await pages[i].close();
            } catch (e) {}
        }
        console.log(`[YouTube Uploader] Seite erstellt / geholt.`);
        
        await page.bringToFront();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1280, height: 800 });
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7' });
        
        // Load manual cookies if present
        const manualCookieFile = findYoutubeSessionFile(accountName, 'cookie');
        if (manualCookieFile && fs.existsSync(manualCookieFile)) {
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
                        
                        // Group cookies by domain to avoid invalid domain exceptions
                        const googleCookies = cleanedCookies.filter(c => c.domain.includes('google.com'));
                        const youtubeCookies = cleanedCookies.filter(c => c.domain.includes('youtube.com'));
                        
                        if (googleCookies.length > 0) {
                            console.log(`[YouTube Uploader] Injecting ${googleCookies.length} Google cookies...`);
                            await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
                            await page.setCookie(...googleCookies);
                            await new Promise(r => setTimeout(r, 1000));
                        }
                        
                        if (youtubeCookies.length > 0) {
                            console.log(`[YouTube Uploader] Injecting ${youtubeCookies.length} YouTube cookies...`);
                            await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
                            await page.setCookie(...youtubeCookies);
                            await new Promise(r => setTimeout(r, 1000));
                        }
                        
                        await new Promise(r => setTimeout(r, 2000));
                        console.log(`[YouTube Uploader] Session-Cookies erfolgreich injiziert.`);
                    }
                }
            } catch (cookieErr) {
                console.error(`[YouTube Uploader] Fehler beim Laden/Setzen der Cookies:`, cookieErr.message);
            }
        }
        
        statusCallback('starting', 'Navigiere zu YouTube Studio...');
        console.log(`[YouTube Uploader] Navigiere zu YouTube Studio...`);
        try {
            await page.goto('https://studio.youtube.com', {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });
            console.log(`[YouTube Uploader] Navigation zu YouTube Studio erfolgreich.`);
        } catch (gotoErr) {
            console.log(`[YouTube Uploader] Warnung bei Navigation zu YouTube Studio (fahre fort):`, gotoErr.message);
        }
        await new Promise(r => setTimeout(r, 6000));
        
        if (await checkYoutubeVerificationBlocked(page)) {
            await handleYoutubeVerificationDialog(page, statusCallback, accountName, publicClipsDir);
        }
        
        // Check login state
        const currentUrl = page.url();
        if (currentUrl.includes('accounts.google.com') || currentUrl.includes('signin')) {
            try {
                await page.screenshot({ path: path.join(publicClipsDir, `youtube_debug_${accountName}_login_failed.png`) });
            } catch(e) {}
            throw new Error('Nicht eingeloggt. Bitte verbinde zuerst deinen YouTube-Account im Dashboard mit aktuellen Cookies.');
        }
        
        // Check for "unsupported browser" warning page
        try {
            console.log('[YouTube Uploader] Prüfe auf unsupported-browser Warnung...');
            let clickedDirect = false;
            for (let checkAttempt = 0; checkAttempt < 10; checkAttempt++) {
                try {
                    clickedDirect = await page.evaluate(() => {
                        const elements = Array.from(document.querySelectorAll('*'));
                        const directLink = elements.find(el => {
                            const txt = el.textContent.toLowerCase().trim();
                            return txt.includes('direkt zu') || txt.includes('go to youtube');
                        });
                        if (directLink) {
                            directLink.click();
                            if (directLink.parentElement) {
                                directLink.parentElement.click();
                            }
                            return true;
                        }
                        return false;
                    });
                    
                    if (clickedDirect) {
                        console.log('[YouTube Uploader] Unsupported browser page detected. Klick auf "Direkt zu YouTube Studio" gesendet.');
                        await new Promise(r => setTimeout(r, 8000));
                        break;
                    }
                } catch (evalErr) {
                    console.log(`[YouTube Uploader] Eval-Fehler im Warnungs-Check (Versuch ${checkAttempt}):`, evalErr.message);
                }
                await new Promise(r => setTimeout(r, 1000));
            }
        } catch (warningErr) {
            console.log('[YouTube Uploader] Fehler beim Behandeln der Browser-Warnung:', warningErr.message);
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
        
        if (await checkYoutubeVerificationBlocked(page)) {
            await handleYoutubeVerificationDialog(page, statusCallback, accountName, publicClipsDir);
        }
        
        // Prepare title & description with #shorts
        let titleText = (caption || '').trim();
        if (titleText === 'undefined' || !titleText) {
            titleText = 'Stream Clip';
        }
        const tags = hashtags.map(tag => tag.startsWith('#') ? tag : '#' + tag).join(' ');
        if (tags) {
            titleText = `${titleText} ${tags}`;
        }
        if (!titleText.toLowerCase().includes('#shorts')) {
            titleText = `${titleText} #shorts`;
        }
        if (titleText.length > 100) {
            titleText = titleText.substring(0, 92) + ' #shorts';
        }
        
        let descText = '';
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
            if (await checkYoutubeVerificationBlocked(page)) {
                await handleYoutubeVerificationDialog(page, statusCallback, accountName, publicClipsDir);
            }
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
        if (await checkYoutubeVerificationBlocked(page)) {
            await handleYoutubeVerificationDialog(page, statusCallback, accountName, publicClipsDir);
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
                        if (doneBtn.hasAttribute('disabled') || doneBtn.disabled || doneBtn.getAttribute('aria-disabled') === 'true') {
                            return 'disabled';
                        }
                        if (doneBtn.shadowRoot) {
                            const btn = doneBtn.shadowRoot.querySelector('button');
                            if (btn && (btn.hasAttribute('disabled') || btn.disabled || btn.getAttribute('aria-disabled') === 'true')) {
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
            for (let check = 0; check < 30; check++) { // 60 seconds max
                await new Promise(r => setTimeout(r, 2000));
                const confirmed = await page.evaluate(() => {
                    function shadowQuerySelector(root, selector) {
                        if (!root) return null;
                        if (root instanceof Element && root.matches(selector)) {
                            return root;
                        }
                        if (root.shadowRoot) {
                            const found = shadowQuerySelector(root.shadowRoot, selector);
                            if (found) return found;
                        }
                        for (let i = 0; i < root.childNodes.length; i++) {
                            const found = shadowQuerySelector(root.childNodes[i], selector);
                            if (found) return found;
                        }
                        return null;
                    }

                    function hasTextInShadow(node, text) {
                        if (!node) return false;
                        if (node.nodeType === Node.TEXT_NODE && node.textContent && node.textContent.includes(text)) {
                            return true;
                        }
                        if (node.shadowRoot && hasTextInShadow(node.shadowRoot, text)) {
                            return true;
                        }
                        if (node.childNodes) {
                            for (let i = 0; i < node.childNodes.length; i++) {
                                if (hasTextInShadow(node.childNodes[i], text)) {
                                    return true;
                                }
                            }
                        }
                        return false;
                    }

                    const shareUrlInput = shadowQuerySelector(document.body, '#share-url') || 
                                          shadowQuerySelector(document.body, '.share-url') || 
                                          shadowQuerySelector(document.body, 'a[href*="youtu.be"]');
                                          
                    const dialogTitle = shadowQuerySelector(document.body, 'ytcp-uploads-still-processing-dialog') || 
                                        shadowQuerySelector(document.body, 'ytcp-video-share-dialog');
                                        
                    const successText = hasTextInShadow(document.body, 'Hochladen abgeschlossen') || 
                                        hasTextInShadow(document.body, 'Upload abgeschlossen') ||
                                        hasTextInShadow(document.body, 'Video veröffentlicht');

                    return !!(shareUrlInput || dialogTitle || successText);
                });
                
                if (confirmed) {
                    publishConfirmed = true;
                    break;
                }
                
                // Also check if we got blocked by verification mid-publish
                if (await checkYoutubeVerificationBlocked(page)) {
                    await handleYoutubeVerificationDialog(page, statusCallback, accountName, publicClipsDir);
                }
            }
            
            // Save final screenshot
            try {
                await page.screenshot({ path: path.join(publicClipsDir, `youtube_debug_${accountName}_4_published.png`) });
            } catch (e) {}
            
            if (!publishConfirmed) {
                try {
                    await page.screenshot({ path: path.join(publicClipsDir, `youtube_debug_${accountName}_publish_unconfirmed.png`) });
                } catch (e) {}
                throw new Error("Veröffentlichung konnte nicht bestätigt werden. Möglicherweise ist ein Fehler aufgetreten oder die Verbindung war zu langsam.");
            }
            
            statusCallback('done', 'Video wurde erfolgreich auf YouTube Shorts veröffentlicht!');
        } else {
            statusCallback('done', 'Video wurde erfolgreich als Entwurf vorbereitet!');
        }
        
    } catch (err) {
        try {
            if (page) {
                let accountName = (youtubeAccount || 'default').replace(/[^a-zA-Z0-9_]/g, '');
                let publicClipsDir = path.join(__dirname, '../public/clips');
                if (fs.existsSync('/var/www/bingo/public/clips')) {
                    publicClipsDir = '/var/www/bingo/public/clips';
                } else if (fs.existsSync(path.join(__dirname, '..', 'bingo', 'public', 'clips'))) {
                    publicClipsDir = path.join(__dirname, '..', 'bingo', 'public', 'clips');
                }
                await page.screenshot({ path: path.join(publicClipsDir, `youtube_debug_${accountName}_error_occurred.png`) });
                console.log(`[YouTube Uploader] Error screenshot saved: youtube_debug_${accountName}_error_occurred.png`);
            }
        } catch (screenshotErr) {
            console.error("[YouTube Uploader] Failed to take error screenshot:", screenshotErr.message);
        }
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
                    
                    // Fallback to streamer name if caption is empty, to prevent caption starting with '#' which crashes TikTok Studio on paste
                    let finalCaption = (job.caption || '').trim();
                    if (!finalCaption || finalCaption === 'undefined') {
                        const displayName = job.streamerName ? job.streamerName.charAt(0).toUpperCase() + job.streamerName.slice(1) : 'Clip';
                        finalCaption = displayName;
                    }
                    if (finalCaption.startsWith('#')) {
                        const displayName = job.streamerName ? job.streamerName.charAt(0).toUpperCase() + job.streamerName.slice(1) : 'Clip';
                        finalCaption = `${displayName} ${finalCaption}`;
                    }

                    await runTikTokUploadOnServer(
                        localPath,
                        finalCaption,
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

                // Apply cooldown delay between uploads if configured
                try {
                    const settingsSnap = await db.ref('clipper/config').once('value');
                    const settings = settingsSnap.val() || {};
                    const cooldownSec = parseInt(settings.uploadCooldownSec || 0, 10);

                    const nextSnap = await db.ref('clipper/tiktok_queue').once('value');
                    const nextQueue = nextSnap.val() || {};
                    const nextPending = Object.values(nextQueue)
                        .filter(j => j.status === 'pending')
                        .sort((a, b) => a.timestamp - b.timestamp);

                    if (nextPending.length > 0 && cooldownSec > 0) {
                        const nextJob = nextPending[0];
                        console.log(`[TikTok Server Queue] Cooldown aktiv. Warte ${cooldownSec} Sekunden vor dem nächsten Upload...`);
                        
                        for (let c = cooldownSec; c > 0; c--) {
                            // Update progress message on the next job to show the countdown
                            await db.ref(`clipper/tiktok_queue/${nextJob.id}`).update({
                                progressMessage: `Warte auf Upload-Cooldown (noch ${c}s)...`
                            });
                            await new Promise(r => setTimeout(r, 1000));
                            
                            // Re-verify if next job status is still pending (in case it got deleted/cancelled)
                            const checkSnap = await db.ref(`clipper/tiktok_queue/${nextJob.id}/status`).once('value');
                            if (!checkSnap.exists() || checkSnap.val() !== 'pending') {
                                break;
                            }
                        }
                        
                        // Reset progress message of the next job back to empty before processing
                        const checkSnap = await db.ref(`clipper/tiktok_queue/${nextJob.id}/status`).once('value');
                        if (checkSnap.exists() && checkSnap.val() === 'pending') {
                            await db.ref(`clipper/tiktok_queue/${nextJob.id}`).update({
                                progressMessage: ''
                            });
                        }
                    }
                } catch (cooldownErr) {
                    console.error("[TikTok Server Queue] Fehler bei Cooldown-Berechnung:", cooldownErr.message);
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
    let page = null;
    let accountName = (tiktokAccount || 'default').replace(/[^a-zA-Z0-9_]/g, '');
    let publicClipsDir = path.join(__dirname, '../public/clips');

    try {
        statusCallback('starting', 'Initialisiere Chrome...');
        
        const sessionDir = path.join(__dirname, 'tiktok_sessions', `tiktok_session_${accountName}`);

        if (fs.existsSync('/var/www/bingo/public/clips')) {
            publicClipsDir = '/var/www/bingo/public/clips';
        } else if (fs.existsSync(path.join(__dirname, '..', 'bingo', 'public', 'clips'))) {
            publicClipsDir = path.join(__dirname, '..', 'bingo', 'public', 'clips');
        }

        // Lösche das gesamte Session-Verzeichnis für einen sauberen Start ohne hängende Tabs oder Cache-Bloat
        if (fs.existsSync(sessionDir)) {
            try {
                fs.rmSync(sessionDir, { recursive: true, force: true });
                console.log(`[TikTok Uploader] Session-Verzeichnis komplett gelöscht für ${accountName}`);
            } catch (e) {
                console.warn(`[TikTok Uploader] Fehler beim Löschen des Session-Verzeichnisses für ${accountName}:`, e.message);
            }
        }

        console.log(`[TikTok Uploader] Starte Puppeteer mit headless: new...`);
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--disable-features=site-per-process'
            ],
            userDataDir: sessionDir
        });
        console.log(`[TikTok Uploader] Puppeteer erfolgreich gestartet.`);

        const pages = await browser.pages();
        page = pages.length > 0 ? pages[0] : await browser.newPage();
        console.log(`[TikTok Uploader] Seite erstellt / geholt.`);
        
        await page.bringToFront();
        console.log(`[TikTok Uploader] page.bringToFront() erfolgreich.`);
        
        await page.setViewport({ width: 1280, height: 800 });
        console.log(`[TikTok Uploader] Viewport gesetzt.`);
        
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
        const loadCrashInfo = await page.evaluate(() => {
            const bodyText = document.body.innerText.toLowerCase();
            if (bodyText.includes('something went wrong') || 
                bodyText.includes('please try again') || 
                bodyText.includes('schiefgelaufen') ||
                bodyText.includes('versuche es später erneut') || 
                bodyText.includes('versuch es später erneut')) {
                // Look for a Retry button coords for trusted mouse click
                const buttons = Array.from(document.querySelectorAll('button'));
                const retryBtn = buttons.find(b => {
                    const txt = b.textContent.toLowerCase().trim();
                    return txt.includes('retry') || txt.includes('erneut') || txt.includes('wiederholen');
                });
                if (retryBtn) {
                    const rect = retryBtn.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        return { type: 'retry', x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                    }
                }
                return { type: 'crash' };
            }
            return null;
        });

        if (loadCrashInfo && loadCrashInfo.type === 'retry') {
            console.log(`[TikTok Uploader] Crash-Bildschirm beim Laden erkannt, klicke "Retry" via Mouse-Click bei (${loadCrashInfo.x}, ${loadCrashInfo.y})...`);
            await page.mouse.click(loadCrashInfo.x, loadCrashInfo.y);
            await new Promise(r => setTimeout(r, 5000));
        } else if (loadCrashInfo && loadCrashInfo.type === 'crash') {
            throw new Error('TikTok-Fehler beim Laden der Seite: "Something went wrong" (System-Crash-Bildschirm).');
        }

        // Deaktiviere beforeunload Warnungen, um hängende Exit-Dialoge beim Schließen zu verhindern
        await page.evaluate(() => {
            window.onbeforeunload = null;
        });

        let hasFileInput = false;
        const fileInputSelectors = ['input[type="file"]', 'input[accept*="video"]', 'input[name="video"]'];
        for (let waitAttempt = 0; waitAttempt < 30; waitAttempt++) {
            for (const sel of fileInputSelectors) {
                if (await page.$(sel)) {
                    hasFileInput = true;
                    break;
                }
            }
            if (hasFileInput) break;
            await new Promise(r => setTimeout(r, 500));
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
                const bodyText = document.body.innerText.toLowerCase();
                return bodyText.includes('something went wrong') || 
                       bodyText.includes('please try again') || 
                       bodyText.includes('schiefgelaufen') ||
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

        // Schließe blockierende Modale (Cookie-Banner & Copyright-Dialog) vor der Texteingabe
        try {
            const btnCoords = await page.evaluate(() => {
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

                const cookieKeywords = [
                    'alle erlauben', 'allow all', 'accept all', 'alle akzeptieren', 'akzeptieren', 'accept',
                    'cookies erlauben', 'cookies zulassen', 'optionale cookies ablehnen', 'decline optional cookies'
                ];
                const dialogKeywords = [
                    'schließen', 'close', 'got it', 'verstanden', 'ok', 'alles klar', 'einschalten', 'turn on'
                ];

                const coords = [];
                const buttons = findAllEls('button');
                for (const btn of buttons) {
                    const txt = (btn.textContent || '').trim().toLowerCase();
                    const isCookie = cookieKeywords.some(kw => txt === kw || txt.includes(kw));
                    const isDialog = dialogKeywords.some(kw => txt === kw || txt.includes(kw));
                    if (isCookie || isDialog) {
                        const rect = btn.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.left >= 0) {
                            coords.push({
                                x: rect.left + rect.width / 2,
                                y: rect.top + rect.height / 2,
                                text: btn.textContent.trim(),
                                type: isCookie ? 'cookie' : 'dialog'
                            });
                        }
                    }
                }
                // If multiple cookie buttons found, keep only the 'accept/allow' one to avoid contradictory clicks
                const cookieBtns = coords.filter(c => c.type === 'cookie');
                const dialogBtns = coords.filter(c => c.type === 'dialog');
                let bestCookie = null;
                if (cookieBtns.length > 1) {
                    bestCookie = cookieBtns.find(c => {
                        const t = c.text.toLowerCase();
                        return t.includes('erlauben') || t.includes('allow') || t.includes('accept') || t.includes('akzeptieren');
                    }) || cookieBtns[0];
                } else if (cookieBtns.length === 1) {
                    bestCookie = cookieBtns[0];
                }
                return bestCookie ? [...dialogBtns, bestCookie] : dialogBtns;
            });

            for (const coord of btnCoords) {
                console.log(`[TikTok Uploader] Klicke auf Button "${coord.text}" (${coord.type}) via Mouse-Click bei (${coord.x}, ${coord.y})`);
                await page.mouse.click(coord.x, coord.y);
                await new Promise(r => setTimeout(r, 1000));
            }
        } catch (dialogErr) {
            console.warn("[TikTok Uploader] Fehler beim Schließen der Banner vor der Texteingabe:", dialogErr.message);
        }

        statusCallback('typing', 'Trage Beschreibung und Hashtags ein...');
        let typedSuccessfully = false;
        for (let typeAttempt = 0; typeAttempt < 5; typeAttempt++) {
            try {
                let cleanCaption = (caption || '').trim();
                if (cleanCaption === 'undefined') {
                    cleanCaption = '';
                }
                const fullCaption = `${cleanCaption} ${hashtags.map(tag => tag.startsWith('#') ? tag : '#' + tag).join(' ')}`.trim();

                // Focus, clear, and paste into description field
                const pasteWorked = await page.evaluate((selector, text) => {
                    const el = document.querySelector(selector);
                    if (!el) return false;
                    
                    el.focus();
                    // Clear existing text
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
                    
                    // Paste text using ClipboardEvent
                    try {
                        const dataTransfer = new DataTransfer();
                        dataTransfer.setData('text/plain', text);
                        const pasteEvent = new ClipboardEvent('paste', {
                            clipboardData: dataTransfer,
                            bubbles: true,
                            cancelable: true
                        });
                        el.dispatchEvent(pasteEvent);
                        return true;
                    } catch (e) {
                        return false;
                    }
                }, descriptionSelector, fullCaption);

                if (pasteWorked) {
                    console.log(`[TikTok Uploader] Beschreibung via Clipboard-Paste eingetragen.`);
                    await new Promise(r => setTimeout(r, 1500));
                    typedSuccessfully = true;
                } else {
                    console.log(`[TikTok Uploader] Clipboard-Paste fehlgeschlagen, nutze Keyboard-Fallback...`);
                    // Re-query and click before typing to establish focus firmly
                    await page.click(descriptionSelector);
                    await page.keyboard.type(fullCaption, { delay: 50 });
                    typedSuccessfully = true;
                }
                break;
            } catch (evalErr) {
                console.warn(`[TikTok Uploader] Fehler beim Eintragen der Beschreibung (Attempt ${typeAttempt + 1}):`, evalErr.message);
                await new Promise(r => setTimeout(r, 2000));
            }
        }
        
        if (!typedSuccessfully) {
            throw new Error('Konnte die Beschreibung aufgrund von wiederholten detached Frame-Fehlern nicht eintragen.');
        }

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

            // Scroll nach unten, damit der Post-Button sichtbar wird
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await new Promise(r => setTimeout(r, 1000));
            
            // Hilfsfunktion: Finde den echten Post/Upload-Button via CSS-Klasse oder data-e2e (zuverlässiger als Text)
            const findPostBtnState = async () => {
                return page.evaluate(() => {
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
            };

            // Warte bis zu 300 Sekunden (5 Minuten), dass der Button fully enabled wird (z.B. Copyright Check abwarten)
            for (let i = 0; i < 300; i++) {
                // Schließe blockierende Modale (Cookie-Banner & Copyright-Dialog)
                try {
                    const btnCoords = await page.evaluate(() => {
                        window.onbeforeunload = null;
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

                        const cookieKeywords = [
                            'alle erlauben', 'allow all', 'accept all', 'alle akzeptieren', 'akzeptieren', 'accept',
                            'cookies erlauben', 'cookies zulassen', 'optionale cookies ablehnen', 'decline optional cookies'
                        ];
                        const dialogKeywords = [
                            'schließen', 'close', 'got it', 'verstanden', 'ok', 'alles klar', 'einschalten', 'turn on'
                        ];

                        const coords = [];
                        const buttons = findAllEls('button');
                        for (const btn of buttons) {
                            const txt = (btn.textContent || '').trim().toLowerCase();
                            const isCookie = cookieKeywords.some(kw => txt === kw || txt.includes(kw));
                            const isDialog = dialogKeywords.some(kw => txt === kw || txt.includes(kw));
                            if (isCookie || isDialog) {
                                const rect = btn.getBoundingClientRect();
                                if (rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.left >= 0) {
                                    coords.push({
                                        x: rect.left + rect.width / 2,
                                        y: rect.top + rect.height / 2,
                                        text: btn.textContent.trim(),
                                        type: isCookie ? 'cookie' : 'dialog'
                                    });
                                }
                            }
                        }
                        // If multiple cookie buttons found, keep only the 'accept/allow' one to avoid contradictory clicks
                        const cookieBtns = coords.filter(c => c.type === 'cookie');
                        const dialogBtns = coords.filter(c => c.type === 'dialog');
                        let bestCookie = null;
                        if (cookieBtns.length > 1) {
                            bestCookie = cookieBtns.find(c => {
                                const t = c.text.toLowerCase();
                                return t.includes('erlauben') || t.includes('allow') || t.includes('accept') || t.includes('akzeptieren');
                            }) || cookieBtns[0];
                        } else if (cookieBtns.length === 1) {
                            bestCookie = cookieBtns[0];
                        }
                        return bestCookie ? [...dialogBtns, bestCookie] : dialogBtns;
                    });

                    for (const coord of btnCoords) {
                        console.log(`[TikTok Uploader Loop] Klicke auf Button "${coord.text}" (${coord.type}) via Mouse-Click bei (${coord.x}, ${coord.y})`);
                        await page.mouse.click(coord.x, coord.y);
                        await new Promise(r => setTimeout(r, 1000));
                    }
                } catch (dialogErr) {
                    console.warn("[TikTok Uploader Loop] Fehler beim Schließen der Banner:", dialogErr.message);
                }

                // Check for crash screen during post wait loop
                const postCrashDetected = await page.evaluate(() => {
                    const bodyText = document.body.innerText.toLowerCase();
                    return bodyText.includes('something went wrong') || 
                           bodyText.includes('please try again') || 
                           bodyText.includes('schiefgelaufen') ||
                           bodyText.includes('versuche es später erneut') || 
                           bodyText.includes('versuch es später erneut');
                });
                if (postCrashDetected) {
                    throw new Error('TikTok-Fehler beim Veröffentlichen: "Something went wrong" (System-Crash-Bildschirm).');
                }

                const btnState = await findPostBtnState();
                
                if (btnState.exists && !btnState.disabled && btnState.ariaDisabled !== 'true') {
                    isPostBtnEnabled = true;
                    console.log(`[TikTok Upload] Post-Button ist aktiv nach ${i}s: "${btnState.text}"`);
                    break;
                }
                
                if (i % 10 === 0) {
                    const state = btnState.exists ? `(disabled=${btnState.disabled}, aria=${btnState.ariaDisabled})` : '(nicht gefunden)';
                    statusCallback('posting', `Warte auf Verarbeitung... (${i}s / 300s) ${state}`);
                    console.log(`[TikTok Upload] Button-Status bei ${i}s: ${JSON.stringify(btnState)}`);
                }
                await new Promise(r => setTimeout(r, 1000));
            }

            // Debug-Screenshot speichern
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
            
            // Klicke auf "Veröffentlichen"
            statusCallback('posting', 'Klicke auf "Veröffentlichen"...');
            
            let clicked = false;
            try {
                const postBtn = await page.$('button[data-e2e="post_video_button"]');
                if (postBtn) {
                    await postBtn.focus();
                    await postBtn.click();
                    clicked = true;
                    console.log('[TikTok Upload] Native click on data-e2e post button.');
                } else {
                    const btns = await page.$$('button.Button__root--type-primary, button[class*="Button__root--type-primary"], button');
                    for (const btn of btns) {
                        const txt = await page.evaluate(el => el.textContent.toLowerCase().trim(), btn);
                        const isSidebarOrHeader = await page.evaluate(el => {
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
                        }, btn);
                        if (isSidebarOrHeader) continue;
                        if (txt === 'post' || txt === 'posten' || txt === 'veröffentlichen' || txt === 'publish' || txt === 'hochladen' || txt === 'teilen') {
                            await btn.focus();
                            await btn.click();
                            clicked = true;
                            console.log(`[TikTok Upload] Native click on matching button text: "${txt}"`);
                            break;
                        }
                    }
                }
            } catch (e) {
                console.warn('[TikTok Upload] Native click failed, falling back to evaluate click:', e.message);
            }

            if (!clicked) {
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
            }

            statusCallback('posting', 'Warte auf Veröffentlichungsbestätigung...');
            
            let isVerifiedSuccess = false;
            let uploadErrorMsg = null;
            
            // Polling loop: Check status every 2 seconds for up to 60 seconds
            for (let check = 0; check < 30; check++) {
                await new Promise(r => setTimeout(r, 2000));
                
                // Check for and click "Jetzt veröffentlichen" confirmation dialog
                try {
                    const confirmCoords = await page.evaluate(() => {
                        const buttons = Array.from(document.querySelectorAll('button'));
                        const confirmBtn = buttons.find(b => {
                            const txt = (b.textContent || '').trim().toLowerCase();
                            return txt === 'jetzt veröffentlichen' || txt === 'publish now' || txt === 'post now';
                        });
                        if (confirmBtn) {
                            const rect = confirmBtn.getBoundingClientRect();
                            if (rect.width > 0 && rect.height > 0) {
                                return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: confirmBtn.textContent.trim() };
                            }
                        }
                        return null;
                    });
                    if (confirmCoords) {
                        console.log(`[TikTok Upload] Bestätigungs-Dialog erkannt, klicke "${confirmCoords.text}" via Mouse-Click bei (${confirmCoords.x}, ${confirmCoords.y})`);
                        await page.mouse.click(confirmCoords.x, confirmCoords.y);
                        await new Promise(r => setTimeout(r, 2000));
                    }
                } catch (confirmErr) {
                    // ignore
                }
                
                const pageState = await page.evaluate(() => {
                    const href = window.location.href;
                    const bodyText = document.body.innerText.toLowerCase();
                    
                    // 1. Success redirects
                    if (href.includes('/posts') || href.includes('/content') || href.includes('/manage')) {
                        return { success: true };
                    }
                    
                    // 2. Success dialogs / buttons
                    const successKeywords = ['manage posts', 'beiträge verwalten', 'weiteres video', 'upload another', 'veröffentlicht', 'published', 'dein video wurde'];
                    const hasSuccessElement = successKeywords.some(t => bodyText.includes(t));
                    if (hasSuccessElement) {
                        return { success: true };
                    }
                    
                    // 3. Errors / limits / expired sessions
                    if (href.includes('/login') || href.includes('/signup')) {
                        return { error: 'TikTok Session abgelaufen oder Login erforderlich (Redirected to login).' };
                    }
                    
                    if (bodyText.includes('something went wrong') || bodyText.includes('versuche es später erneut') || bodyText.includes('versuch es später erneut')) {
                        return { error: 'TikTok-Fehler: Something went wrong.' };
                    }
                    
                    if (bodyText.includes('reached your check limit') || bodyText.includes('limit für heute erreicht') || bodyText.includes('prüflimit für heute erreicht')) {
                        return { error: 'TikTok-Fehler: Tägliches Prüflimit erreicht.' };
                    }
                    
                    return null;
                });
                
                if (pageState) {
                    if (pageState.success) {
                        isVerifiedSuccess = true;
                        break;
                    }
                    if (pageState.error) {
                        uploadErrorMsg = pageState.error;
                        break;
                    }
                }
            }
            
            // Finale Screenshot für Verifizierung
            try {
                await page.screenshot({ path: path.join(publicClipsDir, `tiktok_debug_${accountName}_3_after_click.png`) });
            } catch (e) {
                console.warn("[TikTok Upload] Screenshot failed:", e.message);
            }
            
            // Final fallback check: if no explicit success/error found, check if the post button is still there
            if (!isVerifiedSuccess && !uploadErrorMsg) {
                const stillHasButton = await page.evaluate(() => {
                    if (!window.location.href.includes('/upload')) {
                        return false;
                    }
                    let btn = document.querySelector('button[data-e2e="post_video_button"]');
                    if (btn) return true;
                    
                    const primaryButtons = document.querySelectorAll('button.Button__root--type-primary, button[class*="Button__root--type-primary"]');
                    for (const b of primaryButtons) {
                        const txt = b.textContent.toLowerCase().trim();
                        if (b.closest('header') || b.closest('aside') || b.closest('nav') || b.closest('[class*="header"]') || b.closest('[class*="sidebar"]') || b.closest('[data-tt*="Sidebar"]') || b.closest('[data-tt*="Header"]') || b.closest('[class*="css-77vl8h"]') || b.closest('[class*="ewmbf5a2"]')) continue;
                        if (txt === 'post' || txt === 'posten' || txt === 'veröffentlichen' || txt === 'publish' || txt === 'teilen') {
                            return true;
                        }
                    }
                    return false;
                });
                
                if (!stillHasButton) {
                    const isStillOnUploadUrl = await page.evaluate(() => window.location.href.includes('/upload'));
                    if (isStillOnUploadUrl) {
                        // Save HTML dump for debugging false successes
                        try {
                            const html = await page.content();
                            fs.writeFileSync(path.join(publicClipsDir, `tiktok_debug_${accountName}_dom_dump.html`), html);
                        } catch (e) {}
                        uploadErrorMsg = 'Post-Button verschwunden, aber Seite befindet sich immer noch im Upload-Formular ohne Erfolgsbestätigung.';
                    } else {
                        isVerifiedSuccess = true;
                    }
                } else {
                    // HTML-Dump for debugging
                    try {
                        const html = await page.content();
                        fs.writeFileSync(path.join(publicClipsDir, `tiktok_debug_${accountName}_dom_dump.html`), html);
                    } catch (e) {}
                    
                    uploadErrorMsg = 'Post-Button ist nach dem Klicken immer noch vorhanden. Posten war vermutlich nicht erfolgreich.';
                }
            }
            
            if (uploadErrorMsg) {
                throw new Error(uploadErrorMsg);
            }
            
            if (!isVerifiedSuccess) {
                throw new Error('Veröffentlichung konnte nicht verifiziert werden.');
            }
            
            statusCallback('done', 'Video wurde erfolgreich auf TikTok veröffentlicht!');
        } else {
            statusCallback('done', 'Video wurde erfolgreich als Entwurf vorbereitet!');
        }

    } catch (err) {
        console.error(`[TikTok Uploader] Upload fehlgeschlagen:`, err.message);
        if (page) {
            try {
                const debugPath = path.join(publicClipsDir, `tiktok_debug_${accountName}_error.png`);
                await page.screenshot({ path: debugPath });
                console.log(`[TikTok Uploader] Fehler-Screenshot gespeichert unter: ${debugPath}`);
                
                const html = await page.content();
                fs.writeFileSync(path.join(publicClipsDir, `tiktok_debug_${accountName}_error_dom_dump.html`), html);
                console.log(`[TikTok Uploader] Fehler-DOM-Dump gespeichert.`);
            } catch (screenshotErr) {
                console.warn(`[TikTok Uploader] Screenshot/DOM-Dump bei Fehler fehlgeschlagen:`, screenshotErr.message);
            }
        }
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

// Hilfsfunktion, um Text-Overlay auf ein bereits im Hochformat gerendertes Video zu stempeln
async function drawTextOnRenderedVideo(inputFilename, textOverlay, start, end, audioHighPitch, outputJobId, clipperManager) {
    const fs = require('fs');
    const path = require('path');
    const { exec } = require('child_process');
    
    const inputPath = path.join(clipperManager.clipsDir, inputFilename);
    const outputFilename = `render_${outputJobId}.mp4`;
    const outputPath = path.join(clipperManager.clipsDir, outputFilename);
    
    const formatCleanText = (text) => {
        const paragraphs = text.split('\n');
        const lines = [];
        for (const para of paragraphs) {
            const words = para.split(/\s+/).filter(w => w.length > 0);
            if (words.length > 0) {
                lines.push(words.join(' '));
            }
        }
        return lines.join('\n');
    };

    const getCalculatedFontSize = (text) => {
        const paragraphs = text.split('\n');
        let maxLength = 0;
        for (const para of paragraphs) {
            const words = para.split(/\s+/).filter(w => w.length > 0);
            const lineLength = words.join(' ').length;
            if (lineLength > maxLength) {
                maxLength = lineLength;
            }
        }
        return Math.min(80, Math.floor(1400 / Math.max(1, maxLength)));
    };

    const cleanText = (textOverlay.text || '')
        .toUpperCase()
        .replace(/[^\w\s\d.,!?'"-\/öäüßÄÖÜ]/gi, '')
        .trim();

    const escapedClean = cleanText
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "'\\''")
        .replace(/:/g, '\\:')
        .replace(/,/g, '\\,');

    const escapedText = formatCleanText(escapedClean);
    const calculatedFontSize = getCalculatedFontSize(cleanText);
        
    const tStartVal = parseFloat(start) || 0;
    const tEndVal = parseFloat(end) || 0;
    const duration = tEndVal - tStartVal;
    
    const rawStart = parseFloat(textOverlay.start) || 0;
    const tStart = Math.max(0, rawStart - tStartVal);
    const tEnd = tStart + (parseFloat(textOverlay.duration) || 5);
    
    const yPct = textOverlay.y !== undefined ? parseFloat(textOverlay.y) : 75;
    const yPos = Math.round((yPct * 1920) / 100);
    
    // Choose font
    let fontPath = path.resolve(__dirname, '../public/ariblk.ttf');
    if (!fs.existsSync(fontPath)) {
        fontPath = path.resolve(__dirname, '../bingo/public/ariblk.ttf');
    }
    if (!fs.existsSync(fontPath)) {
        fontPath = '/var/www/bingo/public/ariblk.ttf';
    }
    
    let fontArg = "";
    if (fs.existsSync(fontPath)) {
        fontArg = `fontfile='${fontPath.replace(/\\/g, '/').replace(/:/g, '\\:')}'`;
    } else {
        fontArg = "fontfile='C\\:/Windows/Fonts/ariblk.ttf'";
        if (!fs.existsSync("C:/Windows/Fonts/ariblk.ttf")) {
            fontArg = "fontfile='C\\:/Windows/Fonts/arial.ttf'";
        }
    }
    
    // Drawtext command
    const filter = `drawtext=text='${escapedText}':x=(w-text_w)/2:y=${yPos}-text_h/2:${fontArg}:fontsize=${calculatedFontSize}:fontcolor=white:borderw=12:bordercolor=black:enable='between(t,${tStart},${tEnd})'`;
    
    const ffmpegArgs = [
        '-y',
        '-ss', tStartVal.toString(),
        '-t', duration.toString(),
        '-i', inputPath,
        '-vf', filter,
        '-c:v', 'libx264',
        '-preset', 'superfast',
        '-crf', '18'
    ];
    if (audioHighPitch) {
        ffmpegArgs.push('-af', 'rubberband=pitch=1.20', '-c:a', 'aac');
    } else {
        ffmpegArgs.push('-c:a', 'copy');
    }
    ffmpegArgs.push(outputPath);
    
    console.log(`[Clipper] Spawning ffmpeg for drawtext and trim: ffmpeg ${ffmpegArgs.join(' ')}`);
    
    const { spawn } = require('child_process');
    return new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', ffmpegArgs);
        let stderr = "";
        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        proc.on('close', (code) => {
            if (code !== 0) {
                console.error("[Clipper] FFmpeg failed with code", code, stderr);
                return reject(new Error(`FFmpeg failed with code ${code}: ${stderr}`));
            }
            resolve({ filename: outputFilename });
        });
    });
}

async function trimRenderedVideo(inputFilename, start, end, audioHighPitch, outputJobId, clipperManager) {
    const path = require('path');
    const inputPath = path.join(clipperManager.clipsDir, inputFilename);
    const outputFilename = `render_${outputJobId}.mp4`;
    const outputPath = path.join(clipperManager.clipsDir, outputFilename);
    
    const tStartVal = parseFloat(start) || 0;
    const tEndVal = parseFloat(end) || 0;
    const duration = tEndVal - tStartVal;
    
    const ffmpegArgs = [
        '-y',
        '-ss', tStartVal.toString(),
        '-t', duration.toString(),
        '-i', inputPath,
        '-c:v', 'libx264',
        '-preset', 'superfast',
        '-crf', '18'
    ];
    if (audioHighPitch) {
        ffmpegArgs.push('-af', 'rubberband=pitch=1.20', '-c:a', 'aac');
    } else {
        ffmpegArgs.push('-c:a', 'copy');
    }
    ffmpegArgs.push(outputPath);
    
    console.log(`[Clipper] Spawning ffmpeg for trim: ffmpeg ${ffmpegArgs.join(' ')}`);
    
    const { spawn } = require('child_process');
    return new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', ffmpegArgs);
        let stderr = "";
        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        proc.on('close', (code) => {
            if (code !== 0) {
                console.error("[Clipper] FFmpeg trim failed with code", code, stderr);
                return reject(new Error(`FFmpeg trim failed with code ${code}: ${stderr}`));
            }
            resolve({ filename: outputFilename });
        });
    });
}

// Hilfsfunktion zur Rotation von Titeln und Hashtags (bis zu 5 Zeilen jeweils)
async function getNextCaptionAndHashtags(channelName, platform) {
    const cleanName = channelName.toLowerCase().trim();
    const chanRef = db.ref(`clipper/channels/${cleanName}`);
    const snap = await chanRef.once('value');
    const config = snap.val() || {};
    
    let captionText = "";
    let hashtagsText = "";
    
    if (platform === 'tiktok') {
        const captions = (config.tiktokCaption || '').split('\n').map(l => l.trim()).filter(Boolean);
        const hashtags = (config.tiktokHashtags || '').split('\n').map(l => l.trim()).filter(Boolean);
        
        let capIdx = parseInt(config.lastTiktokCaptionIndex !== undefined ? config.lastTiktokCaptionIndex : -1) + 1;
        let hashIdx = parseInt(config.lastTiktokHashtagsIndex !== undefined ? config.lastTiktokHashtagsIndex : -1) + 1;
        
        if (captions.length > 0) {
            capIdx = capIdx % captions.length;
            captionText = captions[capIdx];
        }
        if (hashtags.length > 0) {
            hashIdx = hashIdx % hashtags.length;
            hashtagsText = hashtags[hashIdx];
        } else {
            hashtagsText = "#fyp #viral #twitch";
        }
        
        await chanRef.update({
            lastTiktokCaptionIndex: capIdx,
            lastTiktokHashtagsIndex: hashIdx
        });
    } else if (platform === 'youtube') {
        const captions = (config.youtubeCaption || '').split('\n').map(l => l.trim()).filter(Boolean);
        const hashtags = (config.youtubeHashtags || '').split('\n').map(l => l.trim()).filter(Boolean);
        
        let capIdx = parseInt(config.lastYoutubeCaptionIndex !== undefined ? config.lastYoutubeCaptionIndex : -1) + 1;
        let hashIdx = parseInt(config.lastYoutubeHashtagsIndex !== undefined ? config.lastYoutubeHashtagsIndex : -1) + 1;
        
        if (captions.length > 0) {
            capIdx = capIdx % captions.length;
            captionText = captions[capIdx];
        }
        if (hashtags.length > 0) {
            hashIdx = hashIdx % hashtags.length;
            hashtagsText = hashtags[hashIdx];
        } else {
            hashtagsText = "#shorts #viral";
        }
        
        await chanRef.update({
            lastYoutubeCaptionIndex: capIdx,
            lastYoutubeHashtagsIndex: hashIdx
        });
    }
    
    return { caption: captionText, hashtags: hashtagsText };
}

// Helper to queue upload to TikTok in Firebase
async function queueTikTokUpload(clipData, streamerName, captionText, customTiktokAccount = null, layout = null, isManual = false) {
    try {
        const cleanStreamerName = (streamerName || 'Streamer').toLowerCase().trim();
        const chanSnap = await db.ref(`clipper/channels/${cleanStreamerName}`).once('value');
        const channelConfig = chanSnap.val() || {};
        
        const uploadJobId = db.ref('clipper/tiktok_queue').push().key;
        const clipUrl = `https://minusnd.de/public/clips/${clipData.filename}`;
        
        let initialStatus = 'pending';
        let progressMessage = isManual ? 'Manuell beauftragt. Bereit zum Upload.' : 'Wartend...';
        
        const isFacecam = layout && layout !== 'blur-bg' && layout !== 'blur-bg-logo';
        if (isFacecam && !isManual) {
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
        
        const nextVals = await getNextCaptionAndHashtags(cleanStreamerName, 'tiktok');
        const hasManualHashtags = captionText && captionText.includes('#');
        
        await db.ref(`clipper/tiktok_queue/${uploadJobId}`).set({
            id: uploadJobId,
            url: clipUrl,
            caption: (captionText !== undefined && captionText !== null && captionText !== '') ? captionText : nextVals.caption,
            hashtags: hasManualHashtags ? "" : nextVals.hashtags,
            tiktokAccount: customTiktokAccount || channelConfig.tiktokAccount || "default",
            status: initialStatus,
            progressMessage: progressMessage,
            timestamp: Date.now(),
            streamerName: cleanStreamerName,
            clipId: clipData.id || ''
        });
        console.log(`[TikTok Queue] Queued upload job ${uploadJobId} for ${cleanStreamerName} on account ${customTiktokAccount || channelConfig.tiktokAccount || "default"} with status ${initialStatus} (manual: ${!!isManual})`);
    } catch (err) {
        console.error("[TikTok Queue] Error queueing upload:", err.message);
    }
}

// Helper to queue upload to YouTube in Firebase
async function queueYoutubeUpload(clipData, streamerName, captionText, customYoutubeAccount = null, layout = null, isManual = false) {
    try {
        const cleanStreamerName = (streamerName || 'Streamer').toLowerCase().trim();
        const chanSnap = await db.ref(`clipper/channels/${cleanStreamerName}`).once('value');
        const channelConfig = chanSnap.val() || {};
        
        const uploadJobId = db.ref('clipper/youtube_queue').push().key;
        const clipUrl = `https://minusnd.de/public/clips/${clipData.filename}`;
        
        let initialStatus = 'pending';
        let progressMessage = isManual ? 'Manuell beauftragt. Bereit zum Upload.' : 'Wartend...';
        
        const isFacecam = layout && layout !== 'blur-bg' && layout !== 'blur-bg-logo';
        if (isFacecam && !isManual) {
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
        
        const nextVals = await getNextCaptionAndHashtags(cleanStreamerName, 'youtube');
        const hasManualHashtags = captionText && captionText.includes('#');
        
        await db.ref(`clipper/youtube_queue/${uploadJobId}`).set({
            id: uploadJobId,
            url: clipUrl,
            caption: (captionText !== undefined && captionText !== null && captionText !== '') ? captionText : nextVals.caption,
            hashtags: hasManualHashtags ? "" : nextVals.hashtags,
            youtubeAccount: customYoutubeAccount || channelConfig.youtubeAccount || "default",
            status: initialStatus,
            progressMessage: progressMessage,
            timestamp: Date.now(),
            streamerName: cleanStreamerName,
            clipId: clipData.id || ''
        });
        console.log(`[YouTube Queue] Queued upload job ${uploadJobId} for ${cleanStreamerName} on account ${customYoutubeAccount || channelConfig.youtubeAccount || "default"} with status ${initialStatus} (manual: ${!!isManual})`);
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
                
                await db.ref('clipper/pipeline_status').update({
                    stage: 'scanning',
                    stepNumber: 1,
                    channelName: channelName,
                    statusText: `Scannt Twitch nach Clips von @${channelName}...`,
                    updatedAt: Date.now()
                }).catch(() => {});
                
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
                
                // Creator-Filter: Strikte Vorgabe: Nur Clips nehmen, die von MinusND erstellt wurden!
                // Niemals Clips von fremden Erstellern nehmen, auch wenn "Minus" im Titel steht.
                const creatorFilter = (channel.creatorFilter ? channel.creatorFilter : 'MinusND').trim().toLowerCase();
                const onlyCreator = channel.onlyCreatorClips !== false; // Standard: IMMER aktiv

                let eligibleClips = clipsData.data.filter(c => {
                    const creator = (c.creator_name || '').trim().toLowerCase();
                    if (onlyCreator) {
                        return creator === creatorFilter;
                    }
                    return true;
                });
                console.log(`[Agent] ${channelName}: Ersteller-Filter "@${creatorFilter}" (aktiv: ${onlyCreator}) -> ${eligibleClips.length} von ${clipsData.data.length} Clips matchen.`);
                if (eligibleClips.length === 0) continue;

                // Process chronologically (oldest first)
                const clipsSorted = eligibleClips.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
                
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
                await db.ref('clipper/pipeline_status').update({
                    stage: 'downloading',
                    stepNumber: 2,
                    channelName: channelName,
                    clipTitle: twitchClip.title,
                    clipId: twitchClip.id,
                    statusText: `Lade Twitch-Clip herunter: "${twitchClip.title}"`,
                    updatedAt: Date.now()
                }).catch(() => {});
                
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
                let shouldDeleteTempFile = true;
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
                    
                    // Automatische Titel-Funktion: Clip-Titel übernehmen & als Overlay anwenden
                    const clipTitle = (twitchClip.title || '').trim();
                    let autoTitleOverlay = null;
                    if (clipTitle && channel.autoTitleOverlay !== false) {
                        autoTitleOverlay = {
                            text: clipTitle,
                            start: 0,
                            duration: Math.round(twitchClip.duration) || 60,
                            isAutoTitle: true
                        };
                    }

                    // Check if Auto-Render Box is active
                    if (channel.autoRender === false || channel.autoRenderTikTok === false) {
                        console.log(`[Agent] ${channelName}: Auto-Render Box ist AUS. Überspringe automatischen Schnitt für "${twitchClip.title}".`);
                        await db.ref(`clipper/processed_clips/${twitchClip.id}`).set({
                            id: twitchClip.id,
                            title: twitchClip.title,
                            channelName: channelName,
                            createdAt: twitchClip.created_at,
                            processedAt: Date.now(),
                            status: 'render_skipped',
                            viewCount: twitchClip.view_count || 0
                        });
                        await db.ref('clipper/pipeline_status').update({
                            stage: 'idle',
                            stepNumber: 0,
                            statusText: `Schnitt übersprungen (Render-Box deaktiviert)`,
                            updatedAt: Date.now()
                        }).catch(() => {});
                        break;
                    }

                    await db.ref('clipper/pipeline_status').update({
                        stage: 'rendering',
                        stepNumber: 3,
                        channelName: channelName,
                        clipTitle: twitchClip.title,
                        clipId: twitchClip.id,
                        progress: 0,
                        statusText: `Schneidet 9:16 Portrait-Video (${detectedLayout}) mit Auto-Titel...`,
                        updatedAt: Date.now()
                    }).catch(() => {});

                    const isLogoEnabled = channel.autoLogoOverlay === true;
                    const logoConfig = { enabled: isLogoEnabled };
                    const isAutoTitle = channel.autoTitleOverlay !== false;

                    let cleanClipData;
                    let clipData;

                    if (channel.isSemiAuto === true) {
                        cleanClipData = await clipperManager.renderPortrait(
                            jobId,
                            targetFilename,
                            0,
                            Math.round(twitchClip.duration),
                            detectedCamCrop,
                            detectedGameCrop,
                            detectedLayout,
                            null,
                            channelName,
                            false,
                            null,
                            { enabled: false }
                        );
                        clipData = cleanClipData;
                    } else {
                        const textToApply = (isAutoTitle && autoTitleOverlay) ? autoTitleOverlay : null;
                        clipData = await clipperManager.renderPortrait(
                            jobId,
                            targetFilename,
                            0,
                            Math.round(twitchClip.duration),
                            detectedCamCrop,
                            detectedGameCrop,
                            detectedLayout,
                            textToApply,
                            channelName,
                            false,
                            null,
                            logoConfig
                        );
                        cleanClipData = clipData;
                    }
                    
                    if (channel.isSemiAuto === true) {
                        console.log(`[Agent] ${channelName}: Halbautomatischer Modus. Portrait-Render abgeschlossen. Setze Job auf 'pending_review' für Text-Eingabe.`);
                        await db.ref(`clipper/renders/${jobId}`).update({
                            status: 'pending_review',
                            filename: clipData.filename,
                            cleanFilename: cleanClipData.filename,
                            autoPublish: channel.autoPublish !== false && channel.autoPublishTikTok !== false,
                            autoPublishYoutube: !!channel.autoPublishYoutube,
                            tiktokAccount: channel.tiktokAccount || 'default',
                            youtubeAccount: channel.youtubeAccount || 'default',
                            clipId: twitchClip.id,
                            clipTitle: clipTitle
                        });
                        await db.ref(`clipper/processed_clips/${twitchClip.id}`).update({
                            status: 'pending_review',
                            renderJobId: jobId,
                            clipTitle: clipTitle
                        });
                        await db.ref('clipper/pipeline_status').update({
                            stage: 'review',
                            stepNumber: 4,
                            channelName: channelName,
                            clipTitle: clipTitle,
                            clipId: twitchClip.id,
                            statusText: `Wartet auf Freigabe im Review-Modus: "${clipTitle}"`,
                            updatedAt: Date.now()
                        }).catch(() => {});
                    } else {
                        // Prüfe, ob TikTok Upload-Box aktiv ist (vom User schaltbar)
                        const shouldUploadTikTok = channel.autoPublish !== false && channel.autoPublishTikTok !== false;
                        if (shouldUploadTikTok) {
                            console.log(`[Agent] ${channelName}: TikTok Auto-Upload ist AKTIV. Reihte Clip "${clipTitle}" in TikTok-Queue ein.`);
                            await db.ref('clipper/pipeline_status').update({
                                stage: 'uploading_tiktok',
                                stepNumber: 5,
                                channelName: channelName,
                                clipTitle: clipTitle,
                                clipId: twitchClip.id,
                                statusText: `Reiht in TikTok-Warteschlange ein: "${clipTitle}"`,
                                updatedAt: Date.now()
                            }).catch(() => {});
                            await queueTikTokUpload(clipData, channelName, clipTitle, null, detectedLayout);
                        } else {
                            console.log(`[Agent] ${channelName}: TikTok Upload-Box ist AUS. Clip "${clipTitle}" wurde geschnitten & gespeichert, aber TikTok-Upload übersprungen.`);
                        }

                        // Prüfe, ob YouTube Upload-Box aktiv ist (vom User schaltbar)
                        const shouldUploadYoutube = channel.autoPublishYoutube === true;
                        if (shouldUploadYoutube) {
                            console.log(`[Agent] ${channelName}: YouTube Auto-Upload ist AKTIV. Reihte Clip "${clipTitle}" in YouTube-Queue ein.`);
                            await db.ref('clipper/pipeline_status').update({
                                stage: 'uploading_youtube',
                                stepNumber: 6,
                                channelName: channelName,
                                clipTitle: clipTitle,
                                clipId: twitchClip.id,
                                statusText: `Reiht in YouTube-Shorts-Queue ein: "${clipTitle}"`,
                                updatedAt: Date.now()
                            }).catch(() => {});
                            await queueYoutubeUpload(clipData, channelName, clipTitle, null, detectedLayout);
                        } else {
                            console.log(`[Agent] ${channelName}: YouTube Upload-Box ist AUS. Clip "${clipTitle}" wurde geschnitten & gespeichert, aber YouTube-Upload übersprungen.`);
                        }
                        
                        await db.ref(`clipper/processed_clips/${twitchClip.id}`).update({
                            status: 'done',
                            renderJobId: jobId,
                            clipTitle: clipTitle,
                            clipUrl: `https://minusnd.de/public/clips/${clipData.filename}`,
                            uploadedTikTok: shouldUploadTikTok,
                            uploadedYoutube: shouldUploadYoutube
                        });

                        await db.ref('clipper/pipeline_status').update({
                            stage: 'done',
                            stepNumber: 7,
                            channelName: channelName,
                            clipTitle: clipTitle,
                            clipId: twitchClip.id,
                            statusText: `Clip erfolgreich fertiggestellt: "${clipTitle}" ${shouldUploadTikTok ? '(TikTok eingereiht)' : '(Ohne Upload gespeichert)'}`,
                            lastCompletedClip: {
                                title: clipTitle,
                                channelName: channelName,
                                filename: clipData.filename,
                                time: Date.now()
                            },
                            updatedAt: Date.now()
                        }).catch(() => {});
                    }
                    
                    console.log(`[Agent] Clip ${twitchClip.id} erfolgreich verarbeitet!`);
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
                    if (shouldDeleteTempFile && fs.existsSync(tempPath)) {
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

            const currentPipeSnap = await db.ref('clipper/pipeline_status').once('value');
            const curPipe = currentPipeSnap.val() || {};
            if (curPipe.stage === 'scanning' || !curPipe.stage) {
                await db.ref('clipper/pipeline_status').update({
                    stage: 'idle',
                    stepNumber: 0,
                    statusText: `Bereit • Überwacht ${activeChannels.length} Kanäle`,
                    updatedAt: Date.now()
                }).catch(() => {});
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


// --- LIVE MATCH AUTO TRACKING SERVICE ---
function startLiveMatchPoller(db) {
    const https = require('https');

    function fetchJson(url) {
        return new Promise((resolve, reject) => {
            https.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            }, (res) => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error(`HTTP status code ${res.statusCode}`));
                }
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(e);
                    }
                });
            }).on('error', reject);
        });
    }

    async function coupleMatchOnServer(streamId, matchId, league) {
        try {
            console.log(`[LiveMatch] Auto-coupling match ${matchId} for stream ${streamId}`);
            const data = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/all/summary?event=${matchId}`);
            
            let homeTeam = null;
            let awayTeam = null;
            let tournamentNameText = "FIFA WORLD CUP 2026™";
            
            if (data.header && data.header.competitions && data.header.competitions[0]) {
                const comp = data.header.competitions[0];
                const homeComp = comp.competitors.find(c => c.homeAway === 'home');
                const awayComp = comp.competitors.find(c => c.homeAway === 'away');
                if (homeComp && awayComp) {
                    homeTeam = {
                        name: homeComp.team.abbreviation || homeComp.team.displayName.substring(0, 3).toUpperCase(),
                        logo: homeComp.team.logos ? homeComp.team.logos[0].href : ""
                    };
                    awayTeam = {
                        name: awayComp.team.abbreviation || awayComp.team.displayName.substring(0, 3).toUpperCase(),
                        logo: awayComp.team.logos ? awayComp.team.logos[0].href : ""
                    };
                }
                if (data.header.league) {
                    tournamentNameText = data.header.league.name.toUpperCase();
                }
            }
            
            const ref = db.ref(`streams/${streamId}`);
            
            await ref.child('data/liveMatch/active').set(true);
            await ref.child('data/liveMatch/id').set(String(matchId));
            await ref.child('data/liveMatch/league').set(league);
            await ref.child('data/liveMatch/lastEventId').set("");
            await ref.child('data/liveMatch/pendingConflict').set(null);
            await ref.child('data/liveMatch/resolvedConflictIds').set(null);
            
            await ref.child('data/timer/addedTime').set(0);
            await ref.child('data/redCards').set({ home: 0, away: 0 });
            await ref.child('data/score').set({ home: 0, away: 0 });
            
            if (homeTeam && awayTeam) {
                await ref.child('data/teams/home').set(homeTeam);
                await ref.child('data/teams/away').set(awayTeam);
            }
            if (tournamentNameText) {
                await ref.child('data/tournamentName').set(tournamentNameText);
            }
            console.log(`[LiveMatch] Auto-coupled match ${matchId} successfully!`);
        } catch (e) {
            console.error(`[LiveMatch] Error in server auto-coupling match ${matchId}:`, e.message);
        }
    }

    async function handleAutoTrackWM(streamId, liveMatch, stream) {
        try {
            const data = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard`);
            if (!data || !data.events) return;
            
            const events = data.events;
            
            if (liveMatch.active === true && liveMatch.id) {
                const currentEvent = events.find(e => String(e.id) === String(liveMatch.id));
                if (currentEvent) {
                    const state = currentEvent.status?.type?.state;
                    if (state === 'post') {
                        console.log(`[LiveMatch] Gekoppeltes WM-Spiel ${liveMatch.id} ist beendet. Setze active=false.`);
                        await db.ref(`streams/${streamId}/data/liveMatch/active`).set(false);
                    } else {
                        return;
                    }
                } else {
                    try {
                        const summary = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/all/summary?event=${liveMatch.id}`);
                        if (summary && summary.header && summary.header.competitions && summary.header.competitions[0]) {
                            const state = summary.header.competitions[0].status?.type?.state;
                            if (state === 'post') {
                                console.log(`[LiveMatch] Gekoppeltes WM-Spiel ${liveMatch.id} beendet laut Details-API. Setze active=false.`);
                                await db.ref(`streams/${streamId}/data/liveMatch/active`).set(false);
                            } else {
                                return;
                            }
                        }
                    } catch (err) {
                        console.error(`[LiveMatch] Fehler beim Prüfen des gekoppelten Spieldetails:`, err.message);
                    }
                }
            }
            
            const liveEvents = events.filter(e => e.status?.type?.state === 'in');
            const upcomingEvents = events.filter(e => e.status?.type?.state === 'pre');
            
            if (liveEvents.length > 0) {
                if (liveEvents.length === 1) {
                    const matchId = String(liveEvents[0].id);
                    if (String(liveMatch.id) !== matchId) {
                        await coupleMatchOnServer(streamId, matchId, 'fifa.world');
                    }
                } else {
                    const currentLiveIds = liveEvents.map(e => String(e.id)).sort();
                    const resolvedIds = Array.isArray(liveMatch.resolvedConflictIds) 
                        ? liveMatch.resolvedConflictIds.map(String) 
                        : [];
                    
                    const isNewConflict = currentLiveIds.some(id => !resolvedIds.includes(id));
                    
                    if (!isNewConflict && liveMatch.active === true && currentLiveIds.includes(String(liveMatch.id))) {
                        return;
                    }
                    
                    console.log(`[LiveMatch] Konflikt: ${liveEvents.length} WM-Spiele laufen gleichzeitig.`);
                    const conflictList = liveEvents.map(e => {
                        const comp = e.competitions ? e.competitions[0] : null;
                        const home = comp?.competitors.find(c => c.homeAway === 'home')?.team?.displayName || 'Home';
                        const away = comp?.competitors.find(c => c.homeAway === 'away')?.team?.displayName || 'Away';
                        return { id: String(e.id), home, away, name: e.name || `${home} vs ${away}` };
                    });
                    
                    const existingConflictSnap = await db.ref(`streams/${streamId}/data/liveMatch/pendingConflict`).once('value');
                    const existingConflict = existingConflictSnap.val();
                    
                    if (JSON.stringify(existingConflict) !== JSON.stringify(conflictList)) {
                        await db.ref(`streams/${streamId}/data/liveMatch/pendingConflict`).set(conflictList);
                        await db.ref(`streams/${streamId}/data/liveMatch/active`).set(false);
                        await db.ref(`streams/${streamId}/data/liveMatch/resolvedConflictIds`).set(null);
                    }
                }
            } else {
                if (upcomingEvents.length > 0) {
                    upcomingEvents.sort((a, b) => new Date(a.date) - new Date(b.date));
                    const earliestDate = upcomingEvents[0].date;
                    const sameTimeUpcoming = upcomingEvents.filter(e => e.date === earliestDate);
                    
                    if (sameTimeUpcoming.length === 1) {
                        const matchId = String(sameTimeUpcoming[0].id);
                        if (String(liveMatch.id) !== matchId) {
                            await coupleMatchOnServer(streamId, matchId, 'fifa.world');
                        }
                    } else {
                        const currentUpcomingIds = sameTimeUpcoming.map(e => String(e.id)).sort();
                        const resolvedIds = Array.isArray(liveMatch.resolvedConflictIds) 
                            ? liveMatch.resolvedConflictIds.map(String) 
                            : [];
                        
                        const isNewConflict = currentUpcomingIds.some(id => !resolvedIds.includes(id));
                        
                        if (!isNewConflict && liveMatch.active === true && currentUpcomingIds.includes(String(liveMatch.id))) {
                            return;
                        }
                        
                        console.log(`[LiveMatch] Konflikt: ${sameTimeUpcoming.length} WM-Spiele starten gleichzeitig um ${earliestDate}.`);
                        const conflictList = sameTimeUpcoming.map(e => {
                            const comp = e.competitions ? e.competitions[0] : null;
                            const home = comp?.competitors.find(c => c.homeAway === 'home')?.team?.displayName || 'Home';
                            const away = comp?.competitors.find(c => c.homeAway === 'away')?.team?.displayName || 'Away';
                            return { id: String(e.id), home, away, name: e.name || `${home} vs ${away}` };
                        });
                        
                        const existingConflictSnap = await db.ref(`streams/${streamId}/data/liveMatch/pendingConflict`).once('value');
                        const existingConflict = existingConflictSnap.val();
                        
                        if (JSON.stringify(existingConflict) !== JSON.stringify(conflictList)) {
                            await db.ref(`streams/${streamId}/data/liveMatch/pendingConflict`).set(conflictList);
                            await db.ref(`streams/${streamId}/data/liveMatch/active`).set(false);
                            await db.ref(`streams/${streamId}/data/liveMatch/resolvedConflictIds`).set(null);
                        }
                    }
                } else {
                    await db.ref(`streams/${streamId}/data/liveMatch/pendingConflict`).set(null);
                    await db.ref(`streams/${streamId}/data/liveMatch/resolvedConflictIds`).set(null);
                }
            }
        } catch (err) {
            console.error(`[LiveMatch] Fehler in handleAutoTrackWM für Stream ${streamId}:`, err.message);
        }
    }

    async function pollLiveMatches() {
        try {
            const snap = await db.ref('streams').once('value');
            const streams = snap.val();
            if (!streams) return;

            for (const streamId of Object.keys(streams)) {
                const stream = streams[streamId];
                let liveMatch = (stream.data && stream.data.liveMatch) ? stream.data.liveMatch : null;
                if (!liveMatch) continue;

                if (liveMatch.autoTrackWM === true) {
                    await handleAutoTrackWM(streamId, liveMatch, stream);
                    
                    // Re-read liveMatch in case handleAutoTrackWM updated it
                    const updatedSnap = await db.ref(`streams/${streamId}/data/liveMatch`).once('value');
                    liveMatch = updatedSnap.val() || liveMatch;
                }

                if (liveMatch && liveMatch.active === true && liveMatch.id) {
                    await processStreamLiveMatch(streamId, liveMatch, stream);
                }
            }
        } catch (err) {
            console.error("[LiveMatch] Fehler im Poller-Intervall:", err.message);
        }
    }

    async function processStreamLiveMatch(streamId, liveMatch, stream) {
        try {
            const data = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/all/summary?event=${liveMatch.id}`);
            if (!data || !data.header || !data.header.competitions || !data.header.competitions[0]) return;

            const comp = data.header.competitions[0];
            const homeComp = comp.competitors.find(c => c.homeAway === 'home');
            const awayComp = comp.competitors.find(c => c.homeAway === 'away');

            if (!homeComp || !awayComp) return;

            const homeScore = parseInt(homeComp.score || 0, 10);
            const awayScore = parseInt(awayComp.score || 0, 10);

            // 1. Sync score if changed
            const currentScore = (stream.data && stream.data.score) || { home: 0, away: 0 };
            if (currentScore.home !== homeScore || currentScore.away !== awayScore) {
                console.log(`[LiveMatch] Stream ${streamId}: Score geändert auf ${homeScore}:${awayScore}`);
                await db.ref(`streams/${streamId}/data/score`).set({
                    home: homeScore,
                    away: awayScore
                });
            }

            // 1.5. Sync clock/timer if status is available
            if (comp.status) {
                const status = comp.status;
                const state = status.type ? status.type.state : 'pre';
                const detail = status.type ? status.type.detail : '';
                
                // Parse clock in seconds robustly (ESPN summary API often omits status.clock for active matches)
                let clockVal = 0;
                let isMinuteResolution = false;
                if (status.clock !== undefined) {
                    clockVal = status.clock;
                } else if (status.displayClock) {
                    const disp = status.displayClock.trim();
                    if (disp.includes(':')) {
                        const parts = disp.split(':');
                        const mins = parseInt(parts[0], 10) || 0;
                        const secs = parseInt(parts[1], 10) || 0;
                        clockVal = mins * 60 + secs;
                    } else {
                        // Check for stoppage time format like "45'+3'" or "90+2"
                        const stoppageMatch = disp.match(/^(\d+)(?:'|\s*)?\+(?:'|\s*)?(\d+)/);
                        if (stoppageMatch) {
                            const baseMins = parseInt(stoppageMatch[1], 10) || 0;
                            const addedMins = parseInt(stoppageMatch[2], 10) || 0;
                            // baseMins is completed (e.g. 45 or 90).
                            // addedMins is the 1-indexed running stoppage minute (e.g. 1st minute is 90:00-90:59).
                            // So we subtract 1 from addedMins to get the completed stoppage minutes.
                            const totalMins = baseMins + Math.max(0, addedMins - 1);
                            clockVal = totalMins * 60 + 10;
                            isMinuteResolution = true;
                        } else {
                            const match = disp.match(/^(\d+)/);
                            if (match) {
                                let mins = parseInt(match[1], 10) || 0;
                                // ESPN displayClock shows the current running minute (1-indexed).
                                // So "1'" means 0:00-0:59, "49'" means 48:00-48:59.
                                // We should subtract 1 minute to get the elapsed minutes (0-indexed base).
                                mins = Math.max(0, mins - 1);
                                clockVal = mins * 60 + 10;
                                isMinuteResolution = true;
                            }
                        }
                    }
                }

                // Convert detail to lowercase for reliable matching
                const dLower = detail ? detail.toLowerCase().trim() : '';
                
                // Identify break states
                const isExtraHalftime = dLower.includes('ht-et') || dLower.includes('ht-extra') || dLower.includes('halftime extra time') || dLower.includes('ht extra time') || dLower.includes('halftime et') || dLower.includes('hz. verl.');
                const isRegularHalftime = (dLower === 'ht' || dLower.includes('halftime') || dLower.includes('halbzeit')) && !isExtraHalftime;
                
                const isExtraFulltime = dLower.includes('ft-et') || dLower.includes('ft-extra') || dLower.includes('aet') || dLower.includes('after extra time') || dLower.includes('fulltime extra time') || dLower === "120'";
                const isRegularFulltime = (dLower === 'ft' || dLower.includes('fulltime') || dLower.includes('beendet') || dLower.includes('end of second half') || dLower.includes('end 2nd half') || dLower === "90'") && !isExtraFulltime;
                
                const isPenalties = dLower.includes('penalties') || dLower.includes('penalty') || dLower.includes('shootout') || dLower === 'pen' || dLower === 'ap';

                // Set exact clock values for break/paused periods
                if (isExtraHalftime) {
                    clockVal = 105 * 60;
                } else if (isRegularHalftime) {
                    clockVal = 45 * 60;
                } else if (isExtraFulltime || isPenalties) {
                    clockVal = 120 * 60;
                } else if (isRegularFulltime) {
                    clockVal = 90 * 60;
                } else if (state === 'post') {
                    // Match completely finished - check if it went to extra time
                    clockVal = (comp.status?.period > 2) ? 120 * 60 : 90 * 60;
                }
                
                let isRunning = false;
                let accumulatedTime = clockVal * 1000;
                
                if (state === 'in') {
                    // Check if we are in any break/paused interval
                    if (isRegularHalftime || isExtraHalftime || isRegularFulltime || isExtraFulltime || isPenalties) {
                        isRunning = false;
                    } else {
                        isRunning = true;
                    }
                } else if (state === 'post') {
                    isRunning = false;
                } else {
                    isRunning = false;
                    accumulatedTime = 0;
                }

                // Extract running added time minutes from displayClock (e.g., "90'+5'" or "45'+3'")
                let displayClockAddedTime = 0;
                if (status.displayClock) {
                    const addedTimeMatch = status.displayClock.match(/\+(\d+)/);
                    if (addedTimeMatch) {
                        displayClockAddedTime = parseInt(addedTimeMatch[1], 10);
                    }
                }

                // Extract announced added time from commentary if available
                let announcedAddedTime = 0;
                if (data.commentary && data.commentary.length > 0) {
                    const currentPeriod = comp.status?.period || 1;
                    // Search from end to start (latest first)
                    const reversedCommentary = [...data.commentary].reverse();
                    
                    for (const item of reversedCommentary) {
                        if (!item.text) continue;
                        
                        let itemMin = 0;
                        if (item.time && item.time.displayValue) {
                            const minMatch = item.time.displayValue.match(/^(\d+)/);
                            if (minMatch) {
                                itemMin = parseInt(minMatch[1], 10);
                            }
                        }
                        
                        // Check if the commentary minute corresponds to the end of the period
                        let isCorrectPeriod = false;
                        if (currentPeriod === 1 && itemMin >= 40 && itemMin <= 50) {
                            isCorrectPeriod = true;
                        } else if (currentPeriod === 2 && itemMin >= 85 && itemMin <= 100) {
                            isCorrectPeriod = true;
                        }
                        
                        if (isCorrectPeriod) {
                            const annMatch = item.text.match(/(?:announced|stoppage|added|injury)[^\d]{0,20}(\d+)\s+minutes?/i)
                                          || item.text.match(/(\d+)\s+minutes?\s+(?:of\s+)?(?:added|stoppage|injury)\s+time/i);
                            if (annMatch) {
                                announcedAddedTime = parseInt(annMatch[1], 10);
                                break;
                            }
                        }
                    }
                }

                // Combine: use announced time if available, otherwise fall back to display clock
                let addedTime = Math.max(announcedAddedTime, displayClockAddedTime);

                // If it is halftime or match finished, reset addedTime to 0
                if (isRegularHalftime || isExtraHalftime || isRegularFulltime || isExtraFulltime || isPenalties || state === 'post') {
                    addedTime = 0;
                }

                // Get the current timer state to avoid overwriting settings
                const currentTimer = (stream.data && stream.data.timer) || { isRunning: false, baseTime: getFirebaseNow(), accumulatedTime: 0, isVisible: true, addedTime: 0 };
                
                const targetTimer = {
                    ...currentTimer,
                    isRunning: isRunning,
                    accumulatedTime: accumulatedTime,
                    addedTime: addedTime,
                    detail: detail,
                    period: comp.status?.period || 1
                };
                
                if (isRunning) {
                    targetTimer.baseTime = getFirebaseNow();
                }
                
                // Check if the state changed significantly
                let shouldUpdate = false;
                if (currentTimer.isRunning !== isRunning) {
                    shouldUpdate = true;
                } else if (currentTimer.detail !== detail) {
                    shouldUpdate = true;
                } else if ((currentTimer.addedTime || 0) !== addedTime) {
                    shouldUpdate = true;
                } else if (isRunning) {
                    const currentLocalTime = currentTimer.accumulatedTime + (getFirebaseNow() - currentTimer.baseTime);
                    const mins = Math.floor(accumulatedTime / 60000);
                    
                    if (mins === 45 || mins === 90 || mins === 105 || mins === 120) {
                        // In stoppage time (at the end of a half/match), allow the clock to tick up.
                        // Force sync only if we lag behind the base time or exceed a maximum stoppage time (12 minutes).
                        const maxStoppageMins = Math.max(12, addedTime + 3);
                        const maxAllowedTime = accumulatedTime + maxStoppageMins * 60 * 1000;
                        if (currentLocalTime < accumulatedTime || currentLocalTime > maxAllowedTime) {
                            shouldUpdate = true;
                        }
                    } else if (isMinuteResolution) {
                        // ESPN minute resolution clock rules:
                        // accumulatedTime is the start of the scraped minute (e.g. 49:00)
                        // The actual match time is in [accumulatedTime, accumulatedTime + 60s)
                        
                        if ((mins === 45 || mins === 90) && addedTime > 0) {
                            // If we are in added time, allow the clock to tick up
                            // during the added time period. Force sync only if we drift
                            // by more than (addedTime + 3) minutes.
                            const maxAllowedTime = accumulatedTime + (addedTime + 3) * 60 * 1000;
                            if (currentLocalTime < accumulatedTime || currentLocalTime > maxAllowedTime) {
                                shouldUpdate = true;
                            }
                        } else {
                            if (currentLocalTime < accumulatedTime) {
                                // Client is lagging behind the new scraped minute, force update to catch up
                                shouldUpdate = true;
                            } else if (currentLocalTime >= accumulatedTime + 120000) {
                                // Client is too far ahead (> 2 minutes), force sync back
                                shouldUpdate = true;
                            }
                            // Otherwise (client is within the current minute or slightly ahead by < 2 mins),
                            // keep the client ticking smoothly without any update.
                        }
                    } else {
                        // Second-resolution clock sync rules:
                        const diff = Math.abs(currentLocalTime - accumulatedTime);
                        if (diff > 5000) {
                            shouldUpdate = true;
                        }
                    }
                } else {
                    if (Math.abs(currentTimer.accumulatedTime - accumulatedTime) > 1000) {
                        shouldUpdate = true;
                    }
                }
                
                if (shouldUpdate) {
                    console.log(`[LiveMatch] Stream ${streamId}: Synchronisiere Uhrzeit (isRunning: ${isRunning}, Zeit: ${Math.round(accumulatedTime / 1000)}s, addedTime: +${addedTime})`);
                    await db.ref(`streams/${streamId}/data/timer`).set(targetTimer);
                }
            }

            // 1.7. Sync total red cards
            let redCards = { home: 0, away: 0 };
            const teamsSnap = await db.ref(`streams/${streamId}/data/teams`).once('value');
            const teams = teamsSnap.val();
            if (teams && data.keyEvents && data.keyEvents.length > 0) {
                const homeName = (teams.home?.name || "").toLowerCase();
                const awayName = (teams.away?.name || "").toLowerCase();
                for (const event of data.keyEvents) {
                    if (event.type?.text === "Red Card") {
                        if (event.team) {
                            const eventTeamName = event.team.displayName.toLowerCase();
                            if (homeName && (eventTeamName.includes(homeName) || homeName.includes(eventTeamName))) {
                                redCards.home++;
                            } else if (awayName && (eventTeamName.includes(awayName) || awayName.includes(eventTeamName))) {
                                redCards.away++;
                            }
                        }
                    }
                }
            }
            const currentRedCardsSnap = await db.ref(`streams/${streamId}/data/redCards`).once('value');
            const currentRedCards = currentRedCardsSnap.val() || { home: 0, away: 0 };
            if (currentRedCards.home !== redCards.home || currentRedCards.away !== redCards.away) {
                console.log(`[LiveMatch] Stream ${streamId}: Rote Karten aktualisiert auf Home: ${redCards.home}, Away: ${redCards.away}`);
                await db.ref(`streams/${streamId}/data/redCards`).set(redCards);
            }

            // 2. Process new events
            if (data.keyEvents && data.keyEvents.length > 0) {
                // Sort events by ID or chronologically so we process in order
                const sortedEvents = [...data.keyEvents].sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));

                let lastProcessedEventId = liveMatch.lastEventId || "";
                let newEvents = [];

                if (!lastProcessedEventId) {
                    // First run after linking - set lastEventId to latest and do not trigger animation
                    const latest = sortedEvents[sortedEvents.length - 1];
                    console.log(`[LiveMatch] Stream ${streamId}: Initialisiere Event-Tracking mit Event-ID ${latest.id}`);
                    await db.ref(`streams/${streamId}/data/liveMatch/lastEventId`).set(String(latest.id));
                } else {
                    // Find all events that have an ID strictly greater than lastProcessedEventId
                    const lastIdNum = parseInt(lastProcessedEventId, 10);
                    newEvents = sortedEvents.filter(e => parseInt(e.id, 10) > lastIdNum);

                    if (newEvents.length > 0) {
                        console.log(`[LiveMatch] Stream ${streamId}: Gefunden ${newEvents.length} neue Events!`);
                        for (const event of newEvents) {
                            await triggerMatchEvent(streamId, event);
                            lastProcessedEventId = String(event.id);
                        }
                        await db.ref(`streams/${streamId}/data/liveMatch/lastEventId`).set(lastProcessedEventId);
                    }
                }
            }
        } catch (e) {
            console.error(`[LiveMatch] Fehler beim Verarbeiten von Stream ${streamId}:`, e.message);
        }
    }

    async function triggerMatchEvent(streamId, event) {
        const typeText = event.type?.text || "";
        const clock = event.clock?.displayValue || "";
        
        let type = null;
        let player = "";
        let playerIn = "";
        let playerOut = "";
        let team = "home"; // fallback

        const typeTextLower = typeText.toLowerCase();

        if (typeTextLower.startsWith("goal") || typeTextLower === "own goal" || typeTextLower === "penalty - scored") {
            type = "goal";
            player = event.participants && event.participants[0] ? (event.participants[0].athlete?.displayName || "") : "";
            if (typeTextLower === "own goal" && player) {
                player += " (Eigentor)";
            } else if (typeTextLower === "penalty - scored" && player) {
                player += " (Elfmeter)";
            }
        } else if (typeTextLower === "yellow card") {
            type = "yellow-card";
            player = event.participants && event.participants[0] ? (event.participants[0].athlete?.displayName || "") : "";
        } else if (typeTextLower === "red card") {
            type = "red-card";
            player = event.participants && event.participants[0] ? (event.participants[0].athlete?.displayName || "") : "";
        } else if (typeTextLower === "substitution") {
            type = "substitution";
            playerIn = event.participants && event.participants[0] ? (event.participants[0].athlete?.displayName || "") : "";
            playerOut = event.participants && event.participants[1] ? (event.participants[1].athlete?.displayName || "") : "";
        } else {
            const lowerText = (event.text || "").toLowerCase();
            if (lowerText.includes("added time") || lowerText.includes("injury time")) {
                const match = lowerText.match(/(\d+)\s*minute/);
                if (match) {
                    type = "added-time";
                    player = match[1]; // Store the added minutes in 'player'
                }
            }
        }

        if (type) {
            console.log(`[LiveMatch] Stream ${streamId} Event: [${clock}] ${typeText} für ${event.team?.displayName || 'Team'}`);
            
            // Determine team ('home' or 'away') based on event team ID vs Firebase metadata
            const teamsSnap = await db.ref(`streams/${streamId}/data/teams`).once('value');
            const teams = teamsSnap.val();
            if (teams && event.team) {
                const eventTeamName = event.team.displayName.toLowerCase();
                const homeName = (teams.home?.name || "").toLowerCase();
                const awayName = (teams.away?.name || "").toLowerCase();
                
                if (homeName && (eventTeamName.includes(homeName) || homeName.includes(eventTeamName))) {
                    team = "home";
                } else if (awayName && (eventTeamName.includes(awayName) || awayName.includes(eventTeamName))) {
                    team = "away";
                }
            }

            const triggerObj = {
                id: String(event.id),
                type: type,
                team: team,
                player: player || "",
                playerIn: playerIn || "",
                playerOut: playerOut || "",
                clock: clock,
                text: event.text || "",
                timestamp: Date.now()
            };

            await db.ref(`streams/${streamId}/data/liveMatch/eventTrigger`).set(triggerObj);
        }
    }

    // Run every 10 seconds
    setInterval(pollLiveMatches, 10000);
}

// Start 24/7 Wordgame & Flaggame Tick Service
setInterval(async () => {
    try {
        const streamsSnap = await db.ref('streams').once('value');
        const streams = streamsSnap.val();
        if (!streams) return;

        for (const [streamId, stream] of Object.entries(streams)) {
            // Wordgame check
            const wordgame = stream.data?.wordgame;
            if (wordgame && wordgame.gameStatus) {
                if (wordgame.gameStatus !== 'guessing' || !wordgame.paused) {
                    await processWordgameTicks(streamId, wordgame);
                }
            }
            
            // Flaggame check
            const flaggame = stream.data?.flaggame;
            if (flaggame && flaggame.gameStatus) {
                if (flaggame.gameStatus !== 'guessing' || !flaggame.paused) {
                    await processFlaggameTicks(streamId, flaggame);
                }
            }

            // Mapgame check
            const mapgame = stream.data?.mapgame;
            if (mapgame && mapgame.gameStatus) {
                if (mapgame.gameStatus !== 'guessing' || !mapgame.paused) {
                    await processMapgameTicks(streamId, mapgame);
                }
            }
        }
    } catch (err) {
        console.error("[Game Server Tick] Error in interval loop:", err);
    }
}, 2000);

// Start Live Match Auto-Tracking Service
startLiveMatchPoller(db);

// Database trigger to automatically clean/resolve TikTok video URLs, timestamps, and upload dates
db.ref('streams').on('child_added', (streamSnap) => {
    const streamId = streamSnap.key;
    setupVideoListener(streamId);
});

const activeListeners = new Set();
function setupVideoListener(streamId) {
    if (activeListeners.has(streamId)) return;
    activeListeners.add(streamId);

    const videosRef = db.ref(`streams/${streamId}/data/clipper_team/videos`);
    
    videosRef.on('child_added', async (videoSnap) => {
        const videoId = videoSnap.key;
        const video = videoSnap.val();
        if (video) {
            await sanitizeAndVerifyVideo(streamId, videoId, video);
        }
    });

    videosRef.on('child_changed', async (videoSnap) => {
        const videoId = videoSnap.key;
        const video = videoSnap.val();
        if (video) {
            await sanitizeAndVerifyVideo(streamId, videoId, video);
        }
    });
}

async function sanitizeAndVerifyVideo(streamId, videoId, video) {
    if (video.verified) return; // Prevent infinite loops
    
    let url = video.videoUrl || '';
    if (!url) return;
    
    let resolvedUrl = url;
    let resolved = false;
    
    // 1. Resolve TikTok Short Links (mobile shares)
    if (url.includes('vm.tiktok.com') || url.includes('vt.tiktok.com')) {
        try {
            console.log(`[TikTok Sync] Resolving short link: ${url}`);
            const res = await fetch(url, {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });
            resolvedUrl = res.url;
            resolved = true;
            console.log(`[TikTok Sync] Resolved to: ${resolvedUrl}`);
        } catch (e) {
            console.error(`[TikTok Sync] Failed to resolve short link: ${url}`, e.message);
        }
    }
    
    // 2. Decode Timestamp from Full URL
    if (resolvedUrl.includes('tiktok.com')) {
        const match = resolvedUrl.match(/video\/(\d+)/);
        if (match) {
            try {
                const idStr = match[1];
                const videoTimestamp = Number(BigInt(idStr) >> 32n) * 1000;
                const uploadDate = new Date(videoTimestamp).toISOString().split('T')[0];
                
                const updates = { verified: true };
                
                // Update URL if resolved
                if (resolved) {
                    updates.videoUrl = resolvedUrl;
                }
                
                // Update timestamp/uploadDate if missing or wrong
                if (!video.timestamp || Math.abs(video.timestamp - videoTimestamp) > 300000 || video.uploadDate !== uploadDate) {
                    updates.timestamp = videoTimestamp;
                    updates.uploadDate = uploadDate;
                }
                
                console.log(`[TikTok Sync] Verifying Video ${videoId} (Clipper: ${video.clipperName}): Date set to ${uploadDate}`);
                await db.ref(`streams/${streamId}/data/clipper_team/videos/${videoId}`).update(updates);
                
            } catch(e) {
                console.error(`[TikTok Sync] Error processing video ID for ${videoId}:`, e.message);
                await db.ref(`streams/${streamId}/data/clipper_team/videos/${videoId}`).update({ verified: true });
            }
        } else {
            await db.ref(`streams/${streamId}/data/clipper_team/videos/${videoId}`).update({ verified: true });
        }
    } else {
        await db.ref(`streams/${streamId}/data/clipper_team/videos/${videoId}`).update({ verified: true });
    }
}

// Start background automatic sync for all clippers periodically
async function startAutomaticClipperSync() {
    console.log("[TikTok Auto-Sync] Service initialized.");
    
    // Check and run auto-sync every 10 minutes
    setInterval(async () => {
        try {
            console.log("[TikTok Auto-Sync] Starting periodic sync for all active clippers...");
            const streamsSnap = await db.ref('streams').once('value');
            const streams = streamsSnap.val();
            if (!streams) return;
            
            const tasks = [];
            for (const [streamId, stream] of Object.entries(streams)) {
                const clippers = stream.data?.clipper_team?.clippers;
                if (!clippers) continue;
                
                for (const [clipperId, clipper] of Object.entries(clippers)) {
                    if (clipper.status !== 'inactive') {
                        tasks.push({ streamId, clipperId, clipper });
                    }
                }
            }
            
            console.log(`[TikTok Auto-Sync] Found ${tasks.length} active clippers to sync.`);
            
            // Sync sequentially to preserve CPU/RAM
            for (const task of tasks) {
                try {
                    await executeQueuedSync(() => syncClipperTikTokData(task.streamId, task.clipperId, task.clipper));
                    await new Promise(r => setTimeout(r, 2000));
                } catch(e) {
                    console.error(`[TikTok Auto-Sync] Failed to sync clipper ${task.clipperId}:`, e.message);
                }
            }
            console.log("[TikTok Auto-Sync] Periodic sync iteration finished.");
        } catch(err) {
            console.error("[TikTok Auto-Sync] Error in periodic sync interval:", err.message);
        }
    }, 10 * 60 * 1000); // 10 minutes

    // Run once on startup after 15 seconds delay
    setTimeout(async () => {
        try {
            console.log("[TikTok Auto-Sync] Starting startup sync for all active clippers...");
            const streamsSnap = await db.ref('streams').once('value');
            const streams = streamsSnap.val();
            if (!streams) return;
            
            const tasks = [];
            for (const [streamId, stream] of Object.entries(streams)) {
                const clippers = stream.data?.clipper_team?.clippers;
                if (!clippers) continue;
                
                for (const [clipperId, clipper] of Object.entries(clippers)) {
                    if (clipper.status !== 'inactive') {
                        tasks.push({ streamId, clipperId, clipper });
                    }
                }
            }
            for (const task of tasks) {
                try {
                    await executeQueuedSync(() => syncClipperTikTokData(task.streamId, task.clipperId, task.clipper));
                    await new Promise(r => setTimeout(r, 2000));
                } catch(e) {
                    console.error(`[TikTok Auto-Sync Startup] Failed to sync clipper ${task.clipperId}:`, e.message);
                }
            }
        } catch(e) {
            console.error("[TikTok Auto-Sync Startup] Error:", e.message);
        }
    }, 15000);
}

startAutomaticClipperSync();

// Car Price-Performance Analyzer API
try {
    const carAnalyzerRouter = require('./car_analyzer/routes');
    app.use('/api/car-analyzer', carAnalyzerRouter);
    console.log('[Car Analyzer] Router erfolgreich auf /api/car-analyzer gemountet.');
} catch (e) {
    console.error('[Car Analyzer] Fehler beim Laden des Routers:', e.message);
}

// Start API Server
app.listen(PORT, () => {
    console.log(`🚀 Zentraler Bot-Server läuft auf Port ${PORT}`);
});
