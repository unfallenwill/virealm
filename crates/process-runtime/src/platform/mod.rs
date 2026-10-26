//! Platform backends.
//!
//! Each backend owns one operating system and one set of primitives. `unsafe`
//! stays inside the backend; callers work with the same validated Rust types on
//! every platform. This module is the facade: it selects the backend at compile
//! time and exposes only platform-neutral names.
//!
//! - Windows: Job Objects, restricted tokens, AppContainer, named pipes.
//! - macOS: POSIX process groups, `proc_pidinfo` identity, Unix domain sockets.
//!
//! Isolation semantics are not identical across the two. A backend must report
//! what the operating system cannot do; it must never substitute a weaker
//! mechanism silently.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::Path;

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(windows)]
pub mod windows;

#[cfg(target_os = "macos")]
use macos as backend;
#[cfg(windows)]
use windows as backend;

use crate::capabilities::CapabilityReport;
use crate::error::Result;
use crate::launch::PreparedLaunchSpec;
use crate::policy::{ContainmentLimits, IsolationMode};
use crate::process::ManagedProcess;

pub(crate) use backend::process::Handle as ProcessHandle;

/// Probe the container primitives of the current platform.
pub fn probe_capabilities() -> CapabilityReport {
    backend::probe_capabilities()
}

/// Launch a validated spec through the platform backend.
pub(crate) fn launch(spec: &PreparedLaunchSpec) -> Result<ManagedProcess> {
    backend::process::launch(spec)
}

/// Run the local IPC server on `address` until the process exits.
pub(crate) fn serve(address: &str) -> std::io::Result<()> {
    backend::serve(address)
}

/// Default IPC address for the platform.
pub(crate) fn default_address() -> String {
    backend::default_address()
}

/// True when `path` is inside `root`, using the platform's path semantics.
pub(crate) fn is_within(path: &Path, root: &Path) -> bool {
    backend::path::is_within(path, root)
}

/// Reject a directory that is too broad to be a meaningful policy boundary.
pub(crate) fn reject_overbroad_root(path: &Path, description: &str) -> Result<()> {
    backend::path::reject_overbroad_root(path, description)
}

/// Validate argument values for the platform's process creation call.
pub(crate) fn validate_arguments(arguments: &[OsString]) -> Result<()> {
    backend::validate_arguments(arguments)
}

/// Validate environment names and values for the platform.
pub(crate) fn validate_environment(environment: &BTreeMap<OsString, OsString>) -> Result<()> {
    backend::validate_environment(environment)
}

/// Reject isolation modes this platform cannot enforce.
pub(crate) fn validate_isolation_supported(mode: IsolationMode) -> Result<()> {
    backend::validate_isolation_supported(mode)
}

/// Reject containment limits this platform cannot enforce.
pub(crate) fn validate_containment(limits: &ContainmentLimits) -> Result<()> {
    backend::validate_containment(limits)
}
