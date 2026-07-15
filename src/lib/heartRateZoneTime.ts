import {
  resolveHeartRateZoneIndex,
  type HeartRateZone,
  type HeartRateZoneSource,
} from "./hrZones";
import { compatibleZoneSecondsToMinutes } from "./zones";

export type HeartRateZoneSamplePoint = {
  relMs: number;
  heartRate?: number | null;
};

export type HeartRateZoneAccumulation = {
  minutes: number[];
  hasHeartRateSamples: boolean;
};

export function compatibleFitHeartRateZoneMinutes(
  source: HeartRateZoneSource | undefined,
  values: unknown,
  zoneCount: number,
): number[] | null {
  return source === "fit"
    ? compatibleZoneSecondsToMinutes(values, zoneCount)
    : null;
}

export function hasHeartRateZoneTimeData(
  zoneCount: number,
  fitZoneMinutes: readonly number[] | null,
  hasHeartRateSamples: boolean,
): boolean {
  return zoneCount > 0 && (fitZoneMinutes !== null || hasHeartRateSamples);
}

export function accumulateHeartRateZoneMinutes(
  points: readonly HeartRateZoneSamplePoint[],
  zones: HeartRateZone[],
): HeartRateZoneAccumulation {
  const minutes = zones.map(() => 0);
  const hasHeartRateSamples = points.some(
    (point) => typeof point.heartRate === "number"
      && Number.isFinite(point.heartRate)
      && point.heartRate > 0
  );

  for (let index = 0; index < points.length - 1; index += 1) {
    const point = points[index];
    const nextPoint = points[index + 1];
    const heartRate = point.heartRate;
    if (typeof heartRate !== "number" || !Number.isFinite(heartRate) || heartRate <= 0) {
      continue;
    }
    if (!Number.isFinite(point.relMs) || !Number.isFinite(nextPoint.relMs)) {
      continue;
    }

    const durationMinutes = Math.max(0, nextPoint.relMs - point.relMs) / 60000;
    const zoneIndex = resolveHeartRateZoneIndex(heartRate, zones);
    if (zoneIndex !== null) {
      minutes[zoneIndex] += durationMinutes;
    }
  }

  return { minutes, hasHeartRateSamples };
}

export type ZoneDefinition = {
  minExclusive: number;
  maxInclusive: number | null;
  color: string;
};

export type ZoneTimeRow = {
  label: string;
  range: string;
  minutes: number;
  color: string;
};

export type ZoneTimeRowMode = "fit-boundaries" | "fit-transition-zones" | "explicit-zones";

function explicitZoneTimeRows(
  zones: ZoneDefinition[],
  minutes: number[],
  unit: string,
): ZoneTimeRow[] {
  return zones.map((zone, index) => {
    let range: string;
    if (zone.maxInclusive === null) {
      range = `>${Math.round(zone.minExclusive)} ${unit}`;
    } else if (!Number.isFinite(zone.minExclusive)) {
      range = `<=${Math.round(zone.maxInclusive)} ${unit}`;
    } else {
      range = `${Math.round(zone.minExclusive + 1)}-${Math.round(zone.maxInclusive)} ${unit}`;
    }

    return {
      label: `Z${index + 1}`,
      range,
      minutes: minutes[index] ?? 0,
      color: zone.color,
    };
  });
}

export function buildZoneTimeRows(
  zones: ZoneDefinition[],
  minutes: number[],
  unit: string,
  mode: ZoneTimeRowMode = "fit-boundaries",
): ZoneTimeRow[] {
  if (mode === "explicit-zones") {
    return explicitZoneTimeRows(zones, minutes, unit);
  }

  const lowerBounds = zones
    .slice(0, -1)
    .map((zone) => zone.maxInclusive)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .map((value) => mode === "fit-transition-zones" ? value + 1 : value);

  if (lowerBounds.length >= 2 && minutes.length >= lowerBounds.length) {
    const rows: ZoneTimeRow[] = [
      {
        label: "<Z1",
        range: `<${Math.round(lowerBounds[0])} ${unit}`,
        minutes: minutes[0] ?? 0,
        color: zones[0]?.color ?? "#94a3b8",
      },
    ];

    for (let index = 1; index < lowerBounds.length - 1; index += 1) {
      rows.push({
        label: `Z${index}`,
        range: `${Math.round(lowerBounds[index - 1])}-${Math.round(lowerBounds[index] - 1)} ${unit}`,
        minutes: minutes[index] ?? 0,
        color: zones[index]?.color ?? "#94a3b8",
      });
    }

    const lastNamedZone = lowerBounds.length - 1;
    rows.push({
      label: `Z${lastNamedZone}`,
      range: `>${Math.round(lowerBounds[lastNamedZone - 1] - 1)} ${unit}`,
      minutes: minutes.slice(lastNamedZone).reduce((sum, value) => sum + value, 0),
      color: zones[lastNamedZone]?.color ?? zones[zones.length - 1]?.color ?? "#94a3b8",
    });

    return rows;
  }

  return explicitZoneTimeRows(zones, minutes, unit);
}
