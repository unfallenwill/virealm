//! Capability probe.
//!
//! Every state is produced by attempting the operation. Version numbers are
//! reported but never used as evidence. Probes clean up after themselves and
//! never leave a resumable process behind.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use windows_sys::Win32::System::SystemServices::PROCESS_MITIGATION_CHILD_PROCESS_POLICY;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetProcessMitigationPolicy, ProcessChildProcessPolicy,
};

use crate::capabilities::{
    Capability, CapabilityReport, IntegrityLevel, PlatformInfo, WindowsVersion,
};
use crate::error::RuntimeError;
use crate::platform::windows::{
    acl, app_container::AppContainerProfile, app_container::SecurityCapabilities, job_object,
    process, token, version,
};
use crate::policy::{AccessLevel, NetworkAccess};

/// Probe this machine.
pub fn probe() -> CapabilityReport {
    let mut notes = vec![
        "AppContainer and restricted-token probes create a suspended process and terminate it \
         without resuming it; the AppContainer probe also creates and deletes a temporary profile."
            .to_owned(),
        "States describe this machine and this build; they are not inferred from the Windows version."
            .to_owned(),
    ];

    let version = match version::windows_version() {
        Ok(version) => version,
        Err(error) => {
            notes.push(format!("Windows version could not be read: {error}"));
            WindowsVersion {
                major: 0,
                minor: 0,
                build: 0,
            }
        }
    };

    let (elevated, integrity_level) = current_token_facts(&mut notes);

    let (app_container, app_container_acl) = probe_app_container(&mut notes);
    let restricted_token = probe_restricted_token();
    let process_mitigation = probe_process_mitigation();

    CapabilityReport {
        platform: PlatformInfo {
            os: "windows".to_owned(),
            version,
            architecture: version::architecture(),
            elevated,
            integrity_level,
        },
        job_object: job_object::probe(),
        app_container,
        app_container_acl,
        restricted_token,
        process_mitigation,
        etw: Capability::not_verified(
            "ETW-based observation is not implemented in this build".to_owned(),
        ),
        notes,
    }
}

fn current_token_facts(notes: &mut Vec<String>) -> (bool, IntegrityLevel) {
    let token = match token::open_current() {
        Ok(token) => token,
        Err(error) => {
            notes.push(format!(
                "current process token could not be opened: {error}"
            ));
            return (false, IntegrityLevel::Unknown);
        }
    };
    use std::os::windows::io::AsRawHandle;
    let handle = token.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;

    let elevated = match token::is_elevated(handle) {
        Ok(value) => value,
        Err(error) => {
            notes.push(format!("token elevation could not be read: {error}"));
            false
        }
    };
    let integrity = match token::integrity_level(handle) {
        Ok(value) => value,
        Err(error) => {
            notes.push(format!("token integrity level could not be read: {error}"));
            IntegrityLevel::Unknown
        }
    };
    (elevated, integrity)
}

fn probe_app_container(notes: &mut Vec<String>) -> (Capability, Capability) {
    let profile = match AppContainerProfile::create_probe() {
        Ok(profile) => profile,
        Err(error) => {
            let capability = classify(&error, "AppContainer profile creation");
            return (capability.clone(), capability);
        }
    };

    let acl_capability = probe_acl(&profile, notes);
    let launch_capability = probe_app_launch(&profile, notes);

    if let Err(error) = profile.delete() {
        notes.push(format!(
            "temporary AppContainer profile cleanup failed: {error}"
        ));
    }

    (launch_capability, acl_capability)
}

fn probe_acl(profile: &AppContainerProfile, notes: &mut Vec<String>) -> Capability {
    let directory = probe_directory("acl");
    let result = (|| -> Result<(), RuntimeError> {
        std::fs::create_dir_all(&directory)
            .map_err(|error| io_error("create probe directory", &error))?;
        acl::grant(&directory, profile.sid(), AccessLevel::ReadWrite)?;
        if !acl::verify(&directory, profile.sid(), AccessLevel::ReadWrite)? {
            return Err(RuntimeError::Internal(
                "AppContainer ACE was not present after the grant".into(),
            ));
        }
        Ok(())
    })();

    if let Err(error) = std::fs::remove_dir_all(&directory) {
        notes.push(format!(
            "probe directory {} could not be removed: {error}",
            directory.display()
        ));
    }

    match result {
        Ok(()) => Capability::supported(
            "granted and read back a directory ACE for a temporary AppContainer SID",
        ),
        Err(error) => classify(&error, "AppContainer directory ACL"),
    }
}

fn probe_app_launch(profile: &AppContainerProfile, notes: &mut Vec<String>) -> Capability {
    let executable = match ProbeExecutable::prepare(profile) {
        Ok(executable) => executable,
        Err(error) => {
            return classify(&error, "AppContainer probe executable preparation");
        }
    };

    let capabilities =
        match crate::platform::windows::app_container::network_capabilities(NetworkAccess::Deny) {
            Ok(capabilities) => capabilities,
            Err(error) => return classify(&error, "AppContainer capability SID"),
        };
    let security = match SecurityCapabilities::new(profile.sid(), capabilities) {
        Ok(security) => security,
        Err(error) => return classify(&error, "AppContainer security capabilities"),
    };

    match process::probe_suspended_process(executable.path(), Some((profile, &security)), None) {
        Ok(()) => Capability::supported(
            "created a suspended AppContainer process with security capabilities and terminated it",
        ),
        Err(error) => {
            notes.push(format!(
                "AppContainer launch probe executable: {}",
                executable.path().display()
            ));
            classify(&error, "AppContainer process creation")
        }
    }
}

fn probe_restricted_token() -> Capability {
    let token = match token::create_restricted_low_token() {
        Ok(token) => token,
        Err(error) => return classify(&error, "restricted token creation"),
    };

    let executable =
        std::env::current_exe().map_err(|error| io_error("resolve current executable", &error));
    let executable = match executable {
        Ok(path) => path,
        Err(error) => return classify(&error, "restricted token probe executable"),
    };

    use std::os::windows::io::AsRawHandle;
    let handle = token.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;

    match process::probe_suspended_process(&executable, None, Some(handle)) {
        Ok(()) => Capability::supported(
            "created a low-integrity restricted token and a suspended process with it",
        ),
        Err(error) => classify(&error, "restricted token process creation"),
    }
}

fn probe_process_mitigation() -> Capability {
    let mut policy = PROCESS_MITIGATION_CHILD_PROCESS_POLICY::default();
    // SAFETY: the structure matches ProcessChildProcessPolicy and is writable.
    let ok = unsafe {
        GetProcessMitigationPolicy(
            GetCurrentProcess(),
            ProcessChildProcessPolicy,
            (&mut policy as *mut PROCESS_MITIGATION_CHILD_PROCESS_POLICY).cast(),
            std::mem::size_of::<PROCESS_MITIGATION_CHILD_PROCESS_POLICY>(),
        )
    };

    if ok != 0 {
        Capability::supported(
            "GetProcessMitigationPolicy is available; this build does not apply additional mitigations",
        )
    } else {
        let error = RuntimeError::last_platform_error("GetProcessMitigationPolicy");
        classify(&error, "process mitigation query")
    }
}

fn classify(error: &RuntimeError, operation: &str) -> Capability {
    match error {
        RuntimeError::PlatformFailure { code, message, .. } => match *code {
            5 | 740 | 1314 => Capability::unavailable(format!(
                "{operation} was denied by the current security context (Win32 {code}): {message}"
            )),
            50 | 120 => Capability::unsupported(format!(
                "{operation} is not provided by this Windows installation (Win32 {code}): {message}"
            )),
            _ => Capability::unavailable(format!("{operation} failed (Win32 {code}): {message}")),
        },
        RuntimeError::CapabilityUnavailable(message) => {
            Capability::unavailable(format!("{operation}: {message}"))
        }
        RuntimeError::Unsupported(message) => {
            Capability::unsupported(format!("{operation}: {message}"))
        }
        RuntimeError::InvalidRequest(message) | RuntimeError::PolicyViolation(message) => {
            Capability::unavailable(format!("{operation}: {message}"))
        }
        RuntimeError::Internal(message) => {
            Capability::unavailable(format!("{operation}: {message}"))
        }
    }
}

fn io_error(operation: &str, error: &std::io::Error) -> RuntimeError {
    RuntimeError::PlatformFailure {
        operation: operation.to_owned(),
        code: error.raw_os_error().unwrap_or(0) as u32,
        message: error.to_string(),
    }
}

fn probe_directory(label: &str) -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "virealm-probe-{label}-{}-{unique}",
        std::process::id()
    ))
}

/// An executable the AppContainer can read.
///
/// `whoami.exe` is used when present because System32 is readable by App
/// Containers. Otherwise the current executable is copied into a temporary
/// directory that is granted only to the probe profile.
struct ProbeExecutable {
    path: PathBuf,
    cleanup: Option<PathBuf>,
}

impl ProbeExecutable {
    fn prepare(profile: &AppContainerProfile) -> Result<Self, RuntimeError> {
        if let Some(path) = system_probe_executable() {
            return Ok(Self {
                path,
                cleanup: None,
            });
        }

        let directory = probe_directory("exe");
        std::fs::create_dir_all(&directory)
            .map_err(|error| io_error("create probe executable directory", &error))?;
        let path = directory.join("virealm-probe.exe");
        let current = std::env::current_exe()
            .map_err(|error| io_error("resolve current executable", &error))?;
        if let Err(error) = std::fs::copy(&current, &path) {
            let _ = std::fs::remove_dir_all(&directory);
            return Err(io_error("copy probe executable", &error));
        }
        if let Err(error) = acl::grant(&directory, profile.sid(), AccessLevel::ReadOnly) {
            let _ = std::fs::remove_dir_all(&directory);
            return Err(error);
        }

        Ok(Self {
            path,
            cleanup: Some(directory),
        })
    }

    fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl Drop for ProbeExecutable {
    fn drop(&mut self) {
        if let Some(directory) = self.cleanup.take() {
            let _ = std::fs::remove_dir_all(directory);
        }
    }
}

fn system_probe_executable() -> Option<PathBuf> {
    let system_root = std::env::var_os("SystemRoot")?;
    let path = PathBuf::from(system_root)
        .join("System32")
        .join("whoami.exe");
    path.is_file().then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn denial_is_reported_as_unavailable() {
        let error = RuntimeError::platform_error("probe", 5);
        assert_eq!(
            classify(&error, "probe").state,
            crate::capabilities::CapabilityState::Unavailable
        );
    }

    #[test]
    fn missing_api_is_reported_as_unsupported() {
        let error = RuntimeError::platform_error("probe", 120);
        assert_eq!(
            classify(&error, "probe").state,
            crate::capabilities::CapabilityState::Unsupported
        );
    }

    #[test]
    fn probe_result_is_serializable() {
        let report = probe();
        let json = serde_json::to_value(report).expect("serialize capability report");
        assert_eq!(json["platform"]["os"], "windows");
    }
}
