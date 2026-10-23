//! Windows path-boundary checks.
//!
//! Windows paths are case-insensitive and may contain non-UTF-8 data, so the
//! comparison runs on UTF-16 code units rather than on a lossy `String`.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use crate::error::{Result, RuntimeError};

/// Encode an `OsStr` as a NUL-terminated UTF-16 buffer.
pub fn to_wide_null(value: &OsStr) -> Vec<u16> {
    let mut wide: Vec<u16> = value.encode_wide().collect();
    wide.push(0);
    wide
}

/// Encode a path as a NUL-terminated UTF-16 buffer.
pub fn path_to_wide_null(path: &Path) -> Vec<u16> {
    to_wide_null(path.as_os_str())
}

/// Whether `child` is equal to or below `base`, comparing case-insensitively
/// without lossy Unicode conversion.
///
/// Both paths should already be canonicalized. Trailing separators are
/// ignored, and a component boundary is required (`C:\foo` is not within
/// `C:\foobar`).
pub fn is_within(child: &Path, base: &Path) -> bool {
    let child: Vec<u16> = child.as_os_str().encode_wide().collect();
    let base: Vec<u16> = base.as_os_str().encode_wide().collect();
    let base = trim_trailing_separators(&base);

    if base.len() > child.len() {
        return false;
    }
    if !super::wide::slice_eq_ignore_ascii_case(&child[..base.len()], base) {
        return false;
    }
    if child.len() == base.len() {
        return true;
    }

    child[base.len()] == b'\\' as u16 || child[base.len()] == b'/' as u16
}

/// Reject roots that would grant a restricted process overly broad access.
///
/// This is a defensive check, not a general ACL analyzer: it refuses volume
/// roots and the exact well-known roots for the user profile, system, and
/// application data. Subdirectories remain allowed and must still be chosen
/// explicitly by the caller.
pub fn reject_overbroad_root(path: &Path, description: &str) -> Result<()> {
    if path.parent().is_none() {
        return Err(RuntimeError::PolicyViolation(format!(
            "{description} must not be a volume root: {}",
            path.display()
        )));
    }

    const BROAD_VARIABLES: &[&str] = &[
        "SystemRoot",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramData",
        "USERPROFILE",
        "LOCALAPPDATA",
        "APPDATA",
    ];

    for variable in BROAD_VARIABLES {
        let Some(root) = std::env::var_os(variable) else {
            continue;
        };
        let root = PathBuf::from(root);
        let Ok(root) = std::fs::canonicalize(root) else {
            continue;
        };
        if is_within(path, &root) && is_within(&root, path) {
            return Err(RuntimeError::PolicyViolation(format!(
                "{description} must not be the root of %{variable}%: {}",
                path.display()
            )));
        }
    }

    Ok(())
}

fn trim_trailing_separators(path: &[u16]) -> &[u16] {
    let mut end = path.len();
    while end > 0 && (path[end - 1] == b'\\' as u16 || path[end - 1] == b'/' as u16) {
        end -= 1;
    }
    &path[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_inside_base_is_accepted() {
        assert!(is_within(
            Path::new(r"C:\Program Files\Chrome\chrome.exe"),
            Path::new(r"C:\Program Files")
        ));
    }

    #[test]
    fn prefix_without_component_boundary_is_rejected() {
        assert!(!is_within(
            Path::new(r"C:\Program Files Evil\chrome.exe"),
            Path::new(r"C:\Program Files")
        ));
    }

    #[test]
    fn comparison_is_case_insensitive() {
        assert!(is_within(
            Path::new(r"C:\PROGRAM FILES\Chrome\chrome.exe"),
            Path::new(r"c:\program files")
        ));
    }

    #[test]
    fn trailing_separator_on_base_is_ignored() {
        assert!(is_within(
            Path::new(r"C:\Program Files\Chrome\chrome.exe"),
            Path::new(r"C:\Program Files\")
        ));
    }

    #[test]
    fn equal_paths_are_within() {
        assert!(is_within(
            Path::new(r"C:\Program Files"),
            Path::new(r"C:\Program Files")
        ));
    }

    #[test]
    fn volume_root_is_rejected() {
        let error = reject_overbroad_root(Path::new(r"C:\"), "data directory")
            .expect_err("volume root must be rejected");
        assert!(matches!(error, RuntimeError::PolicyViolation(_)));
    }

    #[test]
    fn temporary_directory_is_accepted() {
        let temp = std::fs::canonicalize(std::env::temp_dir()).expect("temp dir");
        let nested = temp.join("virealm-path-test");
        assert!(reject_overbroad_root(&nested, "data directory").is_ok());
    }
}
