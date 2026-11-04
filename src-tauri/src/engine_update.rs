use crate::devices::{capture_command, engine, with_idle_sessions};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use windows_sys::Win32::{
    Foundation::{CloseHandle, ERROR_NO_MORE_FILES, GetLastError, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
            TH32CS_SNAPPROCESS,
        },
        Threading::CREATE_NO_WINDOW,
    },
};

type Result<T> = std::result::Result<T, &'static str>;

const REPOSITORY: &str = "https://github.com/Genymobile/scrcpy/releases/download";
const LATEST: &str = "https://github.com/Genymobile/scrcpy/releases/latest";
const SIGNER: &str = "E39E2DE6A55F5AA6D8EFB79ACA01F46F18683B3D";
const PRIMARY: &str = "456958E85A185DD5C2D1E4E80C822B298461FA03";
static UPDATE: Mutex<()> = Mutex::new(());

#[derive(Default, Deserialize, Serialize)]
struct Slots {
    active: Option<String>,
    previous: Option<String>,
    pending: Option<String>,
}

#[derive(Serialize)]
pub struct Status {
    current: Option<String>,
    pending: bool,
    rollback: bool,
    managed: bool,
}

#[derive(Serialize)]
pub(crate) struct EngineOptions {
    version: String,
    options: Vec<EngineOption>,
}

#[derive(Serialize)]
struct EngineOption {
    syntax: String,
    description: String,
}

fn parse_engine_options(text: &str) -> Result<EngineOptions> {
    let version = text.lines().find_map(|line| {
        line.strip_prefix("scrcpy ")?.split_ascii_whitespace().next()
    }).ok_or("queryFailed")?.to_owned();
    let mut options: Vec<EngineOption> = Vec::new();
    for line in text.lines().skip_while(|line| line.trim() != "Options:").skip(1) {
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }
        if line == trimmed { break; }
        if let Some(syntax) = line.strip_prefix("    ").filter(|syntax| syntax.starts_with('-')) {
            options.push(EngineOption { syntax: syntax.to_owned(), description: String::new() });
        } else if let Some(option) = options.last_mut() {
            if !option.description.is_empty() { option.description.push(' '); }
            option.description.push_str(trimmed);
        }
    }
    if options.is_empty() { return Err("queryFailed"); }
    Ok(EngineOptions { version, options })
}

#[tauri::command]
pub(crate) async fn engine_options(app: AppHandle) -> Result<EngineOptions> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = engine(&app)?;
        let mut process = command(path.join("scrcpy.exe"));
        process.current_dir(path).arg("--help");
        let result = capture_command(process, None)?;
        if !result.success { return Err("queryFailed"); }
        parse_engine_options(&result.text)
    })
    .await
    .map_err(|_| "queryFailed")?
}

fn base(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .app_local_data_dir()
        .map_err(|_| "engineUpdateFailed")
}

fn lock_state(base: &Path) -> Result<File> {
    fs::create_dir_all(base).map_err(|_| "engineUpdateFailed")?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(base.join("engine-update.lock"))
        .map_err(|_| "engineUpdateFailed")?;
    file.try_lock().map_err(|_| "engineUpdateBusy")?;
    Ok(file)
}

fn valid_slot(slot: &str) -> bool {
    !slot.is_empty()
        && slot
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'-')
}

fn slots(base: &Path) -> Result<Slots> {
    match fs::read(base.join("engine-slots.json")) {
        Ok(bytes) => {
            let slots: Slots = serde_json::from_slice(&bytes).map_err(|_| "engineUpdateFailed")?;
            if [&slots.active, &slots.previous, &slots.pending]
                .into_iter()
                .flatten()
                .any(|slot| !valid_slot(slot))
            {
                return Err("engineUpdateFailed");
            }
            Ok(slots)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Slots::default()),
        Err(_) => Err("engineUpdateFailed"),
    }
}

fn save(base: &Path, slots: &Slots) -> Result<()> {
    let staging = base.join("engine-slots.tmp");
    let bytes = serde_json::to_vec(slots).map_err(|_| "engineUpdateFailed")?;
    fs::write(&staging, bytes).map_err(|_| "engineUpdateFailed")?;
    fs::rename(staging, base.join("engine-slots.json")).map_err(|_| "engineUpdateFailed")
}

pub fn managed_engine(base: &Path) -> PathBuf {
    slots(base).ok().and_then(|slots| slots.active).map_or_else(
        || base.join("engine"),
        |slot| base.join("engines").join(slot),
    )
}

fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    command
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null());
    command
}

fn version(path: &Path) -> Option<String> {
    let mut process = command(path.join("scrcpy.exe"));
    process.current_dir(path).arg("--version");
    let result = capture_command(process, None).ok()?;
    result.success.then_some(())?;
    let version = result
        .text
        .lines()
        .next()?
        .strip_prefix("scrcpy ")?
        .split_whitespace()
        .next()?;
    version_parts(version)?;
    Some(version.to_owned())
}

fn version_parts(value: &str) -> Option<[u32; 3]> {
    let mut parts = value.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next().map(str::parse).transpose().ok()?.unwrap_or(0);
    parts.next().is_none().then_some([major, minor, patch])
}

fn system_tool(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into()))
        .join("System32")
        .join(name)
}

fn download(url: &str, destination: &Path) -> Result<()> {
    let script = r#"
        $ErrorActionPreference = 'Stop'
        $ProgressPreference = 'SilentlyContinue'
        $uri = [uri]$env:SCRCPY_UPDATE_URL
        $request = @{
            Uri = $uri
            OutFile = $env:SCRCPY_UPDATE_FILE
            UseBasicParsing = $true
            TimeoutSec = 90
            UserAgent = 'ScrcpyController/0.1'
        }
        $proxy = $env:SCRCPY_CONTROLLER_UPDATE_PROXY
        if (!$proxy) { $proxy = $env:HTTPS_PROXY }
        if (!$proxy) {
            $systemProxy = [System.Net.WebRequest]::GetSystemWebProxy()
            if (!$systemProxy.IsBypassed($uri)) {
                $proxy = $systemProxy.GetProxy($uri)
            }
        }
        if ($proxy) { $request.Proxy = $proxy }
        if ($env:SCRCPY_UPDATE_RESOLVE -eq '1') {
            $request.Remove('OutFile')
            $response = Invoke-WebRequest @request -Method Head
            [IO.File]::WriteAllText($env:SCRCPY_UPDATE_FILE, $response.BaseResponse.ResponseUri.AbsoluteUri)
        } else {
            Invoke-WebRequest @request
        }
    "#;
    let output = command(system_tool(r"WindowsPowerShell\v1.0\powershell.exe"))
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ])
        .env("SCRCPY_UPDATE_URL", url)
        .env("SCRCPY_UPDATE_FILE", destination)
        .env(
            "SCRCPY_UPDATE_RESOLVE",
            if url == LATEST { "1" } else { "0" },
        )
        .output()
        .map_err(|_| "engineDownloadFailed")?;
    if !output.status.success() {
        return Err("engineDownloadFailed");
    }
    Ok(())
}

struct Staging(PathBuf);

impl Staging {
    fn new(base: &Path) -> Result<Self> {
        fs::create_dir_all(base).map_err(|_| "engineUpdateFailed")?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "engineUpdateFailed")?;
        let path = base.join(format!("{}-{}", std::process::id(), stamp.as_nanos()));
        fs::create_dir(&path).map_err(|_| "engineUpdateFailed")?;
        Ok(Self(path))
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn latest(dir: &Path) -> Result<String> {
    let file = dir.join("latest.txt");
    download(LATEST, &file)?;
    let resolved = fs::read_to_string(file).map_err(|_| "engineDownloadFailed")?;
    let version = resolved
        .strip_prefix("https://github.com/Genymobile/scrcpy/releases/tag/v")
        .ok_or("engineDownloadFailed")?;
    if version_parts(version).is_none() || !version.bytes().all(|b| b.is_ascii_digit() || b == b'.')
    {
        return Err("engineDownloadFailed");
    }
    Ok(version.to_owned())
}

fn gpg() -> PathBuf {
    ["ProgramFiles", "ProgramFiles(x86)"]
        .into_iter()
        .filter_map(std::env::var_os)
        .flat_map(|root| {
            let root = PathBuf::from(root);
            [
                root.join(r"GnuPG\bin\gpg.exe"),
                root.join(r"Git\usr\bin\gpg.exe"),
            ]
        })
        .find(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("gpg.exe"))
}

fn verify(dir: &Path, filename: &str) -> Result<()> {
    let key_home = dir.join("keyring");
    fs::create_dir(&key_home).map_err(|_| "engineVerifyFailed")?;
    let program = gpg();
    let gpg_command = || {
        let mut process = command(&program);
        process
            .current_dir(dir)
            .args(["--homedir", "keyring"])
            .args(["--batch", "--no-tty", "--no-auto-key-retrieve"]);
        process
    };
    let import = gpg_command()
        .args(["--import", "publisher.asc"])
        .output()
        .map_err(|_| "engineVerifierMissing")?;
    if !import.status.success() {
        return Err("engineVerifyFailed");
    }
    let verified = gpg_command()
        .args([
            "--status-fd",
            "1",
            "--verify",
            "SHA256SUMS.txt.asc",
            "SHA256SUMS.txt",
        ])
        .output()
        .map_err(|_| "engineVerifyFailed")?;
    let status = String::from_utf8_lossy(&verified.stdout);
    if !verified.status.success()
        || !status.lines().any(|line| {
            line.strip_prefix("[GNUPG:] VALIDSIG ")
                .is_some_and(|fields| {
                    let mut fields = fields.split_whitespace();
                    fields.next() == Some(SIGNER) && fields.last() == Some(PRIMARY)
                })
        })
    {
        return Err("engineVerifyFailed");
    }
    let manifest =
        fs::read_to_string(dir.join("SHA256SUMS.txt")).map_err(|_| "engineVerifyFailed")?;
    let expected = manifest
        .lines()
        .find_map(|line| {
            let (hash, name) = line.split_once(char::is_whitespace)?;
            (name.trim_start().trim_start_matches('*') == filename).then_some(hash)
        })
        .ok_or("engineVerifyFailed")?;
    let mut archive = File::open(dir.join(filename)).map_err(|_| "engineVerifyFailed")?;
    let mut digest = Sha256::new();
    io::copy(&mut archive, &mut digest).map_err(|_| "engineVerifyFailed")?;
    if !format!("{:x}", digest.finalize()).eq_ignore_ascii_case(expected) {
        return Err("engineVerifyFailed");
    }
    Ok(())
}

fn mirroring_process_active() -> Result<bool> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err("engineUpdateFailed");
    }
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..unsafe { std::mem::zeroed() }
    };
    let mut found = false;
    let mut has_entry = unsafe { Process32FirstW(snapshot, &mut entry) };
    while has_entry != 0 {
        let end = entry
            .szExeFile
            .iter()
            .position(|&value| value == 0)
            .unwrap_or(entry.szExeFile.len());
        if String::from_utf16_lossy(&entry.szExeFile[..end]).eq_ignore_ascii_case("scrcpy.exe") {
            found = true;
            break;
        }
        has_entry = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    let complete = found || unsafe { GetLastError() } == ERROR_NO_MORE_FILES;
    unsafe { CloseHandle(snapshot) };
    if complete {
        Ok(found)
    } else {
        Err("engineUpdateFailed")
    }
}

pub fn apply_pending(app: &AppHandle) -> Result<()> {
    if std::env::var_os("SCRCPY_CONTROLLER_ENGINE_DIR").is_some() {
        return Ok(());
    }
    let Ok(_guard) = UPDATE.try_lock() else {
        return Ok(());
    };
    let base = base(app)?;
    if slots(&base)?.pending.is_none() {
        return Ok(());
    }
    let _state = match lock_state(&base) {
        Err("engineUpdateBusy") => return Ok(()),
        other => other?,
    };
    let mut slots = slots(&base)?;
    let Some(pending) = slots.pending.clone() else {
        return Ok(());
    };
    with_idle_sessions(app, || {
        if mirroring_process_active()? {
            return Ok(());
        }
        let next = base.join("engines").join(&pending);
        if !next.join("scrcpy.exe").is_file() || !next.join("scrcpy-server").is_file() {
            return Err("engineUpdateFailed");
        }
        slots.pending = None;
        slots.previous = slots.active.replace(pending);
        save(&base, &slots)?;
        let _ = app.emit("engine-options-changed", ());
        Ok(())
    })
    .map(|_| ())
}

#[tauri::command]
pub async fn engine_status(app: AppHandle) -> Result<Status> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = base(&app)?;
        let slots = slots(&base)?;
        let managed = std::env::var_os("SCRCPY_CONTROLLER_ENGINE_DIR").is_none();
        Ok(Status {
            current: engine(&app).ok().and_then(|path| version(&path)),
            pending: managed && slots.pending.is_some(),
            rollback: managed
                && slots.active.is_some()
                && slots.previous.as_ref().map_or_else(
                    || base.join("engine").join("scrcpy.exe").is_file(),
                    |slot| base.join("engines").join(slot).join("scrcpy.exe").is_file(),
                ),
            managed,
        })
    })
    .await
    .map_err(|_| "engineUpdateFailed")?
}

#[tauri::command]
pub async fn check_engine_update(app: AppHandle) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let staging = Staging::new(&base(&app)?)?;
        latest(&staging.0)
    })
    .await
    .map_err(|_| "engineUpdateFailed")?
}

#[tauri::command]
pub async fn install_engine_update(app: AppHandle, requested: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        if std::env::var_os("SCRCPY_CONTROLLER_ENGINE_DIR").is_some() {
            return Err("engineExternal");
        }
        let guard = UPDATE.try_lock().map_err(|_| "engineUpdateBusy")?;
        let base = base(&app)?;
        let state = lock_state(&base)?;
        let mut slots = slots(&base)?;
        if slots.pending.is_some() {
            return Err("engineUpdateBusy");
        }
        let staging = Staging::new(&base)?;
        let version = latest(&staging.0)?;
        if version != requested
            || engine(&app)
                .ok()
                .and_then(|path| self::version(&path))
                .and_then(|current| version_parts(&current))
                >= version_parts(&version)
        {
            return Err("engineReleaseChanged");
        }
        let arch = match std::env::consts::ARCH {
            "x86_64" => "win64",
            "x86" => "win32",
            "aarch64" => "winarm64",
            _ => return Err("engineUpdateFailed"),
        };
        let package = format!("scrcpy-{arch}-v{version}");
        let filename = format!("{package}.zip");
        for name in ["SHA256SUMS.txt", "SHA256SUMS.txt.asc", &filename] {
            download(
                &format!("{REPOSITORY}/v{version}/{name}"),
                &staging.0.join(name),
            )?;
        }
        download(
            "https://blog.rom1v.com/keys/rom1v.asc",
            &staging.0.join("publisher.asc"),
        )?;
        verify(&staging.0, &filename)?;
        let output = command(system_tool("tar.exe"))
            .current_dir(&staging.0)
            .args(["-xf", &filename])
            .output()
            .map_err(|_| "engineUpdateFailed")?;
        let extracted = staging.0.join(&package);
        if !output.status.success()
            || self::version(&extracted).as_deref() != Some(&version)
            || ["adb.exe", "scrcpy-server"]
                .iter()
                .any(|name| !extracted.join(name).is_file())
        {
            return Err("engineUpdateFailed");
        }
        let slot = staging
            .0
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("engineUpdateFailed")?;
        let engines = base.join("engines");
        fs::create_dir_all(&engines).map_err(|_| "engineUpdateFailed")?;
        fs::rename(extracted, engines.join(slot)).map_err(|_| "engineUpdateFailed")?;
        slots.pending = Some(slot.to_owned());
        save(&base, &slots)?;
        drop(state);
        drop(guard);
        apply_pending(&app)
    })
    .await
    .map_err(|_| "engineUpdateFailed")?
}

#[tauri::command]
pub async fn rollback_engine(app: AppHandle) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        if std::env::var_os("SCRCPY_CONTROLLER_ENGINE_DIR").is_some() {
            return Err("engineExternal");
        }
        let _guard = UPDATE.try_lock().map_err(|_| "engineUpdateBusy")?;
        let base = base(&app)?;
        let _state = lock_state(&base)?;
        let mut slots = slots(&base)?;
        if slots.pending.is_some() || slots.active.is_none() {
            return Err("engineUpdateBusy");
        }
        with_idle_sessions(&app, || {
            if mirroring_process_active()? {
                return Err("engineSessionsActive");
            }
            let previous = slots.previous.as_ref().map_or_else(
                || base.join("engine"),
                |slot| base.join("engines").join(slot),
            );
            if !previous.join("scrcpy.exe").is_file() || !previous.join("scrcpy-server").is_file() {
                return Err("engineUpdateFailed");
            }
            slots.active = slots.previous.take();
            save(&base, &slots)?;
            let _ = app.emit("engine-options-changed", ());
            Ok(())
        })?
        .then_some(())
        .ok_or("engineSessionsActive")
    })
    .await
    .map_err(|_| "engineUpdateFailed")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_help_keeps_aliases_optional_values_and_only_options() {
        let help = "scrcpy 5.0.1 <https://example.org>\r\nUsage: scrcpy [options]\r\n\r\nOptions:\r\n\r\n    -K\r\n        Use a physical keyboard.\r\n\r\n    --new-display[=size]\r\n        Create a display.\r\n        Size is optional.\r\n\r\nShortcuts:\r\n    --not-an-option\r\n";
        let parsed = parse_engine_options(help).unwrap();
        assert_eq!(parsed.version, "5.0.1");
        assert_eq!(parsed.options.len(), 2);
        assert_eq!(parsed.options[0].syntax, "-K");
        assert_eq!(parsed.options[1].syntax, "--new-display[=size]");
        assert_eq!(parsed.options[1].description, "Create a display. Size is optional.");
    }

    #[test]
    fn slot_pointer_replaces_previous_state() {
        let staging = Staging::new(&std::env::temp_dir()).unwrap();
        let base = &staging.0;
        let mut state = Slots {
            active: Some("1-10".into()),
            previous: None,
            pending: Some("1-20".into()),
        };
        save(base, &state).unwrap();
        assert_eq!(managed_engine(base), base.join("engines").join("1-10"));
        state.previous = state.active.take();
        state.active = state.pending.take();
        save(base, &state).unwrap();
        assert_eq!(managed_engine(base), base.join("engines").join("1-20"));
        state.active = state.previous.take();
        save(base, &state).unwrap();
        assert_eq!(managed_engine(base), base.join("engines").join("1-10"));
    }

    #[test]
    #[ignore = "requires official release files and a local GnuPG installation"]
    fn verifies_official_release_and_rejects_tampering() {
        let fixture = PathBuf::from(std::env::var_os("SCRCPY_TEST_RELEASE").unwrap());
        let filename = "scrcpy-win64-v5.0.1.zip";
        for damaged in [None, Some("SHA256SUMS.txt.asc"), Some(filename)] {
            let staging = Staging::new(&std::env::temp_dir()).unwrap();
            for name in [
                "publisher.asc",
                "SHA256SUMS.txt",
                "SHA256SUMS.txt.asc",
                filename,
            ] {
                fs::copy(fixture.join(name), staging.0.join(name)).unwrap();
            }
            if let Some(name) = damaged {
                let file = staging.0.join(name);
                let mut bytes = fs::read(&file).unwrap();
                bytes[0] ^= 1;
                fs::write(file, bytes).unwrap();
                assert_eq!(verify(&staging.0, filename), Err("engineVerifyFailed"));
            } else {
                assert_eq!(verify(&staging.0, filename), Ok(()));
            }
        }
    }
}
