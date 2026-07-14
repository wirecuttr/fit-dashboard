import type { RecordPoint } from "../types";

export type PathColorMode = "solid" | "speed" | "heart_rate" | "cadence" | "altitude" | "power" | "temperature" | "time";

export const MISSING_ROUTE_METRIC_COLOR = "#9ca3af";
export const HIDDEN_ROUTE_COLOR = "rgba(0,0,0,0)";

export type RouteLineGradient = string | unknown[];

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

function projectCoordinate(coordinate: number[]): [number, number] | null {
  const longitude = coordinate[0];
  const latitude = coordinate[1];
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;

  const sinLatitude = Math.sin(latitude * Math.PI / 180);
  const x = longitude / 360 + 0.5;
  const rawY = 0.5 - 0.25 * Math.log((1 + sinLatitude) / (1 - sinLatitude)) / Math.PI;
  return [x, Math.max(0, Math.min(1, rawY))];
}

function coordinateDistance(start: number[], end: number[]): number {
  const projectedStart = projectCoordinate(start);
  const projectedEnd = projectCoordinate(end);
  if (!projectedStart || !projectedEnd) return 0;
  return Math.hypot(
    projectedEnd[0] - projectedStart[0],
    projectedEnd[1] - projectedStart[1],
  );
}

export function buildRouteDisplayGeoJson(
  coordinates: number[][],
): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  if (coordinates.length < 2) {
    return { type: "FeatureCollection", features: [] };
  }
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "LineString", coordinates },
      properties: {},
    }],
  };
}

function buildSteppedRouteGradient(
  coordinates: number[][],
  colorForSegment: (index: number) => string,
  revealedEndIndex: number,
  hiddenColor: string,
): RouteLineGradient {
  if (coordinates.length < 2) return hiddenColor;

  const segments: Array<{ index: number; startDistance: number; color: string }> = [];
  const cumulativeDistances = [0];
  let totalDistance = 0;
  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const distance = coordinateDistance(coordinates[index], coordinates[index + 1]);
    if (distance > 0) {
      segments.push({
        index,
        startDistance: totalDistance,
        color: colorForSegment(index),
      });
    }
    totalDistance += distance;
    cumulativeDistances.push(totalDistance);
  }

  if (!segments.length || totalDistance <= 0) return hiddenColor;

  const clampedEndIndex = Math.max(0, Math.min(coordinates.length - 1, revealedEndIndex));
  const revealedDistance = cumulativeDistances[clampedEndIndex] ?? 0;
  if (revealedDistance <= 0) return hiddenColor;

  const visibleSegments = segments.filter((segment) => segment.index < clampedEndIndex);
  if (!visibleSegments.length) return hiddenColor;

  const firstColor = visibleSegments[0].color;
  const gradient: unknown[] = ["step", ["line-progress"], firstColor];
  let previousColor = firstColor;
  let previousStop = 0;

  for (let index = 1; index < visibleSegments.length; index += 1) {
    const segment = visibleSegments[index];
    const stop = segment.startDistance / totalDistance;
    if (stop <= previousStop || stop >= 1 || segment.color === previousColor) continue;
    gradient.push(stop, segment.color);
    previousStop = stop;
    previousColor = segment.color;
  }

  if (revealedDistance < totalDistance) {
    const cutoff = revealedDistance / totalDistance;
    if (cutoff > previousStop && cutoff < 1) gradient.push(cutoff, hiddenColor);
  }

  return gradient.length > 3 ? gradient : firstColor;
}

/**
 * Build a stepped MapLibre line gradient for one continuous route feature.
 * Stops use the same Web Mercator distance calculation as MapLibre's GeoJSON
 * tiler. The complete route remains the gradient domain while playback hides
 * the unrevealed tail with a transparent cutoff.
 */
export function buildRouteLineGradient(
  coordinates: number[][],
  segmentColors: string[],
  fallbackColor: string,
  revealedEndIndex = coordinates.length - 1,
  hiddenColor = HIDDEN_ROUTE_COLOR,
): RouteLineGradient {
  return buildSteppedRouteGradient(
    coordinates,
    (index) => segmentColors[index] ?? fallbackColor,
    revealedEndIndex,
    hiddenColor,
  );
}

export function buildRouteRevealGradient(
  coordinates: number[][],
  revealedEndIndex: number,
  visibleColor: string,
  hiddenColor = HIDDEN_ROUTE_COLOR,
): RouteLineGradient {
  return buildSteppedRouteGradient(
    coordinates,
    () => visibleColor,
    revealedEndIndex,
    hiddenColor,
  );
}
