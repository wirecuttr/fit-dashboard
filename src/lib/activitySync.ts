import {
  basisElapsedMsAtTimestamp,
  sourceTimestampAtBasisElapsed,
  type ActivityTimeBasis,
  type ActivityTimeResolution,
  type StoppedIntervalMs,
} from "./activityTime";

export type ActivitySyncOrigin = "map" | "chart";

export type ActivitySyncPosition = {
  activityId: number;
  sourceTimestampMs: number;
  origin: ActivitySyncOrigin;
};

export type ActivitySyncController = {
  publish(position: ActivitySyncPosition, options?: { immediate?: boolean }): void;
  getCurrent(): ActivitySyncPosition | null;
  subscribe(listener: (position: ActivitySyncPosition | null) => void): () => void;
  registerChart(chartKey: string): () => void;
  getRegisteredChartCount(): number;
  subscribeRegisteredChartCount(listener: (count: number) => void): () => void;
  clear(): void;
  dispose(): void;
};

export type ActivitySyncScheduler = {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
};

export type ActivitySyncAxisRow = {
  x: number;
  sourceTimestampMs: number;
  hasFiniteMetric: boolean;
};

export type ActivitySyncChartAdapter = {
  axisRows: readonly ActivitySyncAxisRow[];
  sourceTimestampToX(sourceTimestampMs: number): number | null;
  xToSourceTimestamp(
    x: number,
    currentSourceTimestampMs: number | null,
  ): number | null;
  stoppedIntervals: readonly StoppedIntervalMs[];
};

export type ActivitySyncProjectionPoint = {
  x: number | null;
  sourceTimestampMs: number;
};

export type ActivitySyncSeriesRow = readonly [
  x: number,
  metric: number | null,
  relativeMs: number,
  sourceTimestampMs: number,
  distanceMeters: number | null,
];

const DEFAULT_PUBLISH_INTERVAL_MS = 80;
const TOOLTIP_MIN_WINDOW_MS = 15_000;
const TOOLTIP_MAX_WINDOW_MS = 60_000;
const AXIS_EPSILON = 1e-9;
const tooltipWindowCache = new WeakMap<readonly ActivitySyncAxisRow[], number>();

const browserScheduler: ActivitySyncScheduler = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

export function createActivitySyncController(
  activityId: number,
  options: {
    publishIntervalMs?: number;
    scheduler?: ActivitySyncScheduler;
  } = {},
): ActivitySyncController {
  const scheduler = options.scheduler ?? browserScheduler;
  const publishIntervalMs = Math.max(1, options.publishIntervalMs ?? DEFAULT_PUBLISH_INTERVAL_MS);
  const listeners = new Set<(position: ActivitySyncPosition | null) => void>();
  const countListeners = new Set<(count: number) => void>();
  const chartKeys = new Set<string>();
  let current: ActivitySyncPosition | null = null;
  let pendingMapPosition: ActivitySyncPosition | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let lastMapPublicationAt = Number.NEGATIVE_INFINITY;
  let disposed = false;

  const cancelPending = () => {
    if (pendingTimer !== null) scheduler.clearTimeout(pendingTimer);
    pendingTimer = null;
    pendingMapPosition = null;
  };

  const notifyPosition = (position: ActivitySyncPosition | null) => {
    for (const listener of listeners) listener(position);
  };

  const commit = (position: ActivitySyncPosition) => {
    current = position;
    if (position.origin === "map") lastMapPublicationAt = scheduler.now();
    notifyPosition(position);
  };

  const flushPending = () => {
    pendingTimer = null;
    const position = pendingMapPosition;
    pendingMapPosition = null;
    if (!disposed && position) commit(position);
  };

  const publish = (
    position: ActivitySyncPosition,
    publishOptions: { immediate?: boolean } = {},
  ) => {
    if (disposed || position.activityId !== activityId || !Number.isFinite(position.sourceTimestampMs)) {
      return;
    }

    const immediate = publishOptions.immediate || position.origin === "chart";
    if (immediate) {
      cancelPending();
      commit(position);
      return;
    }

    const elapsedMs = scheduler.now() - lastMapPublicationAt;
    if (pendingTimer === null && elapsedMs >= publishIntervalMs) {
      commit(position);
      return;
    }

    pendingMapPosition = position;
    if (pendingTimer === null) {
      pendingTimer = scheduler.setTimeout(
        flushPending,
        Math.max(0, publishIntervalMs - elapsedMs),
      );
    }
  };

  const clear = () => {
    if (disposed) return;
    cancelPending();
    current = null;
    notifyPosition(null);
  };

  const dispose = () => {
    if (disposed) return;
    cancelPending();
    current = null;
    notifyPosition(null);
    if (chartKeys.size > 0) {
      chartKeys.clear();
      for (const listener of countListeners) listener(0);
    }
    listeners.clear();
    countListeners.clear();
    disposed = true;
  };

  return {
    publish,
    getCurrent: () => current,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    registerChart(chartKey) {
      if (disposed || chartKeys.has(chartKey)) return () => {};
      chartKeys.add(chartKey);
      for (const listener of countListeners) listener(chartKeys.size);
      let registered = true;
      return () => {
        if (!registered || disposed) return;
        registered = false;
        if (!chartKeys.delete(chartKey)) return;
        for (const listener of countListeners) listener(chartKeys.size);
      };
    },
    getRegisteredChartCount: () => chartKeys.size,
    subscribeRegisteredChartCount(listener) {
      if (disposed) return () => {};
      countListeners.add(listener);
      return () => countListeners.delete(listener);
    },
    clear,
    dispose,
  };
}

export function deriveActivitySyncState(
  enabled: boolean,
  hasRoute: boolean,
  hasPositiveTimeline: boolean,
  registeredChartCount: number,
): { available: boolean; active: boolean } {
  const available = hasRoute && hasPositiveTimeline && registeredChartCount > 0;
  return { available, active: enabled && available };
}

export function sourceTimestampToTimeX(
  sourceTimestampMs: number,
  resolution: ActivityTimeResolution,
  basis: ActivityTimeBasis,
): number {
  return basisElapsedMsAtTimestamp(sourceTimestampMs, resolution, basis);
}

export function timeXToSourceTimestamp(
  x: number,
  resolution: ActivityTimeResolution,
  basis: ActivityTimeBasis,
): number {
  return sourceTimestampAtBasisElapsed(x, resolution, basis);
}

function finiteProjectionPoints(
  points: readonly ActivitySyncProjectionPoint[],
): Array<{ x: number; sourceTimestampMs: number }> {
  const finite = points.filter((point): point is { x: number; sourceTimestampMs: number } => (
    typeof point.x === "number"
    && Number.isFinite(point.x)
    && Number.isFinite(point.sourceTimestampMs)
  ));
  const alreadyChronological = finite.every((point, index) => (
    index === 0 || point.sourceTimestampMs >= finite[index - 1].sourceTimestampMs
  ));
  if (!alreadyChronological) {
    finite.sort((a, b) => a.sourceTimestampMs - b.sourceTimestampMs || a.x - b.x);
  }
  return finite;
}

export function sourceTimestampToAxisX(
  points: readonly ActivitySyncProjectionPoint[],
  sourceTimestampMs: number,
  stoppedIntervals: readonly StoppedIntervalMs[] = [],
): number | null {
  const finitePoints = finiteProjectionPoints(points);
  if (!finitePoints.length || !Number.isFinite(sourceTimestampMs)) return null;

  const stoppedInterval = stoppedIntervals.find((interval) => (
    sourceTimestampMs >= interval.startMs && sourceTimestampMs < interval.endMs
  ));
  if (stoppedInterval) {
    const beforePause = finitePoints.filter((point) => point.sourceTimestampMs <= stoppedInterval.startMs).at(-1);
    return beforePause?.x ?? finitePoints[0].x;
  }

  if (sourceTimestampMs <= finitePoints[0].sourceTimestampMs) return finitePoints[0].x;
  const last = finitePoints[finitePoints.length - 1];
  if (sourceTimestampMs >= last.sourceTimestampMs) return last.x;

  let lo = 0;
  let hi = finitePoints.length - 1;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (finitePoints[mid].sourceTimestampMs <= sourceTimestampMs) lo = mid;
    else hi = mid;
  }
  const before = finitePoints[lo];
  const after = finitePoints[hi];
  const spanMs = after.sourceTimestampMs - before.sourceTimestampMs;
  if (spanMs <= 0) return before.x;
  const ratio = (sourceTimestampMs - before.sourceTimestampMs) / spanMs;
  return before.x + (after.x - before.x) * ratio;
}

function chooseClosestTimestamp(
  points: Array<{ x: number; sourceTimestampMs: number }>,
  currentSourceTimestampMs: number | null,
): number {
  if (currentSourceTimestampMs === null || !Number.isFinite(currentSourceTimestampMs)) {
    return Math.min(...points.map((point) => point.sourceTimestampMs));
  }
  return points.reduce((best, point) => {
    const bestDelta = Math.abs(best.sourceTimestampMs - currentSourceTimestampMs);
    const pointDelta = Math.abs(point.sourceTimestampMs - currentSourceTimestampMs);
    return pointDelta < bestDelta
      || (pointDelta === bestDelta && point.sourceTimestampMs < best.sourceTimestampMs)
      ? point
      : best;
  }).sourceTimestampMs;
}

export function axisXToSourceTimestamp(
  points: readonly ActivitySyncProjectionPoint[],
  x: number,
  currentSourceTimestampMs: number | null,
): number | null {
  const chronological = finiteProjectionPoints(points);
  if (!chronological.length || !Number.isFinite(x)) return null;

  const nonDecreasing = chronological.every((point, index) => (
    index === 0 || point.x + AXIS_EPSILON >= chronological[index - 1].x
  ));
  if (!nonDecreasing) {
    let bestDistance = Number.POSITIVE_INFINITY;
    let candidates: Array<{ x: number; sourceTimestampMs: number }> = [];
    for (const point of chronological) {
      const distance = Math.abs(point.x - x);
      if (distance + AXIS_EPSILON < bestDistance) {
        bestDistance = distance;
        candidates = [point];
      } else if (Math.abs(distance - bestDistance) <= AXIS_EPSILON) {
        candidates.push(point);
      }
    }
    return chooseClosestTimestamp(candidates, currentSourceTimestampMs);
  }

  const byAxis = [...chronological].sort((a, b) => a.x - b.x || a.sourceTimestampMs - b.sourceTimestampMs);
  if (x <= byAxis[0].x) {
    const tied = byAxis.filter((point) => Math.abs(point.x - byAxis[0].x) <= AXIS_EPSILON);
    return chooseClosestTimestamp(tied, currentSourceTimestampMs);
  }
  const last = byAxis[byAxis.length - 1];
  if (x >= last.x) {
    const tied = byAxis.filter((point) => Math.abs(point.x - last.x) <= AXIS_EPSILON);
    return chooseClosestTimestamp(tied, currentSourceTimestampMs);
  }

  const exact = byAxis.filter((point) => Math.abs(point.x - x) <= AXIS_EPSILON);
  if (exact.length) return chooseClosestTimestamp(exact, currentSourceTimestampMs);

  let lo = 0;
  let hi = byAxis.length - 1;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (byAxis[mid].x < x) lo = mid;
    else hi = mid;
  }
  const before = byAxis[lo];
  const after = byAxis[hi];
  const span = after.x - before.x;
  if (span <= AXIS_EPSILON) {
    return chooseClosestTimestamp([before, after], currentSourceTimestampMs);
  }
  const ratio = (x - before.x) / span;
  return before.sourceTimestampMs + (after.sourceTimestampMs - before.sourceTimestampMs) * ratio;
}

export function buildActivitySyncAxisRows(
  seriesGroups: readonly (readonly ActivitySyncSeriesRow[])[],
): ActivitySyncAxisRow[] {
  const rows = new Map<string, ActivitySyncAxisRow>();
  for (const series of seriesGroups) {
    for (const row of series) {
      const x = row[0];
      const sourceTimestampMs = row[3];
      if (!Number.isFinite(x) || !Number.isFinite(sourceTimestampMs)) continue;
      const key = `${x}\u0000${sourceTimestampMs}`;
      const existing = rows.get(key);
      const hasFiniteMetric = typeof row[1] === "number" && Number.isFinite(row[1]);
      if (existing) existing.hasFiniteMetric ||= hasFiniteMetric;
      else rows.set(key, { x, sourceTimestampMs, hasFiniteMetric });
    }
  }
  return [...rows.values()].sort((a, b) => a.x - b.x || a.sourceTimestampMs - b.sourceTimestampMs);
}

export function nearestActivitySyncAxisRow(
  rows: readonly ActivitySyncAxisRow[],
  x: number,
  sourceTimestampMs: number,
): ActivitySyncAxisRow | null {
  if (!rows.length || !Number.isFinite(x)) return null;
  return rows.reduce((best, row) => {
    const rowDistance = Math.abs(row.x - x);
    const bestDistance = Math.abs(best.x - x);
    if (rowDistance < bestDistance) return row;
    if (rowDistance > bestDistance) return best;
    const rowTimeDistance = Math.abs(row.sourceTimestampMs - sourceTimestampMs);
    const bestTimeDistance = Math.abs(best.sourceTimestampMs - sourceTimestampMs);
    return rowTimeDistance < bestTimeDistance ? row : best;
  });
}

export function activitySyncTooltipWindowMs(
  rows: readonly ActivitySyncAxisRow[],
): number {
  const cached = tooltipWindowCache.get(rows);
  if (cached !== undefined) return cached;

  const timestamps = rows
    .filter((row) => row.hasFiniteMetric)
    .map((row) => row.sourceTimestampMs)
    .sort((a, b) => a - b);
  const gaps = timestamps
    .slice(1)
    .map((timestamp, index) => timestamp - timestamps[index])
    .filter((gap) => gap > 0);
  let windowMs = TOOLTIP_MIN_WINDOW_MS;
  if (gaps.length) {
    gaps.sort((a, b) => a - b);
    const middle = Math.floor(gaps.length / 2);
    const median = gaps.length % 2
      ? gaps[middle]
      : (gaps[middle - 1] + gaps[middle]) / 2;
    windowMs = Math.max(TOOLTIP_MIN_WINDOW_MS, Math.min(TOOLTIP_MAX_WINDOW_MS, median * 1.5));
  }
  tooltipWindowCache.set(rows, windowMs);
  return windowMs;
}

function pauseSegment(timestampMs: number, intervals: readonly StoppedIntervalMs[]): string {
  for (let index = 0; index < intervals.length; index += 1) {
    const interval = intervals[index];
    if (timestampMs < interval.startMs) return `active-${index}`;
    if (timestampMs < interval.endMs) return `stopped-${index}`;
  }
  return `active-${intervals.length}`;
}

export function shouldShowActivitySyncTooltip(
  sourceTimestampMs: number,
  row: ActivitySyncAxisRow | null,
  rows: readonly ActivitySyncAxisRow[],
  stoppedIntervals: readonly StoppedIntervalMs[],
): boolean {
  if (!row?.hasFiniteMetric) return false;
  if (Math.abs(row.sourceTimestampMs - sourceTimestampMs) > activitySyncTooltipWindowMs(rows)) {
    return false;
  }
  return pauseSegment(row.sourceTimestampMs, stoppedIntervals)
    === pauseSegment(sourceTimestampMs, stoppedIntervals);
}
