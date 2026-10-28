@echo off
title BOT BACKEND DEPLOYER
color 0B
echo ==============================================================
echo       STARTE ÜBERTRAGUNG DES BOTS ZU MINUSND.DE
echo       Bitte gib gleich dein Server-Passwort ein (falls gefragt)!
echo ==============================================================
echo.

ssh root@87.106.195.67 "mkdir -p /var/www/bot"
scp backend/package.json root@87.106.195.67:/var/www/bot/
scp backend/server.js root@87.106.195.67:/var/www/bot/
scp backend/clipper.js root@87.106.195.67:/var/www/bot/
scp backend/.env root@87.106.195.67:/var/www/bot/
scp backend/serviceAccountKey.json root@87.106.195.67:/var/www/bot/
scp -r backend/car_analyzer root@87.106.195.67:/var/www/bot/

echo.
echo ==============================================================
echo       FERTIG! Der Bot-Code ist jetzt auf dem Server.
echo       Folge nun den Schritten in der Walkthrough-Anleitung!
echo ==============================================================
pause > nul
