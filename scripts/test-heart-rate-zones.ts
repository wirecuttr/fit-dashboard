import {
  resolveHeartRateZoneSelection,
  validateManualHeartRateZoneBounds,
} from "../src/lib/hrZones";
import { compatibleZoneSecondsToMinutes } from "../src/lib/zones";

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
}

const tests = [
  testBoundaryValidation,
  testPolicySelection,
  testCompatibleFitBuckets,
];

for (const test of tests) {
  test();
}

console.log(`heart rate zone tests passed (${tests.length})`);
