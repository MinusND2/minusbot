@echo off
title BINGO DEPLOYER
color 0A
echo ==============================================================
echo       STARTE ÜBERTRAGUNG ZU MINUSND.DE (PER SECURE COPY)
echo       Bitte gib gleich dein Server-Passwort ein (falls gefragt)!
echo ==============================================================
echo.
scp index.html root@87.106.195.67:/var/www/bingo/
scp -r public root@87.106.195.67:/var/www/bingo/
scp -r protected root@87.106.195.67:/var/www/bingo/
echo.
echo ==============================================================
echo       FERTIG! Drücke eine Taste zum Schließen.
echo ==============================================================
pause > nul
