use crate::events::{now_ms, SendOpts};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub enum Outgoing {
    Data { bytes: Vec<u8>, opts: SendOpts },
    Subscribe { topic: String, qos: u8 },
    Unsubscribe { topic: String },
    Kick { client_id: String },
}

pub struct LiveSession {
    pub cancel: CancellationToken,
    pub outgoing: mpsc::Sender<Outgoing>,
}

pub struct AppState {
    pub sessions: Mutex<HashMap<String, LiveSession>>,
    pub ai_cancel: Mutex<Option<CancellationToken>>,
    pub ui_alive_ms: Arc<AtomicU64>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            ai_cancel: Mutex::new(None),
            ui_alive_ms: Arc::new(AtomicU64::new(now_ms())),
        }
    }

    pub fn touch_ui(&self) {
        self.ui_alive_ms.store(now_ms(), Ordering::Relaxed);
    }

    pub fn ui_stale(&self) -> bool {
        now_ms().saturating_sub(self.ui_alive_ms.load(Ordering::Relaxed)) > 2500
    }
}
