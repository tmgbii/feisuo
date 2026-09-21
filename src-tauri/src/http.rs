use crate::events::now_ms;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const MAX_BODY: usize = 5 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestPayload {
    pub method: String,
    pub url: String,
    pub headers: Vec<HttpHeader>,
    pub body: Option<String>,
    pub timeout_ms: u64,
}

#[derive(Debug, Deserialize)]
pub struct HttpHeader {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponsePayload {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<HttpHeaderOut>,
    pub body: String,
    pub truncated: bool,
    pub time_ms: u64,
    pub byte_length: usize,
}

#[derive(Debug, Serialize)]
pub struct HttpHeaderOut {
    pub key: String,
    pub value: String,
}

#[tauri::command]
pub async fn http_request(req: HttpRequestPayload) -> Result<HttpResponsePayload, String> {
    let method = reqwest::Method::from_bytes(req.method.as_bytes())
        .map_err(|_| format!("bad_method:{}", req.method))?;
    let timeout = Duration::from_millis(req.timeout_ms.clamp(500, 120_000));
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;

    let mut builder = client.request(method, &req.url);
    for h in &req.headers {
        if h.key.trim().is_empty() {
            continue;
        }
        builder = builder.header(h.key.trim(), h.value.as_str());
    }
    if let Some(body) = req.body {
        if !body.is_empty() {
            builder = builder.body(body);
        }
    }

    let started = now_ms();
    let response = builder.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let headers: Vec<HttpHeaderOut> = response
        .headers()
        .iter()
        .map(|(k, v)| HttpHeaderOut {
            key: k.to_string(),
            value: v.to_str().unwrap_or("").to_string(),
        })
        .collect();
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let byte_length = bytes.len();
    let truncated = byte_length > MAX_BODY;
    let slice = if truncated { &bytes[..MAX_BODY] } else { &bytes };
    let body = String::from_utf8_lossy(slice).into_owned();
    Ok(HttpResponsePayload {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers,
        body,
        truncated,
        time_ms: now_ms().saturating_sub(started),
        byte_length,
    })
}
