# Crée un raccourci « WLED Fleet » sur le Bureau (et, avec -Autostart, une
# tâche planifiée qui lance le serveur à l'ouverture de session Windows).
#   powershell -ExecutionPolicy Bypass -File tools\install-shortcuts.ps1
#   powershell -ExecutionPolicy Bypass -File tools\install-shortcuts.ps1 -Autostart
#   powershell -ExecutionPolicy Bypass -File tools\install-shortcuts.ps1 -RemoveAutostart
param([switch]$Autostart, [switch]$RemoveAutostart, [switch]$NoWizard)

$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'WLED-Fleet.exe'          # fenêtre native (desktop/, Tauri) si compilée
$launcher = Join-Path $root 'WLED-Fleet.cmd'     # sinon : console réduite + navigateur
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'WLED Fleet.lnk'
$useExe = Test-Path $exe

$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($lnk)
$s.TargetPath = if ($useExe) { $exe } else { $launcher }
$s.WorkingDirectory = $root
$s.Description = 'WLED Fleet : grille de réglages, journal, mises à jour, antenne, appairage'
if ($useExe) { $s.IconLocation = "$exe,0"; $s.WindowStyle = 1 }
else { $s.IconLocation = "$env:SystemRoot\System32\shell32.dll,13"; $s.WindowStyle = 7 }
$s.Save()
Write-Host "Raccourci créé : $lnk -> $(if ($useExe) { 'WLED-Fleet.exe (fenêtre native)' } else { 'WLED-Fleet.cmd (console + navigateur)' })"

# Prérequis de la sonde WiFiman Wizard (Bluetooth) : Python 3.9+ et le module bleak.
# -NoWizard pour sauter cette étape (l'app propose aussi « Installer les prérequis » dans Antenne).
if (-not $NoWizard) {
  $py = $null
  foreach ($c in @(@('py', '-3'), @('python'), @('python3'))) {
    try { $v = & $c[0] @($c[1..($c.Length - 1)] | Where-Object { $_ }) -c 'import sys; print(sys.version.split()[0])' 2>$null; if ($LASTEXITCODE -eq 0 -and $v -match '^3\.(9|[1-9]\d)') { $py = $c; break } } catch {}
  }
  if (-not $py) {
    Write-Host 'Python 3 absent : installation par winget (Python.Python.3.12)…'
    try { winget install -e --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements | Out-Null } catch { Write-Host "winget indisponible : installer Python 3 depuis python.org (cocher « Add to PATH »), puis relancer ce script. $_" }
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    foreach ($c in @(@('py', '-3'), @('python'))) { try { & $c[0] @($c[1..($c.Length - 1)] | Where-Object { $_ }) -c 'import sys' 2>$null; if ($LASTEXITCODE -eq 0) { $py = $c; break } } catch {} }
  }
  if ($py) {
    $args = @($py[1..($py.Length - 1)] | Where-Object { $_ }) + @('-m', 'pip', 'install', '--user', '--upgrade', '--quiet', 'bleak')
    & $py[0] @args
    if ($LASTEXITCODE -eq 0) { Write-Host "Sonde WiFiman Wizard : Python ($($py -join ' ')) + bleak prêts." } else { Write-Host 'pip install bleak a échoué : réessayer depuis l''app (Antenne > Installer les prérequis).' }
  } else { Write-Host 'Sonde WiFiman Wizard : Python introuvable, à installer plus tard (facultatif).' }
}

$taskName = 'WLED Fleet'
if ($RemoveAutostart) {
  schtasks /Delete /TN $taskName /F | Out-Null
  Write-Host "Démarrage automatique retiré."
}
if ($Autostart) {
  # à l'ouverture de session, fenêtre réduite, dans le dossier de l'app
  $cmd = if ($useExe) { "`"$exe`"" } else { "cmd /c start `"WLED Fleet`" /min `"$launcher`"" }
  schtasks /Create /TN $taskName /SC ONLOGON /RL LIMITED /F /TR $cmd | Out-Null
  Write-Host "Démarrage automatique installé (tâche planifiée « $taskName », à l'ouverture de session)."
}
