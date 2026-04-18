// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    process::Command,
};

use tauri::Manager;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn generate_video_thumbnail(app: tauri::AppHandle, path: String) -> Result<Option<String>, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| format!("Failed to locate app cache directory: {err}"))?
        .join("video-thumbnails");

    fs::create_dir_all(&cache_dir)
        .map_err(|err| format!("Failed to create thumbnail cache directory: {err}"))?;

    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    if let Ok(metadata) = fs::metadata(&path) {
        metadata.len().hash(&mut hasher);
        if let Ok(modified) = metadata.modified() {
            modified.hash(&mut hasher);
        }
    }

    let thumbnail_path = cache_dir.join(format!("{:x}.jpg", hasher.finish()));
    if thumbnail_path.exists() {
        return Ok(Some(thumbnail_path.to_string_lossy().into_owned()));
    }

    let output = Command::new("ffmpeg")
        .args([
            "-y",
            "-loglevel",
            "error",
            "-ss",
            "00:00:01",
            "-i",
            &path,
            "-vframes",
            "1",
            "-vf",
            "scale=320:-1",
            thumbnail_path
                .to_str()
                .ok_or("Thumbnail cache path is not valid UTF-8")?,
        ])
        .output();

    match output {
        Ok(result) if result.status.success() => {
            Ok(Some(thumbnail_path.to_string_lossy().into_owned()))
        }
        Ok(_) | Err(_) => {
            let _ = fs::remove_file(&thumbnail_path);
            Ok(None)
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, generate_video_thumbnail])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
