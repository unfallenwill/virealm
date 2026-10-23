//! Isolation policy.
//!
//! Policy is platform-neutral data. The Windows backend maps it onto Job
//! Objects, restricted tokens and AppContainer security capabilities. All
//! policy validation happens before any Windows call, so an inconsistent
//! request fails without side effects.

use serde::{Deserialize, Serialize};

use crate::error::{Result, RuntimeError};

/// Requested isolation mechanism.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IsolationMode {
    /// Ordinary process with Job Object lifecycle containment.
    ///
    /// This is **not** a sandbox: the process runs with the caller's token and
    /// inherits the caller's file and network access.
    Managed,
    /// Restricted token with maximum privileges removed and a low integrity
    /// level. This reduces write access to medium-integrity locations but does
    /// not confine file paths or network access.
    Restricted,
    /// AppContainer profile with explicit file and network capabilities.
    AppContainer,
}

/// Network policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkAccess {
    Allow,
    Deny,
}

/// Access level granted to a restricted process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessLevel {
    ReadOnly,
    ReadWrite,
}

/// An additional directory explicitly exposed to a restricted process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessRoot {
    pub path: std::path::PathBuf,
    pub access: AccessLevel,
}

/// File access policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileAccessPolicy {
    /// Inherit the caller's file access. Only valid for modes that do not
    /// claim file isolation.
    Inherited,
    /// Expose only the environment data directory and explicitly listed roots.
    Restricted {
        data_directory: AccessLevel,
        additional_roots: Vec<AccessRoot>,
    },
}

/// Resource and lifecycle limits applied through a Job Object.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainmentLimits {
    /// Terminate the managed tree when the runtime closes the job handle.
    pub kill_on_close: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_processes: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_limit_bytes: Option<u64>,
}

impl Default for ContainmentLimits {
    fn default() -> Self {
        Self {
            kill_on_close: true,
            max_processes: None,
            memory_limit_bytes: None,
        }
    }
}

impl ContainmentLimits {
    pub fn validate(&self) -> Result<()> {
        if !self.kill_on_close {
            return Err(RuntimeError::PolicyViolation(
                "kill_on_close must remain enabled for managed processes".into(),
            ));
        }
        if self.max_processes == Some(0) {
            return Err(RuntimeError::PolicyViolation(
                "max_processes must be at least 1".into(),
            ));
        }
        if self.memory_limit_bytes == Some(0) {
            return Err(RuntimeError::PolicyViolation(
                "memory_limit_bytes must be greater than 0".into(),
            ));
        }
        Ok(())
    }
}

/// Everything the runtime needs to decide how a process may run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecurityPolicy {
    pub isolation: IsolationMode,
    /// Program directories the executable must live under. Validation is
    /// path-boundary aware; an empty list rejects every launch.
    pub allowed_program_roots: Vec<std::path::PathBuf>,
    pub file_access: FileAccessPolicy,
    pub network_access: NetworkAccess,
    pub containment: ContainmentLimits,
}

impl SecurityPolicy {
    /// Validate mode/policy combinations that cannot be enforced.
    pub fn validate(&self) -> Result<()> {
        self.containment.validate()?;

        if self.allowed_program_roots.is_empty() {
            return Err(RuntimeError::PolicyViolation(
                "allowed_program_roots must contain at least one directory".into(),
            ));
        }

        match self.isolation {
            IsolationMode::Managed => {
                if !matches!(self.file_access, FileAccessPolicy::Inherited) {
                    return Err(RuntimeError::PolicyViolation(
                        "managed mode cannot enforce a restricted file access policy".into(),
                    ));
                }
                if self.network_access == NetworkAccess::Deny {
                    return Err(RuntimeError::PolicyViolation(
                        "managed mode cannot enforce network denial".into(),
                    ));
                }
            }
            IsolationMode::Restricted => {
                if !matches!(self.file_access, FileAccessPolicy::Inherited) {
                    return Err(RuntimeError::PolicyViolation(
                        "restricted token mode cannot enforce path-level file access".into(),
                    ));
                }
                if self.network_access == NetworkAccess::Deny {
                    return Err(RuntimeError::PolicyViolation(
                        "restricted token mode cannot enforce network denial".into(),
                    ));
                }
            }
            IsolationMode::AppContainer => {
                if !matches!(self.file_access, FileAccessPolicy::Restricted { .. }) {
                    return Err(RuntimeError::PolicyViolation(
                        "app_container requires an explicit restricted file access policy".into(),
                    ));
                }
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(isolation: IsolationMode, network: NetworkAccess) -> SecurityPolicy {
        SecurityPolicy {
            isolation,
            allowed_program_roots: vec![std::path::PathBuf::from(r"C:\Program Files")],
            file_access: match isolation {
                IsolationMode::AppContainer => FileAccessPolicy::Restricted {
                    data_directory: AccessLevel::ReadWrite,
                    additional_roots: Vec::new(),
                },
                _ => FileAccessPolicy::Inherited,
            },
            network_access: network,
            containment: ContainmentLimits::default(),
        }
    }

    #[test]
    fn default_containment_kills_on_close() {
        assert!(ContainmentLimits::default().kill_on_close);
    }

    #[test]
    fn managed_mode_rejects_network_denial() {
        let error = policy(IsolationMode::Managed, NetworkAccess::Deny)
            .validate()
            .expect_err("managed cannot deny network");
        assert!(matches!(error, RuntimeError::PolicyViolation(_)));
    }

    #[test]
    fn restricted_mode_rejects_network_denial() {
        let error = policy(IsolationMode::Restricted, NetworkAccess::Deny)
            .validate()
            .expect_err("restricted token cannot deny network");
        assert!(matches!(error, RuntimeError::PolicyViolation(_)));
    }

    #[test]
    fn app_container_requires_restricted_file_policy() {
        let mut policy = policy(IsolationMode::AppContainer, NetworkAccess::Deny);
        policy.file_access = FileAccessPolicy::Inherited;
        assert!(matches!(
            policy.validate(),
            Err(RuntimeError::PolicyViolation(_))
        ));
    }

    #[test]
    fn app_container_accepts_network_denial() {
        assert!(
            policy(IsolationMode::AppContainer, NetworkAccess::Deny)
                .validate()
                .is_ok()
        );
    }

    #[test]
    fn empty_program_roots_are_rejected() {
        let mut policy = policy(IsolationMode::Managed, NetworkAccess::Allow);
        policy.allowed_program_roots.clear();
        assert!(matches!(
            policy.validate(),
            Err(RuntimeError::PolicyViolation(_))
        ));
    }

    #[test]
    fn zero_limits_are_rejected() {
        let mut policy = policy(IsolationMode::Managed, NetworkAccess::Allow);
        policy.containment.max_processes = Some(0);
        assert!(matches!(
            policy.validate(),
            Err(RuntimeError::PolicyViolation(_))
        ));

        policy.containment.max_processes = None;
        policy.containment.memory_limit_bytes = Some(0);
        assert!(matches!(
            policy.validate(),
            Err(RuntimeError::PolicyViolation(_))
        ));
    }
}
