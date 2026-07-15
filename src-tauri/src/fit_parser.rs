use std::path::Path;

use anyhow::{anyhow, Context, Result};
use fitparser::{profile::MesgNum, Value};
use sha2::{Digest, Sha256};

use crate::device_metadata::{
    build_devices, decoded_file_id, decoded_file_id_display_name, RawDeviceInfo, RawDeviceType,
    RawFileId,
};
use crate::models::{ParsedActivity, RecordPoint};

const NON_ACTIVITY_FIT_MARKER: &str = "non-activity-fit:";
const TIMER_INTERVAL_TOLERANCE_S: f64 = 5.0;

#[derive(Clone, Debug, PartialEq)]
struct TimerEvent {
    timestamp_ms: i64,
    event: String,
    event_type: String,
    timer_trigger: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
struct StoppedInterval {
    start_ms: i64,
    end_ms: i64,
    trigger: Option<String>,
    resume_trigger: Option<String>,
    source: &'static str,
}

#[derive(Clone, Debug, serde::Serialize)]
struct Vo2MaxEstimateMetadata {
    value_ml_kg_min: f64,
    phase: String,
    category: String,
    activity_sport_code: Option<i64>,
    activity_sport: Option<String>,
    sub_sport: Option<String>,
    session_index: Option<usize>,
    source: String,
    raw_value: Option<f64>,
    message_index: usize,
}

#[derive(Clone, Debug)]
struct StartingVo2Value {
    value_ml_kg_min: f64,
    raw_value: f64,
    source: String,
    message_index: usize,
}

#[derive(Clone, Debug)]
struct Vo2SessionContext {
    session_index: usize,
    sport: String,
}

fn valid_vo2_max(value: f64) -> bool {
    value.is_finite() && value > 0.0 && value < 200.0
}

fn vo2_category_from_sport_code(sport_code: Option<i64>) -> String {
    match sport_code {
        Some(1) => "running",
        Some(2) => "cycling",
        Some(_) => "generic",
        None => "unknown",
    }
    .to_string()
}

fn vo2_category_from_sport_name(sport: &str) -> Option<String> {
    let normalized: String = sport
        .trim()
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect();
    match normalized.as_str() {
        "running" => Some("running".to_string()),
        "cycling" => Some("cycling".to_string()),
        _ => None,
    }
}

fn sport_code_for_vo2_category(category: &str) -> Option<i64> {
    match category {
        "running" => Some(1),
        "cycling" => Some(2),
        _ => None,
    }
}

fn push_starting_vo2_estimate(
    starting: &StartingVo2Value,
    category: Option<&str>,
    session: Option<&Vo2SessionContext>,
    estimates: &mut Vec<Vo2MaxEstimateMetadata>,
) {
    let category = category.unwrap_or("unknown");
    estimates.push(Vo2MaxEstimateMetadata {
        value_ml_kg_min: starting.value_ml_kg_min,
        phase: "before_activity".to_string(),
        category: category.to_string(),
        activity_sport_code: sport_code_for_vo2_category(category),
        activity_sport: session
            .map(|value| value.sport.clone())
            .or_else(|| (category != "unknown").then(|| category.to_string())),
        sub_sport: None,
        session_index: session.map(|value| value.session_index),
        source: starting.source.clone(),
        raw_value: Some(starting.raw_value),
        message_index: starting.message_index,
    });
}

fn append_starting_vo2_estimates(
    starting_values: &[StartingVo2Value],
    sessions: &[Vo2SessionContext],
    estimates: &mut Vec<Vo2MaxEstimateMetadata>,
) {
    if starting_values.is_empty() {
        return;
    }

    let qualifying_sessions: Vec<&Vo2SessionContext> = sessions
        .iter()
        .filter(|session| vo2_category_from_sport_name(&session.sport).is_some())
        .collect();

    if starting_values.len() == qualifying_sessions.len() && !qualifying_sessions.is_empty() {
        for (starting, session) in starting_values.iter().zip(qualifying_sessions) {
            let category = vo2_category_from_sport_name(&session.sport);
            push_starting_vo2_estimate(
                starting,
                category.as_deref(),
                Some(session),
                estimates,
            );
        }
        return;
    }

    let first_category = qualifying_sessions
        .first()
        .and_then(|session| vo2_category_from_sport_name(&session.sport));
    let one_category = first_category.as_ref().is_some_and(|category| {
        qualifying_sessions.iter().all(|session| {
            vo2_category_from_sport_name(&session.sport).as_ref() == Some(category)
        })
    });
    if one_category {
        let session = (qualifying_sessions.len() == 1).then_some(qualifying_sessions[0]);
        for starting in starting_values {
            push_starting_vo2_estimate(
                starting,
                first_category.as_deref(),
                session,
                estimates,
            );
        }
        return;
    }

    for starting in starting_values {
        push_starting_vo2_estimate(starting, None, None, estimates);
    }
}

pub fn is_non_activity_fit_error(err: &anyhow::Error) -> bool {
    err.chain()
        .any(|cause| cause.to_string().starts_with(NON_ACTIVITY_FIT_MARKER))
}

fn value_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Byte(x) => Some(*x as f64),
        Value::Enum(x) => Some(*x as f64),
        Value::SInt8(x) => Some(*x as f64),
        Value::UInt8(x) => Some(*x as f64),
        Value::UInt8z(x) => Some(*x as f64),
        Value::SInt16(x) => Some(*x as f64),
        Value::UInt16(x) => Some(*x as f64),
        Value::UInt16z(x) => Some(*x as f64),
        Value::SInt32(x) => Some(*x as f64),
        Value::UInt32(x) => Some(*x as f64),
        Value::UInt32z(x) => Some(*x as f64),
        Value::SInt64(x) => Some(*x as f64),
        Value::UInt64(x) => Some(*x as f64),
        Value::UInt64z(x) => Some(*x as f64),
        Value::Float32(x) => Some(*x as f64),
        Value::Float64(x) => Some(*x),
        _ => None,
    }
}

fn value_i64(v: &Value) -> Option<i64> {
    value_f64(v).map(|n| n as i64)
}

fn value_i64_in_range(v: &Value, min: i64, max: i64) -> Option<i64> {
    value_i64(v).filter(|value| *value >= min && *value <= max)
}

fn value_f64_vec(v: &Value) -> Vec<f64> {
    match v {
        Value::Array(values) => values.iter().filter_map(value_f64).collect(),
        _ => value_f64(v).into_iter().collect(),
    }
}

fn value_i64_vec(v: &Value) -> Vec<i64> {
    value_f64_vec(v).into_iter().map(|n| n as i64).collect()
}

fn clean_i64_bounds(values: Vec<i64>, min: i64, max: i64) -> Vec<i64> {
    let mut cleaned: Vec<i64> = values
        .into_iter()
        .filter(|value| *value >= min && *value <= max)
        .collect();
    cleaned.sort_unstable();
    cleaned.dedup();
    cleaned
}

fn clean_duration_values(values: Vec<f64>) -> Vec<f64> {
    values
        .into_iter()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .collect()
}

fn normalized_fit_label(value: &Value) -> Option<String> {
    let value = value_string(value).trim().to_lowercase();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn set_string_if_present(target: &mut Option<String>, value: &Value) {
    if let Some(label) = normalized_fit_label(value) {
        *target = Some(label);
    }
}

fn replace_vec_if_useful<T>(target: &mut Vec<T>, values: Vec<T>) {
    if !values.is_empty() && values.len() >= target.len() {
        *target = values;
    }
}

fn has_positive_duration(values: &[f64]) -> bool {
    values.iter().any(|value| *value > 0.0)
}

fn time_in_zone_reference_priority(reference: Option<&str>) -> u8 {
    match reference.unwrap_or("") {
        "session" => 3,
        "lap" => 2,
        "split" => 0,
        _ => 1,
    }
}

#[derive(Default)]
struct ZoneAccumulator {
    time_in_hr_zone_s: Vec<f64>,
    time_in_power_zone_s: Vec<f64>,
    hr_time_in_zone_priority: u8,
    power_time_in_zone_priority: u8,
    time_in_zone_metadata_priority: u8,
    hr_zone_high_boundary: Vec<i64>,
    power_zone_high_boundary: Vec<i64>,
    hr_calc_type: Option<String>,
    pwr_calc_type: Option<String>,
    max_heart_rate: Option<i64>,
    resting_heart_rate: Option<i64>,
    threshold_heart_rate: Option<i64>,
    functional_threshold_power: Option<i64>,
}

fn inferred_percent_ftp_power_bounds(ftp: i64) -> Vec<i64> {
    [0.55, 0.75, 0.90, 1.05, 1.20, 1.50, 2.00]
        .into_iter()
        .map(|pct| (ftp as f64 * pct).round() as i64)
        .chain(std::iter::once(4000))
        .collect()
}

fn is_percent_ftp(calc_type: Option<&String>) -> bool {
    calc_type
        .map(|value| value.eq_ignore_ascii_case("percent_ftp") || value.eq_ignore_ascii_case("percent ftp"))
        .unwrap_or(false)
}

fn build_zones_json(zones: &ZoneAccumulator) -> serde_json::Value {
    let mut root = serde_json::Map::new();

    let has_heart_rate_zone = !zones.hr_zone_high_boundary.is_empty()
        || !zones.time_in_hr_zone_s.is_empty()
        || zones.hr_calc_type.is_some()
        || zones.max_heart_rate.is_some()
        || zones.resting_heart_rate.is_some()
        || zones.threshold_heart_rate.is_some();

    if has_heart_rate_zone {
        root.insert(
            "heart_rate".to_string(),
            serde_json::json!({
                "source": "fit",
                "calc_type": zones.hr_calc_type.clone(),
                "upper_bounds_bpm": zones.hr_zone_high_boundary.clone(),
                "time_in_zone_s": zones.time_in_hr_zone_s.clone(),
                "configured_max_heart_rate": zones.max_heart_rate,
                "resting_heart_rate": zones.resting_heart_rate,
                "threshold_heart_rate": zones.threshold_heart_rate
            }),
        );
    }

    let explicit_power_bounds = !zones.power_zone_high_boundary.is_empty();
    let inferred_power_bounds = if !explicit_power_bounds
        && is_percent_ftp(zones.pwr_calc_type.as_ref())
        && zones.functional_threshold_power.is_some()
    {
        zones.functional_threshold_power.map(inferred_percent_ftp_power_bounds)
    } else {
        None
    };
    let power_upper_bounds = if explicit_power_bounds {
        zones.power_zone_high_boundary.clone()
    } else {
        inferred_power_bounds.clone().unwrap_or_default()
    };

    let has_power_zone = !zones.time_in_power_zone_s.is_empty()
        || !power_upper_bounds.is_empty()
        || zones.pwr_calc_type.is_some()
        || zones.functional_threshold_power.is_some();

    if has_power_zone {
        root.insert(
            "power".to_string(),
            serde_json::json!({
                "source": if inferred_power_bounds.is_some() { "inferred_default_percent_ftp" } else { "fit" },
                "calc_type": zones.pwr_calc_type.clone(),
                "functional_threshold_power": zones.functional_threshold_power,
                "upper_bounds_watts": power_upper_bounds,
                "time_in_zone_s": zones.time_in_power_zone_s.clone()
            }),
        );
    }

    serde_json::Value::Object(root)
}

fn value_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn fit_value_to_json(v: &Value) -> serde_json::Value {
    match v {
        Value::Timestamp(dt) => serde_json::Value::String(dt.to_rfc3339()),
        Value::Byte(x) => serde_json::Value::Number(serde_json::Number::from(*x)),
        Value::Enum(x) => serde_json::Value::Number(serde_json::Number::from(*x)),
        Value::SInt8(x) => serde_json::Value::Number(serde_json::Number::from(*x)),
        Value::UInt8(x) => serde_json::Value::Number(serde_json::Number::from(*x)),
        Value::UInt8z(x) => serde_json::Value::Number(serde_json::Number::from(*x)),
        Value::SInt16(x) => serde_json::Value::Number(serde_json::Number::from(*x)),
        Value::UInt16(x) => serde_json::Value::Number(serde_json::Number::from(*x)),
        Value::UInt16z(x) => serde_json::Value::Number(serde_json::Number::from(*x)),
        Value::SInt32(x) => serde_json::Value::Number(serde_json::Number::from(*x)),
        Value::UInt32(x) => serde_json::Value::Number(serde_json::Number::from(*x)),
        Value::UInt32z(x) => serde_json::Value::Number(serde_json::Number::from(*x)),
        Value::SInt64(x) => serde_json::Value::Number(serde_json::Number::from(*x)),
        Value::UInt64(x) => serde_json::Value::Number(serde_json::Number::from(*x)),
        Value::UInt64z(x) => serde_json::Value::Number(serde_json::Number::from(*x)),
        Value::Float32(x) => serde_json::Number::from_f64(*x as f64)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        Value::Float64(x) => serde_json::Number::from_f64(*x)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                serde_json::Value::Null
            } else {
                serde_json::Value::String(trimmed.to_string())
            }
        }
        Value::Array(values) => {
            serde_json::Value::Array(values.iter().map(fit_value_to_json).collect())
        }
    }
}

fn insert_fit_json_field(
    map: &mut serde_json::Map<String, serde_json::Value>,
    name: &str,
    value: &Value,
) {
    let json_value = fit_value_to_json(value);
    match &json_value {
        serde_json::Value::Null => {}
        serde_json::Value::Array(values) if values.is_empty() => {}
        _ => {
            map.insert(name.to_string(), json_value);
        }
    }
}

fn decoded_left_right_balance(value: &Value) -> Option<serde_json::Value> {
    let raw = value_i64(value)?;
    if raw < 0 {
        return None;
    }

    let raw_u = raw as u64;
    let right_known = (raw_u & 0x8000) != 0;
    let percent = ((raw_u & 0x7fff) as f64) / 100.0;
    if !percent.is_finite() || !(0.0..=100.0).contains(&percent) {
        return None;
    }

    let (left_percent, right_percent, known_side) = if right_known {
        (100.0 - percent, percent, "right")
    } else {
        (percent, 100.0 - percent, "left")
    };

    Some(serde_json::json!({
        "raw": raw,
        "known_side": known_side,
        "left_percent": left_percent,
        "right_percent": right_percent
    }))
}

fn decoded_fit_message(rec: &fitparser::FitDataRecord) -> serde_json::Value {
    let mut message = serde_json::Map::new();
    for field in rec.fields() {
        insert_fit_json_field(&mut message, field.name(), field.value());
        if field.name() == "left_right_balance" {
            if let Some(decoded) = decoded_left_right_balance(field.value()) {
                message.insert("left_right_balance_decoded".to_string(), decoded);
            }
        }
    }
    serde_json::Value::Object(message)
}

fn push_decoded_fit_message(target: &mut Vec<serde_json::Value>, rec: &fitparser::FitDataRecord) {
    let decoded = decoded_fit_message(rec);
    if decoded.as_object().map(|map| !map.is_empty()).unwrap_or(false) {
        target.push(decoded);
    }
}

fn fit_message_collection(values: Vec<serde_json::Value>) -> Option<serde_json::Value> {
    if values.is_empty() {
        None
    } else {
        Some(serde_json::Value::Array(values))
    }
}

fn clean_fit_label(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let lower = trimmed.to_lowercase();
    if trimmed.is_empty()
        || trimmed.chars().all(|c| c.is_ascii_digit())
        || matches!(lower.as_str(), "unknown" | "invalid")
        || lower.starts_with("unknown_variant_")
    {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn unresolved_fit_value(value: &str) -> bool {
    clean_fit_label(value).is_none()
}

fn canonical_fit_sport(session_sport: &str, sport_profile_name: Option<&str>) -> String {
    let sport = session_sport.trim().to_lowercase();
    if unresolved_fit_value(&sport) {
        if let Some(profile_name) = sport_profile_name.and_then(clean_fit_label) {
            return profile_name.to_lowercase();
        }
        return "unknown".to_string();
    }
    sport
}

fn combine_device_name(
    product_name: Option<String>,
    manufacturer: Option<String>,
    product: Option<String>,
) -> Option<String> {
    let from_product_name = product_name
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if from_product_name.is_some() {
        return from_product_name;
    }

    let manufacturer = manufacturer
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let product = product
        .map(|s| s.trim().to_string())
        .and_then(|s| {
            // Many FIT files provide only numeric product IDs (e.g. "4625")
            // or unknown placeholders. Avoid surfacing these as user-facing names.
            let lower = s.to_lowercase();
            let is_numeric_only = s.chars().all(|c| c.is_ascii_digit());
            let is_unknown_variant = lower.starts_with("unknown_variant_");
            if s.is_empty() || is_numeric_only || is_unknown_variant {
                None
            } else {
                Some(s)
            }
        });

    match (manufacturer, product) {
        (Some(m), Some(p)) => Some(format!("{} {}", m, p)),
        (Some(m), None) => Some(m),
        (None, Some(p)) => Some(p),
        (None, None) => None,
    }
}

fn to_degrees_if_semicircles(v: f64) -> f64 {
    if v.abs() > 180.0 {
        v * (180.0 / 2_f64.powi(31))
    } else {
        v
    }
}

fn parse_timestamp_ms(raw: &str) -> Option<i64> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(raw) {
        return Some(dt.timestamp_millis());
    }
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(dt.and_utc().timestamp_millis());
    }
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S") {
        return Some(dt.and_utc().timestamp_millis());
    }
    None
}

fn value_timestamp_ms(v: &Value) -> Option<i64> {
    match v {
        Value::Timestamp(dt) => Some(dt.timestamp_millis()),
        Value::String(s) => parse_timestamp_ms(s),
        _ => None,
    }
}

fn format_fit_version(v: &Value) -> Option<String> {
    value_f64(v).map(|value| format!("{value:.2}"))
}

fn strip_known_extension(file_name: &str) -> String {
    let lower = file_name.to_lowercase();
    if lower.ends_with(".fit") || lower.ends_with(".tcx") || lower.ends_with(".gpx") {
        let cut = file_name.rfind('.').unwrap_or(file_name.len());
        return file_name[..cut].to_string();
    }
    file_name.to_string()
}

fn file_hash_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn child_text(node: roxmltree::Node<'_, '_>, name: &str) -> Option<String> {
    node.children()
        .find(|n| n.is_element() && n.tag_name().name() == name)
        .and_then(|n| n.text())
        .map(|s| s.trim().to_string())
}

fn child_f64(node: roxmltree::Node<'_, '_>, name: &str) -> Option<f64> {
    child_text(node, name).and_then(|s| s.parse::<f64>().ok())
}

fn child_i64(node: roxmltree::Node<'_, '_>, name: &str) -> Option<i64> {
    child_text(node, name).and_then(|s| s.parse::<i64>().ok())
}

fn child_node<'a>(node: roxmltree::Node<'a, 'a>, name: &str) -> Option<roxmltree::Node<'a, 'a>> {
    node.children()
        .find(|n| n.is_element() && n.tag_name().name() == name)
}

#[derive(Debug, Clone, Default)]
struct ActivityLocation {
    city: Option<String>,
    region: Option<String>,
    country: Option<String>,
    label: Option<String>,
}

fn clean_string(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn title_case_words(value: &str) -> String {
    let words: Vec<String> = value
        .split(|c: char| c == '_' || c == '-' || c.is_whitespace())
        .filter(|part| !part.is_empty())
        .map(|part| {
            let lower = part.to_lowercase();
            match lower.as_str() {
                "gps" | "hr" | "hrm" | "bmx" | "hiit" => lower.to_uppercase(),
                "ebike" | "ebiking" => "eBiking".to_string(),
                _ => {
                    let mut chars = lower.chars();
                    match chars.next() {
                        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                        None => String::new(),
                    }
                }
            }
        })
        .filter(|part| !part.is_empty())
        .collect();

    words.join(" ")
}

fn title_case_sport(sport: &str) -> String {
    let sport = sport.trim();
    if sport.is_empty() || sport.eq_ignore_ascii_case("unknown") {
        return "Activity".to_string();
    }

    let label = title_case_words(sport);
    if label.is_empty() {
        "Activity".to_string()
    } else {
        label
    }
}

fn activity_type_label(sport: &str, sub_sport: Option<&str>) -> String {
    let sport_label = title_case_sport(sport);
    let Some(raw_sub_sport) = sub_sport.map(str::trim).filter(|s| !s.is_empty()) else {
        return sport_label;
    };

    let sub_sport_lower = raw_sub_sport.to_lowercase();
    if matches!(sub_sport_lower.as_str(), "generic" | "all" | "unknown" | "invalid") {
        return sport_label;
    }

    let sport_lower = sport.trim().to_lowercase();
    match (sport_lower.as_str(), sub_sport_lower.as_str()) {
        ("cycling", "road") => return "Road Cycling".to_string(),
        ("cycling", "indoor_cycling") | ("cycling", "spin") => {
            return "Indoor Cycling".to_string()
        }
        ("cycling", "mountain") | ("cycling", "mountain_biking") => {
            return "Mountain Biking".to_string()
        }
        ("cycling", "gravel_cycling") => return "Gravel Cycling".to_string(),
        ("cycling", "e_bike_fitness") | ("e_biking", "e_bike_fitness") => {
            return "eBiking".to_string()
        }
        ("cycling", "e_bike_mountain") | ("e_biking", "e_bike_mountain") => {
            return "eMountain Biking".to_string()
        }
        ("cycling", "cyclocross") => return "Cyclocross".to_string(),
        ("cycling", "track_cycling") => return "Track Cycling".to_string(),
        ("running", "trail") => return "Trail Running".to_string(),
        ("running", "treadmill") | ("running", "indoor_running") => {
            return "Treadmill Running".to_string()
        }
        ("running", "track") => return "Track Running".to_string(),
        ("running", "ultra") => return "Ultra Running".to_string(),
        ("swimming", "lap_swimming") => return "Lap Swimming".to_string(),
        ("swimming", "open_water") => return "Open Water Swimming".to_string(),
        ("training", "strength_training") => return "Strength Training".to_string(),
        ("training", "cardio_training") => return "Cardio Training".to_string(),
        ("training", "yoga") => return "Yoga".to_string(),
        ("training", "pilates") => return "Pilates".to_string(),
        _ => {}
    }

    let sub_sport_label = title_case_words(raw_sub_sport);
    if sub_sport_label.is_empty() {
        return sport_label;
    }

    if sport_label == "Activity" || sub_sport_lower.contains(sport_lower.as_str()) {
        sub_sport_label
    } else {
        format!("{sub_sport_label} {sport_label}")
    }
}

fn generated_activity_name(sport: &str, sub_sport: Option<&str>) -> String {
    activity_type_label(sport, sub_sport)
}

fn derive_activity_location(points: &[RecordPoint]) -> ActivityLocation {
    let Some(pos) = points.iter().find(|p| p.latitude.is_some() && p.longitude.is_some()) else {
        return ActivityLocation::default();
    };

    let geocoder = reverse_geocoder::ReverseGeocoder::new();
    let result = geocoder.search((pos.latitude.unwrap(), pos.longitude.unwrap()));
    let record = result.record;

    let city = clean_string(record.name.to_string());
    let region = clean_string(record.admin1.to_string());
    let country = clean_string(record.cc.to_string());
    let label = [city.as_deref(), region.as_deref()]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(", ");

    ActivityLocation {
        city,
        region,
        country,
        label: if label.is_empty() { None } else { Some(label) },
    }
}

fn build_generated_title(
    file_name: &str,
    sport: &str,
    sub_sport: Option<&str>,
    location: &ActivityLocation,
) -> String {
    let fallback = strip_known_extension(file_name);
    let activity_label = generated_activity_name(sport, sub_sport);
    if activity_label != "Activity" {
        if let Some(city) = location.city.as_deref().filter(|city| !city.is_empty()) {
            return format!("{} {}", city, activity_label);
        }
        return activity_label;
    }
    fallback
}

#[cfg(test)]
fn build_activity_name(
    file_name: &str,
    sport: &str,
    sub_sport: Option<&str>,
    points: &[RecordPoint],
) -> String {
    let location = derive_activity_location(points);
    build_generated_title(file_name, sport, sub_sport, &location)
}

fn haversine_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let r = 6_371_000.0_f64;
    let to_rad = std::f64::consts::PI / 180.0;
    let dlat = (lat2 - lat1) * to_rad;
    let dlon = (lon2 - lon1) * to_rad;
    let lat1r = lat1 * to_rad;
    let lat2r = lat2 * to_rad;
    let a = (dlat / 2.0).sin().powi(2) + lat1r.cos() * lat2r.cos() * (dlon / 2.0).sin().powi(2);
    let c = 2.0 * a.sqrt().atan2((1.0 - a).sqrt());
    r * c
}

fn derive_distance_if_missing(points: &mut [RecordPoint]) {
    let has_distance = points.iter().any(|p| p.distance_m.is_some());
    if has_distance {
        return;
    }

    let mut cumulative = 0.0;
    for i in 0..points.len() {
        if i > 0 {
            if let (Some(lat1), Some(lon1), Some(lat2), Some(lon2)) = (
                points[i - 1].latitude,
                points[i - 1].longitude,
                points[i].latitude,
                points[i].longitude,
            ) {
                cumulative += haversine_m(lat1, lon1, lat2, lon2);
            }
        }
        points[i].distance_m = Some(cumulative);
    }
}

fn derive_speed_if_missing(points: &mut [RecordPoint]) {
    for i in 1..points.len() {
        if points[i].speed_m_s.is_some() {
            continue;
        }
        let dt_s = (points[i].timestamp_ms - points[i - 1].timestamp_ms) as f64 / 1000.0;
        let dd_m = match (points[i].distance_m, points[i - 1].distance_m) {
            (Some(curr), Some(prev)) => curr - prev,
            _ => 0.0,
        };
        if dt_s > 0.0 && dd_m >= 0.0 {
            points[i].speed_m_s = Some(dd_m / dt_s);
        }
    }
}

fn total_distance_m(points: &[RecordPoint]) -> f64 {
    points
        .iter()
        .filter_map(|p| p.distance_m)
        .max_by(|a, b| a.total_cmp(b))
        .unwrap_or(0.0)
}

fn normalize_record_distances_to_zero(points: &mut [RecordPoint]) {
    let Some(first_distance_m) = points.iter().find_map(|p| p.distance_m) else {
        return;
    };

    for point in points.iter_mut().filter(|p| p.distance_m.is_some()) {
        let distance_m = point.distance_m.unwrap() - first_distance_m;
        point.distance_m = Some(distance_m.max(0.0));
    }
}

fn valid_duration_s(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite() && *v > 0.0)
}

fn add_valid_duration_s(total: &mut Option<f64>, value: Option<f64>) {
    if let Some(duration) = valid_duration_s(value) {
        *total = Some(total.unwrap_or(0.0) + duration);
    }
}

fn select_fit_duration_s(
    session_total_timer_time_sum_s: Option<f64>,
    activity_total_timer_time_s: Option<f64>,
    lap_total_timer_time_sum_s: Option<f64>,
    session_total_elapsed_time_sum_s: Option<f64>,
    record_span_duration_s: f64,
) -> (f64, &'static str) {
    if let Some(duration) = valid_duration_s(session_total_timer_time_sum_s) {
        return (duration, "sessions.total_timer_time_sum");
    }
    if let Some(duration) = valid_duration_s(activity_total_timer_time_s) {
        return (duration, "activity.total_timer_time");
    }
    if let Some(duration) = valid_duration_s(lap_total_timer_time_sum_s) {
        return (duration, "laps.total_timer_time_sum");
    }
    if let Some(duration) = valid_duration_s(session_total_elapsed_time_sum_s) {
        return (duration, "sessions.total_elapsed_time_sum");
    }

    (record_span_duration_s.max(0.0), "record_timestamp_span")
}

fn select_fit_time_range_ms(
    record_start_ts: i64,
    record_end_ts: i64,
    session_start_ts: Option<i64>,
    session_end_ts: Option<i64>,
    duration_s: f64,
) -> (i64, i64) {
    let start_ts = session_start_ts.unwrap_or(record_start_ts);
    let mut end_ts = session_end_ts.unwrap_or(record_end_ts).max(start_ts);
    let current_span_ms = end_ts - start_ts;
    let duration_ms = (duration_s * 1000.0).round();

    if duration_ms.is_finite() && duration_ms > current_span_ms as f64 {
        if let Some(duration_end_ts) = start_ts.checked_add(duration_ms as i64) {
            end_ts = duration_end_ts;
        }
    }

    (start_ts, end_ts)
}

fn normalize_fit_token(raw: &str) -> Option<String> {
    let value = raw.trim().to_lowercase().replace([' ', '-'], "_");
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn fit_event_name(value: &Value) -> Option<String> {
    let raw = normalize_fit_token(&value_string(value))?;
    Some(match raw.as_str() {
        "0" => "timer".to_string(),
        _ => raw,
    })
}

fn fit_event_type_name(value: &Value) -> Option<String> {
    let raw = normalize_fit_token(&value_string(value))?;
    Some(match raw.as_str() {
        "0" => "start".to_string(),
        "1" => "stop".to_string(),
        "4" => "stop_all".to_string(),
        "8" => "stop_disable".to_string(),
        "9" => "stop_disable_all".to_string(),
        _ => raw,
    })
}

fn fit_timer_trigger_name(value: &Value) -> Option<String> {
    let raw = normalize_fit_token(&value_string(value))?;
    Some(match raw.as_str() {
        "0" => "manual".to_string(),
        "1" => "auto".to_string(),
        "2" => "fitness_equipment".to_string(),
        _ => raw,
    })
}

fn is_timer_start_event(event_type: &str) -> bool {
    matches!(event_type, "start" | "start_all")
}

fn is_timer_stop_event(event_type: &str) -> bool {
    matches!(event_type, "stop" | "stop_all" | "stop_disable" | "stop_disable_all")
}

fn timestamp_ms_to_rfc3339(ts: i64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(ts).map(|dt| dt.to_rfc3339())
}

fn build_stopped_intervals(
    timer_events: &[TimerEvent],
    start_bound_ms: i64,
    end_bound_ms: i64,
) -> Vec<StoppedInterval> {
    let mut events = timer_events.to_vec();
    events.sort_by_key(|event| event.timestamp_ms);

    let mut stopped_start: Option<TimerEvent> = None;
    let mut intervals = Vec::new();

    for event in events {
        if event.event != "timer" {
            continue;
        }

        if is_timer_stop_event(&event.event_type) {
            if stopped_start.is_none() {
                stopped_start = Some(event);
            }
            continue;
        }

        if is_timer_start_event(&event.event_type) {
            let Some(stop_event) = stopped_start.take() else {
                continue;
            };

            let start_ms = stop_event.timestamp_ms.max(start_bound_ms);
            let end_ms = event.timestamp_ms.min(end_bound_ms);
            if end_ms > start_ms {
                intervals.push(StoppedInterval {
                    start_ms,
                    end_ms,
                    trigger: stop_event.timer_trigger,
                    resume_trigger: event.timer_trigger,
                    source: "fit_event_message",
                });
            }
        }
    }

    intervals
}

fn unmatched_timer_starts(timer_events: &[TimerEvent]) -> Vec<TimerEvent> {
    let mut events = timer_events.to_vec();
    events.sort_by_key(|event| event.timestamp_ms);

    let mut timer_stopped = false;
    let mut unmatched_starts = Vec::new();
    for event in events {
        if event.event != "timer" {
            continue;
        }

        if is_timer_stop_event(&event.event_type) {
            timer_stopped = true;
        } else if is_timer_start_event(&event.event_type) {
            if timer_stopped {
                timer_stopped = false;
            } else {
                unmatched_starts.push(event);
            }
        }
    }

    unmatched_starts
}

fn infer_missing_stopped_intervals(
    timer_events: &[TimerEvent],
    record_timestamps: &[i64],
    explicit_intervals: &[StoppedInterval],
    record_start_ts: i64,
    record_end_ts: i64,
    expected_stopped_time_s: f64,
) -> Vec<StoppedInterval> {
    let explicit_stopped_time_s: f64 = explicit_intervals
        .iter()
        .map(|interval| ((interval.end_ms - interval.start_ms).max(0) as f64) / 1000.0)
        .sum();
    let unexplained_stopped_time_s = expected_stopped_time_s - explicit_stopped_time_s;
    if unexplained_stopped_time_s <= TIMER_INTERVAL_TOLERANCE_S {
        return Vec::new();
    }

    let mut timestamps = record_timestamps
        .iter()
        .copied()
        .filter(|timestamp| *timestamp >= record_start_ts && *timestamp <= record_end_ts)
        .collect::<Vec<_>>();
    timestamps.sort_unstable();
    timestamps.dedup();
    if timestamps.len() < 2 {
        return Vec::new();
    }

    let mut candidates = Vec::new();
    for event in unmatched_timer_starts(timer_events) {
        if event.timestamp_ms <= record_start_ts || event.timestamp_ms > record_end_ts {
            continue;
        }
        let end_ms = event.timestamp_ms;
        let insertion = timestamps.partition_point(|timestamp| *timestamp < end_ms);
        if insertion == 0 {
            continue;
        }

        let start_ms = timestamps[insertion - 1].max(record_start_ts);
        let duration_s = ((end_ms - start_ms).max(0) as f64) / 1000.0;
        if duration_s <= TIMER_INTERVAL_TOLERANCE_S
            || explicit_intervals
                .iter()
                .any(|interval| start_ms < interval.end_ms && end_ms > interval.start_ms)
        {
            continue;
        }

        candidates.push(StoppedInterval {
            start_ms,
            end_ms,
            trigger: None,
            resume_trigger: event.timer_trigger,
            source: "inferred_record_gap",
        });
    }

    let inferred_stopped_time_s: f64 = candidates
        .iter()
        .map(|interval| ((interval.end_ms - interval.start_ms).max(0) as f64) / 1000.0)
        .sum();
    if inferred_stopped_time_s > 0.0
        && (unexplained_stopped_time_s - inferred_stopped_time_s).abs()
            <= TIMER_INTERVAL_TOLERANCE_S
    {
        candidates
    } else {
        Vec::new()
    }
}

fn build_timer_metadata(
    timer_events: &[TimerEvent],
    record_timestamps: &[i64],
    record_start_ts: i64,
    record_end_ts: i64,
    elapsed_time_s: Option<f64>,
    timer_time_s: f64,
) -> serde_json::Value {
    let elapsed_time_s = valid_duration_s(elapsed_time_s)
        .unwrap_or_else(|| ((record_end_ts - record_start_ts).max(0) as f64) / 1000.0);
    let expected_stopped_time_s = (elapsed_time_s - timer_time_s).max(0.0);
    let mut intervals = build_stopped_intervals(timer_events, record_start_ts, record_end_ts);
    let inferred_intervals = infer_missing_stopped_intervals(
        timer_events,
        record_timestamps,
        &intervals,
        record_start_ts,
        record_end_ts,
        expected_stopped_time_s,
    );
    let inferred_interval_count = inferred_intervals.len();
    intervals.extend(inferred_intervals);
    intervals.sort_by_key(|interval| (interval.start_ms, interval.end_ms));
    let stopped_time_s: f64 = intervals
        .iter()
        .map(|interval| ((interval.end_ms - interval.start_ms).max(0) as f64) / 1000.0)
        .sum();
    let derived_timer_time_s = (elapsed_time_s - stopped_time_s).max(0.0);
    let intervals_reliable = !intervals.is_empty()
        && (derived_timer_time_s - timer_time_s).abs() <= TIMER_INTERVAL_TOLERANCE_S;

    serde_json::json!({
        "schema_version": 2,
        "source": if inferred_interval_count > 0 {
            "fit_event_messages_with_record_gap_inference"
        } else {
            "fit_event_messages"
        },
        "active_time_supported": intervals_reliable,
        "intervals_reliable": intervals_reliable,
        "elapsed_time_s": elapsed_time_s,
        "timer_time_s": timer_time_s,
        "stopped_time_s": stopped_time_s,
        "inferred_interval_count": inferred_interval_count,
        "events": timer_events.iter().map(|event| serde_json::json!({
            "timestamp": timestamp_ms_to_rfc3339(event.timestamp_ms),
            "event": event.event,
            "event_type": event.event_type,
            "timer_trigger": event.timer_trigger
        })).collect::<Vec<_>>(),
        "stopped_intervals": intervals.iter().map(|interval| serde_json::json!({
            "start_ts_utc": timestamp_ms_to_rfc3339(interval.start_ms),
            "end_ts_utc": timestamp_ms_to_rfc3339(interval.end_ms),
            "duration_s": ((interval.end_ms - interval.start_ms).max(0) as f64) / 1000.0,
            "trigger": interval.trigger,
            "resume_trigger": interval.resume_trigger,
            "source": interval.source
        })).collect::<Vec<_>>()
    })
}

fn update_min_ts(slot: &mut Option<i64>, value: Option<i64>) {
    if let Some(ts) = value {
        *slot = Some(slot.map_or(ts, |current| current.min(ts)));
    }
}

fn update_max_ts(slot: &mut Option<i64>, value: Option<i64>) {
    if let Some(ts) = value {
        *slot = Some(slot.map_or(ts, |current| current.max(ts)));
    }
}

fn first_valid_coordinates(points: &[RecordPoint]) -> (Option<f64>, Option<f64>) {
    if let Some(point) = points
        .iter()
        .find(|p| p.latitude.is_some() && p.longitude.is_some())
    {
        return (point.latitude, point.longitude);
    }
    (None, None)
}

pub fn parse_activity_bytes(file_name: &str, bytes: &[u8]) -> Result<ParsedActivity> {
    let ext = Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "fit" => parse_fit_bytes(file_name, bytes),
        "tcx" => parse_tcx_bytes(file_name, bytes),
        "gpx" => parse_gpx_bytes(file_name, bytes),
        _ => {
            let text = std::str::from_utf8(bytes).unwrap_or("");
            if text.contains("<TrainingCenterDatabase") {
                parse_tcx_bytes(file_name, bytes)
            } else if text.contains("<gpx") {
                parse_gpx_bytes(file_name, bytes)
            } else {
                Err(anyhow!(
                    "unsupported file extension; expected .fit, .tcx, or .gpx"
                ))
            }
        }
    }
}

fn parse_fit_bytes(file_name: &str, bytes: &[u8]) -> Result<ParsedActivity> {
    let file_hash = file_hash_hex(bytes);

    let mut reader = std::io::Cursor::new(bytes);
    let records = fitparser::from_reader(&mut reader).context("failed to parse FIT")?;

    let mut points: Vec<RecordPoint> = Vec::new();
    let mut sport = String::from("unknown");
    let mut sub_sport: Option<String> = None;
    let mut source_title: Option<String> = None;
    let mut session_sport_raw_code: Option<i64> = None;
    let mut sport_profile_name: Option<String> = None;
    let mut device = String::new();
    let mut file_id_product_name: Option<String> = None;
    let mut file_id_manufacturer: Option<String> = None;
    let mut file_id_product: Option<String> = None;
    let mut file_id_serial_number: Option<i64> = None;
    let mut file_id_type_name: Option<String> = None;
    let mut file_id_type_code: Option<i64> = None;
    let mut raw_file_id = RawFileId::default();
    let mut raw_device_info_records: Vec<RawDeviceInfo> = Vec::new();
    let mut device_info_fallback_name: Option<String> = None;
    let mut device_info_fallback_serial: Option<i64> = None;
    let mut device_info_creator_name: Option<String> = None;
    let mut device_info_creator_serial: Option<i64> = None;
    let mut vo2_max: Option<f64> = None;
    let mut vo2_max_estimates: Vec<Vo2MaxEstimateMetadata> = Vec::new();
    let mut starting_vo2_values: Vec<StartingVo2Value> = Vec::new();
    let mut vo2_sessions: Vec<Vo2SessionContext> = Vec::new();
    let mut pending_vo2_estimate_index: Option<usize> = None;
    let mut user_profile = serde_json::Map::new();

    let mut session_beginning_body_battery: Option<i64> = None;
    let mut session_ending_body_battery: Option<i64> = None;
    let mut session_max_heart_rate: Option<i64> = None;
    let mut session_avg_heart_rate: Option<i64> = None;
    let mut session_max_cadence: Option<i64> = None;
    let mut session_avg_cadence: Option<i64> = None;
    let mut session_count: i64 = 0;
    let mut session_start_ts: Option<i64> = None;
    let mut session_end_ts: Option<i64> = None;
    let mut session_total_elapsed_time_sum_s: Option<f64> = None;
    let mut session_total_timer_time_sum_s: Option<f64> = None;
    let mut session_total_distance_m: Option<f64> = None;
    let mut session_total_calories: Option<i64> = None;
    let mut session_normalized_power: Option<i64> = None;
    let mut session_avg_power: Option<i64> = None;
    let mut session_max_power: Option<i64> = None;
    let mut session_total_ascent_m: Option<f64> = None;
    let mut session_total_descent_m: Option<f64> = None;
    let mut session_training_stress_score: Option<f64> = None;
    let mut session_intensity_factor: Option<f64> = None;
    let mut session_threshold_power: Option<i64> = None;
    let mut session_left_right_balance: Option<serde_json::Value> = None;
    let mut session_total_work_j: Option<i64> = None;
    let mut session_avg_temperature_c: Option<i64> = None;
    let mut session_min_temperature_c: Option<i64> = None;
    let mut session_max_temperature_c: Option<i64> = None;
    let mut session_total_training_effect: Option<f64> = None;
    let mut session_total_anaerobic_training_effect: Option<f64> = None;
    let mut session_training_load_peak: Option<f64> = None;
    let mut session_workout_feel: Option<i64> = None;
    let mut session_workout_rpe: Option<i64> = None;
    let mut session_time_standing_s: Option<f64> = None;
    let mut session_stand_count: Option<i64> = None;
    let mut session_total_grit: Option<f64> = None;
    let mut session_avg_flow: Option<f64> = None;
    let mut session_jump_count: Option<i64> = None;
    let mut activity_total_timer_time_s: Option<f64> = None;
    let mut lap_total_timer_time_sum_s: Option<f64> = None;
    let mut lap_ranges: Vec<serde_json::Value> = Vec::new();
    let mut timer_events: Vec<TimerEvent> = Vec::new();
    let mut zones = ZoneAccumulator::default();
    let mut workout_metadata = serde_json::Map::new();
    let mut training_file_metadata = serde_json::Map::new();
    let mut workout_steps: Vec<serde_json::Value> = Vec::new();
    let mut fit_session_messages: Vec<serde_json::Value> = Vec::new();
    let mut fit_lap_messages: Vec<serde_json::Value> = Vec::new();
    let mut fit_time_in_zone_messages: Vec<serde_json::Value> = Vec::new();
    let mut fit_split_messages: Vec<serde_json::Value> = Vec::new();
    let mut fit_split_summary_messages: Vec<serde_json::Value> = Vec::new();
    let mut fit_climb_pro_messages: Vec<serde_json::Value> = Vec::new();
    let mut fit_event_messages: Vec<serde_json::Value> = Vec::new();

    let mut min_ts: Option<i64> = None;
    let mut max_ts: Option<i64> = None;

    for (message_index, rec) in records.into_iter().enumerate() {
        if rec.kind() == MesgNum::Record {
            let mut timestamp_ms: Option<i64> = None;
            let mut latitude = None;
            let mut longitude = None;
            let mut altitude_m = None;
            let mut distance_m = None;
            let mut speed_m_s = None;
            let mut cadence = None;
            let mut heart_rate = None;
            let mut power = None;
            let mut temperature_c = None;
            let mut respiration_rate_brpm = None;
            let mut current_stamina_pct = None;
            let mut potential_stamina_pct = None;
            let mut performance_condition = None;

            for field in rec.fields() {
                match field.name() {
                    "timestamp" => {
                        if let Value::Timestamp(dt) = field.value() {
                            timestamp_ms = Some(dt.timestamp_millis());
                        }
                    }
                    "position_lat" => latitude = value_f64(field.value()).map(to_degrees_if_semicircles),
                    "position_long" => longitude = value_f64(field.value()).map(to_degrees_if_semicircles),
                    "altitude" | "enhanced_altitude" => {
                        let v = value_f64(field.value());
                        if field.name() == "enhanced_altitude" || altitude_m.is_none() {
                            altitude_m = v;
                        }
                    }
                    "distance" => distance_m = value_f64(field.value()),
                    "speed" | "enhanced_speed" => {
                        let v = value_f64(field.value());
                        if field.name() == "enhanced_speed" || speed_m_s.is_none() {
                            speed_m_s = v;
                        }
                    }
                    "cadence" => cadence = value_i64(field.value()),
                    "heart_rate" => heart_rate = value_i64(field.value()),
                    "power" => power = value_i64(field.value()),
                    "temperature" => temperature_c = value_f64(field.value()),
                    "enhanced_respiration_rate" => respiration_rate_brpm = value_f64(field.value()),
                    "respiration_rate" => {
                        if respiration_rate_brpm.is_none() {
                            respiration_rate_brpm = value_f64(field.value());
                        }
                    }
                    // Garmin proprietary record field 138, empirically mapped to current stamina.
                    "unknown_field_138" | "current_stamina" => current_stamina_pct = value_f64(field.value()),
                    // Garmin proprietary record field 137, empirically mapped to potential stamina.
                    "unknown_field_137" | "potential_stamina" => potential_stamina_pct = value_f64(field.value()),
                    // Garmin proprietary record field 90, empirically mapped to Performance Condition.
                    "unknown_field_90" | "performance_condition" => performance_condition = value_i64(field.value()),
                    _ => {}
                }
            }

            if let Some(ts) = timestamp_ms {
                min_ts = Some(min_ts.map_or(ts, |m| m.min(ts)));
                max_ts = Some(max_ts.map_or(ts, |m| m.max(ts)));
                points.push(RecordPoint {
                    timestamp_ms: ts,
                    latitude,
                    longitude,
                    altitude_m,
                    distance_m,
                    speed_m_s,
                    cadence,
                    heart_rate,
                    power,
                    temperature_c,
                    respiration_rate_brpm,
                    current_stamina_pct,
                    potential_stamina_pct,
                    performance_condition,
                });
            }
        } else if rec.kind() == MesgNum::Session {
            let vo2_session_index = session_count as usize;
            session_count += 1;
            let mut current_session_sport: Option<String> = None;
            let mut current_session_sub_sport: Option<String> = None;
            push_decoded_fit_message(&mut fit_session_messages, &rec);
            for field in rec.fields() {
                match field.name() {
                    "sport" => {
                        let value = value_string(field.value());
                        session_sport_raw_code = value_i64(field.value())
                            .or_else(|| value.trim().parse().ok());
                        sport = value.to_lowercase();
                        current_session_sport = Some(sport.clone());
                    }
                    "sub_sport" => {
                        let value = value_string(field.value()).to_lowercase();
                        if !value.trim().is_empty() {
                            sub_sport = Some(value.clone());
                            current_session_sub_sport = Some(value);
                        }
                    }
                    "start_time" => {
                        update_min_ts(&mut session_start_ts, value_timestamp_ms(field.value()))
                    }
                    "timestamp" => {
                        update_max_ts(&mut session_end_ts, value_timestamp_ms(field.value()))
                    }
                    "beginning_body_battery" | "start_body_battery" => {
                        session_beginning_body_battery = value_i64(field.value())
                    }
                    "ending_body_battery" | "end_body_battery" => {
                        session_ending_body_battery = value_i64(field.value())
                    }
                    "max_heart_rate" => session_max_heart_rate = value_i64(field.value()),
                    "avg_heart_rate" => session_avg_heart_rate = value_i64(field.value()),
                    "max_cadence" => session_max_cadence = value_i64(field.value()),
                    "avg_cadence" => session_avg_cadence = value_i64(field.value()),
                    "total_elapsed_time" => {
                        add_valid_duration_s(
                            &mut session_total_elapsed_time_sum_s,
                            value_f64(field.value()),
                        )
                    }
                    "total_timer_time" => {
                        add_valid_duration_s(
                            &mut session_total_timer_time_sum_s,
                            value_f64(field.value()),
                        )
                    }
                    "total_distance" => session_total_distance_m = value_f64(field.value()),
                    "total_calories" => session_total_calories = value_i64(field.value()),
                    "normalized_power" => session_normalized_power = value_i64(field.value()),
                    "avg_power" => session_avg_power = value_i64(field.value()),
                    "max_power" => session_max_power = value_i64(field.value()),
                    "total_ascent" => session_total_ascent_m = value_f64(field.value()),
                    "total_descent" => session_total_descent_m = value_f64(field.value()),
                    "training_stress_score" => session_training_stress_score = value_f64(field.value()),
                    "intensity_factor" => session_intensity_factor = value_f64(field.value()),
                    "threshold_power" => session_threshold_power = value_i64(field.value()),
                    "left_right_balance" => session_left_right_balance = decoded_left_right_balance(field.value()),
                    "total_work" => session_total_work_j = value_i64(field.value()),
                    "avg_temperature" => session_avg_temperature_c = value_i64(field.value()),
                    "min_temperature" => session_min_temperature_c = value_i64(field.value()),
                    "max_temperature" => session_max_temperature_c = value_i64(field.value()),
                    "total_training_effect" => session_total_training_effect = value_f64(field.value()),
                    "total_anaerobic_training_effect" => session_total_anaerobic_training_effect = value_f64(field.value()),
                    "training_load_peak" => session_training_load_peak = value_f64(field.value()),
                    "workout_feel" => session_workout_feel = value_i64(field.value()),
                    "workout_rpe" => session_workout_rpe = value_i64(field.value()),
                    "time_standing" => session_time_standing_s = value_f64(field.value()),
                    "stand_count" => session_stand_count = value_i64(field.value()),
                    "total_grit" => session_total_grit = value_f64(field.value()),
                    "avg_flow" => session_avg_flow = value_f64(field.value()),
                    "jump_count" => session_jump_count = value_i64(field.value()),
                    _ => {}
                }
            }

            if let Some(session_sport) = current_session_sport {
                let session_category = vo2_category_from_sport_name(&session_sport);
                vo2_sessions.push(Vo2SessionContext {
                    session_index: vo2_session_index,
                    sport: session_sport.clone(),
                });

                if let Some(estimate_index) = pending_vo2_estimate_index {
                    if let Some(estimate) = vo2_max_estimates.get_mut(estimate_index) {
                        let expected_code = session_category
                            .as_deref()
                            .and_then(sport_code_for_vo2_category);
                        let sport_matches = expected_code.is_none()
                            || estimate.activity_sport_code.is_none()
                            || estimate.activity_sport_code == expected_code;
                        if sport_matches {
                            estimate.session_index = Some(vo2_session_index);
                            estimate.activity_sport = Some(session_sport);
                            estimate.sub_sport = current_session_sub_sport;
                            if estimate.category == "unknown" {
                                if let Some(category) = session_category {
                                    estimate.category = category;
                                }
                            }
                        }
                    }
                }
            }
            pending_vo2_estimate_index = None;
        } else if rec.kind() == MesgNum::Sport {
            for field in rec.fields() {
                if field.name() == "name" && sport_profile_name.is_none() {
                    let value = value_string(field.value());
                    sport_profile_name = clean_fit_label(&value);
                }
            }
        } else if rec.kind() == MesgNum::DeviceInfo {
            let mut raw_device_info = RawDeviceInfo::default();
            let mut candidate_product_name: Option<String> = None;
            let mut candidate_manufacturer: Option<String> = None;
            let mut candidate_product: Option<String> = None;
            let mut candidate_serial: Option<i64> = None;
            let mut is_creator = false;

            for field in rec.fields() {
                match field.name() {
                    "timestamp" => {
                        raw_device_info.timestamp_ms = value_timestamp_ms(field.value());
                    }
                    "device_index" => {
                        let v = value_string(field.value());
                        raw_device_info.device_index_value = Some(v.clone());
                        raw_device_info.device_index_code = value_i64(field.value());
                        if v.eq_ignore_ascii_case("creator") || raw_device_info.device_index_code == Some(0) {
                            is_creator = true;
                        }
                    }
                    "source_type" => {
                        raw_device_info.source_type_value = Some(value_string(field.value()));
                        raw_device_info.source_type_code = value_i64(field.value());
                    }
                    "product_name" => {
                        let value = value_string(field.value());
                        if !value.trim().is_empty() {
                            raw_device_info.product_name = Some(value.clone());
                            candidate_product_name = Some(value);
                        }
                    }
                    "manufacturer" => {
                        let value = value_string(field.value());
                        if !value.trim().is_empty() {
                            raw_device_info.manufacturer_value = Some(value.clone());
                            candidate_manufacturer = Some(value);
                        }
                    }
                    "garmin_product" | "product" | "favero_product" => {
                        let value = value_string(field.value());
                        if !value.trim().is_empty() {
                            raw_device_info.product_field = Some(field.name().to_string());
                            raw_device_info.product_value = Some(value.clone());
                            candidate_product = Some(value);
                        }
                    }
                    "serial_number" => {
                        candidate_serial = value_i64(field.value()).filter(|v| *v > 0);
                        raw_device_info.serial_number = candidate_serial;
                    }
                    "software_version" => {
                        raw_device_info.software_version = format_fit_version(field.value());
                    }
                    "hardware_version" => {
                        raw_device_info.hardware_version = value_i64(field.value());
                    }
                    "battery_status" => {
                        let value = value_string(field.value());
                        if !value.trim().is_empty() {
                            raw_device_info.battery_status = Some(value);
                        }
                    }
                    "battery_level" => {
                        raw_device_info.battery_level = value_f64(field.value());
                    }
                    "battery_voltage" => {
                        raw_device_info.battery_voltage = value_f64(field.value());
                    }
                    "ant_device_number" => {
                        raw_device_info.ant_device_number = value_i64(field.value());
                    }
                    "ant_transmission_type" => {
                        raw_device_info.ant_transmission_type = value_i64(field.value());
                    }
                    "ant_network" => {
                        raw_device_info.ant_network_value = Some(value_string(field.value()));
                        raw_device_info.ant_network_code = value_i64(field.value());
                    }
                    "descriptor" => {
                        let value = value_string(field.value());
                        if !value.trim().is_empty() {
                            raw_device_info.descriptor = Some(value);
                        }
                    }
                    "antplus_device_type" | "ble_device_type" | "local_device_type" | "device_type"
                    | "ant_device_type" => {
                        let value = value_string(field.value());
                        if !value.trim().is_empty() {
                            raw_device_info.device_types.push(RawDeviceType {
                                field: field.name().to_string(),
                                value,
                                code: value_i64(field.value()),
                            });
                        }
                    }
                    _ => {}
                }
            }

            let candidate_name = combine_device_name(
                candidate_product_name,
                candidate_manufacturer,
                candidate_product,
            );

            if device_info_fallback_name.is_none() {
                device_info_fallback_name = candidate_name.clone();
            }
            if device_info_fallback_serial.is_none() {
                device_info_fallback_serial = candidate_serial;
            }

            if is_creator {
                device_info_creator_name = candidate_name;
                device_info_creator_serial = candidate_serial;
            }

            raw_device_info_records.push(raw_device_info);
        } else if rec.kind() == MesgNum::FileId {
            for field in rec.fields() {
                match field.name() {
                    "type" => {
                        let value = value_string(field.value());
                        let trimmed = value.trim();
                        if !trimmed.is_empty() {
                            file_id_type_name = Some(trimmed.to_string());
                        }
                        file_id_type_code = value_i64(field.value());
                    }
                    "time_created" => {
                        raw_file_id.time_created_ms = value_timestamp_ms(field.value());
                    }
                    "product_name" => {
                        let value = value_string(field.value());
                        if !value.is_empty() {
                            file_id_product_name = Some(value);
                        }
                    }
                    "manufacturer" => {
                        let value = value_string(field.value());
                        if !value.trim().is_empty() {
                            raw_file_id.manufacturer_value = Some(value.clone());
                            file_id_manufacturer = Some(value);
                        }
                    }
                    "garmin_product" | "product" | "favero_product" => {
                        let value = value_string(field.value());
                        if !value.trim().is_empty() {
                            raw_file_id.product_field = Some(field.name().to_string());
                            raw_file_id.product_value = Some(value.clone());
                            file_id_product = Some(value);
                        }
                    }
                    "serial_number" => {
                        file_id_serial_number = value_i64(field.value()).filter(|v| *v > 0);
                        raw_file_id.serial_number = file_id_serial_number;
                    }
                    _ => {}
                }
            }
        } else if rec.kind() == MesgNum::Workout {
            for field in rec.fields() {
                if field.name() == "wkt_name" && source_title.is_none() {
                    source_title = clean_string(value_string(field.value()));
                }
                match field.name() {
                    "wkt_name" | "wkt_description" | "num_valid_steps" | "sport"
                    | "sub_sport" | "capabilities" => {
                        insert_fit_json_field(&mut workout_metadata, field.name(), field.value());
                    }
                    _ => {}
                }
            }
        } else if rec.kind() == MesgNum::TrainingFile {
            for field in rec.fields() {
                match field.name() {
                    "type" | "manufacturer" | "garmin_product" | "product" => {
                        insert_fit_json_field(
                            &mut training_file_metadata,
                            field.name(),
                            field.value(),
                        );
                    }
                    _ => {}
                }
            }
        } else if rec.kind() == MesgNum::WorkoutStep {
            let mut step = serde_json::Map::new();
            for field in rec.fields() {
                match field.name() {
                    "message_index" | "wkt_step_name" | "duration_type" | "duration_value"
                    | "target_type" | "target_value" | "custom_target_value_low"
                    | "custom_target_value_high" | "intensity" | "notes" | "repeat_steps"
                    | "duration_step" | "equipment" | "exercise_category" | "exercise_name"
                    | "weight" | "secondary_target_type" | "secondary_target_value"
                    | "secondary_custom_target_value_low"
                    | "secondary_custom_target_value_high" => {
                        insert_fit_json_field(&mut step, field.name(), field.value());
                    }
                    _ => {}
                }
            }
            if !step.is_empty() {
                workout_steps.push(serde_json::Value::Object(step));
            }
        } else if rec.kind() == MesgNum::Value(79) {
            let mut raw_field_0: Option<f64> = None;
            let mut raw_field_19: Option<f64> = None;
            for field in rec.fields() {
                match field.name() {
                    "unknown_field_0" => raw_field_0 = value_f64(field.value()),
                    "unknown_field_19" => raw_field_19 = value_f64(field.value()),
                    _ => {}
                }
            }

            let starting_value = raw_field_19
                .map(|raw| (raw * 3.5 / 65536.0, raw, "garmin_message_79_field_19"))
                .or_else(|| {
                    raw_field_0.map(|raw| {
                        (raw * 3.5 / 1024.0, raw, "garmin_message_79_field_0")
                    })
                });
            if let Some((value, raw_value, source)) = starting_value {
                if valid_vo2_max(value) {
                    starting_vo2_values.push(StartingVo2Value {
                        value_ml_kg_min: value,
                        raw_value,
                        source: source.to_string(),
                        message_index,
                    });
                }
            }
        } else if rec.kind() == MesgNum::Value(140) {
            let mut raw_vo2_max: Option<f64> = None;
            let mut activity_sport_code: Option<i64> = None;
            for field in rec.fields() {
                match field.name() {
                    "unknown_field_7" => raw_vo2_max = value_f64(field.value()),
                    "unknown_field_11" => activity_sport_code = value_i64(field.value()),
                    _ => {}
                }
            }

            pending_vo2_estimate_index = None;
            if let Some(raw_value) = raw_vo2_max {
                let value = raw_value * 3.5 / 65536.0;
                if valid_vo2_max(value) {
                    let category = vo2_category_from_sport_code(activity_sport_code);
                    let activity_sport = match category.as_str() {
                        "running" | "cycling" => Some(category.clone()),
                        _ => None,
                    };
                    vo2_max = Some(value);
                    vo2_max_estimates.push(Vo2MaxEstimateMetadata {
                        value_ml_kg_min: value,
                        phase: "after_activity".to_string(),
                        category,
                        activity_sport_code,
                        activity_sport,
                        sub_sport: None,
                        session_index: None,
                        source: "garmin_message_140_field_7".to_string(),
                        raw_value: Some(raw_value),
                        message_index,
                    });
                    pending_vo2_estimate_index = Some(vo2_max_estimates.len() - 1);
                }
            }
        } else if rec.kind() == MesgNum::MaxMetData {
            let mut value_ml_kg_min: Option<f64> = None;
            let mut activity_sport: Option<String> = None;
            let mut estimate_sub_sport: Option<String> = None;
            let mut max_met_category: Option<String> = None;
            for field in rec.fields() {
                match field.name() {
                    "vo2_max" => value_ml_kg_min = value_f64(field.value()),
                    "sport" => {
                        activity_sport = Some(value_string(field.value()).to_lowercase())
                    }
                    "sub_sport" => {
                        estimate_sub_sport = Some(value_string(field.value()).to_lowercase())
                    }
                    "max_met_category" => {
                        max_met_category = Some(value_string(field.value()).to_lowercase())
                    }
                    _ => {}
                }
            }

            if let Some(value) = value_ml_kg_min.filter(|value| valid_vo2_max(*value)) {
                let category = if max_met_category.as_deref() == Some("cycling")
                    || activity_sport.as_deref() == Some("cycling")
                {
                    "cycling".to_string()
                } else if activity_sport.as_deref() == Some("running") {
                    "running".to_string()
                } else if max_met_category.as_deref() == Some("generic") {
                    "generic".to_string()
                } else {
                    "unknown".to_string()
                };
                if vo2_max.is_none() {
                    vo2_max = Some(value);
                }
                vo2_max_estimates.push(Vo2MaxEstimateMetadata {
                    value_ml_kg_min: value,
                    phase: "profile".to_string(),
                    activity_sport_code: sport_code_for_vo2_category(&category),
                    activity_sport,
                    sub_sport: estimate_sub_sport,
                    session_index: None,
                    category,
                    source: "fit_max_met_data_229".to_string(),
                    raw_value: None,
                    message_index,
                });
            }
        } else if rec.kind() == MesgNum::Activity {
            for field in rec.fields() {
                if field.name() == "total_timer_time" {
                    activity_total_timer_time_s = value_f64(field.value());
                }
            }
        } else if rec.kind() == MesgNum::Event {
            let mut timestamp_ms: Option<i64> = None;
            let mut event: Option<String> = None;
            let mut event_type: Option<String> = None;
            let mut timer_trigger: Option<String> = None;

            for field in rec.fields() {
                match field.name() {
                    "timestamp" => timestamp_ms = value_timestamp_ms(field.value()),
                    "event" => event = fit_event_name(field.value()),
                    "event_type" => event_type = fit_event_type_name(field.value()),
                    "timer_trigger" => timer_trigger = fit_timer_trigger_name(field.value()),
                    _ => {}
                }
            }

            if event.as_deref() == Some("timer") {
                if let (Some(timestamp_ms), Some(event_type)) = (timestamp_ms, event_type) {
                    timer_events.push(TimerEvent {
                        timestamp_ms,
                        event: "timer".to_string(),
                        event_type,
                        timer_trigger,
                    });
                }
            }
            if matches!(
                event.as_deref(),
                Some("rider_position_change" | "front_gear_change" | "rear_gear_change" | "gear_change")
            ) {
                push_decoded_fit_message(&mut fit_event_messages, &rec);
            }
        } else if rec.kind() == MesgNum::TimeInZone {
            push_decoded_fit_message(&mut fit_time_in_zone_messages, &rec);
            let reference = rec
                .fields()
                .iter()
                .find(|field| field.name() == "reference_mesg")
                .and_then(|field| normalized_fit_label(field.value()));
            let reference_priority = time_in_zone_reference_priority(reference.as_deref());
            let can_replace_hr_zone_time = reference_priority > zones.hr_time_in_zone_priority;
            let can_replace_power_zone_time = reference_priority > zones.power_time_in_zone_priority;
            let can_replace_zone_metadata = reference_priority > 0
                && reference_priority >= zones.time_in_zone_metadata_priority;

            for field in rec.fields() {
                match field.name() {
                    "time_in_hr_zone" => {
                        let values = clean_duration_values(value_f64_vec(field.value()));
                        if can_replace_hr_zone_time && has_positive_duration(&values) {
                            zones.time_in_hr_zone_s = values;
                            zones.hr_time_in_zone_priority = reference_priority;
                        }
                    },
                    "time_in_power_zone" => {
                        let values = clean_duration_values(value_f64_vec(field.value()));
                        if can_replace_power_zone_time && has_positive_duration(&values) {
                            zones.time_in_power_zone_s = values;
                            zones.power_time_in_zone_priority = reference_priority;
                        }
                    },
                    "hr_zone_high_boundary" => {
                        if can_replace_zone_metadata {
                            replace_vec_if_useful(
                                &mut zones.hr_zone_high_boundary,
                                clean_i64_bounds(value_i64_vec(field.value()), 40, 260),
                            );
                        }
                    },
                    "power_zone_high_boundary" => {
                        if can_replace_zone_metadata {
                            replace_vec_if_useful(
                                &mut zones.power_zone_high_boundary,
                                clean_i64_bounds(value_i64_vec(field.value()), 1, 5000),
                            );
                        }
                    },
                    "hr_calc_type" => {
                        if can_replace_zone_metadata {
                            set_string_if_present(&mut zones.hr_calc_type, field.value());
                        }
                    },
                    "pwr_calc_type" => {
                        if can_replace_zone_metadata {
                            set_string_if_present(&mut zones.pwr_calc_type, field.value());
                        }
                    },
                    "max_heart_rate" => {
                        if can_replace_zone_metadata {
                            zones.max_heart_rate = value_i64_in_range(field.value(), 40, 260);
                        }
                    },
                    "resting_heart_rate" => {
                        if can_replace_zone_metadata {
                            zones.resting_heart_rate = value_i64_in_range(field.value(), 20, 120);
                        }
                    },
                    "threshold_heart_rate" => {
                        if can_replace_zone_metadata {
                            zones.threshold_heart_rate = value_i64_in_range(field.value(), 40, 260);
                        }
                    },
                    "functional_threshold_power" => {
                        if can_replace_zone_metadata {
                            zones.functional_threshold_power = value_i64_in_range(field.value(), 50, 2000);
                        }
                    },
                    _ => {}
                }
            }
            if can_replace_zone_metadata {
                zones.time_in_zone_metadata_priority = reference_priority;
            }
        } else if rec.kind() == MesgNum::ZonesTarget {
            for field in rec.fields() {
                match field.name() {
                    "hr_calc_type" => {
                        if zones.hr_calc_type.is_none() {
                            set_string_if_present(&mut zones.hr_calc_type, field.value());
                        }
                    }
                    "pwr_calc_type" => {
                        if zones.pwr_calc_type.is_none() {
                            set_string_if_present(&mut zones.pwr_calc_type, field.value());
                        }
                    }
                    "max_heart_rate" => {
                        if zones.max_heart_rate.is_none() {
                            zones.max_heart_rate = value_i64_in_range(field.value(), 40, 260);
                        }
                    }
                    "resting_heart_rate" => {
                        if zones.resting_heart_rate.is_none() {
                            zones.resting_heart_rate = value_i64_in_range(field.value(), 20, 120);
                        }
                    }
                    "threshold_heart_rate" => {
                        if zones.threshold_heart_rate.is_none() {
                            zones.threshold_heart_rate = value_i64_in_range(field.value(), 40, 260);
                        }
                    }
                    "functional_threshold_power" => {
                        if zones.functional_threshold_power.is_none() {
                            zones.functional_threshold_power = value_i64_in_range(field.value(), 50, 2000);
                        }
                    }
                    _ => {}
                }
            }
        } else if rec.kind() == MesgNum::Split {
            push_decoded_fit_message(&mut fit_split_messages, &rec);
        } else if rec.kind() == MesgNum::SplitSummary {
            push_decoded_fit_message(&mut fit_split_summary_messages, &rec);
        } else if rec.kind() == MesgNum::ClimbPro {
            push_decoded_fit_message(&mut fit_climb_pro_messages, &rec);
        } else if rec.kind() == MesgNum::UserProfile {
            for field in rec.fields() {
                match field.name() {
                    "friendly_name" | "gender" | "language" | "elev_setting" | "weight_setting"
                    | "hr_setting" | "speed_setting" | "dist_setting" | "power_setting"
                    | "position_setting" | "temperature_setting" | "height_setting" | "depth_setting" => {
                        if let Value::String(value) = field.value() {
                            let trimmed = value.trim();
                            if !trimmed.is_empty() {
                                user_profile.insert(field.name().to_string(), serde_json::Value::String(trimmed.to_string()));
                            }
                        }
                    }
                    "age" | "activity_class" | "default_max_running_heart_rate"
                    | "default_max_biking_heart_rate" | "default_max_heart_rate"
                    | "wake_time" | "sleep_time" => {
                        if let Some(value) = value_i64(field.value()) {
                            user_profile.insert(field.name().to_string(), serde_json::json!(value));
                        }
                    }
                    "height" => {
                        if let Some(value) = value_f64(field.value()).filter(|value| *value > 0.0 && *value < 3.0) {
                            user_profile.insert("height_m".to_string(), serde_json::json!(value));
                        }
                    }
                    "weight" => {
                        if let Some(value) = value_f64(field.value()).filter(|value| *value > 0.0 && *value < 500.0) {
                            user_profile.insert("weight_kg".to_string(), serde_json::json!(value));
                        }
                    }
                    "resting_heart_rate" => {
                        if zones.resting_heart_rate.is_none() {
                            zones.resting_heart_rate = value_i64_in_range(field.value(), 20, 120);
                        }
                        if let Some(value) = value_i64_in_range(field.value(), 20, 120) {
                            user_profile.insert("resting_heart_rate".to_string(), serde_json::json!(value));
                        }
                    }
                    "user_running_step_length" | "user_walking_step_length" => {
                        if let Some(value) = value_f64(field.value()).filter(|value| *value > 0.0 && *value < 5.0) {
                            user_profile.insert(format!("{}_m", field.name()), serde_json::json!(value));
                        }
                    }
                    _ => {}
                }
            }
        } else if rec.kind() == MesgNum::Lap {
            push_decoded_fit_message(&mut fit_lap_messages, &rec);
            let mut lap_start_ms: Option<i64> = None;
            let mut lap_end_ms: Option<i64> = None;
            let mut lap_total_elapsed_time_s: Option<f64> = None;
            let mut lap_total_timer_time_s: Option<f64> = None;
            let mut lap_total_distance_m: Option<f64> = None;
            let mut lap_avg_speed_m_s: Option<f64> = None;
            let mut lap_max_speed_m_s: Option<f64> = None;
            let mut lap_avg_heart_rate: Option<i64> = None;
            let mut lap_max_heart_rate: Option<i64> = None;
            let mut lap_total_ascent_m: Option<f64> = None;
            let mut lap_total_descent_m: Option<f64> = None;
            let mut lap_avg_cadence: Option<i64> = None;
            let mut lap_max_cadence: Option<i64> = None;
            let mut lap_total_calories: Option<i64> = None;
            let mut lap_best_speed_m_s: Option<f64> = None;
            let mut lap_normalized_power: Option<i64> = None;
            let mut lap_avg_power: Option<i64> = None;
            let mut lap_max_power: Option<i64> = None;
            let mut lap_training_stress_score: Option<f64> = None;
            let mut lap_intensity_factor: Option<f64> = None;
            let mut lap_threshold_power: Option<i64> = None;
            let mut lap_left_right_balance: Option<serde_json::Value> = None;
            let mut lap_total_work_j: Option<i64> = None;
            let mut lap_avg_temperature_c: Option<i64> = None;
            let mut lap_min_temperature_c: Option<i64> = None;
            let mut lap_max_temperature_c: Option<i64> = None;
            let mut lap_total_training_effect: Option<f64> = None;
            let mut lap_total_anaerobic_training_effect: Option<f64> = None;
            let mut lap_training_load_peak: Option<f64> = None;
            let mut lap_workout_feel: Option<i64> = None;
            let mut lap_workout_rpe: Option<i64> = None;
            let mut lap_time_standing_s: Option<f64> = None;
            let mut lap_stand_count: Option<i64> = None;
            let mut lap_total_grit: Option<f64> = None;
            let mut lap_avg_flow: Option<f64> = None;
            let mut lap_jump_count: Option<i64> = None;
            let mut lap_wkt_step_index: Option<i64> = None;
            let mut lap_trigger: Option<String> = None;
            let mut lap_intensity: Option<String> = None;
            for field in rec.fields() {
                match field.name() {
                    "start_time" => lap_start_ms = value_timestamp_ms(field.value()),
                    "timestamp" => lap_end_ms = value_timestamp_ms(field.value()),
                    "total_elapsed_time" => lap_total_elapsed_time_s = value_f64(field.value()),
                    "total_timer_time" => lap_total_timer_time_s = value_f64(field.value()),
                    "total_distance" => lap_total_distance_m = value_f64(field.value()),
                    "enhanced_avg_speed" => lap_avg_speed_m_s = value_f64(field.value()),
                    "avg_speed" => {
                        if lap_avg_speed_m_s.is_none() {
                            lap_avg_speed_m_s = value_f64(field.value());
                        }
                    }
                    "enhanced_max_speed" => lap_max_speed_m_s = value_f64(field.value()),
                    "max_speed" => {
                        if lap_max_speed_m_s.is_none() {
                            lap_max_speed_m_s = value_f64(field.value());
                        }
                    }
                    "enhanced_best_speed" => lap_best_speed_m_s = value_f64(field.value()),
                    "best_speed" => {
                        if lap_best_speed_m_s.is_none() {
                            lap_best_speed_m_s = value_f64(field.value());
                        }
                    }
                    "avg_heart_rate" => lap_avg_heart_rate = value_i64(field.value()),
                    "max_heart_rate" => lap_max_heart_rate = value_i64(field.value()),
                    "total_ascent" => lap_total_ascent_m = value_f64(field.value()),
                    "total_descent" => lap_total_descent_m = value_f64(field.value()),
                    "avg_cadence" => lap_avg_cadence = value_i64(field.value()),
                    "max_cadence" => lap_max_cadence = value_i64(field.value()),
                    "total_calories" => lap_total_calories = value_i64(field.value()),
                    "normalized_power" => lap_normalized_power = value_i64(field.value()),
                    "avg_power" => lap_avg_power = value_i64(field.value()),
                    "max_power" => lap_max_power = value_i64(field.value()),
                    "training_stress_score" => lap_training_stress_score = value_f64(field.value()),
                    "intensity_factor" => lap_intensity_factor = value_f64(field.value()),
                    "threshold_power" => lap_threshold_power = value_i64(field.value()),
                    "left_right_balance" => lap_left_right_balance = decoded_left_right_balance(field.value()),
                    "total_work" => lap_total_work_j = value_i64(field.value()),
                    "avg_temperature" => lap_avg_temperature_c = value_i64(field.value()),
                    "min_temperature" => lap_min_temperature_c = value_i64(field.value()),
                    "max_temperature" => lap_max_temperature_c = value_i64(field.value()),
                    "total_training_effect" => lap_total_training_effect = value_f64(field.value()),
                    "total_anaerobic_training_effect" => lap_total_anaerobic_training_effect = value_f64(field.value()),
                    "training_load_peak" => lap_training_load_peak = value_f64(field.value()),
                    "workout_feel" => lap_workout_feel = value_i64(field.value()),
                    "workout_rpe" => lap_workout_rpe = value_i64(field.value()),
                    "time_standing" => lap_time_standing_s = value_f64(field.value()),
                    "stand_count" => lap_stand_count = value_i64(field.value()),
                    "total_grit" => lap_total_grit = value_f64(field.value()),
                    "avg_flow" => lap_avg_flow = value_f64(field.value()),
                    "jump_count" => lap_jump_count = value_i64(field.value()),
                    "wkt_step_index" => lap_wkt_step_index = value_i64(field.value()),
                    "lap_trigger" => {
                        let value = value_string(field.value());
                        if !value.trim().is_empty() {
                            lap_trigger = Some(value.trim().to_string());
                        }
                    }
                    "intensity" => {
                        let value = value_string(field.value());
                        if !value.trim().is_empty() {
                            lap_intensity = Some(value.trim().to_string());
                        }
                    }
                    _ => {}
                }
            }

            if let Some(duration) = valid_duration_s(lap_total_timer_time_s) {
                lap_total_timer_time_sum_s = Some(lap_total_timer_time_sum_s.unwrap_or(0.0) + duration);
            }

            lap_ranges.push(serde_json::json!({
                "start_ts_utc": lap_start_ms
                    .and_then(chrono::DateTime::from_timestamp_millis)
                    .map(|dt| dt.to_rfc3339()),
                "end_ts_utc": lap_end_ms
                    .and_then(chrono::DateTime::from_timestamp_millis)
                    .map(|dt| dt.to_rfc3339()),
                "total_elapsed_time_s": lap_total_elapsed_time_s,
                "total_timer_time_s": lap_total_timer_time_s,
                "total_distance_m": lap_total_distance_m,
                "avg_speed_m_s": lap_avg_speed_m_s,
                "max_speed_m_s": lap_max_speed_m_s,
                "avg_heart_rate": lap_avg_heart_rate,
                "max_heart_rate": lap_max_heart_rate,
                "total_ascent_m": lap_total_ascent_m,
                "total_descent_m": lap_total_descent_m,
                "avg_cadence": lap_avg_cadence,
                "max_cadence": lap_max_cadence,
                "total_calories": lap_total_calories,
                "best_speed_m_s": lap_best_speed_m_s,
                "normalized_power": lap_normalized_power,
                "avg_power": lap_avg_power,
                "max_power": lap_max_power,
                "training_stress_score": lap_training_stress_score,
                "intensity_factor": lap_intensity_factor,
                "threshold_power": lap_threshold_power,
                "left_right_balance": lap_left_right_balance,
                "total_work_j": lap_total_work_j,
                "avg_temperature_c": lap_avg_temperature_c,
                "min_temperature_c": lap_min_temperature_c,
                "max_temperature_c": lap_max_temperature_c,
                "total_training_effect": lap_total_training_effect,
                "total_anaerobic_training_effect": lap_total_anaerobic_training_effect,
                "training_load_peak": lap_training_load_peak,
                "workout_feel": lap_workout_feel,
                "workout_rpe": lap_workout_rpe,
                "time_standing_s": lap_time_standing_s,
                "stand_count": lap_stand_count,
                "total_grit": lap_total_grit,
                "avg_flow": lap_avg_flow,
                "jump_count": lap_jump_count,
                "wkt_step_index": lap_wkt_step_index,
                "lap_trigger": lap_trigger,
                "intensity": lap_intensity
            }));
        }

    }

    append_starting_vo2_estimates(
        &starting_vo2_values,
        &vo2_sessions,
        &mut vo2_max_estimates,
    );
    vo2_max_estimates.sort_by_key(|estimate| estimate.message_index);

    let heart_rate_zone_bounds_bpm = zones.hr_zone_high_boundary.clone();
    let zones_json = build_zones_json(&zones);
    workout_steps.sort_by_key(|step| {
        step.get("message_index")
            .and_then(|value| value.as_i64())
            .unwrap_or(i64::MAX)
    });

    if file_id_type_name.is_some() || file_id_type_code.is_some() {
        let type_name = file_id_type_name
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .to_lowercase();
        let is_activity_name = type_name == "activity";
        let is_activity_code = file_id_type_code == Some(4) || type_name == "4";
        if !(is_activity_name || is_activity_code) {
            let type_desc = file_id_type_name
                .clone()
                .unwrap_or_else(|| file_id_type_code.map(|v| v.to_string()).unwrap_or_else(|| "unknown".to_string()));
            return Err(anyhow!(
                "{NON_ACTIVITY_FIT_MARKER} file_id.type={type_desc}"
            ));
        }
    }

    let record_start_ts = min_ts.ok_or_else(|| anyhow!("FIT file had no timestamped records"))?;
    let record_end_ts = max_ts.unwrap_or(record_start_ts);

    derive_distance_if_missing(&mut points);
    derive_speed_if_missing(&mut points);

    let record_span_duration_s = ((record_end_ts - record_start_ts).max(0) as f64) / 1000.0;
    let (duration_s, duration_source) = select_fit_duration_s(
        session_total_timer_time_sum_s,
        activity_total_timer_time_s,
        lap_total_timer_time_sum_s,
        session_total_elapsed_time_sum_s,
        record_span_duration_s,
    );
    let (start_ts, end_ts) = select_fit_time_range_ms(
        record_start_ts,
        record_end_ts,
        session_start_ts,
        session_end_ts,
        duration_s,
    );
    let distance_m = total_distance_m(&points);
    let (start_latitude, start_longitude) = first_valid_coordinates(&points);
    let record_timestamps = points
        .iter()
        .map(|point| point.timestamp_ms)
        .collect::<Vec<_>>();
    let timer_metadata = build_timer_metadata(
        &timer_events,
        &record_timestamps,
        record_start_ts,
        record_end_ts,
        session_total_elapsed_time_sum_s,
        duration_s,
    );

    let file_id_combined_name = combine_device_name(
        file_id_product_name.clone(),
        file_id_manufacturer,
        file_id_product,
    );

    let decoded_file_id_metadata = decoded_file_id(&raw_file_id);
    let decoded_file_id_name = decoded_file_id_display_name(&decoded_file_id_metadata);

    if device.is_empty() {
        device = device_info_creator_name
            .clone()
            .or(decoded_file_id_name)
            .or(file_id_combined_name.clone())
            .or(device_info_fallback_name.clone())
            .unwrap_or_default();
    }

    let resolved_serial_number = file_id_serial_number
        .or(device_info_creator_serial)
        .or(device_info_fallback_serial);
    sport = canonical_fit_sport(&sport, sport_profile_name.as_deref());
    let location = derive_activity_location(&points);
    let generated_title = build_generated_title(file_name, &sport, sub_sport.as_deref(), &location);
    let activity_name = source_title.clone().unwrap_or_else(|| generated_title.clone());
    let device_entries = build_devices(&raw_device_info_records);
    let workout_json = if workout_metadata.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::Value::Object(workout_metadata)
    };
    let training_file_json = if training_file_metadata.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::Value::Object(training_file_metadata)
    };

    let mut fit_messages = serde_json::Map::new();
    if let Some(value) = fit_message_collection(fit_session_messages) {
        fit_messages.insert("sessions".to_string(), value);
    }
    if let Some(value) = fit_message_collection(fit_lap_messages) {
        fit_messages.insert("laps".to_string(), value);
    }
    if let Some(value) = fit_message_collection(fit_time_in_zone_messages) {
        fit_messages.insert("time_in_zone".to_string(), value);
    }
    if let Some(value) = fit_message_collection(fit_split_messages) {
        fit_messages.insert("splits".to_string(), value);
    }
    if let Some(value) = fit_message_collection(fit_split_summary_messages) {
        fit_messages.insert("split_summaries".to_string(), value);
    }
    if let Some(value) = fit_message_collection(fit_climb_pro_messages) {
        fit_messages.insert("climb_pro".to_string(), value);
    }
    if let Some(value) = fit_message_collection(fit_event_messages) {
        fit_messages.insert("events".to_string(), value);
    }

    let session_json = serde_json::json!({
        "count": session_count,
        "raw_sport_code": session_sport_raw_code,
        "start_ts_utc": session_start_ts
            .and_then(chrono::DateTime::from_timestamp_millis)
            .map(|dt| dt.to_rfc3339()),
        "end_ts_utc": session_end_ts
            .and_then(chrono::DateTime::from_timestamp_millis)
            .map(|dt| dt.to_rfc3339()),
        "beginning_body_battery": session_beginning_body_battery,
        "ending_body_battery": session_ending_body_battery,
        "max_heart_rate": session_max_heart_rate,
        "avg_heart_rate": session_avg_heart_rate,
        "max_cadence": session_max_cadence,
        "avg_cadence": session_avg_cadence,
        "total_elapsed_time_s": session_total_elapsed_time_sum_s,
        "total_timer_time_s": session_total_timer_time_sum_s,
        "total_distance_m": session_total_distance_m,
        "total_calories": session_total_calories,
        "normalized_power": session_normalized_power,
        "avg_power": session_avg_power,
        "max_power": session_max_power,
        "total_ascent_m": session_total_ascent_m,
        "total_descent_m": session_total_descent_m,
        "training_stress_score": session_training_stress_score,
        "intensity_factor": session_intensity_factor,
        "threshold_power": session_threshold_power,
        "left_right_balance": session_left_right_balance,
        "total_work_j": session_total_work_j,
        "avg_temperature_c": session_avg_temperature_c,
        "min_temperature_c": session_min_temperature_c,
        "max_temperature_c": session_max_temperature_c,
        "total_training_effect": session_total_training_effect,
        "total_anaerobic_training_effect": session_total_anaerobic_training_effect,
        "training_load_peak": session_training_load_peak,
        "workout_feel": session_workout_feel,
        "workout_rpe": session_workout_rpe,
        "time_standing_s": session_time_standing_s,
        "stand_count": session_stand_count,
        "total_grit": session_total_grit,
        "avg_flow": session_avg_flow,
        "jump_count": session_jump_count
    });

    let metadata_json = serde_json::json!({
        "record_count": points.len(),
        "device": device,
        "sport": sport,
        "sub_sport": sub_sport.as_deref(),
        "raw_sport_code": session_sport_raw_code,
        "sport_profile_name": sport_profile_name,
        "duration_source": duration_source,
        "record_span_duration_s": record_span_duration_s,
        "record_start_ts_utc": chrono::DateTime::from_timestamp_millis(record_start_ts)
            .map(|dt| dt.to_rfc3339()),
        "record_end_ts_utc": chrono::DateTime::from_timestamp_millis(record_end_ts)
            .map(|dt| dt.to_rfc3339()),
        "source_format": "fit",
        "title": {
            "source_title": source_title.clone(),
            "generated_title": generated_title.clone()
        },
        "location": {
            "city": location.city.clone(),
            "region": location.region.clone(),
            "country": location.country.clone(),
            "label": location.label.clone()
        },
        "file_id": {
            "product_name": file_id_combined_name,
            "serial_number": resolved_serial_number
        },
        "device_info": {
            "schema_version": 1,
            "source_support": "full",
            "creator_product_name": device_info_creator_name,
            "creator_serial_number": device_info_creator_serial,
            "fallback_product_name": device_info_fallback_name,
            "fallback_serial_number": device_info_fallback_serial,
            "decoded_file_id": decoded_file_id_metadata,
            "devices": device_entries,
            "raw_device_info_record_count": raw_device_info_records.len()
        },
        "activity_metrics": {
            "vo2_max": vo2_max
        },
        "vo2_max": {
            "schema_version": 1,
            "estimates": vo2_max_estimates
        },
        "user_profile": serde_json::Value::Object(user_profile),
        "activity": {
            "total_timer_time_s": activity_total_timer_time_s
        },
        "timer": timer_metadata,
        "heart_rate_zone_bounds_bpm": heart_rate_zone_bounds_bpm,
        "zones": zones_json,
        "fit_messages": serde_json::Value::Object(fit_messages),
        "workout": workout_json,
        "workout_steps": workout_steps,
        "training_file": training_file_json,
        "session": session_json,
        "laps": lap_ranges
    })
    .to_string();

    Ok(ParsedActivity {
        file_name: file_name.to_string(),
        source_format: "fit".to_string(),
        activity_name,
        source_title,
        generated_title: Some(generated_title),
        sport,
        sub_sport: sub_sport.unwrap_or_default(),
        device,
        location_city: location.city,
        location_region: location.region,
        location_country: location.country,
        location_label: location.label,
        start_ts_utc: chrono::DateTime::from_timestamp_millis(start_ts)
            .ok_or_else(|| anyhow!("invalid start timestamp"))?
            .to_rfc3339(),
        end_ts_utc: chrono::DateTime::from_timestamp_millis(end_ts)
            .ok_or_else(|| anyhow!("invalid end timestamp"))?
            .to_rfc3339(),
        duration_s,
        distance_m,
        start_latitude,
        start_longitude,
        file_hash,
        records: points,
        metadata_json,
    })
}

fn parse_tcx_bytes(file_name: &str, bytes: &[u8]) -> Result<ParsedActivity> {
    let file_hash = file_hash_hex(bytes);
    let xml = std::str::from_utf8(bytes).context("TCX is not valid UTF-8")?;
    let doc = roxmltree::Document::parse(xml).context("failed to parse TCX XML")?;

    let activity_node = doc
        .descendants()
        .find(|n| n.is_element() && n.tag_name().name() == "Activity")
        .ok_or_else(|| anyhow!("TCX missing Activity node"))?;

    let sport = activity_node
        .attribute("Sport")
        .unwrap_or("unknown")
        .to_lowercase();

    let mut device = String::new();
    if let Some(creator) = activity_node
        .descendants()
        .find(|n| n.is_element() && n.tag_name().name() == "Creator")
    {
        device = child_text(creator, "Name")
            .or_else(|| child_text(creator, "ProductID"))
            .unwrap_or_default();
    }

    let mut points = Vec::new();
    let mut min_ts: Option<i64> = None;
    let mut max_ts: Option<i64> = None;
    let mut lap_distance_m = 0.0;

    for lap in activity_node
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "Lap")
    {
        if let Some(distance_m) = child_f64(lap, "DistanceMeters")
            .filter(|d| d.is_finite() && *d > 0.0)
        {
            lap_distance_m += distance_m;
        }
    }

    for tp in activity_node
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "Trackpoint")
    {
        let ts = child_text(tp, "Time")
            .as_deref()
            .and_then(parse_timestamp_ms);
        let Some(timestamp_ms) = ts else {
            continue;
        };

        let position = child_node(tp, "Position");
        let latitude = position.and_then(|p| child_f64(p, "LatitudeDegrees"));
        let longitude = position.and_then(|p| child_f64(p, "LongitudeDegrees"));

        let mut speed_m_s = None;
        let mut power = None;
        let mut cadence = child_i64(tp, "Cadence");
        let mut temperature_c = None;

        if let Some(ext) = child_node(tp, "Extensions") {
            for n in ext.descendants().filter(|x| x.is_element()) {
                let name = n.tag_name().name().to_lowercase();
                let val = n.text().map(str::trim).unwrap_or("");
                if val.is_empty() {
                    continue;
                }
                match name.as_str() {
                    "speed" => {
                        if speed_m_s.is_none() {
                            speed_m_s = val.parse::<f64>().ok();
                        }
                    }
                    "watts" | "power" => {
                        if power.is_none() {
                            power = val.parse::<i64>().ok();
                        }
                    }
                    "run_cadence" | "cadence" => {
                        if cadence.is_none() {
                            cadence = val.parse::<i64>().ok();
                        }
                    }
                    "temperature" => {
                        if temperature_c.is_none() {
                            temperature_c = val.parse::<f64>().ok();
                        }
                    }
                    _ => {}
                }
            }
        }

        min_ts = Some(min_ts.map_or(timestamp_ms, |m| m.min(timestamp_ms)));
        max_ts = Some(max_ts.map_or(timestamp_ms, |m| m.max(timestamp_ms)));
        points.push(RecordPoint {
            timestamp_ms,
            latitude,
            longitude,
            altitude_m: child_f64(tp, "AltitudeMeters"),
            distance_m: child_f64(tp, "DistanceMeters"),
            speed_m_s,
            cadence,
            heart_rate: child_node(tp, "HeartRateBpm").and_then(|hr| child_i64(hr, "Value")),
            power,
            temperature_c,
            respiration_rate_brpm: None,
            current_stamina_pct: None,
            potential_stamina_pct: None,
            performance_condition: None,
        });
    }

    let start_ts = min_ts.ok_or_else(|| anyhow!("TCX file had no timestamped trackpoints"))?;
    let end_ts = max_ts.unwrap_or(start_ts);

    normalize_record_distances_to_zero(&mut points);
    derive_distance_if_missing(&mut points);
    derive_speed_if_missing(&mut points);

    let duration_s = ((end_ts - start_ts).max(0) as f64) / 1000.0;
    let distance_m = if lap_distance_m > 0.0 {
        lap_distance_m
    } else {
        total_distance_m(&points)
    };
    let (start_latitude, start_longitude) = first_valid_coordinates(&points);
    let sub_sport = String::new();
    let source_title: Option<String> = None;
    let location = derive_activity_location(&points);
    let generated_title = build_generated_title(file_name, &sport, None, &location);
    let activity_name = generated_title.clone();

    let metadata_json = serde_json::json!({
        "record_count": points.len(),
        "device": device,
        "sport": sport,
        "sub_sport": sub_sport.clone(),
        "source_format": "tcx",
        "title": {
            "source_title": source_title.clone(),
            "generated_title": generated_title.clone()
        },
        "location": {
            "city": location.city.clone(),
            "region": location.region.clone(),
            "country": location.country.clone(),
            "label": location.label.clone()
        }
    })
    .to_string();

    Ok(ParsedActivity {
        file_name: file_name.to_string(),
        source_format: "tcx".to_string(),
        activity_name,
        source_title,
        generated_title: Some(generated_title),
        sport,
        sub_sport,
        device,
        location_city: location.city,
        location_region: location.region,
        location_country: location.country,
        location_label: location.label,
        start_ts_utc: chrono::DateTime::from_timestamp_millis(start_ts)
            .ok_or_else(|| anyhow!("invalid start timestamp"))?
            .to_rfc3339(),
        end_ts_utc: chrono::DateTime::from_timestamp_millis(end_ts)
            .ok_or_else(|| anyhow!("invalid end timestamp"))?
            .to_rfc3339(),
        duration_s,
        distance_m,
        start_latitude,
        start_longitude,
        file_hash,
        records: points,
        metadata_json,
    })
}

fn parse_gpx_bytes(file_name: &str, bytes: &[u8]) -> Result<ParsedActivity> {
    let file_hash = file_hash_hex(bytes);
    let xml = std::str::from_utf8(bytes).context("GPX is not valid UTF-8")?;
    let doc = roxmltree::Document::parse(xml).context("failed to parse GPX XML")?;

    let root = doc.root_element();
    if root.tag_name().name() != "gpx" {
        return Err(anyhow!("not a GPX file"));
    }

    let sport = doc
        .descendants()
        .find(|n| n.is_element() && n.tag_name().name() == "type")
        .and_then(|n| n.text())
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string());

    let device = root
        .attribute("creator")
        .map(|s| s.to_string())
        .unwrap_or_default();

    let mut points = Vec::new();
    let mut min_ts: Option<i64> = None;
    let mut max_ts: Option<i64> = None;

    for tp in doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "trkpt")
    {
        let ts = child_text(tp, "time").as_deref().and_then(parse_timestamp_ms);
        let Some(timestamp_ms) = ts else {
            continue;
        };

        let latitude = tp.attribute("lat").and_then(|v| v.parse::<f64>().ok());
        let longitude = tp.attribute("lon").and_then(|v| v.parse::<f64>().ok());

        let mut heart_rate = None;
        let mut cadence = None;
        let mut power = None;
        let mut temperature_c = None;
        let mut speed_m_s = None;
        let mut distance_m = None;

        if let Some(ext) = child_node(tp, "extensions") {
            for n in ext.descendants().filter(|x| x.is_element()) {
                let name = n.tag_name().name().to_lowercase();
                let val = n.text().map(str::trim).unwrap_or("");
                if val.is_empty() {
                    continue;
                }
                match name.as_str() {
                    "hr" => {
                        if heart_rate.is_none() {
                            heart_rate = val.parse::<i64>().ok();
                        }
                    }
                    "cad" | "cadence" => {
                        if cadence.is_none() {
                            cadence = val.parse::<i64>().ok();
                        }
                    }
                    "power" | "watts" => {
                        if power.is_none() {
                            power = val.parse::<i64>().ok();
                        }
                    }
                    "atemp" | "temp" | "temperature" => {
                        if temperature_c.is_none() {
                            temperature_c = val.parse::<f64>().ok();
                        }
                    }
                    "speed" => {
                        if speed_m_s.is_none() {
                            speed_m_s = val.parse::<f64>().ok();
                        }
                    }
                    "distance" => {
                        if distance_m.is_none() {
                            distance_m = val.parse::<f64>().ok();
                        }
                    }
                    _ => {}
                }
            }
        }

        min_ts = Some(min_ts.map_or(timestamp_ms, |m| m.min(timestamp_ms)));
        max_ts = Some(max_ts.map_or(timestamp_ms, |m| m.max(timestamp_ms)));
        points.push(RecordPoint {
            timestamp_ms,
            latitude,
            longitude,
            altitude_m: child_f64(tp, "ele"),
            distance_m,
            speed_m_s,
            cadence,
            heart_rate,
            power,
            temperature_c,
            respiration_rate_brpm: None,
            current_stamina_pct: None,
            potential_stamina_pct: None,
            performance_condition: None,
        });
    }

    let start_ts = min_ts.ok_or_else(|| anyhow!("GPX file had no timestamped trackpoints"))?;
    let end_ts = max_ts.unwrap_or(start_ts);

    derive_distance_if_missing(&mut points);
    derive_speed_if_missing(&mut points);

    let duration_s = ((end_ts - start_ts).max(0) as f64) / 1000.0;
    let distance_m = total_distance_m(&points);
    let (start_latitude, start_longitude) = first_valid_coordinates(&points);
    let sub_sport = String::new();
    let source_title: Option<String> = None;
    let location = derive_activity_location(&points);
    let generated_title = build_generated_title(file_name, &sport, None, &location);
    let activity_name = generated_title.clone();

    let metadata_json = serde_json::json!({
        "record_count": points.len(),
        "device": device,
        "sport": sport,
        "sub_sport": sub_sport.clone(),
        "source_format": "gpx",
        "title": {
            "source_title": source_title.clone(),
            "generated_title": generated_title.clone()
        },
        "location": {
            "city": location.city.clone(),
            "region": location.region.clone(),
            "country": location.country.clone(),
            "label": location.label.clone()
        }
    })
    .to_string();

    Ok(ParsedActivity {
        file_name: file_name.to_string(),
        source_format: "gpx".to_string(),
        activity_name,
        source_title,
        generated_title: Some(generated_title),
        sport,
        sub_sport,
        device,
        location_city: location.city,
        location_region: location.region,
        location_country: location.country,
        location_label: location.label,
        start_ts_utc: chrono::DateTime::from_timestamp_millis(start_ts)
            .ok_or_else(|| anyhow!("invalid start timestamp"))?
            .to_rfc3339(),
        end_ts_utc: chrono::DateTime::from_timestamp_millis(end_ts)
            .ok_or_else(|| anyhow!("invalid end timestamp"))?
            .to_rfc3339(),
        duration_s,
        distance_m,
        start_latitude,
        start_longitude,
        file_hash,
        records: points,
        metadata_json,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn starting_vo2(value: f64, message_index: usize) -> StartingVo2Value {
        StartingVo2Value {
            value_ml_kg_min: value,
            raw_value: value * 65536.0 / 3.5,
            source: "garmin_message_79_field_19".to_string(),
            message_index,
        }
    }

    #[test]
    fn maps_only_running_and_cycling_to_explicit_vo2_categories() {
        assert_eq!(vo2_category_from_sport_code(Some(1)), "running");
        assert_eq!(vo2_category_from_sport_code(Some(2)), "cycling");
        assert_eq!(vo2_category_from_sport_code(Some(11)), "generic");
        assert_eq!(vo2_category_from_sport_code(None), "unknown");
        assert_eq!(
            vo2_category_from_sport_name("Running"),
            Some("running".to_string())
        );
        assert_eq!(vo2_category_from_sport_name("mountain_biking"), None);
    }

    #[test]
    fn associates_multisport_starting_vo2_values_in_session_order() {
        let sessions = vec![
            Vo2SessionContext {
                session_index: 0,
                sport: "running".to_string(),
            },
            Vo2SessionContext {
                session_index: 1,
                sport: "transition".to_string(),
            },
            Vo2SessionContext {
                session_index: 2,
                sport: "cycling".to_string(),
            },
        ];
        let mut estimates = Vec::new();

        append_starting_vo2_estimates(
            &[starting_vo2(44.7, 20), starting_vo2(43.7, 30)],
            &sessions,
            &mut estimates,
        );

        assert_eq!(estimates.len(), 2);
        assert_eq!(estimates[0].category, "running");
        assert_eq!(estimates[0].session_index, Some(0));
        assert_eq!(estimates[1].category, "cycling");
        assert_eq!(estimates[1].session_index, Some(2));
    }

    #[test]
    fn preserves_ambiguous_starting_vo2_value_without_a_category() {
        let sessions = vec![
            Vo2SessionContext {
                session_index: 0,
                sport: "running".to_string(),
            },
            Vo2SessionContext {
                session_index: 1,
                sport: "cycling".to_string(),
            },
        ];
        let mut estimates = Vec::new();

        append_starting_vo2_estimates(&[starting_vo2(45.0, 20)], &sessions, &mut estimates);

        assert_eq!(estimates.len(), 1);
        assert_eq!(estimates[0].category, "unknown");
        assert_eq!(estimates[0].session_index, None);
    }

    fn gps_point() -> RecordPoint {
        RecordPoint {
            timestamp_ms: 0,
            latitude: Some(43.6532),
            longitude: Some(-79.3832),
            altitude_m: None,
            distance_m: None,
            speed_m_s: None,
            cadence: None,
            heart_rate: None,
            power: None,
            temperature_c: None,
            respiration_rate_brpm: None,
            current_stamina_pct: None,
            potential_stamina_pct: None,
            performance_condition: None,
        }
    }

    #[test]
    fn uses_indoor_sub_sport_for_non_gps_name() {
        let name = build_activity_name(
            "123456789_987654321.fit",
            "cycling",
            Some("indoor_cycling"),
            &[],
        );

        assert_eq!(name, "Indoor Cycling");
    }

    #[test]
    fn uses_activity_type_for_non_gps_even_with_meaningful_filename() {
        let name = build_activity_name("Lunch Ride.fit", "cycling", None, &[]);

        assert_eq!(name, "Cycling");
    }

    #[test]
    fn falls_back_to_filename_when_activity_type_is_unknown() {
        let name = build_activity_name("Lunch Ride.fit", "unknown", None, &[]);

        assert_eq!(name, "Lunch Ride");
    }

    #[test]
    fn builds_readable_activity_type_labels() {
        assert_eq!(activity_type_label("cycling", Some("e_bike_fitness")), "eBiking");
        assert_eq!(
            activity_type_label("cycling", Some("indoor_cycling")),
            "Indoor Cycling"
        );
        assert_eq!(activity_type_label("cycling", Some("spin")), "Indoor Cycling");
        assert_eq!(activity_type_label("cycling", Some("road")), "Road Cycling");
        assert_eq!(activity_type_label("cycling", Some("mountain")), "Mountain Biking");
        assert_eq!(
            activity_type_label("cycling", Some("gravel_cycling")),
            "Gravel Cycling"
        );
        assert_eq!(activity_type_label("running", Some("trail")), "Trail Running");
        assert_eq!(activity_type_label("running", Some("generic")), "Running");
        assert_eq!(activity_type_label("unknown", Some("generic")), "Activity");
    }

    #[test]
    fn uses_sub_sport_in_gps_activity_names() {
        let name = build_activity_name(
            "activity.fit",
            "cycling",
            Some("road"),
            &[gps_point()],
        );

        assert!(name.ends_with("Road Cycling"), "unexpected name: {name}");
        assert!(!name.contains("—"), "unexpected name: {name}");
    }

    #[test]
    fn fit_duration_accumulates_valid_session_timer_values() {
        let mut total = None;
        add_valid_duration_s(&mut total, Some(1_000.0));
        add_valid_duration_s(&mut total, Some(0.0));
        add_valid_duration_s(&mut total, Some(1_651.675));
        add_valid_duration_s(&mut total, Some(f64::NAN));

        assert!((total.unwrap() - 2_651.675).abs() < 0.000_001);
    }

    #[test]
    fn fit_duration_prefers_session_timer_time_sum() {
        let (duration, source) = select_fit_duration_s(
            Some(2_651.675),
            Some(2_700.0),
            Some(2_700.0),
            Some(2_705.309),
            2_705.0,
        );

        assert_eq!(duration, 2_651.675);
        assert_eq!(source, "sessions.total_timer_time_sum");
    }

    #[test]
    fn fit_duration_uses_activity_timer_before_lap_sum() {
        let (duration, source) = select_fit_duration_s(
            None,
            Some(606_452.96),
            Some(3_217.111),
            Some(606_452.96),
            3_217.0,
        );

        assert_eq!(duration, 606_452.96);
        assert_eq!(source, "activity.total_timer_time");
    }

    #[test]
    fn fit_duration_uses_lap_timer_sum_before_elapsed_time() {
        let (duration, source) = select_fit_duration_s(
            None,
            None,
            Some(2_651.675),
            Some(2_705.309),
            2_705.0,
        );

        assert_eq!(duration, 2_651.675);
        assert_eq!(source, "laps.total_timer_time_sum");
    }

    #[test]
    fn fit_duration_falls_back_to_elapsed_then_record_span() {
        let (elapsed_duration, elapsed_source) = select_fit_duration_s(
            None,
            None,
            None,
            Some(2_705.309),
            2_705.0,
        );
        assert_eq!(elapsed_duration, 2_705.309);
        assert_eq!(elapsed_source, "sessions.total_elapsed_time_sum");

        let (record_duration, record_source) =
            select_fit_duration_s(None, None, None, None, 2_705.0);
        assert_eq!(record_duration, 2_705.0);
        assert_eq!(record_source, "record_timestamp_span");
    }

    #[test]
    fn fit_duration_ignores_zero_or_invalid_timer_values() {
        let (duration, source) = select_fit_duration_s(
            Some(0.0),
            Some(f64::NAN),
            Some(-1.0),
            Some(2_705.309),
            2_705.0,
        );

        assert_eq!(duration, 2_705.309);
        assert_eq!(source, "sessions.total_elapsed_time_sum");
    }

    fn timer_event(timestamp_ms: i64, event_type: &str, trigger: Option<&str>) -> TimerEvent {
        TimerEvent {
            timestamp_ms,
            event: "timer".to_string(),
            event_type: event_type.to_string(),
            timer_trigger: trigger.map(str::to_string),
        }
    }

    #[test]
    fn fit_timer_intervals_pair_stop_with_next_start() {
        let events = vec![
            timer_event(0, "start", Some("manual")),
            timer_event(10_000, "stop_all", Some("auto")),
            timer_event(20_000, "start", Some("auto")),
            timer_event(30_000, "stop_all", Some("manual")),
        ];

        let intervals = build_stopped_intervals(&events, 0, 40_000);

        assert_eq!(intervals.len(), 1);
        assert_eq!(intervals[0].start_ms, 10_000);
        assert_eq!(intervals[0].end_ms, 20_000);
        assert_eq!(intervals[0].trigger.as_deref(), Some("auto"));
        assert_eq!(intervals[0].resume_trigger.as_deref(), Some("auto"));
    }

    #[test]
    fn fit_timer_intervals_clamp_to_record_bounds() {
        let events = vec![
            timer_event(5_000, "stop", Some("manual")),
            timer_event(20_000, "start", Some("manual")),
        ];

        let intervals = build_stopped_intervals(&events, 10_000, 15_000);

        assert_eq!(intervals.len(), 1);
        assert_eq!(intervals[0].start_ms, 10_000);
        assert_eq!(intervals[0].end_ms, 15_000);
    }

    #[test]
    fn fit_timer_metadata_marks_reliable_when_active_time_matches_timer() {
        let events = vec![
            timer_event(10_000, "stop_all", Some("auto")),
            timer_event(20_000, "start", Some("auto")),
        ];

        let metadata = build_timer_metadata(&events, &[], 0, 100_000, Some(100.0), 90.0);

        assert_eq!(metadata["active_time_supported"].as_bool(), Some(true));
        assert_eq!(metadata["intervals_reliable"].as_bool(), Some(true));
        assert_eq!(metadata["stopped_time_s"].as_f64(), Some(10.0));
    }

    #[test]
    fn fit_timer_metadata_falls_back_when_intervals_do_not_match_timer() {
        let events = vec![
            timer_event(10_000, "stop_all", Some("auto")),
            timer_event(20_000, "start", Some("auto")),
        ];

        let metadata = build_timer_metadata(&events, &[], 0, 100_000, Some(100.0), 70.0);

        assert_eq!(metadata["active_time_supported"].as_bool(), Some(false));
        assert_eq!(metadata["intervals_reliable"].as_bool(), Some(false));
    }

    #[test]
    fn fit_timer_metadata_infers_reconciling_gap_before_unmatched_start() {
        let events = vec![
            timer_event(0, "start", Some("manual")),
            timer_event(1_000_000, "stop_all", Some("auto")),
            timer_event(2_095_000, "start", Some("auto")),
            timer_event(19_855_000, "start", Some("manual")),
            timer_event(19_860_000, "stop_all", Some("manual")),
        ];
        let record_timestamps = vec![
            0,
            1_000_000,
            2_095_000,
            19_780_000,
            19_855_000,
            19_860_000,
        ];

        let metadata = build_timer_metadata(
            &events,
            &record_timestamps,
            0,
            19_860_000,
            Some(19_861.018),
            18_691.618,
        );

        assert_eq!(metadata["schema_version"].as_i64(), Some(2));
        assert_eq!(
            metadata["source"].as_str(),
            Some("fit_event_messages_with_record_gap_inference")
        );
        assert_eq!(metadata["active_time_supported"].as_bool(), Some(true));
        assert_eq!(metadata["intervals_reliable"].as_bool(), Some(true));
        assert_eq!(metadata["inferred_interval_count"].as_u64(), Some(1));
        assert_eq!(metadata["stopped_time_s"].as_f64(), Some(1_170.0));
        assert_eq!(
            metadata["stopped_intervals"][1]["source"].as_str(),
            Some("inferred_record_gap")
        );
        assert_eq!(
            metadata["stopped_intervals"][1]["resume_trigger"].as_str(),
            Some("manual")
        );
    }

    #[test]
    fn fit_timer_metadata_rejects_gap_that_does_not_reconcile() {
        let events = vec![
            timer_event(0, "start", Some("manual")),
            timer_event(10_000, "stop_all", Some("auto")),
            timer_event(20_000, "start", Some("auto")),
            timer_event(80_000, "start", Some("manual")),
            timer_event(100_000, "stop_all", Some("manual")),
        ];
        let record_timestamps = vec![0, 10_000, 20_000, 40_000, 80_000, 100_000];

        let metadata = build_timer_metadata(
            &events,
            &record_timestamps,
            0,
            100_000,
            Some(100.0),
            80.0,
        );

        assert_eq!(metadata["source"].as_str(), Some("fit_event_messages"));
        assert_eq!(metadata["active_time_supported"].as_bool(), Some(false));
        assert_eq!(metadata["intervals_reliable"].as_bool(), Some(false));
        assert_eq!(metadata["inferred_interval_count"].as_u64(), Some(0));
        assert_eq!(metadata["stopped_intervals"].as_array().map(Vec::len), Some(1));
    }

    #[test]
    fn fit_timer_metadata_keeps_equal_no_pause_activity_non_selectable() {
        let events = vec![
            timer_event(0, "start", Some("manual")),
            timer_event(100_000, "stop_all", Some("manual")),
        ];
        let record_timestamps = vec![0, 100_000];

        let metadata = build_timer_metadata(
            &events,
            &record_timestamps,
            0,
            100_000,
            Some(100.0),
            100.0,
        );

        assert_eq!(metadata["active_time_supported"].as_bool(), Some(false));
        assert_eq!(metadata["intervals_reliable"].as_bool(), Some(false));
        assert_eq!(metadata["inferred_interval_count"].as_u64(), Some(0));
        assert_eq!(metadata["stopped_intervals"].as_array().map(Vec::len), Some(0));
    }

    #[test]
    fn fit_time_range_uses_session_bounds_when_available() {
        let (start_ts, end_ts) = select_fit_time_range_ms(
            10_000,
            70_000,
            Some(0),
            Some(120_000),
            60.0,
        );

        assert_eq!(start_ts, 0);
        assert_eq!(end_ts, 120_000);
    }

    #[test]
    fn fit_time_range_extends_sparse_record_range_to_duration() {
        let (start_ts, end_ts) = select_fit_time_range_ms(0, 60_000, None, None, 120.0);

        assert_eq!(start_ts, 0);
        assert_eq!(end_ts, 120_000);
    }

    #[test]
    fn fit_time_range_does_not_shorten_elapsed_record_range() {
        let (start_ts, end_ts) =
            select_fit_time_range_ms(0, 2_705_309, None, None, 2_651.675);

        assert_eq!(start_ts, 0);
        assert_eq!(end_ts, 2_705_309);

    }

    fn tcx_with_lap_distance(lap_distance: Option<f64>) -> String {
        let lap_distance_xml = lap_distance
            .map(|distance| format!("        <DistanceMeters>{distance}</DistanceMeters>\n"))
            .unwrap_or_default();

        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <Activity Sport="Other">
      <Id>2026-01-01T00:00:00.000Z</Id>
      <Lap StartTime="2026-01-01T00:00:00.000Z">
        <TotalTimeSeconds>291.924</TotalTimeSeconds>
{lap_distance_xml}        <Calories>1</Calories>
        <Track>
          <Trackpoint>
            <Time>2026-01-01T00:00:00.000Z</Time>
            <DistanceMeters>40330.828125</DistanceMeters>
          </Trackpoint>
          <Trackpoint>
            <Time>2026-01-01T00:02:25.000Z</Time>
            <DistanceMeters>40395.000000</DistanceMeters>
          </Trackpoint>
          <Trackpoint>
            <Time>2026-01-01T00:04:51.000Z</Time>
            <DistanceMeters>40463.1796875</DistanceMeters>
          </Trackpoint>
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>
"#
        )
    }

    #[test]
    fn tcx_uses_lap_distance_and_normalizes_offset_record_distances() {
        let activity = parse_tcx_bytes(
            "offset-distance.tcx",
            tcx_with_lap_distance(Some(132.35)).as_bytes(),
        )
        .expect("TCX should parse");

        assert!((activity.distance_m - 132.35).abs() < 0.001);
        assert_eq!(activity.records[0].distance_m, Some(0.0));
        assert!(
            (activity.records[2].distance_m.unwrap() - 132.3515625).abs() < 0.001
        );
    }

    #[test]
    fn tcx_falls_back_to_normalized_record_distance_without_lap_distance() {
        let activity = parse_tcx_bytes(
            "offset-distance.tcx",
            tcx_with_lap_distance(None).as_bytes(),
        )
        .expect("TCX should parse");

        assert!((activity.distance_m - 132.3515625).abs() < 0.001);
        assert_eq!(activity.records[0].distance_m, Some(0.0));
        assert!(
            (activity.records[2].distance_m.unwrap() - 132.3515625).abs() < 0.001
        );
    }

    #[test]
    fn sport_profile_name_resolves_numeric_session_sport() {
        assert_eq!(canonical_fit_sport("52", Some("Stopwatch")), "stopwatch");
    }

    #[test]
    fn numeric_session_sport_without_profile_name_becomes_unknown() {
        assert_eq!(canonical_fit_sport("52", None), "unknown");
    }

    #[test]
    fn profile_name_does_not_override_known_session_sport() {
        assert_eq!(canonical_fit_sport("cycling", Some("Stopwatch")), "cycling");
    }
}
