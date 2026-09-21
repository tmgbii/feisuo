use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    pub alg: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone)]
pub enum HostCheck {
    Match,
    Unknown,
    Mismatch(String),
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("ssh_known_hosts.json"))
}

fn load(app: &AppHandle) -> HashMap<String, KnownHost> {
    let Ok(p) = path(app) else {
        return HashMap::new();
    };
    let Ok(raw) = std::fs::read_to_string(p) else {
        return HashMap::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save(app: &AppHandle, map: &HashMap<String, KnownHost>) -> Result<(), String> {
    let p = path(app)?;
    std::fs::write(p, serde_json::to_string_pretty(map).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

pub fn host_id(host: &str, port: u16) -> String {
    format!("{host}:{port}")
}

pub fn check(app: &AppHandle, id: &str, fingerprint: &str) -> HostCheck {
    match load(app).get(id) {
        Some(known) if known.fingerprint == fingerprint => HostCheck::Match,
        Some(known) => HostCheck::Mismatch(known.fingerprint.clone()),
        None => HostCheck::Unknown,
    }
}

pub fn remember(app: &AppHandle, id: &str, alg: &str, fingerprint: &str) -> Result<(), String> {
    let mut map = load(app);
    map.insert(
        id.to_string(),
        KnownHost {
            alg: alg.to_string(),
            fingerprint: fingerprint.to_string(),
        },
    );
    save(app, &map)
}
