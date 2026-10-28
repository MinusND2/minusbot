const fs = require('fs');
const path = require('path');

const jsPath = path.join(__dirname, '../protected/_clipper_js_only.html');
const outPath = path.join(__dirname, '../protected/clipper.html');

if (!fs.existsSync(jsPath)) {
    console.error("Javascript backup file does not exist!");
    process.exit(1);
}

const jsContent = fs.readFileSync(jsPath, 'utf8');

const htmlContent = `<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Stream Clipper (DVR & Twitch Clip Agent)</title>
    <!-- Google Fonts Outfit -->
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-base: #050505;
            --bg-panel: #0c0c0e;
            --bg-panel-hover: #121214;
            --border-color: rgba(255, 255, 255, 0.05);
            --border-hover: rgba(245, 197, 24, 0.15);
            --text-primary: #f4f4f5;
            --text-muted: #a1a1aa;
            --text-muted-dark: #71717a;
            --primary: #f5c518;
            --primary-hover: #e0b310;
            --primary-glow: rgba(245, 197, 24, 0.15);
            --accent-cyan: #06b6d4;
            --accent-magenta: #d946ef;
            --danger: #ef4444;
            --success: #22c55e;
            --warning: #f59e0b;
            --radius-lg: 12px;
            --radius-md: 8px;
            --radius-sm: 4px;
            --font-family: 'Outfit', sans-serif;
            --transition: all 0.2s ease-in-out;
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            background-color: var(--bg-base);
            color: var(--text-primary);
            font-family: var(--font-family);
            min-height: 100vh;
            display: flex;
            overflow: hidden;
            -webkit-font-smoothing: antialiased;
        }

        /* Scrollbar styling */
        ::-webkit-scrollbar {
            width: 6px;
            height: 6px;
        }
        ::-webkit-scrollbar-track {
            background: transparent;
        }
        ::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 4px;
        }
        ::-webkit-scrollbar-thumb:hover {
            background: rgba(245, 197, 24, 0.3);
        }

        /* App Wrapper */
        .app-container {
            display: flex;
            width: 100%;
            height: 100vh;
            overflow: hidden;
            position: relative;
        }

        /* Sidebar styling */
        .sidebar {
            width: 260px;
            background: #09090b;
            border-right: 1px solid var(--border-color);
            display: flex;
            flex-direction: column;
            padding: 24px 16px;
            flex-shrink: 0;
            z-index: 100;
        }

        .logo-wrap {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 32px;
            padding: 0 8px;
        }

        .logo-icon {
            width: 24px;
            height: 24px;
            fill: var(--primary);
            filter: drop-shadow(0 0 8px var(--primary-glow));
        }

        .logo-text {
            font-size: 20px;
            font-weight: 900;
            color: #ffffff;
            letter-spacing: -0.5px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .logo-text span {
            color: var(--primary);
        }

        .nav-menu {
            display: flex;
            flex-direction: column;
            gap: 6px;
            flex: 1;
        }

        .tab-btn {
            background: transparent;
            border: none;
            color: var(--text-muted);
            padding: 12px 14px;
            font-size: 14px;
            font-weight: 600;
            border-radius: var(--radius-md);
            cursor: pointer;
            transition: var(--transition);
            display: flex;
            align-items: center;
            gap: 12px;
            text-align: left;
            width: 100%;
        }

        .tab-btn:hover {
            background: rgba(255, 255, 255, 0.04);
            color: var(--text-primary);
        }

        .tab-btn.active {
            background: rgba(245, 197, 24, 0.08);
            color: var(--primary);
            box-shadow: inset 0 0 0 1px rgba(245, 197, 24, 0.15);
        }

        .live-dot {
            width: 8px;
            height: 8px;
            background: var(--danger);
            border-radius: 50%;
            display: inline-block;
            box-shadow: 0 0 8px var(--danger);
            animation: pulse 1.5s infinite;
        }

        .sidebar-footer {
            border-top: 1px solid var(--border-color);
            padding-top: 16px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .conn-status {
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid var(--border-color);
            padding: 10px 12px;
            border-radius: var(--radius-md);
            font-size: 11px;
            font-weight: 600;
            color: var(--text-muted);
        }

        .conn-indicator {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #6b7280;
            display: inline-block;
            box-shadow: 0 0 4px #6b7280;
        }

        .nav-link {
            text-decoration: none;
            color: var(--text-muted);
            font-size: 13px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 14px;
            border-radius: var(--radius-md);
            transition: var(--transition);
        }

        .nav-link:hover {
            background: rgba(255, 255, 255, 0.04);
            color: var(--text-primary);
        }

        /* Main Content Panel */
        .main-content {
            flex: 1;
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
            background: #09090b;
        }

        /* Top Header styling */
        .top-bar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 20px 32px;
            background: #09090b;
            border-bottom: 1px solid var(--border-color);
            flex-shrink: 0;
        }

        .top-bar-title {
            font-size: 18px;
            font-weight: 800;
            color: #ffffff;
            letter-spacing: -0.5px;
        }

        .top-bar-actions {
            display: flex;
            gap: 12px;
        }

        /* Clipper layout classes */
        .clipper-layout {
            display: flex;
            gap: 24px;
            align-items: start;
            width: 100%;
        }

        .clipper-sidebar {
            width: 320px;
            display: flex;
            flex-direction: column;
            gap: 20px;
            flex-shrink: 0;
        }

        .clipper-main {
            flex: 1;
            display: flex;
            flex-direction: column;
            gap: 24px;
            min-width: 0;
        }

        @media (max-width: 1150px) {
            .clipper-layout {
                flex-direction: column;
                align-items: stretch;
            }
            .clipper-sidebar {
                width: 100%;
            }
        }
        
        .sidebar {
            display: none !important;
        }
        
        .top-bar-tabs .tab-btn {
            width: auto;
            font-size: 12px;
            font-weight: 700;
            padding: 0 16px;
            height: 28px;
            border-radius: 14px;
            display: flex;
            align-items: center;
            gap: 6px;
            color: var(--text-muted);
            background: transparent;
            border: none;
            cursor: pointer;
            transition: var(--transition);
        }
        
        .top-bar-tabs .tab-btn:hover {
            color: #fff;
            background: rgba(255,255,255,0.02);
        }

        .top-bar-tabs .tab-btn.active {
            background: var(--primary) !important;
            color: #000 !important;
            box-shadow: none;
        }
        
        body.is-embedded .hub-back-btn {
            display: none !important;
        }

        .content-panel {
            padding: 24px 32px;
            overflow-y: auto;
            flex: 1;
        }

        .content-section {
            display: none;
            flex-direction: column;
            gap: 24px;
        }

        .content-section.active {
            display: flex;
        }

        /* Baukasten Grid System */
        .baukasten-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
            gap: 20px;
            align-items: start;
        }

        /* Responsive spans for larger Baukasten blocks */
        @media (min-width: 1280px) {
            .baukasten-span-2 {
                grid-column: span 2;
            }
            .baukasten-span-full {
                grid-column: 1 / -1;
            }
        }

        /* Baukasten Module Card */
        .baukasten-card {
            background: var(--bg-panel);
            border: 1px solid var(--border-color);
            border-radius: var(--radius-lg);
            padding: 20px;
            box-shadow: 0 4px 24px rgba(0, 0, 0, 0.25);
            display: flex;
            flex-direction: column;
            gap: 14px;
            position: relative;
            overflow: hidden;
            transition: var(--transition);
        }

        .baukasten-card:hover {
            border-color: rgba(255, 255, 255, 0.12);
            background: var(--bg-panel-hover);
        }

        .baukasten-card-title {
            font-size: 11px;
            font-weight: 800;
            text-transform: uppercase;
            color: var(--text-muted);
            letter-spacing: 1px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            padding-bottom: 8px;
        }

        /* Streamer Search Input */
        .input-group {
            display: flex;
            gap: 8px;
        }

        .text-input {
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid var(--border-color);
            color: #fff;
            padding: 10px 14px;
            border-radius: var(--radius-md);
            font-family: inherit;
            font-size: 13px;
            outline: none;
            width: 100%;
            transition: var(--transition);
        }

        .text-input:focus {
            border-color: var(--primary);
            background: rgba(245, 197, 24, 0.02);
            box-shadow: 0 0 10px rgba(245, 197, 24, 0.1);
        }

        .text-input::placeholder {
            color: var(--text-muted-dark);
        }

        .btn-icon {
            background: var(--primary);
            border: none;
            color: #000;
            width: 38px;
            height: 38px;
            border-radius: var(--radius-md);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: var(--transition);
        }

        .btn-icon:hover {
            background: var(--primary-hover);
            transform: translateY(-1px);
        }

        /* Streamer List */
        .streamer-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
            max-height: 200px;
            overflow-y: auto;
            padding-right: 4px;
        }

        .streamer-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid rgba(255, 255, 255, 0.04);
            padding: 10px 12px;
            border-radius: var(--radius-md);
            font-size: 13px;
            font-weight: 500;
            transition: var(--transition);
        }

        .streamer-item:hover {
            background: rgba(255, 255, 255, 0.04);
            border-color: var(--border-hover);
        }

        .btn-delete {
            background: transparent;
            border: none;
            color: var(--text-muted-dark);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: var(--transition);
        }

        .btn-delete:hover {
            color: var(--danger);
        }

        /* Zeitraum Pills */
        .pills-group {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 8px;
        }

        .pill-btn {
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid var(--border-color);
            color: var(--text-muted);
            padding: 8px;
            border-radius: var(--radius-md);
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            transition: var(--transition);
            text-align: center;
            font-family: inherit;
        }

        .pill-btn.active {
            background: rgba(245, 197, 24, 0.1);
            border-color: var(--primary);
            color: #fff;
        }

        .pill-btn:hover:not(.active) {
            background: rgba(255, 255, 255, 0.05);
            color: #fff;
        }

        .btn-load {
            background: var(--primary);
            border: none;
            color: #000;
            font-weight: 750;
            padding: 12px;
            font-size: 13px;
            border-radius: var(--radius-md);
            cursor: pointer;
            transition: var(--transition);
            text-align: center;
            width: 100%;
        }

        .btn-load:hover {
            background: var(--primary-hover);
        }

        /* Live diagnostic console styling */
        .terminal-console {
            background: #09090b;
            border: 1px solid var(--border-color);
            border-radius: var(--radius-md);
            padding: 14px;
            font-family: monospace;
            font-size: 12px;
            color: #a1a1aa;
            height: 180px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 6px;
            box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.8);
        }

        .terminal-line {
            display: flex;
            gap: 8px;
            line-height: 1.4;
            word-break: break-all;
        }

        .terminal-line .time {
            color: #52525b;
            flex-shrink: 0;
        }

        .terminal-line.success { color: #4ade80; }
        .terminal-line.error { color: #f87171; }
        .terminal-line.warn { color: #fbbf24; }
        .terminal-line.info { color: #a1a1aa; }

        /* Processing list & items */
        .processing-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
            max-height: 250px;
            overflow-y: auto;
        }

        .processing-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid var(--border-color);
            padding: 10px 14px;
            border-radius: var(--radius-md);
            font-size: 13px;
            gap: 8px;
            flex-shrink: 0;
        }

        .processing-item-name {
            font-weight: 500;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            flex: 1;
        }

        .status-badge {
            font-size: 9px;
            font-weight: 750;
            padding: 4px 8px;
            border-radius: 20px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            white-space: nowrap;
        }

        .status-badge.rendering {
            background: rgba(245, 197, 24, 0.1);
            color: var(--primary);
            border: 1px solid rgba(245, 197, 24, 0.25);
        }

        .status-badge.done {
            background: rgba(34, 197, 94, 0.1);
            color: var(--success);
            border: 1px solid rgba(34, 197, 94, 0.25);
        }

        .status-badge.failed {
            background: rgba(239, 68, 68, 0.1);
            color: var(--danger);
            border: 1px solid rgba(239, 68, 68, 0.25);
        }

        .status-badge.downloading {
            background: rgba(6, 182, 212, 0.1);
            color: var(--accent-cyan);
            border: 1px solid rgba(6, 182, 212, 0.25);
        }

        .status-badge.pending {
            background: rgba(255, 255, 255, 0.05);
            color: var(--text-muted);
            border: 1px solid var(--border-color);
        }

        .spinner-ring {
            display: inline-block;
            width: 12px;
            height: 12px;
            border: 2px solid rgba(245, 197, 24, 0.2);
            border-top-color: var(--primary);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        /* TikTok Queue Compact Item Design */
        .tq-item {
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid var(--border-color);
            border-radius: var(--radius-md);
            overflow: hidden;
            display: flex;
            flex-direction: column;
            transition: var(--transition);
            flex-shrink: 0;
        }

        .tq-item:hover {
            border-color: rgba(255, 255, 255, 0.1);
            background: rgba(255, 255, 255, 0.03);
        }

        .tq-item--active { border-left: 3px solid var(--accent-cyan); }
        .tq-item--done { border-left: 3px solid var(--success); }
        .tq-item--failed { border-left: 3px solid var(--danger); }
        .tq-item--pending { border-left: 3px solid var(--text-muted-dark); }

        .tq-item-main {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 14px;
            gap: 12px;
        }

        .tq-item-info {
            flex: 1;
            min-width: 0;
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .tq-item-title {
            font-size: 12px;
            font-weight: 600;
            color: #ffffff;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .tq-item-meta {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 10px;
            color: var(--text-muted);
        }

        .tq-item-dot {
            color: rgba(255, 255, 255, 0.15);
            font-weight: bold;
        }

        .tq-item-detail {
            font-size: 10px;
            font-weight: 500;
        }

        .tq-item-detail--ok { color: var(--text-muted); }
        .tq-item-detail--error { color: var(--danger); }

        .tq-item-right {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-shrink: 0;
        }

        .tq-item-badge {
            font-size: 9px;
            font-weight: 750;
            padding: 3px 8px;
            border-radius: 20px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            white-space: nowrap;
            display: inline-flex;
            align-items: center;
            gap: 5px;
        }

        .tq-item-badge--active { background: rgba(6, 182, 212, 0.1); color: var(--accent-cyan); border: 1px solid rgba(6, 182, 212, 0.2); }
        .tq-item-badge--done { background: rgba(34, 197, 94, 0.1); color: var(--success); border: 1px solid rgba(34, 197, 94, 0.2); }
        .tq-item-badge--failed { background: rgba(239, 68, 68, 0.1); color: var(--danger); border: 1px solid rgba(239, 68, 68, 0.2); }
        .tq-item-badge--pending { background: rgba(255, 255, 255, 0.04); color: var(--text-muted); border: 1px solid var(--border-color); }

        .tq-item-delete {
            background: transparent;
            border: none;
            color: var(--text-muted-dark);
            cursor: pointer;
            padding: 4px;
            border-radius: 4px;
            transition: var(--transition);
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .tq-item-delete:hover {
            color: var(--danger);
            background: rgba(239, 68, 68, 0.08);
        }

        .tq-item-spinner {
            display: inline-block;
            width: 8px;
            height: 8px;
            border: 1.5px solid rgba(255, 255, 255, 0.2);
            border-top-color: currentColor;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }

        .tq-item-progress-wrap {
            height: 2px;
            background: rgba(255, 255, 255, 0.03);
            width: 100%;
        }

        .tq-item-progress-bar {
            height: 100%;
            width: 0%;
            transition: width 0.3s;
        }

        .tq-item--active .tq-item-progress-bar {
            background: var(--accent-cyan);
            width: 70%;
            animation: progressPulse 1.5s infinite ease-in-out;
        }

        .tq-item--done .tq-item-progress-bar { background: var(--success); width: 100%; }
        .tq-item--failed .tq-item-progress-bar { background: var(--danger); width: 100%; }

        @keyframes progressPulse {
            0%, 100% { opacity: 0.5; }
            50% { opacity: 1; }
        }

        /* Toggle switches */
        .toggle-switch {
            user-select: none;
        }

        /* Clip Browser Library styling */
        .clip-browser-section {
            display: flex;
            flex-direction: column;
            gap: 20px;
        }

        .section-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 12px;
            margin-top: 8px;
        }

        .section-title-large {
            font-size: 16px;
            font-weight: 800;
            color: #ffffff;
        }

        .clips-toggle-bar {
            display: flex;
            gap: 8px;
        }

        .clips-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
            gap: 20px;
        }

        .clip-card {
            background: var(--bg-panel);
            border: 1px solid var(--border-color);
            border-radius: var(--radius-md);
            overflow: hidden;
            cursor: pointer;
            transition: var(--transition);
            display: flex;
            flex-direction: column;
        }

        .clip-card:hover {
            border-color: var(--primary);
            transform: translateY(-2px);
            box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
        }

        .clip-thumb-wrap {
            width: 100%;
            aspect-ratio: 16/9;
            position: relative;
            background: #000;
            overflow: hidden;
        }

        .clip-thumb {
            width: 100%;
            height: 100%;
            object-fit: cover;
            transition: transform 0.3s;
        }

        .clip-card:hover .clip-thumb {
            transform: scale(1.04);
        }

        .clip-info {
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 6px;
            flex: 1;
        }

        .clip-title {
            font-size: 13px;
            font-weight: 600;
            color: #ffffff;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .clip-meta-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 11px;
            color: var(--text-muted);
        }

        .clip-views {
            display: flex;
            align-items: center;
            gap: 4px;
            font-weight: 600;
            color: var(--primary);
        }

        .clip-actions {
            display: flex;
            gap: 8px;
            padding: 0 12px 12px;
        }

        .clip-action-btn {
            flex: 1;
            padding: 8px;
            font-size: 11px;
            font-weight: 700;
            border-radius: var(--radius-sm);
            border: 1px solid var(--border-color);
            background: rgba(255, 255, 255, 0.02);
            color: var(--text-muted);
            cursor: pointer;
            transition: var(--transition);
            font-family: inherit;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
        }

        .clip-action-btn:hover {
            border-color: var(--primary);
            color: #fff;
            background: rgba(245, 197, 24, 0.05);
        }

        .clip-action-btn.primary {
            background: var(--primary);
            border-color: var(--primary);
            color: #000;
        }

        .clip-action-btn.primary:hover {
            background: var(--primary-hover);
        }

        .empty-state {
            grid-column: 1 / -1;
            text-align: center;
            padding: 60px 20px;
            color: var(--text-muted);
            font-size: 13px;
        }

        /* Editor container */
        .editor-container {
            display: flex;
            gap: 24px;
            flex: 1;
        }

        .editor-main-col {
            flex: 1;
            display: flex;
            flex-direction: column;
            gap: 16px;
            min-width: 0;
        }

        .editor-side-col {
            width: 280px;
            flex-shrink: 0;
            display: flex;
            flex-direction: column;
            gap: 16px;
        }

        .card-bg {
            background: var(--bg-panel);
            border: 1px solid var(--border-color);
            border-radius: var(--radius-lg);
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .label-text {
            font-size: 11px;
            font-weight: 800;
            text-transform: uppercase;
            color: var(--text-muted);
            letter-spacing: 0.5px;
        }

        .row-space {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .editor-canvas-wrap {
            position: relative;
            width: 100%;
            aspect-ratio: 16/9;
            background: #000;
            border-radius: var(--radius-lg);
            overflow: hidden;
            border: 1px solid var(--border-color);
        }

        .editor-video {
            width: 100%;
            height: 100%;
            object-fit: contain;
        }

        .crop-box {
            position: absolute;
            border: 2px dashed rgba(255, 255, 255, 0.4);
            cursor: move;
            border-radius: 4px;
        }

        .crop-box.camera {
            border-color: var(--success);
        }

        .crop-box.gameplay {
            border-color: #3b82f6;
        }

        .crop-handle {
            position: absolute;
            width: 10px;
            height: 10px;
            background: #fff;
            border-radius: 2px;
        }

        .crop-handle.tl { top: -5px; left: -5px; cursor: nwse-resize; }
        .crop-handle.tr { top: -5px; right: -5px; cursor: nesw-resize; }
        .crop-handle.bl { bottom: -5px; left: -5px; cursor: nesw-resize; }
        .crop-handle.br { bottom: -5px; right: -5px; cursor: nwse-resize; }

        .crop-label {
            position: absolute;
            top: 4px;
            left: 6px;
            font-size: 9px;
            font-weight: 800;
            color: #fff;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            background: rgba(0, 0, 0, 0.6);
            padding: 2px 4px;
            border-radius: 3px;
            pointer-events: none;
        }

        .timeline-editor-panel {
            background: var(--bg-panel);
            border: 1px solid var(--border-color);
            border-radius: var(--radius-lg);
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }

        .timeline-playback-bar {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px 16px;
            border-bottom: 1px solid var(--border-color);
        }

        .nle-timeline {
            display: flex;
            overflow-x: auto;
            height: 120px;
            background: #0c0c0e;
        }

        .nle-headers {
            width: 60px;
            flex-shrink: 0;
            display: flex;
            flex-direction: column;
            border-right: 1px solid var(--border-color);
        }

        .nle-header-spacer {
            height: 24px;
            border-bottom: 1px solid var(--border-color);
        }

        .nle-header-row {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 10px;
            font-weight: 700;
            color: var(--text-muted);
            border-bottom: 1px solid var(--border-color);
            gap: 4px;
        }

        .track-badge {
            font-size: 8px;
            font-weight: 800;
            padding: 2px 4px;
            border-radius: 3px;
            font-family: monospace;
        }

        .track-badge.v1 { background: rgba(34, 197, 94, 0.15); color: var(--success); }
        .track-badge.a1 { background: rgba(59, 130, 246, 0.15); color: #3b82f6; }

        .nle-tracks-container {
            flex: 1;
            display: flex;
            flex-direction: column;
            position: relative;
            min-width: 600px;
        }

        .nle-ruler {
            height: 24px;
            border-bottom: 1px solid var(--border-color);
            position: relative;
            background: rgba(255, 255, 255, 0.01);
        }

        .nle-track-row {
            flex: 1;
            position: relative;
            border-bottom: 1px solid rgba(255, 255, 255, 0.02);
        }

        .timeline-clip-block {
            position: absolute;
            top: 4px;
            bottom: 4px;
            left: 0;
            right: 0;
            background: linear-gradient(135deg, rgba(34, 197, 94, 0.2), rgba(34, 197, 94, 0.08));
            border: 1px solid rgba(34, 197, 94, 0.3);
            border-radius: 4px;
            display: flex;
            align-items: center;
            overflow: hidden;
            cursor: ew-resize;
        }

        .timeline-clip-block.audio {
            background: linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(59, 130, 246, 0.08));
            border-color: rgba(59, 130, 246, 0.3);
        }

        .timeline-playhead-line {
            position: absolute;
            top: 0;
            bottom: 0;
            width: 2px;
            background: var(--primary);
            pointer-events: none;
            z-index: 10;
        }

        .timeline-hidden-inputs {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .timeline-hidden-inputs input[type="range"] {
            width: 100%;
            accent-color: var(--primary);
        }

        .preview-portrait-wrap {
            width: 100%;
        }

        .preview-canvas {
            width: 100%;
            aspect-ratio: 9/16;
            background: #000;
            border-radius: var(--radius-lg);
            overflow: hidden;
            border: 1px solid var(--border-color);
            position: relative;
        }

        .preview-cam-area, .preview-game-area {
            position: relative;
            width: 100%;
            overflow: hidden;
            background: #111;
        }

        .preview-cam-area { height: 50%; border-bottom: 2px solid #000; }
        .preview-game-area { height: 50%; }

        .preview-video-element {
            width: 100%;
            height: 100%;
            object-fit: cover;
            position: absolute;
            top: 0;
            left: 0;
        }

        .preset-btn {
            flex: 1;
            padding: 10px;
            font-size: 12px;
            font-weight: 700;
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid var(--border-color);
            border-radius: var(--radius-md);
            color: var(--text-muted);
            cursor: pointer;
            transition: var(--transition);
            font-family: inherit;
        }

        .preset-btn.active {
            background: rgba(245, 197, 24, 0.1);
            border-color: var(--primary);
            color: #fff;
        }

        .portrait-caption {
            position: absolute;
            bottom: 40px;
            left: 10px;
            right: 10px;
            background: rgba(0, 0, 0, 0.8);
            border: 1px solid rgba(255, 255, 255, 0.15);
            padding: 6px 12px;
            border-radius: var(--radius-sm);
            color: #fff;
            font-size: 10px;
            font-weight: 700;
            text-align: center;
            z-index: 15;
            pointer-events: none;
            display: none;
        }

        .btn-primary-action {
            background: var(--primary);
            color: #000;
            border: none;
            padding: 14px;
            border-radius: var(--radius-md);
            font-family: inherit;
            font-size: 14px;
            font-weight: 800;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            transition: var(--transition);
            width: 100%;
        }

        .btn-primary-action:hover {
            background: var(--primary-hover);
        }

        /* Modals */
        .player-modal {
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.85);
            display: none;
            align-items: center;
            justify-content: center;
            z-index: 9999;
            backdrop-filter: blur(8px);
        }

        .player-modal.open {
            display: flex;
        }

        .player-modal-content {
            background: var(--bg-panel);
            border: 1px solid var(--border-color);
            border-radius: var(--radius-lg);
            width: min(800px, 90vw);
            overflow: hidden;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
        }

        .player-modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 14px 20px;
            border-bottom: 1px solid var(--border-color);
        }

        /* Toast Notifications */
        #toastContainer {
            position: fixed;
            bottom: 24px;
            right: 24px;
            z-index: 99999;
            display: flex;
            flex-direction: column;
            gap: 12px;
            pointer-events: none;
        }

        .toast-notification {
            background: rgba(24, 24, 27, 0.95);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: var(--radius-md);
            padding: 14px 20px;
            color: #fff;
            font-size: 13px;
            font-weight: 600;
            backdrop-filter: blur(12px);
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            gap: 12px;
            transform: translateX(120%);
            transition: transform 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.3s ease;
            pointer-events: auto;
            max-width: 380px;
            opacity: 0;
        }

        .toast-notification.show {
            transform: translateX(0);
            opacity: 1;
        }

        .toast-notification.success {
            border-left: 4px solid var(--success);
        }

        .toast-notification.error {
            border-left: 4px solid var(--danger);
        }

        .toast-notification.info {
            border-left: 4px solid var(--accent-cyan);
        }

        .toast-icon {
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
    </style>
</head>

<body>

    <div class="app-container">
        
        <!-- SIDEBAR (hidden by CSS, but keeping it in DOM for safety) -->
        <aside class="sidebar">
            <div class="logo-wrap">
                <h1 class="logo-text">CLIPS<span>.</span></h1>
            </div>
            <nav class="nav-menu">
                <button class="tab-btn active" onclick="switchTab('browserTab')">Clip Browser</button>
            </nav>
        </aside>

        <!-- MAIN CONTENT -->
        <main class="main-content">
            
            <header class="top-bar" style="display: flex; justify-content: space-between; align-items: center; padding: 14px 24px; gap: 16px; border-bottom: 1px solid var(--border-color); background: #050505;">
                <div style="display: flex; align-items: center; gap: 14px;">
                    <!-- Back button (shown only when NOT embedded) -->
                    <a href="/protected/panel.html" class="nav-link hub-back-btn" style="padding: 6px 12px; font-size: 12px; font-weight: 700; border: 1px solid var(--border-color); background: rgba(255,255,255,0.02); height: 32px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; border-radius: 8px;">
                        <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18"/></svg>
                        Hub
                    </a>
                    <div class="top-bar-title" style="font-size: 16px; font-weight: 800; color: #fff;">Stream Clipper</div>
                </div>

                <!-- Center: Tab Buttons -->
                <div class="top-bar-tabs" style="display: flex; gap: 6px; background: rgba(255,255,255,0.02); border: 1px solid var(--border-color); padding: 3px; border-radius: 20px;">
                    <button class="tab-btn active" onclick="switchTab('browserTab')" style="border-radius: 16px; height: 28px; padding: 0 16px; font-size: 12px; font-weight: 700; cursor: pointer; transition: all 0.2s; background: transparent; border: none; color: var(--text-muted); display: flex; align-items: center; gap: 6px;">
                        Clip Browser
                    </button>
                    <button class="tab-btn" id="editorTabBtn" onclick="switchTab('editorTab')" style="border-radius: 16px; height: 28px; padding: 0 16px; font-size: 12px; font-weight: 700; cursor: pointer; transition: all 0.2s; background: transparent; border: none; color: var(--text-muted); display: flex; align-items: center; gap: 6px;">
                        <span class="live-dot" style="margin: 0; width: 6px; height: 6px;"></span>
                        Clip Editor
                    </button>
                </div>

                <!-- Right elements: Search, TikTok, Agent -->
                <div style="display: flex; align-items: center; gap: 12px;">
                    <!-- Streamer Search capsule input -->
                    <div style="position: relative; display: flex; align-items: center; width: 280px;">
                        <svg style="position: absolute; left: 12px; width: 12px; height: 12px; fill: var(--text-muted); pointer-events: none;" viewBox="0 0 24 24">
                            <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
                        </svg>
                        <input type="text" id="streamerInput" class="text-input" placeholder="Streamer hinzufügen..." style="padding-left: 32px; padding-right: 36px; border-radius: 18px; height: 32px; font-size: 11px; background: rgba(0, 0, 0, 0.4); border: 1px solid var(--border-color); color: #fff; width: 100%;">
                        <button onclick="addStreamer()" style="position: absolute; right: 3px; background: var(--primary); border: none; color: #000; width: 26px; height: 26px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center;">
                            <svg width="10" height="10" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                        </button>
                    </div>

                    <!-- TikTok Status pill -->
                    <div style="display: flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 700; color: var(--text-muted); background: rgba(255,255,255,0.02); border: 1px solid var(--border-color); padding: 0 12px; border-radius: 16px; height: 32px; display: inline-flex; align-items: center;">
                        <span id="tiktokStatusText">Prüfe TikTok...</span>
                        <span id="tiktokStatusIndicator" class="conn-indicator" style="width: 6px; height: 6px; border-radius: 50%; background: #6b7280; display: inline-block;"></span>
                    </div>

                    <!-- Agent Status Indicator (Hidden since it doesn't work anyway) -->
                    <div style="display:none;">
                        <span id="agentGlobalStatus">LÄDT...</span>
                    </div>
                </div>
            </header>

            <div class="content-panel">
                
                <!-- Browser Tab Section -->
                <div id="browserTab" class="content-section active">
                    
                    <div class="clipper-layout">
                        <!-- Left Controls Column -->
                        <div class="clipper-sidebar">
                            
                            <!-- BLOCK 01: Streamer-Verwaltung & Twitch Control -->
                            <div class="baukasten-card">
                                <div class="baukasten-card-title">
                                    <span>Twitch Control</span>
                                </div>
                                <div style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;">Überwachte Kanäle</div>
                                <div class="streamer-list" id="streamerList" style="margin-bottom: 16px;"></div>
                                
                                <div style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 12px;">Zeitraum & Filter</div>
                                <div class="pills-group" style="margin-bottom: 8px;">
                                    <button class="pill-btn" data-val="24h" onclick="selectRange('24h')">24 Std</button>
                                    <button class="pill-btn" data-val="48h" onclick="selectRange('48h')">48 Std</button>
                                    <button class="pill-btn" data-val="72h" onclick="selectRange('72h')">72 Std</button>
                                    <button class="pill-btn active" data-val="7d" onclick="selectRange('7d')">7 Tage</button>
                                </div>
                                <div class="input-group" style="margin-bottom: 16px; display: flex; gap: 8px;">
                                    <input type="number" id="minViewsInput" class="text-input" value="100" style="padding: 6px 12px; font-size:12px; flex: 1; border: 1px solid var(--border-color); color: #fff; background: rgba(0,0,0,0.4); border-radius: 8px;">
                                    <button class="btn-load" onclick="loadClips()" style="margin: 0; font-size: 12px; padding: 6px 16px; width: auto; background: var(--primary); color: #000; border: none; font-weight: 700; border-radius: 8px; cursor: pointer;">Laden</button>
                                </div>

                                <!-- Twitch Clip Agent (Hidden since it doesn't work anyway) -->
                                <div style="display:none;">
                                    <button id="btnAgentStart" onclick="toggleGlobalAgent(true)"></button>
                                    <button id="btnAgentStop" onclick="toggleGlobalAgent(false)"></button>
                                </div>
                            </div>

                            <!-- BLOCK 05: DVR Live-Clipping -->
                            <div class="baukasten-card" id="manualClipPanel" style="display:none;">
                                <div class="baukasten-card-title">
                                    <span>DVR Live-Clipping</span>
                                    <span id="manualClipStatusBadge"></span>
                                </div>
                                
                                <div id="manualClipControls" style="display:none; flex-direction:column; gap:12px;">
                                    <div style="font-size: 12px; color: var(--text-muted); font-weight: 500;">
                                        Kanal: <span id="manualClipStreamerName" style="color: var(--primary); font-weight: bold;">Streamer</span>
                                    </div>
                                    <div style="display:flex; gap:6px; flex-wrap:wrap;">
                                        <button class="pill-btn" style="padding: 4px 8px; font-size:11px;" onclick="triggerManualClip(60)">1 Min</button>
                                        <button class="pill-btn" style="padding: 4px 8px; font-size:11px;" onclick="triggerManualClip(120)">2 Min</button>
                                        <button class="pill-btn" style="padding: 4px 8px; font-size:11px;" onclick="triggerManualClip(300)">5 Min</button>
                                        <button class="pill-btn" style="padding: 4px 8px; font-size:11px;" onclick="triggerManualClip(600)">10 Min</button>
                                        <button class="pill-btn" style="padding: 4px 8px; font-size:11px;" onclick="triggerManualClip(1200)">20 Min</button>
                                    </div>

                                    <!-- Benutzerdefinierter Zeitraum -->
                                    <div style="margin-top: 4px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.06); display:flex; flex-direction:column; gap:8px;">
                                        <div style="display:flex; gap:6px; align-items:flex-end;">
                                            <div style="flex:1; display:flex; flex-direction:column; gap:3px;">
                                                <span style="font-size: 9px; color: var(--text-muted); font-weight: 700;">START (vor Sek.)</span>
                                                <input type="number" id="customClipStart" class="text-input" style="background:rgba(0,0,0,0.3); height:28px; padding: 2px 6px; font-size: 11px;" value="180" min="10">
                                            </div>
                                            <div style="flex:1; display:flex; flex-direction:column; gap:3px;">
                                                <span style="font-size: 9px; color: var(--text-muted); font-weight: 700;">ENDE (vor Sek.)</span>
                                                <input type="number" id="customClipEnd" class="text-input" style="background:rgba(0,0,0,0.3); height:28px; padding: 2px 6px; font-size: 11px;" value="0" min="0">
                                            </div>
                                            <button class="btn-load" onclick="triggerCustomManualClip()" style="padding: 0 10px; margin: 0; font-size: 11px; height: 28px; width:auto; cursor:pointer; font-weight:bold;">Go</button>
                                        </div>
                                    </div>

                                    <!-- Automatische Verarbeitung / TikTok Posting (Hidden since it doesn't work anyway) -->
                                    <div style="display:none;">
                                        <input type="checkbox" id="autoTikTokRender">
                                        <input type="checkbox" id="autoTikTokPublish">
                                    </div>
                                    <div id="manualClipResult" style="display:none; padding:10px; margin-top:4px; background:rgba(34,197,94,0.1); border:1px solid rgba(34,197,94,0.3); border-radius:var(--radius-md); flex-direction:column; gap:8px;">
                                        <span style="color:var(--success); font-weight:700; font-size:12px; text-align:left;" id="manualClipSuccessMsg">Clip erstellt!</span>
                                        <div style="display:flex; gap:6px;" id="manualClipActionBtns"></div>
                                    </div>
                                </div>
                                
                                <div id="manualClipOffline" style="display:none; font-size: 12px; color: var(--text-muted); line-height: 1.4;">
                                    Der Streamer ist offline oder DVR inaktiv.
                                </div>
                            </div>

                            <!-- BLOCK 04: TikTok Verbindung -->
                            <div class="baukasten-card">
                                <div class="baukasten-card-title">
                                    <span>TikTok Verbindung</span>
                                </div>
                                <div style="display:flex; flex-direction:column; gap:8px; background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.08); border-radius:var(--radius-md); padding:12px;">
                                    <div style="display:flex; flex-direction:column; gap:4px;">
                                        <label style="font-size:10px; color:var(--text-muted); font-weight:700;">ACCOUNT NAME:</label>
                                        <input type="text" id="tiktokConnectAccount" class="text-input" value="default" placeholder="z.B. eliasn97_clips" style="padding:4px 8px; font-size:11px; background: rgba(0,0,0,0.4); border: 1px solid var(--border-color); color: #fff; border-radius: 6px;">
                                    </div>
                                    
                                    <div style="display:flex; gap:6px; margin: 4px 0;">
                                        <button type="button" class="pill-btn active" id="btnMethodQr" onclick="switchTiktokMethod('qr')" style="flex:1; font-size:10px; padding:4px 0; cursor:pointer;">QR-Code</button>
                                        <button type="button" class="pill-btn" id="btnMethodManual" onclick="switchTiktokMethod('manual')" style="flex:1; font-size:10px; padding:4px 0; cursor:pointer;">SessionID</button>
                                    </div>

                                    <!-- QR Login Section -->
                                    <div id="tiktokQrSection" style="display:flex; flex-direction:column; gap:6px;">
                                        <div id="tiktokActionArea" style="display:flex; flex-direction:column; gap:6px;">
                                            <button id="btnTiktokConnect" class="pill-btn" onclick="startTiktokQrLogin()" style="font-size:11px; padding:6px 0; cursor:pointer; background:rgba(6,182,212,0.1); border-color:var(--accent-cyan); color:#fff; margin:0;">QR Login starten</button>
                                            <button id="btnTiktokDisconnect" class="pill-btn" onclick="stopTiktokQrLogin()" style="font-size:11px; padding:6px 0; display:none; border-color:var(--danger); color:var(--danger); cursor:pointer; margin:0;">Abbrechen</button>
                                        </div>
                                        <div id="tiktokQrArea" style="display:none; flex-direction:column; align-items:center; margin-top:4px; background:rgba(0,0,0,0.2); padding:8px; border-radius:var(--radius-sm);">
                                            <img id="tiktokQrCodeImg" style="width:160px; height:160px; background:#fff; padding:6px; border-radius:4px;" src="">
                                            <div id="tiktokQrStatusText" style="font-size:10px; color:var(--warning); text-align:center; margin-top:6px; font-weight:600;">QR scannen...</div>
                                        </div>
                                    </div>

                                    <!-- Manual Login Section -->
                                    <div id="tiktokManualSection" style="display:none; flex-direction:column; gap:6px;">
                                        <div style="display:flex; flex-direction:column; gap:4px;">
                                            <label style="font-size:9px; color:var(--text-muted); font-weight:700;">SESSIONID COOKIE:</label>
                                            <input type="password" id="tiktokManualSessionId" class="text-input" placeholder="sessionid-Wert einfügen" style="padding:4px 8px; font-size:11px; background: rgba(0,0,0,0.4); border: 1px solid var(--border-color); color: #fff; border-radius: 6px;">
                                        </div>
                                        <div style="display:flex; gap:6px;">
                                            <button class="pill-btn" onclick="saveTiktokManualCookie()" style="flex:1; font-size:11px; padding:6px 0; cursor:pointer; background:rgba(34,197,94,0.1); border-color:var(--success); color:#fff; margin:0;">Speichern</button>
                                            <button id="btnTiktokManualDelete" class="pill-btn" onclick="disconnectTiktok()" style="flex:1; font-size:11px; padding:6px 0; display:none; border-color:var(--danger); color:var(--danger); cursor:pointer; margin:0;">Trennen</button>
                                        </div>
                                    </div>
                                    
                                    <!-- Global Disconnect Button -->
                                    <button id="btnTiktokGlobalDisconnect" class="pill-btn" onclick="disconnectTiktok()" style="font-size:11px; padding:6px 0; display:none; border-color:var(--danger); color:var(--danger); cursor:pointer; margin-top:4px; width:100%;">Verbindung trennen</button>

                                    <div id="tiktokStatusMsg" style="font-size:10px; color:var(--text-muted); line-height:1.3; margin-top:4px; display:none;"></div>
                                </div>
                            </div>

                            <!-- BLOCK 06 & 07: Pipeline & Queue -->
                            <div class="baukasten-card">
                                <div class="baukasten-card-title">
                                    <span>Pipeline & Queue</span>
                                </div>
                                
                                <!-- Render-Pipeline -->
                                <div id="processingPanel" style="display: flex; flex-direction: column;">
                                    <div style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; display:flex; justify-content:space-between; align-items:center;">
                                        <span>Render-Pipeline</span>
                                        <button class="pill-btn" onclick="clearProcessedRenders()" style="font-size:9px; padding:2px 6px; cursor:pointer; border-color:var(--danger); color:var(--danger); background:transparent; margin:0; width:auto;">Clear</button>
                                    </div>
                                    <div class="processing-list" id="processingList" style="margin-bottom: 16px; min-height: 40px; display: flex; flex-direction: column; gap: 8px;">
                                        <!-- Processing items injected here -->
                                    </div>
                                </div>

                                <!-- TikTok Upload Queue -->
                                <div style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 12px; display: flex; justify-content: space-between; align-items: center;">
                                    <span>TikTok Upload Queue</span>
                                </div>
                                <div class="processing-list" id="tiktokQueueList" style="max-height: 250px; overflow-y: auto;">
                                    <div style="font-size:12px; color:var(--text-muted); text-align:center; padding:10px;">Lade Warteschlange...</div>
                                </div>
                            </div>

                        </div>

                        <!-- Right Main Content Column -->
                        <div class="clipper-main">

                            <!-- Clip Library Section -->
                            <div class="clip-browser-section" style="margin: 0;">
                                <div class="section-header">
                                    <h2 class="section-title-large" id="gridTitle">0 Clip(s) gefunden — Clip auswählen</h2>
                                    <div class="clips-toggle-bar">
                                        <button class="pill-btn active" id="btnToggleTwitch" onclick="toggleClipSource('twitch')">Twitch-Clips</button>
                                        <button class="pill-btn" id="btnToggleLocal" onclick="toggleClipSource('local')">Lokale Aufnahmen</button>
                                    </div>
                                </div>

                                <!-- Grid -->
                                <div class="clips-grid" id="clipsGrid">
                                    <div class="empty-state" style="grid-column: 1/-1;">Gib Streamer an und klicke "Clips laden" um zu beginnen.</div>
                                </div>
                            </div>

                        </div>
                    </div>
                </div>

                <!-- Editor Tab Section -->
                <div id="editorTab" class="content-section">
                    <div class="row-space" style="margin-bottom: 20px;">
                        <h2 style="margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">Clip Bearbeiten <span style="color:var(--text-muted); font-weight:400;">(9:16)</span></h2>
                        <button class="pill-btn" style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); width: auto;" onclick="switchTab('browserTab')">
                            <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24" style="margin-right:6px;"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
                            Zurück
                        </button>
                    </div>

                    <div class="editor-container">
                        
                        <!-- Left Column: Draggable and Timeline -->
                        <div class="editor-main-col">
                            <div class="row-space">
                                <span class="label-text">Quelle (16:9)</span>
                            </div>
                            
                            <div class="editor-canvas-wrap" id="editorVideoContainer">
                                <video id="editorVideo" class="editor-video" playsinline></video>
                                
                                <div class="crop-box camera" id="camCropBox">
                                    <div class="crop-handle tl"></div>
                                    <div class="crop-handle tr"></div>
                                    <div class="crop-handle bl"></div>
                                    <div class="crop-handle br"></div>
                                    <span class="crop-label">Kamera</span>
                                </div>

                                <div class="crop-box gameplay" id="gameCropBox">
                                    <div class="crop-handle tl"></div>
                                    <div class="crop-handle tr"></div>
                                    <div class="crop-handle bl"></div>
                                    <div class="crop-handle br"></div>
                                    <span class="crop-label">Gameplay</span>
                                </div>
                            </div>

                            <!-- Timeline -->
                            <div class="timeline-editor-panel">
                                <div class="timeline-playback-bar">
                                    <button class="btn-icon" style="width:36px; height:36px; background:var(--primary); color:#000;" onclick="togglePlay()">
                                        <svg id="editorPlayIcon" style="width:16px; height:16px; fill:currentColor;" viewBox="0 0 24 24">
                                            <path d="M8 5v14l11-7z" />
                                        </svg>
                                    </button>
                                    <span id="editorTimeLabel" style="font-family: monospace; font-size: 13px; font-weight:600; color: #fff;">00:00 / 00:00</span>
                                    <div style="flex:1;"></div>
                                    <span id="trimDurationLabel" style="font-family: monospace; font-size: 12px; font-weight: 700; color: var(--success); background: rgba(34,197,94,0.1); padding:4px 8px; border-radius:4px;">0.0s</span>
                                </div>

                                <!-- Timeline Tracks -->
                                <div class="nle-timeline" id="timelineScrollArea">
                                    <div class="nle-headers">
                                        <div class="nle-header-spacer"></div>
                                        <div class="nle-header-row">
                                            <span class="track-badge v1">V1</span> Video
                                        </div>
                                        <div class="nle-header-row">
                                            <span class="track-badge a1">A1</span> Audio
                                        </div>
                                    </div>
                                    <div class="nle-tracks-container" id="timelineTracksContainer">
                                        <!-- Time ruler -->
                                        <div class="nle-ruler" id="timelineRuler"></div>
                                        
                                        <!-- Video track -->
                                        <div class="nle-track-row">
                                            <div class="timeline-clip-block" id="timelineVideoBlock">
                                                <div style="padding:4px 8px; font-size:10px; font-weight:700; color:#fff; display:flex; align-items:center; gap:6px; overflow:hidden; white-space:nowrap;">
                                                    <svg style="width:12px; height:12px; fill:currentColor;" viewBox="0 0 24 24"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>
                                                    <span id="timelineClipFilenameText">clip.mp4</span>
                                                </div>
                                            </div>
                                        </div>

                                        <!-- Audio track -->
                                        <div class="nle-track-row">
                                            <div class="timeline-clip-block audio" id="timelineAudioBlock">
                                                <div style="padding:4px 8px; font-size:10px; font-weight:700; color:#fff; display:flex; align-items:center; gap:6px;">
                                                    <svg style="width:12px; height:12px; fill:currentColor;" viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
                                                    Audio
                                                </div>
                                            </div>
                                        </div>

                                        <!-- Playhead vertical line -->
                                        <div class="timeline-playhead-line" id="timelinePlayhead"></div>
                                    </div>
                                </div>
                                
                                <div style="padding: 12px 16px; background: rgba(255,255,255,0.02);">
                                    <div class="timeline-hidden-inputs">
                                        <input type="range" id="trimStartInput" min="0" max="100" step="0.1" value="0">
                                        <input type="range" id="trimEndInput" min="0" max="100" step="0.1" value="100">
                                    </div>
                                    <div style="display:flex; justify-content:space-between; margin-top:8px; font-family:monospace; font-size:11px; color:var(--text-muted);">
                                        <span>Start: <strong id="trimStartVal" style="color: var(--success);">0.0s</strong></span>
                                        <span>Ende: <strong id="trimEndVal" style="color: var(--danger);">0.0s</strong></span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- Right Column: Live Portrait Stacked Preview & Layout Settings -->
                        <div class="editor-side-col">
                            <div class="row-space">
                                <span class="label-text">Ziel (9:16 Vorschau)</span>
                                <span style="background: rgba(34,197,94,0.15); border:1px solid rgba(34,197,94,0.3); color: var(--success); font-size:9px; font-weight:800; padding:2px 6px; border-radius:4px; display:flex; align-items:center; gap:4px;">
                                    <span style="width:6px; height:6px; background:var(--success); border-radius:50%; animation:pulse 1.5s infinite;"></span> LIVE
                                </span>
                            </div>

                            <div class="preview-portrait-wrap">
                                <div class="preview-canvas" id="portraitPreviewContainer">
                                    <div class="preview-bg-area" id="previewBgArea" style="display: none; position: absolute; top: 0; left: 0; width: 100%; height: 100%; overflow: hidden; filter: blur(20px) brightness(0.6);">
                                        <video id="previewVideoBg" class="preview-video-element" playsinline muted style="width: 100%; height: 100%; object-fit: cover; left: 0; top: 0; transform: none;"></video>
                                    </div>
                                    <div class="preview-cam-area" id="previewCamArea">
                                        <video id="previewVideoCam" class="preview-video-element" playsinline muted></video>
                                    </div>
                                    <div class="preview-game-area" id="previewGameArea">
                                        <video id="previewVideoGame" class="preview-video-element" playsinline muted></video>
                                    </div>
                                    <div class="preview-logo-area" id="previewLogoArea" style="display: none; position: absolute; bottom: 45px; left: 50%; transform: translateX(-50%); width: 140px; z-index: 10; pointer-events: none;">
                                        <img src="../public/logo_minusnd.png" style="width:100%; display:block;" />
                                    </div>
                                    <div class="portrait-caption" id="portraitTextOverlay"></div>
                                </div>
                            </div>

                            <!-- Layout Preset Selector -->
                            <div class="card-bg" style="display:flex; flex-direction:column; gap:12px;">
                                <span class="label-text">Layout Preset</span>
                                <div style="display:flex; gap:8px;">
                                    <button type="button" id="presetSplitBtn" class="preset-btn active">
                                        Standard Split
                                    </button>
                                    <button type="button" id="presetBlurBtn" class="preset-btn">
                                        Blur Background
                                    </button>
                                    <button type="button" id="presetBlurLogoBtn" class="preset-btn">
                                        Blur & Logo
                                    </button>
                                </div>
                            </div>

                            <!-- Split Layout Settings (Visible only when preset is split) -->
                            <div class="card-bg" id="splitSettingsCard">
                                <div class="row-space" style="margin-bottom: 12px;">
                                    <span class="label-text">Verhältnis</span>
                                    <span id="layoutRatioLabel" style="font-family:monospace; font-size:11px; font-weight:700; color: #fff;">Cam 50% / Game 50%</span>
                                </div>
                                <div style="display:flex; align-items:center; gap:10px;">
                                    <span style="font-size:10px; color:var(--text-muted); font-weight:700;">CAM</span>
                                    <input type="range" id="layoutRatioInput" min="20" max="80" step="1" value="50" style="flex:1; accent-color: #f0abfc; cursor:pointer;">
                                    <span style="font-size:10px; color:var(--text-muted); font-weight:700;">GAME</span>
                                </div>
                            </div>

                            <!-- Subtitles -->
                            <div class="card-bg" style="display:flex; flex-direction:column; gap:12px;">
                                <div class="row-space">
                                    <span class="label-text">Titel-Overlay</span>
                                    <label class="toggle-switch" style="display:flex; align-items:center; gap:8px; font-size:12px; color:#fff; cursor:pointer; font-weight:600;">
                                        <input type="checkbox" id="textOverlayEnable" style="accent-color: var(--primary); width:16px; height:16px;">
                                        Aktiv
                                    </label>
                                </div>
                                <div id="textOverlayFields" style="display:none; flex-direction:column; gap:12px; margin-top:4px;">
                                    <div style="display:flex; flex-direction:column; gap:6px;">
                                        <input type="text" id="textOverlayContent" class="text-input" style="background:rgba(0,0,0,0.3); border-color:var(--border-color);" placeholder="Z.B. Krankes Gameplay! 🔥">
                                    </div>
                                    <div style="display:flex; gap:12px;">
                                        <div style="flex:1; display:flex; flex-direction:column; gap:6px;">
                                            <span style="font-size:10px; color:var(--text-muted); font-weight:700;">Erscheint ab (s)</span>
                                            <input type="number" id="textOverlayStart" class="text-input" style="background:rgba(0,0,0,0.3); border-color:var(--border-color);" min="0" step="0.5" value="1.0">
                                        </div>
                                        <div style="flex:1; display:flex; flex-direction:column; gap:6px;">
                                            <span style="font-size:10px; color:var(--text-muted); font-weight:700;">Dauer (s)</span>
                                            <input type="number" id="textOverlayDuration" class="text-input" style="background:rgba(0,0,0,0.3); border-color:var(--border-color);" min="1" step="0.5" value="5.0">
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <!-- TikTok Auto-Publish Options (Hidden since it doesn't work anyway) -->
                            <div style="display:none;">
                                <input type="checkbox" id="editorAutoTiktokPublish">
                                <input type="text" id="editorTiktokAccount" value="default">
                                <div id="editorTiktokPublishFields"></div>
                            </div>

                            <div style="flex:1;"></div>
                            <button class="btn-primary-action" onclick="renderPortrait()" style="padding: 16px;">
                                <svg style="width:18px; height:18px; fill:currentColor;" viewBox="0 0 24 24"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4zM14 13h-3v3H9v-3H6v-2h3V8h2v3h3v2z"/></svg>
                                Clip Rendern (MP4)
                            </button>
                        </div>
                    </div>
                </div>

            </div>

        </main>
        
    </div>

    <!-- HTML5 & Twitch Embed Video Player Modal -->
    <div class="player-modal" id="playerModal">
        <div class="player-modal-content">
            <div class="player-modal-header">
                <h3 id="playerModalTitle" style="font-size: 15px; font-weight: 700;">Clip ansehen</h3>
                <button class="btn-icon" style="width:28px; height:28px; background:rgba(255,255,255,0.05);" onclick="closePlayerModal()">
                    <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            </div>
            <div style="width:100%; aspect-ratio:16/9; position:relative; background:#000;">
                <video id="modalVideoPlayer" style="width:100%; height:100%; display:block;" controls></video>
                <iframe id="modalTwitchPlayer" style="width:100%; height:100%; display:none; border:none;" allowfullscreen></iframe>
            </div>
        </div>
    </div>

    <!-- TOAST NOTIFICATION CONTAINER -->
    <div id="toastContainer"></div>

    <script>
        if (window.self !== window.top) {
            document.body.classList.add('is-embedded');
        }
    </script>
`;

// Concatenate and write
fs.writeFileSync(outPath, htmlContent + jsContent, 'utf8');
console.log("clipper.html successfully built with new premium theme!");
process.exit(0);
