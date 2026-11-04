use serde::{Deserialize, Serialize};
use std::{io, mem, ptr};
use windows_sys::Win32::{
    Foundation::{CloseHandle, LocalFree},
    Security::{
        Authorization::ConvertSidToStringSidW, GetTokenInformation, TOKEN_QUERY, TOKEN_USER,
        TokenUser,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

pub const MAX_LINE: usize = 64 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Toolbar {
        serial: String,
        command: String,
        args: Vec<String>,
    },
    Tray {
        command: String,
        serial: Option<String>,
    },
    Devices,
    Open {
        serial: String,
    },
    Focus {
        serial: String,
    },
    Close {
        serial: String,
    },
    Screenshot {
        serial: String,
    },
    Tap {
        serial: String,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    },
}

#[derive(Serialize, Deserialize)]
pub struct Response {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Response {
    pub fn failure(code: impl Into<String>) -> Self {
        Self {
            ok: false,
            result: None,
            error: Some(code.into()),
        }
    }
}

pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain([0]).collect()
}

pub fn endpoint() -> io::Result<(String, String)> {
    unsafe {
        let mut token = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut size = 0;
        GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut size);
        let mut data = vec![0usize; (size as usize).div_ceil(mem::size_of::<usize>())];
        let success = size as usize >= mem::size_of::<TOKEN_USER>()
            && GetTokenInformation(token, TokenUser, data.as_mut_ptr().cast(), size, &mut size)
                != 0;
        let error = io::Error::last_os_error();
        CloseHandle(token);
        if !success {
            return Err(error);
        }
        let user = &*data.as_ptr().cast::<TOKEN_USER>();
        let mut sid = ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut sid) == 0 {
            return Err(io::Error::last_os_error());
        }
        let len = (0..).find(|&i| *sid.add(i) == 0).unwrap();
        let string = String::from_utf16_lossy(std::slice::from_raw_parts(sid, len));
        LocalFree(sid.cast());
        Ok((format!(r"\\.\pipe\ScrcpyController-v1-{string}"), string))
    }
}
