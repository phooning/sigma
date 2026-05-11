use std::{
    collections::{HashMap, HashSet},
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::{
    io::AsyncReadExt,
    process::Command as TokioCommand,
    sync::{mpsc, watch},
    task, time,
};

use super::{
    constants::BROKER_QUEUE_CAPACITY,
    frame_packet::{write_yuv420_packet_from_payload, yuv420_payload_len},
    telemetry::{update_telemetry, TelemetrySnapshot},
    types::{QualityDecision, StreamState},
};

pub(crate) type FrameSubscribers = Arc<Mutex<Option<Channel<InvokeResponseBody>>>>;
const QUEUE_PRESSURE_WINDOW: usize = 3;

#[derive(Clone, Debug)]
pub(crate) enum WorkerAssignment {
    Active {
        asset_id: String,
        source_path: String,
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

struct QueuePressureSmoother {
    samples: [f64; QUEUE_PRESSURE_WINDOW],
    next: usize,
    len: usize,
}

impl QueuePressureSmoother {
    fn new() -> Self {
        Self { samples: [0.0; QUEUE_PRESSURE_WINDOW], next: 0, len: 0 }
    }

    fn push(&mut self, sample: f64) -> f64 {
        self.samples[self.next] = sample;
        self.next = (self.next + 1) % QUEUE_PRESSURE_WINDOW;
        self.len = self.len.saturating_add(1).min(QUEUE_PRESSURE_WINDOW);
        self.samples[..self.len].iter().sum::<f64>() / self.len as f64
    }
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
/// - `FramePool::dispatch` is the sole IPC handoff point. It copies the valid packet bytes into a
///   fresh IPC payload, then immediately returns the original `Arc<Vec<u8>>` to the pool so native
///   decode never waits on frontend or IPC ownership lifetimes.
pub(crate) struct FramePool {
    recycle_tx: mpsc::Sender<Arc<Vec<u8>>>,
    recycle_rx: Mutex<mpsc::Receiver<Arc<Vec<u8>>>>,
    max_frame_bytes: usize,
    capacity: usize,
    exhaustion_count: AtomicU64,
    channel_send_failure_count: AtomicU64,
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
            channel_send_failure_count: AtomicU64::new(0),
        });

        for _ in 0..capacity {
            let _ = pool.recycle_tx.try_send(Arc::new(vec![0_u8; max_frame_bytes]));
        }

        pool
    }

    pub(crate) fn capacity(&self) -> usize {
        self.capacity
    }

    pub(crate) fn exhaustion_count(&self) -> u64 {
        self.exhaustion_count.load(Ordering::Relaxed)
    }

    pub(crate) fn channel_send_failure_count(&self) -> u64 {
        self.channel_send_failure_count.load(Ordering::Relaxed)
    }

    pub(crate) fn try_borrow(self: &Arc<Self>) -> Option<PooledFramePacket> {
        let borrowed =
            self.recycle_rx.lock().ok().and_then(|mut recycle_rx| recycle_rx.try_recv().ok());

        match borrowed {
            Some(buffer) => {
                Some(PooledFramePacket { buffer: Some(buffer), pool: self.clone(), len: 0 })
            }
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
        let Some(buffer) = packet.buffer.take() else {
            return false;
        };

        let len = packet.len.min(buffer.len());
        let fresh_for_ipc = buffer[..len].to_vec();
        packet.len = 0;
        let sent = match on_frame.send(InvokeResponseBody::Raw(fresh_for_ipc)) {
            Ok(()) => true,
            Err(error) => {
                let count = self.channel_send_failure_count.fetch_add(1, Ordering::Relaxed) + 1;
                eprintln!(
                    "native-video: failed to dispatch frame to IPC channel; total_send_failures={count}; error={error}"
                );
                false
            }
        };
        self.recycle(buffer);
        sent
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
    let active_ids: HashSet<u64> =
        allocations.iter().map(|allocation| allocation.stream_id).collect();

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
                source_path: allocation.source_path.clone(),
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
                    source_path,
                    stream_id,
                    width,
                    height,
                    fps,
                    tier_id,
                } => {
                    let source_path = source_path.trim().to_string();
                    if source_path.is_empty() {
                        if assignment_rx.changed().await.is_err() {
                            break;
                        }
                        continue;
                    }

                    let payload_len = yuv420_payload_len(width, height);
                    let mut child =
                        match spawn_ffmpeg_rawvideo_decoder(&source_path, width, height, fps) {
                            Ok(child) => child,
                            Err(_) => {
                                wait_for_reassignment_or_retry(&mut assignment_rx).await;
                                continue;
                            }
                        };
                    let Some(mut stdout) = child.stdout.take() else {
                        let _ = child.kill().await;
                        wait_for_reassignment_or_retry(&mut assignment_rx).await;
                        continue;
                    };
                    let mut payload = vec![0_u8; payload_len];
                    let mut interval =
                        time::interval(Duration::from_secs_f64(1.0 / fps.max(1) as f64));
                    loop {
                        tokio::select! {
                            changed = assignment_rx.changed() => {
                                if changed.is_err() {
                                    let _ = child.kill().await;
                                    return;
                                }
                                let _ = child.kill().await;
                                break;
                            }
                            _ = interval.tick() => {
                                let read_result = tokio::select! {
                                    changed = assignment_rx.changed() => {
                                        if changed.is_err() {
                                            let _ = child.kill().await;
                                            return;
                                        }
                                        let _ = child.kill().await;
                                        break;
                                    }
                                    read_result = stdout.read_exact(&mut payload) => read_result,
                                };

                                if read_result.is_err() {
                                    let _ = child.wait().await;
                                    wait_for_reassignment_or_retry(&mut assignment_rx).await;
                                    break;
                                }

                                let Some(mut packet) = frame_pool.try_borrow() else {
                                    update_telemetry(&telemetry, &telemetry_tx, |snapshot| {
                                        snapshot.frame_pool_capacity = frame_pool.capacity();
                                        snapshot.frame_pool_exhaustions = frame_pool.exhaustion_count();
                                        snapshot.frame_channel_send_failures = frame_pool.channel_send_failure_count();
                                    });
                                    task::yield_now().await;
                                    continue;
                                };

                                let Some(bytes) = packet.bytes_mut() else {
                                    task::yield_now().await;
                                    continue;
                                };

                                let len = write_yuv420_packet_from_payload(
                                    bytes,
                                    stream_id,
                                    sequence,
                                    sequence.saturating_mul(1_000_000) / fps.max(1) as u64,
                                    width,
                                    height,
                                    tier_id,
                                    &payload,
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

fn spawn_ffmpeg_rawvideo_decoder(
    source_path: &str,
    width: u32,
    height: u32,
    fps: u32,
) -> Result<tokio::process::Child, std::io::Error> {
    TokioCommand::new("ffmpeg")
        .args(ffmpeg_rawvideo_decoder_args(source_path, width, height, fps.max(1)))
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
}

fn ffmpeg_rawvideo_decoder_args(
    source_path: &str,
    width: u32,
    height: u32,
    fps: u32,
) -> Vec<String> {
    vec![
        "-v".into(),
        "error".into(),
        "-stream_loop".into(),
        "-1".into(),
        "-i".into(),
        source_path.into(),
        "-an".into(),
        "-vf".into(),
        format!("fps={},scale={}:{}:flags=fast_bilinear,format=yuv420p", fps.max(1), width, height),
        "-f".into(),
        "rawvideo".into(),
        "pipe:1".into(),
    ]
}

async fn wait_for_reassignment_or_retry(assignment_rx: &mut watch::Receiver<WorkerAssignment>) {
    tokio::select! {
        _ = assignment_rx.changed() => {}
        _ = time::sleep(Duration::from_millis(250)) => {}
    }
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
        let mut unsubscribed_drops = 0_u64;
        let mut queue_pressure = QueuePressureSmoother::new();

        while let Some(frame) = frame_rx.recv().await {
            let queue_depth = frame_rx.len();
            let queue_pressure_raw = queue_depth as f64 / BROKER_QUEUE_CAPACITY.max(1) as f64;
            let queue_pressure_smoothed = queue_pressure.push(queue_pressure_raw);
            let frame_pool = frame.packet.pool.clone();
            let subscriber = subscribers.lock().ok().and_then(|subscriber| subscriber.clone());

            match subscriber {
                Some(on_frame) => {
                    if frame_pool.dispatch(frame.packet, &on_frame).await {
                        delivered_frames = delivered_frames.saturating_add(1);
                    } else {
                        dropped_frames = dropped_frames.saturating_add(1);
                        if let Ok(mut subscriber) = subscribers.lock() {
                            if subscriber
                                .as_ref()
                                .is_some_and(|candidate| candidate.id() == on_frame.id())
                            {
                                *subscriber = None;
                            }
                        }
                    }
                }
                None => {
                    dropped_frames = dropped_frames.saturating_add(1);
                    unsubscribed_drops = unsubscribed_drops.saturating_add(1);
                }
            }

            update_telemetry(&telemetry, &telemetry_tx, |snapshot| {
                snapshot.delivered_frames = delivered_frames;
                snapshot.dropped_frames = dropped_frames;
                snapshot.broker_queue_depth = queue_depth;
                snapshot.broker_queue_capacity = BROKER_QUEUE_CAPACITY;
                snapshot.broker_queue_pressure = queue_pressure_raw;
                snapshot.broker_queue_pressure_smoothed = queue_pressure_smoothed;
                snapshot.frame_pool_capacity = frame_pool.capacity();
                snapshot.frame_pool_exhaustions = frame_pool.exhaustion_count();
                snapshot.frame_channel_send_failures = frame_pool.channel_send_failure_count();
                snapshot.frame_unsubscribed_drops = unsubscribed_drops;
                let total = delivered_frames + dropped_frames;
                snapshot.frame_drop_rate =
                    if total == 0 { 0.0 } else { dropped_frames as f64 / total as f64 };
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use tokio::sync::{mpsc, watch};

    use super::{
        ffmpeg_rawvideo_decoder_args, spawn_frame_broker, DecodedFrame, FramePool,
        FrameSubscribers, QueuePressureSmoother,
    };
    use crate::native_video::telemetry::TelemetrySnapshot;

    #[test]
    fn queue_pressure_smoother_averages_last_three_samples() {
        let mut smoother = QueuePressureSmoother::new();

        assert_eq!(smoother.push(0.25), 0.25);
        assert_eq!(smoother.push(0.5), 0.375);
        assert!((smoother.push(0.75) - 0.5).abs() < f64::EPSILON);
        assert!((smoother.push(1.0) - 0.75).abs() < f64::EPSILON);
    }

    #[test]
    fn ffmpeg_decoder_args_request_looped_yuv420_rawvideo() {
        let args = ffmpeg_rawvideo_decoder_args("sample.mp4", 1280, 720, 30);

        assert_eq!(
            args,
            vec![
                "-v".to_string(),
                "error".to_string(),
                "-stream_loop".to_string(),
                "-1".to_string(),
                "-i".to_string(),
                "sample.mp4".to_string(),
                "-an".to_string(),
                "-vf".to_string(),
                "fps=30,scale=1280:720:flags=fast_bilinear,format=yuv420p".to_string(),
                "-f".to_string(),
                "rawvideo".to_string(),
                "pipe:1".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn broker_counts_unsubscribed_drops_separately() {
        let subscribers: FrameSubscribers = Arc::new(Mutex::new(None));
        let telemetry = Arc::new(Mutex::new(TelemetrySnapshot::default()));
        let (telemetry_tx, telemetry_rx) = watch::channel(TelemetrySnapshot::default());
        let (broker_tx, broker_rx) = mpsc::channel(1);
        let pool = FramePool::new(0, 16);
        let mut packet = pool.try_borrow().expect("pooled packet");
        packet.set_len(0);

        spawn_frame_broker(broker_rx, subscribers, telemetry.clone(), telemetry_tx.clone());

        broker_tx.send(DecodedFrame { packet }).await.expect("broker frame send");
        drop(broker_tx);

        let mut telemetry_rx = telemetry_rx;
        telemetry_rx.changed().await.expect("telemetry update after unsubscribed drop");
        let snapshot = telemetry_rx.borrow().clone();

        assert_eq!(snapshot.delivered_frames, 0);
        assert_eq!(snapshot.dropped_frames, 1);
        assert_eq!(snapshot.frame_unsubscribed_drops, 1);
        assert_eq!(snapshot.frame_channel_send_failures, 0);
        assert_eq!(snapshot.frame_pool_exhaustions, 0);
    }
}
