//! RAII and error helpers for Win32 handles.

use std::os::windows::io::{FromRawHandle, OwnedHandle, RawHandle};

use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};

use crate::error::{Result, RuntimeError};

/// Convert an owned Win32 handle into an [`OwnedHandle`].
///
/// The caller must transfer ownership exactly once. The returned value closes
/// the handle on drop.
pub fn from_raw(handle: HANDLE, operation: &str) -> Result<OwnedHandle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(RuntimeError::last_platform_error(operation));
    }

    // SAFETY: the caller transfers ownership of a valid, unique handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) })
}

/// Convert a `BOOL` result into a `Result`, preserving the last error.
pub fn check_bool(result: i32, operation: &str) -> Result<()> {
    if result == 0 {
        Err(RuntimeError::last_platform_error(operation))
    } else {
        Ok(())
    }
}

/// Convert a `WIN32_ERROR` result into a `Result`.
pub fn check_win32(code: u32, operation: &str) -> Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(RuntimeError::platform_error(operation, code))
    }
}

/// Whether a handle value is null or `INVALID_HANDLE_VALUE`.
pub fn is_invalid(handle: HANDLE) -> bool {
    handle.is_null() || handle == INVALID_HANDLE_VALUE
}
