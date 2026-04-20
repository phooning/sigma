use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use tauri::AppHandle;
use tokio::sync::{mpsc, watch};

use super::{
    constants::{BROKER_QUEUE_CAPACITY, MAX_FRAME_HEIGHT, MAX_FRAME_WIDTH},
    controller::{spawn_controller, ControlMessage},
    frame_packet::frame_packet_len,
    profile::{load_profile, profile_path, PerformanceProfile},
    resource_monitor::spawn_resource_monitor,
    telemetry::TelemetrySnapshot,
    worker::{spawn_frame_broker, FramePool, FrameSubscribers},
};

#[derive(Clone)]
pub struct NativeVideoState {
    pub(crate) control_tx: mpsc::Sender<ControlMessage>,
    pub(crate) frame_subscribers: FrameSubscribers,
    pub(crate) telemetry_tx: watch::Sender<TelemetrySnapshot>,
    pub(crate) telemetry: Arc<Mutex<TelemetrySnapshot>>,
    pub(crate) profile: Arc<Mutex<PerformanceProfile>>,
    pub(crate) profile_path: PathBuf,
}

impl NativeVideoState {
    pub fn new(app: &AppHandle) -> Self {
        let profile_path = profile_path(app);
        let profile_snapshot =
            load_profile(&profile_path).unwrap_or_else(PerformanceProfile::uncalibrated);
        let initial_telemetry = TelemetrySnapshot {
            broker_queue_capacity: BROKER_QUEUE_CAPACITY,
            safe_budget_bytes_per_sec: profile_snapshot.safe_budget_bytes_per_sec,
            ..TelemetrySnapshot::default()
        };
        let profile = Arc::new(Mutex::new(profile_snapshot));
        let telemetry = Arc::new(Mutex::new(initial_telemetry.clone()));
        let (telemetry_tx, _) = watch::channel(initial_telemetry);
        let (broker_tx, broker_rx) = mpsc::channel(BROKER_QUEUE_CAPACITY);
        let (control_tx, control_rx) = mpsc::channel(64);
        // The decode subsystem owns one shared pool sized to broker depth + 2.
        let frame_pool = FramePool::new(
            BROKER_QUEUE_CAPACITY,
            frame_packet_len(MAX_FRAME_WIDTH, MAX_FRAME_HEIGHT),
        );
        let frame_subscribers = Arc::new(Mutex::new(Vec::new()));

        spawn_resource_monitor(telemetry.clone(), telemetry_tx.clone());
        spawn_frame_broker(
            broker_rx,
            frame_subscribers.clone(),
            telemetry.clone(),
            telemetry_tx.clone(),
        );
        spawn_controller(
            control_rx,
            broker_tx,
            frame_pool.clone(),
            telemetry.clone(),
            telemetry_tx.clone(),
            profile.clone(),
        );

        Self {
            control_tx,
            frame_subscribers,
            telemetry_tx,
            telemetry,
            profile,
            profile_path,
        }
    }
}
