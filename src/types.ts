export type ActivitySegment = {
  activity_id: number;
  segment_index: number;
  segment_type: "sport" | "transition";
  name: string;
  sport: string;
  sub_sport: string;
  start_ts_utc: string;
  end_ts_utc: string;
  timer_duration_s: number;
  elapsed_duration_s: number;
  distance_m: number;
  record_distance_offset_m: number;
  start_latitude?: number;
  start_longitude?: number;
  metadata_json?: string;
};

export type Activity = {
  id: number;
  file_name: string;
  activity_name: string;
  sport: string;
  device: string;
  start_ts_utc: string;
  end_ts_utc: string;
  duration_s: number;
  distance_m: number;
  start_latitude?: number;
  start_longitude?: number;
  metadata_json?: string;
  activity_kind: "single" | "multisport_parent" | "multisport_segment";
  segments: ActivitySegment[];
};

export type RecordPoint = {
  timestamp_ms: number;
  latitude?: number;
  longitude?: number;
  altitude_m?: number;
  distance_m?: number;
  speed_m_s?: number;
  heart_rate?: number;
  cadence?: number;
  power?: number;
  temperature_c?: number;
  segment_index?: number;
};

export type OverviewStats = {
  activity_count: number;
  total_distance_m: number;
  total_duration_s: number;
};
