use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use tokio::sync::{mpsc, oneshot, watch};

use super::{
    constants::{
        BASE_CASE_MAX_STREAMS_BEFORE_VALIDATION, BYTES_PER_PIXEL_RGBA8, DOWNGRADE_DROP_RATE,
        DOWNGRADE_QUEUE_PRESSURE, MATERIAL_OVERSAMPLE, MIN_DOWNGRADE_DWELL_MS,
        MIN_UPGRADE_DWELL_MS, SCALING_MAX_STREAMS_AFTER_VALIDATION, UPGRADE_HEADROOM,
        UPGRADE_QUEUE_PRESSURE,
    },
    profile::PerformanceProfile,
    telemetry::{update_telemetry, TelemetrySnapshot},
    types::{
        CanvasManifest, ControllerSnapshot, QualityDecision, QualityTier, StreamState,
        VisibleAsset, QUALITY_TIERS, SUSPENDED_TIER,
    },
    util::{now_millis, stable_stream_id},
    worker::{reconcile_workers, DecodedFrame, WorkerHandle},
};

#[derive(Debug)]
pub(crate) enum ControlMessage {
    UpdateManifest {
        manifest: CanvasManifest,
        respond_to: oneshot::Sender<ControllerSnapshot>,
    },
    StopAll {
        respond_to: oneshot::Sender<ControllerSnapshot>,
    },
}

pub(crate) fn spawn_controller(
    mut control_rx: mpsc::Receiver<ControlMessage>,
    broker_tx: mpsc::Sender<DecodedFrame>,
    telemetry: Arc<Mutex<TelemetrySnapshot>>,
    telemetry_tx: watch::Sender<TelemetrySnapshot>,
    profile: Arc<Mutex<PerformanceProfile>>,
) {
    tauri::async_runtime::spawn(async move {
        let mut manifest = CanvasManifest {
            canvas_width: 0,
            canvas_height: 0,
            viewport_zoom: 1.0,
            assets: Vec::new(),
        };
        let mut allocations: HashMap<u64, QualityDecision> = HashMap::new();
        let mut workers: HashMap<u64, WorkerHandle> = HashMap::new();

        while let Some(message) = control_rx.recv().await {
            match message {
                ControlMessage::UpdateManifest {
                    manifest: next_manifest,
                    respond_to,
                } => {
                    manifest = next_manifest;
                    let profile_snapshot = profile
                        .lock()
                        .map(|profile| profile.clone())
                        .unwrap_or_default();
                    let telemetry_snapshot = telemetry
                        .lock()
                        .map(|snapshot| snapshot.clone())
                        .unwrap_or_default();
                    let next_allocations = Arbiter::allocate(
                        &manifest,
                        &profile_snapshot,
                        &telemetry_snapshot,
                        &allocations,
                    );

                    reconcile_workers(&mut workers, &next_allocations, broker_tx.clone());
                    allocations = next_allocations
                        .iter()
                        .cloned()
                        .map(|allocation| (allocation.stream_id, allocation))
                        .collect();

                    let predicted_cost = allocations
                        .values()
                        .map(|allocation| allocation.predicted_cost_bytes_per_sec)
                        .sum();
                    let active_streams = allocations
                        .values()
                        .filter(|allocation| allocation.state == StreamState::Active)
                        .count();
                    let suspended_streams = allocations
                        .values()
                        .filter(|allocation| allocation.state != StreamState::Active)
                        .count();

                    update_telemetry(&telemetry, &telemetry_tx, |snapshot| {
                        snapshot.visible_streams = manifest.assets.len();
                        snapshot.active_streams = active_streams;
                        snapshot.suspended_streams = suspended_streams;
                        snapshot.predicted_cost_bytes_per_sec = predicted_cost;
                        snapshot.safe_budget_bytes_per_sec =
                            profile_snapshot.safe_budget_bytes_per_sec;
                        snapshot.over_budget =
                            predicted_cost > profile_snapshot.safe_budget_bytes_per_sec;
                    });

                    let snapshot = controller_snapshot(
                        &profile_snapshot,
                        &telemetry,
                        allocations.values().cloned().collect(),
                    );
                    let _ = respond_to.send(snapshot);
                }
                ControlMessage::StopAll { respond_to } => {
                    for worker in workers.drain().map(|(_, worker)| worker) {
                        worker.task.abort();
                    }
                    allocations.clear();
                    manifest.assets.clear();
                    let profile_snapshot = profile
                        .lock()
                        .map(|profile| profile.clone())
                        .unwrap_or_default();
                    update_telemetry(&telemetry, &telemetry_tx, |snapshot| {
                        snapshot.visible_streams = 0;
                        snapshot.active_streams = 0;
                        snapshot.suspended_streams = 0;
                        snapshot.predicted_cost_bytes_per_sec = 0;
                        snapshot.over_budget = false;
                    });
                    let snapshot = controller_snapshot(&profile_snapshot, &telemetry, Vec::new());
                    let _ = respond_to.send(snapshot);
                }
            }
        }
    });
}

pub(crate) struct Arbiter;

impl Arbiter {
    pub(crate) fn allocate(
        manifest: &CanvasManifest,
        profile: &PerformanceProfile,
        telemetry: &TelemetrySnapshot,
        previous: &HashMap<u64, QualityDecision>,
    ) -> Vec<QualityDecision> {
        let mut assets = manifest.assets.clone();
        assets.sort_by(|a, b| priority(b, manifest).total_cmp(&priority(a, manifest)));

        let now = now_millis();
        let max_active = if profile.base_case_validated {
            SCALING_MAX_STREAMS_AFTER_VALIDATION
        } else {
            BASE_CASE_MAX_STREAMS_BEFORE_VALIDATION
        };
        let overloaded = telemetry.broker_queue_pressure >= DOWNGRADE_QUEUE_PRESSURE
            || telemetry.frame_drop_rate >= DOWNGRADE_DROP_RATE
            || telemetry.predicted_cost_bytes_per_sec > profile.safe_budget_bytes_per_sec;
        let headroom = if profile.safe_budget_bytes_per_sec == 0 {
            0.0
        } else {
            1.0 - telemetry.predicted_cost_bytes_per_sec as f64
                / profile.safe_budget_bytes_per_sec as f64
        };
        let upgrades_allowed = headroom >= UPGRADE_HEADROOM
            && telemetry.broker_queue_pressure <= UPGRADE_QUEUE_PRESSURE;

        let mut total_cost = 0_u64;
        let mut active_count = 0_usize;
        let mut decisions = Vec::with_capacity(assets.len());

        for asset in assets {
            let stream_id = stable_stream_id(&asset.id);
            let asset_priority = priority(&asset, manifest);
            let previous_decision = previous.get(&stream_id);

            let candidate = if active_count < max_active {
                choose_candidate(
                    &asset,
                    profile,
                    profile.safe_budget_bytes_per_sec.saturating_sub(total_cost),
                )
            } else {
                None
            };

            let mut decision = if let Some((tier, width, height, cost)) = candidate {
                QualityDecision {
                    asset_id: asset.id.clone(),
                    stream_id,
                    state: StreamState::Active,
                    tier,
                    decode_width: width,
                    decode_height: height,
                    fps: asset.target_fps.clamp(1, 60),
                    priority: asset_priority,
                    predicted_cost_bytes_per_sec: cost,
                    last_changed_at_ms: now,
                    reason: "fits measured safe budget".into(),
                }
            } else {
                QualityDecision {
                    asset_id: asset.id.clone(),
                    stream_id,
                    state: if active_count < max_active {
                        StreamState::Thumbnail
                    } else {
                        StreamState::Suspended
                    },
                    tier: SUSPENDED_TIER,
                    decode_width: 0,
                    decode_height: 0,
                    fps: 0,
                    priority: asset_priority,
                    predicted_cost_bytes_per_sec: 0,
                    last_changed_at_ms: now,
                    reason: if profile.base_case_validated {
                        "budget exhausted or rendered pixel cap below minimum tier".into()
                    } else {
                        "base case is not validated; scaling remains gated".into()
                    },
                }
            };

            if let Some(previous) = previous_decision {
                decision = apply_hysteresis(
                    previous,
                    decision,
                    overloaded,
                    upgrades_allowed,
                    now,
                    profile,
                );
            }

            if decision.state == StreamState::Active {
                total_cost = total_cost.saturating_add(decision.predicted_cost_bytes_per_sec);
                active_count += 1;
            }

            decisions.push(decision);
        }

        decisions
    }
}

fn choose_candidate(
    asset: &VisibleAsset,
    profile: &PerformanceProfile,
    remaining_budget: u64,
) -> Option<(QualityTier, u32, u32, u64)> {
    for tier in QUALITY_TIERS.iter().rev().copied() {
        let Some((width, height)) = tier_dimensions(asset, tier) else {
            continue;
        };
        let cost = tier_cost_bytes_per_sec(width, height, asset.target_fps.clamp(1, 60), profile);
        if cost <= remaining_budget {
            return Some((tier, width, height, cost));
        }
    }

    None
}

fn apply_hysteresis(
    previous: &QualityDecision,
    mut next: QualityDecision,
    overloaded: bool,
    upgrades_allowed: bool,
    now: u64,
    profile: &PerformanceProfile,
) -> QualityDecision {
    let dwell_ms = now.saturating_sub(previous.last_changed_at_ms);
    let previous_rank = previous.tier.id;
    let next_rank = next.tier.id;

    if next.state == previous.state && next_rank == previous_rank {
        next.last_changed_at_ms = previous.last_changed_at_ms;
        return next;
    }

    let is_upgrade = next_rank > previous_rank;
    let is_downgrade = next_rank < previous_rank || next.state != StreamState::Active;

    if is_upgrade && (!upgrades_allowed || dwell_ms < MIN_UPGRADE_DWELL_MS) {
        let previous_cost = previous.predicted_cost_bytes_per_sec;
        if previous_cost <= profile.safe_budget_bytes_per_sec {
            let mut held = previous.clone();
            held.reason =
                "held by upgrade hysteresis until explicit headroom and dwell time".into();
            return held;
        }
    }

    if is_downgrade && !overloaded && dwell_ms < MIN_DOWNGRADE_DWELL_MS {
        let mut held = previous.clone();
        held.reason = "held by downgrade hysteresis to avoid quality flapping".into();
        return held;
    }

    next.last_changed_at_ms = now;
    if is_downgrade && overloaded {
        next.reason = "downgraded after sustained queue, drop, or budget pressure".into();
    }
    next
}

fn priority(asset: &VisibleAsset, manifest: &CanvasManifest) -> f64 {
    let canvas_area = (manifest.canvas_width as f64 * manifest.canvas_height as f64).max(1.0);
    let area_score = (asset.visible_area_px.max(0.0) / canvas_area)
        .sqrt()
        .min(1.0);
    let focus = asset.focus_weight.clamp(0.0, 4.0);
    let center = asset.center_weight.clamp(0.0, 1.0);
    focus * 4.0 + center * 2.0 + area_score
}

fn tier_dimensions(asset: &VisibleAsset, tier: QualityTier) -> Option<(u32, u32)> {
    let source_width = asset.source_width.max(1) as f64;
    let source_height = asset.source_height.max(1) as f64;
    let rendered_cap_width = (asset.rendered_width_px * MATERIAL_OVERSAMPLE).max(1.0);
    let rendered_cap_height = (asset.rendered_height_px * MATERIAL_OVERSAMPLE).max(1.0);
    let cap_width = asset
        .source_width
        .max(1)
        .min(rendered_cap_width.floor() as u32);
    let cap_height = asset
        .source_height
        .max(1)
        .min(rendered_cap_height.floor() as u32);

    if cap_width < 64 || cap_height < 64 {
        return None;
    }

    let scale = (tier.max_width as f64 / source_width)
        .min(tier.max_height as f64 / source_height)
        .min(1.0);
    let width = even_dimension((source_width * scale).round() as u32).max(2);
    let height = even_dimension((source_height * scale).round() as u32).max(2);

    if width > cap_width || height > cap_height {
        return None;
    }

    Some((width, height))
}

fn even_dimension(value: u32) -> u32 {
    value.saturating_sub(value % 2).max(2)
}

fn tier_cost_bytes_per_sec(width: u32, height: u32, fps: u32, profile: &PerformanceProfile) -> u64 {
    let raw_bytes = width as u64 * height as u64 * BYTES_PER_PIXEL_RGBA8 * fps.max(1) as u64;
    let factor =
        (profile.decode_cost_factor + profile.upload_cost_factor + profile.composite_cost_factor)
            .max(1.0);

    (raw_bytes as f64 * factor) as u64
}

fn controller_snapshot(
    profile: &PerformanceProfile,
    telemetry: &Arc<Mutex<TelemetrySnapshot>>,
    allocations: Vec<QualityDecision>,
) -> ControllerSnapshot {
    let telemetry = telemetry
        .lock()
        .map(|snapshot| snapshot.clone())
        .unwrap_or_default();
    let assumptions = if profile.base_case_validated {
        vec![
            "Budgets are measured on this machine and capped at 80% of the limiting subsystem."
                .into(),
            "Decode/upload factors are calibrated by base-case frontend telemetry.".into(),
        ]
    } else {
        vec![
            "Scaling is gated until base-case calibration validates a 4K presentation path.".into(),
            "CPU and memory samples are process-local rusage values; VRAM must be provided by platform telemetry.".into(),
        ]
    };

    ControllerSnapshot {
        profile: profile.clone(),
        telemetry,
        allocations,
        assumptions,
    }
}
