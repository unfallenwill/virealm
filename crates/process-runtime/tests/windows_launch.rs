//! Windows integration tests.
//!
//! Every test here creates a real process. The test child is the compiled
//! `virealm-test-child` binary; it never receives a shell command string.

#![cfg(windows)]

mod common;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use common::{
    TestDir, argument, install_child, json_string_array, process_is_running, spec, wait_for_report,
    wait_until,
};
use virealm_process_runtime::{
    AccessLevel, ContainmentLimits, FileAccessPolicy, IsolationMode, NetworkAccess, ProcessState,
    RuntimeError,
};

const WAIT: Duration = Duration::from_secs(30);

fn managed_spec(
    directory: &TestDir,
) -> (
    PathBuf,
    PathBuf,
    PathBuf,
    virealm_process_runtime::LaunchSpec,
) {
    let executable = install_child(&directory.join("program files"));
    let program_root = executable
        .parent()
        .expect("program directory")
        .to_path_buf();
    let data = directory.create_dir("data");
    let spec = spec(
        "it-managed",
        &executable,
        &data,
        &program_root,
        IsolationMode::Managed,
    );
    (executable, program_root, data, spec)
}

#[test]
fn managed_launch_passes_arguments_environment_and_working_directory() {
    let directory = TestDir::new("managed");
    let (_executable, _program_root, _data, mut launch_spec) = managed_spec(&directory);

    let working_directory = directory.create_dir("working dir");
    let report_path = directory.create_dir("report dir").join("report.json");

    launch_spec.arguments = vec![
        argument("--report"),
        argument(report_path.as_os_str()),
        argument("--env"),
        argument("VIREALM_TEST_VALUE"),
        argument("--exit-code"),
        argument("7"),
    ];
    launch_spec.working_directory = Some(working_directory.clone());
    launch_spec.environment_overrides.insert(
        OsString::from("VIREALM_TEST_VALUE"),
        OsString::from("hello world"),
    );

    let mut process = virealm_process_runtime::launch(&launch_spec).expect("managed launch");

    let applied = process.applied_isolation();
    assert_eq!(applied.mode, IsolationMode::Managed);
    assert!(applied.job_object_attached);
    assert!(!applied.app_container_token);
    assert!(!applied.restricted_token);
    assert!(!applied.file_access_restricted);
    assert!(!process.diagnostics().is_empty());

    let status = process.wait(WAIT).expect("wait for exit");
    assert_eq!(status.exit_code(), Some(7));
    assert_eq!(status.id, process.id());
    assert_ne!(status.id.creation_time_100ns, 0);

    let report = wait_for_report(&report_path);
    assert_eq!(report["pid"].as_u64(), Some(u64::from(process.id().pid)));
    assert_eq!(report["environment"]["VIREALM_TEST_VALUE"], "hello world");
    let arguments = json_string_array(&report, "arguments");
    assert!(arguments.iter().any(|value| value == "--exit-code"));
    assert_eq!(arguments.last().map(String::as_str), Some("7"));

    let reported_directory = PathBuf::from(
        report["workingDirectory"]
            .as_str()
            .expect("working directory"),
    );
    assert_eq!(
        std::fs::canonicalize(reported_directory).expect("canonical report cwd"),
        working_directory
    );
}

#[test]
fn missing_executable_fails_before_process_creation() {
    let directory = TestDir::new("missing");
    let (_executable, program_root, data, mut launch_spec) = managed_spec(&directory);
    launch_spec.executable = directory.join("not-here.exe");
    launch_spec.policy.allowed_program_roots = vec![program_root];

    let error = virealm_process_runtime::launch(&launch_spec).expect_err("must fail");
    assert!(matches!(error, RuntimeError::InvalidRequest(_)));
    let _ = data;
}

#[test]
fn terminate_kills_the_whole_tree_and_is_idempotent() {
    let directory = TestDir::new("tree");
    let (_executable, _program_root, _data, mut launch_spec) = managed_spec(&directory);
    let report_path = directory.create_dir("reports").join("tree.json");

    launch_spec.arguments = vec![
        argument("--report"),
        argument(report_path.as_os_str()),
        argument("--spawn-child"),
        argument("--sleep-ms"),
        argument("60000"),
    ];

    let mut process = virealm_process_runtime::launch(&launch_spec).expect("launch");
    let main_pid = process.id().pid;

    let report = wait_for_report(&report_path);
    let child_pid = report["childPid"].as_u64().expect("child process id") as u32;
    assert!(process_is_running(main_pid));
    assert!(process_is_running(child_pid));

    let first = process.terminate().expect("first terminate");
    assert!(matches!(first.state, ProcessState::Exited { .. }));

    assert!(
        wait_until(Duration::from_secs(10), || !process_is_running(main_pid)),
        "main process {main_pid} survived termination"
    );
    assert!(
        wait_until(Duration::from_secs(10), || !process_is_running(child_pid)),
        "child process {child_pid} survived job termination"
    );

    let second = process.terminate().expect("second terminate is a no-op");
    assert_eq!(second.state, first.state);
}

#[test]
fn active_process_limit_is_enforced_by_the_job() {
    let directory = TestDir::new("max-processes");
    let (_executable, _program_root, _data, mut launch_spec) = managed_spec(&directory);
    let report_path = directory.create_dir("reports").join("limit.json");

    launch_spec.policy.containment = ContainmentLimits {
        max_processes: Some(1),
        ..ContainmentLimits::default()
    };
    launch_spec.arguments = vec![
        argument("--report"),
        argument(report_path.as_os_str()),
        argument("--spawn-child"),
    ];

    let mut process = virealm_process_runtime::launch(&launch_spec).expect("launch");
    let status = process.wait(WAIT).expect("wait");
    assert_eq!(status.exit_code(), Some(0));

    let report = wait_for_report(&report_path);
    assert!(report["childPid"].is_null(), "no child may be created");
    assert!(
        report["childErrorCode"].as_i64().is_some(),
        "child creation must fail with a Windows error: {report}"
    );
}

#[test]
fn process_memory_limit_is_enforced_by_the_job() {
    let directory = TestDir::new("memory-limit");
    let (_executable, _program_root, _data, mut launch_spec) = managed_spec(&directory);
    let report_path = directory.create_dir("reports").join("memory.json");

    launch_spec.policy.containment = ContainmentLimits {
        memory_limit_bytes: Some(64 * 1024 * 1024),
        ..ContainmentLimits::default()
    };
    launch_spec.arguments = vec![
        argument("--report"),
        argument(report_path.as_os_str()),
        argument("--allocate-bytes"),
        argument("268435456"),
    ];

    let mut process = virealm_process_runtime::launch(&launch_spec).expect("launch");
    let status = process.wait(WAIT).expect("wait");
    assert_eq!(status.exit_code(), Some(0));

    let report = wait_for_report(&report_path);
    assert_eq!(
        report["allocate"]["ok"],
        serde_json::Value::Bool(false),
        "256 MiB must not be committed under a 64 MiB process limit: {report}"
    );
    assert!(report["allocate"]["errorCode"].as_i64().is_some());
}

#[test]
fn restricted_mode_applies_a_restricted_low_integrity_token() {
    let directory = TestDir::new("restricted");
    let executable = install_child(&directory.join("program"));
    let program_root = executable.parent().expect("program root").to_path_buf();
    let data = directory.create_dir("data");

    let mut launch_spec = spec(
        "it-restricted",
        &executable,
        &data,
        &program_root,
        IsolationMode::Restricted,
    );
    launch_spec.arguments = vec![argument("--exit-code"), argument("3")];

    let mut process = virealm_process_runtime::launch(&launch_spec).expect("restricted launch");
    let applied = process.applied_isolation();
    assert!(applied.restricted_token);
    assert!(applied.low_integrity);
    assert!(!applied.app_container_token);
    assert!(!applied.file_access_restricted);

    let status = process.wait(WAIT).expect("wait");
    assert_eq!(status.exit_code(), Some(3));
}

#[test]
fn app_container_enforces_file_and_network_policy() {
    let directory = TestDir::new("appcontainer");
    let data = directory.create_dir("environment data");
    let program_directory = data.join("bin");
    let executable = install_child(&program_directory);
    let program_root = std::fs::canonicalize(&program_directory).expect("program root");

    let allowed = data.join("allowed.txt");
    std::fs::write(&allowed, b"inside").expect("write allowed file");
    let writable = data.join("written.txt");

    let outside = directory.create_dir("outside");
    let denied_read = outside.join("secret.txt");
    std::fs::write(&denied_read, b"outside").expect("write secret file");
    let denied_write = outside.join("created.txt");

    let report_path = data.join("report.json");
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind listener");
    let address = listener.local_addr().expect("listener address");

    let mut launch_spec = spec(
        "it-appcontainer",
        &executable,
        &data,
        &program_root,
        IsolationMode::AppContainer,
    );
    launch_spec.policy.network_access = NetworkAccess::Deny;
    launch_spec.policy.file_access = FileAccessPolicy::Restricted {
        data_directory: AccessLevel::ReadWrite,
        additional_roots: Vec::new(),
    };
    launch_spec.arguments = vec![
        argument("--report"),
        argument(report_path.as_os_str()),
        argument("--read-file"),
        argument(allowed.as_os_str()),
        argument("--read-file"),
        argument(denied_read.as_os_str()),
        argument("--write-file"),
        argument(writable.as_os_str()),
        argument("--write-file"),
        argument(denied_write.as_os_str()),
        argument("--connect"),
        argument(address.to_string()),
    ];

    let mut process = virealm_process_runtime::launch(&launch_spec).expect("AppContainer launch");
    let applied = process.applied_isolation();
    assert!(applied.app_container_token);
    assert!(applied.low_integrity);
    assert!(applied.file_access_restricted);
    assert!(applied.network_capabilities_verified);
    assert_eq!(applied.network_access, NetworkAccess::Deny);

    let status = process.wait(WAIT).expect("wait");
    assert_eq!(
        status.exit_code(),
        Some(0),
        "child should complete its report"
    );

    let report = wait_for_report(&report_path);
    let reads = report["reads"].as_array().expect("reads array");
    assert_eq!(reads.len(), 2);
    assert_eq!(reads[0]["ok"], true, "data directory must be readable");
    assert_eq!(reads[1]["ok"], false, "outside file must be denied");
    assert_eq!(
        reads[1]["errorCode"].as_i64(),
        Some(5),
        "denied read should report ERROR_ACCESS_DENIED: {report}"
    );

    let writes = report["writes"].as_array().expect("writes array");
    assert_eq!(writes.len(), 2);
    assert_eq!(writes[0]["ok"], true, "data directory must be writable");
    assert_eq!(writes[1]["ok"], false, "outside write must be denied");

    assert_eq!(
        report["connect"]["ok"], false,
        "network deny must block the connection: {report}"
    );

    drop(listener);
}

#[test]
fn app_container_network_allow_grants_network_capabilities() {
    let directory = TestDir::new("appcontainer-network");
    let data = directory.create_dir("environment data");
    let executable = install_child(&data.join("bin"));
    let program_root = executable.parent().expect("program root").to_path_buf();

    let mut launch_spec = spec(
        "it-appcontainer-network",
        &executable,
        &data,
        &program_root,
        IsolationMode::AppContainer,
    );
    launch_spec.policy.network_access = NetworkAccess::Allow;
    launch_spec.policy.file_access = FileAccessPolicy::Restricted {
        data_directory: AccessLevel::ReadWrite,
        additional_roots: Vec::new(),
    };
    launch_spec.arguments = vec![argument("--exit-code"), argument("0")];

    let mut process = virealm_process_runtime::launch(&launch_spec).expect("AppContainer launch");
    let applied = process.applied_isolation();
    assert!(applied.app_container_token);
    assert!(applied.network_capabilities_verified);
    assert_eq!(applied.network_access, NetworkAccess::Allow);

    let status = process.wait(WAIT).expect("wait");
    assert_eq!(status.exit_code(), Some(0));
}

#[test]
fn status_survives_a_sleeping_process_and_reports_exit_code() {
    let directory = TestDir::new("status");
    let (_executable, _program_root, _data, mut launch_spec) = managed_spec(&directory);
    launch_spec.arguments = vec![argument("--sleep-ms"), argument("1500")];

    let mut process = virealm_process_runtime::launch(&launch_spec).expect("launch");
    let first = process.status().expect("status");
    assert!(first.is_running());
    assert_eq!(first.id, process.id());

    let polled = process.wait(Duration::ZERO).expect("non-blocking wait");
    assert!(polled.is_running());

    let exited = process.wait(WAIT).expect("wait");
    assert_eq!(exited.exit_code(), Some(0));
    assert_eq!(exited.id, first.id);
}

/// Chrome compatibility check. Ignored by default because it needs a local
/// Chrome installation; run with `cargo test -- --ignored`.
#[test]
#[ignore = "requires a local Chrome installation"]
fn chrome_launches_in_managed_mode() {
    let Some(chrome) = find_chrome() else {
        panic!("Chrome was not found in the standard installation paths");
    };

    let directory = TestDir::new("chrome");
    let data = directory.create_dir("environment data");
    let profile = data.join("profile");
    std::fs::create_dir_all(&profile).expect("profile directory");
    let program_root = chrome.parent().expect("Chrome directory").to_path_buf();

    let mut launch_spec = spec(
        "it-chrome",
        &chrome,
        &data,
        &program_root,
        IsolationMode::Managed,
    );
    launch_spec.arguments = vec![
        argument("--headless=new"),
        argument("--disable-gpu"),
        argument("--no-first-run"),
        argument("--no-default-browser-check"),
        argument(format!("--user-data-dir={}", profile.display())),
        argument("--dump-dom"),
        argument("about:blank"),
    ];

    let mut process = virealm_process_runtime::launch(&launch_spec).expect("Chrome launch");
    let status = process.wait(Duration::from_secs(60)).expect("Chrome exit");
    process.terminate().expect("cleanup");
    assert_eq!(
        status.exit_code(),
        Some(0),
        "Chrome headless must exit cleanly; diagnostics: {:?}",
        process.diagnostics()
    );
}

fn find_chrome() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for variable in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(root) = std::env::var_os(variable) {
            candidates.push(
                Path::new(&root)
                    .join("Google")
                    .join("Chrome")
                    .join("Application")
                    .join("chrome.exe"),
            );
        }
    }
    candidates.into_iter().find(|path| path.is_file())
}
