// Stages the plain-files app (server.js, static/, …) into desktop/embed/ before
// compiling, so main.rs can bake the whole thing into the exe with include_dir!
// (2026-09-07, single-exe portable distribution — no more zip of loose files).
// Runs on every `cargo build`/`check`, including a fresh CI checkout: it copies
// straight from the real ../ tree, no external mirror needed.
use std::fs;
use std::path::Path;

// not needed at runtime, or genuinely local/user data — never embedded
const EXCLUDE_DIRS: &[&str] = &["desktop", ".git", ".github", "node_modules", "test", "snapshots", "firmware", "release", "__pycache__"];
const EXCLUDE_FILES: &[&str] = &[
    "settings.json", "known-nodes.json", "led-profiles.json", ".gitignore",
    "changes.log", "changes-dev.log", "ap.json", "ap-dev.json", "rf-scans.log",
    "pairing.log", "wizard.json", "wizard-dev.json", "wizard-surveys.log",
    "wizard-live.log", "server-errors.log", "wizard-probe.log",
];

fn copy_app_files(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).expect("create embed dir");
    for entry in fs::read_dir(src).expect("read app dir") {
        let entry = entry.expect("dir entry");
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let ty = entry.file_type().expect("file type");
        if ty.is_dir() {
            if EXCLUDE_DIRS.contains(&name.as_ref()) {
                continue;
            }
            copy_app_files(&entry.path(), &dst.join(name.as_ref()));
        } else {
            // .exe (WLED-Fleet.exe / .old.exe next to server.js in a dev checkout)
            // would otherwise embed a stale copy of the launcher inside itself
            if EXCLUDE_FILES.contains(&name.as_ref()) || name.starts_with('.') || name.ends_with(".exe") || name.ends_with(".pyc") {
                continue;
            }
            fs::copy(entry.path(), dst.join(name.as_ref())).expect("copy app file");
        }
    }
}

fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let src = Path::new(&manifest_dir).join("..");
    let dst = Path::new(&manifest_dir).join("embed");
    let _ = fs::remove_dir_all(&dst);
    copy_app_files(&src, &dst);
    println!("cargo:rerun-if-changed={}", src.display());
    println!("cargo:rerun-if-changed={}", src.join("static").display());
    println!("cargo:rerun-if-changed={}", src.join("tools").display());
    println!("cargo:rerun-if-changed={}", src.join("docs").display());

    // single source of truth for the app version = tauri.conf.json, not Cargo.toml
    // (whose own [package].version is internal-only, see the comment in Cargo.toml)
    let conf = fs::read_to_string(Path::new(&manifest_dir).join("tauri.conf.json")).expect("read tauri.conf.json");
    let version = conf
        .lines()
        .find_map(|l| {
            let l = l.trim();
            l.strip_prefix("\"version\":").map(|rest| rest.trim().trim_matches(|c| c == '"' || c == ',').to_string())
        })
        .expect("version field in tauri.conf.json");
    println!("cargo:rustc-env=WF_APP_VERSION={version}");
    println!("cargo:rerun-if-changed=tauri.conf.json");

    tauri_build::build()
}
