use crate::events::StatusPayload;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sqlx::mysql::{MySqlPoolOptions, MySqlRow};
use sqlx::postgres::{PgPoolOptions, PgRow};
use sqlx::sqlite::{SqlitePoolOptions, SqliteRow};
use sqlx::types::chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use sqlx::types::Decimal;
use sqlx::{Column, MySqlPool, PgPool, Row, SqlitePool};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

const ROW_CAP: usize = 1000;
const CELL_CAP: usize = 8192;
const QUERY_SECS: u64 = 30;
const CONNECT_SECS: u64 = 15;
const SCRIPT_STMT_SECS: u64 = 120;
const SCRIPT_FILE_MAX: u64 = 256 * 1024 * 1024;
const TABLE_CAP: usize = 5000;
const CATALOG_CAP: usize = 5000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnectReq {
    pub session_id: String,
    pub engine: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: String,
    pub file: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbQueryReq {
    pub session_id: String,
    pub sql: String,
    pub select_only: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbQueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub affected: u64,
    pub elapsed_ms: u64,
    pub truncated: bool,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTable {
    pub schema: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbScriptReq {
    pub session_id: String,
    pub path: String,
    pub select_only: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbScriptEvent {
    pub session_id: String,
    pub index: u32,
    pub total: u32,
    pub preview: String,
    pub ok: bool,
    pub affected: u64,
    pub elapsed_ms: u64,
    pub error: Option<String>,
    pub done: bool,
    pub cancelled: bool,
}

#[derive(Clone)]
enum LivePool {
    Postgres(PgPool),
    Mysql(MySqlPool),
    Sqlite(SqlitePool),
}

impl LivePool {
    async fn close(&self) {
        match self {
            Self::Postgres(p) => p.close().await,
            Self::Mysql(p) => p.close().await,
            Self::Sqlite(p) => p.close().await,
        }
    }
}

#[derive(Clone)]
struct LiveDb {
    pool: LivePool,
    engine: String,
    req: DbConnectReq,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbCatalogs {
    pub current: String,
    pub names: Vec<String>,
}

pub struct DbState {
    sessions: Mutex<HashMap<String, LiveDb>>,
    script_cancel: Mutex<HashMap<String, tokio_util::sync::CancellationToken>>,
}

impl DbState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            script_cancel: Mutex::new(HashMap::new()),
        }
    }
}

fn map_err(e: impl ToString) -> String {
    let s = e.to_string();
    let low = s.to_lowercase();
    if low.contains("password") || low.contains("auth") || low.contains("login") || low.contains("access denied")
    {
        return "auth_failed".into();
    }
    if low.contains("timed") || low.contains("timeout") {
        return "timeout".into();
    }
    if low.contains("refused") {
        return "refused".into();
    }
    if low.contains("unreachable") || low.contains("failed to lookup") {
        return "unreachable".into();
    }
    if low.contains("no such file") || low.contains("unable to open") {
        return "file_missing".into();
    }
    s
}

fn pct(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b':' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn host_part(host: &str) -> String {
    let h = host.trim();
    if h.contains(':') && !h.starts_with('[') {
        format!("[{h}]")
    } else {
        h.to_string()
    }
}

fn sqlite_url(path: &str) -> Result<String, String> {
    let p = path.trim();
    if p.is_empty() {
        return Err("missing_file".into());
    }
    let uni = p.replace('\\', "/");
    let enc = uni.split('/').map(pct).collect::<Vec<_>>().join("/");
    if enc.len() >= 2 && enc.as_bytes().get(1) == Some(&b':') {
        Ok(format!("sqlite:///{enc}"))
    } else if enc.starts_with('/') {
        Ok(format!("sqlite://{enc}"))
    } else {
        Ok(format!("sqlite:///{enc}"))
    }
}

fn connect_url(req: &DbConnectReq) -> Result<String, String> {
    match req.engine.as_str() {
        "sqlite" => sqlite_url(&req.file),
        "mysql" => {
            let host = host_part(&req.host);
            if host.is_empty() {
                return Err("missing_host".into());
            }
            let db = pct(req.database.trim());
            Ok(format!(
                "mysql://{}:{}@{}:{}/{}?ssl-mode=DISABLED&charset=utf8mb4",
                pct(req.user.trim()),
                pct(&req.password),
                host,
                req.port,
                db
            ))
        }
        "postgres" => {
            let host = host_part(&req.host);
            if host.is_empty() {
                return Err("missing_host".into());
            }
            let db = {
                let d = req.database.trim();
                if d.is_empty() {
                    "postgres".into()
                } else {
                    pct(d)
                }
            };
            Ok(format!(
                "postgres://{}:{}@{}:{}/{}?sslmode=prefer",
                pct(req.user.trim()),
                pct(&req.password),
                host,
                req.port,
                db
            ))
        }
        _ => Err("unsupported_db".into()),
    }
}

async fn open_pool(req: &DbConnectReq) -> Result<LivePool, String> {
    let url = connect_url(req)?;
    let timeout = Duration::from_secs(CONNECT_SECS);
    match req.engine.as_str() {
        "mysql" => {
            let p = tokio::time::timeout(
                timeout,
                MySqlPoolOptions::new()
                    .max_connections(2)
                    .acquire_timeout(timeout)
                    .connect(&url),
            )
            .await
            .map_err(|_| "timeout".to_string())?
            .map_err(map_err)?;
            Ok(LivePool::Mysql(p))
        }
        "sqlite" => {
            let p = tokio::time::timeout(
                timeout,
                SqlitePoolOptions::new()
                    .max_connections(2)
                    .acquire_timeout(timeout)
                    .connect(&url),
            )
            .await
            .map_err(|_| "timeout".to_string())?
            .map_err(map_err)?;
            Ok(LivePool::Sqlite(p))
        }
        "postgres" => {
            let p = tokio::time::timeout(
                timeout,
                PgPoolOptions::new()
                    .max_connections(2)
                    .acquire_timeout(timeout)
                    .connect(&url),
            )
            .await
            .map_err(|_| "timeout".to_string())?
            .map_err(map_err)?;
            Ok(LivePool::Postgres(p))
        }
        _ => Err("unsupported_db".into()),
    }
}

fn catalog_name(name: &str) -> Result<&str, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("missing_db".into());
    }
    if n.len() > 128 || n.contains('\0') || n.contains('/') || n.contains('\\') {
        return Err("bad_db_name".into());
    }
    Ok(n)
}

fn names_from(result: DbQueryResult) -> Vec<String> {
    let mut out = Vec::new();
    for row in result.rows {
        let name = row.first().cloned().flatten().unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        out.push(name);
        if out.len() >= CATALOG_CAP {
            break;
        }
    }
    out
}

fn emit_status(app: &AppHandle, session_id: &str, status: &str, error: Option<String>) {
    let _ = app.emit(
        "db:status",
        StatusPayload {
            session_id: session_id.to_string(),
            status: status.into(),
            error,
        },
    );
}

async fn live_of(state: &DbState, id: &str) -> Result<LiveDb, String> {
    state
        .sessions
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or_else(|| "not_connected".to_string())
}

fn first_keyword(sql: &str) -> String {
    let bytes = sql.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i + 1 < bytes.len() && bytes[i] == b'-' && bytes[i + 1] == b'-' {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = i.saturating_add(2).min(bytes.len());
            continue;
        }
        break;
    }
    let start = i;
    while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
        i += 1;
    }
    sql.get(start..i).unwrap_or("").to_ascii_uppercase()
}

fn is_query(kw: &str) -> bool {
    matches!(
        kw,
        "SELECT"
            | "WITH"
            | "VALUES"
            | "TABLE"
            | "SHOW"
            | "EXPLAIN"
            | "DESCRIBE"
            | "DESC"
            | "PRAGMA"
            | "CALL"
            | "CHECK"
            | "CHECKSUM"
            | "ANALYZE"
            | "OPTIMIZE"
            | "REPAIR"
            | "HELP"
    )
}

fn to_hex(bytes: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let slice = if bytes.len() > 256 { &bytes[..256] } else { bytes };
    let mut s = String::with_capacity(2 + slice.len() * 2);
    s.push_str("\\x");
    for &b in slice {
        s.push(H[(b >> 4) as usize] as char);
        s.push(H[(b & 0xf) as usize] as char);
    }
    if bytes.len() > 256 {
        s.push('…');
    }
    s
}

fn clip(mut s: String) -> String {
    if s.len() > CELL_CAP {
        s.truncate(CELL_CAP);
        s.push('…');
    }
    s
}

fn bytes_cell(b: Vec<u8>) -> String {
    if let Ok(s) = std::str::from_utf8(&b) {
        if s.chars().all(|c| c == '\t' || c == '\n' || c == '\r' || !c.is_control()) {
            return clip(s.to_string());
        }
    }
    to_hex(&b)
}

fn cell_mysql(row: &MySqlRow, i: usize) -> Option<String> {
    if let Ok(v) = row.try_get::<Option<String>, _>(i) {
        return v.map(clip);
    }
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return v.map(bytes_cell);
    }
    if let Ok(v) = row.try_get::<Option<u64>, _>(i) {
        return v.map(|n| n.to_string());
    }
    if let Ok(v) = row.try_get::<Option<i64>, _>(i) {
        return v.map(|n| n.to_string());
    }
    if let Ok(v) = row.try_get::<Option<u32>, _>(i) {
        return v.map(|n| n.to_string());
    }
    if let Ok(v) = row.try_get::<Option<i32>, _>(i) {
        return v.map(|n| n.to_string());
    }
    if let Ok(v) = row.try_get::<Option<u16>, _>(i) {
        return v.map(|n| n.to_string());
    }
    if let Ok(v) = row.try_get::<Option<i16>, _>(i) {
        return v.map(|n| n.to_string());
    }
    if let Ok(v) = row.try_get::<Option<f64>, _>(i) {
        return v.map(|n| n.to_string());
    }
    if let Ok(v) = row.try_get::<Option<f32>, _>(i) {
        return v.map(|n| n.to_string());
    }
    if let Ok(v) = row.try_get::<Option<bool>, _>(i) {
        return v.map(|b| if b { "1".into() } else { "0".into() });
    }
    if let Ok(v) = row.try_get::<Option<NaiveDateTime>, _>(i) {
        return v.map(|d| d.format("%Y-%m-%d %H:%M:%S").to_string());
    }
    if let Ok(v) = row.try_get::<Option<NaiveDate>, _>(i) {
        return v.map(|d| d.to_string());
    }
    if let Ok(v) = row.try_get::<Option<NaiveTime>, _>(i) {
        return v.map(|d| d.to_string());
    }
    if let Ok(v) = row.try_get::<Option<DateTime<Utc>>, _>(i) {
        return v.map(|d| d.format("%Y-%m-%d %H:%M:%S").to_string());
    }
    if let Ok(v) = row.try_get::<Option<Decimal>, _>(i) {
        return v.map(|d| d.to_string());
    }
    if let Ok(v) = row.try_get::<Option<serde_json::Value>, _>(i) {
        return v.map(|d| clip(d.to_string()));
    }
    Some("?".into())
}

fn cell_pg(row: &PgRow, i: usize) -> Option<String> {
    if let Ok(v) = row.try_get::<Option<String>, _>(i) {
        return v.map(clip);
    }
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return v.map(bytes_cell);
    }
    if let Ok(v) = row.try_get::<Option<i64>, _>(i) {
        return v.map(|n| n.to_string());
    }
    if let Ok(v) = row.try_get::<Option<i32>, _>(i) {
        return v.map(|n| n.to_string());
    }
    if let Ok(v) = row.try_get::<Option<i16>, _>(i) {
        return v.map(|n| n.to_string());
    }
    if let Ok(v) = row.try_get::<Option<f64>, _>(i) {
        return v.map(|n| n.to_string());
    }
    if let Ok(v) = row.try_get::<Option<f32>, _>(i) {
        return v.map(|n| n.to_string());
    }
    if let Ok(v) = row.try_get::<Option<bool>, _>(i) {
        return v.map(|b| if b { "t".into() } else { "f".into() });
    }
    if let Ok(v) = row.try_get::<Option<NaiveDateTime>, _>(i) {
        return v.map(|d| d.format("%Y-%m-%d %H:%M:%S").to_string());
    }
    if let Ok(v) = row.try_get::<Option<NaiveDate>, _>(i) {
        return v.map(|d| d.to_string());
    }
    if let Ok(v) = row.try_get::<Option<NaiveTime>, _>(i) {
        return v.map(|d| d.to_string());
    }
    if let Ok(v) = row.try_get::<Option<DateTime<Utc>>, _>(i) {
        return v.map(|d| d.to_rfc3339());
    }
    if let Ok(v) = row.try_get::<Option<Decimal>, _>(i) {
        return v.map(|d| d.to_string());
    }
    if let Ok(v) = row.try_get::<Option<serde_json::Value>, _>(i) {
        return v.map(|d| clip(d.to_string()));
    }
    Some("?".into())
}

fn cell_sqlite(row: &SqliteRow, i: usize) -> Option<String> {
    if let Ok(v) = row.try_get::<Option<String>, _>(i) {
        return v.map(clip);
    }
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return v.map(bytes_cell);
    }
    if let Ok(v) = row.try_get::<Option<i64>, _>(i) {
        return v.map(|n| n.to_string());
    }
    if let Ok(v) = row.try_get::<Option<f64>, _>(i) {
        return v.map(|n| n.to_string());
    }
    if let Ok(v) = row.try_get::<Option<bool>, _>(i) {
        return v.map(|b| if b { "1".into() } else { "0".into() });
    }
    Some("?".into())
}

macro_rules! collect_rows {
    ($pool:expr, $sql:expr, $cell:expr) => {{
        let mut stream = sqlx::raw_sql($sql).fetch($pool);
        let mut columns: Vec<String> = Vec::new();
        let mut rows: Vec<Vec<Option<String>>> = Vec::new();
        let mut truncated = false;
        while let Some(item) = stream.next().await {
            let row = item.map_err(map_err)?;
            if columns.is_empty() {
                columns = row.columns().iter().map(|c| c.name().to_string()).collect();
            }
            if rows.len() >= ROW_CAP {
                truncated = true;
                break;
            }
            let n = row.len();
            let mut line = Vec::with_capacity(n);
            for i in 0..n {
                line.push($cell(&row, i));
            }
            rows.push(line);
        }
        drop(stream);
        (columns, rows, truncated)
    }};
}

async fn run_sql(pool: &LivePool, sql: &str) -> Result<DbQueryResult, String> {
    let kw = first_keyword(sql);
    let started = Instant::now();
    if is_query(&kw) {
        let (columns, rows, truncated) = match pool {
            LivePool::Postgres(p) => collect_rows!(p, sql, cell_pg),
            LivePool::Mysql(p) => collect_rows!(p, sql, cell_mysql),
            LivePool::Sqlite(p) => collect_rows!(p, sql, cell_sqlite),
        };
        Ok(DbQueryResult {
            columns,
            rows,
            affected: 0,
            elapsed_ms: started.elapsed().as_millis() as u64,
            truncated,
            kind: "query".into(),
        })
    } else {
        let affected = exec_stmt(pool, sql).await?;
        Ok(DbQueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            affected,
            elapsed_ms: started.elapsed().as_millis() as u64,
            truncated: false,
            kind: "exec".into(),
        })
    }
}

#[tauri::command]
pub async fn db_connect(
    app: AppHandle,
    state: State<'_, DbState>,
    req: DbConnectReq,
) -> Result<(), String> {
    let session_id = req.session_id.clone();
    if let Some(old) = state.sessions.lock().await.remove(&session_id) {
        old.pool.close().await;
    }
    let pool = open_pool(&req).await?;
    let engine = req.engine.clone();
    let mut req = req;
    if engine == "postgres" && req.database.trim().is_empty() {
        req.database = "postgres".into();
    }
    state.sessions.lock().await.insert(
        session_id.clone(),
        LiveDb {
            pool,
            engine,
            req,
        },
    );
    emit_status(&app, &session_id, "connected", None);
    Ok(())
}

#[tauri::command]
pub async fn db_disconnect(
    app: AppHandle,
    state: State<'_, DbState>,
    session_id: String,
) -> Result<(), String> {
    if let Some(tok) = state.script_cancel.lock().await.remove(&session_id) {
        tok.cancel();
    }
    if let Some(live) = state.sessions.lock().await.remove(&session_id) {
        live.pool.close().await;
    }
    emit_status(&app, &session_id, "disconnected", None);
    Ok(())
}

#[tauri::command]
pub async fn db_query(
    state: State<'_, DbState>,
    req: DbQueryReq,
) -> Result<DbQueryResult, String> {
    let sql = req.sql.trim();
    if sql.is_empty() {
        return Err("sql_empty".into());
    }
    if sql.len() > 1024 * 1024 {
        return Err("sql_too_long".into());
    }
    let kw = first_keyword(sql);
    if req.select_only && !is_query(&kw) {
        return Err("select_only".into());
    }
    let live = live_of(&state, &req.session_id).await?;
    tokio::time::timeout(Duration::from_secs(QUERY_SECS), run_sql(&live.pool, sql))
        .await
        .map_err(|_| "timeout".to_string())?
}

fn tables_sql(engine: &str) -> &'static str {
    match engine {
        "mysql" => {
            "SELECT table_schema, table_name FROM information_schema.tables \
             WHERE table_type = 'BASE TABLE' AND table_schema = DATABASE() \
             ORDER BY table_name"
        }
        "sqlite" => {
            "SELECT '' AS table_schema, name AS table_name FROM sqlite_master \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        }
        _ => {
            "SELECT table_schema, table_name FROM information_schema.tables \
             WHERE table_type = 'BASE TABLE' \
             AND table_schema NOT IN ('pg_catalog', 'information_schema') \
             ORDER BY table_schema, table_name"
        }
    }
}

fn skip_dollar_tag(b: &[u8], mut i: usize) -> Option<(usize, usize)> {
    if i >= b.len() || b[i] != b'$' {
        return None;
    }
    let start = i;
    i += 1;
    while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
        i += 1;
    }
    if i >= b.len() || b[i] != b'$' {
        return None;
    }
    Some((start, i + 1))
}

fn split_statements(sql: &str, mysql: bool) -> Vec<String> {
    let b = sql.as_bytes();
    let n = b.len();
    let mut i = 0;
    let mut start = 0;
    let mut out = Vec::new();
    while i < n {
        if b[i] == b'-' && i + 1 < n && b[i + 1] == b'-' {
            i += 2;
            while i < n && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if mysql && b[i] == b'#' {
            while i < n && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b[i] == b'/' && i + 1 < n && b[i + 1] == b'*' {
            i += 2;
            while i + 1 < n && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i = i.saturating_add(2).min(n);
            continue;
        }
        if b[i] == b'\'' {
            i += 1;
            while i < n {
                if b[i] == b'\\' && mysql && i + 1 < n {
                    i += 2;
                    continue;
                }
                if b[i] == b'\'' {
                    i += 1;
                    if i < n && b[i] == b'\'' {
                        i += 1;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            continue;
        }
        if b[i] == b'"' {
            i += 1;
            while i < n {
                if b[i] == b'"' {
                    i += 1;
                    if i < n && b[i] == b'"' {
                        i += 1;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            continue;
        }
        if mysql && b[i] == b'`' {
            i += 1;
            while i < n {
                if b[i] == b'`' {
                    i += 1;
                    if i < n && b[i] == b'`' {
                        i += 1;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            continue;
        }
        if !mysql {
            if let Some((tag_from, tag_to)) = skip_dollar_tag(b, i) {
                let tag = &b[tag_from..tag_to];
                i = tag_to;
                while i + tag.len() <= n {
                    if &b[i..i + tag.len()] == tag {
                        i += tag.len();
                        break;
                    }
                    i += 1;
                }
                continue;
            }
        }
        if b[i] == b';' {
            let stmt = sql.get(start..i).unwrap_or("").trim();
            if !stmt.is_empty() && !first_keyword(stmt).is_empty() {
                out.push(stmt.to_string());
            }
            i += 1;
            start = i;
            continue;
        }
        i += 1;
    }
    let stmt = sql.get(start..).unwrap_or("").trim();
    if !stmt.is_empty() && !first_keyword(stmt).is_empty() {
        out.push(stmt.to_string());
    }
    out
}

fn preview_sql(sql: &str) -> String {
    let one = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= 80 {
        one
    } else {
        let mut s: String = one.chars().take(80).collect();
        s.push('…');
        s
    }
}

async fn exec_stmt(pool: &LivePool, sql: &str) -> Result<u64, String> {
    let n = match pool {
        LivePool::Postgres(p) => sqlx::raw_sql(sql).execute(p).await.map_err(map_err)?.rows_affected(),
        LivePool::Mysql(p) => sqlx::raw_sql(sql).execute(p).await.map_err(map_err)?.rows_affected(),
        LivePool::Sqlite(p) => sqlx::raw_sql(sql).execute(p).await.map_err(map_err)?.rows_affected(),
    };
    Ok(n)
}

#[tauri::command]
pub async fn db_tables(
    state: State<'_, DbState>,
    session_id: String,
) -> Result<Vec<DbTable>, String> {
    let live = live_of(&state, &session_id).await?;
    let sql = tables_sql(&live.engine);
    let result = tokio::time::timeout(Duration::from_secs(QUERY_SECS), run_sql(&live.pool, sql))
        .await
        .map_err(|_| "timeout".to_string())??;
    let mut tables = Vec::new();
    for row in result.rows {
        let schema = row.first().cloned().flatten().unwrap_or_default();
        let name = row.get(1).cloned().flatten().unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        tables.push(DbTable { schema, name });
        if tables.len() >= TABLE_CAP {
            break;
        }
    }
    Ok(tables)
}

fn catalogs_sql(engine: &str) -> Result<&'static str, String> {
    match engine {
        "mysql" => Ok(
            "SELECT schema_name FROM information_schema.SCHEMATA ORDER BY schema_name",
        ),
        "postgres" => Ok(
            "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1",
        ),
        _ => Err("no_switch_db".into()),
    }
}

fn current_sql(engine: &str) -> &'static str {
    if engine == "mysql" {
        "SELECT DATABASE()"
    } else {
        "SELECT current_database()"
    }
}

#[tauri::command]
pub async fn db_databases(
    state: State<'_, DbState>,
    session_id: String,
) -> Result<DbCatalogs, String> {
    let live = live_of(&state, &session_id).await?;
    let sql = catalogs_sql(&live.engine)?;
    let listed = tokio::time::timeout(Duration::from_secs(QUERY_SECS), run_sql(&live.pool, sql))
        .await
        .map_err(|_| "timeout".to_string())??;
    let mut names = names_from(listed);
    let current = {
        let cur = tokio::time::timeout(
            Duration::from_secs(QUERY_SECS),
            run_sql(&live.pool, current_sql(&live.engine)),
        )
        .await
        .map_err(|_| "timeout".to_string())??;
        names_from(cur).into_iter().next().unwrap_or_default()
    };
    if !current.is_empty() && !names.iter().any(|n| n == &current) {
        names.insert(0, current.clone());
    }
    Ok(DbCatalogs { current, names })
}

#[tauri::command]
pub async fn db_use(
    state: State<'_, DbState>,
    session_id: String,
    database: String,
) -> Result<(), String> {
    let name = catalog_name(&database)?.to_string();
    if state.script_cancel.lock().await.contains_key(&session_id) {
        return Err("script_running".into());
    }
    let mut req = {
        let map = state.sessions.lock().await;
        let live = map.get(&session_id).ok_or_else(|| "not_connected".to_string())?;
        if live.engine == "sqlite" {
            return Err("no_switch_db".into());
        }
        if live.req.database.trim() == name {
            return Ok(());
        }
        live.req.clone()
    };
    req.database = name;
    let new_pool = open_pool(&req).await?;
    let old = {
        let mut map = state.sessions.lock().await;
        let Some(live) = map.get_mut(&session_id) else {
            new_pool.close().await;
            return Err("not_connected".into());
        };
        live.req = req;
        std::mem::replace(&mut live.pool, new_pool)
    };
    old.close().await;
    Ok(())
}

#[tauri::command]
pub async fn db_script(
    app: AppHandle,
    state: State<'_, DbState>,
    req: DbScriptReq,
) -> Result<(), String> {
    let live = live_of(&state, &req.session_id).await?;
    let meta = tokio::fs::metadata(&req.path)
        .await
        .map_err(|_| "file_missing".to_string())?;
    if meta.len() > SCRIPT_FILE_MAX {
        return Err("file_too_large".into());
    }
    let bytes = tokio::fs::read(&req.path)
        .await
        .map_err(|_| "file_read".to_string())?;
    let sql = String::from_utf8(bytes).map_err(|_| "not_text".to_string())?;
    let stmts = split_statements(&sql, live.engine == "mysql");
    if stmts.is_empty() {
        return Err("no_statements".into());
    }
    let token = tokio_util::sync::CancellationToken::new();
    {
        let mut map = state.script_cancel.lock().await;
        if let Some(old) = map.insert(req.session_id.clone(), token.clone()) {
            old.cancel();
        }
    }
    let total = stmts.len() as u32;
    let mut cancelled = false;
    for (i, stmt) in stmts.iter().enumerate() {
        if token.is_cancelled() {
            cancelled = true;
            break;
        }
        let index = (i + 1) as u32;
        let preview = preview_sql(stmt);
        let kw = first_keyword(stmt);
        if req.select_only && !is_query(&kw) {
            let _ = app.emit(
                "db:script",
                DbScriptEvent {
                    session_id: req.session_id.clone(),
                    index,
                    total,
                    preview,
                    ok: false,
                    affected: 0,
                    elapsed_ms: 0,
                    error: Some("select_only".into()),
                    done: true,
                    cancelled: false,
                },
            );
            state.script_cancel.lock().await.remove(&req.session_id);
            return Ok(());
        }
        let started = Instant::now();
        let outcome = tokio::time::timeout(
            Duration::from_secs(SCRIPT_STMT_SECS),
            exec_stmt(&live.pool, stmt),
        )
        .await;
        let elapsed_ms = started.elapsed().as_millis() as u64;
        match outcome {
            Ok(Ok(affected)) => {
                let last = index == total;
                let _ = app.emit(
                    "db:script",
                    DbScriptEvent {
                        session_id: req.session_id.clone(),
                        index,
                        total,
                        preview,
                        ok: true,
                        affected,
                        elapsed_ms,
                        error: None,
                        done: last,
                        cancelled: false,
                    },
                );
            }
            Ok(Err(err)) => {
                let _ = app.emit(
                    "db:script",
                    DbScriptEvent {
                        session_id: req.session_id.clone(),
                        index,
                        total,
                        preview,
                        ok: false,
                        affected: 0,
                        elapsed_ms,
                        error: Some(err),
                        done: true,
                        cancelled: false,
                    },
                );
                state.script_cancel.lock().await.remove(&req.session_id);
                return Ok(());
            }
            Err(_) => {
                let _ = app.emit(
                    "db:script",
                    DbScriptEvent {
                        session_id: req.session_id.clone(),
                        index,
                        total,
                        preview,
                        ok: false,
                        affected: 0,
                        elapsed_ms,
                        error: Some("timeout".into()),
                        done: true,
                        cancelled: false,
                    },
                );
                state.script_cancel.lock().await.remove(&req.session_id);
                return Ok(());
            }
        }
    }
    if cancelled {
        let _ = app.emit(
            "db:script",
            DbScriptEvent {
                session_id: req.session_id.clone(),
                index: 0,
                total,
                preview: String::new(),
                ok: false,
                affected: 0,
                elapsed_ms: 0,
                error: None,
                done: true,
                cancelled: true,
            },
        );
    }
    state.script_cancel.lock().await.remove(&req.session_id);
    Ok(())
}

#[tauri::command]
pub async fn db_script_cancel(
    state: State<'_, DbState>,
    session_id: String,
) -> Result<(), String> {
    if let Some(tok) = state.script_cancel.lock().await.remove(&session_id) {
        tok.cancel();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{catalog_name, split_statements};

    #[test]
    fn splits_plain() {
        let s = split_statements("a; b; c", false);
        assert_eq!(s, ["a", "b", "c"]);
    }

    #[test]
    fn keeps_semicolon_in_string() {
        let s = split_statements("INSERT INTO t VALUES ('a;b'); SELECT 1", false);
        assert_eq!(s.len(), 2);
        assert!(s[0].contains("'a;b'"));
    }

    #[test]
    fn skips_dollar_body() {
        let sql = "CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; END; $$ LANGUAGE plpgsql; SELECT 1";
        let s = split_statements(sql, false);
        assert_eq!(s.len(), 2);
        assert!(s[0].contains("$$"));
        assert_eq!(s[1], "SELECT 1");
    }

    #[test]
    fn skips_comment_only() {
        let s = split_statements("-- hi;\nSELECT 1;", false);
        assert_eq!(s.len(), 1);
        assert!(s[0].contains("SELECT 1"));
        assert_eq!(split_statements("-- only", false).len(), 0);
    }

    #[test]
    fn catalog_name_ok() {
        assert_eq!(catalog_name(" foo ").unwrap(), "foo");
    }

    #[test]
    fn catalog_name_rejects() {
        assert!(catalog_name("").is_err());
        assert!(catalog_name("a/b").is_err());
        assert!(catalog_name("a\\b").is_err());
    }
}
