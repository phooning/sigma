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
    constants::BYTES_PER_PIXEL_RGBA8,
    controller::ControlMessage,
    frame_packet::{make_frame_packet, make_frame_packet_from_payload},
    profile::{bounded_factor, persist_profile, PerformanceProfile},
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
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
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
            .get(p95_index(decode_latencies.len()))
            .copied()
            .unwrap_or(0.0),
        send_latency_p95_ms: send_latencies
            .get(p95_index(send_latencies.len()))
            .copied()
            .unwrap_or(0.0),
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
        decode_backend: "ffmpeg-rawvideo-rgba".into(),
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
