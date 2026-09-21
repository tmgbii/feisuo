use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("state.json"))
}

#[tauri::command]
pub fn save_app_state(app: AppHandle, json: String) -> Result<(), String> {
    std::fs::write(state_path(&app)?, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_app_state(app: AppHandle) -> Result<Option<String>, String> {
    let path = state_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(std::fs::read_to_string(path).map_err(|e| e.to_string())?))
}
