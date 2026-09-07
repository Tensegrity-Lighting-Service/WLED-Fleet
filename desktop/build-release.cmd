@echo off
setlocal enabledelayedexpansion
rem Build + signe + prepare le manifeste updater d'une release Windows portable
rem (pas d'installateur : un .zip du dossier applicatif + un exe fraichement
rem compile). A lancer depuis ce dossier (desktop\). Resultat dans ..\release\.
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
echo  [1/5] Compilation (cargo build --release)
echo ==============================================================
cargo build --release
if errorlevel 1 (echo ECHEC etape 1/5 : cargo build. & exit /b 1)

echo.
echo ==============================================================
echo  [2/5] Checkout public a jour (code source, sans l'exe)
echo ==============================================================
for /f "delims=" %%D in ('node ..\tools\publish-to-github.js --print-dir') do set "MIRROR=%%D"
node ..\tools\publish-to-github.js
if errorlevel 1 (echo ECHEC etape 2/5 : publish-to-github. & exit /b 1)

echo.
echo ==============================================================
echo  [3/5] Archive de la release ^(zip du dossier applicatif^)
echo ==============================================================
for /f "delims=" %%V in ('powershell -NoProfile -Command "(Get-Content tauri.conf.json | ConvertFrom-Json).version"') do set "VER=%%V"
if not exist "..\release" mkdir "..\release"
copy /y "target\release\wled-fleet-desktop.exe" "%MIRROR%\WLED-Fleet.exe" >nul
set "ZIP=..\release\WLED-Fleet_%VER%_windows.zip"
if exist "%ZIP%" del "%ZIP%"
powershell -NoProfile -Command "Compress-Archive -Path '%MIRROR%\*' -DestinationPath '%ZIP%' -CompressionLevel Optimal"
if errorlevel 1 (echo ECHEC etape 3/5 : compression. & exit /b 1)
echo %ZIP%

echo.
echo ==============================================================
echo  [4/5] Signature ^(minisign, cle hors depot^)
echo ==============================================================
set /p KEYPASS=<"%USERPROFILE%\.tauri\wled-fleet-updater.pass"
cargo tauri signer sign -f "%USERPROFILE%\.tauri\wled-fleet-updater.key" -p "%KEYPASS%" "%ZIP%"
if errorlevel 1 (echo ECHEC etape 4/5 : signature. & exit /b 1)

echo.
echo ==============================================================
echo  [5/5] Manifeste updater ^(latest.json^)
echo ==============================================================
node ..\tools\make-latest-json.js
if errorlevel 1 (echo ECHEC etape 5/5 : latest.json. & exit /b 1)

echo.
echo ==============================================================
echo  TERMINE. Publier la release :
echo    gh release create v%VER% ..\release\WLED-Fleet_%VER%_windows.zip ..\release\WLED-Fleet_%VER%_windows.zip.sig ..\release\latest.json --repo Tensegrity-Lighting-Service/WLED-Fleet --title "WLED Fleet %VER%" --notes "voir README"
echo ==============================================================
