import type { Activity, RecordPoint } from "../src/types";
import {
  basisElapsedMsAtTimestamp,
  getBasisDurationMs,
  getReliableStoppedIntervals,
  isTimestampStopped,
  resolveActivityTime,
  resolveEffectiveTimeBasis,
  sourceTimestampAtBasisElapsed,
  type ActivityTimeMetadata,
  type ActivityTimerMetadata,
} from "../src/lib/activityTime";
import { buildLapMarkers, buildTelemetryPoints } from "../src/lib/telemetryAxis";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const startMs = Date.UTC(2026, 0, 1, 12, 0, 0);
const isoAt = (seconds: number) => new Date(startMs + seconds * 1_000).toISOString();

const activity: Activity = {
  id: 1,
  file_name: "synthetic.fit",
  activity_name: "Synthetic pause activity",
  sport: "cycling",
  device: "test",
  start_ts_utc: isoAt(0),
  end_ts_utc: isoAt(240),
  duration_s: 180,
  distance_m: 2_400,
};

const timer: ActivityTimerMetadata = {
  active_time_supported: true,
  intervals_reliable: true,
  elapsed_time_s: 240,
  timer_time_s: 180,
  stopped_intervals: [
    { start_ts_utc: isoAt(60), end_ts_utc: isoAt(90) },
    { start_ts_utc: isoAt(150), end_ts_utc: isoAt(180) },
  ],
};

const metadata: ActivityTimeMetadata = {
  duration_source: "session_total_timer_time_s",
  total_elapsed_time_s: 240,
  total_timer_time_s: 180,
  timer,
};

const recordSeconds = [0, 30, 60, 75, 90, 120, 150, 170, 180, 210, 240];
const records: RecordPoint[] = recordSeconds.map((seconds) => ({
  timestamp_ms: startMs + seconds * 1_000,
  distance_m: seconds * 10,
  heart_rate: 120 + Math.floor(seconds / 30),
}));

function testResolutionAndMappings() {
  const resolution = resolveActivityTime(activity, records, metadata);
  assertEqual(resolution.movingDurationMs, 180_000, "timer time should resolve as Moving duration");
  assertEqual(resolution.totalDurationMs, 240_000, "elapsed time should resolve as Total duration");
  assertEqual(resolution.stoppedDurationMs, 60_000, "stopped intervals should be accumulated");
  assert(resolution.selectable, "reliable distinct timelines should be selectable");
  assertEqual(resolveEffectiveTimeBasis("moving", resolution), "moving", "Moving should remain selectable");
  assertEqual(resolveEffectiveTimeBasis("total", resolution), "total", "Total should remain selectable");
  assertEqual(getBasisDurationMs(resolution, "moving"), 180_000, "Moving duration should use timer time");
  assertEqual(getBasisDurationMs(resolution, "total"), 240_000, "Total duration should use elapsed time");

  assertEqual(basisElapsedMsAtTimestamp(startMs + 75_000, resolution, "moving"), 60_000, "Moving time should stop during a pause");
  assertEqual(basisElapsedMsAtTimestamp(startMs + 100_000, resolution, "moving"), 70_000, "Moving time should subtract completed pauses");
  assertEqual(basisElapsedMsAtTimestamp(startMs + 75_000, resolution, "total"), 75_000, "Total time should preserve wall-clock elapsed time");
  assertEqual(sourceTimestampAtBasisElapsed(60_000, resolution, "moving"), startMs + 90_000, "Moving pause boundary should map to the resume timestamp");
  assertEqual(sourceTimestampAtBasisElapsed(75_000, resolution, "total"), startMs + 75_000, "Total time should map directly to source time");
  assert(isTimestampStopped(startMs + 75_000, resolution.stoppedIntervals), "timestamps inside a pause should be identified");
  assert(!isTimestampStopped(startMs + 90_000, resolution.stoppedIntervals), "pause end should be treated as resumed");
}

function testIntervalMergingAndClamping() {
  const intervals = getReliableStoppedIntervals({
    active_time_supported: true,
    intervals_reliable: true,
    stopped_intervals: [
      { start_ts_utc: isoAt(-10), end_ts_utc: isoAt(20) },
      { start_ts_utc: isoAt(15), end_ts_utc: isoAt(30) },
      { start_ts_utc: isoAt(230), end_ts_utc: isoAt(260) },
    ],
  }, startMs, startMs + 240_000);
  assertEqual(intervals.length, 2, "overlapping stopped intervals should merge");
  assertEqual(intervals[0].startMs, startMs, "intervals should clamp to timeline start");
  assertEqual(intervals[0].endMs, startMs + 30_000, "merged interval should retain the latest end");
  assertEqual(intervals[1].endMs, startMs + 240_000, "intervals should clamp to timeline end");
}

function testTelemetryBases() {
  const moving = buildTelemetryPoints(records, startMs, "time", "km", timer, "moving");
  const total = buildTelemetryPoints(records, startMs, "time", "km", timer, "total");
  const distance = buildTelemetryPoints(records, startMs, "distance", "km", timer, "total");

  assertEqual(moving.length, 7, "Moving telemetry should remove stopped records");
  assertEqual(total.length, records.length, "Total telemetry should retain stopped records");
  assertEqual(distance.length, moving.length, "Distance telemetry should keep active-record semantics");
  assertEqual(moving.find((point) => point.timestampMs === startMs + 90_000)?.x, 60_000, "Moving telemetry should compress pause time");
  assertEqual(total.find((point) => point.timestampMs === startMs + 75_000)?.x, 75_000, "Total telemetry should use raw elapsed time");

  const movingLap = buildLapMarkers(records, [isoAt(0), isoAt(150)], startMs, "time", "km", timer, "moving");
  const totalLap = buildLapMarkers(records, [isoAt(0), isoAt(150)], startMs, "time", "km", timer, "total");
  assertEqual(movingLap[0]?.xAxis, 120_000, "Moving lap markers should subtract prior pauses");
  assertEqual(totalLap[0]?.xAxis, 150_000, "Total lap markers should preserve elapsed time");
}

function testFallbackCapabilities() {
  const unreliable = resolveActivityTime(activity, records, {
    ...metadata,
    timer: { ...timer, active_time_supported: true, intervals_reliable: false },
  });
  assert(!unreliable.selectable, "unreliable interval locations should prevent basis switching");
  assertEqual(resolveEffectiveTimeBasis("moving", unreliable), "total", "unreliable distinct timelines should fall back to Total");

  const undifferentiated = resolveActivityTime(
    { ...activity, file_name: "synthetic.gpx", duration_s: 240 },
    records,
    { duration_source: "record_span", record_span_duration_s: 240 },
  );
  assert(!undifferentiated.movingLabelSupported, "a record span must not be labelled Moving time");
  assert(!undifferentiated.totalLabelSupported, "a record span alone remains an undifferentiated Duration");
  assertEqual(resolveEffectiveTimeBasis("moving", undifferentiated), "total", "an undifferentiated elapsed timeline should use raw elapsed time internally");
}

testResolutionAndMappings();
testIntervalMergingAndClamping();
testTelemetryBases();
testFallbackCapabilities();
console.log("Activity time tests passed");
