use std::{
    cmp::Ordering,
    collections::{BinaryHeap, HashMap},
    path::PathBuf,
    sync::Arc,
};

use serde::Deserialize;
use tauri::{AppHandle, Runtime};
use tokio::sync::{mpsc, oneshot, RwLock, Semaphore};

use crate::{generate_image_preview_blocking, generate_video_thumbnail_blocking};

type DecodeResult = Result<Option<PathBuf>, String>;

#[repr(u8)]
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Ord, PartialOrd)]
#[serde(rename_all = "lowercase")]
pub enum DecodePriority {
    Visible = 0,
    Prefetch = 1,
    Background = 2,
}

struct DecodeRequest {
    item_id: String,
    path: PathBuf,
    lod: u32,
    generation: u64,
    priority: DecodePriority,
    respond_to: oneshot::Sender<DecodeResult>,
}

struct QueuedDecodeRequest {
    sequence: u64,
    request: DecodeRequest,
}

impl Eq for QueuedDecodeRequest {}

impl PartialEq for QueuedDecodeRequest {
    fn eq(&self, other: &Self) -> bool {
        self.sequence == other.sequence && self.request.priority == other.request.priority
    }
}

impl Ord for QueuedDecodeRequest {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .request
            .priority
            .cmp(&self.request.priority)
            .then_with(|| other.sequence.cmp(&self.sequence))
    }
}

impl PartialOrd for QueuedDecodeRequest {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

pub struct DecodeArbiter {
    tx: mpsc::Sender<DecodeRequest>,
    generations: Arc<RwLock<HashMap<String, u64>>>,
}

impl DecodeArbiter {
    pub fn spawn<R: Runtime>(app: AppHandle<R>, max_parallel: usize) -> Self {
        let (tx, mut rx) = mpsc::channel::<DecodeRequest>(256);
        let generations = Arc::new(RwLock::new(HashMap::new()));
        let worker_generations = Arc::clone(&generations);
        let max_parallel = max_parallel.max(1);

        tauri::async_runtime::spawn(async move {
            let (completion_tx, mut completion_rx) = mpsc::channel::<()>(max_parallel);
            let semaphore = Arc::new(Semaphore::new(max_parallel));
            let mut queue = BinaryHeap::<QueuedDecodeRequest>::new();
            let mut sequence = 0_u64;
            let mut accepting_requests = true;

            loop {
                if !accepting_requests && queue.is_empty() {
                    break;
                }

                tokio::select! {
                    request = rx.recv(), if accepting_requests => {
                        if let Some(request) = request {
                            worker_generations
                                .write()
                                .await
                                .insert(request.item_id.clone(), request.generation);
                            queue.push(QueuedDecodeRequest { sequence, request });
                            sequence = sequence.wrapping_add(1);
                        } else {
                            accepting_requests = false;
                        }
                    }
                    _ = completion_rx.recv() => {}
                }

                while let Some(permit) = semaphore.clone().try_acquire_owned().ok() {
                    let Some(queued) = queue.pop() else {
                        drop(permit);
                        break;
                    };

                    let app = app.clone();
                    let completion_tx = completion_tx.clone();
                    let generations = Arc::clone(&worker_generations);
                    tauri::async_runtime::spawn(async move {
                        let _permit = permit;
                        let DecodeRequest {
                            item_id,
                            path,
                            lod,
                            generation,
                            respond_to,
                            ..
                        } = queued.request;

                        let decoded = if generations.read().await.get(&item_id).copied()
                            != Some(generation)
                        {
                            Ok(None)
                        } else {
                            let decode_path = path.clone();
                            let decoded = tauri::async_runtime::spawn_blocking(move || {
                                decode_preview_to_cache(app, decode_path, lod)
                            })
                            .await
                            .map_err(|err| format!("Failed to run decode task: {err}"))
                            .and_then(|result| result);

                            if generations.read().await.get(&item_id).copied() != Some(generation) {
                                Ok(None)
                            } else {
                                decoded
                            }
                        };

                        let _ = respond_to.send(decoded);
                        drop(_permit);
                        let _ = completion_tx.send(()).await;
                    });
                }
            }
        });

        Self { tx, generations }
    }

    pub async fn request_decode(
        &self,
        item_id: String,
        path: PathBuf,
        lod: u32,
        generation: u64,
        priority: DecodePriority,
    ) -> DecodeResult {
        let (respond_to, response) = oneshot::channel();
        self.tx
            .send(DecodeRequest {
                item_id,
                path,
                lod,
                generation,
                priority,
                respond_to,
            })
            .await
            .map_err(|_| "Decode arbiter is not available".to_string())?;

        response
            .await
            .map_err(|_| "Decode arbiter dropped the decode response".to_string())?
    }

    #[allow(dead_code)]
    pub async fn latest_generation(&self, item_id: &str) -> Option<u64> {
        self.generations.read().await.get(item_id).copied()
    }
}

fn decode_preview_to_cache<R: Runtime>(
    app: AppHandle<R>,
    path: PathBuf,
    lod: u32,
) -> DecodeResult {
    let path_string = path.to_string_lossy().into_owned();

    if is_video_path(&path) {
        return generate_video_thumbnail_blocking(app, path_string)
            .map(|path| path.map(PathBuf::from));
    }

    let max_dimension = match lod {
        0 => return Err("Decode LOD must be greater than zero".to_string()),
        1..=512 => 256,
        _ => 1024,
    };

    generate_image_preview_blocking(app, path_string, max_dimension)
        .map(|path| path.map(PathBuf::from))
}

fn is_video_path(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "mp4" | "webm" | "mov" | "mkv"
            )
        })
        .unwrap_or(false)
}
