//! Minimal command-line adapter over the process runtime.
//!
//! This binary exists to exercise the public API from an external caller. It
//! deliberately keeps parsing simple and does not become a second policy
//! implementation.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use virealm_process_runtime::ipc::{DEFAULT_PIPE_NAME, serve};
use virealm_process_runtime::{
    AccessLevel, AccessRoot, CONTRACT_VERSION, ContainmentLimits, FileAccessPolicy, IsolationMode,
    LaunchSpec, NetworkAccess, PROTOCOL_VERSION, SecurityPolicy, launch, probe_capabilities,
    validate_launch_spec,
};

const USAGE: &str = "\
Usage:
  virealm-runtime probe
  virealm-runtime serve [--pipe <name>]
  virealm-runtime run --environment-id <id> --isolation <managed|restricted|app-container>
      --executable <path> --program-root <dir> [--program-root <dir> ...]
      --data-directory <dir> [--working-directory <dir>]
      [--arg <value> ...] [--env KEY=VALUE ...]
      [--network <allow|deny>]
      [--file-access <read-only|read-write>] [--access-root <dir=read-only|read-write> ...]
      [--max-processes <n>] [--memory-limit <bytes>] [--timeout-ms <n>]
";

fn main() -> ExitCode {
    let arguments: Vec<OsString> = std::env::args_os().skip(1).collect();
    match parse(arguments) {
        Ok(Command::Help) => {
            print!("{USAGE}");
            ExitCode::SUCCESS
        }
        Ok(Command::Probe) => match probe() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("virealm-runtime: {error}");
                ExitCode::FAILURE
            }
        },
        Ok(Command::Serve(pipe)) => match serve(&pipe) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("virealm-runtime: {error}");
                ExitCode::FAILURE
            }
        },
        Ok(Command::Run(options)) => match run(*options) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("virealm-runtime: {error}");
                ExitCode::FAILURE
            }
        },
        Err(message) => {
            eprintln!("virealm-runtime: {message}\n\n{USAGE}");
            ExitCode::from(2)
        }
    }
}

enum Command {
    Help,
    Probe,
    Serve(String),
    Run(Box<RunOptions>),
}

struct RunOptions {
    environment_id: String,
    isolation: IsolationMode,
    executable: PathBuf,
    program_roots: Vec<PathBuf>,
    data_directory: PathBuf,
    working_directory: Option<PathBuf>,
    arguments: Vec<OsString>,
    environment: BTreeMap<OsString, OsString>,
    network: NetworkAccess,
    file_access: Option<AccessLevel>,
    access_roots: Vec<AccessRoot>,
    max_processes: Option<u32>,
    memory_limit_bytes: Option<u64>,
    timeout: Option<Duration>,
}

fn parse(mut arguments: Vec<OsString>) -> Result<Command, String> {
    let Some(command) = arguments.first() else {
        return Ok(Command::Help);
    };
    let command = command
        .to_str()
        .ok_or_else(|| "command must be valid UTF-8".to_owned())?;

    match command {
        "probe" => {
            if arguments.len() != 1 {
                return Err("probe takes no arguments".into());
            }
            Ok(Command::Probe)
        }
        "run" => {
            arguments.remove(0);
            parse_run(arguments).map(|options| Command::Run(Box::new(options)))
        }
        "serve" => {
            arguments.remove(0);
            let mut pipe = DEFAULT_PIPE_NAME.to_owned();
            while let Some(flag) = arguments.first() {
                let flag = flag
                    .to_str()
                    .ok_or_else(|| "flags must be valid UTF-8".to_owned())?;
                match flag {
                    "--pipe" => {
                        arguments.remove(0);
                        pipe = arguments
                            .first()
                            .ok_or_else(|| "--pipe requires a value".to_owned())?
                            .to_str()
                            .ok_or_else(|| "--pipe requires a valid UTF-8 value".to_owned())?
                            .to_owned();
                        arguments.remove(0);
                    }
                    other => return Err(format!("unknown serve flag: {other}")),
                }
            }
            Ok(Command::Serve(pipe))
        }
        "-h" | "--help" | "help" => Ok(Command::Help),
        other => Err(format!("unknown command: {other}")),
    }
}

fn parse_run(arguments: Vec<OsString>) -> Result<RunOptions, String> {
    let mut cursor = arguments.into_iter();

    let mut environment_id = None;
    let mut isolation = None;
    let mut executable = None;
    let mut program_roots = Vec::new();
    let mut data_directory = None;
    let mut working_directory = None;
    let mut argument_list = Vec::new();
    let mut environment = BTreeMap::new();
    let mut network = NetworkAccess::Allow;
    let mut file_access = None;
    let mut access_roots = Vec::new();
    let mut max_processes = None;
    let mut memory_limit_bytes = None;
    let mut timeout = None;

    while let Some(flag) = cursor.next() {
        let flag = flag
            .to_str()
            .ok_or_else(|| "flags must be valid UTF-8".to_owned())?
            .to_owned();

        match flag.as_str() {
            "--environment-id" => environment_id = Some(take_string(&mut cursor, &flag)?),
            "--isolation" => {
                isolation = Some(parse_isolation(&take_string(&mut cursor, &flag)?)?);
            }
            "--executable" => executable = Some(PathBuf::from(take_os(&mut cursor, &flag)?)),
            "--program-root" => program_roots.push(PathBuf::from(take_os(&mut cursor, &flag)?)),
            "--data-directory" => {
                data_directory = Some(PathBuf::from(take_os(&mut cursor, &flag)?))
            }
            "--working-directory" => {
                working_directory = Some(PathBuf::from(take_os(&mut cursor, &flag)?));
            }
            "--arg" => argument_list.push(take_os(&mut cursor, &flag)?),
            "--env" => {
                let value = take_string(&mut cursor, &flag)?;
                let (key, value) = value
                    .split_once('=')
                    .ok_or_else(|| "--env requires KEY=VALUE".to_owned())?;
                if key.is_empty() {
                    return Err("--env requires a non-empty key".into());
                }
                environment.insert(OsString::from(key), OsString::from(value));
            }
            "--network" => network = parse_network(&take_string(&mut cursor, &flag)?)?,
            "--file-access" => {
                file_access = Some(parse_access(&take_string(&mut cursor, &flag)?)?);
            }
            "--access-root" => {
                let value = take_string(&mut cursor, &flag)?;
                let (path, access) = value
                    .rsplit_once('=')
                    .ok_or_else(|| "--access-root requires PATH=read-only|read-write".to_owned())?;
                access_roots.push(AccessRoot {
                    path: PathBuf::from(path),
                    access: parse_access(access)?,
                });
            }
            "--max-processes" => {
                max_processes = Some(parse_u32(&take_string(&mut cursor, &flag)?, &flag)?);
            }
            "--memory-limit" => {
                memory_limit_bytes = Some(parse_u64(&take_string(&mut cursor, &flag)?, &flag)?);
            }
            "--timeout-ms" => {
                timeout = Some(Duration::from_millis(parse_u64(
                    &take_string(&mut cursor, &flag)?,
                    &flag,
                )?));
            }
            other => return Err(format!("unknown flag: {other}")),
        }
    }

    let isolation = isolation.ok_or_else(|| "--isolation is required".to_owned())?;
    let executable = executable.ok_or_else(|| "--executable is required".to_owned())?;
    let data_directory = data_directory.ok_or_else(|| "--data-directory is required".to_owned())?;
    if program_roots.is_empty() {
        return Err("at least one --program-root is required".into());
    }
    if isolation != IsolationMode::AppContainer
        && (file_access.is_some() || !access_roots.is_empty())
    {
        return Err("restricted file access is only available in app_container mode".into());
    }

    Ok(RunOptions {
        environment_id: environment_id.ok_or_else(|| "--environment-id is required".to_owned())?,
        isolation,
        executable,
        program_roots,
        data_directory,
        working_directory,
        arguments: argument_list,
        environment,
        network,
        file_access,
        access_roots,
        max_processes,
        memory_limit_bytes,
        timeout,
    })
}

fn take_os(cursor: &mut impl Iterator<Item = OsString>, flag: &str) -> Result<OsString, String> {
    cursor
        .next()
        .ok_or_else(|| format!("{flag} requires a value"))
}

fn take_string(cursor: &mut impl Iterator<Item = OsString>, flag: &str) -> Result<String, String> {
    take_os(cursor, flag)?
        .into_string()
        .map_err(|_| format!("{flag} requires a valid UTF-8 value"))
}

fn parse_isolation(value: &str) -> Result<IsolationMode, String> {
    match value {
        "managed" => Ok(IsolationMode::Managed),
        "restricted" => Ok(IsolationMode::Restricted),
        "app-container" => Ok(IsolationMode::AppContainer),
        other => Err(format!("unknown isolation mode: {other}")),
    }
}

fn parse_network(value: &str) -> Result<NetworkAccess, String> {
    match value {
        "allow" => Ok(NetworkAccess::Allow),
        "deny" => Ok(NetworkAccess::Deny),
        other => Err(format!("unknown network policy: {other}")),
    }
}

fn parse_access(value: &str) -> Result<AccessLevel, String> {
    match value {
        "read-only" => Ok(AccessLevel::ReadOnly),
        "read-write" => Ok(AccessLevel::ReadWrite),
        other => Err(format!("unknown access level: {other}")),
    }
}

fn parse_u32(value: &str, flag: &str) -> Result<u32, String> {
    value
        .parse()
        .map_err(|_| format!("{flag} requires a non-negative integer"))
}

fn parse_u64(value: &str, flag: &str) -> Result<u64, String> {
    value
        .parse()
        .map_err(|_| format!("{flag} requires a non-negative integer"))
}

fn probe() -> Result<(), Box<dyn std::error::Error>> {
    let report = probe_capabilities();
    let value = serde_json::json!({
        "protocolVersion": PROTOCOL_VERSION,
        "contractVersion": CONTRACT_VERSION,
        "capabilities": report,
    });
    write_json(&value)
}

fn run(options: RunOptions) -> Result<(), Box<dyn std::error::Error>> {
    let file_access = match options.isolation {
        IsolationMode::AppContainer => FileAccessPolicy::Restricted {
            data_directory: options.file_access.unwrap_or(AccessLevel::ReadWrite),
            additional_roots: options.access_roots,
        },
        IsolationMode::Managed | IsolationMode::Restricted => FileAccessPolicy::Inherited,
    };

    let spec = LaunchSpec {
        environment_id: options.environment_id,
        executable: options.executable,
        arguments: options.arguments,
        working_directory: options.working_directory,
        environment_overrides: options.environment,
        data_directory: options.data_directory,
        policy: SecurityPolicy {
            isolation: options.isolation,
            allowed_program_roots: options.program_roots,
            file_access,
            network_access: options.network,
            containment: ContainmentLimits {
                kill_on_close: true,
                max_processes: options.max_processes,
                memory_limit_bytes: options.memory_limit_bytes,
            },
        },
    };

    validate_launch_spec(&spec)?;
    let mut process = launch(&spec)?;
    let launched = process.status()?;

    let wait_for = options
        .timeout
        .unwrap_or_else(|| Duration::from_millis(u64::from(u32::MAX)));
    let status = process.wait(wait_for)?;
    if status.is_running() {
        process.terminate()?;
    }
    // Even after a normal exit, terminate the job so children are gone before
    // the status is reported.
    let final_status = process.terminate()?;

    let value = serde_json::json!({
        "launched": launched,
        "final": final_status,
        "diagnostics": process.diagnostics(),
    });
    write_json(&value)
}

fn write_json(value: &serde_json::Value) -> Result<(), Box<dyn std::error::Error>> {
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    serde_json::to_writer_pretty(&mut lock, value)?;
    use std::io::Write;
    writeln!(lock)?;
    Ok(())
}
