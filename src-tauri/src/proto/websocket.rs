use crate::events::{now_ms, ConnectConfig, RxFrame};
use crate::proto::emit_status;
use crate::state::Outgoing;
use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tauri::AppHandle;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

pub fn spawn(
    app: AppHandle,
    session_id: String,
    config: ConnectConfig,
    outgoing: mpsc::Receiver<Outgoing>,
    batch_tx: mpsc::Sender<RxFrame>,
    cancel: CancellationToken,
) {
    tauri::async_runtime::spawn(async move {
        match run(app.clone(), &session_id, config, outgoing, batch_tx, cancel).await {
            Ok(()) => emit_status(&app, &session_id, "disconnected", None),
            Err(err) => emit_status(&app, &session_id, "error", Some(err)),
        }
    });
}

async fn run(
    app: AppHandle,
    session_id: &str,
    config: ConnectConfig,
    mut outgoing: mpsc::Receiver<Outgoing>,
    batch_tx: mpsc::Sender<RxFrame>,
    cancel: CancellationToken,
) -> Result<(), String> {
    let ConnectConfig::Websocket {
        url,
        message_mode,
        heartbeat_enabled,
        heartbeat_interval_ms,
        heartbeat_payload,
    } = config
    else {
        return Err("not_ws".into());
    };

    let (ws, _) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(crate::proto::map_connect)?;
    emit_status(&app, session_id, "connected", None);

    let (mut sink, mut stream) = ws.split();
    let text_mode = message_mode == "text";
    let interval_ms = heartbeat_interval_ms.max(200);
    let mut hb = tokio::time::interval(Duration::from_millis(interval_ms));
    hb.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    hb.tick().await;

    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = hb.tick(), if heartbeat_enabled => {
                let msg = if text_mode {
                    Message::Text(heartbeat_payload.clone().into())
                } else {
                    Message::Binary(heartbeat_payload.clone().into_bytes().into())
                };
                sink.send(msg).await.map_err(|e| e.to_string())?;
            }
            msg = outgoing.recv() => {
                match msg {
                    Some(Outgoing::Data { bytes, opts }) => {
                        let as_text = opts.ws_text.unwrap_or(text_mode);
                        let msg = if as_text {
                            let s = String::from_utf8_lossy(&bytes).to_string();
                            Message::Text(s.into())
                        } else {
                            Message::Binary(bytes.into())
                        };
                        sink.send(msg).await.map_err(|e| e.to_string())?;
                    }
                    None => break,
                    _ => {}
                }
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        let _ = batch_tx.send(RxFrame {
                            timestamp: now_ms(),
                            data: text.as_bytes().to_vec(),
                            source: Some("text".into()),
                            color: None,
                            topic: None,
                        }).await;
                    }
                    Some(Ok(Message::Binary(bin))) => {
                        let _ = batch_tx.send(RxFrame {
                            timestamp: now_ms(),
                            data: bin.to_vec(),
                            source: Some("binary".into()),
                            color: None,
                            topic: None,
                        }).await;
                    }
                    Some(Ok(Message::Ping(p))) => {
                        sink.send(Message::Pong(p)).await.map_err(|e| e.to_string())?;
                    }
                    Some(Ok(Message::Close(_))) | None => return Err("closed".into()),
                    Some(Err(err)) => return Err(err.to_string()),
                    _ => {}
                }
            }
        }
    }
    Ok(())
}
