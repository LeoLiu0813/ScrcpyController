use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub(crate) struct WechatServer(PathBuf);

impl WechatServer {
    pub(crate) fn prepare(engine: &Path) -> Result<Self, &'static str> {
        const OFFICIAL_SERVER_SHA256: &str =
            "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536";
        let official = fs::read(engine.join("scrcpy-server")).map_err(|_| "appWindowFailed")?;
        if format!("{:x}", Sha256::digest(&official)) != OFFICIAL_SERVER_SHA256 {
            return Err("wechatEngineUnsupported");
        }

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "appWindowFailed")?;
        let directory = std::env::temp_dir().join(format!(
            "scrcpy-wechat-{}-{}",
            std::process::id(),
            stamp.as_nanos()
        ));
        fs::create_dir(&directory).map_err(|_| "appWindowFailed")?;
        let server = Self(directory.join("scrcpy-server"));
        fs::write(
            server.path(),
            include_bytes!("../android-helper/wechat-server.jar"),
        )
        .map_err(|_| "appWindowFailed")?;
        Ok(server)
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for WechatServer {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
        if let Some(directory) = self.0.parent() {
            let _ = fs::remove_dir(directory);
        }
    }
}
