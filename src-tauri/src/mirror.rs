use std::{
    io::{BufRead, BufReader, Read},
    process::{Child, Command, Stdio},
    collections::BTreeMap,
    fs,
    sync::{Arc, Mutex, atomic::{AtomicU32, AtomicU64, Ordering}},
};
use crate::profile::StartupPlacement;
use tauri::{Emitter, AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use windows_sys::Win32::{
    Foundation::{GetLastError, HWND, POINT, RECT, SetLastError},
    Graphics::Gdi::{ClientToScreen, CreateRectRgn, CreateRoundRectRgn, DeleteObject, EqualRgn, GetWindowRgn, ScreenToClient, SetWindowRgn},
    System::Threading::{AttachThreadInput, GetCurrentThreadId},
    UI::Input::KeyboardAndMouse::{INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEINPUT, SendInput, SetFocus},
    UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
    UI::WindowsAndMessaging::{
        ChildWindowFromPointEx, CWP_SKIPINVISIBLE, CWP_SKIPTRANSPARENT, GWL_STYLE, GetAncestor, GA_ROOT, GetClientRect, GetCursorPos, GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId, GUITHREADINFO, GetParent, GetWindowRect, SetCursorPos, WindowFromPoint, IsChild, IsWindowVisible, IsIconic, GetWindowLongPtrW, HWND_TOP, IsWindow, PostMessageW,
        SW_HIDE, SWP_ASYNCWINDOWPOS, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SetParent, SetWindowLongPtrW,
        SetWindowPos, ShowWindowAsync, WM_APP, WM_CLOSE, WM_DPICHANGED, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_MOUSEMOVE, WM_NCDESTROY, WM_SETFOCUS, WM_WINDOWPOSCHANGED, WM_KEYDOWN, WM_KEYUP, WS_CHILD, WS_POPUP,
    },
};

// Match the compact title bar in MirrorWindow.css and mirrorSizing.ts.
const MINIMUM_WIDTH: u32 = 288;
const MINIMUM_HEIGHT: u32 = 310;

#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
pub(crate) struct Placement {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl Placement {
    fn at_least_minimum(self, scale: f64) -> Self {
        Self {
            width: self.width.max((f64::from(MINIMUM_WIDTH) * scale).ceil() as u32),
            height: self.height.max((f64::from(MINIMUM_HEIGHT) * scale).ceil() as u32),
            ..self
        }
    }

    fn overlap(self, area: Self) -> u64 {
        let width = (i64::from(self.x) + i64::from(self.width))
            .min(i64::from(area.x) + i64::from(area.width)) - i64::from(self.x.max(area.x));
        let height = (i64::from(self.y) + i64::from(self.height))
            .min(i64::from(area.y) + i64::from(area.height)) - i64::from(self.y.max(area.y));
        width.max(0) as u64 * height.max(0) as u64
    }

    fn fit_within(self, area: Self, scale: f64) -> Self {
        let size = self.at_least_minimum(scale);
        let width = size.width.min(area.width);
        let height = size.height.min(area.height);
        Self {
            x: self.x.clamp(area.x, area.x + (area.width - width) as i32),
            y: self.y.clamp(area.y, area.y + (area.height - height) as i32),
            width,
            height,
        }
    }
}

static PLACEMENTS: Mutex<()> = Mutex::new(());

fn placement_path(app: &AppHandle) -> Result<std::path::PathBuf, &'static str> {
    app.path().app_config_dir().map(|path| path.join("mirror-placement.json")).map_err(|_| "sessionError")
}

fn read_placements(path: &std::path::Path) -> BTreeMap<String, Placement> {
    fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

fn write_placements(path: &std::path::Path, all: &BTreeMap<String, Placement>) -> Result<(), &'static str> {
    fs::create_dir_all(path.parent().ok_or("sessionError")?).map_err(|_| "sessionError")?;
    let pending = path.with_extension("tmp");
    fs::write(&pending, serde_json::to_vec(all).map_err(|_| "sessionError")?).map_err(|_| "sessionError")?;
    fs::rename(pending, path).map_err(|_| "sessionError")
}

fn remembered_placement(all: &mut BTreeMap<String, Placement>, key: &str, legacy: &[String]) -> Option<Placement> {
    if let Some(placement) = all.get(key) { return Some(*placement); }
    let placement = legacy.iter().find_map(|old| all.get(old)).copied()?;
    all.insert(key.to_owned(), placement);
    Some(placement)
}

#[tauri::command]
pub(crate) fn last_mirror_placement(
    app: AppHandle, serial: String, hardware: String, legacy_serials: Option<Vec<String>>,
) -> Result<Option<Placement>, &'static str> {
    if hardware.trim().is_empty() { return Err("deviceVerifying"); }
    let key = serde_json::to_string(&(format!("hardware:{hardware}"), Option::<String>::None)).map_err(|_| "sessionError")?;
    let legacy = std::iter::once(serial).chain(legacy_serials.unwrap_or_default()).map(|serial|
        serde_json::to_string(&(serial, Option::<String>::None)).map_err(|_| "sessionError")
    ).collect::<Result<Vec<_>, _>>()?;
    let _lock = PLACEMENTS.lock().map_err(|_| "sessionError")?;
    let path = placement_path(&app)?;
    let mut all = read_placements(&path);
    let existed = all.contains_key(&key);
    let placement = remembered_placement(&mut all, &key, &legacy);
    if !existed && placement.is_some() { write_placements(&path, &all)?; }
    Ok(placement)
}

fn restore_placement(shell: &WebviewWindow, key: &str, legacy: &[String], startup: StartupPlacement) {
    let saved = PLACEMENTS.lock().ok().and_then(|_lock| {
        let path = placement_path(shell.app_handle()).ok()?;
        let mut all = read_placements(&path);
        let existed = all.contains_key(key);
        let placement = remembered_placement(&mut all, key, legacy);
        if !existed && placement.is_some() { let _ = write_placements(&path, &all); }
        placement
    });
    let (Ok(default_pos), Ok(default_size)) = (shell.outer_position(), shell.inner_size()) else { return; };
    let Ok(monitors) = shell.available_monitors() else { return; };
    let work_area = |monitor: &tauri::Monitor| {
        let area = monitor.work_area();
        Placement { x: area.position.x, y: area.position.y, width: area.size.width, height: area.size.height }
    };
    let visible_monitor = |placement: Placement| monitors.iter()
        .max_by_key(|monitor| placement.overlap(work_area(monitor)))
        .filter(|monitor| placement.overlap(work_area(monitor)) > 0);
    let saved = saved.filter(|p| (150..=16384).contains(&p.width)
        && (150..=16384).contains(&p.height));
    let default = Placement {
        x: default_pos.x, y: default_pos.y, width: default_size.width, height: default_size.height,
    };
    let base = saved.unwrap_or(default);
    let requested = Placement {
        x: startup.startup_x.unwrap_or(base.x),
        y: startup.startup_y.unwrap_or(base.y),
        width: startup.startup_width.unwrap_or(base.width),
        height: startup.startup_height.unwrap_or(base.height),
    };
    let Some(destination) = visible_monitor(requested)
        .or_else(|| visible_monitor(default)).or_else(|| monitors.first()) else { return; };
    let area = work_area(destination);
    let target = requested.fit_within(area, destination.scale_factor());
    if let Ok(hwnd) = shell.hwnd() {
        let hwnd = hwnd.0 as usize;
        // Moving first lets the destination monitor apply its DPI before restoring
        // the saved physical dimensions. Both calls run while the shell is hidden.
        let _ = shell.run_on_main_thread(move || unsafe {
            SetWindowPos(hwnd as HWND, std::ptr::null_mut(), target.x, target.y,
                0, 0, SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOSIZE);
            SetWindowPos(hwnd as HWND, std::ptr::null_mut(), target.x, target.y,
                target.width as i32, target.height as i32, SWP_NOACTIVATE | SWP_NOZORDER);
        });
    }
}

pub(crate) fn save_placement(shell: &WebviewWindow, mirror: &Mirror) -> Result<(), &'static str> {
    if shell.is_fullscreen().unwrap_or(true) || shell.is_minimized().unwrap_or(true) || shell.is_maximized().unwrap_or(true) {
        return Ok(());
    }
    let pos = shell.outer_position().map_err(|_| "mirrorFrameFailed")?;
    let size = shell.inner_size().map_err(|_| "mirrorFrameFailed")?;
    let placement = Placement { x: pos.x, y: pos.y, width: size.width, height: size.height };
    let _lock = PLACEMENTS.lock().map_err(|_| "sessionError")?;
    let path = placement_path(shell.app_handle())?;
    let mut all = read_placements(&path);
    all.insert(mirror.placement_key.clone(), placement);
    write_placements(&path, &all)
}

static NEXT_WINDOW: AtomicU64 = AtomicU64::new(1);
static NEXT_INPUT_OPERATION: AtomicU64 = AtomicU64::new(1);
static LOG_SESSIONS: Mutex<BTreeMap<usize, String>> = Mutex::new(BTreeMap::new());

pub(crate) fn log_session(host: HWND) -> String {
    // 仅作为本次运行内匿名编号的映射键，窗口句柄不会写入日志。
    LOG_SESSIONS.lock().ok().and_then(|sessions| sessions.get(&(host as usize)).cloned())
        .unwrap_or_else(|| format!("host-{}", host as usize))
}

#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize)]
struct InputSnapshot {
    system_modifiers: u16,
    buttons: u8,
    foreground: &'static str,
    focus: &'static str,
    capture: &'static str,
    pointer_in_video: bool,
    sampler_thread: u32,
    sampled: bool,
    sdl_modifiers: &'static str,
}

fn input_snapshot(host: HWND, video: HWND) -> InputSnapshot {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    let target = |window: HWND| unsafe {
        if window.is_null() { "none" }
        else if window == video { "video" }
        else if window == host { "host" }
        else if IsChild(host, window) != 0 { "shellChild" }
        else { "other" }
    };
    unsafe {
        // 这里只读取系统状态，不绑定输入队列，也不声称读取到播放器内部状态。
        let mut info = GUITHREADINFO { cbSize: std::mem::size_of::<GUITHREADINFO>() as u32, ..Default::default() };
        let thread = GetWindowThreadProcessId(video, std::ptr::null_mut());
        if thread != 0 { GetGUIThreadInfo(thread, &mut info); }
        let mut cursor = POINT::default();
        let pointer_in_video = GetCursorPos(&mut cursor) != 0 && WindowFromPoint(cursor) == video;
        let system_modifiers = [0xa2, 0xa3, 0xa0, 0xa1, 0xa4, 0xa5, 0x5b, 0x5c]
            .iter().enumerate().fold(0, |mask, (bit, key)|
                mask | if GetAsyncKeyState(*key) < 0 { 1 << bit } else { 0 });
        let buttons = [1, 2, 4].iter().enumerate().fold(0, |mask, (bit, key)|
            mask | if GetAsyncKeyState(*key) < 0 { 1 << bit } else { 0 });
        InputSnapshot { system_modifiers, buttons, foreground: target(GetForegroundWindow()),
            focus: target(info.hwndFocus), capture: target(info.hwndCapture), pointer_in_video,
            sampler_thread: GetCurrentThreadId(), sampled: true, sdl_modifiers: "unavailable" }
    }
}

fn log_input(event: &'static str, host: HWND, video: HWND) {
    if !crate::control_log::enabled() || unsafe { GetForegroundWindow() } != host { return; }
    crate::control_log::record(event, Some(&log_session(host)), serde_json::to_value(input_snapshot(host, video)).unwrap_or_default());
}

#[derive(Clone)]
pub(crate) struct MirrorOptions {
    pub fullscreen: bool,
    pub top: bool,
    pub control_enabled: bool,
    pub virtual_screen: bool,
    pub follow: bool,
    pub startup: StartupPlacement,
    fps: Arc<AtomicU32>,
    frame_size: Arc<AtomicU32>,
}

impl MirrorOptions {
    pub(crate) fn prepare(command: &mut Command, fullscreen: bool, top: bool, control_enabled: bool, virtual_screen: bool, follow: bool) -> Self {
        command.args([
            "--window-borderless", "--window-x=-30000", "--window-y=-30000",
            "--shortcut-mod=rctrl,lalt,lsuper", "--print-fps",
        ]).stdout(Stdio::piped()).stderr(Stdio::piped());
        Self {
            fullscreen, top, control_enabled, virtual_screen, follow, startup: StartupPlacement::default(),
            fps: Arc::new(AtomicU32::new(u32::MAX)), frame_size: Arc::default(),
        }
    }

    pub(crate) fn watch_stats(&self, child: &mut Child) {
        fn read(output: impl Read + Send + 'static, fps: Arc<AtomicU32>, frame_size: Arc<AtomicU32>) {
            std::thread::spawn(move || {
                for line in BufReader::new(output).lines().map_while(Result::ok) {
                    if let Some((width, height)) = texture_size(&line) {
                        frame_size.store((u32::from(width) << 16) | u32::from(height), Ordering::Relaxed);
                    }
                    if let Some((prefix, _)) = line.split_once(" fps")
                        && let Some(count) = prefix.split_whitespace().last().and_then(|word| word.parse().ok())
                    {
                        fps.store(count, Ordering::Relaxed);
                    }
                }
            });
        }
        if let Some(stdout) = child.stdout.take() { read(stdout, self.fps.clone(), self.frame_size.clone()); }
        if let Some(stderr) = child.stderr.take() { read(stderr, self.fps.clone(), self.frame_size.clone()); }
    }

    pub(crate) fn stats(&self) -> (Option<u32>, Option<[u16; 2]>) {
        let count = self.fps.load(Ordering::Relaxed);
        let size = self.frame_size.load(Ordering::Relaxed);
        ((count != u32::MAX).then_some(count), (size != 0).then_some([(size >> 16) as u16, size as u16]))
    }
}

fn texture_size(line: &str) -> Option<(u16, u16)> {
    let (suffix, size) = line.trim().strip_prefix("INFO: Texture")?.split_once(':')?;
    if !suffix.is_empty() && !(suffix.starts_with(" (") && suffix.ends_with(')')) {
        return None;
    }
    let (width, height) = size.trim().split_once('x')?;
    let width = width.parse::<u16>().ok()?;
    let height = height.parse::<u16>().ok()?;
    (width > 0 && height > 0).then_some((width, height))
}

#[cfg(test)]
mod tests {
    use super::{Placement, keyboard_inputs, remembered_placement, texture_size};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{INPUT_KEYBOARD, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE};

    #[test]
    fn moving_parent_requires_native_child_position_refresh() {
        use std::sync::atomic::{AtomicU32, Ordering};
        use windows_sys::Win32::{System::LibraryLoader::GetModuleHandleW,
            UI::WindowsAndMessaging::{CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassW,
                SetWindowPos, UnregisterClassW, WNDCLASSW, WM_WINDOWPOSCHANGED,
                WS_CHILD, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOZORDER}};
        static CHANGES: AtomicU32 = AtomicU32::new(0);
        unsafe extern "system" fn child_proc(window: super::HWND, message: u32, wparam: usize, lparam: isize) -> isize {
            if message == WM_WINDOWPOSCHANGED { CHANGES.fetch_add(1, Ordering::Relaxed); }
            unsafe { DefWindowProcW(window, message, wparam, lparam) }
        }
        unsafe {
            let instance = GetModuleHandleW(std::ptr::null());
            let class = crate::cli_protocol::wide(&format!("ControllerGeometryProbe-{}", std::process::id()));
            let descriptor = WNDCLASSW { lpfnWndProc: Some(child_proc), hInstance: instance,
                lpszClassName: class.as_ptr(), ..Default::default() };
            assert_ne!(RegisterClassW(&descriptor), 0);
            let parent = CreateWindowExW(0, crate::cli_protocol::wide("STATIC").as_ptr(), std::ptr::null(),
                0, 100, 100, 400, 500, std::ptr::null_mut(), std::ptr::null_mut(), instance, std::ptr::null());
            assert!(!parent.is_null());
            let child = CreateWindowExW(0, class.as_ptr(), std::ptr::null(), WS_CHILD,
                10, 20, 200, 300, parent, std::ptr::null_mut(), instance, std::ptr::null());
            assert!(!child.is_null());
            CHANGES.store(0, Ordering::Relaxed);
            let moved = SetWindowPos(parent, std::ptr::null_mut(), 500, 400, 400, 500, SWP_NOACTIVATE | SWP_NOZORDER);
            let inherited_notifications = CHANGES.load(Ordering::Relaxed);
            let unchanged = SetWindowPos(child, std::ptr::null_mut(), 10, 20, 200, 300, SWP_NOACTIVATE | SWP_NOZORDER);
            let unchanged_notifications = CHANGES.load(Ordering::Relaxed);
            let refreshed = SetWindowPos(child, std::ptr::null_mut(), 10, 20, 200, 300, SWP_NOACTIVATE | SWP_NOZORDER | SWP_FRAMECHANGED);
            let refreshed_notifications = CHANGES.load(Ordering::Relaxed);
            DestroyWindow(parent);
            UnregisterClassW(class.as_ptr(), instance);
            assert_ne!(moved, 0);
            assert_eq!(inherited_notifications, 0, "父窗口移动不会刷新播放器的子窗口缓存");
            assert_ne!(unchanged, 0);
            assert_eq!(unchanged_notifications, 0, "相同几何的普通定位会被系统省略");
            assert_ne!(refreshed, 0);
            assert!(refreshed_notifications > 0, "同尺寸真实定位也必须产生位置刷新消息");
        }
    }

    #[test]
    fn discrete_keys_use_hardware_scancodes_and_matching_releases() {
        for (name, scancode, extended) in [
            ("left", 0x4b, true), ("right", 0x4d, true),
            ("up", 0x48, true), ("down", 0x50, true),
            ("backspace", 0x0e, false), ("enter", 0x1c, false),
            ("escape", 0x01, false), ("tab", 0x0f, false),
        ] {
            let [down, up] = keyboard_inputs(name).unwrap();
            let flags = KEYEVENTF_SCANCODE | if extended { KEYEVENTF_EXTENDEDKEY } else { 0 };
            assert_eq!((down.r#type, up.r#type), (INPUT_KEYBOARD, INPUT_KEYBOARD));
            unsafe {
                assert_eq!((down.Anonymous.ki.wVk, up.Anonymous.ki.wVk), (0, 0));
                assert_eq!((down.Anonymous.ki.wScan, up.Anonymous.ki.wScan), (scancode, scancode));
                assert_eq!((down.Anonymous.ki.dwFlags, up.Anonymous.ki.dwFlags), (flags, flags | KEYEVENTF_KEYUP));
            }
        }
        assert!(keyboard_inputs("unknown").is_none());
    }

    #[test]
    fn legacy_placement_uses_logical_limits_at_the_destination_scale() {
        let saved = Placement { x: -240, y: 12, width: 160, height: 450 };
        let actual = saved.at_least_minimum(1.25);
        assert_eq!((actual.x, actual.y, actual.width, actual.height), (-240, 12, 360, 450));
        let actual = saved.at_least_minimum(1.5);
        assert_eq!((actual.width, actual.height), (432, 465));
    }

    #[test]
    fn restore_chooses_the_monitor_with_the_largest_visible_area() {
        let screens = [
            Placement { x: -1080, y: 0, width: 1080, height: 1920 },
            Placement { x: 0, y: 0, width: 2560, height: 1400 },
        ];
        let saved = Placement { x: -80, y: 100, width: 900, height: 1000 };
        let destination = screens.iter().max_by_key(|screen| saved.overlap(**screen)).unwrap();
        assert_eq!(destination.x, 0);
        assert_eq!(saved.fit_within(*destination, 1.5).x, 0);
    }

    #[test]
    fn disconnected_monitor_and_oversized_windows_restore_fully_visible() {
        let screen = Placement { x: 0, y: 40, width: 1920, height: 1040 };
        let missing_screen = Placement { x: -1700, y: 1500, width: 900, height: 2000 };
        assert_eq!(missing_screen.overlap(screen), 0);
        let restored = missing_screen.fit_within(screen, 1.25);
        assert_eq!((restored.x, restored.y, restored.width, restored.height), (0, 40, 900, 1040));
        let narrow = Placement { x: 1900, y: 1040, width: 160, height: 320 }.fit_within(screen, 1.5);
        assert_eq!((narrow.x, narrow.y, narrow.width, narrow.height), (1488, 615, 432, 465));
    }

    #[test]
    fn placement_migrates_only_known_aliases_and_keeps_the_stable_value() {
        let old = Placement { x: 120, y: 80, width: 720, height: 900 };
        let mut all = std::collections::BTreeMap::from([("old-port".to_owned(), old)]);
        assert!(remembered_placement(&mut all, "phone", &["another-port".to_owned()]).is_none());
        assert_eq!(remembered_placement(&mut all, "phone", &["old-port".to_owned()]).unwrap().x, 120);
        all.get_mut("old-port").unwrap().x = 999;
        assert_eq!(remembered_placement(&mut all, "phone", &["old-port".to_owned()]).unwrap().x, 120);
        assert_eq!(remembered_placement(&mut all, "phone", &[]).unwrap().width, 720);
    }

    #[test]
    fn reads_video_dimensions_from_software_and_hardware_renderers() {
        assert_eq!(texture_size("INFO: Texture: 1440x3200"), Some((1440, 3200)));
        assert_eq!(texture_size("INFO: Texture (D3D11VA): 1440x3200"), Some((1440, 3200)));
        assert_eq!(texture_size("INFO: Texture: 1440x0"), None);
        assert_eq!(texture_size("INFO: Texture creation failed: 1440x3200"), None);
    }
}

#[derive(Clone)]
pub(crate) struct Mirror {
    pub label: String,
    pub video: usize,
    pub original_size: (i32, i32),
    pub startup_position: (i32, i32),
    pub options: MirrorOptions,
    placement_key: String,
    legacy_placement_keys: Vec<String>,
    bounds: Arc<Mutex<Option<VideoBounds>>>,
}

impl Mirror {
    pub fn new(video: HWND, options: MirrorOptions, placement_key: String, legacy_placement_keys: Vec<String>) -> Result<Self, &'static str> {
        let mut bounds = RECT::default();
        let mut screen = RECT::default();
        if unsafe { GetClientRect(video, &mut bounds) == 0 || GetWindowRect(video, &mut screen) == 0 } {
            return Err("mirrorFrameFailed");
        }
        Ok(Self {
            label: format!("mirror-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed)),
            video: video as usize,
            options,
            placement_key,
            legacy_placement_keys,
            bounds: Arc::default(),
            original_size: (bounds.right.max(1), bounds.bottom.max(1)),
            startup_position: (screen.left, screen.top),
        })
    }

    pub fn window(&self) -> HWND {
        self.video as HWND
    }
}

pub(crate) fn create(app: &AppHandle, mirror: &Mirror, title: &str) -> Result<(), &'static str> {
    let ratio = mirror.original_size.0 as f64 / mirror.original_size.1 as f64;
    let height = app.get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
        .map(|monitor| (monitor.work_area().size.height as f64 / monitor.scale_factor() - 60.0).max(272.0))
        .unwrap_or(790.0).min(830.0).min(1080.0 / ratio);
    let shell = WebviewWindowBuilder::new(app, &mirror.label, WebviewUrl::App("index.html".into()))
        .title(title)
        .decorations(false)
        .disable_drag_drop_handler()
        .transparent(true)
        .shadow(false)
        .inner_size((height * ratio + 56.0).max(f64::from(MINIMUM_WIDTH)), (height + 38.0).max(f64::from(MINIMUM_HEIGHT)))
        .min_inner_size(f64::from(MINIMUM_WIDTH), f64::from(MINIMUM_HEIGHT))
        .always_on_top(mirror.options.top)
        .fullscreen(mirror.options.fullscreen)
        .visible(false)
        .build()
        .map_err(|_| "mirrorFrameFailed")?;
    let video = mirror.video;
    let host = shell.hwnd().map_err(|_| "mirrorFrameFailed")?.0 as HWND;
    if let Ok(mut sessions) = LOG_SESSIONS.lock() { sessions.insert(host as usize, mirror.label.clone()); }
    let session = log_session(host);
    crate::control_log::record("mirror.created", Some(&session), serde_json::json!({
        "virtual_screen": mirror.options.virtual_screen, "control_enabled": mirror.options.control_enabled,
        "follow": mirror.options.follow, "width": mirror.original_size.0, "height": mirror.original_size.1,
    }));
    let window_session = session.clone();
    let host_id = host as usize;
    shell.on_window_event(move |event| {
        if let WindowEvent::Focused(active) = event {
            crate::control_log::record("mirror.foreground_changed", Some(&window_session), serde_json::json!({ "active": active }));
        }
        if matches!(event, WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed) {
            crate::control_log::record(if matches!(event, WindowEvent::Destroyed) { "mirror.destroyed" } else { "mirror.close_requested" },
                Some(&window_session), serde_json::json!({}));
            unsafe { PostMessageW(video as HWND, WM_CLOSE, 0, 0) };
            if matches!(event, WindowEvent::Destroyed)
                && let Ok(mut sessions) = LOG_SESSIONS.lock()
            {
                sessions.remove(&host_id);
            }
            if matches!(event, WindowEvent::Destroyed) { crate::mouse_trace::unregister(host_id); }
        }
    });
    if !attach(mirror.window(), host) {
        crate::control_log::record("mirror.attach_failed", Some(&session), serde_json::json!({}));
        let _ = shell.destroy();
        return Err("mirrorFrameFailed");
    }
    crate::control_log::record("mirror.attached", Some(&session), serde_json::json!({}));
    let tracing = crate::mouse_trace::register(host as usize, video, session.clone());
    crate::control_log::record("input.trace_registered", Some(&session), serde_json::json!({ "success": tracing }));
    install_move_handler(&shell, host, video)?;
    let app = app.clone();
    let label = mirror.label.clone();
    let host = host as usize;
    let bounds = mirror.bounds.clone();
    std::thread::spawn(move || {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_ESCAPE};
        let mut escape_was_down = false;
        let mut was_active = false;
        let mut previous_input = None;
        while unsafe { IsWindow(video as HWND) } != 0 {
            let foreground = unsafe { GetForegroundWindow() };
            let active = foreground == host as HWND;
            if !foreground.is_null() || unsafe { IsIconic(host as HWND) } != 0 {
                if was_active && !active {
                    let _ = app.emit_to(&label, &format!("mirror-blur-{label}"), ());
                }
                was_active = active;
            }
            if crate::control_log::enabled() && active {
                let snapshot = input_snapshot(host as HWND, video as HWND);
                if previous_input != Some(snapshot) {
                    crate::control_log::record("input.sample_changed", Some(&session), serde_json::to_value(snapshot).unwrap_or_default());
                    previous_input = Some(snapshot);
                }
            } else {
                previous_input = None;
            }
            let escape = active && unsafe { GetAsyncKeyState(VK_ESCAPE as i32) } < 0;
            if escape && !escape_was_down {
                let _ = app.emit_to(&label, &format!("mirror-escape-{label}"), ());
            }
            escape_was_down = escape;
            if let Ok(bounds) = bounds.lock()
                && let Some(bounds) = *bounds
            {
                let _ = correct_video_bounds(host as HWND, video as HWND, bounds);
            }
            std::thread::sleep(std::time::Duration::from_millis(if active { 35 } else { 200 }));
        }
        crate::control_log::record("mirror.closed", Some(&session), serde_json::json!({}));
        crate::mouse_trace::unregister(host);
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.destroy();
        }
    });
    if !mirror.options.fullscreen {
        restore_placement(&shell, &mirror.placement_key, &mirror.legacy_placement_keys, mirror.options.startup);
    }
    shell.show().map_err(|_| "mirrorFrameFailed")?;
    let _ = shell.set_focus();
    Ok(())
}

fn attach(video: HWND, host: HWND) -> bool {
    unsafe {
        ShowWindowAsync(video, SW_HIDE);
        let style = GetWindowLongPtrW(video, GWL_STYLE);
        SetWindowLongPtrW(video, GWL_STYLE, (style & !(WS_POPUP as isize)) | WS_CHILD as isize);
        SetLastError(0);
        let previous = SetParent(video, host);
        if (previous.is_null() && GetLastError() != 0) || GetParent(video) != host {
            SetWindowLongPtrW(video, GWL_STYLE, style);
            return false;
        }
        SetWindowPos(video, HWND_TOP, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED) != 0
    }
}

#[derive(Clone, Copy, serde::Deserialize)]
pub struct VideoBounds {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    radius: i32,
}

pub(crate) fn position(window: &WebviewWindow, mirror: &Mirror, bounds: VideoBounds) -> Result<(), &'static str> {
    let host = window.hwnd().map_err(|_| "mirrorFrameFailed")?.0 as HWND;
    let mut client = RECT::default();
    let video = mirror.window();
    let mut desired = mirror.bounds.lock().map_err(|_| "mirrorFrameFailed")?;
    unsafe {
        if GetParent(video) != host || GetClientRect(host, &mut client) == 0 {
            return Err("mirrorFrameFailed");
        }
        let x = bounds.x.clamp(0, client.right);
        let y = bounds.y.clamp(0, client.bottom);
        let width = bounds.width.clamp(0, client.right - x);
        let height = bounds.height.clamp(0, client.bottom - y);
        let radius = bounds.radius.clamp(0, width.min(height) / 2);
        let bounds = VideoBounds { x, y, width, height, radius };
        let first = desired.is_none();
        *desired = Some(bounds);
        if width == 0 || height == 0 {
            if IsWindowVisible(video) != 0 {
                ShowWindowAsync(video, SW_HIDE);
            }
            return Ok(());
        }
        if first && IsIconic(host) == 0 {
            // Complete the first visible resize before returning to the webview.
            // The player refreshes its frame and pointer coordinates on a visible size event.
            if SetWindowPos(video, HWND_TOP, x, y, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW) == 0 {
                return Err("mirrorFrameFailed");
            }
        } else if !correct_video_bounds(host, video, bounds) {
            return Err("mirrorFrameFailed");
        }
    }
    Ok(())
}

fn correct_video_region(video: HWND, bounds: VideoBounds) -> bool {
    unsafe {
        let current = CreateRectRgn(0, 0, 0, 0);
        if current.is_null() {
            return false;
        }
        let has_region = GetWindowRgn(video, current) != 0;
        let desired = if bounds.radius > 0 {
            let diameter = 2 * bounds.radius;
            // GDI leaves out the bottom and right pixel at the supplied extent.
            CreateRoundRectRgn(0, 0, bounds.width + 1, bounds.height + 1, diameter, diameter)
        } else {
            std::ptr::null_mut()
        };
        let matches = if desired.is_null() {
            !has_region
        } else {
            has_region && EqualRgn(current, desired) != 0
        };
        DeleteObject(current);
        if bounds.radius > 0 && desired.is_null() {
            return false;
        }
        if !matches && SetWindowRgn(video, desired, 1) != 0 {
            return true;
        }
        if !desired.is_null() {
            DeleteObject(desired);
        }
        matches
    }
}

fn correct_video_bounds(host: HWND, video: HWND, bounds: VideoBounds) -> bool {
    if bounds.width <= 0 || bounds.height <= 0 {
        return true;
    }
    unsafe {
        if IsIconic(host) != 0 {
            return true;
        }
        let mut point = POINT { x: bounds.x, y: bounds.y };
        let mut actual = RECT::default();
        if GetParent(video) != host || ClientToScreen(host, &mut point) == 0
            || GetWindowRect(video, &mut actual) == 0
        {
            return false;
        }
        let visible = IsWindowVisible(video) != 0;
        let on_top = video_hit(host, bounds.x + bounds.width / 2, bounds.y + bounds.height / 2) == video;
        if visible && on_top && actual.left == point.x && actual.top == point.y
            && actual.right - actual.left == bounds.width && actual.bottom - actual.top == bounds.height
        {
            // The player may replace its region after processing the native resize.
            return correct_video_region(video, bounds);
        }
        let flags = SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS
            | if on_top { SWP_NOZORDER } else { 0 }
            | if visible { 0 } else { SWP_SHOWWINDOW };
        SetWindowPos(video, HWND_TOP, bounds.x, bounds.y, bounds.width, bounds.height, flags) != 0
    }
}

pub(crate) fn shortcut(video: HWND, key: usize, scan: usize, shift: bool, extended: bool) -> Result<(), &'static str> {
    fn post(video: HWND, session: &str, operation: u64, down: bool, key: usize, scan: usize, extended: bool) -> bool {
        let flags = 1 | (scan << 16) | (usize::from(extended) << 24) | if down { 0 } else { 3 << 30 };
        let queued = unsafe { PostMessageW(video, if down { WM_KEYDOWN } else { WM_KEYUP }, key, flags as isize) != 0 };
        crate::control_log::record("shortcut.queued", Some(session), serde_json::json!({
            "operation": operation, "key_code": key, "scan_code": scan, "pressed": down,
            "extended": extended, "queued": queued,
        }));
        queued
    }
    let host = unsafe { GetParent(video) };
    let session = log_session(host);
    let operation = NEXT_INPUT_OPERATION.fetch_add(1, Ordering::Relaxed);
    crate::control_log::record("shortcut.started", Some(&session), serde_json::json!({ "operation": operation, "key_code": key, "shift": shift }));
    log_input("shortcut.input_before", host, video);
    let ctrl_down = post(video, &session, operation, true, 0x11, 0x1d, true);
    let shift_down = !shift || post(video, &session, operation, true, 0x10, 0x2a, false);
    let key_down = post(video, &session, operation, true, key, scan, extended);
    let key_up = post(video, &session, operation, false, key, scan, extended);
    let shift_up = !shift || post(video, &session, operation, false, 0x10, 0x2a, false);
    let ctrl_up = post(video, &session, operation, false, 0x11, 0x1d, true);
    let success = ctrl_down && shift_down && key_down && key_up && shift_up && ctrl_up;
    // 成功仅表示消息已入队，不表示播放器已经处理。
    crate::control_log::record("shortcut.completed", Some(&session), serde_json::json!({ "operation": operation, "queued": success }));
    log_input("shortcut.input_after", host, video);
    if success {
        Ok(())
    } else {
        Err("mirrorActionFailed")
    }
}

pub(crate) fn copy_png(owner: HWND, bytes: &[u8]) -> Result<(), &'static str> {
    use std::ptr::copy_nonoverlapping;
    use windows_sys::Win32::{
        Foundation::GlobalFree,
        System::{
            DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData},
            Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock},
        },
    };

    unsafe {
        let format = RegisterClipboardFormatW([80, 78, 71, 0].as_ptr());
        if format == 0 || OpenClipboard(owner) == 0 {
            return Err("captureUnavailable");
        }
        let memory = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
        let success = if memory.is_null() {
            false
        } else {
            let data = GlobalLock(memory);
            if data.is_null() {
                false
            } else {
                copy_nonoverlapping(bytes.as_ptr(), data.cast::<u8>(), bytes.len());
                GlobalUnlock(memory);
                EmptyClipboard() != 0 && !SetClipboardData(format, memory).is_null()
            }
        };
        if !success && !memory.is_null() {
            GlobalFree(memory);
        }
        CloseClipboard();
        success.then_some(()).ok_or("captureUnavailable")
    }
}


fn focused_child() -> HWND {
    let mut info = GUITHREADINFO { cbSize: std::mem::size_of::<GUITHREADINFO>() as u32, ..Default::default() };
    if unsafe { GetGUIThreadInfo(0, &mut info) } != 0 { info.hwndFocus } else { std::ptr::null_mut() }
}

fn focus_video(host: HWND, video: HWND) -> bool {
    log_input("focus.restore_started", host, video);
    unsafe {
        if GetForegroundWindow() != host || GetParent(video) != host || IsWindowVisible(video) == 0 {
            crate::control_log::record("focus.restore_skipped", Some(&log_session(host)), serde_json::json!({}));
            return false;
        }
        if focused_child() != video {
            let current_thread = GetCurrentThreadId();
            let video_thread = GetWindowThreadProcessId(video, std::ptr::null_mut());
            let attached = video_thread != 0 && current_thread != video_thread
                && AttachThreadInput(current_thread, video_thread, 1) != 0;
            crate::control_log::record("focus.thread_attach", Some(&log_session(host)), serde_json::json!({
                "success": attached, "needed": video_thread != 0 && current_thread != video_thread,
            }));
            SetFocus(video);
            if attached {
                let detached = AttachThreadInput(current_thread, video_thread, 0) != 0;
                crate::control_log::record("focus.thread_detach", Some(&log_session(host)), serde_json::json!({ "success": detached }));
            }
        }
        let focused = focused_child() == video;
        log_input("focus.restore_completed", host, video);
        crate::control_log::record("focus.restore_result", Some(&log_session(host)), serde_json::json!({ "success": focused }));
        focused
    }
}

pub(crate) async fn prepare_input(shell: WebviewWindow, video: usize) -> Result<bool, &'static str> {
    let host = shell.hwnd().map_err(|_| "mirrorFrameFailed")?.0 as usize;
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    shell.run_on_main_thread(move || unsafe {
        let video = video as HWND;
        let focused = focus_video(host as HWND, video);
        if focused {
            let mut rect = RECT::default();
            if GetClientRect(video, &mut rect) != 0 {
                let point = ((rect.bottom / 2) << 16) | (rect.right / 2);
                PostMessageW(video, WM_MOUSEMOVE, 0, point as isize);
            }
        }
        let _ = send.send(focused);
    }).map_err(|_| "mirrorFrameFailed")?;
    tauri::async_runtime::spawn_blocking(move || receive.recv_timeout(std::time::Duration::from_millis(800)))
        .await.map_err(|_| "mirrorFrameFailed")?.map_err(|_| "mirrorFrameFailed")
}

fn install_move_handler(shell: &WebviewWindow, host: HWND, video: usize) -> Result<(), &'static str> {
    const RESTORE_INPUT: u32 = WM_APP + 0x6f2;
    const REFRESH_GEOMETRY: usize = 1;
    const RESTORE_FOCUS: usize = 2;
    unsafe extern "system" fn on_message(
        host: HWND, message: u32, wparam: usize, lparam: isize, id: usize, video: usize,
    ) -> isize {
        if message == WM_ENTERSIZEMOVE {
            log_input("mirror.move_started", host, video as HWND);
        } else if message == WM_EXITSIZEMOVE || message == WM_DPICHANGED {
            log_input("mirror.move_ended", host, video as HWND);
            let mut rect = RECT::default();
            if unsafe { GetClientRect(host, &mut rect) } != 0 {
                crate::control_log::record("mirror.resized", Some(&log_session(host)), serde_json::json!({
                    "width": rect.right - rect.left, "height": rect.bottom - rect.top,
                }));
            }
        }
        if message == WM_NCDESTROY {
            unsafe { RemoveWindowSubclass(host, Some(on_message), id); }
        }
        let result = unsafe { DefSubclassProc(host, message, wparam, lparam) };
        if message == WM_EXITSIZEMOVE || message == WM_DPICHANGED || message == WM_SETFOCUS || message == WM_WINDOWPOSCHANGED {
            // 父窗口移动不会向子窗口发送位置变化。通过真实窗口操作刷新播放器
            // 缓存；纯几何变化不抢焦点，避免移动过程中改变鼠标捕获。
            let flags = match message {
                WM_SETFOCUS => RESTORE_FOCUS,
                WM_WINDOWPOSCHANGED => REFRESH_GEOMETRY,
                _ => REFRESH_GEOMETRY | RESTORE_FOCUS,
            };
            unsafe { PostMessageW(host, RESTORE_INPUT, flags, 0); }
        } else if message == RESTORE_INPUT {
            let video = video as HWND;
            unsafe {
                if GetParent(video) == host && IsWindowVisible(video) != 0 && IsIconic(host) == 0 {
                    if wparam & REFRESH_GEOMETRY != 0 {
                        let mut origin = POINT::default();
                        let mut rect = RECT::default();
                        if ClientToScreen(video, &mut origin) != 0 {
                            let screen_origin = origin;
                            if ScreenToClient(host, &mut origin) == 0 { return result; }
                            if GetClientRect(video, &mut rect) != 0 {
                                // 同位置、同尺寸的普通调用会被系统合并；强制框架计算
                                // 才会产生播放器实际处理的位置事件，不必做可见尺寸抖动。
                                let queued = SetWindowPos(video, std::ptr::null_mut(), origin.x, origin.y,
                                    rect.right, rect.bottom, SWP_NOACTIVATE | SWP_NOZORDER | SWP_ASYNCWINDOWPOS | SWP_FRAMECHANGED) != 0;
                                crate::control_log::record("geometry.refresh_requested", Some(&log_session(host)), serde_json::json!({
                                    "queued": queued, "client_x": origin.x, "client_y": origin.y,
                                    "video_screen_x": screen_origin.x, "video_screen_y": screen_origin.y,
                                    "width": rect.right, "height": rect.bottom,
                                }));
                            }
                        }
                    }
                    if wparam & RESTORE_FOCUS != 0 { focus_video(host, video); }
                }
            }
        }
        result
    }

    let host = host as usize;
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    shell.run_on_main_thread(move || {
        let installed = unsafe { SetWindowSubclass(host as HWND, Some(on_message), 1, video) } != 0;
        let _ = send.send(installed);
    }).map_err(|_| "mirrorFrameFailed")?;
    if receive.recv_timeout(std::time::Duration::from_secs(2)).unwrap_or(false) {
        Ok(())
    } else {
        let _ = shell.destroy();
        Err("mirrorFrameFailed")
    }
}

fn video_hit(host: HWND, x: i32, y: i32) -> HWND {
    unsafe { ChildWindowFromPointEx(host, POINT { x, y }, CWP_SKIPINVISIBLE | CWP_SKIPTRANSPARENT) }
}

fn send_mouse(flags: u32) -> bool {
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 { mi: MOUSEINPUT { dwFlags: flags, ..Default::default() } },
    };
    unsafe { SendInput(1, &input, std::mem::size_of::<INPUT>() as i32) == 1 }
}

fn keyboard_inputs(key: &str) -> Option<[INPUT; 2]> {
    let (scancode, extended) = match key {
        "left" => (0x4b, true),
        "right" => (0x4d, true),
        "up" => (0x48, true),
        "down" => (0x50, true),
        "backspace" => (0x0e, false),
        "enter" => (0x1c, false),
        "escape" => (0x01, false),
        "tab" => (0x0f, false),
        _ => return None,
    };
    let flags = KEYEVENTF_SCANCODE | if extended { KEYEVENTF_EXTENDEDKEY } else { 0 };
    let down = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wScan: scancode, dwFlags: flags, ..Default::default() } },
    };
    let mut up = down;
    unsafe { up.Anonymous.ki.dwFlags |= KEYEVENTF_KEYUP; }
    Some([down, up])
}

pub(crate) fn press_key(window: &WebviewWindow, mirror: &Mirror, key: &str) -> Result<(), &'static str> {
    if !mirror.options.control_enabled { return Err("mirrorActionFailed"); }
    let inputs = keyboard_inputs(key).ok_or("invalidArguments")?;
    let host = window.hwnd().map_err(|_| "mirrorFrameFailed")?.0 as HWND;
    let video = mirror.window();
    let session = log_session(host);
    let operation = NEXT_INPUT_OPERATION.fetch_add(1, Ordering::Relaxed);
    crate::control_log::record("cli.key_started", Some(&session), serde_json::json!({ "operation": operation, "key": key }));
    log_input("cli.input_before", host, video);
    unsafe {
        if GetForegroundWindow() != host || GetParent(video) != host
            || IsWindowVisible(video) == 0 || focused_child() != video
        {
            crate::control_log::record("cli.key_completed", Some(&session), serde_json::json!({ "operation": operation, "success": false, "error_code": "focusDenied" }));
            return Err("focusDenied");
        }
        // 同批提交按下和抬起，保持原始键盘输入的顺序。
        let sent = SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32);
        let mut release_sent = None;
        if sent != inputs.len() as u32 {
            if sent == 1 {
                // 部分提交时补发抬起，避免留下按住的按键。
                release_sent = Some(SendInput(1, &inputs[1], std::mem::size_of::<INPUT>() as i32) == 1);
            }
            crate::control_log::record("cli.key_completed", Some(&session), serde_json::json!({
                "operation": operation, "sent_count": sent, "success": false, "release_sent": release_sent,
                "error_code": "mirrorActionFailed",
            }));
            return Err("mirrorActionFailed");
        }
        crate::control_log::record("cli.key_completed", Some(&session), serde_json::json!({ "operation": operation, "sent_count": sent, "success": true }));
    }
    log_input("cli.input_after", host, video);
    Ok(())
}

pub(crate) fn drag_window(window: &WebviewWindow, dx: i32, dy: i32) -> Result<(), &'static str> {
    if (dx == 0 && dy == 0) || dx.unsigned_abs() > 500 || dy.unsigned_abs() > 500
        || window.is_fullscreen().unwrap_or(true) || window.is_maximized().unwrap_or(true)
    {
        return Err("invalidArguments");
    }
    let host = window.hwnd().map_err(|_| "mirrorFrameFailed")?.0 as HWND;
    let mut point = POINT { x: 28, y: 16 };
    let pause = |ms| std::thread::sleep(std::time::Duration::from_millis(ms));
    unsafe {
        if GetForegroundWindow() != host || ClientToScreen(host, &mut point) == 0
            || GetAncestor(WindowFromPoint(point), GA_ROOT) != host || SetCursorPos(point.x, point.y) == 0
        {
            return Err("focusDenied");
        }
        pause(60);
        if !send_mouse(MOUSEEVENTF_LEFTDOWN) {
            return Err("mirrorActionFailed");
        }
        pause(95);
        let moved = (1..=8).all(|step| {
            let ok = SetCursorPos(point.x + dx * step / 8, point.y + dy * step / 8) != 0;
            pause(24);
            ok
        });
        if !send_mouse(MOUSEEVENTF_LEFTUP) || !moved {
            return Err("mirrorActionFailed");
        }
    }
    Ok(())
}

pub(crate) fn click_video(window: &WebviewWindow, mirror: &Mirror, x: i32, y: i32) -> Result<(), &'static str> {
    if !mirror.options.control_enabled {
        return Err("mirrorActionFailed");
    }
    let host = window.hwnd().map_err(|_| "mirrorFrameFailed")?.0 as HWND;
    let video = mirror.window();
    let bounds = mirror.bounds.lock().map_err(|_| "mirrorFrameFailed")?.ok_or("windowPending")?;
    if x < 0 || y < 0 || x >= bounds.width || y >= bounds.height {
        return Err("invalidArguments");
    }
    if video_hit(host, bounds.x + x, bounds.y + y) != video {
        return Err("mirrorFrameFailed");
    }
    let mut point = POINT { x, y };
    unsafe {
        if ClientToScreen(video, &mut point) == 0
            || GetForegroundWindow() != host || WindowFromPoint(point) != video
            || SetCursorPos(point.x, point.y) == 0
        {
            return Err("focusDenied");
        }
        // Let the native player process pointer entry before issuing the button event.
        std::thread::sleep(std::time::Duration::from_millis(60));
        let mut cursor = POINT::default();
        if GetCursorPos(&mut cursor) == 0 || cursor.x != point.x || cursor.y != point.y
            || GetForegroundWindow() != host || WindowFromPoint(point) != video
        {
            return Err("focusDenied");
        }
        if !send_mouse(MOUSEEVENTF_LEFTDOWN) {
            return Err("mirrorActionFailed");
        }
        std::thread::sleep(std::time::Duration::from_millis(55));
        if !send_mouse(MOUSEEVENTF_LEFTUP) {
            return Err("mirrorActionFailed");
        }
    }
    Ok(())
}

pub(crate) fn click_toolbar(window: &WebviewWindow, mirror: &Mirror, x: i32, y: i32) -> Result<(), &'static str> {
    let host = window.hwnd().map_err(|_| "mirrorFrameFailed")?.0 as HWND;
    let video = mirror.window();
    let mut client = RECT::default();
    let mut point = POINT { x, y };
    unsafe {
        if GetClientRect(host, &mut client) == 0 { return Err("mirrorFrameFailed"); }
        if x < 0 || y < 0 || x >= client.right || y >= client.bottom {
            return Err("invalidArguments");
        }
        if GetForegroundWindow() != host || GetParent(video) != host
            || ClientToScreen(host, &mut point) == 0
        {
            return Err("focusDenied");
        }
        let hit = WindowFromPoint(point);
        if GetAncestor(hit, GA_ROOT) != host || hit == video || IsChild(video, hit) != 0 {
            return Err("focusDenied");
        }
        if SetCursorPos(point.x, point.y) == 0 { return Err("focusDenied"); }
        std::thread::sleep(std::time::Duration::from_millis(60));
        let mut cursor = POINT::default();
        let hit = WindowFromPoint(point);
        if GetCursorPos(&mut cursor) == 0 || cursor.x != point.x || cursor.y != point.y
            || GetForegroundWindow() != host || GetAncestor(hit, GA_ROOT) != host
            || hit == video || IsChild(video, hit) != 0
        {
            return Err("focusDenied");
        }
        if !send_mouse(MOUSEEVENTF_LEFTDOWN) { return Err("mirrorActionFailed"); }
        std::thread::sleep(std::time::Duration::from_millis(55));
        if !send_mouse(MOUSEEVENTF_LEFTUP) { return Err("mirrorActionFailed"); }
    }
    Ok(())
}

pub(crate) fn geometry(window: &WebviewWindow, video: HWND) -> Result<serde_json::Value, &'static str> {
    let host = window.hwnd().map_err(|_| "mirrorFrameFailed")?.0 as HWND;
    let mut rect = RECT::default();
    let mut shell = RECT::default();
    unsafe {
        if GetWindowRect(video, &mut rect) == 0 || GetWindowRect(host, &mut shell) == 0 {
            return Err("mirrorFrameFailed");
        }
        let mut origin = POINT::default();
        if ClientToScreen(host, &mut origin) == 0 {
            return Err("mirrorFrameFailed");
        }
        let hit = video_hit(host, (rect.left + rect.right) / 2 - origin.x, (rect.top + rect.bottom) / 2 - origin.y);
        let focus = focused_child();
        let focus_target = if focus.is_null() { "none" }
            else if focus == video { "video" }
            else if focus == host { "host" }
            else if IsChild(host, focus) != 0 { "shellChild" }
            else { "other" };
        Ok(serde_json::json!({
            "videoHit": hit == video,
            "videoFocused": focus == video,
            "foregroundHost": GetForegroundWindow() == host,
            "focusTarget": focus_target,
            "desktopVideoHit": WindowFromPoint(POINT { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 }) == video,
            "video": [rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top],
            "window": [shell.left, shell.top, shell.right - shell.left, shell.bottom - shell.top],
            "attached": GetParent(video) == host,
            "minimized": IsIconic(host) != 0,
            "videoVisible": IsWindowVisible(video) != 0 && IsIconic(host) == 0,
        }))
    }
}
