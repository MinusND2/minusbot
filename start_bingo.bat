@echo off
chcp 65001 > nul
cls
color 0E
cd /d "%~dp0"

:START
cls
echo.
echo ==============================================================
echo      BINGO STARTER v2.0 (MIT LOGIN HILFE)
echo ==============================================================
echo.
echo  SCHRITT 1: Server wird gestartet...
tasklist /FI "IMAGENAME eq node.exe" 2>NUL | find /I /N "node.exe">NUL
if "%ERRORLEVEL%"=="0" (
    echo  (Server laeuft bereits)
) else (
    start "Bingo Server (MINIMIERT)" /MIN node server.js
    timeout /t 2 > nul
    echo  (Erledigt)
)

echo.
echo  SCHRITT 2: Internet-Verbindung...
echo.
echo  BITTE WARTEN...
echo.
echo  ==============================================================
echo  SO FINDEST DU DEINE LINKS (Kopier dir das!):
echo.
echo  Sobald unten "Forwarding https://..." steht:
echo.
echo  1. BINGO SPIEL:       Der Link unten
echo  2. SCOREBOARD:        Der Link unten + /scoreboard.html
echo  3. ADMIN (BINGO):     Der Link unten + /admin
echo  4. ADMIN (TEAMS):     Der Link unten + /admin/scoreboard
echo.
echo     (Admin Login: Benutzer=admin, Passwort=bingo)
echo  ==============================================================
echo.
echo  Startet Loophole...
echo.

:: Check for loophole.exe
if not exist "loophole.exe" (
    echo FEHLER: loophole.exe fehlt!
    pause
    exit
)

:: Try to start loophole
.\loophole.exe http 3000

:: If we get here, loophole closed. Check exit code.
if %ERRORLEVEL% NEQ 0 (
    goto LOGIN_NEEDED
)

echo.
echo Programm wurde beendet.
pause
exit

:LOGIN_NEEDED
cls
color 0C
echo.
echo ==============================================================
echo               ACHTUNG: LOGIN ERFORDERLICH
echo ==============================================================
echo.
echo Loophole braucht eine kurze Anmeldung.
echo.
echo 1. Druecke gleich eine Taste.
echo 2. Ein Link wird angezeigt (oder Browser oeffnet sich).
echo 3. Gib den Code ein, der angezeigt wird.
echo.
echo Druecke eine Taste zum Starten der Anmeldung...
pause > nul

.\loophole.exe account login

echo.
echo Wenn du dich angemeldet hast, druecke eine Taste zum Neustart!
pause > nul
goto START