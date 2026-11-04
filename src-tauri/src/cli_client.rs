use crate::cli_protocol::{self, MAX_LINE, Request, Response};
use std::{
    fs::{File, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle},
    process::ExitCode,
    ptr, thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY, WAIT_ABANDONED, WAIT_OBJECT_0,
    },
    Storage::FileSystem::{SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT},
    System::{
        Pipes::PeekNamedPipe,
        Threading::{CREATE_NO_WINDOW, CreateMutexW, CreateProcessW, PROCESS_INFORMATION, ReleaseMutex, STARTUPINFOW, WaitForSingleObject},
    },
};

const HELP: &str = "安卓控制台命令行\n\
用法：scrcpy-controller [--json] <命令>\n\
  devices                         列出设备\n\
  open <设备序列号>                打开或聚焦手机窗口\n\
  focus <设备序列号>               聚焦已有手机窗口\n\
  close <设备序列号>               关闭手机窗口\n\
  screenshot <设备序列号>          截图并返回路径与尺寸\n\
  tap <设备序列号> <横坐标> <纵坐标> <截图宽> <截图高>\n\
  toolbar <设备序列号> <操作>      控制和检查右侧快捷栏\n\
  tray <status|show|hide|device|lock|exit>  托盘状态与操作\n\
  --json                          输出单行结构化结果";

fn parse(args: &[String]) -> Option<Request> {
    Some(match args {
        [command, serial, operation, args @ ..] if command == "toolbar" && !serial.is_empty() => {
            Request::Toolbar {
                serial: serial.clone(),
                command: operation.clone(),
                args: args.to_vec(),
            }
        }
        [command, operation] if command == "tray" => Request::Tray {
            command: operation.clone(),
            serial: None,
        },
        [command, operation, serial] if command == "tray" && matches!(operation.as_str(), "device" | "lock") => {
            Request::Tray {
                command: operation.clone(),
                serial: Some(serial.clone()),
            }
        }
        [command] if command == "devices" => Request::Devices,
        [command, serial] if !serial.is_empty() => {
            let serial = serial.clone();
            match command.as_str() {
                "open" => Request::Open { serial },
                "focus" => Request::Focus { serial },
                "close" => Request::Close { serial },
                "screenshot" => Request::Screenshot { serial },
                _ => return None,
            }
        }
        [command, serial, x, y, width, height] if command == "tap" && !serial.is_empty() => {
            Request::Tap {
                serial: serial.clone(),
                x: x.parse().ok()?,
                y: y.parse().ok()?,
                width: width.parse().ok()?,
                height: height.parse().ok()?,
            }
        }
        _ => return None,
    })
}

fn open_pipe(name: &str) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .security_qos_flags(SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION)
        .open(name)
}

struct StartupLock(windows_sys::Win32::Foundation::HANDLE);
impl Drop for StartupLock {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.0);
            CloseHandle(self.0);
        }
    }
}

fn start_controller(integrated: bool) -> io::Result<()> {
    let current = std::env::current_exe()?;
    let app = if integrated { current } else { current.with_file_name("tauri-app.exe") };
    let path: Vec<_> = app.as_os_str().encode_wide().chain([0]).collect();
    let startup = STARTUPINFOW { cb: std::mem::size_of::<STARTUPINFOW>() as u32, ..Default::default() };
    let mut process = PROCESS_INFORMATION::default();
    unsafe {
        // The desktop process must not keep the CLI caller's redirected pipes open.
        if CreateProcessW(path.as_ptr(), ptr::null_mut(), ptr::null(), ptr::null(), 0,
            CREATE_NO_WINDOW, ptr::null(), ptr::null(), &startup, &mut process) == 0
        {
            return Err(io::Error::last_os_error());
        }
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }
    Ok(())
}

fn connect(integrated: bool, allow_start: bool) -> io::Result<File> {
    let (name, sid) = cli_protocol::endpoint()?;
    match open_pipe(&name) {
        Ok(pipe) => return Ok(pipe),
        Err(err) if matches!(err.raw_os_error(), Some(code) if code == ERROR_FILE_NOT_FOUND as i32 || code == ERROR_PIPE_BUSY as i32) =>
            {}
        Err(err) => return Err(err),
    }
    let lock_name = cli_protocol::wide(&format!(r"Local\ScrcpyController-cli-start-{sid}"));
    let mutex = unsafe { CreateMutexW(ptr::null(), 0, lock_name.as_ptr()) };
    if mutex.is_null() {
        return Err(io::Error::last_os_error());
    }
    if !matches!(
        unsafe { WaitForSingleObject(mutex, 25_000) },
        WAIT_OBJECT_0 | WAIT_ABANDONED
    ) {
        unsafe {
            CloseHandle(mutex);
        }
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "startup lock timeout",
        ));
    }
    let _lock = StartupLock(mutex);
    let deadline = Instant::now() + Duration::from_secs(18);
    let mut started = false;
    loop {
        match open_pipe(&name) {
            Ok(pipe) => return Ok(pipe),
            Err(err) if err.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) && !started && allow_start => {
                start_controller(integrated)?;
                started = true;
            }
            Err(err) if matches!(err.raw_os_error(), Some(code) if code == ERROR_FILE_NOT_FOUND as i32 || code == ERROR_PIPE_BUSY as i32) =>
                {}
            Err(err) => return Err(err),
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "controller unavailable",
            ));
        }
        thread::sleep(Duration::from_millis(80));
    }
}

fn call(request: &Request, integrated: bool, allow_start: bool) -> io::Result<Response> {
    let mut pipe = connect(integrated, allow_start)?;
    let mut bytes = serde_json::to_vec(request).map_err(io::Error::other)?;
    if bytes.len() >= MAX_LINE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "request too large",
        ));
    }
    bytes.push(b'\n');
    pipe.write_all(&bytes)?;
    let deadline = Instant::now() + Duration::from_secs(35);
    loop {
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
        if available != 0 {
            break;
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "response timeout"));
        }
        thread::sleep(Duration::from_millis(15));
    }
    let mut response = Vec::new();
    BufReader::new(pipe)
        .take(MAX_LINE as u64)
        .read_until(b'\n', &mut response)?;
    serde_json::from_slice(&response).map_err(io::Error::other)
}

#[allow(dead_code)]
pub fn show_existing() {
    let _ = call(&Request::Tray { command: "show".into(), serial: None }, true, false);
}

pub fn run(integrated: bool) -> ExitCode {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let json = args.iter().any(|arg| arg == "--json");
    let args: Vec<_> = args.into_iter().filter(|arg| arg != "--json").collect();
    if args.is_empty() && !json
        || matches!(args.as_slice(), [arg] if arg == "--help" || arg == "-h")
    {
        println!("{HELP}");
        return ExitCode::SUCCESS;
    }
    let (response, status) = match parse(&args) {
        Some(request) => match call(&request, integrated, true) {
            Ok(response) => {
                let status = if response.ok { 0 } else { 1 };
                (response, status)
            }
            Err(error) => {
                if !json {
                    eprintln!("无法联系安卓控制台：{error}");
                }
                (Response::failure("controllerUnavailable"), 3)
            }
        },
        None => (Response::failure("invalidArguments"), 2),
    };
    if json {
        println!("{}", serde_json::to_string(&response).unwrap());
    } else if response.ok {
        println!(
            "{}",
            serde_json::to_string_pretty(&response.result).unwrap()
        );
    } else {
        eprintln!("{}", response.error.as_deref().unwrap_or("unknownError"));
    }
    ExitCode::from(status)
}
