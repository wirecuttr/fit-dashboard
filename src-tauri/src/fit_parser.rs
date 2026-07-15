use std::path::Path;

use anyhow::{anyhow, Context, Result};
use fitparser::{profile::MesgNum, Value};
use sha2::{Digest, Sha256};

use crate::models::{ParsedActivity, RecordPoint};

const NON_ACTIVITY_FIT_MARKER: &str = "non-activity-fit:";

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

fn value_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
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

fn title_case_sport(sport: &str) -> String {
    if sport.is_empty() {
        return "Activity".to_string();
    }
    let mut chars = sport.chars();
    let Some(first) = chars.next() else {
        return "Activity".to_string();
    };
    first.to_uppercase().collect::<String>() + chars.as_str()
}

fn build_activity_name(file_name: &str, sport: &str, points: &[RecordPoint]) -> String {
    let fallback = strip_known_extension(file_name);
    let sport_label = title_case_sport(sport);

    if let Some(pos) = points.iter().find(|p| p.latitude.is_some() && p.longitude.is_some()) {
        let geocoder = reverse_geocoder::ReverseGeocoder::new();
        let result = geocoder.search((pos.latitude.unwrap(), pos.longitude.unwrap()));
        let record = result.record;

        let mut loc_parts = Vec::new();
        if !record.name.is_empty() {
            loc_parts.push(record.name.as_str());
        }
        if !record.admin1.is_empty() {
            loc_parts.push(record.admin1.as_str());
        }
        let loc = loc_parts.join(", ");
        if !loc.is_empty() {
            return format!("{} — {}", loc, sport_label);
        }
    }

    fallback
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
    let mut device = String::new();
    let mut file_id_product_name: Option<String> = None;
    let mut file_id_manufacturer: Option<String> = None;
    let mut file_id_product: Option<String> = None;
    let mut file_id_serial_number: Option<i64> = None;
    let mut file_id_type_name: Option<String> = None;
    let mut file_id_type_code: Option<i64> = None;
    let mut device_info_fallback_name: Option<String> = None;
    let mut device_info_fallback_serial: Option<i64> = None;
    let mut device_info_creator_name: Option<String> = None;
    let mut device_info_creator_serial: Option<i64> = None;
    let mut vo2_max: Option<f64> = None;
    let mut vo2_max_estimates: Vec<Vo2MaxEstimateMetadata> = Vec::new();
    let mut starting_vo2_values: Vec<StartingVo2Value> = Vec::new();
    let mut vo2_sessions: Vec<Vo2SessionContext> = Vec::new();
    let mut vo2_session_count = 0usize;
    let mut pending_vo2_estimate_index: Option<usize> = None;

    let mut session_beginning_body_battery: Option<i64> = None;
    let mut session_ending_body_battery: Option<i64> = None;
    let mut session_max_heart_rate: Option<i64> = None;
    let mut session_avg_heart_rate: Option<i64> = None;
    let mut session_max_cadence: Option<i64> = None;
    let mut session_avg_cadence: Option<i64> = None;
    let mut session_total_elapsed_time_s: Option<f64> = None;
    let mut session_total_distance_m: Option<f64> = None;
    let mut session_total_calories: Option<i64> = None;
    let mut lap_ranges: Vec<serde_json::Value> = Vec::new();
    let mut heart_rate_zone_bounds_bpm: Vec<i64> = Vec::new();

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
                });
            }
        } else if rec.kind() == MesgNum::Session {
            let session_index = vo2_session_count;
            vo2_session_count += 1;
            let mut current_session_sport: Option<String> = None;
            let mut current_session_sub_sport: Option<String> = None;
            for field in rec.fields() {
                match field.name() {
                    "sport" => {
                        let value = value_string(field.value()).to_lowercase();
                        sport = value.clone();
                        current_session_sport = Some(value);
                    }
                    "sub_sport" => {
                        current_session_sub_sport = Some(value_string(field.value()).to_lowercase());
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
                    "total_elapsed_time" => session_total_elapsed_time_s = value_f64(field.value()),
                    "total_distance" => session_total_distance_m = value_f64(field.value()),
                    "total_calories" => session_total_calories = value_i64(field.value()),
                    _ => {}
                }
            }

            if let Some(session_sport) = current_session_sport {
                let session_category = vo2_category_from_sport_name(&session_sport);
                vo2_sessions.push(Vo2SessionContext {
                    session_index,
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
                            estimate.session_index = Some(session_index);
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
        } else if rec.kind() == MesgNum::DeviceInfo {
            let mut candidate_product_name: Option<String> = None;
            let mut candidate_manufacturer: Option<String> = None;
            let mut candidate_product: Option<String> = None;
            let mut candidate_serial: Option<i64> = None;
            let mut is_creator = false;

            for field in rec.fields() {
                match field.name() {
                    "device_index" => {
                        let v = value_string(field.value()).to_lowercase();
                        if v == "creator" || value_i64(field.value()) == Some(0) {
                            is_creator = true;
                        }
                    }
                    "product_name" => {
                        let value = value_string(field.value());
                        if !value.trim().is_empty() {
                            candidate_product_name = Some(value);
                        }
                    }
                    "manufacturer" => {
                        let value = value_string(field.value());
                        if !value.trim().is_empty() {
                            candidate_manufacturer = Some(value);
                        }
                    }
                    "garmin_product" | "product" | "favero_product" => {
                        let value = value_string(field.value());
                        if !value.trim().is_empty() {
                            candidate_product = Some(value);
                        }
                    }
                    "serial_number" => {
                        candidate_serial = value_i64(field.value()).filter(|v| *v > 0);
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
                    "product_name" => {
                        let value = value_string(field.value());
                        if !value.is_empty() {
                            file_id_product_name = Some(value);
                        }
                    }
                    "manufacturer" => {
                        let value = value_string(field.value());
                        if !value.trim().is_empty() {
                            file_id_manufacturer = Some(value);
                        }
                    }
                    "garmin_product" | "product" | "favero_product" => {
                        let value = value_string(field.value());
                        if !value.trim().is_empty() {
                            file_id_product = Some(value);
                        }
                    }
                    "serial_number" => {
                        file_id_serial_number = value_i64(field.value()).filter(|v| *v > 0);
                    }
                    _ => {}
                }
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
            let mut sub_sport: Option<String> = None;
            let mut max_met_category: Option<String> = None;
            for field in rec.fields() {
                match field.name() {
                    "vo2_max" => value_ml_kg_min = value_f64(field.value()),
                    "sport" => {
                        activity_sport = Some(value_string(field.value()).to_lowercase())
                    }
                    "sub_sport" => {
                        sub_sport = Some(value_string(field.value()).to_lowercase())
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
                    sub_sport,
                    session_index: None,
                    category,
                    source: "fit_max_met_data_229".to_string(),
                    raw_value: None,
                    message_index,
                });
            }
        } else if rec.kind() == MesgNum::Lap {
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
                    _ => {}
                }
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
                "best_speed_m_s": lap_best_speed_m_s
            }));
        }

        let rec_kind_name = format!("{:?}", rec.kind()).to_lowercase();
        if rec_kind_name.contains("zone") {
            for field in rec.fields() {
                let field_name = field.name().to_lowercase();
                let is_heart_rate_zone_field =
                    field_name.contains("zone")
                        && (field_name.contains("heart") || field_name.starts_with("hr_"));
                if !is_heart_rate_zone_field {
                    continue;
                }

                if let Some(value) = value_i64(field.value()).filter(|v| *v >= 40 && *v <= 260) {
                    heart_rate_zone_bounds_bpm.push(value);
                }
            }
        }
    }

    append_starting_vo2_estimates(
        &starting_vo2_values,
        &vo2_sessions,
        &mut vo2_max_estimates,
    );
    vo2_max_estimates.sort_by_key(|estimate| estimate.message_index);

    heart_rate_zone_bounds_bpm.sort_unstable();
    heart_rate_zone_bounds_bpm.dedup();

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

    let start_ts = min_ts.ok_or_else(|| anyhow!("FIT file had no timestamped records"))?;
    let end_ts = max_ts.unwrap_or(start_ts);

    derive_distance_if_missing(&mut points);
    derive_speed_if_missing(&mut points);

    let duration_s = ((end_ts - start_ts).max(0) as f64) / 1000.0;
    let distance_m = total_distance_m(&points);
    let (start_latitude, start_longitude) = first_valid_coordinates(&points);

    let file_id_combined_name = combine_device_name(
        file_id_product_name.clone(),
        file_id_manufacturer,
        file_id_product,
    );

    if device.is_empty() {
        device = device_info_creator_name
            .clone()
            .or(file_id_combined_name.clone())
            .or(device_info_fallback_name.clone())
            .unwrap_or_default();
    }

    let resolved_serial_number = file_id_serial_number
        .or(device_info_creator_serial)
        .or(device_info_fallback_serial);

    let metadata_json = serde_json::json!({
        "record_count": points.len(),
        "device": device,
        "sport": sport,
        "source_format": "fit",
        "file_id": {
            "product_name": file_id_combined_name,
            "serial_number": resolved_serial_number
        },
        "device_info": {
            "creator_product_name": device_info_creator_name,
            "creator_serial_number": device_info_creator_serial,
            "fallback_product_name": device_info_fallback_name,
            "fallback_serial_number": device_info_fallback_serial
        },
        "activity_metrics": {
            "vo2_max": vo2_max
        },
        "vo2_max": {
            "schema_version": 1,
            "estimates": vo2_max_estimates
        },
        "heart_rate_zone_bounds_bpm": heart_rate_zone_bounds_bpm,
        "session": {
            "beginning_body_battery": session_beginning_body_battery,
            "ending_body_battery": session_ending_body_battery,
            "max_heart_rate": session_max_heart_rate,
            "avg_heart_rate": session_avg_heart_rate,
            "max_cadence": session_max_cadence,
            "avg_cadence": session_avg_cadence,
            "total_elapsed_time_s": session_total_elapsed_time_s,
            "total_distance_m": session_total_distance_m,
            "total_calories": session_total_calories
        },
        "laps": lap_ranges
    })
    .to_string();

    let activity_name = build_activity_name(file_name, &sport, &points);

    Ok(ParsedActivity {
        file_name: file_name.to_string(),
        source_format: "fit".to_string(),
        activity_name,
        sport,
        device,
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
        });
    }

    let start_ts = min_ts.ok_or_else(|| anyhow!("TCX file had no timestamped trackpoints"))?;
    let end_ts = max_ts.unwrap_or(start_ts);

    derive_distance_if_missing(&mut points);
    derive_speed_if_missing(&mut points);

    let duration_s = ((end_ts - start_ts).max(0) as f64) / 1000.0;
    let distance_m = total_distance_m(&points);
    let (start_latitude, start_longitude) = first_valid_coordinates(&points);

    let metadata_json = serde_json::json!({
        "record_count": points.len(),
        "device": device,
        "sport": sport,
        "source_format": "tcx"
    })
    .to_string();

    let activity_name = build_activity_name(file_name, &sport, &points);

    Ok(ParsedActivity {
        file_name: file_name.to_string(),
        source_format: "tcx".to_string(),
        activity_name,
        sport,
        device,
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
        });
    }

    let start_ts = min_ts.ok_or_else(|| anyhow!("GPX file had no timestamped trackpoints"))?;
    let end_ts = max_ts.unwrap_or(start_ts);

    derive_distance_if_missing(&mut points);
    derive_speed_if_missing(&mut points);

    let duration_s = ((end_ts - start_ts).max(0) as f64) / 1000.0;
    let distance_m = total_distance_m(&points);
    let (start_latitude, start_longitude) = first_valid_coordinates(&points);

    let metadata_json = serde_json::json!({
        "record_count": points.len(),
        "device": device,
        "sport": sport,
        "source_format": "gpx"
    })
    .to_string();

    let activity_name = build_activity_name(file_name, &sport, &points);

    Ok(ParsedActivity {
        file_name: file_name.to_string(),
        source_format: "gpx".to_string(),
        activity_name,
        sport,
        device,
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
mod vo2_tests {
    use super::*;

    fn starting(value: f64, message_index: usize) -> StartingVo2Value {
        StartingVo2Value {
            value_ml_kg_min: value,
            raw_value: value * 65536.0 / 3.5,
            source: "garmin_message_79_field_19".to_string(),
            message_index,
        }
    }

    #[test]
    fn maps_only_running_and_cycling_to_explicit_categories() {
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
    fn associates_multisport_starting_values_in_session_order() {
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
            &[starting(44.7, 20), starting(43.7, 30)],
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
    fn preserves_ambiguous_starting_value_without_a_category() {
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

        append_starting_vo2_estimates(&[starting(45.0, 20)], &sessions, &mut estimates);

        assert_eq!(estimates.len(), 1);
        assert_eq!(estimates[0].category, "unknown");
        assert_eq!(estimates[0].session_index, None);
    }
}
