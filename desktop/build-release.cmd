@echo off
setlocal enabledelayedexpansion
rem Build + signe + prepare le manifeste updater d'une release Windows.
rem
rem Depuis le 2026-09-08 la sortie est un INSTALLEUR NSIS (par utilisateur, sans
rem droits admin) et non plus un exe portable : l'app s'installe dans
rem %LOCALAPPDATA%\Programs, extrait son code dans %LOCALAPPDATA%\WLED-Fleet\app
rem et garde ses donnees dans Documents\WLED Fleet.
rem
rem La signature minisign est faite par le bundler lui-meme des que la cle est
rem dans l'environnement (TAURI_SIGNING_PRIVATE_KEY) : plus de `signer sign` a
rem la main, l'installeur et son .sig sortent ensemble.
rem
rem A lancer depuis ce dossier (desktop\). Resultat dans ..\release\.
rem Prerequis : la cle de signature updater (generee une fois avec
rem   cargo tauri signer generate -w %%USERPROFILE%%\.tauri\wled-fleet-updater.key
rem ) et cargo-tauri (cargo install tauri-cli --version "^2").
cd /d "%~dp0"

if not exist "%USERPROFILE%\.tauri\wled-fleet-updater.key" (
  echo ECHEC : cle de signature introuvable ^(%USERPROFILE%\.tauri\wled-fleet-updater.key^).
  echo         La perdre = plus aucune app installee ne pourra se mettre a jour.
  exit /b 1
)
if not exist "%USERPROFILE%\.tauri\wled-fleet-updater.pass" (
  echo ECHEC : mot de passe de la cle introuvable ^(%USERPROFILE%\.tauri\wled-fleet-updater.pass^).
  exit /b 1
)

for /f "delims=" %%V in ('powershell -NoProfile -Command "(Get-Content tauri.conf.json | ConvertFrom-Json).version"') do set "VER=%%V"
set /p KEYPASS=<"%USERPROFILE%\.tauri\wled-fleet-updater.pass"
rem la variable accepte un CHEMIN de cle : la lire ligne a ligne en cmd ne
rem donnerait que la derniere ligne du fichier (une cle minisign en fait deux)
set "TAURI_SIGNING_PRIVATE_KEY=%USERPROFILE%\.tauri\wled-fleet-updater.key"
set "TAURI_SIGNING_PRIVATE_KEY_PASSWORD=%KEYPASS%"

echo ==============================================================
echo  [1/3] Compilation + installeur NSIS ^(cargo tauri build^)
echo         l'app est embarquee dedans par build.rs, la signature
echo         minisign est faite au passage
echo ==============================================================
cargo tauri build
if errorlevel 1 (echo ECHEC etape 1/3 : cargo tauri build. & exit /b 1)

echo.
echo ==============================================================
echo  [2/3] Recuperation des artefacts
echo ==============================================================
if not exist "..\release" mkdir "..\release"
set "NSIS=target\release\bundle\nsis"
rem le bundler nomme l'artefact d'apres productName, donc avec une espace
rem ("WLED Fleet_x.y.z_x64-setup.exe") : on le renomme en tiret pour l'URL de
rem telechargement. La signature porte sur le CONTENU, renommer ne l'invalide pas.
set "BUILT=WLED Fleet_%VER%_x64-setup.exe"
set "SETUP=WLED-Fleet_%VER%_x64-setup.exe"
if not exist "%NSIS%\%BUILT%" (
  echo ECHEC : installeur introuvable ^(%NSIS%\%BUILT%^). Contenu du dossier :
  dir /b "%NSIS%" 2>nul
  exit /b 1
)
if not exist "%NSIS%\%BUILT%.sig" (
  echo ECHEC : signature absente ^(%NSIS%\%BUILT%.sig^) ??? la cle de signature n'a pas ete prise en compte,
  echo         l'updater refuserait la mise a jour. Verifier TAURI_SIGNING_PRIVATE_KEY.
  exit /b 1
)
copy /y "%NSIS%\%BUILT%" "..\release\%SETUP%" >nul
copy /y "%NSIS%\%BUILT%.sig" "..\release\%SETUP%.sig" >nul
echo ..\release\%SETUP%

echo.
echo ==============================================================
echo  [3/3] Manifeste updater ^(latest.json^)
echo ==============================================================
node ..\tools\make-latest-json.js
if errorlevel 1 (echo ECHEC etape 3/3 : latest.json. & exit /b 1)

echo.
echo ==============================================================
echo  TERMINE. Publier le code source ^(depot public, transparence^) :
echo    node ..\tools\publish-to-github.js
echo  Publier la release ^(3 fichiers^) :
echo    gh release create v%VER% ..\release\%SETUP% ..\release\%SETUP%.sig ..\release\latest.json --repo Tensegrity-Lighting-Service/WLED-Fleet --title "WLED Fleet %VER%" --notes "voir README"
echo ==============================================================
