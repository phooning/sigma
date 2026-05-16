use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use tokio::sync::{mpsc, oneshot, watch};

use super::{
    constants::{
        BASE_CASE_MAX_STREAMS_BEFORE_VALIDATION, DOWNGRADE_DROP_RATE, DOWNGRADE_QUEUE_PRESSURE,
        GPU_FRAME_RESIDENCY_MULTIPLIER, MATERIAL_OVERSAMPLE, MIN_DOWNGRADE_DWELL_MS,
        MIN_UPGRADE_DWELL_MS, UPGRADE_HEADROOM, UPGRADE_QUEUE_PRESSURE,
    },
    frame_packet::yuv420_payload_len,
    profile::PerformanceProfile,
    telemetry::{update_telemetry, TelemetrySnapshot},
    types::{
        CanvasManifest, ControllerSnapshot, QualityDecision, QualityTier, StreamState,
        VisibleAsset, QUALITY_TIERS, SUSPENDED_TIER,
    },
    util::{even_dimension, now_millis, stable_stream_id},
    worker::{reconcile_workers, DecodedFrame, FramePool, WorkerHandle},
};

#[derive(Debug)]
pub(crate) enum ControlMessage {
    UpdateManifest { manifest: CanvasManifest, respond_to: oneshot::Sender<ControllerSnapshot> },
    StopAll { respond_to: oneshot::Sender<ControllerSnapshot> },
}

pub(crate) fn spawn_controller(
    mut control_rx: mpsc::Receiver<ControlMessage>,
    broker_tx: mpsc::Sender<DecodedFrame>,
    frame_pool: Arc<FramePool>,
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
                ControlMessage::UpdateManifest { manifest: next_manifest, respond_to } => {
                    manifest = next_manifest;
                    let profile_snapshot =
                        profile.lock().map(|profile| profile.clone()).unwrap_or_default();
                    let telemetry_snapshot =
                        telemetry.lock().map(|snapshot| snapshot.clone()).unwrap_or_default();
                    let next_allocations = Arbiter::allocate(
                        &manifest,
                        &profile_snapshot,
                        &telemetry_snapshot,
                        &allocations,
                    );

                    reconcile_workers(
                        &mut workers,
                        &next_allocations,
                        broker_tx.clone(),
                        frame_pool.clone(),
                        telemetry.clone(),
                        telemetry_tx.clone(),
                    );
                    allocations = next_allocations
                        .iter()
                        .cloned()
                        .map(|allocation| (allocation.stream_id, allocation))
                        .collect();

                    let predicted_cost = allocations
                        .values()
                        .map(|allocation| allocation.predicted_cost_bytes_per_sec)
                        .sum();
                    let predicted_vram = allocations
                        .values()
                        .filter(|allocation| allocation.state == StreamState::Active)
                        .map(|allocation| {
                            tier_vram_bytes(allocation.decode_width, allocation.decode_height)
                        })
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
                        snapshot.predicted_vram_bytes = predicted_vram;
                        snapshot.safe_budget_bytes_per_sec =
                            profile_snapshot.safe_budget_bytes_per_sec;
                        snapshot.vram_budget_bytes = profile_snapshot.vram_budget_bytes;
                        snapshot.over_budget = predicted_cost
                            > profile_snapshot.safe_budget_bytes_per_sec
                            || predicted_vram > profile_snapshot.vram_budget_bytes;
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
                    let profile_snapshot =
                        profile.lock().map(|profile| profile.clone()).unwrap_or_default();
                    update_telemetry(&telemetry, &telemetry_tx, |snapshot| {
                        snapshot.visible_streams = 0;
                        snapshot.active_streams = 0;
                        snapshot.suspended_streams = 0;
                        snapshot.predicted_cost_bytes_per_sec = 0;
                        snapshot.predicted_vram_bytes = 0;
                        snapshot.vram_budget_bytes = profile_snapshot.vram_budget_bytes;
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
        let max_active = profile.max_active_streams();
        let overloaded = telemetry.broker_queue_pressure_smoothed >= DOWNGRADE_QUEUE_PRESSURE
            || telemetry.frame_drop_rate >= DOWNGRADE_DROP_RATE
            || telemetry.broker_backpressure_active
            || telemetry.predicted_vram_bytes > profile.vram_budget_bytes
            || telemetry.predicted_cost_bytes_per_sec > profile.safe_budget_bytes_per_sec;
        let headroom = if profile.safe_budget_bytes_per_sec == 0 {
            0.0
        } else {
            1.0 - telemetry.predicted_cost_bytes_per_sec as f64
                / profile.safe_budget_bytes_per_sec as f64
        };
        let upgrades_allowed = headroom >= UPGRADE_HEADROOM
            && telemetry.broker_queue_pressure_smoothed <= UPGRADE_QUEUE_PRESSURE;

        let mut total_cost = 0_u64;
        let mut total_vram = 0_u64;
        let mut active_count = 0_usize;
        let mut decisions = Vec::with_capacity(assets.len());

        for asset in assets {
            let stream_id = stable_stream_id(&asset.id);
            let asset_priority = priority(&asset, manifest);
            let previous_decision = previous.get(&stream_id);
            let remaining_budget = profile.safe_budget_bytes_per_sec.saturating_sub(total_cost);
            let remaining_vram_budget = profile.vram_budget_bytes.saturating_sub(total_vram);

            let candidate = if active_count < max_active {
                choose_candidate(&asset, profile, remaining_budget, remaining_vram_budget)
            } else {
                None
            };

            let mut decision = if let Some((tier, width, height, cost)) = candidate {
                QualityDecision {
                    asset_id: asset.id.clone(),
                    source_path: asset.path.clone(),
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
                    source_path: asset.path.clone(),
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
                    } else if max_active > BASE_CASE_MAX_STREAMS_BEFORE_VALIDATION {
                        "soft calibration permits limited scaling while full validation remains pending"
                            .into()
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
                    remaining_budget,
                    remaining_vram_budget,
                    now,
                    profile,
                );
            }

            if decision.state == StreamState::Active {
                total_cost = total_cost.saturating_add(decision.predicted_cost_bytes_per_sec);
                total_vram = total_vram
                    .saturating_add(tier_vram_bytes(decision.decode_width, decision.decode_height));
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
    remaining_vram_budget: u64,
) -> Option<(QualityTier, u32, u32, u64)> {
    for tier in QUALITY_TIERS.iter().rev().copied() {
        let Some((width, height)) = tier_dimensions(asset, tier) else {
            continue;
        };
        let cost = tier_cost_bytes_per_sec(width, height, asset.target_fps.clamp(1, 60), profile);
        let vram = tier_vram_bytes(width, height);
        if cost <= remaining_budget && vram <= remaining_vram_budget {
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
    remaining_budget: u64,
    remaining_vram_budget: u64,
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
        let previous_cost = tier_cost_bytes_per_sec(
            previous.decode_width,
            previous.decode_height,
            previous.fps,
            profile,
        );
        let previous_vram = tier_vram_bytes(previous.decode_width, previous.decode_height);
        if previous_cost <= remaining_budget && previous_vram <= remaining_vram_budget {
            let mut held = previous.clone();
            held.predicted_cost_bytes_per_sec = previous_cost;
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

#[cfg(test)]
mod tests {
    use super::{
        apply_hysteresis, choose_candidate, tier_cost_bytes_per_sec, tier_vram_bytes, Arbiter,
        MIN_UPGRADE_DWELL_MS, QUALITY_TIERS,
    };
    use crate::native_video::{
        profile::PerformanceProfile,
        telemetry::TelemetrySnapshot,
        types::{CanvasManifest, QualityDecision, StreamState, VisibleAsset},
    };

    fn profile_with_budget_and_factor(budget: u64, factor: f64) -> PerformanceProfile {
        PerformanceProfile {
            base_case_validated: true,
            safe_budget_bytes_per_sec: budget,
            cpu_decode_budget_bytes_per_sec: budget,
            ipc_budget_bytes_per_sec: budget,
            ram_bandwidth_bytes_per_sec: budget as f64,
            ram_bandwidth_budget_bytes_per_sec: budget,
            vram_budget_bytes: u64::MAX,
            decode_cost_factor: factor,
            upload_cost_factor: 0.0,
            composite_cost_factor: 0.0,
            ..PerformanceProfile::uncalibrated()
        }
    }

    fn profile_with_cost_factors(decode: f64, upload: f64, composite: f64) -> PerformanceProfile {
        PerformanceProfile {
            decode_cost_factor: decode,
            upload_cost_factor: upload,
            composite_cost_factor: composite,
            ..PerformanceProfile::uncalibrated()
        }
    }

    fn decision(
        tier_index: usize,
        width: u32,
        height: u32,
        fps: u32,
        predicted_cost_bytes_per_sec: u64,
    ) -> QualityDecision {
        QualityDecision {
            asset_id: format!("asset-{tier_index}"),
            source_path: format!("asset-{tier_index}.mp4"),
            stream_id: tier_index as u64,
            state: StreamState::Active,
            tier: QUALITY_TIERS[tier_index],
            decode_width: width,
            decode_height: height,
            fps,
            priority: 1.0,
            predicted_cost_bytes_per_sec,
            last_changed_at_ms: 1_000,
            reason: String::new(),
        }
    }

    #[test]
    fn upgrade_hysteresis_recomputes_previous_cost_with_current_profile() {
        let previous = decision(1, 256, 144, 60, 1);
        let next = decision(2, 426, 240, 60, 10_000_000);
        let profile = profile_with_budget_and_factor(4_000_000, 4.0);
        let remaining_budget = profile.safe_budget_bytes_per_sec;
        let now = previous.last_changed_at_ms + MIN_UPGRADE_DWELL_MS - 1;

        let result = apply_hysteresis(
            &previous,
            next.clone(),
            false,
            false,
            remaining_budget,
            u64::MAX,
            now,
            &profile,
        );
        let current_previous_cost = tier_cost_bytes_per_sec(
            previous.decode_width,
            previous.decode_height,
            previous.fps,
            &profile,
        );

        assert!(current_previous_cost > remaining_budget);
        assert_eq!(result.tier.id, next.tier.id);
    }

    #[test]
    fn upgrade_hysteresis_requires_previous_tier_to_fit_remaining_budget() {
        let previous = decision(1, 256, 144, 60, 1);
        let next = decision(2, 426, 240, 60, 10_000_000);
        let profile = profile_with_budget_and_factor(10_000_000, 1.0);
        let current_previous_cost = tier_cost_bytes_per_sec(
            previous.decode_width,
            previous.decode_height,
            previous.fps,
            &profile,
        );
        let now = previous.last_changed_at_ms + MIN_UPGRADE_DWELL_MS - 1;

        let result = apply_hysteresis(
            &previous,
            next,
            false,
            false,
            current_previous_cost.saturating_sub(1),
            u64::MAX,
            now,
            &profile,
        );

        assert_eq!(result.tier.id, QUALITY_TIERS[2].id);
    }

    #[test]
    fn tier_cost_includes_composite_factor_in_spending_model() {
        let without_composite = profile_with_cost_factors(1.5, 0.5, 0.0);
        let with_composite = profile_with_cost_factors(1.5, 0.5, 4.0);

        let base_cost = tier_cost_bytes_per_sec(426, 240, 60, &without_composite);
        let composite_cost = tier_cost_bytes_per_sec(426, 240, 60, &with_composite);

        assert!(composite_cost > base_cost);
    }

    #[test]
    fn allocation_carries_asset_path_for_decode_worker() {
        let manifest = CanvasManifest {
            canvas_width: 1920,
            canvas_height: 1080,
            viewport_zoom: 1.0,
            assets: vec![VisibleAsset {
                id: "asset-1".into(),
                path: "C:/media/clip.mp4".into(),
                source_width: 1920,
                source_height: 1080,
                screen_x: 0.0,
                screen_y: 0.0,
                rendered_width_px: 1280.0,
                rendered_height_px: 720.0,
                visible_area_px: 1280.0 * 720.0,
                focus_weight: 1.0,
                center_weight: 0.5,
                target_fps: 30,
            }],
        };
        let profile = profile_with_budget_and_factor(u64::MAX / 4, 1.0);

        let allocations = Arbiter::allocate(
            &manifest,
            &profile,
            &TelemetrySnapshot::default(),
            &Default::default(),
        );

        assert_eq!(allocations[0].asset_id, "asset-1");
        assert_eq!(allocations[0].source_path, "C:/media/clip.mp4");
        assert_eq!(allocations[0].state, StreamState::Active);
    }

    #[test]
    fn allocation_spends_budget_on_composite_pressure() {
        let manifest = CanvasManifest {
            canvas_width: 1920,
            canvas_height: 1080,
            viewport_zoom: 1.0,
            assets: vec![VisibleAsset {
                id: "asset-1".into(),
                path: "C:/media/clip.mp4".into(),
                source_width: 1920,
                source_height: 1080,
                screen_x: 0.0,
                screen_y: 0.0,
                rendered_width_px: 1280.0,
                rendered_height_px: 720.0,
                visible_area_px: 1280.0 * 720.0,
                focus_weight: 1.0,
                center_weight: 0.5,
                target_fps: 30,
            }],
        };
        let budget =
            tier_cost_bytes_per_sec(1280, 720, 30, &profile_with_cost_factors(1.0, 0.0, 0.0));
        let without_composite = PerformanceProfile {
            base_case_validated: true,
            safe_budget_bytes_per_sec: budget,
            cpu_decode_budget_bytes_per_sec: budget,
            ipc_budget_bytes_per_sec: budget,
            ram_bandwidth_bytes_per_sec: budget as f64,
            ram_bandwidth_budget_bytes_per_sec: budget,
            vram_budget_bytes: u64::MAX,
            decode_cost_factor: 1.0,
            upload_cost_factor: 0.0,
            composite_cost_factor: 0.0,
            ..PerformanceProfile::uncalibrated()
        };
        let with_composite =
            PerformanceProfile { composite_cost_factor: 1.0, ..without_composite.clone() };

        let baseline = Arbiter::allocate(
            &manifest,
            &without_composite,
            &TelemetrySnapshot::default(),
            &Default::default(),
        );
        let constrained = Arbiter::allocate(
            &manifest,
            &with_composite,
            &TelemetrySnapshot::default(),
            &Default::default(),
        );

        assert_eq!(baseline[0].state, StreamState::Active);
        assert_eq!(baseline[0].tier.id, 4);
        assert_eq!(constrained[0].state, StreamState::Active);
        assert!(constrained[0].tier.id < baseline[0].tier.id);
        assert!(
            constrained[0].predicted_cost_bytes_per_sec <= with_composite.safe_budget_bytes_per_sec
        );
    }

    #[test]
    fn choose_candidate_respects_remaining_vram_budget() {
        let asset = VisibleAsset {
            id: "asset-1".into(),
            path: "/tmp/video.mp4".into(),
            source_width: 3840,
            source_height: 2160,
            screen_x: 0.0,
            screen_y: 0.0,
            rendered_width_px: 3840.0,
            rendered_height_px: 2160.0,
            visible_area_px: 3840.0 * 2160.0,
            focus_weight: 1.0,
            center_weight: 0.5,
            target_fps: 60,
        };
        let profile = PerformanceProfile::uncalibrated();
        let vram_for_240p = tier_vram_bytes(426, 240);

        let candidate =
            choose_candidate(&asset, &profile, u64::MAX, vram_for_240p.saturating_sub(1))
                .expect("candidate under tight vram budget");

        assert_eq!(candidate.0.id, 1);
    }
}

fn priority(asset: &VisibleAsset, manifest: &CanvasManifest) -> f64 {
    let canvas_area = (manifest.canvas_width as f64 * manifest.canvas_height as f64).max(1.0);
    let area_score = (asset.visible_area_px.max(0.0) / canvas_area).sqrt().min(1.0);
    let focus = asset.focus_weight.clamp(0.0, 4.0);
    let center = asset.center_weight.clamp(0.0, 1.0);
    focus * 4.0 + center * 2.0 + area_score
}

fn tier_dimensions(asset: &VisibleAsset, tier: QualityTier) -> Option<(u32, u32)> {
    let source_width = asset.source_width.max(1) as f64;
    let source_height = asset.source_height.max(1) as f64;
    let rendered_cap_width = (asset.rendered_width_px * MATERIAL_OVERSAMPLE).max(1.0);
    let rendered_cap_height = (asset.rendered_height_px * MATERIAL_OVERSAMPLE).max(1.0);
    let cap_width = asset.source_width.max(1).min(rendered_cap_width.floor() as u32);
    let cap_height = asset.source_height.max(1).min(rendered_cap_height.floor() as u32);

    if cap_width < 64 || cap_height < 64 {
        return None;
    }

    let scale =
        (tier.max_width as f64 / source_width).min(tier.max_height as f64 / source_height).min(1.0);
    let width = even_dimension((source_width * scale).round() as u32).max(2);
    let height = even_dimension((source_height * scale).round() as u32).max(2);

    if width > cap_width || height > cap_height {
        return None;
    }

    Some((width, height))
}

fn tier_cost_bytes_per_sec(width: u32, height: u32, fps: u32, profile: &PerformanceProfile) -> u64 {
    // Cost modeling uses normalized frontend factors so allocation can react to decode, upload,
    // and composite pressure with the same byte/sec budgeting path.
    let raw_bytes = yuv420_payload_len(width, height) as u64 * fps.max(1) as u64;
    let factor =
        (profile.decode_cost_factor + profile.upload_cost_factor + profile.composite_cost_factor)
            .max(1.0);

    (raw_bytes as f64 * factor) as u64
}

fn tier_vram_bytes(width: u32, height: u32) -> u64 {
    yuv420_payload_len(width, height) as u64 * GPU_FRAME_RESIDENCY_MULTIPLIER
}

fn controller_snapshot(
    profile: &PerformanceProfile,
    telemetry: &Arc<Mutex<TelemetrySnapshot>>,
    allocations: Vec<QualityDecision>,
) -> ControllerSnapshot {
    let telemetry = telemetry.lock().map(|snapshot| snapshot.clone()).unwrap_or_default();
    let assumptions = if profile.base_case_validated {
        vec![
            "Budgets are measured on this machine and capped at 80% of the limiting subsystem."
                .into(),
            "Decode/upload/composite factors are calibrated by base-case frontend telemetry."
                .into(),
        ]
    } else if profile.max_active_streams() > BASE_CASE_MAX_STREAMS_BEFORE_VALIDATION {
        vec![
            "Soft calibration allows a small number of active streams before 4K validation succeeds."
                .into(),
            "Additional backend probe and frontend telemetry unlock more low-risk concurrency before full validation.".into(),
        ]
    } else {
        vec![
            "Scaling is gated until base-case calibration validates a 4K presentation path.".into(),
            "VRAM capacity is read from platform telemetry when available and otherwise falls back to the persisted profile default.".into(),
        ]
    };

    ControllerSnapshot { profile: profile.clone(), telemetry, allocations, assumptions }
}
