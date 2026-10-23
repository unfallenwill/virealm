//! Launch specification and policy validation.
//!
//! Validation runs before any Windows call. It is intentionally strict:
//! absolute paths, an explicit program allow-list, explicit environment
//! overrides, and a mode/policy combination that can actually be enforced.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::error::{Result, RuntimeError};
use crate::platform::windows::path as windows_path;
use crate::policy::{AccessLevel, FileAccessPolicy, SecurityPolicy};
use crate::process::ManagedProcess;

/// A request to launch one managed process.
///
/// Paths must be absolute. Arguments and environment values are kept as
/// [`OsString`] so non-UTF-8 Windows data is not silently lossy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    /// Opaque environment identifier. Used for diagnostics and profile names.
    pub environment_id: String,
    /// Absolute path to the executable.
    pub executable: PathBuf,
    /// Individual arguments. Never concatenated by the caller.
    pub arguments: Vec<OsString>,
    /// Absolute working directory, when the caller wants to override it.
    pub working_directory: Option<PathBuf>,
    /// Explicit environment overrides applied on top of the inherited block.
    pub environment_overrides: BTreeMap<OsString, OsString>,
    /// Environment-specific data directory. Must already exist.
    pub data_directory: PathBuf,
    pub policy: SecurityPolicy,
}

/// Canonicalized launch request used by the platform backend.
#[derive(Debug, Clone)]
pub(crate) struct PreparedLaunchSpec {
    pub environment_id: String,
    pub executable: PathBuf,
    pub arguments: Vec<OsString>,
    pub working_directory: Option<PathBuf>,
    pub environment_overrides: BTreeMap<OsString, OsString>,
    pub data_directory: PathBuf,
    pub policy: SecurityPolicy,
}

/// Validate a launch request without performing any Windows call beyond path
/// resolution.
pub fn validate_launch_spec(spec: &LaunchSpec) -> Result<()> {
    prepare(spec).map(|_| ())
}

/// Validate the request and launch a contained process.
///
/// On success the returned [`ManagedProcess`] owns the process and Job Object
/// handles. Dropping it terminates the remaining process tree.
pub fn launch(spec: &LaunchSpec) -> Result<ManagedProcess> {
    let prepared = prepare(spec)?;
    crate::platform::windows::process::launch(&prepared)
}

fn prepare(spec: &LaunchSpec) -> Result<PreparedLaunchSpec> {
    validate_environment_id(&spec.environment_id)?;
    validate_arguments(&spec.arguments)?;
    validate_environment(&spec.environment_overrides)?;

    let executable = canonical_existing(&spec.executable, "executable")?;
    if !executable.is_file() {
        return Err(RuntimeError::InvalidRequest(format!(
            "executable is not a file: {}",
            executable.display()
        )));
    }

    if spec.policy.allowed_program_roots.is_empty() {
        return Err(RuntimeError::PolicyViolation(
            "allowed_program_roots must contain at least one directory".into(),
        ));
    }

    let mut program_roots = Vec::with_capacity(spec.policy.allowed_program_roots.len());
    for root in &spec.policy.allowed_program_roots {
        let root = canonical_existing(root, "allowed program root")?;
        if !root.is_dir() {
            return Err(RuntimeError::InvalidRequest(format!(
                "allowed program root is not a directory: {}",
                root.display()
            )));
        }
        program_roots.push(root);
    }

    if !program_roots
        .iter()
        .any(|root| windows_path::is_within(&executable, root))
    {
        return Err(RuntimeError::PolicyViolation(format!(
            "executable {} is outside the allowed program roots",
            executable.display()
        )));
    }

    let data_directory = canonical_existing(&spec.data_directory, "data directory")?;
    if !data_directory.is_dir() {
        return Err(RuntimeError::InvalidRequest(format!(
            "data directory is not a directory: {}",
            data_directory.display()
        )));
    }
    windows_path::reject_overbroad_root(&data_directory, "data directory")?;

    let working_directory = match &spec.working_directory {
        Some(path) => {
            let path = canonical_existing(path, "working directory")?;
            if !path.is_dir() {
                return Err(RuntimeError::InvalidRequest(format!(
                    "working directory is not a directory: {}",
                    path.display()
                )));
            }
            Some(path)
        }
        None => None,
    };

    let mut policy = spec.policy.clone();
    policy.allowed_program_roots = program_roots;

    if let FileAccessPolicy::Restricted {
        data_directory: _,
        additional_roots,
    } = &policy.file_access
    {
        let mut canonical_roots = Vec::with_capacity(additional_roots.len());
        for root in additional_roots {
            let path = canonical_existing(&root.path, "additional access root")?;
            if !path.is_dir() {
                return Err(RuntimeError::InvalidRequest(format!(
                    "additional access root is not a directory: {}",
                    path.display()
                )));
            }
            windows_path::reject_overbroad_root(&path, "additional access root")?;
            if path == data_directory {
                return Err(RuntimeError::PolicyViolation(
                    "data directory must not be duplicated in additional_roots".into(),
                ));
            }
            canonical_roots.push(crate::policy::AccessRoot {
                path,
                access: root.access,
            });
        }

        policy.file_access = FileAccessPolicy::Restricted {
            data_directory: match &spec.policy.file_access {
                FileAccessPolicy::Restricted { data_directory, .. } => *data_directory,
                FileAccessPolicy::Inherited => AccessLevel::ReadWrite,
            },
            additional_roots: canonical_roots,
        };
    }

    policy.validate()?;

    Ok(PreparedLaunchSpec {
        environment_id: spec.environment_id.clone(),
        executable,
        arguments: spec.arguments.clone(),
        working_directory,
        environment_overrides: spec.environment_overrides.clone(),
        data_directory,
        policy,
    })
}

fn validate_environment_id(environment_id: &str) -> Result<()> {
    if environment_id.trim().is_empty() {
        return Err(RuntimeError::InvalidRequest(
            "environment_id must not be empty".into(),
        ));
    }
    if environment_id.len() > 128 {
        return Err(RuntimeError::InvalidRequest(
            "environment_id must be at most 128 bytes".into(),
        ));
    }
    if environment_id.chars().any(char::is_control) {
        return Err(RuntimeError::InvalidRequest(
            "environment_id must not contain control characters".into(),
        ));
    }
    Ok(())
}

fn validate_arguments(arguments: &[OsString]) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;

    if arguments
        .iter()
        .any(|argument| argument.encode_wide().any(|unit| unit == 0))
    {
        return Err(RuntimeError::InvalidRequest(
            "arguments must not contain NUL characters".into(),
        ));
    }
    Ok(())
}

fn validate_environment(environment: &BTreeMap<OsString, OsString>) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;

    let mut seen: Vec<&OsString> = Vec::with_capacity(environment.len());
    for (key, value) in environment {
        let wide: Vec<u16> = key.encode_wide().collect();
        if wide.is_empty() {
            return Err(RuntimeError::InvalidRequest(
                "environment variable name must not be empty".into(),
            ));
        }
        if wide.first() == Some(&(b'=' as u16)) || wide.contains(&(b'=' as u16)) {
            return Err(RuntimeError::InvalidRequest(
                "environment variable name must not contain '='".into(),
            ));
        }
        if wide.contains(&0) || value.encode_wide().any(|unit| unit == 0) {
            return Err(RuntimeError::InvalidRequest(
                "environment variables must not contain NUL characters".into(),
            ));
        }

        if let Some(previous) = seen
            .iter()
            .find(|previous| crate::process::os_string_is_ascii_case_insensitive(previous, key))
        {
            return Err(RuntimeError::InvalidRequest(format!(
                "duplicate environment variable (case-insensitive): {:?} and {:?}",
                previous, key
            )));
        }
        seen.push(key);
    }
    Ok(())
}

fn canonical_existing(path: &Path, description: &str) -> Result<PathBuf> {
    if path.as_os_str().is_empty() {
        return Err(RuntimeError::InvalidRequest(format!(
            "{description} path is empty"
        )));
    }
    if !path.is_absolute() {
        return Err(RuntimeError::InvalidRequest(format!(
            "{description} path must be absolute: {}",
            path.display()
        )));
    }

    std::fs::canonicalize(path).map_err(|error| {
        RuntimeError::InvalidRequest(format!(
            "cannot resolve {description} {}: {error}",
            path.display()
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::{AccessLevel, AccessRoot, ContainmentLimits, IsolationMode, NetworkAccess};

    fn minimal_policy(root: PathBuf) -> SecurityPolicy {
        SecurityPolicy {
            isolation: IsolationMode::Managed,
            allowed_program_roots: vec![root],
            file_access: FileAccessPolicy::Inherited,
            network_access: NetworkAccess::Allow,
            containment: ContainmentLimits::default(),
        }
    }

    fn spec_for(executable: PathBuf) -> LaunchSpec {
        let data = executable.parent().expect("temp file parent").to_path_buf();
        LaunchSpec {
            environment_id: "test-env".into(),
            executable,
            arguments: Vec::new(),
            working_directory: None,
            environment_overrides: BTreeMap::new(),
            data_directory: data.clone(),
            policy: minimal_policy(data),
        }
    }

    #[test]
    fn empty_environment_id_is_rejected() {
        let mut spec = spec_for(std::env::current_exe().expect("current exe"));
        spec.environment_id = "  ".into();
        assert!(matches!(
            validate_launch_spec(&spec),
            Err(RuntimeError::InvalidRequest(_))
        ));
    }

    #[test]
    fn relative_executable_is_rejected() {
        let mut spec = spec_for(std::env::current_exe().expect("current exe"));
        spec.executable = PathBuf::from("chrome.exe");
        assert!(matches!(
            validate_launch_spec(&spec),
            Err(RuntimeError::InvalidRequest(_))
        ));
    }

    #[test]
    fn executable_outside_program_roots_is_rejected() {
        let current = std::env::current_exe().expect("current exe");
        let mut spec = spec_for(current);
        spec.policy.allowed_program_roots = vec![std::env::temp_dir()];
        assert!(matches!(
            validate_launch_spec(&spec),
            Err(RuntimeError::PolicyViolation(_))
        ));
    }

    #[test]
    fn duplicate_environment_names_are_rejected_case_insensitively() {
        let mut spec = spec_for(std::env::current_exe().expect("current exe"));
        spec.environment_overrides
            .insert(OsString::from("Path"), OsString::from("a"));
        spec.environment_overrides
            .insert(OsString::from("PATH"), OsString::from("b"));
        assert!(matches!(
            validate_launch_spec(&spec),
            Err(RuntimeError::InvalidRequest(_))
        ));
    }

    #[test]
    fn environment_names_with_equals_are_rejected() {
        let mut spec = spec_for(std::env::current_exe().expect("current exe"));
        spec.environment_overrides
            .insert(OsString::from("BAD=KEY"), OsString::from("value"));
        assert!(matches!(
            validate_launch_spec(&spec),
            Err(RuntimeError::InvalidRequest(_))
        ));
    }

    #[test]
    fn nul_in_argument_is_rejected() {
        let mut spec = spec_for(std::env::current_exe().expect("current exe"));
        spec.arguments.push(OsString::from("bad\0argument"));
        assert!(matches!(
            validate_launch_spec(&spec),
            Err(RuntimeError::InvalidRequest(_))
        ));
    }

    #[test]
    fn missing_executable_is_rejected() {
        let mut spec = spec_for(std::env::current_exe().expect("current exe"));
        spec.executable = std::env::temp_dir().join("virealm-does-not-exist.exe");
        assert!(matches!(
            validate_launch_spec(&spec),
            Err(RuntimeError::InvalidRequest(_))
        ));
    }

    #[test]
    fn directory_as_executable_is_rejected() {
        let mut spec = spec_for(std::env::current_exe().expect("current exe"));
        spec.executable = std::env::temp_dir();
        assert!(matches!(
            validate_launch_spec(&spec),
            Err(RuntimeError::InvalidRequest(_))
        ));
    }

    #[test]
    fn missing_program_root_is_rejected() {
        let mut spec = spec_for(std::env::current_exe().expect("current exe"));
        spec.policy.allowed_program_roots = vec![std::env::temp_dir().join("virealm-missing-root")];
        assert!(matches!(
            validate_launch_spec(&spec),
            Err(RuntimeError::InvalidRequest(_))
        ));
    }

    #[test]
    fn file_as_program_root_is_rejected() {
        let executable = std::env::current_exe().expect("current exe");
        let mut spec = spec_for(executable.clone());
        spec.policy.allowed_program_roots = vec![executable];
        assert!(matches!(
            validate_launch_spec(&spec),
            Err(RuntimeError::InvalidRequest(_))
        ));
    }

    #[test]
    fn missing_data_directory_is_rejected() {
        let mut spec = spec_for(std::env::current_exe().expect("current exe"));
        spec.data_directory = std::env::temp_dir().join("virealm-missing-data");
        assert!(matches!(
            validate_launch_spec(&spec),
            Err(RuntimeError::InvalidRequest(_))
        ));
    }

    #[test]
    fn volume_root_as_data_directory_is_rejected() {
        let mut spec = spec_for(std::env::current_exe().expect("current exe"));
        spec.data_directory = PathBuf::from(r"C:\");
        assert!(matches!(
            validate_launch_spec(&spec),
            Err(RuntimeError::PolicyViolation(_))
        ));
    }

    #[test]
    fn non_directory_working_directory_is_rejected() {
        let executable = std::env::current_exe().expect("current exe");
        let mut spec = spec_for(executable.clone());
        spec.working_directory = Some(executable);
        assert!(matches!(
            validate_launch_spec(&spec),
            Err(RuntimeError::InvalidRequest(_))
        ));
    }

    #[test]
    fn missing_working_directory_is_rejected() {
        let mut spec = spec_for(std::env::current_exe().expect("current exe"));
        spec.working_directory = Some(std::env::temp_dir().join("virealm-missing-cwd"));
        assert!(matches!(
            validate_launch_spec(&spec),
            Err(RuntimeError::InvalidRequest(_))
        ));
    }

    #[test]
    fn empty_environment_name_is_rejected() {
        let mut spec = spec_for(std::env::current_exe().expect("current exe"));
        spec.environment_overrides
            .insert(OsString::new(), OsString::from("value"));
        assert!(matches!(
            validate_launch_spec(&spec),
            Err(RuntimeError::InvalidRequest(_))
        ));
    }

    #[test]
    fn nul_in_environment_value_is_rejected() {
        let mut spec = spec_for(std::env::current_exe().expect("current exe"));
        spec.environment_overrides
            .insert(OsString::from("KEY"), OsString::from("bad\0value"));
        assert!(matches!(
            validate_launch_spec(&spec),
            Err(RuntimeError::InvalidRequest(_))
        ));
    }

    #[test]
    fn oversized_environment_id_is_rejected() {
        let mut spec = spec_for(std::env::current_exe().expect("current exe"));
        spec.environment_id = "a".repeat(129);
        assert!(matches!(
            validate_launch_spec(&spec),
            Err(RuntimeError::InvalidRequest(_))
        ));
    }

    #[test]
    fn control_characters_in_environment_id_are_rejected() {
        let mut spec = spec_for(std::env::current_exe().expect("current exe"));
        spec.environment_id = "env\nname".into();
        assert!(matches!(
            validate_launch_spec(&spec),
            Err(RuntimeError::InvalidRequest(_))
        ));
    }

    fn app_container_spec(additional_roots: Vec<AccessRoot>) -> LaunchSpec {
        let executable = std::env::current_exe().expect("current exe");
        let mut spec = spec_for(executable);
        spec.policy.isolation = IsolationMode::AppContainer;
        spec.policy.file_access = FileAccessPolicy::Restricted {
            data_directory: AccessLevel::ReadWrite,
            additional_roots,
        };
        spec
    }

    #[test]
    fn app_container_rejects_duplicate_data_root() {
        let mut spec = app_container_spec(Vec::new());
        let data = spec.data_directory.clone();
        spec.policy.file_access = FileAccessPolicy::Restricted {
            data_directory: AccessLevel::ReadWrite,
            additional_roots: vec![AccessRoot {
                path: data,
                access: AccessLevel::ReadOnly,
            }],
        };
        assert!(matches!(
            validate_launch_spec(&spec),
            Err(RuntimeError::PolicyViolation(_))
        ));
    }

    #[test]
    fn app_container_rejects_missing_additional_root() {
        let spec = app_container_spec(vec![AccessRoot {
            path: std::env::temp_dir().join("virealm-missing-access-root"),
            access: AccessLevel::ReadOnly,
        }]);
        assert!(matches!(
            validate_launch_spec(&spec),
            Err(RuntimeError::InvalidRequest(_))
        ));
    }

    #[test]
    fn app_container_rejects_overbroad_additional_root() {
        let spec = app_container_spec(vec![AccessRoot {
            path: PathBuf::from(r"C:\"),
            access: AccessLevel::ReadWrite,
        }]);
        assert!(matches!(
            validate_launch_spec(&spec),
            Err(RuntimeError::PolicyViolation(_))
        ));
    }

    #[test]
    fn app_container_rejects_network_denial_for_managed_mode() {
        let mut spec = spec_for(std::env::current_exe().expect("current exe"));
        spec.policy.network_access = NetworkAccess::Deny;
        assert!(matches!(
            validate_launch_spec(&spec),
            Err(RuntimeError::PolicyViolation(_))
        ));
    }
}
