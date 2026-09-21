use russh::client::Handle;
use russh::ChannelMsg;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

pub async fn run_socks<H>(
    listener: TcpListener,
    handle: Arc<Handle<H>>,
    cancel: CancellationToken,
) where
    H: russh::client::Handler + Send + Sync + 'static,
    H::Error: From<russh::Error> + Send + std::fmt::Debug,
{
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { break };
                let h = handle.clone();
                let c = cancel.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = serve(stream, h, c).await;
                });
            }
        }
    }
}

async fn serve<H>(
    mut stream: TcpStream,
    handle: Arc<Handle<H>>,
    cancel: CancellationToken,
) -> Result<(), String>
where
    H: russh::client::Handler + Send + Sync + 'static,
    H::Error: From<russh::Error> + Send + std::fmt::Debug,
{
    let mut buf = [0u8; 258];
    stream.read_exact(&mut buf[..2]).await.map_err(|e| e.to_string())?;
    if buf[0] != 5 {
        return Err("not_socks5".into());
    }
    let n = buf[1] as usize;
    stream.read_exact(&mut buf[..n]).await.map_err(|e| e.to_string())?;
    stream.write_all(&[5, 0]).await.map_err(|e| e.to_string())?;

    stream.read_exact(&mut buf[..4]).await.map_err(|e| e.to_string())?;
    if buf[0] != 5 || buf[1] != 1 {
        let _ = stream.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await;
        return Err("socks_connect_only".into());
    }
    let atyp = buf[3];
    let (host, port) = match atyp {
        1 => {
            stream.read_exact(&mut buf[..6]).await.map_err(|e| e.to_string())?;
            let ip = format!("{}.{}.{}.{}", buf[0], buf[1], buf[2], buf[3]);
            let port = u16::from_be_bytes([buf[4], buf[5]]);
            (ip, port)
        }
        3 => {
            stream.read_exact(&mut buf[..1]).await.map_err(|e| e.to_string())?;
            let len = buf[0] as usize;
            stream.read_exact(&mut buf[..len + 2]).await.map_err(|e| e.to_string())?;
            let host = String::from_utf8_lossy(&buf[..len]).to_string();
            let port = u16::from_be_bytes([buf[len], buf[len + 1]]);
            (host, port)
        }
        4 => {
            let mut raw = [0u8; 18];
            stream.read_exact(&mut raw).await.map_err(|e| e.to_string())?;
            let mut oct = [0u8; 16];
            oct.copy_from_slice(&raw[..16]);
            let host = std::net::Ipv6Addr::from(oct).to_string();
            let port = u16::from_be_bytes([raw[16], raw[17]]);
            (host, port)
        }
        _ => return Err("addr_type".into()),
    };

    let channel = handle
        .channel_open_direct_tcpip(&host, port as u32, "127.0.0.1", 0)
        .await
        .map_err(|e| e.to_string())?;
    stream
        .write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
        .await
        .map_err(|e| e.to_string())?;
    pump(stream, channel, cancel).await
}

pub async fn pump(
    mut tcp: TcpStream,
    mut channel: russh::Channel<russh::client::Msg>,
    cancel: CancellationToken,
) -> Result<(), String> {
    let mut buf = vec![0u8; 8192];
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            n = tcp.read(&mut buf) => {
                match n {
                    Ok(0) | Err(_) => {
                        let _ = channel.eof().await;
                        break;
                    }
                    Ok(n) => {
                        channel.data(&buf[..n]).await.map_err(|e| e.to_string())?;
                    }
                }
            }
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { ref data }) => {
                        if tcp.write_all(data).await.is_err() {
                            break;
                        }
                    }
                    Some(ChannelMsg::Eof) | None => break,
                    _ => {}
                }
            }
        }
    }
    Ok(())
}
