use crate::state::AppState;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    #[serde(default)]
    pub session_id: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub messages: Vec<ChatMessage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDelta {
    pub session_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDone {
    pub session_id: String,
    pub error: Option<String>,
    pub stopped: bool,
}

fn completions_url(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/chat/completions")
    }
}

fn map_error(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        return "timeout".into();
    }
    if err.is_connect() {
        return "unreachable".into();
    }
    "request_failed".into()
}

fn map_status(status: u16, body: &str) -> String {
    let hint = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_default();
    match status {
        401 | 403 => {
            if hint.is_empty() {
                "auth_failed".into()
            } else {
                hint
            }
        }
        404 => "not_found".into(),
        429 => "rate_limited".into(),
        _ => {
            if hint.is_empty() {
                format!("HTTP {status}")
            } else {
                hint
            }
        }
    }
}

fn delta_text(value: &Value) -> Option<String> {
    let content = value
        .pointer("/choices/0/delta/content")
        .or_else(|| value.pointer("/choices/0/message/content"))?;
    content.as_str().map(|s| s.to_string())
}

fn replace_cancel(state: &AppState) -> CancellationToken {
    let token = CancellationToken::new();
    let mut slot = state.ai_cancel.lock().expect("ai_cancel");
    if let Some(prev) = slot.take() {
        prev.cancel();
    }
    *slot = Some(token.clone());
    token
}

#[tauri::command]
pub fn ai_stop(state: State<AppState>) {
    if let Some(token) = state.ai_cancel.lock().expect("ai_cancel").take() {
        token.cancel();
    }
}

#[tauri::command]
pub async fn ai_chat(
    app: AppHandle,
    state: State<'_, AppState>,
    req: ChatRequest,
) -> Result<(), String> {
    let base = req.base_url.trim();
    let model = req.model.trim();
    if base.is_empty() {
        return Err("missing_url".into());
    }
    if model.is_empty() {
        return Err("missing_model".into());
    }
    let session_id = req.session_id.clone();
    let cancel = replace_cancel(&state);
    let url = completions_url(base);
    let body = json!({
        "model": model,
        "messages": req.messages.iter().map(|m| json!({
            "role": m.role,
            "content": m.content,
        })).collect::<Vec<_>>(),
        "stream": true,
        "temperature": 0.2,
        "max_tokens": 2048,
    });

    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?
        .post(&url)
        .header("content-type", "application/json");
    let key = req.api_key.trim();
    if !key.is_empty() {
        builder = builder.bearer_auth(key);
    }

    let send = builder.body(body.to_string()).send();
    let response = tokio::select! {
        _ = cancel.cancelled() => {
            let _ = app.emit(
                "ai:done",
                AiDone {
                    session_id: session_id.clone(),
                    error: None,
                    stopped: true,
                },
            );
            return Ok(());
        }
        result = send => result.map_err(|e| map_error(&e))?,
    };

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(map_status(status.as_u16(), &text));
    }

    let mut stream = response.bytes_stream();
    let mut buf = String::new();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                let _ = app.emit(
                    "ai:done",
                    AiDone {
                        session_id: session_id.clone(),
                        error: None,
                        stopped: true,
                    },
                );
                return Ok(());
            }
            chunk = stream.next() => {
                let Some(chunk) = chunk else { break };
                let bytes = chunk.map_err(|e| map_error(&e))?;
                buf.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(idx) = buf.find('\n') {
                    let line = buf[..idx].trim().to_string();
                    buf = buf[idx + 1..].to_string();
                    emit_sse_line(&app, &session_id, &line);
                    if line.trim_start_matches("data:").trim() == "[DONE]" {
                        let _ = app.emit(
                            "ai:done",
                            AiDone {
                                session_id: session_id.clone(),
                                error: None,
                                stopped: false,
                            },
                        );
                        return Ok(());
                    }
                }
            }
        }
    }
    if !buf.trim().is_empty() {
        emit_sse_line(&app, &session_id, buf.trim());
    }
    let _ = app.emit(
        "ai:done",
        AiDone {
            session_id,
            error: None,
            stopped: false,
        },
    );
    Ok(())
}

fn emit_sse_line(app: &AppHandle, session_id: &str, line: &str) {
    let Some(data) = line.strip_prefix("data:") else {
        return;
    };
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return;
    }
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return;
    };
    if let Some(text) = delta_text(&value) {
        if !text.is_empty() {
            let _ = app.emit(
                "ai:delta",
                AiDelta {
                    session_id: session_id.to_string(),
                    text,
                },
            );
        }
    }
}
