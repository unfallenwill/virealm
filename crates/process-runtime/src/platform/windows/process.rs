//! Process launch, status and termination.
//!
//! Launch follows one order everywhere: create suspended, apply containment,
//! resume, then verify what Windows actually produced. A failure at any point
//! tears the process down; there is no path that quietly returns a weaker
//! isolation mode.

use std::ffi::c_void;
use std::mem::size_of;
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::time::Duration;

use windows_sys::Win32::Foundation::{FILETIME, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::Security::TOKEN_QUERY;
use windows_sys::Win32::System::Threading::{
    CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessAsUserW, CreateProcessW,
    DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess,
    GetProcessTimes, InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, PROCESS_INFORMATION, ResumeThread, STARTUPINFOEXW,
    STARTUPINFOW, TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject,
};

use crate::diagnostics::{DiagnosticEvent, DiagnosticLevel};
use crate::error::{Result, RuntimeError};
use crate::launch::PreparedLaunchSpec;
use crate::platform::windows::app_container::{
    AppContainerProfile, NETWORK_CAPABILITIES, SECURITY_CAPABILITIES_SIZE, SecurityCapabilities,
};
use crate::platform::windows::{
    acl, app_container, command_line, environment, handles, job_object::JobObject, path, token,
};
use crate::policy::{
    AccessLevel, ContainmentLimits, FileAccessPolicy, IsolationMode, NetworkAccess,
};
use crate::process::{AppliedIsolation, ManagedProcess, ProcessId, ProcessState, ProcessStatus};

const PROCESS_FLAGS: u32 =
    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT;
const TERMINATE_WAIT_MS: u32 = 10_000;

/// Launch a validated spec.
pub(crate) fn launch(spec: &PreparedLaunchSpec) -> Result<ManagedProcess> {
    let mut diagnostics = Vec::with_capacity(8);
    push_event(
        &mut diagnostics,
        DiagnosticLevel::Info,
        "launch_requested",
        "validated launch request accepted",
        &spec.environment_id,
        mode_label(spec.policy.isolation),
    );

    let job = JobObject::create(&spec.policy.containment)?;
    push_event(
        &mut diagnostics,
        DiagnosticLevel::Info,
        "job_object_configured",
        "Job Object limits applied and read back",
        &spec.environment_id,
        mode_label(spec.policy.isolation),
    );

    let app_context = match spec.policy.isolation {
        IsolationMode::AppContainer => Some(AppContainerContext::prepare(spec, &mut diagnostics)?),
        IsolationMode::Managed | IsolationMode::Restricted => None,
    };

    let restricted_token = match spec.policy.isolation {
        IsolationMode::Restricted => {
            Some(token::create_restricted_low_token().map_err(|error| {
                RuntimeError::CapabilityUnavailable(format!(
                    "restricted mode requires a low-integrity restricted token: {error}"
                ))
            })?)
        }
        IsolationMode::Managed | IsolationMode::AppContainer => None,
    };

    let temp_directory = app_context
        .as_ref()
        .map(AppContainerContext::temp_directory);
    let environment_block = environment::build_block(&spec.environment_overrides, temp_directory)?;
    let mut command_line_buffer =
        command_line::build_command_line(&spec.executable, &spec.arguments);
    let application = path::path_to_wide_null(&spec.executable);
    let working_directory = spec
        .working_directory
        .as_ref()
        .map(|directory| path::path_to_wide_null(directory));

    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    if let Some(context) = &app_context {
        startup.lpAttributeList = context.attribute_list();
    }

    let mut process_information = PROCESS_INFORMATION::default();
    let current_directory = working_directory
        .as_ref()
        .map_or(std::ptr::null(), |directory| directory.as_ptr());
    let environment_pointer: *const c_void = environment_block.as_ptr().cast();

    // SAFETY: all pointers reference buffers that live until CreateProcess
    // returns. The startup structure is a STARTUPINFOEXW whose `cb` covers the
    // extended structure, and the attribute list (when present) was built for
    // SECURITY_CAPABILITIES.
    let created = unsafe {
        match (&restricted_token, &app_context) {
            (Some(token), _) => CreateProcessAsUserW(
                token.as_raw_handle() as HANDLE,
                application.as_ptr(),
                command_line_buffer.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                PROCESS_FLAGS,
                environment_pointer,
                current_directory,
                (&startup as *const STARTUPINFOEXW).cast::<STARTUPINFOW>(),
                &mut process_information,
            ),
            _ => CreateProcessW(
                application.as_ptr(),
                command_line_buffer.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                PROCESS_FLAGS,
                environment_pointer,
                current_directory,
                (&startup as *const STARTUPINFOEXW).cast::<STARTUPINFOW>(),
                &mut process_information,
            ),
        }
    };

    if created == 0 {
        let error = RuntimeError::last_platform_error("CreateProcessW");
        if spec.policy.isolation == IsolationMode::Restricted
            && matches!(&error, RuntimeError::PlatformFailure { code: 1314, .. })
        {
            return Err(RuntimeError::CapabilityUnavailable(
                "restricted mode could not create the process with its restricted token; \
                 this environment requires SeAssignPrimaryTokenPrivilege"
                    .into(),
            ));
        }
        return Err(error);
    }

    let process = handles::from_raw(process_information.hProcess, "CreateProcessW(process)")?;
    let thread = match handles::from_raw(process_information.hThread, "CreateProcessW(thread)") {
        Ok(thread) => thread,
        Err(error) => {
            // SAFETY: the process was created and is still suspended.
            unsafe { TerminateProcess(process.as_raw_handle() as HANDLE, 1) };
            return Err(error);
        }
    };

    let mut kill_guard = KillOnDrop::new(process.as_raw_handle() as HANDLE);

    job.assign(process.as_raw_handle() as HANDLE)?;
    push_event(
        &mut diagnostics,
        DiagnosticLevel::Info,
        "job_object_assigned",
        "process assigned to the Job Object and verified with IsProcessInJob",
        &spec.environment_id,
        mode_label(spec.policy.isolation),
    );

    // SAFETY: the thread handle refers to the primary thread of the suspended
    // process and is valid until it is closed below.
    let previous_suspend_count = unsafe { ResumeThread(thread.as_raw_handle() as HANDLE) };
    if previous_suspend_count == u32::MAX {
        return Err(RuntimeError::last_platform_error("ResumeThread"));
    }
    drop(thread);

    let id = process_id(
        process.as_raw_handle() as HANDLE,
        process_information.dwProcessId,
    )?;
    let applied = verify_isolation(spec, process.as_raw_handle() as HANDLE)?;

    kill_guard.disarm();
    push_event(
        &mut diagnostics,
        DiagnosticLevel::Info,
        "isolation_verified",
        "child token and containment matched the requested policy",
        &spec.environment_id,
        mode_label(spec.policy.isolation),
    );

    Ok(ManagedProcess::new(
        id,
        Handle::new(Some(job.into_handle()), process),
        applied,
        ProcessState::Running { pid: id.pid },
        diagnostics,
    ))
}

/// Owned Windows handles for one managed process.
///
/// Field order is load-bearing: the job handle must close before the process
/// handle so `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` terminates the tree even on
/// drop.
#[derive(Debug)]
pub(crate) struct Handle {
    job: Option<OwnedHandle>,
    process: OwnedHandle,
}

impl Handle {
    pub(crate) fn new(job: Option<OwnedHandle>, process: OwnedHandle) -> Self {
        Self { job, process }
    }

    pub(crate) fn status(
        &self,
        id: ProcessId,
        applied: &AppliedIsolation,
    ) -> Result<ProcessStatus> {
        query_status(self.process.as_raw_handle().cast(), id, applied)
    }

    pub(crate) fn wait(
        &mut self,
        id: ProcessId,
        applied: &AppliedIsolation,
        timeout: Duration,
    ) -> Result<ProcessStatus> {
        wait_for_status(self.process.as_raw_handle().cast(), id, applied, timeout)
    }

    pub(crate) fn terminate(
        &mut self,
        id: ProcessId,
        applied: &AppliedIsolation,
    ) -> Result<ProcessStatus> {
        terminate_and_wait(
            self.job
                .as_ref()
                .map(|handle| handle.as_raw_handle().cast()),
            self.process.as_raw_handle().cast(),
            id,
            applied,
        )
    }
}

/// Query a process without waiting.
pub(crate) fn query_status(
    process: HANDLE,
    id: ProcessId,
    applied: &AppliedIsolation,
) -> Result<ProcessStatus> {
    if wait_for(process, 0)? {
        exited_status(process, id, applied)
    } else {
        Ok(ProcessStatus {
            id,
            state: ProcessState::Running { pid: id.pid },
            applied: applied.clone(),
        })
    }
}

/// Wait for exit or timeout.
pub(crate) fn wait_for_status(
    process: HANDLE,
    id: ProcessId,
    applied: &AppliedIsolation,
    timeout: Duration,
) -> Result<ProcessStatus> {
    let milliseconds = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX);
    if wait_for(process, milliseconds)? {
        exited_status(process, id, applied)
    } else {
        Ok(ProcessStatus {
            id,
            state: ProcessState::Running { pid: id.pid },
            applied: applied.clone(),
        })
    }
}

/// Terminate the job or process and wait for the main process to exit.
pub(crate) fn terminate_and_wait(
    job: Option<HANDLE>,
    process: HANDLE,
    id: ProcessId,
    applied: &AppliedIsolation,
) -> Result<ProcessStatus> {
    let initial = query_status(process, id, applied)?;

    if !initial.is_running() {
        // The main process already exited, but children may still be alive in
        // the job. Closing the job handle would kill them; do it explicitly so
        // the caller observes the result now.
        if let Some(job) = job {
            // SAFETY: the job handle is valid and owned by the ManagedProcess.
            let ok = unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(job, 1) };
            if ok == 0 {
                return Err(RuntimeError::last_platform_error("TerminateJobObject"));
            }
        }
        return Ok(initial);
    }

    let terminated = match job {
        Some(job) => {
            // SAFETY: the job handle is valid and owned by the ManagedProcess.
            unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(job, 1) }
        }
        None => {
            // SAFETY: the process handle is valid and owned by ManagedProcess.
            unsafe { TerminateProcess(process, 1) }
        }
    };

    if terminated == 0 {
        let status = query_status(process, id, applied)?;
        if !status.is_running() {
            return Ok(status);
        }
        return Err(RuntimeError::last_platform_error(if job.is_some() {
            "TerminateJobObject"
        } else {
            "TerminateProcess"
        }));
    }

    if !wait_for(process, TERMINATE_WAIT_MS)? {
        return Err(RuntimeError::platform_error(
            "WaitForSingleObject(after terminate)",
            1460,
        ));
    }
    exited_status(process, id, applied)
}

/// Launch a process suspended, assign it to a job, and terminate it without
/// ever resuming it. Used only by capability probes.
pub(crate) fn probe_suspended_process(
    executable: &Path,
    app: Option<(&AppContainerProfile, &SecurityCapabilities)>,
    token_handle: Option<HANDLE>,
) -> Result<()> {
    if !executable.is_file() {
        return Err(RuntimeError::InvalidRequest(format!(
            "probe executable does not exist: {}",
            executable.display()
        )));
    }

    let application = path::path_to_wide_null(executable);
    let attributes = match app {
        Some((_, capabilities)) => Some(AttributeList::for_capabilities(capabilities)?),
        None => None,
    };

    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    if let Some(attributes) = &attributes {
        startup.lpAttributeList = attributes.as_ptr();
    }

    let flags = CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT;
    let mut process_information = PROCESS_INFORMATION::default();
    // SAFETY: the application path is NUL-terminated; no command line is
    // needed because the module name becomes argv[0]. The startup structure is
    // fully initialized.
    let created = unsafe {
        match token_handle {
            Some(token) => CreateProcessAsUserW(
                token,
                application.as_ptr(),
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                flags,
                std::ptr::null(),
                std::ptr::null(),
                (&startup as *const STARTUPINFOEXW).cast::<STARTUPINFOW>(),
                &mut process_information,
            ),
            None => CreateProcessW(
                application.as_ptr(),
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                flags,
                std::ptr::null(),
                std::ptr::null(),
                (&startup as *const STARTUPINFOEXW).cast::<STARTUPINFOW>(),
                &mut process_information,
            ),
        }
    };
    if created == 0 {
        return Err(RuntimeError::last_platform_error("CreateProcessW(probe)"));
    }

    let process = handles::from_raw(process_information.hProcess, "probe process handle")?;
    let thread = handles::from_raw(process_information.hThread, "probe thread handle")?;
    let mut kill_guard = KillOnDrop::new(process.as_raw_handle() as HANDLE);

    let job = JobObject::create(&ContainmentLimits::default())?;
    job.assign(process.as_raw_handle() as HANDLE)?;
    job.terminate(1)?;

    if !wait_for(process.as_raw_handle() as HANDLE, 5_000)? {
        return Err(RuntimeError::platform_error(
            "WaitForSingleObject(probe)",
            1460,
        ));
    }

    kill_guard.disarm();
    drop(thread);
    drop(job);
    Ok(())
}

fn exited_status(
    process: HANDLE,
    id: ProcessId,
    applied: &AppliedIsolation,
) -> Result<ProcessStatus> {
    let mut exit_code = 0u32;
    // SAFETY: the process handle is valid and `exit_code` is writable.
    let ok = unsafe { GetExitCodeProcess(process, &mut exit_code) };
    if ok == 0 {
        return Err(RuntimeError::last_platform_error("GetExitCodeProcess"));
    }
    Ok(ProcessStatus {
        id,
        state: ProcessState::Exited { exit_code },
        applied: applied.clone(),
    })
}

fn wait_for(process: HANDLE, milliseconds: u32) -> Result<bool> {
    // SAFETY: the process handle is valid.
    let result = unsafe { WaitForSingleObject(process, milliseconds) };
    match result {
        WAIT_OBJECT_0 => Ok(true),
        WAIT_TIMEOUT => Ok(false),
        _ => Err(RuntimeError::last_platform_error("WaitForSingleObject")),
    }
}

fn process_id(process: HANDLE, pid: u32) -> Result<ProcessId> {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: all out-parameters are writable and the process handle is valid.
    let ok = unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) };
    if ok == 0 {
        return Err(RuntimeError::last_platform_error("GetProcessTimes"));
    }

    let creation_time_100ns =
        (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
    if creation_time_100ns == 0 {
        return Err(RuntimeError::Internal(
            "GetProcessTimes returned a zero creation time".into(),
        ));
    }

    Ok(ProcessId {
        pid,
        creation_time_100ns,
    })
}

fn verify_isolation(spec: &PreparedLaunchSpec, process: HANDLE) -> Result<AppliedIsolation> {
    let token_handle = token::open_for(process, TOKEN_QUERY, "OpenProcessToken(child)")?;
    let token = token_handle.as_raw_handle() as HANDLE;

    let mode = spec.policy.isolation;
    let mut app_container_token = false;
    let mut restricted_token = false;
    let mut low_integrity = false;
    let mut network_capabilities_verified = false;

    match mode {
        IsolationMode::Managed => {}
        IsolationMode::Restricted => {
            if token::integrity_level(token)? != crate::capabilities::IntegrityLevel::Low {
                return Err(RuntimeError::Internal(
                    "restricted token does not carry a low integrity label".into(),
                ));
            }
            if token::enabled_privilege_count(token)? > 1 {
                return Err(RuntimeError::Internal(
                    "restricted token still has privileges enabled".into(),
                ));
            }
            restricted_token = true;
            low_integrity = true;
        }
        IsolationMode::AppContainer => {
            if !token::is_app_container(token)? {
                return Err(RuntimeError::Internal(
                    "app_container mode produced a token that is not an AppContainer".into(),
                ));
            }
            app_container_token = true;
            if token::integrity_level(token)? != crate::capabilities::IntegrityLevel::Low {
                return Err(RuntimeError::Internal(
                    "AppContainer token does not carry a low integrity label".into(),
                ));
            }
            low_integrity = true;

            match spec.policy.network_access {
                NetworkAccess::Allow => {
                    for sid in NETWORK_CAPABILITIES {
                        if !token::has_capability(token, sid)? {
                            return Err(RuntimeError::Internal(format!(
                                "AppContainer token is missing network capability {sid}"
                            )));
                        }
                    }
                }
                NetworkAccess::Deny => {
                    for sid in NETWORK_CAPABILITIES {
                        if token::has_capability(token, sid)? {
                            return Err(RuntimeError::Internal(format!(
                                "AppContainer token has network capability {sid} despite deny policy"
                            )));
                        }
                    }
                }
            }
            network_capabilities_verified = true;
        }
    }

    Ok(AppliedIsolation {
        mode,
        job_object_attached: true,
        app_container_token,
        restricted_token,
        low_integrity,
        file_access_restricted: mode == IsolationMode::AppContainer,
        network_access: spec.policy.network_access,
        network_capabilities_verified,
        process_group_attached: None,
        process_group_id: None,
        kill_on_close_armed: None,
    })
}

/// Per-launch AppContainer setup: profile, security capabilities, attribute
/// list, and the environment temp directory.
struct AppContainerContext {
    _profile: AppContainerProfile,
    _capabilities: SecurityCapabilities,
    attributes: AttributeList,
    temp_directory: PathBuf,
}

impl AppContainerContext {
    fn prepare(spec: &PreparedLaunchSpec, diagnostics: &mut Vec<DiagnosticEvent>) -> Result<Self> {
        let profile = AppContainerProfile::open_or_create(&spec.environment_id)
            .map_err(|error| prerequisite("AppContainer profile", error))?;

        let capability_sids = app_container::network_capabilities(spec.policy.network_access)
            .map_err(|error| prerequisite("AppContainer network capability", error))?;
        let capabilities = SecurityCapabilities::new(profile.sid(), capability_sids)?;
        let attributes = AttributeList::for_capabilities(&capabilities)
            .map_err(|error| prerequisite("AppContainer attribute list", error))?;

        let temp_directory = spec.data_directory.join("Temp");
        std::fs::create_dir_all(&temp_directory)
            .map_err(|error| io_error("create environment temp directory", &error))?;

        let FileAccessPolicy::Restricted {
            data_directory,
            additional_roots,
        } = &spec.policy.file_access
        else {
            return Err(RuntimeError::Internal(
                "validated AppContainer policy is not file-restricted".into(),
            ));
        };

        acl::grant(&spec.data_directory, profile.sid(), *data_directory)
            .map_err(|error| prerequisite("AppContainer data directory grant", error))?;
        acl::grant(&temp_directory, profile.sid(), AccessLevel::ReadWrite)
            .map_err(|error| prerequisite("AppContainer temp directory grant", error))?;
        for root in additional_roots {
            acl::grant(&root.path, profile.sid(), root.access)
                .map_err(|error| prerequisite("AppContainer additional root grant", error))?;
        }

        push_event(
            diagnostics,
            DiagnosticLevel::Info,
            "app_container_ready",
            "AppContainer profile, security capabilities and directory ACLs verified",
            &spec.environment_id,
            "app_container",
        );

        Ok(Self {
            _profile: profile,
            _capabilities: capabilities,
            attributes,
            temp_directory,
        })
    }

    fn attribute_list(&self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.attributes.as_ptr()
    }

    fn temp_directory(&self) -> &Path {
        &self.temp_directory
    }
}

/// Owns the attribute list buffer.
struct AttributeList {
    _buffer: Vec<usize>,
    list: LPPROC_THREAD_ATTRIBUTE_LIST,
}

impl AttributeList {
    fn for_capabilities(capabilities: &SecurityCapabilities) -> Result<Self> {
        let mut size = 0usize;
        // SAFETY: a size query with a null list is expected to fail and write
        // the required buffer size.
        unsafe {
            InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size);
        }
        if size == 0 {
            return Err(RuntimeError::last_platform_error(
                "InitializeProcThreadAttributeList(size)",
            ));
        }

        let words = size.div_ceil(size_of::<usize>());
        let mut buffer = vec![0usize; words];
        let list = buffer.as_mut_ptr().cast::<c_void>();
        let mut initialized_size = size;
        // SAFETY: the buffer is at least `size` bytes and is writable.
        let ok = unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut initialized_size) };
        if ok == 0 {
            return Err(RuntimeError::last_platform_error(
                "InitializeProcThreadAttributeList",
            ));
        }

        // SAFETY: `capabilities` outlives this call; UpdateProcThreadAttribute
        // copies the SECURITY_CAPABILITIES value into the list.
        let ok = unsafe {
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                capabilities.as_ptr(),
                SECURITY_CAPABILITIES_SIZE,
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        if ok == 0 {
            // SAFETY: the list was successfully initialized.
            unsafe { DeleteProcThreadAttributeList(list) };
            return Err(RuntimeError::last_platform_error(
                "UpdateProcThreadAttribute",
            ));
        }

        Ok(Self {
            _buffer: buffer,
            list,
        })
    }

    fn as_ptr(&self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.list
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        // SAFETY: the list was initialized exactly once by this value.
        unsafe { DeleteProcThreadAttributeList(self.list) };
    }
}

/// Terminates a suspended process if a later launch step fails.
struct KillOnDrop {
    process: HANDLE,
    armed: bool,
}

impl KillOnDrop {
    fn new(process: HANDLE) -> Self {
        Self {
            process,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        if self.armed {
            // SAFETY: the process handle was created by this launch path and
            // has not been closed yet.
            unsafe { TerminateProcess(self.process, 1) };
        }
    }
}

fn push_event(
    diagnostics: &mut Vec<DiagnosticEvent>,
    level: DiagnosticLevel,
    code: &str,
    message: &str,
    environment_id: &str,
    isolation: &str,
) {
    diagnostics.push(
        DiagnosticEvent::new(level, "process.launch", code, message)
            .with_context("environment_id", environment_id)
            .with_context("isolation", isolation),
    );
}

fn mode_label(mode: IsolationMode) -> &'static str {
    match mode {
        IsolationMode::Managed => "managed",
        IsolationMode::Restricted => "restricted",
        IsolationMode::AppContainer => "app_container",
    }
}

fn prerequisite(operation: &str, error: RuntimeError) -> RuntimeError {
    match error {
        RuntimeError::CapabilityUnavailable(message) => {
            RuntimeError::CapabilityUnavailable(format!("{operation}: {message}"))
        }
        RuntimeError::PlatformFailure { code, message, .. } => RuntimeError::CapabilityUnavailable(
            format!("{operation} failed (Win32 {code}): {message}"),
        ),
        other => other,
    }
}

fn io_error(operation: &str, error: &std::io::Error) -> RuntimeError {
    RuntimeError::platform_failure(
        operation,
        error.raw_os_error().unwrap_or(0) as u32,
        error.to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_labels_are_stable() {
        assert_eq!(mode_label(IsolationMode::Managed), "managed");
        assert_eq!(mode_label(IsolationMode::Restricted), "restricted");
        assert_eq!(mode_label(IsolationMode::AppContainer), "app_container");
    }

    #[test]
    fn prerequisite_errors_remain_structured() {
        let error = prerequisite(
            "profile",
            RuntimeError::platform_error("CreateAppContainerProfile", 5),
        );
        assert!(matches!(error, RuntimeError::CapabilityUnavailable(_)));
    }
}
