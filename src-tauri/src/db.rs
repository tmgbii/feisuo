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
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tiberius::{AuthMethod, Client as MssqlClient, Config as MssqlConfig, EncryptionLevel, QueryItem};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

type MssqlConn = MssqlClient<Compat<TcpStream>>;

const ROW_CAP: usize = 1000;
const CELL_CAP: usize = 8192;
const QUERY_SECS: u64 = 30;
const CONNECT_SECS: u64 = 15;
const SCRIPT_STMT_SECS: u64 = 120;
const SCRIPT_FILE_MAX: u64 = 256 * 1024 * 1024;
const TABLE_CAP: usize = 5000;
const CATALOG_CAP: usize = 5000;
const EXPORT_SECS: u64 = 600;
const INSERT_BATCH: usize = 80;

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
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub comment: String,
    pub pk: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbQueryResult {
    pub columns: Vec<DbColumn>,
    pub rows: Vec<Vec<Option<String>>>,
    pub affected: u64,
    pub elapsed_ms: u64,
    pub truncated: bool,
    pub kind: String,
    pub offset: u64,
    pub has_more: bool,
    pub paged: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTable {
    pub schema: String,
    pub name: String,
    pub comment: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbInspectReq {
    pub session_id: String,
    pub schema: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbInspectCol {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub nullable: bool,
    pub default: String,
    pub comment: String,
    pub pk: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbInspectRow {
    pub name: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTableInspect {
    pub schema: String,
    pub name: String,
    pub comment: String,
    pub estimate: String,
    pub size: String,
    pub columns: Vec<DbInspectCol>,
    pub indexes: Vec<DbInspectRow>,
    pub foreign_keys: Vec<DbInspectRow>,
    pub checks: Vec<DbInspectRow>,
    pub triggers: Vec<DbInspectRow>,
    pub ddl: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbExportReq {
    pub session_id: String,
    pub path: String,
    pub schema: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbExportResult {
    pub tables: u32,
    pub rows: u64,
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
    SqlServer(Arc<Mutex<MssqlConn>>),
}

impl LivePool {
    async fn close(self) {
        match self {
            Self::Postgres(p) => p.close().await,
            Self::Mysql(p) => p.close().await,
            Self::Sqlite(p) => p.close().await,
            Self::SqlServer(c) => {
                if let Ok(lock) = Arc::try_unwrap(c) {
                    let client = lock.into_inner();
                    let _ = client.close().await;
                }
            }
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
    if low.contains("no route")
        || low.contains("host is unreachable")
        || low.contains("network is unreachable")
    {
        return "local_network".into();
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

fn is_loopback_host(host: &str) -> bool {
    let h = host.trim().trim_start_matches('[').trim_end_matches(']');
    h == "127.0.0.1" || h == "localhost" || h == "::1" || h.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// 与 MQTT/TCP 同一条 BSD connect：优先 IPv4，避免 AAAA 先连被局域网策略挡掉。
async fn resolve_pref_v4(host: &str, port: u16) -> Result<String, String> {
    let h = host.trim();
    if h.is_empty() {
        return Err("missing_host".into());
    }
    let bare = h.trim_start_matches('[').trim_end_matches(']');
    if bare.parse::<IpAddr>().is_ok() {
        return Ok(bare.to_string());
    }
    let addrs: Vec<_> = tokio::time::timeout(
        Duration::from_secs(CONNECT_SECS),
        tokio::net::lookup_host((h, port)),
    )
    .await
    .map_err(|_| "timeout".to_string())?
    .map_err(map_err)?
    .collect();
    if let Some(a) = addrs.iter().find(|a| a.is_ipv4()) {
        return Ok(a.ip().to_string());
    }
    if let Some(a) = addrs.first() {
        return Ok(a.ip().to_string());
    }
    Err("unreachable".into())
}

async fn warmup_tcp(host: &str, port: u16) -> Result<(), String> {
    if is_loopback_host(host) {
        return Ok(());
    }
    let stream = tokio::time::timeout(
        Duration::from_secs(CONNECT_SECS),
        TcpStream::connect((host, port)),
    )
    .await
    .map_err(|_| "timeout".to_string())?
    .map_err(map_err)?;
    drop(stream);
    Ok(())
}

async fn open_pool(req: &DbConnectReq) -> Result<LivePool, String> {
    let mut req = req.clone();
    if req.engine != "sqlite" {
        crate::probe_local_network();
        req.host = resolve_pref_v4(&req.host, req.port).await?;
        warmup_tcp(&req.host, req.port).await?;
    }
    let url = connect_url(&req)?;
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
        "sqlserver" => open_mssql(&req).await,
        _ => Err("unsupported_db".into()),
    }
}

async fn open_mssql(req: &DbConnectReq) -> Result<LivePool, String> {
    if req.host.trim().is_empty() {
        return Err("missing_host".into());
    }
    let mut config = MssqlConfig::new();
    config.host(req.host.trim());
    config.port(req.port);
    config.authentication(AuthMethod::sql_server(req.user.trim(), &req.password));
    let db = req.database.trim();
    if !db.is_empty() {
        config.database(db);
    }
    config.encryption(EncryptionLevel::Required);
    config.trust_cert();
    let addr = config.get_addr();
    let timeout = Duration::from_secs(CONNECT_SECS);
    let tcp = tokio::time::timeout(timeout, TcpStream::connect(addr))
        .await
        .map_err(|_| "timeout".to_string())?
        .map_err(map_err)?;
    tcp.set_nodelay(true).map_err(map_err)?;
    let client = tokio::time::timeout(timeout, MssqlClient::connect(config, tcp.compat_write()))
        .await
        .map_err(|_| "timeout".to_string())?
        .map_err(map_err)?;
    Ok(LivePool::SqlServer(Arc::new(Mutex::new(client))))
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

fn cols_from_sqlx<R: Row>(row: &R) -> Vec<DbColumn> {
    row.columns()
        .iter()
        .map(|c| DbColumn {
            name: c.name().to_string(),
            type_name: c.type_info().to_string(),
            comment: String::new(),
            pk: false,
        })
        .collect()
}

macro_rules! collect_rows {
    ($pool:expr, $sql:expr, $cell:expr, $cap:expr) => {{
        let mut stream = sqlx::raw_sql($sql).fetch($pool);
        let mut columns: Vec<DbColumn> = Vec::new();
        let mut rows: Vec<Vec<Option<String>>> = Vec::new();
        let mut truncated = false;
        while let Some(item) = stream.next().await {
            let row = item.map_err(map_err)?;
            if columns.is_empty() {
                columns = cols_from_sqlx(&row);
            }
            if rows.len() >= $cap {
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
    run_sql_limited(pool, sql, ROW_CAP).await
}

async fn run_sql_limited(pool: &LivePool, sql: &str, cap: usize) -> Result<DbQueryResult, String> {
    let kw = first_keyword(sql);
    let started = Instant::now();
    if is_query(&kw) {
        let (columns, rows, truncated) = match pool {
            LivePool::Postgres(p) => collect_rows!(p, sql, cell_pg, cap),
            LivePool::Mysql(p) => collect_rows!(p, sql, cell_mysql, cap),
            LivePool::Sqlite(p) => collect_rows!(p, sql, cell_sqlite, cap),
            LivePool::SqlServer(c) => run_mssql_query(c, sql, cap).await?,
        };
        Ok(DbQueryResult {
            columns,
            rows,
            affected: 0,
            elapsed_ms: started.elapsed().as_millis() as u64,
            truncated,
            kind: "query".into(),
            offset: 0,
            has_more: false,
            paged: false,
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
            offset: 0,
            has_more: false,
            paged: false,
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
    if engine == "sqlserver" && req.database.trim().is_empty() {
        req.database = "master".into();
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

fn sql_lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

fn matches_word(bytes: &[u8], i: usize, word: &[u8]) -> bool {
    if i + word.len() > bytes.len() {
        return false;
    }
    if i > 0 && is_ident_byte(bytes[i - 1]) {
        return false;
    }
    let end = i + word.len();
    if end < bytes.len() && is_ident_byte(bytes[end]) {
        return false;
    }
    bytes[i..end].eq_ignore_ascii_case(word)
}

fn read_ident(sql: &str, i: usize) -> Option<(String, usize)> {
    let b = sql.as_bytes();
    if i >= b.len() {
        return None;
    }
    match b[i] {
        b'`' | b'"' => {
            let q = b[i];
            let mut j = i + 1;
            let mut out = String::new();
            while j < b.len() {
                if b[j] == q {
                    if j + 1 < b.len() && b[j + 1] == q {
                        out.push(q as char);
                        j += 2;
                        continue;
                    }
                    return Some((out, j + 1));
                }
                out.push(b[j] as char);
                j += 1;
            }
            None
        }
        b'[' => {
            let mut j = i + 1;
            let mut out = String::new();
            while j < b.len() {
                if b[j] == b']' {
                    if j + 1 < b.len() && b[j + 1] == b']' {
                        out.push(']');
                        j += 2;
                        continue;
                    }
                    return Some((out, j + 1));
                }
                out.push(b[j] as char);
                j += 1;
            }
            None
        }
        _ if is_ident_byte(b[i]) => {
            let mut j = i;
            while j < b.len() && is_ident_byte(b[j]) {
                j += 1;
            }
            Some((sql[i..j].to_string(), j))
        }
        _ => None,
    }
}

fn simple_from_table(sql: &str) -> Option<(String, String)> {
    let b = sql.as_bytes();
    let mut i = 0;
    let mut in_s = false;
    let mut in_d = false;
    let mut in_bt = false;
    while i < b.len() {
        let c = b[i];
        if in_s {
            if c == b'\'' {
                in_s = false;
            }
            i += 1;
            continue;
        }
        if in_d {
            if c == b'"' {
                in_d = false;
            }
            i += 1;
            continue;
        }
        if in_bt {
            if c == b'`' {
                in_bt = false;
            }
            i += 1;
            continue;
        }
        if c == b'\'' {
            in_s = true;
            i += 1;
            continue;
        }
        if c == b'"' {
            in_d = true;
            i += 1;
            continue;
        }
        if c == b'`' {
            in_bt = true;
            i += 1;
            continue;
        }
        if matches_word(b, i, b"FROM") {
            i += 4;
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < b.len() && b[i] == b'(' {
                return None;
            }
            let (first, next) = read_ident(sql, i)?;
            i = next;
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < b.len() && b[i] == b'.' {
                i += 1;
                while i < b.len() && b[i].is_ascii_whitespace() {
                    i += 1;
                }
                let (second, _) = read_ident(sql, i)?;
                return Some((first, second));
            }
            return Some((String::new(), first));
        }
        i += 1;
    }
    None
}

fn col_meta_sql(engine: &str, schema: &str, table: &str) -> Option<String> {
    let t = sql_lit(table);
    match engine {
        "mysql" => {
            let db = if schema.is_empty() {
                "DATABASE()".into()
            } else {
                sql_lit(schema)
            };
            Some(format!(
                "SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_COMMENT, COLUMN_KEY \
                 FROM information_schema.COLUMNS \
                 WHERE TABLE_SCHEMA = {db} AND TABLE_NAME = {t}"
            ))
        }
        "postgres" => {
            let s = sql_lit(if schema.is_empty() { "public" } else { schema });
            Some(format!(
                "SELECT a.attname, format_type(a.atttypid, a.atttypmod), \
                 COALESCE(col_description(c.oid, a.attnum), ''), \
                 CASE WHEN EXISTS ( \
                   SELECT 1 FROM pg_index i \
                   WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey) \
                 ) THEN '1' ELSE '0' END \
                 FROM pg_attribute a \
                 JOIN pg_class c ON c.oid = a.attrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = {s} AND c.relname = {t} \
                   AND a.attnum > 0 AND NOT a.attisdropped"
            ))
        }
        "sqlite" => Some(format!(
            "SELECT name, type, '', CAST(pk AS TEXT) FROM pragma_table_info({t})"
        )),
        "sqlserver" => {
            let s = sql_lit(if schema.is_empty() { "dbo" } else { schema });
            Some(format!(
                "SELECT c.name, ty.name, ISNULL(CAST(ep.value AS nvarchar(4000)), ''), \
                 CASE WHEN i.is_primary_key = 1 THEN '1' ELSE '0' END \
                 FROM sys.columns c \
                 JOIN sys.types ty ON ty.user_type_id = c.user_type_id \
                 JOIN sys.tables tb ON tb.object_id = c.object_id \
                 JOIN sys.schemas sc ON sc.schema_id = tb.schema_id \
                 LEFT JOIN sys.index_columns ic \
                   ON ic.object_id = c.object_id AND ic.column_id = c.column_id \
                 LEFT JOIN sys.indexes i \
                   ON i.object_id = ic.object_id AND i.index_id = ic.index_id AND i.is_primary_key = 1 \
                 LEFT JOIN sys.extended_properties ep \
                   ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = N'MS_Description' \
                 WHERE sc.name = {s} AND tb.name = {t}"
            ))
        }
        _ => None,
    }
}

async fn enrich_columns(live: &LiveDb, sql: &str, columns: &mut [DbColumn]) {
    if columns.is_empty() {
        return;
    }
    let Some((schema, table)) = simple_from_table(sql) else {
        return;
    };
    let Some(meta) = col_meta_sql(&live.engine, &schema, &table) else {
        return;
    };
    let Ok(result) = run_sql(&live.pool, &meta).await else {
        return;
    };
    let mut map = HashMap::new();
    for row in result.rows {
        let name = row.first().cloned().flatten().unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let type_name = row.get(1).cloned().flatten().unwrap_or_default();
        let comment = row.get(2).cloned().flatten().unwrap_or_default();
        let pk = row.get(3).cloned().flatten().unwrap_or_default();
        let is_pk = pk == "1" || pk.eq_ignore_ascii_case("pri");
        map.insert(name.to_ascii_lowercase(), (type_name, comment, is_pk));
    }
    for col in columns.iter_mut() {
        if let Some((ty, comment, pk)) = map.get(&col.name.to_ascii_lowercase()) {
            if !ty.is_empty() {
                col.type_name = ty.clone();
            }
            col.comment = comment.clone();
            col.pk = *pk;
        }
    }
}

const PAGE_MAX: u32 = 1000;

fn top_level_words(sql: &str, mysql: bool) -> Vec<(usize, String)> {
    let b = sql.as_bytes();
    let n = b.len();
    let mut i = 0;
    let mut depth = 0i32;
    let mut words = Vec::new();
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
        if b[i] == b'\'' || b[i] == b'"' || b[i] == b'`' {
            let q = b[i];
            i += 1;
            while i < n {
                if q == b'\'' && mysql && b[i] == b'\\' && i + 1 < n {
                    i += 2;
                    continue;
                }
                if b[i] == q {
                    i += 1;
                    if i < n && b[i] == q {
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
        if b[i] == b'[' {
            i += 1;
            while i < n {
                if b[i] == b']' {
                    i += 1;
                    if i < n && b[i] == b']' {
                        i += 1;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            continue;
        }
        if b[i] == b'(' {
            depth += 1;
            i += 1;
            continue;
        }
        if b[i] == b')' {
            depth = depth.saturating_sub(1);
            i += 1;
            continue;
        }
        if depth == 0 && b[i].is_ascii_alphabetic() {
            let start = i;
            i += 1;
            while i < n && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                i += 1;
            }
            if let Some(word) = sql.get(start..i) {
                words.push((start, word.to_ascii_uppercase()));
            }
            continue;
        }
        i += 1;
    }
    words
}

fn blocks_page(words: &[(usize, String)]) -> bool {
    for (i, (_, word)) in words.iter().enumerate() {
        if matches!(
            word.as_str(),
            "LIMIT"
                | "TOP"
                | "FETCH"
                | "OFFSET"
                | "INTO"
                | "FOR"
                | "RETURNING"
                | "OUTPUT"
                | "INSERT"
                | "UPDATE"
                | "DELETE"
                | "MERGE"
        ) {
            return true;
        }
        if word == "LOCK" && words.get(i + 1).is_some_and(|(_, next)| next == "IN") {
            return true;
        }
    }
    false
}

fn pageable_body(engine: &str, sql: &str) -> Option<String> {
    let parts = split_statements(sql, engine == "mysql");
    if parts.len() != 1 {
        return None;
    }
    let body = parts[0].trim();
    if body.is_empty() {
        return None;
    }
    let kw = first_keyword(body);
    if !matches!(kw.as_str(), "SELECT" | "WITH" | "VALUES" | "TABLE") {
        return None;
    }
    let words = top_level_words(body, engine == "mysql");
    if blocks_page(&words) {
        return None;
    }
    Some(body.to_string())
}

fn has_top_order(sql: &str, mysql: bool) -> bool {
    let words = top_level_words(sql, mysql);
    words.windows(2).any(|pair| pair[0].1 == "ORDER" && pair[1].1 == "BY")
}

fn without_trailing_order<'a>(sql: &'a str, mysql: bool) -> &'a str {
    let words = top_level_words(sql, mysql);
    let mut at = None;
    for pair in words.windows(2) {
        if pair[0].1 == "ORDER" && pair[1].1 == "BY" {
            at = Some(pair[0].0);
        }
    }
    match at {
        Some(i) => sql.get(..i).unwrap_or(sql).trim(),
        None => sql,
    }
}

fn page_sql(engine: &str, sql: &str, limit: u32, offset: u32) -> Option<String> {
    let body = pageable_body(engine, sql)?;
    let limit = limit.clamp(1, PAGE_MAX + 1);
    if engine == "sqlserver" {
        if has_top_order(&body, false) {
            Some(format!("{body}\nOFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY"))
        } else {
            Some(format!(
                "{body}\nORDER BY (SELECT NULL) OFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY"
            ))
        }
    } else {
        Some(format!("{body}\nLIMIT {limit} OFFSET {offset}"))
    }
}

fn count_sql(engine: &str, sql: &str) -> Option<String> {
    let body = pageable_body(engine, sql)?;
    let inner = without_trailing_order(&body, engine == "mysql");
    if inner.is_empty() {
        return None;
    }
    Some(format!("SELECT COUNT(*) AS n FROM (\n{inner}\n) AS _fs"))
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
    let page_limit = req.limit.filter(|n| *n > 0).map(|n| n.min(PAGE_MAX));
    let page_offset = req.offset.unwrap_or(0);
    let (exec_sql, paged_limit) = if let Some(limit) = page_limit {
        match page_sql(&live.engine, sql, limit + 1, page_offset) {
            Some(wrapped) => (wrapped, Some(limit)),
            None => (sql.to_string(), None),
        }
    } else {
        (sql.to_string(), None)
    };
    let cap = paged_limit.map(|n| n as usize + 1).unwrap_or(ROW_CAP);
    let mut result = tokio::time::timeout(
        Duration::from_secs(QUERY_SECS),
        run_sql_limited(&live.pool, &exec_sql, cap),
    )
    .await
    .map_err(|_| "timeout".to_string())??;
    if let Some(limit) = paged_limit {
        if result.kind == "query" {
            let keep = limit as usize;
            let has_more = result.rows.len() > keep;
            if has_more {
                result.rows.truncate(keep);
            }
            result.truncated = false;
            result.has_more = has_more;
            result.paged = true;
            result.offset = u64::from(page_offset);
        }
    }
    if result.kind == "query" {
        enrich_columns(&live, sql, &mut result.columns).await;
    }
    Ok(result)
}

#[tauri::command]
pub async fn db_count(state: State<'_, DbState>, session_id: String, sql: String) -> Result<u64, String> {
    let sql = sql.trim();
    if sql.is_empty() {
        return Err("sql_empty".into());
    }
    if sql.len() > 1024 * 1024 {
        return Err("sql_too_long".into());
    }
    let live = live_of(&state, &session_id).await?;
    let wrapped = count_sql(&live.engine, sql).ok_or_else(|| "not_pageable".to_string())?;
    let result = tokio::time::timeout(Duration::from_secs(QUERY_SECS), run_sql(&live.pool, &wrapped))
        .await
        .map_err(|_| "timeout".to_string())??;
    let cell = result
        .rows
        .first()
        .and_then(|row| row.first())
        .and_then(|cell| cell.as_ref())
        .ok_or_else(|| "not_pageable".to_string())?;
    cell.parse::<u64>().map_err(|_| "not_pageable".to_string())
}

fn tables_sql(engine: &str) -> &'static str {
    match engine {
        "mysql" => {
            "SELECT table_schema, table_name, table_comment FROM information_schema.tables \
             WHERE table_type = 'BASE TABLE' AND table_schema = DATABASE() \
             ORDER BY table_name"
        }
        "sqlite" => {
            "SELECT '' AS table_schema, name AS table_name, '' AS table_comment FROM sqlite_master \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        }
        "sqlserver" => {
            "SELECT SCHEMA_NAME(t.schema_id), t.name, \
             ISNULL(CAST(ep.value AS nvarchar(4000)), '') \
             FROM sys.tables t \
             LEFT JOIN sys.extended_properties ep \
               ON ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = N'MS_Description' \
             ORDER BY 1, 2"
        }
        _ => {
            "SELECT n.nspname, c.relname, COALESCE(obj_description(c.oid), '') \
             FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.relkind = 'r' \
               AND n.nspname NOT IN ('pg_catalog', 'information_schema') \
             ORDER BY 1, 2"
        }
    }
}

fn tables_from(result: DbQueryResult) -> Vec<DbTable> {
    let mut tables = Vec::new();
    for row in result.rows {
        let schema = row.first().cloned().flatten().unwrap_or_default();
        let name = row.get(1).cloned().flatten().unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        tables.push(DbTable {
            schema,
            name,
            comment: row.get(2).cloned().flatten().unwrap_or_default(),
        });
        if tables.len() >= TABLE_CAP {
            break;
        }
    }
    tables
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

fn go_repeat(line: &str) -> Option<u32> {
    let t = line.split("--").next().unwrap_or(line).trim();
    let b = t.as_bytes();
    if b.len() < 2 || !b[..2].eq_ignore_ascii_case(b"GO") {
        return None;
    }
    if b.len() == 2 {
        return Some(1);
    }
    if !b[2].is_ascii_whitespace() {
        return None;
    }
    let rest = t[2..].trim();
    if rest.is_empty() {
        return Some(1);
    }
    rest.parse::<u32>().ok().filter(|n| *n > 0 && *n <= 100)
}

fn split_go(sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < sql.len() {
        let end = sql[i..].find('\n').map(|n| i + n + 1).unwrap_or(sql.len());
        if let Some(n) = go_repeat(&sql[i..end]) {
            let batch = sql[start..i].trim();
            if !batch.is_empty() {
                for _ in 0..n {
                    out.push(batch.to_string());
                }
            }
            start = end;
        }
        i = end;
    }
    let batch = sql[start..].trim();
    if !batch.is_empty() {
        out.push(batch.to_string());
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

fn mssql_type_name(t: tiberius::ColumnType) -> String {
    match format!("{t:?}").as_str() {
        "NVarchar" => "nvarchar".into(),
        "NChar" => "nchar".into(),
        "BigVarChar" => "varchar".into(),
        "BigChar" => "char".into(),
        "Int1" => "tinyint".into(),
        "Int2" => "smallint".into(),
        "Int4" => "int".into(),
        "Int8" => "bigint".into(),
        "Float4" => "real".into(),
        "Float8" => "float".into(),
        "Bit" => "bit".into(),
        "Datetime" | "Datetime2" => "datetime".into(),
        "Datetime4" => "smalldatetime".into(),
        "BigVarBin" => "varbinary".into(),
        "BigBinary" => "binary".into(),
        other => other.to_ascii_lowercase(),
    }
}

fn cell_mssql(row: &tiberius::Row, i: usize) -> Option<String> {
    if let Ok(Some(v)) = row.try_get::<&str, _>(i) {
        return Some(clip(v.to_string()));
    }
    if let Ok(Some(v)) = row.try_get::<&[u8], _>(i) {
        return Some(bytes_cell(v.to_vec()));
    }
    if let Ok(Some(v)) = row.try_get::<i64, _>(i) {
        return Some(v.to_string());
    }
    if let Ok(Some(v)) = row.try_get::<i32, _>(i) {
        return Some(v.to_string());
    }
    if let Ok(Some(v)) = row.try_get::<i16, _>(i) {
        return Some(v.to_string());
    }
    if let Ok(Some(v)) = row.try_get::<u8, _>(i) {
        return Some(v.to_string());
    }
    if let Ok(Some(v)) = row.try_get::<f64, _>(i) {
        return Some(v.to_string());
    }
    if let Ok(Some(v)) = row.try_get::<f32, _>(i) {
        return Some(v.to_string());
    }
    if let Ok(Some(v)) = row.try_get::<bool, _>(i) {
        return Some(if v { "1".into() } else { "0".into() });
    }
    if let Ok(Some(v)) = row.try_get::<NaiveDateTime, _>(i) {
        return Some(v.format("%Y-%m-%d %H:%M:%S").to_string());
    }
    if let Ok(Some(v)) = row.try_get::<NaiveDate, _>(i) {
        return Some(v.to_string());
    }
    if let Ok(Some(v)) = row.try_get::<NaiveTime, _>(i) {
        return Some(v.to_string());
    }
    if let Ok(Some(v)) = row.try_get::<Decimal, _>(i) {
        return Some(v.to_string());
    }
    if let Ok(None) = row.try_get::<&str, _>(i) {
        return None;
    }
    Some("?".into())
}

async fn run_mssql_query(
    client: &Arc<Mutex<MssqlConn>>,
    sql: &str,
    cap: usize,
) -> Result<(Vec<DbColumn>, Vec<Vec<Option<String>>>, bool), String> {
    let mut cli = client.lock().await;
    let mut stream = cli.simple_query(sql).await.map_err(map_err)?;
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    let mut truncated = false;
    while let Some(item) = stream.next().await {
        match item.map_err(map_err)? {
            QueryItem::Metadata(meta) => {
                columns = meta
                    .columns()
                    .iter()
                    .map(|c| DbColumn {
                        name: c.name().to_string(),
                        type_name: mssql_type_name(c.column_type()),
                        comment: String::new(),
                        pk: false,
                    })
                    .collect();
            }
            QueryItem::Row(row) => {
                if rows.len() >= cap {
                    truncated = true;
                    continue;
                }
                let n = row.len();
                let mut line = Vec::with_capacity(n);
                for i in 0..n {
                    line.push(cell_mssql(&row, i));
                }
                rows.push(line);
            }
        }
    }
    Ok((columns, rows, truncated))
}

async fn exec_stmt(pool: &LivePool, sql: &str) -> Result<u64, String> {
    let n = match pool {
        LivePool::Postgres(p) => sqlx::raw_sql(sql).execute(p).await.map_err(map_err)?.rows_affected(),
        LivePool::Mysql(p) => sqlx::raw_sql(sql).execute(p).await.map_err(map_err)?.rows_affected(),
        LivePool::Sqlite(p) => sqlx::raw_sql(sql).execute(p).await.map_err(map_err)?.rows_affected(),
        LivePool::SqlServer(c) => {
            let mut cli = c.lock().await;
            let res = cli.execute(sql, &[]).await.map_err(map_err)?;
            res.rows_affected().iter().copied().sum()
        }
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
    Ok(tables_from(result))
}

fn ident_name(name: &str) -> Result<&str, String> {
    let n = name.trim();
    if n.is_empty() || n.len() > 128 || n.contains('\0') || n.contains(';') || n.contains('\n') {
        return Err("bad_ident".into());
    }
    Ok(n)
}

fn ident_sql(engine: &str, name: &str) -> String {
    match engine {
        "mysql" => format!("`{}`", name.replace('`', "``")),
        "sqlserver" => format!("[{}]", name.replace(']', "]]")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

fn table_rel(engine: &str, schema: &str, table: &str) -> String {
    if schema.is_empty() || engine == "mysql" || engine == "sqlite" {
        return ident_sql(engine, table);
    }
    format!("{}.{}", ident_sql(engine, schema), ident_sql(engine, table))
}

fn row_cell(row: &[Option<String>], i: usize) -> String {
    row.get(i).cloned().flatten().unwrap_or_default()
}

fn as_bool(s: &str) -> bool {
    matches!(
        s.trim().to_ascii_lowercase().as_str(),
        "1" | "t" | "true" | "yes" | "y" | "pri"
    )
}

fn pair_rows(rows: Vec<Vec<Option<String>>>) -> Vec<DbInspectRow> {
    rows.into_iter()
        .filter_map(|row| {
            let name = row_cell(&row, 0);
        if name.is_empty() {
                return None;
            }
            Some(DbInspectRow {
                name,
                detail: row_cell(&row, 1),
            })
        })
        .collect()
}

fn compose_ddl(engine: &str, schema: &str, table: &str, cols: &[DbInspectCol]) -> String {
    if cols.is_empty() {
        return String::new();
    }
    let rel = table_rel(engine, schema, table);
    let mut lines = Vec::new();
    for c in cols {
        let mut line = format!("  {} {}", ident_sql(engine, &c.name), c.type_name);
        if !c.nullable {
            line.push_str(" NOT NULL");
        }
        if !c.default.is_empty() {
            line.push_str(" DEFAULT ");
            line.push_str(&c.default);
        }
        lines.push(line);
    }
    let pks: Vec<String> = cols
        .iter()
        .filter(|c| c.pk)
        .map(|c| ident_sql(engine, &c.name))
        .collect();
    if !pks.is_empty() {
        lines.push(format!("  PRIMARY KEY ({})", pks.join(", ")));
    }
    format!("CREATE TABLE {rel} (\n{}\n)", lines.join(",\n"))
}

async fn query_opt(live: &LiveDb, sql: &str) -> Option<DbQueryResult> {
    tokio::time::timeout(Duration::from_secs(QUERY_SECS), run_sql(&live.pool, sql))
        .await
        .ok()
        .and_then(Result::ok)
}

fn mysql_indexes(rows: Vec<Vec<Option<String>>>) -> Vec<DbInspectRow> {
    let mut order = Vec::new();
    let mut map: HashMap<String, (bool, Vec<String>)> = HashMap::new();
    for row in rows {
        let key = row_cell(&row, 2);
        if key.is_empty() {
            continue;
        }
        let unique = row_cell(&row, 1) == "0";
        let col = row_cell(&row, 4);
        let e = map.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            (unique, Vec::new())
        });
        if !col.is_empty() {
            e.1.push(col);
        }
    }
    order
        .into_iter()
        .filter_map(|key| {
            let (unique, cols) = map.get(&key)?;
            let mark = if key.eq_ignore_ascii_case("PRIMARY") {
                "PK"
            } else if *unique {
                "UNIQUE"
            } else {
                "INDEX"
            };
            Some(DbInspectRow {
                name: key,
                detail: format!("{mark} ({})", cols.join(", ")),
            })
        })
        .collect()
}

async fn inspect_table(live: &LiveDb, schema: &str, table: &str) -> Result<DbTableInspect, String> {
    let engine = live.engine.as_str();
    let rel = table_rel(engine, schema, table);
    let t = sql_lit(table);
    let mut info = DbTableInspect {
        schema: schema.to_string(),
        name: table.to_string(),
        comment: String::new(),
        estimate: String::new(),
        size: String::new(),
        columns: Vec::new(),
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        checks: Vec::new(),
        triggers: Vec::new(),
        ddl: String::new(),
    };
    match engine {
        "mysql" => {
            if let Some(r) = query_opt(
                live,
                &format!(
                    "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT, COLUMN_KEY \
                     FROM information_schema.COLUMNS \
                     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = {t} \
                     ORDER BY ORDINAL_POSITION"
                ),
            )
            .await
            {
                info.columns = r
                    .rows
                    .into_iter()
                    .filter_map(|row| {
                        let name = row_cell(&row, 0);
                        if name.is_empty() {
                            return None;
                        }
                        Some(DbInspectCol {
                            name,
                            type_name: row_cell(&row, 1),
                            nullable: row_cell(&row, 2).eq_ignore_ascii_case("yes"),
                            default: row_cell(&row, 3),
                            comment: row_cell(&row, 4),
                            pk: row_cell(&row, 5).eq_ignore_ascii_case("pri"),
                        })
                    })
                    .collect();
            }
            if let Some(r) = query_opt(live, &format!("SHOW INDEX FROM {rel}")).await {
                info.indexes = mysql_indexes(r.rows);
            }
            if let Some(r) = query_opt(
                live,
                &format!(
                    "SELECT CONSTRAINT_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION), \
                     REFERENCED_TABLE_NAME, GROUP_CONCAT(REFERENCED_COLUMN_NAME ORDER BY ORDINAL_POSITION) \
                     FROM information_schema.KEY_COLUMN_USAGE \
                     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = {t} AND REFERENCED_TABLE_NAME IS NOT NULL \
                     GROUP BY CONSTRAINT_NAME, REFERENCED_TABLE_NAME"
                ),
            )
            .await
            {
                info.foreign_keys = r
                    .rows
                    .into_iter()
                    .filter_map(|row| {
                        let name = row_cell(&row, 0);
                        if name.is_empty() {
                            return None;
                        }
                        Some(DbInspectRow {
                            name,
                            detail: format!(
                                "({}) → {}.({})",
                                row_cell(&row, 1),
                                row_cell(&row, 2),
                                row_cell(&row, 3)
                            ),
                        })
                    })
                    .collect();
            }
            if let Some(r) = query_opt(
                live,
                &format!(
                    "SELECT CONSTRAINT_NAME, CONSTRAINT_TYPE \
                     FROM information_schema.TABLE_CONSTRAINTS \
                     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = {t} \
                       AND CONSTRAINT_TYPE IN ('UNIQUE', 'CHECK')"
                ),
            )
            .await
            {
                info.checks = pair_rows(r.rows);
            }
            if let Some(r) = query_opt(live, &format!("SHOW TRIGGERS WHERE `Table` = {t}")).await {
                info.triggers = r
                    .rows
                    .into_iter()
                    .filter_map(|row| {
                        let name = row_cell(&row, 0);
                        if name.is_empty() {
                            return None;
                        }
                        Some(DbInspectRow {
                            name,
                            detail: format!("{} {} {}", row_cell(&row, 4), row_cell(&row, 1), row_cell(&row, 3)),
                        })
                    })
                    .collect();
            }
            if let Some(r) = query_opt(
                live,
                &format!(
                    "SELECT TABLE_ROWS, DATA_LENGTH + INDEX_LENGTH, TABLE_COMMENT \
                     FROM information_schema.TABLES \
                     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = {t}"
                ),
            )
            .await
            {
                if let Some(row) = r.rows.into_iter().next() {
                    info.estimate = row_cell(&row, 0);
                    let bytes = row_cell(&row, 1);
                    if !bytes.is_empty() {
                        info.size = format!("{bytes} B");
                    }
                    info.comment = row_cell(&row, 2);
                }
            }
            if let Some(r) = query_opt(live, &format!("SHOW CREATE TABLE {rel}")).await {
                if let Some(row) = r.rows.into_iter().next() {
                    info.ddl = row_cell(&row, 1);
                }
            }
        }
        "sqlite" => {
            if let Some(r) = query_opt(live, &format!("SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info({t})")).await
            {
                info.columns = r
                    .rows
                    .into_iter()
                    .filter_map(|row| {
                        let name = row_cell(&row, 0);
                        if name.is_empty() {
                            return None;
                        }
                        Some(DbInspectCol {
                            name,
                            type_name: row_cell(&row, 1),
                            nullable: !as_bool(&row_cell(&row, 2)),
                            default: row_cell(&row, 3),
                            comment: String::new(),
                            pk: as_bool(&row_cell(&row, 4)),
                        })
                    })
                    .collect();
            }
            if let Some(r) = query_opt(
                live,
                &format!("SELECT name, CASE WHEN \"unique\" = 1 THEN 'UNIQUE' ELSE 'INDEX' END || ' · ' || origin FROM pragma_index_list({t})"),
            )
            .await
            {
                info.indexes = pair_rows(r.rows);
            }
            if let Some(r) = query_opt(
                live,
                &format!("SELECT \"from\", \"table\" || '(' || COALESCE(\"to\", '') || ')' FROM pragma_foreign_key_list({t})"),
            )
            .await
            {
                info.foreign_keys = pair_rows(r.rows);
            }
            if let Some(r) = query_opt(
                live,
                &format!("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = {t}"),
            )
            .await
            {
                info.triggers = pair_rows(r.rows);
            }
            if let Some(r) = query_opt(
                live,
                &format!("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = {t}"),
            )
            .await
            {
                info.ddl = r.rows.into_iter().next().map(|row| row_cell(&row, 0)).unwrap_or_default();
            }
            if let Some(r) = query_opt(
                live,
                &format!("SELECT SUM(pgsize) FROM dbstat WHERE name = {t}"),
            )
            .await
            {
                if let Some(row) = r.rows.into_iter().next() {
                    let bytes = row_cell(&row, 0);
                    if !bytes.is_empty() {
                        info.size = format!("{bytes} B");
                    }
                }
            }
        }
        "sqlserver" => {
            let s = sql_lit(if schema.is_empty() { "dbo" } else { schema });
            let obj = format!("OBJECT_ID({s} + '.' + {t})");
            if let Some(r) = query_opt(
                live,
                &format!(
                    "SELECT c.name, ty.name \
                     + CASE WHEN ty.name IN ('nvarchar','varchar','nchar','char','varbinary','binary') \
                       THEN '(' + CASE WHEN c.max_length < 0 THEN 'max' ELSE CAST(c.max_length AS varchar(16)) END + ')' \
                       WHEN ty.name IN ('decimal','numeric') \
                       THEN '(' + CAST(c.precision AS varchar(8)) + ',' + CAST(c.scale AS varchar(8)) + ')' \
                       ELSE '' END, \
                     c.is_nullable, \
                     ISNULL(OBJECT_DEFINITION(c.default_object_id), ''), \
                     ISNULL(CAST(ep.value AS nvarchar(4000)), ''), \
                     CASE WHEN i.is_primary_key = 1 THEN 1 ELSE 0 END \
                     FROM sys.columns c \
                     JOIN sys.types ty ON ty.user_type_id = c.user_type_id \
                     LEFT JOIN sys.index_columns ic \
                       ON ic.object_id = c.object_id AND ic.column_id = c.column_id \
                     LEFT JOIN sys.indexes i \
                       ON i.object_id = ic.object_id AND i.index_id = ic.index_id AND i.is_primary_key = 1 \
                     LEFT JOIN sys.extended_properties ep \
                       ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = N'MS_Description' \
                     WHERE c.object_id = {obj} \
                     ORDER BY c.column_id"
                ),
            )
            .await
            {
                info.columns = r
                    .rows
                    .into_iter()
                    .filter_map(|row| {
                        let name = row_cell(&row, 0);
                        if name.is_empty() {
                            return None;
                        }
                        Some(DbInspectCol {
                            name,
                            type_name: row_cell(&row, 1),
                            nullable: as_bool(&row_cell(&row, 2)),
                            default: row_cell(&row, 3),
                            comment: row_cell(&row, 4),
                            pk: as_bool(&row_cell(&row, 5)),
                        })
                    })
                    .collect();
            }
            if let Some(r) = query_opt(
                live,
                &format!(
                    "SELECT i.name, \
                     CASE WHEN i.is_primary_key = 1 THEN 'PK' WHEN i.is_unique = 1 THEN 'UNIQUE' ELSE i.type_desc END \
                     FROM sys.indexes i \
                     WHERE i.object_id = {obj} AND i.name IS NOT NULL \
                     ORDER BY i.index_id"
                ),
            )
            .await
            {
                info.indexes = pair_rows(r.rows);
            }
            if let Some(r) = query_opt(
                live,
                &format!(
                    "SELECT fk.name, \
                     COL_NAME(fkc.parent_object_id, fkc.parent_column_id) + ' → ' + \
                     OBJECT_SCHEMA_NAME(fk.referenced_object_id) + '.' + \
                     OBJECT_NAME(fk.referenced_object_id) + '(' + \
                     COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) + ')' \
                     FROM sys.foreign_keys fk \
                     JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
                     WHERE fk.parent_object_id = {obj}"
                ),
            )
            .await
            {
                info.foreign_keys = pair_rows(r.rows);
            }
            if let Some(r) = query_opt(
                live,
                &format!("SELECT name, definition FROM sys.check_constraints WHERE parent_object_id = {obj}"),
            )
            .await
            {
                info.checks = pair_rows(r.rows);
            }
            if let Some(r) = query_opt(
                live,
                &format!(
                    "SELECT name, type_desc + CASE WHEN is_disabled = 1 THEN ' disabled' ELSE '' END \
                     FROM sys.triggers WHERE parent_id = {obj}"
                ),
            )
            .await
            {
                info.triggers = pair_rows(r.rows);
            }
            if let Some(r) = query_opt(
                live,
                &format!(
                    "SELECT SUM(CASE WHEN p.index_id IN (0, 1) THEN p.rows ELSE 0 END), \
                     SUM(a.total_pages) * 8 \
                     FROM sys.partitions p \
                     JOIN sys.allocation_units a ON a.container_id = p.partition_id \
                     WHERE p.object_id = {obj}"
                ),
            )
            .await
            {
                if let Some(row) = r.rows.into_iter().next() {
                    info.estimate = row_cell(&row, 0);
                    let kb = row_cell(&row, 1);
                    if !kb.is_empty() {
                        info.size = format!("{kb} KB");
                    }
                }
            }
            if let Some(r) = query_opt(
                live,
                &format!(
                    "SELECT CAST(ep.value AS nvarchar(4000)) \
                     FROM sys.extended_properties ep \
                     WHERE ep.major_id = {obj} AND ep.minor_id = 0 AND ep.name = N'MS_Description'"
                ),
            )
            .await
            {
                if let Some(row) = r.rows.into_iter().next() {
                    info.comment = row_cell(&row, 0);
                }
            }
        }
        _ => {
            let s = sql_lit(if schema.is_empty() { "public" } else { schema });
            if let Some(r) = query_opt(
                live,
                &format!(
                    "SELECT a.attname, format_type(a.atttypid, a.atttypmod), \
                     NOT a.attnotnull, \
                     COALESCE(pg_get_expr(ad.adbin, ad.adrelid), ''), \
                     COALESCE(col_description(c.oid, a.attnum), ''), \
                     EXISTS ( \
                       SELECT 1 FROM pg_index i \
                       WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey) \
                     ) \
                     FROM pg_attribute a \
                     JOIN pg_class c ON c.oid = a.attrelid \
                     JOIN pg_namespace n ON n.oid = c.relnamespace \
                     LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum \
                     WHERE n.nspname = {s} AND c.relname = {t} \
                       AND a.attnum > 0 AND NOT a.attisdropped \
                     ORDER BY a.attnum"
                ),
            )
            .await
            {
                info.columns = r
                    .rows
                    .into_iter()
                    .filter_map(|row| {
                        let name = row_cell(&row, 0);
                        if name.is_empty() {
                            return None;
                        }
                        Some(DbInspectCol {
                            name,
                            type_name: row_cell(&row, 1),
                            nullable: as_bool(&row_cell(&row, 2)),
                            default: row_cell(&row, 3),
                            comment: row_cell(&row, 4),
                            pk: as_bool(&row_cell(&row, 5)),
                        })
                    })
                    .collect();
            }
            if let Some(r) = query_opt(
                live,
                &format!(
                    "SELECT i.relname, \
                     CASE WHEN ix.indisprimary THEN 'PK' WHEN ix.indisunique THEN 'UNIQUE' ELSE 'INDEX' END \
                     || ' · ' || pg_get_indexdef(ix.indexrelid) \
                     FROM pg_index ix \
                     JOIN pg_class tbl ON tbl.oid = ix.indrelid \
                     JOIN pg_class i ON i.oid = ix.indexrelid \
                     JOIN pg_namespace n ON n.oid = tbl.relnamespace \
                     WHERE n.nspname = {s} AND tbl.relname = {t}"
                ),
            )
            .await
            {
                info.indexes = pair_rows(r.rows);
            }
            if let Some(r) = query_opt(
                live,
                &format!(
                    "SELECT con.conname, pg_get_constraintdef(con.oid) \
                     FROM pg_constraint con \
                     JOIN pg_class rel ON rel.oid = con.conrelid \
                     JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace \
                     WHERE nsp.nspname = {s} AND rel.relname = {t} AND con.contype = 'f'"
                ),
            )
            .await
            {
                info.foreign_keys = pair_rows(r.rows);
            }
            if let Some(r) = query_opt(
                live,
                &format!(
                    "SELECT con.conname, pg_get_constraintdef(con.oid) \
                     FROM pg_constraint con \
                     JOIN pg_class rel ON rel.oid = con.conrelid \
                     JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace \
                     WHERE nsp.nspname = {s} AND rel.relname = {t} AND con.contype IN ('c', 'u')"
                ),
            )
            .await
            {
                info.checks = pair_rows(r.rows);
            }
            if let Some(r) = query_opt(
                live,
                &format!(
                    "SELECT tg.tgname, pg_get_triggerdef(tg.oid) \
                     FROM pg_trigger tg \
                     JOIN pg_class c ON c.oid = tg.tgrelid \
                     JOIN pg_namespace n ON n.oid = c.relnamespace \
                     WHERE n.nspname = {s} AND c.relname = {t} AND NOT tg.tgisinternal"
                ),
            )
            .await
            {
                info.triggers = pair_rows(r.rows);
            }
            if let Some(r) = query_opt(
                live,
                &format!(
                    "SELECT c.reltuples::bigint, pg_size_pretty(pg_total_relation_size(c.oid)), \
                     COALESCE(obj_description(c.oid), '') \
                     FROM pg_class c \
                     JOIN pg_namespace n ON n.oid = c.relnamespace \
                     WHERE n.nspname = {s} AND c.relname = {t}"
                ),
            )
            .await
            {
                if let Some(row) = r.rows.into_iter().next() {
                    info.estimate = row_cell(&row, 0);
                    info.size = row_cell(&row, 1);
                    info.comment = row_cell(&row, 2);
                }
            }
        }
    }
    if info.ddl.is_empty() {
        info.ddl = compose_ddl(engine, schema, table, &info.columns);
    }
    Ok(info)
}

#[tauri::command]
pub async fn db_inspect(
    state: State<'_, DbState>,
    req: DbInspectReq,
) -> Result<DbTableInspect, String> {
    let name = ident_name(&req.name)?.to_string();
    let schema = req.schema.trim();
    if !schema.is_empty() {
        ident_name(schema)?;
    }
    let live = live_of(&state, &req.session_id).await?;
    inspect_table(&live, schema, &name).await
}

fn sql_literal(engine: &str, cell: &Option<String>) -> String {
    let Some(v) = cell else {
        return "NULL".into();
    };
    if let Some(hex) = v.strip_prefix("\\x") {
        let hex = hex.trim_end_matches('…');
        return match engine {
            "postgres" => format!("'\\x{hex}'"),
            "sqlserver" => format!("0x{hex}"),
            _ => format!("X'{hex}'"),
        };
    }
    match engine {
        "mysql" => {
            let mut out = String::with_capacity(v.len() + 2);
            out.push('\'');
            for c in v.chars() {
                match c {
                    '\\' => out.push_str("\\\\"),
                    '\'' => out.push_str("\\'"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\0' => out.push_str("\\0"),
                    _ => out.push(c),
                }
            }
            out.push('\'');
            out
        }
        _ => format!("'{}'", v.replace('\'', "''")),
    }
}

fn format_inserts(engine: &str, rel: &str, columns: &[DbColumn], rows: &[Vec<Option<String>>]) -> String {
    if columns.is_empty() || rows.is_empty() {
        return String::new();
    }
    let cols = columns
        .iter()
        .map(|c| ident_sql(engine, &c.name))
        .collect::<Vec<_>>()
        .join(", ");
    let mut out = format!("INSERT INTO {rel} ({cols}) VALUES\n");
    for (i, row) in rows.iter().enumerate() {
        if i > 0 {
            out.push_str(",\n");
        }
        out.push('(');
        for (j, _) in columns.iter().enumerate() {
            if j > 0 {
                out.push_str(", ");
            }
            out.push_str(&sql_literal(engine, row.get(j).unwrap_or(&None)));
        }
        out.push(')');
    }
    out.push_str(";\n");
    out
}

fn export_preamble(engine: &str) -> &'static str {
    match engine {
        "mysql" => "SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\n\n",
        "postgres" => "SET session_replication_role = replica;\n\n",
        "sqlite" => "PRAGMA foreign_keys=OFF;\nBEGIN;\n\n",
        "sqlserver" => "BEGIN TRANSACTION;\n\n",
        _ => "",
    }
}

fn export_epilogue(engine: &str) -> &'static str {
    match engine {
        "mysql" => "\nSET FOREIGN_KEY_CHECKS=1;\n",
        "postgres" => "\nSET session_replication_role = DEFAULT;\n",
        "sqlite" => "\nCOMMIT;\nPRAGMA foreign_keys=ON;\n",
        "sqlserver" => "\nCOMMIT;\n",
        _ => "",
    }
}

async fn append_sql(file: &mut tokio::fs::File, chunk: &str, written: &mut u64) -> Result<(), String> {
    let bytes = chunk.as_bytes();
    *written = written.saturating_add(bytes.len() as u64);
    if *written > SCRIPT_FILE_MAX {
        return Err("file_too_large".into());
    }
    use tokio::io::AsyncWriteExt;
    file.write_all(bytes).await.map_err(|_| "file_write".to_string())
}

async fn write_insert_batch(
    file: &mut tokio::fs::File,
    engine: &str,
    rel: &str,
    columns: &[DbColumn],
    rows: &[Vec<Option<String>>],
    written: &mut u64,
) -> Result<(), String> {
    let sql = format_inserts(engine, rel, columns, rows);
    if sql.is_empty() {
        return Ok(());
    }
    append_sql(file, &sql, written).await
}

async fn dump_table_rows(
    pool: &LivePool,
    engine: &str,
    rel: &str,
    file: &mut tokio::fs::File,
    written: &mut u64,
) -> Result<u64, String> {
    let sql = format!("SELECT * FROM {rel}");
    let mut columns = Vec::new();
    let mut batch = Vec::new();
    let mut n = 0u64;
    match pool {
        LivePool::Postgres(p) => {
            let mut stream = sqlx::raw_sql(&sql).fetch(p);
            while let Some(item) = stream.next().await {
                let row = item.map_err(map_err)?;
                if columns.is_empty() {
                    columns = cols_from_sqlx(&row);
                }
                let mut line = Vec::with_capacity(row.len());
                for i in 0..row.len() {
                    line.push(cell_pg(&row, i));
                }
                batch.push(line);
                n += 1;
                if batch.len() >= INSERT_BATCH {
                    write_insert_batch(file, engine, rel, &columns, &batch, written).await?;
                    batch.clear();
                }
            }
        }
        LivePool::Mysql(p) => {
            let mut stream = sqlx::raw_sql(&sql).fetch(p);
            while let Some(item) = stream.next().await {
                let row = item.map_err(map_err)?;
                if columns.is_empty() {
                    columns = cols_from_sqlx(&row);
                }
                let mut line = Vec::with_capacity(row.len());
                for i in 0..row.len() {
                    line.push(cell_mysql(&row, i));
                }
                batch.push(line);
                n += 1;
                if batch.len() >= INSERT_BATCH {
                    write_insert_batch(file, engine, rel, &columns, &batch, written).await?;
                    batch.clear();
                }
            }
        }
        LivePool::Sqlite(p) => {
            let mut stream = sqlx::raw_sql(&sql).fetch(p);
            while let Some(item) = stream.next().await {
                let row = item.map_err(map_err)?;
                if columns.is_empty() {
                    columns = cols_from_sqlx(&row);
                }
                let mut line = Vec::with_capacity(row.len());
                for i in 0..row.len() {
                    line.push(cell_sqlite(&row, i));
                }
                batch.push(line);
                n += 1;
                if batch.len() >= INSERT_BATCH {
                    write_insert_batch(file, engine, rel, &columns, &batch, written).await?;
                    batch.clear();
                }
            }
        }
        LivePool::SqlServer(c) => {
            let mut cli = c.lock().await;
            let mut stream = cli.simple_query(&sql).await.map_err(map_err)?;
            while let Some(item) = stream.next().await {
                match item.map_err(map_err)? {
                    QueryItem::Metadata(meta) => {
                        columns = meta
                            .columns()
                            .iter()
                            .map(|c| DbColumn {
                                name: c.name().to_string(),
                                type_name: mssql_type_name(c.column_type()),
                                comment: String::new(),
                                pk: false,
                            })
                            .collect();
                    }
                    QueryItem::Row(row) => {
                        let mut line = Vec::with_capacity(row.len());
                        for i in 0..row.len() {
                            line.push(cell_mssql(&row, i));
                        }
                        batch.push(line);
                        n += 1;
                        if batch.len() >= INSERT_BATCH {
                            write_insert_batch(file, engine, rel, &columns, &batch, written).await?;
                            batch.clear();
                        }
                    }
                }
            }
        }
    }
    if !batch.is_empty() {
        write_insert_batch(file, engine, rel, &columns, &batch, written).await?;
    }
    Ok(n)
}

async fn export_one_table(
    live: &LiveDb,
    schema: &str,
    name: &str,
    file: &mut tokio::fs::File,
    written: &mut u64,
) -> Result<u64, String> {
    let engine = live.engine.as_str();
    let rel = table_rel(engine, schema, name);
    let info = inspect_table(live, schema, name).await.ok();
    let mut ddl = info.as_ref().map(|i| i.ddl.trim().to_string()).unwrap_or_default();
    if !ddl.is_empty() && !ddl.ends_with(';') {
        ddl.push(';');
    }
    let label = if schema.is_empty() {
        name.to_string()
    } else {
        format!("{schema}.{name}")
    };
    append_sql(file, &format!("-- {label}\n"), written).await?;
    if !ddl.is_empty() {
        append_sql(file, &ddl, written).await?;
        append_sql(file, "\n\n", written).await?;
    }
    let rows = dump_table_rows(&live.pool, engine, &rel, file, written).await?;
    append_sql(file, "\n", written).await?;
    Ok(rows)
}

async fn list_export_tables(live: &LiveDb, schema: &str, name: &str) -> Result<Vec<DbTable>, String> {
    if !name.is_empty() {
        ident_name(name)?;
        if !schema.is_empty() {
            ident_name(schema)?;
        }
        return Ok(vec![DbTable {
            schema: schema.to_string(),
            name: name.to_string(),
            comment: String::new(),
        }]);
    }
    let sql = tables_sql(&live.engine);
    let result = tokio::time::timeout(Duration::from_secs(QUERY_SECS), run_sql(&live.pool, sql))
        .await
        .map_err(|_| "timeout".to_string())??;
    Ok(tables_from(result))
}

#[tauri::command]
pub async fn db_export(
    state: State<'_, DbState>,
    req: DbExportReq,
) -> Result<DbExportResult, String> {
    if req.path.trim().is_empty() {
        return Err("missing_file".into());
    }
    if state.script_cancel.lock().await.contains_key(&req.session_id) {
        return Err("script_running".into());
    }
    let live = live_of(&state, &req.session_id).await?;
    let schema = req.schema.trim().to_string();
    let name = req.name.trim().to_string();
    let tables = list_export_tables(&live, &schema, &name).await?;
    if tables.is_empty() {
        return Err("no_tables".into());
    }
    let work = async {
        let mut file = tokio::fs::File::create(&req.path)
            .await
            .map_err(|_| "file_write".to_string())?;
        let mut written = 0u64;
        let engine = live.engine.as_str();
        let catalog = live.req.database.trim();
        append_sql(
            &mut file,
            &format!("-- feisuo {engine} {catalog}\n"),
            &mut written,
        )
        .await?;
        append_sql(&mut file, export_preamble(engine), &mut written).await?;
        let mut rows = 0u64;
        for tbl in &tables {
            rows += export_one_table(&live, &tbl.schema, &tbl.name, &mut file, &mut written).await?;
        }
        append_sql(&mut file, export_epilogue(engine), &mut written).await?;
        use tokio::io::AsyncWriteExt;
        file.flush().await.map_err(|_| "file_write".to_string())?;
        Ok(DbExportResult {
            tables: tables.len() as u32,
            rows,
        })
    };
    tokio::time::timeout(Duration::from_secs(EXPORT_SECS), work)
        .await
        .map_err(|_| "timeout".to_string())?
}

fn catalogs_sql(engine: &str) -> Result<&'static str, String> {
    match engine {
        "mysql" => Ok(
            "SELECT schema_name FROM information_schema.SCHEMATA ORDER BY schema_name",
        ),
        "postgres" => Ok(
            "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1",
        ),
        "sqlserver" => Ok("SELECT name FROM sys.databases WHERE state = 0 ORDER BY name"),
        _ => Err("no_switch_db".into()),
    }
}

fn current_sql(engine: &str) -> &'static str {
    match engine {
        "mysql" => "SELECT DATABASE()",
        "sqlserver" => "SELECT DB_NAME()",
        _ => "SELECT current_database()",
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
    let chunks = if live.engine == "sqlserver" {
        split_go(&sql)
    } else {
        vec![sql]
    };
    let mysql = live.engine == "mysql";
    let mut stmts = Vec::new();
    for chunk in &chunks {
        stmts.extend(split_statements(chunk, mysql));
    }
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
    use super::{catalog_name, count_sql, page_sql, simple_from_table, split_go, split_statements, sql_literal};

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

    #[test]
    fn from_plain() {
        assert_eq!(simple_from_table("SELECT * FROM users"), Some(("".into(), "users".into())));
        assert_eq!(
            simple_from_table("SELECT * FROM public.users"),
            Some(("public".into(), "users".into()))
        );
        assert_eq!(
            simple_from_table("SELECT * FROM [dbo].[t]"),
            Some(("dbo".into(), "t".into()))
        );
        assert_eq!(simple_from_table("SELECT * FROM (SELECT 1) x"), None);
    }

    #[test]
    fn splits_go_batches() {
        let s = split_go("SELECT 1\nGO\nSELECT 2\nGO 2");
        assert_eq!(s, ["SELECT 1", "SELECT 2", "SELECT 2"]);
        assert!(split_go("GOTO skip\nSELECT 1").len() == 1);
    }

    #[test]
    fn pages_plain_select() {
        let sql = page_sql("postgres", "SELECT * FROM t", 201, 0).unwrap();
        assert!(sql.ends_with("LIMIT 201 OFFSET 0"), "{sql}");
    }

    #[test]
    fn pages_keeps_order_and_skips_quoted_limit() {
        let sql = page_sql("mysql", "SELECT * FROM t ORDER BY id", 101, 200).unwrap();
        assert!(sql.contains("ORDER BY id"));
        assert!(sql.ends_with("LIMIT 101 OFFSET 200"), "{sql}");
        assert!(page_sql("mysql", "SELECT * FROM t WHERE note = 'LIMIT'", 50, 0).is_some());
        let inner = page_sql("postgres", "SELECT * FROM (SELECT * FROM t LIMIT 1) x", 11, 0).unwrap();
        assert!(inner.ends_with("LIMIT 11 OFFSET 0"), "{inner}");
    }

    #[test]
    fn skips_limit_top_for_update_and_multi() {
        assert!(page_sql("postgres", "SELECT * FROM t LIMIT 10", 200, 0).is_none());
        assert!(page_sql("sqlserver", "SELECT TOP 10 * FROM t", 20, 0).is_none());
        assert!(page_sql("postgres", "SELECT * FROM t FOR UPDATE", 20, 0).is_none());
        assert!(page_sql("postgres", "SELECT 1; SELECT 2", 10, 0).is_none());
        assert!(page_sql(
            "postgres",
            "WITH c AS (SELECT 1) INSERT INTO t SELECT * FROM c",
            10,
            0
        )
        .is_none());
    }

    #[test]
    fn pages_sqlserver() {
        let ordered = page_sql("sqlserver", "SELECT * FROM t ORDER BY id", 101, 20).unwrap();
        assert!(ordered.contains("ORDER BY id\nOFFSET 20 ROWS FETCH NEXT 101 ROWS ONLY"), "{ordered}");
        assert!(!ordered.contains("SELECT NULL"));
        let plain = page_sql("sqlserver", "SELECT * FROM t", 101, 0).unwrap();
        assert!(plain.contains("ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 101 ROWS ONLY"), "{plain}");
    }

    #[test]
    fn count_strips_order_and_tail() {
        let sql = count_sql("postgres", "SELECT * FROM t ORDER BY id DESC;").unwrap();
        assert!(sql.contains("SELECT * FROM t"));
        assert!(!sql.to_ascii_uppercase().contains("ORDER BY"));
        assert!(sql.contains("COUNT(*)"));
        let commented = page_sql("postgres", "-- LIMIT\nSELECT * FROM t", 11, 0).unwrap();
        assert!(commented.ends_with("LIMIT 11 OFFSET 0"), "{commented}");
    }

    #[test]
    fn sql_literal_quotes() {
        assert_eq!(sql_literal("postgres", &None), "NULL");
        assert_eq!(sql_literal("postgres", &Some("a'b".into())), "'a''b'");
        assert_eq!(sql_literal("mysql", &Some("a'b".into())), "'a\\'b'");
        assert_eq!(sql_literal("sqlserver", &Some("\\xdead".into())), "0xdead");
    }
}
