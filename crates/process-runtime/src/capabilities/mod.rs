//! Windows capability probing.
//!
//! A probe reports four states so "we could not determine this" is never
//! mistaken for "this works":
//!
//! - [`CapabilityState::Supported`]: exercised successfully on this machine.
//! - [`CapabilityState::Unsupported`]: the operating system does not provide it.
//! - [`CapabilityState::Unavailable`]: it exists but current conditions block it.
//! - [`CapabilityState::NotVerified`]: this build does not exercise it.
//!
//! Critical capabilities are probed with real Windows calls. The AppContainer
//! and restricted-token probes create a transient **suspended** process that is
//! terminated without ever being resumed; the AppContainer probe also creates
//! and deletes a temporary profile. Callers should treat a probe as an
//! observable, side-effecting operation rather than a pure read.

use serde::{Deserialize, Serialize};

use crate::platform;

/// Result of probing a single capability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityState {
    /// Exercised successfully on this machine.
    Supported,
    /// The operating system does not provide this capability.
    Unsupported,
    /// The capability exists but current conditions block its use.
    Unavailable,
    /// This build does not exercise the capability.
    NotVerified,
}

/// One capability plus an optional explanation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub state: CapabilityState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl Capability {
    pub fn supported(detail: impl Into<String>) -> Self {
        Self {
            state: CapabilityState::Supported,
            detail: Some(detail.into()),
        }
    }

    pub fn unsupported(detail: impl Into<String>) -> Self {
        Self {
            state: CapabilityState::Unsupported,
            detail: Some(detail.into()),
        }
    }

    pub fn unavailable(detail: impl Into<String>) -> Self {
        Self {
            state: CapabilityState::Unavailable,
            detail: Some(detail.into()),
        }
    }

    pub fn not_verified(detail: impl Into<String>) -> Self {
        Self {
            state: CapabilityState::NotVerified,
            detail: Some(detail.into()),
        }
    }

    /// Whether the capability was successfully exercised.
    pub fn is_supported(&self) -> bool {
        self.state == CapabilityState::Supported
    }
}

/// Operating system version.
///
/// Windows reports major/minor/build from `RtlGetVersion`. macOS reports
/// major/minor/patch from `kern.osproductversion`, with the patch component
/// carried in `build`; [`PlatformInfo::os_version`] carries the exact product
/// string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformVersion {
    pub major: u32,
    pub minor: u32,
    pub build: u32,
}

/// Historical name kept for existing callers. Windows reports the same shape.
pub type WindowsVersion = PlatformVersion;

/// Integrity level of a token.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntegrityLevel {
    Untrusted,
    Low,
    Medium,
    High,
    System,
    Protected,
    Unknown,
}

/// Facts about the host and the caller's token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub os: String,
    pub version: PlatformVersion,
    /// Exact product version string, when the platform reports one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_version: Option<String>,
    pub architecture: String,
    /// Whether the calling process token is elevated.
    pub elevated: bool,
    pub integrity_level: IntegrityLevel,
}

/// Availability of per-process-tree resource limits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceLimits {
    pub max_processes: Capability,
    pub memory_limit: Capability,
}

/// Snapshot of the primitives available on this machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityReport {
    pub platform: PlatformInfo,
    pub job_object: Capability,
    pub app_container: Capability,
    /// Whether granting an AppContainer SID access to a directory was verified.
    pub app_container_acl: Capability,
    pub restricted_token: Capability,
    pub process_mitigation: Capability,
    pub etw: Capability,
    /// POSIX process-group lifecycle containment (macOS).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_group: Option<Capability>,
    /// Per-tree process and memory limits.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_limits: Option<ResourceLimits>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

/// Probe the current machine.
///
/// See the module documentation for the side effects of the AppContainer and
/// restricted-token probes.
pub fn probe_capabilities() -> CapabilityReport {
    platform::probe_capabilities()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_state_maps_to_supported() {
        assert!(Capability::supported("ok").is_supported());
        assert!(!Capability::unavailable("no").is_supported());
        assert!(!Capability::not_verified("later").is_supported());
    }

    #[test]
    fn capability_serializes_state_as_snake_case() {
        let value = serde_json::to_value(Capability::not_verified("later")).expect("serialize");
        assert_eq!(value["state"], serde_json::json!("not_verified"));
    }
}
