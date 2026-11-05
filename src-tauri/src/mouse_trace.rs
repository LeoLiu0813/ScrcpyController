//! Read-only pointer diagnostics scoped to registered mirror windows.
//!
//! The global hook never changes or suppresses input. It snapshots native
//! coordinates before the player processes an event, then hands a small sample
//! to a bounded worker queue. SDL's internal state is deliberately not inferred.

use std::{
    cell::Cell,
    collections::BTreeMap,
    ptr,
    sync::{
        Arc, Mutex, OnceLock, RwLock,
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use serde_json::json;
use windows_sys::Win32::{
    Foundation::{GetLastError, HWND, POINT, RECT, WAIT_FAILED},
    Graphics::Gdi::ClientToScreen,
    System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
    UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GUITHREADINFO, GetClientRect, GetForegroundWindow,
        GetGUIThreadInfo, GetParent, GetWindowThreadProcessId, HC_ACTION, IsChild, IsWindow,
        LLMHF_INJECTED, LLMHF_LOWER_IL_INJECTED, MSG, MSLLHOOKSTRUCT, MWMO_INPUTAVAILABLE,
        MsgWaitForMultipleObjectsEx, PM_NOREMOVE, PM_REMOVE, PeekMessageW, PostThreadMessageW,
        QS_ALLINPUT, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, WH_MOUSE_LL,
        WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEHWHEEL, WM_MOUSEMOVE,
        WM_MOUSEWHEEL, WM_QUIT, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_XBUTTONDOWN, WM_XBUTTONUP,
        WindowFromPoint,
    },
};

const QUEUE_SIZE: usize = 512;
const STARTUP_TIMEOUT: Duration = Duration::from_millis(350);
const WORKER_POLL: Duration = Duration::from_millis(40);
static TRACE: OnceLock<Arc<Trace>> = OnceLock::new();

struct Trace {
    targets: RwLock<BTreeMap<usize, Arc<Target>>>,
    target_count: AtomicUsize,
    next_target: AtomicU64,
    sender: SyncSender<Sample>,
    queue_dropped: AtomicU64,
    registry_skipped: AtomicU64,
    sampling: AtomicBool,
    stopping: AtomicBool,
    hook_finished: AtomicBool,
    thread_id: AtomicU32,
    hook_thread: Mutex<Option<JoinHandle<()>>>,
    worker_thread: Mutex<Option<JoinHandle<()>>>,
}

struct Target {
    host: usize,
    video: usize,
    host_thread: u32,
    video_thread: u32,
    generation: u64,
    session: String,
    registered: AtomicBool,
}

#[derive(Clone, Copy, Default)]
struct Drag {
    host: usize,
    generation: u64,
    buttons: u8,
}

thread_local! {
    // Only the hook thread touches this state. No input-processing lock is held.
    static DRAG: Cell<Drag> = const { Cell::new(Drag { host: 0, generation: 0, buttons: 0 }) };
}

#[derive(Clone, Copy)]
struct ClientBox {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

struct Sample {
    target: Arc<Target>,
    message: u32,
    x: i32,
    y: i32,
    mouse_data: u32,
    flags: u32,
    event_time_ms: u32,
    sampled_at: Instant,
    host_box: Option<ClientBox>,
    video_box: Option<ClientBox>,
    hit_video: bool,
    captured_drag: bool,
    foreground: bool,
}

fn fail(stage: u32, code: u32, message: &str) -> String {
    crate::control_log::record(
        "input.trace_failed",
        None,
        json!({"source": "win_event", "result": "failed", "success": false, "stage": stage, "error_code": code}),
    );
    if code == 0 {
        message.to_owned()
    } else {
        format!("{message}（系统错误码 {code}）")
    }
}

/// Start a dedicated hook thread and a separate serialization worker.
/// Failure is returned to the caller and also added to the control log.
pub(crate) fn install() -> Result<(), String> {
    if let Some(trace) = TRACE.get() {
        return if trace.sampling.load(Ordering::Acquire) && !trace.stopping.load(Ordering::Acquire)
        {
            Ok(())
        } else {
            Err("鼠标控制日志尚未就绪或已停止。".into())
        };
    }
    let (sender, receiver) = mpsc::sync_channel(QUEUE_SIZE);
    let trace = Arc::new(Trace {
        targets: RwLock::new(BTreeMap::new()),
        target_count: AtomicUsize::new(0),
        next_target: AtomicU64::new(1),
        sender,
        queue_dropped: AtomicU64::new(0),
        registry_skipped: AtomicU64::new(0),
        sampling: AtomicBool::new(false),
        stopping: AtomicBool::new(false),
        hook_finished: AtomicBool::new(false),
        thread_id: AtomicU32::new(0),
        hook_thread: Mutex::new(None),
        worker_thread: Mutex::new(None),
    });
    if TRACE.set(trace.clone()).is_err() {
        return Err("鼠标控制日志正在启动，请勿重复初始化。".into());
    }
    let worker_state = trace.clone();
    let worker = thread::Builder::new()
        .name("mirror-pointer-log".into())
        .spawn(move || worker(worker_state, receiver))
        .map_err(|_| {
            trace.stopping.store(true, Ordering::Release);
            trace.hook_finished.store(true, Ordering::Release);
            fail(1, 0, "无法启动鼠标控制日志处理线程。")
        })?;
    if let Ok(mut handle) = trace.worker_thread.lock() {
        *handle = Some(worker);
    }

    let (ready_send, ready_receive) = mpsc::sync_channel(1);
    let hook_state = trace.clone();
    let hook = thread::Builder::new()
        .name("mirror-pointer-hook".into())
        .spawn(move || hook_loop(hook_state, ready_send))
        .map_err(|_| {
            trace.stopping.store(true, Ordering::Release);
            trace.hook_finished.store(true, Ordering::Release);
            fail(2, 0, "无法启动鼠标控制日志采样线程。")
        })?;
    if let Ok(mut handle) = trace.hook_thread.lock() {
        *handle = Some(hook);
    }

    match ready_receive.recv_timeout(STARTUP_TIMEOUT) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(code)) => {
            request_stop(&trace);
            Err(fail(3, code, "无法启用鼠标控制日志采样。"))
        }
        Err(_) => {
            // Do not join a slow-starting thread on the UI startup path.
            request_stop(&trace);
            Err(fail(4, 0, "鼠标控制日志采样启动超时。"))
        }
    }
}

/// Register only mirror-owned native handles. Session labels are anonymized by
/// control_log::record, and never appear directly in pointer event details.
pub(crate) fn register(host: usize, video: usize, session: String) -> bool {
    let Some(trace) = TRACE.get() else {
        return false;
    };
    if trace.stopping.load(Ordering::Acquire)
        || host == 0
        || video == 0
        || unsafe { IsWindow(host as HWND) == 0 || IsWindow(video as HWND) == 0 }
    {
        return false;
    }
    let mut host_process = 0;
    let host_thread = unsafe { GetWindowThreadProcessId(host as HWND, &mut host_process) };
    if host_process != std::process::id() || unsafe { GetParent(video as HWND) } as usize != host {
        return false;
    }
    let target = Arc::new(Target {
        host,
        video,
        host_thread,
        video_thread: unsafe { GetWindowThreadProcessId(video as HWND, ptr::null_mut()) },
        generation: trace.next_target.fetch_add(1, Ordering::Relaxed),
        session,
        registered: AtomicBool::new(true),
    });
    let Ok(mut targets) = trace.targets.write() else {
        return false;
    };
    if let Some(previous) = targets.insert(host, target) {
        previous.registered.store(false, Ordering::Release);
    }
    trace.target_count.store(targets.len(), Ordering::Release);
    true
}

pub(crate) fn unregister(host: usize) {
    let Some(trace) = TRACE.get() else { return };
    if let Ok(mut targets) = trace.targets.write() {
        if let Some(target) = targets.remove(&host) {
            target.registered.store(false, Ordering::Release);
        }
        trace.target_count.store(targets.len(), Ordering::Release);
    }
}

fn request_stop(trace: &Trace) {
    trace.sampling.store(false, Ordering::Release);
    trace.stopping.store(true, Ordering::Release);
    let thread = trace.thread_id.load(Ordering::Acquire);
    if thread != 0 {
        unsafe {
            PostThreadMessageW(thread, WM_QUIT, 0, 0);
        }
    }
}

/// Stop sampling and allow at most 450ms for unhooking and draining. Slow
/// background threads detach rather than holding up application shutdown.
/// Call before flushing the control log during normal application shutdown.
pub(crate) fn shutdown() {
    let Some(trace) = TRACE.get() else { return };
    request_stop(trace);
    let hook = trace
        .hook_thread
        .try_lock()
        .ok()
        .and_then(|mut handle| handle.take());
    let worker = trace
        .worker_thread
        .try_lock()
        .ok()
        .and_then(|mut handle| handle.take());
    let handles: Vec<_> = [hook, worker].into_iter().flatten().collect();
    let deadline = Instant::now() + Duration::from_millis(450);
    while handles.iter().any(|handle| !handle.is_finished()) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    let unfinished = handles
        .iter()
        .filter(|handle| !handle.is_finished())
        .count();
    for handle in handles {
        if handle.is_finished() {
            let _ = handle.join();
        }
        // Dropping an unfinished JoinHandle detaches it. The stopping flag
        // still makes its bounded message/receive loops exit naturally.
    }
    if unfinished != 0 {
        crate::control_log::record(
            "input.trace_failed",
            None,
            json!({
                "source": "win_event", "success": false, "result": "timeout",
                "stage": 7, "unfinished_threads": unfinished,
            }),
        );
    }
    if let Ok(mut targets) = trace.targets.try_write() {
        for target in targets.values() {
            target.registered.store(false, Ordering::Release);
        }
        targets.clear();
        trace.target_count.store(0, Ordering::Release);
    }
}

fn hook_loop(trace: Arc<Trace>, ready: SyncSender<Result<(), u32>>) {
    let mut message = MSG::default();
    unsafe {
        PeekMessageW(&mut message, ptr::null_mut(), 0, 0, PM_NOREMOVE);
    }
    trace
        .thread_id
        .store(unsafe { GetCurrentThreadId() }, Ordering::Release);
    if trace.stopping.load(Ordering::Acquire) {
        trace.hook_finished.store(true, Ordering::Release);
        let _ = ready.try_send(Err(0));
        return;
    }
    let module = unsafe { GetModuleHandleW(ptr::null()) };
    let hook = unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), module, 0) };
    if hook.is_null() {
        let code = unsafe { GetLastError() };
        trace.stopping.store(true, Ordering::Release);
        trace.hook_finished.store(true, Ordering::Release);
        let _ = ready.try_send(Err(code));
        return;
    }
    trace.sampling.store(true, Ordering::Release);
    let _ = ready.try_send(Ok(()));
    crate::control_log::record(
        "input.trace_started",
        None,
        json!({"source": "win_event", "queue_capacity": QUEUE_SIZE, "readonly": true}),
    );

    while !trace.stopping.load(Ordering::Acquire) {
        // The bounded wait also guarantees shutdown if posting WM_QUIT fails.
        let wait = unsafe {
            MsgWaitForMultipleObjectsEx(0, ptr::null(), 40, QS_ALLINPUT, MWMO_INPUTAVAILABLE)
        };
        if wait == WAIT_FAILED {
            let _ = fail(5, unsafe { GetLastError() }, "鼠标控制日志消息循环失败。");
            break;
        }
        while !trace.stopping.load(Ordering::Acquire)
            && unsafe { PeekMessageW(&mut message, ptr::null_mut(), 0, 0, PM_REMOVE) } != 0
        {
            if message.message == WM_QUIT {
                trace.stopping.store(true, Ordering::Release);
                break;
            }
            unsafe {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }
    trace.sampling.store(false, Ordering::Release);
    if unsafe { UnhookWindowsHookEx(hook) } == 0 {
        let _ = fail(6, unsafe { GetLastError() }, "鼠标控制日志钩子卸载失败。");
    }
    trace.stopping.store(true, Ordering::Release);
    trace.hook_finished.store(true, Ordering::Release);
    crate::control_log::record("input.trace_stopped", None, json!({"source": "win_event"}));
}

unsafe extern "system" fn mouse_hook(code: i32, wparam: usize, lparam: isize) -> isize {
    if code == HC_ACTION as i32 && lparam != 0 {
        if let Some(trace) = TRACE.get() {
            if trace.sampling.load(Ordering::Relaxed)
                && !trace.stopping.load(Ordering::Relaxed)
                && crate::control_log::enabled()
                && trace.target_count.load(Ordering::Relaxed) != 0
            {
                let event = unsafe { &*(lparam as *const MSLLHOOKSTRUCT) };
                collect(trace, wparam as u32, event);
            } else {
                DRAG.with(|drag| drag.set(Drag::default()));
            }
        }
    }
    // Never suppress, inject, modify, or delay the next hook's input delivery.
    unsafe { CallNextHookEx(ptr::null_mut(), code, wparam, lparam) }
}

fn belongs(window: HWND, parent: usize) -> bool {
    !window.is_null()
        && (window as usize == parent || unsafe { IsChild(parent as HWND, window) } != 0)
}

fn captures_pointer(target: &Target) -> bool {
    [target.host_thread, target.video_thread]
        .into_iter()
        .filter(|thread| *thread != 0)
        .any(|thread| {
            let mut state = GUITHREADINFO {
                cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
                ..Default::default()
            };
            (unsafe { GetGUIThreadInfo(thread, &mut state) != 0 })
                && (belongs(state.hwndCapture, target.host)
                    || belongs(state.hwndCapture, target.video))
        })
}

fn client_box(window: usize) -> Option<ClientBox> {
    let mut rect = RECT::default();
    let mut origin = POINT::default();
    if unsafe {
        GetClientRect(window as HWND, &mut rect) == 0
            || ClientToScreen(window as HWND, &mut origin) == 0
    } {
        return None;
    }
    Some(ClientBox {
        x: origin.x,
        y: origin.y,
        width: rect.right.saturating_sub(rect.left),
        height: rect.bottom.saturating_sub(rect.top),
    })
}

fn button_change(message: u32, mouse_data: u32) -> Option<(u8, bool)> {
    match message {
        WM_LBUTTONDOWN => Some((1, true)),
        WM_LBUTTONUP => Some((1, false)),
        WM_RBUTTONDOWN => Some((2, true)),
        WM_RBUTTONUP => Some((2, false)),
        WM_MBUTTONDOWN => Some((4, true)),
        WM_MBUTTONUP => Some((4, false)),
        WM_XBUTTONDOWN | WM_XBUTTONUP => {
            let bit = match mouse_data >> 16 {
                1 => 8,
                2 => 16,
                _ => return None,
            };
            Some((bit, message == WM_XBUTTONDOWN))
        }
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Scope {
    Direct,
    Captured,
    Excluded,
}

fn pointer_scope(
    hit_owned: bool,
    buttons: u8,
    same_registration: bool,
    owns_capture: bool,
) -> Scope {
    if buttons != 0 && same_registration && owns_capture {
        Scope::Captured
    } else if hit_owned {
        Scope::Direct
    } else {
        Scope::Excluded
    }
}

fn relative_point(x: i32, y: i32, rect: ClientBox) -> (i64, i64) {
    (
        i64::from(x) - i64::from(rect.x),
        i64::from(y) - i64::from(rect.y),
    )
}

fn normalized_point(x: i32, y: i32, rect: ClientBox) -> Option<(f64, f64)> {
    if rect.width <= 0 || rect.height <= 0 {
        return None;
    }
    Some((
        (f64::from(x) - f64::from(rect.x)) / f64::from(rect.width),
        (f64::from(y) - f64::from(rect.y)) / f64::from(rect.height),
    ))
}

fn collect(trace: &Trace, message: u32, event: &MSLLHOOKSTRUCT) {
    if !matches!(
        message,
        WM_MOUSEMOVE
            | WM_LBUTTONDOWN
            | WM_LBUTTONUP
            | WM_RBUTTONDOWN
            | WM_RBUTTONUP
            | WM_MBUTTONDOWN
            | WM_MBUTTONUP
            | WM_XBUTTONDOWN
            | WM_XBUTTONUP
            | WM_MOUSEWHEEL
            | WM_MOUSEHWHEEL
    ) {
        return;
    }
    let change = button_change(message, event.mouseData);
    let mut drag = DRAG.with(Cell::get);
    let Ok(targets) = trace.targets.try_read() else {
        trace.registry_skipped.fetch_add(1, Ordering::Relaxed);
        DRAG.with(|state| state.set(Drag::default()));
        return;
    };
    let hit = unsafe { WindowFromPoint(event.pt) };
    let direct = targets.values().find(|target| {
        pointer_scope(
            belongs(hit, target.host) || belongs(hit, target.video),
            0,
            false,
            false,
        ) == Scope::Direct
    });
    let captured = if drag.buttons != 0 {
        targets.get(&drag.host).filter(|target| {
            pointer_scope(
                false,
                drag.buttons,
                target.generation == drag.generation,
                captures_pointer(target),
            ) == Scope::Captured
        })
    } else {
        None
    };
    // Capture owns input delivery even when a drag crosses another registered
    // mirror. Keep its session and geometry until its mouse button is released.
    let accepted = captured.or(direct).filter(|target| {
        let mut host_process = 0;
        target.registered.load(Ordering::Relaxed)
            && unsafe { GetWindowThreadProcessId(target.host as HWND, &mut host_process) }
                == target.host_thread
            && host_process == std::process::id()
            && unsafe { GetParent(target.video as HWND) } as usize == target.host
    });
    let selected = accepted.map(Arc::clone);
    let captured_drag = selected.as_ref().is_some_and(|target| {
        captured.is_some() && !belongs(hit, target.host) && !belongs(hit, target.video)
    });
    drop(targets);

    if let Some((bit, pressed)) = change {
        if pressed {
            if let Some(target) = selected.as_ref() {
                if drag.host != target.host || drag.generation != target.generation {
                    drag = Drag::default();
                }
                drag.host = target.host;
                drag.generation = target.generation;
                drag.buttons |= bit;
            }
        } else {
            drag.buttons &= !bit;
            if drag.buttons == 0 {
                drag = Drag::default();
            }
        }
        DRAG.with(|state| state.set(drag));
    }
    let Some(target) = selected else { return };
    // No coordinates from unrelated applications are retained. An off-window
    // point is accepted only while this registered target still owns capture.
    let sample = Sample {
        host_box: client_box(target.host),
        video_box: client_box(target.video),
        hit_video: belongs(hit, target.video),
        captured_drag,
        foreground: unsafe { GetForegroundWindow() } as usize == target.host,
        target,
        message,
        x: event.pt.x,
        y: event.pt.y,
        mouse_data: event.mouseData,
        flags: event.flags,
        event_time_ms: event.time,
        sampled_at: Instant::now(),
    };
    match trace.sender.try_send(sample) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) => {
            trace.queue_dropped.fetch_add(1, Ordering::Relaxed);
        }
        Err(TrySendError::Disconnected(_)) => {
            trace.stopping.store(true, Ordering::Release);
        }
    }
}

fn report_dropped(trace: &Trace) {
    let queue = trace.queue_dropped.swap(0, Ordering::Relaxed);
    let registry = trace.registry_skipped.swap(0, Ordering::Relaxed);
    if queue != 0 || registry != 0 {
        crate::control_log::record(
            "input.trace_dropped",
            None,
            json!({"source": "win_event", "count": queue.saturating_add(registry),
                "queue_dropped": queue, "registry_skipped": registry}),
        );
    }
}

fn worker(trace: Arc<Trace>, receiver: Receiver<Sample>) {
    let mut last_report = Instant::now();
    loop {
        match receiver.recv_timeout(WORKER_POLL) {
            Ok(sample) => {
                // Registration was verified when this event was sampled. An
                // unregister must not erase the gesture's already queued up.
                if crate::control_log::enabled() {
                    write_sample(sample);
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if trace.stopping.load(Ordering::Acquire)
                    && trace.hook_finished.load(Ordering::Acquire)
                {
                    report_dropped(&trace);
                    return;
                }
            }
            Err(RecvTimeoutError::Disconnected) => return,
        }
        // A saturated input queue must not amplify its own backlog by emitting
        // a separate loss report for every pointer sample.
        if last_report.elapsed() >= Duration::from_millis(250) {
            report_dropped(&trace);
            last_report = Instant::now();
        }
    }
}

fn write_sample(sample: Sample) {
    let host_point = sample
        .host_box
        .map(|rect| relative_point(sample.x, sample.y, rect));
    let video_point = sample
        .video_box
        .map(|rect| relative_point(sample.x, sample.y, rect));
    let normalized = sample
        .video_box
        .and_then(|rect| normalized_point(sample.x, sample.y, rect));
    let inside_video = sample
        .video_box
        .zip(video_point)
        .is_some_and(|(rect, (x, y))| {
            x >= 0 && y >= 0 && x < i64::from(rect.width) && y < i64::from(rect.height)
        });
    let mut detail = json!({
        "source": "win_event", "event_time_ms": sample.event_time_ms,
        "processing_delay_us": sample.sampled_at.elapsed().as_micros().min(u128::from(u64::MAX)) as u64,
        "screen_x": sample.x, "screen_y": sample.y,
        "client_x": host_point.map(|point| point.0), "client_y": host_point.map(|point| point.1),
        "video_x": video_point.map(|point| point.0), "video_y": video_point.map(|point| point.1),
        "normalized_x": normalized.map(|point| point.0), "normalized_y": normalized.map(|point| point.1),
        "video_width": sample.video_box.map(|rect| rect.width), "video_height": sample.video_box.map(|rect| rect.height),
        "target": if sample.captured_drag { "outside" } else if sample.hit_video { "video" } else { "host" },
        "inside_video": inside_video, "captured_drag": sample.captured_drag, "foreground": sample.foreground,
        "injected": sample.flags & LLMHF_INJECTED != 0,
        "lower_integrity_injected": sample.flags & LLMHF_LOWER_IL_INJECTED != 0,
        "geometry_sampled_in_hook": true, "player_processing_observed": false,
        "normalization_basis": "client",
    });
    let name = if sample.message == WM_MOUSEMOVE {
        "input.pointer_move"
    } else if matches!(sample.message, WM_MOUSEWHEEL | WM_MOUSEHWHEEL) {
        detail["wheel_delta"] = json!((sample.mouse_data >> 16) as u16 as i16);
        detail["horizontal"] = json!(sample.message == WM_MOUSEHWHEEL);
        "input.pointer_wheel"
    } else {
        if let Some((bit, pressed)) = button_change(sample.message, sample.mouse_data) {
            detail["button"] = json!(match bit {
                1 => "left",
                2 => "right",
                4 => "middle",
                8 => "x1",
                _ => "x2",
            });
            detail["pressed"] = json!(pressed);
        }
        "input.pointer_button"
    };
    crate::control_log::record(name, Some(&sample.target.session), detail);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn button_changes_keep_both_edges_and_disambiguate_x_buttons() {
        for (down, up, bit) in [
            (WM_LBUTTONDOWN, WM_LBUTTONUP, 1),
            (WM_RBUTTONDOWN, WM_RBUTTONUP, 2),
            (WM_MBUTTONDOWN, WM_MBUTTONUP, 4),
        ] {
            assert_eq!(button_change(down, 0), Some((bit, true)));
            assert_eq!(button_change(up, 0), Some((bit, false)));
        }
        assert_eq!(button_change(WM_XBUTTONDOWN, 1 << 16), Some((8, true)));
        assert_eq!(button_change(WM_XBUTTONUP, 1 << 16), Some((8, false)));
        assert_eq!(button_change(WM_XBUTTONDOWN, 2 << 16), Some((16, true)));
        assert_eq!(button_change(WM_XBUTTONUP, 2 << 16), Some((16, false)));
        assert_eq!(button_change(WM_XBUTTONDOWN, 3 << 16), None);
        assert_eq!(button_change(WM_MOUSEMOVE, 0), None);
        assert_eq!(button_change(WM_MOUSEWHEEL, 120 << 16), None);
    }

    #[test]
    fn negative_monitor_origins_preserve_client_and_relative_coordinates() {
        let rect = ClientBox {
            x: -2000,
            y: -1000,
            width: 400,
            height: 800,
        };
        assert_eq!(relative_point(-1800, -900, rect), (200, 100));
        assert_eq!(normalized_point(-1800, -900, rect), Some((0.5, 0.125)));
        assert_eq!(normalized_point(-2040, -40, rect), Some((-0.1, 1.2)));
        assert_eq!(
            relative_point(
                i32::MAX,
                i32::MAX,
                ClientBox {
                    x: i32::MIN,
                    y: i32::MIN,
                    width: 1,
                    height: 1
                }
            ),
            (4_294_967_295, 4_294_967_295)
        );
        assert_eq!(normalized_point(0, 0, ClientBox { width: 0, ..rect }), None);
        assert_eq!(
            normalized_point(0, 0, ClientBox { height: -1, ..rect }),
            None
        );
    }

    #[test]
    fn unrelated_positions_need_an_active_same_registration_capture() {
        assert_eq!(pointer_scope(false, 0, false, false), Scope::Excluded);
        assert_eq!(pointer_scope(false, 0, true, true), Scope::Excluded);
        assert_eq!(pointer_scope(false, 1, false, true), Scope::Excluded);
        assert_eq!(pointer_scope(false, 1, true, false), Scope::Excluded);
        assert_eq!(pointer_scope(false, 1, true, true), Scope::Captured);
        assert_eq!(pointer_scope(true, 0, false, false), Scope::Direct);
        // If a captured drag crosses another app-owned window, the original
        // capture still wins, rather than falsely changing the event's session.
        assert_eq!(pointer_scope(true, 1, true, true), Scope::Captured);
    }
}
