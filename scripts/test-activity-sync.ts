import {
  activitySyncTooltipWindowMs,
  axisXToSourceTimestamp,
  buildActivitySyncAxisRows,
  createActivitySyncController,
  deriveActivitySyncState,
  nearestActivitySyncAxisRow,
  shouldShowActivitySyncTooltip,
  sourceTimestampToAxisX,
  sourceTimestampToTimeX,
  timeXToSourceTimestamp,
  type ActivitySyncPosition,
  type ActivitySyncScheduler,
} from "../src/lib/activitySync";
import type { ActivityTimeResolution } from "../src/lib/activityTime";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertClose(actual: number | null, expected: number, message: string) {
  if (actual === null || Math.abs(actual - expected) > 0.001) {
    throw new Error(`${message}: expected ${expected}, got ${String(actual)}`);
  }
}

class FakeScheduler implements ActivitySyncScheduler {
  private currentMs = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();

  now() { return this.currentMs; }

  setTimeout(callback: () => void, delayMs: number) {
    const id = this.nextId++;
    this.timers.set(id, { at: this.currentMs + delayMs, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>) {
    this.timers.delete(handle as number);
  }

  advance(delayMs: number) {
    const target = this.currentMs + delayMs;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.currentMs = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.currentMs = target;
  }
}

const activityId = 42;
const position = (
  sourceTimestampMs: number,
  origin: ActivitySyncPosition["origin"] = "map",
): ActivitySyncPosition => ({ activityId, sourceTimestampMs, origin });

function testControllerCoalescingAndImmediateCancellation() {
  const scheduler = new FakeScheduler();
  const controller = createActivitySyncController(activityId, { publishIntervalMs: 80, scheduler });
  const received: Array<number | null> = [];
  controller.subscribe((value) => received.push(value?.sourceTimestampMs ?? null));

  controller.publish(position(100));
  scheduler.advance(10);
  controller.publish(position(110));
  scheduler.advance(10);
  controller.publish(position(120));
  assertEqual(controller.getCurrent()?.sourceTimestampMs, 100, "coalesced updates should remain pending");
  scheduler.advance(60);
  assertEqual(controller.getCurrent()?.sourceTimestampMs, 120, "latest pending position should win");
  assertEqual(received.join(","), "100,120", "replaced pending positions should not notify");

  scheduler.advance(10);
  controller.publish(position(130));
  controller.publish(position(500, "chart"), { immediate: true });
  assertEqual(controller.getCurrent()?.sourceTimestampMs, 500, "chart click should publish immediately");
  scheduler.advance(100);
  assertEqual(controller.getCurrent()?.sourceTimestampMs, 500, "stale map work must not overwrite a chart click");

  controller.publish(position(510));
  controller.clear();
  assertEqual(controller.getCurrent(), null, "clear should remove the current position");
  scheduler.advance(100);
  assertEqual(controller.getCurrent(), null, "clear should cancel pending map work");

  controller.publish(position(600), { immediate: true });
  controller.publish(position(610));
  controller.dispose();
  scheduler.advance(100);
  assertEqual(controller.getCurrent(), null, "dispose should cancel pending work and clear state");
}

function testRegistrationAndActivityGuards() {
  const controller = createActivitySyncController(activityId);
  const counts: number[] = [];
  controller.subscribeRegisteredChartCount((count) => counts.push(count));
  const unregisterA = controller.registerChart("heart-rate");
  const unregisterDuplicate = controller.registerChart("heart-rate");
  const unregisterB = controller.registerChart("power");
  assertEqual(controller.getRegisteredChartCount(), 2, "duplicate chart keys should not inflate availability");
  unregisterDuplicate();
  assertEqual(controller.getRegisteredChartCount(), 2, "duplicate cleanup should not remove the real registration");
  unregisterA();
  unregisterA();
  assertEqual(controller.getRegisteredChartCount(), 1, "chart cleanup should be idempotent");
  unregisterB();
  assertEqual(counts.join(","), "1,2,1,0", "count listeners should only receive real changes");

  controller.publish({ activityId: 999, sourceTimestampMs: 10, origin: "map" }, { immediate: true });
  assertEqual(controller.getCurrent(), null, "mismatched activity events should be rejected");
}

const resolution: ActivityTimeResolution = {
  timelineStartMs: 1_000_000,
  timelineEndMs: 1_240_000,
  movingDurationMs: 180_000,
  totalDurationMs: 240_000,
  recordSpanMs: 240_000,
  stoppedDurationMs: 60_000,
  stoppedIntervals: [
    { startMs: 1_060_000, endMs: 1_090_000 },
    { startMs: 1_150_000, endMs: 1_180_000 },
  ],
  intervalsReliable: true,
  hasPositiveTimeRange: true,
  hasDistinctTotalTime: true,
  movingLabelSupported: true,
  totalLabelSupported: true,
  selectable: true,
  defaultBasis: "moving",
};

function testTimeAndDistanceProjection() {
  assertEqual(sourceTimestampToTimeX(1_075_000, resolution, "moving"), 60_000, "Moving projection should hold through pauses");
  assertEqual(sourceTimestampToTimeX(1_075_000, resolution, "total"), 75_000, "Total projection should include pauses");
  assertEqual(timeXToSourceTimestamp(60_000, resolution, "moving"), 1_090_000, "Moving inverse should seek to pause end");
  assertEqual(timeXToSourceTimestamp(75_000, resolution, "total"), 1_075_000, "Total inverse should preserve time");

  const points = [
    { x: 0, sourceTimestampMs: 1_000_000 },
    { x: 1, sourceTimestampMs: 1_030_000 },
    { x: 2, sourceTimestampMs: 1_060_000 },
    { x: 2, sourceTimestampMs: 1_090_000 },
    { x: 3, sourceTimestampMs: 1_120_000 },
  ];
  assertClose(sourceTimestampToAxisX(points, 1_045_000), 1.5, "distance should interpolate by timestamp");
  assertClose(sourceTimestampToAxisX(points, 1_075_000, resolution.stoppedIntervals), 2, "distance should hold during a pause");
  assertEqual(axisXToSourceTimestamp(points, 2, 1_085_000), 1_090_000, "plateaus should use the current moment");
  assertClose(axisXToSourceTimestamp(points, 2.5, null), 1_105_000, "distance inverse should interpolate");

  const regressing = [
    { x: 0, sourceTimestampMs: 0 },
    { x: 2, sourceTimestampMs: 10_000 },
    { x: 1.8, sourceTimestampMs: 20_000 },
  ];
  assertEqual(axisXToSourceTimestamp(regressing, 1.9, 19_000), 20_000, "regressions should use nearest search");
}

function testAxisRowsAndTooltipRules() {
  const rows = buildActivitySyncAxisRows([
    [[0, 120, 0, 1_000_000, 0], [10, null, 10, 1_010_000, 100], [20, 130, 20, 1_020_000, 200]],
    [[0, null, 0, 1_000_000, 0], [10, 200, 10, 1_010_000, 100], [20, null, 20, 1_020_000, 200]],
  ]);
  assertEqual(rows.length, 3, "matching multi-series rows should be grouped");
  assert(rows.every((row) => row.hasFiniteMetric), "either finite series should mark a row finite");
  assertEqual(nearestActivitySyncAxisRow(rows, 11, 1_011_000)?.x, 10, "nearest row should follow the axis");
  assertEqual(activitySyncTooltipWindowMs(rows), 15_000, "dense data should use the minimum window");

  const nullRows = buildActivitySyncAxisRows([[
    [0, 120, 0, 1_000_000, 0],
    [10, null, 10, 1_010_000, 100],
  ]]);
  assert(!shouldShowActivitySyncTooltip(1_010_000, nullRows[1], nullRows, []), "null rows should hide tooltips");
  assert(!shouldShowActivitySyncTooltip(
    1_075_000,
    { x: 10, sourceTimestampMs: 1_090_000, hasFiniteMetric: true },
    [
      { x: 0, sourceTimestampMs: 1_060_000, hasFiniteMetric: true },
      { x: 10, sourceTimestampMs: 1_090_000, hasFiniteMetric: true },
    ],
    resolution.stoppedIntervals,
  ), "samples across a pause boundary should be rejected");
}

function testStateDerivation() {
  assertEqual(deriveActivitySyncState(true, true, true, 0).active, false, "checked Sync should remain inactive without charts");
  assertEqual(deriveActivitySyncState(true, true, true, 1).active, true, "checked available Sync should become active");
  assertEqual(deriveActivitySyncState(false, true, true, 1).available, true, "availability should not depend on preference");
}

testControllerCoalescingAndImmediateCancellation();
testRegistrationAndActivityGuards();
testTimeAndDistanceProjection();
testAxisRowsAndTooltipRules();
testStateDerivation();
console.log("Activity sync tests passed");
