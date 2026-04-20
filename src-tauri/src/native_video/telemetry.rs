use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::sync::watch;

use super::util::now_millis;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySnapshot {
    pub sampled_at_ms: u64,
    pub process_cpu_core_fraction: f64,
    pub process_peak_cpu_core_fraction: f64,
    pub process_peak_rss_bytes: u64,
    pub visible_streams: usize,
    pub active_streams: usize,
    pub suspended_streams: usize,
    pub delivered_frames: u64,
    pub dropped_frames: u64,
    pub broker_queue_depth: usize,
    pub broker_queue_capacity: usize,
    pub broker_queue_pressure: f64,
    pub frame_drop_rate: f64,
    pub safe_budget_bytes_per_sec: u64,
    pub predicted_cost_bytes_per_sec: u64,
    pub over_budget: bool,
}

pub(crate) fn update_telemetry(
    telemetry: &Arc<Mutex<TelemetrySnapshot>>,
    telemetry_tx: &watch::Sender<TelemetrySnapshot>,
    update: impl FnOnce(&mut TelemetrySnapshot),
) {
    let Ok(mut snapshot) = telemetry.lock() else {
        return;
    };
    update(&mut snapshot);
    snapshot.sampled_at_ms = now_millis();
    let _ = telemetry_tx.send(snapshot.clone());
}
