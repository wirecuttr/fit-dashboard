import {
  buildHeartRateDriftChartData,
  calculateCardiacDecoupling,
  describeCardiacDecouplingBand,
  type CardiacDecouplingModeResult,
} from "../src/lib/cardiacDecoupling";
import type { Activity, RecordPoint } from "../src/types";

type RecordOptions = {
  durationS?: number;
  intervalS?: number;
  heartRate?: (elapsedS: number) => number | undefined;
  power?: (elapsedS: number) => number | undefined;
  speed?: (elapsedS: number) => number | undefined;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function activity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: 1,
    file_name: "activity.fit",
    activity_name: "Activity",
    sport: "running",
    device: "Test Device",
    start_ts_utc: "2026-01-01T00:00:00Z",
    end_ts_utc: "2026-01-01T01:15:00Z",
    duration_s: 75 * 60,
    distance_m: 0,
    metadata_json: "{}",
    ...overrides,
  };
}

function records({
  durationS = 75 * 60,
  intervalS = 1,
  heartRate = () => 130,
  power,
  speed,
}: RecordOptions = {}): RecordPoint[] {
  const rows: RecordPoint[] = [];
  let distanceM = 0;
  let lastElapsedS = 0;

  for (let elapsedS = 0; elapsedS <= durationS; elapsedS += intervalS) {
    const previousSpeed = speed?.(lastElapsedS);
    if (elapsedS > 0 && typeof previousSpeed === "number" && Number.isFinite(previousSpeed)) {
      distanceM += previousSpeed * (elapsedS - lastElapsedS);
    }

    const row: RecordPoint = { timestamp_ms: elapsedS * 1000 };
    const hr = heartRate(elapsedS);
    const watts = power?.(elapsedS);
    const speedMps = speed?.(elapsedS);
    if (typeof hr === "number") row.heart_rate = hr;
    if (typeof watts === "number") row.power = watts;
    if (typeof speedMps === "number") {
      row.speed_m_s = speedMps;
      row.distance_m = distanceM;
    }

    rows.push(row);
    lastElapsedS = elapsedS;
  }

  return rows;
}

function resultFor(result: ReturnType<typeof calculateCardiacDecoupling>, mode: CardiacDecouplingModeResult["mode"]): CardiacDecouplingModeResult {
  const modeResult = result.results.find((candidate) => candidate.mode === mode);
  assert(modeResult, `missing ${mode} result`);
  return modeResult;
}

function testEligibilityIgnoresEditableNames() {
  const result = calculateCardiacDecoupling(
    activity({ sport: "unknown", activity_name: "Morning Run", file_name: "bike_ride.fit" }),
    records({ speed: () => 3 }),
  );

  assertEqual(result.available, false, "unknown sport should remain unavailable despite name/file text");
  assertEqual(result.reason, "unsupported_activity_type", "unsupported reason should come from structured type");
}

function testShortStreamGapIsBridged() {
  const result = calculateCardiacDecoupling(
    activity({ sport: "running" }),
    records({
      speed: () => 3,
      heartRate: (elapsedS) => (elapsedS >= 1800 && elapsedS <= 1802 ? undefined : 130),
    }),
  );

  assert(result.available, "short HR sample gap should be bridged");
  const speedResult = resultFor(result, "speed");
  assert(speedResult.available, "speed result should remain available");
  assert((speedResult.firstHalfHrCoveragePct ?? 0) > 99.9, "bridged HR gap should not reduce first-half HR coverage");
}

function testMissingCyclingPowerReason() {
  const result = calculateCardiacDecoupling(
    activity({ sport: "cycling" }),
    records({ heartRate: () => 130 }),
  );

  const normalizedPowerResult = resultFor(result, "normalized_power");
  assertEqual(normalizedPowerResult.available, false, "normalized power should be unavailable without power");
  assertEqual(normalizedPowerResult.reason, "missing_power", "missing power should be reported distinctly");
  assertEqual(result.reason, "missing_power", "top-level cycling failure should surface missing power first");
}

function testConstantOutputChartIsHrOnly() {
  const elliptical = activity({
    sport: "fitness_equipment",
    metadata_json: JSON.stringify({ sub_sport: "elliptical" }),
  });
  const result = calculateCardiacDecoupling(
    elliptical,
    records({ heartRate: (elapsedS) => (elapsedS < 2400 ? 132 : 140) }),
  );

  assert(result.available, "constant-output machine should produce an HR-only result");
  const constantResult = resultFor(result, "constant_output_hr");
  assert(constantResult.available, "constant-output mode should be available");

  const chart = buildHeartRateDriftChartData(records({ heartRate: (elapsedS) => (elapsedS < 2400 ? 132 : 140) }), result, constantResult);
  assert(chart, "constant-output mode should still build chart data");
  assertEqual(chart.outputMode, undefined, "constant-output chart should not have an output mode");
  assertEqual(chart.output.length, 0, "constant-output chart should be HR-only");
  assert(chart.heartRate.length > 0, "constant-output chart should include HR data");
}

function testNegativeDriftBandIsNotHigh() {
  assertEqual(describeCardiacDecouplingBand(-12), "low", "negative drift should not be classified as high drift");
}

const tests = [
  testEligibilityIgnoresEditableNames,
  testShortStreamGapIsBridged,
  testMissingCyclingPowerReason,
  testConstantOutputChartIsHrOnly,
  testNegativeDriftBandIsNotHigh,
];

for (const test of tests) {
  test();
}

console.log(`cardiac decoupling tests passed (${tests.length})`);
