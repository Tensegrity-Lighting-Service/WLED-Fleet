@echo off
rem ── WLED Fleet : lanceur autonome ────────────────────────────────────────────
rem Double-clic = démarre le serveur (réglages dans settings.json) et ouvre la
rem page. Fermer cette fenêtre = arrêter. Le bouton « Redémarrer le serveur »
rem de la page (ou un POST /api/restart) fait sortir node avec le code 75 :
rem cette boucle le relance aussitôt avec les fichiers modifiés.
setlocal
title WLED Fleet
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js est introuvable. Installer Node.js 18 ou plus : https://nodejs.org/
  pause
  exit /b 1
)

set WLED_FLEET_LAUNCHER=1
set FIRST=1

:loop
if "%FIRST%"=="1" (
  set FIRST=0
  rem ouvre la page une fois le serveur prêt (3 s), dans le navigateur par défaut
  start "" /min cmd /c "timeout /t 3 /nobreak >nul && start http://127.0.0.1:8792/"
)
echo [%date% %time%] demarrage du serveur WLED Fleet
node server.js %*
if errorlevel 76 goto crashed
if errorlevel 75 (
  echo [%date% %time%] redemarrage demande
  goto loop
)
if errorlevel 1 goto crashed
echo serveur arrete.
exit /b 0

:crashed
echo.
echo Le serveur s'est arrete avec une erreur (code %errorlevel%). Relance dans 5 s, Ctrl+C pour abandonner.
timeout /t 5 >nul
goto loop
