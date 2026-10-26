//! Shared helpers for process-runtime integration tests.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use virealm_process_runtime::{
    ContainmentLimits, FileAccessPolicy, IsolationMode, LaunchSpec, NetworkAccess, SecurityPolicy,
};

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// Temporary directory removed when the test finishes.
pub struct TestDir {
    path: PathBuf,
}

impl TestDir {
    pub fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "virealm-it-{}-{}-{label}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).expect("create test directory");
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn join(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }

    pub fn create_dir(&self, name: &str) -> PathBuf {
        let path = self.join(name);
        std::fs::create_dir_all(&path).expect("create test subdirectory");
        std::fs::canonicalize(path).expect("canonicalize test subdirectory")
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        // Best effort: a failed test can leave AppContainer-owned files behind.
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Path of the test child built for this package.
pub fn child_executable() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_virealm-test-child"))
}

/// File name of the test child on this platform.
pub fn child_file_name() -> &'static str {
    if cfg!(windows) {
        "virealm-test-child.exe"
    } else {
        "virealm-test-child"
    }
}

/// Copy the test child into `directory` and return the copied path.
pub fn install_child(directory: &Path) -> PathBuf {
    std::fs::create_dir_all(directory).expect("create program directory");
    let target = directory.join(child_file_name());
    std::fs::copy(child_executable(), &target).expect("copy test child");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755))
            .expect("make test child executable");
    }
    std::fs::canonicalize(target).expect("canonicalize test child")
}

/// Build a launch request with the given isolation mode.
pub fn spec(
    environment_id: &str,
    executable: &Path,
    data_directory: &Path,
    program_root: &Path,
    isolation: IsolationMode,
) -> LaunchSpec {
    let file_access = match isolation {
        IsolationMode::AppContainer => FileAccessPolicy::Restricted {
            data_directory: virealm_process_runtime::AccessLevel::ReadWrite,
            additional_roots: Vec::new(),
        },
        IsolationMode::Managed | IsolationMode::Restricted => FileAccessPolicy::Inherited,
    };

    LaunchSpec {
        environment_id: environment_id.to_owned(),
        executable: executable.to_path_buf(),
        arguments: Vec::new(),
        working_directory: None,
        environment_overrides: BTreeMap::new(),
        data_directory: data_directory.to_path_buf(),
        policy: SecurityPolicy {
            isolation,
            allowed_program_roots: vec![program_root.to_path_buf()],
            file_access,
            network_access: NetworkAccess::Allow,
            containment: ContainmentLimits::default(),
        },
    }
}

pub fn argument(value: impl Into<OsString>) -> OsString {
    value.into()
}

/// Wait until the child's JSON report is complete and parse it.
pub fn wait_for_report(path: &Path) -> serde_json::Value {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(bytes) = std::fs::read(path)
            && let Ok(value) = serde_json::from_slice(&bytes)
        {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "report was not written: {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Poll `condition` until it holds or the timeout elapses.
pub fn wait_until(timeout: Duration, mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if condition() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Whether a process with this PID is still running.
///
/// On Windows this uses `PROCESS_QUERY_LIMITED_INFORMATION`, which is enough to
/// read the exit code and works across integrity levels for the same user.
#[cfg(windows)]
pub fn process_is_running(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // SAFETY: the PID is caller-provided; a failed open returns null and is
    // handled below.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return false;
    }

    let mut exit_code = 0u32;
    // SAFETY: the handle was returned by OpenProcess and `exit_code` is writable.
    let ok = unsafe { GetExitCodeProcess(handle, &mut exit_code) };
    // SAFETY: the handle is owned by this function.
    unsafe { CloseHandle(handle) };

    ok != 0 && exit_code == 259 // STILL_ACTIVE
}

/// Whether a process with this PID is still running.
///
/// Asks `proc_pidinfo` rather than `kill(pid, 0)`: a zombie is not running, but
/// `kill(pid, 0)` still succeeds for one.
#[cfg(target_os = "macos")]
pub fn process_is_running(pid: u32) -> bool {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: `info` is correctly sized for PROC_PIDTBSDINFO.
    let written = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    written == size
}

pub fn json_string_array(value: &serde_json::Value, key: &str) -> Vec<String> {
    value[key]
        .as_array()
        .unwrap_or_else(|| panic!("{key} must be an array"))
        .iter()
        .map(|entry| entry.as_str().expect("array entry").to_owned())
        .collect()
}
