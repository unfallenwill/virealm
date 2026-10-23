//! Process identity, status and lifecycle.

use std::ffi::OsString;
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::diagnostics::DiagnosticEvent;
use crate::error::Result;
use crate::platform::windows::process as platform_process;
use crate::policy::{IsolationMode, NetworkAccess};

/// Durable process identity.
///
/// A PID alone is not an identity: Windows reuses PIDs. The pair of PID and
/// process creation time identifies one process instance for as long as the
/// original handle is held.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessId {
    pub pid: u32,
    /// Creation time as 100-nanosecond intervals since 1601-01-01 UTC.
    pub creation_time_100ns: u64,
}

impl std::fmt::Display for ProcessId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}:{}", self.pid, self.creation_time_100ns)
    }
}

/// Observed state of a managed process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ProcessState {
    /// Created, not yet confirmed running.
    Starting,
    /// Running with the given process id.
    Running { pid: u32 },
    /// Exited with the given code.
    Exited { exit_code: u32 },
}

/// Isolation actually applied and verified after the process was created.
///
/// This is evidence, not intent: each `true` flag was checked against the
/// created process or its job, not copied from the request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedIsolation {
    pub mode: IsolationMode,
    pub job_object_attached: bool,
    pub app_container_token: bool,
    pub restricted_token: bool,
    pub low_integrity: bool,
    /// True only when path-level file access is enforced by AppContainer.
    pub file_access_restricted: bool,
    pub network_access: NetworkAccess,
    /// True when the child token's capability SIDs matched the network policy.
    pub network_capabilities_verified: bool,
}

/// Status snapshot for a managed process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStatus {
    pub id: ProcessId,
    pub state: ProcessState,
    pub applied: AppliedIsolation,
}

impl ProcessStatus {
    pub fn exit_code(&self) -> Option<u32> {
        match self.state {
            ProcessState::Exited { exit_code } => Some(exit_code),
            _ => None,
        }
    }

    pub fn is_running(&self) -> bool {
        matches!(self.state, ProcessState::Running { .. })
    }
}

/// A process owned by the runtime.
///
/// Dropping the value closes the Job Object handle. Because the job was
/// configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, that terminates every
/// process still in the tree. Call [`ManagedProcess::terminate`] for an
/// explicit, observable shutdown.
///
/// Field order is load-bearing: the job handle must close before the process
/// handle so the tree is terminated even on drop.
#[derive(Debug)]
pub struct ManagedProcess {
    id: ProcessId,
    job: Option<OwnedHandle>,
    process: OwnedHandle,
    applied: AppliedIsolation,
    state: ProcessState,
    diagnostics: Vec<DiagnosticEvent>,
}

impl ManagedProcess {
    pub(crate) fn new(
        id: ProcessId,
        job: Option<OwnedHandle>,
        process: OwnedHandle,
        applied: AppliedIsolation,
        initial_state: ProcessState,
        diagnostics: Vec<DiagnosticEvent>,
    ) -> Self {
        Self {
            id,
            job,
            process,
            applied,
            state: initial_state,
            diagnostics,
        }
    }

    /// Durable identity of this process instance.
    pub fn id(&self) -> ProcessId {
        self.id
    }

    /// Isolation that was applied and verified at launch.
    pub fn applied_isolation(&self) -> &AppliedIsolation {
        &self.applied
    }

    /// Structured events emitted during launch and lifecycle operations.
    pub fn diagnostics(&self) -> &[DiagnosticEvent] {
        &self.diagnostics
    }

    /// Last known state. Use [`ManagedProcess::status`] to query Windows.
    pub fn state(&self) -> ProcessState {
        self.state
    }

    /// Query the operating system for the current status.
    pub fn status(&self) -> Result<ProcessStatus> {
        platform_process::query_status(self.process.as_raw_handle().cast(), self.id, &self.applied)
    }

    /// Wait up to `timeout` for exit.
    ///
    /// Returns `Running` when the timeout elapses. A zero timeout performs a
    /// non-blocking poll.
    pub fn wait(&mut self, timeout: Duration) -> Result<ProcessStatus> {
        let status = platform_process::wait_for_status(
            self.process.as_raw_handle().cast(),
            self.id,
            &self.applied,
            timeout,
        )?;
        self.state = status.state;
        Ok(status)
    }

    /// Terminate the managed process tree and wait for the main process.
    ///
    /// Idempotent: calling it after exit still terminates any remaining
    /// children in the job and returns the main process status.
    pub fn terminate(&mut self) -> Result<ProcessStatus> {
        let status = platform_process::terminate_and_wait(
            self.job
                .as_ref()
                .map(|handle| handle.as_raw_handle().cast()),
            self.process.as_raw_handle().cast(),
            self.id,
            &self.applied,
        )?;
        self.state = status.state;
        Ok(status)
    }
}

/// Convenience conversion used by the launch path.
pub(crate) fn os_string_is_ascii_case_insensitive(a: &OsString, b: &OsString) -> bool {
    use std::os::windows::ffi::OsStrExt;

    let a: Vec<u16> = a.encode_wide().collect();
    let b: Vec<u16> = b.encode_wide().collect();
    crate::platform::windows::wide::slice_eq_ignore_ascii_case(&a, &b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_id_display_contains_both_parts() {
        let id = ProcessId {
            pid: 42,
            creation_time_100ns: 7,
        };
        assert_eq!(id.to_string(), "42:7");
    }

    #[test]
    fn status_exposes_exit_code_only_when_exited() {
        let applied = AppliedIsolation {
            mode: IsolationMode::Managed,
            job_object_attached: true,
            app_container_token: false,
            restricted_token: false,
            low_integrity: false,
            file_access_restricted: false,
            network_access: NetworkAccess::Allow,
            network_capabilities_verified: false,
        };
        let id = ProcessId {
            pid: 1,
            creation_time_100ns: 2,
        };

        let running = ProcessStatus {
            id,
            state: ProcessState::Running { pid: 1 },
            applied: applied.clone(),
        };
        assert_eq!(running.exit_code(), None);
        assert!(running.is_running());

        let exited = ProcessStatus {
            id,
            state: ProcessState::Exited { exit_code: 9 },
            applied,
        };
        assert_eq!(exited.exit_code(), Some(9));
        assert!(!exited.is_running());
    }

    #[test]
    fn ascii_case_insensitive_comparison() {
        assert!(os_string_is_ascii_case_insensitive(
            &OsString::from("Path"),
            &OsString::from("PATH")
        ));
        assert!(!os_string_is_ascii_case_insensitive(
            &OsString::from("Path"),
            &OsString::from("Paths")
        ));
    }
}
