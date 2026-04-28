use std::{
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use super::{
    constants::{BROKER_QUEUE_CAPACITY, SAFE_BUDGET_FACTOR},
    util::now_millis,
};

const DEFAULT_RAM_BANDWIDTH_BYTES_PER_SEC: f64 = 4.0 * 1024.0 * 1024.0 * 1024.0;
const RAM_BANDWIDTH_WARNING_FLOOR_BYTES_PER_SEC: f64 = 4.0 * 1024.0 * 1024.0 * 1024.0;
const PROFILE_MAX_AGE_MS: u64 = 7 * 24 * 60 * 60 * 1_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceProfile {
    pub schema_version: u32,
    pub base_case_validated: bool,
    pub calibrated_at_ms: Option<u64>,
    pub cpu_decode_budget_bytes_per_sec: u64,
    pub ipc_budget_bytes_per_sec: u64,
    #[serde(default = "default_ram_bandwidth_bytes_per_sec")]
    pub ram_bandwidth_bytes_per_sec: f64,
    pub ram_bandwidth_budget_bytes_per_sec: u64,
    pub safe_budget_bytes_per_sec: u64,
    pub decode_cost_factor: f64,
    pub upload_cost_factor: f64,
    pub composite_cost_factor: f64,
    pub max_ram_bytes: u64,
    pub max_vram_bytes: u64,
    pub broker_queue_capacity: usize,
    #[serde(default)]
    pub base_probe_frame_drop_rate: Option<f64>,
    #[serde(default)]
    pub base_probe_ipc_latency_p95_ms: Option<f64>,
    #[serde(default)]
    pub base_probe_ram_bandwidth_bytes_per_sec: Option<f64>,
    pub notes: Vec<String>,
}

impl PerformanceProfile {
    pub(crate) fn uncalibrated() -> Self {
        let mut profile = Self {
            schema_version: 1,
            base_case_validated: false,
            calibrated_at_ms: None,
            cpu_decode_budget_bytes_per_sec: 450 * 1024 * 1024,
            ipc_budget_bytes_per_sec: 300 * 1024 * 1024,
            ram_bandwidth_bytes_per_sec: DEFAULT_RAM_BANDWIDTH_BYTES_PER_SEC,
            ram_bandwidth_budget_bytes_per_sec: 0,
            safe_budget_bytes_per_sec: 0,
            decode_cost_factor: 1.0,
            upload_cost_factor: 1.0,
            composite_cost_factor: 0.15,
            max_ram_bytes: 768 * 1024 * 1024,
            max_vram_bytes: 768 * 1024 * 1024,
            broker_queue_capacity: BROKER_QUEUE_CAPACITY,
            base_probe_frame_drop_rate: None,
            base_probe_ipc_latency_p95_ms: None,
            base_probe_ram_bandwidth_bytes_per_sec: None,
            notes: vec![
                "Uncalibrated defaults only permit the highest-priority visible stream.".into(),
            ],
        };
        profile.recompute_safe_budget();
        profile
    }

    pub(crate) fn recompute_safe_budget(&mut self) {
        // RAM budget uses calibrated bandwidth instead of a hardcoded 2 GB/s constant.
        let b_ram = self.ram_bandwidth_bytes_per_sec * SAFE_BUDGET_FACTOR;
        // The 0.8 factor reserves 20% headroom for the OS, compositor, browser, and non-video app work.
        let limiting_budget = self
            .cpu_decode_budget_bytes_per_sec
            .min(self.ipc_budget_bytes_per_sec)
            .min(b_ram.max(0.0) as u64);
        self.ram_bandwidth_budget_bytes_per_sec = b_ram.max(0.0) as u64;
        self.safe_budget_bytes_per_sec = limiting_budget;
        if self.ram_bandwidth_bytes_per_sec < RAM_BANDWIDTH_WARNING_FLOOR_BYTES_PER_SEC {
            eprintln!(
                "native-video: calibrated RAM bandwidth {:.2} GB/s is below the 4 GB/s warning floor",
                self.ram_bandwidth_bytes_per_sec / 1_000_000_000.0
            );
        }
    }

    pub(crate) fn should_measure_ram_bandwidth(&self) -> bool {
        if std::env::args().any(|arg| arg == "--recalibrate") {
            return true;
        }

        if self.base_probe_ram_bandwidth_bytes_per_sec.is_none()
            || !self.ram_bandwidth_bytes_per_sec.is_finite()
            || self.ram_bandwidth_bytes_per_sec <= 0.0
        {
            return true;
        }

        let Some(calibrated_at_ms) = self.calibrated_at_ms else {
            return true;
        };

        now_millis().saturating_sub(calibrated_at_ms) > PROFILE_MAX_AGE_MS
    }
}

impl Default for PerformanceProfile {
    fn default() -> Self {
        Self::uncalibrated()
    }
}

pub(crate) fn bounded_factor(latency_ms: f64, frame_budget_ms: f64) -> f64 {
    if !latency_ms.is_finite() || latency_ms <= 0.0 {
        return 1.0;
    }

    (latency_ms / frame_budget_ms).clamp(0.1, 4.0)
}

fn default_ram_bandwidth_bytes_per_sec() -> f64 {
    DEFAULT_RAM_BANDWIDTH_BYTES_PER_SEC
}

pub(crate) fn measure_ram_bandwidth() -> f64 {
    // Base-case calibration measures sequential memory copy bandwidth.
    // Common hardware should land around 4-80 GB/s; below 4 GB/s the budget path emits a warning.
    const COPY_BYTES: usize = 256 * 1024 * 1024;
    let src = vec![0xa5_u8; COPY_BYTES];
    let mut dst = vec![0_u8; COPY_BYTES];
    let mut samples = [0.0_f64; 3];

    for sample in &mut samples {
        let started = Instant::now();
        dst.copy_from_slice(&src);
        let elapsed = started.elapsed().max(Duration::from_nanos(1));
        *sample = COPY_BYTES as f64 / elapsed.as_secs_f64();
        std::hint::black_box(&dst);
    }

    samples.sort_by(f64::total_cmp);
    samples[1]
}

pub(crate) fn profile_path<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("sigma"))
        .join("native-video-profile.json")
}

pub(crate) fn load_profile(path: &PathBuf) -> Option<PerformanceProfile> {
    let bytes = fs::read(path).ok()?;
    let mut profile: PerformanceProfile = serde_json::from_slice(&bytes).ok()?;
    profile.recompute_safe_budget();
    Some(profile)
}

pub(crate) fn persist_profile(path: &PathBuf, profile: &PerformanceProfile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create native video profile directory: {err}"))?;
    }

    let bytes = serde_json::to_vec_pretty(profile)
        .map_err(|err| format!("failed to serialize native video profile: {err}"))?;
    fs::write(path, bytes).map_err(|err| format!("failed to persist native video profile: {err}"))
}
