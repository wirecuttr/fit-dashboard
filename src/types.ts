export type Activity = {
  id: number;
  file_name: string;
  activity_name: string;
  source_title?: string | null;
  generated_title?: string | null;
  sport: string;
  sub_sport?: string;
  device: string;
  location_city?: string | null;
  location_region?: string | null;
  location_country?: string | null;
  location_label?: string | null;
  start_ts_utc: string;
  end_ts_utc: string;
  duration_s: number;
  distance_m: number;
  start_latitude?: number;
  start_longitude?: number;
  metadata_json?: string;
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
  respiration_rate_brpm?: number;
  current_stamina_pct?: number;
  potential_stamina_pct?: number;
  performance_condition?: number;
};

export type OverviewStats = {
  activity_count: number;
  total_distance_m: number;
  total_duration_s: number;
};
