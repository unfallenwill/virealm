//! macOS integration tests.
//!
//! Every test here creates a real process. Managed isolation is a POSIX process
//! group; the tests verify the group is created, reported, and killed on
//! `terminate` and on drop.

#![cfg(target_os = "macos")]

mod common;

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use common::{
    TestDir, argument, install_child, process_is_running, spec, wait_for_report, wait_until,
};
use virealm_process_runtime::{
    AccessLevel, ContainmentLimits, FileAccessPolicy, IsolationMode, NetworkAccess, ProcessState,
    RuntimeError, launch, validate_launch_spec,
};

fn launch_spec(
    directory: &TestDir,
    isolation: IsolationMode,
) -> (PathBuf, virealm_process_runtime::LaunchSpec) {
    let program = directory.create_dir("program");
    let data = directory.create_dir("data");
    let executable = install_child(&program);
    let spec = spec("macos-test-env", &executable, &data, &program, isolation);
    (executable, spec)
}

#[test]
fn managed_launch_reports_process_group_evidence() {
    let directory = TestDir::new("macos-managed");
    let data = directory.create_dir("data");
    let report = directory.join("report.json");
    let (executable, mut launch_spec) = launch_spec(&directory, IsolationMode::Managed);
    let _ = executable;

    launch_spec.arguments = vec![
        argument("--report"),
        argument(report.clone().into_os_string()),
        argument("--env"),
        argument("VIREALM_TEST_VARIABLE"),
        argument("--exit-code"),
        argument("5"),
    ];
    launch_spec.working_directory = Some(data.clone());
    launch_spec
        .environment_overrides
        .insert("VIREALM_TEST_VARIABLE".into(), "macos".into());

    let mut process = launch(&launch_spec).expect("launch");
    let applied = process.applied_isolation();
    assert_eq!(applied.mode, IsolationMode::Managed);
    assert_eq!(applied.process_group_attached, Some(true));
    assert_eq!(applied.process_group_id, Some(process.id().pid));
    assert_eq!(applied.kill_on_close_armed, Some(true));
    assert!(!applied.job_object_attached);

    let status = process.wait(Duration::from_secs(20)).expect("wait");
    assert_eq!(status.state, ProcessState::Exited { exit_code: 5 });

    let value = wait_for_report(&report);
    assert_eq!(value["environment"]["VIREALM_TEST_VARIABLE"], "macos");
    assert_eq!(
        value["workingDirectory"]
            .as_str()
            .expect("working directory"),
        data.display().to_string()
    );
    let arguments: Vec<&str> = value["arguments"]
        .as_array()
        .expect("arguments")
        .iter()
        .filter_map(|value| value.as_str())
        .collect();
    assert!(arguments.contains(&"--exit-code"));
}

#[test]
fn terminate_kills_the_whole_process_group() {
    let directory = TestDir::new("macos-terminate");
    let report = directory.join("report.json");
    let (_executable, mut launch_spec) = launch_spec(&directory, IsolationMode::Managed);
    launch_spec.arguments = vec![
        argument("--report"),
        argument(report.clone().into_os_string()),
        argument("--spawn-child"),
        argument("--sleep-ms"),
        argument("60000"),
    ];

    let mut process = launch(&launch_spec).expect("launch");
    let value = wait_for_report(&report);
    let grandchild = value["childPid"].as_u64().expect("grandchild pid") as u32;
    assert!(process_is_running(grandchild));

    let status = process.terminate().expect("terminate");
    assert!(matches!(status.state, ProcessState::Exited { .. }));
    assert!(
        wait_until(Duration::from_secs(10), || !process_is_running(grandchild)),
        "the grandchild must not outlive terminate"
    );
}

#[test]
fn dropping_the_managed_process_kills_the_group() {
    let directory = TestDir::new("macos-drop");
    let (_executable, mut launch_spec) = launch_spec(&directory, IsolationMode::Managed);
    launch_spec.arguments = vec![argument("--sleep-ms"), argument("60000")];

    let process = launch(&launch_spec).expect("launch");
    let pid = process.id().pid;
    assert!(process_is_running(pid));

    drop(process);
    assert!(
        wait_until(Duration::from_secs(10), || !process_is_running(pid)),
        "dropping the handle must kill the process group"
    );
}

#[test]
fn windows_only_isolation_modes_are_refused() {
    let directory = TestDir::new("macos-modes");
    let (_executable, mut launch_spec) = launch_spec(&directory, IsolationMode::Restricted);
    assert!(matches!(
        validate_launch_spec(&launch_spec),
        Err(RuntimeError::CapabilityUnavailable(_))
    ));

    launch_spec.policy.isolation = IsolationMode::AppContainer;
    launch_spec.policy.file_access = FileAccessPolicy::Restricted {
        data_directory: AccessLevel::ReadWrite,
        additional_roots: Vec::new(),
    };
    assert!(matches!(
        validate_launch_spec(&launch_spec),
        Err(RuntimeError::CapabilityUnavailable(_))
    ));
}

#[test]
fn containment_limits_are_refused() {
    let directory = TestDir::new("macos-limits");
    let (_executable, mut launch_spec) = launch_spec(&directory, IsolationMode::Managed);

    launch_spec.policy.containment = ContainmentLimits {
        kill_on_close: true,
        max_processes: Some(8),
        memory_limit_bytes: None,
    };
    assert!(matches!(
        validate_launch_spec(&launch_spec),
        Err(RuntimeError::CapabilityUnavailable(_))
    ));

    launch_spec.policy.containment = ContainmentLimits {
        kill_on_close: true,
        max_processes: None,
        memory_limit_bytes: Some(64 * 1024 * 1024),
    };
    assert!(matches!(
        validate_launch_spec(&launch_spec),
        Err(RuntimeError::CapabilityUnavailable(_))
    ));
}

#[test]
fn executable_outside_the_program_roots_is_refused() {
    let directory = TestDir::new("macos-path");
    let (_executable, mut launch_spec) = launch_spec(&directory, IsolationMode::Managed);
    launch_spec.policy.allowed_program_roots = vec![directory.create_dir("elsewhere")];
    assert!(matches!(
        validate_launch_spec(&launch_spec),
        Err(RuntimeError::PolicyViolation(_))
    ));
    assert_eq!(launch_spec.policy.network_access, NetworkAccess::Allow);
}

fn runtime_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_virealm-runtime"))
}

fn send_request(address: &str, request: &str) -> String {
    let mut stream = UnixStream::connect(address).expect("connect to runtime");
    stream
        .write_all(format!("{request}\n").as_bytes())
        .expect("write request");
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).expect("read response");
    line
}

#[test]
fn unix_socket_server_serves_capabilities() {
    let directory = TestDir::new("macos-socket");
    let address = directory.join("runtime.sock");
    let address_string = address.display().to_string();

    let mut server = Command::new(runtime_binary())
        .args(["serve", "--pipe", &address_string])
        .stderr(Stdio::null())
        .spawn()
        .expect("start runtime server");

    let ready = wait_until(Duration::from_secs(20), || address.exists());
    if !ready {
        let _ = server.kill();
        panic!("runtime did not create the socket");
    }

    let mode = std::fs::metadata(&address)
        .expect("socket metadata")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(
        mode, 0o600,
        "the socket must only be accessible to its owner"
    );

    let response = send_request(
        &address_string,
        r#"{"protocolVersion":2,"requestId":"req_macos_caps","method":"runtime.getCapabilities"}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("json response");
    assert_eq!(value["ok"], true);
    assert_eq!(value["result"]["platform"]["os"], "macos");
    assert_eq!(value["result"]["processGroup"]["state"], "supported");
    assert_eq!(value["result"]["jobObject"]["state"], "unsupported");

    let second = Command::new(runtime_binary())
        .args(["serve", "--pipe", &address_string])
        .stderr(Stdio::null())
        .status()
        .expect("second server must run and exit");
    assert!(!second.success(), "a second server must be refused");

    let _ = server.kill();
    let _ = server.wait();
}

#[test]
fn overlong_socket_paths_are_rejected() {
    let long = format!("/tmp/{}.sock", "a".repeat(120));
    let status = Command::new(runtime_binary())
        .args(["serve", "--pipe", &long])
        .stderr(Stdio::null())
        .status()
        .expect("runtime must run");
    assert!(!status.success());
}
