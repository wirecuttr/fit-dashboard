import {
  HIDDEN_ROUTE_COLOR,
  MISSING_ROUTE_METRIC_COLOR,
  buildRouteDisplayGeoJson,
  buildRouteLineGradient,
  buildRevealedRouteGeoJson,
  buildRouteSegmentColors,
  type PathColorMode,
} from "../src/lib/mapRouteColor";
import type { RecordPoint } from "../src/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function record(timestampMs: number, values: Partial<RecordPoint>): RecordPoint {
  return { timestamp_ms: timestampMs, ...values };
}

function testColoursRemainStableAsRouteIsRevealed() {
  const records = [
    record(0, { speed_m_s: 1, heart_rate: 100, cadence: 50, altitude_m: 100, power: 100, temperature_c: 10 }),
    record(1_000, { speed_m_s: 2, heart_rate: 120, cadence: 70, altitude_m: 150, power: 200, temperature_c: 15 }),
    record(2_000, { speed_m_s: 4, heart_rate: 180, cadence: 100, altitude_m: 250, power: 400, temperature_c: 30 }),
    record(3_000, { speed_m_s: 0.5, heart_rate: 80, cadence: 40, altitude_m: 50, power: 50, temperature_c: 5 }),
  ];
  const modes: PathColorMode[] = ["speed", "heart_rate", "cadence", "altitude", "power", "temperature", "time"];

  for (const mode of modes) {
    const fullColours = buildRouteSegmentColors(records, records, mode, "#d65252");
    const visibleRecords = records.slice(0, 2);
    const prefixColours = buildRouteSegmentColors(visibleRecords, records, mode, "#d65252");
    assertEqual(prefixColours[0], fullColours[0], `${mode} should retain the first segment colour`);
    assertEqual(prefixColours[1], fullColours[1], `${mode} should retain the second segment colour`);

    const prefixScaledToItself = buildRouteSegmentColors(visibleRecords, visibleRecords, mode, "#d65252");
    assert(
      prefixScaledToItself[1] !== fullColours[1],
      `${mode} test data should detect prefix-based colour rescaling`,
    );
  }
}

function testMissingValuesDoNotChangeTheScale() {
  const records = [
    record(0, {}),
    record(1_000, { heart_rate: 100 }),
    record(2_000, { heart_rate: 200 }),
  ];
  const colours = buildRouteSegmentColors(records, records, "heart_rate", "#d65252");
  assertEqual(colours[0], MISSING_ROUTE_METRIC_COLOR, "missing data should use the neutral route colour");
  assertEqual(colours[1], "rgb(0,100,200)", "the lowest available value should start the scale");
  assertEqual(colours[2], "rgb(240,70,70)", "the highest available value should end the scale");
}

function testSolidColourIsUnchanged() {
  const records = [record(0, {}), record(1_000, {})];
  const colours = buildRouteSegmentColors(records, records, "solid", "#d65252");
  assertEqual(colours[0], "#d65252", "solid mode should retain its configured colour");
  assertEqual(colours[1], "#d65252", "solid mode should retain its configured colour throughout");
}

function testDisplayRouteUsesOneCompleteContinuousFeature() {
  const coordinates = [[-114.0, 51.0], [-114.001, 51.001], [-114.002, 51.0]];
  const route = buildRouteDisplayGeoJson(coordinates);

  assertEqual(route.features.length, 1, "the display route should use one feature");
  assertEqual(route.features[0].geometry.type, "LineString", "the display route should be a LineString");
  assertEqual(
    route.features[0].geometry.coordinates.length,
    coordinates.length,
    "the display LineString should retain the complete route",
  );
}

function testRevealedRouteExcludesUnplayedCoordinates() {
  const coordinates = [[0, 0], [0.001, 0], [0.002, 0], [0.003, 0]];
  const route = buildRevealedRouteGeoJson(coordinates, 1);

  assertEqual(route.features.length, 1, "the revealed route should remain one continuous feature");
  assertEqual(
    route.features[0].geometry.coordinates.length,
    2,
    "the revealed route should exclude unplayed coordinates",
  );
  assertEqual(route.features[0].geometry.coordinates[1][0], 0.001, "the revealed route should end at the playhead");
}

function testGradientStopsFollowMapLibreRouteDistance() {
  const coordinates = [[0, 0], [0.001, 0], [0.003, 0]];
  const gradient = buildRouteLineGradient(
    coordinates,
    ["#111111", "#222222", "#333333"],
    "#d65252",
  );

  assert(Array.isArray(gradient), "different segment colours should produce a gradient expression");
  assertEqual(gradient[0], "step", "the route gradient should preserve discrete segment colours");
  assertEqual(gradient[2], "#111111", "the first segment colour should start the gradient");
  const secondSegmentStop = Number(gradient[3]);
  assert(
    secondSegmentStop > 0.32 && secondSegmentStop < 0.34,
    "gradient stops should follow MapLibre's projected route distance",
  );
  assertEqual(gradient[4], "#222222", "the second segment colour should follow its distance stop");
}

function testPlaybackCutoffKeepsTheFullGradientDomain() {
  const coordinates = [[0, 0], [0.001, 0], [0.002, 0], [0.003, 0]];
  const colours = ["#111111", "#222222", "#333333", "#444444"];
  const fullGradient = buildRouteLineGradient(coordinates, colours, "#d65252");
  const partialGradient = buildRouteLineGradient(coordinates, colours, "#d65252", 2);

  assert(Array.isArray(fullGradient), "the full route should produce a gradient expression");
  assert(Array.isArray(partialGradient), "the partial route should produce a cutoff expression");
  assertEqual(partialGradient[2], fullGradient[2], "the first revealed colour should remain stable");
  assertEqual(partialGradient[3], fullGradient[3], "the first colour stop should retain full-route progress");
  assertEqual(partialGradient[4], fullGradient[4], "the next revealed colour should remain stable");
  assertEqual(partialGradient[5], fullGradient[5], "the cutoff should retain full-route progress");
  assertEqual(partialGradient[6], HIDDEN_ROUTE_COLOR, "the unplayed tail should be transparent");
}

function testSolidRouteUsesOneConstantGradientColour() {
  const gradient = buildRouteLineGradient(
    [[0, 0], [0.001, 0], [0.002, 0]],
    ["#d65252", "#d65252", "#d65252"],
    "#d65252",
  );
  assertEqual(gradient, "#d65252", "a fully revealed solid route should use one constant-colour stroke");
}

testColoursRemainStableAsRouteIsRevealed();
testMissingValuesDoNotChangeTheScale();
testSolidColourIsUnchanged();
testDisplayRouteUsesOneCompleteContinuousFeature();
testRevealedRouteExcludesUnplayedCoordinates();
testGradientStopsFollowMapLibreRouteDistance();
testPlaybackCutoffKeepsTheFullGradientDomain();
testSolidRouteUsesOneConstantGradientColour();

console.log("Map route colour tests passed");
