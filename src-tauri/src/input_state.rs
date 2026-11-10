//! 将嵌入播放器遗漏的修饰键抬起同步到原窗口，不生成按下或鼠标消息。

use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, OnceLock, TryLockError, atomic::{AtomicBool, AtomicU64, Ordering}},
};
use windows_sys::Win32::{
    Foundation::HWND,
    UI::{
        Input::KeyboardAndMouse::GetAsyncKeyState,
        WindowsAndMessaging::{GetParent, GetWindowThreadProcessId, IsWindow, PostMessageW, WM_KEYUP, WM_SYSKEYUP},
    },
};

const ALL_MODIFIERS: u16 = 0xff;
const FAILURE: &str = "mirrorActionFailed";

#[derive(Clone, Copy)]
struct Modifier {
    physical_key: i32,
    message_key: usize,
    scan: usize,
    extended: bool,
    system_key: bool,
}

// 位图顺序与窗口控制日志一致：左右控制、左右上档、左右交替、左右系统键。
const MODIFIERS: [Modifier; 8] = [
    Modifier { physical_key: 0xa2, message_key: 0xa2, scan: 0x1d, extended: false, system_key: false },
    Modifier { physical_key: 0xa3, message_key: 0xa3, scan: 0x1d, extended: true, system_key: false },
    Modifier { physical_key: 0xa0, message_key: 0xa0, scan: 0x2a, extended: false, system_key: false },
    Modifier { physical_key: 0xa1, message_key: 0xa1, scan: 0x36, extended: false, system_key: false },
    Modifier { physical_key: 0xa4, message_key: 0xa4, scan: 0x38, extended: false, system_key: true },
    Modifier { physical_key: 0xa5, message_key: 0xa5, scan: 0x38, extended: true, system_key: true },
    Modifier { physical_key: 0x5b, message_key: 0x5b, scan: 0x5b, extended: true, system_key: false },
    Modifier { physical_key: 0x5c, message_key: 0x5c, scan: 0x5c, extended: true, system_key: false },
];

impl Modifier {
    fn release_message(self) -> (u32, usize, isize) {
        let flags = 1usize | (self.scan << 16) | (usize::from(self.extended) << 24)
            | (usize::from(self.system_key) << 29) | (3usize << 30);
        (if self.system_key { WM_SYSKEYUP } else { WM_KEYUP }, self.message_key, flags as isize)
    }
}

#[derive(Default)]
struct State {
    last_system: u16,
    retry: u16,
}

struct Target {
    generation: u64,
    host: usize,
    video: usize,
    host_thread: u32,
    video_thread: u32,
    video_process: u32,
    session: String,
    active: AtomicBool,
    pending_force: AtomicBool,
    state: Mutex<State>,
}

impl Target {
    fn valid(&self) -> bool {
        if !self.active.load(Ordering::Acquire) { return false; }
        let host = self.host as HWND;
        let video = self.video as HWND;
        unsafe {
            if IsWindow(host) == 0 || IsWindow(video) == 0 || GetParent(video) != host { return false; }
            let mut owner = 0;
            if GetWindowThreadProcessId(host, &mut owner) != self.host_thread || owner != std::process::id() { return false; }
            GetWindowThreadProcessId(video, &mut owner) == self.video_thread && owner == self.video_process
        }
    }
}

static TARGETS: OnceLock<Mutex<BTreeMap<usize, Arc<Target>>>> = OnceLock::new();
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

fn targets() -> &'static Mutex<BTreeMap<usize, Arc<Target>>> {
    TARGETS.get_or_init(Mutex::default)
}

fn target(host: usize) -> Option<Arc<Target>> {
    target_owned(host, None)
}

fn matching_target(all: &BTreeMap<usize, Arc<Target>>, host: usize, generation: Option<u64>) -> Option<Arc<Target>> {
    all.get(&host).filter(|target| generation.is_none_or(|generation| target.generation == generation)).cloned()
}

fn target_owned(host: usize, generation: Option<u64>) -> Option<Arc<Target>> {
    matching_target(&targets().lock().unwrap_or_else(|error| error.into_inner()), host, generation)
}

fn unregister_generation(all: &mut BTreeMap<usize, Arc<Target>>, host: usize, generation: u64) {
    if all.get(&host).is_some_and(|target| target.generation == generation)
        && let Some(target) = all.remove(&host)
    {
        // 旧轮询即便仍持有共享引用，也不能继续向已注销的窗口发送消息。
        target.active.store(false, Ordering::Release);
    }
}

fn system_modifiers() -> u16 {
    MODIFIERS.iter().enumerate().fold(0, |mask, (index, key)| {
        mask | if unsafe { GetAsyncKeyState(key.physical_key) } < 0 { 1 << index } else { 0 }
    })
}

#[derive(Default, Clone, Copy, serde::Serialize)]
pub(crate) struct SyncReport {
    pub system_modifiers: u16,
    pub requested: u16,
    /// 已入队的抬起位图；不代表播放器已经消费。
    pub released: u16,
    pub failed: u16,
    pub held: u16,
    pub deferred: bool,
    pub registered: bool,
    pub player_processing_observed: bool,
}

pub(crate) fn register(host: usize, video: usize, session: String) -> Option<u64> {
    let mut host_process = 0;
    let mut video_process = 0;
    let host_thread = unsafe { GetWindowThreadProcessId(host as HWND, &mut host_process) };
    let video_thread = unsafe { GetWindowThreadProcessId(video as HWND, &mut video_process) };
    if host == 0 || video == 0 || host == video || host_thread == 0 || video_thread == 0
        || host_process != std::process::id() || video_process == 0
        || unsafe { GetParent(video as HWND) } != host as HWND
    { return None; }
    let mut all = targets().lock().unwrap_or_else(|error| error.into_inner());
    if let Some(previous) = all.get(&host) {
        if previous.video == video && previous.video_thread == video_thread
            && previous.video_process == video_process && previous.session == session && previous.valid()
        { return Some(previous.generation); }
        previous.active.store(false, Ordering::Release);
    }
    let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
    all.insert(host, Arc::new(Target {
        generation, host, video, host_thread, video_thread, video_process, session,
        active: AtomicBool::new(true), pending_force: AtomicBool::new(true),
        state: Mutex::new(State { last_system: system_modifiers(), retry: 0 }),
    }));
    Some(generation)
}

pub(crate) fn unregister(host: usize, generation: u64) {
    unregister_generation(&mut targets().lock().unwrap_or_else(|error| error.into_inner()), host, generation);
}

fn serialized<T>(target: &Target, valid: impl FnOnce() -> bool, operation: impl FnOnce() -> T) -> Result<T, &'static str> {
    let _state = target.state.lock().unwrap_or_else(|error| {
        target.pending_force.store(true, Ordering::Release);
        target.state.clear_poison();
        error.into_inner()
    });
    if !target.active.load(Ordering::Acquire) || !valid() { return Err(FAILURE); }
    Ok(operation())
}

pub(crate) fn serialize<T>(host: HWND, video: HWND, operation: impl FnOnce() -> T) -> Result<T, &'static str> {
    let target = target(host as usize).ok_or(FAILURE)?;
    if target.video != video as usize { return Err(FAILURE); }
    serialized(&target, || target.valid(), operation)
}

fn synchronize_state(
    state: &mut State, system: u16, force: bool,
    mut held: impl FnMut(Modifier) -> bool,
    mut valid: impl FnMut() -> bool,
    mut post: impl FnMut(Modifier) -> bool,
) -> SyncReport {
    let requested = ((if force { ALL_MODIFIERS } else { state.last_system }) | state.retry)
        & !system & ALL_MODIFIERS;
    let mut report = SyncReport { system_modifiers: system, requested, registered: true, ..Default::default() };
    state.last_system = system;
    let previous_retry = state.retry;
    for (index, key) in MODIFIERS.iter().copied().enumerate() {
        let bit = 1 << index;
        if requested & bit == 0 { continue; }
        if !valid() {
            report.registered = false;
            report.failed |= requested & !report.released & !report.held;
            break;
        }
        // 读取计划与投递之间可能重新按键，再逐键确认，保留用户的真实组合操作。
        if held(key) {
            report.held |= bit;
            report.system_modifiers |= bit;
            state.last_system |= bit;
            continue;
        }
        if post(key) { report.released |= bit; } else { report.failed |= bit; }
    }
    state.retry = (previous_retry & report.system_modifiers) | report.failed;
    report
}

fn try_synchronize(
    target: &Target, system: u16, force: bool,
    held: impl FnMut(Modifier) -> bool,
    mut valid: impl FnMut() -> bool,
    post: impl FnMut(Modifier) -> bool,
) -> (SyncReport, bool) {
    if !target.active.load(Ordering::Acquire) || !valid() {
        return (SyncReport { system_modifiers: system, ..Default::default() }, false);
    }
    let mut state = match target.state.try_lock() {
        Ok(state) => state,
        Err(TryLockError::WouldBlock) => {
            let first_deferred = !target.pending_force.swap(true, Ordering::AcqRel);
            return (SyncReport { system_modifiers: system, requested: if force { !system & ALL_MODIFIERS } else { 0 },
                deferred: true, registered: true, ..Default::default() }, first_deferred);
        }
        Err(TryLockError::Poisoned(error)) => {
            target.pending_force.store(true, Ordering::Release);
            target.state.clear_poison();
            error.into_inner()
        }
    };
    let force = force | target.pending_force.swap(false, Ordering::AcqRel);
    let report = synchronize_state(&mut state, system, force, held,
        || target.active.load(Ordering::Acquire) && valid(), post);
    (report, report.requested != 0 || report.failed != 0)
}

pub(crate) fn synchronize(host: HWND, reason: &'static str, force: bool) -> SyncReport {
    synchronize_registration(host, None, reason, force)
}

pub(crate) fn synchronize_owned(host: HWND, generation: u64, reason: &'static str, force: bool) -> SyncReport {
    synchronize_registration(host, Some(generation), reason, force)
}

fn synchronize_registration(host: HWND, generation: Option<u64>, reason: &'static str, force: bool) -> SyncReport {
    let system = system_modifiers();
    let Some(target) = target_owned(host as usize, generation) else {
        return SyncReport { system_modifiers: system, ..Default::default() };
    };
    let (report, log) = try_synchronize(&target, system, force,
        |key| unsafe { GetAsyncKeyState(key.physical_key) < 0 },
        || target.valid(),
        |key| {
            let (message, wparam, lparam) = key.release_message();
            unsafe { PostMessageW(target.video as HWND, message, wparam, lparam) != 0 }
        });
    if log {
        let reason = match reason {
            "native_poll" | "host_message" | "focus" | "foreground" | "background" | "cli" | "requested"
                | "poll" | "activated" | "deactivated" | "manual" => reason,
            _ => "unknown",
        };
        let mut detail = serde_json::to_value(report).unwrap_or_default();
        detail["reason"] = serde_json::json!(reason);
        crate::control_log::record("input.modifiers_synchronized", Some(&target.session), detail);
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn test_target(system: u16) -> Arc<Target> {
        Arc::new(Target { generation: NEXT_GENERATION.fetch_add(1, Ordering::Relaxed),
            host: 1, video: 2, host_thread: 1, video_thread: 2, video_process: 3,
            session: "test".into(), active: AtomicBool::new(true), pending_force: AtomicBool::new(false),
            state: Mutex::new(State { last_system: system, retry: 0 }) })
    }

    #[test]
    fn physically_held_modifiers_are_never_released() {
        let mut state = State { last_system: 1, retry: 0 };
        let mut sent = Vec::new();
        let report = synchronize_state(&mut state, 1, true, |_| false, || true,
            |key| { sent.push(key.physical_key); true });
        assert_eq!(report.requested, 0xfe);
        assert!(!sent.contains(&0xa2));
        assert_eq!(report.released, 0xfe);
        let report = synchronize_state(&mut state, 0, false, |key| key.physical_key == 0xa2, || true,
            |_| panic!("重新按住的控制键不能被补发抬起"));
        assert_eq!(report.held, 1);
        assert_eq!(report.system_modifiers, 1);
    }

    #[test]
    fn release_outside_the_player_is_delivered_without_a_focus_requirement() {
        let mut state = State { last_system: 1, retry: 0 };
        let mut sent = Vec::new();
        let report = synchronize_state(&mut state, 0, false, |_| false, || true,
            |key| { sent.push(key.physical_key); true });
        assert_eq!(sent, [0xa2]);
        assert_eq!(report.released, 1);
        assert!(!report.player_processing_observed);
        let report = synchronize_state(&mut state, 0, false, |_| false, || true,
            |_| panic!("没有释放变化时不能重复发送"));
        assert_eq!(report.requested, 0);
    }

    #[test]
    fn left_and_right_release_messages_have_matching_scancodes_and_extended_bits() {
        for (key, (virtual_key, scan, extended)) in MODIFIERS.into_iter().zip([
            (0xa2, 0x1d, false), (0xa3, 0x1d, true),
            (0xa0, 0x2a, false), (0xa1, 0x36, false),
            (0xa4, 0x38, false), (0xa5, 0x38, true),
            (0x5b, 0x5b, true), (0x5c, 0x5c, true),
        ]) {
            let (message, actual_key, flags) = key.release_message();
            assert_eq!(actual_key, virtual_key);
            assert_eq!((flags as usize >> 16) & 0xff, scan);
            assert_eq!((flags as usize >> 24) & 1, usize::from(extended));
            assert_eq!((flags as usize >> 30) & 3, 3);
            assert_eq!(message, if key.system_key { WM_SYSKEYUP } else { WM_KEYUP });
        }
    }

    #[test]
    fn failed_releases_are_retried_even_when_the_system_state_does_not_change() {
        let mut state = State { last_system: 1, retry: 0 };
        let failed = synchronize_state(&mut state, 0, false, |_| false, || true, |_| false);
        assert_eq!(failed.failed, 1);
        assert_eq!(state.retry, 1);
        let retried = synchronize_state(&mut state, 0, false, |_| false, || true, |_| true);
        assert_eq!(retried.released, 1);
        assert_eq!(state.retry, 0);
    }

    #[test]
    fn cleanup_cannot_interleave_with_a_shortcut_and_deferred_force_is_retried() {
        let target = test_target(0xfe);
        let sequence = Arc::new(Mutex::new(Vec::new()));
        let (started_send, started_receive) = mpsc::channel();
        let (finish_send, finish_receive) = mpsc::channel();
        let worker_target = target.clone();
        let worker_sequence = sequence.clone();
        let worker = std::thread::spawn(move || {
            serialized(&worker_target, || true, || {
                worker_sequence.lock().unwrap().push("control_down");
                started_send.send(()).unwrap();
                finish_receive.recv().unwrap();
                worker_sequence.lock().unwrap().extend(["letter", "control_up"]);
            }).unwrap();
        });
        started_receive.recv().unwrap();
        let (deferred, _) = try_synchronize(&target, 0xfe, true, |_| false, || true,
            |_| panic!("快捷组合尚未排完，不能插入同步消息"));
        assert!(deferred.deferred);
        assert_eq!(*sequence.lock().unwrap(), ["control_down"]);
        finish_send.send(()).unwrap();
        worker.join().unwrap();
        let (completed, _) = try_synchronize(&target, 0xfe, false, |_| false, || true,
            |_| { sequence.lock().unwrap().push("cleanup"); true });
        assert_eq!(completed.released, 1);
        assert_eq!(*sequence.lock().unwrap(), ["control_down", "letter", "control_up", "cleanup"]);
    }

    #[test]
    fn unregistered_or_replaced_windows_never_receive_old_queued_cleanup() {
        let target = test_target(1);
        target.active.store(false, Ordering::Release);
        let (report, _) = try_synchronize(&target, 0, true, |_| false, || true,
            |_| panic!("已经注销的旧窗口不能接收消息"));
        assert!(!report.registered);
        assert!(serialized(&target, || true, || panic!("旧窗口不能执行组合键")).is_err());
        let target = test_target(1);
        let (report, _) = try_synchronize(&target, 0, true, |_| false, || false,
            |_| panic!("所属进程或父子关系不符时不能接收消息"));
        assert!(!report.registered);
    }

    #[test]
    fn a_reused_host_survives_stale_unregister_and_polling_generations() {
        let previous = test_target(1);
        let replacement = test_target(0xfe);
        assert_ne!(previous.generation, replacement.generation);
        let mut all = BTreeMap::new();
        all.insert(previous.host, previous.clone());
        unregister_generation(&mut all, previous.host, previous.generation);
        assert!(!previous.active.load(Ordering::Acquire));
        all.insert(replacement.host, replacement.clone());

        // 旧工作线程退出时的第二次注销不得删除复用同一宿主句柄的新窗口。
        unregister_generation(&mut all, previous.host, previous.generation);
        assert!(replacement.active.load(Ordering::Acquire));
        assert!(Arc::ptr_eq(all.get(&replacement.host).unwrap(), &replacement));

        // 旧代次轮询不能取得新窗口；只有当前代次可以继续向其发送同步消息。
        assert!(matching_target(&all, previous.host, Some(previous.generation)).is_none());
        let current = matching_target(&all, replacement.host, Some(replacement.generation)).unwrap();
        let (report, _) = try_synchronize(&current, 0xfe, true, |_| false, || true, |_| true);
        assert_eq!(report.released, 1);
        let (old, _) = try_synchronize(&previous, 0, true, |_| false, || true,
            |_| panic!("旧代次持有的引用不能发送任何消息"));
        assert!(!old.registered);
        unregister_generation(&mut all, replacement.host, replacement.generation);
        assert!(all.is_empty());
        assert!(!replacement.active.load(Ordering::Acquire));
    }
}
