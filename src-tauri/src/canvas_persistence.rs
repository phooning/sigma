use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use tauri::Runtime;
use tauri_plugin_fs::FsExt;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn validate_destination(scope: &tauri::fs::Scope, path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path.file_name().is_none()
        || path.components().any(|part| matches!(part, Component::ParentDir))
    {
        return Err("Canvas destination must be an absolute file path".into());
    }
    if !scope.is_allowed(path) {
        return Err("Canvas destination is outside the application file scope".into());
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            Err("Canvas destination must be a regular file".into())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cannot inspect canvas destination: {error}")),
    }
}

struct TemporaryFile(PathBuf, bool);

impl Drop for TemporaryFile {
    fn drop(&mut self) {
        if self.1 {
            let _ = fs::remove_file(&self.0);
        }
    }
}

fn replace_canvas_file(
    path: &Path,
    write: impl FnOnce(&mut File) -> io::Result<()>,
    before_replace: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let parent = path.parent().ok_or("Canvas destination has no parent directory")?;
    let existing_permissions = match fs::metadata(path) {
        Ok(metadata) => Some(metadata.permissions()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Cannot inspect canvas destination: {error}")),
    };
    let (mut temporary, mut file) = loop {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temporary = parent.join(format!(".sigma-canvas-{}-{sequence}.tmp", std::process::id()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&temporary) {
            Ok(file) => break (TemporaryFile(temporary, true), file),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Cannot create temporary canvas file: {error}")),
        }
    };

    write(&mut file).map_err(|error| format!("Cannot write canvas: {error}"))?;
    if let Some(permissions) = existing_permissions {
        file.set_permissions(permissions)
            .map_err(|error| format!("Cannot preserve canvas permissions: {error}"))?;
    }
    file.sync_all().map_err(|error| format!("Cannot sync canvas: {error}"))?;
    drop(file);
    before_replace()?;
    fs::rename(&temporary.0, path).map_err(|error| format!("Cannot replace canvas: {error}"))?;
    temporary.1 = false;
    #[cfg(unix)]
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Canvas replaced, but cannot sync its directory: {error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn save_canvas_atomic<R: Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
    contents: String,
) -> Result<(), String> {
    let path = PathBuf::from(path);
    let scope = app.try_fs_scope().ok_or("Filesystem scope is unavailable")?;
    validate_destination(&scope, &path)?;
    let operation = crate::lifecycle::OperationGuard::start(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        replace_canvas_file(
            &path,
            |file| file.write_all(contents.as_bytes()),
            || {
                #[cfg(all(debug_assertions, feature = "tauri-plugin-wdio-webdriver"))]
                desktop_save_barrier(&path)?;
                validate_destination(&scope, &path)
            },
        )
    })
    .await
    .map_err(|error| format!("Canvas save task failed: {error}"))?
}

// Deterministic fault injection exists only in native desktop test builds and
// only for the runner's canonical, disposable fixture directory.
#[cfg(all(debug_assertions, feature = "tauri-plugin-wdio-webdriver"))]
fn desktop_save_barrier(path: &Path) -> Result<(), String> {
    let Some(directory) = std::env::var_os("SIGMA_DESKTOP_FIXTURE_DIR") else { return Ok(()) };
    let directory = PathBuf::from(directory).canonicalize().map_err(|error| error.to_string())?;
    if path.parent() != Some(directory.as_path()) {
        return Ok(());
    }
    let delay = std::env::var("SIGMA_DESKTOP_SAVE_DELAY_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
        .min(15_000);
    if delay > 0 {
        fs::write(directory.join("save-started"), "ready").map_err(|error| error.to_string())?;
        std::thread::sleep(std::time::Duration::from_millis(delay));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_write_and_precommit_failure_preserve_original_and_remove_temporary() {
        let directory = std::env::temp_dir().join(format!(
            "sigma-atomic-test-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("canvas.json");
        fs::write(&path, "last valid").unwrap();
        let result = replace_canvas_file(
            &path,
            |file| {
                file.write_all(b"partial")?;
                Err(io::Error::other("injected write failure"))
            },
            || Ok(()),
        );
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "last valid");
        assert!(replace_canvas_file(
            &path,
            |file| file.write_all(b"new"),
            || Err("revoked".into())
        )
        .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "last valid");
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        let missing = directory.join("missing.json");
        assert!(replace_canvas_file(
            &missing,
            |file| {
                file.write_all(b"partial")?;
                Err(io::Error::other("injected failure"))
            },
            || Ok(())
        )
        .is_err());
        assert!(!missing.exists());
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_dir_all(directory).unwrap();
    }
}
