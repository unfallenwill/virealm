//! Windows command-line construction.
//!
//! Arguments are quoted with the algorithm used by the Microsoft C runtime:
//! backslashes are only special immediately before a quote, and trailing
//! backslashes are doubled before the closing quote. Callers pass individual
//! arguments; the runtime never accepts a pre-joined command string.

use std::ffi::{OsStr, OsString};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

/// Build a NUL-terminated UTF-16 command line.
pub fn build_command_line(executable: &Path, arguments: &[OsString]) -> Vec<u16> {
    let mut line: Vec<u16> = Vec::new();
    append_argument(&mut line, executable.as_os_str());
    for argument in arguments {
        line.push(b' ' as u16);
        append_argument(&mut line, argument);
    }
    line.push(0);
    line
}

fn append_argument(line: &mut Vec<u16>, argument: &OsStr) {
    let argument: Vec<u16> = argument.encode_wide().collect();

    if argument.is_empty() {
        line.extend_from_slice(&[b'"' as u16, b'"' as u16]);
        return;
    }

    let needs_quotes = argument.iter().any(
        |unit| matches!(*unit, u if u == b' ' as u16 || u == b'\t' as u16 || u == b'"' as u16),
    );

    if !needs_quotes {
        line.extend_from_slice(&argument);
        return;
    }

    line.push(b'"' as u16);
    let mut backslashes = 0usize;
    for unit in argument {
        match unit {
            u if u == b'\\' as u16 => backslashes += 1,
            u if u == b'"' as u16 => {
                line.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2 + 1));
                line.push(b'"' as u16);
                backslashes = 0;
            }
            other => {
                line.extend(std::iter::repeat_n(b'\\' as u16, backslashes));
                backslashes = 0;
                line.push(other);
            }
        }
    }
    line.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2));
    line.push(b'"' as u16);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(executable: &str, arguments: &[&str]) -> String {
        let arguments: Vec<OsString> = arguments.iter().map(OsString::from).collect();
        let line = build_command_line(Path::new(executable), &arguments);
        String::from_utf16(&line[..line.len() - 1]).expect("utf-16")
    }

    #[test]
    fn simple_arguments_are_not_quoted() {
        assert_eq!(
            render(r"C:\chrome.exe", &["--version"]),
            r"C:\chrome.exe --version"
        );
    }

    #[test]
    fn arguments_with_spaces_are_quoted() {
        assert_eq!(
            render(r"C:\chrome.exe", &[r"--user-data-dir=C:\a b"]),
            r#"C:\chrome.exe "--user-data-dir=C:\a b""#
        );
    }

    #[test]
    fn embedded_quotes_are_escaped() {
        assert_eq!(
            render("app.exe", &["say \"hi\""]),
            r#"app.exe "say \"hi\"""#
        );
    }

    #[test]
    fn trailing_backslashes_are_doubled_inside_quotes() {
        assert_eq!(
            render("app.exe", &[r"C:\path with space\"]),
            "app.exe \"C:\\path with space\\\\\""
        );
    }

    #[test]
    fn empty_argument_becomes_empty_quotes() {
        assert_eq!(render("app.exe", &[""]), "app.exe \"\"");
    }

    #[test]
    fn non_ascii_is_preserved() {
        assert_eq!(render("app.exe", &["--name=环境"]), "app.exe --name=环境");
    }
}
