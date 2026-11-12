use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use tauri::{AppHandle, Emitter, Manager, Runtime, State};

const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);

// Tao 0.35 handles applicationWillTerminate but does not ask Tauri's
// ExitRequested callback before Cocoa's terminate: (including the Quit menu).
// Add only the optional should-terminate method to this delegate instance;
// all of Tao's existing delegate behavior and ivars remain inherited.
#[cfg(target_os = "macos")]
pub(crate) fn install_macos_termination_handler<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(), String> {
    use objc2::{
        class, msg_send,
        runtime::{AnyObject, ClassBuilder, Sel},
        sel,
    };
    use std::sync::OnceLock;

    static ON_QUIT: OnceLock<Box<dyn Fn() -> bool + Send + Sync>> = OnceLock::new();
    extern "C" fn should_terminate(_: &AnyObject, _: Sel, _: &AnyObject) -> usize {
        // NSUInteger / NSApplicationTerminateReply: 0 cancels Cocoa's immediate
        // exit. Our normal asynchronous coordinator exits after acknowledgment.
        usize::from(ON_QUIT.get().is_some_and(|on_quit| on_quit()))
    }

    let handle = app.clone();
    ON_QUIT
        .set(Box::new(move || {
            if exit_approved(&handle) {
                return true;
            }
            request_shutdown(&handle);
            false
        }))
        .map_err(|_| "macOS termination handler is already installed".to_string())?;

    // SAFETY: run() calls this once on the main thread after Tao creates its
    // delegate. The subclass adds no ivars, uses the documented AppKit ABI, and
    // changes no existing Tao methods. NSApplication retains the same delegate.
    unsafe {
        let application: &AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let delegate: Option<&AnyObject> = msg_send![application, delegate];
        let delegate = delegate.ok_or("NSApplication has no delegate")?;
        let mut subclass = ClassBuilder::new("SigmaLifecycleAppDelegate", delegate.class())
            .ok_or("Could not register the Sigma application delegate subclass")?;
        subclass.add_method(
            sel!(applicationShouldTerminate:),
            should_terminate as extern "C" fn(_, _, _) -> usize,
        );
        AnyObject::set_class(delegate, subclass.register());
    }
    Ok(())
}

#[derive(Clone, Default)]
pub(crate) struct ShutdownState(Arc<Mutex<Shutdown>>, Arc<tokio::sync::Notify>);

#[derive(Default)]
struct Shutdown {
    sequence: u32,
    pending: Option<u32>,
    ready: bool,
    stopping: bool,
    approved: bool,
    operations: usize,
}

pub(crate) struct OperationGuard(ShutdownState);

impl ShutdownState {
    fn begin_operation(&self) -> Result<OperationGuard, String> {
        let mut state = self.0.lock().unwrap();
        if state.stopping || state.approved {
            return Err("Application is shutting down".into());
        }
        state.operations += 1;
        Ok(OperationGuard(self.clone()))
    }

    async fn drain(&self) {
        loop {
            let changed = self.1.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.0.lock().unwrap().operations == 0 {
                return;
            }
            changed.await;
        }
    }
}

impl OperationGuard {
    pub(crate) fn start<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        app.state::<ShutdownState>().begin_operation()
    }
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        self.0 .0.lock().unwrap().operations -= 1;
        self.0 .1.notify_waiters();
    }
}

impl Shutdown {
    fn begin(&mut self) -> Option<u32> {
        if self.pending.is_some() || self.approved {
            return None;
        }
        self.sequence += 1;
        self.pending = Some(self.sequence);
        Some(self.sequence)
    }

    fn cancel(&mut self, id: u32) -> bool {
        if self.pending != Some(id) || self.approved {
            return false;
        }
        self.pending = None;
        self.stopping = false;
        true
    }
}

pub(crate) fn exit_approved<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<ShutdownState>().0.lock().unwrap().approved
}

pub(crate) fn while_running<R: Runtime, T>(
    app: &AppHandle<R>,
    operation: impl FnOnce() -> T,
) -> Result<T, String> {
    let state = app.state::<ShutdownState>();
    let state = state.0.lock().unwrap();
    if state.stopping || state.approved {
        return Err("Application is shutting down".into());
    }
    Ok(operation())
}

fn cancel<R: Runtime>(app: &AppHandle<R>, id: u32, message: &str) {
    let canceled = app.state::<ShutdownState>().0.lock().unwrap().cancel(id);
    if canceled {
        eprintln!("Shutdown canceled: {message}");
        let _ =
            app.emit("sigma:shutdown-failed", serde_json::json!({ "id": id, "message": message }));
    }
}

pub(crate) fn request_shutdown<R: Runtime>(app: &AppHandle<R>) {
    let (id, ready) = {
        let state = app.state::<ShutdownState>();
        let mut state = state.0.lock().unwrap();
        let Some(id) = state.begin() else { return };
        (id, state.ready)
    };
    if ready {
        if let Err(error) = app.emit("sigma:shutdown-request", id) {
            cancel(app, id, &error.to_string());
            return;
        }
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SHUTDOWN_TIMEOUT).await;
        cancel(&app, id, "Saving or cleanup did not finish within 10 seconds. The app is still open; wait for the operation to finish and try again.");
    });
}

#[tauri::command]
pub(crate) fn lifecycle_ready<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ShutdownState>,
) -> Result<(), String> {
    let pending = {
        let mut state = state.0.lock().unwrap();
        state.ready = true;
        state.pending
    };
    if let Some(id) = pending {
        app.emit("sigma:shutdown-request", id).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn complete_shutdown<R: Runtime>(
    app: AppHandle<R>,
    id: u32,
    error: Option<String>,
) -> Result<(), String> {
    if let Some(error) = error {
        cancel(&app, id, &error);
        return Ok(());
    }
    {
        let state = app.state::<ShutdownState>();
        let mut state = state.0.lock().unwrap();
        if state.pending != Some(id) || state.stopping || state.approved {
            return Ok(());
        }
        state.stopping = true;
    }
    // New manifests are rejected once cleanup begins, so a delayed frontend
    // update cannot restart a decoder after stop-all has completed.
    let cleanup = tokio::time::timeout(SHUTDOWN_TIMEOUT, async {
        app.state::<ShutdownState>().drain().await;
        crate::native_video::commands::native_video_stop_all(app.state()).await
    })
    .await
    .map_err(|_| "Native operations did not finish before the shutdown deadline".to_string())
    .and_then(|result| result);
    if let Err(error) = cleanup {
        cancel(&app, id, &error);
        return Err(error);
    }
    {
        let state = app.state::<ShutdownState>();
        let mut state = state.0.lock().unwrap();
        if state.pending != Some(id) {
            return Ok(());
        }
        state.approved = true;
    }
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn native_operations_are_drained_and_late_work_is_rejected() {
        let state = ShutdownState::default();
        let operation = state.begin_operation().unwrap();
        state.0.lock().unwrap().stopping = true;
        assert!(state.begin_operation().is_err());
        assert!(tokio::time::timeout(Duration::from_millis(10), state.drain()).await.is_err());
        drop(operation);
        tokio::time::timeout(Duration::from_secs(1), state.drain()).await.unwrap();
    }

    #[test]
    fn repeated_close_is_coalesced_and_timed_out_acknowledgments_are_stale() {
        let mut state = Shutdown::default();
        let first = state.begin().unwrap();
        assert_eq!(state.begin(), None);
        state.stopping = true;
        assert!(state.cancel(first));
        assert!(!state.stopping);
        let second = state.begin().unwrap();
        assert_ne!(first, second);
        assert!(!state.cancel(first));
        assert_eq!(state.pending, Some(second));
        state.approved = true;
        assert!(!state.cancel(second));
        assert_eq!(state.begin(), None);
    }
}
