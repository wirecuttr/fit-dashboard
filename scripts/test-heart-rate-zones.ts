import {
  buildHeartRateZones,
  resolveHeartRateZoneSelection,
  validateManualHeartRateZoneBounds,
} from "../src/lib/hrZones";
import {
  accumulateHeartRateZoneMinutes,
  buildZoneTimeRows,
  compatibleFitHeartRateZoneMinutes,
  hasHeartRateZoneTimeData,
} from "../src/lib/heartRateZoneTime";
import { buildTelemetryPoints } from "../src/lib/telemetryAxis";
import { compatibleZoneSecondsToMinutes } from "../src/lib/zones";
import type { RecordPoint } from "../src/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertArrayEqual(actual: number[] | null, expected: number[], message: string) {
  assert(actual, `${message}: expected an array`);
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

function testBoundaryValidation() {
  assert(validateManualHeartRateZoneBounds([40, 45, 50, 260]), "inclusive 40-260 bpm limits should be valid");
  assert(validateManualHeartRateZoneBounds([75, 95, 120, 150]), "default bounds should be valid");
  assert(!validateManualHeartRateZoneBounds([39, 95, 120, 150]), "values below 40 bpm should be rejected");
  assert(!validateManualHeartRateZoneBounds([75, 95, 120, 261]), "values above 260 bpm should be rejected");
  assert(!validateManualHeartRateZoneBounds([75, 79, 120, 150]), "adjacent bounds less than 5 bpm apart should be rejected");
  assert(!validateManualHeartRateZoneBounds([75, 95, 120]), "exactly four boundaries should be required");
}

function testPolicySelection() {
  const fit = [100, 120, 140, 160];
  const manual = [75, 95, 120, 150];

  const fallbackWithFit = resolveHeartRateZoneSelection(fit, manual, "fallback");
  assertEqual(fallbackWithFit.source, "fit", "fallback should prefer FIT bounds");
  assertArrayEqual(fallbackWithFit.boundsBpm, fit, "fallback should return FIT bounds");

  const fallbackWithoutFit = resolveHeartRateZoneSelection(undefined, manual, "fallback");
  assertEqual(fallbackWithoutFit.source, "manual", "fallback should use manual bounds when FIT bounds are absent");
  assertArrayEqual(fallbackWithoutFit.boundsBpm, manual, "fallback should return manual bounds without FIT data");

  const alwaysWithFit = resolveHeartRateZoneSelection(fit, manual, "always");
  assertEqual(alwaysWithFit.source, "manual", "always should override FIT bounds");
  assertArrayEqual(alwaysWithFit.boundsBpm, manual, "always should return manual bounds");

  const alwaysWithoutFit = resolveHeartRateZoneSelection(undefined, manual, "always");
  assertEqual(alwaysWithoutFit.source, "manual", "always should use manual bounds without FIT data");
  assertArrayEqual(alwaysWithoutFit.boundsBpm, manual, "always should return manual bounds without FIT data");
}

function testCompatibleFitBuckets() {
  assertArrayEqual(
    compatibleZoneSecondsToMinutes([60, 120, 0, 30, 90], 5),
    [1, 2, 0, 0.5, 1.5],
    "matching non-negative FIT buckets should convert to minutes",
  );
  assertEqual(compatibleZoneSecondsToMinutes([60, 120, 30, 90], 5), null, "bucket-count mismatches should be rejected");
  assertEqual(compatibleZoneSecondsToMinutes([0, 0, 0, 0, 0], 5), null, "empty FIT totals should be rejected");
  assertEqual(compatibleZoneSecondsToMinutes([60, -1, 0, 30, 90], 5), null, "negative FIT totals should be rejected");
  assertEqual(compatibleZoneSecondsToMinutes([60, Number.NaN, 0, 30, 90], 5), null, "non-finite FIT totals should be rejected");
  assertEqual(compatibleZoneSecondsToMinutes([60, null, 0, 30, 90], 5), null, "null FIT totals should be rejected");
  assertEqual(compatibleZoneSecondsToMinutes([60, false, 0, 30, 90], 5), null, "boolean FIT totals should be rejected");
  assertEqual(compatibleZoneSecondsToMinutes([60, "120", 0, 30, 90], 5), null, "string FIT totals should be rejected");
  assertEqual(compatibleZoneSecondsToMinutes([60, "", 0, 30, 90], 5), null, "empty-string FIT totals should be rejected");
}

function testManualSourceIgnoresFitBuckets() {
  const fitBuckets = [60, 120, 180, 240, 300];
  assertEqual(
    compatibleFitHeartRateZoneMinutes("manual", fitBuckets, 5),
    null,
    "manual zones should ignore FIT time-in-zone totals",
  );
  assertArrayEqual(
    compatibleFitHeartRateZoneMinutes("fit", fitBuckets, 5),
    [1, 2, 3, 4, 5],
    "FIT zones should retain compatible FIT time-in-zone totals",
  );
}

function testManualZoneRowsRemainOneToOne() {
  const zones = buildHeartRateZones([75, 95, 120, 150]);
  const rows = buildZoneTimeRows(zones, [1, 2, 3, 4, 5], "bpm", "explicit-zones");

  assertEqual(rows.length, 5, "manual zones should render five rows");
  assertEqual(
    JSON.stringify(rows.map((row) => row.label)),
    JSON.stringify(["Z1", "Z2", "Z3", "Z4", "Z5"]),
    "manual rows should keep Z1-Z5 labels",
  );
  assertEqual(
    JSON.stringify(rows.map((row) => row.range)),
    JSON.stringify(["<=75 bpm", "76-95 bpm", "96-120 bpm", "121-150 bpm", ">150 bpm"]),
    "manual rows should show their configured ranges",
  );
  assertEqual(
    JSON.stringify(rows.map((row) => row.minutes)),
    JSON.stringify([1, 2, 3, 4, 5]),
    "manual row durations should not be shifted or combined",
  );

  const fitRows = buildZoneTimeRows(zones, [1, 2, 3, 4, 5], "bpm");
  assertEqual(fitRows.length, 4, "FIT-boundary presentation should remain unchanged");
  assertEqual(fitRows[0].label, "<Z1", "FIT-boundary presentation should retain its first label");
  assertEqual(fitRows[3].minutes, 9, "FIT-boundary presentation should retain its combined upper bucket");
}

function testActiveTimeZoneAccumulation() {
  const startTimestampMs = Date.parse("2026-01-01T00:00:00Z");
  const records: RecordPoint[] = [
    { timestamp_ms: startTimestampMs, heart_rate: 80 },
    { timestamp_ms: startTimestampMs + 1_000, heart_rate: 100 },
    { timestamp_ms: startTimestampMs + 2_000, heart_rate: 120 },
    { timestamp_ms: startTimestampMs + 5_000, heart_rate: 130 },
    { timestamp_ms: startTimestampMs + 6_000, heart_rate: 160 },
  ];
  const points = buildTelemetryPoints(records, startTimestampMs, "time", "km", {
    active_time_supported: true,
    intervals_reliable: true,
    stopped_intervals: [{
      start_ts_utc: new Date(startTimestampMs + 2_000).toISOString(),
      end_ts_utc: new Date(startTimestampMs + 5_000).toISOString(),
    }],
  });
  const result = accumulateHeartRateZoneMinutes(
    points.map((point) => ({ relMs: point.relMs, heartRate: point.record.heart_rate })),
    buildHeartRateZones([90, 110, 140, 160]),
  );

  assertEqual(points.length, 4, "records inside a reliable stopped interval should be excluded");
  assertEqual(
    JSON.stringify(points.map((point) => point.relMs)),
    JSON.stringify([0, 1_000, 2_000, 3_000]),
    "active timestamps should exclude stopped duration",
  );
  assertEqual(result.hasHeartRateSamples, true, "valid heart-rate samples should be detected");
  assertEqual(
    JSON.stringify(result.minutes),
    JSON.stringify([1 / 60, 1 / 60, 1 / 60, 0, 0]),
    "zone durations should accumulate from active record intervals",
  );
}

function testNoHeartRateSamplesHideZoneTime() {
  const result = accumulateHeartRateZoneMinutes(
    [{ relMs: 0 }, { relMs: 1_000, heartRate: null }],
    buildHeartRateZones([75, 95, 120, 150]),
  );

  assertEqual(result.hasHeartRateSamples, false, "missing heart-rate samples should be reported");
  assertEqual(
    hasHeartRateZoneTimeData(5, null, result.hasHeartRateSamples),
    false,
    "zone-time chart should be hidden without FIT totals or heart-rate samples",
  );
  assertEqual(
    JSON.stringify(result.minutes),
    JSON.stringify([0, 0, 0, 0, 0]),
    "missing heart-rate samples should not create zone time",
  );
}

const tests = [
  testBoundaryValidation,
  testPolicySelection,
  testCompatibleFitBuckets,
  testManualSourceIgnoresFitBuckets,
  testManualZoneRowsRemainOneToOne,
  testActiveTimeZoneAccumulation,
  testNoHeartRateSamplesHideZoneTime,
];

for (const test of tests) {
  test();
}

console.log(`heart rate zone tests passed (${tests.length})`);
