use crate::devices::{QueryOutput, adb_path, capture_command, engine, read_devices, verify_device};
use std::{
    net::SocketAddr,
    os::windows::process::CommandExt,
    path::Path,
    process::{Command, Stdio},
    sync::Once,
    thread,
    time::{Duration, Instant},
};
use tauri::AppHandle;
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

type Result<T> = std::result::Result<T, &'static str>;

fn endpoint(value: &str) -> Result<String> {
    let value = value.trim();
    if let Ok(address) = value.parse::<SocketAddr>() {
        return if address.port() != 0 {
            Ok(address.to_string())
        } else {
            Err("invalidEndpoint")
        };
    }
    let (host, port) = value.rsplit_once(':').ok_or("invalidEndpoint")?;
    let port = port
        .parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
        .ok_or("invalidEndpoint")?;
    if host.is_empty()
        || host.len() > 253
        || !host.trim_end_matches('.').split('.').all(|part| {
            !part.is_empty()
                && part.len() <= 63
                && !part.starts_with('-')
                && !part.ends_with('-')
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return Err("invalidEndpoint");
    }
    Ok(format!("{}:{port}", host.to_ascii_lowercase()))
}

fn adb(path: &Path, args: &[&str], input: Option<&str>) -> Result<QueryOutput> {
    let mut command = Command::new(adb_path(path));
    command
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null());
    capture_command(command, input)
}

pub(crate) fn prepare_wireless(path: &Path) {
    static PREPARE: Once = Once::new();
    PREPARE.call_once(|| {
        // A legacy local server can share the client protocol version while lacking discovery.
        if ["ADB", "ADB_SERVER_SOCKET", "ANDROID_ADB_SERVER_ADDRESS", "ANDROID_ADB_SERVER_PORT"]
            .iter()
            .any(|name| std::env::var_os(name).is_some())
        {
            return;
        }
        let Ok(status) = adb(path, &["server-status"], None) else {
            return;
        };
        if status.text.contains("unknown host service")
            || status.text.lines().any(|line| line.trim() == "mdns_enabled: false")
        {
            if adb(path, &["kill-server"], None).is_ok_and(|output| output.success) {
                let _ = adb(path, &["start-server"], None);
            }
        }
    });
}

fn discovered(path: &Path) -> Vec<(String, String)> {
    let Ok(output) = adb(path, &["mdns", "services"], None) else {
        return vec![];
    };
    output
        .text
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let name = fields.next()?;
            if fields.next()?.trim_end_matches('.') != "_adb-tls-connect._tcp" {
                return None;
            }
            let address = endpoint(fields.next()?).ok()?;
            Some((format!("{name}._adb-tls-connect._tcp"), address))
        })
        .collect()
}

fn resolve(path: &Path, target: &str) -> Result<String> {
    if let Ok(address) = endpoint(target) {
        return Ok(address);
    }
    discovered(path)
        .into_iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(target.trim_end_matches('.')))
        .map(|(_, address)| address)
        .ok_or("wirelessAddressUnavailable")
}

#[tauri::command]
pub async fn pair_wireless(app: AppHandle, address: String, code: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let address = endpoint(&address)?;
        if code.len() != 6 || !code.bytes().all(|value| value.is_ascii_digit()) {
            return Err("invalidPairCode");
        }
        let path = engine(&app)?;
        let output = adb(&path, &["pair", &address], Some(&format!("{code}\n")))
            .map_err(|_| "pairFailed")?;
        if output.success
            && output
                .text
                .lines()
                .any(|line| line.contains("Successfully paired to "))
        {
            Ok(())
        } else {
            Err("pairFailed")
        }
    })
    .await
    .map_err(|_| "pairFailed")?
}

#[tauri::command]
pub async fn connect_wireless(
    app: AppHandle,
    target: String,
    saved_address: Option<String>,
) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = engine(&app)?;
        let address = match resolve(&path, &target) {
            Ok(address) => address,
            Err(error) => match saved_address {
                Some(saved) => endpoint(&saved)?,
                None => {
                    return Err(if target.ends_with("._adb-tls-connect._tcp") {
                        error
                    } else {
                        "invalidEndpoint"
                    });
                }
            },
        };
        let output = adb(&path, &["connect", &address], None).map_err(|_| "connectFailed")?;
        if !output.success
            || !output.text.lines().any(|line| {
                line.starts_with("connected to ") || line.starts_with("already connected to ")
            })
        {
            return Err("connectFailed");
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(devices) = read_devices(&path) {
                if devices.iter().any(|device| {
                    device.connection == "wireless"
                        && device.status == "online"
                        && (device.serial.eq_ignore_ascii_case(&address)
                            || device.serial.eq_ignore_ascii_case(&target))
                }) {
                    return Ok(address);
                }
            }
            if Instant::now() >= deadline {
                return Err("wirelessNotOnline");
            }
            thread::sleep(Duration::from_millis(200));
        }
    })
    .await
    .map_err(|_| "connectFailed")?
}

#[tauri::command]
pub async fn switch_to_wireless(app: AppHandle, serial: String, hardware: Option<String>) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = engine(&app)?;
        let wired = verify_device(&app, &serial, hardware.as_deref())?;
        if wired.connection != "wired" {
            return Err("deviceUnavailable");
        }
        let verified = wired.hardware.as_deref().ok_or("deviceVerifying")?;
        let prefix = format!("adb-{verified}-");
        let mut names: Vec<_> = discovered(&path)
            .into_iter()
            .map(|(name, _)| name)
            .filter(|name| name.starts_with(&prefix))
            .collect();
        names.sort_unstable();
        names.dedup();
        let [name] = names.as_slice() else {
            return Err("wiredWirelessUnavailable");
        };
        let output = adb(&path, &["connect", name], None).map_err(|_| "connectFailed")?;
        if !output.success {
            return Err("connectFailed");
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match verify_device(&app, name, Some(verified)) {
                Ok(_) => return Ok(name.clone()),
                Err("deviceUnavailable" | "deviceVerifying") if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(200));
                }
                Err(error) => return Err(error),
            }
        }
    })
    .await
    .map_err(|_| "connectFailed")?
}

#[tauri::command]
pub async fn disconnect_wireless(app: AppHandle, serial: String, hardware: Option<String>) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = engine(&app)?;
        let device = read_devices(&path)?.into_iter()
            .find(|device| device.serial == serial && device.connection == "wireless")
            .ok_or("deviceUnavailable")?;
        if device.status == "online" {
            verify_device(&app, &serial, hardware.as_deref())?;
        }
        let address = resolve(&path, &serial)?;
        let output = adb(&path, &["disconnect", &serial], None).map_err(|_| "disconnectFailed")?;
        if !output.success
            || !output
                .text
                .lines()
                .any(|line| line.starts_with("disconnected "))
        {
            return Err("disconnectFailed");
        }
        if read_devices(&path)?
            .iter()
            .any(|device| device.serial == serial && device.status == "online")
        {
            return Err("disconnectFailed");
        }
        Ok(address)
    })
    .await
    .map_err(|_| "disconnectFailed")?
}
