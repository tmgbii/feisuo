use crate::events::{now_ms, StatusPayload};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;
use suppaftp::list::File as FtpListFile;
use suppaftp::tokio::AsyncFtpStream;
use suppaftp::types::{FileType, Mode};
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FtpConnectReq {
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FtpFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub mode: String,
    pub mtime: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FtpXfer {
    pub session_id: String,
    pub id: String,
    pub name: String,
    pub transferred: u64,
    pub total: u64,
    pub done: bool,
    pub error: Option<String>,
}

pub struct FtpState {
    sessions: Mutex<HashMap<String, Arc<LiveFtp>>>,
    xfer_cancel: Mutex<HashMap<String, CancellationToken>>,
}

struct LiveFtp {
    stream: Mutex<AsyncFtpStream>,
    cancel: CancellationToken,
}

impl FtpState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            xfer_cancel: Mutex::new(HashMap::new()),
        }
    }
}

fn map_err(e: impl ToString) -> String {
    let s = e.to_string();
    let low = s.to_lowercase();
    if s.contains("530") || low.contains("login") {
        return "auth_failed".into();
    }
    if low.contains("timed") || low.contains("timeout") {
        return "timeout".into();
    }
    if low.contains("refused") {
        return "refused".into();
    }
    if low.contains("unreachable") {
        return "unreachable".into();
    }
    s
}

async fn live_of(state: &FtpState, id: &str) -> Result<Arc<LiveFtp>, String> {
    state
        .sessions
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or_else(|| "not_connected".to_string())
}

fn join_remote(dir: &str, name: &str) -> String {
    let name = name.trim_matches('/').replace('\\', "/");
    let dir = dir.trim_end_matches('/');
    if name.is_empty() {
        return if dir.is_empty() { "/".into() } else { dir.to_string() };
    }
    if dir.is_empty() || dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn emit_status(app: &AppHandle, session_id: &str, status: &str, error: Option<String>) {
    let _ = app.emit(
        "ftp:status",
        StatusPayload {
            session_id: session_id.to_string(),
            status: status.into(),
            error,
        },
    );
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
        "ftp:xfer",
        FtpXfer {
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
pub async fn ftp_connect(
    app: AppHandle,
    state: State<'_, FtpState>,
    req: FtpConnectReq,
) -> Result<(), String> {
    if let Some(live) = state.sessions.lock().await.remove(&req.session_id) {
        live.cancel.cancel();
        let mut old = live.stream.lock().await;
        let _ = old.quit().await;
    }
    let addr = format!("{}:{}", req.host.trim(), req.port);
    let mut stream = tokio::time::timeout(Duration::from_secs(15), AsyncFtpStream::connect(&addr))
        .await
        .map_err(|_| "timeout".to_string())?
        .map_err(map_err)?;
    stream
        .login(req.user.trim(), &req.password)
        .await
        .map_err(map_err)?;
    stream.set_mode(Mode::Passive);
    let _ = stream.transfer_type(FileType::Binary).await;
    let live = Arc::new(LiveFtp {
        stream: Mutex::new(stream),
        cancel: CancellationToken::new(),
    });
    state.sessions.lock().await.insert(req.session_id.clone(), live);
    emit_status(&app, &req.session_id, "connected", None);
    Ok(())
}

#[tauri::command]
pub async fn ftp_disconnect(
    app: AppHandle,
    state: State<'_, FtpState>,
    session_id: String,
) -> Result<(), String> {
    if let Some(live) = state.sessions.lock().await.remove(&session_id) {
        live.cancel.cancel();
        let mut stream = live.stream.lock().await;
        let _ = stream.quit().await;
    }
    emit_status(&app, &session_id, "disconnected", None);
    Ok(())
}

#[tauri::command]
pub async fn ftp_home(state: State<'_, FtpState>, session_id: String) -> Result<String, String> {
    let live = live_of(&state, &session_id).await?;
    let mut ftp = live.stream.lock().await;
    ftp.pwd().await.map_err(map_err)
}

#[tauri::command]
pub async fn ftp_list(
    state: State<'_, FtpState>,
    session_id: String,
    path: String,
) -> Result<Vec<FtpFileEntry>, String> {
    let live = live_of(&state, &session_id).await?;
    let mut ftp = live.stream.lock().await;
    let dir = if path.trim().is_empty() {
        ftp.pwd().await.map_err(map_err)?
    } else {
        path
    };
    let _ = ftp.cwd(&dir).await;
    let lines = ftp.list(None).await.map_err(map_err)?;
    let mut out = Vec::new();
    for line in lines {
        let Ok(item) = FtpListFile::from_str(&line) else {
            continue;
        };
        let name = item.name().to_string();
        if name == "." || name == ".." {
            continue;
        }
        let mtime = item
            .modified()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as u32)
            .unwrap_or(0);
        out.push(FtpFileEntry {
            path: join_remote(&dir, &name),
            is_dir: item.is_directory(),
            size: item.size() as u64,
            mode: "—".into(),
            mtime,
            name,
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(out)
}

#[tauri::command]
pub async fn ftp_mkdir(
    state: State<'_, FtpState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let live = live_of(&state, &session_id).await?;
    let mut ftp = live.stream.lock().await;
    ftp.mkdir(&path).await.map_err(map_err)
}

#[tauri::command]
pub async fn ftp_rename(
    state: State<'_, FtpState>,
    session_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let live = live_of(&state, &session_id).await?;
    let mut ftp = live.stream.lock().await;
    ftp.rename(&from, &to).await.map_err(map_err)
}

#[tauri::command]
pub async fn ftp_remove(
    state: State<'_, FtpState>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let live = live_of(&state, &session_id).await?;
    let mut ftp = live.stream.lock().await;
    if is_dir {
        remove_tree(&mut ftp, &path).await
    } else {
        ftp.rm(&path).await.map_err(map_err)
    }
}

async fn remove_tree(ftp: &mut AsyncFtpStream, path: &str) -> Result<(), String> {
    let mut dirs = vec![path.to_string()];
    let mut files = Vec::new();
    let mut i = 0;
    while i < dirs.len() {
        let cur = dirs[i].clone();
        i += 1;
        let _ = ftp.cwd(&cur).await;
        let lines = match ftp.list(None).await {
            Ok(rows) => rows,
            Err(_) => continue,
        };
        for line in lines {
            let Ok(item) = FtpListFile::from_str(&line) else {
                continue;
            };
            let name = item.name();
            if name == "." || name == ".." {
                continue;
            }
            let child = join_remote(&cur, name);
            if item.is_directory() {
                dirs.push(child);
            } else {
                files.push(child);
            }
        }
    }
    for file in files {
        ftp.rm(&file).await.map_err(map_err)?;
    }
    for dir in dirs.into_iter().rev() {
        ftp.rmdir(&dir).await.map_err(map_err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn ftp_read(
    state: State<'_, FtpState>,
    session_id: String,
    path: String,
    max_mb: f64,
) -> Result<String, String> {
    let live = live_of(&state, &session_id).await?;
    let mut ftp = live.stream.lock().await;
    let size = ftp.size(&path).await.unwrap_or(0) as u64;
    let cap = (max_mb.max(0.5) * 1024.0 * 1024.0) as u64;
    if size > cap {
        return Err(format!("over_mb:{max_mb}"));
    }
    let mut stream = ftp.retr_as_stream(&path).await.map_err(map_err)?;
    let mut bytes = Vec::new();
    let read = stream.read_to_end(&mut bytes).await.map_err(|e| e.to_string());
    stream.finish().await.map_err(map_err)?;
    read?;
    if bytes.len() as u64 > cap {
        return Err(format!("over_mb:{max_mb}"));
    }
    String::from_utf8(bytes).map_err(|_| "not_utf8".to_string())
}

#[tauri::command]
pub async fn ftp_write(
    state: State<'_, FtpState>,
    session_id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let live = live_of(&state, &session_id).await?;
    let mut ftp = live.stream.lock().await;
    let mut cur = Cursor::new(content.into_bytes());
    ftp.put_file(&path, &mut cur).await.map_err(map_err)?;
    Ok(())
}

#[tauri::command]
pub async fn ftp_upload(
    app: AppHandle,
    state: State<'_, FtpState>,
    session_id: String,
    local: String,
    remote: String,
    offset: u64,
) -> Result<(), String> {
    let _ = offset;
    let live = live_of(&state, &session_id).await?;
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
    let mut ftp = live.stream.lock().await;
    let result = if meta.is_dir() {
        upload_tree(&app, &session_id, &xfer_id, &name, &mut ftp, &local, &remote, &cancel).await
    } else {
        upload_file(&app, &session_id, &xfer_id, &name, &mut ftp, &local, &remote, &cancel).await
    };
    state.xfer_cancel.lock().await.remove(&xfer_id);
    result
}

async fn upload_file(
    app: &AppHandle,
    session_id: &str,
    xfer_id: &str,
    name: &str,
    ftp: &mut AsyncFtpStream,
    local: &str,
    remote: &str,
    cancel: &CancellationToken,
) -> Result<(), String> {
    if cancel.is_cancelled() {
        return Err("cancelled".into());
    }
    let total = tokio::fs::metadata(local).await.map(|m| m.len()).unwrap_or(0);
    emit_xfer(app, session_id, xfer_id, name, 0, total, false, None);
    let mut file = tokio::fs::File::open(local).await.map_err(|e| e.to_string())?;
    let n = ftp.put_file(remote, &mut file).await.map_err(map_err)?;
    emit_xfer(app, session_id, xfer_id, name, n, total.max(n), true, None);
    Ok(())
}

async fn mkdir_ok(ftp: &mut AsyncFtpStream, path: &str) -> Result<(), String> {
    let path = path.trim_end_matches('/');
    if path.is_empty() || path == "/" {
        return Ok(());
    }
    match ftp.mkdir(path).await {
        Ok(()) => Ok(()),
        Err(err) => {
            let s = err.to_string();
            if s.contains("550") || s.to_lowercase().contains("exist") {
                Ok(())
            } else {
                Err(map_err(err))
            }
        }
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
            } else {
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

async fn upload_tree(
    app: &AppHandle,
    session_id: &str,
    xfer_id: &str,
    name: &str,
    ftp: &mut AsyncFtpStream,
    local: &str,
    remote: &str,
    cancel: &CancellationToken,
) -> Result<(), String> {
    mkdir_ok(ftp, remote).await?;
    let items = collect_tree(Path::new(local)).await?;
    let total: u64 = items.iter().map(|i| i.size).sum();
    let mut done = 0u64;
    emit_xfer(app, session_id, xfer_id, name, 0, total, false, None);
    for item in items {
        if cancel.is_cancelled() {
            emit_xfer(app, session_id, xfer_id, name, done, total, true, Some("cancelled".into()));
            return Err("cancelled".into());
        }
        let dest = join_remote(remote, &item.rel);
        if item.is_dir {
            mkdir_ok(ftp, &dest).await?;
            continue;
        }
        let mut file = tokio::fs::File::open(&item.local).await.map_err(|e| e.to_string())?;
        ftp.put_file(&dest, &mut file).await.map_err(map_err)?;
        done += item.size;
        emit_xfer(app, session_id, xfer_id, name, done, total, false, None);
    }
    emit_xfer(app, session_id, xfer_id, name, total.max(done), total.max(done), true, None);
    Ok(())
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

async fn collect_remote_tree(ftp: &mut AsyncFtpStream, root: &str) -> Result<Vec<RemoteTreeItem>, String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_string()];
    let prefix = root.trim_end_matches('/');
    while let Some(dir) = stack.pop() {
        let _ = ftp.cwd(&dir).await;
        let lines = match ftp.list(None).await {
            Ok(rows) => rows,
            Err(err) => return Err(map_err(err)),
        };
        for line in lines {
            let Ok(item) = FtpListFile::from_str(&line) else {
                continue;
            };
            let name = item.name().to_string();
            if name == "." || name == ".." {
                continue;
            }
            let child = join_remote(&dir, &name);
            let rel = child
                .strip_prefix(prefix)
                .unwrap_or(name.as_str())
                .trim_start_matches('/')
                .to_string();
            if rel.is_empty() {
                continue;
            }
            if item.is_directory() {
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
                    size: item.size() as u64,
                });
            }
        }
    }
    Ok(out)
}

async fn download_file(
    ftp: &mut AsyncFtpStream,
    remote: &str,
    local: &str,
    cancel: &CancellationToken,
) -> Result<u64, String> {
    if cancel.is_cancelled() {
        return Err("cancelled".into());
    }
    let mut out = tokio::fs::File::create(local)
        .await
        .map_err(|e| e.to_string())?;
    let mut stream = ftp.retr_as_stream(remote).await.map_err(map_err)?;
    let copy = tokio::io::copy(&mut stream, &mut out).await;
    let fin = stream.finish().await;
    let n = copy.map_err(|e| e.to_string())?;
    fin.map_err(map_err)?;
    Ok(n)
}

async fn download_tree(
    app: &AppHandle,
    session_id: &str,
    xfer_id: &str,
    name: &str,
    ftp: &mut AsyncFtpStream,
    remote: &str,
    local: &str,
    cancel: &CancellationToken,
) -> Result<(), String> {
    tokio::fs::create_dir_all(local)
        .await
        .map_err(|e| e.to_string())?;
    let items = collect_remote_tree(ftp, remote).await?;
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
            download_file(ftp, &item.remote, &dest, cancel).await?;
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

#[tauri::command]
pub async fn ftp_download(
    app: AppHandle,
    state: State<'_, FtpState>,
    session_id: String,
    remote: String,
    local: String,
    offset: u64,
    is_dir: bool,
) -> Result<(), String> {
    let _ = offset;
    let live = live_of(&state, &session_id).await?;
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
    let mut ftp = live.stream.lock().await;
    let result = if is_dir {
        download_tree(
            &app,
            &session_id,
            &xfer_id,
            &name,
            &mut ftp,
            &remote,
            &local,
            &cancel,
        )
        .await
    } else {
        let total = ftp.size(&remote).await.unwrap_or(0) as u64;
        emit_xfer(&app, &session_id, &xfer_id, &name, 0, total, false, None);
        match download_file(&mut ftp, &remote, &local, &cancel).await {
            Ok(n) => {
                emit_xfer(&app, &session_id, &xfer_id, &name, n, total.max(n), true, None);
                Ok(())
            }
            Err(err) => {
                emit_xfer(&app, &session_id, &xfer_id, &name, 0, total, true, Some(err.clone()));
                Err(err)
            }
        }
    };
    state.xfer_cancel.lock().await.remove(&xfer_id);
    result
}

#[tauri::command]
pub async fn ftp_xfer_cancel(state: State<'_, FtpState>, id: String) -> Result<(), String> {
    if let Some(c) = state.xfer_cancel.lock().await.remove(&id) {
        c.cancel();
    }
    Ok(())
}
