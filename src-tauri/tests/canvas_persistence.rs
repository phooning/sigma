use serde_json::json;
use std::{fs, path::Path};
use tauri::{
    ipc::{CallbackFn, InvokeBody},
    test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY},
    webview::InvokeRequest,
    WebviewWindowBuilder,
};
use tauri_plugin_fs::FsExt;

fn request_with_policy(path: &Path, contents: &str, create_only: bool) -> InvokeRequest {
    InvokeRequest {
        cmd: "save_canvas_atomic".into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: if cfg!(any(windows, target_os = "android")) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
        .parse()
        .unwrap(),
        body: InvokeBody::Json(
            json!({ "path": path, "contents": contents, "createOnly": create_only }),
        ),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    }
}

fn request(path: &Path, contents: &str) -> InvokeRequest {
    request_with_policy(path, contents, false)
}

#[test]
fn ipc_replaces_only_scoped_files_and_leaves_other_files_untouched() {
    let app =
        tauri_app_lib::configure_tauri_builder(mock_builder().plugin(tauri_plugin_fs::init()))
            .build(mock_context(noop_assets()))
            .expect("mock app");
    let directory = std::env::temp_dir().join(format!("sigma-canvas-ipc-{}", std::process::id()));
    fs::create_dir_all(&directory).unwrap();
    let selected = directory.join("selected.json");
    let unselected = directory.join("unselected.json");
    let new_file = directory.join("new.json");
    fs::write(&selected, "old").unwrap();
    fs::write(&unselected, "protected").unwrap();
    app.fs_scope().allow_file(&selected).unwrap();
    app.fs_scope().allow_file(&new_file).unwrap();
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();

    assert!(get_ipc_response(&webview, request(&unselected, "denied")).is_err());
    assert_eq!(fs::read_to_string(&unselected).unwrap(), "protected");
    assert!(get_ipc_response(&webview, request(Path::new("relative.json"), "denied")).is_err());
    assert!(get_ipc_response(&webview, request(&selected, "replacement")).is_ok());
    assert_eq!(fs::read_to_string(&selected).unwrap(), "replacement");
    assert!(get_ipc_response(&webview, request(&new_file, "created")).is_ok());
    assert_eq!(fs::read_to_string(&new_file).unwrap(), "created");
    assert!(
        get_ipc_response(&webview, request_with_policy(&selected, "raw invalid", true)).is_err()
    );
    assert_eq!(fs::read_to_string(&selected).unwrap(), "replacement");
    let backup = directory.join("backup.json");
    app.fs_scope().allow_file(&backup).unwrap();
    assert!(get_ipc_response(&webview, request_with_policy(&backup, "raw invalid", true)).is_ok());
    assert_eq!(fs::read_to_string(&backup).unwrap(), "raw invalid");
    #[cfg(unix)]
    {
        let link = directory.join("link.json");
        std::os::unix::fs::symlink(&selected, &link).unwrap();
        app.fs_scope().allow_file(&link).unwrap();
        assert!(get_ipc_response(&webview, request(&link, "symlink")).is_err());
        assert_eq!(fs::read_to_string(&selected).unwrap(), "replacement");
        fs::remove_file(link).unwrap();
    }
    app.fs_scope().forbid_file(&selected).unwrap();
    assert!(get_ipc_response(&webview, request(&selected, "revoked")).is_err());
    assert_eq!(fs::read_to_string(&selected).unwrap(), "replacement");
    assert_eq!(fs::read_dir(&directory).unwrap().count(), 4);
    fs::remove_dir_all(directory).unwrap();
}
