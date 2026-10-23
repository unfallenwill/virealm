//! AppContainer profiles and security capabilities.
//!
//! A profile is derived from the environment identifier, so restarts reuse the
//! same container instead of accumulating profiles. Capability SIDs are only
//! attached when policy allows network access; the launch path verifies the
//! resulting child token.

use std::ffi::c_void;
use std::mem::size_of;
use std::time::{SystemTime, UNIX_EPOCH};

use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Authorization::ConvertStringSidToSidW;
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows_sys::Win32::Security::{FreeSid, PSID, SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES};
use windows_sys::Win32::System::SystemServices::SE_GROUP_ENABLED;

use crate::error::{Result, RuntimeError};
use crate::policy::NetworkAccess;

const ERROR_ALREADY_EXISTS_HRESULT: u32 = 0x8007_00B7;
const ERROR_FILE_NOT_FOUND: u32 = 2;
const ERROR_NOT_FOUND: u32 = 1168;

/// Network capability SIDs that are attached for [`NetworkAccess::Allow`].
pub const INTERNET_CLIENT: &str = "S-1-15-3-1";
pub const INTERNET_CLIENT_SERVER: &str = "S-1-15-3-2";
pub const PRIVATE_NETWORK_CLIENT_SERVER: &str = "S-1-15-3-3";

/// The network capability SIDs checked after launch.
pub const NETWORK_CAPABILITIES: [&str; 3] = [
    INTERNET_CLIENT,
    INTERNET_CLIENT_SERVER,
    PRIVATE_NETWORK_CLIENT_SERVER,
];

/// An AppContainer profile and the SID owned by this process.
#[derive(Debug)]
pub struct AppContainerProfile {
    name: String,
    sid: PSID,
}

impl AppContainerProfile {
    /// Create the profile for an environment, or derive its existing SID.
    pub fn open_or_create(environment_id: &str) -> Result<Self> {
        let name = profile_name(environment_id);
        Self::create_named(&name)
    }

    /// Create a profile with a fresh name for a capability probe.
    pub fn create_probe() -> Result<Self> {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        Self::create_named(&format!("VirealmProbe{}{unique}", std::process::id()))
    }

    fn create_named(name: &str) -> Result<Self> {
        let wide_name = wide(name);
        let display = wide("Virealm environment");
        let description = wide("Virealm managed environment container");
        let mut sid: PSID = std::ptr::null_mut();

        // SAFETY: all strings are NUL-terminated; no capabilities are passed;
        // `sid` is writable.
        let hr = unsafe {
            CreateAppContainerProfile(
                wide_name.as_ptr(),
                display.as_ptr(),
                description.as_ptr(),
                std::ptr::null(),
                0,
                &mut sid,
            )
        };

        if hr >= 0 && !sid.is_null() {
            return Ok(Self {
                name: name.to_owned(),
                sid,
            });
        }

        if hr as u32 == ERROR_ALREADY_EXISTS_HRESULT {
            let mut sid: PSID = std::ptr::null_mut();
            // SAFETY: `wide_name` is NUL-terminated and `sid` is writable.
            let hr =
                unsafe { DeriveAppContainerSidFromAppContainerName(wide_name.as_ptr(), &mut sid) };
            if hr >= 0 && !sid.is_null() {
                return Ok(Self {
                    name: name.to_owned(),
                    sid,
                });
            }
            return Err(hresult_error(
                "DeriveAppContainerSidFromAppContainerName",
                hr,
            ));
        }

        Err(hresult_error("CreateAppContainerProfile", hr))
    }

    /// Profile name used for creation and deletion.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Profile SID. Owned by this value.
    pub fn sid(&self) -> PSID {
        self.sid
    }

    /// Delete the profile. The SID remains valid until this value is dropped.
    pub fn delete(&self) -> Result<()> {
        Self::delete_profile(&self.name)
    }

    /// Delete a profile by name.
    pub fn delete_profile(name: &str) -> Result<()> {
        let wide_name = wide(name);
        // SAFETY: `wide_name` is NUL-terminated.
        let hr = unsafe { DeleteAppContainerProfile(wide_name.as_ptr()) };
        if hr >= 0 {
            return Ok(());
        }
        let code = hresult_code(hr);
        if matches!(code, ERROR_FILE_NOT_FOUND | ERROR_NOT_FOUND) {
            return Ok(());
        }
        Err(RuntimeError::platform_error(
            "DeleteAppContainerProfile",
            code,
        ))
    }
}

impl Drop for AppContainerProfile {
    fn drop(&mut self) {
        if !self.sid.is_null() {
            // SAFETY: the SID was allocated by the AppContainer API.
            unsafe {
                FreeSid(self.sid);
            }
            self.sid = std::ptr::null_mut();
        }
    }
}

/// A capability SID allocated for a process attribute list.
#[derive(Debug)]
pub struct CapabilitySid {
    sid: PSID,
}

impl CapabilitySid {
    pub fn parse(value: &str) -> Result<Self> {
        let wide: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
        let mut sid: PSID = std::ptr::null_mut();
        // SAFETY: `wide` is NUL-terminated and `sid` is writable.
        let ok = unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut sid) };
        if ok == 0 || sid.is_null() {
            return Err(RuntimeError::last_platform_error("ConvertStringSidToSidW"));
        }
        Ok(Self { sid })
    }

    pub fn sid(&self) -> PSID {
        self.sid
    }
}

impl Drop for CapabilitySid {
    fn drop(&mut self) {
        if !self.sid.is_null() {
            // SAFETY: ConvertStringSidToSidW allocates with LocalAlloc.
            unsafe {
                LocalFree(self.sid);
            }
        }
    }
}

/// Capability SIDs required by the network policy.
pub fn network_capabilities(access: NetworkAccess) -> Result<Vec<CapabilitySid>> {
    let names: &[&str] = match access {
        NetworkAccess::Allow => &NETWORK_CAPABILITIES,
        NetworkAccess::Deny => &[],
    };
    names
        .iter()
        .map(|name| CapabilitySid::parse(name))
        .collect()
}

/// Owns the SIDs and the `SECURITY_CAPABILITIES` value passed to
/// `UpdateProcThreadAttribute`.
///
/// `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` retains a pointer to the
/// `SECURITY_CAPABILITIES` value until `CreateProcess` returns, so the value
/// lives in its own allocation and is never moved when this struct is moved.
/// It also points into `_attributes` and the SID allocations, which stay alive
/// with it.
pub struct SecurityCapabilities {
    _sids: Vec<CapabilitySid>,
    _attributes: Vec<SID_AND_ATTRIBUTES>,
    value: Box<SECURITY_CAPABILITIES>,
}

impl SecurityCapabilities {
    pub fn new(profile_sid: PSID, sids: Vec<CapabilitySid>) -> Result<Self> {
        if profile_sid.is_null() {
            return Err(RuntimeError::Internal(
                "AppContainer security capabilities require a profile SID".into(),
            ));
        }

        let attributes: Vec<SID_AND_ATTRIBUTES> = sids
            .iter()
            .map(|sid| SID_AND_ATTRIBUTES {
                Sid: sid.sid(),
                Attributes: SE_GROUP_ENABLED as u32,
            })
            .collect();

        let capabilities = if attributes.is_empty() {
            std::ptr::null_mut()
        } else {
            attributes.as_ptr() as *mut SID_AND_ATTRIBUTES
        };

        let value = Box::new(SECURITY_CAPABILITIES {
            AppContainerSid: profile_sid,
            Capabilities: capabilities,
            CapabilityCount: attributes.len() as u32,
            Reserved: 0,
        });

        Ok(Self {
            _sids: sids,
            _attributes: attributes,
            value,
        })
    }

    pub fn as_ptr(&self) -> *const c_void {
        (&*self.value as *const SECURITY_CAPABILITIES).cast()
    }
}

fn profile_name(environment_id: &str) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in environment_id.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("Virealm.{hash:016x}")
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn hresult_code(hr: i32) -> u32 {
    let raw = hr as u32;
    if raw & 0xFFFF_0000 == 0x8007_0000 {
        raw & 0xFFFF
    } else {
        raw
    }
}

fn hresult_error(operation: &str, hr: i32) -> RuntimeError {
    RuntimeError::platform_error(operation, hresult_code(hr))
}

/// Size of the `SECURITY_CAPABILITIES` structure copied into the attribute
/// list.
pub const SECURITY_CAPABILITIES_SIZE: usize = size_of::<SECURITY_CAPABILITIES>();

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_name_is_stable_and_bounded() {
        let first = profile_name("environment-one");
        let second = profile_name("environment-one");
        assert_eq!(first, second);
        assert!(first.starts_with("Virealm."));
        assert!(first.len() <= 64);
    }

    #[test]
    fn different_environments_get_different_names() {
        assert_ne!(profile_name("a"), profile_name("b"));
    }

    #[test]
    fn hresult_from_win32_is_unwrapped() {
        assert_eq!(hresult_code(0x8007_0005u32 as i32), 5);
        assert_eq!(hresult_code(0x8000_4005u32 as i32), 0x8000_4005);
    }

    #[test]
    fn network_denial_attaches_no_capabilities() {
        assert!(
            network_capabilities(NetworkAccess::Deny)
                .expect("no capability SIDs")
                .is_empty()
        );
    }

    #[test]
    fn network_allow_attaches_internet_capabilities() {
        let capabilities = network_capabilities(NetworkAccess::Allow).expect("capability SIDs");
        assert_eq!(capabilities.len(), NETWORK_CAPABILITIES.len());
    }
}
