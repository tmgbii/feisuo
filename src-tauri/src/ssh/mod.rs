mod known;
mod socks;

use crate::events::now_ms;
use russh::client::{self, Handle, Msg};
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKey};
use russh::{Channel, ChannelMsg, Pty};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshAuth {
    pub method: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub key_path: String,
    #[serde(default)]
    pub key_passphrase: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshEndpoint {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectReq {
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
    pub cols: u32,
    pub rows: u32,
    pub jump: Option<SshEndpoint>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelReq {
    pub session_id: String,
    pub id: String,
    pub kind: String,
    #[serde(default = "default_bind")]
    pub bind_host: String,
    pub bind_port: u16,
    #[serde(default)]
    pub dest_host: String,
    #[serde(default)]
    pub dest_port: u16,
}

fn default_bind() -> String {
    "127.0.0.1".into()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshStatus {
    pub session_id: String,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshRx {
    pub session_id: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostKey {
    pub session_id: String,
    pub host: String,
    pub fingerprint: String,
    pub alg: String,
    pub previous: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub mode: String,
    pub mtime: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshXfer {
    pub session_id: String,
    pub id: String,
    pub name: String,
    pub transferred: u64,
    pub total: u64,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelStatus {
    pub session_id: String,
    pub id: String,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProbe {
    pub session_id: String,
    pub os: String,
    pub cores: String,
    pub mem: String,
    pub disk: String,
    pub hostname: String,
    pub distro: String,
    pub ip: String,
    pub load: String,
    pub disk_total: String,
    pub os_id: String,
    pub rtt_ms: u32,
}

struct LiveSsh {
    handle: Arc<Handle<ClientHandler>>,
    #[allow(dead_code)]
    jump: Option<Arc<Handle<ClientHandler>>>,
    cancel: CancellationToken,
    pty_tx: mpsc::Sender<PtyCmd>,
    sftp: Arc<Mutex<Option<Arc<SftpSession>>>>,
    tunnels: Mutex<HashMap<String, CancellationToken>>,
    reverse: Arc<Mutex<HashMap<(String, u32), (String, u16)>>>,
    xfer: Mutex<()>,
}

enum PtyCmd {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
}

pub struct SshState {
    sessions: Mutex<HashMap<String, Arc<LiveSsh>>>,
    xfer_cancel: Mutex<HashMap<String, CancellationToken>>,
}

impl SshState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            xfer_cancel: Mutex::new(HashMap::new()),
        }
    }
}

struct ClientHandler {
    app: AppHandle,
    session_id: String,
    host_id: String,
    reverse: Arc<Mutex<HashMap<(String, u32), (String, u16)>>>,
    reverse_cancel: CancellationToken,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let alg = server_public_key.algorithm().to_string();
        match known::check(&self.app, &self.host_id, &fingerprint) {
            known::HostCheck::Match => Ok(true),
            known::HostCheck::Unknown => {
                self.ask_key(&fingerprint, &alg, None).await
            }
            known::HostCheck::Mismatch(prev) => {
                self.ask_key(&fingerprint, &alg, Some(prev)).await
            }
        }
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let _ = session;
        let dest = {
            let map = self.reverse.lock().await;
            map.get(&(connected_address.to_string(), connected_port))
                .cloned()
                .or_else(|| {
                    map.iter()
                        .find(|((_, p), _)| *p == connected_port)
                        .map(|(_, v)| v.clone())
                })
        };
        let Some((host, port)) = dest else {
            return Ok(());
        };
        let cancel = self.reverse_cancel.clone();
        tauri::async_runtime::spawn(async move {
            if let Ok(tcp) = TcpStream::connect((host.as_str(), port)).await {
                let _ = socks::pump(tcp, channel, cancel).await;
            }
        });
        Ok(())
    }
}

impl ClientHandler {
    async fn ask_key(
        &self,
        fingerprint: &str,
        alg: &str,
        previous: Option<String>,
    ) -> Result<bool, russh::Error> {
        let (tx, rx) = oneshot::channel();
        pending_insert(self.session_id.clone(), tx);
        let _ = self.app.emit(
            "ssh:hostkey",
            SshHostKey {
                session_id: self.session_id.clone(),
                host: self.host_id.clone(),
                fingerprint: fingerprint.to_string(),
                alg: alg.to_string(),
                previous,
            },
        );
        let accept = tokio::time::timeout(Duration::from_secs(120), rx)
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or(false);
        if accept {
            let _ = known::remember(&self.app, &self.host_id, alg, fingerprint);
        }
        Ok(accept)
    }
}

pub fn map_err(err: &str) -> String {
    let s = err.to_lowercase();
    if s.contains("fingerprint") || s.contains("host key") || s.contains("server key") {
        return "fingerprint".into();
    }
    if s.contains("auth") || s.contains("permission denied") || s.contains("denied") {
        return "auth_failed".into();
    }
    if s.contains("refused") || s.contains("reject") {
        return "rejected".into();
    }
    if s.contains("timed out") || s.contains("timeout") {
        return "timeout".into();
    }
    if s.contains("unreachable") || s.contains("no route") || s.contains("failed to lookup") {
        return "unreachable".into();
    }
    if s.contains("reset") || s.contains("broken pipe") || s.contains("disconnect") {
        return "disconnected".into();
    }
    if err.chars().count() > 80 {
        format!("{}…", err.chars().take(80).collect::<String>())
    } else if err.is_empty() {
        "failed".into()
    } else {
        err.to_string()
    }
}

fn emit_status(app: &AppHandle, session_id: &str, status: &str, error: Option<String>) {
    let _ = app.emit(
        "ssh:status",
        SshStatus {
            session_id: session_id.to_string(),
            status: status.to_string(),
            error,
        },
    );
}

fn ssh_config() -> client::Config {
    client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(20)),
        ..Default::default()
    }
}

fn handler(
    app: AppHandle,
    session_id: String,
    host: &str,
    port: u16,
    reverse: Arc<Mutex<HashMap<(String, u32), (String, u16)>>>,
    reverse_cancel: CancellationToken,
) -> ClientHandler {
    ClientHandler {
        app,
        session_id,
        host_id: known::host_id(host, port),
        reverse,
        reverse_cancel,
    }
}

async fn authenticate(
    session: &mut Handle<ClientHandler>,
    user: &str,
    auth: &SshAuth,
) -> Result<(), String> {
    let ok = if auth.method == "key" {
        let path = auth.key_path.trim();
        if path.is_empty() {
            return Err("missing_key".into());
        }
        let pass = if auth.key_passphrase.is_empty() {
            None
        } else {
            Some(auth.key_passphrase.as_str())
        };
        let key = load_secret_key(path, pass).map_err(|e| map_err(&e.to_string()))?;
        let hash = session
            .best_supported_rsa_hash()
            .await
            .map_err(|e| map_err(&e.to_string()))?
            .flatten();
        session
            .authenticate_publickey(
                user,
                PrivateKeyWithHashAlg::new(Arc::new(key), hash),
            )
            .await
            .map_err(|e| map_err(&e.to_string()))?
            .success()
    } else {
        session
            .authenticate_password(user, &auth.password)
            .await
            .map_err(|e| map_err(&e.to_string()))?
            .success()
    };
    if ok {
        Ok(())
    } else {
        Err("auth_failed".into())
    }
}

async fn open_target(
    app: &AppHandle,
    req: &SshConnectReq,
    reverse: Arc<Mutex<HashMap<(String, u32), (String, u16)>>>,
    cancel: CancellationToken,
) -> Result<(Handle<ClientHandler>, Option<Handle<ClientHandler>>), String> {
    let cfg = Arc::new(ssh_config());
    if let Some(jump) = &req.jump {
        if jump.host.trim().is_empty() {
            return Err("missing_jump_host".into());
        }
        if jump.user.trim().is_empty() {
            return Err("missing_jump_user".into());
        }
        let mut hop = client::connect(
            cfg.clone(),
            (jump.host.as_str(), jump.port),
            handler(
                app.clone(),
                req.session_id.clone(),
                &jump.host,
                jump.port,
                reverse.clone(),
                cancel.clone(),
            ),
        )
        .await
        .map_err(|e| map_err(&e.to_string()))?;
        authenticate(&mut hop, &jump.user, &jump.auth).await?;
        let channel = hop
            .channel_open_direct_tcpip(&req.host, req.port as u32, "127.0.0.1", 0)
            .await
            .map_err(|e| map_err(&e.to_string()))?;
        let mut target = client::connect_stream(
            cfg,
            channel.into_stream(),
            handler(
                app.clone(),
                req.session_id.clone(),
                &req.host,
                req.port,
                reverse,
                cancel,
            ),
        )
        .await
        .map_err(|e| map_err(&e.to_string()))?;
        authenticate(&mut target, &req.user, &req.auth).await?;
        Ok((target, Some(hop)))
    } else {
        let mut target = client::connect(
            cfg,
            (req.host.as_str(), req.port),
            handler(
                app.clone(),
                req.session_id.clone(),
                &req.host,
                req.port,
                reverse,
                cancel,
            ),
        )
        .await
        .map_err(|e| map_err(&e.to_string()))?;
        authenticate(&mut target, &req.user, &req.auth).await?;
        Ok((target, None))
    }
}

async fn wait_success(channel: &mut Channel<Msg>, prelude: &mut Vec<u8>) -> Result<(), String> {
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Success) => return Ok(()),
            Some(ChannelMsg::Failure) => return Err("pty_failed".into()),
            Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                prelude.extend_from_slice(&data);
            }
            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => return Err("disconnected".into()),
            Some(_) => {}
        }
    }
}

async fn run_pty(
    app: AppHandle,
    session_id: String,
    channel: Channel<Msg>,
    mut cmds: mpsc::Receiver<PtyCmd>,
    cancel: CancellationToken,
    mut buf: Vec<u8>,
) {
    let (mut read, write) = channel.split();
    let writer_cancel = cancel.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = writer_cancel.cancelled() => break,
                cmd = cmds.recv() => {
                    match cmd {
                        Some(PtyCmd::Data(bytes)) => {
                            if write.data(&bytes[..]).await.is_err() {
                                break;
                            }
                        }
                        Some(PtyCmd::Resize { cols, rows }) => {
                            let _ = write.window_change(cols, rows, 0, 0).await;
                        }
                        None => break,
                    }
                }
            }
        }
    });
    let mut tick = tokio::time::interval(Duration::from_millis(24));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = tick.tick() => {
                if !buf.is_empty() {
                    let _ = app.emit("ssh:rx", SshRx { session_id: session_id.clone(), data: std::mem::take(&mut buf) });
                }
            }
            msg = read.wait() => {
                match msg {
                    Some(ChannelMsg::Data { ref data }) | Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                        buf.extend_from_slice(data);
                        if buf.len() >= 32 * 1024 {
                            let _ = app.emit("ssh:rx", SshRx { session_id: session_id.clone(), data: std::mem::take(&mut buf) });
                        }
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
        }
    }
    if !buf.is_empty() {
        let _ = app.emit(
            "ssh:rx",
            SshRx {
                session_id: session_id.clone(),
                data: buf,
            },
        );
    }
    emit_status(&app, &session_id, "disconnected", Some("disconnected".into()));
}

async fn live_of(state: &SshState, id: &str) -> Result<Arc<LiveSsh>, String> {
    state
        .sessions
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or_else(|| "not_connected".into())
}

async fn sftp_of(live: &LiveSsh) -> Result<Arc<SftpSession>, String> {
    if let Some(sftp) = live.sftp.lock().await.as_ref() {
        return Ok(sftp.clone());
    }
    let channel = live
        .handle
        .channel_open_session()
        .await
        .map_err(|e| map_err(&e.to_string()))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| map_err(&e.to_string()))?;
    let sftp = Arc::new(
        SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| e.to_string())?,
    );
    *live.sftp.lock().await = Some(sftp.clone());
    Ok(sftp)
}

#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, SshState>,
    req: SshConnectReq,
) -> Result<(), String> {
    if req.host.trim().is_empty() {
        return Err("missing_host".into());
    }
    if req.user.trim().is_empty() {
        return Err("missing_user".into());
    }
    ssh_disconnect(app.clone(), state.clone(), req.session_id.clone()).await?;
    emit_status(&app, &req.session_id, "connecting", None);
    let cancel = CancellationToken::new();
    let reverse = Arc::new(Mutex::new(HashMap::new()));
    let result = connect_inner(app.clone(), req.clone(), cancel.clone(), reverse.clone()).await;
    match result {
        Ok(live) => {
            state.sessions.lock().await.insert(live.0.clone(), live.1);
            emit_status(&app, &live.0, "connected", None);
            Ok(())
        }
        Err(err) => {
            emit_status(&app, &req.session_id, "error", Some(err.clone()));
            Err(err)
        }
    }
}

async fn connect_inner(
    app: AppHandle,
    req: SshConnectReq,
    cancel: CancellationToken,
    reverse: Arc<Mutex<HashMap<(String, u32), (String, u16)>>>,
) -> Result<(String, Arc<LiveSsh>), String> {
    let (handle, jump) = open_target(&app, &req, reverse.clone(), cancel.clone()).await?;
    let handle = Arc::new(handle);
    let jump = jump.map(Arc::new);
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| map_err(&e.to_string()))?;
    channel
        .request_pty(
            true,
            "xterm-256color",
            req.cols.max(20),
            req.rows.max(8),
            0,
            0,
            &[
                (Pty::IXON, 0),
                (Pty::IXOFF, 0),
                (Pty::IUTF8, 1),
                (Pty::ICRNL, 1),
                (Pty::OPOST, 1),
                (Pty::ONLCR, 1),
                (Pty::ISIG, 1),
                (Pty::ICANON, 1),
                (Pty::ECHO, 1),
                (Pty::ECHOE, 1),
                (Pty::ECHOK, 1),
                (Pty::IEXTEN, 1),
                (Pty::CS8, 1),
            ],
        )
        .await
        .map_err(|e| map_err(&e.to_string()))?;
    let mut prelude = Vec::new();
    wait_success(&mut channel, &mut prelude).await?;
    let _ = channel.set_env(false, "LANG", "C.UTF-8").await;
    let _ = channel.set_env(false, "LC_ALL", "C.UTF-8").await;
    channel
        .exec(
            true,
            "stty -ixon 2>/dev/null; export TERM=xterm-256color COLORTERM=truecolor; exec ${SHELL:-/bin/bash} -il",
        )
        .await
        .map_err(|e| map_err(&e.to_string()))?;
    let (pty_tx, pty_rx) = mpsc::channel(1024);
    let live = Arc::new(LiveSsh {
        handle,
        jump,
        cancel: cancel.clone(),
        pty_tx,
        sftp: Arc::new(Mutex::new(None)),
        tunnels: Mutex::new(HashMap::new()),
        reverse,
        xfer: Mutex::new(()),
    });
    let sid = req.session_id.clone();
    tauri::async_runtime::spawn(run_pty(
        app.clone(),
        sid.clone(),
        channel,
        pty_rx,
        cancel.clone(),
        prelude,
    ));
    Ok((sid, live))
}

use std::sync::Mutex as StdMutex;
static PENDING_KEYS: StdMutex<Option<HashMap<String, oneshot::Sender<bool>>>> = StdMutex::new(None);

fn pending_insert(id: String, tx: oneshot::Sender<bool>) {
    let mut g = PENDING_KEYS.lock().expect("pending");
    g.get_or_insert_with(HashMap::new).insert(id, tx);
}

fn pending_take(id: &str) -> Option<oneshot::Sender<bool>> {
    PENDING_KEYS.lock().ok()?.as_mut()?.remove(id)
}

#[tauri::command]
pub async fn ssh_answer_hostkey(session_id: String, accept: bool) -> Result<(), String> {
    if let Some(tx) = pending_take(&session_id) {
        let _ = tx.send(accept);
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_disconnect(
    app: AppHandle,
    state: State<'_, SshState>,
    session_id: String,
) -> Result<(), String> {
    if let Some(tx) = pending_take(&session_id) {
        let _ = tx.send(false);
    }
    let live = state.sessions.lock().await.remove(&session_id);
    if let Some(live) = live {
        live.cancel.cancel();
        let _ = live.handle.disconnect(russh::Disconnect::ByApplication, "", "").await;
    }
    emit_status(&app, &session_id, "disconnected", None);
    Ok(())
}

#[tauri::command]
pub async fn ssh_write(
    state: State<'_, SshState>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let live = live_of(&state, &session_id).await?;
    live.pty_tx
        .send(PtyCmd::Data(data))
        .await
        .map_err(|_| "channel_closed".to_string())
}

#[tauri::command]
pub async fn ssh_resize(
    state: State<'_, SshState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let live = live_of(&state, &session_id).await?;
    live.pty_tx
        .send(PtyCmd::Resize { cols, rows })
        .await
        .map_err(|_| "channel_closed".to_string())
}

#[tauri::command]
pub async fn ssh_sftp_list(
    state: State<'_, SshState>,
    session_id: String,
    path: String,
) -> Result<Vec<SshFileEntry>, String> {
    let live = live_of(&state, &session_id).await?;
    let sftp = sftp_of(&live).await?;
    let dir = if path.trim().is_empty() {
        sftp.canonicalize(".").await.map_err(|e| e.to_string())?
    } else {
        path
    };
    let mut out = Vec::new();
    let entries = sftp.read_dir(&dir).await.map_err(|e| e.to_string())?;
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = entry.metadata();
        let is_dir = meta.file_type().is_dir();
        let joined = if dir.ends_with('/') {
            format!("{dir}{name}")
        } else {
            format!("{dir}/{name}")
        };
        out.push(SshFileEntry {
            name,
            path: joined,
            is_dir,
            size: meta.size.unwrap_or(0),
            mode: format!("{:04o}", meta.permissions.unwrap_or(0) & 0o7777),
            mtime: meta.mtime.unwrap_or(0),
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(out)
}

#[tauri::command]
pub async fn ssh_sftp_mkdir(
    state: State<'_, SshState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let live = live_of(&state, &session_id).await?;
    let sftp = sftp_of(&live).await?;
    sftp.create_dir(path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ssh_sftp_rename(
    state: State<'_, SshState>,
    session_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let live = live_of(&state, &session_id).await?;
    let sftp = sftp_of(&live).await?;
    sftp.rename(from, to).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ssh_sftp_remove(
    state: State<'_, SshState>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let live = live_of(&state, &session_id).await?;
    let sftp = sftp_of(&live).await?;
    if is_dir {
        remove_tree(&sftp, &path).await
    } else {
        sftp.remove_file(path).await.map_err(|e| e.to_string())
    }
}

async fn remove_tree(sftp: &SftpSession, path: &str) -> Result<(), String> {
    let mut dirs = vec![path.to_string()];
    let mut files = Vec::new();
    let mut i = 0;
    while i < dirs.len() {
        let cur = dirs[i].clone();
        i += 1;
        let entries = match sftp.read_dir(&cur).await {
            Ok(rows) => rows,
            Err(_) => continue,
        };
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child = if cur.ends_with('/') {
                format!("{cur}{name}")
            } else {
                format!("{cur}/{name}")
            };
            if entry.metadata().file_type().is_dir() {
                dirs.push(child);
            } else {
                files.push(child);
            }
        }
    }
    for file in files {
        sftp.remove_file(file).await.map_err(|e| e.to_string())?;
    }
    for dir in dirs.into_iter().rev() {
        sftp.remove_dir(dir).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_sftp_chmod(
    state: State<'_, SshState>,
    session_id: String,
    path: String,
    mode: u32,
    recursive: bool,
) -> Result<(), String> {
    let live = live_of(&state, &session_id).await?;
    let sftp = sftp_of(&live).await?;
    chmod_one(&sftp, &path, mode).await?;
    if recursive {
        chmod_walk(&sftp, &path, mode).await?;
    }
    Ok(())
}

async fn chmod_one(sftp: &SftpSession, path: &str, mode: u32) -> Result<(), String> {
    let mut meta = sftp.metadata(path).await.map_err(|e| e.to_string())?;
    meta.permissions = Some(mode);
    sftp.set_metadata(path, meta).await.map_err(|e| e.to_string())
}

async fn chmod_walk(sftp: &SftpSession, path: &str, mode: u32) -> Result<(), String> {
    let mut stack = vec![path.to_string()];
    while let Some(cur) = stack.pop() {
        let meta = sftp.metadata(&cur).await.map_err(|e| e.to_string())?;
        if !meta.file_type().is_dir() {
            continue;
        }
        for entry in sftp.read_dir(&cur).await.map_err(|e| e.to_string())? {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child = if cur.ends_with('/') {
                format!("{cur}{name}")
            } else {
                format!("{cur}/{name}")
            };
            chmod_one(sftp, &child, mode).await?;
            stack.push(child);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_sftp_read(
    state: State<'_, SshState>,
    session_id: String,
    path: String,
    max_mb: f64,
) -> Result<String, String> {
    let live = live_of(&state, &session_id).await?;
    let sftp = sftp_of(&live).await?;
    let meta = sftp.metadata(&path).await.map_err(|e| e.to_string())?;
    let size = meta.size.unwrap_or(0);
    let cap = (max_mb.max(0.5) * 1024.0 * 1024.0) as u64;
    if size > cap {
        return Err(format!("over_mb:{max_mb}"));
    }
    let bytes = sftp.read(&path).await.map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| "not_utf8".to_string())
}

#[tauri::command]
pub async fn ssh_sftp_write(
    state: State<'_, SshState>,
    session_id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let live = live_of(&state, &session_id).await?;
    let sftp = sftp_of(&live).await?;
    sftp.write(path, content.as_bytes())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ssh_sftp_upload(
    app: AppHandle,
    state: State<'_, SshState>,
    session_id: String,
    local: String,
    remote: String,
    offset: u64,
) -> Result<(), String> {
    let live = live_of(&state, &session_id).await?;
    let _queue = live.xfer.lock().await;
    let sftp = sftp_of(&live).await?;
    let xfer_id = format!("up-{}", now_ms());
    let cancel = CancellationToken::new();
    state
        .xfer_cancel
        .lock()
        .await
        .insert(xfer_id.clone(), cancel.clone());
    let name = PathBuf::from(&local)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| remote.clone());
    let meta = tokio::fs::symlink_metadata(&local)
        .await
        .map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        state.xfer_cancel.lock().await.remove(&xfer_id);
        return Err("symlink".into());
    }
    let result = if meta.is_dir() {
        copy_upload_tree(
            &app,
            &session_id,
            &xfer_id,
            &name,
            &sftp,
            &local,
            &remote,
            cancel,
        )
        .await
    } else {
        copy_upload(
            &app,
            &session_id,
            &xfer_id,
            &name,
            &sftp,
            &local,
            &remote,
            offset,
            cancel,
        )
        .await
    };
    state.xfer_cancel.lock().await.remove(&xfer_id);
    result
}

fn remote_join(dir: &str, name: &str) -> String {
    let name = name.trim_matches('/').replace('\\', "/");
    if name.is_empty() {
        let dir = dir.trim_end_matches('/');
        return if dir.is_empty() {
            "/".into()
        } else {
            dir.to_string()
        };
    }
    let dir = dir.trim_end_matches('/');
    if dir.is_empty() || dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    }
}

async fn ensure_remote_dir(sftp: &SftpSession, path: &str) -> Result<(), String> {
    let path = path.trim_end_matches('/');
    if path.is_empty() || path == "/" {
        return Ok(());
    }
    match sftp.metadata(path).await {
        Ok(meta) if meta.is_dir() => Ok(()),
        Ok(_) => Err(format!("exists:{path}")),
        Err(_) => sftp.create_dir(path).await.map_err(|e| e.to_string()),
    }
}

struct TreeItem {
    local: PathBuf,
    rel: String,
    is_dir: bool,
    size: u64,
}

async fn collect_tree(root: &Path) -> Result<Vec<TreeItem>, String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut rd = tokio::fs::read_dir(&dir).await.map_err(|e| e.to_string())?;
        while let Some(entry) = rd.next_entry().await.map_err(|e| e.to_string())? {
            let path = entry.path();
            let meta = match tokio::fs::symlink_metadata(&path).await {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            let Ok(rel) = path.strip_prefix(root) else {
                continue;
            };
            let rel = rel.to_string_lossy().replace('\\', "/");
            if rel.is_empty() {
                continue;
            }
            if meta.is_dir() {
                out.push(TreeItem {
                    local: path.clone(),
                    rel,
                    is_dir: true,
                    size: 0,
                });
                stack.push(path);
            } else if meta.is_file() {
                out.push(TreeItem {
                    local: path,
                    rel,
                    is_dir: false,
                    size: meta.len(),
                });
            }
        }
    }
    Ok(out)
}

async fn copy_upload_tree(
    app: &AppHandle,
    session_id: &str,
    xfer_id: &str,
    name: &str,
    sftp: &SftpSession,
    local: &str,
    remote: &str,
    cancel: CancellationToken,
) -> Result<(), String> {
    ensure_remote_dir(sftp, remote).await?;
    let items = collect_tree(Path::new(local)).await?;
    let mut dirs: Vec<_> = items.iter().filter(|item| item.is_dir).collect();
    dirs.sort_by_key(|item| item.rel.matches('/').count());
    let total: u64 = items.iter().filter(|item| !item.is_dir).map(|item| item.size).sum();
    let mut transferred = 0u64;
    emit_xfer(app, session_id, xfer_id, name, 0, total, false, None);
    let result: Result<(), String> = async {
        for dir in dirs {
            if cancel.is_cancelled() {
                return Err("cancelled".into());
            }
            ensure_remote_dir(sftp, &remote_join(remote, &dir.rel)).await?;
        }
        for item in items.iter().filter(|item| !item.is_dir) {
            if cancel.is_cancelled() {
                return Err("cancelled".into());
            }
            let dest = remote_join(remote, &item.rel);
            let local_path = item.local.to_string_lossy().to_string();
            let base = transferred;
            copy_file_to_remote(sftp, &local_path, &dest, 0, &cancel, |wrote, _file_total| {
                emit_xfer(app, session_id, xfer_id, name, base + wrote, total, false, None);
            })
            .await?;
            transferred += item.size;
            emit_xfer(app, session_id, xfer_id, name, transferred, total, false, None);
        }
        Ok(())
    }
    .await;
    match result {
        Ok(()) => {
            emit_xfer(app, session_id, xfer_id, name, transferred, total, true, None);
            Ok(())
        }
        Err(err) => {
            emit_xfer(app, session_id, xfer_id, name, transferred, total, true, Some(err.clone()));
            Err(err)
        }
    }
}

async fn copy_upload(
    app: &AppHandle,
    session_id: &str,
    xfer_id: &str,
    name: &str,
    sftp: &SftpSession,
    local: &str,
    remote: &str,
    offset: u64,
    cancel: CancellationToken,
) -> Result<(), String> {
    match copy_file_to_remote(sftp, local, remote, offset, &cancel, |transferred, total| {
        emit_xfer(app, session_id, xfer_id, name, transferred, total, false, None);
    })
    .await
    {
        Ok(total) => {
            emit_xfer(app, session_id, xfer_id, name, total, total, true, None);
            Ok(())
        }
        Err(err) => {
            emit_xfer(app, session_id, xfer_id, name, offset, 0, true, Some(err.clone()));
            Err(err)
        }
    }
}

async fn copy_file_to_remote(
    sftp: &SftpSession,
    local: &str,
    remote: &str,
    offset: u64,
    cancel: &CancellationToken,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<u64, String> {
    let mut src = tokio::fs::File::open(local).await.map_err(|e| e.to_string())?;
    let total = src.metadata().await.map_err(|e| e.to_string())?.len();
    if offset > 0 {
        src.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| e.to_string())?;
    }
    let flags = if offset > 0 {
        OpenFlags::WRITE | OpenFlags::READ | OpenFlags::CREATE
    } else {
        OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE
    };
    let mut dest = sftp
        .open_with_flags(remote, flags)
        .await
        .map_err(|e| e.to_string())?;
    if offset > 0 {
        dest.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| e.to_string())?;
    }
    let mut buf = vec![0u8; 32 * 1024];
    let mut transferred = offset;
    loop {
        if cancel.is_cancelled() {
            return Err("cancelled".into());
        }
        let n = src.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        dest.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
        transferred += n as u64;
        on_progress(transferred, total);
    }
    let _ = dest.flush().await;
    Ok(total)
}

#[tauri::command]
pub async fn ssh_sftp_download(
    app: AppHandle,
    state: State<'_, SshState>,
    session_id: String,
    remote: String,
    local: String,
    offset: u64,
) -> Result<(), String> {
    let live = live_of(&state, &session_id).await?;
    let _queue = live.xfer.lock().await;
    let sftp = sftp_of(&live).await?;
    let xfer_id = format!("dn-{}", now_ms());
    let cancel = CancellationToken::new();
    state
        .xfer_cancel
        .lock()
        .await
        .insert(xfer_id.clone(), cancel.clone());
    let name = PathBuf::from(&remote)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| remote.clone());
    let meta = sftp.metadata(&remote).await.map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        state.xfer_cancel.lock().await.remove(&xfer_id);
        return Err("symlink".into());
    }
    let result = if meta.file_type().is_dir() {
        copy_download_tree(
            &app,
            &session_id,
            &xfer_id,
            &name,
            &sftp,
            &remote,
            &local,
            cancel,
        )
        .await
    } else {
        copy_download(
            &app,
            &session_id,
            &xfer_id,
            &name,
            &sftp,
            &remote,
            &local,
            offset,
            cancel,
        )
        .await
    };
    state.xfer_cancel.lock().await.remove(&xfer_id);
    result
}

struct RemoteTreeItem {
    remote: String,
    rel: String,
    is_dir: bool,
    size: u64,
}

fn local_join(root: &str, rel: &str) -> PathBuf {
    let mut dest = PathBuf::from(root);
    for part in rel.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            continue;
        }
        dest.push(part);
    }
    dest
}

async fn collect_remote_tree(sftp: &SftpSession, root: &str) -> Result<Vec<RemoteTreeItem>, String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_string()];
    let prefix = root.trim_end_matches('/');
    while let Some(dir) = stack.pop() {
        let entries = sftp.read_dir(&dir).await.map_err(|e| e.to_string())?;
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let meta = entry.metadata();
            let kind = meta.file_type();
            if kind.is_symlink() {
                continue;
            }
            let child = remote_join(&dir, &name);
            let rel = child
                .strip_prefix(prefix)
                .unwrap_or(name.as_str())
                .trim_start_matches('/')
                .to_string();
            if rel.is_empty() {
                continue;
            }
            if kind.is_dir() {
                out.push(RemoteTreeItem {
                    remote: child.clone(),
                    rel,
                    is_dir: true,
                    size: 0,
                });
                stack.push(child);
            } else {
                out.push(RemoteTreeItem {
                    remote: child,
                    rel,
                    is_dir: false,
                    size: meta.size.unwrap_or(0),
                });
            }
        }
    }
    Ok(out)
}

async fn copy_download_tree(
    app: &AppHandle,
    session_id: &str,
    xfer_id: &str,
    name: &str,
    sftp: &SftpSession,
    remote: &str,
    local: &str,
    cancel: CancellationToken,
) -> Result<(), String> {
    tokio::fs::create_dir_all(local)
        .await
        .map_err(|e| e.to_string())?;
    let items = collect_remote_tree(sftp, remote).await?;
    let mut dirs: Vec<_> = items.iter().filter(|item| item.is_dir).collect();
    dirs.sort_by_key(|item| item.rel.matches('/').count());
    let total: u64 = items.iter().filter(|item| !item.is_dir).map(|item| item.size).sum();
    let mut transferred = 0u64;
    emit_xfer(app, session_id, xfer_id, name, 0, total, false, None);
    let result: Result<(), String> = async {
        for dir in dirs {
            if cancel.is_cancelled() {
                return Err("cancelled".into());
            }
            tokio::fs::create_dir_all(local_join(local, &dir.rel))
                .await
                .map_err(|e| e.to_string())?;
        }
        for item in items.iter().filter(|item| !item.is_dir) {
            if cancel.is_cancelled() {
                return Err("cancelled".into());
            }
            let dest = local_join(local, &item.rel);
            if let Some(parent) = dest.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            let dest = dest.to_string_lossy().to_string();
            let base = transferred;
            copy_file_from_remote(sftp, &item.remote, &dest, 0, &cancel, |wrote, _file_total| {
                emit_xfer(app, session_id, xfer_id, name, base + wrote, total, false, None);
            })
            .await?;
            transferred += item.size;
            emit_xfer(app, session_id, xfer_id, name, transferred, total, false, None);
        }
        Ok(())
    }
    .await;
    match result {
        Ok(()) => {
            emit_xfer(app, session_id, xfer_id, name, transferred, total.max(transferred), true, None);
            Ok(())
        }
        Err(err) => {
            emit_xfer(app, session_id, xfer_id, name, transferred, total, true, Some(err.clone()));
            Err(err)
        }
    }
}

async fn copy_download(
    app: &AppHandle,
    session_id: &str,
    xfer_id: &str,
    name: &str,
    sftp: &SftpSession,
    remote: &str,
    local: &str,
    offset: u64,
    cancel: CancellationToken,
) -> Result<(), String> {
    match copy_file_from_remote(sftp, remote, local, offset, &cancel, |transferred, total| {
        emit_xfer(app, session_id, xfer_id, name, transferred, total, false, None);
    })
    .await
    {
        Ok(total) => {
            emit_xfer(app, session_id, xfer_id, name, total, total, true, None);
            Ok(())
        }
        Err(err) => {
            emit_xfer(app, session_id, xfer_id, name, offset, 0, true, Some(err.clone()));
            Err(err)
        }
    }
}

async fn copy_file_from_remote(
    sftp: &SftpSession,
    remote: &str,
    local: &str,
    offset: u64,
    cancel: &CancellationToken,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<u64, String> {
    let meta = sftp.metadata(remote).await.map_err(|e| e.to_string())?;
    let total = meta.size.unwrap_or(0);
    let mut src = sftp
        .open_with_flags(remote, OpenFlags::READ)
        .await
        .map_err(|e| e.to_string())?;
    if offset > 0 {
        src.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| e.to_string())?;
    }
    let mut dest = if offset > 0 {
        tokio::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .open(local)
            .await
            .map_err(|e| e.to_string())?
    } else {
        tokio::fs::File::create(local).await.map_err(|e| e.to_string())?
    };
    if offset > 0 {
        dest.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| e.to_string())?;
    }
    let mut buf = vec![0u8; 32 * 1024];
    let mut transferred = offset;
    loop {
        if cancel.is_cancelled() {
            return Err("cancelled".into());
        }
        let n = src.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        dest.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
        transferred += n as u64;
        on_progress(transferred, total);
    }
    dest.flush().await.map_err(|e| e.to_string())?;
    Ok(total.max(transferred))
}

fn emit_xfer(
    app: &AppHandle,
    session_id: &str,
    id: &str,
    name: &str,
    transferred: u64,
    total: u64,
    done: bool,
    error: Option<String>,
) {
    let _ = app.emit(
        "ssh:xfer",
        SshXfer {
            session_id: session_id.to_string(),
            id: id.to_string(),
            name: name.to_string(),
            transferred,
            total,
            done,
            error,
        },
    );
}

#[tauri::command]
pub async fn ssh_xfer_cancel(state: State<'_, SshState>, id: String) -> Result<(), String> {
    if let Some(c) = state.xfer_cancel.lock().await.remove(&id) {
        c.cancel();
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_tunnel_start(
    app: AppHandle,
    state: State<'_, SshState>,
    req: SshTunnelReq,
) -> Result<(), String> {
    let live = live_of(&state, &req.session_id).await?;
    let cancel = CancellationToken::new();
    {
        let mut map = live.tunnels.lock().await;
        if let Some(prev) = map.remove(&req.id) {
            prev.cancel();
        }
        map.insert(req.id.clone(), cancel.clone());
    }
    let kind = req.kind.clone();
    let bind_host = if req.bind_host.trim().is_empty() {
        "127.0.0.1".into()
    } else {
        req.bind_host.clone()
    };
    let bind_port = req.bind_port;
    let dest_host = req.dest_host.clone();
    let dest_port = req.dest_port;
    let handle = live.handle.clone();
    let reverse = live.reverse.clone();
    let sid = req.session_id.clone();
    let tid = req.id.clone();
    let parent = live.cancel.clone();
    let app_task = app.clone();
    tauri::async_runtime::spawn(async move {
        let run = async {
            match kind.as_str() {
                "remote" => {
                    reverse
                        .lock()
                        .await
                        .insert((bind_host.clone(), bind_port as u32), (dest_host, dest_port));
                    handle
                        .tcpip_forward(bind_host.clone(), bind_port as u32)
                        .await
                        .map_err(|e| e.to_string())?;
                    loop {
                        tokio::select! {
                            _ = cancel.cancelled() => break,
                            _ = parent.cancelled() => break,
                        }
                    }
                    let _ = handle.cancel_tcpip_forward(bind_host.clone(), bind_port as u32).await;
                    reverse.lock().await.remove(&(bind_host, bind_port as u32));
                    Ok::<(), String>(())
                }
                "dynamic" => {
                    let listener = TcpListener::bind((bind_host.as_str(), bind_port))
                        .await
                        .map_err(|e| e.to_string())?;
                    socks::run_socks(listener, handle, cancel.clone()).await;
                    Ok(())
                }
                _ => {
                    let listener = TcpListener::bind((bind_host.as_str(), bind_port))
                        .await
                        .map_err(|e| e.to_string())?;
                    loop {
                        tokio::select! {
                            _ = cancel.cancelled() => break,
                            _ = parent.cancelled() => break,
                            accepted = listener.accept() => {
                                let Ok((tcp, _)) = accepted else { break };
                                let h = handle.clone();
                                let dh = dest_host.clone();
                                let c = cancel.clone();
                                tauri::async_runtime::spawn(async move {
                                    match h.channel_open_direct_tcpip(&dh, dest_port as u32, "127.0.0.1", 0).await {
                                        Ok(ch) => { let _ = socks::pump(tcp, ch, c).await; }
                                        Err(_) => {}
                                    }
                                });
                            }
                        }
                    }
                    Ok(())
                }
            }
        };
        match run.await {
            Ok(()) => {
                let _ = app_task.emit("ssh:tunnel", SshTunnelStatus {
                    session_id: sid,
                    id: tid,
                    status: "stopped".into(),
                    error: None,
                });
            }
            Err(err) => {
                let _ = app_task.emit("ssh:tunnel", SshTunnelStatus {
                    session_id: sid,
                    id: tid,
                    status: "error".into(),
                    error: Some(map_err(&err)),
                });
            }
        }
    });
    let _ = app.emit(
        "ssh:tunnel",
        SshTunnelStatus {
            session_id: req.session_id,
            id: req.id,
            status: "open".into(),
            error: None,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn ssh_tunnel_stop(
    app: AppHandle,
    state: State<'_, SshState>,
    session_id: String,
    id: String,
) -> Result<(), String> {
    let live = live_of(&state, &session_id).await?;
    if let Some(c) = live.tunnels.lock().await.remove(&id) {
        c.cancel();
    }
    let _ = app.emit(
        "ssh:tunnel",
        SshTunnelStatus {
            session_id,
            id,
            status: "stopped".into(),
            error: None,
        },
    );
    Ok(())
}

const PROBE_CMD: &str = r#"
h=$(hostname -s 2>/dev/null || uname -n 2>/dev/null); printf '%s\n' "$h"; echo __
sys=$(uname -s 2>/dev/null)
if [ "$sys" = Darwin ]; then
  printf '%s\n' macos; echo __
  printf '%s\n' "macOS $(sw_vers -productVersion 2>/dev/null)"; echo __
  uname -srm 2>/dev/null; echo __
  sysctl -n hw.ncpu 2>/dev/null; echo __
  mem=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
  awk -v b="$mem" 'BEGIN{if(b>=1073741824) printf "%.0fG", b/1073741824; else if(b>=1048576) printf "%.0fMB", b/1048576; else printf "%dB", b+0}'; echo __
  df -kP / 2>/dev/null | awk 'function h(k){if(k>=1073741824) printf "%.0fT",k/1073741824; else if(k>=1048576) printf "%.0fG",k/1048576; else if(k>=1024) printf "%.0fM",k/1024; else printf "%dK",k+0} NR==2{h($4)}'; echo __
  df -kP / 2>/dev/null | awk 'function h(k){if(k>=1073741824) printf "%.0fT",k/1073741824; else if(k>=1048576) printf "%.0fG",k/1048576; else if(k>=1024) printf "%.0fM",k/1024; else printf "%dK",k+0} NR==2{h($2)}'; echo __
  ip=""; for i in en0 en1 en2 en3 en4 en5; do a=$(ipconfig getifaddr "$i" 2>/dev/null) && { ip=$a; break; }; done; printf '%s\n' "$ip"; echo __
  sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}'
else
  awk -F= '/^ID=/{gsub(/"/,"",$2); print $2; exit}' /etc/os-release 2>/dev/null; echo __
  awk -F= '/^PRETTY_NAME=/{gsub(/"/,"",$2); print $2; exit}' /etc/os-release 2>/dev/null; echo __
  uname -srm 2>/dev/null; echo __
  (nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null); echo __
  awk '/MemTotal/{mb=$2/1024; if(mb>=1024) printf "%.0fG", mb/1024; else printf "%.0fMB", mb}' /proc/meminfo 2>/dev/null; echo __
  df -kP / 2>/dev/null | awk 'function h(k){if(k>=1073741824) printf "%.0fT",k/1073741824; else if(k>=1048576) printf "%.0fG",k/1048576; else if(k>=1024) printf "%.0fM",k/1024; else printf "%dK",k+0} NR==2{h($4)}'; echo __
  df -kP / 2>/dev/null | awk 'function h(k){if(k>=1073741824) printf "%.0fT",k/1073741824; else if(k>=1048576) printf "%.0fG",k/1048576; else if(k>=1024) printf "%.0fM",k/1024; else printf "%dK",k+0} NR==2{h($2)}'; echo __
  { hostname -I 2>/dev/null; ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}'; } | tr ' /' '\n' | awk '/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ && $0 !~ /^127\./ {print; exit}'; echo __
  awk '{print $1}' /proc/loadavg 2>/dev/null
fi
"#;

fn probe_field(parts: &mut std::str::Split<'_, &str>) -> String {
    parts
        .next()
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[tauri::command]
pub async fn ssh_probe(app: AppHandle, state: State<'_, SshState>, session_id: String) -> Result<(), String> {
    let live = live_of(&state, &session_id).await?;
    let mut ch = live
        .handle
        .channel_open_session()
        .await
        .map_err(|e| map_err(&e.to_string()))?;
    let t0 = std::time::Instant::now();
    ch.exec(true, PROBE_CMD)
    .await
    .map_err(|e| map_err(&e.to_string()))?;
    let mut raw = Vec::new();
    loop {
        match ch.wait().await {
            Some(ChannelMsg::Data { ref data }) | Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                raw.extend_from_slice(data);
            }
            Some(ChannelMsg::Eof) | Some(ChannelMsg::ExitStatus { .. }) | None => break,
            _ => {}
        }
    }
    let rtt_ms = t0.elapsed().as_millis() as u32;
    let text = String::from_utf8_lossy(&raw);
    if text.to_lowercase().contains("mingw") || text.to_lowercase().contains("windows") {
        return Ok(());
    }
    let mut parts = text.split("__");
    let hostname = probe_field(&mut parts);
    let os_id = probe_field(&mut parts);
    let distro = probe_field(&mut parts);
    let os = probe_field(&mut parts);
    let cores = probe_field(&mut parts);
    let mem = probe_field(&mut parts);
    let disk = probe_field(&mut parts);
    let disk_total = probe_field(&mut parts);
    let ip = probe_field(&mut parts);
    let load = probe_field(&mut parts);
    let _ = app.emit(
        "ssh:probe",
        SshProbe {
            session_id,
            os,
            cores,
            mem,
            disk,
            hostname,
            distro,
            ip,
            load,
            disk_total,
            os_id,
            rtt_ms,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn ssh_read_local(path: String) -> Result<String, String> {
    tokio::fs::read_to_string(path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ssh_local_size(path: String) -> Result<u64, String> {
    match tokio::fs::metadata(path).await {
        Ok(meta) => Ok(meta.len()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
pub async fn ssh_write_local(path: String, content: String) -> Result<(), String> {
    tokio::fs::write(path, content).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ssh_home(state: State<'_, SshState>, session_id: String) -> Result<String, String> {
    let live = live_of(&state, &session_id).await?;
    let sftp = sftp_of(&live).await?;
    sftp.canonicalize(".").await.map_err(|e| e.to_string())
}
