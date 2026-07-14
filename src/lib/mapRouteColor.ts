import type { RecordPoint } from "../types";

export type PathColorMode = "solid" | "speed" | "heart_rate" | "cadence" | "altitude" | "power" | "temperature" | "time";

export const MISSING_ROUTE_METRIC_COLOR = "#9ca3af";

function finiteNumber(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function valueToColor(t: number): string {
  const stops: [number, number, number][] = [
    [0, 100, 200], [0, 185, 225], [16, 185, 129], [250, 170, 30], [240, 70, 70],
  ];
  const s = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const lo = Math.max(0, Math.min(Math.floor(s), stops.length - 2));
  const hi = lo + 1;
  const f = s - lo;
  return `rgb(${Math.round(stops[lo][0] + (stops[hi][0] - stops[lo][0]) * f)},${Math.round(stops[lo][1] + (stops[hi][1] - stops[lo][1]) * f)},${Math.round(stops[lo][2] + (stops[hi][2] - stops[lo][2]) * f)})`;
}

export function getRouteMetricValues(recs: RecordPoint[], mode: PathColorMode): Array<number | null> {
  switch (mode) {
    case "speed": return recs.map((record, index) => {
      const speedMps = finiteNumber(record.speed_m_s);
      if (speedMps !== null && speedMps > 0) return speedMps * 3.6;

      const previous = index > 0 ? recs[index - 1] : undefined;
      const distance = finiteNumber(record.distance_m);
      const previousDistance = finiteNumber(previous?.distance_m);
      const elapsedSeconds = previous ? (record.timestamp_ms - previous.timestamp_ms) / 1000 : 0;
      if (distance !== null && previousDistance !== null && elapsedSeconds > 0) {
        return Math.max(0, ((distance - previousDistance) / elapsedSeconds) * 3.6);
      }
      return speedMps === null ? null : Math.max(0, speedMps * 3.6);
    });
    case "heart_rate": return recs.map((record) => finiteNumber(record.heart_rate));
    case "cadence": return recs.map((record) => finiteNumber(record.cadence));
    case "altitude": return recs.map((record) => finiteNumber(record.altitude_m));
    case "power": return recs.map((record) => finiteNumber(record.power));
    case "temperature": return recs.map((record) => finiteNumber(record.temperature_c));
    case "time": return recs.map((_, index) => index);
    default: return recs.map(() => null);
  }
}

export function buildRouteSegmentColors(
  segmentRecords: RecordPoint[],
  scaleRecords: RecordPoint[],
  mode: PathColorMode,
  solidColor: string,
  missingColor = MISSING_ROUTE_METRIC_COLOR,
): string[] {
  if (mode === "solid") return segmentRecords.map(() => solidColor);

  const values = getRouteMetricValues(segmentRecords, mode);
  const scaleValues = getRouteMetricValues(scaleRecords, mode)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  if (!scaleValues.length) return segmentRecords.map(() => missingColor);

  const min = Math.min(...scaleValues);
  const max = Math.max(...scaleValues);
  const range = (max - min) || 1;
  return values.map((value) => (
    value === null || !Number.isFinite(value)
      ? missingColor
      : valueToColor((value - min) / range)
  ));
}
