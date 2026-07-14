import { createStore } from "zustand/vanilla";
import {
  DEFAULT_POWER_ZONE_BOUND_PERCENTS,
  configuredPowerZoneBoundsWatts,
  normalizePowerZonePreferences,
  resolvePowerZoneTimeSource,
  validFitPowerZoneSeconds,
  validatePowerZoneBoundPercents,
  type PowerZonePreferences,
} from "../src/lib/powerZones";
import { calculatePowerZoneTime } from "../src/lib/powerZoneTime";
import { buildPowerZones, zoneSecondsToMinutes } from "../src/lib/zones";
import { buildTelemetryPoints } from "../src/lib/telemetryAxis";
import type { RecordPoint } from "../src/types";
import {
  createInitialPowerZonePreferenceData,
  createPowerZonePreferenceActions,
  type PowerZonePreferenceBackend,
  type PowerZonePreferenceSlice,
} from "../src/stores/powerZonePreferenceSlice";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

function assertArrayEqual(actual: number[] | null | undefined, expected: number[], message: string) {
  assert(actual, `${message}: expected an array`);
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

function clonePreferences(preferences: PowerZonePreferences): PowerZonePreferences {
  return { ...preferences, bounds_percent_ftp: [...preferences.bounds_percent_ftp] };
}

function createPreferenceStore(backend: PowerZonePreferenceBackend) {
  return createStore<PowerZonePreferenceSlice>((set, get) => ({
    ...createInitialPowerZonePreferenceData(),
    ...createPowerZonePreferenceActions((partial) => set(partial), get, backend),
  }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withoutExpectedWarnings<T>(action: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    return await action();
  } finally {
    console.warn = warn;
  }
}

function testBoundaryValidationAndDefaults() {
  assertArrayEqual(
    [...DEFAULT_POWER_ZONE_BOUND_PERCENTS],
    [55, 75, 90, 105, 120, 150],
    "reset defaults should define seven power zones",
  );
  assert(validatePowerZoneBoundPercents([1, 6, 11, 16, 21, 300]), "inclusive limits and five-point gaps should be valid");
  assert(!validatePowerZoneBoundPercents([0, 75, 90, 105, 120, 150]), "values below one percent should be rejected");
  assert(!validatePowerZoneBoundPercents([55, 75, 90, 105, 120, 301]), "values above 300 percent should be rejected");
  assert(!validatePowerZoneBoundPercents([55, 75, 90, 105, 120, 150, 200]), "exactly six boundaries should be required");
  assert(!validatePowerZoneBoundPercents([55, 75, 90, 105, 120, 124]), "five-point gaps should be required");
  assert(!validatePowerZoneBoundPercents([55, 75, 90, 105.5, 120, 150]), "fractional percentages should be rejected");

  const migrated = normalizePowerZonePreferences({
    version: 1,
    bounds_percent_ftp: [50, 70, 85, 100, 115, 140, 190],
    zone_time_source: "calculated",
  });
  assertEqual(migrated.version, 2, "version-one preferences should migrate to version two");
  assertArrayEqual(migrated.bounds_percent_ftp, [50, 70, 85, 100, 115, 140], "migration should remove the obsolete seventh boundary");
  assertEqual(migrated.zone_time_source, "calculated", "migration should preserve the chart source");

  let rejected = false;
  try {
    normalizePowerZonePreferences({
      version: 3,
      bounds_percent_ftp: [...DEFAULT_POWER_ZONE_BOUND_PERCENTS],
      zone_time_source: "fit",
    });
  } catch {
    rejected = true;
  }
  assert(rejected, "unsupported preference versions should be rejected");
}

function testConfiguredBoundsConversion() {
  assertArrayEqual(
    configuredPowerZoneBoundsWatts(50, [1, 6, 11, 16, 21, 300]),
    [1, 3, 6, 8, 11, 150],
    "minimum accepted FTP should still produce strictly increasing watt boundaries",
  );
  const defaultWatts = configuredPowerZoneBoundsWatts(251, [...DEFAULT_POWER_ZONE_BOUND_PERCENTS]);
  assertArrayEqual(
    defaultWatts,
    [138, 188, 226, 264, 301, 377],
    "configured percentages should use nearest-watt rounding",
  );
  assertEqual(buildPowerZones(defaultWatts).length, 7, "six configured boundaries should build exactly seven zones");
  assertEqual(configuredPowerZoneBoundsWatts(49, [...DEFAULT_POWER_ZONE_BOUND_PERCENTS]), undefined, "FTP below 50 W should be rejected");
  assertEqual(configuredPowerZoneBoundsWatts(2001, [...DEFAULT_POWER_ZONE_BOUND_PERCENTS]), undefined, "FTP above 2000 W should be rejected");
  assertEqual(configuredPowerZoneBoundsWatts(Number.NaN, [...DEFAULT_POWER_ZONE_BOUND_PERCENTS]), undefined, "non-finite FTP should be rejected");
  assertEqual(configuredPowerZoneBoundsWatts(250, [55, 75, 90]), undefined, "invalid boundaries should not derive watts");
}

function testFitTotalsAndSourceResolution() {
  assertArrayEqual(validFitPowerZoneSeconds([60, 120, 0]), [60, 120, 0], "valid FIT totals should remain unchanged");
  assertArrayEqual(zoneSecondsToMinutes([60, 120], 4), [1, 2, 0, 0], "FIT presentation should keep padding missing buckets");
  assertArrayEqual(zoneSecondsToMinutes([60, 120, 180, 240], 3), [1, 2, 3], "FIT presentation should keep truncating excess buckets");
  assertEqual(validFitPowerZoneSeconds([0, 0, 0]), null, "empty FIT totals should be unavailable");
  assertEqual(validFitPowerZoneSeconds([60, -1, 0]), null, "negative FIT totals should be rejected");
  assertEqual(validFitPowerZoneSeconds([60, Number.NaN, 0]), null, "non-finite FIT totals should be rejected");
  assertEqual(resolvePowerZoneTimeSource("fit", true, true), "fit", "FIT preference should win when available");
  assertEqual(resolvePowerZoneTimeSource("calculated", true, true), "calculated", "calculated preference should win when available");
  assertEqual(resolvePowerZoneTimeSource("calculated", true, false), "fit", "unavailable calculated should fall back to FIT");
  assertEqual(resolvePowerZoneTimeSource("fit", false, true), "calculated", "unavailable FIT should fall back to calculated");
  assertEqual(resolvePowerZoneTimeSource("fit", false, false), undefined, "missing sources should hide the chart");
}

function testCalculatedZoneTime() {
  const result = calculatePowerZoneTime(
    [
      { relMs: 0, power: 50 },
      { relMs: 1_000, power: 150 },
      { relMs: 2_000, power: 250 },
      { relMs: 3_000, power: 0 },
    ],
    buildPowerZones([100, 200]),
  );
  assertEqual(result.hasPowerSamples, true, "positive power should make calculated zones available");
  assertArrayEqual(result.minutes, [1 / 60, 1 / 60, 1 / 60], "moving intervals should use their leading samples");

  const missing = calculatePowerZoneTime(
    [{ relMs: 0 }, { relMs: 1_000, power: null }],
    buildPowerZones([100, 200]),
  );
  assertEqual(missing.hasPowerSamples, false, "missing power should keep calculated zones unavailable");
  assertArrayEqual(missing.minutes, [0, 0, 0], "missing power should not create zone time");
}
function testCalculatedZoneTimeUsesMovingTimeline() {
  const startTimestampMs = Date.parse("2026-01-01T00:00:00Z");
  const records: RecordPoint[] = [
    { timestamp_ms: startTimestampMs, power: 50 },
    { timestamp_ms: startTimestampMs + 1_000, power: 150 },
    { timestamp_ms: startTimestampMs + 2_000, power: 999 },
    { timestamp_ms: startTimestampMs + 5_000, power: 250 },
    { timestamp_ms: startTimestampMs + 6_000, power: 0 },
  ];
  const points = buildTelemetryPoints(records, startTimestampMs, "time", "km", {
    active_time_supported: true,
    intervals_reliable: true,
    stopped_intervals: [{
      start_ts_utc: new Date(startTimestampMs + 2_000).toISOString(),
      end_ts_utc: new Date(startTimestampMs + 5_000).toISOString(),
    }],
  }, "moving");
  const result = calculatePowerZoneTime(
    points.map((point) => ({ relMs: point.relMs, power: point.record.power })),
    buildPowerZones([100, 200]),
  );

  assertEqual(points.length, 4, "records inside reliable stopped intervals should be excluded");
  assertArrayEqual(points.map((point) => point.relMs), [0, 1_000, 2_000, 3_000], "moving timestamps should exclude stopped duration");
  assertArrayEqual(result.minutes, [1 / 60, 1 / 60, 1 / 60], "pause duration should not contribute to calculated bars");
}


async function testPreferenceStoreLoadsAndSaves() {
  let stored: PowerZonePreferences = {
    version: 2,
    bounds_percent_ftp: [50, 70, 85, 100, 115, 140],
    zone_time_source: "fit",
  };
  const writes: PowerZonePreferences[] = [];
  const store = createPreferenceStore({
    getPowerZonePreferences: async () => clonePreferences(stored),
    setPowerZonePreferences: async (preferences) => {
      writes.push(clonePreferences(preferences));
      stored = clonePreferences(preferences);
      return clonePreferences(stored);
    },
  });

  assertEqual(await store.getState().loadPowerZonePreferences(), true, "valid preferences should load");
  assertEqual(store.getState().powerZonePreferenceStatus, "ready", "successful load should enable preferences");
  assertArrayEqual(store.getState().configuredPowerZoneBoundPercents, stored.bounds_percent_ftp, "load should apply stored boundaries");

  const sourceSave = store.getState().setPowerZoneTimeSource("calculated");
  assertEqual(store.getState().powerZoneTimeSource, "calculated", "source should apply optimistically");
  assertEqual(await sourceSave, true, "valid source should save");
  assertEqual(store.getState().confirmedPowerZoneTimeSource, "calculated", "source save should update confirmation");

  const nextBounds = [52, 72, 87, 102, 117, 145];
  assertEqual(await store.getState().savePowerZoneBoundPercents(nextBounds), true, "valid boundaries should save");
  assertArrayEqual(writes[1].bounds_percent_ftp, nextBounds, "boundary save should send the draft bounds");
  assertEqual(writes[1].zone_time_source, "calculated", "boundary save should preserve the confirmed source");
  assertArrayEqual(store.getState().confirmedPowerZoneBoundPercents, nextBounds, "boundary save should update confirmation");
}

async function testPreferenceStoreRollsBackAndSerialisesWrites() {
  const pendingSave = deferred<PowerZonePreferences>();
  let saveCalls = 0;
  const store = createPreferenceStore({
    getPowerZonePreferences: async () => ({
      version: 2,
      bounds_percent_ftp: [...DEFAULT_POWER_ZONE_BOUND_PERCENTS],
      zone_time_source: "fit",
    }),
    setPowerZonePreferences: async () => {
      saveCalls += 1;
      return pendingSave.promise;
    },
  });
  await store.getState().loadPowerZonePreferences();

  const sourceSave = withoutExpectedWarnings(() => store.getState().setPowerZoneTimeSource("calculated"));
  assertEqual(store.getState().powerZoneTimeSource, "calculated", "pending source save should apply immediately");
  assertEqual(
    await store.getState().savePowerZoneBoundPercents([50, 70, 85, 100, 115, 140]),
    false,
    "boundary saves should be blocked while a source write is pending",
  );
  assertEqual(saveCalls, 1, "concurrent preference writes should be serialised");

  pendingSave.reject(new Error("save failed"));
  assertEqual(await sourceSave, false, "failed source save should report failure");
  assertEqual(store.getState().powerZoneTimeSource, "fit", "failed source save should restore the confirmed source");
  assertEqual(store.getState().confirmedPowerZoneTimeSource, "fit", "failed source save should not change confirmation");
  assertEqual(store.getState().powerZonePreferenceSaving, false, "failed source save should clear saving state");
  assert(!!store.getState().powerZonePreferenceError, "failed source save should expose an error");
  assertEqual(store.getState().powerZonePreferenceErrorContext, "source", "source failure should be identified for chart feedback");
}

async function testPreferenceStorePreservesBoundsAfterFailure() {
  const originalBounds = [...DEFAULT_POWER_ZONE_BOUND_PERCENTS];
  const store = createPreferenceStore({
    getPowerZonePreferences: async () => ({
      version: 2,
      bounds_percent_ftp: originalBounds,
      zone_time_source: "calculated",
    }),
    setPowerZonePreferences: async () => {
      throw new Error("save failed");
    },
  });
  await store.getState().loadPowerZonePreferences();

  const saved = await withoutExpectedWarnings(
    () => store.getState().savePowerZoneBoundPercents([50, 70, 85, 100, 115, 140]),
  );
  assertEqual(saved, false, "failed boundary save should report failure");
  assertArrayEqual(store.getState().configuredPowerZoneBoundPercents, originalBounds, "failed save should preserve active bounds");
  assertArrayEqual(store.getState().confirmedPowerZoneBoundPercents, originalBounds, "failed save should preserve confirmed bounds");
  assertEqual(store.getState().powerZonePreferenceErrorContext, "bounds", "boundary failure should remain Settings-specific");
}
async function testPreferenceStoreReportsLoadFailure() {
  const store = createPreferenceStore({
    getPowerZonePreferences: async () => {
      throw new Error("load failed");
    },
    setPowerZonePreferences: async (preferences) => preferences,
  });

  const loaded = await withoutExpectedWarnings(() => store.getState().loadPowerZonePreferences());
  assertEqual(loaded, false, "failed preference load should report failure");
  assertEqual(store.getState().powerZonePreferenceStatus, "error", "failed load should disable preference controls");
  assertEqual(store.getState().powerZonePreferenceErrorContext, "load", "failed load should be identified for retry UI");
}


const tests = [
  testBoundaryValidationAndDefaults,
  testConfiguredBoundsConversion,
  testFitTotalsAndSourceResolution,
  testCalculatedZoneTime,
  testCalculatedZoneTimeUsesMovingTimeline,
  testPreferenceStoreLoadsAndSaves,
  testPreferenceStoreRollsBackAndSerialisesWrites,
  testPreferenceStoreReportsLoadFailure,
  testPreferenceStorePreservesBoundsAfterFailure,
];

async function runTests() {
  for (const test of tests) await test();
  console.log(`power zone tests passed (${tests.length})`);
}

runTests().catch((error) => {
  console.error(error);
  throw error;
});
