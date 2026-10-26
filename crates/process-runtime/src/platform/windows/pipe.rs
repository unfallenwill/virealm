//! Named-pipe transport for the wire protocol.
//!
//! The pipe rejects remote clients and inherits the creating process's default
//! DACL, so only principals the current user can already act as can connect.
//! The default pipe name is fixed per protocol version; a named mutex per pipe
//! prevents two servers from sharing it.

use std::ffi::OsStr;
use std::fs::File;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr;
use std::sync::Arc;
use std::thread;

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ALREADY_EXISTS, ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::CreateMutexW;

use crate::ipc::{RuntimeState, handle_connection};

/// Default pipe name. Callers may override it, but both sides must agree.
pub const DEFAULT_PIPE_NAME: &str = r"\\.\pipe\virealm-runtime-v2";

const PIPE_BUFFER_BYTES: u32 = 64 * 1024;
const MUTEX_PREFIX: &str = r"Local\virealm-runtime-v2-server";

/// Run the pipe server until the process exits.
///
/// Errors are limited to failing to create the server; connection and request
/// errors are reported per connection and do not stop the server.
pub(crate) fn serve(pipe_name: &str) -> std::io::Result<()> {
    let _mutex = acquire_single_instance(pipe_name)?;
    let state = Arc::new(RuntimeState::new());

    eprintln!("virealm-runtime: listening on {pipe_name}");
    loop {
        let pipe = create_pipe(pipe_name)?;
        if !connect(pipe.as_raw_handle())? {
            continue;
        }

        let state = Arc::clone(&state);
        let file = File::from(pipe);
        thread::spawn(move || {
            let _ = handle_connection(file, &state);
        });
    }
}

fn acquire_single_instance(pipe_name: &str) -> std::io::Result<OwnedHandle> {
    let name = wide(&mutex_name(pipe_name));
    // SAFETY: `name` is a NUL-terminated wide string and the default security
    // descriptor applies the creator's DACL.
    let handle = unsafe { CreateMutexW(ptr::null(), 1, name.as_ptr()) };
    if handle.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: `GetLastError` has no preconditions.
    if unsafe { windows_sys::Win32::Foundation::GetLastError() } == ERROR_ALREADY_EXISTS {
        // SAFETY: the handle was created by this call.
        unsafe { CloseHandle(handle) };
        return Err(std::io::Error::new(
            std::io::ErrorKind::AddrInUse,
            "another virealm runtime server already owns the pipe",
        ));
    }
    // SAFETY: ownership transfers to the returned handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle as _) })
}

/// One server per pipe. Deriving the name from the pipe keeps independent
/// pipes usable side by side (tests, isolated hosts) without weakening the
/// single-writer guarantee for a given pipe.
fn mutex_name(pipe_name: &str) -> String {
    let suffix: String = pipe_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
                character
            } else {
                '_'
            }
        })
        .collect();
    format!("{MUTEX_PREFIX}-{suffix}")
}

fn create_pipe(name: &str) -> std::io::Result<OwnedHandle> {
    let name = wide(name);
    // SAFETY: the name is NUL-terminated; buffers are non-zero; the default
    // security descriptor gives the pipe the creator's DACL, and remote
    // clients are rejected.
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            PIPE_BUFFER_BYTES,
            PIPE_BUFFER_BYTES,
            0,
            ptr::null(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: `handle` is a fresh, valid handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle as _) })
}

fn connect(handle: HANDLE) -> std::io::Result<bool> {
    // SAFETY: `handle` is an unconnected server pipe instance.
    let connected = unsafe { ConnectNamedPipe(handle, ptr::null_mut()) };
    if connected != 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(ERROR_PIPE_CONNECTED as i32) {
        Ok(true)
    } else {
        Err(error)
    }
}

fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}
