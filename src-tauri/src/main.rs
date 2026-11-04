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
    tauri_app_lib::run();
    std::process::ExitCode::SUCCESS
}
