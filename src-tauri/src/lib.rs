// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::Manager;

#[derive(serde::Serialize)]
struct MediaMetadata {
    width: u32,
    height: u32,
    duration: f64,
    size: u64,
}

#[derive(serde::Deserialize)]
struct CropRatio {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    #[serde(rename = "boxWidth")]
    box_width: Option<f64>,
    #[serde(rename = "boxHeight")]
    box_height: Option<f64>,
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

    let Some(stream) = json["streams"].as_array().and_then(|streams| {
        streams
            .iter()
            .find(|stream| stream["codec_type"] == "video")
    }) else {
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

#[tauri::command]
async fn save_media_screenshot(
    path: String,
    media_type: String,
    output_directory: Option<String>,
    current_time: Option<f64>,
    crop: CropRatio,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_media_screenshot_blocking(path, media_type, output_directory, current_time, crop)
    })
    .await
    .map_err(|err| format!("Failed to save screenshot: {err}"))?
}

#[tauri::command]
async fn export_video(
    path: String,
    output_path: String,
    crop: CropRatio,
    start_time: Option<f64>,
    end_time: Option<f64>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        export_video_blocking(path, output_path, crop, start_time, end_time)
    })
    .await
    .map_err(|err| format!("Failed to export video: {err}"))?
}

fn save_media_screenshot_blocking(
    path: String,
    media_type: String,
    output_directory: Option<String>,
    current_time: Option<f64>,
    crop: CropRatio,
) -> Result<String, String> {
    let metadata = probe_media_blocking(path.clone())?;
    let source_width = metadata.width.max(1);
    let source_height = metadata.height.max(1);
    let (crop_x, crop_y, crop_width, crop_height) = crop_pixels(&crop, source_width, source_height);
    let crop_filter = format!("crop={crop_width}:{crop_height}:{crop_x}:{crop_y}");

    let output_dir = output_directory
        .filter(|directory| !directory.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| Path::new(&path).parent().map(Path::to_path_buf))
        .ok_or("Failed to choose a screenshot output directory")?;

    fs::create_dir_all(&output_dir)
        .map_err(|err| format!("Failed to create screenshot directory: {err}"))?;

    let output_path = output_dir.join(screenshot_filename(&path)?);
    let output_path_str = output_path
        .to_str()
        .ok_or("Screenshot output path is not valid UTF-8")?;

    let mut args = vec![
        "-y".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
    ];
    if media_type == "video" {
        let seconds = current_time.unwrap_or(0.0);
        args.push("-ss".to_string());
        args.push(format!(
            "{:.3}",
            if seconds.is_finite() {
                seconds.max(0.0)
            } else {
                0.0
            }
        ));
    }
    args.push("-i".to_string());
    args.push(path);
    args.push("-frames:v".to_string());
    args.push("1".to_string());
    args.push("-vf".to_string());
    args.push(crop_filter);
    args.push(output_path_str.to_string());

    let output = Command::new("ffmpeg")
        .args(args)
        .output()
        .map_err(|err| format!("Failed to run ffmpeg: {err}"))?;

    if output.status.success() {
        Ok(output_path.to_string_lossy().into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        if detail.is_empty() {
            Err("ffmpeg failed to save the screenshot".to_string())
        } else {
            Err(format!("ffmpeg failed to save the screenshot: {detail}"))
        }
    }
}

fn export_video_blocking(
    path: String,
    output_path: String,
    crop: CropRatio,
    start_time: Option<f64>,
    end_time: Option<f64>,
) -> Result<String, String> {
    if output_path.trim().is_empty() {
        return Err("Choose an export location".to_string());
    }

    if path == output_path {
        return Err(
            "Choose an export location that is different from the source video".to_string(),
        );
    }

    let metadata = probe_media_blocking(path.clone())?;
    let source_width = metadata.width.max(1);
    let source_height = metadata.height.max(1);
    let (crop_x, crop_y, crop_width, crop_height) = crop_pixels(&crop, source_width, source_height);
    let should_crop =
        crop_x > 0 || crop_y > 0 || crop_width < source_width || crop_height < source_height;
    let mut video_filters = Vec::new();

    if should_crop {
        video_filters.push(format!("crop={crop_width}:{crop_height}:{crop_x}:{crop_y}"));
    }

    if crop_width % 2 != 0 || crop_height % 2 != 0 {
        video_filters.push("scale=trunc(iw/2)*2:trunc(ih/2)*2".to_string());
    }
    video_filters.push("format=yuv420p".to_string());

    let output_path = PathBuf::from(output_path);
    if let Some(parent) = output_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create export directory: {err}"))?;
    }

    let output_path_str = output_path
        .to_str()
        .ok_or("Export output path is not valid UTF-8")?;

    let start = start_time
        .filter(|seconds| seconds.is_finite())
        .map(|seconds| seconds.max(0.0));
    let duration = match (start, end_time.filter(|seconds| seconds.is_finite())) {
        (Some(start), Some(end)) if end > start => Some(end - start),
        _ => None,
    };

    let mut args = vec![
        "-y".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
    ];

    if let Some(start) = start {
        args.push("-ss".to_string());
        args.push(format!("{start:.3}"));
    }

    args.push("-i".to_string());
    args.push(path);

    if let Some(duration) = duration {
        args.push("-t".to_string());
        args.push(format!("{duration:.3}"));
    }

    args.extend([
        "-map".to_string(),
        "0:v:0".to_string(),
        "-map".to_string(),
        "0:a?".to_string(),
        "-vf".to_string(),
        video_filters.join(","),
        "-c:v".to_string(),
        "libx264".to_string(),
        "-preset".to_string(),
        "veryfast".to_string(),
        "-crf".to_string(),
        "20".to_string(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "192k".to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        output_path_str.to_string(),
    ]);

    let output = Command::new("ffmpeg")
        .args(args)
        .output()
        .map_err(|err| format!("Failed to run ffmpeg: {err}"))?;

    if output.status.success() {
        Ok(output_path.to_string_lossy().into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        if detail.is_empty() {
            Err("ffmpeg failed to export the video".to_string())
        } else {
            Err(format!("ffmpeg failed to export the video: {detail}"))
        }
    }
}

fn crop_pixels(crop: &CropRatio, source_width: u32, source_height: u32) -> (u32, u32, u32, u32) {
    let (source_x, source_y, visible_source_width, visible_source_height) =
        cover_crop_source_rect(crop, source_width, source_height);

    let x = (source_x + crop.x.clamp(0.0, 1.0) * visible_source_width)
        .floor()
        .max(0.0) as u32;
    let y = (source_y + crop.y.clamp(0.0, 1.0) * visible_source_height)
        .floor()
        .max(0.0) as u32;
    let x = x.min(source_width - 1);
    let y = y.min(source_height - 1);
    let width = (crop.width.clamp(0.0, 1.0) * visible_source_width).round() as u32;
    let height = (crop.height.clamp(0.0, 1.0) * visible_source_height).round() as u32;
    let width = width.max(1).min(source_width.saturating_sub(x).max(1));
    let height = height.max(1).min(source_height.saturating_sub(y).max(1));

    (x, y, width, height)
}

fn cover_crop_source_rect(
    crop: &CropRatio,
    source_width: u32,
    source_height: u32,
) -> (f64, f64, f64, f64) {
    let source_width = source_width as f64;
    let source_height = source_height as f64;
    let box_width = crop
        .box_width
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(source_width);
    let box_height = crop
        .box_height
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(source_height);
    let source_aspect = source_width / source_height;
    let box_aspect = box_width / box_height;

    if source_aspect > box_aspect {
        let visible_source_width = source_height * box_aspect;
        let source_x = (source_width - visible_source_width) / 2.0;

        (source_x, 0.0, visible_source_width, source_height)
    } else {
        let visible_source_height = source_width / box_aspect;
        let source_y = (source_height - visible_source_height) / 2.0;

        (0.0, source_y, source_width, visible_source_height)
    }
}

fn screenshot_filename(path: &str) -> Result<String, String> {
    let stem = Path::new(path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("media");
    let sanitized_stem: String = stem
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("System clock is before Unix epoch: {err}"))?
        .as_millis();

    Ok(format!("{sanitized_stem}-screenshot-{timestamp}.png"))
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
            probe_media,
            generate_video_thumbnail,
            save_media_screenshot,
            export_video
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crop(x: f64, y: f64, width: f64, height: f64, box_width: f64, box_height: f64) -> CropRatio {
        CropRatio {
            x,
            y,
            width,
            height,
            box_width: Some(box_width),
            box_height: Some(box_height),
        }
    }

    #[test]
    fn crop_pixels_accounts_for_cover_crop_from_resized_frame() {
        let result = crop_pixels(&crop(0.0, 0.0, 1.0, 1.0, 1280.0, 960.0), 1920, 1080);

        assert_eq!(result, (240, 0, 1440, 1080));
    }

    #[test]
    fn crop_pixels_applies_explicit_crop_inside_cover_crop() {
        let result = crop_pixels(
            &crop(120.0 / 1280.0, 0.0, 1160.0 / 1280.0, 1.0, 1280.0, 960.0),
            1920,
            1080,
        );

        assert_eq!(result, (375, 0, 1305, 1080));
    }
}
