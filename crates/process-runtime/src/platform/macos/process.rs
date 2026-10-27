//! Process launch, status and termination on macOS.
//!
//! Managed isolation is a POSIX process group: the child is created with
//! `process_group(0)`, the group id is verified with `getpgid`, and termination
//! uses `killpg`. The group leader is observed with
//! `waitid(WEXITED | WNOHANG | WNOWAIT)` so a status query does not reap it; the
//! leader is only reaped after the group has been signalled. Reaping earlier
//! would let the kernel reuse the PGID while children are still alive.

use std::io::ErrorKind;
use std::os::unix::process::CommandExt;
use std::process::Command;
use std::time::{Duration, Instant};

use crate::diagnostics::{DiagnosticEvent, DiagnosticLevel};
use crate::error::{Result, RuntimeError};
use crate::launch::PreparedLaunchSpec;
use crate::platform::macos::identity;
use crate::policy::IsolationMode;
use crate::process::{AppliedIsolation, ManagedProcess, ProcessId, ProcessState, ProcessStatus};

/// How long the group gets to exit after `SIGTERM` before `SIGKILL`.
const TERMINATE_GRACE: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// Launch a validated spec in its own process group.
pub(crate) fn launch(spec: &PreparedLaunchSpec) -> Result<ManagedProcess> {
    let mut diagnostics = Vec::with_capacity(4);
    push_event(
        &mut diagnostics,
        DiagnosticLevel::Info,
        "launch_requested",
        "validated launch request accepted",
        &spec.environment_id,
        mode_label(spec.policy.isolation),
    );

    let mut command = Command::new(&spec.executable);
    command.args(&spec.arguments);
    command.envs(&spec.environment_overrides);
    if let Some(directory) = &spec.working_directory {
        command.current_dir(directory);
    }
    // `process_group(0)` calls setpgid(post-child, 0) in the child, making it
    // the leader of a new group whose id equals its pid.
    command.process_group(0);

    let child = command.spawn().map_err(|error| {
        RuntimeError::platform_error("posix_spawn", error.raw_os_error().unwrap_or(0) as u32)
    })?;
    let pid = i32::try_from(child.id())
        .map_err(|_| RuntimeError::Internal("child pid does not fit in i32".into()))?;
    // The runtime reaps the child itself through `waitid`; dropping `Child`
    // does not wait, kill or reap it.
    drop(child);

    // SAFETY: `pid` is a live child of this process.
    let group = unsafe { libc::getpgid(pid) };
    if group < 0 || group != pid {
        kill_and_reap(pid);
        return Err(RuntimeError::CapabilityUnavailable(
            "could not create the managed process in its own POSIX process group".into(),
        ));
    }

    let id = match identity::process_id(pid) {
        Ok(id) => id,
        Err(error) => {
            kill_and_reap(pid);
            return Err(error);
        }
    };

    push_event(
        &mut diagnostics,
        DiagnosticLevel::Info,
        "process_group_created",
        "child created in its own process group and verified with getpgid",
        &spec.environment_id,
        mode_label(spec.policy.isolation),
    );
    push_event(
        &mut diagnostics,
        DiagnosticLevel::Info,
        "process_identity_verified",
        "process start time read with proc_pidinfo",
        &spec.environment_id,
        mode_label(spec.policy.isolation),
    );

    let applied = AppliedIsolation {
        mode: spec.policy.isolation,
        job_object_attached: false,
        app_container_token: false,
        restricted_token: false,
        low_integrity: false,
        file_access_restricted: false,
        network_access: spec.policy.network_access,
        network_capabilities_verified: false,
        process_group_attached: Some(true),
        process_group_id: Some(group as u32),
        kill_on_close_armed: Some(true),
    };

    Ok(ManagedProcess::new(
        id,
        Handle::new(pid, group),
        applied,
        ProcessState::Running { pid: id.pid },
        diagnostics,
    ))
}

/// Owned POSIX process group for one managed process.
///
/// Dropping the handle signals the group with `SIGKILL` and reaps the leader.
/// There is no kernel-level "kill on close" equivalent to a Job Object: if the
/// runtime itself is killed, the group survives.
#[derive(Debug)]
pub(crate) struct Handle {
    pid: libc::pid_t,
    pgid: libc::pid_t,
    reaped: bool,
    exit_code: Option<u32>,
}

impl Handle {
    pub(crate) fn new(pid: libc::pid_t, pgid: libc::pid_t) -> Self {
        Self {
            pid,
            pgid,
            reaped: false,
            exit_code: None,
        }
    }

    pub(crate) fn status(
        &self,
        id: ProcessId,
        applied: &AppliedIsolation,
    ) -> Result<ProcessStatus> {
        match self.observed_exit()? {
            Some(exit_code) => Ok(exited_status(id, exit_code, applied)),
            None => Ok(running_status(id, applied)),
        }
    }

    pub(crate) fn wait(
        &mut self,
        id: ProcessId,
        applied: &AppliedIsolation,
        timeout: Duration,
    ) -> Result<ProcessStatus> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(exit_code) = self.observed_exit()? {
                return Ok(exited_status(id, exit_code, applied));
            }
            if timeout.is_zero() || Instant::now() >= deadline {
                return Ok(running_status(id, applied));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            std::thread::sleep(POLL_INTERVAL.min(remaining));
        }
    }

    /// Signal the group, reap the leader and report its exit.
    ///
    /// Idempotent: after the first call the recorded exit code is returned.
    pub(crate) fn terminate(
        &mut self,
        id: ProcessId,
        applied: &AppliedIsolation,
    ) -> Result<ProcessStatus> {
        if let Some(exit_code) = self.exit_code {
            return Ok(exited_status(id, exit_code, applied));
        }

        if !self.reaped {
            // Ignore ESRCH: the group may already be gone.
            // SAFETY: `pgid` is the group this handle created.
            unsafe {
                libc::killpg(self.pgid, libc::SIGTERM);
            }

            let deadline = Instant::now() + TERMINATE_GRACE;
            loop {
                if self.observed_exit()?.is_some() {
                    break;
                }
                if Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(POLL_INTERVAL);
            }

            // Always escalate: children that ignored SIGTERM are still in the
            // group and must not outlive the call.
            // SAFETY: same group as above; ESRCH is harmless.
            unsafe {
                libc::killpg(self.pgid, libc::SIGKILL);
            }
        }

        let exit_code = self.reap_blocking()?;
        Ok(exited_status(id, exit_code, applied))
    }

    /// Observe exit without reaping. `None` means still running.
    fn observed_exit(&self) -> Result<Option<u32>> {
        if let Some(exit_code) = self.exit_code {
            return Ok(Some(exit_code));
        }

        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        loop {
            // SAFETY: `info` is a correctly sized siginfo_t and `pid` is our
            // child. WNOWAIT leaves the zombie in place for the later reap.
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    self.pid as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if result == 0 {
                break;
            }
            let error = std::io::Error::last_os_error();
            if error.kind() != ErrorKind::Interrupted {
                return Err(platform_failure("waitid", &error));
            }
        }

        if info.si_pid == 0 {
            Ok(None)
        } else {
            Ok(Some(exit_code_from(&info)))
        }
    }

    /// Reap the leader and record its exit code.
    fn reap_blocking(&mut self) -> Result<u32> {
        if let Some(exit_code) = self.exit_code {
            return Ok(exit_code);
        }

        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        loop {
            // SAFETY: `info` is a correctly sized siginfo_t and `pid` is our
            // child. Without WNOWAIT this releases the zombie.
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    self.pid as libc::id_t,
                    &mut info,
                    libc::WEXITED,
                )
            };
            if result == 0 {
                let exit_code = exit_code_from(&info);
                self.exit_code = Some(exit_code);
                self.reaped = true;
                return Ok(exit_code);
            }
            let error = std::io::Error::last_os_error();
            if error.kind() != ErrorKind::Interrupted {
                return Err(platform_failure("waitid", &error));
            }
        }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        if self.reaped {
            // The PGID may already have been reused; never signal it after the
            // leader was reaped.
            return;
        }
        // SAFETY: `pgid` identifies the group created for this handle; ESRCH is
        // harmless when the group already exited.
        unsafe {
            libc::killpg(self.pgid, libc::SIGKILL);
        }
        // The leader must not remain a zombie; ignore a failure during drop.
        let _ = self.reap_blocking();
    }
}

fn running_status(id: ProcessId, applied: &AppliedIsolation) -> ProcessStatus {
    ProcessStatus {
        id,
        state: ProcessState::Running { pid: id.pid },
        applied: applied.clone(),
    }
}

fn exited_status(id: ProcessId, exit_code: u32, applied: &AppliedIsolation) -> ProcessStatus {
    ProcessStatus {
        id,
        state: ProcessState::Exited { exit_code },
        applied: applied.clone(),
    }
}

/// Interpret a `waitid` result for an exited child.
fn exit_code_from(info: &libc::siginfo_t) -> u32 {
    match info.si_code {
        libc::CLD_EXITED => (info.si_status as u32) & 0xff,
        // Killed or dumped: follow the shell convention of 128 + signal.
        _ => 128 + (info.si_status as u32 & 0x7f),
    }
}

/// Kill a group and reap its leader. Used on the launch error path.
fn kill_and_reap(pid: libc::pid_t) {
    // SAFETY: `pid` is the child created by this launch; ESRCH is harmless.
    unsafe {
        libc::killpg(pid, libc::SIGKILL);
    }
    let mut status = 0;
    // SAFETY: `pid` is our child and has not been reaped.
    unsafe {
        while libc::waitpid(pid, &mut status, 0) < 0 {
            if std::io::Error::last_os_error().kind() != ErrorKind::Interrupted {
                break;
            }
        }
    }
}

fn platform_failure(operation: &str, error: &std::io::Error) -> RuntimeError {
    RuntimeError::platform_error(operation, error.raw_os_error().unwrap_or(0) as u32)
}

fn push_event(
    diagnostics: &mut Vec<DiagnosticEvent>,
    level: DiagnosticLevel,
    code: &str,
    message: &str,
    environment_id: &str,
    mode: &str,
) {
    diagnostics.push(
        DiagnosticEvent::new(level, "process.launch", code, message)
            .with_context("environment_id", environment_id)
            .with_context("isolation", mode),
    );
}

fn mode_label(mode: IsolationMode) -> &'static str {
    match mode {
        IsolationMode::Managed => "managed",
        IsolationMode::Restricted => "restricted",
        IsolationMode::AppContainer => "app_container",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_codes_follow_the_shell_convention() {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        info.si_code = libc::CLD_EXITED;
        info.si_status = 7;
        assert_eq!(exit_code_from(&info), 7);

        info.si_code = libc::CLD_KILLED;
        info.si_status = libc::SIGKILL;
        assert_eq!(exit_code_from(&info), 128 + 9);
    }
}
