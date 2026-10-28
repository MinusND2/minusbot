@echo off
title Minus TikTok Auto-Uploader
cd /d "%~dp0"
echo ==========================================
echo    Minus TikTok Auto-Uploader Launcher
echo ==========================================
echo.
echo Installiere/Pruefe NodeJS-Abhaengigkeiten...
call npm.cmd install
echo.
echo Starte Web-Dashboard unter http://localhost:4002 ...
start http://localhost:4002
echo.
echo Starte Server...
node server.js
pause
