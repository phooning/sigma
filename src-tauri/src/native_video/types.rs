use serde::{Deserialize, Serialize};

use super::{profile::PerformanceProfile, telemetry::TelemetrySnapshot};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasManifest {
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub viewport_zoom: f64,
    pub assets: Vec<VisibleAsset>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibleAsset {
    pub id: String,
    pub path: String,
    pub source_width: u32,
    pub source_height: u32,
    pub screen_x: f64,
    pub screen_y: f64,
    pub rendered_width_px: f64,
    pub rendered_height_px: f64,
    pub visible_area_px: f64,
    pub focus_weight: f64,
    pub center_weight: f64,
    pub target_fps: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendMetrics {
    pub renderer: String,
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub upload_latency_p95_ms: f64,
    pub composite_latency_p95_ms: f64,
    pub frame_drop_rate: f64,
    pub measured_ipc_bytes_per_sec: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseCaseProbeConfig {
    pub source_path: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<u32>,
    pub frames: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseCaseProbeReport {
    pub decode_backend: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub frames_sent: u32,
    pub bytes_sent: u64,
    pub elapsed_ms: f64,
    pub measured_ipc_bytes_per_sec: u64,
    pub decode_latency_p95_ms: f64,
    pub send_latency_p95_ms: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerSnapshot {
    pub profile: PerformanceProfile,
    pub telemetry: TelemetrySnapshot,
    pub allocations: Vec<QualityDecision>,
    pub assumptions: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityDecision {
    pub asset_id: String,
    pub stream_id: u64,
    pub state: StreamState,
    pub tier: QualityTier,
    pub decode_width: u32,
    pub decode_height: u32,
    pub fps: u32,
    pub priority: f64,
    pub predicted_cost_bytes_per_sec: u64,
    pub last_changed_at_ms: u64,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamState {
    Active,
    Suspended,
    Thumbnail,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityTier {
    pub id: u8,
    pub name: &'static str,
    pub max_width: u32,
    pub max_height: u32,
}

pub(crate) const SUSPENDED_TIER: QualityTier = QualityTier {
    id: 0,
    name: "suspended",
    max_width: 0,
    max_height: 0,
};

pub(crate) const QUALITY_TIERS: [QualityTier; 6] = [
    QualityTier {
        id: 1,
        name: "thumb-144p",
        max_width: 256,
        max_height: 144,
    },
    QualityTier {
        id: 2,
        name: "low-240p",
        max_width: 426,
        max_height: 240,
    },
    QualityTier {
        id: 3,
        name: "canvas-480p",
        max_width: 854,
        max_height: 480,
    },
    QualityTier {
        id: 4,
        name: "detail-720p",
        max_width: 1280,
        max_height: 720,
    },
    QualityTier {
        id: 5,
        name: "focus-1080p",
        max_width: 1920,
        max_height: 1080,
    },
    QualityTier {
        id: 6,
        name: "native-2160p",
        max_width: 3840,
        max_height: 2160,
    },
];
