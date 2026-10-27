//! Test child used by process-runtime integration tests.
//!
//! It performs one observable action per flag, writes a small JSON report
//! without dumping the environment, and then optionally sleeps so the parent
//! can test tree termination.

use std::collections::BTreeMap;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Serialize;

fn main() {
    if let Err(error) = run() {
        eprintln!("virealm-test-child: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let options = parse()?;

    let mut report = Report {
        pid: std::process::id(),
        arguments: std::env::args_os()
            .skip(1)
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect(),
        working_directory: std::env::current_dir()
            .map(|path| path.display().to_string())
            .unwrap_or_default(),
        environment: BTreeMap::new(),
        reads: options
            .read_files
            .iter()
            .map(|path| read_file(path.as_path()))
            .collect(),
        writes: options
            .write_files
            .iter()
            .map(|path| write_file(path.as_path()))
            .collect(),
        allocate: options.allocate_bytes.map(allocate),
        connect: options.connect.map(connect),
        child_pid: None,
        child_error_code: None,
        exit_code: options.exit_code,
    };

    for name in options.environment_names {
        report
            .environment
            .insert(name.clone(), std::env::var(name).ok());
    }

    if options.spawn_child {
        match Command::new(std::env::current_exe()?)
            .args(["--sleep-ms", "60000"])
            .spawn()
        {
            Ok(child) => report.child_pid = Some(child.id()),
            Err(error) => report.child_error_code = error.raw_os_error(),
        }
    }

    if let Some(path) = options.report {
        let json = serde_json::to_vec_pretty(&report)?;
        std::fs::write(path, json)?;
    }

    if options.sleep_ms > 0 {
        std::thread::sleep(Duration::from_millis(options.sleep_ms));
    }

    if options.exit_code != 0 {
        std::process::exit(i32::from(options.exit_code));
    }
    Ok(())
}

struct Options {
    report: Option<PathBuf>,
    read_files: Vec<PathBuf>,
    write_files: Vec<PathBuf>,
    allocate_bytes: Option<usize>,
    connect: Option<SocketAddr>,
    environment_names: Vec<String>,
    spawn_child: bool,
    sleep_ms: u64,
    exit_code: u8,
}

fn parse() -> Result<Options, Box<dyn std::error::Error>> {
    let mut options = Options {
        report: None,
        read_files: Vec::new(),
        write_files: Vec::new(),
        allocate_bytes: None,
        connect: None,
        environment_names: Vec::new(),
        spawn_child: false,
        sleep_ms: 0,
        exit_code: 0,
    };

    let mut arguments = std::env::args_os().skip(1);
    while let Some(flag) = arguments.next() {
        let flag = flag.to_string_lossy().into_owned();
        match flag.as_str() {
            "--report" => options.report = Some(PathBuf::from(next(&mut arguments, &flag)?)),
            "--read-file" => {
                options
                    .read_files
                    .push(PathBuf::from(next(&mut arguments, &flag)?));
            }
            "--write-file" => {
                options
                    .write_files
                    .push(PathBuf::from(next(&mut arguments, &flag)?));
            }
            "--allocate-bytes" => {
                let value = next(&mut arguments, &flag)?;
                options.allocate_bytes = Some(value.to_string_lossy().parse()?);
            }
            "--connect" => {
                let value = next(&mut arguments, &flag)?;
                options.connect = Some(value.to_string_lossy().parse()?);
            }
            "--env" => {
                let value = next(&mut arguments, &flag)?;
                options
                    .environment_names
                    .push(value.to_string_lossy().into_owned());
            }
            "--spawn-child" => options.spawn_child = true,
            "--sleep-ms" => {
                let value = next(&mut arguments, &flag)?;
                options.sleep_ms = value.to_string_lossy().parse()?;
            }
            "--exit-code" => {
                let value = next(&mut arguments, &flag)?;
                options.exit_code = value.to_string_lossy().parse()?;
            }
            other => return Err(format!("unknown flag: {other}").into()),
        }
    }

    Ok(options)
}

fn next(
    arguments: &mut impl Iterator<Item = std::ffi::OsString>,
    flag: &str,
) -> Result<std::ffi::OsString, Box<dyn std::error::Error>> {
    arguments
        .next()
        .ok_or_else(|| format!("{flag} requires a value").into())
}

fn read_file(path: &Path) -> FileResult {
    match std::fs::read(path) {
        Ok(bytes) => FileResult::success(path, bytes.len()),
        Err(error) => FileResult::failure(path, &error),
    }
}

fn write_file(path: &Path) -> FileResult {
    match std::fs::write(path, b"virealm-test") {
        Ok(()) => FileResult::success(path, 11),
        Err(error) => FileResult::failure(path, &error),
    }
}

#[cfg(windows)]
fn allocate(bytes: usize) -> AllocationResult {
    // SAFETY: a null address lets the allocator choose the region; the size is
    // the caller's request. No pointer is dereferenced.
    let pointer = unsafe {
        windows_sys::Win32::System::Memory::VirtualAlloc(
            std::ptr::null(),
            bytes,
            windows_sys::Win32::System::Memory::MEM_COMMIT
                | windows_sys::Win32::System::Memory::MEM_RESERVE,
            windows_sys::Win32::System::Memory::PAGE_READWRITE,
        )
    };
    if pointer.is_null() {
        AllocationResult {
            ok: false,
            bytes,
            error_code: std::io::Error::last_os_error().raw_os_error(),
        }
    } else {
        AllocationResult {
            ok: true,
            bytes,
            error_code: None,
        }
    }
}

#[cfg(target_os = "macos")]
fn allocate(bytes: usize) -> AllocationResult {
    // SAFETY: an anonymous private mapping has no file descriptor; the kernel
    // chooses the address. The pointer is never dereferenced.
    let pointer = unsafe {
        libc::mmap(
            std::ptr::null_mut(),
            bytes,
            libc::PROT_READ | libc::PROT_WRITE,
            libc::MAP_ANON | libc::MAP_PRIVATE,
            -1,
            0,
        )
    };
    if pointer == libc::MAP_FAILED {
        AllocationResult {
            ok: false,
            bytes,
            error_code: std::io::Error::last_os_error().raw_os_error(),
        }
    } else {
        // The mapping is released when the child exits; tests only observe the
        // allocation result.
        AllocationResult {
            ok: true,
            bytes,
            error_code: None,
        }
    }
}

fn connect(address: SocketAddr) -> ConnectResult {
    match TcpStream::connect_timeout(&address, Duration::from_secs(2)) {
        Ok(_) => ConnectResult {
            ok: true,
            error_code: None,
        },
        Err(error) => ConnectResult {
            ok: false,
            error_code: error.raw_os_error(),
        },
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    pid: u32,
    arguments: Vec<String>,
    working_directory: String,
    environment: BTreeMap<String, Option<String>>,
    reads: Vec<FileResult>,
    writes: Vec<FileResult>,
    allocate: Option<AllocationResult>,
    connect: Option<ConnectResult>,
    child_pid: Option<u32>,
    child_error_code: Option<i32>,
    exit_code: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileResult {
    path: String,
    ok: bool,
    bytes: Option<usize>,
    error_code: Option<i32>,
}

impl FileResult {
    fn success(path: &Path, bytes: usize) -> Self {
        Self {
            path: path.display().to_string(),
            ok: true,
            bytes: Some(bytes),
            error_code: None,
        }
    }

    fn failure(path: &Path, error: &std::io::Error) -> Self {
        Self {
            path: path.display().to_string(),
            ok: false,
            bytes: None,
            error_code: error.raw_os_error(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AllocationResult {
    ok: bool,
    bytes: usize,
    error_code: Option<i32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectResult {
    ok: bool,
    error_code: Option<i32>,
}
