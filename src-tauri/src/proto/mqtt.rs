use crate::events::{now_ms, ConnectConfig, RxFrame};
use crate::proto::emit_status;
use crate::state::Outgoing;
use rumqttc::{AsyncClient, Event, Incoming, MqttOptions, QoS, TlsConfiguration, Transport};
use std::time::Duration;
use tauri::AppHandle;
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

fn qos_from(v: u8) -> QoS {
    match v {
        1 => QoS::AtLeastOnce,
        2 => QoS::ExactlyOnce,
        _ => QoS::AtMostOnce,
    }
}

async fn run(
    app: AppHandle,
    session_id: &str,
    config: ConnectConfig,
    mut outgoing: mpsc::Receiver<Outgoing>,
    batch_tx: mpsc::Sender<RxFrame>,
    cancel: CancellationToken,
) -> Result<(), String> {
    let ConnectConfig::Mqtt {
        broker,
        port,
        client_id,
        username,
        password,
        keep_alive,
        clean_session,
        publish_topic,
        publish_qos,
        tls,
    } = config
    else {
        return Err("not_mqtt".into());
    };

    let client_id = if client_id.trim().is_empty() {
        let n = session_id.len().min(8);
        format!("fs_{}_{}", &session_id[..n], now_ms())
    } else {
        client_id
    };
    let mut options = MqttOptions::new(client_id, broker, port);
    options.set_keep_alive(Duration::from_secs(keep_alive.max(1)));
    options.set_clean_session(clean_session);
    if tls {
        options.set_transport(Transport::tls_with_config(TlsConfiguration::Native));
    }
    if !username.is_empty() {
        options.set_credentials(username, password);
    }

    let (client, mut eventloop) = AsyncClient::new(options, 256);
    let default_topic = publish_topic.unwrap_or_else(|| "test".into());
    let default_qos = qos_from(publish_qos.unwrap_or(0));
    let mut connected = false;

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                let _ = client.disconnect().await;
                break;
            }
            msg = outgoing.recv() => {
                match msg {
                    Some(Outgoing::Data { bytes, opts }) => {
                        let topic = opts.mqtt_topic.unwrap_or_else(|| default_topic.clone());
                        let qos = opts.mqtt_qos.map(qos_from).unwrap_or(default_qos);
                        client
                            .publish(topic, qos, false, bytes)
                            .await
                            .map_err(|e| e.to_string())?;
                    }
                    Some(Outgoing::Subscribe { topic, qos }) => {
                        client
                            .subscribe(topic, qos_from(qos))
                            .await
                            .map_err(|e| e.to_string())?;
                    }
                    Some(Outgoing::Unsubscribe { topic }) => {
                        client.unsubscribe(topic).await.map_err(|e| e.to_string())?;
                    }
                    None => break,
                    _ => {}
                }
            }
            event = eventloop.poll() => {
                match event {
                    Ok(Event::Incoming(Incoming::ConnAck(_))) => {
                        connected = true;
                        emit_status(&app, session_id, "connected", None);
                    }
                    Ok(Event::Incoming(Incoming::Publish(p))) => {
                        let _ = batch_tx.try_send(RxFrame {
                            timestamp: now_ms(),
                            data: p.payload.to_vec(),
                            source: None,
                            color: None,
                            topic: Some(p.topic),
                        });
                    }
                    Ok(Event::Incoming(Incoming::Disconnect)) => {
                        return Err("broker_gone".into());
                    }
                    Err(err) => {
                        if connected {
                            return Err(err.to_string());
                        }
                        return Err(format!("connect_failed:{err}"));
                    }
                    _ => {}
                }
            }
        }
    }
    Ok(())
}
