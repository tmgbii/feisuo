use crate::events::{now_ms, ClientsPayload, ConnectConfig, RxFrame, TcpClientInfo};
use crate::proto::emit_status;
use crate::state::Outgoing;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

const COLORS: [&str; 8] = [
    "#f97316", "#a855f7", "#14b8a6", "#eab308", "#ec4899", "#22c55e", "#38bdf8", "#f43f5e",
];

pub fn spawn(
    app: AppHandle,
    session_id: String,
    config: ConnectConfig,
    outgoing: mpsc::Receiver<Outgoing>,
    batch_tx: mpsc::Sender<RxFrame>,
    cancel: CancellationToken,
) {
    tauri::async_runtime::spawn(async move {
        let result = match &config {
            ConnectConfig::Tcp { mode, .. } if mode == "server" => {
                run_server(app.clone(), &session_id, config, outgoing, batch_tx, cancel).await
            }
            _ => run_client(app.clone(), &session_id, config, outgoing, batch_tx, cancel).await,
        };
        match result {
            Ok(()) => emit_status(&app, &session_id, "disconnected", None),
            Err(err) => emit_status(&app, &session_id, "error", Some(err)),
        }
    });
}

async fn run_client(
    app: AppHandle,
    session_id: &str,
    config: ConnectConfig,
    mut outgoing: mpsc::Receiver<Outgoing>,
    batch_tx: mpsc::Sender<RxFrame>,
    cancel: CancellationToken,
) -> Result<(), String> {
    let ConnectConfig::Tcp { host, port, .. } = config else {
        return Err("not_tcp".into());
    };
    let mut stream = TcpStream::connect((host.as_str(), port))
        .await
        .map_err(crate::proto::map_connect)?;
    let _ = stream.set_nodelay(true);
    emit_status(&app, session_id, "connected", None);

    let mut buf = vec![0u8; 8192];
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            msg = outgoing.recv() => {
                match msg {
                    Some(Outgoing::Data { bytes, .. }) => {
                        stream.write_all(&bytes).await.map_err(|e| e.to_string())?;
                    }
                    None => break,
                    _ => {}
                }
            }
            read = stream.read(&mut buf) => {
                match read {
                    Ok(0) => return Err("peer_gone".into()),
                    Ok(n) => {
                        let _ = batch_tx.send(RxFrame {
                            timestamp: now_ms(),
                            data: buf[..n].to_vec(),
                            source: Some(format!("{host}:{port}")),
                            color: None,
                            topic: None,
                        }).await;
                    }
                    Err(err) => return Err(err.to_string()),
                }
            }
        }
    }
    Ok(())
}

struct ClientSlot {
    addr: SocketAddr,
    color: String,
    tx: mpsc::Sender<Vec<u8>>,
}

async fn run_server(
    app: AppHandle,
    session_id: &str,
    config: ConnectConfig,
    mut outgoing: mpsc::Receiver<Outgoing>,
    batch_tx: mpsc::Sender<RxFrame>,
    cancel: CancellationToken,
) -> Result<(), String> {
    let ConnectConfig::Tcp { port, .. } = config else {
        return Err("not_tcp".into());
    };
    let listener = TcpListener::bind(("0.0.0.0", port))
        .await
        .map_err(|e| format!("listen_failed:{e}"))?;
    emit_status(&app, session_id, "connected", None);

    let clients: Arc<Mutex<HashMap<String, ClientSlot>>> = Arc::new(Mutex::new(HashMap::new()));
    let mut next_id = 0u64;

    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            msg = outgoing.recv() => {
                match msg {
                    Some(Outgoing::Data { bytes, opts }) => {
                        let map = clients.lock().await;
                        if let Some(id) = opts.tcp_client_id {
                            if let Some(c) = map.get(&id) {
                                let _ = c.tx.send(bytes).await;
                            }
                        } else {
                            for c in map.values() {
                                let _ = c.tx.send(bytes.clone()).await;
                            }
                        }
                    }
                    Some(Outgoing::Kick { client_id }) => {
                        clients.lock().await.remove(&client_id);
                        emit_clients(&app, session_id, &clients).await;
                    }
                    None => break,
                    _ => {}
                }
            }
            accepted = listener.accept() => {
                let (stream, addr) = accepted.map_err(|e| e.to_string())?;
                let _ = stream.set_nodelay(true);
                next_id += 1;
                let id = format!("c{next_id}");
                let color = COLORS[((next_id - 1) as usize) % COLORS.len()].to_string();
                let (tx, rx) = mpsc::channel::<Vec<u8>>(64);
                clients.lock().await.insert(id.clone(), ClientSlot {
                    addr,
                    color: color.clone(),
                    tx,
                });
                emit_clients(&app, session_id, &clients).await;
                spawn_client(
                    app.clone(),
                    session_id.to_string(),
                    id,
                    color,
                    addr,
                    stream,
                    rx,
                    batch_tx.clone(),
                    clients.clone(),
                    cancel.clone(),
                );
            }
        }
    }
    Ok(())
}

async fn emit_clients(
    app: &AppHandle,
    session_id: &str,
    clients: &Arc<Mutex<HashMap<String, ClientSlot>>>,
) {
    let list: Vec<TcpClientInfo> = clients
        .lock()
        .await
        .iter()
        .map(|(id, c)| TcpClientInfo {
            id: id.clone(),
            addr: c.addr.to_string(),
            color: c.color.clone(),
        })
        .collect();
    let _ = app.emit(
        "comm:clients",
        ClientsPayload {
            session_id: session_id.to_string(),
            clients: list,
        },
    );
}

fn spawn_client(
    app: AppHandle,
    session_id: String,
    id: String,
    color: String,
    addr: SocketAddr,
    stream: TcpStream,
    mut out_rx: mpsc::Receiver<Vec<u8>>,
    batch_tx: mpsc::Sender<RxFrame>,
    clients: Arc<Mutex<HashMap<String, ClientSlot>>>,
    cancel: CancellationToken,
) {
    tauri::async_runtime::spawn(async move {
        let mut stream = stream;
        let mut buf = vec![0u8; 8192];
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                msg = out_rx.recv() => {
                    match msg {
                        Some(bytes) => {
                            if stream.write_all(&bytes).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    }
                }
                read = stream.read(&mut buf) => {
                    match read {
                        Ok(0) => break,
                        Ok(n) => {
                            let _ = batch_tx.send(RxFrame {
                                timestamp: now_ms(),
                                data: buf[..n].to_vec(),
                                source: Some(addr.to_string()),
                                color: Some(color.clone()),
                                topic: None,
                            }).await;
                        }
                        Err(_) => break,
                    }
                }
            }
        }
        clients.lock().await.remove(&id);
        emit_clients(&app, &session_id, &clients).await;
    });
}
