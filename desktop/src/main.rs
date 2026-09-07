// WLED Fleet — native window (Tauri 2 / WebView2), same recipe as Lumitrack.
//
// The application (server.js, columns.js, static/index.html …) is baked into
// this binary at compile time (build.rs stages it into embed/, include_dir!
// below embeds it) and self-extracts next to the exe on first launch, or
// whenever the embedded version changes — see ensure_app_dir(). That's the
// whole point: GitHub Releases only ever has to offer ONE .exe, not a zip of
// loose files. This shell then only:
//   1. makes sure server.js & friends are there (extracting if needed),
//   2. starts `node server.js` hidden (no console), with WLED_FLEET_LAUNCHER=1
//      so the page's « Redémarrer le serveur » button works: node exits with
//      code 75 and this supervisor relaunches it at once,
//   3. opens a window on http://127.0.0.1:8792/ (the page retries by itself
//      until the server answers),
//   4. kills node when the window is closed.
// If a WLED Fleet server is already listening on the port (e.g. started by
// WLED-Fleet.cmd), it is reused and left running on exit.
// `windows_subsystem = "windows"` (hides the console) is a Windows-only
// attribute; the compiler silently ignores it on macOS/Linux, so no
// target_os cfg is needed here.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use include_dir::{include_dir, Dir};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Manager, RunEvent};
use tauri_plugin_updater::UpdaterExt;

const PORT: u16 = 8792;
const RESTART_EXIT_CODE: i32 = 75;
// build.rs stages the app into embed/ (from ../, minus dev/runtime-only stuff:
// desktop/, test/, snapshots/, firmware/, settings.json, known-nodes.json…)
// and stamps WF_APP_VERSION from tauri.conf.json (Cargo.toml's own version is
// internal-only, see its comment — deliberately not used as the freshness key).
static APP_FILES: Dir = include_dir!("$CARGO_MANIFEST_DIR/embed");
const APP_VERSION: &str = env!("WF_APP_VERSION");

/// Resolves `node` on PATH, with a couple of well-known fallback locations on
/// macOS: a GUI app launched from Finder does NOT inherit the shell's PATH
/// (unlike a Terminal-launched process), so `node` installed via Homebrew or
/// nvm is often invisible to it even though `node -v` works fine in a
/// terminal — a known Tauri/Electron gotcha, not a bug in this app.
fn find_node() -> Command {
    #[cfg(target_os = "macos")]
    {
        for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
            if Path::new(candidate).is_file() {
                return Command::new(candidate);
            }
        }
    }
    Command::new("node")
}

/// Writes the embedded app tree under `dst`, creating folders as needed.
/// Never touches anything else — settings.json, known-nodes.json, snapshots/,
/// firmware/, logs… simply aren't part of the embed (see build.rs), so a
/// re-extract (first run, or after an update) can never clobber local data.
fn extract_embedded(d: &Dir, dst: &Path) -> std::io::Result<()> {
    for file in d.files() {
        let target = dst.join(file.path());
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(target, file.contents())?;
    }
    for sub in d.dirs() {
        extract_embedded(sub, dst)?;
    }
    Ok(())
}

/// The app's folder: a `WLED-Fleet\` subfolder next to this exe, self-extracted
/// there if missing or out of date — never loose files dropped straight into
/// whatever folder (Downloads…) the exe happens to sit in. `WLED_FLEET_DIR`
/// (dev only) points at a live source tree instead and skips extraction
/// entirely — the escape hatch for editing server.js/static/* without losing
/// the changes to a re-extract on the next build; WLED-Fleet.cmd (console
/// launch) never goes through any of this, it always runs the folder's own
/// files (wherever that .cmd itself was placed).
fn ensure_app_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("WLED_FLEET_DIR") {
        let p = PathBuf::from(dir);
        if p.join("server.js").is_file() {
            return Some(p);
        }
    }
    let dir = std::env::current_exe().ok()?.parent()?.join("WLED-Fleet");
    let marker = dir.join(".wf-embedded-version");
    let up_to_date = std::fs::read_to_string(&marker).map(|v| v.trim() == APP_VERSION).unwrap_or(false);
    if !up_to_date {
        match extract_embedded(&APP_FILES, &dir) {
            Ok(()) => {
                let _ = std::fs::write(&marker, APP_VERSION);
            }
            Err(e) => eprintln!("WLED Fleet: extraction impossible : {e}"),
        }
    }
    if dir.join("server.js").is_file() {
        Some(dir)
    } else {
        None
    }
}

fn port_open() -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], PORT).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

fn spawn_node(dir: &Path) -> std::io::Result<Child> {
    let mut c = find_node();
    // WLED_FLEET_PARENT_PID: the server exits by itself if this window process
    // disappears without a clean close (killed from the task manager…)
    c.arg("server.js").current_dir(dir).env("WLED_FLEET_LAUNCHER", "1").env("WLED_FLEET_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c.spawn()
}

struct Sidecar {
    child: Mutex<Option<Child>>,
    stop: Mutex<bool>,
}

// ── Portable updater ─────────────────────────────────────────────────────────
// No installer, no zip: a release is just the signed exe (see
// desktop/build-release.cmd). `Update::download()` already verifies the
// minisign signature against the pubkey in tauri.conf.json against the raw
// exe bytes; we deliberately never call `Update::install()` (it expects a
// platform installer, which we don't have) and instead swap the running
// executable ourselves. The new exe re-extracts its own (newer) embedded
// files next to itself the moment it starts, via ensure_app_dir() above.
#[derive(Clone, serde::Serialize)]
struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let found = updater.check().await.map_err(|e| e.to_string())?;
    Ok(found.map(|u| UpdateInfo { version: u.version, notes: u.body }))
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?.ok_or("aucune mise à jour disponible")?;
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    swap_and_relaunch(&current_exe, &bytes).map_err(|e| e.to_string())?;
    // the supervisor's RunEvent::Exit handler stops node cleanly before quitting
    app.exit(0);
    Ok(())
}

/// Windows allows renaming a running executable's file (just not overwriting
/// it in place), so: rename the current exe aside as `<name>.old.exe`
/// (cleaned up on the next launch, see `main()`), write the new bytes in its
/// place, launch it, and let the caller exit this process. On macOS/Linux the
/// running binary's inode stays valid after its path is overwritten, so a
/// plain overwrite + relaunch is enough — left as the fallback branch below;
/// worth re-checking once this runs as a macOS .app bundle (a directory, not
/// a single file) rather than a bare binary.
fn swap_and_relaunch(current_exe: &Path, new_bytes: &[u8]) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        let old = current_exe.with_extension("old.exe");
        let _ = std::fs::remove_file(&old);
        std::fs::rename(current_exe, &old)?;
        std::fs::write(current_exe, new_bytes)?;
    }
    #[cfg(not(windows))]
    {
        std::fs::write(current_exe, new_bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(current_exe)?.permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(current_exe, perms)?;
        }
    }
    Command::new(current_exe).spawn()?;
    Ok(())
}

fn main() {
    // best-effort cleanup of a previous update's renamed-away executable: by
    // now nothing has it open any more
    if let Ok(exe) = std::env::current_exe() {
        let old = exe.with_extension("old.exe");
        if old.is_file() {
            let _ = std::fs::remove_file(&old);
        }
    }

    let reuse = port_open();
    let dir = if reuse { None } else { ensure_app_dir() };
    let sidecar = Arc::new(Sidecar { child: Mutex::new(None), stop: Mutex::new(false) });

    if !reuse {
        match dir {
            Some(dir) => {
                // supervisor thread: relaunch on exit code 75 (page's restart button)
                // or after a crash, stop when the window closes
                let sc = sidecar.clone();
                std::thread::spawn(move || loop {
                    match spawn_node(&dir) {
                        Ok(child) => {
                            *sc.child.lock().unwrap() = Some(child);
                            let status = loop {
                                if *sc.stop.lock().unwrap() { return; }
                                let mut guard = sc.child.lock().unwrap();
                                match guard.as_mut().map(|c| c.try_wait()) {
                                    Some(Ok(Some(st))) => break Some(st),
                                    Some(Ok(None)) => {}
                                    _ => break None,
                                }
                                drop(guard);
                                std::thread::sleep(Duration::from_millis(400));
                            };
                            if *sc.stop.lock().unwrap() { return; }
                            match status.and_then(|s| s.code()) {
                                Some(RESTART_EXIT_CODE) => continue,
                                Some(0) => return,
                                _ => std::thread::sleep(Duration::from_secs(5)),
                            }
                        }
                        Err(_) => { std::thread::sleep(Duration::from_secs(5)); }
                    }
                });
            }
            None => {
                // extraction failed and no leftover server.js either: the window
                // will show its own "can't connect" error
                eprintln!("WLED Fleet: impossible de préparer le dossier de l'application");
            }
        }
    }

    let sc = sidecar.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![check_update, install_update])
        .setup(move |app| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_title(if reuse { "WLED Fleet (serveur déjà lancé)" } else { "WLED Fleet" });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("erreur au démarrage de la fenêtre WLED Fleet")
        .run(move |_app, event| {
            if let RunEvent::Exit = event {
                *sc.stop.lock().unwrap() = true;
                if let Some(mut child) = sc.child.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
