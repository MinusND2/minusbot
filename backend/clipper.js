const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

class ClipperManager {
    constructor(db) {
        this.db = db;
        this.activeRecordings = new Map(); // channelName (lower) -> { ffmpegProcess, streamlinkUrl, checkTimeout, isOffline }
        this.buffersDir = path.join(__dirname, 'buffers');
        
        // Detect public directory dynamically (server uses /var/www/bingo/public, local uses ../public)
        let possiblePublicDir = path.join(__dirname, '..', 'public');
        const stratoPublicDir = path.join(__dirname, '..', 'bingo', 'public');
        if (fs.existsSync(stratoPublicDir)) {
            possiblePublicDir = stratoPublicDir;
        }
        this.clipsDir = path.join(possiblePublicDir, 'clips');

        // Create directories if they don't exist
        if (!fs.existsSync(this.buffersDir)) fs.mkdirSync(this.buffersDir, { recursive: true });
        if (!fs.existsSync(this.clipsDir)) fs.mkdirSync(this.clipsDir, { recursive: true });

        this.init();
    }

    init() {
        console.log('[Clipper] Initialisiere Stream Clipper Manager...');
        
        // Listen to Firebase channels configuration
        this.db.ref('clipper/channels').on('value', (snapshot) => {
            const channels = snapshot.val() || {};
            this.syncChannels(channels);
        });
    }

    syncChannels(configuredChannels) {
        const configuredNames = new Set();
        
        Object.entries(configuredChannels).forEach(([key, channel]) => {
            const channelName = key.toLowerCase();
            configuredNames.add(channelName);

            if (channel.isActive !== false) {
                if (!this.activeRecordings.has(channelName)) {
                    // Start monitoring this channel
                    this.startMonitoring(channelName, channel.platform || 'twitch');
                }
            } else {
                // If marked inactive, stop if running
                this.stopMonitoring(channelName);
            }
        });

        // Stop any channels that were deleted from configuration
        for (const channelName of this.activeRecordings.keys()) {
            if (!configuredNames.has(channelName)) {
                this.stopMonitoring(channelName, true);
            }
        }
    }

    startMonitoring(channelName, platform) {
        console.log(`[Clipper] Starte Überwachung für ${channelName} (${platform})`);
        
        const state = {
            ffmpegProcess: null,
            checkTimeout: null,
            isOffline: false,
            platform: platform
        };
        this.activeRecordings.set(channelName, state);

        this.db.ref(`clipper/channels/${channelName}/status`).set('checking');

        this.checkAndRecord(channelName);
    }

    stopMonitoring(channelName, wasDeleted = false) {
        console.log(`[Clipper] Stoppe Überwachung für ${channelName}`);
        const state = this.activeRecordings.get(channelName);
        if (state) {
            if (state.checkTimeout) clearTimeout(state.checkTimeout);
            if (state.ffmpegProcess) {
                state.ffmpegProcess.kill('SIGINT');
            }
            this.activeRecordings.delete(channelName);
            if (!wasDeleted) {
                this.db.ref(`clipper/channels/${channelName}/status`).set('offline');
            }
        }
    }

    checkAndRecord(channelName) {
        const state = this.activeRecordings.get(channelName);
        if (!state) return;

        const channelUrl = state.platform === 'kick' 
            ? `kick.com/${channelName}` 
            : `twitch.tv/${channelName}`;

        console.log(`[Clipper] Prüfe ob ${channelName} online ist...`);

        // Execute streamlink to get stream url
        exec(`streamlink --stream-url ${channelUrl} best`, (err, stdout, stderr) => {
            const currentState = this.activeRecordings.get(channelName);
            if (!currentState) return; // Stopped in the meantime

            if (err || !stdout.trim().startsWith('http')) {
                // Channel is offline
                if (!currentState.isOffline) {
                    currentState.isOffline = true;
                    console.log(`[Clipper] ${channelName} ist offline.`);
                    this.db.ref(`clipper/channels/${channelName}/status`).set('offline');
                }
                
                // Re-check in 2 minutes
                currentState.checkTimeout = setTimeout(() => {
                    this.checkAndRecord(channelName);
                }, 120000);
            } else {
                // Channel is online! Start recording
                const streamUrl = stdout.trim();
                currentState.isOffline = false;
                console.log(`[Clipper] ${channelName} ist online! Starte Aufnahme...`);
                this.db.ref(`clipper/channels/${channelName}/status`).set('recording');
                
                this.recordStream(channelName, streamUrl);
            }
        });
    }

    recordStream(channelName, streamUrl) {
        const state = this.activeRecordings.get(channelName);
        if (!state) return;

        const channelBufferDir = path.join(this.buffersDir, channelName);
        if (!fs.existsSync(channelBufferDir)) {
            fs.mkdirSync(channelBufferDir, { recursive: true });
        } else {
            // Clear old buffer files on startup to prevent stale segments or pattern collisions
            try {
                fs.readdirSync(channelBufferDir).forEach(file => {
                    if (file.startsWith('buffer_') && file.endsWith('.ts')) {
                        fs.unlinkSync(path.join(channelBufferDir, file));
                    }
                });
                console.log(`[Clipper] Puffer-Verzeichnis bereinigt für ${channelName}`);
            } catch (err) {
                console.error(`[Clipper] Fehler beim Bereinigen des Puffers für ${channelName}:`, err.message);
            }
        }

        // Circular buffer configuration:
        // segment_time 10: 10-second chunks
        // segment_wrap 200: wrap around 200 files, keeping ~2000 seconds (over 33 minutes)
        const ffmpegArgs = [
            '-i', streamUrl,
            '-c', 'copy',
            '-f', 'segment',
            '-segment_time', '10',
            '-segment_wrap', '200',
            '-reset_timestamps', '1',
            '-y',
            path.join(channelBufferDir, 'buffer_%03d.ts')
        ];

        console.log(`[Clipper] Spawning ffmpeg for ${channelName}...`);
        const child = spawn('ffmpeg', ffmpegArgs);
        state.ffmpegProcess = child;

        child.on('close', (code) => {
            console.log(`[Clipper] ffmpeg für ${channelName} beendet mit Code ${code}`);
            
            const currentState = this.activeRecordings.get(channelName);
            if (currentState) {
                currentState.ffmpegProcess = null;
                this.db.ref(`clipper/channels/${channelName}/status`).set('offline');
                
                // Try to reconnect/recheck in 15 seconds (stream might have fluctuated)
                currentState.checkTimeout = setTimeout(() => {
                    this.checkAndRecord(channelName);
                }, 15000);
            }
        });

        child.stderr.on('data', (data) => {
            // Optional: ffmpeg output logging for debug
        });
    }

    async createClip(channelName, durationSec = 120, startSecAgo = undefined, endSecAgo = undefined) {
        console.log(`[Clipper] Erstelle Clip für ${channelName} (duration: ${durationSec}, startSecAgo: ${startSecAgo}, endSecAgo: ${endSecAgo})...`);
        const channelBufferDir = path.join(this.buffersDir, channelName.toLowerCase());
        
        if (!fs.existsSync(channelBufferDir)) {
            throw new Error('Kein Aufnahme-Puffer für diesen Streamer vorhanden.');
        }

        // Get list of all buffer segment files
        let files = fs.readdirSync(channelBufferDir)
            .filter(f => f.startsWith('buffer_') && f.endsWith('.ts'))
            .map(f => {
                const filePath = path.join(channelBufferDir, f);
                const stat = fs.statSync(filePath);
                return { name: f, path: filePath, mtime: stat.mtimeMs };
            });

        if (files.length === 0) {
            throw new Error('Noch keine Video-Daten im Puffer vorhanden. Bitte kurz warten.');
        }

        // Sort files chronologically by modification time
        files.sort((a, b) => a.mtime - b.mtime);

        const now = Date.now();
        let targetFiles = [];
        let startOffset = 0;
        let clipDuration = durationSec;

        if (startSecAgo !== undefined && endSecAgo !== undefined) {
            const startTimeEpoch = now - (startSecAgo * 1000);
            const endTimeEpoch = now - (endSecAgo * 1000);
            clipDuration = startSecAgo - endSecAgo;

            // Find all files that overlap the range [startTimeEpoch, endTimeEpoch]
            // A segment file covers approximately [mtime - 10000, mtime]
            targetFiles = files.filter(f => {
                const segStart = f.mtime - 10000;
                const segEnd = f.mtime;
                return (segEnd >= startTimeEpoch && segStart <= endTimeEpoch);
            });

            if (targetFiles.length === 0) {
                throw new Error('Keine Puffer-Segmente im angegebenen Zeitraum gefunden.');
            }

            // Calculate start offset in the concatenated video
            const firstSegStart = targetFiles[0].mtime - 10000;
            startOffset = Math.max(0, (startTimeEpoch - firstSegStart) / 1000);
        } else {
            // Default behavior: slice the last N segments corresponding to the requested duration
            const ageLimitMs = (durationSec * 1000) + 20000;
            const filtered = files.filter(f => (now - f.mtime) < ageLimitMs);
            const maxFilesNeeded = Math.ceil(durationSec / 10);
            if (filtered.length > maxFilesNeeded) {
                targetFiles = filtered.slice(filtered.length - maxFilesNeeded);
            } else {
                targetFiles = filtered;
            }
            if (targetFiles.length === 0) {
                throw new Error('Puffer enthält keine aktuellen Aufnahmedaten.');
            }
            startOffset = 0;
        }

        // Create concat file list
        const concatFilePath = path.join(channelBufferDir, 'concat_list.txt');
        const fileContent = targetFiles.map(f => `file '${f.path.replace(/\\/g, '/')}'`).join('\n');
        fs.writeFileSync(concatFilePath, fileContent);

        const timestamp = Math.floor(Date.now() / 1000);
        const clipFilename = `clip_${channelName}_${timestamp}.mp4`;
        const outputClipPath = path.join(this.clipsDir, clipFilename);

        return new Promise((resolve, reject) => {
            // Concatenate segments using ffmpeg concat demuxer without re-encoding
            const ffmpegArgs = [
                '-f', 'concat',
                '-safe', '0',
                '-i', concatFilePath
            ];

            if (startOffset > 0) {
                ffmpegArgs.push('-ss', startOffset.toFixed(2));
            }
            ffmpegArgs.push('-t', clipDuration.toFixed(2));

            ffmpegArgs.push(
                '-c', 'copy',
                '-bsf:a', 'aac_adtstoasc',
                '-movflags', '+faststart',
                '-y',
                outputClipPath
            );

            const concatProcess = spawn('ffmpeg', ffmpegArgs);
            
            concatProcess.on('close', (code) => {
                // Clean up concat text file
                try { fs.unlinkSync(concatFilePath); } catch(e) {}

                if (code === 0) {
                    console.log(`[Clipper] Clip erfolgreich erstellt: ${clipFilename}`);
                    
                    // Add clip entry to database
                    const clipId = this.db.ref('clipper/clips').push().key;
                    const clipData = {
                        id: clipId,
                        channelName: channelName,
                        filename: clipFilename,
                        timestamp: Date.now(),
                        url: `/public/clips/${clipFilename}`
                    };

                    this.db.ref(`clipper/clips/${clipId}`).set(clipData)
                        .then(() => resolve(clipData))
                        .catch(err => reject(err));
                } else {
                    reject(new Error(`ffmpeg concat process failed with code ${code}`));
                }
            });

            concatProcess.on('error', (err) => {
                reject(err);
            });
        });
    }

    async renderPortrait(jobId, filename, start, end, camCrop, gameCrop, layout = '50', textOverlay = null, streamerName = null, audioHighPitch = false, zoomEffect = null, logoConfig = null) {
        console.log(`[Clipper] Starte Portrait-Rendering für Job ${jobId}, Datei: ${filename}`);
        const inputPath = path.join(this.clipsDir, filename);

        if (!fs.existsSync(inputPath)) {
            throw new Error(`Die Quelldatei ${filename} wurde nicht gefunden.`);
        }

        const getBestFontFile = () => {
            const paths = [
                path.resolve(__dirname, '../public/ariblk.ttf'),
                path.resolve(__dirname, '../bingo/public/ariblk.ttf'),
                "/var/www/bingo/public/ariblk.ttf",
                "C:\\Windows\\Fonts\\impact.ttf",
                "C:\\Windows\\Fonts\\ariblk.ttf",
                "C:\\Windows\\Fonts\\arialbd.ttf",
                "/usr/share/fonts/truetype/msttcorefonts/Impact.ttf",
                "/usr/share/fonts/truetype/msttcorefonts/impact.ttf",
                "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
            ];
            for (const p of paths) {
                if (fs.existsSync(p)) {
                    return p.replace(/\\/g, '/').replace(/:/g, '\\:');
                }
            }
            return null;
        };

        const autoWrapText = (text, maxChars = 26) => {
            if (!text || text.includes('\n')) return text;
            const words = text.split(/\s+/).filter(w => w.length > 0);
            if (words.length === 0) return text;
            const lines = [];
            let current = '';
            for (const word of words) {
                if (!current) {
                    current = word;
                } else if ((current + ' ' + word).length <= maxChars) {
                    current += ' ' + word;
                } else {
                    lines.push(current);
                    current = word;
                }
            }
            if (current) lines.push(current);
            return lines.join('\n');
        };

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

        // 1. Probe resolution of input file using ffprobe
        const getResolution = () => {
            return new Promise((resolve) => {
                exec(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${inputPath}"`, (err, stdout, stderr) => {
                    if (err) {
                        console.error("[Clipper] ffprobe failed, fallback to 1920x1080:", err.message);
                        resolve({ width: 1920, height: 1080 });
                    } else {
                        const parts = stdout.trim().split('x');
                        const w = parseInt(parts[0], 10);
                        const h = parseInt(parts[1], 10);
                        resolve({ width: w || 1920, height: h || 1080 });
                    }
                });
            });
        };

        const res = await getResolution();
        const W = res.width;
        const H = res.height;
        console.log(`[Clipper] Quellauflösung ermittelt: ${W}x${H}`);

        // Convert percentage crops to pixels
        const cam_w = Math.round((camCrop.w * W) / 100);
        const cam_h = Math.round((camCrop.h * H) / 100);
        const cam_x = Math.round((camCrop.x * W) / 100);
        const cam_y = Math.round((camCrop.y * H) / 100);

        // Extra cameras for 3-way layout
        const cam2 = camCrop.cam2 || { x: 0, y: 0, w: 100, h: 100 };
        const cam_w2 = Math.round((cam2.w * W) / 100);
        const cam_h2 = Math.round((cam2.h * H) / 100);
        const cam_x2 = Math.round((cam2.x * W) / 100);
        const cam_y2 = Math.round((cam2.y * H) / 100);

        const cam3 = camCrop.cam3 || { x: 0, y: 0, w: 100, h: 100 };
        const cam_w3 = Math.round((cam3.w * W) / 100);
        const cam_h3 = Math.round((cam3.h * H) / 100);
        const cam_x3 = Math.round((cam3.x * W) / 100);
        const cam_y3 = Math.round((cam3.y * H) / 100);

        const game_w = Math.round((gameCrop.w * W) / 100);
        const game_h = Math.round((gameCrop.h * H) / 100);
        const game_x = Math.round((gameCrop.x * W) / 100);
        const game_y = Math.round((gameCrop.y * H) / 100);

        // Layout split configuration based on numeric layout percentage (represents Camera height)
        let game_out_h = 960;
        let cam_out_h = 960;

        const camPct = parseFloat(layout);
        if (!isNaN(camPct) && camPct >= 10 && camPct <= 90) {
            cam_out_h = Math.round(1920 * (camPct / 100));
            game_out_h = 1920 - cam_out_h;
        } else if (layout === '70-30') {
            game_out_h = 1344;
            cam_out_h = 576;
        }

        const duration = parseFloat(end) - parseFloat(start);
        if (duration <= 0) throw new Error("Ungültige Dauer (Ende muss nach Start liegen).");

        // Output configuration
        const timestamp = Math.floor(Date.now() / 1000);
        // Find channelName from filename as fallback
        let channelName = "unknown";
        const parts = filename.split('_');
        if (parts.length >= 2) channelName = parts[1];
        
        // Use streamerName as the primary source for the channel name if available
        const actualChannelName = streamerName || channelName;
        
        const outputFilename = `clip_${actualChannelName}_${timestamp}_portrait.mp4`;
        const outputPath = path.join(this.clipsDir, outputFilename);

        let logoPath = '';
        if (streamerName) {
            logoPath = path.join(this.clipsDir, '..', `logo_${streamerName.toLowerCase().trim()}.png`);
        }
        if (!logoPath || !fs.existsSync(logoPath)) {
            logoPath = path.join(this.clipsDir, '..', `logo_${channelName.toLowerCase()}.png`);
        }
        if (!fs.existsSync(logoPath)) {
            logoPath = path.join(this.clipsDir, '..', 'logo_rushclipzquick.png');
        }
        if (!fs.existsSync(logoPath)) {
            logoPath = path.join(this.clipsDir, '..', 'logo_minusnd.png');
        }
        let zooms = [];
        if (Array.isArray(zoomEffect)) {
            zooms = zoomEffect;
        } else if (zoomEffect && typeof zoomEffect === 'object') {
            zooms = [zoomEffect];
        }
        zooms = zooms.filter(z => z && z.start !== undefined && parseFloat(z.duration) > 0);

        const chainZoomsOnStream = (baseNode, targetKey, targetW, targetH, outLabelPrefix) => {
            let currentLabel = baseNode;
            let subFilters = [];
            
            const targetZooms = zooms.filter(z => {
                const isCam = (z.target === 'cam' || z.target === 'custom-cam');
                if (targetKey === 'cam') return isCam;
                if (targetKey === 'game') return !isCam;
                return true;
            });
            
            targetZooms.forEach((z, idx) => {
                const tStart = parseFloat(z.start) || 0;
                const tEnd = tStart + (parseFloat(z.duration) || 3.0);
                
                let wz, hz, xz, yz;
                if (z.w !== undefined && z.h !== undefined) {
                    wz = Math.round(parseFloat(z.w) * W / 100);
                    hz = Math.round(parseFloat(z.h) * H / 100);
                    xz = Math.round(parseFloat(z.x) * W / 100);
                    yz = Math.round(parseFloat(z.y) * H / 100);
                } else {
                    const zFactor = parseFloat(z.factor) || 1.5;
                    wz = Math.round(W / zFactor);
                    hz = Math.round(H / zFactor);
                    const zPctX = z.x !== undefined ? parseFloat(z.x) : 50;
                    const zPctY = z.y !== undefined ? parseFloat(z.y) : 50;
                    xz = Math.round((W - wz) * zPctX / 100);
                    yz = Math.round((H - hz) * zPctY / 100);
                }
                
                wz = Math.max(16, Math.min(W, wz));
                hz = Math.max(16, Math.min(H, hz));
                xz = Math.max(0, Math.min(W - wz, xz));
                yz = Math.max(0, Math.min(H - hz, yz));

                const zoomNode = `${outLabelPrefix}_z${idx}`;
                const mergedNode = `${outLabelPrefix}_m${idx}`;
                
                subFilters.push(`[0:v]crop=${wz}:${hz}:${xz}:${yz},scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH}[${zoomNode}]`);
                subFilters.push(`[${currentLabel}][${zoomNode}]overlay=0:0:enable='between(t,${tStart},${tEnd})'[${mergedNode}]`);
                currentLabel = mergedNode;
            });
            
            return {
                lastNode: currentLabel,
                filterPart: subFilters.length > 0 ? subFilters.join(';') : ''
            };
        };

        let filterStr = "";
        let lastNode = "";

        // Dynamic Watermark / Logo Positioning & Scaling Filter
        const applyLogoOverlay = (baseNode, defaultPosYPct = 91.6) => {
            if (!fs.existsSync(logoPath)) return baseNode;
            if (logoConfig && logoConfig.enabled === false) return baseNode;
            
            const scaleW = logoConfig && logoConfig.scale ? Math.round(parseFloat(logoConfig.scale)) : 260;
            const posX = logoConfig && logoConfig.x !== undefined ? parseFloat(logoConfig.x) : 50; // percentage 0-100
            const posY = logoConfig && logoConfig.y !== undefined ? parseFloat(logoConfig.y) : defaultPosYPct; // percentage 0-100
            const opacity = logoConfig && logoConfig.opacity !== undefined ? Math.max(0.1, Math.min(1.0, parseFloat(logoConfig.opacity))) : 1.0;
            
            let logoFilter = `[1:v]scale=${scaleW}:-2`;
            if (opacity < 0.99) {
                logoFilter += `,format=rgba,colorchannelmixer=aa=${opacity.toFixed(2)}`;
            }
            logoFilter += `[logo_scaled]`;
            
            // Positioning formula: W = 1080, H = 1920
            const overlayExpr = `overlay=x='(W-w)*${(posX / 100).toFixed(4)}':y='(H-h)*${(posY / 100).toFixed(4)}'`;
            
            filterStr += `;${logoFilter};[${baseNode}][logo_scaled]${overlayExpr}[logoed]`;
            return "logoed";
        };

        if (W < H) {
            let filterParts = [];
            filterParts.push(`[0:v]scale=1080:1920[stacked_base]`);
            
            const zoomChain = chainZoomsOnStream("stacked_base", "screen", 1080, 1920, "stacked");
            if (zoomChain.filterPart) {
                filterParts.push(zoomChain.filterPart);
            }
            filterStr = filterParts.join(';');
            lastNode = zoomChain.lastNode;

            if (logoConfig && logoConfig.enabled === true) {
                const defaultY = (layout === 'blur-bg-logo') ? 65.8 : 91.6;
                lastNode = applyLogoOverlay(lastNode, defaultY);
            }
        } else if (layout === 'blur-bg') {
            let filterParts = [];
            filterParts.push(`[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:10[bg]`);
            filterParts.push(`[0:v]crop=ih*0.75:ih:(iw-ih*0.75)/2:0,scale=1080:1440[fg_base]`);
            
            const zoomChain = chainZoomsOnStream("fg_base", "game", 1080, 1440, "fg");
            if (zoomChain.filterPart) {
                filterParts.push(zoomChain.filterPart);
            }
            filterParts.push(`[bg][${zoomChain.lastNode}]overlay=0:240[overlayed]`);
            
            filterStr = filterParts.join(';');
            lastNode = "overlayed";

            if (logoConfig && logoConfig.enabled) {
                lastNode = applyLogoOverlay(lastNode, 87.5);
            }
        } else if (layout === 'blur-bg-logo') {
            let filterParts = [];
            filterParts.push(`[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:10[bg]`);
            filterParts.push(`[0:v]scale=1080:608[fg_base]`);
            
            const zoomChain = chainZoomsOnStream("fg_base", "game", 1080, 608, "fg");
            if (zoomChain.filterPart) {
                filterParts.push(zoomChain.filterPart);
            }
            filterParts.push(`[bg][${zoomChain.lastNode}]overlay=0:656[overlayed]`);
            
            filterStr = filterParts.join(';');
            lastNode = "overlayed";

            lastNode = applyLogoOverlay(lastNode, 65.8);
        } else if (layout === '3-way') {
            filterStr = `[0:v]crop=${cam_w}:${cam_h}:${cam_x}:${cam_y},scale=1080:640:force_original_aspect_ratio=increase,crop=1080:640[cam1];` +
                        `[0:v]crop=${cam_w2}:${cam_h2}:${cam_x2}:${cam_y2},scale=1080:640:force_original_aspect_ratio=increase,crop=1080:640[cam2];` +
                        `[0:v]crop=${cam_w3}:${cam_h3}:${cam_x3}:${cam_y3},scale=1080:640:force_original_aspect_ratio=increase,crop=1080:640[cam3];` +
                        `[cam1][cam2][cam3]vstack=inputs=3[stacked]`;
            
            filterStr += `;[stacked]drawbox=y=637:color=black:width=1080:height=6:t=fill[div1]`;
            filterStr += `;[div1]drawbox=y=1277:color=black:width=1080:height=6:t=fill[divided]`;
            lastNode = "divided";

            lastNode = applyLogoOverlay(lastNode, 91.6);
        } else {
            let filterParts = [];
            filterParts.push(`[0:v]crop=${game_w}:${game_h}:${game_x}:${game_y},scale=1080:${game_out_h}:force_original_aspect_ratio=increase,crop=1080:${game_out_h}[game_base]`);
            filterParts.push(`[0:v]crop=${cam_w}:${cam_h}:${cam_x}:${cam_y},scale=1080:${cam_out_h}:force_original_aspect_ratio=increase,crop=1080:${cam_out_h}[cam_base]`);
            
            const gameChain = chainZoomsOnStream("game_base", "game", 1080, game_out_h, "game");
            const camChain = chainZoomsOnStream("cam_base", "cam", 1080, cam_out_h, "cam");
            
            if (gameChain.filterPart) filterParts.push(gameChain.filterPart);
            if (camChain.filterPart) filterParts.push(camChain.filterPart);
            
            filterParts.push(`[${camChain.lastNode}][${gameChain.lastNode}]vstack=inputs=2[stacked]`);
            
            filterStr = filterParts.join(';');
            
            filterStr += `;[stacked]drawbox=y=${cam_out_h}-3:color=black:width=1080:height=6:t=fill[divided]`;
            lastNode = "divided";

            lastNode = applyLogoOverlay(lastNode, 91.6);
        }

        let outvName = lastNode;
        const overlayText = textOverlay ? (textOverlay.text || textOverlay.content) : null;
        if (textOverlay && overlayText) {
            const fontFile = getBestFontFile();
            const fontArg = fontFile ? `fontfile='${fontFile}'` : "font='Arial'";
            
            const wrappedText = autoWrapText(overlayText.trim(), 24);
            const cleanText = wrappedText
                .replace(/[^\w\s\d.,!?'"-\/öäüßÄÖÜ\n]/gi, '')
                .trim();

            const rawLines = cleanText.split('\n')
                .map(l => l.trim())
                .filter(l => l.length > 0);

            if (rawLines.length > 0) {
                let maxLen = 0;
                rawLines.forEach(l => { if (l.length > maxLen) maxLen = l.length; });
                
                // Dynamic font size between 46 and 64 based on line length
                const calculatedFontSize = Math.max(46, Math.min(64, Math.floor(1250 / Math.max(1, maxLen))));
                const lineSpacing = Math.round(calculatedFontSize * 1.32);

                const tStartVal = parseFloat(start) || 0;
                const rawStart = parseFloat(textOverlay.start) || 0;
                const tStart = Math.max(0, rawStart - tStartVal);
                const tEnd = (textOverlay.isAutoTitle || !textOverlay.duration || parseFloat(textOverlay.duration) >= duration)
                    ? duration
                    : tStart + (parseFloat(textOverlay.duration) || 5);

                const enableExpr = `:enable='between(t\\,${tStart.toFixed(2)}\\,${tEnd.toFixed(2)})'`;

                // Positioning logic:
                // When facecam is stacked on top: place between facecam and lower picture (at cam_out_h).
                // Otherwise (blur-bg, full vertical, etc.): place lower down (targetCenterY = 300) leaving breathing room at top.
                const isStackedFacecam = (layout !== 'blur-bg' && layout !== 'blur-bg-logo' && layout !== '3-way');
                let targetCenterY;

                if (textOverlay.y !== undefined && textOverlay.isAutoTitle !== true && textOverlay.position !== 'auto') {
                    const yPct = parseFloat(textOverlay.y);
                    targetCenterY = Math.round((yPct * 1920) / 100);
                } else if (isStackedFacecam) {
                    targetCenterY = cam_out_h;
                } else if (layout === '3-way') {
                    targetCenterY = 640;
                } else if (layout === 'blur-bg') {
                    targetCenterY = 300;
                } else if (layout === 'blur-bg-logo') {
                    targetCenterY = 320;
                } else {
                    targetCenterY = 300;
                }

                const totalBlockHeight = (rawLines.length - 1) * lineSpacing;
                const startY = Math.round(targetCenterY - (totalBlockHeight / 2));

                let currentNode = lastNode;

                rawLines.forEach((lineText, idx) => {
                    const escapedLine = lineText
                        .replace(/\\/g, '\\\\')
                        .replace(/'/g, "'\\''")
                        .replace(/:/g, '\\:')
                        .replace(/,/g, '\\,');

                    const y = startY + (idx * lineSpacing);
                    const isLastLine = (rawLines.length > 1 && idx === rawLines.length - 1);
                    const isWhiteBadge = isLastLine;

                    const shadowNode = `txt_sh_${idx}`;
                    const lineNode = (idx === rawLines.length - 1) ? "textout" : `txt_${idx}`;

                    if (isWhiteBadge) {
                        // White Badge:
                        // 1. Dark outer border/drop-shadow layer (3px thicker)
                        filterStr += `;[${currentNode}]drawtext=text='${escapedLine}':x=(w-text_w)/2:y=${y + 4}:${fontArg}:fontsize=${calculatedFontSize}:fontcolor=black@0:box=1:boxcolor=black@0.85:boxborderw=16${enableExpr}[${shadowNode}]`;
                        // 2. Solid white badge with bold black text
                        filterStr += `;[${shadowNode}]drawtext=text='${escapedLine}':x=(w-text_w)/2:y=${y + 4}:${fontArg}:fontsize=${calculatedFontSize}:fontcolor=black:borderw=0:box=1:boxcolor=white@1.0:boxborderw=13${enableExpr}[${lineNode}]`;
                    } else {
                        // Red Badge:
                        // 1. Dark outer border/drop-shadow layer (4px thicker)
                        filterStr += `;[${currentNode}]drawtext=text='${escapedLine}':x=(w-text_w)/2:y=${y}:${fontArg}:fontsize=${calculatedFontSize}:fontcolor=black@0:box=1:boxcolor=black@0.75:boxborderw=18${enableExpr}[${shadowNode}]`;
                        // 2. Vibrant red badge (#e60026) with white text & bold black outline
                        filterStr += `;[${shadowNode}]drawtext=text='${escapedLine}':x=(w-text_w)/2:y=${y}:${fontArg}:fontsize=${calculatedFontSize}:fontcolor=white:borderw=5:bordercolor=black:box=1:boxcolor=0xe60026@1.0:boxborderw=14${enableExpr}[${lineNode}]`;
                    }

                    currentNode = lineNode;
                });

                outvName = "textout";
            }
        }

        let mappedAudio = "0:a";
        if (audioHighPitch) {
            filterStr += `;[0:a]rubberband=pitch=1.20[audioout]`;
            mappedAudio = "[audioout]";
        }

        const ffmpegArgs = [
            '-ss', start.toString(),
            '-t', duration.toString(),
            '-i', inputPath
        ];

        if (fs.existsSync(logoPath)) {
            ffmpegArgs.push('-i', logoPath);
        }

        ffmpegArgs.push(
            '-filter_complex', filterStr,
            '-map', `[${outvName}]`,
            '-map', mappedAudio,
            '-c:v', 'libx264',
            '-preset', 'superfast',
            '-crf', '22',
            '-c:a', 'aac',
            '-y',
            outputPath
        );

        console.log(`[Clipper] Spawning ffmpeg: ffmpeg ${ffmpegArgs.join(' ')}`);

        return new Promise((resolve, reject) => {
            const process = spawn('ffmpeg', ffmpegArgs);
            let stderrBuffer = "";

            process.stderr.on('data', (data) => {
                const text = data.toString();
                stderrBuffer += text;

                // Parse time=HH:MM:SS.xx or time=SS.xx for progress
                const timeMatch = text.match(/time=(\d+):(\d+):(\d+\.\d+)/) || text.match(/time=(\d+\.\d+)/);
                if (timeMatch) {
                    let curSecs = 0;
                    if (timeMatch.length === 4) {
                        const h = parseInt(timeMatch[1], 10);
                        const m = parseInt(timeMatch[2], 10);
                        const s = parseFloat(timeMatch[3]);
                        curSecs = h * 3600 + m * 60 + s;
                    } else if (timeMatch.length === 2) {
                        curSecs = parseFloat(timeMatch[1]);
                    }

                    if (curSecs > 0) {
                        const pct = Math.min(99, Math.round((curSecs / duration) * 100));
                        this.db.ref(`clipper/renders/${jobId}`).update({ progress: pct });
                        this.db.ref('clipper/pipeline_status').update({ progress: pct, statusText: `Schneidet 9:16 Portrait-Video (${pct}%)...` }).catch(() => {});
                    }
                }
            });

            process.on('close', (code) => {
                if (code === 0) {
                    console.log(`[Clipper] Portrait-Rendering erfolgreich beendet für Job ${jobId}`);
                    
                    // Add clip entry to database
                    const clipId = this.db.ref('clipper/clips').push().key;
                    const clipData = {
                        id: clipId,
                        channelName: channelName,
                        filename: outputFilename,
                        timestamp: Date.now(),
                        url: `/public/clips/${outputFilename}`,
                        isPortrait: true
                    };

                    this.db.ref(`clipper/clips/${clipId}`).set(clipData)
                        .then(() => {
                            this.db.ref(`clipper/renders/${jobId}`).update({ status: 'done', clip: clipData })
                                .then(() => {
                                    this.pruneOldRenders();
                                    resolve(clipData);
                                })
                                .catch(reject);
                        })
                        .catch(reject);
                } else {
                    console.error(`[Clipper] ffmpeg rendering failed with code ${code}. Stderr:`, stderrBuffer);
                    this.db.ref(`clipper/renders/${jobId}`).update({ status: 'failed', error: `Rendering fehlgeschlagen (Code ${code})` })
                        .then(() => {
                            this.pruneOldRenders();
                            reject(new Error(`ffmpeg failed with code ${code}`));
                        })
                        .catch(reject);
                }
            });

            process.on('error', (err) => {
                this.db.ref(`clipper/renders/${jobId}`).update({ status: 'failed', error: err.message })
                    .then(() => {
                        this.pruneOldRenders();
                        reject(err);
                    })
                    .catch(reject);
            });
        });
    }

    async pruneOldRenders() {
        try {
            const snap = await this.db.ref('clipper/renders').once('value');
            const renders = snap.val() || {};
            const finishedJobs = Object.entries(renders).filter(([k, j]) => j.status === 'done' || j.status === 'failed');
            if (finishedJobs.length > 1) {
                finishedJobs.sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0));
                const updates = {};
                for (let i = 1; i < finishedJobs.length; i++) {
                    updates[finishedJobs[i][0]] = null;
                }
                await this.db.ref('clipper/renders').update(updates);
                console.log(`[Clipper] Pruned ${Object.keys(updates).length} old finished/failed renders.`);
            }
        } catch (err) {
            console.error("[Clipper] Error pruning renders:", err.message);
        }
    }

    deleteClip(clipId, filename) {
        console.log(`[Clipper] Lösche Clip ${clipId} (${filename})`);
        
        // Remove file
        const filePath = path.join(this.clipsDir, filename);
        if (fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
            } catch(e) {
                console.error(`[Clipper] Fehler beim Löschen der Datei ${filename}:`, e.message);
            }
        }

        // Remove from database
        return this.db.ref(`clipper/clips/${clipId}`).remove();
    }
}

module.exports = ClipperManager;

