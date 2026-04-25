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

mod native_video;

#[derive(serde::Serialize)]
struct ImageProbe {
    path: String,
    width: u32,
    height: u32,
    size: u64,
}

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

#[tauri::command]
async fn probe_images(paths: Vec<String>) -> Result<Vec<ImageProbe>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .map(probe_image_blocking)
            .collect::<Result<Vec<_>, _>>()
    })
    .await
    .map_err(|err| format!("Failed to probe images: {err}"))?
}

fn probe_image_blocking(path: String) -> Result<ImageProbe, String> {
    let metadata = fs::metadata(&path)
        .map_err(|err| format!("Failed to read image metadata for {path}: {err}"))?;
    let reader = image::ImageReader::open(&path)
        .map_err(|err| format!("Failed to open image {path}: {err}"))?
        .with_guessed_format()
        .map_err(|err| format!("Failed to detect image format for {path}: {err}"))?;
    let (width, height) = reader
        .into_dimensions()
        .map_err(|err| format!("Failed to read image dimensions for {path}: {err}"))?;

    Ok(ImageProbe {
        path,
        width,
        height,
        size: metadata.len(),
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
async fn generate_video_thumbnail<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || generate_video_thumbnail_blocking(app, path))
        .await
        .map_err(|err| format!("Failed to generate video thumbnail: {err}"))?
}

fn generate_video_thumbnail_blocking<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
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
async fn generate_image_preview<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
    max_dimension: u32,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        generate_image_preview_blocking(app, path, max_dimension)
    })
    .await
    .map_err(|err| format!("Failed to generate image preview: {err}"))?
}

fn generate_image_preview_blocking<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
    max_dimension: u32,
) -> Result<Option<String>, String> {
    if max_dimension == 0 {
        return Err("Image preview size must be greater than zero".to_string());
    }

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| format!("Failed to locate app cache directory: {err}"))?
        .join("image-previews");

    fs::create_dir_all(&cache_dir)
        .map_err(|err| format!("Failed to create image preview cache directory: {err}"))?;

    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    max_dimension.hash(&mut hasher);
    if let Ok(metadata) = fs::metadata(&path) {
        metadata.len().hash(&mut hasher);
        if let Ok(modified) = metadata.modified() {
            modified.hash(&mut hasher);
        }
    }

    let preview_path = cache_dir.join(format!("{:x}-{max_dimension}.png", hasher.finish()));
    if preview_path.exists() {
        return Ok(Some(preview_path.to_string_lossy().into_owned()));
    }

    let reader = image::ImageReader::open(&path)
        .map_err(|err| format!("Failed to open image for preview: {err}"))?
        .with_guessed_format()
        .map_err(|err| format!("Failed to detect image format for preview: {err}"))?;
    let image = reader
        .decode()
        .map_err(|err| format!("Failed to decode image for preview: {err}"))?;
    let preview = image.resize(
        max_dimension,
        max_dimension,
        image::imageops::FilterType::Triangle,
    );

    preview
        .save_with_format(&preview_path, image::ImageFormat::Png)
        .map_err(|err| format!("Failed to save image preview: {err}"))?;

    Ok(Some(preview_path.to_string_lossy().into_owned()))
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

pub fn manage_native_video_state<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if app.try_state::<native_video::NativeVideoState>().is_none() {
        app.manage(native_video::NativeVideoState::new(app));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn configure_tauri_builder<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .setup(|app| {
            manage_native_video_state(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            probe_media,
            probe_images,
            generate_video_thumbnail,
            generate_image_preview,
            save_media_screenshot,
            export_video,
            native_video::commands::native_video_get_profile,
            native_video::commands::native_video_update_manifest,
            native_video::commands::native_video_stop_all,
            native_video::commands::native_video_subscribe_frames,
            native_video::commands::native_video_subscribe_telemetry,
            native_video::commands::native_video_record_frontend_metrics,
            native_video::commands::native_video_reset_profile,
            native_video::commands::native_video_run_base_case_probe
        ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_tauri_builder(
        tauri::Builder::default()
            .plugin(tauri_plugin_os::init())
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_fs::init())
            .plugin(tauri_plugin_shell::init())
            .plugin(tauri_plugin_opener::init()),
    )
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command_available(command: &str) -> bool {
        Command::new(command)
            .arg("-version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

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

    #[test]
    fn image_screenshot_export_matches_system_crop_pixels() {
        if !command_available("magick")
            || !command_available("ffmpeg")
            || !command_available("ffprobe")
        {
            eprintln!(
                "skipping pixel crop export test because magick, ffmpeg, or ffprobe is missing"
            );
            return;
        }

        let test_id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let temp_dir = std::env::temp_dir().join(format!(
            "sigma-crop-export-{}-{test_id}",
            std::process::id()
        ));
        fs::create_dir_all(&temp_dir).expect("failed to create temp test directory");

        let source_path = temp_dir.join("source.png");
        let reference_path = temp_dir.join("reference.png");
        let output_dir = temp_dir.join("exported");
        fs::create_dir_all(&output_dir).expect("failed to create output directory");

        let generate = Command::new("magick")
            .args([
                "-size",
                "192x108",
                "xc:black",
                "-channel",
                "R",
                "-fx",
                "i/w",
                "-channel",
                "G",
                "-fx",
                "j/h",
                "-channel",
                "B",
                "-fx",
                "(i+j)/(w+h)",
                "+channel",
                "-depth",
                "8",
                source_path.to_str().expect("source path should be UTF-8"),
            ])
            .output()
            .expect("failed to run ImageMagick source generation");
        assert!(
            generate.status.success(),
            "ImageMagick source generation failed: {}",
            String::from_utf8_lossy(&generate.stderr)
        );

        let crop = crop(
            24.0 / 128.0,
            18.0 / 72.0,
            80.0 / 128.0,
            42.0 / 72.0,
            128.0,
            72.0,
        );
        let (crop_x, crop_y, crop_width, crop_height) = crop_pixels(&crop, 192, 108);
        let crop_geometry = format!("{crop_width}x{crop_height}+{crop_x}+{crop_y}");

        let reference = Command::new("magick")
            .args([
                source_path.to_str().expect("source path should be UTF-8"),
                "-crop",
                &crop_geometry,
                "+repage",
                "-depth",
                "8",
                reference_path
                    .to_str()
                    .expect("reference path should be UTF-8"),
            ])
            .output()
            .expect("failed to run ImageMagick reference crop");
        assert!(
            reference.status.success(),
            "ImageMagick reference crop failed: {}",
            String::from_utf8_lossy(&reference.stderr)
        );

        let exported_path = save_media_screenshot_blocking(
            source_path.to_string_lossy().into_owned(),
            "image".to_string(),
            Some(output_dir.to_string_lossy().into_owned()),
            None,
            crop,
        )
        .expect("Sigma screenshot export should succeed");

        let compare = Command::new("magick")
            .args([
                "compare",
                "-metric",
                "AE",
                &exported_path,
                reference_path
                    .to_str()
                    .expect("reference path should be UTF-8"),
                "null:",
            ])
            .output()
            .expect("failed to compare exported crop to reference crop");
        let stderr = String::from_utf8_lossy(&compare.stderr);
        let stdout = String::from_utf8_lossy(&compare.stdout);
        let compare_metric = stderr
            .split_whitespace()
            .next()
            .or_else(|| stdout.split_whitespace().next())
            .unwrap_or("");
        let differing_pixels = if compare.status.success() && compare_metric.is_empty() {
            0
        } else {
            compare_metric.parse::<u64>().unwrap_or(u64::MAX)
        };

        let _ = fs::remove_dir_all(&temp_dir);

        assert_eq!(
            differing_pixels, 0,
            "exported screenshot pixels differed from ImageMagick crop: stdout={stdout:?} stderr={stderr:?}"
        );
    }
}
