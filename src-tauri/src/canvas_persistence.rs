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

#[cfg(unix)]
fn sync_directory(directory: &Path) -> io::Result<()> {
    File::open(directory)?.sync_all()
}

#[cfg(not(unix))]
fn sync_directory(_directory: &Path) -> io::Result<()> {
    Ok(())
}

/// Some volumes (SMB, some FUSE/exFAT mounts) cannot fsync a directory. That is
/// a property of the volume, not a failed save: treating it as an error would
/// report every save there as failed and leave the session permanently dirty.
fn directory_sync_unsupported(error: &io::Error) -> bool {
    if error.kind() == io::ErrorKind::Unsupported {
        return true;
    }
    #[cfg(unix)]
    if matches!(error.raw_os_error(), Some(libc::EINVAL | libc::ENOTSUP)) {
        return true;
    }
    false
}

// Opening without truncation asks the OS whether this process can actually
// write the file, including owner/group and ACL rules. Rename itself only
// requires permission on the parent, so mode bits alone are insufficient.
fn writable_target_metadata(path: &Path) -> Result<fs::Metadata, String> {
    let mut options = OpenOptions::new();
    options.write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let file = options
        .open(path)
        .map_err(|error| format!("Canvas destination is not writable; use Save As ({error})"))?;
    let opened =
        file.metadata().map_err(|error| format!("Cannot inspect canvas destination: {error}"))?;
    let named = fs::symlink_metadata(path)
        .map_err(|error| format!("Cannot inspect canvas destination: {error}"))?;
    if !named.file_type().is_file() {
        return Err("Canvas destination must be a regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if (opened.dev(), opened.ino()) != (named.dev(), named.ino()) {
            return Err("Canvas destination changed while saving; retry or use Save As".into());
        }
    }
    Ok(named)
}

#[cfg(unix)]
fn same_target(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    (a.dev(), a.ino(), a.mode(), a.uid(), a.gid()) == (b.dev(), b.ino(), b.mode(), b.uid(), b.gid())
}

#[cfg(not(unix))]
fn same_target(_a: &fs::Metadata, _b: &fs::Metadata) -> bool {
    true
}

#[cfg(test)]
fn replace_canvas_file(
    path: &Path,
    write: impl FnOnce(&mut File) -> io::Result<()>,
    before_replace: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    replace_canvas_file_with(path, write, before_replace, sync_directory)
}

#[cfg(test)]
fn replace_canvas_file_with(
    path: &Path,
    write: impl FnOnce(&mut File) -> io::Result<()>,
    before_replace: impl FnOnce() -> Result<(), String>,
    sync_parent: impl FnOnce(&Path) -> io::Result<()>,
) -> Result<(), String> {
    replace_canvas_file_with_policy(path, write, before_replace, sync_parent, false)
}

fn replace_canvas_file_with_policy(
    path: &Path,
    write: impl FnOnce(&mut File) -> io::Result<()>,
    before_replace: impl FnOnce() -> Result<(), String>,
    sync_parent: impl FnOnce(&Path) -> io::Result<()>,
    create_only: bool,
) -> Result<(), String> {
    let parent = path.parent().ok_or("Canvas destination has no parent directory")?;
    let existing = match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if create_only {
                return Err("Recovery export destination already exists; choose a new file".into());
            }
            if !metadata.file_type().is_file() {
                return Err("Canvas destination must be a regular file".into());
            }
            if metadata.permissions().readonly() {
                return Err(
                    "Canvas destination is read-only; use Save As to choose another file".into()
                );
            }
            Some(writable_target_metadata(path)?)
        }
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
    if let Some(metadata) = &existing {
        file.set_permissions(metadata.permissions())
            .map_err(|error| format!("Cannot preserve canvas permissions: {error}"))?;
    }
    file.sync_all().map_err(|error| format!("Cannot sync canvas: {error}"))?;
    drop(file);
    before_replace()?;
    if let Some(previous) = &existing {
        let current = writable_target_metadata(path)?;
        if !same_target(previous, &current) {
            return Err("Canvas destination changed while saving; retry or use Save As".into());
        }
    } else if !create_only {
        match fs::symlink_metadata(path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Ok(_) => {
                return Err("Canvas destination appeared while saving; retry or use Save As".into())
            }
            Err(error) => return Err(format!("Cannot inspect canvas destination: {error}")),
        }
    }
    if create_only {
        // hard_link is create-new at the destination: it cannot replace a
        // project even if another process creates one after the save dialog.
        fs::hard_link(&temporary.0, path).map_err(|error| {
            format!("Cannot create recovery export; choose a new file ({error})")
        })?;
        fs::remove_file(&temporary.0).map_err(|error| {
            format!("Recovery export written, but temporary cleanup failed: {error}")
        })?;
    } else {
        fs::rename(&temporary.0, path)
            .map_err(|error| format!("Cannot replace canvas: {error}"))?;
    }
    temporary.1 = false;
    match sync_parent(parent) {
        Ok(()) => Ok(()),
        Err(error) if directory_sync_unsupported(&error) => Ok(()),
        // The new bytes are already in place. Report the durability failure so
        // the session stays dirty and the user can retry or Save As elsewhere.
        Err(error) => Err(format!(
            "Canvas written, but its folder could not be flushed to disk ({error}); save again or use Save As"
        )),
    }
}

#[tauri::command]
pub async fn save_canvas_atomic<R: Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
    contents: String,
    create_only: Option<bool>,
) -> Result<(), String> {
    let path = PathBuf::from(path);
    let scope = app.try_fs_scope().ok_or("Filesystem scope is unavailable")?;
    validate_destination(&scope, &path)?;
    let operation = crate::lifecycle::OperationGuard::start(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        replace_canvas_file_with_policy(
            &path,
            |file| file.write_all(contents.as_bytes()),
            || {
                #[cfg(all(debug_assertions, feature = "tauri-plugin-wdio-webdriver"))]
                desktop_save_barrier(&path)?;
                validate_destination(&scope, &path)
            },
            sync_directory,
            create_only.unwrap_or(false),
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

    fn scratch_directory(label: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "sigma-{label}-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&directory).unwrap();
        directory
    }

    #[cfg(unix)]
    #[test]
    fn overwrite_requires_effective_writability_and_a_writable_folder() {
        use std::os::unix::fs::PermissionsExt;
        let directory = scratch_directory("writability-test");
        let path = directory.join("canvas.json");
        fs::write(&path, "original").unwrap();
        for mode in [0o464, 0o444] {
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
            let result = replace_canvas_file(&path, |file| file.write_all(b"wrong"), || Ok(()));
            assert!(result.is_err(), "mode {mode:o} was replaced");
            assert_eq!(fs::read_to_string(&path).unwrap(), "original");
            assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        }
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        replace_canvas_file(&path, |file| file.write_all(b"saved"), || Ok(())).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "saved");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o555)).unwrap();
        let result = replace_canvas_file(&path, |file| file.write_all(b"wrong"), || Ok(()));
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "saved");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn raw_recovery_export_never_replaces_an_existing_file() {
        let directory = scratch_directory("recovery-export-test");
        let path = directory.join("backup.json");
        fs::write(&path, "valid project").unwrap();
        let result = replace_canvas_file_with_policy(
            &path,
            |file| file.write_all(b"{invalid"),
            || Ok(()),
            sync_directory,
            true,
        );
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "valid project");
        let fresh = directory.join("fresh.json");
        replace_canvas_file_with_policy(
            &fresh,
            |file| file.write_all(b"{invalid"),
            || Ok(()),
            sync_directory,
            true,
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&fresh).unwrap(), "{invalid");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn directory_sync_failure_is_reported_and_unsupported_sync_is_tolerated() {
        let directory = scratch_directory("dirsync-test");
        let path = directory.join("canvas.json");
        fs::write(&path, "last valid").unwrap();

        let failed = replace_canvas_file_with(
            &path,
            |file| file.write_all(b"new bytes"),
            || Ok(()),
            |_| Err(io::Error::from_raw_os_error(libc::EIO)),
        );
        let message = failed.expect_err("an I/O error flushing the folder must be reported");
        assert!(message.contains("could not be flushed"), "{message}");
        // The rename already happened: the destination is the complete new
        // file, never a partial one, and no temporary file is left behind.
        assert_eq!(fs::read_to_string(&path).unwrap(), "new bytes");
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);

        for unsupported in [
            io::Error::from_raw_os_error(libc::EINVAL),
            io::Error::from_raw_os_error(libc::ENOTSUP),
            io::Error::from(io::ErrorKind::Unsupported),
        ] {
            assert!(replace_canvas_file_with(
                &path,
                |file| file.write_all(b"newer bytes"),
                || Ok(()),
                move |_| Err(unsupported),
            )
            .is_ok());
        }
        assert_eq!(fs::read_to_string(&path).unwrap(), "newer bytes");
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn folder_permission_revoked_during_save_preserves_original() {
        use std::os::unix::fs::PermissionsExt;
        let directory = scratch_directory("revoke-test");
        let path = directory.join("canvas.json");
        fs::write(&path, "last valid").unwrap();
        let writable = fs::metadata(&directory).unwrap().permissions();
        let result = replace_canvas_file(
            &path,
            |file| file.write_all(b"unwanted"),
            || {
                // Revoke write access after the temporary file is complete but
                // before it replaces the destination.
                fs::set_permissions(&directory, fs::Permissions::from_mode(0o555))
                    .map_err(|error| error.to_string())
            },
        );
        fs::set_permissions(&directory, writable).unwrap();
        // Running as root would bypass the permission check entirely.
        if unsafe { libc::geteuid() } == 0 {
            fs::remove_dir_all(directory).unwrap();
            return;
        }
        let message = result.expect_err("rename into a read-only folder must fail");
        assert!(message.contains("Cannot replace canvas"), "{message}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "last valid");
        // The temporary file cannot be unlinked while the folder is read-only;
        // it is hidden and never replaces the destination.
        let leftovers: Vec<_> = fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name != "canvas.json")
            .collect();
        assert!(leftovers.iter().all(|name| name.starts_with(".sigma-canvas-")), "{leftovers:?}");
        fs::remove_dir_all(directory).unwrap();
    }

    /// Real out-of-space failure. Needs a small, nearly full volume, so it is
    /// opt-in: `scripts/fs-faults/disk-full.sh` creates and removes one.
    #[test]
    #[ignore = "requires SIGMA_FULL_VOLUME_DIR on a nearly full volume"]
    fn disk_full_preserves_original_and_removes_temporary() {
        let Some(volume) = std::env::var_os("SIGMA_FULL_VOLUME_DIR") else {
            panic!("set SIGMA_FULL_VOLUME_DIR");
        };
        let directory = PathBuf::from(volume);
        let path = directory.join("canvas.json");
        let original = fs::read_to_string(&path).expect("script seeds canvas.json");
        let before: Vec<_> =
            fs::read_dir(&directory).unwrap().map(|e| e.unwrap().file_name()).collect();
        let large = vec![b'x'; 8 * 1024 * 1024];
        let result = replace_canvas_file(&path, |file| file.write_all(&large), || Ok(()));
        let message = result.expect_err("an 8 MiB write must not fit");
        assert!(
            message.contains("Cannot write canvas") || message.contains("Cannot sync canvas"),
            "{message}"
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        let after: Vec<_> =
            fs::read_dir(&directory).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(before.len(), after.len(), "temporary file was not removed: {after:?}");
        // A small save still succeeds once it fits.
        fs::remove_file(directory.join("filler")).expect("script creates filler");
        replace_canvas_file(&path, |file| file.write_all(b"{\"items\":[]}"), || Ok(())).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"items\":[]}");
    }

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
        let permissions = fs::metadata(&path).unwrap().permissions();
        let mut readonly = permissions.clone();
        readonly.set_readonly(true);
        fs::set_permissions(&path, readonly).unwrap();
        let readonly_result =
            replace_canvas_file(&path, |file| file.write_all(b"unwanted"), || Ok(()));
        assert!(readonly_result.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "last valid");
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::set_permissions(&path, permissions).unwrap();
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
