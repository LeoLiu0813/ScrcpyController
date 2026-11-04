// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli_client;
mod cli_protocol;

fn main() -> std::process::ExitCode {
    if std::env::args_os().len() > 1 {
        use windows_sys::Win32::System::Console::{ATTACH_PARENT_PROCESS, AttachConsole};
        unsafe { AttachConsole(ATTACH_PARENT_PROCESS); }
        return cli_client::run(true);
    }
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError},
        System::Threading::CreateMutexW,
    };
    let name = cli_protocol::wide(r"Global\ScrcpyController-desktop-v1");
    let instance = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    let already_running = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    if instance.is_null() || already_running {
        if !instance.is_null() {
            unsafe { CloseHandle(instance); }
        }
        cli_client::show_existing();
        return std::process::ExitCode::SUCCESS;
    }
    tauri_app_lib::run();
    unsafe { CloseHandle(instance); }
    std::process::ExitCode::SUCCESS
}
