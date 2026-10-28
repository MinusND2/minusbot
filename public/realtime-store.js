(function () {
    const DEFAULT_TERMS = [
        "10/10 Vallah", "Essen schmeckt scheiße", "Mitarbeiter call", "Ali hat Hunger", "5/5 Nacken",
        "marli Spucken", "jan call", "Ali Stuhl kaputt", "Ghoul", "20 Subs",
        "Ali telefoniet", "Ali redet auf arabsichcc", "Redo 17 GMBHs", "Harbi", "Goldmünze",
        "Manager lacht", "GIG", "Kheir", "Marli raucht", "Menschenfleisch",
        "mit brot ggespielt", "10 Subs", "Ali schreit", "5/5 Hund", "Schere heben"
    ];

    function createDefaultState() {
        return {
            terms: DEFAULT_TERMS.slice(0, 25),
            state: new Array(25).fill(false),
            score: { home: 0, away: 0 },
            teams: {
                home: {
                    name: "BARCELONA",
                    logo: "https://upload.wikimedia.org/wikipedia/en/thumb/4/47/FC_Barcelona_%28crest%29.svg/1200px-FC_Barcelona_%28crest%29.svg.png"
                },
                away: {
                    name: "ATLETICO MADRID",
                    logo: "https://logos-world.net/wp-content/uploads/2020/11/Atletico-Madrid-Logo.png"
                }
            },
            bingoStyle: {
                fontSize: 28,
                textColor: "#e0f2f1",
                boardBackgroundColor: "#051a14",
                cellBackgroundColor: "#0f2d26",
                checkedBackgroundColor: "rgba(46, 125, 50, 0.6)"
            },
            scoreboardStyle: {
                posX: 40,
                posY: 40,
                totalWidth: 460,
                height: 58,
                teamWidth: 185,
                teamFontSize: 14,
                scoreFontSize: 22,
                radius: 14,
                scale: 1.0
            },
            timer: {
                isRunning: false,
                isVisible: true,
                baseTime: Date.now(),
                accumulatedTime: 0,
                showSeconds: false,
                addedTime: 0
            },
            redCards: {
                home: 0,
                away: 0
            },
            tournamentName: "FIFA WORLD CUP 2026™ - GROUP STAGE",
            game2v2v2: {
                title: "2V2V2 GAME",
                teams: [
                    { id: "team1", name: "Ali & Jussef", score: 0 },
                    { id: "team2", name: "Ayman & Eli", score: 0 },
                    { id: "team3", name: "Coach & Rohat", score: 0 }
                ],
                style: {
                    posX: 40,
                    posY: 40,
                    scale: 1.0
                }
            },
            videoOverlay: {
                active: false,
                type: "youtube",
                source: "",
                playing: false,
                volume: 50,
                muted: false,
                loop: false,
                seekTo: 0,
                style: {
                    posX: 0,
                    posY: 0,
                    width: 100,
                    height: 100,
                    scale: 1.0,
                    opacity: 1.0,
                    borderRadius: 0
                },
                presets: {},
                updatedAt: Date.now()
            },
            updatedAt: Date.now()
        };
    }

    function requireConfig() {
        if (!window.BINGO_CONFIG) {
            throw new Error("BINGO_CONFIG fehlt. Bitte public/app-config.js erstellen.");
        }
        if (!window.BINGO_CONFIG.firebaseConfig) {
            throw new Error("BINGO_CONFIG ist unvollständig (firebaseConfig erforderlich).");
        }
    }

    function normalizePayload(payload) {
        const fallback = createDefaultState();
        const terms = Array.isArray(payload?.terms) && payload.terms.length === 25 ? payload.terms : fallback.terms;
        const state = Array.isArray(payload?.state) && payload.state.length === 25 ? payload.state : fallback.state;

        return {
            terms,
            state,
            score: payload?.score || fallback.score,
            teams: payload?.teams || fallback.teams,
            bingoStyle: payload?.bingoStyle || fallback.bingoStyle,
            scoreboardStyle: payload?.scoreboardStyle || fallback.scoreboardStyle,
            timer: {
                ...fallback.timer,
                ...payload?.timer
            },
            redCards: payload?.redCards || fallback.redCards,
            tournamentName: payload?.tournamentName ?? fallback.tournamentName,
            game2v2v2: payload?.game2v2v2 || fallback.game2v2v2,
            shootout: payload?.shootout || { active: false, homePenalties: [], awayPenalties: [], homeScore: 0, awayScore: 0 },
            videoOverlay: payload?.videoOverlay || fallback.videoOverlay,
            updatedAt: payload?.updatedAt || Date.now()
        };
    }

    function getStreamIdFromUrl() {
        const value = new URLSearchParams(window.location.search).get("stream");
        return value ? value.trim() : "";
    }

    function getActiveStreamId() {
        return getStreamIdFromUrl() || window.BINGO_CONFIG.streamId || "default-stream";
    }

    requireConfig();
    if (!firebase.apps.length) {
        firebase.initializeApp(window.BINGO_CONFIG.firebaseConfig);
    }
    const db = firebase.database();
    const auth = firebase.auth ? firebase.auth() : null;

    function streamRef(streamId) {
        return db.ref("streams/" + streamId);
    }

    function streamDataRef(streamId) {
        return streamRef(streamId).child("data");
    }

    function globalLinksRef() {
        return db.ref("global/savedLinks");
    }

    function botInstanceRef(botId) {
        return db.ref("bot_instances/" + botId);
    }

    async function ensureInitialized(streamId) {
        const id = streamId || getActiveStreamId();
        const dataRef = streamDataRef(id);
        const snap = await dataRef.once("value");
        if (!snap.exists()) {
            await dataRef.set(createDefaultState());
        }
    }

    function subscribe(onChange, streamId) {
        const id = streamId || getActiveStreamId();
        const dataRef = streamDataRef(id);
        const handler = (snap) => {
            const normalized = normalizePayload(snap.val());
            onChange(normalized);
        };
        dataRef.on("value", handler);
        return function unsubscribe() {
            dataRef.off("value", handler);
        };
    }

    async function toggleCell(index, streamId) {
        if (index < 0 || index > 24) return;
        const id = streamId || getActiveStreamId();
        const baseRef = streamDataRef(id);
        await baseRef.child("state/" + index).transaction((current) => !current);
        await baseRef.child("updatedAt").set(Date.now());
    }

    async function resetBoard(streamId) {
        const id = streamId || getActiveStreamId();
        const baseRef = streamDataRef(id);
        await baseRef.update({
            state: new Array(25).fill(false),
            updatedAt: Date.now()
        });
    }

    async function setTerms(terms, streamId) {
        if (!Array.isArray(terms) || terms.length !== 25) return;
        const id = streamId || getActiveStreamId();
        const baseRef = streamDataRef(id);
        await baseRef.update({
            terms: terms.map((v) => (v || "").trim()),
            updatedAt: Date.now()
        });
    }

    async function setScore(score, streamId) {
        const id = streamId || getActiveStreamId();
        const baseRef = streamDataRef(id);
        await baseRef.update({
            score: {
                home: Math.max(0, Number(score?.home) || 0),
                away: Math.max(0, Number(score?.away) || 0)
            },
            updatedAt: Date.now()
        });
    }

    async function setTeams(teams, streamId) {
        const id = streamId || getActiveStreamId();
        const baseRef = streamDataRef(id);
        await baseRef.update({
            teams: {
                home: {
                    name: teams?.home?.name || "HOME",
                    logo: teams?.home?.logo || ""
                },
                away: {
                    name: teams?.away?.name || "AWAY",
                    logo: teams?.away?.logo || ""
                }
            },
            updatedAt: Date.now()
        });
    }

    async function setTournamentName(name, streamId) {
        const id = streamId || getActiveStreamId();
        const baseRef = streamDataRef(id);
        await baseRef.update({
            tournamentName: (name || "").trim(),
            updatedAt: Date.now()
        });
    }

    async function setScoreboardStyle(style, streamId) {
        const id = streamId || getActiveStreamId();
        const baseRef = streamDataRef(id);
        const safe = {
            posX: Math.max(0, Number(style?.posX) || 0),
            posY: Math.max(0, Number(style?.posY) || 0),
            totalWidth: Math.max(340, Number(style?.totalWidth) || 460),
            height: Math.max(46, Number(style?.height) || 58),
            teamWidth: Math.max(120, Number(style?.teamWidth) || 185),
            teamFontSize: Math.max(8, Number(style?.teamFontSize) || 14),
            scoreFontSize: Math.max(14, Number(style?.scoreFontSize) || 22),
            radius: Math.max(0, Number(style?.radius) || 8),
            scale: Math.max(0.1, Number(style?.scale) || 1.0)
        };
        await baseRef.update({
            scoreboardStyle: safe,
            updatedAt: Date.now()
        });
    }

    async function setBingoStyle(style, streamId) {
        const id = streamId || getActiveStreamId();
        const baseRef = streamDataRef(id);
        const safe = {
            fontSize: Math.max(10, Math.min(64, Number(style?.fontSize) || 34)),
            textColor: style?.textColor || "#111111",
            boardBackgroundColor: style?.boardBackgroundColor || "#ffffff",
            cellBackgroundColor: style?.cellBackgroundColor || "#ffffff",
            checkedBackgroundColor: style?.checkedBackgroundColor || "#bdf7bd"
        };
        await baseRef.update({
            bingoStyle: safe,
            updatedAt: Date.now()
        });
    }

    async function setVideoOverlay(videoData, streamId) {
        const id = streamId || getActiveStreamId();
        const baseRef = streamDataRef(id);
        await baseRef.child("videoOverlay").update(videoData);
        await baseRef.child("updatedAt").set(Date.now());
    }

    // --- TIMER LOGIK ---
    async function startTimer(streamId) {
        const id = streamId || getActiveStreamId();
        const baseRef = streamDataRef(id);
        const timerSnap = await baseRef.child("timer").once("value");
        const currentTimer = timerSnap.val() || createDefaultState().timer;
        
        if (currentTimer.isRunning) return; // Schon gestartet
        
        await baseRef.update({
            timer: {
                ...currentTimer,
                isRunning: true,
                baseTime: Date.now(),
                accumulatedTime: currentTimer.accumulatedTime
            },
            updatedAt: Date.now()
        });
    }

    async function pauseTimer(streamId) {
        const id = streamId || getActiveStreamId();
        const baseRef = streamDataRef(id);
        const timerSnap = await baseRef.child("timer").once("value");
        const currentTimer = timerSnap.val() || createDefaultState().timer;
        
        if (!currentTimer.isRunning) return; // Schon pausiert
        
        const now = Date.now();
        const addedTime = now - currentTimer.baseTime;
        
        await baseRef.update({
            timer: {
                ...currentTimer,
                isRunning: false,
                baseTime: now,
                accumulatedTime: currentTimer.accumulatedTime + addedTime
            },
            updatedAt: Date.now()
        });
    }

    async function resetTimer(streamId) {
        const id = streamId || getActiveStreamId();
        const baseRef = streamDataRef(id);
        const timerSnap = await baseRef.child("timer").once("value");
        const currentTimer = timerSnap.val() || createDefaultState().timer;
        await baseRef.update({
            timer: {
                ...currentTimer,
                isRunning: false,
                baseTime: Date.now(),
                accumulatedTime: 0
            },
            updatedAt: Date.now()
        });
    }

    async function setTimerMinutes(minutes, streamId) {
        const id = streamId || getActiveStreamId();
        const baseRef = streamDataRef(id);
        const timerSnap = await baseRef.child("timer").once("value");
        const currentTimer = timerSnap.val() || createDefaultState().timer;
        
        const targetMs = Math.max(0, parseInt(minutes, 10)) * 60 * 1000;
        
        await baseRef.update({
            timer: {
                ...currentTimer,
                isRunning: currentTimer.isRunning,
                baseTime: Date.now(),
                accumulatedTime: targetMs
            },
            updatedAt: Date.now()
        });
    }

    async function toggleTimerVisibility(streamId) {
        const id = streamId || getActiveStreamId();
        const baseRef = streamDataRef(id);
        const timerSnap = await baseRef.child("timer").once("value");
        const currentTimer = timerSnap.val() || createDefaultState().timer;
        
        await baseRef.update({
            timer: {
                ...currentTimer,
                isVisible: currentTimer.isVisible === false ? true : false
            },
            updatedAt: Date.now()
        });
    }

    async function toggleTimerSeconds(streamId) {
        const id = streamId || getActiveStreamId();
        const baseRef = streamDataRef(id);
        const timerSnap = await baseRef.child("timer").once("value");
        const currentTimer = timerSnap.val() || createDefaultState().timer;
        
        await baseRef.update({
            timer: {
                ...currentTimer,
                showSeconds: currentTimer.showSeconds === true ? false : true
            },
            updatedAt: Date.now()
        });
    }

    async function deleteStream(streamId, uid) {
        const id = (streamId || "").trim();
        if (!id) return;
        const ownerSnap = await streamRef(id).child("meta/ownerUid").once("value");
        if (!ownerSnap.exists()) return;
        if (ownerSnap.val() !== uid) {
            throw new Error("Kein Zugriff auf dieses Overlay.");
        }
        await streamRef(id).remove();
    }

    function onAuthStateChanged(callback) {
        if (!auth) return function noop() {};
        return auth.onAuthStateChanged(callback);
    }

    async function signIn(email, password) {
        if (!auth) throw new Error("Firebase Auth SDK nicht geladen.");
        return auth.signInWithEmailAndPassword(email, password);
    }

    async function register(email, password) {
        if (!auth) throw new Error("Firebase Auth SDK nicht geladen.");
        return auth.createUserWithEmailAndPassword(email, password);
    }

    async function signOut() {
        if (!auth) return;
        return auth.signOut();
    }

    async function listOwnedStreams(uid) {
        const snap = await db.ref("streams").orderByChild("meta/ownerUid").equalTo(uid).once("value");
        const value = snap.val() || {};
        return Object.keys(value).map((id) => ({
            id,
            name: value[id]?.meta?.name || id
        }));
    }

    function subscribeOwnedStreams(uid, onChange) {
        if (!uid) return () => {};
        const ref = db.ref("streams").orderByChild("meta/ownerUid").equalTo(uid);
        const handler = (snap) => {
            const value = snap.val() || {};
            const items = Object.keys(value).map((id) => ({
                id,
                name: value[id]?.meta?.name || id
            }));
            onChange(items);
        };
        ref.on("value", handler);
        return () => ref.off("value", handler);
    }

    async function createStream(name, uid) {
        const newRef = db.ref("streams").push();
        const streamId = newRef.key;
        await newRef.set({
            meta: {
                name: (name || "").trim() || "Neues Overlay",
                ownerUid: uid,
                createdAt: Date.now()
            },
            data: createDefaultState()
        });
        return streamId;
    }

    function normalizeSavedLink(payload, id) {
        return {
            id,
            name: String(payload?.name || "").trim(),
            url: String(payload?.url || "").trim(),
            createdAt: Number(payload?.createdAt) || Date.now(),
            updatedAt: Number(payload?.updatedAt) || Date.now()
        };
    }

    async function listSavedLinks(uid) {
        // Veraltet, behalten wir für Kompatibilität
        return [];
    }

    function subscribeGlobalLinks(onChange) {
        const ref = globalLinksRef();
        const handler = (snap) => {
            const value = snap.val() || {};
            const items = Object.keys(value)
                .map((id) => normalizeSavedLink(value[id], id))
                .filter((item) => item.name && item.url)
                .sort((a, b) => a.name.localeCompare(b.name, "de", { sensitivity: "base" }));
            onChange(items);
        };
        ref.on("value", handler);
        return () => ref.off("value", handler);
    }

    async function saveSavedLink(uid, link) {
        if (!uid) throw new Error("Nicht eingeloggt.");
        const name = String(link?.name || "").trim();
        const url = String(link?.url || "").trim();
        if (!name) throw new Error("Name fehlt.");
        if (!url) throw new Error("Link fehlt.");

        const now = Date.now();
        const id = String(link?.id || "").trim();
        if (id) {
            const ref = globalLinksRef().child(id);
            const existing = await ref.once("value");
            const createdAt = Number(existing.val()?.createdAt) || now;
            await ref.set({
                name,
                url,
                createdAt,
                updatedAt: now
            });
            return id;
        }

        const ref = globalLinksRef().push();
        await ref.set({
            name,
            url,
            createdAt: now,
            updatedAt: now
        });
        return ref.key;
    }

    async function deleteSavedLink(uid, linkId) {
        if (!uid) throw new Error("Nicht eingeloggt.");
        const id = String(linkId || "").trim();
        if (!id) return;
        await globalLinksRef().child(id).remove();
    }

    // --- BOT MANAGEMENT ---

    async function createBotInstance(name, uid, type = 'spotify') {
        if (!uid) throw new Error("Nicht eingeloggt.");
        const newRef = db.ref("bot_instances").push();
        const botId = newRef.key;
        await newRef.set({
            meta: {
                name: (name || "").trim() || "Neuer Bot",
                ownerUid: uid,
                createdAt: Date.now(),
                type: type
            },
            config: {
                isActive: false,
                rewardTitle: "",
                twitchConnected: false,
                spotifyConnected: false,
                allowTestsong: false,
                testsongPermission: "all"
            }
        });
        return botId;
    }

    function subscribeOwnedBots(uid, onChange) {
        if (!uid) return () => {};
        const ref = db.ref("bot_instances").orderByChild("meta/ownerUid").equalTo(uid);
        const handler = (snap) => {
            const value = snap.val() || {};
            const items = Object.keys(value).map((id) => ({
                id,
                name: value[id]?.meta?.name || id,
                type: value[id]?.meta?.type || 'spotify',
                config: value[id]?.config || {}
            }));
            onChange(items);
        };
        ref.on("value", handler);
        return () => ref.off("value", handler);
    }

    async function deleteBotInstance(botId, uid) {
        if (!botId || !uid) return;
        const ownerSnap = await botInstanceRef(botId).child("meta/ownerUid").once("value");
        if (!ownerSnap.exists()) return;
        if (ownerSnap.val() !== uid) {
            throw new Error("Kein Zugriff auf diesen Bot.");
        }
        await botInstanceRef(botId).remove();
    }

    function subscribeBotConfig(botId, onChange) {
        if (!botId) return () => {};
        const ref = botInstanceRef(botId).child('config');
        const handler = (snap) => {
            onChange(snap.val() || {
                isActive: false,
                rewardTitle: "",
                twitchConnected: false,
                spotifyConnected: false
            });
        };
        ref.on("value", handler);
        return () => ref.off("value", handler);
    }

    async function saveBotConfig(botId, config) {
        if (!botId) throw new Error("Kein Bot ausgewählt.");
        await botInstanceRef(botId).child('config').update(config);
    }

    function subscribePlayback(botId, onChange) {
        if (!botId) return () => {};
        const ref = botInstanceRef(botId).child('playback');
        const handler = (snap) => {
            onChange(snap.val() || null);
        };
        ref.on("value", handler);
        return () => ref.off("value", handler);
    }

    async function sendBotCommand(botId, command) {
        if (!botId) throw new Error("Kein Bot ausgewählt.");
        await botInstanceRef(botId).child('commands').push({
            action: command,
            timestamp: Date.now()
        });
    }

    function subscribeBotLogs(botId, onChange) {
        if (!botId) return () => {};
        const ref = botInstanceRef(botId).child('mod_logs');
        const handler = (snap) => {
            const val = snap.val() || {};
            const items = Object.keys(val).map(id => ({
                id,
                ...val[id]
            })).sort((a, b) => b.timestamp - a.timestamp);
            onChange(items);
        };
        ref.on("value", handler);
        return () => ref.off("value", handler);
    }

    async function clearBotLogs(botId) {
        if (!botId) throw new Error("Kein Bot ausgewählt.");
        await botInstanceRef(botId).child('mod_logs').remove();
    }

    function subscribeModeratedChannels(botId, onChange) {
        if (!botId) return () => {};
        const ref = botInstanceRef(botId).child('moderated_channels');
        const handler = (snap) => {
            onChange(snap.val() || []);
        };
        ref.on("value", handler);
        return () => ref.off("value", handler);
    }

    async function requireOwner(streamId, uid) {
        const id = streamId || getActiveStreamId();
        const ownerSnap = await streamRef(id).child("meta/ownerUid").once("value");
        if (!ownerSnap.exists()) {
            if (!uid) throw new Error("Nicht eingeloggt.");
            await streamRef(id).set({
                meta: {
                    name: id,
                    ownerUid: uid,
                    createdAt: Date.now()
                },
                data: createDefaultState()
            });
            return true;
        }
        if (ownerSnap.val() !== uid) {
            throw new Error("Kein Zugriff auf dieses Overlay.");
        }
        return true;
    }

    // --- GENERAL OVERLAYS MANAGEMENT ---

    async function createGeneralProfile(name, uid) {
        if (!uid) throw new Error("Nicht eingeloggt.");
        const newRef = db.ref("general_profiles").push();
        const profileId = newRef.key;
        const createdAt = Date.now();
        const cleanName = (name || "").trim() || "Allgemeines Overlay";

        await newRef.set({
            meta: {
                name: cleanName,
                ownerUid: uid,
                createdAt: createdAt
            },
            countdown: {
                title: "Stream startet gleich",
                minutes: 10,
                accentColor: "#22c55e",
                isRunning: false,
                baseTime: createdAt,
                accumulatedTime: 0
            },
            chat: {
                channel: "",
                theme: "glass",
                fontSize: 16,
                limit: 20,
                fadeTime: 15
            },
            goal: {
                title: "Follower Goal",
                target: 100,
                current: 0,
                color: "#22c55e"
            },
            social: {
                instagram: "",
                tiktok: "",
                youtube: "",
                twitch: "",
                duration: 5,
                color: "#22c55e"
            },
            hearts: {
                maxHearts: 3,
                heartColor: "#ff3366",
                entries: {}
            }
        });

        // Index under users/{uid}/general_profiles
        await db.ref(`users/${uid}/general_profiles/${profileId}`).set({
            name: cleanName,
            createdAt: createdAt
        });

        return profileId;
    }

    function subscribeGeneralProfiles(uid, onChange, onError) {
        if (!uid) return () => {};
        const ref = db.ref(`users/${uid}/general_profiles`);
        const handler = (snap) => {
            const value = snap.val() || {};
            const items = Object.keys(value).map((id) => ({
                id,
                name: value[id]?.name || id,
                createdAt: value[id]?.createdAt || 0
            }));
            items.sort((a, b) => b.createdAt - a.createdAt);
            onChange(items);
        };
        const errHandler = (err) => {
            if (onError) onError(err);
        };
        ref.on("value", handler, errHandler);
        return () => ref.off("value", handler);
    }

    async function deleteGeneralProfile(profileId, uid) {
        if (!profileId || !uid) return;
        await db.ref(`users/${uid}/general_profiles/${profileId}`).remove();
        try {
            await db.ref("general_profiles/" + profileId).remove();
        } catch (e) {
            console.warn("Could not delete root general_profile node:", e);
        }
    }

    function subscribeGeneralProfile(profileId, onChange) {
        if (!profileId) return () => {};
        const ref = db.ref("general_profiles/" + profileId);
        const handler = (snap) => {
            onChange(snap.val() || null);
        };
        ref.on("value", handler);
        return () => ref.off("value", handler);
    }

    async function saveGeneralProfileConfig(profileId, section, config) {
        if (!profileId) throw new Error("Kein Profil ausgewählt.");
        await db.ref("general_profiles/" + profileId + "/" + section).update(config);
    }

    async function startGeneralTimer(profileId) {
        if (!profileId) return;
        const ref = db.ref("general_profiles/" + profileId + "/countdown");
        const snap = await ref.once("value");
        const current = snap.val() || {};
        if (current.isRunning) return;
        await ref.update({
            isRunning: true,
            baseTime: Date.now(),
            accumulatedTime: current.accumulatedTime || 0
        });
    }

    async function pauseGeneralTimer(profileId) {
        if (!profileId) return;
        const ref = db.ref("general_profiles/" + profileId + "/countdown");
        const snap = await ref.once("value");
        const current = snap.val() || {};
        if (!current.isRunning) return;
        const now = Date.now();
        const added = now - (current.baseTime || now);
        await ref.update({
            isRunning: false,
            baseTime: now,
            accumulatedTime: (current.accumulatedTime || 0) + added
        });
    }

    async function resetGeneralTimer(profileId) {
        if (!profileId) return;
        const ref = db.ref("general_profiles/" + profileId + "/countdown");
        await ref.update({
            isRunning: false,
            baseTime: Date.now(),
            accumulatedTime: 0
        });
    }

    async function setGeneralTimerMinutes(minutes, profileId) {
        if (!profileId) return;
        const ref = db.ref("general_profiles/" + profileId + "/countdown");
        await ref.update({
            isRunning: false,
            baseTime: Date.now(),
            accumulatedTime: 0,
            minutes: parseInt(minutes, 10)
        });
    }

    async function startGeneralStopwatch(profileId) {
        if (!profileId) return;
        const ref = db.ref("general_profiles/" + profileId + "/stopwatch");
        const snap = await ref.once("value");
        const current = snap.val() || {};
        if (current.isRunning) return;
        await ref.update({
            isRunning: true,
            baseTime: Date.now(),
            accumulatedTime: current.accumulatedTime || 0
        });
    }

    async function pauseGeneralStopwatch(profileId) {
        if (!profileId) return;
        const ref = db.ref("general_profiles/" + profileId + "/stopwatch");
        const snap = await ref.once("value");
        const current = snap.val() || {};
        if (!current.isRunning) return;
        const now = Date.now();
        const added = now - (current.baseTime || now);
        await ref.update({
            isRunning: false,
            baseTime: now,
            accumulatedTime: (current.accumulatedTime || 0) + added
        });
    }

    async function resetGeneralStopwatch(profileId) {
        if (!profileId) return;
        const ref = db.ref("general_profiles/" + profileId + "/stopwatch");
        await ref.update({
            isRunning: false,
            baseTime: Date.now(),
            accumulatedTime: 0
        });
    }

    async function setGeneralStopwatchMinutes(minutes, profileId) {
        if (!profileId) return;
        const ref = db.ref("general_profiles/" + profileId + "/stopwatch");
        await ref.update({
            isRunning: false,
            baseTime: Date.now(),
            accumulatedTime: 0,
            minutes: parseInt(minutes, 10)
        });
    }

    async function saveHeartsEntry(profileId, entryId, entryData) {
        if (!profileId) throw new Error("Kein Profil ausgewählt.");
        const entriesRef = db.ref("general_profiles/" + profileId + "/hearts/entries");
        if (entryId) {
            await entriesRef.child(entryId).update(entryData);
            return entryId;
        } else {
            const newRef = entriesRef.push();
            await newRef.set(entryData);
            return newRef.key;
        }
    }

    async function deleteHeartsEntry(profileId, entryId) {
        if (!profileId || !entryId) return;
        await db.ref("general_profiles/" + profileId + "/hearts/entries/" + entryId).remove();
    }

    async function saveHeartsConfig(profileId, config) {
        if (!profileId) throw new Error("Kein Profil ausgewählt.");
        const ref = db.ref("general_profiles/" + profileId + "/hearts");
        await ref.update({
            maxHearts: Math.max(1, Math.min(100, parseInt(config.maxHearts, 10) || 3)),
            heartColor: config.heartColor || "#ff3366",
            theme: config.theme || "standard"
        });
    }

    async function saveSmashPassEntry(uid, entryId, entryData) {
        if (!uid) throw new Error("Nicht eingeloggt.");
        const entriesRef = db.ref("users/" + uid + "/smashpass/entries");
        if (entryId) {
            await entriesRef.child(entryId).update(entryData);
            return entryId;
        } else {
            const newRef = entriesRef.push();
            await newRef.set(entryData);
            return newRef.key;
        }
    }

    async function deleteSmashPassEntry(uid, entryId) {
        if (!uid || !entryId) return;
        await db.ref("users/" + uid + "/smashpass/entries/" + entryId).remove();
    }

    async function addSmashPassEntryText(uid, entryId, text) {
        if (!uid || !entryId || !text) return;
        const textsRef = db.ref("users/" + uid + "/smashpass/entries/" + entryId + "/texts");
        const newRef = textsRef.push();
        await newRef.set(text);
        return newRef.key;
    }

    async function deleteSmashPassEntryText(uid, entryId, textId) {
        if (!uid || !entryId || !textId) return;
        await db.ref("users/" + uid + "/smashpass/entries/" + entryId + "/texts/" + textId).remove();
    }

    window.BingoStore = {
        getActiveStreamId,
        ensureInitialized,
        subscribe,
        toggleCell,
        resetBoard,
        setTerms,
        setScore,
        setTeams,
        setTournamentName,
        setBingoStyle,
        setScoreboardStyle,
        setVideoOverlay,
        startTimer,
        pauseTimer,
        resetTimer,
        setTimerMinutes,
        toggleTimerVisibility,
        toggleTimerSeconds,
        deleteStream,
        onAuthStateChanged,
        signIn,
        register,
        signOut,
        listOwnedStreams,
        subscribeOwnedStreams,
        createStream,
        requireOwner,
        listSavedLinks,
        subscribeGlobalLinks,
        saveSavedLink,
        deleteSavedLink,
        createBotInstance,
        subscribeOwnedBots,
        deleteBotInstance,
        subscribeBotConfig,
        saveBotConfig,
        subscribePlayback,
        sendBotCommand,
        subscribeBotLogs,
        clearBotLogs,
        subscribeModeratedChannels,
        createGeneralProfile,
        subscribeGeneralProfiles,
        deleteGeneralProfile,
        subscribeGeneralProfile,
        saveGeneralProfileConfig,
        startGeneralTimer,
        pauseGeneralTimer,
        resetGeneralTimer,
        setGeneralTimerMinutes,
        startGeneralStopwatch,
        pauseGeneralStopwatch,
        resetGeneralStopwatch,
        setGeneralStopwatchMinutes,
        saveHeartsEntry,
        deleteHeartsEntry,
        saveHeartsConfig,
        saveSmashPassEntry,
        deleteSmashPassEntry,
        addSmashPassEntryText,
        deleteSmashPassEntryText
    };
})();
