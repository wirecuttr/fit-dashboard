const EARTH_RADIUS_M = 6_371_008.8;
const MIN_HEADING_DISPLACEMENT_M = 5;
const CURVATURE_WINDOW_M = 30;
const LOOKBEHIND_M = 3;

export type FollowRouteInputPoint = {
  longitude: number;
  latitude: number;
  timestampMs: number;
};

export type PreparedFollowPoint = FollowRouteInputPoint & {
  cumulativeDistanceM: number;
  unwrappedBearingDeg: number | null;
};

export type PreparedFollowRoute = {
  points: PreparedFollowPoint[];
};

export type InterpolatedFollowPosition = {
  longitude: number;
  latitude: number;
  bearingDeg: number | null;
};

function toRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function toDegrees(radians: number): number {
  return radians * 180 / Math.PI;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function normaliseBearingDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

export function signedBearingDeltaDegrees(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

export function unwrapBearingNear(reference: number, bearing: number): number {
  return reference + signedBearingDeltaDegrees(reference, bearing);
}

export function distanceMetres(a: FollowRouteInputPoint, b: FollowRouteInputPoint): number {
  const latitude1 = toRadians(a.latitude);
  const latitude2 = toRadians(b.latitude);
  const deltaLatitude = latitude2 - latitude1;
  const deltaLongitude = toRadians(b.longitude - a.longitude);
  const haversine = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(deltaLongitude / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(clamp(haversine, 0, 1)));
}

export function initialBearingDegrees(a: FollowRouteInputPoint, b: FollowRouteInputPoint): number | null {
  if (distanceMetres(a, b) < 0.01) return null;

  const latitude1 = toRadians(a.latitude);
  const latitude2 = toRadians(b.latitude);
  const deltaLongitude = toRadians(b.longitude - a.longitude);
  const y = Math.sin(deltaLongitude) * Math.cos(latitude2);
  const x = Math.cos(latitude1) * Math.sin(latitude2)
    - Math.sin(latitude1) * Math.cos(latitude2) * Math.cos(deltaLongitude);
  return normaliseBearingDegrees(toDegrees(Math.atan2(y, x)));
}

function firstIndexAtOrAfterDistance(distances: number[], target: number): number {
  let low = 0;
  let high = distances.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (distances[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function lastIndexAtOrBeforeDistance(distances: number[], target: number): number {
  let low = 0;
  let high = distances.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (distances[middle] <= target) low = middle;
    else high = middle - 1;
  }
  return low;
}

function routeBearing(
  points: FollowRouteInputPoint[],
  distances: number[],
  index: number,
  lookbehindM: number,
  lookaheadM: number,
): number | null {
  const currentDistance = distances[index];
  let beforeIndex = Math.min(
    index,
    lastIndexAtOrBeforeDistance(distances, Math.max(0, currentDistance - lookbehindM)),
  );
  let afterIndex = Math.max(
    index,
    firstIndexAtOrAfterDistance(
      distances,
      Math.min(distances[distances.length - 1], currentDistance + lookaheadM),
    ),
  );

  if (beforeIndex === afterIndex) {
    if (afterIndex < points.length - 1) afterIndex += 1;
    else if (beforeIndex > 0) beforeIndex -= 1;
  }

  let displacement = distanceMetres(points[beforeIndex], points[afterIndex]);
  while (displacement < MIN_HEADING_DISPLACEMENT_M
    && (beforeIndex > 0 || afterIndex < points.length - 1)) {
    const previousIndex = distances[beforeIndex] > 0
      ? lastIndexAtOrBeforeDistance(distances, distances[beforeIndex] - 0.000_001)
      : -1;
    const nextIndex = distances[afterIndex] < distances[distances.length - 1]
      ? firstIndexAtOrAfterDistance(distances, distances[afterIndex] + 0.000_001)
      : -1;
    const previousDistance = previousIndex >= 0
      ? currentDistance - distances[previousIndex]
      : Number.POSITIVE_INFINITY;
    const nextDistance = nextIndex >= 0
      ? distances[nextIndex] - currentDistance
      : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(previousDistance) && !Number.isFinite(nextDistance)) break;
    if (nextDistance <= previousDistance) afterIndex = nextIndex;
    else beforeIndex = previousIndex;
    displacement = distanceMetres(points[beforeIndex], points[afterIndex]);
  }

  if (displacement < MIN_HEADING_DISPLACEMENT_M) return null;
  return initialBearingDegrees(points[beforeIndex], points[afterIndex]);
}

export function prepareFollowRoute(inputPoints: FollowRouteInputPoint[]): PreparedFollowRoute {
  const points = inputPoints.filter((point) => (
    Number.isFinite(point.longitude)
    && Number.isFinite(point.latitude)
    && Number.isFinite(point.timestampMs)
  ));
  if (points.length === 0) return { points: [] };

  const distances = new Array<number>(points.length).fill(0);
  for (let index = 1; index < points.length; index += 1) {
    distances[index] = distances[index - 1] + distanceMetres(points[index - 1], points[index]);
  }
  if (distances[distances.length - 1] < MIN_HEADING_DISPLACEMENT_M) {
    return {
      points: points.map((point, index) => ({
        ...point,
        cumulativeDistanceM: distances[index],
        unwrappedBearingDeg: null,
      })),
    };
  }

  const baseBearings = points.map((_, index) => routeBearing(points, distances, index, 5, 5));
  const bearings: Array<number | null> = [];
  let previousBearing: number | null = null;

  for (let index = 0; index < points.length; index += 1) {
    const futureIndex = firstIndexAtOrAfterDistance(
      distances,
      Math.min(distances[distances.length - 1], distances[index] + CURVATURE_WINDOW_M),
    );
    const currentBase = baseBearings[index];
    const futureBase = baseBearings[futureIndex];
    const headingChange = currentBase === null || futureBase === null
      ? 0
      : Math.abs(signedBearingDeltaDegrees(currentBase, futureBase));
    const lookaheadM = headingChange >= 60 ? 6 : headingChange >= 30 ? 12 : 25;
    const bearing = routeBearing(points, distances, index, LOOKBEHIND_M, lookaheadM);

    if (bearing === null) {
      bearings.push(previousBearing);
      continue;
    }
    const unwrapped: number = previousBearing === null ? bearing : unwrapBearingNear(previousBearing, bearing);
    bearings.push(unwrapped);
    previousBearing = unwrapped;
  }

  return {
    points: points.map((point, index) => ({
      ...point,
      cumulativeDistanceM: distances[index],
      unwrappedBearingDeg: bearings[index],
    })),
  };
}

function shortestLongitudeDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

function normaliseLongitude(longitude: number): number {
  return ((longitude + 540) % 360) - 180;
}

export function interpolateFollowPosition(
  route: PreparedFollowRoute,
  timestampMs: number,
): InterpolatedFollowPosition | null {
  const { points } = route;
  if (points.length === 0) return null;
  if (timestampMs < points[0].timestampMs) {
    return {
      longitude: points[0].longitude,
      latitude: points[0].latitude,
      bearingDeg: points[0].unwrappedBearingDeg,
    };
  }
  const lastPoint = points[points.length - 1];
  if (timestampMs >= lastPoint.timestampMs) {
    return {
      longitude: lastPoint.longitude,
      latitude: lastPoint.latitude,
      bearingDeg: lastPoint.unwrappedBearingDeg,
    };
  }

  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (points[middle].timestampMs <= timestampMs) low = middle;
    else high = middle - 1;
  }

  const before = points[low];
  const after = points[Math.min(low + 1, points.length - 1)];
  const durationMs = after.timestampMs - before.timestampMs;
  const progress = durationMs > 0 ? clamp((timestampMs - before.timestampMs) / durationMs, 0, 1) : 0;
  const beforeBearing = before.unwrappedBearingDeg;
  const afterBearing = after.unwrappedBearingDeg;
  const bearingDeg = beforeBearing === null
    ? afterBearing
    : afterBearing === null
      ? beforeBearing
      : beforeBearing + (afterBearing - beforeBearing) * progress;

  return {
    longitude: normaliseLongitude(before.longitude + shortestLongitudeDelta(before.longitude, after.longitude) * progress),
    latitude: before.latitude + (after.latitude - before.latitude) * progress,
    bearingDeg,
  };
}

export function smoothFollowBearing(
  currentBearingDeg: number | null,
  targetBearingDeg: number | null,
  elapsedMs: number,
  playbackSpeed: number,
): number | null {
  if (targetBearingDeg === null) return currentBearingDeg;
  if (currentBearingDeg === null) return targetBearingDeg;
  if (elapsedMs <= 0) return currentBearingDeg;

  const boundedElapsedMs = Math.min(elapsedMs, 250);
  const timeConstantMs = Math.max(80, 300 / Math.sqrt(Math.max(1, playbackSpeed)));
  const alpha = 1 - Math.exp(-boundedElapsedMs / timeConstantMs);
  const target = unwrapBearingNear(currentBearingDeg, targetBearingDeg);
  const desiredChange = (target - currentBearingDeg) * alpha;
  const maximumChange = 240 * boundedElapsedMs / 1000;
  return currentBearingDeg + clamp(desiredChange, -maximumChange, maximumChange);
}
