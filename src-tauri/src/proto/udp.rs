use crate::events::{now_ms, ConnectConfig, RxFrame};
use crate::proto::emit_status;
use crate::state::Outgoing;
use tauri::AppHandle;
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
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
    let ConnectConfig::Udp {
        local_port,
        remote_host,
        remote_port,
    } = config
    else {
        return Err("not_udp".into());
    };

    let socket = UdpSocket::bind(("0.0.0.0", local_port))
        .await
        .map_err(|e| format!("bind_failed:{e}"))?;
    emit_status(&app, session_id, "connected", None);

    let mut buf = vec![0u8; 65535];
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            msg = outgoing.recv() => {
                match msg {
                    Some(Outgoing::Data { bytes, .. }) => {
                        socket
                            .send_to(&bytes, (remote_host.as_str(), remote_port))
                            .await
                            .map_err(|e| e.to_string())?;
                    }
                    None => break,
                    _ => {}
                }
            }
            recv = socket.recv_from(&mut buf) => {
                let (n, addr) = recv.map_err(|e| e.to_string())?;
                let _ = batch_tx.send(RxFrame {
                    timestamp: now_ms(),
                    data: buf[..n].to_vec(),
                    source: Some(addr.to_string()),
                    color: None,
                    topic: None,
                }).await;
            }
        }
    }
    Ok(())
}
