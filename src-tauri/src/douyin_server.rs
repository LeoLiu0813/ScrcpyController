use crate::devices::capture_command;
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

const OFFICIAL_SERVER_SHA256: &str =
    "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536";

pub(crate) struct DouyinServer(PathBuf);

impl DouyinServer {
    pub(crate) fn prepare(engine: &Path) -> Result<Self, &'static str> {
        let server = fs::read(engine.join("scrcpy-server")).map_err(|_| "appWindowFailed")?;
        if format!("{:x}", Sha256::digest(&server)) != OFFICIAL_SERVER_SHA256 {
            return Err("douyinEngineUnsupported");
        }

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "appWindowFailed")?;
        let directory = std::env::temp_dir().join(format!(
            "scrcpy-douyin-{}-{}",
            std::process::id(),
            stamp.as_nanos()
        ));
        fs::create_dir(&directory).map_err(|_| "appWindowFailed")?;
        let temporary = Self(directory.join("scrcpy-server"));
        fs::write(&temporary.0, server).map_err(|_| "appWindowFailed")?;

        let system_root = std::env::var_os("SystemRoot").ok_or("appWindowFailed")?;
        let mut command = Command::new(
            PathBuf::from(system_root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe"),
        );
        command
            .creation_flags(CREATE_NO_WINDOW)
            .env("SCRCPY_DOUYIN_SERVER", &temporary.0)
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                include_str!("douyin_server.ps1"),
            ]);
        let output = capture_command(command, None).map_err(|_| "douyinServerFailed")?;
        if !output.success {
            return Err("douyinServerFailed");
        }
        Ok(temporary)
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for DouyinServer {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
        if let Some(directory) = self.0.parent() {
            let _ = fs::remove_dir(directory);
        }
    }
}
