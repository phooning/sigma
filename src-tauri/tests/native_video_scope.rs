use serde_json::{json, Value};
use tauri::{
    ipc::{CallbackFn, InvokeBody},
    test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY},
    webview::InvokeRequest,
    Manager, WebviewWindowBuilder,
};

fn manifest_request(paths: &[&str]) -> InvokeRequest {
    let assets: Vec<Value> = paths
        .iter()
        .enumerate()
        .map(|(index, path)| {
            json!({
                "id": format!("asset-{index}"), "path": path,
                "sourceWidth": 640, "sourceHeight": 480,
                "screenX": 0.0, "screenY": 0.0,
                "renderedWidthPx": 0.0, "renderedHeightPx": 0.0,
                "visibleAreaPx": 0.0, "focusWeight": 1.0,
                "centerWeight": 1.0, "targetFps": 30
            })
        })
        .collect();
    InvokeRequest {
        cmd: "native_video_update_manifest".into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: if cfg!(any(windows, target_os = "android")) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
        .parse()
        .expect("valid test URL"),
        body: InvokeBody::Json(json!({ "manifest": {
            "canvasWidth": 640, "canvasHeight": 480,
            "viewportZoom": 1.0, "assets": assets
        }})),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    }
}

#[test]
fn manifest_ipc_requires_every_source_to_be_in_runtime_scope() {
    let app = tauri_app_lib::configure_tauri_builder(mock_builder())
        .build(mock_context(noop_assets()))
        .expect("mock app");
    tauri_app_lib::manage_native_video_state(app.handle());
    let allowed = std::env::temp_dir().join("sigma-allowed-video.mp4");
    let denied = std::env::temp_dir().join("sigma-denied-video.mp4");
    app.asset_protocol_scope().allow_file(&allowed).expect("allow selected source");
    let webview =
        WebviewWindowBuilder::new(&app, "main", Default::default()).build().expect("mock webview");
    let allowed = allowed.to_str().expect("UTF-8 path");
    let denied = denied.to_str().expect("UTF-8 path");

    assert!(get_ipc_response(&webview, manifest_request(&[])).is_ok());
    assert!(get_ipc_response(&webview, manifest_request(&[allowed])).is_ok());
    assert!(get_ipc_response(&webview, manifest_request(&[allowed, denied])).is_err());
    assert!(get_ipc_response(&webview, manifest_request(&["relative.mp4"])).is_err());
}
