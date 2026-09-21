use crate::events::{ConnectConfig, SendOpts, StatusPayload};
use crate::state::{AppState, LiveSession, Outgoing};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub mod batch;
pub mod mqtt;
pub mod serial;
pub mod tcp;
pub mod udp;
pub mod websocket;

pub fn emit_status(app: &AppHandle, session_id: &str, status: &str, error: Option<String>) {
    let _ = app.emit(
        "comm:status",
        StatusPayload {
            session_id: session_id.to_string(),
            status: status.to_string(),
            error,
        },
    );
}

pub fn start_session(
    app: AppHandle,
    state: &State<AppState>,
    session_id: String,
    config: ConnectConfig,
) -> Result<(), String> {
    stop_session(state, &session_id);

    let cancel = CancellationToken::new();
    let (outgoing_tx, outgoing_rx) = mpsc::channel::<Outgoing>(256);
    let (batch_tx, batch_rx) = mpsc::channel(1024);

    {
        let mut map = state
            .sessions
            .lock()
            .map_err(|_| "lock_failed".to_string())?;
        map.insert(
            session_id.clone(),
            LiveSession {
                cancel: cancel.clone(),
                outgoing: outgoing_tx,
            },
        );
    }

    batch::spawn_batcher(app.clone(), session_id.clone(), batch_rx, cancel.clone());

    match config {
        ConnectConfig::Serial { .. } => {
            serial::spawn(app, session_id, config, outgoing_rx, batch_tx, cancel);
        }
        ConnectConfig::Tcp { .. } => {
            tcp::spawn(app, session_id, config, outgoing_rx, batch_tx, cancel);
        }
        ConnectConfig::Udp { .. } => {
            udp::spawn(app, session_id, config, outgoing_rx, batch_tx, cancel);
        }
        ConnectConfig::Websocket { .. } => {
            websocket::spawn(app, session_id, config, outgoing_rx, batch_tx, cancel);
        }
        ConnectConfig::Mqtt { .. } => {
            mqtt::spawn(app, session_id, config, outgoing_rx, batch_tx, cancel);
        }
    }
    Ok(())
}

pub fn stop_session(state: &State<AppState>, session_id: &str) {
    if let Ok(mut map) = state.sessions.lock() {
        if let Some(live) = map.remove(session_id) {
            live.cancel.cancel();
        }
    }
}

pub async fn send_to_session(
    state: &State<'_, AppState>,
    session_id: &str,
    bytes: Vec<u8>,
    opts: SendOpts,
) -> Result<(), String> {
    let tx = {
        let map = state.sessions.lock().map_err(|_| "lock_failed".to_string())?;
        map.get(session_id)
            .map(|s| s.outgoing.clone())
            .ok_or_else(|| "session_not_connected".to_string())?
    };
    tx.send(Outgoing::Data { bytes, opts })
        .await
        .map_err(|_| "send_closed".to_string())
}

pub async fn mqtt_sub(
    state: &State<'_, AppState>,
    session_id: &str,
    topic: String,
    qos: u8,
) -> Result<(), String> {
    let tx = {
        let map = state.sessions.lock().map_err(|_| "lock_failed".to_string())?;
        map.get(session_id)
            .map(|s| s.outgoing.clone())
            .ok_or_else(|| "session_not_connected".to_string())?
    };
    tx.send(Outgoing::Subscribe { topic, qos })
        .await
        .map_err(|_| "send_closed".to_string())
}

pub async fn mqtt_unsub(
    state: &State<'_, AppState>,
    session_id: &str,
    topic: String,
) -> Result<(), String> {
    let tx = {
        let map = state.sessions.lock().map_err(|_| "lock_failed".to_string())?;
        map.get(session_id)
            .map(|s| s.outgoing.clone())
            .ok_or_else(|| "session_not_connected".to_string())?
    };
    tx.send(Outgoing::Unsubscribe { topic })
        .await
        .map_err(|_| "send_closed".to_string())
}

pub async fn kick_client(
    state: &State<'_, AppState>,
    session_id: &str,
    client_id: String,
) -> Result<(), String> {
    let tx = {
        let map = state.sessions.lock().map_err(|_| "lock_failed".to_string())?;
        map.get(session_id)
            .map(|s| s.outgoing.clone())
            .ok_or_else(|| "session_not_connected".to_string())?
    };
    tx.send(Outgoing::Kick { client_id })
        .await
        .map_err(|_| "send_closed".to_string())
}
