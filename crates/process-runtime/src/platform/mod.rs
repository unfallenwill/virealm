//! Platform backends.
//!
//! Only Windows is compiled. Platform-specific code stays a module of this
//! crate rather than becoming its own crate: there is one target platform
//! today and the split can happen if a second backend and a stable
//! platform-neutral contract actually exist.

pub mod windows;

pub fn probe_capabilities() -> crate::capabilities::CapabilityReport {
    windows::probe_capabilities()
}
