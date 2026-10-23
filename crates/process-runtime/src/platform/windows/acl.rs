//! Narrow directory ACL grants for AppContainer tokens.
//!
//! Only the environment data directory and explicitly requested additional
//! roots are modified. The grant is applied to one SID with inheritance, then
//! read back from the on-disk DACL. The runtime never grants access to a
//! profile, a volume root, or an entire user directory.

use std::mem::size_of;
use std::path::Path;

use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Authorization::{
    EXPLICIT_ACCESS_W, GRANT_ACCESS, GetNamedSecurityInfoW, SE_FILE_OBJECT, SetEntriesInAclW,
    SetNamedSecurityInfoW, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACL, ACL_SIZE_INFORMATION, AclSizeInformation, DACL_SECURITY_INFORMATION,
    EqualSid, GetAce, GetAclInformation, PSECURITY_DESCRIPTOR, PSID,
};
use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_DELETE_CHILD, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
};
use windows_sys::Win32::System::SystemServices::ACCESS_ALLOWED_ACE_TYPE;

use crate::error::{Result, RuntimeError};
use crate::platform::windows::handles;
use crate::platform::windows::path::path_to_wide_null;
use crate::policy::AccessLevel;

/// Grant `sid` read-only or read-write access to `path`.
pub(crate) fn grant(path: &Path, sid: PSID, level: AccessLevel) -> Result<()> {
    if sid.is_null() {
        return Err(RuntimeError::Internal(
            "cannot grant access to a null SID".into(),
        ));
    }

    let wide = path_to_wide_null(path);
    let mut old_dacl: *mut ACL = std::ptr::null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: `wide` is NUL-terminated and all out-parameters are writable.
    let code = unsafe {
        GetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut old_dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    handles::check_win32(code, "GetNamedSecurityInfoW")?;
    let _descriptor = LocalMemory(descriptor);

    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: mask_for(level),
        grfAccessMode: GRANT_ACCESS,
        grfInheritance: windows_sys::Win32::Security::SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: 0,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: sid.cast(),
        },
    };

    let mut new_dacl: *mut ACL = std::ptr::null_mut();
    // SAFETY: `entry` describes a single trustee; `old_dacl` is owned by the
    // security descriptor above.
    let code = unsafe { SetEntriesInAclW(1, &entry, old_dacl, &mut new_dacl) };
    handles::check_win32(code, "SetEntriesInAclW")?;
    let _new_dacl = LocalMemory(new_dacl.cast());

    // SAFETY: `wide` is NUL-terminated and `new_dacl` is a valid ACL.
    let code = unsafe {
        SetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            new_dacl,
            std::ptr::null_mut(),
        )
    };
    handles::check_win32(code, "SetNamedSecurityInfoW")?;

    if !verify(path, sid, level)? {
        return Err(RuntimeError::Internal(format!(
            "access grant for {} was not visible in the DACL after writing it",
            path.display()
        )));
    }
    Ok(())
}

/// Whether the on-disk DACL contains an allow ACE for `sid` with at least the
/// access required by `level`.
pub(crate) fn verify(path: &Path, sid: PSID, level: AccessLevel) -> Result<bool> {
    let wide = path_to_wide_null(path);
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: all out-parameters are writable and `wide` is NUL-terminated.
    let code = unsafe {
        GetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    handles::check_win32(code, "GetNamedSecurityInfoW(verify)")?;
    let _descriptor = LocalMemory(descriptor);

    if dacl.is_null() {
        return Ok(false);
    }

    let mut size_info = ACL_SIZE_INFORMATION::default();
    // SAFETY: `dacl` is valid and `size_info` is writable.
    let ok = unsafe {
        GetAclInformation(
            dacl,
            (&mut size_info as *mut ACL_SIZE_INFORMATION).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    };
    if ok == 0 {
        return Err(RuntimeError::last_platform_error("GetAclInformation"));
    }

    let required = mask_for(level);
    for index in 0..size_info.AceCount {
        let mut ace: *mut std::ffi::c_void = std::ptr::null_mut();
        // SAFETY: index is below AceCount.
        let ok = unsafe { GetAce(dacl, index, &mut ace) };
        if ok == 0 {
            return Err(RuntimeError::last_platform_error("GetAce"));
        }
        if ace.is_null() {
            continue;
        }

        // SAFETY: `ace` points at an ACE inside the DACL. Its header is read
        // before deciding whether the body is an ACCESS_ALLOWED_ACE.
        let header = unsafe { &*ace.cast::<windows_sys::Win32::Security::ACE_HEADER>() };
        if u32::from(header.AceType) != ACCESS_ALLOWED_ACE_TYPE {
            continue;
        }
        // SAFETY: an allow ACE has the ACCESS_ALLOWED_ACE layout.
        let allowed = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
        if (allowed.Mask & required) != required {
            continue;
        }
        // SAFETY: SidStart is the first byte of the SID stored in the ACE.
        let ace_sid = (&allowed.SidStart as *const u32).cast_mut().cast();
        // SAFETY: both SIDs are valid.
        if unsafe { EqualSid(ace_sid, sid) } != 0 {
            return Ok(true);
        }
    }

    Ok(false)
}

fn mask_for(level: AccessLevel) -> u32 {
    match level {
        AccessLevel::ReadOnly => FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
        AccessLevel::ReadWrite => {
            FILE_GENERIC_READ
                | FILE_GENERIC_EXECUTE
                | FILE_GENERIC_WRITE
                | DELETE
                | FILE_DELETE_CHILD
        }
    }
}

/// Frees memory allocated by the security APIs.
struct LocalMemory(*mut std::ffi::c_void);

impl Drop for LocalMemory {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the pointer was allocated by LocalAlloc on behalf of the
            // security API and is freed exactly once.
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_mask_excludes_write_and_delete() {
        let mask = mask_for(AccessLevel::ReadOnly);
        assert_ne!(mask & FILE_GENERIC_WRITE, FILE_GENERIC_WRITE);
        assert_ne!(mask & DELETE, DELETE);
        assert_eq!(mask & FILE_GENERIC_READ, FILE_GENERIC_READ);
    }

    #[test]
    fn read_write_mask_includes_write_and_delete() {
        let mask = mask_for(AccessLevel::ReadWrite);
        assert_eq!(mask & FILE_GENERIC_WRITE, FILE_GENERIC_WRITE);
        assert_eq!(mask & DELETE, DELETE);
    }
}
