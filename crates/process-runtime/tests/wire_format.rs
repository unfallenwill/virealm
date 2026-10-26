//! Wire-format tests.
//!
//! The JSON shapes asserted here are the contract consumed by
//! `packages/contracts`. A change here is a protocol change and must bump
//! `PROTOCOL_VERSION` on both sides.

use serde_json::Value;
use virealm_process_runtime::{
    AppliedIsolation, Capability, CapabilityReport, CapabilityState, DiagnosticEvent,
    DiagnosticLevel, ErrorCode, ErrorInfo, IntegrityLevel, IsolationMode, NetworkAccess,
    PlatformInfo, ProcessId, ProcessState, ProcessStatus, RuntimeError, WindowsVersion,
};

#[test]
fn capability_report_uses_camel_case_fields_and_snake_case_states() {
    let report = CapabilityReport {
        platform: PlatformInfo {
            os: "windows".into(),
            version: WindowsVersion {
                major: 10,
                minor: 0,
                build: 26100,
            },
            os_version: None,
            architecture: "x86_64".into(),
            elevated: false,
            integrity_level: IntegrityLevel::Medium,
        },
        job_object: Capability::supported("verified"),
        app_container: Capability::unavailable("profile creation denied"),
        app_container_acl: Capability::not_verified("not exercised"),
        restricted_token: Capability::unsupported("missing"),
        process_mitigation: Capability::supported("queried"),
        etw: Capability::not_verified("not implemented"),
        process_group: None,
        resource_limits: None,
        notes: Vec::new(),
    };

    let value = serde_json::to_value(&report).expect("report must serialize");

    assert!(value.get("jobObject").is_some());
    assert!(value.get("appContainer").is_some());
    assert!(value.get("appContainerAcl").is_some());
    assert!(value.get("restrictedToken").is_some());
    assert!(value.get("processMitigation").is_some());
    assert!(value.get("job_object").is_none());

    assert_eq!(
        value["jobObject"]["state"],
        Value::String("supported".into())
    );
    assert_eq!(
        value["appContainer"]["state"],
        Value::String("unavailable".into())
    );
    assert_eq!(
        value["appContainerAcl"]["state"],
        Value::String("not_verified".into())
    );
    assert_eq!(
        value["platform"]["integrityLevel"],
        Value::String("medium".into())
    );
    assert_eq!(value["platform"]["version"]["build"], 26100);
    assert!(
        value["platform"].get("osVersion").is_none(),
        "Windows reports no product version string"
    );
    assert!(value.get("notes").is_none(), "empty notes are omitted");
    assert!(
        value.get("processGroup").is_none(),
        "Windows reports no process group capability"
    );
    assert!(value.get("resourceLimits").is_none());
}

#[test]
fn capability_state_has_exactly_four_values() {
    for (state, text) in [
        (CapabilityState::Supported, "supported"),
        (CapabilityState::Unsupported, "unsupported"),
        (CapabilityState::Unavailable, "unavailable"),
        (CapabilityState::NotVerified, "not_verified"),
    ] {
        let value = serde_json::to_value(Capability {
            state,
            detail: None,
        })
        .expect("capability must serialize");
        assert_eq!(value["state"], Value::String(text.into()));
        assert!(value.get("detail").is_none());
    }
}

#[test]
fn process_state_is_tagged_and_camel_case() {
    let value =
        serde_json::to_value(ProcessState::Exited { exit_code: 0 }).expect("state must serialize");
    assert_eq!(value["state"], Value::String("exited".into()));
    assert_eq!(value["exitCode"], Value::Number(0.into()));

    let running = serde_json::to_value(ProcessState::Running { pid: 42 }).expect("state");
    assert_eq!(running["state"], Value::String("running".into()));
    assert_eq!(running["pid"], 42);
}

#[test]
fn process_status_round_trips_with_evidence() {
    let status = ProcessStatus {
        id: ProcessId {
            pid: 1234,
            creation_time_100ns: 133_000_000_000_000_000,
        },
        state: ProcessState::Running { pid: 1234 },
        applied: AppliedIsolation {
            mode: IsolationMode::AppContainer,
            job_object_attached: true,
            app_container_token: true,
            restricted_token: false,
            low_integrity: true,
            file_access_restricted: true,
            network_access: NetworkAccess::Deny,
            network_capabilities_verified: true,
            process_group_attached: None,
            process_group_id: None,
            kill_on_close_armed: None,
        },
    };

    let value = serde_json::to_value(&status).expect("status must serialize");
    assert_eq!(value["id"]["creationTime100ns"], 133_000_000_000_000_000u64);
    assert_eq!(
        value["applied"]["mode"],
        Value::String("app_container".into())
    );
    assert_eq!(value["applied"]["jobObjectAttached"], true);
    assert_eq!(value["applied"]["fileAccessRestricted"], true);
    assert_eq!(
        value["applied"]["networkAccess"],
        Value::String("deny".into())
    );
    assert_eq!(value["applied"]["networkCapabilitiesVerified"], true);
    for key in ["processGroupAttached", "processGroupId", "killOnCloseArmed"] {
        assert!(
            value["applied"].get(key).is_none(),
            "Windows output must not invent {key}"
        );
    }

    let decoded: ProcessStatus = serde_json::from_value(value).expect("status must deserialize");
    assert_eq!(decoded, status);
}

#[test]
fn macos_process_evidence_uses_optional_fields() {
    let status = ProcessStatus {
        id: ProcessId {
            pid: 4242,
            creation_time_100ns: 134_129_088_000_000_000,
        },
        state: ProcessState::Running { pid: 4242 },
        applied: AppliedIsolation {
            mode: IsolationMode::Managed,
            job_object_attached: false,
            app_container_token: false,
            restricted_token: false,
            low_integrity: false,
            file_access_restricted: false,
            network_access: NetworkAccess::Allow,
            network_capabilities_verified: false,
            process_group_attached: Some(true),
            process_group_id: Some(4242),
            kill_on_close_armed: Some(true),
        },
    };

    let value = serde_json::to_value(&status).expect("status must serialize");
    assert_eq!(value["applied"]["processGroupAttached"], true);
    assert_eq!(value["applied"]["processGroupId"], 4242);
    assert_eq!(value["applied"]["killOnCloseArmed"], true);
    assert_eq!(value["applied"]["jobObjectAttached"], false);
}

#[test]
fn error_info_carries_code_operation_and_win32_code() {
    let error = RuntimeError::platform_error("CreateProcessW", 2);
    let info = error.info();

    let value = serde_json::to_value(&info).expect("error must serialize");
    assert_eq!(value["code"], Value::String("platform_failure".into()));
    assert_eq!(value["operation"], Value::String("CreateProcessW".into()));
    #[cfg(windows)]
    {
        assert_eq!(value["windowsError"], 2);
        assert!(value.get("errno").is_none());
    }
    #[cfg(target_os = "macos")]
    {
        assert_eq!(value["errno"], 2);
        assert!(value.get("windowsError").is_none());
    }

    for code in [
        ErrorCode::InvalidRequest,
        ErrorCode::PolicyViolation,
        ErrorCode::CapabilityUnavailable,
        ErrorCode::PlatformFailure,
        ErrorCode::Unsupported,
        ErrorCode::Internal,
    ] {
        let info = ErrorInfo {
            code,
            message: "x".into(),
            operation: None,
            windows_error: None,
            errno: None,
        };
        let value = serde_json::to_value(info).expect("error info must serialize");
        assert!(value.get("operation").is_none());
        assert!(value.get("windowsError").is_none());
        assert!(value.get("errno").is_none());
    }
}

#[test]
fn diagnostic_event_has_stable_shape() {
    let event = DiagnosticEvent::new(
        DiagnosticLevel::Info,
        "process.launch",
        "isolation_verified",
        "child token matched the policy",
    )
    .with_context("environment_id", "env-1");

    let value = serde_json::to_value(&event).expect("event must serialize");
    assert_eq!(value["level"], Value::String("info".into()));
    assert_eq!(value["component"], Value::String("process.launch".into()));
    assert_eq!(value["context"]["environment_id"], "env-1");
    assert!(value["timestampUnixMs"].as_u64().unwrap_or(0) > 0);
}
