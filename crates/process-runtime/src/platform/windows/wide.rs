//! ASCII-only helpers for Windows UTF-16 data.
//!
//! Windows path and environment-name comparisons are case-insensitive. These
//! helpers normalize ASCII letters without allocating a UTF-8 copy; non-ASCII
//! code units compare exactly.

/// Case-insensitive comparison of one UTF-16 code unit for ASCII letters.
pub fn eq_ignore_ascii_case(left: u16, right: u16) -> bool {
    left == right
        || (left < 128 && right < 128 && (left as u8).eq_ignore_ascii_case(&(right as u8)))
}

/// Uppercase an ASCII letter; other code units are unchanged.
pub fn to_ascii_uppercase(unit: u16) -> u16 {
    if (u16::from(b'a')..=u16::from(b'z')).contains(&unit) {
        unit - 32
    } else {
        unit
    }
}

/// Case-insensitive equality for UTF-16 slices.
pub fn slice_eq_ignore_ascii_case(left: &[u16], right: &[u16]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .all(|(left, right)| eq_ignore_ascii_case(*left, *right))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_case_is_ignored() {
        assert!(slice_eq_ignore_ascii_case(&[b'A' as u16], &[b'a' as u16]));
        assert!(!slice_eq_ignore_ascii_case(&[b'A' as u16], &[b'b' as u16]));
    }

    #[test]
    fn non_ascii_units_compare_exactly() {
        assert!(slice_eq_ignore_ascii_case(&[0x73AF], &[0x73AF]));
        assert!(!slice_eq_ignore_ascii_case(&[0x73AF], &[0x73AF + 1]));
    }

    #[test]
    fn uppercase_only_touches_ascii_lowercase() {
        assert_eq!(to_ascii_uppercase(b'z' as u16), b'Z' as u16);
        assert_eq!(to_ascii_uppercase(b'Z' as u16), b'Z' as u16);
        assert_eq!(to_ascii_uppercase(0x73AF), 0x73AF);
    }
}
