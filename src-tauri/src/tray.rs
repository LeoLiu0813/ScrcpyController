use crate::{devices, profile::Profile};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::{
    AppHandle, Emitter, Manager, WebviewWindow, WindowEvent,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
};

use windows_sys::Win32::{
    Foundation::HWND,
    UI::WindowsAndMessaging::{
        GetForegroundWindow, IsIconic, SW_RESTORE, SetForegroundWindow, ShowWindow,
    },
};

const ID: &str = "controller-tray";

#[derive(Default)]
pub struct TrayState {
    quitting: AtomicBool,
    settings: Mutex<Settings>,
    rows: Mutex<Vec<Row>>,
}

#[derive(Default, Clone)]
struct Settings {
    english: bool,
    exit_on_close: bool,
    devices: Vec<TrayDevice>,
    removed: Vec<String>,
}

#[derive(Clone, Deserialize)]
pub struct TrayDevice {
    serial: String,
    name: String,
    profile: Option<Profile>,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
struct Row {
    serial: String,
    name: String,
    running: bool,
}

pub fn quitting(app: &AppHandle) -> bool {
    app.state::<TrayState>().quitting.load(Ordering::Acquire)
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let mut builder = TrayIconBuilder::with_id(ID)
        .tooltip("安卓控制台")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => {
                let _ = show(app);
            }
            "tray-quit" => quit(app),
            id => {
                if let Some(serial) = id.strip_prefix("tray-device:") {
                    // Apply the activation while handling the user's native menu selection.
                    if !quitting(app) && focus_existing(app, serial) {
                        return;
                    }
                    let app = app.clone();
                    let serial = serial.to_owned();
                    tauri::async_runtime::spawn(async move {
                        if let Err(code) = open_device(&app, serial).await {
                            let _ = show(&app);
                            let _ = app.emit_to("main", "tray-device-error", code);
                        }
                    });
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                let _ = show(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder = builder.menu(&build_menu(app, false, &[])?);
    builder.build(app)?;

    if let Some(main) = app.get_webview_window("main") {
        let main_for_event = main.clone();
        main.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event
                && !quitting(main_for_event.app_handle())
            {
                api.prevent_close();
                let app = main_for_event.app_handle();
                if exit_on_close(app) {
                    quit(app);
                } else {
                    let _ = main_for_event.hide();
                }
            }
        });
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut previous = None;
        while !quitting(&handle) {
            let settings = handle
                .state::<TrayState>()
                .settings
                .lock()
                .map(|s| s.clone())
                .unwrap_or_default();
            let mut rows = Vec::new();
            if let Ok(devices) = devices::tray_devices(&handle) {
                for device in devices.into_iter().filter(|device| {
                    device.status == "online" && !settings.removed.contains(&device.serial)
                }) {
                    let configured = settings
                        .devices
                        .iter()
                        .find(|entry| entry.serial == device.serial);
                    rows.push(Row {
                        name: configured.map_or(device.model, |entry| entry.name.clone()),
                        serial: device.serial,
                        running: device.session == "running",
                    });
                }
                rows.sort_by_key(|row| {
                    settings
                        .devices
                        .iter()
                        .position(|device| device.serial == row.serial)
                        .unwrap_or(usize::MAX)
                });
            }
            if previous.as_ref() != Some(&(settings.english, rows.clone()))
                && let Some(tray) = handle.tray_by_id(ID)
                && let Ok(menu) = build_menu(&handle, settings.english, &rows)
                && tray.set_menu(Some(menu)).is_ok()
            {
                let _ = tray.set_tooltip(Some(if settings.english {
                    "Android Controller"
                } else {
                    "安卓控制台"
                }));
                if let Ok(mut live) = handle.state::<TrayState>().rows.lock() {
                    *live = rows.clone();
                }
                previous = Some((settings.english, rows));
            }
            std::thread::sleep(Duration::from_millis(1500));
        }
    });
    Ok(())
}

fn build_menu(app: &AppHandle, english: bool, rows: &[Row]) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    let show = MenuItem::with_id(
        app,
        "tray-show",
        if english {
            "Open controller"
        } else {
            "打开主窗口"
        },
        true,
        None::<&str>,
    )?;
    menu.append(&show)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    if rows.is_empty() {
        menu.append(&MenuItem::with_id(
            app,
            "tray-empty",
            if english {
                "No connected phones"
            } else {
                "没有已连接的手机"
            },
            false,
            None::<&str>,
        )?)?;
    }
    for row in rows {
        let status = match (english, row.running) {
            (true, true) => "Mirroring",
            (true, false) => "Connected",
            (false, true) => "投屏中",
            (false, false) => "已连接",
        };
        let name = row.name.replace('&', "&&");
        let item = MenuItem::with_id(
            app,
            format!("tray-device:{}", row.serial),
            format!("{name} · {status}"),
            true,
            None::<&str>,
        )?;
        menu.append(&item)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "tray-quit",
        if english { "Exit" } else { "退出" },
        true,
        None::<&str>,
    )?)?;
    Ok(menu)
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, &'static str> {
    app.get_webview_window("main").ok_or("windowPending")
}

pub fn show(app: &AppHandle) -> Result<(), &'static str> {
    let main = main_window(app)?;
    main.show().map_err(|_| "windowPending")?;
    main.unminimize().map_err(|_| "focusDenied")?;
    main.set_focus().map_err(|_| "focusDenied")
}

fn focus_existing(app: &AppHandle, serial: &str) -> bool {
    let Ok(window) = devices::cli_mirror_window(app, serial) else {
        return false;
    };
    let Ok(window) = window.hwnd() else {
        return false;
    };
    let window = window.0 as HWND;
    unsafe {
        if IsIconic(window) != 0 {
            ShowWindow(window, SW_RESTORE);
        }
        GetForegroundWindow() == window || SetForegroundWindow(window) != 0
    }
}

pub(crate) fn configured_name(app: &AppHandle, serial: &str) -> Option<String> {
    let state = app.state::<TrayState>();
    let settings = state.settings.lock().ok()?;
    settings.devices.iter().find(|entry| entry.serial == serial).map(|entry| entry.name.clone())
}

pub async fn open_device(app: &AppHandle, serial: String) -> Result<(), &'static str> {
    if quitting(app) {
        return Err("sessionError");
    }
    let settings = app.state::<TrayState>();
    let entry = {
        let settings = settings.settings.lock().map_err(|_| "sessionError")?;
        if settings.removed.contains(&serial) {
            return Err("deviceUnavailable");
        }
        settings
            .devices
            .iter()
            .find(|entry| entry.serial == serial)
            .cloned()
    };
    if focus_existing(app, &serial) {
        return Ok(());
    }
    let running = devices::cli_mirror_window(app, &serial).is_ok();
    let (alias, profile) = entry.map_or((None, None), |entry| (Some(entry.name), entry.profile));
    devices::open_device(app.clone(), serial.clone(), alias, profile).await?;
    if running && !focus_existing(app, &serial) {
        return Err("focusDenied");
    }
    Ok(())
}

pub fn quit(app: &AppHandle) {
    if app
        .state::<TrayState>()
        .quitting
        .swap(true, Ordering::AcqRel)
    {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        devices::shutdown_windows(&app);
        app.exit(0);
    });
}

pub fn status(app: &AppHandle) -> Result<serde_json::Value, &'static str> {
    let visible = main_window(app)?
        .is_visible()
        .map_err(|_| "windowPending")?;
    let state = app.state::<TrayState>();
    let rows = state.rows.lock().map_err(|_| "sessionError")?;
    Ok(
        serde_json::json!({ "installed": app.tray_by_id(ID).is_some(), "mainVisible": visible,
            "exitOnClose": exit_on_close(app), "devices": *rows }),
    )
}

fn exit_on_close(app: &AppHandle) -> bool {
    app.state::<TrayState>().settings.lock().is_ok_and(|settings| settings.exit_on_close)
}

#[tauri::command]
pub fn tray_sync(
    window: WebviewWindow,
    english: bool,
    exit_on_close: Option<bool>,
    devices: Vec<TrayDevice>,
    removed: Vec<String>,
) -> Result<(), &'static str> {
    if window.label() != "main" {
        return Err("invalidArguments");
    }
    let state = window.state::<TrayState>();
    *state.settings.lock().map_err(|_| "sessionError")? = Settings {
        english,
        exit_on_close: exit_on_close.unwrap_or(false),
        devices,
        removed,
    };
    Ok(())
}

pub fn hide(app: &AppHandle) -> Result<(), &'static str> {
    main_window(app)?.hide().map_err(|_| "windowPending")
}
