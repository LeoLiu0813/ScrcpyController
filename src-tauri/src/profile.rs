use serde::Deserialize;
use std::{
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

type Result<T> = std::result::Result<T, &'static str>;

#[derive(Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Profile {
    max_size: u32,
    max_fps: u32,
    bit_rate: u32,
    mute: bool,
    record: bool,
    codec: String,
    audio_source: String,
    pub(crate) camera: String,
    pub(crate) display: String,
    keyboard: String,
    mouse: String,
    gamepad: String,
    pub(crate) read_only: bool,
    pub(crate) top: bool,
    pub(crate) fullscreen: bool,
    screen_off: bool,
    awake: bool,
    forward: bool,
}

pub fn name(alias: Option<String>, model: String) -> Result<String> {
    let Some(alias) = alias else { return Ok(model) };
    let alias = alias.trim();
    if alias.chars().count() > 60 || alias.chars().any(char::is_control) {
        return Err("invalidName");
    }
    Ok(if alias.is_empty() {
        model
    } else {
        alias.to_owned()
    })
}

pub fn recording(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .video_dir()
        .map_err(|_| "captureUnavailable")?
        .join("ScrcpyController");
    std::fs::create_dir_all(&dir).map_err(|_| "captureUnavailable")?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "captureUnavailable")?
        .as_nanos();
    Ok(dir.join(format!("screen-{stamp}.mkv")))
}

fn choice<'a>(value: &'a str, allowed: &[&str]) -> Result<Option<&'a str>> {
    if value.is_empty() {
        Ok(None)
    } else if allowed.contains(&value) {
        Ok(Some(value))
    } else {
        Err("invalidProfile")
    }
}

impl Profile {
    pub fn apply(
        &self,
        command: &mut Command,
        app: &AppHandle,
        preview: bool,
    ) -> Result<Option<PathBuf>> {
        for (flag, value, max) in [
            ("--max-size", self.max_size, 8192),
            ("--max-fps", self.max_fps, 240),
            ("--video-bit-rate", self.bit_rate, 200),
        ] {
            if value > max {
                return Err("invalidProfile");
            }
            if value != 0 {
                command.arg(flag).arg(if flag == "--video-bit-rate" {
                    format!("{value}M")
                } else {
                    value.to_string()
                });
            }
        }
        for (flag, value, allowed) in [
            ("--video-codec", &self.codec, &["h264", "h265", "av1"][..]),
            (
                "--audio-source",
                &self.audio_source,
                &["output", "playback", "mic"][..],
            ),
            (
                "--keyboard",
                &self.keyboard,
                &["sdk", "uhid", "disabled"][..],
            ),
            ("--mouse", &self.mouse, &["sdk", "uhid", "disabled"][..]),
            ("--gamepad", &self.gamepad, &["uhid", "disabled"][..]),
        ] {
            if let Some(value) = choice(value, allowed)? {
                command.arg(flag).arg(value);
            }
        }
        if let Some(facing) = choice(&self.camera, &["front", "back", "external"])? {
            if !self.display.is_empty() {
                return Err("invalidProfile");
            }
            command.args(["--video-source=camera", "--camera-facing", facing]);
        }
        if !self.display.is_empty() {
            let (w, h) = self.display.split_once('x').ok_or("invalidProfile")?;
            if ![w, h]
                .iter()
                .all(|v| v.parse::<u32>().is_ok_and(|n| (128..=8192).contains(&n)))
            {
                return Err("invalidProfile");
            }
            command.arg("--new-display").arg(&self.display);
        }
        for (enabled, flag) in [
            (self.mute, "--no-audio"),
            (self.read_only, "--no-control"),
            (self.top, "--always-on-top"),
            (self.fullscreen, "--fullscreen"),
            (self.screen_off, "--turn-screen-off"),
            (self.awake, "--stay-awake"),
            (self.forward, "--force-adb-forward"),
        ] {
            if enabled {
                command.arg(flag);
            }
        }
        if self.record {
            let path = if preview {
                app.path()
                    .video_dir()
                    .map_err(|_| "captureUnavailable")?
                    .join("ScrcpyController")
                    .join("screen-{timestamp}.mkv")
            } else {
                recording(app)?
            };
            command.arg("--record").arg(&path);
            return Ok(Some(path));
        }
        Ok(None)
    }
}
