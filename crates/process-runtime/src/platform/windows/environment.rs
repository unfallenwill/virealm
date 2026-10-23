//! Windows environment block construction.
//!
//! The child inherits the caller's environment and receives explicit
//! overrides. Names are matched case-insensitively, as Windows does. Values
//! are never logged.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows_sys::Win32::System::Environment::{FreeEnvironmentStringsW, GetEnvironmentStringsW};

use crate::error::{Result, RuntimeError};

/// Build a NUL-terminated UTF-16 environment block.
///
/// `temp_directory` is applied when the caller needs `TEMP`/`TMP` redirected
/// into an environment data directory (AppContainer launches).
pub fn build_block(
    overrides: &BTreeMap<OsString, OsString>,
    temp_directory: Option<&Path>,
) -> Result<Vec<u16>> {
    let inherited = read_inherited()?;
    let overrides: Vec<(Vec<u16>, Vec<u16>)> = overrides
        .iter()
        .map(|(key, value)| (key.encode_wide().collect(), value.encode_wide().collect()))
        .collect();

    let mut entries = merge_entries(inherited, &overrides);

    if let Some(directory) = temp_directory {
        let value: Vec<u16> = directory.as_os_str().encode_wide().collect();
        set_entry(&mut entries, &wide("TEMP"), value.clone());
        set_entry(&mut entries, &wide("TMP"), value);
    }

    Ok(render(entries))
}

fn read_inherited() -> Result<Vec<(Vec<u16>, Vec<u16>)>> {
    // SAFETY: GetEnvironmentStringsW returns a read-only block owned by the
    // process. It is freed exactly once below.
    let block = unsafe { GetEnvironmentStringsW() };
    if block.is_null() {
        return Err(RuntimeError::last_platform_error("GetEnvironmentStringsW"));
    }

    let mut entries = Vec::new();
    let mut cursor = block;
    // SAFETY: the block is NUL-separated and ends with an empty entry.
    unsafe {
        loop {
            let mut length = 0usize;
            while *cursor.add(length) != 0 {
                length += 1;
            }
            if length == 0 {
                break;
            }
            let entry = std::slice::from_raw_parts(cursor, length);
            if entry[0] != b'=' as u16 {
                if let Some(position) = entry.iter().position(|unit| *unit == b'=' as u16) {
                    entries.push((entry[..position].to_vec(), entry[position + 1..].to_vec()));
                }
            }
            cursor = cursor.add(length + 1);
        }
        FreeEnvironmentStringsW(block);
    }

    Ok(entries)
}

fn merge_entries(
    mut inherited: Vec<(Vec<u16>, Vec<u16>)>,
    overrides: &[(Vec<u16>, Vec<u16>)],
) -> Vec<(Vec<u16>, Vec<u16>)> {
    for (key, value) in overrides {
        set_entry(&mut inherited, key, value.clone());
    }
    inherited
}

fn set_entry(entries: &mut Vec<(Vec<u16>, Vec<u16>)>, key: &[u16], value: Vec<u16>) {
    if let Some(existing) = entries
        .iter_mut()
        .find(|(existing, _)| wide_eq_ignore_ascii_case(existing, key))
    {
        existing.1 = value;
    } else {
        entries.push((key.to_vec(), value));
    }
}

fn wide_eq_ignore_ascii_case(left: &[u16], right: &[u16]) -> bool {
    super::wide::slice_eq_ignore_ascii_case(left, right)
}

fn render(mut entries: Vec<(Vec<u16>, Vec<u16>)>) -> Vec<u16> {
    entries.sort_by_key(|(key, _)| {
        key.iter()
            .map(|unit| super::wide::to_ascii_uppercase(*unit))
            .collect::<Vec<u16>>()
    });

    let mut block = Vec::new();
    for (key, value) in entries {
        block.extend_from_slice(&key);
        block.push(b'=' as u16);
        block.extend_from_slice(&value);
        block.push(0);
    }
    block.push(0);
    block
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overrides_replace_case_insensitively() {
        let entries = merge_entries(
            vec![(wide("Path"), wide("old")), (wide("KEEP"), wide("1"))],
            &[(wide("PATH"), wide("new"))],
        );

        assert_eq!(entries.len(), 2);
        let path = entries
            .iter()
            .find(|(key, _)| wide_eq_ignore_ascii_case(key, &wide("Path")))
            .expect("path entry");
        assert_eq!(path.1, wide("new"));
    }

    #[test]
    fn overrides_append_missing_entries() {
        let entries = merge_entries(Vec::new(), &[(wide("NEW"), wide("value"))]);
        assert_eq!(entries, vec![(wide("NEW"), wide("value"))]);
    }

    #[test]
    fn rendering_is_sorted_and_double_terminated() {
        let block = render(vec![(wide("B"), wide("2")), (wide("A"), wide("1"))]);
        let text = String::from_utf16(&block).expect("utf-16");
        assert_eq!(text, "A=1\0B=2\0\0");
    }

    #[test]
    fn temp_overrides_apply_to_both_variables() {
        let mut entries = Vec::new();
        let value = wide(r"C:\data\Temp");
        set_entry(&mut entries, &wide("TEMP"), value.clone());
        set_entry(&mut entries, &wide("TMP"), value.clone());

        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|(_, existing)| *existing == value));
    }
}
