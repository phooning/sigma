use std::time::{SystemTime, UNIX_EPOCH};

// Stream IDs use 64-bit FNV-1 with offset basis `0xcbf29ce484222325` and prime
// `0x100000001b3` over the UTF-8 bytes of the source string. Keep this exact contract in sync
// with any TypeScript or tooling implementation that needs to reproduce native IDs.
pub(crate) fn stable_stream_id(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

pub(crate) fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn p95_index(len: usize) -> usize {
    ((len as f64 * 0.95).ceil() as usize).saturating_sub(1).min(len.saturating_sub(1))
}

pub(crate) fn even_dimension(value: u32) -> u32 {
    value.saturating_sub(value % 2).max(2)
}
