use crate::events::RxFrame;
use crate::events::RxBatch;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use std::time::Duration;

pub fn spawn_batcher(
    app: AppHandle,
    session_id: String,
    mut rx: mpsc::Receiver<RxFrame>,
    cancel: CancellationToken,
) {
    tauri::async_runtime::spawn(async move {
        let mut frames: Vec<RxFrame> = Vec::new();
        let mut interval = tokio::time::interval(Duration::from_millis(100));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    flush(&app, &session_id, &mut frames);
                    break;
                }
                _ = interval.tick() => {
                    flush(&app, &session_id, &mut frames);
                }
                frame = rx.recv() => {
                    match frame {
                        Some(frame) => {
                            frames.push(frame);
                            if frames.len() >= 50 {
                                flush(&app, &session_id, &mut frames);
                            }
                        }
                        None => {
                            flush(&app, &session_id, &mut frames);
                            break;
                        }
                    }
                }
            }
        }
    });
}

fn flush(app: &AppHandle, session_id: &str, frames: &mut Vec<RxFrame>) {
    if frames.is_empty() {
        return;
    }
    let _ = app.emit(
        "comm:rx",
        RxBatch {
            session_id: session_id.to_string(),
            frames: std::mem::take(frames),
        },
    );
}
