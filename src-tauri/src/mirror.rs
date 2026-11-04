use std::{
    io::{BufRead, BufReader, Read},
    process::{Child, Command, Stdio},
    collections::BTreeMap,
    fs,
    sync::{Arc, Mutex, atomic::{AtomicU32, AtomicU64, Ordering}},
};
use crate::profile::StartupPlacement;
use tauri::{Emitter, AppHandle, Manager, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use windows_sys::Win32::{
    Foundation::{GetLastError, HWND, POINT, RECT, SetLastError},
    Graphics::Gdi::{ClientToScreen, CreateRectRgn, CreateRoundRectRgn, DeleteObject, EqualRgn, GetWindowRgn, ScreenToClient, SetWindowRgn},
    System::Threading::{AttachThreadInput, GetCurrentThreadId},
    UI::Input::KeyboardAndMouse::{INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEINPUT, SendInput, SetFocus},
    UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
    UI::WindowsAndMessaging::{
        ChildWindowFromPointEx, CWP_SKIPINVISIBLE, CWP_SKIPTRANSPARENT, GWL_STYLE, GetAncestor, GA_ROOT, GetClientRect, GetCursorPos, GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId, GUITHREADINFO, GetParent, GetWindowRect, SetCursorPos, WindowFromPoint, IsWindowVisible, IsIconic, GetWindowLongPtrW, HWND_TOP, IsWindow, PostMessageW,
        SW_HIDE, SWP_ASYNCWINDOWPOS, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SetParent, SetWindowLongPtrW,
        SetWindowPos, ShowWindowAsync, WM_APP, WM_CLOSE, WM_EXITSIZEMOVE, WM_MOUSEMOVE, WM_MOVE, WM_NCDESTROY, WM_SIZE, WM_KEYDOWN, WM_KEYUP, WS_CHILD, WS_POPUP,
    },
};

#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
pub(crate) struct Placement {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

static PLACEMENTS: Mutex<()> = Mutex::new(());

fn placement_path(app: &AppHandle) -> Result<std::path::PathBuf, &'static str> {
    app.path().app_config_dir().map(|path| path.join("mirror-placement.json")).map_err(|_| "sessionError")
}

fn read_placements(path: &std::path::Path) -> BTreeMap<String, Placement> {
    fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

#[tauri::command]
pub(crate) fn last_mirror_placement(app: AppHandle, serial: String) -> Result<Option<Placement>, &'static str> {
    let key = serde_json::to_string(&(serial, Option::<String>::None)).map_err(|_| "sessionError")?;
    let _lock = PLACEMENTS.lock().map_err(|_| "sessionError")?;
    Ok(read_placements(&placement_path(&app)?).get(&key).copied())
}

fn restore_placement(shell: &WebviewWindow, key: &str, startup: StartupPlacement) {
    let saved = PLACEMENTS.lock().ok().and_then(|_lock| {
        let path = placement_path(shell.app_handle()).ok()?;
        read_placements(&path).get(key).copied()
    });
    let (Ok(default_pos), Ok(default_size)) = (shell.outer_position(), shell.inner_size()) else { return; };
    let Ok(monitors) = shell.available_monitors() else { return; };
    let visible = |placement: Placement| monitors.iter().any(|monitor| {
        let area = monitor.work_area();
        let left = i64::from(area.position.x);
        let top = i64::from(area.position.y);
        let x = i64::from(placement.x);
        let y = i64::from(placement.y);
        x + i64::from(placement.width) >= left + 100 && x <= left + i64::from(area.size.width) - 100
            && y >= top && y <= top + i64::from(area.size.height) - 38
    });
    let saved = saved.filter(|p| (150..=16384).contains(&p.width)
        && (150..=16384).contains(&p.height) && visible(*p));
    if saved.is_none() && startup.is_empty() {
        return;
    }
    let base = saved.unwrap_or(Placement {
        x: default_pos.x, y: default_pos.y, width: default_size.width, height: default_size.height,
    });
    let requested = Placement {
        x: startup.startup_x.unwrap_or(base.x),
        y: startup.startup_y.unwrap_or(base.y),
        width: startup.startup_width.unwrap_or(base.width),
        height: startup.startup_height.unwrap_or(base.height),
    };
    let position = if visible(requested) {
        Some((requested.x, requested.y))
    } else {
        saved.filter(|saved| visible(Placement { x: saved.x, y: saved.y, ..requested }))
            .map(|saved| (saved.x, saved.y))
    };
    let custom_size = startup.startup_width.is_some() || startup.startup_height.is_some();
    if custom_size {
        let _ = shell.set_min_size(Some(PhysicalSize::new(160, 310)));
    }
    if let Ok(hwnd) = shell.hwnd() {
        let hwnd = hwnd.0 as usize;
        let (x, y) = position.unwrap_or_default();
        let mut flags = SWP_NOACTIVATE | SWP_NOZORDER;
        if position.is_none() { flags |= SWP_NOMOVE; }
        if saved.is_none() && !custom_size { flags |= SWP_NOSIZE; }
        // Apply the complete physical rectangle before showing the undecorated window.
        let _ = shell.run_on_main_thread(move || unsafe {
            SetWindowPos(hwnd as HWND, std::ptr::null_mut(), x, y,
                requested.width as i32, requested.height as i32, flags);
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
    let parent = path.parent().ok_or("sessionError")?;
    fs::create_dir_all(parent).map_err(|_| "sessionError")?;
    let pending = path.with_extension("tmp");
    fs::write(&pending, serde_json::to_vec(&all).map_err(|_| "sessionError")?).map_err(|_| "sessionError")?;
    fs::rename(pending, path).map_err(|_| "sessionError")
}

static NEXT_WINDOW: AtomicU64 = AtomicU64::new(1);

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
    use super::texture_size;

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
    bounds: Arc<Mutex<Option<VideoBounds>>>,
}

impl Mirror {
    pub fn new(video: HWND, options: MirrorOptions, placement_key: String) -> Result<Self, &'static str> {
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
        .inner_size((height * ratio + 56.0).max(276.0), height + 38.0)
        .min_inner_size(160.0, 310.0)
        .always_on_top(mirror.options.top)
        .fullscreen(mirror.options.fullscreen)
        .visible(false)
        .build()
        .map_err(|_| "mirrorFrameFailed")?;
    let video = mirror.video;
    shell.on_window_event(move |event| {
        if matches!(event, WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed) {
            unsafe { PostMessageW(video as HWND, WM_CLOSE, 0, 0) };
        }
    });
    let host = shell.hwnd().map_err(|_| "mirrorFrameFailed")?.0 as HWND;
    if !attach(mirror.window(), host) {
        let _ = shell.destroy();
        return Err("mirrorFrameFailed");
    }
    install_move_handler(&shell, host, video)?;
    let app = app.clone();
    let label = mirror.label.clone();
    let host = host as usize;
    let bounds = mirror.bounds.clone();
    std::thread::spawn(move || {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_ESCAPE};
        let mut escape_was_down = false;
        let mut was_active = false;
        while unsafe { IsWindow(video as HWND) } != 0 {
            let foreground = unsafe { GetForegroundWindow() };
            let active = foreground == host as HWND;
            if !foreground.is_null() || unsafe { IsIconic(host as HWND) } != 0 {
                if was_active && !active {
                    let _ = app.emit_to(&label, &format!("mirror-blur-{label}"), ());
                }
                was_active = active;
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
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.destroy();
        }
    });
    if !mirror.options.fullscreen {
        restore_placement(&shell, &mirror.placement_key, mirror.options.startup);
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
            PostMessageW(video, WM_SIZE, 0, ((height << 16) | width) as isize);
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
    fn post(video: HWND, down: bool, key: usize, scan: usize, extended: bool) -> bool {
        let flags = 1 | (scan << 16) | (usize::from(extended) << 24) | if down { 0 } else { 3 << 30 };
        unsafe { PostMessageW(video, if down { WM_KEYDOWN } else { WM_KEYUP }, key, flags as isize) != 0 }
    }
    let ctrl_down = post(video, true, 0x11, 0x1d, true);
    let shift_down = !shift || post(video, true, 0x10, 0x2a, false);
    let key_down = post(video, true, key, scan, extended);
    let key_up = post(video, false, key, scan, extended);
    let shift_up = !shift || post(video, false, 0x10, 0x2a, false);
    let ctrl_up = post(video, false, 0x11, 0x1d, true);
    if ctrl_down && shift_down && key_down && key_up && shift_up && ctrl_up {
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
    unsafe {
        if GetForegroundWindow() != host || GetParent(video) != host || IsWindowVisible(video) == 0 {
            return false;
        }
        if focused_child() != video {
            let current_thread = GetCurrentThreadId();
            let video_thread = GetWindowThreadProcessId(video, std::ptr::null_mut());
            let attached = video_thread != 0 && current_thread != video_thread
                && AttachThreadInput(current_thread, video_thread, 1) != 0;
            SetFocus(video);
            if attached {
                AttachThreadInput(current_thread, video_thread, 0);
            }
        }
        focused_child() == video
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
    unsafe extern "system" fn on_message(
        host: HWND, message: u32, wparam: usize, lparam: isize, id: usize, video: usize,
    ) -> isize {
        if message == WM_NCDESTROY {
            unsafe { RemoveWindowSubclass(host, Some(on_message), id); }
        }
        let result = unsafe { DefSubclassProc(host, message, wparam, lparam) };
        if message == WM_EXITSIZEMOVE {
            // Run after the system's modal move loop gives up the title-bar focus.
            unsafe { PostMessageW(host, RESTORE_INPUT, 0, 0); }
        } else if message == RESTORE_INPUT {
            let video = video as HWND;
            unsafe {
                if GetParent(video) == host && IsWindowVisible(video) != 0 {
                    let mut origin = POINT::default();
                    let mut rect = RECT::default();
                    if ClientToScreen(video, &mut origin) != 0 && ScreenToClient(host, &mut origin) != 0 {
                        let coords = (origin.x as u16 as u32) | ((origin.y as u16 as u32) << 16);
                        PostMessageW(video, WM_MOVE, 0, coords as isize);
                    }
                    if GetClientRect(video, &mut rect) != 0 {
                        PostMessageW(video, WM_SIZE, 0, ((rect.bottom << 16) | rect.right) as isize);
                    }
                    focus_video(host, video);
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
        Ok(serde_json::json!({
            "videoHit": hit == video,
            "videoFocused": focused_child() == video,
            "desktopVideoHit": WindowFromPoint(POINT { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 }) == video,
            "video": [rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top],
            "window": [shell.left, shell.top, shell.right - shell.left, shell.bottom - shell.top],
            "attached": GetParent(video) == host,
            "minimized": IsIconic(host) != 0,
            "videoVisible": IsWindowVisible(video) != 0 && IsIconic(host) == 0,
        }))
    }
}
