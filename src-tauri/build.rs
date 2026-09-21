use std::fs;
use std::path::Path;

fn npm_version() -> String {
    let raw = fs::read_to_string(Path::new("../package.json")).expect("read package.json");
    for line in raw.lines() {
        let line = line.trim().trim_end_matches(',');
        if let Some(rest) = line.strip_prefix("\"version\":") {
            let ver = rest.trim().trim_matches('"');
            if !ver.is_empty() {
                return ver.to_string();
            }
        }
    }
    panic!("package.json missing version");
}

fn sync_cargo_version(version: &str) {
    let path = Path::new("Cargo.toml");
    let raw = fs::read_to_string(path).expect("read Cargo.toml");
    let nl = if raw.contains("\r\n") { "\r\n" } else { "\n" };
    let mut out = String::new();
    let mut in_package = false;
    let mut changed = false;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_package = trimmed == "[package]";
        }
        if in_package && trimmed.starts_with("version") {
            let next = format!("version = \"{version}\"");
            if trimmed != next {
                changed = true;
            }
            out.push_str(&next);
            out.push_str(nl);
            continue;
        }
        out.push_str(line);
        out.push_str(nl);
    }
    if changed {
        fs::write(path, out).expect("write Cargo.toml");
    }
}

fn main() {
    println!("cargo:rerun-if-changed=../package.json");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    sync_cargo_version(&npm_version());
    tauri_build::build()
}
