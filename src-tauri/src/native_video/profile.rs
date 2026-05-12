use std::{
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};

#[cfg(target_os = "linux")]
use std::ffi::{c_uint, c_void, CString};

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
    #[serde(default)]
    pub vram_budget_bytes: u64,
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
            vram_budget_bytes: 0,
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
                "Uncalibrated defaults only permit the highest-priority visible stream.".into()
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
        self.vram_budget_bytes = (self.max_vram_bytes as f64 * SAFE_BUDGET_FACTOR).max(0.0) as u64;
        self.safe_budget_bytes_per_sec = limiting_budget;
        if self.ram_bandwidth_bytes_per_sec < RAM_BANDWIDTH_WARNING_FLOOR_BYTES_PER_SEC {
            eprintln!(
                "native-video: calibrated RAM bandwidth {:.2} GB/s is below the 4 GB/s warning floor",
                self.ram_bandwidth_bytes_per_sec / 1_000_000_000.0
            );
        }
    }

    pub(crate) fn max_active_streams(&self) -> usize {
        if self.base_case_validated {
            return super::constants::SCALING_MAX_STREAMS_AFTER_VALIDATION;
        }

        if self.base_probe_ram_bandwidth_bytes_per_sec.is_some()
            && self.base_probe_ipc_latency_p95_ms.is_some()
            && self.base_probe_frame_drop_rate.is_some()
        {
            return super::constants::SOFT_CALIBRATED_MAX_STREAMS_WITH_FRONTEND_METRICS;
        }

        if self.base_probe_ram_bandwidth_bytes_per_sec.is_some()
            || self.base_probe_ipc_latency_p95_ms.is_some()
            || self.base_probe_frame_drop_rate.is_some()
        {
            return super::constants::SOFT_CALIBRATED_MAX_STREAMS_WITH_PROBE;
        }

        super::constants::BASE_CASE_MAX_STREAMS_BEFORE_VALIDATION
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

    (latency_ms / frame_budget_ms).clamp(0.1, 8.0)
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

pub(crate) fn detect_max_vram_bytes() -> Option<u64> {
    detect_max_vram_bytes_inner().filter(|bytes| *bytes > 0)
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {}

#[cfg(target_os = "macos")]
fn detect_max_vram_bytes_inner() -> Option<u64> {
    use objc2::rc::Retained;
    use objc2_metal::{MTLCreateSystemDefaultDevice, MTLDevice};

    let device = unsafe { Retained::from_raw(MTLCreateSystemDefaultDevice())? };
    Some(device.recommendedMaxWorkingSetSize())
}

#[cfg(target_os = "linux")]
fn detect_max_vram_bytes_inner() -> Option<u64> {
    type NvmlReturn = i32;
    type NvmlDevice = *mut c_void;
    const NVML_SUCCESS: NvmlReturn = 0;

    #[repr(C)]
    struct NvmlMemory {
        total: u64,
        free: u64,
        used: u64,
    }

    unsafe fn load_symbol<T: Copy>(handle: *mut c_void, symbol: &str) -> Option<T> {
        let symbol = CString::new(symbol).ok()?;
        let address = unsafe { libc::dlsym(handle, symbol.as_ptr()) };
        if address.is_null() {
            return None;
        }

        Some(unsafe { std::mem::transmute_copy::<*mut c_void, T>(&address) })
    }

    let libraries = ["libnvidia-ml.so.1", "libnvidia-ml.so"];
    let handle = libraries.iter().find_map(|library| {
        let library = CString::new(*library).ok()?;
        let handle = unsafe { libc::dlopen(library.as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL) };
        (!handle.is_null()).then_some(handle)
    })?;

    let result = (|| unsafe {
        let init_v2: unsafe extern "C" fn() -> NvmlReturn = load_symbol(handle, "nvmlInit_v2")?;
        let shutdown: unsafe extern "C" fn() -> NvmlReturn = load_symbol(handle, "nvmlShutdown")?;
        let device_get_count_v2: unsafe extern "C" fn(*mut c_uint) -> NvmlReturn =
            load_symbol(handle, "nvmlDeviceGetCount_v2")?;
        let device_get_handle_by_index_v2: unsafe extern "C" fn(
            c_uint,
            *mut NvmlDevice,
        ) -> NvmlReturn = load_symbol(handle, "nvmlDeviceGetHandleByIndex_v2")?;
        let device_get_memory_info: unsafe extern "C" fn(
            NvmlDevice,
            *mut NvmlMemory,
        ) -> NvmlReturn = load_symbol(handle, "nvmlDeviceGetMemoryInfo")?;

        if init_v2() != NVML_SUCCESS {
            return None;
        }

        let mut count = 0_u32;
        if device_get_count_v2(&mut count) != NVML_SUCCESS {
            let _ = shutdown();
            return None;
        }

        let mut max_total = 0_u64;
        for index in 0..count {
            let mut device = std::ptr::null_mut();
            if device_get_handle_by_index_v2(index, &mut device) != NVML_SUCCESS {
                continue;
            }

            let mut memory = NvmlMemory { total: 0, free: 0, used: 0 };
            if device_get_memory_info(device, &mut memory) == NVML_SUCCESS {
                max_total = max_total.max(memory.total);
            }
        }

        let _ = shutdown();
        Some(max_total)
    })();

    unsafe {
        libc::dlclose(handle);
    }

    result
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn detect_max_vram_bytes_inner() -> Option<u64> {
    None
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

#[cfg(test)]
mod tests {
    use super::{bounded_factor, PerformanceProfile};

    #[test]
    fn bounded_factor_allows_higher_backpressure_before_capping() {
        assert_eq!(bounded_factor(64.0, 16.667), 64.0 / 16.667);
        assert_eq!(bounded_factor(200.0, 16.667), 8.0);
    }

    #[test]
    fn recompute_safe_budget_updates_vram_budget_bytes() {
        let mut profile = PerformanceProfile::uncalibrated();
        profile.max_vram_bytes = 1_000;
        profile.recompute_safe_budget();

        assert_eq!(profile.vram_budget_bytes, 800);
    }

    #[test]
    fn max_active_streams_stages_calibration_progressively() {
        let mut profile = PerformanceProfile::uncalibrated();
        assert_eq!(profile.max_active_streams(), 1);

        profile.base_probe_ipc_latency_p95_ms = Some(4.0);
        assert_eq!(profile.max_active_streams(), 2);

        profile.base_probe_ram_bandwidth_bytes_per_sec = Some(8_000_000_000.0);
        profile.base_probe_frame_drop_rate = Some(0.02);
        assert_eq!(profile.max_active_streams(), 4);

        profile.base_case_validated = true;
        assert_eq!(profile.max_active_streams(), 32);
    }
}
