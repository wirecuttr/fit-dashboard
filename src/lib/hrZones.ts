export type HeartRateZone = {
  name: string;
  minExclusive: number;
  maxInclusive: number | null;
  color: string;
};

export const HR_ZONE_COLORS = ["#3b82f6", "#22c55e", "#eab308", "#f97316", "#ef4444", "#a855f7", "#06b6d4"];
export const HEART_RATE_ZONE_PREFERENCES_VERSION = 1 as const;
export const MANUAL_HR_BOUND_MIN_BPM = 40;
export const MANUAL_HR_BOUND_MAX_BPM = 260;
export const MANUAL_HR_BOUND_MIN_GAP_BPM = 5;
export const MANUAL_HR_SLIDER_MIN_BPM = 30;
export const MANUAL_HR_SLIDER_MAX_BPM = 270;

/** The 4 upper-bound values that separate the 5 default zones. */
export const DEFAULT_HR_ZONE_BOUNDS: number[] = [75, 95, 120, 150];

export type ManualHeartRateZoneUsage = "fallback" | "always";
export type HeartRateZoneSource = "fit" | "manual";
/** Manual settings are upper bounds; FIT values are integer starts of the following bucket. */
export type HeartRateZoneBoundarySemantics = "inclusive-upper" | "next-zone-start";

export type HeartRateZoneSelection = {
  boundsBpm: number[];
  source: HeartRateZoneSource;
};

export type HeartRateZonePreferences = {
  version: typeof HEART_RATE_ZONE_PREFERENCES_VERSION;
  bounds_bpm: number[];
  usage: ManualHeartRateZoneUsage;
};

export function validateManualHeartRateZoneBounds(bounds: unknown): bounds is number[] {
  if (!Array.isArray(bounds) || bounds.length !== 4) return false;
  if (bounds.some((value) => !Number.isInteger(value)
    || value < MANUAL_HR_BOUND_MIN_BPM
    || value > MANUAL_HR_BOUND_MAX_BPM)) {
    return false;
  }
  return bounds.every((value, index) => index === 0
    || value - bounds[index - 1] >= MANUAL_HR_BOUND_MIN_GAP_BPM);
}

export function normalizeHeartRateZonePreferences(value: unknown): HeartRateZonePreferences {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid heart-rate-zone preferences");
  }
  const candidate = value as Partial<HeartRateZonePreferences>;
  if (candidate.version !== HEART_RATE_ZONE_PREFERENCES_VERSION
    || (candidate.usage !== "fallback" && candidate.usage !== "always")
    || !validateManualHeartRateZoneBounds(candidate.bounds_bpm)) {
    throw new Error("Invalid heart-rate-zone preferences");
  }
  return {
    version: HEART_RATE_ZONE_PREFERENCES_VERSION,
    bounds_bpm: [...candidate.bounds_bpm],
    usage: candidate.usage,
  };
}

export function resolveHeartRateZoneSelection(
  fitBoundsBpm: number[] | undefined,
  manualBoundsBpm: number[],
  usage: ManualHeartRateZoneUsage,
): HeartRateZoneSelection {
  const normalizedFitBounds = normalizeHeartRateZoneBounds(fitBoundsBpm);
  if (usage === "fallback" && normalizedFitBounds.length >= 2) {
    return { boundsBpm: normalizedFitBounds, source: "fit" };
  }
  return { boundsBpm: [...manualBoundsBpm], source: "manual" };
}

function normalizeHeartRateZoneBounds(zoneUpperBoundsBpm?: number[] | null): number[] {
  if (!Array.isArray(zoneUpperBoundsBpm)) return [];
  return Array.from(
    new Set(
      zoneUpperBoundsBpm
        .map((value) => Math.round(Number(value)))
        .filter((value) => Number.isFinite(value) && value > 0 && value <= MANUAL_HR_BOUND_MAX_BPM)
    )
  ).sort((a, b) => a - b);
}

export function buildHeartRateZones(
  zoneUpperBoundsBpm?: number[] | null,
  boundarySemantics: HeartRateZoneBoundarySemantics = "inclusive-upper",
): HeartRateZone[] {
  const bounds = normalizeHeartRateZoneBounds(zoneUpperBoundsBpm);

  if (bounds.length < 2) {
    return [];
  }

  const zones: HeartRateZone[] = [];
  let minExclusive = -Infinity;

  for (let i = 0; i < bounds.length; i += 1) {
    const boundary = bounds[i];
    const maxInclusive = boundarySemantics === "next-zone-start" ? boundary - 1 : boundary;
    const label = minExclusive === -Infinity
      ? `Z${i + 1} ${boundarySemantics === "next-zone-start" ? "<" : "<="}${boundary} bpm`
      : `Z${i + 1} ${Math.round(minExclusive + 1)}-${maxInclusive} bpm`;
    zones.push({
      name: label,
      minExclusive,
      maxInclusive,
      color: HR_ZONE_COLORS[i % HR_ZONE_COLORS.length],
    });
    minExclusive = maxInclusive;
  }

  zones.push({
    name: boundarySemantics === "next-zone-start"
      ? `Z${zones.length + 1} >=${Math.round(minExclusive + 1)} bpm`
      : `Z${zones.length + 1} >${Math.round(minExclusive)} bpm`,
    minExclusive,
    maxInclusive: null,
    color: HR_ZONE_COLORS[zones.length % HR_ZONE_COLORS.length],
  });

  return zones;
}

export function resolveHeartRateZoneIndex(hr: number, zones: HeartRateZone[]): number | null {
  if (zones.length === 0) return null;

  for (let i = 0; i < zones.length; i += 1) {
    const zone = zones[i];
    const inLower = hr > zone.minExclusive;
    const inUpper = zone.maxInclusive === null ? true : hr <= zone.maxInclusive;
    if (inLower && inUpper) return i;
  }
  return zones.length - 1;
}
