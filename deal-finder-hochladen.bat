@echo off
title DEAL-FINDER HOCHLADEN
cd /d "%~dp0"
echo ===== 1/2: Backend hochladen und Server neu starten =====
node deploy_backend.js
echo.
echo ===== 2/2: Webseite hochladen =====
node deploy.js
echo.
echo ===== FERTIG - Fenster kann geschlossen werden =====
pause > nul
