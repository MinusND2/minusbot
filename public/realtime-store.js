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
            scoreboardStyle: {
                posX: 40,
                posY: 40,
                totalWidth: 460,
                height: 58,
                teamWidth: 185,
                teamFontSize: 14,
                scoreFontSize: 22,
                radius: 14
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
            scoreboardStyle: payload?.scoreboardStyle || fallback.scoreboardStyle,
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
            radius: Math.max(0, Number(style?.radius) || 8)
        };
        await baseRef.update({
            scoreboardStyle: safe,
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

    window.BingoStore = {
        getActiveStreamId,
        ensureInitialized,
        subscribe,
        toggleCell,
        resetBoard,
        setTerms,
        setScore,
        setTeams,
        setScoreboardStyle,
        deleteStream,
        onAuthStateChanged,
        signIn,
        register,
        signOut,
        listOwnedStreams,
        createStream,
        requireOwner
    };
})();
