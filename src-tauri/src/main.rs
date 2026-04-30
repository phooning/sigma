// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use tracing::info;

fn main() {
    tracing_subscriber::fmt().with_writer(std::fs::File::create("debug.log").unwrap()).init();

    #[cfg(target_os = "linux")]
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    info!("Starting Tauri app...");
    tauri_app_lib::run()
}
