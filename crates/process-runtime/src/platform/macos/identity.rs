//! Process identity on macOS.
//!
//! A PID alone is not an identity: the kernel reuses PIDs. The pair of PID and
//! process start time is stable for as long as the process exists. macOS
//! exposes the start time through `proc_pidinfo(PROC_PIDTBSDINFO)`; the runtime
//! converts it to the same 100-nanosecond-since-1601 value Windows reports so
//! the wire contract keeps one identity type.

use std::mem::size_of;

use crate::error::{Result, RuntimeError};
use crate::process::ProcessId;

/// Seconds between 1601-01-01 and 1970-01-01.
const FILETIME_EPOCH_OFFSET_100NS: u64 = 116_444_736_000_000_000;

/// Read the durable identity of `pid`.
pub(crate) fn process_id(pid: i32) -> Result<ProcessId> {
    if pid <= 0 {
        return Err(RuntimeError::Internal(format!("invalid process id {pid}")));
    }

    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: `info` is a correctly sized proc_bsdinfo and `pid` is positive.
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    if written != size {
        return Err(RuntimeError::last_platform_error("proc_pidinfo"));
    }

    let creation_time_100ns = start_time_100ns(&info)?;
    Ok(ProcessId {
        pid: pid as u32,
        creation_time_100ns,
    })
}

/// Convert the BSD start time to 100-nanosecond intervals since 1601.
pub(crate) fn start_time_100ns(info: &libc::proc_bsdinfo) -> Result<u64> {
    let seconds = info.pbi_start_tvsec;
    let microseconds = info.pbi_start_tvusec;

    if seconds == 0 && microseconds == 0 {
        return Err(RuntimeError::Internal(
            "proc_pidinfo returned a zero start time".into(),
        ));
    }

    let since_1601 = seconds
        .checked_mul(10_000_000)
        .and_then(|value| value.checked_add(microseconds.checked_mul(10)?))
        .and_then(|value| value.checked_add(FILETIME_EPOCH_OFFSET_100NS))
        .ok_or_else(|| {
            RuntimeError::Internal("process start time does not fit in 100ns units".into())
        })?;

    Ok(since_1601)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info_with(seconds: u64, microseconds: u64) -> libc::proc_bsdinfo {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        info.pbi_start_tvsec = seconds;
        info.pbi_start_tvusec = microseconds;
        info
    }

    #[test]
    fn start_time_uses_the_filetime_epoch() {
        // 2026-01-15T00:00:00Z = 1768435200 seconds since 1970.
        let value = start_time_100ns(&info_with(1_768_435_200, 0)).expect("start time");
        assert_eq!(value, 134_129_088_000_000_000);
        assert_eq!(
            (value / 10_000) as i64 - 11_644_473_600_000,
            1_768_435_200_000
        );
    }

    #[test]
    fn microseconds_are_preserved() {
        let value = start_time_100ns(&info_with(1_768_435_200, 123_456)).expect("start time");
        assert_eq!(value % 10_000_000, 1_234_560);
    }

    #[test]
    fn zero_start_time_is_rejected() {
        assert!(start_time_100ns(&info_with(0, 0)).is_err());
    }

    #[test]
    fn current_process_has_an_identity() {
        let id = process_id(std::process::id() as i32).expect("identity");
        assert_eq!(id.pid, std::process::id());
        assert!(id.creation_time_100ns > 116_444_736_000_000_000);
    }
}
