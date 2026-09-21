mod commands;
mod events;
mod ftp;
mod db;
mod http;
mod ai;
mod persist;
mod proto;
mod ssh;
mod state;
mod netdiag;

use tauri::image::Image;
use tauri::include_image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, Manager};

const APP_ICON: Image<'_> = include_image!("icons/128x128.png");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state::AppState::new())
        .manage(ssh::SshState::new())
        .manage(ftp::FtpState::new())
        .manage(db::DbState::new())
        .manage(netdiag::NetdiagState::new())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                proto::serial::watch_ports(handle).await;
            });
            setup_tray(app)?;
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_icon(APP_ICON);
                let handle = app.handle().clone();
                win.on_window_event(move |event| match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        hide_main(&handle);
                    }
                    tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                        if let Some(w) = handle.get_webview_window("main") {
                            if w.is_minimized().unwrap_or(false) {
                                hide_main(&handle);
                                let _ = w.unminimize();
                            }
                        }
                    }
                    _ => {}
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_serial_ports,
            commands::connect_session,
            commands::disconnect_session,
            commands::send_session,
            commands::mqtt_subscribe,
            commands::mqtt_unsubscribe,
            commands::kick_tcp_client,
            http::http_request,
            ai::ai_chat,
            ai::ai_stop,
            ssh::ssh_connect,
            ssh::ssh_disconnect,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_answer_hostkey,
            ssh::ssh_sftp_list,
            ssh::ssh_sftp_mkdir,
            ssh::ssh_sftp_rename,
            ssh::ssh_sftp_remove,
            ssh::ssh_sftp_chmod,
            ssh::ssh_sftp_read,
            ssh::ssh_sftp_write,
            ssh::ssh_sftp_upload,
            ssh::ssh_sftp_download,
            ssh::ssh_xfer_cancel,
            ssh::ssh_tunnel_start,
            ssh::ssh_tunnel_stop,
            ssh::ssh_probe,
            ssh::ssh_home,
            ssh::ssh_read_local,
            ssh::ssh_write_local,
            ssh::ssh_local_size,
            ftp::ftp_connect,
            ftp::ftp_disconnect,
            ftp::ftp_home,
            ftp::ftp_list,
            ftp::ftp_mkdir,
            ftp::ftp_rename,
            ftp::ftp_remove,
            ftp::ftp_read,
            ftp::ftp_write,
            ftp::ftp_upload,
            ftp::ftp_download,
            ftp::ftp_xfer_cancel,
            db::db_connect,
            db::db_disconnect,
            db::db_query,
            db::db_tables,
            db::db_databases,
            db::db_use,
            db::db_script,
            db::db_script_cancel,
            persist::save_app_state,
            persist::load_app_state,
            commands::app_quit,
            netdiag::netdiag_ping_start,
            netdiag::netdiag_ping_stop,
            netdiag::netdiag_port,
            netdiag::netdiag_host,
            netdiag::netdiag_routes,
            netdiag::netdiag_socks,
            netdiag::netdiag_scan_start,
            netdiag::netdiag_scan_stop,
            netdiag::netdiag_lan_start,
            netdiag::netdiag_lan_stop,
            netdiag::netdiag_arp,
            netdiag::netdiag_dns,
            netdiag::netdiag_trace_start,
            netdiag::netdiag_trace_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running 飞梭");
}

fn hide_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
        let _ = win.set_skip_taskbar(true);
    }
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_skip_taskbar(false);
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn setup_tray(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "显示", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::new()
        .tooltip("飞梭 · 现代通讯调试助手")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    tray = tray.icon(APP_ICON);
    tray.build(app)?;
    Ok(())
}
