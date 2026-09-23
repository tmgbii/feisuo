use crate::events::{ConnectConfig, PortsPayload, RxFrame, SerialPortInfo};
use crate::proto::emit_status;
use crate::state::Outgoing;
use serialport::{available_ports, SerialPortType};
use std::future;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::time::{Instant, sleep_until};
use tokio_serial::{DataBits, FlowControl, Parity, SerialPortBuilderExt, StopBits};
use tokio_util::sync::CancellationToken;

const RX_IDLE: Duration = Duration::from_millis(10);

pub fn list_ports() -> Result<Vec<SerialPortInfo>, String> {
    let ports = available_ports().map_err(|e| e.to_string())?;
    Ok(ports
        .into_iter()
        .map(|p| {
            let extra = match p.port_type {
                SerialPortType::UsbPort(usb) => {
                    let product = usb.product.unwrap_or_default();
                    if product.is_empty() {
                        String::new()
                    } else {
                        format!(" · {product}")
                    }
                }
                _ => String::new(),
            };
            SerialPortInfo {
                label: format!("{}{extra}", p.port_name),
                name: p.port_name,
            }
        })
        .collect())
}

pub async fn watch_ports(app: AppHandle) {
    let mut last: Option<Vec<String>> = None;
    loop {
        match list_ports() {
            Ok(ports) => {
                let names: Vec<String> = ports.iter().map(|p| p.name.clone()).collect();
                let (added, removed): (Vec<String>, Vec<String>) = match &last {
                    Some(prev) => (
                        names.iter().filter(|n| !prev.contains(n)).cloned().collect(),
                        prev.iter().filter(|n| !names.contains(n)).cloned().collect(),
                    ),
                    None => (Vec::new(), Vec::new()),
                };
                if last.is_none() || !added.is_empty() || !removed.is_empty() {
                    let _ = app.emit(
                        "comm:ports",
                        PortsPayload {
                            ports,
                            added,
                            removed,
                        },
                    );
                }
                last = Some(names);
            }
            Err(_) => {}
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

fn map_open_error(err: impl std::fmt::Display) -> String {
    let s = err.to_string();
    let lower = s.to_lowercase();
    if lower.contains("access is denied")
        || lower.contains("denied")
        || lower.contains("in use")
        || lower.contains("busy")
        || lower.contains("os error 5")
        || lower.contains("os error 16")
    {
        "port_busy".to_string()
    } else {
        s
    }
}

pub fn spawn(
    app: AppHandle,
    session_id: String,
    config: ConnectConfig,
    outgoing: mpsc::Receiver<Outgoing>,
    batch_tx: mpsc::Sender<RxFrame>,
    cancel: CancellationToken,
) {
    tauri::async_runtime::spawn(async move {
        if let Err(err) = run(app.clone(), &session_id, config, outgoing, batch_tx, cancel).await {
            emit_status(&app, &session_id, "error", Some(err));
        } else {
            emit_status(&app, &session_id, "disconnected", None);
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
    let ConnectConfig::Serial {
        port,
        baud_rate,
        data_bits,
        stop_bits,
        parity,
        flow_control,
    } = config
    else {
        return Err("not_serial".into());
    };
    if port.trim().is_empty() {
        return Err("pick_serial".into());
    }

    let data_bits = match data_bits {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        _ => DataBits::Eight,
    };
    let stop_bits = if stop_bits == 2 {
        StopBits::Two
    } else {
        StopBits::One
    };
    let parity = match parity.as_str() {
        "even" => Parity::Even,
        "odd" => Parity::Odd,
        _ => Parity::None,
    };
    let flow_control = match flow_control.as_str() {
        "hardware" => FlowControl::Hardware,
        "software" => FlowControl::Software,
        _ => FlowControl::None,
    };

    let mut port = tokio_serial::new(&port, baud_rate)
        .data_bits(data_bits)
        .stop_bits(stop_bits)
        .parity(parity)
        .flow_control(flow_control)
        .timeout(Duration::from_millis(50))
        .open_native_async()
        .map_err(map_open_error)?;

    emit_status(&app, session_id, "connected", None);

    let mut buf = vec![0u8; 4096];
    let mut acc: Vec<u8> = Vec::new();
    let mut idle_at: Option<Instant> = None;

    loop {
        let idle = idle_at;
        tokio::select! {
            _ = cancel.cancelled() => {
                flush_rx(&batch_tx, &mut acc).await;
                break;
            }
            _ = async {
                if let Some(deadline) = idle {
                    sleep_until(deadline).await;
                } else {
                    future::pending::<()>().await;
                }
            }, if idle_at.is_some() => {
                flush_rx(&batch_tx, &mut acc).await;
                idle_at = None;
            }
            msg = outgoing.recv() => {
                match msg {
                    Some(Outgoing::Data { bytes, .. }) => {
                        flush_rx(&batch_tx, &mut acc).await;
                        idle_at = None;
                        port.write_all(&bytes).await.map_err(|e| e.to_string())?;
                    }
                    None => break,
                    _ => {}
                }
            }
            read = port.read(&mut buf) => {
                match read {
                    Ok(0) => {
                        flush_rx(&batch_tx, &mut acc).await;
                        return Err("serial_gone".into());
                    }
                    Ok(n) => {
                        acc.extend_from_slice(&buf[..n]);
                        idle_at = Some(Instant::now() + RX_IDLE);
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::TimedOut => {}
                    Err(err) => {
                        flush_rx(&batch_tx, &mut acc).await;
                        return Err(if err.kind() == std::io::ErrorKind::BrokenPipe {
                            "serial_unplugged".into()
                        } else {
                            err.to_string()
                        });
                    }
                }
            }
        }
    }
    Ok(())
}

async fn flush_rx(batch_tx: &mpsc::Sender<RxFrame>, acc: &mut Vec<u8>) {
    if acc.is_empty() {
        return;
    }
    let _ = batch_tx.send(crate::events::rx_frame(std::mem::take(acc))).await;
}

