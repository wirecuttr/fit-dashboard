import {
  distanceMetres,
  initialBearingDegrees,
  interpolateFollowPosition,
  prepareFollowRoute,
  signedBearingDeltaDegrees,
  smoothFollowBearing,
  unwrapBearingNear,
  type FollowRouteInputPoint,
} from "../src/lib/mapFollow";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertClose(actual: number | null, expected: number, tolerance: number, message: string) {
  assert(actual !== null, `${message}: expected a number`);
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}: expected ${expected} ± ${tolerance}, got ${actual}`);
  }
}

function routePoint(xMetres: number, yMetres: number, timestampMs: number): FollowRouteInputPoint {
  const metresPerDegree = 111_195;
  return {
    longitude: xMetres / metresPerDegree,
    latitude: yMetres / metresPerDegree,
    timestampMs,
  };
}

function testGeographicDistanceAndBearing() {
  const origin = routePoint(0, 0, 0);
  const east = routePoint(100, 0, 1_000);
  const north = routePoint(0, 100, 1_000);
  assertClose(distanceMetres(origin, east), 100, 0.2, "Haversine distance should preserve local metre scale");
  assertClose(initialBearingDegrees(origin, east), 90, 0.1, "eastward bearing should be 90 degrees");
  assertClose(initialBearingDegrees(origin, north), 0, 0.1, "northward bearing should be zero degrees");
}

function testBearingUnwrapAcrossNorth() {
  const wrapped = [350, 355, 359, 1, 5, 10];
  const unwrapped = [wrapped[0]];
  for (let index = 1; index < wrapped.length; index += 1) {
    unwrapped.push(unwrapBearingNear(unwrapped[index - 1], wrapped[index]));
  }
  assert(
    JSON.stringify(unwrapped) === JSON.stringify([350, 355, 359, 361, 365, 370]),
    `north crossing should unwrap continuously, got ${JSON.stringify(unwrapped)}`,
  );
  assertClose(signedBearingDeltaDegrees(350, 10), 20, 0.001, "signed delta should take the short path across north");
  assertClose(signedBearingDeltaDegrees(10, 350), -20, 0.001, "signed delta should support the counter-clockwise short path");
}

function testHairpinAndStationaryPoints() {
  const points: FollowRouteInputPoint[] = [];
  let timestampMs = 0;
  for (let x = 0; x <= 40; x += 2) points.push(routePoint(x, 0, timestampMs += 1_000));
  for (let y = 2; y <= 8; y += 2) points.push(routePoint(40, y, timestampMs += 1_000));
  for (let x = 38; x >= 0; x -= 2) points.push(routePoint(x, 8, timestampMs += 1_000));

  const prepared = prepareFollowRoute(points);
  const bearings = prepared.points
    .map((point) => point.unwrappedBearingDeg)
    .filter((bearing): bearing is number => bearing !== null);
  assert(bearings.length === points.length, "a route with sufficient displacement should have headings throughout");
  for (let index = 1; index < bearings.length; index += 1) {
    assert(Math.abs(bearings[index] - bearings[index - 1]) < 180, "hairpin headings must not contain a 180-degree wrap snap");
  }
  assert(Math.abs(bearings[bearings.length - 1] - bearings[0]) > 150, "hairpin heading should turn towards the return leg");

  const repeatedSwitchbackPoints = [...points];
  for (let y = 10; y <= 16; y += 2) repeatedSwitchbackPoints.push(routePoint(0, y, timestampMs += 1_000));
  for (let x = 2; x <= 40; x += 2) repeatedSwitchbackPoints.push(routePoint(x, 16, timestampMs += 1_000));
  const repeatedBearings = prepareFollowRoute(repeatedSwitchbackPoints).points
    .map((point) => point.unwrappedBearingDeg)
    .filter((bearing): bearing is number => bearing !== null);
  for (let index = 1; index < repeatedBearings.length; index += 1) {
    assert(Math.abs(repeatedBearings[index] - repeatedBearings[index - 1]) < 180, "repeated close switchbacks must remain route-ordered and continuous");
  }

  const stopped = prepareFollowRoute([
    routePoint(0, 0, 0),
    routePoint(10, 0, 1_000),
    routePoint(10, 0, 2_000),
    routePoint(10, 0, 3_000),
    routePoint(20, 0, 4_000),
  ]);
  for (const point of stopped.points) {
    assertClose(point.unwrappedBearingDeg, 90, 0.2, "stationary samples should retain the route heading");
  }

  const sparse = prepareFollowRoute([
    routePoint(0, 0, 0),
    routePoint(100, 0, 10_000),
  ]);
  assertClose(sparse.points[0].unwrappedBearingDeg, 90, 0.2, "a sparse route should derive its first heading");
  assertClose(sparse.points[1].unwrappedBearingDeg, 90, 0.2, "a sparse route should retain its final heading");

  const delayedMovement = prepareFollowRoute([
    routePoint(0, 0, 0),
    routePoint(0, 0, 1_000),
    routePoint(1, 0, 2_000),
    routePoint(10, 0, 3_000),
  ]);
  assertClose(delayedMovement.points.at(-1)?.unwrappedBearingDeg ?? null, 90, 0.2, "reliable movement should establish a heading after close points");
}

function testTimestampInterpolationAndAntimeridian() {
  const route = prepareFollowRoute([
    routePoint(0, 0, 0),
    routePoint(10, 0, 1_000),
    routePoint(20, 0, 2_000),
  ]);
  const midpoint = interpolateFollowPosition(route, 1_500);
  assert(midpoint, "midpoint interpolation should return a position");
  assertClose(distanceMetres(routePoint(0, 0, 0), { ...midpoint, timestampMs: 0 }), 15, 0.2, "position should interpolate by timestamp");

  const duplicateTimestamp = prepareFollowRoute([
    routePoint(0, 0, 0),
    routePoint(10, 0, 0),
    routePoint(20, 0, 1_000),
  ]);
  const exact = interpolateFollowPosition(duplicateTimestamp, 0);
  assert(exact, "duplicate timestamp lookup should return a position");
  assertClose(distanceMetres(routePoint(0, 0, 0), { ...exact, timestampMs: 0 }), 10, 0.2, "exact lookup should use the last sample at a duplicate timestamp");

  const antimeridian = prepareFollowRoute([
    { longitude: 179, latitude: 0, timestampMs: 0 },
    { longitude: -179, latitude: 0, timestampMs: 1_000 },
  ]);
  const across = interpolateFollowPosition(antimeridian, 500);
  assert(across, "antimeridian interpolation should return a position");
  assert(Math.abs(Math.abs(across.longitude) - 180) < 0.001, `antimeridian interpolation should take the short path, got ${across.longitude}`);
}

function testBearingSmoothing() {
  const acrossNorth = smoothFollowBearing(350, 10, 100, 1);
  assert(acrossNorth !== null && acrossNorth > 350 && acrossNorth < 370, "smoothing should rotate across north by the short path");

  const rateLimited = smoothFollowBearing(0, 180, 100, 1);
  assertClose(Math.abs(rateLimited ?? 0), 24, 0.001, "smoothing should enforce the 240-degree-per-second rotation cap");

  const faster = smoothFollowBearing(0, 30, 100, 16);
  const normal = smoothFollowBearing(0, 30, 100, 1);
  assert(faster !== null && normal !== null && Math.abs(faster) > Math.abs(normal), "higher playback speed should use a shorter smoothing time constant");
  assertClose(smoothFollowBearing(25, 120, 0, 1), 25, 0.001, "a duplicate frame time should retain the current bearing");
}

function testMaximumPreparedRouteSize() {
  const points = Array.from({ length: 6_000 }, (_, index) => routePoint(index * 2, Math.sin(index / 50) * 5, index * 1_000));
  const prepared = prepareFollowRoute(points);
  assert(prepared.points.length === 6_000, "the configured maximum route size should prepare without dropping valid points");
  assert(prepared.points.every((point) => Number.isFinite(point.cumulativeDistanceM)), "prepared distances should remain finite");
  assert(prepared.points.every((point, index) => (
    index === 0 || point.cumulativeDistanceM >= prepared.points[index - 1].cumulativeDistanceM
  )), "prepared cumulative distance should be monotonic");

  const stationary = prepareFollowRoute(Array.from(
    { length: 6_000 },
    (_, index) => routePoint(0, 0, index * 1_000),
  ));
  assert(stationary.points.every((point) => point.unwrappedBearingDeg === null), "a fully stationary route should not invent a heading");
}

testGeographicDistanceAndBearing();
testBearingUnwrapAcrossNorth();
testHairpinAndStationaryPoints();
testTimestampInterpolationAndAntimeridian();
testBearingSmoothing();
testMaximumPreparedRouteSize();
console.log("Map Follow tests passed");
