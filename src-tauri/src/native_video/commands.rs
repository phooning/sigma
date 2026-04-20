use std::{
    process::Stdio,
    time::{Duration, Instant},
};

use tauri::{
    ipc::{Channel, InvokeResponseBody},
    State,
};
use tokio::{io::AsyncReadExt, process::Command as TokioCommand, sync::oneshot, time};

use super::{
    constants::PIXEL_FORMAT_YUV420,
    controller::ControlMessage,
    frame_packet::{make_frame_packet, make_frame_packet_from_payload, yuv420_payload_len},
    profile::{bounded_factor, measure_ram_bandwidth, persist_profile, PerformanceProfile},
    state::NativeVideoState,
    telemetry::{update_telemetry, TelemetrySnapshot},
    types::{
        BaseCaseProbeConfig, BaseCaseProbeReport, CanvasManifest, ControllerSnapshot,
        FrontendMetrics,
    },
    util::{now_millis, p95_index, stable_stream_id},
};

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
    // The broker dispatches the owned pool buffer directly; subscribers no longer clone broadcast frames.
    let mut subscribers = state
        .frame_subscribers
        .lock()
        .map_err(|_| "native video frame subscriber lock poisoned".to_string())?;
    subscribers.clear();
    subscribers.push(on_frame);

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
    profile.base_probe_frame_drop_rate = Some(metrics.frame_drop_rate);
    profile.base_case_validated = metrics.canvas_width >= 3840
        && metrics.canvas_height >= 2160
        && metrics.frame_drop_rate <= 0.01
        && metrics.composite_latency_p95_ms <= 8.0
        && metrics.upload_latency_p95_ms <= 8.0
        && profile.base_probe_ram_bandwidth_bytes_per_sec.is_some();
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
    state: State<'_, NativeVideoState>,
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
        let report =
            run_ffmpeg_base_case_probe(source_path, width, height, fps, frames, on_frame).await?;
        persist_base_case_probe_metrics(&state, &report).await?;
        return Ok(report);
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

    let report = BaseCaseProbeReport {
        decode_backend: "synthetic-yuv420".into(),
        width,
        height,
        fps,
        frames_sent: frames,
        bytes_sent,
        elapsed_ms,
        measured_ipc_bytes_per_sec,
        decode_latency_p95_ms: decode_latencies
            .get(p95_index(decode_latencies.len()))
            .copied()
            .unwrap_or(0.0),
        send_latency_p95_ms: send_latencies
            .get(p95_index(send_latencies.len()))
            .copied()
            .unwrap_or(0.0),
    };
    persist_base_case_probe_metrics(&state, &report).await?;
    Ok(report)
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
    let payload_len = yuv420_payload_len(width, height);
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
            &format!("fps={fps},scale={width}:{height}:flags=fast_bilinear,format=yuv420p"),
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
        return Err(format!(
            "ffmpeg base-case probe failed with status {status}"
        ));
    }

    decode_latencies.sort_by(f64::total_cmp);
    send_latencies.sort_by(f64::total_cmp);
    let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
    let measured_ipc_bytes_per_sec = if elapsed_ms > 0.0 {
        ((bytes_sent as f64 / elapsed_ms) * 1_000.0) as u64
    } else {
        0
    };

    Ok(BaseCaseProbeReport {
        decode_backend: "ffmpeg-rawvideo-yuv420p".into(),
        width,
        height,
        fps,
        frames_sent: frames,
        bytes_sent,
        elapsed_ms,
        measured_ipc_bytes_per_sec,
        decode_latency_p95_ms: decode_latencies
            .get(p95_index(decode_latencies.len()))
            .copied()
            .unwrap_or(0.0),
        send_latency_p95_ms: send_latencies
            .get(p95_index(send_latencies.len()))
            .copied()
            .unwrap_or(0.0),
    })
}

async fn persist_base_case_probe_metrics(
    state: &State<'_, NativeVideoState>,
    report: &BaseCaseProbeReport,
) -> Result<(), String> {
    // RAM bandwidth measurement is part of base-case probe completion.
    let should_measure = state
        .profile
        .lock()
        .map_err(|_| "native video profile lock poisoned".to_string())?
        .should_measure_ram_bandwidth();

    let ram_bandwidth = if should_measure {
        tokio::task::spawn_blocking(measure_ram_bandwidth)
            .await
            .map_err(|err| format!("failed to join RAM bandwidth probe: {err}"))?
    } else {
        state
            .profile
            .lock()
            .map_err(|_| "native video profile lock poisoned".to_string())?
            .ram_bandwidth_bytes_per_sec
    };

    let mut profile = state
        .profile
        .lock()
        .map_err(|_| "native video profile lock poisoned".to_string())?
        .clone();

    profile.ipc_budget_bytes_per_sec = profile
        .ipc_budget_bytes_per_sec
        .max(report.measured_ipc_bytes_per_sec);
    profile.base_probe_ipc_latency_p95_ms = Some(report.send_latency_p95_ms);
    profile.base_probe_ram_bandwidth_bytes_per_sec = Some(ram_bandwidth);
    profile.ram_bandwidth_bytes_per_sec = ram_bandwidth;
    profile.calibrated_at_ms = Some(now_millis());
    profile.notes = vec![
        format!("Base-case decode backend: {}", report.decode_backend),
        format!("SVF1 pixel format: {}", PIXEL_FORMAT_YUV420),
        "Base case probe writes IPC latency, frontend frame-drop metrics, and RAM bandwidth before validation.".into(),
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

    Ok(())
}
