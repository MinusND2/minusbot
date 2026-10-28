@echo off
title BERICHTSHEFT HOCHLADEN
cd /d "%~dp0"
echo ===== Berichtsheft-Assistent wird auf minusnd.de hochgeladen =====
node deploy_berichtsheft.js
echo.
echo ===== FERTIG - Fenster kann geschlossen werden =====
pause > nul
