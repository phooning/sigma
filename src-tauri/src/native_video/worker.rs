use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::{
    sync::{broadcast, mpsc, watch},
    time,
};

use super::{
    constants::BROKER_QUEUE_CAPACITY,
    frame_packet::make_frame_packet,
    telemetry::{update_telemetry, TelemetrySnapshot},
    types::{QualityDecision, StreamState},
};

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
    packet: Vec<u8>,
}

pub(crate) fn reconcile_workers(
    workers: &mut HashMap<u64, WorkerHandle>,
    allocations: &[QualityDecision],
    broker_tx: mpsc::Sender<DecodedFrame>,
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
        let task = spawn_decode_worker(rx, broker_tx.clone());
        workers.insert(allocation.stream_id, WorkerHandle { tx, task });
    }
}

fn spawn_decode_worker(
    mut assignment_rx: watch::Receiver<WorkerAssignment>,
    broker_tx: mpsc::Sender<DecodedFrame>,
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
                                let packet = make_frame_packet(
                                    stream_id,
                                    sequence,
                                    sequence.saturating_mul(1_000_000) / fps.max(1) as u64,
                                    width,
                                    height,
                                    tier_id,
                                );
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
    frame_tx: broadcast::Sender<Arc<[u8]>>,
    telemetry: Arc<Mutex<TelemetrySnapshot>>,
    telemetry_tx: watch::Sender<TelemetrySnapshot>,
) {
    tauri::async_runtime::spawn(async move {
        let mut delivered_frames = 0_u64;
        let mut dropped_frames = 0_u64;

        while let Some(frame) = frame_rx.recv().await {
            let queue_depth = frame_rx.len();
            match frame_tx.send(Arc::<[u8]>::from(frame.packet.into_boxed_slice())) {
                Ok(_) => delivered_frames = delivered_frames.saturating_add(1),
                Err(_) => dropped_frames = dropped_frames.saturating_add(1),
            }

            update_telemetry(&telemetry, &telemetry_tx, |snapshot| {
                snapshot.delivered_frames = delivered_frames;
                snapshot.dropped_frames = dropped_frames;
                snapshot.broker_queue_depth = queue_depth;
                snapshot.broker_queue_capacity = BROKER_QUEUE_CAPACITY;
                snapshot.broker_queue_pressure =
                    queue_depth as f64 / BROKER_QUEUE_CAPACITY.max(1) as f64;
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
