//! Windows version and architecture.
//!
//! Version data comes from `RtlGetVersion`, not from manifest-affected
//! `GetVersionEx`, and architecture from `GetNativeSystemInfo`. The values are
//! reported to callers; they are never used to infer that a capability works.

use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
use windows_sys::Win32::System::SystemInformation::{
    GetNativeSystemInfo, OSVERSIONINFOW, PROCESSOR_ARCHITECTURE_AMD64,
    PROCESSOR_ARCHITECTURE_ARM64, PROCESSOR_ARCHITECTURE_INTEL, SYSTEM_INFO,
};

use crate::capabilities::WindowsVersion;
use crate::error::{Result, RuntimeError};

/// Read the real Windows version.
pub fn windows_version() -> Result<WindowsVersion> {
    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };

    // SAFETY: the structure is initialized with its own size and is writable.
    let status = unsafe { RtlGetVersion(&mut info) };
    if status < 0 {
        return Err(RuntimeError::platform_error("RtlGetVersion", status as u32));
    }

    Ok(WindowsVersion {
        major: info.dwMajorVersion,
        minor: info.dwMinorVersion,
        build: info.dwBuildNumber,
    })
}

/// Native processor architecture as a stable label.
pub fn architecture() -> String {
    let mut info = SYSTEM_INFO::default();
    // SAFETY: GetNativeSystemInfo fills a caller-owned structure.
    unsafe { GetNativeSystemInfo(&mut info) };
    // SAFETY: the union is valid after GetNativeSystemInfo.
    let architecture = unsafe { info.Anonymous.Anonymous.wProcessorArchitecture };

    match architecture {
        PROCESSOR_ARCHITECTURE_AMD64 => "x86_64",
        PROCESSOR_ARCHITECTURE_ARM64 => "aarch64",
        PROCESSOR_ARCHITECTURE_INTEL => "x86",
        other => {
            return format!("unknown-{other}");
        }
    }
    .to_owned()
}

/// Human-readable `major.minor.build`.
pub fn version_string(version: WindowsVersion) -> String {
    format!("{}.{}.{}", version.major, version.minor, version.build)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_probe_matches_current_windows() {
        let version = windows_version().expect("RtlGetVersion succeeds on Windows");
        assert_eq!(version.major, 10, "Windows 10/11 report major 10");
        assert!(version.build > 0);
    }

    #[test]
    fn architecture_is_not_empty() {
        assert!(!architecture().is_empty());
    }
}
