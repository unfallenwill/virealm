//! macOS capability probing.
//!
//! macOS capabilities are exercised, not inferred from a version number. The
//! process-group and Unix socket probes create real kernel objects and tear
//! them down; the identity probe reads the current process.
//!
//! Windows-only primitives are reported as `unsupported` with an explanation.
//! There is no macOS equivalent of a Job Object, AppContainer or restricted
//! token, and the report says so instead of pretending otherwise.

use std::ffi::CString;
use std::os::unix::process::CommandExt;
use std::process::Command;

use crate::capabilities::{
    Capability, CapabilityReport, IntegrityLevel, PlatformInfo, PlatformVersion, ResourceLimits,
};
use crate::platform::macos::{identity, socket};

/// Probe this machine.
pub(crate) fn probe() -> CapabilityReport {
    let os_version = product_version();
    let version = os_version
        .as_deref()
        .map(parse_version)
        .unwrap_or(PlatformVersion {
            major: 0,
            minor: 0,
            build: 0,
        });

    let mut notes = vec![
        "macOS managed isolation is process-group lifecycle containment, not a sandbox.".to_owned(),
        "No file or network confinement is claimed on macOS.".to_owned(),
    ];
    if os_version.is_none() {
        notes.push("kern.osproductversion could not be read.".to_owned());
    }
    if let Err(error) = socket::selftest() {
        notes.push(format!(
            "Unix socket transport could not be exercised: {error}"
        ));
    }
    if let Err(error) = identity::process_id(std::process::id() as libc::pid_t) {
        notes.push(format!(
            "proc_pidinfo did not report process identity: {error}"
        ));
    }

    CapabilityReport {
        platform: PlatformInfo {
            os: "macos".to_owned(),
            version,
            os_version,
            architecture: architecture(),
            // macOS does not have Windows integrity levels; running as root is
            // the only elevation the runtime reports.
            elevated: unsafe { libc::geteuid() } == 0,
            integrity_level: IntegrityLevel::Unknown,
        },
        job_object: Capability::unsupported("Job Objects are a Windows primitive"),
        app_container: Capability::unsupported("AppContainer is a Windows primitive"),
        app_container_acl: Capability::unsupported("AppContainer is a Windows primitive"),
        restricted_token: Capability::unsupported("restricted tokens are a Windows primitive"),
        process_mitigation: Capability::unsupported(
            "process mitigation policies are a Windows primitive",
        ),
        etw: Capability::unsupported("ETW is a Windows facility"),
        process_group: Some(probe_process_group()),
        resource_limits: Some(ResourceLimits {
            max_processes: Capability::unavailable("macOS has no per-process-tree process limit"),
            memory_limit: Capability::unavailable("macOS has no per-process-tree memory limit"),
        }),
        notes,
    }
}

fn architecture() -> String {
    match std::env::consts::ARCH {
        "aarch64" => "arm64".to_owned(),
        other => other.to_owned(),
    }
}

fn product_version() -> Option<String> {
    let name = CString::new("kern.osproductversion").ok()?;
    let mut size: libc::size_t = 0;
    // SAFETY: a null buffer asks for the required size only.
    let probe = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if probe != 0 || size == 0 {
        return None;
    }

    let mut buffer = vec![0u8; size];
    // SAFETY: `buffer` is exactly `size` bytes, as requested above.
    let read = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            buffer.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if read != 0 {
        return None;
    }
    while buffer.last() == Some(&0) {
        buffer.pop();
    }
    String::from_utf8(buffer).ok()
}

fn parse_version(value: &str) -> PlatformVersion {
    let mut parts = value
        .split('.')
        .map(|part| part.parse::<u32>().unwrap_or(0));
    PlatformVersion {
        major: parts.next().unwrap_or(0),
        minor: parts.next().unwrap_or(0),
        build: parts.next().unwrap_or(0),
    }
}

fn probe_process_group() -> Capability {
    let mut command = Command::new("/bin/sh");
    command.arg("-c").arg("exit 0").process_group(0);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return Capability::unavailable(format!(
                "could not create a probe process group: {error}"
            ));
        }
    };

    let pid = child.id() as libc::pid_t;
    // SAFETY: `pid` is our live child.
    let group = unsafe { libc::getpgid(pid) };
    // SAFETY: the probe group is ours; ESRCH is harmless.
    unsafe {
        libc::killpg(pid, libc::SIGKILL);
    }
    let _ = child.wait();

    if group == pid {
        Capability::supported("created a child in its own process group and verified getpgid")
    } else {
        Capability::unavailable("getpgid did not report the child as its own group leader")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_parse_into_major_minor_patch() {
        assert_eq!(
            parse_version("27.0.1"),
            PlatformVersion {
                major: 27,
                minor: 0,
                build: 1
            }
        );
        assert_eq!(
            parse_version("14.5"),
            PlatformVersion {
                major: 14,
                minor: 5,
                build: 0
            }
        );
    }

    #[test]
    fn probes_are_exercised() {
        assert!(probe_process_group().is_supported());
        socket::selftest().expect("socket self test");
        identity::process_id(std::process::id() as libc::pid_t).expect("identity");
    }

    #[test]
    fn windows_primitives_are_reported_unsupported() {
        let report = probe();
        assert_eq!(
            report.job_object.state,
            crate::capabilities::CapabilityState::Unsupported
        );
        assert!(
            report
                .process_group
                .expect("process group probe")
                .is_supported()
        );
    }
}
