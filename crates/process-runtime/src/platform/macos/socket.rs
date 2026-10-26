//! Unix domain socket transport for the wire protocol.
//!
//! The socket lives in `$TMPDIR`, is created with mode 0600, and every accepted
//! connection is checked with `LOCAL_PEERCRED`: only clients running as the
//! same effective user are served.
//!
//! Single instance is enforced with `flock` on a sidecar lock file, not with
//! the socket itself. A stale socket left by a crashed runtime is removed only
//! while the lock is held, so two starting runtimes cannot both delete and bind.
//! The socket is deliberately not unlinked on normal exit: the next instance
//! cleans it up under the lock, and removing it on exit would race a client
//! that is about to connect.

use std::env;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;

use crate::ipc::{RuntimeState, handle_connection};

const SOCKET_NAME: &str = "virealm-runtime-v2.sock";

/// `sun_path` is 104 bytes on macOS and the terminator needs one of them.
const MAX_SOCKET_PATH_BYTES: usize = 100;

/// Default endpoint: `$TMPDIR/virealm-runtime-v2.sock`.
pub(crate) fn default_address() -> String {
    let directory = env::var_os("TMPDIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    directory.join(SOCKET_NAME).to_string_lossy().into_owned()
}

/// Run the socket server until the process exits.
pub(crate) fn serve(address: &str) -> io::Result<()> {
    let path = validate_address(address)?;
    let _lock = acquire_lock(&path)?;
    remove_stale_socket(&path)?;

    let listener = UnixListener::bind(&path)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;

    eprintln!("virealm-runtime: listening on {}", path.display());
    let state = Arc::new(RuntimeState::new());

    loop {
        let stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        if !peer_is_same_user(&stream) {
            eprintln!("virealm-runtime: rejected a client from another user");
            continue;
        }

        let state = Arc::clone(&state);
        thread::spawn(move || {
            let _ = handle_connection(stream, &state);
        });
    }
}

/// Exercise bind, connect and peer credentials in a temporary path.
pub(crate) fn selftest() -> io::Result<()> {
    let path = env::temp_dir().join(format!(
        "virealm-runtime-selftest-{}.sock",
        std::process::id()
    ));
    let path = validate_address(&path.to_string_lossy())?;
    let _ = fs::remove_file(&path);
    let _ = fs::remove_file(lock_path(&path));

    let listener = UnixListener::bind(&path)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    let result = (|| {
        let _client = UnixStream::connect(&path)?;
        let (server, _) = listener.accept()?;
        if !peer_is_same_user(&server) {
            return Err(io::Error::other(
                "peer credentials did not identify this user",
            ));
        }
        Ok(())
    })();

    drop(listener);
    let _ = fs::remove_file(&path);
    let _ = fs::remove_file(lock_path(&path));
    result
}

fn validate_address(address: &str) -> io::Result<PathBuf> {
    let path = PathBuf::from(address);
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the runtime socket path must be absolute",
        ));
    }
    if path.as_os_str().as_bytes().contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the runtime socket path must not contain NUL",
        ));
    }
    if path.as_os_str().as_bytes().len() > MAX_SOCKET_PATH_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "the runtime socket path must be at most {MAX_SOCKET_PATH_BYTES} bytes: {}",
                path.display()
            ),
        ));
    }
    Ok(path)
}

fn lock_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".lock");
    PathBuf::from(name)
}

/// Hold an exclusive lock for the lifetime of the server.
fn acquire_lock(path: &Path) -> io::Result<File> {
    let lock = lock_path(path);
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(&lock)?;

    // SAFETY: `file` is an open file descriptor; flock does not retain it.
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result != 0 {
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::WouldBlock {
            return Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                "another virealm runtime server already owns this endpoint",
            ));
        }
        return Err(error);
    }
    Ok(file)
}

/// Remove a socket left behind by a runtime that is no longer running.
///
/// Runs only while holding the lock. A socket that accepts a connection means
/// a live server owns it; anything that is not a socket is never deleted.
fn remove_stale_socket(path: &Path) -> io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };

    if !metadata.file_type().is_socket() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("{} exists and is not a Unix domain socket", path.display()),
        ));
    }

    match UnixStream::connect(path) {
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::AddrInUse,
            "another virealm runtime server is listening",
        )),
        Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => {
            fs::remove_file(path)?;
            Ok(())
        }
        Err(error) => Err(error),
    }
}

fn peer_is_same_user(stream: &UnixStream) -> bool {
    // SAFETY: geteuid has no preconditions.
    peer_uid(stream).is_some_and(|uid| uid == unsafe { libc::geteuid() })
}

fn peer_uid(stream: &UnixStream) -> Option<libc::uid_t> {
    let mut credentials: libc::xucred = unsafe { std::mem::zeroed() };
    let mut length = std::mem::size_of::<libc::xucred>() as libc::socklen_t;
    // SAFETY: the buffer is a correctly sized xucred and `length` describes it.
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERCRED,
            (&mut credentials as *mut libc::xucred).cast(),
            &mut length,
        )
    };
    if result != 0 {
        return None;
    }
    Some(credentials.cr_uid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_address_lives_in_the_temp_directory() {
        let address = default_address();
        assert!(Path::new(&address).is_absolute());
        assert!(address.ends_with(SOCKET_NAME));
    }

    #[test]
    fn relative_and_overlong_paths_are_rejected() {
        assert!(validate_address("virealm.sock").is_err());
        let long = format!("/tmp/{}", "a".repeat(MAX_SOCKET_PATH_BYTES));
        assert!(validate_address(&long).is_err());
    }

    #[test]
    fn lock_path_appends_a_suffix() {
        assert_eq!(
            lock_path(Path::new("/tmp/runtime.sock")),
            PathBuf::from("/tmp/runtime.sock.lock")
        );
    }

    #[test]
    fn selftest_round_trips() {
        selftest().expect("socket self test");
    }
}
