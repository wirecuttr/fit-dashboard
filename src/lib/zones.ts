export type ActivityZones = {
  heart_rate?: {
    source?: string | null;
    calc_type?: string | null;
    upper_bounds_bpm?: number[] | null;
    time_in_zone_s?: number[] | null;
    configured_max_heart_rate?: number | null;
    resting_heart_rate?: number | null;
    threshold_heart_rate?: number | null;
  } | null;
  power?: {
    source?: string | null;
    calc_type?: string | null;
    functional_threshold_power?: number | null;
    upper_bounds_watts?: number[] | null;
    time_in_zone_s?: number[] | null;
  } | null;
};

export type HeartRateZoneMetadata = NonNullable<ActivityZones["heart_rate"]>;
export type PowerZoneMetadata = NonNullable<ActivityZones["power"]>;

export type NumericZone = {
  name: string;
  minExclusive: number;
  maxInclusive: number | null;
  color: string;
};

const POWER_ZONE_COLORS = ["#60a5fa", "#22c55e", "#eab308", "#f97316", "#ef4444", "#a855f7", "#06b6d4", "#f43f5e", "#94a3b8"];

function numericArray(values: unknown, minExclusive = Number.NEGATIVE_INFINITY, maxInclusive = Number.POSITIVE_INFINITY): number[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > minExclusive && value <= maxInclusive);
}

function stableBounds(values: unknown, minExclusive: number, maxInclusive: number): number[] {
  return Array.from(new Set(numericArray(values, minExclusive, maxInclusive).map((value) => Math.round(value)))).sort((a, b) => a - b);
}

export function getHeartRateZoneBounds(metadata?: { zones?: ActivityZones | null; heart_rate_zone_bounds_bpm?: number[] | null } | null): number[] | undefined {
  const zoneBounds = stableBounds(metadata?.zones?.heart_rate?.upper_bounds_bpm, 0, 260);
  if (zoneBounds.length > 0) return zoneBounds;

  const legacyBounds = stableBounds(metadata?.heart_rate_zone_bounds_bpm, 0, 260);
  return legacyBounds.length > 0 ? legacyBounds : undefined;
}

export function buildPowerZones(zoneUpperBoundsWatts?: number[] | null): NumericZone[] {
  const bounds = stableBounds(zoneUpperBoundsWatts, 0, 5000);
  if (bounds.length === 0) return [];

  const zones: NumericZone[] = [];
  let minExclusive = -Infinity;

  for (let i = 0; i < bounds.length; i += 1) {
    const upper = bounds[i];
    const label = minExclusive === -Infinity ? `Z${i + 1} <=${upper} W` : `Z${i + 1} ${Math.round(minExclusive + 1)}-${upper} W`;
    zones.push({
      name: label,
      minExclusive,
      maxInclusive: upper,
      color: POWER_ZONE_COLORS[i % POWER_ZONE_COLORS.length],
    });
    minExclusive = upper;
  }

  zones.push({
    name: `Z${zones.length + 1} >${Math.round(minExclusive)} W`,
    minExclusive,
    maxInclusive: null,
    color: POWER_ZONE_COLORS[zones.length % POWER_ZONE_COLORS.length],
  });

  return zones;
}

export function resolveNumericZoneIndex(value: number, zones: NumericZone[]): number {
  for (let i = 0; i < zones.length; i += 1) {
    const zone = zones[i];
    const inLower = value > zone.minExclusive;
    const inUpper = zone.maxInclusive === null ? true : value <= zone.maxInclusive;
    if (inLower && inUpper) return i;
  }
  return Math.max(0, zones.length - 1);
}

function secondsToMinutes(values: unknown): number[] {
  return numericArray(values, -1, Number.POSITIVE_INFINITY).map((value) => value / 60);
}

export function zoneSecondsToMinutes(values: unknown, zoneCount: number): number[] {
  const minutes = secondsToMinutes(values);
  return Array.from({ length: zoneCount }, (_, idx) => minutes[idx] ?? 0);
}

export function compatibleZoneSecondsToMinutes(values: unknown, zoneCount: number): number[] | null {
  if (!Array.isArray(values) || values.length !== zoneCount || zoneCount <= 0) return null;
  const seconds = values.map((value) => Number(value));
  if (seconds.some((value) => !Number.isFinite(value) || value < 0)) return null;
  if (!seconds.some((value) => value > 0)) return null;
  return seconds.map((value) => value / 60);
}

export function parseMetadataZones(raw?: string | null): ActivityZones | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { zones?: ActivityZones | null };
    return parsed && typeof parsed === "object" && parsed.zones && typeof parsed.zones === "object" ? parsed.zones : null;
  } catch {
    return null;
  }
}

export function buildExportZones(raw?: string | null): Record<string, unknown> | null {
  const zones = parseMetadataZones(raw);
  if (!zones) return null;

  const out: Record<string, unknown> = {};
  const hr = zones.heart_rate;
  if (hr) {
    out.heartRate = {
      source: hr.source ?? null,
      calcType: hr.calc_type ?? null,
      upperBoundsBpm: numericArray(hr.upper_bounds_bpm, 0, 260),
      timeInZoneS: numericArray(hr.time_in_zone_s, -1),
      configuredMaxHeartRate: typeof hr.configured_max_heart_rate === "number" ? hr.configured_max_heart_rate : null,
      restingHeartRate: typeof hr.resting_heart_rate === "number" ? hr.resting_heart_rate : null,
      thresholdHeartRate: typeof hr.threshold_heart_rate === "number" ? hr.threshold_heart_rate : null,
    };
  }

  const power = zones.power;
  if (power) {
    out.power = {
      source: power.source ?? null,
      calcType: power.calc_type ?? null,
      functionalThresholdPower: typeof power.functional_threshold_power === "number" ? power.functional_threshold_power : null,
      upperBoundsWatts: numericArray(power.upper_bounds_watts, 0, 5000),
      timeInZoneS: numericArray(power.time_in_zone_s, -1),
    };
  }

  return Object.keys(out).length > 0 ? out : null;
}
