use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RxFrame {
    pub timestamp: u64,
    pub data: Vec<u8>,
    pub source: Option<String>,
    pub color: Option<String>,
    pub topic: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RxBatch {
    pub session_id: String,
    pub frames: Vec<RxFrame>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusPayload {
    pub session_id: String,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortInfo {
    pub name: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortsPayload {
    pub ports: Vec<SerialPortInfo>,
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpClientInfo {
    pub id: String,
    pub addr: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientsPayload {
    pub session_id: String,
    pub clients: Vec<TcpClientInfo>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendOpts {
    pub mqtt_topic: Option<String>,
    pub mqtt_qos: Option<u8>,
    pub tcp_client_id: Option<String>,
    pub ws_text: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind")]
pub enum ConnectConfig {
    #[serde(rename = "serial", rename_all = "camelCase")]
    Serial {
        port: String,
        baud_rate: u32,
        data_bits: u8,
        stop_bits: u8,
        parity: String,
        flow_control: String,
    },
    #[serde(rename = "tcp", rename_all = "camelCase")]
    Tcp {
        mode: String,
        host: String,
        port: u16,
    },
    #[serde(rename = "udp", rename_all = "camelCase")]
    Udp {
        local_port: u16,
        remote_host: String,
        remote_port: u16,
    },
    #[serde(rename = "websocket", rename_all = "camelCase")]
    Websocket {
        url: String,
        message_mode: String,
        heartbeat_enabled: bool,
        heartbeat_interval_ms: u64,
        heartbeat_payload: String,
    },
    #[serde(rename = "mqtt", rename_all = "camelCase")]
    Mqtt {
        broker: String,
        port: u16,
        client_id: String,
        username: String,
        password: String,
        keep_alive: u64,
        clean_session: bool,
        publish_topic: Option<String>,
        publish_qos: Option<u8>,
        #[serde(default)]
        tls: bool,
    },
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn rx_frame(data: Vec<u8>) -> RxFrame {
    RxFrame {
        timestamp: now_ms(),
        data,
        source: None,
        color: None,
        topic: None,
    }
}
