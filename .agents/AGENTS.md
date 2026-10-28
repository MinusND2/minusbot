# Project Rules for MinusBot

## YouTube & TikTok Upload Code Freeze
- **Do NOT modify, edit, or delete** any of the YouTube or TikTok upload logic, endpoints, session directories, or credential helper functions in `backend/server.js` or `protected/clipper.html`.
- This code freeze specifically covers:
  - `runYoutubeUploadOnServer` (both API-based and Puppeteer fallback paths)
  - `runTikTokUploadOnServer`
  - `findYoutubeSessionFile` (case-insensitive file lookup helper)
  - Google OAuth / Callback routes (`/bot/auth/youtube` and `/bot/auth/youtube/callback`)
  - Status endpoints (`/api/clipper/youtube/status`, `/api/clipper/tiktok/qr/status`, etc.)
  - Disconnect endpoints (`/api/clipper/youtube/disconnect`, `/api/clipper/tiktok/disconnect`)
- These uploading components are fully tested and functional. Focus all future edits strictly on the clipper/cutter frontend rendering, editor, or Twitch API components without touching the upload routines.
