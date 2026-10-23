//! Token inspection and restricted-token creation.
//!
//! Tokens are opened read-only unless a restricted token is deliberately
//! produced. Query helpers accept a raw handle so they work for both the
//! caller's token and a child's token.

use std::mem::size_of;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};

use windows_sys::Win32::Foundation::{HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::ConvertStringSidToSidW;
use windows_sys::Win32::Security::{
    CreateRestrictedToken, CreateWellKnownSid, DISABLE_MAX_PRIVILEGE, EqualSid, GetSidSubAuthority,
    GetSidSubAuthorityCount, GetTokenInformation, IsValidSid, SE_PRIVILEGE_ENABLED,
    SECURITY_MAX_SID_SIZE, SID_AND_ATTRIBUTES, SetTokenInformation, TOKEN_ADJUST_DEFAULT,
    TOKEN_ADJUST_SESSIONID, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_ELEVATION, TOKEN_GROUPS,
    TOKEN_MANDATORY_LABEL, TOKEN_PRIVILEGES, TOKEN_QUERY, TokenCapabilities, TokenElevation,
    TokenIntegrityLevel, TokenIsAppContainer, TokenPrivileges, WinLowLabelSid,
};
use windows_sys::Win32::System::SystemServices::{SE_GROUP_ENABLED, SE_GROUP_INTEGRITY};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use crate::capabilities::IntegrityLevel;
use crate::error::{Result, RuntimeError};

/// Open the current process token for query access.
pub fn open_current() -> Result<OwnedHandle> {
    open_for(
        unsafe { GetCurrentProcess() },
        TOKEN_QUERY,
        "OpenProcessToken",
    )
}

/// Open a process token with the requested access.
pub(crate) fn open_for(process: HANDLE, access: u32, operation: &str) -> Result<OwnedHandle> {
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: the process handle is valid for the duration of the call and
    // `token` is a writable out-parameter.
    let ok = unsafe { OpenProcessToken(process, access, &mut token) };
    if ok == 0 {
        return Err(RuntimeError::last_platform_error(operation));
    }
    // SAFETY: ownership of the newly created token handle is transferred.
    Ok(unsafe { OwnedHandle::from_raw_handle(token as RawHandle) })
}

/// Whether the token is elevated.
pub fn is_elevated(token: HANDLE) -> Result<bool> {
    let buffer = TokenBuffer::query(token, TokenElevation)?;
    // SAFETY: TokenElevation returns a TOKEN_ELEVATION value.
    let elevation = unsafe { &*buffer.as_ptr::<TOKEN_ELEVATION>() };
    Ok(elevation.TokenIsElevated != 0)
}

/// Integrity level of the token.
pub fn integrity_level(token: HANDLE) -> Result<IntegrityLevel> {
    let buffer = TokenBuffer::query(token, TokenIntegrityLevel)?;
    // SAFETY: TokenIntegrityLevel returns a TOKEN_MANDATORY_LABEL.
    let label = unsafe { &*buffer.as_ptr::<TOKEN_MANDATORY_LABEL>() };
    if label.Label.Sid.is_null() {
        return Ok(IntegrityLevel::Unknown);
    }

    // SAFETY: the SID is owned by the token information buffer.
    let count = unsafe { *GetSidSubAuthorityCount(label.Label.Sid) } as u32;
    if count == 0 {
        return Ok(IntegrityLevel::Unknown);
    }
    // SAFETY: the last sub-authority exists because count > 0.
    let rid = unsafe { *GetSidSubAuthority(label.Label.Sid, count - 1) };

    Ok(match rid {
        0x0000 => IntegrityLevel::Untrusted,
        0x1000 => IntegrityLevel::Low,
        0x2000 => IntegrityLevel::Medium,
        0x3000 => IntegrityLevel::High,
        0x4000 => IntegrityLevel::System,
        0x5000 => IntegrityLevel::Protected,
        _ => IntegrityLevel::Unknown,
    })
}

/// Whether the token is an AppContainer token.
pub fn is_app_container(token: HANDLE) -> Result<bool> {
    query_u32(token, TokenIsAppContainer).map(|value| value != 0)
}

/// Number of privileges currently enabled in the token.
///
/// `CreateRestrictedToken` with `DISABLE_MAX_PRIVILEGE` leaves only
/// `SeChangeNotifyPrivilege` enabled, so a verified restricted token reports
/// at most one enabled privilege.
pub fn enabled_privilege_count(token: HANDLE) -> Result<u32> {
    let buffer = TokenBuffer::query(token, TokenPrivileges)?;
    // SAFETY: TokenPrivileges returns a TOKEN_PRIVILEGES whose variable-length
    // `Privileges` array has `PrivilegeCount` entries.
    let privileges = unsafe { &*buffer.as_ptr::<TOKEN_PRIVILEGES>() };
    let count = privileges.PrivilegeCount as usize;
    // SAFETY: the array is part of the queried token information buffer.
    let entries = unsafe { std::slice::from_raw_parts(privileges.Privileges.as_ptr(), count) };
    Ok(entries
        .iter()
        .filter(|entry| entry.Attributes & SE_PRIVILEGE_ENABLED != 0)
        .count() as u32)
}

/// Whether the token carries the given capability SID.
pub fn has_capability(token: HANDLE, sid_string: &str) -> Result<bool> {
    let sid = StringSid::parse(sid_string)?;
    let buffer = TokenBuffer::query(token, TokenCapabilities)?;

    // SAFETY: TokenCapabilities returns a TOKEN_GROUPS whose `Groups` array is
    // `GroupCount` entries long.
    let groups = unsafe { &*buffer.as_ptr::<TOKEN_GROUPS>() };
    let entries = groups.Groups.as_ptr();
    for index in 0..groups.GroupCount as usize {
        // SAFETY: index is below GroupCount.
        let entry = unsafe { &*entries.add(index) };
        if unsafe { EqualSid(entry.Sid, sid.0) } != 0 {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Create a restricted token with all privileges removed, disable-maximum
/// privilege, and a low integrity label.
///
/// The caller must keep the returned token alive until process creation
/// completes. Using it does not by itself confine filesystem paths or network
/// access; only an AppContainer token does that.
pub fn create_restricted_low_token() -> Result<OwnedHandle> {
    let existing = open_for(
        unsafe { GetCurrentProcess() },
        TOKEN_QUERY
            | TOKEN_DUPLICATE
            | TOKEN_ASSIGN_PRIMARY
            | TOKEN_ADJUST_DEFAULT
            | TOKEN_ADJUST_SESSIONID,
        "OpenProcessToken(current)",
    )?;

    let mut restricted: HANDLE = std::ptr::null_mut();
    // SAFETY: no SIDs or privileges are disabled explicitly; DISABLE_MAX_PRIVILEGE
    // removes all privileges from the new token. The output handle is writable.
    let ok = unsafe {
        CreateRestrictedToken(
            existing.as_raw_handle() as HANDLE,
            DISABLE_MAX_PRIVILEGE,
            0,
            std::ptr::null(),
            0,
            std::ptr::null(),
            0,
            std::ptr::null(),
            &mut restricted,
        )
    };
    if ok == 0 {
        return Err(RuntimeError::last_platform_error("CreateRestrictedToken"));
    }
    // SAFETY: ownership of the new token handle is transferred.
    let restricted = unsafe { OwnedHandle::from_raw_handle(restricted as RawHandle) };

    set_low_integrity(restricted.as_raw_handle() as HANDLE)?;

    Ok(restricted)
}

fn set_low_integrity(token: HANDLE) -> Result<()> {
    let mut sid_buffer = vec![0u8; SECURITY_MAX_SID_SIZE as usize];
    let mut sid_size = SECURITY_MAX_SID_SIZE;
    // SAFETY: the buffer is SECURITY_MAX_SID_SIZE bytes; the SID is written into it.
    let ok = unsafe {
        CreateWellKnownSid(
            WinLowLabelSid,
            std::ptr::null_mut(),
            sid_buffer.as_mut_ptr().cast(),
            &mut sid_size,
        )
    };
    if ok == 0 {
        return Err(RuntimeError::last_platform_error("CreateWellKnownSid"));
    }

    let label = TOKEN_MANDATORY_LABEL {
        Label: SID_AND_ATTRIBUTES {
            Sid: sid_buffer.as_mut_ptr().cast(),
            Attributes: SE_GROUP_INTEGRITY as u32,
        },
    };

    // SAFETY: the label points into `sid_buffer`, which outlives the call.
    let ok = unsafe {
        SetTokenInformation(
            token,
            TokenIntegrityLevel,
            (&label as *const TOKEN_MANDATORY_LABEL).cast(),
            size_of::<TOKEN_MANDATORY_LABEL>() as u32,
        )
    };
    if ok == 0 {
        return Err(RuntimeError::last_platform_error("SetTokenInformation"));
    }
    Ok(())
}

fn query_u32(token: HANDLE, class: i32) -> Result<u32> {
    let buffer = TokenBuffer::query(token, class)?;
    // SAFETY: boolean token information classes return a single DWORD.
    Ok(unsafe { *buffer.as_ptr::<u32>() })
}

/// Owned, word-aligned buffer for `GetTokenInformation`.
struct TokenBuffer {
    words: Vec<usize>,
}

impl TokenBuffer {
    fn query(token: HANDLE, class: i32) -> Result<Self> {
        let mut needed = 0u32;
        // SAFETY: a zero-length query returns the required size in `needed`
        // and is expected to fail with ERROR_INSUFFICIENT_BUFFER.
        unsafe {
            GetTokenInformation(token, class, std::ptr::null_mut(), 0, &mut needed);
        }
        if needed == 0 {
            return Err(RuntimeError::last_platform_error(
                "GetTokenInformation(size)",
            ));
        }

        let word_size = size_of::<usize>();
        let words = (needed as usize).div_ceil(word_size);
        let mut buffer = vec![0usize; words];
        let mut written = 0u32;
        // SAFETY: the buffer is at least `needed` bytes and is writable. The
        // exact required length is passed because some token classes reject a
        // larger buffer with ERROR_BAD_LENGTH.
        let ok = unsafe {
            GetTokenInformation(
                token,
                class,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut written,
            )
        };
        if ok == 0 {
            return Err(RuntimeError::last_platform_error("GetTokenInformation"));
        }
        Ok(Self { words: buffer })
    }

    fn as_ptr<T>(&self) -> *const T {
        self.words.as_ptr().cast()
    }
}

/// Owned SID returned by `ConvertStringSidToSidW`.
struct StringSid(*mut std::ffi::c_void);

impl StringSid {
    fn parse(value: &str) -> Result<Self> {
        let wide: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
        let mut sid: *mut std::ffi::c_void = std::ptr::null_mut();
        // SAFETY: `wide` is NUL-terminated and `sid` is writable.
        let ok = unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut sid) };
        if ok == 0 || sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
            return Err(RuntimeError::last_platform_error("ConvertStringSidToSidW"));
        }
        Ok(Self(sid))
    }
}

impl Drop for StringSid {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the SID was allocated by ConvertStringSidToSidW/LocalAlloc.
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

/// Enabled capability attributes.
pub fn capability_attributes(sid: *mut std::ffi::c_void) -> SID_AND_ATTRIBUTES {
    SID_AND_ATTRIBUTES {
        Sid: sid,
        Attributes: SE_GROUP_ENABLED as u32,
    }
}

/// Verify that the current process token reports the expected state.
#[cfg(test)]
pub fn current_token_summary() -> Result<(bool, IntegrityLevel, bool)> {
    let token = open_current()?;
    Ok((
        is_elevated(token.as_raw_handle() as HANDLE)?,
        integrity_level(token.as_raw_handle() as HANDLE)?,
        is_app_container(token.as_raw_handle() as HANDLE)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_token_can_be_opened_and_inspected() {
        let (elevated, integrity, app_container) = current_token_summary().expect("token query");
        let _ = elevated;
        assert!(!app_container, "test process is not an AppContainer");
        assert_ne!(integrity, IntegrityLevel::Unknown);
    }

    #[test]
    fn restricted_token_is_low_integrity_with_privileges_disabled() {
        let token = create_restricted_low_token().expect("restricted token");
        let handle = token.as_raw_handle() as HANDLE;

        assert_eq!(
            integrity_level(handle).expect("integrity"),
            IntegrityLevel::Low
        );
        assert!(
            enabled_privilege_count(handle).expect("privileges") <= 1,
            "DISABLE_MAX_PRIVILEGE must leave at most SeChangeNotifyPrivilege enabled"
        );
        assert!(!is_app_container(handle).expect("app container flag"));
    }

    #[test]
    fn invalid_sid_string_is_rejected() {
        let token = open_current().expect("token");
        assert!(has_capability(token.as_raw_handle() as HANDLE, "not-a-sid").is_err());
    }
}
