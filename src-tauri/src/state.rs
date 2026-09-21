use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use crate::events::SendOpts;

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
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            ai_cancel: Mutex::new(None),
        }
    }
}
