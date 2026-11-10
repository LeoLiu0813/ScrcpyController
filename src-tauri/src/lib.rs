mod connections;
mod engine_update;
mod devices;
mod douyin_server;
mod wechat_server;
mod profile;
mod mirror;
mod cli_protocol;
mod cli_server;
mod tray;
mod control_log;
mod mouse_trace;
mod input_state;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(devices::Sessions::default())
        .manage(tray::TrayState::default())
        .setup(|app| {
            if control_log::install(app.handle()).is_err() { eprintln!("控制日志启动失败，请检查本地数据目录。 "); }
            if let Err(error) = mouse_trace::install() { eprintln!("鼠标控制日志启动失败：{error}"); }
            if let Err(error) = tray::install(app.handle()) { eprintln!("系统托盘启动失败：{error}"); }
            if let Err(error) = cli_server::start(app.handle().clone()) {
                eprintln!("本地命令行接口启动失败：{error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            control_log::control_log_read,
            control_log::control_log_set_enabled,
            control_log::control_log_export,
            devices::list_devices,
            tray::tray_sync,
            engine_update::engine_status,
            engine_update::engine_options,
            engine_update::check_engine_update,
            engine_update::install_engine_update,
            engine_update::rollback_engine,
            connections::pair_wireless,
            connections::connect_wireless,
            connections::switch_to_wireless,
            connections::disconnect_wireless,
            tray::launch_device,
            devices::mirror_info,
            devices::lock_device,
            devices::mirror_stats,
            devices::mirror_position,
            devices::mirror_prepare_input,
            devices::mirror_save_placement,
            mirror::last_mirror_placement,
            devices::mirror_action,
            devices::mirror_log_ui,
            devices::stop_device,
            devices::run_tool,
            devices::choose_local_paths,
            devices::capture_crop_preview,
            devices::reveal_capture,
            devices::transfer_files,
            devices::query_device,
            devices::list_apps,
            devices::app_icon,
            devices::open_app_window,
            devices::preview_profile,
        ])
        .build(tauri::generate_context!())
        .expect("无法启动安卓控制台")
        .run(|_app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                mouse_trace::shutdown();
                control_log::record("app.exiting", None, serde_json::json!({}));
                control_log::flush();
            }
        });
}
