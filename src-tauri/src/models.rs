use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Activity {
    pub id: i64,
    pub file_name: String,
    pub activity_name: String,
    pub source_title: Option<String>,
    pub generated_title: Option<String>,
    pub sport: String,
    pub sub_sport: String,
    pub device: String,
    pub location_city: Option<String>,
    pub location_region: Option<String>,
    pub location_country: Option<String>,
    pub location_label: Option<String>,
    pub start_ts_utc: String,
    pub end_ts_utc: String,
    pub duration_s: f64,
    pub distance_m: f64,
    pub start_latitude: Option<f64>,
    pub start_longitude: Option<f64>,
    pub metadata_json: String,
    pub activity_kind: String,
    pub segments: Vec<ActivitySegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivitySegment {
    pub activity_id: i64,
    pub segment_index: i64,
    pub segment_type: String,
    pub name: String,
    pub sport: String,
    pub sub_sport: String,
    pub start_ts_utc: String,
    pub end_ts_utc: String,
    pub timer_duration_s: f64,
    pub elapsed_duration_s: f64,
    pub distance_m: f64,
    pub record_distance_offset_m: f64,
    pub start_latitude: Option<f64>,
    pub start_longitude: Option<f64>,
    pub metadata_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordPoint {
    pub timestamp_ms: i64,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub altitude_m: Option<f64>,
    pub distance_m: Option<f64>,
    pub speed_m_s: Option<f64>,
    pub cadence: Option<i64>,
    pub heart_rate: Option<i64>,
    pub power: Option<i64>,
    pub temperature_c: Option<f64>,
    pub respiration_rate_brpm: Option<f64>,
    pub current_stamina_pct: Option<f64>,
    pub potential_stamina_pct: Option<f64>,
    pub performance_condition: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub segment_index: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct ParsedActivitySegment {
    pub segment_index: i64,
    pub segment_type: String,
    pub name: String,
    pub sport: String,
    pub sub_sport: String,
    pub start_ts_utc: String,
    pub end_ts_utc: String,
    pub timer_duration_s: f64,
    pub elapsed_duration_s: f64,
    pub distance_m: f64,
    pub record_distance_offset_m: f64,
    pub start_latitude: Option<f64>,
    pub start_longitude: Option<f64>,
    pub metadata_json: String,
}

#[derive(Debug, Clone)]
pub struct ParsedActivity {
    pub file_name: String,
    pub source_format: String,
    pub activity_name: String,
    pub source_title: Option<String>,
    pub generated_title: Option<String>,
    pub sport: String,
    pub sub_sport: String,
    pub device: String,
    pub location_city: Option<String>,
    pub location_region: Option<String>,
    pub location_country: Option<String>,
    pub location_label: Option<String>,
    pub start_ts_utc: String,
    pub end_ts_utc: String,
    pub duration_s: f64,
    pub distance_m: f64,
    pub start_latitude: Option<f64>,
    pub start_longitude: Option<f64>,
    pub file_hash: String,
    pub records: Vec<RecordPoint>,
    pub metadata_json: String,
    pub activity_kind: String,
    pub segments: Vec<ParsedActivitySegment>,
}

#[derive(Debug, Serialize)]
pub struct OverviewStats {
    pub activity_count: i64,
    pub total_distance_m: f64,
    pub total_duration_s: f64,
}

#[cfg(all(feature = "web", not(feature = "tauri-app")))]
#[derive(Debug, Deserialize)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

#[cfg(all(feature = "web", not(feature = "tauri-app")))]
#[derive(Debug, Deserialize)]
pub struct UnlockPayload {
    pub password: String,
}

#[cfg(all(feature = "web", not(feature = "tauri-app")))]
#[derive(Debug, Deserialize)]
pub struct RenameActivityPayload {
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct TokenResponse {
    pub token: String,
}
