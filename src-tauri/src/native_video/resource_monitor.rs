use std::sync::{Arc, Mutex};
#[cfg(any(unix, windows))]
use std::time::Duration;
#[cfg(any(unix, windows))]
use std::time::Instant;

use tokio::sync::watch;
#[cfg(any(unix, windows))]
use tokio::time;

#[cfg(not(any(unix, windows)))]
use super::telemetry::TelemetrySnapshot;
#[cfg(any(unix, windows))]
use super::{
    constants::RESOURCE_SAMPLE_MS,
    telemetry::{update_telemetry, TelemetrySnapshot},
    util::now_millis,
};

#[cfg(any(unix, windows))]
pub(crate) fn spawn_resource_monitor(
    telemetry: Arc<Mutex<TelemetrySnapshot>>,
    telemetry_tx: watch::Sender<TelemetrySnapshot>,
) {
    tauri::async_runtime::spawn(async move {
        let mut monitor = ResourceMonitor::new();
        let mut interval = time::interval(Duration::from_millis(RESOURCE_SAMPLE_MS));

        loop {
            interval.tick().await;
            let sample = monitor.sample();
            update_telemetry(&telemetry, &telemetry_tx, |snapshot| {
                snapshot.sampled_at_ms = now_millis();
                snapshot.process_cpu_core_fraction = sample.cpu_core_fraction;
                snapshot.process_peak_cpu_core_fraction = sample.peak_cpu_core_fraction;
                snapshot.process_peak_rss_bytes = sample.peak_rss_bytes;
            });
        }
    });
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn spawn_resource_monitor(
    _telemetry: Arc<Mutex<TelemetrySnapshot>>,
    _telemetry_tx: watch::Sender<TelemetrySnapshot>,
) {
    eprintln!("native-video: resource monitor is only implemented on Unix and Windows platforms");
}

#[cfg(any(unix, windows))]
struct ResourceMonitor {
    last_at: Instant,
    last_cpu_us: u64,
    peak_cpu_core_fraction: f64,
}

#[cfg(any(unix, windows))]
struct ResourceSample {
    cpu_core_fraction: f64,
    peak_cpu_core_fraction: f64,
    peak_rss_bytes: u64,
}

#[cfg(any(unix, windows))]
impl ResourceMonitor {
    fn new() -> Self {
        let usage = process_usage();
        Self { last_at: Instant::now(), last_cpu_us: usage.cpu_us, peak_cpu_core_fraction: 0.0 }
    }

    fn sample(&mut self) -> ResourceSample {
        let now = Instant::now();
        let usage = process_usage();
        let elapsed_us = now.duration_since(self.last_at).as_micros().max(1) as f64;
        let cpu_delta_us = usage.cpu_us.saturating_sub(self.last_cpu_us) as f64;
        let cpu_core_fraction = cpu_delta_us / elapsed_us;
        self.peak_cpu_core_fraction = self.peak_cpu_core_fraction.max(cpu_core_fraction);
        self.last_at = now;
        self.last_cpu_us = usage.cpu_us;

        ResourceSample {
            cpu_core_fraction,
            peak_cpu_core_fraction: self.peak_cpu_core_fraction,
            peak_rss_bytes: usage.peak_rss_bytes,
        }
    }
}

struct ProcessUsage {
    cpu_us: u64,
    peak_rss_bytes: u64,
}

#[cfg(unix)]
fn process_usage() -> ProcessUsage {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
    if result != 0 {
        return ProcessUsage { cpu_us: 0, peak_rss_bytes: 0 };
    }

    let usage = unsafe { usage.assume_init() };
    let user_us = timeval_to_us(usage.ru_utime);
    let system_us = timeval_to_us(usage.ru_stime);

    #[cfg(target_os = "macos")]
    let peak_rss_bytes = usage.ru_maxrss.max(0) as u64;
    #[cfg(not(target_os = "macos"))]
    let peak_rss_bytes = usage.ru_maxrss.max(0) as u64 * 1024;

    ProcessUsage { cpu_us: user_us.saturating_add(system_us), peak_rss_bytes }
}

#[cfg(windows)]
fn process_usage() -> ProcessUsage {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};

    let process = unsafe { GetCurrentProcess() };

    let mut memory = unsafe { zeroed::<PROCESS_MEMORY_COUNTERS>() };
    memory.cb = size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    let peak_rss_bytes = if unsafe { GetProcessMemoryInfo(process, &mut memory, memory.cb) } != 0 {
        memory.PeakWorkingSetSize as u64
    } else {
        0
    };

    let mut creation_time = unsafe { zeroed::<FILETIME>() };
    let mut exit_time = unsafe { zeroed::<FILETIME>() };
    let mut kernel_time = unsafe { zeroed::<FILETIME>() };
    let mut user_time = unsafe { zeroed::<FILETIME>() };
    let cpu_us = if unsafe {
        GetProcessTimes(
            process,
            &mut creation_time,
            &mut exit_time,
            &mut kernel_time,
            &mut user_time,
        )
    } != 0
    {
        filetime_to_us(kernel_time).saturating_add(filetime_to_us(user_time))
    } else {
        0
    };

    ProcessUsage { cpu_us, peak_rss_bytes }
}

#[cfg(not(any(unix, windows)))]
fn process_usage() -> ProcessUsage {
    ProcessUsage { cpu_us: 0, peak_rss_bytes: 0 }
}

#[cfg(windows)]
fn filetime_to_us(time: windows_sys::Win32::Foundation::FILETIME) -> u64 {
    let ticks = ((time.dwHighDateTime as u64) << 32) | time.dwLowDateTime as u64;
    ticks / 10
}

#[cfg(unix)]
fn timeval_to_us(time: libc::timeval) -> u64 {
    (time.tv_sec.max(0) as u64).saturating_mul(1_000_000).saturating_add(time.tv_usec.max(0) as u64)
}
