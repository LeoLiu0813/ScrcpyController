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
    mute: Option<bool>,
    audio_mode: String,
    audio_codec: String,
    audio_bit_rate: u32,
    audio_buffer: u32,
    video_buffer: u32,
    crop: String,
    capture_orientation: String,
    video_encoder: String,
    audio_encoder: String,
    record_format: String,
    record_folder: String,
    record_seconds: u32,
    camera_id: String,
    camera_size: String,
    camera_fps: u32,
    camera_high_speed: bool,
    camera_torch: bool,
    camera_zoom: String,
    no_clipboard_sync: bool,
    legacy_paste: bool,
    push_target: String,
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
    extra_args: Vec<String>,
    #[serde(flatten)]
    pub(crate) startup: StartupPlacement,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct StartupPlacement {
    pub startup_x: Option<i32>,
    pub startup_y: Option<i32>,
    pub startup_width: Option<u32>,
    pub startup_height: Option<u32>,
}

impl StartupPlacement {
    pub(crate) fn validate(self) -> Result<()> {
        // Older profiles use physical pixels. Keep their values valid and
        // apply the logical window minimum at the destination monitor's scale.
        if self.startup_width.is_some_and(|width| !(160..=16384).contains(&width))
            || self.startup_height.is_some_and(|height| !(310..=16384).contains(&height))
        {
            return Err("invalidStartupPlacement");
        }
        Ok(())
    }

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
    recording_path(app, "", "screen", "mkv", false)
}

pub(crate) fn recording_path(
    app: &AppHandle, folder: &str, prefix: &str, format: &str, preview: bool,
) -> Result<PathBuf> {
    let dir = if folder.trim().is_empty() {
        app.path().video_dir().map_err(|_| "captureUnavailable")?.join("ScrcpyController")
    } else {
        let path = PathBuf::from(folder);
        if !path.is_absolute() { return Err("invalidRecordFolder"); }
        path
    };
    if preview {
        return Ok(dir.join(format!("{prefix}-{{timestamp}}.{format}")));
    }
    if folder.trim().is_empty() {
        std::fs::create_dir_all(&dir).map_err(|_| "captureUnavailable")?;
    } else if !dir.is_dir() {
        return Err("invalidRecordFolder");
    }
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH)
        .map_err(|_| "captureUnavailable")?.as_nanos();
    let probe = dir.join(format!(".scrcpy-write-{stamp}.tmp"));
    let file = std::fs::OpenOptions::new().write(true).create_new(true).open(&probe)
        .map_err(|_| "invalidRecordFolder")?;
    drop(file);
    std::fs::remove_file(probe).map_err(|_| "invalidRecordFolder")?;
    Ok(dir.join(format!("{prefix}-{stamp}.{format}")))
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

fn safe_token(value: &str) -> bool {
    value.len() <= 128 && value.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}

fn dimensions(value: &str) -> bool {
    value.split_once('x').is_some_and(|(w, h)| [w, h].iter()
        .all(|part| part.parse::<u32>().is_ok_and(|n| (128..=8192).contains(&n))))
}

pub(crate) fn android_folder(value: &str) -> bool {
    value.starts_with('/') && value.len() <= 512
        && !value.chars().any(char::is_control)
        && !value.split('/').any(|segment| segment == "..")
}

fn launch_arg_valid(arg: &str) -> bool {
    if arg.len() > 1024 || arg.chars().any(char::is_control) {
        return false;
    }
    let (name, value) = arg.split_once('=').unwrap_or((arg, ""));
    let number = |min, max| value.parse::<u32>().is_ok_and(|n| (min..=max).contains(&n));
    let bit_rate = |max| {
        let (digits, multiplier) = if let Some(digits) = value.strip_suffix('M') {
            (digits, 1_000_000)
        } else if let Some(digits) = value.strip_suffix('K') {
            (digits, 1000)
        } else {
            (value, 1)
        };
        digits.parse::<u32>().ok().and_then(|rate| rate.checked_mul(multiplier))
            .is_some_and(|rate| (1..=max).contains(&rate))
    };
    let rotations = ["0", "90", "180", "270"];
    match name {
        "--max-size" => number(0, 8192),
        "--max-fps" => value.parse::<f32>().is_ok_and(|fps| (0.0..=240.0).contains(&fps)),
        "--video-bit-rate" => bit_rate(200_000_000),
        "--audio-bit-rate" => bit_rate(512_000),
        "--video-buffer" | "--audio-buffer" | "--audio-output-buffer" => number(0, 5000),
        "--time-limit" => number(3, 3600),
        "--video-codec" => matches!(value, "h264" | "h265" | "av1"),
        "--audio-codec" => matches!(value, "opus" | "aac" | "flac" | "raw"),
        "--video-encoder" | "--audio-encoder" => !value.is_empty() && safe_token(value),
        "--video-codec-options" | "--audio-codec-options" => !value.is_empty(),
        "--display-orientation" => rotations.contains(&value)
            || value.strip_prefix("flip").is_some_and(|value| rotations.contains(&value)),
        "--capture-orientation" => value == "@"
            || rotations.contains(&value.strip_prefix('@').unwrap_or(value)),
        "--record-orientation" => rotations.contains(&value),
        "--angle" => value.parse::<f64>().is_ok_and(|value| (-360.0..=360.0).contains(&value)),
        "--no-mipmaps" | "--no-downsize-on-error" | "--no-mouse-hover" | "--no-key-repeat"
        | "--prefer-text" | "--raw-key-events" | "--no-power-on" | "--disable-screensaver"
        | "--power-off-on-close" | "--show-touches" | "--no-clipboard-autosync" | "--legacy-paste"
        | "--no-audio-playback" | "--require-audio" | "--stay-awake" | "--turn-screen-off" => arg == name,
        _ => false,
    }
}

impl Profile {
    pub(crate) fn is_camera(&self) -> bool {
        !self.camera.is_empty() || !self.camera_id.is_empty()
    }

    pub(crate) fn for_camera(mut self) -> Self {
        if !self.is_camera() { self.camera = "back".into(); }
        self.crop.clear();
        self.display.clear();
        self
    }

    pub(crate) fn validate_crop(&self, width: u32, height: u32) -> Result<()> {
        if self.crop.is_empty() { return Ok(()); }
        let values: Vec<_> = self.crop.split(':').map(str::parse::<u32>).collect();
        if !matches!(values.as_slice(), [Ok(w), Ok(h), Ok(x), Ok(y)]
            if *w > 0 && *h > 0 && x.checked_add(*w).is_some_and(|end| end <= width)
                && y.checked_add(*h).is_some_and(|end| end <= height)) {
            return Err("invalidCrop");
        }
        Ok(())
    }

    pub(crate) fn has_crop(&self) -> bool { !self.crop.is_empty() }

    fn apply_audio(&self, command: &mut Command) -> Result<()> {
        let mode = choice(&self.audio_mode, &["phone", "computer", "both", "recordOnly"])?
            .unwrap_or(if self.mute.unwrap_or(true) { "phone" } else { "computer" });
        if mode == "phone" {
            command.arg("--no-audio");
            return Ok(());
        }
        if mode == "both" {
            command.arg("--audio-dup");
        } else if let Some(source) = choice(&self.audio_source, &["output", "playback", "mic"])? {
            command.args(["--audio-source", source]);
        }
        if mode == "recordOnly" {
            if !self.record { return Err("invalidProfile"); }
            command.arg("--no-audio-playback");
        }
        if let Some(codec) = choice(&self.audio_codec, &["opus", "aac", "flac", "raw"])? {
            command.args(["--audio-codec", codec]);
        }
        if self.audio_bit_rate > 512 || self.audio_buffer > 5000 { return Err("invalidProfile"); }
        if self.audio_bit_rate > 0 && self.audio_codec != "raw" {
            command.arg("--audio-bit-rate").arg(format!("{}K", self.audio_bit_rate));
        }
        if self.audio_buffer > 0 {
            command.arg("--audio-buffer").arg(self.audio_buffer.to_string());
        }
        if !self.audio_encoder.is_empty() {
            if !safe_token(&self.audio_encoder) { return Err("invalidProfile"); }
            command.args(["--audio-encoder", &self.audio_encoder]);
        }
        Ok(())
    }

    pub fn apply(
        &self,
        command: &mut Command,
        app: &AppHandle,
        preview: bool,
    ) -> Result<Option<PathBuf>> {
        self.startup.validate()?;
        let mut names = std::collections::HashSet::new();
        if self.extra_args.len() > 32 || self.extra_args.iter().any(|arg| {
            !launch_arg_valid(arg) || !names.insert(arg.split_once('=').map_or(arg.as_str(), |(name, _)| name))
        }) {
            return Err("invalidLaunchArguments");
        }
        for (flag, value, max) in [
            ("--max-size", self.max_size, 8192),
            ("--max-fps", self.max_fps, 240),
            ("--video-bit-rate", self.bit_rate, 200),
            ("--video-buffer", self.video_buffer, 5000),
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
        let camera = choice(&self.camera, &["front", "back", "external"])?;
        if camera.is_some() || !self.camera_id.is_empty() {
            if !self.display.is_empty() || !self.crop.is_empty() { return Err("invalidProfile"); }
            command.arg("--video-source=camera");
            if !self.camera_id.is_empty() {
                if !safe_token(&self.camera_id) { return Err("invalidProfile"); }
                command.args(["--camera-id", &self.camera_id]);
            } else if let Some(facing) = camera {
                command.args(["--camera-facing", facing]);
            }
            if !self.camera_size.is_empty() {
                if !dimensions(&self.camera_size) { return Err("invalidProfile"); }
                command.args(["--camera-size", &self.camera_size]);
            }
            if self.camera_fps > 240 { return Err("invalidProfile"); }
            if self.camera_fps > 0 { command.arg("--camera-fps").arg(self.camera_fps.to_string()); }
            if self.camera_high_speed {
                if self.camera_size.is_empty() || self.camera_fps < 60 { return Err("invalidProfile"); }
                command.arg("--camera-high-speed");
            }
            if self.camera_torch { command.arg("--camera-torch"); }
            if !self.camera_zoom.is_empty() {
                if !self.camera_zoom.parse::<f32>().is_ok_and(|v| (0.1..=100.0).contains(&v)) {
                    return Err("invalidProfile");
                }
                command.args(["--camera-zoom", &self.camera_zoom]);
            }
        }
        if !self.crop.is_empty() {
            self.validate_crop(8192, 8192)?;
            command.args(["--crop", &self.crop]);
        }
        if let Some(orientation) = choice(&self.capture_orientation, &["@", "@0", "@90", "@180", "@270"])? {
            command.args(["--capture-orientation", orientation]);
        }
        if !self.video_encoder.is_empty() {
            if !safe_token(&self.video_encoder) { return Err("invalidProfile"); }
            command.args(["--video-encoder", &self.video_encoder]);
        }
        if !self.push_target.is_empty() {
            if !android_folder(&self.push_target) { return Err("invalidPushTarget"); }
            command.args(["--push-target", &self.push_target]);
        }
        self.apply_audio(command)?;
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
            (self.no_clipboard_sync, "--no-clipboard-autosync"),
            (self.legacy_paste, "--legacy-paste"),
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
            let format = choice(&self.record_format, &["mkv", "mp4"])?.unwrap_or("mkv");
            if self.record_seconds > 0 {
                if !(3..=3600).contains(&self.record_seconds) { return Err("invalidDuration"); }
                command.arg("--time-limit").arg(self.record_seconds.to_string());
            }
            let path = recording_path(app, &self.record_folder, "screen", format, preview)?;
            command.arg("--record").arg(&path);
            command.args(&self.extra_args);
            return Ok(Some(path));
        }
        command.args(&self.extra_args);
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_profiles_keep_audio_on_phone_and_legacy_settings_are_respected() {
        for (json, flag) in [
            ("{}", Some("--no-audio")),
            (r#"{"mute":false}"#, None),
            (r#"{"mute":true,"audioMode":"computer"}"#, None),
            (r#"{"audioMode":"both"}"#, Some("--audio-dup")),
            (r#"{"audioMode":"recordOnly","record":true}"#, Some("--no-audio-playback")),
        ] {
            let profile: Profile = serde_json::from_str(json).unwrap();
            let mut command = Command::new("scrcpy");
            profile.apply_audio(&mut command).unwrap();
            assert_eq!(command.get_args().next().and_then(|arg| arg.to_str()), flag);
        }
        let mut command = Command::new("scrcpy");
        assert!(Profile { audio_mode: "recordOnly".into(), ..Profile::default() }.apply_audio(&mut command).is_err());
    }

    #[test]
    fn crop_must_fit_the_phone_screen() {
        let profile = Profile { crop: "960:1800:120:500".into(), ..Profile::default() };
        assert!(profile.validate_crop(1080, 2400).is_ok());
        assert_eq!(profile.validate_crop(1079, 2400), Err("invalidCrop"));
        assert_eq!(profile.validate_crop(1080, 2299), Err("invalidCrop"));
    }

    #[test]
    fn startup_placement_accepts_negative_screen_coordinates_and_partial_values() {
        let profile: Profile = serde_json::from_str(
            r#"{"startupX":-1200,"startupY":null,"startupWidth":640,"extraArgs":["--max-fps=30"]}"#,
        ).unwrap();
        assert_eq!(profile.startup.startup_x, Some(-1200));
        assert_eq!(profile.startup.startup_y, None);
        assert_eq!(profile.startup.startup_width, Some(640));
        assert_eq!(profile.startup.startup_height, None);
        assert!(profile.startup.validate().is_ok());
        assert_eq!(profile.extra_args, ["--max-fps=30"]);
        let startup = Profile::default().startup;
        assert_eq!((startup.startup_x, startup.startup_y, startup.startup_width, startup.startup_height),
            (None, None, None, None));
        assert_eq!(StartupPlacement { startup_height: Some(309), ..Default::default() }.validate(), Err("invalidStartupPlacement"));
    }

    #[test]
    fn extra_launch_arguments_allow_tuning_but_protect_managed_options() {
        for arg in ["--max-fps=29.97", "--video-bit-rate=8M", "--no-mipmaps", "--display-orientation=90",
            "--video-codec-options=priority:int=0"] {
            assert!(launch_arg_valid(arg), "{arg}");
        }
        for arg in ["--serial=other", "--window-x=99", "--port=27183", "--no-window", "--record=movie.mp4",
            "--kill-adb-on-close", "--max-fps=999", "--max-fps=30\n--serial=other", "--no-mipmaps=1"] {
            assert!(!launch_arg_valid(arg), "{arg}");
        }
    }
}
