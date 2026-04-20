use std::collections::HashMap;

use super::{
    constants::{BYTES_PER_PIXEL_RGBA8, FRAME_PACKET_HEADER_LEN, FRAME_PACKET_MAGIC},
    controller::Arbiter,
    frame_packet::make_frame_packet,
    profile::PerformanceProfile,
    telemetry::TelemetrySnapshot,
    types::{CanvasManifest, StreamState, VisibleAsset},
};

fn profile_with_budget(budget: u64, validated: bool) -> PerformanceProfile {
    PerformanceProfile {
        base_case_validated: validated,
        safe_budget_bytes_per_sec: budget,
        cpu_decode_budget_bytes_per_sec: budget,
        ipc_budget_bytes_per_sec: budget,
        ram_bandwidth_budget_bytes_per_sec: budget,
        ..PerformanceProfile::uncalibrated()
    }
}

fn asset(id: usize, width: f64, height: f64, focus_weight: f64) -> VisibleAsset {
    VisibleAsset {
        id: format!("asset-{id}"),
        path: format!("/tmp/asset-{id}.mp4"),
        source_width: 3840,
        source_height: 2160,
        screen_x: 0.0,
        screen_y: 0.0,
        rendered_width_px: width,
        rendered_height_px: height,
        visible_area_px: width * height,
        focus_weight,
        center_weight: 0.5,
        target_fps: 60,
    }
}

#[test]
fn rendered_pixel_cap_keeps_equal_32_way_tiles_below_4k() {
    let manifest = CanvasManifest {
        canvas_width: 3840,
        canvas_height: 2160,
        viewport_zoom: 1.0,
        assets: (0..32)
            .map(|index| asset(index, 480.0, 270.0, 1.0))
            .collect(),
    };
    let profile = profile_with_budget(20 * 1024 * 1024 * 1024, true);
    let decisions = Arbiter::allocate(
        &manifest,
        &profile,
        &TelemetrySnapshot::default(),
        &HashMap::new(),
    );

    assert_eq!(decisions.len(), 32);
    assert!(decisions
        .iter()
        .all(|decision| decision.decode_width <= 426 && decision.decode_height <= 240));
}

#[test]
fn scaling_is_gated_until_base_case_is_validated() {
    let manifest = CanvasManifest {
        canvas_width: 3840,
        canvas_height: 2160,
        viewport_zoom: 1.0,
        assets: (0..4)
            .map(|index| asset(index, 1920.0, 1080.0, 1.0))
            .collect(),
    };
    let profile = profile_with_budget(20 * 1024 * 1024 * 1024, false);
    let decisions = Arbiter::allocate(
        &manifest,
        &profile,
        &TelemetrySnapshot::default(),
        &HashMap::new(),
    );

    assert_eq!(
        decisions
            .iter()
            .filter(|decision| decision.state == StreamState::Active)
            .count(),
        1
    );
}

#[test]
fn packet_header_is_little_endian_and_binary() {
    let packet = make_frame_packet(42, 7, 12_345, 128, 72, 3);

    assert_eq!(&packet[0..4], FRAME_PACKET_MAGIC);
    assert_eq!(packet[5], FRAME_PACKET_HEADER_LEN as u8);
    assert_eq!(u64::from_le_bytes(packet[8..16].try_into().unwrap()), 7);
    assert_eq!(
        u64::from_le_bytes(packet[16..24].try_into().unwrap()),
        12_345
    );
    assert_eq!(u64::from_le_bytes(packet[24..32].try_into().unwrap()), 42);
    assert_eq!(u32::from_le_bytes(packet[32..36].try_into().unwrap()), 128);
    assert_eq!(u32::from_le_bytes(packet[36..40].try_into().unwrap()), 72);
    assert_eq!(
        packet.len(),
        FRAME_PACKET_HEADER_LEN + 128 * 72 * BYTES_PER_PIXEL_RGBA8 as usize
    );
}
