use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    AppHandle, Manager, State,
};
use tokio::{
    io::AsyncReadExt,
    process::Command as TokioCommand,
    sync::{broadcast, mpsc, oneshot, watch},
    time,
};

const RESOURCE_SAMPLE_MS: u64 = 150;
const BROKER_QUEUE_CAPACITY: usize = 96;
const FRAME_BROADCAST_CAPACITY: usize = 32;
const FRAME_PACKET_HEADER_LEN: usize = 64;
const FRAME_PACKET_MAGIC: &[u8; 4] = b"SVF1";
const BYTES_PER_PIXEL_RGBA8: u64 = 4;
const SAFE_BUDGET_FACTOR: f64 = 0.8;
const BASE_CASE_MAX_STREAMS_BEFORE_VALIDATION: usize = 1;
const SCALING_MAX_STREAMS_AFTER_VALIDATION: usize = 32;
const DOWNGRADE_QUEUE_PRESSURE: f64 = 0.65;
const DOWNGRADE_DROP_RATE: f64 = 0.03;
const UPGRADE_QUEUE_PRESSURE: f64 = 0.25;
const UPGRADE_HEADROOM: f64 = 0.25;
const MIN_UPGRADE_DWELL_MS: u64 = 2_000;
const MIN_DOWNGRADE_DWELL_MS: u64 = 800;
const MATERIAL_OVERSAMPLE: f64 = 1.15;

#[derive(Clone)]
pub struct NativeVideoState {
    control_tx: mpsc::Sender<ControlMessage>,
    frame_tx: broadcast::Sender<Arc<[u8]>>,
    telemetry_tx: watch::Sender<TelemetrySnapshot>,
    telemetry: Arc<Mutex<TelemetrySnapshot>>,
    profile: Arc<Mutex<PerformanceProfile>>,
    profile_path: PathBuf,
}

impl NativeVideoState {
    pub fn new(app: &AppHandle) -> Self {
        let profile_path = profile_path(app);
        let profile_snapshot =
            load_profile(&profile_path).unwrap_or_else(PerformanceProfile::uncalibrated);
        let initial_telemetry = TelemetrySnapshot {
            broker_queue_capacity: BROKER_QUEUE_CAPACITY,
            safe_budget_bytes_per_sec: profile_snapshot.safe_budget_bytes_per_sec,
            ..TelemetrySnapshot::default()
        };
        let profile = Arc::new(Mutex::new(profile_snapshot));
        let telemetry = Arc::new(Mutex::new(initial_telemetry.clone()));
        let (telemetry_tx, _) = watch::channel(initial_telemetry);
        let (frame_tx, _) = broadcast::channel(FRAME_BROADCAST_CAPACITY);
        let (broker_tx, broker_rx) = mpsc::channel(BROKER_QUEUE_CAPACITY);
        let (control_tx, control_rx) = mpsc::channel(64);

        spawn_resource_monitor(telemetry.clone(), telemetry_tx.clone());
        spawn_frame_broker(
            broker_rx,
            frame_tx.clone(),
            telemetry.clone(),
            telemetry_tx.clone(),
        );
        spawn_controller(
            control_rx,
            broker_tx,
            telemetry.clone(),
            telemetry_tx.clone(),
            profile.clone(),
        );

        Self {
            control_tx,
            frame_tx,
            telemetry_tx,
            telemetry,
            profile,
            profile_path,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasManifest {
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub viewport_zoom: f64,
    pub assets: Vec<VisibleAsset>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibleAsset {
    pub id: String,
    pub path: String,
    pub source_width: u32,
    pub source_height: u32,
    pub screen_x: f64,
    pub screen_y: f64,
    pub rendered_width_px: f64,
    pub rendered_height_px: f64,
    pub visible_area_px: f64,
    pub focus_weight: f64,
    pub center_weight: f64,
    pub target_fps: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendMetrics {
    pub renderer: String,
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub upload_latency_p95_ms: f64,
    pub composite_latency_p95_ms: f64,
    pub frame_drop_rate: f64,
    pub measured_ipc_bytes_per_sec: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseCaseProbeConfig {
    pub source_path: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<u32>,
    pub frames: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseCaseProbeReport {
    pub decode_backend: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub frames_sent: u32,
    pub bytes_sent: u64,
    pub elapsed_ms: f64,
    pub measured_ipc_bytes_per_sec: u64,
    pub decode_latency_p95_ms: f64,
    pub send_latency_p95_ms: f64,
}

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
    fn uncalibrated() -> Self {
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

    fn recompute_safe_budget(&mut self) {
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerSnapshot {
    pub profile: PerformanceProfile,
    pub telemetry: TelemetrySnapshot,
    pub allocations: Vec<QualityDecision>,
    pub assumptions: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityDecision {
    pub asset_id: String,
    pub stream_id: u64,
    pub state: StreamState,
    pub tier: QualityTier,
    pub decode_width: u32,
    pub decode_height: u32,
    pub fps: u32,
    pub priority: f64,
    pub predicted_cost_bytes_per_sec: u64,
    pub last_changed_at_ms: u64,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamState {
    Active,
    Suspended,
    Thumbnail,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityTier {
    pub id: u8,
    pub name: &'static str,
    pub max_width: u32,
    pub max_height: u32,
}

const SUSPENDED_TIER: QualityTier = QualityTier {
    id: 0,
    name: "suspended",
    max_width: 0,
    max_height: 0,
};

const QUALITY_TIERS: [QualityTier; 6] = [
    QualityTier {
        id: 1,
        name: "thumb-144p",
        max_width: 256,
        max_height: 144,
    },
    QualityTier {
        id: 2,
        name: "low-240p",
        max_width: 426,
        max_height: 240,
    },
    QualityTier {
        id: 3,
        name: "canvas-480p",
        max_width: 854,
        max_height: 480,
    },
    QualityTier {
        id: 4,
        name: "detail-720p",
        max_width: 1280,
        max_height: 720,
    },
    QualityTier {
        id: 5,
        name: "focus-1080p",
        max_width: 1920,
        max_height: 1080,
    },
    QualityTier {
        id: 6,
        name: "native-2160p",
        max_width: 3840,
        max_height: 2160,
    },
];

#[derive(Debug)]
enum ControlMessage {
    UpdateManifest {
        manifest: CanvasManifest,
        respond_to: oneshot::Sender<ControllerSnapshot>,
    },
    StopAll {
        respond_to: oneshot::Sender<ControllerSnapshot>,
    },
}

#[derive(Clone, Debug)]
enum WorkerAssignment {
    Active {
        asset_id: String,
        stream_id: u64,
        width: u32,
        height: u32,
        fps: u32,
        tier_id: u8,
    },
    Suspended,
}

struct WorkerHandle {
    tx: watch::Sender<WorkerAssignment>,
    task: tauri::async_runtime::JoinHandle<()>,
}

struct DecodedFrame {
    packet: Vec<u8>,
}

#[tauri::command]
pub async fn native_video_get_profile(
    state: State<'_, NativeVideoState>,
) -> Result<PerformanceProfile, String> {
    Ok(state
        .profile
        .lock()
        .map_err(|_| "native video profile lock poisoned".to_string())?
        .clone())
}

#[tauri::command]
pub async fn native_video_update_manifest(
    state: State<'_, NativeVideoState>,
    manifest: CanvasManifest,
) -> Result<ControllerSnapshot, String> {
    let (respond_to, response) = oneshot::channel();
    state
        .control_tx
        .send(ControlMessage::UpdateManifest {
            manifest,
            respond_to,
        })
        .await
        .map_err(|_| "native video controller is not running".to_string())?;

    response
        .await
        .map_err(|_| "native video controller dropped the manifest response".to_string())
}

#[tauri::command]
pub async fn native_video_stop_all(
    state: State<'_, NativeVideoState>,
) -> Result<ControllerSnapshot, String> {
    let (respond_to, response) = oneshot::channel();
    state
        .control_tx
        .send(ControlMessage::StopAll { respond_to })
        .await
        .map_err(|_| "native video controller is not running".to_string())?;

    response
        .await
        .map_err(|_| "native video controller dropped the stop response".to_string())
}

#[tauri::command]
pub fn native_video_subscribe_frames(
    state: State<'_, NativeVideoState>,
    on_frame: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let mut rx = state.frame_tx.subscribe();

    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(packet) => {
                    if on_frame
                        .send(InvokeResponseBody::Raw(packet.as_ref().to_vec()))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn native_video_subscribe_telemetry(
    state: State<'_, NativeVideoState>,
    on_event: Channel<TelemetrySnapshot>,
) -> Result<(), String> {
    let mut rx = state.telemetry_tx.subscribe();

    tauri::async_runtime::spawn(async move {
        while rx.changed().await.is_ok() {
            if on_event.send(rx.borrow().clone()).is_err() {
                break;
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn native_video_record_frontend_metrics(
    state: State<'_, NativeVideoState>,
    metrics: FrontendMetrics,
) -> Result<PerformanceProfile, String> {
    let mut profile = state
        .profile
        .lock()
        .map_err(|_| "native video profile lock poisoned".to_string())?
        .clone();

    profile.ipc_budget_bytes_per_sec = profile
        .ipc_budget_bytes_per_sec
        .max(metrics.measured_ipc_bytes_per_sec);
    profile.upload_cost_factor = bounded_factor(metrics.upload_latency_p95_ms, 16.667);
    profile.composite_cost_factor = bounded_factor(metrics.composite_latency_p95_ms, 16.667);
    profile.base_case_validated = metrics.canvas_width >= 3840
        && metrics.canvas_height >= 2160
        && metrics.frame_drop_rate <= 0.01
        && metrics.composite_latency_p95_ms <= 8.0
        && metrics.upload_latency_p95_ms <= 8.0;
    profile.calibrated_at_ms = Some(now_millis());
    profile.notes = vec![
        format!("Frontend renderer: {}", metrics.renderer),
        "Base case validation requires 4K canvas metrics with <=1% drops and p95 upload/composite <=8ms each.".into(),
    ];
    profile.recompute_safe_budget();

    persist_profile(&state.profile_path, &profile)?;
    *state
        .profile
        .lock()
        .map_err(|_| "native video profile lock poisoned".to_string())? = profile.clone();

    update_telemetry(&state.telemetry, &state.telemetry_tx, |snapshot| {
        snapshot.safe_budget_bytes_per_sec = profile.safe_budget_bytes_per_sec;
    });

    Ok(profile)
}

#[tauri::command]
pub async fn native_video_reset_profile(
    state: State<'_, NativeVideoState>,
) -> Result<PerformanceProfile, String> {
    let profile = PerformanceProfile::uncalibrated();
    persist_profile(&state.profile_path, &profile)?;
    *state
        .profile
        .lock()
        .map_err(|_| "native video profile lock poisoned".to_string())? = profile.clone();
    Ok(profile)
}

#[tauri::command]
pub async fn native_video_run_base_case_probe(
    config: BaseCaseProbeConfig,
    on_frame: Channel<InvokeResponseBody>,
) -> Result<BaseCaseProbeReport, String> {
    let width = config.width.unwrap_or(3840).clamp(64, 3840);
    let height = config.height.unwrap_or(2160).clamp(64, 2160);
    let fps = config.fps.unwrap_or(60).clamp(1, 60);
    let frames = config.frames.unwrap_or(fps * 3).clamp(1, fps * 10);

    if let Some(source_path) = config
        .source_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        return run_ffmpeg_base_case_probe(source_path, width, height, fps, frames, on_frame).await;
    }

    let stream_id = stable_stream_id("base-case-probe");
    let mut decode_latencies = Vec::with_capacity(frames as usize);
    let mut send_latencies = Vec::with_capacity(frames as usize);
    let mut bytes_sent = 0_u64;
    let started = Instant::now();
    let mut interval = time::interval(Duration::from_secs_f64(1.0 / fps as f64));

    for sequence in 0..frames {
        interval.tick().await;
        let decode_started = Instant::now();
        let packet = make_frame_packet(
            stream_id,
            sequence as u64,
            sequence as u64 * 1_000_000 / fps as u64,
            width,
            height,
            6,
        );
        decode_latencies.push(decode_started.elapsed().as_secs_f64() * 1_000.0);
        bytes_sent += packet.len() as u64;
        let send_started = Instant::now();
        on_frame
            .send(InvokeResponseBody::Raw(packet))
            .map_err(|err| format!("failed to send base-case frame: {err}"))?;
        send_latencies.push(send_started.elapsed().as_secs_f64() * 1_000.0);
    }

    decode_latencies.sort_by(f64::total_cmp);
    send_latencies.sort_by(f64::total_cmp);
    let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
    let measured_ipc_bytes_per_sec = if elapsed_ms > 0.0 {
        ((bytes_sent as f64 / elapsed_ms) * 1_000.0) as u64
    } else {
        0
    };
    let p95_index = ((send_latencies.len() as f64 * 0.95).ceil() as usize)
        .saturating_sub(1)
        .min(send_latencies.len().saturating_sub(1));
    let decode_p95_index = ((decode_latencies.len() as f64 * 0.95).ceil() as usize)
        .saturating_sub(1)
        .min(decode_latencies.len().saturating_sub(1));

    Ok(BaseCaseProbeReport {
        decode_backend: "synthetic-rgba".into(),
        width,
        height,
        fps,
        frames_sent: frames,
        bytes_sent,
        elapsed_ms,
        measured_ipc_bytes_per_sec,
        decode_latency_p95_ms: decode_latencies
            .get(decode_p95_index)
            .copied()
            .unwrap_or(0.0),
        send_latency_p95_ms: send_latencies.get(p95_index).copied().unwrap_or(0.0),
    })
}

async fn run_ffmpeg_base_case_probe(
    source_path: &str,
    width: u32,
    height: u32,
    fps: u32,
    frames: u32,
    on_frame: Channel<InvokeResponseBody>,
) -> Result<BaseCaseProbeReport, String> {
    let stream_id = stable_stream_id(source_path);
    let payload_len = width as usize * height as usize * BYTES_PER_PIXEL_RGBA8 as usize;
    let mut child = TokioCommand::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-stream_loop",
            "-1",
            "-i",
            source_path,
            "-an",
            "-vf",
            &format!("fps={fps},scale={width}:{height}:flags=fast_bilinear,format=rgba"),
            "-frames:v",
            &frames.to_string(),
            "-f",
            "rawvideo",
            "pipe:1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("failed to start ffmpeg base-case probe: {err}"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or("ffmpeg base-case probe did not expose stdout")?;
    let mut decode_latencies = Vec::with_capacity(frames as usize);
    let mut send_latencies = Vec::with_capacity(frames as usize);
    let mut bytes_sent = 0_u64;
    let started = Instant::now();
    let mut interval = time::interval(Duration::from_secs_f64(1.0 / fps as f64));

    for sequence in 0..frames {
        interval.tick().await;
        let mut payload = vec![0_u8; payload_len];
        let decode_started = Instant::now();
        stdout
            .read_exact(&mut payload)
            .await
            .map_err(|err| format!("ffmpeg ended before the base-case probe completed: {err}"))?;
        decode_latencies.push(decode_started.elapsed().as_secs_f64() * 1_000.0);

        let packet = make_frame_packet_from_payload(
            stream_id,
            sequence as u64,
            sequence as u64 * 1_000_000 / fps as u64,
            width,
            height,
            6,
            &payload,
        );
        bytes_sent += packet.len() as u64;

        let send_started = Instant::now();
        on_frame
            .send(InvokeResponseBody::Raw(packet))
            .map_err(|err| format!("failed to send ffmpeg base-case frame: {err}"))?;
        send_latencies.push(send_started.elapsed().as_secs_f64() * 1_000.0);
    }

    let status = child
        .wait()
        .await
        .map_err(|err| format!("failed to wait for ffmpeg base-case probe: {err}"))?;
    if !status.success() {
        return Err(format!("ffmpeg base-case probe failed with status {status}"));
    }

    decode_latencies.sort_by(f64::total_cmp);
    send_latencies.sort_by(f64::total_cmp);
    let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
    let measured_ipc_bytes_per_sec = if elapsed_ms > 0.0 {
        ((bytes_sent as f64 / elapsed_ms) * 1_000.0) as u64
    } else {
        0
    };
    let decode_p95_index = ((decode_latencies.len() as f64 * 0.95).ceil() as usize)
        .saturating_sub(1)
        .min(decode_latencies.len().saturating_sub(1));
    let send_p95_index = ((send_latencies.len() as f64 * 0.95).ceil() as usize)
        .saturating_sub(1)
        .min(send_latencies.len().saturating_sub(1));

    Ok(BaseCaseProbeReport {
        decode_backend: "ffmpeg-rawvideo-rgba".into(),
        width,
        height,
        fps,
        frames_sent: frames,
        bytes_sent,
        elapsed_ms,
        measured_ipc_bytes_per_sec,
        decode_latency_p95_ms: decode_latencies
            .get(decode_p95_index)
            .copied()
            .unwrap_or(0.0),
        send_latency_p95_ms: send_latencies
            .get(send_p95_index)
            .copied()
            .unwrap_or(0.0),
    })
}

fn spawn_controller(
    mut control_rx: mpsc::Receiver<ControlMessage>,
    broker_tx: mpsc::Sender<DecodedFrame>,
    telemetry: Arc<Mutex<TelemetrySnapshot>>,
    telemetry_tx: watch::Sender<TelemetrySnapshot>,
    profile: Arc<Mutex<PerformanceProfile>>,
) {
    tauri::async_runtime::spawn(async move {
        let mut manifest = CanvasManifest {
            canvas_width: 0,
            canvas_height: 0,
            viewport_zoom: 1.0,
            assets: Vec::new(),
        };
        let mut allocations: HashMap<u64, QualityDecision> = HashMap::new();
        let mut workers: HashMap<u64, WorkerHandle> = HashMap::new();

        while let Some(message) = control_rx.recv().await {
            match message {
                ControlMessage::UpdateManifest {
                    manifest: next_manifest,
                    respond_to,
                } => {
                    manifest = next_manifest;
                    let profile_snapshot = profile
                        .lock()
                        .map(|profile| profile.clone())
                        .unwrap_or_default();
                    let telemetry_snapshot = telemetry
                        .lock()
                        .map(|snapshot| snapshot.clone())
                        .unwrap_or_default();
                    let next_allocations =
                        Arbiter::allocate(&manifest, &profile_snapshot, &telemetry_snapshot, &allocations);

                    reconcile_workers(&mut workers, &next_allocations, broker_tx.clone());
                    allocations = next_allocations
                        .iter()
                        .cloned()
                        .map(|allocation| (allocation.stream_id, allocation))
                        .collect();

                    let predicted_cost = allocations
                        .values()
                        .map(|allocation| allocation.predicted_cost_bytes_per_sec)
                        .sum();
                    let active_streams = allocations
                        .values()
                        .filter(|allocation| allocation.state == StreamState::Active)
                        .count();
                    let suspended_streams = allocations
                        .values()
                        .filter(|allocation| allocation.state != StreamState::Active)
                        .count();

                    update_telemetry(&telemetry, &telemetry_tx, |snapshot| {
                        snapshot.visible_streams = manifest.assets.len();
                        snapshot.active_streams = active_streams;
                        snapshot.suspended_streams = suspended_streams;
                        snapshot.predicted_cost_bytes_per_sec = predicted_cost;
                        snapshot.safe_budget_bytes_per_sec = profile_snapshot.safe_budget_bytes_per_sec;
                        snapshot.over_budget = predicted_cost > profile_snapshot.safe_budget_bytes_per_sec;
                    });

                    let snapshot = controller_snapshot(
                        &profile_snapshot,
                        &telemetry,
                        allocations.values().cloned().collect(),
                    );
                    let _ = respond_to.send(snapshot);
                }
                ControlMessage::StopAll { respond_to } => {
                    for worker in workers.drain().map(|(_, worker)| worker) {
                        worker.task.abort();
                    }
                    allocations.clear();
                    manifest.assets.clear();
                    let profile_snapshot = profile
                        .lock()
                        .map(|profile| profile.clone())
                        .unwrap_or_default();
                    update_telemetry(&telemetry, &telemetry_tx, |snapshot| {
                        snapshot.visible_streams = 0;
                        snapshot.active_streams = 0;
                        snapshot.suspended_streams = 0;
                        snapshot.predicted_cost_bytes_per_sec = 0;
                        snapshot.over_budget = false;
                    });
                    let snapshot = controller_snapshot(&profile_snapshot, &telemetry, Vec::new());
                    let _ = respond_to.send(snapshot);
                }
            }
        }
    });
}

fn reconcile_workers(
    workers: &mut HashMap<u64, WorkerHandle>,
    allocations: &[QualityDecision],
    broker_tx: mpsc::Sender<DecodedFrame>,
) {
    let active_ids: HashSet<u64> = allocations.iter().map(|allocation| allocation.stream_id).collect();

    workers.retain(|stream_id, worker| {
        if active_ids.contains(stream_id) {
            true
        } else {
            worker.task.abort();
            false
        }
    });

    for allocation in allocations {
        let assignment = if allocation.state == StreamState::Active {
            WorkerAssignment::Active {
                asset_id: allocation.asset_id.clone(),
                stream_id: allocation.stream_id,
                width: allocation.decode_width,
                height: allocation.decode_height,
                fps: allocation.fps,
                tier_id: allocation.tier.id,
            }
        } else {
            WorkerAssignment::Suspended
        };

        if let Some(worker) = workers.get(&allocation.stream_id) {
            let _ = worker.tx.send(assignment);
            continue;
        }

        let (tx, rx) = watch::channel(assignment);
        let task = spawn_decode_worker(rx, broker_tx.clone());
        workers.insert(allocation.stream_id, WorkerHandle { tx, task });
    }
}

fn spawn_decode_worker(
    mut assignment_rx: watch::Receiver<WorkerAssignment>,
    broker_tx: mpsc::Sender<DecodedFrame>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut sequence = 0_u64;

        loop {
            let assignment = assignment_rx.borrow().clone();
            match assignment {
                WorkerAssignment::Suspended => {
                    if assignment_rx.changed().await.is_err() {
                        break;
                    }
                }
                WorkerAssignment::Active {
                    asset_id: _asset_id,
                    stream_id,
                    width,
                    height,
                    fps,
                    tier_id,
                } => {
                    let mut interval = time::interval(Duration::from_secs_f64(1.0 / fps.max(1) as f64));
                    loop {
                        tokio::select! {
                            changed = assignment_rx.changed() => {
                                if changed.is_err() {
                                    return;
                                }
                                break;
                            }
                            _ = interval.tick() => {
                                let packet = make_frame_packet(
                                    stream_id,
                                    sequence,
                                    sequence.saturating_mul(1_000_000) / fps.max(1) as u64,
                                    width,
                                    height,
                                    tier_id,
                                );
                                sequence = sequence.wrapping_add(1);
                                if broker_tx.try_send(DecodedFrame { packet }).is_err() {
                                    time::sleep(Duration::from_millis(4)).await;
                                }
                            }
                        }
                    }
                }
            }
        }
    })
}

fn spawn_frame_broker(
    mut frame_rx: mpsc::Receiver<DecodedFrame>,
    frame_tx: broadcast::Sender<Arc<[u8]>>,
    telemetry: Arc<Mutex<TelemetrySnapshot>>,
    telemetry_tx: watch::Sender<TelemetrySnapshot>,
) {
    tauri::async_runtime::spawn(async move {
        let mut delivered_frames = 0_u64;
        let mut dropped_frames = 0_u64;

        while let Some(frame) = frame_rx.recv().await {
            let queue_depth = frame_rx.len();
            match frame_tx.send(Arc::<[u8]>::from(frame.packet.into_boxed_slice())) {
                Ok(_) => delivered_frames = delivered_frames.saturating_add(1),
                Err(_) => dropped_frames = dropped_frames.saturating_add(1),
            }

            update_telemetry(&telemetry, &telemetry_tx, |snapshot| {
                snapshot.delivered_frames = delivered_frames;
                snapshot.dropped_frames = dropped_frames;
                snapshot.broker_queue_depth = queue_depth;
                snapshot.broker_queue_capacity = BROKER_QUEUE_CAPACITY;
                snapshot.broker_queue_pressure =
                    queue_depth as f64 / BROKER_QUEUE_CAPACITY.max(1) as f64;
                let total = delivered_frames + dropped_frames;
                snapshot.frame_drop_rate = if total == 0 {
                    0.0
                } else {
                    dropped_frames as f64 / total as f64
                };
            });
        }
    });
}

fn spawn_resource_monitor(
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

struct ResourceMonitor {
    last_at: Instant,
    last_cpu_us: u64,
    peak_cpu_core_fraction: f64,
}

struct ResourceSample {
    cpu_core_fraction: f64,
    peak_cpu_core_fraction: f64,
    peak_rss_bytes: u64,
}

impl ResourceMonitor {
    fn new() -> Self {
        let usage = process_usage();
        Self {
            last_at: Instant::now(),
            last_cpu_us: usage.cpu_us,
            peak_cpu_core_fraction: 0.0,
        }
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

fn process_usage() -> ProcessUsage {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
    if result != 0 {
        return ProcessUsage {
            cpu_us: 0,
            peak_rss_bytes: 0,
        };
    }

    let usage = unsafe { usage.assume_init() };
    let user_us = timeval_to_us(usage.ru_utime);
    let system_us = timeval_to_us(usage.ru_stime);

    #[cfg(target_os = "macos")]
    let peak_rss_bytes = usage.ru_maxrss.max(0) as u64;
    #[cfg(not(target_os = "macos"))]
    let peak_rss_bytes = usage.ru_maxrss.max(0) as u64 * 1024;

    ProcessUsage {
        cpu_us: user_us.saturating_add(system_us),
        peak_rss_bytes,
    }
}

fn timeval_to_us(time: libc::timeval) -> u64 {
    (time.tv_sec.max(0) as u64)
        .saturating_mul(1_000_000)
        .saturating_add(time.tv_usec.max(0) as u64)
}

struct Arbiter;

impl Arbiter {
    fn allocate(
        manifest: &CanvasManifest,
        profile: &PerformanceProfile,
        telemetry: &TelemetrySnapshot,
        previous: &HashMap<u64, QualityDecision>,
    ) -> Vec<QualityDecision> {
        let mut assets = manifest.assets.clone();
        assets.sort_by(|a, b| priority(b, manifest).total_cmp(&priority(a, manifest)));

        let now = now_millis();
        let max_active = if profile.base_case_validated {
            SCALING_MAX_STREAMS_AFTER_VALIDATION
        } else {
            BASE_CASE_MAX_STREAMS_BEFORE_VALIDATION
        };
        let overloaded = telemetry.broker_queue_pressure >= DOWNGRADE_QUEUE_PRESSURE
            || telemetry.frame_drop_rate >= DOWNGRADE_DROP_RATE
            || telemetry.predicted_cost_bytes_per_sec > profile.safe_budget_bytes_per_sec;
        let headroom = if profile.safe_budget_bytes_per_sec == 0 {
            0.0
        } else {
            1.0 - telemetry.predicted_cost_bytes_per_sec as f64
                / profile.safe_budget_bytes_per_sec as f64
        };
        let upgrades_allowed =
            headroom >= UPGRADE_HEADROOM && telemetry.broker_queue_pressure <= UPGRADE_QUEUE_PRESSURE;

        let mut total_cost = 0_u64;
        let mut active_count = 0_usize;
        let mut decisions = Vec::with_capacity(assets.len());

        for asset in assets {
            let stream_id = stable_stream_id(&asset.id);
            let asset_priority = priority(&asset, manifest);
            let previous_decision = previous.get(&stream_id);

            let candidate = if active_count < max_active {
                choose_candidate(&asset, profile, profile.safe_budget_bytes_per_sec.saturating_sub(total_cost))
            } else {
                None
            };

            let mut decision = if let Some((tier, width, height, cost)) = candidate {
                QualityDecision {
                    asset_id: asset.id.clone(),
                    stream_id,
                    state: StreamState::Active,
                    tier,
                    decode_width: width,
                    decode_height: height,
                    fps: asset.target_fps.clamp(1, 60),
                    priority: asset_priority,
                    predicted_cost_bytes_per_sec: cost,
                    last_changed_at_ms: now,
                    reason: "fits measured safe budget".into(),
                }
            } else {
                QualityDecision {
                    asset_id: asset.id.clone(),
                    stream_id,
                    state: if active_count < max_active {
                        StreamState::Thumbnail
                    } else {
                        StreamState::Suspended
                    },
                    tier: SUSPENDED_TIER,
                    decode_width: 0,
                    decode_height: 0,
                    fps: 0,
                    priority: asset_priority,
                    predicted_cost_bytes_per_sec: 0,
                    last_changed_at_ms: now,
                    reason: if profile.base_case_validated {
                        "budget exhausted or rendered pixel cap below minimum tier".into()
                    } else {
                        "base case is not validated; scaling remains gated".into()
                    },
                }
            };

            if let Some(previous) = previous_decision {
                decision = apply_hysteresis(previous, decision, overloaded, upgrades_allowed, now, profile);
            }

            if decision.state == StreamState::Active {
                total_cost = total_cost.saturating_add(decision.predicted_cost_bytes_per_sec);
                active_count += 1;
            }

            decisions.push(decision);
        }

        decisions
    }
}

fn choose_candidate(
    asset: &VisibleAsset,
    profile: &PerformanceProfile,
    remaining_budget: u64,
) -> Option<(QualityTier, u32, u32, u64)> {
    for tier in QUALITY_TIERS.iter().rev().copied() {
        let Some((width, height)) = tier_dimensions(asset, tier) else {
            continue;
        };
        let cost = tier_cost_bytes_per_sec(width, height, asset.target_fps.clamp(1, 60), profile);
        if cost <= remaining_budget {
            return Some((tier, width, height, cost));
        }
    }

    None
}

fn apply_hysteresis(
    previous: &QualityDecision,
    mut next: QualityDecision,
    overloaded: bool,
    upgrades_allowed: bool,
    now: u64,
    profile: &PerformanceProfile,
) -> QualityDecision {
    let dwell_ms = now.saturating_sub(previous.last_changed_at_ms);
    let previous_rank = previous.tier.id;
    let next_rank = next.tier.id;

    if next.state == previous.state && next_rank == previous_rank {
        next.last_changed_at_ms = previous.last_changed_at_ms;
        return next;
    }

    let is_upgrade = next_rank > previous_rank;
    let is_downgrade = next_rank < previous_rank || next.state != StreamState::Active;

    if is_upgrade && (!upgrades_allowed || dwell_ms < MIN_UPGRADE_DWELL_MS) {
        let previous_cost = previous.predicted_cost_bytes_per_sec;
        if previous_cost <= profile.safe_budget_bytes_per_sec {
            let mut held = previous.clone();
            held.reason = "held by upgrade hysteresis until explicit headroom and dwell time".into();
            return held;
        }
    }

    if is_downgrade && !overloaded && dwell_ms < MIN_DOWNGRADE_DWELL_MS {
        let mut held = previous.clone();
        held.reason = "held by downgrade hysteresis to avoid quality flapping".into();
        return held;
    }

    next.last_changed_at_ms = now;
    if is_downgrade && overloaded {
        next.reason = "downgraded after sustained queue, drop, or budget pressure".into();
    }
    next
}

fn priority(asset: &VisibleAsset, manifest: &CanvasManifest) -> f64 {
    let canvas_area = (manifest.canvas_width as f64 * manifest.canvas_height as f64).max(1.0);
    let area_score = (asset.visible_area_px.max(0.0) / canvas_area).sqrt().min(1.0);
    let focus = asset.focus_weight.clamp(0.0, 4.0);
    let center = asset.center_weight.clamp(0.0, 1.0);
    focus * 4.0 + center * 2.0 + area_score
}

fn tier_dimensions(asset: &VisibleAsset, tier: QualityTier) -> Option<(u32, u32)> {
    let source_width = asset.source_width.max(1) as f64;
    let source_height = asset.source_height.max(1) as f64;
    let rendered_cap_width = (asset.rendered_width_px * MATERIAL_OVERSAMPLE).max(1.0);
    let rendered_cap_height = (asset.rendered_height_px * MATERIAL_OVERSAMPLE).max(1.0);
    let cap_width = asset
        .source_width
        .max(1)
        .min(rendered_cap_width.floor() as u32);
    let cap_height = asset
        .source_height
        .max(1)
        .min(rendered_cap_height.floor() as u32);

    if cap_width < 64 || cap_height < 64 {
        return None;
    }

    let scale = (tier.max_width as f64 / source_width)
        .min(tier.max_height as f64 / source_height)
        .min(1.0);
    let width = even_dimension((source_width * scale).round() as u32).max(2);
    let height = even_dimension((source_height * scale).round() as u32).max(2);

    if width > cap_width || height > cap_height {
        return None;
    }

    Some((width, height))
}

fn even_dimension(value: u32) -> u32 {
    value.saturating_sub(value % 2).max(2)
}

fn tier_cost_bytes_per_sec(
    width: u32,
    height: u32,
    fps: u32,
    profile: &PerformanceProfile,
) -> u64 {
    let raw_bytes = width as u64
        * height as u64
        * BYTES_PER_PIXEL_RGBA8
        * fps.max(1) as u64;
    let factor = (profile.decode_cost_factor
        + profile.upload_cost_factor
        + profile.composite_cost_factor)
        .max(1.0);

    (raw_bytes as f64 * factor) as u64
}

fn make_frame_packet(
    stream_id: u64,
    sequence: u64,
    pts_us: u64,
    width: u32,
    height: u32,
    tier_id: u8,
) -> Vec<u8> {
    let stride = width.saturating_mul(BYTES_PER_PIXEL_RGBA8 as u32);
    let payload_len = stride as usize * height as usize;
    let mut packet = vec![0_u8; FRAME_PACKET_HEADER_LEN + payload_len];

    packet[0..4].copy_from_slice(FRAME_PACKET_MAGIC);
    packet[4] = 1;
    packet[5] = FRAME_PACKET_HEADER_LEN as u8;
    packet[6] = 1;
    packet[7] = 0;
    write_u64(&mut packet, 8, sequence);
    write_u64(&mut packet, 16, pts_us);
    write_u64(&mut packet, 24, stream_id);
    write_u32(&mut packet, 32, width);
    write_u32(&mut packet, 36, height);
    write_u32(&mut packet, 40, stride);
    write_u32(&mut packet, 44, payload_len as u32);
    write_u16(&mut packet, 48, tier_id as u16);
    write_u16(&mut packet, 50, 0);
    write_u32(&mut packet, 52, 0);
    write_u32(&mut packet, 56, width);
    write_u32(&mut packet, 60, height);

    fill_synthetic_rgba(&mut packet[FRAME_PACKET_HEADER_LEN..], width, height, sequence, stream_id);
    packet
}

fn make_frame_packet_from_payload(
    stream_id: u64,
    sequence: u64,
    pts_us: u64,
    width: u32,
    height: u32,
    tier_id: u8,
    payload: &[u8],
) -> Vec<u8> {
    let stride = width.saturating_mul(BYTES_PER_PIXEL_RGBA8 as u32);
    let payload_len = stride as usize * height as usize;
    let mut packet = vec![0_u8; FRAME_PACKET_HEADER_LEN + payload_len];

    packet[0..4].copy_from_slice(FRAME_PACKET_MAGIC);
    packet[4] = 1;
    packet[5] = FRAME_PACKET_HEADER_LEN as u8;
    packet[6] = 1;
    packet[7] = 0;
    write_u64(&mut packet, 8, sequence);
    write_u64(&mut packet, 16, pts_us);
    write_u64(&mut packet, 24, stream_id);
    write_u32(&mut packet, 32, width);
    write_u32(&mut packet, 36, height);
    write_u32(&mut packet, 40, stride);
    write_u32(&mut packet, 44, payload_len as u32);
    write_u16(&mut packet, 48, tier_id as u16);
    write_u16(&mut packet, 50, 0);
    write_u32(&mut packet, 52, 0);
    write_u32(&mut packet, 56, width);
    write_u32(&mut packet, 60, height);
    packet[FRAME_PACKET_HEADER_LEN..].copy_from_slice(&payload[..payload_len]);
    packet
}

fn fill_synthetic_rgba(payload: &mut [u8], width: u32, height: u32, sequence: u64, stream_id: u64) {
    let r_base = (stream_id & 0xff) as u8;
    let g_base = ((stream_id >> 8) & 0xff) as u8;
    let b_base = ((stream_id >> 16) & 0xff) as u8;
    let motion = (sequence % 255) as u8;
    let width = width as usize;
    let height = height as usize;

    for y in 0..height {
        let row = y * width * 4;
        for x in 0..width {
            let offset = row + x * 4;
            payload[offset] = r_base.wrapping_add((x as u8).wrapping_add(motion));
            payload[offset + 1] = g_base.wrapping_add((y as u8).wrapping_sub(motion));
            payload[offset + 2] = b_base.wrapping_add(((x + y) as u8) / 2);
            payload[offset + 3] = 255;
        }
    }
}

fn write_u16(packet: &mut [u8], offset: usize, value: u16) {
    packet[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn write_u32(packet: &mut [u8], offset: usize, value: u32) {
    packet[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn write_u64(packet: &mut [u8], offset: usize, value: u64) {
    packet[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

fn controller_snapshot(
    profile: &PerformanceProfile,
    telemetry: &Arc<Mutex<TelemetrySnapshot>>,
    allocations: Vec<QualityDecision>,
) -> ControllerSnapshot {
    let telemetry = telemetry
        .lock()
        .map(|snapshot| snapshot.clone())
        .unwrap_or_default();
    let assumptions = if profile.base_case_validated {
        vec![
            "Budgets are measured on this machine and capped at 80% of the limiting subsystem.".into(),
            "Decode/upload factors are calibrated by base-case frontend telemetry.".into(),
        ]
    } else {
        vec![
            "Scaling is gated until base-case calibration validates a 4K presentation path.".into(),
            "CPU and memory samples are process-local rusage values; VRAM must be provided by platform telemetry.".into(),
        ]
    };

    ControllerSnapshot {
        profile: profile.clone(),
        telemetry,
        allocations,
        assumptions,
    }
}

fn update_telemetry(
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

fn bounded_factor(latency_ms: f64, frame_budget_ms: f64) -> f64 {
    if !latency_ms.is_finite() || latency_ms <= 0.0 {
        return 1.0;
    }

    (latency_ms / frame_budget_ms).clamp(0.1, 4.0)
}

fn profile_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("sigma"))
        .join("native-video-profile.json")
}

fn load_profile(path: &PathBuf) -> Option<PerformanceProfile> {
    let bytes = fs::read(path).ok()?;
    let mut profile: PerformanceProfile = serde_json::from_slice(&bytes).ok()?;
    profile.recompute_safe_budget();
    Some(profile)
}

fn persist_profile(path: &PathBuf, profile: &PerformanceProfile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create native video profile directory: {err}"))?;
    }

    let bytes = serde_json::to_vec_pretty(profile)
        .map_err(|err| format!("failed to serialize native video profile: {err}"))?;
    fs::write(path, bytes).map_err(|err| format!("failed to persist native video profile: {err}"))
}

fn stable_stream_id(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile_with_budget(budget: u64, validated: bool) -> PerformanceProfile {
        PerformanceProfile {
            base_case_validated: validated,
            safe_budget_bytes_per_sec: budget,
            cpu_decode_budget_bytes_per_sec: budget,
            ipc_budget_bytes_per_sec: budget,
            ram_bandwidth_budget_bytes_per_sec: budget,
            ..PerformanceProfile::uncalibrated()
        }
    }

    fn asset(id: usize, width: f64, height: f64, focus_weight: f64) -> VisibleAsset {
        VisibleAsset {
            id: format!("asset-{id}"),
            path: format!("/tmp/asset-{id}.mp4"),
            source_width: 3840,
            source_height: 2160,
            screen_x: 0.0,
            screen_y: 0.0,
            rendered_width_px: width,
            rendered_height_px: height,
            visible_area_px: width * height,
            focus_weight,
            center_weight: 0.5,
            target_fps: 60,
        }
    }

    #[test]
    fn rendered_pixel_cap_keeps_equal_32_way_tiles_below_4k() {
        let manifest = CanvasManifest {
            canvas_width: 3840,
            canvas_height: 2160,
            viewport_zoom: 1.0,
            assets: (0..32).map(|index| asset(index, 480.0, 270.0, 1.0)).collect(),
        };
        let profile = profile_with_budget(20 * 1024 * 1024 * 1024, true);
        let decisions = Arbiter::allocate(
            &manifest,
            &profile,
            &TelemetrySnapshot::default(),
            &HashMap::new(),
        );

        assert_eq!(decisions.len(), 32);
        assert!(decisions
            .iter()
            .all(|decision| decision.decode_width <= 426 && decision.decode_height <= 240));
    }

    #[test]
    fn scaling_is_gated_until_base_case_is_validated() {
        let manifest = CanvasManifest {
            canvas_width: 3840,
            canvas_height: 2160,
            viewport_zoom: 1.0,
            assets: (0..4).map(|index| asset(index, 1920.0, 1080.0, 1.0)).collect(),
        };
        let profile = profile_with_budget(20 * 1024 * 1024 * 1024, false);
        let decisions = Arbiter::allocate(
            &manifest,
            &profile,
            &TelemetrySnapshot::default(),
            &HashMap::new(),
        );

        assert_eq!(
            decisions
                .iter()
                .filter(|decision| decision.state == StreamState::Active)
                .count(),
            1
        );
    }

    #[test]
    fn packet_header_is_little_endian_and_binary() {
        let packet = make_frame_packet(42, 7, 12_345, 128, 72, 3);

        assert_eq!(&packet[0..4], FRAME_PACKET_MAGIC);
        assert_eq!(packet[5], FRAME_PACKET_HEADER_LEN as u8);
        assert_eq!(u64::from_le_bytes(packet[8..16].try_into().unwrap()), 7);
        assert_eq!(u64::from_le_bytes(packet[16..24].try_into().unwrap()), 12_345);
        assert_eq!(u64::from_le_bytes(packet[24..32].try_into().unwrap()), 42);
        assert_eq!(u32::from_le_bytes(packet[32..36].try_into().unwrap()), 128);
        assert_eq!(u32::from_le_bytes(packet[36..40].try_into().unwrap()), 72);
        assert_eq!(
            packet.len(),
            FRAME_PACKET_HEADER_LEN + 128 * 72 * BYTES_PER_PIXEL_RGBA8 as usize
        );
    }
}
