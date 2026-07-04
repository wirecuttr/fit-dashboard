use std::path::Path;

use anyhow::{anyhow, Context, Result};
use fitparser::{profile::MesgNum, Value};
use sha2::{Digest, Sha256};

use crate::models::{ParsedActivity, RecordPoint};

const NON_ACTIVITY_FIT_MARKER: &str = "non-activity-fit:";

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

fn humanize_token(value: &str) -> String {
    value
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
        .collect::<Vec<_>>()
        .join(" ")
}

fn activity_type_label(sport: &str, sub_sport: &str) -> Option<String> {
    let sport = sport.trim().to_lowercase();
    let sub_sport = sub_sport.trim().to_lowercase();
    let has_sub_sport = !sub_sport.is_empty() && sub_sport != "generic" && sub_sport != "unknown";

    if has_sub_sport {
        match (sport.as_str(), sub_sport.as_str()) {
            ("cycling", "road") => return Some("Road Cycling".to_string()),
            ("cycling", "indoor_cycling") | ("cycling", "spin") => {
                return Some("Indoor Cycling".to_string())
            }
            ("cycling", "mountain") => return Some("Mountain Biking".to_string()),
            ("cycling", "gravel_cycling") => return Some("Gravel Cycling".to_string()),
            ("cycling", "e_bike_fitness") | ("e_biking", "e_bike_fitness") => {
                return Some("eBiking".to_string())
            }
            ("cycling", "e_bike_mountain") | ("e_biking", "e_bike_mountain") => {
                return Some("eMountain Biking".to_string())
            }
            ("cycling", "cyclocross") => return Some("Cyclocross".to_string()),
            ("cycling", "track_cycling") => return Some("Track Cycling".to_string()),
            ("running", "trail") => return Some("Trail Running".to_string()),
            ("running", "treadmill") | ("running", "indoor_running") => {
                return Some("Treadmill Running".to_string())
            }
            ("running", "track") => return Some("Track Running".to_string()),
            ("running", "ultra") => return Some("Ultra Running".to_string()),
            ("swimming", "lap_swimming") => return Some("Lap Swimming".to_string()),
            ("swimming", "open_water") => return Some("Open Water Swimming".to_string()),
            ("training", "strength_training") => return Some("Strength Training".to_string()),
            ("training", "cardio_training") => return Some("Cardio Training".to_string()),
            ("training", "yoga") => return Some("Yoga".to_string()),
            ("training", "pilates") => return Some("Pilates".to_string()),
            _ => return Some(humanize_token(&sub_sport)),
        }
    }

    match sport.as_str() {
        "" | "unknown" => None,
        "e_biking" => Some("eBiking".to_string()),
        _ => Some(humanize_token(&sport)),
    }
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
    let label_parts = [city.as_deref(), region.as_deref()]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();

    ActivityLocation {
        city,
        region,
        country,
        label: if label_parts.is_empty() {
            None
        } else {
            Some(label_parts.join(", "))
        },
    }
}

fn build_generated_title(file_name: &str, sport: &str, sub_sport: &str, location: &ActivityLocation) -> String {
    let fallback = strip_known_extension(file_name);
    if let Some(activity_type) = activity_type_label(sport, sub_sport) {
        if let Some(city) = location.city.as_deref().filter(|city| !city.is_empty()) {
            return format!("{} {}", city, activity_type);
        }
        return activity_type;
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
    let mut sub_sport = String::new();
    let mut source_title: Option<String> = None;
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

    for rec in records {
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
            for field in rec.fields() {
                match field.name() {
                    "sport" => sport = value_string(field.value()).to_lowercase(),
                    "sub_sport" => sub_sport = value_string(field.value()).to_lowercase(),
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
        } else if rec.kind() == MesgNum::Workout {
            for field in rec.fields() {
                if field.name() == "wkt_name" && source_title.is_none() {
                    source_title = clean_string(value_string(field.value()));
                }
            }
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
        } else if rec.kind() == MesgNum::Value(140){
            for field in rec.fields() {
                if field.name() == "unknown_field_7" {
                    if let Some(v) = value_f64(field.value()) {
                        vo2_max = Some(v * 3.5 / 65536.0);
                    }
                }
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
    let location = derive_activity_location(&points);
    let generated_title = build_generated_title(file_name, &sport, &sub_sport, &location);
    let activity_name = source_title.clone().unwrap_or_else(|| generated_title.clone());

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
        "sub_sport": sub_sport.clone(),
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
            "creator_product_name": device_info_creator_name,
            "creator_serial_number": device_info_creator_serial,
            "fallback_product_name": device_info_fallback_name,
            "fallback_serial_number": device_info_fallback_serial
        },
        "activity_metrics": {
            "vo2_max": vo2_max
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

    Ok(ParsedActivity {
        file_name: file_name.to_string(),
        source_format: "fit".to_string(),
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
    let sub_sport = String::new();
    let source_title: Option<String> = None;
    let location = derive_activity_location(&points);
    let generated_title = build_generated_title(file_name, &sport, &sub_sport, &location);
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
    let generated_title = build_generated_title(file_name, &sport, &sub_sport, &location);
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
