export type HeartRateZone = {
  name: string;
  minExclusive: number;
  maxInclusive: number | null;
  color: string;
};

const HR_ZONE_COLORS = ["#3b82f6", "#22c55e", "#eab308", "#f97316", "#ef4444", "#a855f7", "#06b6d4"];

export function buildHeartRateZones(zoneUpperBoundsBpm?: number[] | null): HeartRateZone[] {
  if (!Array.isArray(zoneUpperBoundsBpm) || zoneUpperBoundsBpm.length === 0) {
    return [];
  }

  const bounds = Array.from(
    new Set(
      zoneUpperBoundsBpm
        .map((value) => Math.round(Number(value)))
        .filter((value) => Number.isFinite(value) && value > 0 && value < 260)
    )
  ).sort((a, b) => a - b);

  if (bounds.length < 2) {
    return [];
  }

  const zones: HeartRateZone[] = [];
  let minExclusive = -Infinity;

  for (let i = 0; i < bounds.length; i += 1) {
    const upper = bounds[i];
    const label = minExclusive === -Infinity ? `Z${i + 1} <=${upper} bpm` : `Z${i + 1} ${Math.round(minExclusive + 1)}-${upper} bpm`;
    zones.push({
      name: label,
      minExclusive,
      maxInclusive: upper,
      color: HR_ZONE_COLORS[i % HR_ZONE_COLORS.length],
    });
    minExclusive = upper;
  }

  zones.push({
    name: `Z${zones.length + 1} >${Math.round(minExclusive)} bpm`,
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