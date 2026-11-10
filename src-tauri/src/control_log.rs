//! Bounded, in-memory control diagnostics. Only an explicit export writes events to disk.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock, atomic::{AtomicBool, AtomicU64, Ordering}, mpsc::{self, Receiver, SyncSender, TrySendError}},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, WebviewWindow};

const MAX_BYTES: u64 = 16 * 1024 * 1024;
const RETAINED_FILES: usize = 1;
const QUEUE_SIZE: usize = 512;
const MAX_ENTRY_BYTES: usize = 4096;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(3);
const FAILURE: &str = "controlLogFailed";
static LOGGER: OnceLock<Logger> = OnceLock::new();

#[derive(Serialize, Deserialize)]
struct Settings { enabled: bool }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LogView {
    pub enabled: bool,
    pub run_id: String,
    pub entries: Vec<Value>,
    pub dropped: u64,
    pub max_bytes: u64,
    pub retained_files: usize,
    pub storage_mode: &'static str,
    pub buffer_bytes: u64,
    pub overwritten: u64,
    pub error: Option<String>,
}

struct Logger {
    sender: SyncSender<Message>,
    enabled: std::sync::Arc<AtomicBool>,
    dropped: std::sync::Arc<AtomicU64>,
    failed: std::sync::Arc<AtomicBool>,
    sequence: AtomicU64,
    sessions: Mutex<HashMap<String, usize>>,
    run_id: String,
    started: Instant,
}

enum Message {
    Event(Value),
    Read(usize, SyncSender<Result<LogView, &'static str>>),
    Enabled(bool, SyncSender<Result<LogView, &'static str>>),
    Export(SyncSender<Result<PathBuf, &'static str>>),
    Flush(SyncSender<Result<(), &'static str>>),
}

struct Store {
    directory: PathBuf,
    settings_path: PathBuf,
    max_bytes: u64,
    retained_files: usize,
    run_id: String,
    enabled: std::sync::Arc<AtomicBool>,
    dropped: std::sync::Arc<AtomicU64>,
    failed: std::sync::Arc<AtomicBool>,
    buffer: RingBuffer,
}

struct RingBuffer {
    entries: VecDeque<Vec<u8>>,
    bytes: u64,
    capacity: u64,
    overwritten: u64,
}

impl RingBuffer {
    fn new(capacity: u64) -> Self {
        Self { entries: VecDeque::new(), bytes: 0, capacity, overwritten: 0 }
    }

    fn push(&mut self, entry: &Value) -> io::Result<()> {
        let mut bytes = serde_json::to_vec(entry)?;
        bytes.push(b'\n');
        let length = bytes.len() as u64;
        if bytes.len() > MAX_ENTRY_BYTES || length > self.capacity {
            return Err(io::Error::other("entry too large"));
        }
        while self.bytes + length > self.capacity {
            let oldest = self.entries.pop_front().expect("non-empty bounded log buffer");
            self.bytes -= oldest.len() as u64;
            self.overwritten += 1;
        }
        self.bytes += length;
        self.entries.push_back(bytes);
        Ok(())
    }

    fn tail(&self, limit: usize) -> io::Result<Vec<Value>> {
        self.entries.iter().skip(self.entries.len().saturating_sub(limit.min(1000)))
            .map(|entry| serde_json::from_slice(entry).map_err(io::Error::other)).collect()
    }
}

fn unix_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u128::from(u64::MAX)) as u64
}

// Values are intentionally enumerated: an accidental filename, device code,
// application title or pasted text must never enter a control diagnostic file.
fn safe_string(value: &str) -> bool {
    matches!(value,
        "video" | "host" | "shellChild" | "main" | "other" | "none" | "unavailable" |
        "system_async" | "native_poll" | "host_message" | "win_event" | "cli" | "ui" | "native" |
        "begin" | "end" | "start" | "started" | "stop" | "stopped" | "success" | "failed" |
        "failure" | "queued" | "timeout" | "pending" | "denied" | "cancelled" | "completed" |
        "requested" | "before" | "after" | "down" | "up" | "pressed" | "released" |
        "ordinary" | "virtual" | "fixed" | "follow" | "rail" | "more" |
        "back" | "home" | "recents" | "volumeUp" | "volumeDown" | "screenPower" |
        "notifications" | "quickSettings" | "screenOff" | "screenOn" | "rotate" | "paste" |
        "pause" | "resume" | "resetVideo" | "screenshot" | "copyScreenshot" | "captureFolder" |
        "sendFiles" | "fullscreen" | "actual" | "fit" | "pin" | "sidebar" | "minimize" |
        "maximize" | "restore" | "close" | "open" | "focus" | "move" | "resize" |
        "button" | "wheel" | "middle" | "x1" | "x2" | "horizontal" | "vertical" |
        "outside" | "titlebar" | "client" | "frame" | "desktop" | "memory" |
        "left" | "right" | "backspace" | "enter" | "escape" | "tab" |
        "leftCtrl" | "rightCtrl" | "leftShift" | "rightShift" | "leftAlt" | "rightAlt" |
        "leftWin" | "rightWin" | "control" | "shift" | "alt" | "win" |
        "LCTRL" | "RCTRL" | "LSHIFT" | "RSHIFT" | "LALT" | "RALT" | "LWIN" | "RWIN" |
        "WM_SETFOCUS" | "WM_KILLFOCUS" | "WM_EXITSIZEMOVE" | "WM_DPICHANGED" | "WM_NCDESTROY" |
        "focusDenied" | "mirrorActionFailed" | "mirrorFrameFailed" | "invalidArguments" |
        "sessionError" | "sessionNotFound" | "windowPending" | "captureUnavailable" |
        "deviceUnavailable" | "deviceIdentityMismatch" | "deviceVerifying" | "controlLogFailed" |
        "appWindowFailed" | "appWindowUnavailable" | "launchFailed" | "engineMissing" |
        "readOnly" | "position" | "geometry" | "attached" | "detached" |
        "foreground" | "background" | "visible" | "hidden" | "no_focus" | "not_foreground" |
        "poll" | "activated" | "deactivated" | "manual"
        | "unknown"
    ) || value.len() == 1 && value.as_bytes()[0].is_ascii_uppercase()
        || value == env!("CARGO_PKG_VERSION")
}

fn sanitize(value: Value, depth: usize) -> Value {
    if depth > 5 { return Value::Null; }
    match value {
        Value::String(value) => Value::String(if safe_string(&value) { value } else { "[redacted]".into() }),
        Value::Array(values) => Value::Array(values.into_iter().take(32).map(|value| sanitize(value, depth + 1)).collect()),
        Value::Object(values) => Value::Object(values.into_iter().filter(|(key, _)| {
            let lower = key.to_ascii_lowercase();
            key.len() <= 48 && key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
                && !["serial", "hardware", "clipboard", "password", "token", "address", "filename", "package", "path", "title", "text"].iter().any(|sensitive| lower.contains(sensitive))
        }).take(40).map(|(key, value)| (key, sanitize(value, depth + 1))).collect()),
        other => other,
    }
}

impl Logger {
    fn new(directory: PathBuf, settings_path: PathBuf, capacity: usize, max_bytes: u64) -> io::Result<Self> {
        if let Some(parent) = settings_path.parent() { fs::create_dir_all(parent)?; }
        let (enabled, failed) = match fs::read(&settings_path) {
            Ok(bytes) => match serde_json::from_slice::<Settings>(&bytes) {
                Ok(settings) => (settings.enabled, false),
                Err(_) => (false, true),
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => (true, false),
            Err(_) => (false, true),
        };
        let enabled = std::sync::Arc::new(AtomicBool::new(enabled));
        let dropped = std::sync::Arc::new(AtomicU64::new(0));
        let failed = std::sync::Arc::new(AtomicBool::new(failed));
        let run_id = format!("{}-{}", unix_ms(), std::process::id());
        let store = Store { directory, settings_path, max_bytes, retained_files: RETAINED_FILES, run_id: run_id.clone(),
            enabled: enabled.clone(), dropped: dropped.clone(), failed: failed.clone(), buffer: RingBuffer::new(max_bytes) };
        let (sender, receiver) = mpsc::sync_channel(capacity);
        thread::Builder::new().name("control-log-writer".into()).spawn(move || store.run(receiver))?;
        Ok(Self { sender, enabled, dropped, failed, sequence: AtomicU64::new(1),
            sessions: Mutex::new(HashMap::new()), run_id, started: Instant::now() })
    }

    fn entry(&self, event: &str, session: Option<&str>, detail: Value) -> Option<Value> {
        let session = if let Some(session) = session {
            let Ok(mut sessions) = self.sessions.try_lock() else {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                return None;
            };
            let next = sessions.len() + 1;
            let index = *sessions.entry(session.to_owned()).or_insert(next);
            Some(format!("window-{index}"))
        } else { None };
        let event = if event.len() <= 80 && event.bytes().all(|c| c.is_ascii_lowercase() || c == b'.' || c == b'_') {
            event
        } else { "log.invalid_event" };
        Some(json!({ "ts_unix_ms": unix_ms(), "elapsed_ms": self.started.elapsed().as_millis() as u64,
            "seq": self.sequence.fetch_add(1, Ordering::Relaxed), "run_id": self.run_id,
            "session": session, "event": event, "detail": sanitize(detail, 0) }))
    }

    fn emit(&self, entry: Value) {
        match self.sender.try_send(Message::Event(entry)) {
            Ok(()) => {},
            Err(TrySendError::Full(_)) => { self.dropped.fetch_add(1, Ordering::Relaxed); },
            Err(TrySendError::Disconnected(_)) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                self.failed.store(true, Ordering::Relaxed);
            },
        }
    }

    fn request<T>(&self, make: impl FnOnce(SyncSender<Result<T, &'static str>>) -> Message) -> Result<T, &'static str> {
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut message = make(sender);
        let deadline = Instant::now() + COMMAND_TIMEOUT;
        loop {
            match self.sender.try_send(message) {
                Ok(()) => break,
                Err(TrySendError::Full(pending)) if Instant::now() < deadline => {
                    message = pending;
                    thread::sleep(Duration::from_millis(5));
                },
                Err(_) => return Err(FAILURE),
            }
        }
        receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())).map_err(|_| FAILURE)?
    }
}

impl Store {
    fn checked<T>(&self, result: io::Result<T>) -> Result<T, &'static str> {
        result.map_err(|_| {
            self.failed.store(true, Ordering::Relaxed);
            FAILURE
        })
    }

    fn view(&self, limit: usize) -> io::Result<LogView> {
        Ok(LogView { enabled: self.enabled.load(Ordering::Relaxed), run_id: self.run_id.clone(), entries: self.buffer.tail(limit)?,
            dropped: self.dropped.load(Ordering::Relaxed), max_bytes: self.max_bytes,
            retained_files: self.retained_files, storage_mode: "memory", buffer_bytes: self.buffer.bytes,
            overwritten: self.buffer.overwritten, error: self.failed.load(Ordering::Relaxed).then(|| FAILURE.into()) })
    }

    fn set_enabled(&self, enabled: bool) -> io::Result<LogView> {
        let temporary = self.settings_path.with_extension("tmp");
        fs::write(&temporary, serde_json::to_vec(&Settings { enabled })?)?;
        fs::rename(&temporary, &self.settings_path)?;
        self.enabled.store(enabled, Ordering::Relaxed);
        self.failed.store(false, Ordering::Relaxed);
        self.view(100)
    }

    fn export(&self) -> io::Result<PathBuf> {
        fs::create_dir_all(&self.directory)?;
        let path = self.directory.join("latest-export.jsonl");
        let temporary = self.directory.join("latest-export.tmp");
        let result = (|| {
            let mut target = File::create(&temporary)?;
            for entry in &self.buffer.entries { target.write_all(entry)?; }
            target.sync_all()?;
            drop(target);
            fs::rename(&temporary, &path)?;
            Ok(path)
        })();
        if result.is_err() { let _ = fs::remove_file(temporary); }
        result
    }

    fn run(mut self, receiver: Receiver<Message>) {
        let mut sequence = 1_u64;
        for message in receiver {
            match message {
                Message::Event(mut entry) => {
                    if self.enabled.load(Ordering::Relaxed) {
                        // Assign the visible order on the writer thread. Concurrent
                        // producers can reach the queue in a different order.
                        entry["seq"] = json!(sequence);
                        sequence += 1;
                        if self.buffer.push(&entry).is_err() {
                            self.failed.store(true, Ordering::Relaxed);
                            self.dropped.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                },
                Message::Read(limit, reply) => { let _ = reply.send(self.checked(self.view(limit))); },
                Message::Enabled(enabled, reply) => {
                    let result = self.set_enabled(enabled).map_err(|_| FAILURE);
                    if result.is_err() { self.failed.store(true, Ordering::Relaxed); }
                    let _ = reply.send(result);
                },
                Message::Export(reply) => { let _ = reply.send(self.checked(self.export())); },
                Message::Flush(reply) => {
                    // FIFO barrier only: exit never persists the diagnostic buffer.
                    let _ = reply.send(Ok(()));
                },
            }
        }
    }
}

// The previous diagnostic capture is exported before this migration is deployed.
// Never enumerate or recursively delete the containing directory.
fn cleanup_legacy_disk_logs(directory: &Path) -> io::Result<()> {
    for name in ["control-0.jsonl", "control-1.jsonl", "control-2.jsonl"] {
        let path = directory.join(name);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_file() => fs::remove_file(path)?,
            Ok(_) => {},
            Err(error) if error.kind() == io::ErrorKind::NotFound => {},
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

pub(crate) fn install(app: &AppHandle) -> io::Result<()> {
    let directory = app.path().app_local_data_dir().map_err(io::Error::other)?;
    let log_directory = directory.join("control-logs");
    let cleanup_failed = cleanup_legacy_disk_logs(&log_directory).is_err();
    let logger = Logger::new(log_directory, directory.join("control-log-settings.json"), QUEUE_SIZE, MAX_BYTES)?;
    if cleanup_failed { logger.failed.store(true, Ordering::Relaxed); }
    LOGGER.set(logger).map_err(|_| io::Error::other("already initialized"))?;
    if cleanup_failed { record("log.legacy_cleanup_failed", None, json!({})); }
    record("app.started", None, json!({ "app_version": env!("CARGO_PKG_VERSION"), "sdl_modifiers": "unavailable", "storage_mode": "memory", "max_bytes": MAX_BYTES }));
    Ok(())
}

pub(crate) fn enabled() -> bool { LOGGER.get().is_some_and(|logger| logger.enabled.load(Ordering::Relaxed)) }

pub(crate) fn record(event: &'static str, session: Option<&str>, detail: Value) {
    let Some(logger) = LOGGER.get().filter(|logger| logger.enabled.load(Ordering::Relaxed)) else { return; };
    if let Some(entry) = logger.entry(event, session, detail) { logger.emit(entry); }
}

pub(crate) fn read(limit: usize) -> Result<LogView, &'static str> {
    LOGGER.get().ok_or(FAILURE)?.request(|reply| Message::Read(limit.min(1000), reply))
}

pub(crate) fn set_enabled(enabled: bool) -> Result<LogView, &'static str> {
    LOGGER.get().ok_or(FAILURE)?.request(|reply| Message::Enabled(enabled, reply))
}

pub(crate) fn export() -> Result<PathBuf, &'static str> { LOGGER.get().ok_or(FAILURE)?.request(Message::Export) }

pub(crate) fn flush() {
    if let Some(logger) = LOGGER.get() { let _ = logger.request(Message::Flush); }
}

fn main_only(window: &WebviewWindow) -> Result<(), &'static str> {
    (window.label() == "main").then_some(()).ok_or("invalidArguments")
}

#[tauri::command]
pub(crate) async fn control_log_read(window: WebviewWindow, limit: Option<usize>) -> Result<LogView, &'static str> {
    main_only(&window)?;
    tauri::async_runtime::spawn_blocking(move || read(limit.unwrap_or(100))).await.map_err(|_| FAILURE)?
}

#[tauri::command]
pub(crate) async fn control_log_set_enabled(window: WebviewWindow, enabled: bool) -> Result<LogView, &'static str> {
    main_only(&window)?;
    tauri::async_runtime::spawn_blocking(move || set_enabled(enabled)).await.map_err(|_| FAILURE)?
}

#[tauri::command]
pub(crate) async fn control_log_export(window: WebviewWindow) -> Result<String, &'static str> {
    main_only(&window)?;
    tauri::async_runtime::spawn_blocking(|| export().map(|path| path.to_string_lossy().into_owned())).await.map_err(|_| FAILURE)?
}

#[cfg(test)]
mod tests {
    use super::*;
    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("scrcpy-control-log-test-{}-{}-{}", std::process::id(), unix_ms(), NEXT.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn logger(&self, maximum: u64) -> Logger {
            Logger::new(self.0.join("logs"), self.0.join("settings.json"), 512, maximum).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if let (Ok(path), Ok(parent)) = (self.0.canonicalize(), std::env::temp_dir().canonicalize()) {
                if path.starts_with(parent) && path.file_name().is_some_and(|name| name.to_string_lossy().starts_with("scrcpy-control-log-test-")) {
                    let _ = fs::remove_dir_all(path);
                }
            }
        }
    }

    #[test]
    fn session_and_arbitrary_detail_are_redacted_and_mouse_coordinates_are_kept() {
        let fixture = Fixture::new();
        let logger = fixture.logger(8192);
        let entry = logger.entry("input.sample_changed", Some("private-device-identity"), json!({
            "source": "native_poll", "path": "C:\\Users\\Private\\photo.png", "text": "私密文字",
            "hardware": "synthetic-hardware-identity", "system_modifiers": 0, "sdl_modifiers": "unavailable",
            "client_x": 320, "client_y": 640, "video_x": 317, "video_y": 604, "normalized_x": 0.5, "normalized_y": 0.75,
            "target": "video", "event_type": "wheel"
        })).unwrap();
        logger.emit(entry);
        let view = logger.request(|reply| Message::Read(10, reply)).unwrap();
        let serialized = serde_json::to_string(&view.entries).unwrap();
        assert!(serialized.contains("window-1"));
        for private in ["private-device-identity", "Private", "私密文字", "synthetic-hardware-identity"] { assert!(!serialized.contains(private)); }
        assert_eq!(view.entries[0]["detail"]["source"], "native_poll");
        assert!(view.entries[0]["detail"].get("hardware").is_none());
        assert_eq!(view.entries[0]["detail"]["client_x"], 320);
        assert_eq!(view.entries[0]["detail"]["normalized_y"], 0.75);
        assert_eq!(view.entries[0]["detail"]["event_type"], "wheel");
        assert!(!fixture.0.join("logs").exists());
    }

    #[test]
    fn ring_capacity_is_counted_in_serialized_bytes_and_overwrites_oldest_first() {
        let entry_size = serde_json::to_vec(&json!({ "index": 0 })).unwrap().len() as u64 + 1;
        let mut buffer = RingBuffer::new(3 * entry_size);
        for index in 0..10 { buffer.push(&json!({ "index": index })).unwrap(); }
        assert_eq!(buffer.bytes, 3 * entry_size);
        assert_eq!(buffer.overwritten, 7);
        assert_eq!(buffer.tail(100).unwrap(), vec![json!({ "index": 7 }), json!({ "index": 8 }), json!({ "index": 9 })]);
        assert!(buffer.push(&json!({ "large": "x".repeat(100) })).is_err());
        assert_eq!(buffer.bytes, 3 * entry_size);
        assert_eq!(buffer.overwritten, 7);
    }

    #[test]
    fn export_has_only_the_bounded_memory_history_and_is_atomically_replaced() {
        let fixture = Fixture::new();
        let logger = fixture.logger(1024);
        for index in 0..64 {
            logger.emit(logger.entry("input.sample_changed", Some("opaque"), json!({ "index": index })).unwrap());
        }
        let view = logger.request(|reply| Message::Read(100, reply)).unwrap();
        assert!(view.entries.len() < 64);
        assert!(view.entries.first().unwrap()["detail"]["index"].as_u64().unwrap() > 0);
        assert_eq!(view.entries.last().unwrap()["detail"]["index"], 63);
        assert_eq!(view.overwritten + view.entries.len() as u64, 64);
        assert_eq!(view.dropped, 0);
        assert_eq!(view.storage_mode, "memory");
        assert!(view.buffer_bytes <= 1024);
        assert!(!fixture.0.join("logs").exists());
        let exported = logger.request(Message::Export).unwrap();
        assert!(fs::metadata(&exported).unwrap().len() <= 1024);
        assert_eq!(fs::metadata(&exported).unwrap().len(), view.buffer_bytes);
        let exports = fs::read_to_string(exported).unwrap().lines().map(|line| serde_json::from_str::<Value>(line).unwrap()).collect::<Vec<_>>();
        assert_eq!(view.entries, exports);
        let exported_again = logger.request(Message::Export).unwrap();
        assert_eq!(fs::read(exported_again).unwrap(), exports.iter().map(|entry| format!("{entry}\n")).collect::<String>().as_bytes());
        assert_eq!(fs::read_dir(fixture.0.join("logs")).unwrap().count(), 1);
    }

    #[test]
    fn disabling_is_persistent_and_stops_event_storage() {
        let fixture = Fixture::new();
        let logger = fixture.logger(8192);
        logger.emit(logger.entry("app.started", None, json!({})).unwrap());
        let disabled = logger.request(|reply| Message::Enabled(false, reply)).unwrap();
        assert!(!disabled.enabled);
        logger.emit(logger.entry("input.sample_changed", None, json!({})).unwrap());
        assert_eq!(logger.request(|reply| Message::Read(10, reply)).unwrap().entries.len(), 1);
        assert!(!serde_json::from_slice::<Settings>(&fs::read(fixture.0.join("settings.json")).unwrap()).unwrap().enabled);
        let enabled = logger.request(|reply| Message::Enabled(true, reply)).unwrap();
        assert!(enabled.enabled);
        logger.emit(logger.entry("input.sample_changed", None, json!({})).unwrap());
        assert_eq!(logger.request(|reply| Message::Read(10, reply)).unwrap().entries.len(), 2);
        logger.request(Message::Flush).unwrap();
        assert!(!fixture.0.join("logs").exists());
    }

    #[test]
    fn queue_backpressure_and_invalid_records_are_visible_as_failures() {
        let fixture = Fixture::new();
        let mut logger = fixture.logger(8192);
        let (sender, _receiver) = mpsc::sync_channel(1);
        logger.sender = sender;
        logger.emit(json!({})); logger.emit(json!({}));
        assert_eq!(logger.dropped.load(Ordering::Relaxed), 1);
        let live = fixture.logger(8192);
        live.emit(json!({ "oversized": "x".repeat(MAX_ENTRY_BYTES + 1) }));
        let status = live.request(|reply| Message::Read(0, reply)).unwrap();
        assert_eq!(status.dropped, 1);
        assert_eq!(status.error.as_deref(), Some(FAILURE));
    }

    #[test]
    fn concurrent_producers_have_one_monotonic_buffer_sequence() {
        let fixture = Fixture::new();
        let logger = std::sync::Arc::new(fixture.logger(MAX_BYTES));
        let workers = (0..4).map(|_| {
            let logger = logger.clone();
            thread::spawn(move || {
                for index in 0..40 {
                    logger.emit(logger.entry("input.sample_changed", None, json!({ "index": index })).unwrap());
                }
            })
        }).collect::<Vec<_>>();
        for worker in workers { worker.join().unwrap(); }
        let view = logger.request(|reply| Message::Read(200, reply)).unwrap();
        assert_eq!(view.entries.len(), 160);
        for (index, entry) in view.entries.iter().enumerate() { assert_eq!(entry["seq"], index as u64 + 1); }
        assert_eq!(view.dropped, 0);
    }

    #[test]
    fn a_new_run_starts_empty_and_never_loads_previous_disk_logs() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.0.join("logs")).unwrap();
        fs::write(fixture.0.join("logs/control-0.jsonl"), b"old log data\n").unwrap();
        fs::write(fixture.0.join("logs/latest-export.jsonl"), b"previous explicit export\n").unwrap();
        let logger = fixture.logger(8192);
        let view = logger.request(|reply| Message::Read(100, reply)).unwrap();
        assert!(view.entries.is_empty());
        assert_eq!(view.buffer_bytes, 0);
        assert!(view.error.is_none());
        logger.request(Message::Flush).unwrap();
        assert_eq!(fs::read(fixture.0.join("logs/latest-export.jsonl")).unwrap(), b"previous explicit export\n");
    }

    #[test]
    fn export_failures_remain_visible_in_status() {
        let fixture = Fixture::new();
        let logger = fixture.logger(8192);
        fs::create_dir_all(fixture.0.join("logs/latest-export.jsonl")).unwrap();
        assert!(logger.request(Message::Export).is_err());
        assert_eq!(logger.request(|reply| Message::Read(0, reply)).unwrap().error.as_deref(), Some(FAILURE));
    }

    #[test]
    fn legacy_cleanup_removes_only_the_three_fixed_regular_log_files() {
        let fixture = Fixture::new();
        let directory = fixture.0.join("logs");
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("control-0.jsonl"), b"old").unwrap();
        fs::write(directory.join("control-1.jsonl"), b"old").unwrap();
        fs::create_dir(directory.join("control-2.jsonl")).unwrap();
        fs::write(directory.join("control-2.jsonl/keep.txt"), b"keep").unwrap();
        fs::write(directory.join("latest-export.jsonl"), b"export").unwrap();
        fs::write(directory.join("unrelated.jsonl"), b"keep").unwrap();
        cleanup_legacy_disk_logs(&directory).unwrap();
        assert!(!directory.join("control-0.jsonl").exists());
        assert!(!directory.join("control-1.jsonl").exists());
        assert_eq!(fs::read(directory.join("control-2.jsonl/keep.txt")).unwrap(), b"keep");
        assert_eq!(fs::read(directory.join("latest-export.jsonl")).unwrap(), b"export");
        assert_eq!(fs::read(directory.join("unrelated.jsonl")).unwrap(), b"keep");
    }
}
