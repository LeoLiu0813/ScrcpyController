use crate::{devices, profile::Profile};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::{
    AppHandle, Emitter, Manager, WebviewWindow, WindowEvent,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
};
use windows_sys::Win32::{System::Threading::GetCurrentProcessId, UI::WindowsAndMessaging::AllowSetForegroundWindow};

const ID: &str = "controller-tray";

#[derive(Default)]
pub struct TrayState {
    quitting: AtomicBool,
    settings: Mutex<Settings>,
    settings_changed: Condvar,
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
    pub(crate) hardware: String,
    pub(crate) name: String,
    alias: Option<String>,
    profile: Profile,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
struct Row {
    serial: String,
    #[serde(skip_serializing)]
    hardware: String,
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
                if let Some((hardware, serial)) = id.strip_prefix("tray-device:")
                    .and_then(|target| target.split_once(':'))
                {
                    // Preserve foreground permission from the menu click while the target is verified.
                    unsafe { AllowSetForegroundWindow(GetCurrentProcessId()); }
                    let app = app.clone();
                    let serial = serial.to_owned();
                    let hardware = hardware.to_owned();
                    tauri::async_runtime::spawn(async move {
                        if let Err(code) = open_device(&app, serial, Some(hardware)).await {
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
                for device in devices.into_iter().filter(|device| device.status == "online") {
                    let Some(hardware) = device.hardware else { continue; };
                    let Some(configured) = settings.device(&device.serial, Some(&hardware)) else { continue; };
                    rows.push(Row {
                        name: configured.name.clone(),
                        serial: device.serial,
                        hardware,
                        running: device.session == "running",
                    });
                }
                rows = settings.device_rows(rows);
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
            format!("tray-device:{}:{}", row.hardware, row.serial),
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

impl Settings {
    fn device_rows(&self, mut rows: Vec<Row>) -> Vec<Row> {
        rows.sort_by_key(|row| self.devices.iter()
            .position(|device| device.serial == row.serial).unwrap_or(usize::MAX));
        let mut devices: Vec<Row> = Vec::new();
        for row in rows {
            if let Some(existing) = devices.iter_mut().find(|device| device.hardware == row.hardware) {
                // Keep one phone entry and target the transport with its active window.
                if row.running && !existing.running { *existing = row; }
            } else {
                devices.push(row);
            }
        }
        devices
    }

    fn is_removed(&self, serial: &str, hardware: &str) -> bool {
        self.removed.iter().any(|key| key == serial || key.strip_prefix("hardware:") == Some(hardware))
    }

    fn device(&self, serial: &str, hardware: Option<&str>) -> Option<&TrayDevice> {
        self.devices.iter().find(|entry| {
            entry.serial == serial && hardware.is_none_or(|expected| entry.hardware == expected)
                && !self.is_removed(serial, &entry.hardware)
        })
    }
}

fn configured_device(app: &AppHandle, serial: &str, hardware: Option<&str>) -> Option<TrayDevice> {
    app.state::<TrayState>().settings.lock().ok()?.device(serial, hardware).cloned()
}

pub(crate) fn is_removed(app: &AppHandle, serial: &str, hardware: &str) -> bool {
    app.state::<TrayState>().settings.lock().map_or(true, |settings| settings.is_removed(serial, hardware))
}

pub(crate) fn expected_hardware(app: &AppHandle, serial: &str) -> Option<String> {
    configured_device(app, serial, None).map(|entry| entry.hardware)
}

pub(crate) fn input_hardware(app: &AppHandle, serial: &str) -> Option<String> {
    configured_device(app, serial, None).filter(|entry| !entry.profile.read_only).map(|entry| entry.hardware)
}

pub(crate) fn configured_name(app: &AppHandle, serial: &str, hardware: Option<&str>) -> Option<String> {
    configured_device(app, serial, hardware).and_then(|entry| entry.alias)
}

pub(crate) async fn wait_for_device(app: &AppHandle, serial: &str, hardware: Option<String>) -> Result<TrayDevice, &'static str> {
    if quitting(app) { return Err("sessionError"); }
    if let Some(hardware) = hardware {
        let entry = configured_device(app, serial, None).ok_or("deviceUnavailable")?;
        return (entry.hardware == hardware).then_some(entry).ok_or("deviceIdentityMismatch");
    }
    let app = app.clone();
    let serial = serial.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<TrayState>();
        let settings = state.settings.lock().map_err(|_| "sessionError")?;
        // A cold command-line launch must wait for the main window to publish its saved settings.
        let (settings, _) = state.settings_changed.wait_timeout_while(settings, Duration::from_secs(6), |current| {
            !quitting(&app) && !current.removed.contains(&serial) && current.device(&serial, None).is_none()
        }).map_err(|_| "sessionError")?;
        settings.device(&serial, None).cloned().ok_or("deviceUnavailable")
    }).await.map_err(|_| "sessionError")?
}

pub async fn open_device(app: &AppHandle, serial: String, hardware: Option<String>) -> Result<Option<PathBuf>, &'static str> {
    let entry = wait_for_device(app, &serial, hardware).await?;
    devices::open_device(app.clone(), serial, entry.alias, Some(entry.profile), Some(entry.hardware)).await
}

#[tauri::command]
pub async fn launch_device(window: WebviewWindow, serial: String, hardware: String) -> Result<Option<PathBuf>, &'static str> {
    if window.label() != "main" { return Err("invalidArguments"); }
    open_device(window.app_handle(), serial, Some(hardware)).await
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
    app.state::<TrayState>().settings_changed.notify_all();
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
    state.settings_changed.notify_all();
    Ok(())
}

pub fn hide(app: &AppHandle) -> Result<(), &'static str> {
    main_window(app)?.hide().map_err(|_| "windowPending")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stale_menu_entry_cannot_select_reassigned_hardware() {
        let serial = "192.168.0.10:5555";
        let settings = Settings {
            devices: vec![TrayDevice {
                serial: serial.into(), hardware: "new-device".into(), name: "新手机".into(),
                alias: None, profile: Profile::default(),
            }],
            removed: vec!["hardware:old-device".into()],
            ..Settings::default()
        };
        assert!(settings.device(serial, Some("old-device")).is_none());
        assert!(settings.device(serial, Some("new-device")).is_some());
        assert!(settings.is_removed("another-connection", "old-device"));
    }

    #[test]
    fn duplicate_connections_keep_the_running_window_and_phone_order() {
        let entry = |serial: &str, hardware: &str| TrayDevice {
            serial: serial.into(), hardware: hardware.into(), name: hardware.into(),
            alias: None, profile: Profile::default(),
        };
        let settings = Settings {
            devices: vec![entry("wireless-a", "phone-a"), entry("wired-b", "phone-b"), entry("mdns-a", "phone-a")],
            ..Settings::default()
        };
        let rows = settings.devices.iter().rev().map(|device| Row {
            serial: device.serial.clone(), hardware: device.hardware.clone(), name: device.name.clone(),
            running: device.serial == "mdns-a",
        }).collect();
        let rows = settings.device_rows(rows);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].hardware, "phone-a");
        assert_eq!(rows[0].serial, "mdns-a");
        assert!(rows[0].running);
        assert_eq!(rows[1].hardware, "phone-b");
    }
}
