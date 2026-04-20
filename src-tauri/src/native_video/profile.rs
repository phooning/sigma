use std::{fs, path::PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::constants::{BROKER_QUEUE_CAPACITY, SAFE_BUDGET_FACTOR};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceProfile {
    pub schema_version: u32,
    pub base_case_validated: bool,
    pub calibrated_at_ms: Option<u64>,
    pub cpu_decode_budget_bytes_per_sec: u64,
    pub ipc_budget_bytes_per_sec: u64,
    pub ram_bandwidth_budget_bytes_per_sec: u64,
    pub safe_budget_bytes_per_sec: u64,
    pub decode_cost_factor: f64,
    pub upload_cost_factor: f64,
    pub composite_cost_factor: f64,
    pub max_ram_bytes: u64,
    pub max_vram_bytes: u64,
    pub broker_queue_capacity: usize,
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
            ram_bandwidth_budget_bytes_per_sec: 2 * 1024 * 1024 * 1024,
            safe_budget_bytes_per_sec: 0,
            decode_cost_factor: 1.0,
            upload_cost_factor: 1.0,
            composite_cost_factor: 0.15,
            max_ram_bytes: 768 * 1024 * 1024,
            max_vram_bytes: 768 * 1024 * 1024,
            broker_queue_capacity: BROKER_QUEUE_CAPACITY,
            notes: vec![
                "Uncalibrated defaults only permit the highest-priority visible stream.".into(),
            ],
        };
        profile.recompute_safe_budget();
        profile
    }

    pub(crate) fn recompute_safe_budget(&mut self) {
        let limiting_budget = self
            .cpu_decode_budget_bytes_per_sec
            .min(self.ipc_budget_bytes_per_sec)
            .min(self.ram_bandwidth_budget_bytes_per_sec);
        self.safe_budget_bytes_per_sec = (SAFE_BUDGET_FACTOR * limiting_budget as f64) as u64;
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

pub(crate) fn profile_path(app: &AppHandle) -> PathBuf {
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
