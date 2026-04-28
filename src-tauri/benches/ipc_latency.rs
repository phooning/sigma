use criterion::{black_box, criterion_group, criterion_main, Criterion};
use serde_json::json;
use tauri::{
    ipc::{CallbackFn, InvokeBody},
    test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY},
    webview::InvokeRequest,
    App, WebviewWindow, WebviewWindowBuilder,
};

struct BenchHarness {
    _app: App<tauri::test::MockRuntime>,
    webview: WebviewWindow<tauri::test::MockRuntime>,
}

fn create_harness() -> BenchHarness {
    let app = tauri_app_lib::configure_tauri_builder(mock_builder())
        .build(mock_context(noop_assets()))
        .expect("failed to build mock app");
    tauri_app_lib::manage_native_video_state(app.handle());

    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("failed to build mock webview");

    BenchHarness { _app: app, webview }
}

fn invoke_request(command: &str, body: serde_json::Value) -> InvokeRequest {
    InvokeRequest {
        cmd: command.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: "http://tauri.localhost".parse().expect("valid test URL"),
        body: InvokeBody::Json(body),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    }
}

fn sample_manifest(asset_count: usize) -> serde_json::Value {
    json!({
        "manifest": {
            "canvasWidth": 1920,
            "canvasHeight": 1080,
            "viewportZoom": 0.85,
            "assets": (0..asset_count)
                .map(|index| {
                    json!({
                        "id": format!("asset-{index}"),
                        "path": format!("/tmp/asset-{index}.mp4"),
                        "sourceWidth": 3840,
                        "sourceHeight": 2160,
                        "screenX": (index % 8) as f64 * 180.0,
                        "screenY": (index / 8) as f64 * 120.0,
                        "renderedWidthPx": 320.0,
                        "renderedHeightPx": 180.0,
                        "visibleAreaPx": 57_600.0,
                        "focusWeight": if index % 6 == 0 { 2.5 } else { 1.0 },
                        "centerWeight": 0.75,
                        "targetFps": 60
                    })
                })
                .collect::<Vec<_>>()
        }
    })
}

fn ipc_latency_benchmarks(c: &mut Criterion) {
    let harness = create_harness();
    let mut group = c.benchmark_group("tauri_ipc_dispatch");

    group.bench_function("native_video_get_profile", |b| {
        b.iter(|| {
            let response = get_ipc_response(
                &harness.webview,
                invoke_request(
                    "native_video_get_profile",
                    serde_json::Value::Object(Default::default()),
                ),
            )
            .expect("profile command should succeed");
            black_box(response);
        });
    });

    group.bench_function("native_video_update_manifest_32_assets", |b| {
        b.iter(|| {
            let response = get_ipc_response(
                &harness.webview,
                invoke_request("native_video_update_manifest", sample_manifest(32)),
            )
            .expect("manifest command should succeed");
            black_box(response);
        });
    });

    group.finish();
}

criterion_group!(ipc_benches, ipc_latency_benchmarks);
criterion_main!(ipc_benches);
