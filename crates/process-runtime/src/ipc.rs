//! Minimal authenticated local IPC server for the versioned wire protocol.
//!
//! The server owns [`ManagedProcess`] values and exposes exactly the five
//! operations defined in `packages/contracts`. It deliberately contains no
//! Chrome, CDP or policy logic: it parses protocol messages, calls the same
//! public runtime API a Rust caller would use, and serializes the result.
//!
//! Transport is newline-delimited JSON over a named pipe. The pipe rejects
//! remote clients and inherits the creating process's default DACL, so only
//! principals the current user can already act as can connect. The default
//! pipe name is fixed per protocol version; a named mutex per pipe prevents
//! two servers from sharing it.

use std::collections::{BTreeMap, HashMap};
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::PathBuf;
use std::ptr;
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Deserialize;
use serde_json::{Value, json};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ALREADY_EXISTS, ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::CreateMutexW;

use crate::PROTOCOL_VERSION;
use crate::capabilities::CapabilityReport;
use crate::error::{ErrorCode, RuntimeError};
use crate::launch::{LaunchSpec, launch};
use crate::policy::{
    AccessLevel, AccessRoot, ContainmentLimits, FileAccessPolicy, IsolationMode, NetworkAccess,
    SecurityPolicy,
};
use crate::process::{ManagedProcess, ProcessStatus};

/// Default pipe name. Callers may override it, but both sides must agree.
pub const DEFAULT_PIPE_NAME: &str = r"\\.\pipe\virealm-runtime-v2";

const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
const PIPE_BUFFER_BYTES: u32 = 64 * 1024;
const MUTEX_PREFIX: &str = r"Local\virealm-runtime-v2-server";

/// One process registry shared by every client connection.
struct RuntimeState {
    processes: Mutex<HashMap<String, ManagedProcess>>,
}

impl RuntimeState {
    fn new() -> Self {
        Self {
            processes: Mutex::new(HashMap::new()),
        }
    }
}

/// Run the pipe server until the process exits.
///
/// Errors are limited to failing to create the server; connection and request
/// errors are reported per connection and do not stop the server.
pub fn serve(pipe_name: &str) -> std::io::Result<()> {
    let _mutex = acquire_single_instance(pipe_name)?;
    let state = Arc::new(RuntimeState::new());

    eprintln!("virealm-runtime: listening on {pipe_name}");
    loop {
        let pipe = create_pipe(pipe_name)?;
        if !connect(pipe.as_raw_handle())? {
            continue;
        }

        let state = Arc::clone(&state);
        let file = File::from(pipe);
        thread::spawn(move || {
            let _ = handle_connection(file, &state);
        });
    }
}

fn acquire_single_instance(pipe_name: &str) -> std::io::Result<OwnedHandle> {
    let name = wide(&mutex_name(pipe_name));
    // SAFETY: `name` is a NUL-terminated wide string and the default security
    // descriptor applies the creator's DACL.
    let handle = unsafe { CreateMutexW(ptr::null(), 1, name.as_ptr()) };
    if handle.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: `GetLastError` has no preconditions.
    if unsafe { windows_sys::Win32::Foundation::GetLastError() } == ERROR_ALREADY_EXISTS {
        // SAFETY: the handle was created by this call.
        unsafe { CloseHandle(handle) };
        return Err(std::io::Error::new(
            std::io::ErrorKind::AddrInUse,
            "another virealm runtime server already owns the pipe",
        ));
    }
    // SAFETY: ownership transfers to the returned handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle as _) })
}

/// One server per pipe. Deriving the name from the pipe keeps independent
/// pipes usable side by side (tests, isolated hosts) without weakening the
/// single-writer guarantee for a given pipe.
fn mutex_name(pipe_name: &str) -> String {
    let suffix: String = pipe_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
                character
            } else {
                '_'
            }
        })
        .collect();
    format!("{MUTEX_PREFIX}-{suffix}")
}

fn create_pipe(name: &str) -> std::io::Result<OwnedHandle> {
    let name = wide(name);
    // SAFETY: the name is NUL-terminated; buffers are non-zero; the default
    // security descriptor gives the pipe the creator's DACL, and remote
    // clients are rejected.
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            PIPE_BUFFER_BYTES,
            PIPE_BUFFER_BYTES,
            0,
            ptr::null(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: `handle` is a fresh, valid handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle as _) })
}

fn connect(handle: HANDLE) -> std::io::Result<bool> {
    // SAFETY: `handle` is an unconnected server pipe instance.
    let connected = unsafe { ConnectNamedPipe(handle, ptr::null_mut()) };
    if connected != 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(ERROR_PIPE_CONNECTED as i32) {
        Ok(true)
    } else {
        Err(error)
    }
}

fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

fn handle_connection(file: File, state: &RuntimeState) -> std::io::Result<()> {
    let mut reader = BufReader::new(file);
    let mut buffer = String::new();
    loop {
        buffer.clear();
        let read = reader.read_line(&mut buffer)?;
        if read == 0 {
            return Ok(());
        }
        if buffer.len() > MAX_MESSAGE_BYTES {
            let response = error_response(
                None,
                None,
                protocol_error(
                    "invalid_request",
                    "request exceeds the maximum message size",
                    true,
                    None,
                ),
            );
            write_response(&mut reader, &response)?;
            return Ok(());
        }

        let response = process_line(buffer.trim_end_matches(['\r', '\n']), state);
        write_response(&mut reader, &response)?;
    }
}

fn write_response(reader: &mut BufReader<File>, response: &Value) -> std::io::Result<()> {
    let mut writer = BufWriter::new(reader.get_mut());
    serde_json::to_writer(&mut writer, response)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

fn process_line(line: &str, state: &RuntimeState) -> Value {
    let value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => {
            return error_response(
                None,
                None,
                protocol_error("invalid_request", "request is not valid JSON", true, None),
            );
        }
    };

    let request_id = value
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|value| valid_request_id(value))
        .map(str::to_owned);
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .filter(|value| value.len() <= 128)
        .map(str::to_owned);

    let version = value.get("protocolVersion").and_then(Value::as_u64);
    if version != Some(u64::from(PROTOCOL_VERSION)) {
        return error_response(
            request_id,
            method,
            protocol_error(
                "unsupported_protocol_version",
                &format!(
                    "unsupported protocol version; this runtime implements version {PROTOCOL_VERSION}"
                ),
                true,
                Some(json!({ "supportedProtocolVersion": PROTOCOL_VERSION })),
            ),
        );
    }

    let Some(method) = method else {
        return error_response(
            request_id,
            None,
            protocol_error("invalid_request", "method is required", true, None),
        );
    };

    let Some(parsed_method) = Method::parse(&method) else {
        let printable = sanitize_method(&method);
        return error_response(
            request_id,
            None,
            protocol_error(
                "unknown_method",
                &format!("unknown method {printable:?}"),
                true,
                Some(json!({ "method": printable })),
            ),
        );
    };

    let Some(request_id) = request_id else {
        return error_response(
            None,
            None,
            protocol_error("invalid_request", "requestId is invalid", true, None),
        );
    };

    match dispatch(parsed_method, &value, state) {
        Ok(result) => json!({
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
            "method": method,
            "ok": true,
            "result": result,
        }),
        Err(error) => error_response(Some(request_id), Some(method), error),
    }
}

#[derive(Clone, Copy)]
enum Method {
    GetCapabilities,
    Launch,
    GetStatus,
    Terminate,
    GetDiagnostics,
}

impl Method {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "runtime.getCapabilities" => Some(Self::GetCapabilities),
            "process.launch" => Some(Self::Launch),
            "process.getStatus" => Some(Self::GetStatus),
            "process.terminate" => Some(Self::Terminate),
            "process.getDiagnostics" => Some(Self::GetDiagnostics),
            _ => None,
        }
    }
}

fn dispatch(method: Method, request: &Value, state: &RuntimeState) -> Result<Value, ErrorPayload> {
    match method {
        Method::GetCapabilities => {
            ensure_no_params(request)?;
            serde_json::to_value(capabilities_json()).map_err(|error| internal(error.to_string()))
        }
        Method::Launch => {
            let params: LaunchParams = parse_params(request)?;
            let spec = params.into_spec()?;
            let process = launch(&spec).map_err(runtime_error)?;
            let status = process.status().map_err(runtime_error)?;
            let key = instance_id(&status);
            state
                .processes
                .lock()
                .map_err(|_| internal("process registry lock poisoned"))?
                .insert(key, process);
            Ok(status_json(&status))
        }
        Method::GetStatus => {
            let reference: ProcessReference = parse_params(request)?;
            let processes = state
                .processes
                .lock()
                .map_err(|_| internal("process registry lock poisoned"))?;
            let process = processes
                .get(&reference.process_instance_id)
                .ok_or_else(not_found)?;
            Ok(status_json(&process.status().map_err(runtime_error)?))
        }
        Method::Terminate => {
            let reference: ProcessReference = parse_params(request)?;
            let mut processes = state
                .processes
                .lock()
                .map_err(|_| internal("process registry lock poisoned"))?;
            let process = processes
                .get_mut(&reference.process_instance_id)
                .ok_or_else(not_found)?;
            Ok(status_json(&process.terminate().map_err(runtime_error)?))
        }
        Method::GetDiagnostics => {
            let reference: ProcessReference = parse_params(request)?;
            let processes = state
                .processes
                .lock()
                .map_err(|_| internal("process registry lock poisoned"))?;
            let process = processes
                .get(&reference.process_instance_id)
                .ok_or_else(not_found)?;
            Ok(json!({
                "processInstanceId": reference.process_instance_id,
                "diagnostics": process.diagnostics(),
            }))
        }
    }
}

fn capabilities_json() -> CapabilityReport {
    crate::probe_capabilities()
}

fn ensure_no_params(request: &Value) -> Result<(), ErrorPayload> {
    if request.get("params").is_some() {
        return Err(protocol_error(
            "invalid_request",
            "runtime.getCapabilities takes no params",
            true,
            None,
        ));
    }
    Ok(())
}

fn parse_params<T: for<'de> Deserialize<'de>>(request: &Value) -> Result<T, ErrorPayload> {
    let params = request
        .get("params")
        .ok_or_else(|| protocol_error("invalid_request", "params are required", true, None))?;
    serde_json::from_value(params.clone())
        .map_err(|error| protocol_error("invalid_request", &error.to_string(), true, None))
}

fn status_json(status: &ProcessStatus) -> Value {
    let creation_time = status.id.creation_time_100ns;
    let started_at = (creation_time / 10_000) as i64 - 11_644_473_600_000;
    let state = match status.state {
        crate::process::ProcessState::Starting => json!({ "state": "starting" }),
        crate::process::ProcessState::Running { pid } => json!({ "state": "running", "pid": pid }),
        crate::process::ProcessState::Exited { exit_code } => {
            json!({ "state": "exited", "exitCode": exit_code })
        }
    };

    json!({
        "processInstanceId": format!("{}:{}", status.id.pid, creation_time),
        "pid": status.id.pid,
        "creationTime100ns": creation_time.to_string(),
        "startedAtUnixMs": started_at,
        "state": state,
        "applied": status.applied,
    })
}

fn instance_id(status: &ProcessStatus) -> String {
    format!("{}:{}", status.id.pid, status.id.creation_time_100ns)
}

// --------------------------------------------------------------------------
// Wire request types
// --------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LaunchParams {
    environment_id: String,
    executable: String,
    arguments: Vec<String>,
    working_directory: Option<String>,
    environment_overrides: Option<BTreeMap<String, String>>,
    data_directory: String,
    policy: LaunchPolicy,
}

impl LaunchParams {
    fn into_spec(self) -> Result<LaunchSpec, ErrorPayload> {
        let mut environment = BTreeMap::new();
        for (name, value) in self.environment_overrides.unwrap_or_default() {
            if name.is_empty() || name.contains('=') || name.contains('\0') || value.contains('\0')
            {
                return Err(protocol_error(
                    "invalid_request",
                    "environment overrides contain an invalid name or value",
                    true,
                    None,
                ));
            }
            if environment
                .keys()
                .any(|existing: &OsString| existing.to_string_lossy().eq_ignore_ascii_case(&name))
            {
                return Err(protocol_error(
                    "invalid_request",
                    "environment variable names must be unique case-insensitively",
                    true,
                    None,
                ));
            }
            environment.insert(OsString::from(name), OsString::from(value));
        }

        let policy = self.policy.into_policy()?;
        Ok(LaunchSpec {
            environment_id: self.environment_id,
            executable: PathBuf::from(self.executable),
            arguments: self.arguments.into_iter().map(OsString::from).collect(),
            working_directory: self.working_directory.map(PathBuf::from),
            environment_overrides: environment,
            data_directory: PathBuf::from(self.data_directory),
            policy,
        })
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "isolation",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum LaunchPolicy {
    Managed {
        allowed_program_roots: Vec<String>,
        file_access: InheritedFileAccess,
        network_access: NetworkPolicy,
        containment: Containment,
    },
    Restricted {
        allowed_program_roots: Vec<String>,
        file_access: InheritedFileAccess,
        network_access: NetworkPolicy,
        containment: Containment,
    },
    AppContainer {
        allowed_program_roots: Vec<String>,
        file_access: RestrictedFileAccess,
        network_access: NetworkPolicy,
        containment: Containment,
    },
}

impl LaunchPolicy {
    fn into_policy(self) -> Result<SecurityPolicy, ErrorPayload> {
        match self {
            LaunchPolicy::Managed {
                allowed_program_roots,
                file_access,
                network_access,
                containment,
            } => {
                let _ = file_access.kind;
                require_allow_network(network_access)?;
                Ok(SecurityPolicy {
                    isolation: IsolationMode::Managed,
                    allowed_program_roots: roots(allowed_program_roots),
                    file_access: FileAccessPolicy::Inherited,
                    network_access: NetworkAccess::Allow,
                    containment: containment.into(),
                })
            }
            LaunchPolicy::Restricted {
                allowed_program_roots,
                file_access,
                network_access,
                containment,
            } => {
                let _ = file_access.kind;
                require_allow_network(network_access)?;
                Ok(SecurityPolicy {
                    isolation: IsolationMode::Restricted,
                    allowed_program_roots: roots(allowed_program_roots),
                    file_access: FileAccessPolicy::Inherited,
                    network_access: NetworkAccess::Allow,
                    containment: containment.into(),
                })
            }
            LaunchPolicy::AppContainer {
                allowed_program_roots,
                file_access,
                network_access,
                containment,
            } => {
                let _ = &file_access.kind;
                Ok(SecurityPolicy {
                    isolation: IsolationMode::AppContainer,
                    allowed_program_roots: roots(allowed_program_roots),
                    file_access: FileAccessPolicy::Restricted {
                        data_directory: file_access.data_directory.into(),
                        additional_roots: file_access
                            .additional_roots
                            .into_iter()
                            .map(|root| AccessRoot {
                                path: PathBuf::from(root.path),
                                access: root.access.into(),
                            })
                            .collect(),
                    },
                    network_access: match network_access {
                        NetworkPolicy::Allow => NetworkAccess::Allow,
                        NetworkPolicy::Deny => NetworkAccess::Deny,
                    },
                    containment: containment.into(),
                })
            }
        }
    }
}

fn require_allow_network(value: NetworkPolicy) -> Result<(), ErrorPayload> {
    if value == NetworkPolicy::Allow {
        Ok(())
    } else {
        Err(protocol_error(
            "invalid_request",
            "managed and restricted modes require networkAccess=allow",
            true,
            None,
        ))
    }
}

fn roots(values: Vec<String>) -> Vec<PathBuf> {
    values.into_iter().map(PathBuf::from).collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
struct InheritedFileAccess {
    kind: InheritedKind,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum InheritedKind {
    Inherited,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RestrictedFileAccess {
    kind: RestrictedKind,
    data_directory: AccessLevelDto,
    additional_roots: Vec<AccessRootDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum RestrictedKind {
    Restricted,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AccessRootDto {
    path: String,
    access: AccessLevelDto,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum AccessLevelDto {
    ReadOnly,
    ReadWrite,
}

impl From<AccessLevelDto> for AccessLevel {
    fn from(value: AccessLevelDto) -> Self {
        match value {
            AccessLevelDto::ReadOnly => AccessLevel::ReadOnly,
            AccessLevelDto::ReadWrite => AccessLevel::ReadWrite,
        }
    }
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum NetworkPolicy {
    Allow,
    Deny,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Containment {
    kill_on_close: bool,
    max_processes: Option<u32>,
    memory_limit_bytes: Option<u64>,
}

impl From<Containment> for ContainmentLimits {
    fn from(value: Containment) -> Self {
        Self {
            kill_on_close: value.kill_on_close,
            max_processes: value.max_processes,
            memory_limit_bytes: value.memory_limit_bytes,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProcessReference {
    process_instance_id: String,
}

// --------------------------------------------------------------------------
// Error payloads
// --------------------------------------------------------------------------

struct ErrorPayload {
    code: &'static str,
    message: String,
    retryable: bool,
    details: Option<Value>,
}

fn protocol_error(
    code: &'static str,
    message: &str,
    retryable: bool,
    details: Option<Value>,
) -> ErrorPayload {
    ErrorPayload {
        code,
        message: message.to_owned(),
        retryable,
        details,
    }
}

fn runtime_error(error: RuntimeError) -> ErrorPayload {
    let retryable = matches!(
        error.code(),
        ErrorCode::InvalidRequest | ErrorCode::PolicyViolation | ErrorCode::Unsupported
    );
    let details = match &error {
        RuntimeError::PlatformFailure {
            operation, code, ..
        } => Some(json!({ "operation": operation, "windowsError": code })),
        _ => None,
    };
    ErrorPayload {
        code: match error.code() {
            ErrorCode::InvalidRequest => "invalid_request",
            ErrorCode::PolicyViolation => "policy_violation",
            ErrorCode::CapabilityUnavailable => "capability_unavailable",
            ErrorCode::PlatformFailure => "platform_failure",
            ErrorCode::Unsupported => "unsupported",
            ErrorCode::Internal => "internal",
        },
        message: error.to_string(),
        retryable,
        details,
    }
}

fn internal(message: impl Into<String>) -> ErrorPayload {
    protocol_error("internal", &message.into(), false, None)
}

fn not_found() -> ErrorPayload {
    protocol_error(
        "process_not_found",
        "no managed process with this instance id",
        true,
        None,
    )
}

fn error_response(
    request_id: Option<String>,
    method: Option<String>,
    error: ErrorPayload,
) -> Value {
    let mut response = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "ok": false,
        "error": {
            "code": error.code,
            "message": error.message,
            "retryable": error.retryable,
        },
    });
    if let Some(request_id) = request_id {
        response["requestId"] = Value::String(request_id);
    }
    if let Some(method) = method {
        response["method"] = Value::String(method);
    }
    if let Some(details) = error.details {
        response["error"]["details"] = details;
    }
    response
}

fn valid_request_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (5..=68).contains(&bytes.len())
        && value.starts_with("req_")
        && bytes[4..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn sanitize_method(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|character| {
            if (' '..='~').contains(&character) {
                character
            } else {
                '?'
            }
        })
        .take(128)
        .collect();
    if sanitized.is_empty() {
        "<unprintable>".to_owned()
    } else {
        sanitized
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_ids_match_the_contract() {
        assert!(valid_request_id("req_abc123"));
        assert!(!valid_request_id("req_"));
        assert!(!valid_request_id("abc123"));
        assert!(!valid_request_id("req_bad space"));
        assert!(!valid_request_id(&format!("req_{}", "a".repeat(65))));
    }

    #[test]
    fn unknown_methods_are_sanitised() {
        assert_eq!(sanitize_method("process.kill"), "process.kill");
        assert_eq!(sanitize_method("bad\nmethod"), "bad?method");
        assert_eq!(sanitize_method(""), "<unprintable>");
    }

    #[test]
    fn status_shape_matches_the_contract() {
        use crate::process::{AppliedIsolation, ProcessId, ProcessState};

        let status = ProcessStatus {
            id: ProcessId {
                pid: 42,
                creation_time_100ns: 134_129_088_000_000_000,
            },
            state: ProcessState::Running { pid: 42 },
            applied: AppliedIsolation {
                mode: IsolationMode::Managed,
                job_object_attached: true,
                app_container_token: false,
                restricted_token: false,
                low_integrity: false,
                file_access_restricted: false,
                network_access: NetworkAccess::Allow,
                network_capabilities_verified: false,
            },
        };
        let value = status_json(&status);
        assert_eq!(value["processInstanceId"], "42:134129088000000000");
        assert_eq!(value["creationTime100ns"], "134129088000000000");
        assert_eq!(value["startedAtUnixMs"], 1_768_435_200_000_i64);
        assert_eq!(value["state"]["state"], "running");
    }

    #[test]
    fn unsupported_versions_report_the_implemented_version() {
        let response = error_response(
            None,
            None,
            protocol_error(
                "unsupported_protocol_version",
                "bad version",
                true,
                Some(json!({ "supportedProtocolVersion": PROTOCOL_VERSION })),
            ),
        );
        assert_eq!(response["error"]["code"], "unsupported_protocol_version");
        assert_eq!(
            response["error"]["details"]["supportedProtocolVersion"],
            PROTOCOL_VERSION
        );
    }
}
