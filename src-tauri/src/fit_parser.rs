use std::path::Path;

use anyhow::{anyhow, Context, Result};
use fitparser::{profile::MesgNum, Value};
use sha2::{Digest, Sha256};

use crate::models::{ParsedActivity, ParsedActivitySegment, RecordPoint};

const NON_ACTIVITY_FIT_MARKER: &str = "non-activity-fit:";

#[derive(Debug, Clone, Default, serde::Serialize)]
struct FitActivitySummary {
    activity_type: String,
    total_timer_time_s: Option<f64>,
    total_elapsed_time_s: Option<f64>,
    total_distance_m: Option<f64>,
    timestamp_ms: Option<i64>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
struct FitSessionSummary {
    message_index: usize,
    sport: String,
    sub_sport: String,
    start_timestamp_ms: Option<i64>,
    timestamp_ms: Option<i64>,
    total_timer_time_s: Option<f64>,
    total_elapsed_time_s: Option<f64>,
    total_distance_m: Option<f64>,
    total_calories: Option<i64>,
    avg_speed_m_s: Option<f64>,
    max_speed_m_s: Option<f64>,
    avg_heart_rate: Option<i64>,
    max_heart_rate: Option<i64>,
    avg_cadence: Option<i64>,
    max_cadence: Option<i64>,
    avg_power: Option<i64>,
    max_power: Option<i64>,
    normalized_power: Option<i64>,
    total_ascent_m: Option<f64>,
    total_descent_m: Option<f64>,
    beginning_body_battery: Option<i64>,
    ending_body_battery: Option<i64>,
    first_lap_index: Option<usize>,
    num_laps: Option<usize>,
}

#[derive(Debug, Clone, Default)]
struct FitLapAssignment {
    start_timestamp_ms: Option<i64>,
    sport: String,
    sub_sport: String,
}

fn normalized_fit_value(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_transition_sport(sport: &str) -> bool {
    normalized_fit_value(sport) == "transition"
}

fn session_is_meaningful(session: &FitSessionSummary) -> bool {
    session.start_timestamp_ms.is_some()
        && [
            session.total_timer_time_s,
            session.total_elapsed_time_s,
            session.total_distance_m,
        ]
        .into_iter()
        .flatten()
        .any(|value| value > 0.0)
}

fn ordered_meaningful_sessions(sessions: &[FitSessionSummary]) -> Vec<FitSessionSummary> {
    let mut ordered = sessions
        .iter()
        .filter(|session| session_is_meaningful(session))
        .cloned()
        .collect::<Vec<_>>();
    ordered.sort_by_key(|session| (session.start_timestamp_ms, session.message_index));
    ordered.dedup_by_key(|session| session.start_timestamp_ms);
    ordered
}

fn multisport_detection_reason(
    activity_type: &str,
    sessions: &[FitSessionSummary],
) -> Option<String> {
    let ordered = ordered_meaningful_sessions(sessions);
    if ordered.len() < 2 {
        return None;
    }

    if normalized_fit_value(activity_type) == "automultisport" {
        return Some("activity_type".to_string());
    }
    if ordered
        .iter()
        .any(|session| is_transition_sport(&session.sport))
    {
        return Some("transition_session".to_string());
    }
    if ordered.windows(2).any(|pair| {
        normalized_fit_value(&pair[0].sport) != normalized_fit_value(&pair[1].sport)
            || normalized_fit_value(&pair[0].sub_sport) != normalized_fit_value(&pair[1].sub_sport)
    }) {
        return Some("adjacent_sport_change".to_string());
    }
    None
}

fn display_sport_name(sport: &str, sub_sport: &str) -> String {
    let raw = if !sub_sport.trim().is_empty()
        && normalized_fit_value(sub_sport) != "generic"
        && normalized_fit_value(sub_sport) != normalized_fit_value(sport)
    {
        sub_sport
    } else {
        sport
    };
    raw.split('_')
        .filter(|part| !part.is_empty())
        .map(title_case_sport)
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Debug, Clone)]
struct SegmentInterval {
    segment_index: i64,
    session: FitSessionSummary,
    start_timestamp_ms: i64,
    end_timestamp_ms: i64,
}

fn build_segment_intervals(
    sessions: &[FitSessionSummary],
    parent_end_timestamp_ms: i64,
) -> Vec<SegmentInterval> {
    let ordered = ordered_meaningful_sessions(sessions);
    ordered
        .iter()
        .enumerate()
        .filter_map(|(index, session)| {
            let start = session.start_timestamp_ms?;
            let declared_end = session
                .total_elapsed_time_s
                .or(session.total_timer_time_s)
                .map(|seconds| start + (seconds.max(0.0) * 1000.0).round() as i64);
            let end = ordered
                .get(index + 1)
                .and_then(|next| next.start_timestamp_ms)
                .or(declared_end)
                .unwrap_or(parent_end_timestamp_ms);
            let end = if index + 1 == ordered.len() {
                end.max(parent_end_timestamp_ms)
            } else {
                end
            };
            Some(SegmentInterval {
                segment_index: index as i64 + 1,
                session: session.clone(),
                start_timestamp_ms: start,
                end_timestamp_ms: end.max(start),
            })
        })
        .collect()
}

fn segment_index_for_timestamp(intervals: &[SegmentInterval], timestamp_ms: i64) -> Option<i64> {
    intervals.iter().enumerate().find_map(|(index, interval)| {
        let is_last = index + 1 == intervals.len();
        let inside = timestamp_ms >= interval.start_timestamp_ms
            && (timestamp_ms < interval.end_timestamp_ms
                || (is_last && timestamp_ms <= interval.end_timestamp_ms));
        inside.then_some(interval.segment_index)
    })
}

fn assign_laps_to_segments(
    intervals: &[SegmentInterval],
    lap_sources: &[FitLapAssignment],
) -> Vec<Option<i64>> {
    let mut assignments = vec![None; lap_sources.len()];
    for interval in intervals {
        if let (Some(first), Some(count)) =
            (interval.session.first_lap_index, interval.session.num_laps)
        {
            for lap_index in first..first.saturating_add(count).min(assignments.len()) {
                assignments[lap_index] = Some(interval.segment_index);
            }
        }
    }

    for (lap_index, source) in lap_sources.iter().enumerate() {
        if assignments[lap_index].is_none() {
            assignments[lap_index] = source
                .start_timestamp_ms
                .and_then(|timestamp| segment_index_for_timestamp(intervals, timestamp));
        }
        if assignments[lap_index].is_none() && !source.sport.is_empty() {
            let matches = intervals
                .iter()
                .filter(|interval| {
                    normalized_fit_value(&interval.session.sport)
                        == normalized_fit_value(&source.sport)
                        && (source.sub_sport.is_empty()
                            || normalized_fit_value(&interval.session.sub_sport)
                                == normalized_fit_value(&source.sub_sport))
                })
                .collect::<Vec<_>>();
            if matches.len() == 1 {
                assignments[lap_index] = Some(matches[0].segment_index);
            }
        }
    }
    assignments
}

fn record_distance_offset(points: &[RecordPoint], segment_start_ms: i64) -> f64 {
    points
        .iter()
        .filter(|point| point.timestamp_ms < segment_start_ms)
        .filter_map(|point| {
            point
                .distance_m
                .map(|distance| (point.timestamp_ms, distance))
        })
        .max_by_key(|(timestamp, _)| *timestamp)
        .map(|(_, distance)| distance)
        .unwrap_or(0.0)
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
    let product = product.map(|s| s.trim().to_string()).and_then(|s| {
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

    if let Some(pos) = points
        .iter()
        .find(|p| p.latitude.is_some() && p.longitude.is_some())
    {
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
    let mut fit_activity = FitActivitySummary::default();
    let mut fit_sessions: Vec<FitSessionSummary> = Vec::new();
    let mut lap_assignment_sources: Vec<FitLapAssignment> = Vec::new();
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
                    "position_lat" => {
                        latitude = value_f64(field.value()).map(to_degrees_if_semicircles)
                    }
                    "position_long" => {
                        longitude = value_f64(field.value()).map(to_degrees_if_semicircles)
                    }
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
                    segment_index: None,
                });
            }
        } else if rec.kind() == MesgNum::Activity {
            for field in rec.fields() {
                match field.name() {
                    "type" => {
                        fit_activity.activity_type = value_string(field.value()).to_lowercase()
                    }
                    "total_timer_time" => {
                        fit_activity.total_timer_time_s = value_f64(field.value())
                    }
                    "total_elapsed_time" => {
                        fit_activity.total_elapsed_time_s = value_f64(field.value())
                    }
                    "total_distance" => fit_activity.total_distance_m = value_f64(field.value()),
                    "timestamp" => fit_activity.timestamp_ms = value_timestamp_ms(field.value()),
                    _ => {}
                }
            }
        } else if rec.kind() == MesgNum::Session {
            let mut session = FitSessionSummary {
                message_index: fit_sessions.len(),
                ..FitSessionSummary::default()
            };
            for field in rec.fields() {
                match field.name() {
                    "sport" => session.sport = value_string(field.value()).to_lowercase(),
                    "sub_sport" => session.sub_sport = value_string(field.value()).to_lowercase(),
                    "start_time" => session.start_timestamp_ms = value_timestamp_ms(field.value()),
                    "timestamp" => session.timestamp_ms = value_timestamp_ms(field.value()),
                    "total_timer_time" => session.total_timer_time_s = value_f64(field.value()),
                    "total_elapsed_time" => session.total_elapsed_time_s = value_f64(field.value()),
                    "total_distance" => session.total_distance_m = value_f64(field.value()),
                    "total_calories" => session.total_calories = value_i64(field.value()),
                    "enhanced_avg_speed" => session.avg_speed_m_s = value_f64(field.value()),
                    "avg_speed" if session.avg_speed_m_s.is_none() => {
                        session.avg_speed_m_s = value_f64(field.value())
                    }
                    "enhanced_max_speed" => session.max_speed_m_s = value_f64(field.value()),
                    "max_speed" if session.max_speed_m_s.is_none() => {
                        session.max_speed_m_s = value_f64(field.value())
                    }
                    "avg_heart_rate" => session.avg_heart_rate = value_i64(field.value()),
                    "max_heart_rate" => session.max_heart_rate = value_i64(field.value()),
                    "avg_cadence" => session.avg_cadence = value_i64(field.value()),
                    "max_cadence" => session.max_cadence = value_i64(field.value()),
                    "avg_power" => session.avg_power = value_i64(field.value()),
                    "max_power" => session.max_power = value_i64(field.value()),
                    "normalized_power" => session.normalized_power = value_i64(field.value()),
                    "total_ascent" => session.total_ascent_m = value_f64(field.value()),
                    "total_descent" => session.total_descent_m = value_f64(field.value()),
                    "beginning_body_battery" | "start_body_battery" => {
                        session.beginning_body_battery = value_i64(field.value())
                    }
                    "ending_body_battery" | "end_body_battery" => {
                        session.ending_body_battery = value_i64(field.value())
                    }
                    "first_lap_index" => {
                        session.first_lap_index = value_i64(field.value())
                            .filter(|value| *value >= 0)
                            .map(|value| value as usize)
                    }
                    "num_laps" => {
                        session.num_laps = value_i64(field.value())
                            .filter(|value| *value >= 0)
                            .map(|value| value as usize)
                    }
                    _ => {}
                }
            }

            if !session.sport.is_empty() {
                sport = session.sport.clone();
            }
            session_beginning_body_battery = session.beginning_body_battery;
            session_ending_body_battery = session.ending_body_battery;
            session_max_heart_rate = session.max_heart_rate;
            session_avg_heart_rate = session.avg_heart_rate;
            session_max_cadence = session.max_cadence;
            session_avg_cadence = session.avg_cadence;
            session_total_elapsed_time_s = session.total_elapsed_time_s;
            session_total_distance_m = session.total_distance_m;
            session_total_calories = session.total_calories;
            fit_sessions.push(session);
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
        } else if rec.kind() == MesgNum::Value(140) {
            for field in rec.fields() {
                if field.name() == "unknown_field_7" {
                    if let Some(v) = value_f64(field.value()) {
                        vo2_max = Some(v * 3.5 / 65536.0);
                    }
                }
            }
        } else if rec.kind() == MesgNum::Lap {
            let mut lap_start_ms: Option<i64> = None;
            let mut lap_timestamp_ms: Option<i64> = None;
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
            let mut lap_sport = String::new();
            let mut lap_sub_sport = String::new();
            for field in rec.fields() {
                match field.name() {
                    "start_time" => lap_start_ms = value_timestamp_ms(field.value()),
                    "timestamp" => lap_timestamp_ms = value_timestamp_ms(field.value()),
                    "sport" => lap_sport = value_string(field.value()).to_lowercase(),
                    "sub_sport" => lap_sub_sport = value_string(field.value()).to_lowercase(),
                    "total_elapsed_time" => lap_total_elapsed_time_s = value_f64(field.value()),
                    "total_timer_time" => lap_total_timer_time_s = value_f64(field.value()),
                    "total_distance" => lap_total_distance_m = value_f64(field.value()),
                    "enhanced_avg_speed" => lap_avg_speed_m_s = value_f64(field.value()),
                    "avg_speed" if lap_avg_speed_m_s.is_none() => {
                        lap_avg_speed_m_s = value_f64(field.value())
                    }
                    "enhanced_max_speed" => lap_max_speed_m_s = value_f64(field.value()),
                    "max_speed" if lap_max_speed_m_s.is_none() => {
                        lap_max_speed_m_s = value_f64(field.value())
                    }
                    "enhanced_best_speed" => lap_best_speed_m_s = value_f64(field.value()),
                    "best_speed" if lap_best_speed_m_s.is_none() => {
                        lap_best_speed_m_s = value_f64(field.value())
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

            let duration_ms = lap_total_elapsed_time_s
                .or(lap_total_timer_time_s)
                .map(|seconds| (seconds.max(0.0) * 1000.0).round() as i64);
            let lap_end_ms = lap_start_ms
                .zip(duration_ms)
                .map(|(start, duration)| start + duration)
                .or_else(|| {
                    lap_timestamp_ms
                        .filter(|end| lap_start_ms.map(|start| *end > start).unwrap_or(true))
                });
            let fit_lap_index = lap_ranges.len();
            lap_assignment_sources.push(FitLapAssignment {
                start_timestamp_ms: lap_start_ms,
                sport: lap_sport.clone(),
                sub_sport: lap_sub_sport.clone(),
            });
            lap_ranges.push(serde_json::json!({
                "fit_lap_index": fit_lap_index,
                "sport": lap_sport,
                "sub_sport": lap_sub_sport,
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
                let is_heart_rate_zone_field = field_name.contains("zone")
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
            let type_desc = file_id_type_name.clone().unwrap_or_else(|| {
                file_id_type_code
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            });
            return Err(anyhow!(
                "{NON_ACTIVITY_FIT_MARKER} file_id.type={type_desc}"
            ));
        }
    }

    let record_start_ts = min_ts.ok_or_else(|| anyhow!("FIT file had no timestamped records"))?;
    let record_end_ts = max_ts.unwrap_or(record_start_ts);

    derive_distance_if_missing(&mut points);
    derive_speed_if_missing(&mut points);

    let detection_reason = multisport_detection_reason(&fit_activity.activity_type, &fit_sessions);
    let is_multisport = detection_reason.is_some();
    let intervals = if is_multisport {
        build_segment_intervals(&fit_sessions, record_end_ts)
    } else {
        Vec::new()
    };

    let mut unassigned_record_count = 0usize;
    if is_multisport {
        for point in &mut points {
            point.segment_index = segment_index_for_timestamp(&intervals, point.timestamp_ms);
            if point.segment_index.is_none() {
                unassigned_record_count += 1;
            }
        }
    }

    let lap_segment_indices = if is_multisport {
        assign_laps_to_segments(&intervals, &lap_assignment_sources)
    } else {
        vec![None; lap_ranges.len()]
    };
    if is_multisport {
        let mut local_lap_counts = vec![0usize; intervals.len()];
        for (lap_index, segment_index) in lap_segment_indices.iter().enumerate() {
            let Some(segment_index) = segment_index else {
                continue;
            };
            let local_index = (*segment_index - 1) as usize;
            local_lap_counts[local_index] += 1;
            if let Some(lap) = lap_ranges
                .get_mut(lap_index)
                .and_then(|value| value.as_object_mut())
            {
                lap.insert(
                    "segment_index".to_string(),
                    serde_json::json!(segment_index),
                );
                lap.insert(
                    "segment_type".to_string(),
                    serde_json::json!(
                        if is_transition_sport(&intervals[local_index].session.sport) {
                            "transition"
                        } else {
                            "sport"
                        }
                    ),
                );
                lap.insert(
                    "segment_lap_index".to_string(),
                    serde_json::json!(local_lap_counts[local_index]),
                );
            }
        }
    }
    let unassigned_lap_count = lap_segment_indices
        .iter()
        .filter(|value| value.is_none())
        .count();

    let record_span_duration_s = ((record_end_ts - record_start_ts).max(0) as f64) / 1000.0;
    let session_timer_duration_s = intervals
        .iter()
        .filter_map(|interval| interval.session.total_timer_time_s)
        .sum::<f64>();
    let session_elapsed_duration_s = intervals
        .iter()
        .filter_map(|interval| interval.session.total_elapsed_time_s)
        .sum::<f64>();
    let duration_s = if is_multisport {
        fit_activity
            .total_timer_time_s
            .filter(|value| *value > 0.0)
            .or_else(|| (session_timer_duration_s > 0.0).then_some(session_timer_duration_s))
            .or_else(|| (session_elapsed_duration_s > 0.0).then_some(session_elapsed_duration_s))
            .unwrap_or(record_span_duration_s)
    } else {
        record_span_duration_s
    };

    let record_distance_m = total_distance_m(&points);
    let session_distance_m = intervals
        .iter()
        .filter_map(|interval| interval.session.total_distance_m)
        .sum::<f64>();
    let distance_m = if is_multisport {
        fit_activity
            .total_distance_m
            .filter(|value| *value > 0.0)
            .or_else(|| (session_distance_m > 0.0).then_some(session_distance_m))
            .unwrap_or(record_distance_m)
    } else {
        record_distance_m
    };

    let start_ts = intervals
        .first()
        .map(|interval| interval.start_timestamp_ms)
        .unwrap_or(record_start_ts);
    let end_ts = intervals
        .last()
        .map(|interval| interval.end_timestamp_ms)
        .unwrap_or(record_end_ts);
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

    let mut segments = Vec::new();
    for (interval_position, interval) in intervals.iter().enumerate() {
        let record_distance_offset_m = if interval_position == 0 {
            0.0
        } else {
            record_distance_offset(&points, interval.start_timestamp_ms)
        };
        let start_coordinates = points.iter().find(|point| {
            point.segment_index == Some(interval.segment_index)
                && point.latitude.is_some()
                && point.longitude.is_some()
        });
        let base_name = display_sport_name(&interval.session.sport, &interval.session.sub_sport);
        let repeated_count = intervals
            .iter()
            .filter(|candidate| {
                display_sport_name(&candidate.session.sport, &candidate.session.sub_sport)
                    == base_name
            })
            .count();
        let occurrence = intervals[..=interval_position]
            .iter()
            .filter(|candidate| {
                display_sport_name(&candidate.session.sport, &candidate.session.sub_sport)
                    == base_name
            })
            .count();
        let transition_number = intervals[..=interval_position]
            .iter()
            .filter(|candidate| is_transition_sport(&candidate.session.sport))
            .count();
        let name = if is_transition_sport(&interval.session.sport) {
            format!("T{transition_number}")
        } else if repeated_count > 1 {
            format!("{base_name} {occurrence}")
        } else if base_name.is_empty() {
            format!("Leg {}", interval.segment_index)
        } else {
            base_name
        };
        let record_segment_distance_m = points
            .iter()
            .filter(|point| point.segment_index == Some(interval.segment_index))
            .filter_map(|point| point.distance_m)
            .max_by(|left, right| left.total_cmp(right))
            .map(|last| (last - record_distance_offset_m).max(0.0));
        let segment_distance_m = interval
            .session
            .total_distance_m
            .filter(|value| *value >= 0.0)
            .or(record_segment_distance_m)
            .unwrap_or(0.0);
        let interval_duration_s =
            ((interval.end_timestamp_ms - interval.start_timestamp_ms).max(0) as f64) / 1000.0;
        let segment_metadata = serde_json::json!({
            "fit_session_index": interval.session.message_index,
            "session": interval.session
        })
        .to_string();

        segments.push(ParsedActivitySegment {
            segment_index: interval.segment_index,
            segment_type: if is_transition_sport(&interval.session.sport) {
                "transition".to_string()
            } else {
                "sport".to_string()
            },
            name,
            sport: interval.session.sport.clone(),
            sub_sport: interval.session.sub_sport.clone(),
            start_ts_utc: chrono::DateTime::from_timestamp_millis(interval.start_timestamp_ms)
                .ok_or_else(|| anyhow!("invalid segment start timestamp"))?
                .to_rfc3339(),
            end_ts_utc: chrono::DateTime::from_timestamp_millis(interval.end_timestamp_ms)
                .ok_or_else(|| anyhow!("invalid segment end timestamp"))?
                .to_rfc3339(),
            timer_duration_s: interval
                .session
                .total_timer_time_s
                .unwrap_or(interval_duration_s),
            elapsed_duration_s: interval
                .session
                .total_elapsed_time_s
                .unwrap_or(interval_duration_s),
            distance_m: segment_distance_m,
            record_distance_offset_m,
            start_latitude: start_coordinates.and_then(|point| point.latitude),
            start_longitude: start_coordinates.and_then(|point| point.longitude),
            metadata_json: segment_metadata,
        });
    }

    let parent_session = if is_multisport {
        let avg_heart_rates = intervals
            .iter()
            .filter_map(|interval| interval.session.avg_heart_rate)
            .collect::<Vec<_>>();
        serde_json::json!({
            "beginning_body_battery": intervals
                .iter()
                .find_map(|interval| interval.session.beginning_body_battery),
            "ending_body_battery": intervals
                .iter()
                .rev()
                .find_map(|interval| interval.session.ending_body_battery),
            "max_heart_rate": intervals
                .iter()
                .filter_map(|interval| interval.session.max_heart_rate)
                .max(),
            "avg_heart_rate": (!avg_heart_rates.is_empty()).then(|| {
                avg_heart_rates.iter().sum::<i64>() / avg_heart_rates.len() as i64
            }),
            "max_cadence": null,
            "avg_cadence": null,
            "total_elapsed_time_s": fit_activity.total_elapsed_time_s.or_else(|| {
                (session_elapsed_duration_s > 0.0).then_some(session_elapsed_duration_s)
            }),
            "total_distance_m": distance_m,
            "total_calories": {
                let total = intervals
                    .iter()
                    .filter_map(|interval| interval.session.total_calories)
                    .sum::<i64>();
                (total > 0).then_some(total)
            }
        })
    } else {
        serde_json::json!({
            "beginning_body_battery": session_beginning_body_battery,
            "ending_body_battery": session_ending_body_battery,
            "max_heart_rate": session_max_heart_rate,
            "avg_heart_rate": session_avg_heart_rate,
            "max_cadence": session_max_cadence,
            "avg_cadence": session_avg_cadence,
            "total_elapsed_time_s": session_total_elapsed_time_s,
            "total_distance_m": session_total_distance_m,
            "total_calories": session_total_calories
        })
    };
    let resolved_sport = if is_multisport {
        "multisport".to_string()
    } else {
        sport.clone()
    };
    let mut metadata = serde_json::json!({
        "record_count": points.len(),
        "device": device,
        "sport": resolved_sport,
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
        "heart_rate_zone_bounds_bpm": heart_rate_zone_bounds_bpm,
        "session": parent_session,
        "laps": lap_ranges
    });
    if is_multisport {
        metadata
            .as_object_mut()
            .expect("activity metadata is an object")
            .insert(
                "multisport".to_string(),
                serde_json::json!({
                    "activity": fit_activity,
                    "sessions": fit_sessions,
                    "assignment": {
                        "detection_reason": detection_reason,
                        "unassigned_record_count": unassigned_record_count,
                        "overlapping_record_count": 0,
                        "unassigned_lap_count": unassigned_lap_count
                    }
                }),
            );
    }
    let metadata_json = metadata.to_string();
    let activity_name = if is_multisport {
        "Multisport".to_string()
    } else {
        build_activity_name(file_name, &resolved_sport, &points)
    };

    Ok(ParsedActivity {
        file_name: file_name.to_string(),
        source_format: "fit".to_string(),
        activity_name,
        sport: resolved_sport,
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
        activity_kind: if is_multisport {
            "multisport_parent".to_string()
        } else {
            "single".to_string()
        },
        segments,
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
            segment_index: None,
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
        activity_kind: "single".to_string(),
        segments: Vec::new(),
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
        let ts = child_text(tp, "time")
            .as_deref()
            .and_then(parse_timestamp_ms);
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
            segment_index: None,
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
        activity_kind: "single".to_string(),
        segments: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(start_timestamp_ms: i64, sport: &str) -> FitSessionSummary {
        FitSessionSummary {
            sport: sport.to_string(),
            start_timestamp_ms: Some(start_timestamp_ms),
            total_timer_time_s: Some(10.0),
            total_elapsed_time_s: Some(10.0),
            ..FitSessionSummary::default()
        }
    }

    #[test]
    fn single_session_auto_multisport_is_not_detected() {
        let sessions = vec![session(1_000, "running")];
        assert_eq!(
            multisport_detection_reason("auto_multi_sport", &sessions),
            None
        );
    }

    #[test]
    fn manual_multi_session_sport_change_is_detected() {
        let sessions = vec![session(1_000, "cycling"), session(11_000, "running")];
        assert_eq!(
            multisport_detection_reason("manual", &sessions).as_deref(),
            Some("adjacent_sport_change")
        );
    }

    #[test]
    fn adjacent_starts_create_half_open_segment_intervals() {
        let sessions = vec![session(1_000, "cycling"), session(11_000, "running")];
        let intervals = build_segment_intervals(&sessions, 21_000);
        assert_eq!(segment_index_for_timestamp(&intervals, 10_999), Some(1));
        assert_eq!(segment_index_for_timestamp(&intervals, 11_000), Some(2));
        assert_eq!(segment_index_for_timestamp(&intervals, 21_000), Some(2));
        assert_eq!(segment_index_for_timestamp(&intervals, 999), None);
    }

    #[test]
    fn explicit_session_lap_ranges_take_priority() {
        let mut first = session(1_000, "cycling");
        first.first_lap_index = Some(0);
        first.num_laps = Some(2);
        let mut second = session(11_000, "running");
        second.first_lap_index = Some(2);
        second.num_laps = Some(1);
        let intervals = build_segment_intervals(&[first, second], 21_000);
        let lap_sources = vec![
            FitLapAssignment {
                start_timestamp_ms: Some(12_000),
                ..FitLapAssignment::default()
            },
            FitLapAssignment {
                start_timestamp_ms: Some(13_000),
                ..FitLapAssignment::default()
            },
            FitLapAssignment {
                start_timestamp_ms: Some(2_000),
                ..FitLapAssignment::default()
            },
        ];
        assert_eq!(
            assign_laps_to_segments(&intervals, &lap_sources),
            vec![Some(1), Some(1), Some(2)]
        );
    }

    #[test]
    fn distance_offset_uses_last_sample_before_segment_start() {
        let point = |timestamp_ms, distance_m| RecordPoint {
            timestamp_ms,
            latitude: None,
            longitude: None,
            altitude_m: None,
            distance_m: Some(distance_m),
            speed_m_s: None,
            cadence: None,
            heart_rate: None,
            power: None,
            temperature_c: None,
            segment_index: None,
        };
        let points = vec![point(0, 0.0), point(900, 42.0), point(1_000, 45.0)];
        assert_eq!(record_distance_offset(&points, 1_000), 42.0);
    }
}
