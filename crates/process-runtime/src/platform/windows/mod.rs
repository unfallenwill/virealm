//! Windows backend.
//!
//! Each module owns one concern and one set of Win32 calls. `unsafe` is
//! confined here; callers work with validated Rust types.

pub mod acl;
pub mod app_container;
pub mod capability;
pub mod command_line;
pub mod environment;
pub mod handles;
pub mod job_object;
pub mod path;
pub mod process;
pub mod token;
pub mod version;
pub mod wide;

use crate::capabilities::CapabilityReport;

/// Probe the Windows containment primitives.
pub fn probe_capabilities() -> CapabilityReport {
    capability::probe()
}
