//! # Virealm Process Runtime
//!
//! Constrained process lifecycle management for Virealm browser environments.
//!
//! The runtime owns every operation that touches the Windows process and
//! security model: capability probing, policy validation, process creation,
//! Job Object containment, AppContainer isolation, restricted tokens and
//! structured diagnostics.
//!
//! It deliberately knows nothing about Chromium, CDP, profiles or time zones.
//! Those concerns belong to `browser-adapter`; the two are composed through an
//! environment configuration rather than by sharing implementation details.
//!
//! ## Security boundary
//!
//! Only [`IsolationMode::AppContainer`] claims file and network isolation. The
//! runtime never silently degrades a request to a weaker mode: if a requested
//! capability is unavailable, [`launch`] fails with
//! [`RuntimeError::CapabilityUnavailable`].
//!
//! [`IsolationMode::Managed`] means "ordinary process with lifecycle
//! containment". It is not a sandbox. [`IsolationMode::Restricted`] removes
//! privileges and lowers the integrity level, but does not confine file paths
//! or network access.
//!
//! ## Platform
//!
//! Windows 10/11 and macOS (Apple silicon first). The crate intentionally
//! fails to compile on other platforms rather than pretending to provide
//! isolation it cannot implement.
//!
//! macOS implements [`IsolationMode::Managed`] with a POSIX process group and
//! reports [`IsolationMode::Restricted`] and [`IsolationMode::AppContainer`] as
//! unavailable. There is no macOS equivalent of those Windows primitives, and
//! the runtime never substitutes a weaker mechanism silently.

#[cfg(not(any(windows, target_os = "macos")))]
compile_error!(
    "virealm-process-runtime supports Windows and macOS only; other platforms have no \
     isolation backend"
);

pub mod capabilities;
pub mod diagnostics;
pub mod error;
pub mod ipc;
pub mod launch;
pub mod platform;
pub mod policy;
pub mod process;

pub use capabilities::{
    Capability, CapabilityReport, CapabilityState, IntegrityLevel, PlatformInfo, PlatformVersion,
    ResourceLimits, WindowsVersion, probe_capabilities,
};
pub use diagnostics::{DiagnosticEvent, DiagnosticLevel, DiagnosticSink, NullDiagnosticSink};
pub use error::{ErrorCode, ErrorInfo, Result, RuntimeError};
pub use launch::{LaunchSpec, launch, validate_launch_spec};
pub use policy::{
    AccessLevel, AccessRoot, ContainmentLimits, FileAccessPolicy, IsolationMode, NetworkAccess,
    SecurityPolicy,
};
pub use process::{AppliedIsolation, ManagedProcess, ProcessId, ProcessState, ProcessStatus};

/// Version of the runtime-to-host wire protocol.
///
/// Bump on breaking changes. Mirrored in `packages/contracts/src/protocol.ts`.
pub const PROTOCOL_VERSION: u32 = 2;

/// Version of the crate's public Rust API.
pub const CONTRACT_VERSION: &str = "0.3.0";
