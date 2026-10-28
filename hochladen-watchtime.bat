@echo off
title MINUS WATCHTIME DEPLOYER
color 0C
echo ==============================================================
echo       STARTE ÜBERTRAGUNG VON MINUS WATCHTIME ZU MINUSND.DE
echo       Bitte gib gleich dein Server-Passwort ein (falls gefragt)!
echo ==============================================================
echo.

ssh root@87.106.195.67 "mkdir -p /var/www/watchtime /var/www/watchtime/public"
scp minus-watchtime/package.json root@87.106.195.67:/var/www/watchtime/
scp minus-watchtime/server.js root@87.106.195.67:/var/www/watchtime/
scp minus-watchtime/config.json root@87.106.195.67:/var/www/watchtime/
scp -r minus-watchtime/public/* root@87.106.195.67:/var/www/watchtime/public/

echo.
echo ==============================================================
echo       FERTIG! Der Watchtime-Code ist jetzt auf dem Server.
echo ==============================================================
pause > nul
