//! Structured errors shared by every runtime operation.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Stable, machine-readable error categories.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The request is malformed or violates a basic invariant.
    InvalidRequest,
    /// The request is well-formed but the configured policy forbids it.
    PolicyViolation,
    /// A required Windows capability is missing or blocked.
    CapabilityUnavailable,
    /// A Windows API call failed.
    PlatformFailure,
    /// The operation exists in the contract but is not implemented.
    Unsupported,
    /// An invariant inside the runtime was broken.
    Internal,
}

/// Serializable error payload crossing the runtime/host boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorInfo {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
    /// Raw Win32 error code, when the failure came from a Windows API call.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub windows_error: Option<u32>,
}

/// Errors returned by the process runtime.
#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("invalid launch request: {0}")]
    InvalidRequest(String),

    #[error("security policy rejected the request: {0}")]
    PolicyViolation(String),

    #[error("required capability is unavailable: {0}")]
    CapabilityUnavailable(String),

    #[error("{operation} failed (Win32 error {code}): {message}")]
    PlatformFailure {
        operation: String,
        code: u32,
        message: String,
    },

    #[error("operation is not supported: {0}")]
    Unsupported(String),

    #[error("internal runtime error: {0}")]
    Internal(String),
}

impl RuntimeError {
    /// Capture the calling thread's last Windows error with operation context.
    pub fn last_platform_error(operation: impl Into<String>) -> Self {
        let error = std::io::Error::last_os_error();
        Self::platform_error(operation, error.raw_os_error().unwrap_or(0) as u32)
    }

    /// Build a platform error from an explicit Win32 code.
    pub fn platform_error(operation: impl Into<String>, code: u32) -> Self {
        let message = std::io::Error::from_raw_os_error(code as i32).to_string();
        Self::PlatformFailure {
            operation: operation.into(),
            code,
            message,
        }
    }

    /// Stable category for this error.
    pub fn code(&self) -> ErrorCode {
        match self {
            Self::InvalidRequest(_) => ErrorCode::InvalidRequest,
            Self::PolicyViolation(_) => ErrorCode::PolicyViolation,
            Self::CapabilityUnavailable(_) => ErrorCode::CapabilityUnavailable,
            Self::PlatformFailure { .. } => ErrorCode::PlatformFailure,
            Self::Unsupported(_) => ErrorCode::Unsupported,
            Self::Internal(_) => ErrorCode::Internal,
        }
    }

    /// Serializable form for diagnostics and IPC responses.
    pub fn info(&self) -> ErrorInfo {
        let (operation, windows_error) = match self {
            Self::PlatformFailure {
                operation, code, ..
            } => (Some(operation.clone()), Some(*code)),
            _ => (None, None),
        };

        ErrorInfo {
            code: self.code(),
            message: self.to_string(),
            operation,
            windows_error,
        }
    }
}

/// Convenient result alias used throughout the crate.
pub type Result<T> = std::result::Result<T, RuntimeError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_variant_has_a_distinct_code() {
        let errors = [
            RuntimeError::InvalidRequest(String::new()),
            RuntimeError::PolicyViolation(String::new()),
            RuntimeError::CapabilityUnavailable(String::new()),
            RuntimeError::platform_error("test", 5),
            RuntimeError::Unsupported(String::new()),
            RuntimeError::Internal(String::new()),
        ];

        for (index, error) in errors.iter().enumerate() {
            for other in errors.iter().skip(index + 1) {
                assert_ne!(error.code(), other.code());
            }
        }
    }

    #[test]
    fn platform_error_preserves_operation_and_code() {
        let info = RuntimeError::platform_error("CreateProcessW", 5).info();

        assert_eq!(info.code, ErrorCode::PlatformFailure);
        assert_eq!(info.operation.as_deref(), Some("CreateProcessW"));
        assert_eq!(info.windows_error, Some(5));
        assert!(info.message.contains("CreateProcessW"));
    }

    #[test]
    fn policy_error_has_no_platform_context() {
        let info = RuntimeError::PolicyViolation("network deny".into()).info();

        assert_eq!(info.code, ErrorCode::PolicyViolation);
        assert!(info.operation.is_none());
        assert!(info.windows_error.is_none());
    }
}
