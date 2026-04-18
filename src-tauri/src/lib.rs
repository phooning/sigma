// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    process::Command,
};

use tauri::Manager;

#[derive(serde::Serialize)]
struct MediaMetadata {
    width: u32,
    height: u32,
    duration: f64,
    size: u64,
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn probe_media(path: String) -> Result<MediaMetadata, String> {
    tauri::async_runtime::spawn_blocking(move || probe_media_blocking(path))
        .await
        .map_err(|err| format!("Failed to probe media: {err}"))?
}

fn probe_media_blocking(path: String) -> Result<MediaMetadata, String> {
    let metadata =
        fs::metadata(&path).map_err(|err| format!("Failed to read media file metadata: {err}"))?;
    let fallback = MediaMetadata {
        width: 1280,
        height: 720,
        duration: 0.0,
        size: metadata.len(),
    };

    let output = match Command::new("ffprobe")
        .args([
            "-v",
            "quiet",
            "-select_streams",
            "v:0",
            "-print_format",
            "json",
            "-show_streams",
            "-show_entries",
            "stream=codec_type,width,height,duration:stream_tags=DURATION",
            &path,
        ])
        .output()
    {
        Ok(output) if output.status.success() => output,
        _ => return Ok(fallback),
    };

    let json: serde_json::Value = match serde_json::from_slice(&output.stdout) {
        Ok(json) => json,
        Err(_) => return Ok(fallback),
    };

    let Some(stream) = json["streams"]
        .as_array()
        .and_then(|streams| streams.iter().find(|stream| stream["codec_type"] == "video"))
    else {
        return Ok(fallback);
    };

    Ok(MediaMetadata {
        width: stream["width"].as_u64().unwrap_or(fallback.width as u64) as u32,
        height: stream["height"].as_u64().unwrap_or(fallback.height as u64) as u32,
        duration: parse_duration_value(&stream["duration"])
            .or_else(|| parse_duration_value(&stream["tags"]["DURATION"]))
            .unwrap_or(fallback.duration),
        size: fallback.size,
    })
}

fn parse_duration_value(value: &serde_json::Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(parse_duration_string))
}

fn parse_duration_string(duration: &str) -> Option<f64> {
    if let Ok(seconds) = duration.parse() {
        return Some(seconds);
    }

    let mut parts = duration.split(':');
    let hours: f64 = parts.next()?.parse().ok()?;
    let minutes: f64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;

    if parts.next().is_some() {
        return None;
    }

    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

#[tauri::command]
async fn generate_video_thumbnail(
    app: tauri::AppHandle,
    path: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || generate_video_thumbnail_blocking(app, path))
        .await
        .map_err(|err| format!("Failed to generate video thumbnail: {err}"))?
}

fn generate_video_thumbnail_blocking(
    app: tauri::AppHandle,
    path: String,
) -> Result<Option<String>, String> {
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
        .invoke_handler(tauri::generate_handler![
            greet,
            probe_media,
            generate_video_thumbnail
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
