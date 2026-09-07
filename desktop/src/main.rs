// WLED Fleet — native window (Tauri 2 / WebView2), same recipe as Lumitrack.
//
// The whole application lives in the parent folder as plain files
// (server.js, columns.js, static/index.html …). This shell only:
//   1. finds that folder (next to the exe, or the source tree in dev),
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

use std::io::Cursor;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Manager, RunEvent};
use tauri_plugin_updater::UpdaterExt;

const PORT: u16 = 8792;
const RESTART_EXIT_CODE: i32 = 75;

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

/// Folder holding server.js: the exe's folder (or up to 3 parents, so the
/// exe can also run from desktop/target/release), else the source tree.
fn app_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("WLED_FLEET_DIR") {
        let p = PathBuf::from(dir);
        if p.join("server.js").is_file() { return Some(p); }
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut d = exe.parent().map(Path::to_path_buf);
        for _ in 0..4 {
            if let Some(ref p) = d {
                if p.join("server.js").is_file() { return Some(p.clone()); }
                d = p.parent().map(Path::to_path_buf);
            }
        }
    }
    let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    if src.join("server.js").is_file() { return Some(src); }
    None
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
// No installer (no NSIS/MSI/dmg): a release is a signed .zip of the plain app
// folder (server.js, static/, …, and a freshly built exe named WLED-Fleet.exe
// — see desktop/build-release.cmd). `Update::download()` already verifies the
// minisign signature against the pubkey in tauri.conf.json; we deliberately
// never call `Update::install()` (it expects a platform installer, which we
// don't have) and instead extract the zip ourselves and copy it over this
// folder, then swap the running executable.
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
    let dir = app_dir().ok_or("dossier de l'application introuvable")?;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("aucune mise à jour disponible")?;
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    apply_update(&dir, bytes).map_err(|e| e.to_string())?;
    // the supervisor's RunEvent::Exit handler stops node cleanly before quitting
    app.exit(0);
    Ok(())
}

/// Extracts the release zip into a scratch folder, copies every file it
/// contains over `dir` (the zip only ever holds app code — the same
/// .gitignore-filtered fileset that gets published, so this never touches
/// settings.json / known-nodes.json / snapshots/ / firmware/ / logs — they
/// simply aren't in the zip), then swaps the running executable last.
fn apply_update(dir: &Path, bytes: Vec<u8>) -> std::io::Result<()> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| std::io::Error::other(format!("archive invalide : {e}")))?;
    let scratch = std::env::temp_dir().join(format!("wled-fleet-update-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    archive
        .extract(&scratch)
        .map_err(|e| std::io::Error::other(format!("extraction : {e}")))?;

    let current_exe = std::env::current_exe()?;
    let new_exe_in_scratch = scratch.join("WLED-Fleet.exe");
    copy_tree(&scratch, dir, &new_exe_in_scratch)?;

    if new_exe_in_scratch.is_file() {
        swap_and_relaunch(&current_exe, &new_exe_in_scratch)?;
    }
    let _ = std::fs::remove_dir_all(&scratch);
    Ok(())
}

/// Recursively copies `src` over `dst`, skipping `skip` (the new executable —
/// the currently running one can't be overwritten in place, see
/// `swap_and_relaunch`).
fn copy_tree(src: &Path, dst: &Path, skip: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        if from == skip {
            continue;
        }
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            std::fs::create_dir_all(&to)?;
            copy_tree(&from, &to, skip)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Windows allows renaming a running executable's file (just not overwriting
/// it in place), so: rename the current exe aside as `<name>.old.exe`
/// (cleaned up on the next launch, see `main()`), write the new one in its
/// place, launch it, and let the caller exit this process. On macOS/Linux the
/// running binary's inode stays valid after its path is overwritten, so a
/// plain overwrite + relaunch is enough — left as the fallback branch below;
/// worth re-checking once this runs as a macOS .app bundle (a directory, not
/// a single file) rather than a bare binary.
fn swap_and_relaunch(current_exe: &Path, new_exe: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        let old = current_exe.with_extension("old.exe");
        let _ = std::fs::remove_file(&old);
        std::fs::rename(current_exe, &old)?;
        std::fs::copy(new_exe, current_exe)?;
    }
    #[cfg(not(windows))]
    {
        std::fs::copy(new_exe, current_exe)?;
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
    let dir = app_dir();
    let reuse = port_open();
    let sidecar = Arc::new(Sidecar { child: Mutex::new(None), stop: Mutex::new(false) });

    // best-effort cleanup of a previous update's renamed-away executable: by
    // now nothing has it open any more
    if let Ok(exe) = std::env::current_exe() {
        let old = exe.with_extension("old.exe");
        if old.is_file() {
            let _ = std::fs::remove_file(&old);
        }
    }

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
                // no server.js found: the window will show the page's own error
                eprintln!("WLED Fleet: server.js introuvable à côté de l'exécutable");
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
