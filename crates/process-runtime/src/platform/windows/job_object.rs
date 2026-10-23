//! Job Object lifecycle and resource limits.
//!
//! The job is created before process creation, assigned immediately after, and
//! queried back so the launch path can report configured limits as evidence.
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` is mandatory: closing the job handle
//! must terminate every remaining process in the tree.

use std::mem::size_of;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
};

use crate::error::{Result, RuntimeError};
use crate::policy::ContainmentLimits;

/// An owned Job Object handle.
#[derive(Debug)]
pub struct JobObject {
    handle: OwnedHandle,
    limits: ContainmentLimits,
}

impl JobObject {
    /// Create a job and apply the requested limits.
    pub fn create(limits: &ContainmentLimits) -> Result<Self> {
        limits.validate()?;

        // SAFETY: no attributes or name are required for an anonymous job.
        let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw.is_null() {
            return Err(RuntimeError::last_platform_error("CreateJobObjectW"));
        }
        // SAFETY: ownership of the returned handle is transferred to `OwnedHandle`.
        let handle = unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) };

        let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        let mut flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if let Some(max_processes) = limits.max_processes {
            flags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            information.BasicLimitInformation.ActiveProcessLimit = max_processes;
        }
        if let Some(bytes) = limits.memory_limit_bytes {
            flags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
            information.ProcessMemoryLimit = usize::try_from(bytes).map_err(|_| {
                RuntimeError::InvalidRequest(
                    "memory_limit_bytes does not fit this platform's address space".into(),
                )
            })?;
        }
        information.BasicLimitInformation.LimitFlags = flags;

        // SAFETY: the structure matches JobObjectExtendedLimitInformation and
        // its size is passed explicitly.
        let ok = unsafe {
            SetInformationJobObject(
                handle.as_raw_handle() as HANDLE,
                JobObjectExtendedLimitInformation,
                (&information as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(RuntimeError::last_platform_error("SetInformationJobObject"));
        }

        let job = Self {
            handle,
            limits: *limits,
        };
        job.verify_limits()?;
        Ok(job)
    }

    /// Raw job handle.
    pub fn handle(&self) -> HANDLE {
        self.handle.as_raw_handle() as HANDLE
    }

    /// Transfer ownership of the job handle to the caller.
    ///
    /// The caller becomes responsible for closing it, which also terminates
    /// the remaining process tree because kill-on-close is mandatory.
    pub fn into_handle(self) -> OwnedHandle {
        self.handle
    }

    /// Assign a process to the job and verify the assignment took effect.
    pub(crate) fn assign(&self, process: HANDLE) -> Result<()> {
        // SAFETY: both handles are valid for the duration of the call.
        let ok = unsafe { AssignProcessToJobObject(self.handle(), process) };
        if ok == 0 {
            return Err(RuntimeError::last_platform_error(
                "AssignProcessToJobObject",
            ));
        }
        if !self.contains(process)? {
            return Err(RuntimeError::Internal(
                "process was assigned but IsProcessInJob reports it is not in the job".into(),
            ));
        }
        Ok(())
    }

    /// Whether a process belongs to this job.
    pub(crate) fn contains(&self, process: HANDLE) -> Result<bool> {
        let mut result = 0;
        // SAFETY: both handles are valid; `result` is writable.
        let ok = unsafe { IsProcessInJob(process, self.handle(), &mut result) };
        if ok == 0 {
            return Err(RuntimeError::last_platform_error("IsProcessInJob"));
        }
        Ok(result != 0)
    }

    /// Terminate every process in the job.
    pub fn terminate(&self, exit_code: u32) -> Result<()> {
        // SAFETY: the job handle is valid.
        let ok = unsafe { TerminateJobObject(self.handle(), exit_code) };
        if ok == 0 {
            return Err(RuntimeError::last_platform_error("TerminateJobObject"));
        }
        Ok(())
    }

    /// Read the limits back from Windows and compare them with the request.
    fn verify_limits(&self) -> Result<()> {
        let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        let mut returned = 0u32;
        // SAFETY: the structure matches the requested class and is writable.
        let ok = unsafe {
            QueryInformationJobObject(
                self.handle(),
                JobObjectExtendedLimitInformation,
                (&mut information as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                &mut returned,
            )
        };
        if ok == 0 {
            return Err(RuntimeError::last_platform_error(
                "QueryInformationJobObject",
            ));
        }

        let actual = &information.BasicLimitInformation;
        if (actual.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) == 0 {
            return Err(RuntimeError::Internal(
                "Job Object did not retain JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE".into(),
            ));
        }
        if let Some(max_processes) = self.limits.max_processes
            && actual.ActiveProcessLimit != max_processes
        {
            return Err(RuntimeError::Internal(format!(
                "Job Object active process limit is {}, expected {max_processes}",
                actual.ActiveProcessLimit
            )));
        }
        if let Some(bytes) = self.limits.memory_limit_bytes
            && information.ProcessMemoryLimit as u64 != bytes
        {
            return Err(RuntimeError::Internal(format!(
                "Job Object process memory limit is {}, expected {bytes}",
                information.ProcessMemoryLimit
            )));
        }
        Ok(())
    }
}

/// Exercise Job Object creation and limit configuration.
pub fn probe() -> crate::capabilities::Capability {
    match JobObject::create(&ContainmentLimits::default()) {
        Ok(_) => crate::capabilities::Capability::supported(
            "created a Job Object, applied JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, and read it back",
        ),
        Err(error) => classify_probe_error(&error),
    }
}

fn classify_probe_error(error: &RuntimeError) -> crate::capabilities::Capability {
    use crate::capabilities::Capability;

    match error {
        RuntimeError::PlatformFailure { code, message, .. } if matches!(*code, 5 | 740 | 1314) => {
            Capability::unavailable(format!(
                "Job Object creation was denied (Win32 {code}): {message}"
            ))
        }
        other => Capability::unavailable(format!("Job Object probe failed: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_object_applies_and_reports_limits() {
        let limits = ContainmentLimits {
            kill_on_close: true,
            max_processes: Some(4),
            memory_limit_bytes: Some(64 * 1024 * 1024),
        };
        let job = JobObject::create(&limits).expect("job creation");
        assert!(!job.handle().is_null());
    }

    #[test]
    fn job_object_rejects_disabled_kill_on_close() {
        let limits = ContainmentLimits {
            kill_on_close: false,
            ..ContainmentLimits::default()
        };
        assert!(matches!(
            JobObject::create(&limits),
            Err(RuntimeError::PolicyViolation(_))
        ));
    }
}
