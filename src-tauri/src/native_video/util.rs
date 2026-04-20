use std::time::{SystemTime, UNIX_EPOCH};

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
    ((len as f64 * 0.95).ceil() as usize)
        .saturating_sub(1)
        .min(len.saturating_sub(1))
}
