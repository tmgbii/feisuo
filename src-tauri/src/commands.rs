use crate::events::{ConnectConfig, SendOpts, SerialPortInfo};
use crate::proto;
use crate::state::AppState;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn list_serial_ports() -> Result<Vec<SerialPortInfo>, String> {
    proto::serial::list_ports()
}

#[tauri::command]
pub fn connect_session(
    app: AppHandle,
    state: State<AppState>,
    session_id: String,
    config: ConnectConfig,
) -> Result<(), String> {
    proto::emit_status(&app, &session_id, "connecting", None);
    proto::start_session(app, &state, session_id, config)
}

#[tauri::command]
pub fn disconnect_session(
    app: AppHandle,
    state: State<AppState>,
    session_id: String,
) -> Result<(), String> {
    proto::stop_session(&state, &session_id);
    proto::emit_status(&app, &session_id, "disconnected", None);
    Ok(())
}

#[tauri::command]
pub async fn send_session(
    state: State<'_, AppState>,
    session_id: String,
    data: Vec<u8>,
    opts: Option<SendOpts>,
) -> Result<(), String> {
    proto::send_to_session(&state, &session_id, data, opts.unwrap_or_default()).await
}

#[tauri::command]
pub async fn mqtt_subscribe(
    state: State<'_, AppState>,
    session_id: String,
    topic: String,
    qos: u8,
) -> Result<(), String> {
    proto::mqtt_sub(&state, &session_id, topic, qos).await
}

#[tauri::command]
pub async fn mqtt_unsubscribe(
    state: State<'_, AppState>,
    session_id: String,
    topic: String,
) -> Result<(), String> {
    proto::mqtt_unsub(&state, &session_id, topic).await
}

#[tauri::command]
pub async fn kick_tcp_client(
    state: State<'_, AppState>,
    session_id: String,
    client_id: String,
) -> Result<(), String> {
    proto::kick_client(&state, &session_id, client_id).await
}

#[tauri::command]
pub fn ui_alive(state: State<AppState>) {
    state.touch_ui();
}

#[tauri::command]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}
