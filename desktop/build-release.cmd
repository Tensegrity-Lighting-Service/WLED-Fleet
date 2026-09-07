@echo off
setlocal enabledelayedexpansion
rem Build + signe + prepare le manifeste updater d'une release Windows : UN SEUL
rem exe (l'app est compilee dedans, voir build.rs + include_dir! dans main.rs ;
rem elle se reextrait toute seule a cote de l'exe au premier lancement). Pas de
rem zip, pas d'installateur. A lancer depuis ce dossier (desktop\). Resultat
rem dans ..\release\.
rem
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

echo ==============================================================
echo  [1/4] Compilation ^(cargo build --release^) -- l'app est embarquee
echo         dedans par build.rs, rien d'autre a assembler
echo ==============================================================
cargo build --release
if errorlevel 1 (echo ECHEC etape 1/4 : cargo build. & exit /b 1)

echo.
echo ==============================================================
echo  [2/4] Renommage ^(l'asset de la release^)
echo ==============================================================
for /f "delims=" %%V in ('powershell -NoProfile -Command "(Get-Content tauri.conf.json | ConvertFrom-Json).version"') do set "VER=%%V"
if not exist "..\release" mkdir "..\release"
set "EXE=..\release\WLED-Fleet_%VER%_windows.exe"
copy /y "target\release\wled-fleet-desktop.exe" "%EXE%" >nul
echo %EXE%

echo.
echo ==============================================================
echo  [3/4] Signature ^(minisign, cle hors depot^)
echo ==============================================================
set /p KEYPASS=<"%USERPROFILE%\.tauri\wled-fleet-updater.pass"
cargo tauri signer sign -f "%USERPROFILE%\.tauri\wled-fleet-updater.key" -p "%KEYPASS%" "%EXE%"
if errorlevel 1 (echo ECHEC etape 3/4 : signature. & exit /b 1)

echo.
echo ==============================================================
echo  [4/4] Manifeste updater ^(latest.json^)
echo ==============================================================
node ..\tools\make-latest-json.js
if errorlevel 1 (echo ECHEC etape 4/4 : latest.json. & exit /b 1)

echo.
echo ==============================================================
echo  TERMINE. Publier le code source ^(dépôt public, transparence^) :
echo    node ..\tools\publish-to-github.js
echo  Publier la release ^(3 fichiers -- l'exe EST le telechargement^) :
echo    gh release create v%VER% ..\release\WLED-Fleet_%VER%_windows.exe ..\release\WLED-Fleet_%VER%_windows.exe.sig ..\release\latest.json --repo Tensegrity-Lighting-Service/WLED-Fleet --title "WLED Fleet %VER%" --notes "voir README"
echo ==============================================================
