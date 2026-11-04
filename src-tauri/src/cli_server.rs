use crate::{
    cli_protocol::{self, MAX_LINE, Request, Response, wide},
    devices,
};
use serde_json::{Value, json};
use std::{
    fs::File,
    io::{self, Read, Write},
    mem,
    os::windows::io::{AsRawHandle, FromRawHandle},
    ptr, thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Listener};
use windows_sys::Win32::{
    Foundation::{ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE, LocalFree},
    Security::{
        Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1},
        SECURITY_ATTRIBUTES,
    },
    Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, FlushFileBuffers, PIPE_ACCESS_DUPLEX},
    System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_REJECT_REMOTE_CLIENTS,
        PeekNamedPipe,
    },
};

pub fn start(app: AppHandle) -> io::Result<()> {
    let (name, sid) = cli_protocol::endpoint()?;
    let pipe = unsafe {
        let mut descriptor = ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide(&format!("D:P(A;;GA;;;{sid})")).as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            ptr::null_mut(),
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        let attrs = SECURITY_ATTRIBUTES {
            nLength: mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let handle = CreateNamedPipeW(
            wide(&name).as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_REJECT_REMOTE_CLIENTS,
            1,
            MAX_LINE as u32,
            MAX_LINE as u32,
            0,
            &attrs,
        );
        let error = io::Error::last_os_error();
        LocalFree(descriptor);
        if handle == INVALID_HANDLE_VALUE {
            return Err(error);
        }
        File::from_raw_handle(handle)
    };
    thread::spawn(move || serve(app, pipe));
    Ok(())
}

fn serve(app: AppHandle, mut pipe: File) {
    let handle = pipe.as_raw_handle();
    loop {
        let connected = unsafe { ConnectNamedPipe(handle, ptr::null_mut()) } != 0
            || io::Error::last_os_error().raw_os_error() == Some(ERROR_PIPE_CONNECTED as i32);
        if !connected {
            break;
        }
        let mut exit = false;
        let response = match read_request(&mut pipe) {
            Ok(request) => {
                exit = matches!(&request, Request::Tray { command, serial: None } if command == "exit");
                match tauri::async_runtime::block_on(dispatch(&app, request)) {
                    Ok(result) => Response {
                        ok: true,
                        result: Some(result),
                        error: None,
                    },
                    Err(code) => Response::failure(code),
                }
            }
            Err(_) => Response::failure("invalidRequest"),
        };
        if let Ok(mut bytes) = serde_json::to_vec(&response) {
            if bytes.len() >= MAX_LINE {
                bytes = serde_json::to_vec(&Response::failure("responseTooLarge")).unwrap();
            }
            bytes.push(b'\n');
            if pipe.write_all(&bytes).is_ok() {
                unsafe { FlushFileBuffers(handle) };
            }
        }
        unsafe { DisconnectNamedPipe(handle) };
        if exit {
            crate::tray::quit(&app);
            break;
        }
    }
}

fn read_request(pipe: &mut File) -> io::Result<Request> {
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut line = Vec::new();
    let mut buffer = [0; 4096];
    while line.len() < MAX_LINE && Instant::now() < deadline {
        let mut available = 0;
        if unsafe {
            PeekNamedPipe(
                pipe.as_raw_handle(),
                ptr::null_mut(),
                0,
                ptr::null_mut(),
                &mut available,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if available == 0 {
            thread::sleep(Duration::from_millis(10));
            continue;
        }
        let count = (available as usize)
            .min(buffer.len())
            .min(MAX_LINE - line.len());
        let bytes = pipe.read(&mut buffer[..count])?;
        line.extend_from_slice(&buffer[..bytes]);
        if let Some(end) = line.iter().position(|&b| b == b'\n') {
            return serde_json::from_slice(&line[..end]).map_err(io::Error::other);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid request length",
    ))
}

async fn dispatch(app: &AppHandle, request: Request) -> Result<Value, &'static str> {
    match request {
        Request::Toolbar {
            serial,
            command,
            args,
        } => toolbar(app, &serial, &command, args).await,
        Request::Tray { command, serial } => match (command.as_str(), serial) {
            ("status", None) => crate::tray::status(app),
            ("show", None) => {
                crate::tray::show(app)?;
                Ok(json!({ "visible": true }))
            }
            ("hide", None) => {
                crate::tray::hide(app)?;
                Ok(json!({ "visible": false }))
            }
            ("device", Some(serial)) => {
                crate::tray::open_device(app, serial).await?;
                Ok(json!({ "opened": true }))
            }
            ("lock", Some(serial)) => {
                devices::lock_device(app.clone(), serial).await?;
                Ok(json!({ "locked": true }))
            }
            ("exit", None) => Ok(json!({ "exiting": true })),
            _ => Err("invalidArguments"),
        },
        Request::Devices => serde_json::to_value(devices::list_devices(app.clone()).await?)
            .map_err(|_| "sessionError"),
        Request::Open { serial } => {
            let alias = crate::tray::configured_name(app, &serial);
            let recording = devices::open_device(app.clone(), serial.clone(), alias, None).await?;
            Ok(json!({ "serial": serial, "recording": recording }))
        }
        Request::Focus { serial } => {
            devices::cli_focus(app.clone(), serial.clone()).await?;
            Ok(json!({ "serial": serial }))
        }
        Request::Close { serial } => {
            devices::cli_close(app.clone(), serial.clone()).await?;
            Ok(json!({ "serial": serial, "state": "closed" }))
        }
        Request::Screenshot { serial } => {
            let (path, width, height) =
                devices::cli_screenshot(app.clone(), serial.clone()).await?;
            Ok(json!({ "serial": serial, "path": path, "width": width, "height": height }))
        }
        Request::Tap {
            serial,
            x,
            y,
            width,
            height,
        } => {
            devices::cli_tap(app.clone(), serial.clone(), x, y, width, height).await?;
            Ok(json!({ "serial": serial, "x": x, "y": y }))
        }
    }
}

async fn toolbar(
    app: &AppHandle,
    serial: &str,
    operation: &str,
    args: Vec<String>,
) -> Result<Value, &'static str> {
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    };
    static NEXT: AtomicU64 = AtomicU64::new(1);
    if operation == "app-open" {
        let [package, width, height] = args.as_slice() else {
            return Err("invalidArguments");
        };
        let display = devices::AppDisplay::Fixed {
            width: width.parse().map_err(|_| "invalidArguments")?,
            height: height.parse().map_err(|_| "invalidArguments")?,
            wechat_insets: false,
        };
        let title = crate::tray::configured_name(app, serial)
            .map_or_else(|| package.clone(), |name| format!("{package} · {name}"));
        devices::open_app_window(
            app.clone(),
            serial.to_owned(),
            package.clone(),
            title,
            display,
        )
        .await?;
        return Ok(json!({ "opened": true }));
    }
    let (operation, args, package) = match operation {
        "app-state" | "app-close" => {
            let [package] = args.as_slice() else {
                return Err("invalidArguments");
            };
            (
                if operation == "app-state" {
                    "state"
                } else {
                    "close"
                },
                Vec::new(),
                Some(package.clone()),
            )
        }
        "app-toolbar" => {
            let [package, command, rest @ ..] = args.as_slice() else {
                return Err("invalidArguments");
            };
            (command.as_str(), rest.to_vec(), Some(package.clone()))
        }
        _ => (operation, args.clone(), None),
    };
    let window = if let Some(package) = package.as_deref() {
        devices::cli_virtual_window(app, serial, package)?
    } else {
        devices::cli_mirror_window(app, serial)?
    };
    if operation == "close" && package.is_some() {
        window.close().map_err(|_| "windowPending")?;
        return Ok(json!({ "closed": true }));
    }
    if operation == "drag-window" {
        let [dx, dy] = args.as_slice() else {
            return Err("invalidArguments");
        };
        let (dx, dy) = (
            dx.parse().map_err(|_| "invalidArguments")?,
            dy.parse().map_err(|_| "invalidArguments")?,
        );
        crate::mirror::drag_window(&window, dx, dy)?;
        return Ok(json!({ "dx": dx, "dy": dy }));
    }
    if operation == "click-video" {
        let [x, y] = args.as_slice() else {
            return Err("invalidArguments");
        };
        let (x, y) = (
            x.parse().map_err(|_| "invalidArguments")?,
            y.parse().map_err(|_| "invalidArguments")?,
        );
        devices::cli_click_video(&window, x, y)?;
        return Ok(json!({ "x": x, "y": y }));
    }
    if !matches!(
        operation,
        "state"
            | "action"
            | "more"
            | "drag"
            | "exit-fullscreen"
            | "minimize"
            | "restore"
            | "move"
            | "resize"
            | "pin"
            | "apps"
            | "app"
            | "style"
            | "tip"
            | "sidebar"
            | "border"
    ) {
        return Err("invalidArguments");
    }
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = mpsc::sync_channel(1);
    let listener = app.listen_any(format!("mirror-cli-response-{id}"), move |event| {
        if let Ok(response) = serde_json::from_str::<Response>(event.payload()) {
            let _ = sender.try_send(response);
        }
    });
    let emitted = app.emit_to(
        window.label(),
        &format!("mirror-cli-request-{}", window.label()),
        json!({ "id": id, "operation": operation, "args": args }),
    );
    let reply = if emitted.is_ok() {
        tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(15)))
            .await
            .ok()
            .and_then(Result::ok)
    } else {
        None
    };
    app.unlisten(listener);
    let reply = reply.ok_or("toolbarUnavailable")?;
    if !reply.ok {
        return Err(match reply.error.as_deref() {
            Some("invalidArguments") => "invalidArguments",
            Some("captureUnavailable") => "captureUnavailable",
            Some("mirrorFrameFailed") => "mirrorFrameFailed",
            _ => "mirrorActionFailed",
        });
    }
    let mut result = reply.result.unwrap_or(Value::Null);
    if operation == "state" {
        result["native"] = devices::cli_video_geometry(&window)?;
    }
    Ok(result)
}
