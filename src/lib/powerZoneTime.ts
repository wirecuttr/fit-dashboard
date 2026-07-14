import { resolveNumericZoneIndex, type NumericZone } from "./zones";

export type PowerZoneTelemetryPoint = {
  relMs: number;
  power?: number | null;
};

export type CalculatedPowerZoneTime = {
  minutes: number[];
  hasPowerSamples: boolean;
};

export function calculatePowerZoneTime(
  points: PowerZoneTelemetryPoint[],
  zones: NumericZone[],
): CalculatedPowerZoneTime {
  const seconds = zones.map(() => 0);
  let hasPowerSamples = false;

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const power = point.power;
    if (typeof power !== "number" || !Number.isFinite(power) || power < 0) continue;

    hasPowerSamples = hasPowerSamples || power > 0;
    if (index >= points.length - 1 || zones.length === 0) continue;

    const nextRelMs = points[index + 1].relMs;
    if (!Number.isFinite(point.relMs) || !Number.isFinite(nextRelMs)) continue;
    const intervalSeconds = Math.max(0, nextRelMs - point.relMs) / 1000;
    const zoneIndex = resolveNumericZoneIndex(power, zones);
    if (zoneIndex >= 0) seconds[zoneIndex] += intervalSeconds;
  }

  return {
    minutes: seconds.map((value) => value / 60),
    hasPowerSamples,
  };
}
