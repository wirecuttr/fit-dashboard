import {
  MISSING_ROUTE_METRIC_COLOR,
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

testColoursRemainStableAsRouteIsRevealed();
testMissingValuesDoNotChangeTheScale();
testSolidColourIsUnchanged();

console.log("Map route colour tests passed");
