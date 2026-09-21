use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::net::{IpAddr, Ipv4Addr};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use futures_util::stream::{self, StreamExt};
use surge_ping::{Client, Config, PingIdentifier, PingSequence};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct NetdiagState {
    ping: Mutex<Option<CancellationToken>>,
    scan: Mutex<Option<CancellationToken>>,
    lan: Mutex<Option<CancellationToken>>,
    trace: Mutex<Option<CancellationToken>>,
}

impl NetdiagState {
    pub fn new() -> Self {
        Self {
            ping: Mutex::new(None),
            scan: Mutex::new(None),
            lan: Mutex::new(None),
            trace: Mutex::new(None),
        }
    }
}

async fn take_cancel(slot: &Mutex<Option<CancellationToken>>) -> CancellationToken {
    let next = CancellationToken::new();
    let mut g = slot.lock().await;
    if let Some(old) = g.take() {
        old.cancel();
    }
    *g = Some(next.clone());
    next
}

async fn drop_cancel(slot: &Mutex<Option<CancellationToken>>) {
    if let Some(c) = slot.lock().await.take() {
        c.cancel();
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingReq {
    pub host: String,
    pub count: u32,
    pub size: u32,
    pub interval_ms: u64,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PingReply {
    pub seq: u32,
    pub ttl: Option<u32>,
    pub rtt_ms: Option<f64>,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PingDone {
    pub sent: u32,
    pub recv: u32,
    pub loss: f64,
    pub min_ms: Option<f64>,
    pub avg_ms: Option<f64>,
    pub max_ms: Option<f64>,
    pub degraded: bool,
    pub action: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortReq {
    pub host: String,
    pub port: u16,
    pub timeout_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortResult {
    pub open: bool,
    pub time_ms: u64,
    pub error: Option<String>,
    pub action: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IfaceRow {
    pub name: String,
    pub up: bool,
    pub ip: String,
    pub mask: String,
    pub mac: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub ifaces: Vec<IfaceRow>,
    pub egress: String,
    pub gateway: String,
    pub dns: Vec<String>,
    pub action: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteRow {
    pub dest: String,
    pub mask: String,
    pub gateway: String,
    pub iface: String,
    pub metric: String,
    pub is_default: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteInfo {
    pub routes: Vec<RouteRow>,
    pub action: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocksReq {
    pub port: u16,
    pub listen_only: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SockRow {
    pub proto: String,
    pub local: String,
    pub remote: String,
    pub state: String,
    pub pid: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SocksInfo {
    pub rows: Vec<SockRow>,
    pub action: String,
}

fn hidden_cmd(bin: &str) -> Command {
    let mut cmd = Command::new(bin);
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn addr_port(addr: &str) -> Option<u16> {
    if let Some(rest) = addr.strip_prefix('[') {
        let i = rest.find("]:")?;
        rest[i + 2..].parse().ok()
    } else {
        addr.rsplit(':').next()?.parse().ok()
    }
}

fn normalize_state(raw: &str) -> String {
    let u = raw.to_ascii_uppercase();
    if u.contains("LISTEN") || raw.contains("侦听") {
        "LISTEN".into()
    } else if u == "ESTABLISHED" || raw.contains("已建立") {
        "ESTABLISHED".into()
    } else if u.is_empty() || u == "—" {
        "—".into()
    } else {
        u
    }
}

fn is_listen(proto: &str, state: &str, remote: &str) -> bool {
    if proto.eq_ignore_ascii_case("UDP") {
        return remote == "*:*"
            || remote == "0.0.0.0:0"
            || remote == "[::]:0"
            || remote.ends_with(":*");
    }
    state == "LISTEN"
}

fn parse_netstat_line(line: &str) -> Option<SockRow> {
    let cols: Vec<&str> = line.split_whitespace().collect();
    if cols.len() < 4 {
        return None;
    }
    let p = cols[0].to_ascii_uppercase();
    if p != "TCP" && p != "UDP" && p != "TCPV6" && p != "UDPV6" {
        return None;
    }
    let pid = cols.last()?.parse::<u32>().ok()?;
    let proto = if p.starts_with("UDP") { "UDP" } else { "TCP" };
    let local = cols[1].to_string();
    let (remote, state) = if cols.len() == 4 {
        (cols[2].to_string(), "—".into())
    } else {
        (cols[2].to_string(), normalize_state(cols[3]))
    };
    Some(SockRow {
        proto: proto.into(),
        local,
        remote,
        state,
        pid: pid.to_string(),
        name: "—".into(),
    })
}

fn filter_socks(mut rows: Vec<SockRow>, port: u16, listen_only: bool) -> Vec<SockRow> {
    rows.retain(|r| {
        if port != 0 && addr_port(&r.local) != Some(port) {
            return false;
        }
        if listen_only || port == 0 {
            return is_listen(&r.proto, &r.state, &r.remote);
        }
        true
    });
    rows
}

fn ping_cmd(host: &str, size: u32, timeout_ms: u64) -> (String, Vec<String>) {
    let size = size.clamp(8, 1472);
    let wait = ((timeout_ms / 1000).max(1)) as u32;
    #[cfg(windows)]
    {
        (
            "ping".into(),
            vec![
                "-n".into(),
                "1".into(),
                "-l".into(),
                size.to_string(),
                "-w".into(),
                (wait * 1000).to_string(),
                host.into(),
            ],
        )
    }
    #[cfg(not(windows))]
    {
        let mut args = vec!["-c".into(), "1".into(), "-s".into(), size.to_string()];
        if cfg!(target_os = "linux") {
            args.push("-W".into());
            args.push(wait.to_string());
        } else {
            args.push("-W".into());
            args.push((wait * 1000).to_string());
        }
        args.push(host.into());
        ("ping".into(), args)
    }
}

fn ping_action(host: &str, count: u32, size: u32, icmp: bool) -> String {
    if icmp {
        let n = if count == 0 {
            "∞".into()
        } else {
            count.to_string()
        };
        return format!("ICMP ping {host} count={n} size={size}");
    }
    let (bin, args) = ping_cmd(host, size, 1000);
    let n = if count == 0 { "∞".to_string() } else { count.to_string() };
    format!("{bin} {}  ×{n}", args.join(" "))
}

fn parse_ttl_rtt(text: &str) -> (Option<u32>, Option<f64>, bool) {
    let low = text.to_ascii_lowercase();
    let timed_out = low.contains("timed out")
        || low.contains("timeout")
        || text.contains("超时")
        || text.contains("无法访问")
        || low.contains("unreachable")
        || low.contains("100% loss")
        || text.contains("100% 丢失");
    let ttl = grab_after_ci(text, "ttl=").or_else(|| grab_after_ci(text, "TTL="));
    let rtt = grab_ms(text);
    let ok = rtt.is_some() && !timed_out;
    (ttl, rtt, ok)
}

fn grab_after_ci(text: &str, key: &str) -> Option<u32> {
    let i = text.to_ascii_lowercase().find(&key.to_ascii_lowercase())?;
    let rest = &text[i + key.len()..];
    let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    num.parse().ok()
}

fn grab_ms(text: &str) -> Option<f64> {
    for key in ["time=", "time<", "时间=", "时间<"] {
        if let Some(i) = text.find(key) {
            let rest = &text[i + key.len()..];
            let num: String = rest
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            if let Ok(v) = num.parse::<f64>() {
                return Some(v);
            }
        }
    }
    None
}

async fn resolve_ip(host: &str) -> Result<IpAddr, String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("missing_host".into());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(ip);
    }
    let sock = format!("{host}:0");
    let mut it = tokio::net::lookup_host(&sock)
        .await
        .map_err(|_| "unreachable".to_string())?;
    it.next()
        .map(|s| s.ip())
        .ok_or_else(|| "unreachable".to_string())
}

async fn icmp_one(ip: IpAddr, seq: u16, size: usize, timeout_ms: u64) -> Result<PingReply, String> {
    let client = Client::new(&Config::default()).map_err(|e| e.to_string())?;
    let mut pinger = client.pinger(ip, PingIdentifier(1)).await;
    pinger.timeout(Duration::from_millis(timeout_ms.clamp(200, 10_000)));
    let payload = vec![0u8; size.clamp(8, 1472)];
    match pinger.ping(PingSequence(seq), &payload).await {
        Ok((_, dur)) => Ok(PingReply {
            seq: seq as u32,
            ttl: None,
            rtt_ms: Some(dur.as_secs_f64() * 1000.0),
            ok: true,
            error: None,
        }),
        Err(_) => Err("timeout".into()),
    }
}

async fn shell_one(host: &str, size: u32, timeout_ms: u64, seq: u32) -> PingReply {
    let (bin, args) = ping_cmd(host, size, timeout_ms);
    let mut cmd = Command::new(&bin);
    cmd.args(&args);
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match timeout(
        Duration::from_millis(timeout_ms.saturating_add(1500)),
        cmd.output(),
    )
    .await
    {
        Ok(Ok(out)) => {
            let text = String::from_utf8_lossy(&out.stdout);
            let err = String::from_utf8_lossy(&out.stderr);
            let blob = format!("{text}\n{err}");
            let (ttl, rtt, ok) = parse_ttl_rtt(&blob);
            PingReply {
                seq,
                ttl,
                rtt_ms: rtt,
                ok,
                error: if ok {
                    None
                } else if blob.to_ascii_lowercase().contains("unreachable") || blob.contains("无法访问")
                {
                    Some("unreachable".into())
                } else {
                    Some("timeout".into())
                },
            }
        }
        _ => PingReply {
            seq,
            ttl: None,
            rtt_ms: None,
            ok: false,
            error: Some("timeout".into()),
        },
    }
}

#[tauri::command]
pub async fn netdiag_ping_start(
    app: AppHandle,
    state: State<'_, NetdiagState>,
    req: PingReq,
) -> Result<String, String> {
    let host = req.host.trim().to_string();
    if host.is_empty() {
        return Err("missing_host".into());
    }
    let count = req.count;
    let size = req.size.clamp(8, 1472);
    let interval = Duration::from_millis(req.interval_ms.clamp(200, 10_000));
    let timeout_ms = req.timeout_ms.clamp(200, 10_000);
    let cancel = take_cancel(&state.ping).await;
    let ip = resolve_ip(&host).await.ok();
    let icmp_ok = ip.is_some() && Client::new(&Config::default()).is_ok();
    let action = ping_action(&host, count, size, icmp_ok);
    let action_out = action.clone();
    tauri::async_runtime::spawn(async move {
        let mut sent = 0u32;
        let mut recv = 0u32;
        let mut rtts: Vec<f64> = Vec::new();
        let mut seq = 0u32;
        loop {
            if cancel.is_cancelled() {
                break;
            }
            if count > 0 && sent >= count {
                break;
            }
            seq += 1;
            sent += 1;
            let reply = if icmp_ok {
                if let Some(ip) = ip {
                    match icmp_one(ip, seq as u16, size as usize, timeout_ms).await {
                        Ok(mut r) => {
                            r.seq = seq;
                            r
                        }
                        Err(code) => PingReply {
                            seq,
                            ttl: None,
                            rtt_ms: None,
                            ok: false,
                            error: Some(code),
                        },
                    }
                } else {
                    shell_one(&host, size, timeout_ms, seq).await
                }
            } else {
                shell_one(&host, size, timeout_ms, seq).await
            };
            if reply.ok {
                recv += 1;
                if let Some(ms) = reply.rtt_ms {
                    rtts.push(ms);
                }
            }
            let _ = app.emit("netdiag:ping", &reply);
            if count > 0 && sent >= count {
                break;
            }
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = tokio::time::sleep(interval) => {}
            }
        }
        let loss = if sent == 0 {
            0.0
        } else {
            ((sent - recv) as f64) * 100.0 / sent as f64
        };
        let done = PingDone {
            sent,
            recv,
            loss,
            min_ms: rtts.iter().copied().reduce(f64::min),
            avg_ms: if rtts.is_empty() {
                None
            } else {
                Some(rtts.iter().sum::<f64>() / rtts.len() as f64)
            },
            max_ms: rtts.iter().copied().reduce(f64::max),
            degraded: !icmp_ok,
            action,
        };
        let _ = app.emit("netdiag:ping_done", &done);
    });
    Ok(action_out)
}

#[tauri::command]
pub async fn netdiag_ping_stop(state: State<'_, NetdiagState>) -> Result<(), String> {
    drop_cancel(&state.ping).await;
    Ok(())
}

#[tauri::command]
pub async fn netdiag_port(req: PortReq) -> Result<PortResult, String> {
    let host = req.host.trim();
    if host.is_empty() {
        return Err("missing_host".into());
    }
    if req.port == 0 {
        return Err("missing_port".into());
    }
    let action = format!("TCP connect {host}:{}", req.port);
    let (open, time_ms, error) = tcp_probe(host, req.port, req.timeout_ms).await;
    Ok(PortResult {
        open,
        time_ms,
        error,
        action,
    })
}

async fn tcp_probe(host: &str, port: u16, timeout_ms: u64) -> (bool, u64, Option<String>) {
    let dur = Duration::from_millis(timeout_ms.clamp(200, 15_000));
    let target = format!("{host}:{port}");
    let started = Instant::now();
    let result = timeout(dur, async {
        let mut addrs = tokio::net::lookup_host(&target)
            .await
            .map_err(|e| e.kind())?;
        let addr = addrs.next().ok_or(std::io::ErrorKind::NotFound)?;
        TcpStream::connect(addr).await.map_err(|e| e.kind())?;
        Ok::<(), std::io::ErrorKind>(())
    })
    .await;
    let time_ms = started.elapsed().as_millis() as u64;
    match result {
        Ok(Ok(())) => (true, time_ms, None),
        Ok(Err(kind)) => {
            let error = match kind {
                std::io::ErrorKind::ConnectionRefused => "refused",
                std::io::ErrorKind::TimedOut => "timeout",
                std::io::ErrorKind::NotFound => "unreachable",
                _ => "unreachable",
            };
            (false, time_ms, Some(error.into()))
        }
        Err(_) => (false, time_ms, Some("timeout".into())),
    }
}

fn mask_from_v4(ip: Ipv4Addr) -> String {
    ip.to_string()
}

pub fn collect_ifaces() -> Vec<IfaceRow> {
    use network_interface::{Addr, NetworkInterface, NetworkInterfaceConfig};
    let Ok(list) = NetworkInterface::show() else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    for ni in list {
        let mac = ni.mac_addr.unwrap_or_else(|| "—".into());
        let up = !ni.addr.is_empty();
        let v4: Vec<&Addr> = ni
            .addr
            .iter()
            .filter(|a| matches!(a, Addr::V4(_)))
            .collect();
        if v4.is_empty() {
            rows.push(IfaceRow {
                name: ni.name,
                up,
                ip: "—".into(),
                mask: "—".into(),
                mac,
            });
            continue;
        }
        for (i, addr) in v4.into_iter().enumerate() {
            let (ip, mask) = match addr {
                Addr::V4(v) => (
                    v.ip.to_string(),
                    v.netmask.map(mask_from_v4).unwrap_or_else(|| "—".into()),
                ),
                _ => continue,
            };
            rows.push(IfaceRow {
                name: if i == 0 {
                    ni.name.clone()
                } else {
                    format!("{}#{}", ni.name, i)
                },
                up,
                ip,
                mask,
                mac: mac.clone(),
            });
        }
    }
    rows
}

fn egress_ip() -> String {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok();
    let Some(sock) = sock else {
        return "—".into();
    };
    let _ = sock.connect("8.8.8.8:80");
    sock.local_addr()
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "—".into())
}

fn dns_servers() -> Vec<String> {
    #[cfg(windows)]
    {
        dns_from_ipconfig()
    }
    #[cfg(not(windows))]
    {
        let Ok(text) = std::fs::read_to_string("/etc/resolv.conf") else {
            return Vec::new();
        };
        text.lines()
            .filter_map(|l| {
                let l = l.trim();
                l.strip_prefix("nameserver ")
                    .map(|s| s.split_whitespace().next().unwrap_or("").to_string())
            })
            .filter(|s| !s.is_empty())
            .collect()
    }
}

#[cfg(windows)]
fn dns_from_ipconfig() -> Vec<String> {
    let mut cmd = std::process::Command::new("ipconfig");
    cmd.arg("/all");
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().ok();
    let Some(out) = out else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut dns = Vec::new();
    let mut take = false;
    for line in text.lines() {
        let t = line.trim();
        let is_dns = t.to_ascii_lowercase().contains("dns servers")
            || t.contains("DNS 服务器")
            || t.contains("DNS Servers");
        if is_dns {
            take = true;
            if let Some(ip) = t.split(':').nth(1).map(str::trim) {
                if looks_ip(ip) {
                    dns.push(ip.to_string());
                }
            }
            continue;
        }
        if take {
            if t.is_empty() || t.contains(':') {
                take = false;
            } else if looks_ip(t) {
                dns.push(t.to_string());
            } else {
                take = false;
            }
        }
    }
    dns
}

fn looks_ip(s: &str) -> bool {
    s.parse::<IpAddr>().is_ok()
}

fn parse_routes(text: &str) -> Vec<RouteRow> {
    let mut rows = Vec::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 3 {
            continue;
        }
        if cols[0].eq_ignore_ascii_case("destination")
            || cols[0].contains("目标")
            || cols[0].contains("Destination")
            || cols[0] == "Kernel"
            || cols[0] == "Internet:"
        {
            continue;
        }
        let dest = cols[0];
        let is_default = dest.eq_ignore_ascii_case("default") || dest == "0.0.0.0" || dest == "::/0";
        if !is_default && !dest.contains('.') && !dest.contains(':') && dest != "On-link" {
            continue;
        }
        if cfg!(windows) && cols.len() >= 5 && looks_ip(dest) {
            rows.push(RouteRow {
                dest: dest.into(),
                mask: cols[1].to_string(),
                gateway: cols[2].to_string(),
                iface: cols[3].to_string(),
                metric: cols.get(4).unwrap_or(&"").to_string(),
                is_default: dest == "0.0.0.0" && cols[1] == "0.0.0.0",
            });
        } else if !cfg!(windows) {
            let (mask, gw, iface) = if dest.contains('/') {
                (
                    dest.split('/').nth(1).unwrap_or("").to_string(),
                    cols.get(2).or(cols.get(1)).unwrap_or(&"").to_string(),
                    cols.last().unwrap_or(&"").to_string(),
                )
            } else {
                (
                    "—".into(),
                    cols.get(1).unwrap_or(&"").to_string(),
                    cols.get(3).or(cols.get(2)).unwrap_or(&"").to_string(),
                )
            };
            let gw = gw
                .trim_start_matches("via")
                .trim()
                .to_string();
            rows.push(RouteRow {
                dest: dest.into(),
                mask,
                gateway: gw,
                iface,
                metric: "—".into(),
                is_default,
            });
        }
    }
    rows
}

#[cfg(target_os = "linux")]
fn linux_proc_routes() -> Vec<RouteRow> {
    let Ok(text) = std::fs::read_to_string("/proc/net/route") else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    for line in text.lines().skip(1) {
        let c: Vec<&str> = line.split_whitespace().collect();
        if c.len() < 8 {
            continue;
        }
        let iface = c[0].to_string();
        let dest = hex_le_ip(c[1]);
        let gateway = hex_le_ip(c[2]);
        let mask = hex_le_ip(c[7]);
        let metric = c[6].to_string();
        let is_default = dest == "0.0.0.0";
        rows.push(RouteRow {
            dest,
            mask,
            gateway,
            iface,
            metric,
            is_default,
        });
    }
    rows
}

#[cfg(target_os = "linux")]
fn hex_le_ip(h: &str) -> String {
    if h.len() != 8 {
        return h.into();
    }
    let n = u32::from_str_radix(h, 16).unwrap_or(0);
    Ipv4Addr::from(n.to_le_bytes()).to_string()
}

async fn route_text() -> (Vec<RouteRow>, String) {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("route");
        cmd.arg("print");
        cmd.creation_flags(CREATE_NO_WINDOW);
        let action = "route print".into();
        if let Ok(out) = cmd.output().await {
            let text = String::from_utf8_lossy(&out.stdout);
            return (parse_routes(&text), action);
        }
        (Vec::new(), action)
    }
    #[cfg(target_os = "linux")]
    {
        let proc_rows = linux_proc_routes();
        if !proc_rows.is_empty() {
            return (proc_rows, "/proc/net/route".into());
        }
        let action = "ip route".into();
        if let Ok(out) = Command::new("ip").args(["route"]).output().await {
            let text = String::from_utf8_lossy(&out.stdout);
            return (parse_routes(&text), action);
        }
        (Vec::new(), action)
    }
    #[cfg(target_os = "macos")]
    {
        let action = "netstat -rn -f inet".into();
        if let Ok(out) = Command::new("netstat")
            .args(["-rn", "-f", "inet"])
            .output()
            .await
        {
            let text = String::from_utf8_lossy(&out.stdout);
            return (parse_routes(&text), action);
        }
        (Vec::new(), action)
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        (Vec::new(), "route".into())
    }
}

#[tauri::command]
pub async fn netdiag_host() -> Result<HostInfo, String> {
    let ifaces = collect_ifaces();
    let egress = egress_ip();
    let routes: Vec<RouteRow> = {
        #[cfg(target_os = "linux")]
        {
            linux_proc_routes()
        }
        #[cfg(not(target_os = "linux"))]
        {
            Vec::new()
        }
    };
    let gateway = routes
        .iter()
        .find(|r| r.is_default)
        .map(|r| r.gateway.clone())
        .filter(|g| g != "0.0.0.0" && g != "*")
        .unwrap_or_else(|| "—".into());
    #[cfg(windows)]
    let action = "ipconfig /all".to_string();
    #[cfg(target_os = "linux")]
    let action = "ip addr · /etc/resolv.conf".to_string();
    #[cfg(target_os = "macos")]
    let action = "ifconfig · /etc/resolv.conf".to_string();
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    let action = "ifaces".to_string();
    let mut gw = gateway;
    if gw == "—" {
        let (rt, _) = route_text().await;
        if let Some(r) = rt.iter().find(|r| r.is_default) {
            if r.gateway != "0.0.0.0" && r.gateway != "*" && !r.gateway.is_empty() {
                gw = r.gateway.clone();
            }
        }
    }
    Ok(HostInfo {
        ifaces,
        egress,
        gateway: gw,
        dns: dns_servers(),
        action,
    })
}

#[tauri::command]
pub async fn netdiag_routes() -> Result<RouteInfo, String> {
    let (routes, action) = route_text().await;
    Ok(RouteInfo { routes, action })
}

fn parse_tasklist_csv(text: &str) -> HashMap<u32, String> {
    let mut map = HashMap::new();
    map.insert(0, "System Idle".into());
    map.insert(4, "System".into());
    for line in text.lines() {
        let line = line.trim().trim_start_matches('\u{feff}');
        if !line.starts_with('"') {
            continue;
        }
        let rest = &line[1..];
        let Some(end) = rest.find('"') else {
            continue;
        };
        let name = rest[..end].to_string();
        let after = rest[end + 1..].trim_start_matches(',').trim_start_matches('"');
        let pid_s: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(pid) = pid_s.parse::<u32>() {
            map.insert(pid, name);
        }
    }
    map
}

fn apply_names(rows: &mut [SockRow], names: &HashMap<u32, String>) {
    for row in rows {
        if let Ok(pid) = row.pid.parse::<u32>() {
            if let Some(n) = names.get(&pid) {
                row.name = n.clone();
            }
        }
    }
}

#[cfg(windows)]
async fn windows_socks(port: u16, listen_only: bool) -> (Vec<SockRow>, String) {
    let action = if port == 0 {
        "netstat -ano".into()
    } else {
        format!("netstat -ano  ·  :{port}")
    };
    let mut cmd = hidden_cmd("netstat");
    cmd.arg("-ano");
    let Ok(out) = cmd.output().await else {
        return (Vec::new(), action);
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut rows: Vec<SockRow> = text.lines().filter_map(parse_netstat_line).collect();
    rows = filter_socks(rows, port, listen_only);
    let mut names = HashMap::new();
    let mut tl = hidden_cmd("tasklist");
    tl.args(["/FO", "CSV", "/NH"]);
    if let Ok(out) = tl.output().await {
        names = parse_tasklist_csv(&String::from_utf8_lossy(&out.stdout));
    }
    apply_names(&mut rows, &names);
    (rows, action)
}

#[cfg(target_os = "linux")]
fn hex_ipv6(h: &str) -> String {
    use std::net::Ipv6Addr;
    if h.len() != 32 {
        return h.into();
    }
    let mut bytes = [0u8; 16];
    for i in 0..4 {
        let word = u32::from_str_radix(&h[i * 8..i * 8 + 8], 16).unwrap_or(0);
        bytes[i * 4..i * 4 + 4].copy_from_slice(&word.to_le_bytes());
    }
    Ipv6Addr::from(bytes).to_string()
}

#[cfg(target_os = "linux")]
fn proc_ip_port(s: &str) -> Option<(String, u16)> {
    let (ip, port) = s.split_once(':')?;
    let port = u16::from_str_radix(port, 16).ok()?;
    let ip = if ip.len() == 8 {
        hex_le_ip(ip)
    } else {
        hex_ipv6(ip)
    };
    Some((ip, port))
}

#[cfg(target_os = "linux")]
fn tcp_state(st: &str) -> String {
    match st.to_ascii_uppercase().as_str() {
        "01" => "ESTABLISHED",
        "02" => "SYN_SENT",
        "06" => "TIME_WAIT",
        "08" => "CLOSE_WAIT",
        "0A" => "LISTEN",
        _ => st,
    }
    .into()
}

#[cfg(target_os = "linux")]
fn inode_to_pid() -> HashMap<u64, u32> {
    let mut map = HashMap::new();
    let Ok(proc) = std::fs::read_dir("/proc") else {
        return map;
    };
    for ent in proc.flatten() {
        let Some(pid) = ent.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        let Ok(fds) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
            continue;
        };
        for fd in fds.flatten() {
            let Ok(link) = std::fs::read_link(fd.path()) else {
                continue;
            };
            let s = link.to_string_lossy();
            let Some(n) = s.strip_prefix("socket:[") else {
                continue;
            };
            let Some(n) = n.strip_suffix(']') else {
                continue;
            };
            if let Ok(ino) = n.parse::<u64>() {
                map.entry(ino).or_insert(pid);
            }
        }
    }
    map
}

#[cfg(target_os = "linux")]
fn proc_comm(pid: u32) -> String {
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "—".into())
}

#[cfg(target_os = "linux")]
fn linux_proc_socks(path: &str, proto: &str, udp: bool) -> Vec<SockRow> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let inodes = inode_to_pid();
    let mut rows = Vec::new();
    for line in text.lines().skip(1) {
        let c: Vec<&str> = line.split_whitespace().collect();
        if c.len() < 10 {
            continue;
        }
        let Some((lip, lp)) = proc_ip_port(c[1]) else {
            continue;
        };
        let Some((rip, rp)) = proc_ip_port(c[2]) else {
            continue;
        };
        let state = if udp {
            "—".into()
        } else {
            tcp_state(c[3])
        };
        let inode: u64 = c[9].parse().unwrap_or(0);
        let (pid, name) = if let Some(&pid) = inodes.get(&inode) {
            (pid.to_string(), proc_comm(pid))
        } else {
            ("—".into(), "—".into())
        };
        rows.push(SockRow {
            proto: proto.into(),
            local: format!("{lip}:{lp}"),
            remote: format!("{rip}:{rp}"),
            state,
            pid,
            name,
        });
    }
    rows
}

#[cfg(target_os = "linux")]
async fn linux_socks(port: u16, listen_only: bool) -> (Vec<SockRow>, String) {
    let action = if port == 0 {
        "/proc/net/tcp · /proc/*/fd".into()
    } else {
        format!("/proc/net/tcp  ·  :{port}")
    };
    let mut rows = linux_proc_socks("/proc/net/tcp", "TCP", false);
    rows.extend(linux_proc_socks("/proc/net/tcp6", "TCP", false));
    rows.extend(linux_proc_socks("/proc/net/udp", "UDP", true));
    rows.extend(linux_proc_socks("/proc/net/udp6", "UDP", true));
    if rows.is_empty() {
        let action = if port == 0 {
            "ss -tulpn".into()
        } else {
            format!("ss -tulpn  ·  :{port}")
        };
        let mut cmd = hidden_cmd("ss");
        cmd.args(["-tulpn"]);
        if let Ok(out) = cmd.output().await {
            let text = String::from_utf8_lossy(&out.stdout);
            rows = parse_ss(&text);
        }
        return (filter_socks(rows, port, listen_only), action);
    }
    (filter_socks(rows, port, listen_only), action)
}

#[cfg(target_os = "linux")]
fn parse_ss(text: &str) -> Vec<SockRow> {
    let mut rows = Vec::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 5 {
            continue;
        }
        let proto = cols[0].to_ascii_uppercase();
        if !proto.starts_with("TCP") && !proto.starts_with("UDP") {
            continue;
        }
        let proto = if proto.starts_with("UDP") { "UDP" } else { "TCP" };
        let (state, local, remote, rest_i) = if proto == "UDP" {
            ("—".into(), cols[3].to_string(), cols[4].to_string(), 5)
        } else {
            (
                normalize_state(cols[1]),
                cols[4].to_string(),
                cols.get(5).unwrap_or(&"").to_string(),
                6,
            )
        };
        let rest = cols.get(rest_i).copied().unwrap_or("");
        let (pid, name) = parse_ss_users(rest).unwrap_or_else(|| ("—".into(), "—".into()));
        rows.push(SockRow {
            proto: proto.into(),
            local,
            remote,
            state,
            pid,
            name,
        });
    }
    rows
}

#[cfg(target_os = "linux")]
fn parse_ss_users(s: &str) -> Option<(String, String)> {
    let i = s.find("pid=")?;
    let rest = &s[i + 4..];
    let pid: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    let name = s.find("((\"").and_then(|j| {
        let r = &s[j + 3..];
        r.split('"').next().map(|n| n.to_string())
    });
    Some((pid, name.unwrap_or_else(|| "—".into())))
}

#[cfg(target_os = "macos")]
fn parse_lsof(text: &str) -> Vec<SockRow> {
    let mut rows = Vec::new();
    for line in text.lines().skip(1) {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 9 {
            continue;
        }
        let name_col = cols[8..].join(" ");
        let proto = if name_col.contains("UDP") {
            "UDP"
        } else {
            "TCP"
        };
        let (local, remote, state) = parse_lsof_name(&name_col);
        rows.push(SockRow {
            proto: proto.into(),
            local,
            remote,
            state,
            pid: cols[1].to_string(),
            name: cols[0].to_string(),
        });
    }
    rows
}

#[cfg(target_os = "macos")]
fn parse_lsof_name(name: &str) -> (String, String, String) {
    let body = name
        .trim_start_matches("TCP ")
        .trim_start_matches("UDP ");
    let (pair, st) = if let Some(i) = body.find(" (") {
        (
            &body[..i],
            normalize_state(body[i + 2..].trim_end_matches(')')),
        )
    } else {
        (body, "—".into())
    };
    if let Some((a, b)) = pair.split_once("->") {
        (a.to_string(), b.to_string(), st)
    } else {
        (pair.to_string(), "—".into(), st)
    }
}

#[cfg(target_os = "macos")]
async fn macos_socks(port: u16, listen_only: bool) -> (Vec<SockRow>, String) {
    let action = if port == 0 {
        "lsof -nP -iTCP -sTCP:LISTEN · -iUDP".into()
    } else {
        format!("lsof -nP -i:{port}")
    };
    let mut rows = Vec::new();
    if port == 0 {
        let mut tcp = hidden_cmd("lsof");
        tcp.args(["-nP", "-iTCP", "-sTCP:LISTEN"]);
        if let Ok(out) = tcp.output().await {
            rows.extend(parse_lsof(&String::from_utf8_lossy(&out.stdout)));
        }
        let mut udp = hidden_cmd("lsof");
        udp.args(["-nP", "-iUDP"]);
        if let Ok(out) = udp.output().await {
            rows.extend(parse_lsof(&String::from_utf8_lossy(&out.stdout)));
        }
    } else {
        let mut cmd = hidden_cmd("lsof");
        cmd.args(["-nP", &format!("-i:{port}")]);
        if let Ok(out) = cmd.output().await {
            rows = parse_lsof(&String::from_utf8_lossy(&out.stdout));
        }
    }
    (filter_socks(rows, port, listen_only), action)
}

#[tauri::command]
pub async fn netdiag_socks(req: SocksReq) -> Result<SocksInfo, String> {
    let listen_only = req.listen_only || req.port == 0;
    #[cfg(windows)]
    let (rows, action) = windows_socks(req.port, listen_only).await;
    #[cfg(target_os = "linux")]
    let (rows, action) = linux_socks(req.port, listen_only).await;
    #[cfg(target_os = "macos")]
    let (rows, action) = macos_socks(req.port, listen_only).await;
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    let (rows, action) = (Vec::new(), "netstat".to_string());
    Ok(SocksInfo { rows, action })
}

const COMMON_PORTS: &[u16] = &[
    21, 22, 23, 25, 53, 80, 110, 139, 143, 161, 389, 443, 445, 465, 502, 587, 993, 995, 1433, 1521,
    1883, 2375, 3306, 3389, 4840, 5432, 5672, 5900, 6379, 8080, 8443, 8883, 9000, 9090, 9200, 1502,
    102, 44818, 47808, 20000,
];

fn parse_port_list(raw: &str) -> Result<Vec<u16>, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(COMMON_PORTS.to_vec());
    }
    let mut set = BTreeSet::new();
    for part in raw.split([',', ' ', '，', ';', '、']) {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some((a, b)) = part.split_once('-') {
            let a: u16 = a.trim().parse().map_err(|_| "missing_port".to_string())?;
            let b: u16 = b.trim().parse().map_err(|_| "missing_port".to_string())?;
            let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
            if u32::from(hi) - u32::from(lo) + 1 + set.len() as u32 > 256 {
                return Err("too_many_ports".into());
            }
            for p in lo..=hi {
                if p != 0 {
                    set.insert(p);
                }
            }
        } else {
            let p: u16 = part.parse().map_err(|_| "missing_port".to_string())?;
            if p != 0 {
                set.insert(p);
            }
        }
        if set.len() > 256 {
            return Err("too_many_ports".into());
        }
    }
    if set.is_empty() {
        return Ok(COMMON_PORTS.to_vec());
    }
    Ok(set.into_iter().collect())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReq {
    pub host: String,
    pub ports: String,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanHit {
    pub port: u16,
    pub open: bool,
    pub time_ms: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanDone {
    pub open: Vec<u16>,
    pub total: u32,
    pub action: String,
}

#[tauri::command]
pub async fn netdiag_scan_start(
    app: AppHandle,
    state: State<'_, NetdiagState>,
    req: ScanReq,
) -> Result<String, String> {
    let host = req.host.trim().to_string();
    if host.is_empty() {
        return Err("missing_host".into());
    }
    let ports = parse_port_list(&req.ports)?;
    let timeout_ms = req.timeout_ms.clamp(200, 8_000);
    let action = format!(
        "TCP connect {host} ports={} n={}",
        join_ports(&ports),
        ports.len()
    );
    let action_out = action.clone();
    let total = ports.len() as u32;
    let cancel = take_cancel(&state.scan).await;
    tauri::async_runtime::spawn(async move {
        let found = Arc::new(Mutex::new(Vec::<u16>::new()));
        stream::iter(ports)
            .for_each_concurrent(32, |port| {
                let host = host.clone();
                let app = app.clone();
                let cancel = cancel.clone();
                let found = found.clone();
                async move {
                    if cancel.is_cancelled() {
                        return;
                    }
                    let (ok, time_ms, error) = tcp_probe(&host, port, timeout_ms).await;
                    if ok {
                        found.lock().await.push(port);
                    }
                    let _ = app.emit(
                        "netdiag:scan",
                        ScanHit {
                            port,
                            open: ok,
                            time_ms,
                            error,
                        },
                    );
                }
            })
            .await;
        let mut open = found.lock().await.clone();
        open.sort_unstable();
        let _ = app.emit(
            "netdiag:scan_done",
            ScanDone {
                open,
                total,
                action,
            },
        );
    });
    Ok(action_out)
}

fn join_ports(ports: &[u16]) -> String {
    if ports.len() > 12 {
        format!("{}…", ports[..8].iter().map(|p| p.to_string()).collect::<Vec<_>>().join(","))
    } else {
        ports.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",")
    }
}

#[tauri::command]
pub async fn netdiag_scan_stop(state: State<'_, NetdiagState>) -> Result<(), String> {
    drop_cancel(&state.scan).await;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanHost {
    pub ip: String,
    pub rtt_ms: Option<f64>,
    pub mac: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanDone {
    pub up: u32,
    pub total: u32,
    pub action: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArpInfo {
    pub rows: Vec<LanHost>,
    pub action: String,
}

fn mask_prefix(mask: &str) -> Option<u8> {
    let ip: Ipv4Addr = mask.parse().ok()?;
    let n = u32::from(ip);
    if n.leading_ones() + n.trailing_zeros() != 32 && n != 0 {
        return None;
    }
    Some(n.count_ones() as u8)
}

fn subnet_targets() -> Result<(String, Vec<Ipv4Addr>), String> {
    let egress = egress_ip();
    let ip: Ipv4Addr = egress.parse().map_err(|_| "unreachable".to_string())?;
    if ip.is_loopback() {
        return Err("net_too_wide".into());
    }
    let ifaces = collect_ifaces();
    let mask = ifaces
        .iter()
        .find(|r| r.ip == egress)
        .map(|r| r.mask.as_str())
        .unwrap_or("255.255.255.0");
    let prefix = mask_prefix(mask).unwrap_or(24);
    if prefix < 24 {
        return Err("net_too_wide".into());
    }
    let mn = u32::from(mask.parse::<Ipv4Addr>().unwrap_or(Ipv4Addr::new(255, 255, 255, 0)));
    let net = u32::from(ip) & mn;
    let count = 1u32 << (32 - prefix);
    let mut hosts = Vec::new();
    for i in 1..count.saturating_sub(1) {
        let h = Ipv4Addr::from(net + i);
        if h != ip {
            hosts.push(h);
        }
    }
    let cidr = format!("{}/{}", Ipv4Addr::from(net), prefix);
    Ok((cidr, hosts))
}

fn parse_arp_table(text: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 2 || !looks_ip(cols[0]) {
            continue;
        }
        let mac = cols[1].replace('-', ":").to_ascii_lowercase();
        if mac.contains(':') || cols[1].contains('-') {
            map.insert(cols[0].to_string(), mac);
        }
    }
    map
}

async fn arp_map() -> (HashMap<String, String>, String) {
    #[cfg(windows)]
    {
        let mut cmd = hidden_cmd("arp");
        cmd.arg("-a");
        let action = "arp -a".to_string();
        if let Ok(out) = cmd.output().await {
            return (parse_arp_table(&String::from_utf8_lossy(&out.stdout)), action);
        }
        (HashMap::new(), action)
    }
    #[cfg(target_os = "linux")]
    {
        let action = "/proc/net/arp".to_string();
        if let Ok(text) = std::fs::read_to_string("/proc/net/arp") {
            return (parse_arp_table(&text), action);
        }
        (HashMap::new(), action)
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = hidden_cmd("arp");
        cmd.arg("-an");
        let action = "arp -an".to_string();
        if let Ok(out) = cmd.output().await {
            let mut map = HashMap::new();
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                // ? (192.168.1.1) at aa:bb:cc:dd:ee:ff on en0
                let ip = line.split('(').nth(1).and_then(|s| s.split(')').next());
                let mac = line.split(" at ").nth(1).and_then(|s| s.split_whitespace().next());
                if let (Some(ip), Some(mac)) = (ip, mac) {
                    if looks_ip(ip) && mac.contains(':') {
                        map.insert(ip.to_string(), mac.replace('-', ":"));
                    }
                }
            }
            return (map, action);
        }
        (HashMap::new(), action)
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        (HashMap::new(), "arp".into())
    }
}

#[tauri::command]
pub async fn netdiag_lan_start(app: AppHandle, state: State<'_, NetdiagState>) -> Result<String, String> {
    let (cidr, hosts) = subnet_targets()?;
    let action = format!("ICMP ping {cidr} n={}", hosts.len());
    let action_out = action.clone();
    let total = hosts.len() as u32;
    let cancel = take_cancel(&state.lan).await;
    tauri::async_runtime::spawn(async move {
        let icmp_ok = Client::new(&Config::default()).is_ok();
        let up = Arc::new(Mutex::new(0u32));
        stream::iter(hosts)
            .for_each_concurrent(32, |ip| {
                let app = app.clone();
                let cancel = cancel.clone();
                let up = up.clone();
                async move {
                    if cancel.is_cancelled() {
                        return;
                    }
                    let host = ip.to_string();
                    let rtt = if icmp_ok {
                        match icmp_one(IpAddr::V4(ip), 1, 32, 800).await {
                            Ok(r) if r.ok => r.rtt_ms,
                            _ => None,
                        }
                    } else {
                        let r = shell_one(&host, 32, 800, 1).await;
                        if r.ok { r.rtt_ms } else { None }
                    };
                    if rtt.is_none() {
                        return;
                    }
                    *up.lock().await += 1;
                    let _ = app.emit(
                        "netdiag:lan",
                        LanHost {
                            ip: host,
                            rtt_ms: rtt,
                            mac: "—".into(),
                            name: "—".into(),
                        },
                    );
                }
            })
            .await;
        let (macs, _) = arp_map().await;
        if !macs.is_empty() {
            for (ip, mac) in &macs {
                let _ = app.emit(
                    "netdiag:lan",
                    LanHost {
                        ip: ip.clone(),
                        rtt_ms: None,
                        mac: mac.clone(),
                        name: "—".into(),
                    },
                );
            }
        }
        let n = *up.lock().await;
        let _ = app.emit(
            "netdiag:lan_done",
            LanDone {
                up: n,
                total,
                action,
            },
        );
    });
    Ok(action_out)
}

#[tauri::command]
pub async fn netdiag_lan_stop(state: State<'_, NetdiagState>) -> Result<(), String> {
    drop_cancel(&state.lan).await;
    Ok(())
}

#[tauri::command]
pub async fn netdiag_arp() -> Result<ArpInfo, String> {
    let (map, action) = arp_map().await;
    let mut rows: Vec<LanHost> = map
        .into_iter()
        .map(|(ip, mac)| LanHost {
            ip,
            rtt_ms: None,
            mac,
            name: "—".into(),
        })
        .collect();
    rows.sort_by(|a, b| a.ip.cmp(&b.ip));
    Ok(ArpInfo { rows, action })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsInfo {
    pub host: String,
    pub addrs: Vec<String>,
    pub action: String,
}

#[tauri::command]
pub async fn netdiag_dns(host: String) -> Result<DnsInfo, String> {
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("missing_host".into());
    }
    let action = format!("getaddrinfo {host}");
    let sock = format!("{host}:0");
    let addrs = match tokio::net::lookup_host(&sock).await {
        Ok(it) => {
            let mut v: Vec<String> = it.map(|s| s.ip().to_string()).collect();
            v.sort();
            v.dedup();
            v
        }
        Err(_) => Vec::new(),
    };
    Ok(DnsInfo {
        host,
        addrs,
        action,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceReq {
    pub host: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceHop {
    pub hop: u32,
    pub ip: String,
    pub rtt_ms: Option<f64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceDone {
    pub hops: u32,
    pub action: String,
}

fn parse_trace_line(line: &str) -> Option<TraceHop> {
    let cols: Vec<&str> = line.split_whitespace().collect();
    if cols.is_empty() {
        return None;
    }
    let hop: u32 = cols[0].parse().ok()?;
    if hop == 0 || hop > 64 {
        return None;
    }
    let timed = line.contains('*')
        && (line.matches('*').count() >= 2 || line.contains("超时") || line.to_ascii_lowercase().contains("timeout"));
    let ip = cols
        .iter()
        .rev()
        .map(|c| c.trim_matches(|ch| ch == '[' || ch == ']' || ch == ','))
        .find(|c| looks_ip(c))
        .unwrap_or("—")
        .to_string();
    let mut rtt = None;
    for c in &cols {
        let t = c.to_ascii_lowercase().replace("ms", "").replace("毫秒", "");
        if let Ok(v) = t.parse::<f64>() {
            if cols[0] != *c {
                rtt = Some(v);
                break;
            }
        }
    }
    Some(TraceHop {
        hop,
        ip: ip.clone(),
        rtt_ms: rtt,
        error: if timed && ip == "—" {
            Some("timeout".into())
        } else {
            None
        },
    })
}

#[tauri::command]
pub async fn netdiag_trace_start(
    app: AppHandle,
    state: State<'_, NetdiagState>,
    req: TraceReq,
) -> Result<String, String> {
    let host = req.host.trim().to_string();
    if host.is_empty() {
        return Err("missing_host".into());
    }
    #[cfg(windows)]
    let (bin, args): (String, Vec<String>) = (
        "tracert".into(),
        vec!["-d".into(), "-h".into(), "20".into(), "-w".into(), "800".into(), host.clone()],
    );
    #[cfg(not(windows))]
    let (bin, args): (String, Vec<String>) = (
        "traceroute".into(),
        vec!["-n".into(), "-w".into(), "1".into(), "-q".into(), "1".into(), "-m".into(), "20".into(), host.clone()],
    );
    let action = format!("{bin} {}", args.join(" "));
    let action_out = action.clone();
    let cancel = take_cancel(&state.trace).await;
    tauri::async_runtime::spawn(async move {
        let mut cmd = hidden_cmd(&bin);
        cmd.args(&args);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        let Ok(mut child) = cmd.spawn() else {
            let _ = app.emit(
                "netdiag:trace_done",
                TraceDone {
                    hops: 0,
                    action,
                },
            );
            return;
        };
        let stdout = child.stdout.take();
        let mut hops = 0u32;
        if let Some(out) = stdout {
            let mut lines = BufReader::new(out).lines();
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => {
                        let _ = child.start_kill();
                        break;
                    }
                    line = lines.next_line() => {
                        match line {
                            Ok(Some(l)) => {
                                if let Some(hop) = parse_trace_line(&l) {
                                    hops = hop.hop;
                                    let _ = app.emit("netdiag:trace", &hop);
                                }
                            }
                            _ => break,
                        }
                    }
                }
            }
        }
        let _ = child.wait().await;
        let _ = app.emit("netdiag:trace_done", TraceDone { hops, action });
    });
    Ok(action_out)
}

#[tauri::command]
pub async fn netdiag_trace_stop(state: State<'_, NetdiagState>) -> Result<(), String> {
    drop_cancel(&state.trace).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn netstat_listen() {
        let row = parse_netstat_line("TCP    0.0.0.0:80             0.0.0.0:0              LISTENING       4")
            .unwrap();
        assert_eq!(row.proto, "TCP");
        assert_eq!(row.pid, "4");
        assert_eq!(row.state, "LISTEN");
        assert_eq!(addr_port(&row.local), Some(80));
    }

    #[test]
    fn netstat_udp() {
        let row = parse_netstat_line("UDP    0.0.0.0:53            *:*                                    1234").unwrap();
        assert_eq!(row.proto, "UDP");
        assert_eq!(row.pid, "1234");
        assert!(is_listen(&row.proto, &row.state, &row.remote));
    }

    #[test]
    fn ipv6_port() {
        assert_eq!(addr_port("[::1]:443"), Some(443));
    }

    #[test]
    fn port_list_default() {
        assert!(parse_port_list("").unwrap().contains(&502));
        assert_eq!(parse_port_list("80,443").unwrap(), vec![80, 443]);
        assert_eq!(parse_port_list("8000-8002").unwrap(), vec![8000, 8001, 8002]);
        assert!(parse_port_list("1-300").is_err());
    }
}
