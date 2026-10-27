//! Windows backend.
//!
//! Each module owns one concern and one set of Win32 calls. `unsafe` is
//! confined here; callers work with validated Rust types.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::os::windows::ffi::OsStrExt;

pub mod acl;
pub mod app_container;
pub mod capability;
pub mod command_line;
pub mod environment;
pub mod handles;
pub mod job_object;
pub mod path;
pub mod pipe;
pub mod process;
pub mod token;
pub mod version;
pub mod wide;

use crate::capabilities::CapabilityReport;
use crate::error::{Result, RuntimeError};
use crate::policy::{ContainmentLimits, IsolationMode};

/// Probe the Windows containment primitives.
pub fn probe_capabilities() -> CapabilityReport {
    capability::probe()
}

/// Run the named-pipe server on `address`.
pub(crate) fn serve(address: &str) -> std::io::Result<()> {
    pipe::serve(address)
}

/// Default named pipe for the wire protocol.
pub(crate) fn default_address() -> String {
    pipe::DEFAULT_PIPE_NAME.to_owned()
}

/// Validate argument values for `CreateProcessW`.
pub(crate) fn validate_arguments(arguments: &[OsString]) -> Result<()> {
    if arguments
        .iter()
        .any(|argument| argument.encode_wide().any(|unit| unit == 0))
    {
        return Err(RuntimeError::InvalidRequest(
            "arguments must not contain NUL characters".into(),
        ));
    }
    Ok(())
}

/// Validate environment names and values for `CreateProcessW`.
pub(crate) fn validate_environment(environment: &BTreeMap<OsString, OsString>) -> Result<()> {
    let mut seen: Vec<&OsString> = Vec::with_capacity(environment.len());
    for (key, value) in environment {
        let wide: Vec<u16> = key.encode_wide().collect();
        if wide.is_empty() {
            return Err(RuntimeError::InvalidRequest(
                "environment variable name must not be empty".into(),
            ));
        }
        if wide.first() == Some(&(b'=' as u16)) || wide.contains(&(b'=' as u16)) {
            return Err(RuntimeError::InvalidRequest(
                "environment variable name must not contain '='".into(),
            ));
        }
        if wide.contains(&0) || value.encode_wide().any(|unit| unit == 0) {
            return Err(RuntimeError::InvalidRequest(
                "environment variables must not contain NUL characters".into(),
            ));
        }

        if let Some(previous) = seen
            .iter()
            .find(|previous| os_string_eq_ignore_ascii_case(previous, key))
        {
            return Err(RuntimeError::InvalidRequest(format!(
                "duplicate environment variable (case-insensitive): {:?} and {:?}",
                previous, key
            )));
        }
        seen.push(key);
    }
    Ok(())
}

/// Windows environment names are case-insensitive.
pub(crate) fn os_string_eq_ignore_ascii_case(a: &OsString, b: &OsString) -> bool {
    let a: Vec<u16> = a.encode_wide().collect();
    let b: Vec<u16> = b.encode_wide().collect();
    wide::slice_eq_ignore_ascii_case(&a, &b)
}

/// Every isolation mode has a Windows implementation.
pub(crate) fn validate_isolation_supported(_mode: IsolationMode) -> Result<()> {
    Ok(())
}

/// Job Objects enforce per-tree limits, so every containment limit is valid.
pub(crate) fn validate_containment(_limits: &ContainmentLimits) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_case_insensitive_comparison() {
        assert!(os_string_eq_ignore_ascii_case(
            &OsString::from("Path"),
            &OsString::from("PATH")
        ));
        assert!(!os_string_eq_ignore_ascii_case(
            &OsString::from("Path"),
            &OsString::from("Paths")
        ));
    }
}
