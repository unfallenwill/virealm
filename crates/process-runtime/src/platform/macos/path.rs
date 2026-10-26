//! POSIX path boundaries.
//!
//! macOS path comparison is case-sensitive by default (HFS+ and APFS can be
//! case-insensitive, but the canonical form the runtime sees is what the file
//! system reported). Component-wise comparison avoids the prefix bug where
//! `/Applications-old` would look like it lives under `/Applications`.

use std::path::Path;

use crate::error::{Result, RuntimeError};

/// True when `path` is `root` or lives below it.
pub(crate) fn is_within(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

/// Reject directories that are too broad to be a policy boundary.
///
/// Home directories themselves are rejected, but subdirectories such as
/// `~/Library/Application Support/Virealm/...` are allowed: the adapter stores
/// environment data there.
pub(crate) fn reject_overbroad_root(path: &Path, description: &str) -> Result<()> {
    const BROAD_ROOTS: &[&str] = &[
        "/",
        "/Applications",
        "/Library",
        "/System",
        "/Users",
        "/Volumes",
        "/bin",
        "/cores",
        "/dev",
        "/etc",
        "/opt",
        "/private",
        "/private/etc",
        "/private/tmp",
        "/private/var",
        "/sbin",
        "/tmp",
        "/usr",
        "/var",
    ];

    let is_broad = BROAD_ROOTS.iter().any(|root| path == Path::new(root))
        || std::env::var_os("HOME")
            .map(|home| path == Path::new(&home))
            .unwrap_or(false);

    if is_broad {
        return Err(RuntimeError::PolicyViolation(format!(
            "{description} {} is too broad to be a policy boundary",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn containment_is_component_wise() {
        let root = Path::new("/Applications/Google Chrome.app");
        assert!(is_within(
            Path::new("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            root
        ));
        assert!(is_within(root, root));
        assert!(!is_within(
            Path::new("/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome"),
            root
        ));
    }

    #[test]
    fn broad_roots_are_rejected() {
        assert!(reject_overbroad_root(Path::new("/"), "data directory").is_err());
        assert!(reject_overbroad_root(Path::new("/Users"), "data directory").is_err());
        assert!(reject_overbroad_root(Path::new("/tmp"), "data directory").is_err());
    }

    #[test]
    fn home_subdirectories_are_allowed() {
        let home = match std::env::var_os("HOME") {
            Some(home) => home,
            None => return,
        };
        let home = Path::new(&home);
        assert!(reject_overbroad_root(home, "data directory").is_err());

        let data = home
            .join("Library")
            .join("Application Support")
            .join("Virealm")
            .join("environments")
            .join("demo");
        if data.exists() {
            assert!(reject_overbroad_root(&data, "data directory").is_ok());
        }
    }
}
