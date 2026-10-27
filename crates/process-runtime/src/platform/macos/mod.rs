//! macOS backend.
//!
//! macOS has no Job Object, restricted token or AppContainer equivalent. The
//! backend implements [`IsolationMode::Managed`] with a POSIX process group and
//! reports the two Windows-specific modes as unavailable rather than
//! substituting a weaker mechanism.
//!
//! Process identity uses `proc_pidinfo(PROC_PIDTBSDINFO)` and is expressed in
//! the same shape as the Windows creation time, so the wire contract does not
//! need a second identity type.
//!
//! `unsafe` is confined to this module tree; callers work with validated Rust
//! types.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::os::unix::ffi::OsStrExt;

pub(crate) mod capability;
pub(crate) mod identity;
pub(crate) mod path;
pub(crate) mod process;
pub(crate) mod socket;

use crate::capabilities::CapabilityReport;
use crate::error::{Result, RuntimeError};
use crate::policy::{ContainmentLimits, IsolationMode};

/// Probe the macOS containment primitives.
pub fn probe_capabilities() -> CapabilityReport {
    capability::probe()
}

/// Run the Unix domain socket server on `address`.
pub(crate) fn serve(address: &str) -> std::io::Result<()> {
    socket::serve(address)
}

/// Default socket under `$TMPDIR`.
pub(crate) fn default_address() -> String {
    socket::default_address()
}

/// Validate argument values for `posix_spawn`.
pub(crate) fn validate_arguments(arguments: &[OsString]) -> Result<()> {
    if arguments
        .iter()
        .any(|argument| argument.as_os_str().as_bytes().contains(&0))
    {
        return Err(RuntimeError::InvalidRequest(
            "arguments must not contain NUL characters".into(),
        ));
    }
    Ok(())
}

/// Validate environment names and values for `posix_spawn`.
pub(crate) fn validate_environment(environment: &BTreeMap<OsString, OsString>) -> Result<()> {
    let mut seen: Vec<&OsString> = Vec::with_capacity(environment.len());
    for (key, value) in environment {
        let bytes = key.as_os_str().as_bytes();
        if bytes.is_empty() {
            return Err(RuntimeError::InvalidRequest(
                "environment variable name must not be empty".into(),
            ));
        }
        if bytes.contains(&b'=') {
            return Err(RuntimeError::InvalidRequest(
                "environment variable name must not contain '='".into(),
            ));
        }
        if bytes.contains(&0) || value.as_os_str().as_bytes().contains(&0) {
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

/// The contract keeps environment names unique case-insensitively on every
/// platform, even though POSIX itself is case-sensitive.
fn os_string_eq_ignore_ascii_case(a: &OsString, b: &OsString) -> bool {
    let a = a.as_os_str().as_bytes();
    let b = b.as_os_str().as_bytes();
    a.len() == b.len() && a.eq_ignore_ascii_case(b)
}

/// macOS implements managed isolation only.
pub(crate) fn validate_isolation_supported(mode: IsolationMode) -> Result<()> {
    match mode {
        IsolationMode::Managed => Ok(()),
        IsolationMode::Restricted => Err(RuntimeError::CapabilityUnavailable(
            "restricted mode requires a Windows restricted token; macOS has no equivalent".into(),
        )),
        IsolationMode::AppContainer => Err(RuntimeError::CapabilityUnavailable(
            "app_container isolation requires Windows AppContainer; macOS has no equivalent".into(),
        )),
    }
}

/// macOS has no per-process-tree aggregate limits.
pub(crate) fn validate_containment(limits: &ContainmentLimits) -> Result<()> {
    if limits.max_processes.is_some() {
        return Err(RuntimeError::CapabilityUnavailable(
            "macOS has no per-process-tree process limit".into(),
        ));
    }
    if limits.memory_limit_bytes.is_some() {
        return Err(RuntimeError::CapabilityUnavailable(
            "macOS has no per-process-tree memory limit".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_is_supported_and_windows_modes_are_not() {
        assert!(validate_isolation_supported(IsolationMode::Managed).is_ok());
        assert!(matches!(
            validate_isolation_supported(IsolationMode::Restricted),
            Err(RuntimeError::CapabilityUnavailable(_))
        ));
        assert!(matches!(
            validate_isolation_supported(IsolationMode::AppContainer),
            Err(RuntimeError::CapabilityUnavailable(_))
        ));
    }

    #[test]
    fn containment_limits_are_rejected() {
        let limits = ContainmentLimits {
            kill_on_close: true,
            max_processes: Some(4),
            memory_limit_bytes: None,
        };
        assert!(matches!(
            validate_containment(&limits),
            Err(RuntimeError::CapabilityUnavailable(_))
        ));
    }

    #[test]
    fn environment_names_collide_case_insensitively() {
        let mut environment = BTreeMap::new();
        environment.insert(OsString::from("Path"), OsString::from("a"));
        environment.insert(OsString::from("PATH"), OsString::from("b"));
        assert!(matches!(
            validate_environment(&environment),
            Err(RuntimeError::InvalidRequest(_))
        ));
    }
}
