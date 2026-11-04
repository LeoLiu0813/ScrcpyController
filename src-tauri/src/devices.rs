use crate::profile::{self, Profile};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    os::windows::process::CommandExt,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM},
    System::Threading::CREATE_NO_WINDOW,
    UI::WindowsAndMessaging::{
        EnumWindows, GetForegroundWindow, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
        PostMessageW, SW_RESTORE, SetForegroundWindow, ShowWindowAsync, WM_CLOSE,
    },
};

type Result<T> = std::result::Result<T, &'static str>;

type SessionKey = (String, Option<String>);

#[derive(Default)]
pub struct Sessions(Mutex<HashMap<SessionKey, Session>>);

struct Session {
    child: Child,
    port_start: u16,
    stopping: bool,
    task: Option<String>,
    display: Option<AppDisplay>,
    mirror: Option<crate::mirror::Mirror>,
    recording: bool,
}

impl Drop for Sessions {
    fn drop(&mut self) {
        if let Ok(sessions) = self.0.get_mut() {
            for session in sessions.values_mut() {
                if matches!(session.task.as_deref(), Some("backgroundRecord" | "audioRecord"))
                    || !matches!(session.child.try_wait(), Ok(None))
                {
                    continue;
                }
                if let Some(window) = session.mirror.as_ref().map(crate::mirror::Mirror::window).or_else(|| session_window(session.child.id())) {
                    unsafe { PostMessageW(window, WM_CLOSE, 0, 0) };
                } else {
                    let _ = session.child.kill();
                    let _ = session.child.wait();
                }
            }
        }
    }
}

#[derive(Serialize)]
pub struct Device {
    pub(crate) serial: String,
    pub(crate) model: String,
    pub(crate) connection: &'static str,
    pub(crate) status: &'static str,
    pub(crate) session: &'static str,
    task: Option<String>,
}

pub(crate) fn engine(app: &AppHandle) -> Result<PathBuf> {
    let path = match std::env::var_os("SCRCPY_CONTROLLER_ENGINE_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => crate::engine_update::managed_engine(
            &app.path().app_local_data_dir().map_err(|_| "engineMissing")?,
        ),
    };
    if !path.is_absolute()
        || !path.join("scrcpy.exe").is_file()
        || !path.join("scrcpy-server").is_file()
    {
        return Err("engineMissing");
    }
    Ok(path)
}

pub(crate) fn adb_path(engine: &std::path::Path) -> PathBuf {
    std::env::var_os("ADB").map_or_else(|| engine.join("adb.exe"), PathBuf::from)
}

pub(crate) fn read_devices(engine: &std::path::Path) -> Result<Vec<Device>> {
    let mut child = Command::new(adb_path(engine))
        .args(["devices", "-l"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "adbUnavailable")?;
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("adbUnavailable");
            }
        }
    }
    let output = child.wait_with_output().map_err(|_| "adbUnavailable")?;
    if !output.status.success() {
        return Err("adbUnavailable");
    }
    let output = String::from_utf8_lossy(&output.stdout);
    let (_, rows) = output
        .split_once("List of devices attached")
        .ok_or("adbUnavailable")?;
    Ok(rows
        .lines()
        .filter_map(|line| {
            let (serial, details) = line.split_once('\t').or_else(|| line.split_once(' '))?;
            let mut fields = details.split_whitespace();
            let status = match fields.next()? {
                "device" => "online",
                "unauthorized" => "unauthorized",
                "offline" => "offline",
                "no" => "unavailable",
                _ => return None,
            };
            let model = fields
                .find_map(|field| field.strip_prefix("model:"))
                .unwrap_or(serial)
                .replace('_', " ");
            Some(Device {
                serial: serial.to_owned(),
                model,
                connection: if serial.contains(':') || serial.ends_with("._adb-tls-connect._tcp") {
                    "wireless"
                } else {
                    "wired"
                },
                status,
                session: "idle",
                task: None,
            })
        })
        .collect())
}

fn session_window(pid: u32) -> Option<HWND> {
    struct Search {
        pid: u32,
        window: HWND,
    }
    unsafe extern "system" fn visit(window: HWND, data: LPARAM) -> i32 {
        let search = unsafe { &mut *(data as *mut Search) };
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(window, &mut pid) };
        if pid == search.pid && unsafe { IsWindowVisible(window) } != 0 {
            search.window = window;
            return 0;
        }
        1
    }
    let mut search = Search {
        pid,
        window: std::ptr::null_mut(),
    };
    unsafe { EnumWindows(Some(visit), (&mut search as *mut Search) as LPARAM) };
    (!search.window.is_null()).then_some(search.window)
}

fn reap(sessions: &mut HashMap<SessionKey, Session>) {
    sessions.retain(|key, session| !matches!(session.child.try_wait(), Ok(Some(status)) if key.1.is_some() || status.success() || session.stopping));
}

fn session_ports(sessions: &HashMap<SessionKey, Session>, command: &mut Command) -> Result<u16> {
    // ADB forwarding listeners share the host port namespace across devices.
    let start = (27200..28224).step_by(4)
        .find(|port| sessions.values().all(|session| session.port_start != *port))
        .ok_or("sessionError")?;
    command.arg(format!("--port={start}:{}", start + 3));
    Ok(start)
}

pub(crate) fn with_idle_sessions(app: &AppHandle, action: impl FnOnce() -> Result<()>) -> Result<bool> {
    let state = app.state::<Sessions>();
    let mut sessions = state.0.lock().map_err(|_| "sessionError")?;
    for session in sessions.values_mut() {
        if session.child.try_wait().map_err(|_| "sessionError")?.is_none() {
            return Ok(false);
        }
    }
    action()?;
    Ok(true)
}

#[tauri::command]
pub async fn list_devices(app: AppHandle) -> Result<Vec<Device>> {
    tauri::async_runtime::spawn_blocking(move || {
        let _ = crate::engine_update::apply_pending(&app);
        let path = engine(&app)?;
        crate::connections::prepare_wireless(&path);
        devices_with_sessions(&app, &path)
    })
    .await
    .map_err(|_| "sessionError")?
}

pub(crate) fn tray_devices(app: &AppHandle) -> Result<Vec<Device>> {
    devices_with_sessions(app, &engine(app)?)
}

fn devices_with_sessions(app: &AppHandle, path: &std::path::Path) -> Result<Vec<Device>> {
        let mut devices = read_devices(path)?;
        let state = app.state::<Sessions>();
        let mut sessions = state.0.lock().map_err(|_| "sessionError")?;
        reap(&mut sessions);
        for device in &mut devices {
            if let Some(session) = sessions.get_mut(&(device.serial.clone(), None)) {
                device.task = session.task.clone();
                device.session = if matches!(session.child.try_wait(), Ok(Some(_))) {
                    "failed"
                } else if session.stopping {
                    "stopping"
                } else if session.task.is_some() || session.mirror.is_some() || session_window(session.child.id()).is_some() {
                    "running"
                } else {
                    "starting"
                };
            }
        }
        Ok(devices)
}

pub(crate) fn shutdown_windows(app: &AppHandle) {
    let state = app.state::<Sessions>();
    let Ok(mut sessions) = state.0.lock() else { return; };
    let keys = sessions.iter().filter(|(_, session)| !matches!(session.task.as_deref(), Some("backgroundRecord" | "audioRecord")))
        .map(|(key, _)| key.clone()).collect::<Vec<_>>();
    let mut closing = keys.into_iter().filter_map(|key| sessions.remove(&key)).collect::<Vec<_>>();
    drop(sessions);
    for session in &mut closing {
        if let Some(window) = session.mirror.as_ref().map(crate::mirror::Mirror::window)
            .or_else(|| session_window(session.child.id()))
        {
            unsafe { PostMessageW(window, WM_CLOSE, 0, 0) };
        } else {
            let _ = session.child.kill();
        }
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        closing.retain_mut(|session| !matches!(session.child.try_wait(), Ok(Some(_))));
        if closing.is_empty() { return; }
        thread::sleep(Duration::from_millis(40));
    }
    for mut session in closing {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
}

#[tauri::command]
pub async fn open_device(
    app: AppHandle,
    serial: String,
    alias: Option<String>,
    profile: Option<Profile>,
) -> Result<Option<PathBuf>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Sessions>();
        let key = (serial.clone(), None);
        let (pid, title, capture, options) = {
            let mut sessions = state.0.lock().map_err(|_| "sessionError")?;
            if crate::tray::quitting(&app) { return Err("sessionError"); }
            reap(&mut sessions);
            if let Some(session) = sessions
                .get_mut(&key)
                .and_then(|session| matches!(session.child.try_wait(), Ok(None)).then_some(session))
            {
                if session.stopping {
                    return Err("windowPending");
                }
                if session.task.is_some() {
                    return Err("taskBusy");
                }
                let target = focus_target(session)?;
                drop(sessions);
                return focus_window(&app, target).map(|()| None);
            }
            let path = engine(&app)?;
            let device = read_devices(&path)?
                .into_iter()
                .find(|device| device.serial == serial && device.status == "online")
                .ok_or("deviceUnavailable")?;
            let title = profile::name(alias, device.model)?;
            let mut command = official(&path, &serial);
            command.args(["--window-title", &title]);
            let mut profile = profile.unwrap_or_default();
            if profile.has_crop() {
                let mut size = Command::new(adb_path(&path));
                size.args(["-s", &serial, "shell", "wm", "size"]).creation_flags(CREATE_NO_WINDOW);
                let size = capture_query(size)?;
                let (width, height) = size.text.lines().find_map(|line| {
                    let (width, height) = line.strip_prefix("Physical size: ")?.trim().split_once('x')?;
                    Some((width.parse().ok()?, height.parse().ok()?))
                }).ok_or("invalidCrop")?;
                profile.validate_crop(width, height)?;
            }
            let embed = !profile.is_camera();
            let options = embed.then(|| {
                let mut options = crate::mirror::MirrorOptions::prepare(
                    &mut command, profile.fullscreen, profile.top, !profile.read_only, !profile.display.is_empty(), false,
                );
                options.startup = profile.startup;
                profile.fullscreen = false;
                profile.top = false;
                options
            });
            let capture = profile.apply(&mut command, &app, false)?;
            let port_start = session_ports(&sessions, &mut command)?;
            let mut child = command.spawn().map_err(|_| "launchFailed")?;
            if let Some(options) = &options {
                options.watch_stats(&mut child);
            }
            let pid = child.id();
            sessions.insert(key.clone(), Session {
                child, port_start, stopping: false, task: None, display: None, mirror: None, recording: capture.is_some(),
            });
            let Some(options) = options else { return Ok(capture); };
            (pid, title, capture, options)
        };
        finish_mirror(&app, &key, pid, &title, options)?;
        Ok(capture)
    })
    .await
    .map_err(|_| "sessionError")?
}

fn finish_mirror(app: &AppHandle, key: &SessionKey, pid: u32, title: &str, options: crate::mirror::MirrorOptions) -> Result<()> {
        let state = app.state::<Sessions>();
        let deadline = Instant::now() + Duration::from_secs(10);
        let opened = loop {
            let mut sessions = state.0.lock().map_err(|_| "sessionError")?;
            let session = sessions.get_mut(key).filter(|session| session.child.id() == pid)
                .ok_or("launchFailed")?;
            if session.child.try_wait().map_err(|_| "launchFailed")?.is_some() {
                sessions.remove(key);
                return Err("launchFailed");
            }
            if let Some(video) = session_window(pid) {
                let mirror = match crate::mirror::Mirror::new(video, options.clone(), serde_json::to_string(key).map_err(|_| "sessionError")?) {
                    Ok(mirror) => mirror,
                    Err(error) => break Err(error),
                };
                session.mirror = Some(mirror.clone());
                drop(sessions);
                break crate::mirror::create(app, &mirror, title);
            }
            if session.stopping || Instant::now() >= deadline {
                break Err("launchFailed");
            }
            drop(sessions);
            thread::sleep(Duration::from_millis(40));
        };
        if let Err(error) = opened {
            let mut sessions = state.0.lock().map_err(|_| "sessionError")?;
            if sessions.get(key).is_some_and(|session| session.child.id() == pid)
                && let Some(mut session) = sessions.remove(key)
            {
                let _ = session.child.kill();
                let _ = session.child.wait();
            }
            return Err(error);
        }
        Ok(())
}

fn mirror_session(window: &tauri::WebviewWindow) -> Result<(String, crate::mirror::Mirror)> {
    let state = window.state::<Sessions>();
    let sessions = state.0.lock().map_err(|_| "sessionError")?;
    sessions.iter().find_map(|((serial, _), session)| {
        let mirror = session.mirror.as_ref()?;
        (mirror.label == window.label() && !session.stopping)
            .then(|| (serial.clone(), mirror.clone()))
    }).ok_or("windowPending")
}

#[tauri::command]
pub fn mirror_info(window: tauri::WebviewWindow) -> Result<(String, i32, i32, String, bool, bool, bool)> {
    let (serial, mirror) = mirror_session(&window)?;
    let (width, height) = mirror.original_size;
    let state = window.state::<Sessions>();
    let sessions = state.0.lock().map_err(|_| "sessionError")?;
    let recording = !mirror.options.virtual_screen && sessions.get(&(serial.clone(), None))
        .is_some_and(|session| session.recording);
    Ok((window.title().map_err(|_| "mirrorFrameFailed")?, width, height, serial,
        mirror.options.virtual_screen, mirror.options.follow, recording))
}

#[tauri::command]
pub async fn lock_device(app: AppHandle, serial: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        require_online(&app, &serial)?;
        mirror_phone_command(&app, &serial, &["input", "-d", "0", "keyevent", "KEYCODE_SLEEP"])?;
        Ok(())
    }).await.map_err(|_| "mirrorActionFailed")?
}

#[tauri::command]
pub fn mirror_stats(window: tauri::WebviewWindow) -> Result<(Option<u32>, Option<[u16; 2]>)> {
    let (_, mirror) = mirror_session(&window)?;
    Ok(mirror.options.stats())
}

#[tauri::command]
pub async fn mirror_prepare_input(window: tauri::WebviewWindow) -> Result<bool> {
    let (_, mirror) = mirror_session(&window)?;
    crate::mirror::prepare_input(window, mirror.video).await
}

#[tauri::command]
pub fn mirror_save_placement(window: tauri::WebviewWindow) -> Result<()> {
    let (_, mirror) = mirror_session(&window)?;
    crate::mirror::save_placement(&window, &mirror)
}

#[tauri::command]
pub fn mirror_position(window: tauri::WebviewWindow, bounds: crate::mirror::VideoBounds) -> Result<()> {
    let (_, mirror) = mirror_session(&window)?;
    crate::mirror::position(&window, &mirror, bounds)
}

#[tauri::command]
pub async fn mirror_action(window: tauri::WebviewWindow, action: String) -> Result<Option<PathBuf>> {
    let (serial, mirror) = mirror_session(&window)?;
    let video = mirror.video;
    if !mirror.options.control_enabled && matches!(action.as_str(),
        "back" | "home" | "recents" | "volumeUp" | "volumeDown" | "screenPower" |
        "notifications" | "quickSettings" | "screenOff" | "screenOn" | "paste") {
        return Err("mirrorActionFailed");
    }
    let app = window.app_handle().clone();
    let owner = window.hwnd().map_err(|_| "mirrorFrameFailed")?.0 as usize;
    let virtual_screen = mirror.options.virtual_screen;
    if action == "sendFiles" && !virtual_screen {
        use tauri::Emitter;
        crate::tray::show(&app)?;
        app.emit_to("main", "open-file-tools", serial).map_err(|_| "mirrorActionFailed")?;
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let key = match action.as_str() {
            "back" => Some("KEYCODE_BACK"),
            "home" => Some("KEYCODE_HOME"),
            "recents" => Some("KEYCODE_APP_SWITCH"),
            "volumeUp" => Some("KEYCODE_VOLUME_UP"),
            "volumeDown" => Some("KEYCODE_VOLUME_DOWN"),
            "screenPower" => Some("KEYCODE_POWER"),
            _ => None,
        };
        if !virtual_screen && let Some(key) = key {
            return mirror_phone_command(&app, &serial, &["input", "-d", "0", "keyevent", key]);
        }
        if !virtual_screen && matches!(action.as_str(), "notifications" | "quickSettings") {
            let operation = if action == "notifications" { "expand-notifications" } else { "expand-settings" };
            return mirror_phone_command(&app, &serial, &["cmd", "statusbar", operation]);
        }
        let video = video as HWND;
        let shortcut = match action.as_str() {
            "back" => (0x42, 0x30, false, false),
            "home" => (0x48, 0x23, false, false),
            "recents" => (0x53, 0x1f, false, false),
            "volumeUp" => (0x26, 0x48, false, true),
            "volumeDown" => (0x28, 0x50, false, true),
            "screenOff" => (0x4f, 0x18, false, false),
            "screenOn" => (0x4f, 0x18, true, false),
            "rotate" => (0x27, 0x4d, false, true),
            "paste" => (0x56, 0x2f, false, false),
            "pause" => (0x5a, 0x2c, false, false),
            "resume" => (0x5a, 0x2c, true, false),
            "resetVideo" => (0x52, 0x13, true, false),
            "screenshot" | "copyScreenshot" if virtual_screen => return Err("captureUnavailable"),
            "screenshot" | "copyScreenshot" | "captureFolder" => {
                return mirror_capture(&app, &serial, &action, owner as HWND);
            }
            _ => return Err("mirrorActionFailed"),
        };
        crate::mirror::shortcut(video, shortcut.0, shortcut.1, shortcut.2, shortcut.3)?;
        Ok(None)
    }).await.map_err(|_| "mirrorActionFailed")?
}

fn mirror_phone_command(app: &AppHandle, serial: &str, args: &[&str]) -> Result<Option<PathBuf>> {
    let mut command = Command::new(adb_path(&engine(app)?));
    command.args(["-s", serial, "shell"]).args(args).creation_flags(CREATE_NO_WINDOW);
    if !capture_command(command, None)?.success {
        return Err("mirrorActionFailed");
    }
    Ok(None)
}

pub(crate) fn cli_mirror_window(app: &AppHandle, serial: &str) -> Result<tauri::WebviewWindow> {
    cli_session_window(app, (serial.to_owned(), None))
}

pub(crate) fn cli_virtual_window(app: &AppHandle, serial: &str, package: &str) -> Result<tauri::WebviewWindow> {
    cli_session_window(app, (serial.to_owned(), Some(package.to_owned())))
}

fn cli_session_window(app: &AppHandle, key: SessionKey) -> Result<tauri::WebviewWindow> {
    let state = app.state::<Sessions>();
    let sessions = state.0.lock().map_err(|_| "sessionError")?;
    let label = sessions.get(&key)
        .filter(|session| !session.stopping)
        .and_then(|session| session.mirror.as_ref())
        .ok_or("sessionNotFound")?.label.clone();
    drop(sessions);
    app.get_webview_window(&label).ok_or("windowPending")
}

pub(crate) fn cli_click_video(window: &tauri::WebviewWindow, x: i32, y: i32) -> Result<()> {
    let (_, mirror) = mirror_session(window)?;
    crate::mirror::click_video(window, &mirror, x, y)
}

pub(crate) fn cli_video_geometry(window: &tauri::WebviewWindow) -> Result<serde_json::Value> {
    let (_, mirror) = mirror_session(window)?;
    let mut geometry = crate::mirror::geometry(window, mirror.window())?;
    geometry["startupPosition"] = serde_json::json!(mirror.startup_position);
    Ok(geometry)
}

fn mirror_capture(app: &AppHandle, serial: &str, action: &str, owner: HWND) -> Result<Option<PathBuf>> {
    let file = profile::recording(app)?.with_extension("png");
    let folder = file.parent().ok_or("captureUnavailable")?;
    if action == "captureFolder" {
        Command::new("explorer.exe").arg(folder).spawn().map_err(|_| "captureUnavailable")?;
        return Ok(None);
    }
    let bytes = phone_screenshot(app, serial)?;
    if action == "copyScreenshot" {
        return crate::mirror::copy_png(owner, &bytes).map(|()| None);
    }
    std::fs::write(&file, &bytes).map_err(|_| "captureUnavailable")?;
    Ok(Some(file))
}

#[tauri::command]
pub async fn capture_crop_preview(app: AppHandle, serial: String) -> Result<tauri::ipc::Response> {
    tauri::async_runtime::spawn_blocking(move || {
        require_online(&app, &serial)?;
        phone_screenshot(&app, &serial).map(tauri::ipc::Response::new)
    }).await.map_err(|_| "captureUnavailable")?
}

#[tauri::command]
pub fn reveal_capture(path: PathBuf) -> Result<()> {
    if !path.is_absolute() || !path.is_file() { return Err("captureUnavailable"); }
    Command::new("explorer.exe").arg("/select,").arg(path)
        .spawn().map_err(|_| "captureUnavailable")?;
    Ok(())
}

fn phone_screenshot(app: &AppHandle, serial: &str) -> Result<Vec<u8>> {
    let path = engine(app)?;
    let output = Command::new(adb_path(&path))
        .args(["-s", serial, "exec-out", "screencap", "-p"])
        .creation_flags(CREATE_NO_WINDOW)
        .output().map_err(|_| "captureUnavailable")?;
    if !output.status.success() || png_size(&output.stdout).is_none() {
        return Err("captureUnavailable");
    }
    Ok(output.stdout)
}

fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || bytes.get(12..16)? != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(bytes.get(16..20)?.try_into().ok()?);
    let height = u32::from_be_bytes(bytes.get(20..24)?.try_into().ok()?);
    (width > 0 && height > 0).then_some((width, height))
}

fn require_online(app: &AppHandle, serial: &str) -> Result<()> {
    read_devices(&engine(app)?)?.iter()
        .any(|device| device.serial == serial && device.status == "online")
        .then_some(()).ok_or("deviceUnavailable")
}

fn focus_target(session: &Session) -> Result<(u32, Option<String>)> {
    if session.stopping {
        return Err("windowPending");
    }
    if session.task.is_some() {
        return Err("taskBusy");
    }
    Ok((session.child.id(), session.mirror.as_ref().map(|mirror| mirror.label.clone())))
}

fn focus_window(app: &AppHandle, (pid, label): (u32, Option<String>)) -> Result<()> {
    if let Some(label) = label {
        let window = app.get_webview_window(&label).ok_or("windowPending")?;
        window.unminimize().map_err(|_| "focusDenied")?;
        return window.set_focus().map_err(|_| "focusDenied");
    }
    let window = session_window(pid).ok_or("windowPending")?;
    unsafe {
        if IsIconic(window) != 0 {
            ShowWindowAsync(window, SW_RESTORE);
        }
        if SetForegroundWindow(window) == 0 && GetForegroundWindow() != window {
            return Err("focusDenied");
        }
    }
    Ok(())
}

pub async fn cli_focus(app: AppHandle, serial: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Sessions>();
        let mut sessions = state.0.lock().map_err(|_| "sessionError")?;
        let session = sessions.get_mut(&(serial, None)).ok_or("sessionNotFound")?;
        if !matches!(session.child.try_wait(), Ok(None)) || session.stopping {
            return Err("sessionNotFound");
        }
        let target = focus_target(session)?;
        drop(sessions);
        focus_window(&app, target)
    }).await.map_err(|_| "sessionError")?
}

pub async fn cli_close(app: AppHandle, serial: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        stop_device(app.clone(), serial.clone())?;
        let deadline = Instant::now() + Duration::from_secs(5);
        let state = app.state::<Sessions>();
        let key = (serial, None);
        loop {
            {
                let mut sessions = state.0.lock().map_err(|_| "sessionError")?;
                reap(&mut sessions);
                if !sessions.contains_key(&key) { return Ok(()); }
            }
            if Instant::now() >= deadline { return Err("windowPending"); }
            thread::sleep(Duration::from_millis(35));
        }
    }).await.map_err(|_| "sessionError")?
}

pub async fn cli_screenshot(app: AppHandle, serial: String) -> Result<(PathBuf, u32, u32)> {
    tauri::async_runtime::spawn_blocking(move || {
        require_online(&app, &serial)?;
        let bytes = phone_screenshot(&app, &serial)?;
        let (width, height) = png_size(&bytes).ok_or("captureUnavailable")?;
        let file = profile::recording(&app)?.with_extension("png");
        std::fs::write(&file, bytes).map_err(|_| "captureUnavailable")?;
        Ok((file, width, height))
    }).await.map_err(|_| "captureUnavailable")?
}

pub async fn cli_tap(app: AppHandle, serial: String, x: u32, y: u32, width: u32, height: u32) -> Result<()> {
    if x >= width || y >= height {
        return Err("invalidCoordinates");
    }
    tauri::async_runtime::spawn_blocking(move || {
        require_online(&app, &serial)?;
        let bytes = phone_screenshot(&app, &serial)?;
        if png_size(&bytes) != Some((width, height)) {
            return Err("screenSizeChanged");
        }
        let path = engine(&app)?;
        let mut command = Command::new(adb_path(&path));
        command.args(["-s", &serial, "shell", "input", "-d", "0", "tap", &x.to_string(), &y.to_string()])
            .creation_flags(CREATE_NO_WINDOW);
        if !capture_command(command, None)?.success {
            return Err("mirrorActionFailed");
        }
        Ok(())
    }).await.map_err(|_| "sessionError")?
}

#[tauri::command]
pub fn stop_device(app: AppHandle, serial: String) -> Result<()> {
    let state = app.state::<Sessions>();
    let mut sessions = state.0.lock().map_err(|_| "sessionError")?;
    reap(&mut sessions);
    if let Some(session) = sessions.get_mut(&(serial.clone(), None)) {
        if matches!(session.task.as_deref(), Some("backgroundRecord" | "audioRecord")) {
            return Err("taskBusy");
        }
        if let Some(window) = session.mirror.as_ref().map(crate::mirror::Mirror::window).or_else(|| session_window(session.child.id())) {
            if unsafe { PostMessageW(window, WM_CLOSE, 0, 0) } == 0 {
                return Err("stopFailed");
            }
        } else if session.task.is_some() {
            session.child.kill().map_err(|_| "stopFailed")?;
        } else {
            return Err("windowPending");
        }
        session.stopping = true;
    }
    Ok(())
}

fn official(path: &std::path::Path, serial: &str) -> Command {
    let mut command = Command::new(path.join("scrcpy.exe"));
    command
        .current_dir(path)
        .env("ADB", adb_path(path))
        .arg("--serial")
        .arg(serial)
        .arg("--pause-on-exit=false")
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

#[tauri::command]
pub fn preview_profile(
    app: AppHandle,
    serial: String,
    title: String,
    profile: Profile,
) -> Result<Vec<String>> {
    let path = engine(&app)?;
    let mut command = official(&path, &serial);
    command
        .arg("--window-title")
        .arg(profile::name(Some(title), String::new())?);
    profile.apply(&mut command, &app, true)?;
    Ok(std::iter::once(command.get_program())
        .chain(command.get_args())
        .map(|part| part.to_string_lossy().into_owned())
        .collect())
}

#[tauri::command]
pub async fn run_tool(
    app: AppHandle,
    serial: String,
    task: String,
    seconds: u32,
    folder: Option<String>,
    format: Option<String>,
    audio_source: Option<String>,
    profile: Option<Profile>,
) -> Result<Option<PathBuf>> {
    if task == "cameraMirror" {
        let alias = crate::tray::configured_name(&app, &serial);
        return open_device(app, serial, alias, Some(profile.unwrap_or_default().for_camera())).await;
    }
    tauri::async_runtime::spawn_blocking(move || {
        if !(3..=300).contains(&seconds) {
            return Err("invalidDuration");
        }
        let state = app.state::<Sessions>();
        let mut sessions = state.0.lock().map_err(|_| "sessionError")?;
            if crate::tray::quitting(&app) { return Err("sessionError"); }
        let path = engine(&app)?;
        if task == "directControl" {
            if serial.is_empty()
                || serial.len() > 128
                || serial.contains(':')
                || serial.ends_with("._adb-tls-connect._tcp")
                || serial.chars().any(char::is_control)
            {
                return Err("wiredRequired");
            }
        } else if !read_devices(&path)?
            .into_iter()
            .any(|device| device.serial == serial && device.status == "online")
        {
            return Err("deviceUnavailable");
        }
        let mut command = official(&path, &serial);
        let mut capture = None;
        match task.as_str() {
            "backgroundRecord" => {
                let format = format.as_deref().unwrap_or("mkv");
                if !matches!(format, "mkv" | "mp4") { return Err("invalidProfile"); }
                let file = profile::recording_path(&app, folder.as_deref().unwrap_or(""), "screen", format, false)?;
                command
                    .args(["--no-window", "--no-playback", "--no-control", "--record"])
                    .arg(&file);
                capture = Some(file);
            }
            "audioRecord" => {
                let format = format.as_deref().unwrap_or("opus");
                let codec = match format { "opus" => "opus", "flac" => "flac", "wav" => "raw", _ => return Err("invalidProfile") };
                let source = audio_source.as_deref().unwrap_or("output");
                if !matches!(source, "output" | "mic") { return Err("invalidProfile"); }
                let file = profile::recording_path(&app, folder.as_deref().unwrap_or(""), "audio", format, false)?;
                command.args(["--no-video", "--no-window", "--no-control", "--no-audio-playback",
                    "--require-audio", "--audio-codec", codec, "--audio-source", source, "--record"]).arg(&file);
                capture = Some(file);
            }
            "audioOnly" => {
                command.args([
                    "--no-video",
                    "--no-window",
                    "--no-control",
                    "--require-audio",
                ]);
            }
            "controlOnly" => {
                command.args([
                    "--no-video",
                    "--no-audio",
                    "--keyboard=uhid",
                    "--mouse=uhid",
                ]);
            }
            "directControl" => {
                command.arg("--otg");
            }
            _ => return Err("sessionError"),
        }
        if task != "directControl" {
            command.arg("--time-limit").arg(seconds.to_string());
        }
        reap(&mut sessions);
        if let Some(session) = sessions.get_mut(&(serial.clone(), None)) {
            if session
                .child
                .try_wait()
                .map_err(|_| "sessionError")?
                .is_none()
            {
                return Err("taskBusy");
            }
        }
        let port_start = session_ports(&sessions, &mut command)?;
        let child = command.spawn().map_err(|_| "launchFailed")?;
        sessions.insert(
            (serial, None),
            Session {
                child,
                port_start,
                stopping: false,
                task: Some(task),
                display: None,
                mirror: None,
                recording: capture.is_some(),
            },
        );
        Ok(capture)
    })
    .await
    .map_err(|_| "sessionError")?
}

#[tauri::command]
pub async fn choose_local_paths(window: tauri::WebviewWindow, folder: bool) -> Result<Vec<PathBuf>> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = window.dialog().file().set_parent(&window);
        let paths = if folder {
            dialog.blocking_pick_folder().into_iter().collect()
        } else {
            dialog.blocking_pick_files().unwrap_or_default()
        };
        paths.into_iter().map(|path| path.into_path().map_err(|_| "invalidLocalPath")).collect()
    }).await.map_err(|_| "invalidLocalPath")?
}

#[derive(Serialize)]
pub struct FileResult {
    path: PathBuf,
    success: bool,
    detail: String,
}

#[tauri::command]
pub async fn transfer_files(
    app: AppHandle, serial: String, files: Vec<PathBuf>, target: String, install: bool,
) -> Result<Vec<FileResult>> {
    tauri::async_runtime::spawn_blocking(move || {
        require_online(&app, &serial)?;
        if files.is_empty() || files.len() > 32 || !install && !profile::android_folder(&target) {
            return Err("invalidPushTarget");
        }
        let adb = adb_path(&engine(&app)?);
        Ok(files.into_iter().map(|path| {
            let is_apk = path.extension().and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("apk"));
            let mut command = Command::new(&adb);
            command.args(["-s", &serial]).creation_flags(CREATE_NO_WINDOW).stdin(Stdio::null());
            let output = if !path.is_absolute() || !path.is_file() || (install && !is_apk) {
                Err("invalidLocalPath")
            } else {
                if install { command.arg("install").arg(&path); }
                else { command.arg("push").arg(&path).arg(&target); }
                capture_with_timeout(command, None, Duration::from_secs(300))
            };
            let (success, detail) = match output {
                Ok(output) => (output.success, output.text),
                Err(error) => (false, error.into()),
            };
            FileResult { path, success, detail }
        }).collect())
    }).await.map_err(|_| "queryFailed")?
}

#[derive(Serialize)]
pub struct QueryOutput {
    pub(crate) text: String,
    pub(crate) success: bool,
}

#[tauri::command]
pub async fn query_device(app: AppHandle, serial: String, query: String) -> Result<QueryOutput> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = engine(&app)?;
        let device = read_devices(&path)?
            .into_iter()
            .find(|device| device.serial == serial && device.status == "online")
            .ok_or("deviceUnavailable")?;
        let mut command = official(&path, &serial);
        if query == "diagnostics" {
            return Ok(QueryOutput {
                text: format!("{}\n{}\n{}", device.model, device.serial, path.display()),
                success: true,
            });
        }
        if query == "deviceFacts" {
            command = Command::new(adb_path(&path));
            command
                .args([
                    "-s",
                    &serial,
                    "shell",
                    "getprop ro.product.manufacturer; wm size; printf '\\ncontroller-serial:'; getprop ro.serialno; printf 'controller-sdk:'; getprop ro.build.version.sdk",
                ])
                .creation_flags(CREATE_NO_WINDOW)
                .stdin(Stdio::null());
        } else {
            let flag = match query.as_str() {
                "encoders" => "--list-encoders",
                "displays" => "--list-displays",
                "apps" => "--list-apps",
                "cameras" => "--list-cameras",
                "cameraSizes" => "--list-camera-sizes",
                _ => return Err("queryFailed"),
            };
            command.arg(flag);
        }
        capture_query(command)
    })
    .await
    .map_err(|_| "queryFailed")?
}

#[derive(Serialize)]
pub struct PhoneApp {
    name: String,
    package: String,
}

fn valid_package(package: &str) -> bool {
    !package.is_empty()
        && package.len() <= 255
        && package.split('.').all(|part| {
            part.starts_with(|c: char| c.is_ascii_alphabetic())
                && part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
        })
}

#[tauri::command]
pub async fn list_apps(app: AppHandle, serial: String) -> Result<Vec<PhoneApp>> {
    let output = query_device(app, serial, "apps".into()).await?;
    if !output.success {
        return Err("queryFailed");
    }
    Ok(output
        .text
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let entry = line
                .strip_prefix("* ")
                .or_else(|| line.strip_prefix("- "))?;
            let (name, package) = entry.trim_end().rsplit_once(char::is_whitespace)?;
            valid_package(package).then(|| PhoneApp {
                name: name.trim().to_owned(),
                package: package.to_owned(),
            })
        })
        .collect())
}

#[tauri::command]
pub async fn open_app_window(
    app: AppHandle,
    serial: String,
    package: String,
    title: String,
    display: AppDisplay,
) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_package(&package) {
            return Err("appWindowFailed");
        }
        let key = (serial.clone(), Some(package.clone()));
        let state = app.state::<Sessions>();
        let (pid, title, options, _douyin_server, _wechat_server) = {
            let mut sessions = state.0.lock().map_err(|_| "sessionError")?;
            if crate::tray::quitting(&app) { return Err("sessionError"); }
            let path = engine(&app)?;
            let mut command = official(&path, &serial);
            let douyin = package == "com.ss.android.ugc.aweme";
            match display {
                AppDisplay::Fixed { width, height, .. } => {
                    if ![width, height]
                        .into_iter()
                        .all(|value| (128..=8192).contains(&value))
                    {
                        return Err("invalidAppResolution");
                    }
                    command.arg(format!("--new-display={width}x{height}"));
                }
                AppDisplay::Follow => {
                    let initial_display = if douyin {
                        "--new-display=720x1280/240"
                    } else {
                        "--new-display"
                    };
                    command.args([initial_display, "--flex-display"]);
                }
            }
            if douyin || package == "com.tencent.mm" {
                command.arg("--no-vd-system-decorations");
            }
            if douyin {
                command.arg("--keep-active");
            }
            if !read_devices(&path)?
                .iter()
                .any(|device| device.serial == serial && device.status == "online")
            {
                return Err("deviceUnavailable");
            }
            reap(&mut sessions);
            if let Some(session) = sessions.get(&key) {
                if session.display != Some(display) {
                    return Err("reopenAppWindow");
                }
                let target = focus_target(session)?;
                drop(sessions);
                return focus_window(&app, target);
            }
            let title: String = title.chars().filter(|c| !c.is_control()).take(90).collect();
            let title = if title.trim().is_empty() { package.clone() } else { title };
            let douyin_server = douyin
                .then(|| crate::douyin_server::DouyinServer::prepare(&path))
                .transpose()?;
            if let Some(server) = &douyin_server {
                command.env("SCRCPY_SERVER_PATH", server.path());
            }
            let wechat_server = (package == "com.tencent.mm"
                && matches!(display, AppDisplay::Fixed { width, height, wechat_insets: true } if width < height))
                .then(|| crate::wechat_server::WechatServer::prepare(&path))
                .transpose()?;
            if let Some(server) = &wechat_server {
                command.env("SCRCPY_SERVER_PATH", server.path());
            }
            let port_start = session_ports(&sessions, &mut command)?;
            let options = crate::mirror::MirrorOptions::prepare(
                &mut command, false, false, true, true, display == AppDisplay::Follow,
            );
            let mut child = command
                .arg("--start-app").arg(&package).arg("--window-title").arg(&title)
                .spawn().map_err(|_| "appWindowFailed")?;
            options.watch_stats(&mut child);
            let pid = child.id();
            sessions.insert(
                key.clone(),
                Session {
                    child,
                    port_start,
                    stopping: false,
                    task: None,
                    display: Some(display),
                        mirror: None,
                    recording: false,
                },
            );
            (pid, title, options, douyin_server, wechat_server)
        };
        finish_mirror(&app, &key, pid, &title, options).map_err(|error| {
            if error == "launchFailed" { "appWindowFailed" } else { error }
        })
    })
    .await
    .map_err(|_| "appWindowFailed")?
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum AppDisplay {
    Fixed {
        width: u32,
        height: u32,
        #[serde(default, rename = "wechatInsets")]
        wechat_insets: bool,
    },
    Follow,
}

fn capture_query(command: Command) -> Result<QueryOutput> {
    capture_command(command, None)
}

pub(crate) fn capture_command(command: Command, input: Option<&str>) -> Result<QueryOutput> {
    capture_with_timeout(command, input, Duration::from_secs(12))
}

fn capture_with_timeout(mut command: Command, input: Option<&str>, timeout: Duration) -> Result<QueryOutput> {
    use std::io::{Read, Write};
    if input.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "queryFailed")?;
    if let Some(input) = input {
        let sent = child
            .stdin
            .take()
            .ok_or("queryFailed")?
            .write_all(input.as_bytes());
        if sent.is_err() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("queryFailed");
        }
    }
    let stdout = child.stdout.take().ok_or("queryFailed")?;
    let stderr = child.stderr.take().ok_or("queryFailed")?;
    let read = |source: Box<dyn Read + Send>| {
        thread::spawn(move || {
            let mut bytes = Vec::new();
            source.take(262_144).read_to_end(&mut bytes).map(|_| bytes)
        })
    };
    let out = read(Box::new(stdout));
    let err = read(Box::new(stderr));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("queryFailed");
            }
        }
    };
    let mut bytes = out
        .join()
        .map_err(|_| "queryFailed")?
        .map_err(|_| "queryFailed")?;
    bytes.extend(
        err.join()
            .map_err(|_| "queryFailed")?
            .map_err(|_| "queryFailed")?,
    );
    if !status.success() && bytes.is_empty() {
        return Err("queryFailed");
    }
    Ok(QueryOutput {
        text: String::from_utf8_lossy(&bytes).trim().to_owned(),
        success: status.success(),
    })
}

#[tauri::command]
pub async fn app_icon(app: AppHandle, serial: String, package: String) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_package(&package) {
            return Err("queryFailed");
        }
        let path = engine(&app)?;
        let token = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).map_err(|_| "queryFailed")?.as_nanos();
        let token = format!("{}-{token}", std::process::id());
        let local = std::env::temp_dir().join(format!("scrcpy-controller-icon-{token}.jar"));
        let remote_helper = format!("/data/local/tmp/scrcpy-controller-icon-{token}.jar");
        let remote_server = format!("/data/local/tmp/scrcpy-controller-server-{token}.jar");
        let adb = || {
            let mut command = Command::new(adb_path(&path));
            command.args(["-s", &serial]).creation_flags(CREATE_NO_WINDOW).stdin(Stdio::null());
            command
        };
        std::fs::write(&local, include_bytes!("../android-helper/icons.jar")).map_err(|_| "queryFailed")?;
        let result = (|| {
            let mut push = adb();
            push.arg("push").arg(&local).arg(&remote_helper);
            if !capture_query(push)?.success {
                return Err("queryFailed");
            }
            let mut push = adb();
            push.arg("push").arg(path.join("scrcpy-server")).arg(&remote_server);
            if !capture_query(push)?.success {
                return Err("queryFailed");
            }
            let mut read = adb();
            read.arg("shell").arg(format!(
                "CLASSPATH={remote_helper}:{remote_server} app_process / ControllerAppIcon {package}"
            ));
            let output = capture_query(read)?;
            if !output.success {
                return Err("queryFailed");
            }
            let icon = output.text.lines()
                .find_map(|line| line.strip_prefix("CONTROLLER_ICON "))
                .filter(|icon| icon.starts_with("iVBORw0KGgo") && icon.len() <= 65536
                    && icon.bytes().all(|c| c.is_ascii_alphanumeric() || b"+/=".contains(&c)))
                .ok_or("queryFailed")?;
            Ok(format!("data:image/png;base64,{icon}"))
        })();
        let _ = std::fs::remove_file(&local);
        let mut cleanup = adb();
        cleanup.args(["shell", "rm", "-f", &remote_helper, &remote_server]);
        let _ = capture_query(cleanup);
        result
    }).await.map_err(|_| "queryFailed")?
}
