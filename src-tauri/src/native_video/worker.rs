use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::{
    sync::{mpsc, watch},
    task, time,
};

use super::{
    constants::BROKER_QUEUE_CAPACITY,
    frame_packet::write_synthetic_yuv420_packet,
    telemetry::{update_telemetry, TelemetrySnapshot},
    types::{QualityDecision, StreamState},
};

pub(crate) type FrameSubscribers = Arc<Mutex<Vec<Channel<InvokeResponseBody>>>>;

const DISPATCH_UNWRAP_RETRIES: usize = 8;

#[derive(Clone, Debug)]
pub(crate) enum WorkerAssignment {
    Active {
        asset_id: String,
        stream_id: u64,
        width: u32,
        height: u32,
        fps: u32,
        tier_id: u8,
    },
    Suspended,
}

pub(crate) struct WorkerHandle {
    pub(crate) tx: watch::Sender<WorkerAssignment>,
    pub(crate) task: tauri::async_runtime::JoinHandle<()>,
}

pub(crate) struct DecodedFrame {
    packet: PooledFramePacket,
}

// FramePool preallocates and recycles decode buffers.
/// FramePool ownership contract.
///
/// - `FramePool::new` allocates a fixed ring of `Arc<Vec<u8>>` buffers sized for the maximum SVF1
///   packet. The ring is seeded into a bounded recycle channel at subsystem startup.
/// - Decode workers borrow a unique `Arc<Vec<u8>>` with `try_borrow`; this is a non-blocking
///   `try_recv` from the recycle queue. Workers write the packet in place and send the
///   `PooledFramePacket` to the broker.
/// - If a packet is dropped before IPC dispatch, `Drop` returns the original `Arc<Vec<u8>>` to the
///   recycle queue with `try_send`; no `Mutex<Vec<_>>` free list is used.
/// - `FramePool::dispatch` is the sole IPC handoff point. It takes the `Arc<Vec<u8>>` out of the
///   drop wrapper and uses `Arc::try_unwrap()` so `InvokeResponseBody::Raw` receives the owned
///   `Vec<u8>` directly. On successful unwrap the wrapper is consumed and does not recycle the
///   buffer because IPC now owns it. On unwrap timeout or send failure, `Drop` recycles the buffer.
pub(crate) struct FramePool {
    recycle_tx: mpsc::Sender<Arc<Vec<u8>>>,
    recycle_rx: Mutex<mpsc::Receiver<Arc<Vec<u8>>>>,
    max_frame_bytes: usize,
    capacity: usize,
    exhaustion_count: AtomicU64,
}

pub(crate) struct PooledFramePacket {
    buffer: Option<Arc<Vec<u8>>>,
    pool: Arc<FramePool>,
    len: usize,
}

impl FramePool {
    pub(crate) fn new(channel_depth: usize, max_frame_bytes: usize) -> Arc<Self> {
        let capacity = channel_depth.saturating_add(2);
        let (recycle_tx, recycle_rx) = mpsc::channel(capacity);
        let pool = Arc::new(Self {
            recycle_tx,
            recycle_rx: Mutex::new(recycle_rx),
            max_frame_bytes,
            capacity,
            exhaustion_count: AtomicU64::new(0),
        });

        for _ in 0..capacity {
            let _ = pool
                .recycle_tx
                .try_send(Arc::new(vec![0_u8; max_frame_bytes]));
        }

        pool
    }

    pub(crate) fn capacity(&self) -> usize {
        self.capacity
    }

    pub(crate) fn exhaustion_count(&self) -> u64 {
        self.exhaustion_count.load(Ordering::Relaxed)
    }

    pub(crate) fn try_borrow(self: &Arc<Self>) -> Option<PooledFramePacket> {
        let borrowed = self
            .recycle_rx
            .lock()
            .ok()
            .and_then(|mut recycle_rx| recycle_rx.try_recv().ok());

        match borrowed {
            Some(buffer) => Some(PooledFramePacket {
                buffer: Some(buffer),
                pool: self.clone(),
                len: 0,
            }),
            None => {
                let count = self.exhaustion_count.fetch_add(1, Ordering::Relaxed) + 1;
                eprintln!("native-video: frame pool exhausted; total_exhaustions={count}");
                None
            }
        }
    }

    fn recycle(&self, buffer: Arc<Vec<u8>>) {
        if buffer.len() != self.max_frame_bytes {
            eprintln!(
                "native-video: dropping frame buffer with unexpected size {}; expected {}",
                buffer.len(),
                self.max_frame_bytes
            );
            return;
        }

        if self.recycle_tx.try_send(buffer).is_err() {
            eprintln!("native-video: frame recycle queue is full or closed; dropping buffer");
        }
    }

    pub(crate) async fn dispatch(
        &self,
        mut packet: PooledFramePacket,
        on_frame: &Channel<InvokeResponseBody>,
    ) -> bool {
        // FIX: VIOLATION 2 — IPC receives the owned pool buffer without `Arc<[u8]>::to_vec()`.
        for attempt in 0..=DISPATCH_UNWRAP_RETRIES {
            let Some(buffer) = packet.buffer.take() else {
                return false;
            };

            match Arc::try_unwrap(buffer) {
                Ok(mut vec) => {
                    vec.truncate(packet.len);
                    packet.len = 0;
                    return on_frame.send(InvokeResponseBody::Raw(vec)).is_ok();
                }
                Err(buffer) => {
                    packet.buffer = Some(buffer);
                    if attempt == DISPATCH_UNWRAP_RETRIES {
                        eprintln!(
                            "native-video: dropping frame after Arc::try_unwrap timeout at IPC boundary"
                        );
                        return false;
                    }
                    task::yield_now().await;
                }
            }
        }

        false
    }
}

impl PooledFramePacket {
    pub(crate) fn bytes_mut(&mut self) -> Option<&mut [u8]> {
        Arc::get_mut(self.buffer.as_mut()?).map(|buffer| buffer.as_mut_slice())
    }

    pub(crate) fn set_len(&mut self, len: usize) {
        self.len = len;
    }
}

impl Drop for PooledFramePacket {
    fn drop(&mut self) {
        if let Some(buffer) = self.buffer.take() {
            self.pool.recycle(buffer);
        }
    }
}

pub(crate) fn reconcile_workers(
    workers: &mut HashMap<u64, WorkerHandle>,
    allocations: &[QualityDecision],
    broker_tx: mpsc::Sender<DecodedFrame>,
    frame_pool: Arc<FramePool>,
    telemetry: Arc<Mutex<TelemetrySnapshot>>,
    telemetry_tx: watch::Sender<TelemetrySnapshot>,
) {
    let active_ids: HashSet<u64> = allocations
        .iter()
        .map(|allocation| allocation.stream_id)
        .collect();

    workers.retain(|stream_id, worker| {
        if active_ids.contains(stream_id) {
            true
        } else {
            worker.task.abort();
            false
        }
    });

    for allocation in allocations {
        let assignment = if allocation.state == StreamState::Active {
            WorkerAssignment::Active {
                asset_id: allocation.asset_id.clone(),
                stream_id: allocation.stream_id,
                width: allocation.decode_width,
                height: allocation.decode_height,
                fps: allocation.fps,
                tier_id: allocation.tier.id,
            }
        } else {
            WorkerAssignment::Suspended
        };

        if let Some(worker) = workers.get(&allocation.stream_id) {
            let _ = worker.tx.send(assignment);
            continue;
        }

        let (tx, rx) = watch::channel(assignment);
        let task = spawn_decode_worker(
            rx,
            broker_tx.clone(),
            frame_pool.clone(),
            telemetry.clone(),
            telemetry_tx.clone(),
        );
        workers.insert(allocation.stream_id, WorkerHandle { tx, task });
    }
}

fn spawn_decode_worker(
    mut assignment_rx: watch::Receiver<WorkerAssignment>,
    broker_tx: mpsc::Sender<DecodedFrame>,
    frame_pool: Arc<FramePool>,
    telemetry: Arc<Mutex<TelemetrySnapshot>>,
    telemetry_tx: watch::Sender<TelemetrySnapshot>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut sequence = 0_u64;

        loop {
            let assignment = assignment_rx.borrow().clone();
            match assignment {
                WorkerAssignment::Suspended => {
                    if assignment_rx.changed().await.is_err() {
                        break;
                    }
                }
                WorkerAssignment::Active {
                    asset_id: _asset_id,
                    stream_id,
                    width,
                    height,
                    fps,
                    tier_id,
                } => {
                    let mut interval =
                        time::interval(Duration::from_secs_f64(1.0 / fps.max(1) as f64));
                    loop {
                        tokio::select! {
                            changed = assignment_rx.changed() => {
                                if changed.is_err() {
                                    return;
                                }
                                break;
                            }
                            _ = interval.tick() => {
                                let Some(mut packet) = frame_pool.try_borrow() else {
                                    update_telemetry(&telemetry, &telemetry_tx, |snapshot| {
                                        snapshot.frame_pool_capacity = frame_pool.capacity();
                                        snapshot.frame_pool_exhaustions = frame_pool.exhaustion_count();
                                    });
                                    task::yield_now().await;
                                    continue;
                                };

                                let Some(bytes) = packet.bytes_mut() else {
                                    task::yield_now().await;
                                    continue;
                                };

                                let len = write_synthetic_yuv420_packet(
                                    bytes,
                                    stream_id,
                                    sequence,
                                    sequence.saturating_mul(1_000_000) / fps.max(1) as u64,
                                    width,
                                    height,
                                    tier_id,
                                );
                                packet.set_len(len);
                                sequence = sequence.wrapping_add(1);
                                if broker_tx.try_send(DecodedFrame { packet }).is_err() {
                                    time::sleep(Duration::from_millis(4)).await;
                                }
                            }
                        }
                    }
                }
            }
        }
    })
}

pub(crate) fn spawn_frame_broker(
    mut frame_rx: mpsc::Receiver<DecodedFrame>,
    subscribers: FrameSubscribers,
    telemetry: Arc<Mutex<TelemetrySnapshot>>,
    telemetry_tx: watch::Sender<TelemetrySnapshot>,
) {
    tauri::async_runtime::spawn(async move {
        let mut delivered_frames = 0_u64;
        let mut dropped_frames = 0_u64;

        while let Some(frame) = frame_rx.recv().await {
            let queue_depth = frame_rx.len();
            let frame_pool = frame.packet.pool.clone();
            let subscriber = subscribers
                .lock()
                .ok()
                .and_then(|subscribers| subscribers.last().cloned());

            match subscriber {
                Some(on_frame) => {
                    if frame_pool.dispatch(frame.packet, &on_frame).await {
                        delivered_frames = delivered_frames.saturating_add(1);
                    } else {
                        dropped_frames = dropped_frames.saturating_add(1);
                        if let Ok(mut subscribers) = subscribers.lock() {
                            subscribers.retain(|candidate| candidate.id() != on_frame.id());
                        }
                    }
                }
                None => {
                    dropped_frames = dropped_frames.saturating_add(1);
                }
            }

            update_telemetry(&telemetry, &telemetry_tx, |snapshot| {
                snapshot.delivered_frames = delivered_frames;
                snapshot.dropped_frames = dropped_frames;
                snapshot.broker_queue_depth = queue_depth;
                snapshot.broker_queue_capacity = BROKER_QUEUE_CAPACITY;
                snapshot.broker_queue_pressure =
                    queue_depth as f64 / BROKER_QUEUE_CAPACITY.max(1) as f64;
                snapshot.frame_pool_capacity = frame_pool.capacity();
                snapshot.frame_pool_exhaustions = frame_pool.exhaustion_count();
                let total = delivered_frames + dropped_frames;
                snapshot.frame_drop_rate = if total == 0 {
                    0.0
                } else {
                    dropped_frames as f64 / total as f64
                };
            });
        }
    });
}
