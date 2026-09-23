use crate::events::RxFrame;
use crate::events::{now_ms, RxBatch};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const FLUSH_LEN: usize = 50;
const HOLD_KEEP: usize = 64;
const UI_SLACK_MS: u64 = 2500;

pub fn spawn_batcher(
    app: AppHandle,
    session_id: String,
    mut rx: mpsc::Receiver<RxFrame>,
    cancel: CancellationToken,
    ui_alive_ms: Arc<AtomicU64>,
) {
    tauri::async_runtime::spawn(async move {
        let mut frames: Vec<RxFrame> = Vec::new();
        let mut dropped: u32 = 0;
        let mut interval = tokio::time::interval(Duration::from_millis(100));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    flush(&app, &session_id, &mut frames, &mut dropped);
                    break;
                }
                _ = interval.tick() => {
                    if ui_stale(&ui_alive_ms) {
                        trim(&mut frames, HOLD_KEEP, &mut dropped);
                    } else {
                        flush(&app, &session_id, &mut frames, &mut dropped);
                    }
                }
                frame = rx.recv() => {
                    match frame {
                        Some(frame) => {
                            frames.push(frame);
                            if ui_stale(&ui_alive_ms) {
                                trim(&mut frames, HOLD_KEEP, &mut dropped);
                            } else if frames.len() >= FLUSH_LEN {
                                flush(&app, &session_id, &mut frames, &mut dropped);
                            }
                        }
                        None => {
                            flush(&app, &session_id, &mut frames, &mut dropped);
                            break;
                        }
                    }
                }
            }
        }
    });
}

fn ui_stale(ui_alive_ms: &AtomicU64) -> bool {
    now_ms().saturating_sub(ui_alive_ms.load(Ordering::Relaxed)) > UI_SLACK_MS
}

fn trim(frames: &mut Vec<RxFrame>, keep: usize, dropped: &mut u32) {
    if frames.len() <= keep {
        return;
    }
    let n = frames.len() - keep;
    frames.drain(0..n);
    *dropped = dropped.saturating_add(n as u32);
}

fn flush(app: &AppHandle, session_id: &str, frames: &mut Vec<RxFrame>, dropped: &mut u32) {
    if frames.is_empty() && *dropped == 0 {
        return;
    }
    let _ = app.emit(
        "comm:rx",
        RxBatch {
            session_id: session_id.to_string(),
            frames: std::mem::take(frames),
            dropped: std::mem::take(dropped),
        },
    );
}
