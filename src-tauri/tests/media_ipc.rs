//! Real Tauri IPC dispatch over media commands.
//!
//! `stale_decode_generation_is_rejected_over_ipc` always runs. The corpus
//! workload runs only when `SIGMA_MEDIA_PLAN` points at a plan written by
//! `scripts/media/run-media-suite.ts`; it then writes a JSON report and the
//! orchestrator turns that into gates. Without a plan it prints NOT RUN and the
//! orchestrator never treats that as a pass.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Instant,
};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{
    ipc::{CallbackFn, InvokeBody},
    test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY},
    webview::InvokeRequest,
    App, Manager, WebviewWindow, WebviewWindowBuilder,
};

fn request(cmd: &str, body: Value) -> InvokeRequest {
    InvokeRequest {
        cmd: cmd.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: if cfg!(any(windows, target_os = "android")) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
        .parse()
        .expect("valid test URL"),
        body: InvokeBody::Json(body),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    }
}

fn invoke(webview: &WebviewWindow<MockRuntime>, cmd: &str, body: Value) -> Result<Value, String> {
    get_ipc_response(webview, request(cmd, body))
        .map(|response| response.deserialize::<Value>().expect("JSON IPC response"))
        .map_err(|error| match error {
            Value::String(message) => message,
            other => other.to_string(),
        })
}

fn mock_app() -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let app = tauri_app_lib::configure_tauri_builder(mock_builder())
        .build(mock_context(noop_assets()))
        .expect("mock app");
    tauri_app_lib::manage_native_video_state(app.handle());
    tauri_app_lib::manage_decode_arbiter(app.handle());
    let webview =
        WebviewWindowBuilder::new(&app, "main", Default::default()).build().expect("mock webview");
    (app, webview)
}

fn unique_dir(name: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("sigma-{name}-{}-{nanos}", std::process::id()));
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

#[test]
fn stale_decode_generation_is_rejected_over_ipc() {
    let (app, webview) = mock_app();
    let dir = unique_dir("stale-generation");
    let image_path = dir.join("frame.png");
    image::RgbaImage::from_pixel(32, 16, image::Rgba([10, 20, 30, 255]))
        .save(&image_path)
        .expect("write png");
    app.asset_protocol_scope().allow_file(&image_path).expect("grant");
    let path = image_path.to_string_lossy().into_owned();
    let decode = |generation: u64| {
        invoke(
            &webview,
            "request_decode",
            json!({ "itemId": "item-1", "path": path, "lod": 256,
                    "generation": generation, "priority": "visible" }),
        )
    };

    let newest = decode(2).expect("current generation decodes");
    assert!(newest.as_str().is_some_and(|preview| Path::new(preview).exists()), "{newest}");
    // An older request delivered after a newer one is obsolete and must not
    // decode (nor demote the item's latest generation).
    assert_eq!(decode(1).expect("stale request resolves"), Value::Null);
    assert!(decode(2).expect("latest generation still decodes").is_string());

    let denied = invoke(
        &webview,
        "request_decode",
        json!({ "itemId": "item-2", "path": dir.join("ungranted.png").to_string_lossy(),
                "lod": 256, "generation": 1, "priority": "visible" }),
    );
    assert!(denied.is_err_and(|message| message.contains("scope")));
    let _ = fs::remove_dir_all(&dir);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanAsset {
    id: String,
    path: String,
    /// "ok" or "error": whether probing is expected to succeed.
    expect: String,
    expected: Option<ExpectedMetadata>,
    #[serde(default = "default_grant")]
    grant: bool,
}

fn default_grant() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedMetadata {
    width: u32,
    height: u32,
    duration: Option<f64>,
    frame_rate: Option<f64>,
    size: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Plan {
    assets: Vec<PlanAsset>,
    report: String,
    #[serde(default = "one")]
    probe_iterations: usize,
    #[serde(default)]
    concurrency_levels: Vec<usize>,
    #[serde(default)]
    soak_cycles: usize,
}

fn one() -> usize {
    1
}

fn elapsed_ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

fn current_rss_bytes() -> Option<u64> {
    let output =
        Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output();
    let text = String::from_utf8(output.ok()?.stdout).ok()?;
    text.trim().parse::<u64>().ok().map(|kib| kib * 1024)
}

fn peak_rss_bytes(who: i32) -> Option<u64> {
    // SAFETY: getrusage writes into the zeroed struct we own.
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    if unsafe { libc::getrusage(who, &mut usage) } != 0 {
        return None;
    }
    let raw = usage.ru_maxrss as u64;
    // macOS reports bytes, Linux reports KiB.
    Some(if cfg!(target_os = "macos") { raw } else { raw * 1024 })
}

/// Child processes (FFmpeg/ffprobe) still attached to this test process.
/// Open descriptors in this process, for leak detection across soak cycles.
fn open_fds() -> Option<usize> {
    let directory = if cfg!(target_os = "linux") { "/proc/self/fd" } else { "/dev/fd" };
    fs::read_dir(directory).ok().map(Iterator::count)
}

fn live_children() -> Vec<String> {
    let Ok(output) =
        Command::new("pgrep").args(["-l", "-P", &std::process::id().to_string()]).output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| line.contains("ffmpeg") || line.contains("ffprobe"))
        .map(str::to_string)
        .collect()
}

fn jpeg_dimensions(path: &str) -> Option<(u32, u32)> {
    image::ImageReader::open(path).ok()?.with_guessed_format().ok()?.into_dimensions().ok()
}

fn compare_metadata(expected: &ExpectedMetadata, observed: &Value) -> Vec<String> {
    let mut mismatches = Vec::new();
    let number = |key: &str| observed.get(key).and_then(Value::as_f64);
    if number("width") != Some(expected.width as f64) {
        mismatches.push(format!("width {:?} != {}", number("width"), expected.width));
    }
    if number("height") != Some(expected.height as f64) {
        mismatches.push(format!("height {:?} != {}", number("height"), expected.height));
    }
    if number("size") != Some(expected.size as f64) {
        mismatches.push(format!("size {:?} != {}", number("size"), expected.size));
    }
    if let Some(duration) = expected.duration {
        // Stream and container durations can differ by a frame.
        if number("duration").is_none_or(|value| (value - duration).abs() > 0.1) {
            mismatches.push(format!("duration {:?} != {duration}", number("duration")));
        }
    }
    if let Some(frame_rate) = expected.frame_rate {
        if number("frameRate").is_none_or(|value| (value - frame_rate).abs() > 0.01) {
            mismatches.push(format!("frameRate {:?} != {frame_rate}", number("frameRate")));
        }
    }
    mismatches
}

#[test]
fn media_corpus_plan() {
    let Ok(plan_path) = std::env::var("SIGMA_MEDIA_PLAN") else {
        eprintln!("NOT RUN: SIGMA_MEDIA_PLAN is unset (run pnpm test:media:smoke or :full)");
        return;
    };
    let plan: Plan =
        serde_json::from_str(&fs::read_to_string(&plan_path).expect("read plan")).expect("plan");
    let (app, webview) = mock_app();
    let cache_dir = app.path().app_cache_dir().expect("cache dir");
    for asset in plan.assets.iter().filter(|asset| asset.grant) {
        app.asset_protocol_scope().allow_file(&asset.path).expect("grant fixture");
    }
    let rss_start = current_rss_bytes();
    let _ = invoke(&webview, "clear_media_cache", json!({}));
    let mut asset_reports = Vec::new();
    let mut probe_ms = Vec::new();
    let mut cold_ms = Vec::new();
    let mut warm_ms = Vec::new();
    let mut errors = Vec::new();

    for (index, asset) in plan.assets.iter().enumerate() {
        let mut latencies = Vec::new();
        let mut observed = Value::Null;
        let mut probe_error = None;
        for _ in 0..plan.probe_iterations.max(1) {
            let start = Instant::now();
            let result = invoke(&webview, "probe_media", json!({ "path": asset.path }));
            latencies.push(elapsed_ms(start));
            match result {
                Ok(value) => observed = value,
                Err(error) => probe_error = Some(error),
            }
        }
        let mismatches = match (&asset.expected, probe_error.is_none()) {
            (Some(expected), true) => compare_metadata(expected, &observed),
            _ => Vec::new(),
        };
        let probe_status = match (asset.expect.as_str(), &probe_error) {
            ("ok", None) if mismatches.is_empty() => "ok",
            ("ok", None) => "mismatch",
            ("ok", Some(_)) => "unexpected-error",
            (_, Some(_)) => "expected-error",
            (_, None) => "unexpected-success",
        };
        if asset.expect == "ok" && probe_error.is_none() {
            probe_ms.extend(latencies.iter().copied());
        }

        // Thumbnails go through the decode arbiter exactly as the UI requests them.
        let decode = |generation: u64| {
            let start = Instant::now();
            let result = invoke(
                &webview,
                "request_decode",
                json!({ "itemId": asset.id, "path": asset.path, "lod": 256,
                        "generation": generation, "priority": "visible" }),
            );
            (elapsed_ms(start), result)
        };
        let (cold_latency, cold) = decode(1);
        let (warm_latency, warm) = decode(2);
        let thumbnail = match &cold {
            Ok(Value::String(path)) => {
                let dims = jpeg_dimensions(path);
                let inside_cache = Path::new(path).starts_with(&cache_dir);
                json!({ "status": if dims.is_some() && inside_cache { "ok" } else { "invalid" },
                        "width": dims.map(|d| d.0), "height": dims.map(|d| d.1),
                        "insideCache": inside_cache })
            }
            Ok(Value::Null) => json!({ "status": "none" }),
            Ok(other) => json!({ "status": "invalid", "value": other }),
            Err(error) => json!({ "status": "error", "error": error }),
        };
        let warm_same = matches!((&cold, &warm), (Ok(a), Ok(b)) if a == b);
        if asset.expect == "ok" && thumbnail["status"] == "ok" {
            cold_ms.push(cold_latency);
            warm_ms.push(warm_latency);
        }
        eprintln!(
            "[{}/{}] {} probe={probe_status} thumbnail={} cold={cold_latency:.1}ms warm={warm_latency:.1}ms",
            index + 1,
            plan.assets.len(),
            asset.id,
            thumbnail["status"]
        );
        asset_reports.push(json!({
            "id": asset.id,
            "probe": { "status": probe_status, "error": probe_error, "observed": observed,
                       "mismatches": mismatches, "latencyMs": latencies },
            "thumbnail": thumbnail,
            "thumbnailColdMs": cold_latency,
            "thumbnailWarmMs": warm_latency,
            "warmMatchesCold": warm_same,
        }));
    }

    let after_serial_children = live_children();
    let decodable: Vec<&PlanAsset> = plan.assets.iter().filter(|a| a.expect == "ok").collect();
    let mut concurrency = Vec::new();
    for &level in &plan.concurrency_levels {
        if decodable.is_empty() {
            break;
        }
        let _ = invoke(&webview, "clear_media_cache", json!({}));
        let start = Instant::now();
        let outcomes: Vec<bool> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..level)
                .map(|slot| {
                    let asset = decodable[slot % decodable.len()];
                    let webview = webview.clone();
                    scope.spawn(move || {
                        invoke(
                            &webview,
                            "request_decode",
                            json!({ "itemId": format!("concurrency-{level}-{slot}"),
                                    "path": asset.path, "lod": 256, "generation": 1,
                                    "priority": "visible" }),
                        )
                        .is_ok_and(|value| value.is_string())
                    })
                })
                .collect();
            handles.into_iter().map(|handle| handle.join().unwrap_or(false)).collect()
        });
        let wall = elapsed_ms(start);
        concurrency.push(json!({ "level": level, "wallMs": wall,
            "succeeded": outcomes.iter().filter(|ok| **ok).count(),
            "requested": level, "throughputPerSec": level as f64 / (wall / 1000.0) }));
    }

    let mut soak = Vec::new();
    for cycle in 0..plan.soak_cycles {
        let start = Instant::now();
        let _ = invoke(&webview, "clear_media_cache", json!({}));
        let mut failures = 0;
        for (slot, asset) in decodable.iter().enumerate() {
            if invoke(&webview, "probe_media", json!({ "path": asset.path })).is_err() {
                failures += 1;
            }
            let decoded = invoke(
                &webview,
                "request_decode",
                json!({ "itemId": format!("soak-{slot}"), "path": asset.path, "lod": 256,
                        "generation": cycle as u64 + 1, "priority": "visible" }),
            );
            if !decoded.is_ok_and(|value| value.is_string()) {
                failures += 1;
            }
        }
        let stats = invoke(&webview, "media_cache_stats", json!({})).unwrap_or(Value::Null);
        soak.push(json!({ "cycle": cycle, "wallMs": elapsed_ms(start), "failures": failures,
            "rssBytes": current_rss_bytes(), "openFds": open_fds(), "liveChildren": live_children(),
            "cacheBytes": stats.get("totalBytes") }));
    }

    let cache_stats = invoke(&webview, "media_cache_stats", json!({})).unwrap_or(Value::Null);
    let cleared = invoke(&webview, "clear_media_cache", json!({}));
    if let Err(error) = &cleared {
        errors.push(format!("clear_media_cache failed: {error}"));
    }
    let report = json!({
        "schema": "sigma.media-ipc-report.v1",
        "assets": asset_reports,
        "metrics": { "probeMs": probe_ms, "thumbnailColdMs": cold_ms, "thumbnailWarmMs": warm_ms },
        "concurrency": concurrency,
        "soak": soak,
        "cacheStatsBeforeClear": cache_stats,
        "cacheStatsAfterClear": cleared.unwrap_or(Value::Null),
        "liveChildrenAfterSerial": after_serial_children,
        "liveChildrenAtEnd": live_children(),
        "rss": { "startBytes": rss_start, "endBytes": current_rss_bytes(),
                 "peakSelfBytes": peak_rss_bytes(libc::RUSAGE_SELF),
                 "peakChildBytes": peak_rss_bytes(libc::RUSAGE_CHILDREN) },
        "errors": errors,
    });
    fs::write(&plan.report, serde_json::to_string_pretty(&report).expect("report"))
        .expect("write report");
    eprintln!("Wrote {}", plan.report);
}
