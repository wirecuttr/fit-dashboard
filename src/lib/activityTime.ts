import type { Activity, RecordPoint } from "../types";

export type ActivityTimeBasis = "moving" | "total";

export type ActivityStoppedInterval = {
  start_ts_utc?: string | null;
  end_ts_utc?: string | null;
  duration_s?: number | null;
  trigger?: string | null;
  resume_trigger?: string | null;
};

export type ActivityTimerMetadata = {
  active_time_supported?: boolean;
  intervals_reliable?: boolean;
  elapsed_time_s?: number | null;
  timer_time_s?: number | null;
  stopped_intervals?: ActivityStoppedInterval[];
};

export type ActivityTimeMetadata = {
  duration_source?: string | null;
  record_span_duration_s?: number | null;
  total_elapsed_time_s?: number | null;
  total_timer_time_s?: number | null;
  timer?: ActivityTimerMetadata | null;
  session?: {
    total_elapsed_time_s?: number | null;
    total_timer_time_s?: number | null;
  } | null;
};

export type StoppedIntervalMs = {
  startMs: number;
  endMs: number;
};

export type ActivityTimeResolution = {
  timelineStartMs: number;
  timelineEndMs: number;
  movingDurationMs: number | null;
  totalDurationMs: number | null;
  recordSpanMs: number;
  stoppedDurationMs: number;
  stoppedIntervals: StoppedIntervalMs[];
  intervalsReliable: boolean;
  hasPositiveTimeRange: boolean;
  hasDistinctTotalTime: boolean;
  movingLabelSupported: boolean;
  totalLabelSupported: boolean;
  selectable: boolean;
  defaultBasis: ActivityTimeBasis;
};

const DURATION_EQUIVALENCE_TOLERANCE_MS = 1_000;

function finitePositiveMilliseconds(seconds: unknown): number | null {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? seconds * 1_000
    : null;
}

function parseTimestampMs(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstPositive(...values: Array<number | null>): number | null {
  return values.find((value): value is number => value !== null) ?? null;
}

export function getReliableStoppedIntervals(
  timerMetadata?: ActivityTimerMetadata | null,
  timelineStartMs?: number,
  timelineEndMs?: number,
): StoppedIntervalMs[] {
  if (!timerMetadata?.active_time_supported || !timerMetadata.intervals_reliable) return [];

  const intervals = (timerMetadata.stopped_intervals ?? [])
    .map((interval) => {
      let startMs = parseTimestampMs(interval.start_ts_utc);
      let endMs = parseTimestampMs(interval.end_ts_utc);
      if (startMs === null || endMs === null || endMs <= startMs) return null;
      if (Number.isFinite(timelineStartMs)) startMs = Math.max(startMs, timelineStartMs as number);
      if (Number.isFinite(timelineEndMs)) endMs = Math.min(endMs, timelineEndMs as number);
      return endMs > startMs ? { startMs, endMs } : null;
    })
    .filter((interval): interval is StoppedIntervalMs => interval !== null)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const merged: StoppedIntervalMs[] = [];
  for (const interval of intervals) {
    const previous = merged[merged.length - 1];
    if (previous && interval.startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, interval.endMs);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

export function isTimestampStopped(timestampMs: number, intervals: StoppedIntervalMs[]): boolean {
  return intervals.some((interval) => timestampMs >= interval.startMs && timestampMs < interval.endMs);
}

export function stoppedIntervalAtTimestamp(
  timestampMs: number,
  intervals: StoppedIntervalMs[],
): StoppedIntervalMs | null {
  return intervals.find((interval) => timestampMs >= interval.startMs && timestampMs < interval.endMs) ?? null;
}

export function stoppedDurationBeforeMs(timestampMs: number, intervals: StoppedIntervalMs[]): number {
  let stoppedMs = 0;
  for (const interval of intervals) {
    if (timestampMs <= interval.startMs) break;
    stoppedMs += Math.max(0, Math.min(timestampMs, interval.endMs) - interval.startMs);
  }
  return stoppedMs;
}

export function movingElapsedMsAtTimestamp(
  timestampMs: number,
  startTimestampMs: number,
  intervals: StoppedIntervalMs[],
): number {
  const elapsedMs = Math.max(0, timestampMs - startTimestampMs);
  return Math.max(0, elapsedMs - stoppedDurationBeforeMs(timestampMs, intervals));
}

export function basisElapsedMsAtTimestamp(
  timestampMs: number,
  resolution: ActivityTimeResolution,
  basis: ActivityTimeBasis,
): number {
  if (basis === "total") {
    return Math.max(0, Math.min(timestampMs - resolution.timelineStartMs, getBasisDurationMs(resolution, basis)));
  }
  return Math.min(
    movingElapsedMsAtTimestamp(timestampMs, resolution.timelineStartMs, resolution.stoppedIntervals),
    getBasisDurationMs(resolution, basis),
  );
}

export function sourceTimestampAtBasisElapsed(
  elapsedMs: number,
  resolution: ActivityTimeResolution,
  basis: ActivityTimeBasis,
): number {
  const durationMs = getBasisDurationMs(resolution, basis);
  const clampedElapsedMs = Math.max(0, Math.min(elapsedMs, durationMs));
  if (basis === "total" || !resolution.stoppedIntervals.length) {
    return resolution.timelineStartMs + clampedElapsedMs;
  }

  let stoppedMs = 0;
  for (const interval of resolution.stoppedIntervals) {
    const movingAtPauseStart = Math.max(
      0,
      interval.startMs - resolution.timelineStartMs - stoppedMs,
    );
    if (clampedElapsedMs < movingAtPauseStart) break;
    stoppedMs += interval.endMs - interval.startMs;
  }
  return Math.min(resolution.timelineEndMs, resolution.timelineStartMs + clampedElapsedMs + stoppedMs);
}

export function resolveActivityTime(
  activity: Activity | null | undefined,
  records: RecordPoint[],
  metadata?: ActivityTimeMetadata | null,
): ActivityTimeResolution {
  let recordStartMs: number | null = null;
  let recordEndMs: number | null = null;
  for (const record of records) {
    if (!Number.isFinite(record.timestamp_ms)) continue;
    recordStartMs = recordStartMs === null ? record.timestamp_ms : Math.min(recordStartMs, record.timestamp_ms);
    recordEndMs = recordEndMs === null ? record.timestamp_ms : Math.max(recordEndMs, record.timestamp_ms);
  }
  const activityStartMs = parseTimestampMs(activity?.start_ts_utc);
  const activityEndMs = parseTimestampMs(activity?.end_ts_utc);
  const timelineStartMs = recordStartMs ?? activityStartMs ?? 0;

  const recordSpanMs = recordStartMs !== null && recordEndMs !== null
    ? Math.max(0, recordEndMs - recordStartMs)
    : Math.max(0, (activityEndMs ?? timelineStartMs) - timelineStartMs);
  const activitySpanMs = activityStartMs !== null && activityEndMs !== null
    ? Math.max(0, activityEndMs - activityStartMs)
    : null;
  const metadataRecordSpanMs = finitePositiveMilliseconds(metadata?.record_span_duration_s);
  const timerElapsedMs = finitePositiveMilliseconds(metadata?.timer?.elapsed_time_s);
  const timerTimeMs = finitePositiveMilliseconds(metadata?.timer?.timer_time_s);
  const topLevelElapsedMs = finitePositiveMilliseconds(metadata?.total_elapsed_time_s);
  const topLevelTimerMs = finitePositiveMilliseconds(metadata?.total_timer_time_s);
  const sessionElapsedMs = finitePositiveMilliseconds(metadata?.session?.total_elapsed_time_s);
  const sessionTimerMs = finitePositiveMilliseconds(metadata?.session?.total_timer_time_s);
  const activityDurationMs = finitePositiveMilliseconds(activity?.duration_s);
  const durationSource = metadata?.duration_source?.toLowerCase() ?? "";
  const activityDurationIsTimer = durationSource.includes("timer");

  const movingDurationMs = firstPositive(
    timerTimeMs,
    topLevelTimerMs,
    sessionTimerMs,
    activityDurationIsTimer ? activityDurationMs : null,
  );
  const totalDurationMs = firstPositive(
    timerElapsedMs,
    topLevelElapsedMs,
    sessionElapsedMs,
    activitySpanMs,
    metadataRecordSpanMs,
    recordSpanMs > 0 ? recordSpanMs : null,
  );
  const timelineDurationMs = totalDurationMs ?? movingDurationMs ?? recordSpanMs;
  const timelineEndMs = timelineStartMs + Math.max(0, timelineDurationMs);
  const stoppedIntervals = getReliableStoppedIntervals(metadata?.timer, timelineStartMs, timelineEndMs);
  const stoppedDurationMs = stoppedIntervals.reduce((sum, interval) => sum + interval.endMs - interval.startMs, 0);
  const intervalsReliable = Boolean(
    metadata?.timer?.active_time_supported && metadata.timer.intervals_reliable,
  );
  const movingLabelSupported = movingDurationMs !== null;
  const totalLabelSupported = Boolean(timerElapsedMs ?? topLevelElapsedMs ?? sessionElapsedMs);
  const hasPositiveTimeRange = Math.max(timelineDurationMs, recordSpanMs) > 0;
  const hasDistinctTotalTime = movingDurationMs !== null
    && totalDurationMs !== null
    && totalDurationMs - movingDurationMs > DURATION_EQUIVALENCE_TOLERANCE_MS;
  const selectable = intervalsReliable && stoppedIntervals.length > 0 && hasDistinctTotalTime;
  const defaultBasis: ActivityTimeBasis = selectable || (movingLabelSupported && intervalsReliable)
    ? "moving"
    : "total";

  return {
    timelineStartMs,
    timelineEndMs,
    movingDurationMs,
    totalDurationMs,
    recordSpanMs,
    stoppedDurationMs,
    stoppedIntervals,
    intervalsReliable,
    hasPositiveTimeRange,
    hasDistinctTotalTime,
    movingLabelSupported,
    totalLabelSupported,
    selectable,
    defaultBasis,
  };
}

export function resolveEffectiveTimeBasis(
  requested: ActivityTimeBasis,
  resolution: ActivityTimeResolution,
): ActivityTimeBasis {
  if (resolution.selectable) return requested;
  return resolution.defaultBasis;
}

export function getBasisDurationMs(
  resolution: ActivityTimeResolution,
  basis: ActivityTimeBasis,
): number {
  if (basis === "moving") {
    return Math.max(
      0,
      resolution.movingDurationMs
        ?? ((resolution.totalDurationMs ?? resolution.recordSpanMs) - resolution.stoppedDurationMs),
    );
  }
  return Math.max(0, resolution.totalDurationMs ?? resolution.recordSpanMs ?? resolution.movingDurationMs ?? 0);
}
