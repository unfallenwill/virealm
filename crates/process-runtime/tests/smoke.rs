//! Public-API tests that do not start a process.
//!
//! These cover request validation, policy rejection and the four-state
//! capability contract. Launch behaviour lives in `windows_launch.rs`.

mod common;

use std::ffi::OsString;

use common::{TestDir, spec};
use virealm_process_runtime::{
    CONTRACT_VERSION, CapabilityState, IsolationMode, LaunchSpec, NetworkAccess, PROTOCOL_VERSION,
    RuntimeError, probe_capabilities,
};

fn valid_spec() -> (TestDir, LaunchSpec) {
    let directory = TestDir::new("validation");
    let executable = std::env::current_exe().expect("current test executable");
    let root = executable
        .parent()
        .expect("executable parent")
        .to_path_buf();
    let data = directory.create_dir("data");
    let spec = spec(
        "validation-env",
        &executable,
        &data,
        &root,
        IsolationMode::Managed,
    );
    (directory, spec)
}

#[test]
fn wire_and_contract_versions_are_published() {
    assert_eq!(PROTOCOL_VERSION, 2);
    assert_eq!(CONTRACT_VERSION, "0.2.0");
}

#[test]
fn capability_probe_reports_only_verified_states() {
    let report = probe_capabilities();

    for capability in [
        &report.job_object,
        &report.app_container,
        &report.app_container_acl,
        &report.restricted_token,
        &report.process_mitigation,
        &report.etw,
    ] {
        assert!(matches!(
            capability.state,
            CapabilityState::Supported
                | CapabilityState::Unsupported
                | CapabilityState::Unavailable
                | CapabilityState::NotVerified
        ));
    }

    assert!(
        report.job_object.is_supported(),
        "Job Objects are required on Windows 10/11: {:?}",
        report.job_object
    );
    assert_eq!(report.platform.os, "windows");
    assert!(report.platform.version.major >= 10);

    let value = serde_json::to_value(&report).expect("report serializes");
    for key in [
        "jobObject",
        "appContainer",
        "appContainerAcl",
        "restrictedToken",
        "processMitigation",
        "etw",
    ] {
        assert!(value.get(key).is_some(), "missing {key}");
    }
    assert!(value.get("job_object").is_none());
}

#[test]
fn relative_executable_is_rejected() {
    let (_directory, mut spec) = valid_spec();
    spec.executable = OsString::from("chrome.exe").into();
    assert!(matches!(
        virealm_process_runtime::validate_launch_spec(&spec),
        Err(RuntimeError::InvalidRequest(_))
    ));
}

#[test]
fn missing_executable_is_rejected() {
    let (directory, mut spec) = valid_spec();
    spec.executable = directory.join("does-not-exist.exe");
    assert!(matches!(
        virealm_process_runtime::validate_launch_spec(&spec),
        Err(RuntimeError::InvalidRequest(_))
    ));
}

#[test]
fn executable_outside_the_allow_list_is_rejected() {
    let (directory, mut spec) = valid_spec();
    spec.policy.allowed_program_roots = vec![directory.create_dir("elsewhere")];
    assert!(matches!(
        virealm_process_runtime::validate_launch_spec(&spec),
        Err(RuntimeError::PolicyViolation(_))
    ));
}

#[test]
fn empty_program_allow_list_is_rejected() {
    let (_directory, mut spec) = valid_spec();
    spec.policy.allowed_program_roots.clear();
    assert!(matches!(
        virealm_process_runtime::validate_launch_spec(&spec),
        Err(RuntimeError::PolicyViolation(_))
    ));
}

#[test]
fn managed_mode_cannot_request_network_denial() {
    let (_directory, mut spec) = valid_spec();
    spec.policy.network_access = NetworkAccess::Deny;
    assert!(matches!(
        virealm_process_runtime::validate_launch_spec(&spec),
        Err(RuntimeError::PolicyViolation(_))
    ));
}

#[test]
fn restricted_mode_cannot_request_path_isolation() {
    let (_directory, mut spec) = valid_spec();
    spec.policy.isolation = IsolationMode::Restricted;
    spec.policy.file_access = virealm_process_runtime::FileAccessPolicy::Restricted {
        data_directory: virealm_process_runtime::AccessLevel::ReadOnly,
        additional_roots: Vec::new(),
    };
    assert!(matches!(
        virealm_process_runtime::validate_launch_spec(&spec),
        Err(RuntimeError::PolicyViolation(_))
    ));
}

#[test]
fn app_container_requires_an_explicit_file_policy() {
    let (_directory, mut spec) = valid_spec();
    spec.policy.isolation = IsolationMode::AppContainer;
    spec.policy.file_access = virealm_process_runtime::FileAccessPolicy::Inherited;
    assert!(matches!(
        virealm_process_runtime::validate_launch_spec(&spec),
        Err(RuntimeError::PolicyViolation(_))
    ));
}

#[test]
fn app_container_launch_never_degrades_silently() {
    // The child lives inside the data directory, which the launch grants to
    // the AppContainer, so success and refusal are both meaningful outcomes.
    let directory = TestDir::new("appcontainer-unavailable");
    let data = directory.create_dir("data");
    let executable = common::install_child(&data);
    let mut launch_spec = spec(
        "smoke-appcontainer",
        &executable,
        &data,
        &data,
        IsolationMode::AppContainer,
    );

    fn assert_no_downgrade(spec: &LaunchSpec, expected_network: NetworkAccess) {
        match virealm_process_runtime::launch(spec) {
            Ok(mut process) => {
                // If the host can run it, it must really be an AppContainer.
                let applied = process.applied_isolation();
                assert_eq!(applied.mode, IsolationMode::AppContainer);
                assert!(applied.app_container_token);
                assert!(applied.file_access_restricted);
                assert_eq!(applied.network_access, expected_network);
                assert!(applied.network_capabilities_verified);
                process.terminate().expect("terminate");
            }
            Err(RuntimeError::CapabilityUnavailable(_)) => {
                // Refusing is the required behaviour when the primitive is absent.
            }
            Err(error) => {
                panic!("AppContainer must not degrade to a weaker mode: {error:?}")
            }
        }
    }

    assert_no_downgrade(&launch_spec, NetworkAccess::Allow);

    // The same guarantee holds for an explicit network policy.
    launch_spec.policy.network_access = NetworkAccess::Deny;
    assert_no_downgrade(&launch_spec, NetworkAccess::Deny);
}

#[test]
fn duplicate_environment_names_are_rejected_case_insensitively() {
    let (_directory, mut spec) = valid_spec();
    spec.environment_overrides
        .insert(OsString::from("Path"), OsString::from("a"));
    spec.environment_overrides
        .insert(OsString::from("PATH"), OsString::from("b"));
    assert!(matches!(
        virealm_process_runtime::validate_launch_spec(&spec),
        Err(RuntimeError::InvalidRequest(_))
    ));
}

#[test]
fn nul_in_arguments_is_rejected() {
    let (_directory, mut spec) = valid_spec();
    spec.arguments.push(OsString::from("bad\0argument"));
    assert!(matches!(
        virealm_process_runtime::validate_launch_spec(&spec),
        Err(RuntimeError::InvalidRequest(_))
    ));
}
