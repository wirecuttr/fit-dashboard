import type { Activity, RecordPoint } from "../types";

export type CardiacDecouplingMode = "average_power" | "normalized_power" | "speed" | "constant_output_hr";
export type CardiacDecouplingConfidence = "high" | "medium" | "low";
export type CardiacDecouplingWarning = "high_variability_effort";
export type CardiacDecouplingUnavailableReason =
  | "duration_too_short"
  | "unsupported_activity_type"
  | "missing_heart_rate"
  | "missing_power"
  | "missing_speed"
  | "insufficient_heart_rate_coverage"
  | "insufficient_output_coverage"
  | "insufficient_paired_coverage"
  | "insufficient_rolling_window_coverage"
  | "invalid_segment_average";

export type CardiacDecouplingConfig = {
  minActivityDurationS: number;
  warmupIgnoreS: number;
  ignoreLastS: number;
  targetBinDurationS: number;
  minBinDurationS: number;
  minHrCoveragePct: number;
  minOutputCoveragePct: number;
  minPairedCoveragePct: number;
  resampleIntervalS: number;
  maxInterpolationGapS: number;
  maxRecordGapS: number;
  minRollingWindowCoveragePct: number;
  highVariabilityIndexThreshold: number;
  lowDriftThresholdPct: number;
  highDriftThresholdPct: number;
};

export type CardiacDecouplingBin = {
  startS: number;
  endS: number;
  efficiency?: number;
  avgHr: number;
  avgOutput?: number;
  hrCoveragePct: number;
  outputCoveragePct?: number;
  pairedCoveragePct?: number;
  rollingWindowCoveragePct?: number;
};

export type CardiacDecouplingModeResult = {
  available: boolean;
  reason?: CardiacDecouplingUnavailableReason;
  mode: CardiacDecouplingMode;
  decouplingPct?: number;
  firstHalfEfficiency?: number;
  secondHalfEfficiency?: number;
  firstHalfAvgHr?: number;
  secondHalfAvgHr?: number;
  firstHalfAvgOutput?: number;
  secondHalfAvgOutput?: number;
  firstHalfHrCoveragePct?: number;
  secondHalfHrCoveragePct?: number;
  firstHalfOutputCoveragePct?: number;
  secondHalfOutputCoveragePct?: number;
  firstHalfPairedCoveragePct?: number;
  secondHalfPairedCoveragePct?: number;
  firstHalfRollingWindowCoveragePct?: number;
  secondHalfRollingWindowCoveragePct?: number;
  overallBinDriftPct?: number;
  adjacentBinDriftPct?: number[];
  assumption?: "constant_output" | "cycling_speed_fallback";
  bins?: CardiacDecouplingBin[];
};

export type CardiacDecouplingResult = {
  available: boolean;
  reason?: CardiacDecouplingUnavailableReason;
  evaluatedDurationS?: number;
  warmupExcludedS?: number;
  endExcludedS?: number;
  defaultMode?: CardiacDecouplingMode;
  variabilityIndex?: number;
  warnings?: CardiacDecouplingWarning[];
  results: CardiacDecouplingModeResult[];
};

export type HeartRateDriftChartMarker = {
  elapsedMs: number;
  kind: "warmup" | "cooldown" | "bin";
  index?: number;
  efficiency?: number;
};

export type HeartRateDriftExcludedRange = {
  startMs: number;
  endMs: number;
  kind: "warmup" | "cooldown" | "gap";
};

export type HeartRateDriftChartData = {
  heartRate: Array<[number, number | null]>;
  output: Array<[number, number | null]>;
  outputMode?: Exclude<CardiacDecouplingMode, "constant_output_hr">;
  markers: HeartRateDriftChartMarker[];
  excludedRanges: HeartRateDriftExcludedRange[];
};

export const DEFAULT_CARDIAC_DECOUPLING_CONFIG: CardiacDecouplingConfig = {
  minActivityDurationS: 60 * 60,
  warmupIgnoreS: 10 * 60,
  ignoreLastS: 5 * 60,
  targetBinDurationS: 30 * 60,
  minBinDurationS: 20 * 60,
  minHrCoveragePct: 80,
  minOutputCoveragePct: 80,
  minPairedCoveragePct: 80,
  resampleIntervalS: 1,
  maxInterpolationGapS: 5,
  maxRecordGapS: 15,
  minRollingWindowCoveragePct: 90,
  highVariabilityIndexThreshold: 1.05,
  lowDriftThresholdPct: 5,
  highDriftThresholdPct: 10,
};

type ActivityClass = "cycling" | "speed" | "constant_output_machine" | "unsupported";

type ActiveInterval = {
  startRecord: RecordPoint;
  endRecord: RecordPoint;
  dtS: number;
  activeStartS: number;
  activeEndS: number;
};

type SegmentStats = {
  durationS: number;
  avgHr: number | null;
  avgOutput: number | null;
  efficiency: number | null;
  hrCoveragePct: number;
  outputCoveragePct: number;
  pairedCoveragePct: number;
};

type SegmentBounds = {
  startS: number;
  endS: number;
};

type NormalizedPowerWindow = {
  activeS: number;
  rollingPower: number | null;
  coveragePct: number;
};

type NormalizedPowerStats = {
  normalizedPower: number | null;
  rollingWindowCoveragePct: number;
};

type StreamSample = {
  activeS: number;
  elapsedMs: number;
  value: number;
};

type StreamContext = {
  heartRate: StreamSample[];
  power: StreamSample[];
  speed: StreamSample[];
  distance: StreamSample[];
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositive(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isNonNegative(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function percent(part: number, total: number): number {
  return total > 0 ? (part / total) * 100 : 0;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function readMetadataString(metadataJson: string | null | undefined, key: string): string {
  if (!metadataJson) return "";
  try {
    const parsed = JSON.parse(metadataJson) as Record<string, unknown>;
    const value = parsed[key];
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function classifyActivity(activity: Pick<Activity, "sport" | "metadata_json">): ActivityClass {
  const sport = normalizeText(activity.sport);
  const subSport = normalizeText(readMetadataString(activity.metadata_json, "sub_sport"));

  if (sport === "cycling" || (sport === "fitness_equipment" && subSport === "indoor_cycling")) {
    return "cycling";
  }

  if (
    sport === "fitness_equipment" &&
    ["elliptical", "stair_climbing", "stair_stepper"].includes(subSport)
  ) {
    return "constant_output_machine";
  }

  if (
    ["running", "walking", "hiking", "rowing", "cross_country_skiing"].includes(sport) ||
    (sport === "training" && subSport === "cardio_training") ||
    (sport === "fitness_equipment" && subSport === "indoor_rowing")
  ) {
    return "speed";
  }

  return "unsupported";
}

function sortRecords(records: RecordPoint[]): RecordPoint[] {
  const sorted = records
    .filter((record) => isFiniteNumber(record.timestamp_ms))
    .slice()
    .sort((a, b) => a.timestamp_ms - b.timestamp_ms);

  const unique: RecordPoint[] = [];
  let lastTimestamp = -Infinity;
  for (const record of sorted) {
    if (record.timestamp_ms > lastTimestamp) {
      unique.push(record);
      lastTimestamp = record.timestamp_ms;
    }
  }
  return unique;
}

function buildActiveIntervals(records: RecordPoint[], config: CardiacDecouplingConfig): ActiveInterval[] {
  const sorted = sortRecords(records);
  const intervals: ActiveInterval[] = [];
  let activeElapsedS = 0;

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const startRecord = sorted[i];
    const endRecord = sorted[i + 1];
    const dtS = (endRecord.timestamp_ms - startRecord.timestamp_ms) / 1000;
    if (dtS <= 0) continue;
    if (dtS > config.maxRecordGapS) continue;

    intervals.push({
      startRecord,
      endRecord,
      dtS,
      activeStartS: activeElapsedS,
      activeEndS: activeElapsedS + dtS,
    });
    activeElapsedS += dtS;
  }

  return intervals;
}

function getActiveDurationS(intervals: ActiveInterval[]): number {
  return intervals.length ? intervals[intervals.length - 1].activeEndS : 0;
}

function clippedDuration(interval: ActiveInterval, segment: SegmentBounds): number {
  return Math.max(0, Math.min(interval.activeEndS, segment.endS) - Math.max(interval.activeStartS, segment.startS));
}

function interpolateNumber(start: number, end: number, fraction: number): number {
  return start + (end - start) * fraction;
}

function buildActiveSamples(intervals: ActiveInterval[]): Array<{ activeS: number; elapsedMs: number; record: RecordPoint }> {
  const samples: Array<{ activeS: number; elapsedMs: number; record: RecordPoint }> = [];

  for (const interval of intervals) {
    const last = samples[samples.length - 1];
    if (!last || last.elapsedMs !== interval.startRecord.timestamp_ms) {
      samples.push({ activeS: interval.activeStartS, elapsedMs: interval.startRecord.timestamp_ms, record: interval.startRecord });
    }
    samples.push({ activeS: interval.activeEndS, elapsedMs: interval.endRecord.timestamp_ms, record: interval.endRecord });
  }

  return samples;
}

function streamSamples(
  activeSamples: Array<{ activeS: number; elapsedMs: number; record: RecordPoint }>,
  readValue: (record: RecordPoint) => unknown,
  isValid: (value: unknown) => value is number,
): StreamSample[] {
  return activeSamples
    .map((sample) => {
      const value = readValue(sample.record);
      return isValid(value) ? { activeS: sample.activeS, elapsedMs: sample.elapsedMs, value } : null;
    })
    .filter((sample): sample is StreamSample => sample !== null);
}

function buildStreamContext(intervals: ActiveInterval[]): StreamContext {
  const activeSamples = buildActiveSamples(intervals);
  return {
    heartRate: streamSamples(activeSamples, (record) => record.heart_rate, isPositive),
    power: streamSamples(activeSamples, (record) => record.power, isNonNegative),
    speed: streamSamples(activeSamples, (record) => record.speed_m_s, isNonNegative),
    distance: streamSamples(activeSamples, (record) => record.distance_m, isNonNegative),
  };
}

function lowerBoundByActiveS(samples: StreamSample[], activeS: number): number {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (samples[mid].activeS < activeS) low = mid + 1;
    else high = mid;
  }
  return low;
}

function streamValueAt(samples: StreamSample[], activeS: number, config: CardiacDecouplingConfig): number | null {
  if (!samples.length) return null;
  const index = lowerBoundByActiveS(samples, activeS);
  const exact = samples[index] ?? samples[index - 1];
  if (exact && Math.abs(exact.activeS - activeS) < 1e-9) return exact.value;

  const before = samples[index - 1];
  const after = samples[index];
  if (!before || !after) return null;

  const activeGapS = after.activeS - before.activeS;
  const elapsedGapS = (after.elapsedMs - before.elapsedMs) / 1000;
  if (activeGapS <= 0 || elapsedGapS <= 0) return null;
  if (activeGapS > config.maxInterpolationGapS || elapsedGapS > config.maxInterpolationGapS) return null;

  return interpolateNumber(before.value, after.value, (activeS - before.activeS) / activeGapS);
}

function clippedActiveBounds(interval: ActiveInterval, segment: SegmentBounds): [number, number] | null {
  const startS = Math.max(interval.activeStartS, segment.startS);
  const endS = Math.min(interval.activeEndS, segment.endS);
  if (endS <= startS) return null;
  return [startS, endS];
}

function averageStreamValue(
  samples: StreamSample[],
  interval: ActiveInterval,
  segment: SegmentBounds,
  config: CardiacDecouplingConfig,
): number | null {
  const bounds = clippedActiveBounds(interval, segment);
  if (!bounds) return null;
  const [startS, endS] = bounds;
  if (endS - startS > config.maxInterpolationGapS) return null;

  const startValue = streamValueAt(samples, startS, config);
  const endValue = streamValueAt(samples, endS, config);
  if (startValue === null || endValue === null) return null;
  return (startValue + endValue) / 2;
}

function intervalHr(interval: ActiveInterval, streams: StreamContext, config: CardiacDecouplingConfig, segment: SegmentBounds): number | null {
  return averageStreamValue(streams.heartRate, interval, segment, config);
}

function intervalPower(interval: ActiveInterval, streams: StreamContext, config: CardiacDecouplingConfig, segment: SegmentBounds): number | null {
  return averageStreamValue(streams.power, interval, segment, config);
}

function intervalDistanceSpeed(interval: ActiveInterval, streams: StreamContext, config: CardiacDecouplingConfig, segment: SegmentBounds): number | null {
  const bounds = clippedActiveBounds(interval, segment);
  if (!bounds) return null;
  const [startS, endS] = bounds;
  const durationS = endS - startS;
  if (durationS <= 0 || durationS > config.maxInterpolationGapS) return null;

  const startDistance = streamValueAt(streams.distance, startS, config);
  const endDistance = streamValueAt(streams.distance, endS, config);
  if (startDistance === null || endDistance === null || endDistance < startDistance) return null;
  return (endDistance - startDistance) / durationS;
}

function intervalSpeed(interval: ActiveInterval, streams: StreamContext, config: CardiacDecouplingConfig, segment: SegmentBounds): number | null {
  const distanceSpeed = intervalDistanceSpeed(interval, streams, config, segment);
  if (distanceSpeed !== null) return distanceSpeed;
  return averageStreamValue(streams.speed, interval, segment, config);
}

function intervalOutput(interval: ActiveInterval, streams: StreamContext, mode: CardiacDecouplingMode, config: CardiacDecouplingConfig, segment: SegmentBounds): number | null {
  if (mode === "average_power" || mode === "normalized_power") return intervalPower(interval, streams, config, segment);
  if (mode === "speed") return intervalSpeed(interval, streams, config, segment);
  return null;
}

function sampleStreamValue(samples: StreamSample[], sampleAtS: number, config: CardiacDecouplingConfig): number | null {
  return streamValueAt(samples, sampleAtS, config);
}

function sampleSpeedValue(interval: ActiveInterval, streams: StreamContext, sampleAtS: number, config: CardiacDecouplingConfig): number | null {
  if (interval.dtS <= config.maxInterpolationGapS) {
    const startDistance = streamValueAt(streams.distance, interval.activeStartS, config);
    const endDistance = streamValueAt(streams.distance, interval.activeEndS, config);
    if (startDistance !== null && endDistance !== null && endDistance >= startDistance) {
      return (endDistance - startDistance) / interval.dtS;
    }
  }
  return streamValueAt(streams.speed, sampleAtS, config);
}

function sampleOutputValue(
  interval: ActiveInterval,
  streams: StreamContext,
  sampleAtS: number,
  mode: Exclude<CardiacDecouplingMode, "constant_output_hr">,
  config: CardiacDecouplingConfig
): number | null {
  if (mode === "average_power" || mode === "normalized_power") {
    return sampleStreamValue(streams.power, sampleAtS, config);
  }
  return sampleSpeedValue(interval, streams, sampleAtS, config);
}

function measureSegment(
  intervals: ActiveInterval[],
  streams: StreamContext,
  segment: SegmentBounds,
  mode: CardiacDecouplingMode,
  config: CardiacDecouplingConfig
): SegmentStats {
  const requiresOutput = mode !== "constant_output_hr";
  let durationS = 0;
  let hrCoveredS = 0;
  let outputCoveredS = 0;
  let pairedCoveredS = 0;
  let hrSum = 0;
  let pairedHrSum = 0;
  let outputSum = 0;

  for (const interval of intervals) {
    const duration = clippedDuration(interval, segment);
    if (duration <= 0) continue;
    durationS += duration;

    const hr = intervalHr(interval, streams, config, segment);
    if (hr !== null) {
      hrCoveredS += duration;
      hrSum += hr * duration;
    }

    if (!requiresOutput) continue;

    const output = intervalOutput(interval, streams, mode, config, segment);
    if (output !== null) {
      outputCoveredS += duration;
    }
    if (hr !== null && output !== null) {
      pairedCoveredS += duration;
      pairedHrSum += hr * duration;
      outputSum += output * duration;
    }
  }

  const avgHr = requiresOutput
    ? pairedCoveredS > 0 ? pairedHrSum / pairedCoveredS : null
    : hrCoveredS > 0 ? hrSum / hrCoveredS : null;
  const avgOutput = requiresOutput && pairedCoveredS > 0 ? outputSum / pairedCoveredS : null;
  const efficiency = requiresOutput && avgHr !== null && avgOutput !== null && avgHr > 0 ? avgOutput / avgHr : null;

  return {
    durationS,
    avgHr,
    avgOutput,
    efficiency,
    hrCoveragePct: percent(hrCoveredS, durationS),
    outputCoveragePct: requiresOutput ? percent(outputCoveredS, durationS) : 0,
    pairedCoveragePct: requiresOutput ? percent(pairedCoveredS, durationS) : 0,
  };
}

function missingOutputReason(mode: CardiacDecouplingMode): CardiacDecouplingUnavailableReason {
  if (mode === "average_power" || mode === "normalized_power") return "missing_power";
  if (mode === "speed") return "missing_speed";
  return "insufficient_output_coverage";
}

function validateOutputSegment(stats: SegmentStats, mode: CardiacDecouplingMode, config: CardiacDecouplingConfig): CardiacDecouplingUnavailableReason | null {
  if (stats.hrCoveragePct <= 0) return "missing_heart_rate";
  if (stats.hrCoveragePct < config.minHrCoveragePct) return "insufficient_heart_rate_coverage";
  if (stats.avgOutput === null || stats.outputCoveragePct <= 0) return missingOutputReason(mode);
  if (stats.outputCoveragePct < config.minOutputCoveragePct) return "insufficient_output_coverage";
  if (stats.pairedCoveragePct < config.minPairedCoveragePct || stats.avgHr === null) return "insufficient_paired_coverage";
  if (stats.avgHr <= 0 || stats.avgOutput <= 0 || stats.efficiency === null || stats.efficiency <= 0) return "invalid_segment_average";
  return null;
}

function validateHrSegment(stats: SegmentStats, config: CardiacDecouplingConfig): CardiacDecouplingUnavailableReason | null {
  if (stats.avgHr === null) return "missing_heart_rate";
  if (stats.hrCoveragePct < config.minHrCoveragePct) return "insufficient_heart_rate_coverage";
  if (stats.avgHr <= 0) return "invalid_segment_average";
  return null;
}

function makeUnavailable(mode: CardiacDecouplingMode, reason: CardiacDecouplingUnavailableReason): CardiacDecouplingModeResult {
  return { available: false, mode, reason };
}

function buildBins(evaluatedStartS: number, evaluatedDurationS: number, config: CardiacDecouplingConfig): SegmentBounds[] | null {
  const maxBinCount = Math.floor(evaluatedDurationS / config.minBinDurationS);
  if (maxBinCount < 2) return null;

  const roundedTargetCount = Math.floor((evaluatedDurationS + config.targetBinDurationS / 2) / config.targetBinDurationS);
  const binCount = Math.min(Math.max(2, roundedTargetCount), maxBinCount);
  const binDurationS = evaluatedDurationS / binCount;
  if (binDurationS < config.minBinDurationS) return null;

  return Array.from({ length: binCount }, (_, index) => ({
    startS: evaluatedStartS + index * binDurationS,
    endS: index === binCount - 1 ? evaluatedStartS + evaluatedDurationS : evaluatedStartS + (index + 1) * binDurationS,
  }));
}

function calculateDrift(firstEfficiency: number, secondEfficiency: number): number {
  return ((firstEfficiency - secondEfficiency) / firstEfficiency) * 100;
}

function calculateConstantOutputDrift(firstHalfHr: number, secondHalfHr: number): number {
  return ((secondHalfHr - firstHalfHr) / secondHalfHr) * 100;
}

function binDrift(bins: CardiacDecouplingBin[]): Pick<CardiacDecouplingModeResult, "overallBinDriftPct" | "adjacentBinDriftPct"> {
  const efficiencies = bins.map((bin) => bin.efficiency).filter((value): value is number => isPositive(value));
  if (efficiencies.length !== bins.length || efficiencies.length < 2) return {};

  const adjacentBinDriftPct: number[] = [];
  for (let i = 0; i < efficiencies.length - 1; i += 1) {
    adjacentBinDriftPct.push(calculateDrift(efficiencies[i], efficiencies[i + 1]));
  }

  return {
    overallBinDriftPct: calculateDrift(efficiencies[0], efficiencies[efficiencies.length - 1]),
    adjacentBinDriftPct,
  };
}

function buildOutputBins(
  intervals: ActiveInterval[],
  streams: StreamContext,
  binSegments: SegmentBounds[],
  mode: CardiacDecouplingMode,
  config: CardiacDecouplingConfig
): { bins?: CardiacDecouplingBin[]; reason?: CardiacDecouplingUnavailableReason } {
  const bins: CardiacDecouplingBin[] = [];
  for (const segment of binSegments) {
    const stats = measureSegment(intervals, streams, segment, mode, config);
    const reason = validateOutputSegment(stats, mode, config);
    if (reason) return { reason };
    bins.push({
      startS: segment.startS,
      endS: segment.endS,
      efficiency: stats.efficiency ?? undefined,
      avgHr: stats.avgHr ?? 0,
      avgOutput: stats.avgOutput ?? undefined,
      hrCoveragePct: stats.hrCoveragePct,
      outputCoveragePct: stats.outputCoveragePct,
      pairedCoveragePct: stats.pairedCoveragePct,
    });
  }
  return { bins };
}

function buildConstantOutputBins(
  intervals: ActiveInterval[],
  streams: StreamContext,
  binSegments: SegmentBounds[],
  config: CardiacDecouplingConfig
): { bins?: CardiacDecouplingBin[]; reason?: CardiacDecouplingUnavailableReason } {
  const bins: CardiacDecouplingBin[] = [];
  for (const segment of binSegments) {
    const stats = measureSegment(intervals, streams, segment, "constant_output_hr", config);
    const reason = validateHrSegment(stats, config);
    if (reason) return { reason };
    bins.push({
      startS: segment.startS,
      endS: segment.endS,
      avgHr: stats.avgHr ?? 0,
      hrCoveragePct: stats.hrCoveragePct,
    });
  }
  return { bins };
}

function sampleStreamWithActiveTimes(
  intervals: ActiveInterval[],
  streams: StreamContext,
  segment: SegmentBounds,
  config: CardiacDecouplingConfig,
  stream: "power" | "hr"
): Array<{ activeS: number; value: number | null }> {
  const intervalS = Math.max(1, config.resampleIntervalS);
  const count = Math.floor((segment.endS - segment.startS) / intervalS);
  const samples: Array<{ activeS: number; value: number | null }> = [];
  let intervalIndex = 0;

  for (let i = 0; i < count; i += 1) {
    const sampleAtS = segment.startS + i * intervalS + intervalS / 2;
    while (intervalIndex < intervals.length && intervals[intervalIndex].activeEndS <= sampleAtS) {
      intervalIndex += 1;
    }

    const interval = intervals[intervalIndex];
    const source = stream === "power" ? streams.power : streams.heartRate;
    const value = interval && interval.activeStartS <= sampleAtS && interval.activeEndS > sampleAtS
      ? sampleStreamValue(source, sampleAtS, config)
      : null;
    samples.push({ activeS: sampleAtS, value });
  }

  return samples;
}

function buildNormalizedPowerWindows(intervals: ActiveInterval[], streams: StreamContext, evaluatedSegment: SegmentBounds, config: CardiacDecouplingConfig): NormalizedPowerWindow[] {
  const powerSamples = sampleStreamWithActiveTimes(intervals, streams, evaluatedSegment, config, "power");
  const intervalS = Math.max(1, config.resampleIntervalS);
  const windowSize = Math.round(30 / intervalS);
  if (windowSize <= 0 || powerSamples.length < windowSize) return [];

  const windows: NormalizedPowerWindow[] = [];
  for (let end = windowSize; end <= powerSamples.length; end += 1) {
    const window = powerSamples.slice(end - windowSize, end);
    const valid = window.map((sample) => sample.value).filter((value): value is number => isNonNegative(value));
    const coveragePct = percent(valid.length, window.length);
    const rollingPower = coveragePct >= config.minRollingWindowCoveragePct && valid.length
      ? valid.reduce((sum, value) => sum + value, 0) / valid.length
      : null;
    const firstActiveS = window[0]?.activeS ?? evaluatedSegment.startS;
    const centerActiveS = firstActiveS - intervalS / 2 + (windowSize * intervalS) / 2;
    windows.push({ activeS: centerActiveS, rollingPower, coveragePct });
  }
  return windows;
}

function measureNormalizedPower(windows: NormalizedPowerWindow[], segment: SegmentBounds, config: CardiacDecouplingConfig): NormalizedPowerStats {
  const candidates = windows.filter((window) => window.activeS >= segment.startS && window.activeS < segment.endS);
  if (!candidates.length) {
    return { normalizedPower: null, rollingWindowCoveragePct: 0 };
  }

  const accepted = candidates.filter((window): window is NormalizedPowerWindow & { rollingPower: number } => isNonNegative(window.rollingPower));
  const rollingWindowCoveragePct = percent(accepted.length, candidates.length);
  if (rollingWindowCoveragePct < config.minRollingWindowCoveragePct || !accepted.length) {
    return { normalizedPower: null, rollingWindowCoveragePct };
  }

  const meanFourthPower = accepted.reduce((sum, window) => sum + window.rollingPower ** 4, 0) / accepted.length;
  return {
    normalizedPower: meanFourthPower > 0 ? meanFourthPower ** 0.25 : 0,
    rollingWindowCoveragePct,
  };
}

function buildAverageOutputResult(
  intervals: ActiveInterval[],
  streams: StreamContext,
  halfSegments: [SegmentBounds, SegmentBounds],
  binSegments: SegmentBounds[],
  mode: "average_power" | "speed",
  config: CardiacDecouplingConfig,
  assumption?: CardiacDecouplingModeResult["assumption"]
): CardiacDecouplingModeResult {
  const first = measureSegment(intervals, streams, halfSegments[0], mode, config);
  const second = measureSegment(intervals, streams, halfSegments[1], mode, config);
  const firstReason = validateOutputSegment(first, mode, config);
  if (firstReason) return makeUnavailable(mode, firstReason);
  const secondReason = validateOutputSegment(second, mode, config);
  if (secondReason) return makeUnavailable(mode, secondReason);

  const binResult = buildOutputBins(intervals, streams, binSegments, mode, config);
  if (binResult.reason || !binResult.bins) return makeUnavailable(mode, binResult.reason ?? "invalid_segment_average");

  const firstEfficiency = first.efficiency ?? 0;
  const secondEfficiency = second.efficiency ?? 0;
  return {
    available: true,
    mode,
    decouplingPct: calculateDrift(firstEfficiency, secondEfficiency),
    firstHalfEfficiency: firstEfficiency,
    secondHalfEfficiency: secondEfficiency,
    firstHalfAvgHr: first.avgHr ?? undefined,
    secondHalfAvgHr: second.avgHr ?? undefined,
    firstHalfAvgOutput: first.avgOutput ?? undefined,
    secondHalfAvgOutput: second.avgOutput ?? undefined,
    firstHalfHrCoveragePct: first.hrCoveragePct,
    secondHalfHrCoveragePct: second.hrCoveragePct,
    firstHalfOutputCoveragePct: first.outputCoveragePct,
    secondHalfOutputCoveragePct: second.outputCoveragePct,
    firstHalfPairedCoveragePct: first.pairedCoveragePct,
    secondHalfPairedCoveragePct: second.pairedCoveragePct,
    ...(assumption ? { assumption } : {}),
    ...binDrift(binResult.bins),
    bins: binResult.bins,
  };
}

function buildNormalizedPowerResult(
  intervals: ActiveInterval[],
  streams: StreamContext,
  halfSegments: [SegmentBounds, SegmentBounds],
  binSegments: SegmentBounds[],
  normalizedPowerWindows: NormalizedPowerWindow[],
  config: CardiacDecouplingConfig
): CardiacDecouplingModeResult {
  const mode: CardiacDecouplingMode = "normalized_power";
  const first = measureSegment(intervals, streams, halfSegments[0], mode, config);
  const second = measureSegment(intervals, streams, halfSegments[1], mode, config);
  const firstReason = validateOutputSegment(first, mode, config);
  if (firstReason) return makeUnavailable(mode, firstReason);
  const secondReason = validateOutputSegment(second, mode, config);
  if (secondReason) return makeUnavailable(mode, secondReason);

  const firstNp = measureNormalizedPower(normalizedPowerWindows, halfSegments[0], config);
  const secondNp = measureNormalizedPower(normalizedPowerWindows, halfSegments[1], config);
  if (firstNp.normalizedPower === null || firstNp.rollingWindowCoveragePct < config.minRollingWindowCoveragePct) {
    return makeUnavailable(mode, "insufficient_rolling_window_coverage");
  }
  if (secondNp.normalizedPower === null || secondNp.rollingWindowCoveragePct < config.minRollingWindowCoveragePct) {
    return makeUnavailable(mode, "insufficient_rolling_window_coverage");
  }

  const bins: CardiacDecouplingBin[] = [];
  for (const segment of binSegments) {
    const stats = measureSegment(intervals, streams, segment, mode, config);
    const reason = validateOutputSegment(stats, mode, config);
    if (reason) return makeUnavailable(mode, reason);
    const np = measureNormalizedPower(normalizedPowerWindows, segment, config);
    if (np.normalizedPower === null || np.rollingWindowCoveragePct < config.minRollingWindowCoveragePct) {
      return makeUnavailable(mode, "insufficient_rolling_window_coverage");
    }
    const avgHr = stats.avgHr ?? 0;
    const efficiency = avgHr > 0 ? np.normalizedPower / avgHr : undefined;
    bins.push({
      startS: segment.startS,
      endS: segment.endS,
      efficiency,
      avgHr,
      avgOutput: np.normalizedPower,
      hrCoveragePct: stats.hrCoveragePct,
      outputCoveragePct: stats.outputCoveragePct,
      pairedCoveragePct: stats.pairedCoveragePct,
      rollingWindowCoveragePct: np.rollingWindowCoveragePct,
    });
  }

  const firstEfficiency = (first.avgHr ?? 0) > 0 ? firstNp.normalizedPower / (first.avgHr ?? 1) : 0;
  const secondEfficiency = (second.avgHr ?? 0) > 0 ? secondNp.normalizedPower / (second.avgHr ?? 1) : 0;
  if (firstEfficiency <= 0 || secondEfficiency <= 0) return makeUnavailable(mode, "invalid_segment_average");

  return {
    available: true,
    mode,
    decouplingPct: calculateDrift(firstEfficiency, secondEfficiency),
    firstHalfEfficiency: firstEfficiency,
    secondHalfEfficiency: secondEfficiency,
    firstHalfAvgHr: first.avgHr ?? undefined,
    secondHalfAvgHr: second.avgHr ?? undefined,
    firstHalfAvgOutput: firstNp.normalizedPower,
    secondHalfAvgOutput: secondNp.normalizedPower,
    firstHalfHrCoveragePct: first.hrCoveragePct,
    secondHalfHrCoveragePct: second.hrCoveragePct,
    firstHalfOutputCoveragePct: first.outputCoveragePct,
    secondHalfOutputCoveragePct: second.outputCoveragePct,
    firstHalfPairedCoveragePct: first.pairedCoveragePct,
    secondHalfPairedCoveragePct: second.pairedCoveragePct,
    firstHalfRollingWindowCoveragePct: firstNp.rollingWindowCoveragePct,
    secondHalfRollingWindowCoveragePct: secondNp.rollingWindowCoveragePct,
    ...binDrift(bins),
    bins,
  };
}

function buildConstantOutputResult(
  intervals: ActiveInterval[],
  streams: StreamContext,
  halfSegments: [SegmentBounds, SegmentBounds],
  binSegments: SegmentBounds[],
  config: CardiacDecouplingConfig
): CardiacDecouplingModeResult {
  const mode: CardiacDecouplingMode = "constant_output_hr";
  const first = measureSegment(intervals, streams, halfSegments[0], mode, config);
  const second = measureSegment(intervals, streams, halfSegments[1], mode, config);
  const firstReason = validateHrSegment(first, config);
  if (firstReason) return makeUnavailable(mode, firstReason);
  const secondReason = validateHrSegment(second, config);
  if (secondReason) return makeUnavailable(mode, secondReason);

  const binResult = buildConstantOutputBins(intervals, streams, binSegments, config);
  if (binResult.reason || !binResult.bins) return makeUnavailable(mode, binResult.reason ?? "invalid_segment_average");

  const firstAvgHr = first.avgHr ?? 0;
  const secondAvgHr = second.avgHr ?? 0;
  if (firstAvgHr <= 0 || secondAvgHr <= 0) return makeUnavailable(mode, "invalid_segment_average");

  return {
    available: true,
    mode,
    assumption: "constant_output",
    decouplingPct: calculateConstantOutputDrift(firstAvgHr, secondAvgHr),
    firstHalfAvgHr: firstAvgHr,
    secondHalfAvgHr: secondAvgHr,
    firstHalfHrCoveragePct: first.hrCoveragePct,
    secondHalfHrCoveragePct: second.hrCoveragePct,
    bins: binResult.bins,
  };
}

function hasOutputCoverage(intervals: ActiveInterval[], streams: StreamContext, segment: SegmentBounds, mode: "average_power" | "speed", config: CardiacDecouplingConfig): boolean {
  const stats = measureSegment(intervals, streams, segment, mode, config);
  return stats.outputCoveragePct > 0;
}

function chooseDefaultMode(
  results: CardiacDecouplingModeResult[],
  activityClass: ActivityClass
): CardiacDecouplingMode | undefined {
  const availableModes = new Set(results.filter((result) => result.available).map((result) => result.mode));
  if (!availableModes.size) return undefined;

  if (activityClass === "cycling") {
    for (const mode of ["normalized_power", "speed"] as const) {
      if (availableModes.has(mode)) return mode;
    }
  }

  if (activityClass === "constant_output_machine") {
    if (availableModes.has("speed")) return "speed";
    if (availableModes.has("constant_output_hr")) return "constant_output_hr";
  }

  if (availableModes.has("speed")) return "speed";
  return results.find((result) => result.available)?.mode;
}

function firstUnavailableReason(results: CardiacDecouplingModeResult[]): CardiacDecouplingUnavailableReason | undefined {
  return results.find((result) => !result.available && result.reason)?.reason;
}

function calculateVariabilityIndex(
  intervals: ActiveInterval[],
  streams: StreamContext,
  segment: SegmentBounds,
  normalizedPowerWindows: NormalizedPowerWindow[],
  config: CardiacDecouplingConfig
): number | undefined {
  const averageStats = measureSegment(intervals, streams, segment, "average_power", config);
  const normalized = measureNormalizedPower(normalizedPowerWindows, segment, config);
  if ((averageStats.avgOutput ?? 0) <= 0 || (normalized.normalizedPower ?? 0) <= 0) return undefined;
  return (normalized.normalizedPower ?? 0) / (averageStats.avgOutput ?? 1);
}

export function calculateCardiacDecoupling(
  activity: Pick<Activity, "sport" | "duration_s" | "metadata_json">,
  records: RecordPoint[],
  configOverrides: Partial<CardiacDecouplingConfig> = {}
): CardiacDecouplingResult {
  const config = { ...DEFAULT_CARDIAC_DECOUPLING_CONFIG, ...configOverrides };
  const activityClass = classifyActivity(activity);
  if (activityClass === "unsupported") {
    return { available: false, reason: "unsupported_activity_type", results: [] };
  }

  const intervals = buildActiveIntervals(records, config);
  const streams = buildStreamContext(intervals);
  const activeDurationS = getActiveDurationS(intervals);
  const activityDurationS = isPositive(activity.duration_s) ? activity.duration_s : activeDurationS;
  if (activityDurationS < config.minActivityDurationS) {
    return { available: false, reason: "duration_too_short", results: [] };
  }

  const evaluatedStartS = Math.min(config.warmupIgnoreS, activeDurationS);
  const evaluatedEndS = Math.max(evaluatedStartS, activeDurationS - config.ignoreLastS);
  const evaluatedDurationS = evaluatedEndS - evaluatedStartS;
  if (evaluatedDurationS < 2 * config.minBinDurationS) {
    return {
      available: false,
      reason: "duration_too_short",
      evaluatedDurationS,
      warmupExcludedS: evaluatedStartS,
      endExcludedS: activeDurationS - evaluatedEndS,
      results: [],
    };
  }

  const binSegments = buildBins(evaluatedStartS, evaluatedDurationS, config);
  if (!binSegments) {
    return {
      available: false,
      reason: "duration_too_short",
      evaluatedDurationS,
      warmupExcludedS: evaluatedStartS,
      endExcludedS: activeDurationS - evaluatedEndS,
      results: [],
    };
  }

  const halfSegments: [SegmentBounds, SegmentBounds] = [
    { startS: evaluatedStartS, endS: evaluatedStartS + evaluatedDurationS / 2 },
    { startS: evaluatedStartS + evaluatedDurationS / 2, endS: evaluatedEndS },
  ];
  const evaluatedSegment = { startS: evaluatedStartS, endS: evaluatedEndS };
  const normalizedPowerWindows = buildNormalizedPowerWindows(intervals, streams, evaluatedSegment, config);
  const results: CardiacDecouplingModeResult[] = [];

  if (activityClass === "cycling") {
    const normalizedPowerResult = buildNormalizedPowerResult(intervals, streams, halfSegments, binSegments, normalizedPowerWindows, config);
    results.push(normalizedPowerResult);
    if (!normalizedPowerResult.available) {
      if (hasOutputCoverage(intervals, streams, evaluatedSegment, "speed", config)) {
        results.push(buildAverageOutputResult(intervals, streams, halfSegments, binSegments, "speed", config, "cycling_speed_fallback"));
      } else {
        results.push(makeUnavailable("speed", "missing_speed"));
      }
    }
  } else if (activityClass === "constant_output_machine") {
    if (hasOutputCoverage(intervals, streams, evaluatedSegment, "speed", config)) {
      const speedResult = buildAverageOutputResult(intervals, streams, halfSegments, binSegments, "speed", config);
      results.push(speedResult);
      if (!speedResult.available) {
        results.push(buildConstantOutputResult(intervals, streams, halfSegments, binSegments, config));
      }
    } else {
      results.push(buildConstantOutputResult(intervals, streams, halfSegments, binSegments, config));
    }
  } else {
    if (hasOutputCoverage(intervals, streams, evaluatedSegment, "speed", config)) {
      results.push(buildAverageOutputResult(intervals, streams, halfSegments, binSegments, "speed", config));
    } else {
      results.push(makeUnavailable("speed", "missing_speed"));
    }
  }

  const available = results.some((result) => result.available);
  const defaultMode = chooseDefaultMode(results, activityClass);
  const warnings: CardiacDecouplingWarning[] = [];
  const variabilityIndex = activityClass === "cycling" ? calculateVariabilityIndex(intervals, streams, evaluatedSegment, normalizedPowerWindows, config) : undefined;
  if (variabilityIndex !== undefined && variabilityIndex > config.highVariabilityIndexThreshold) {
    warnings.push("high_variability_effort");
  }

  return {
    available,
    reason: available ? undefined : firstUnavailableReason(results) ?? "invalid_segment_average",
    evaluatedDurationS,
    warmupExcludedS: evaluatedStartS,
    endExcludedS: activeDurationS - evaluatedEndS,
    defaultMode,
    variabilityIndex,
    warnings,
    results,
  };
}

export function describeCardiacDecouplingBand(decouplingPct: number, config: CardiacDecouplingConfig = DEFAULT_CARDIAC_DECOUPLING_CONFIG): "low" | "moderate" | "high" {
  if (decouplingPct < 0) return "low";
  if (decouplingPct < config.lowDriftThresholdPct) return "low";
  if (decouplingPct <= config.highDriftThresholdPct) return "moderate";
  return "high";
}

export function describeCardiacDecouplingConfidence(
  result: Pick<CardiacDecouplingModeResult, "available" | "assumption"> | undefined,
  warnings: CardiacDecouplingWarning[] = [],
): CardiacDecouplingConfidence | undefined {
  if (!result?.available) return undefined;
  if (warnings.includes("high_variability_effort")) return "low";
  if (result.assumption === "cycling_speed_fallback") return "low";
  if (result.assumption === "constant_output") return "medium";
  return "high";
}

function activeToElapsedMs(intervals: ActiveInterval[], activeS: number, t0: number): number | null {
  if (!intervals.length) return null;
  const first = intervals[0];
  if (activeS <= first.activeStartS) return first.startRecord.timestamp_ms - t0;

  for (const interval of intervals) {
    if (activeS >= interval.activeStartS && activeS <= interval.activeEndS) {
      const fraction = interval.dtS > 0 ? (activeS - interval.activeStartS) / interval.dtS : 0;
      const startMs = interval.startRecord.timestamp_ms - t0;
      const endMs = interval.endRecord.timestamp_ms - t0;
      return startMs + (endMs - startMs) * Math.min(1, Math.max(0, fraction));
    }
  }

  const last = intervals[intervals.length - 1];
  if (activeS >= last.activeEndS) return last.endRecord.timestamp_ms - t0;
  return null;
}

function normalizeExcludedRanges(ranges: HeartRateDriftExcludedRange[]): HeartRateDriftExcludedRange[] {
  const primary = ranges.filter((range) => range.kind !== "gap" && range.endMs > range.startMs);
  const normalized: HeartRateDriftExcludedRange[] = [...primary];

  for (const gap of ranges.filter((range) => range.kind === "gap" && range.endMs > range.startMs)) {
    let segments = [{ startMs: gap.startMs, endMs: gap.endMs }];
    for (const blocker of primary) {
      segments = segments.flatMap((segment) => {
        if (segment.endMs <= blocker.startMs || segment.startMs >= blocker.endMs) return [segment];
        const trimmed: Array<{ startMs: number; endMs: number }> = [];
        if (segment.startMs < blocker.startMs) trimmed.push({ startMs: segment.startMs, endMs: blocker.startMs });
        if (segment.endMs > blocker.endMs) trimmed.push({ startMs: blocker.endMs, endMs: segment.endMs });
        return trimmed;
      });
    }
    for (const segment of segments) {
      if (segment.endMs - segment.startMs >= 1000) normalized.push({ ...segment, kind: "gap" });
    }
  }

  const order: Record<HeartRateDriftExcludedRange["kind"], number> = { warmup: 0, cooldown: 1, gap: 2 };
  return normalized.sort((a, b) => a.startMs - b.startMs || order[a.kind] - order[b.kind]);
}

function buildHeartRateDriftOutputSeries(
  intervals: ActiveInterval[],
  streams: StreamContext,
  evaluatedSegment: SegmentBounds,
  mode: Exclude<CardiacDecouplingMode, "constant_output_hr">,
  config: CardiacDecouplingConfig,
  t0: number
): Array<[number, number | null]> {
  if (mode === "normalized_power") {
    return buildNormalizedPowerWindows(intervals, streams, evaluatedSegment, config)
      .filter((window) => isNonNegative(window.rollingPower))
      .map((window) => {
        const elapsedMs = activeToElapsedMs(intervals, window.activeS, t0);
        return elapsedMs === null ? null : [elapsedMs, Number((window.rollingPower ?? 0).toFixed(2))] as [number, number];
      })
      .filter((point): point is [number, number] => point !== null);
  }

  const intervalS = Math.max(1, config.resampleIntervalS);
  const count = Math.floor((evaluatedSegment.endS - evaluatedSegment.startS) / intervalS);
  const points: Array<[number, number | null]> = [];
  let intervalIndex = 0;

  for (let i = 0; i < count; i += 1) {
    const sampleAtS = evaluatedSegment.startS + i * intervalS + intervalS / 2;
    while (intervalIndex < intervals.length && intervals[intervalIndex].activeEndS <= sampleAtS) {
      intervalIndex += 1;
    }

    const elapsedMs = activeToElapsedMs(intervals, sampleAtS, t0);
    if (elapsedMs === null) continue;

    const interval = intervals[intervalIndex];
    const value = interval && interval.activeStartS <= sampleAtS && interval.activeEndS > sampleAtS
      ? sampleOutputValue(interval, streams, sampleAtS, mode, config)
      : null;
    points.push([elapsedMs, value === null ? null : Number(value.toFixed(mode === "speed" ? 4 : 2))]);
  }

  return points;
}

export function buildHeartRateDriftChartData(
  records: RecordPoint[],
  decoupling: Pick<CardiacDecouplingResult, "evaluatedDurationS" | "warmupExcludedS" | "endExcludedS">,
  result: Pick<CardiacDecouplingModeResult, "bins" | "mode"> | undefined,
  configOverrides: Partial<CardiacDecouplingConfig> = {},
): HeartRateDriftChartData | null {
  const config = { ...DEFAULT_CARDIAC_DECOUPLING_CONFIG, ...configOverrides };
  const sorted = sortRecords(records);
  if (sorted.length < 2 || typeof decoupling.evaluatedDurationS !== "number") return null;
  if (!result) return null;

  const t0 = sorted[0].timestamp_ms;
  const totalElapsedMs = Math.max(0, sorted[sorted.length - 1].timestamp_ms - t0);
  const intervals = buildActiveIntervals(sorted, config);
  if (!intervals.length) return null;
  const streams = buildStreamContext(intervals);

  const evaluatedStartS = decoupling.warmupExcludedS ?? 0;
  const evaluatedEndS = evaluatedStartS + decoupling.evaluatedDurationS;
  const evaluatedSegment = { startS: evaluatedStartS, endS: evaluatedEndS };
  const evaluatedStartMs = activeToElapsedMs(intervals, evaluatedStartS, t0);
  const evaluatedEndMs = activeToElapsedMs(intervals, evaluatedEndS, t0);

  const excludedRanges: HeartRateDriftExcludedRange[] = [];
  if (evaluatedStartMs !== null && evaluatedStartMs > 0) {
    excludedRanges.push({ startMs: 0, endMs: evaluatedStartMs, kind: "warmup" });
  }
  if (evaluatedEndMs !== null && evaluatedEndMs < totalElapsedMs) {
    excludedRanges.push({ startMs: evaluatedEndMs, endMs: totalElapsedMs, kind: "cooldown" });
  }
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const dtS = (sorted[i + 1].timestamp_ms - sorted[i].timestamp_ms) / 1000;
    if (dtS > config.maxRecordGapS) {
      excludedRanges.push({
        startMs: sorted[i].timestamp_ms - t0,
        endMs: sorted[i + 1].timestamp_ms - t0,
        kind: "gap",
      });
    }
  }

  const markers: HeartRateDriftChartMarker[] = [];
  const bins = result?.bins ?? [];
  if (bins.length) {
    for (let i = 0; i < bins.length; i += 1) {
      const elapsedMs = activeToElapsedMs(intervals, bins[i].startS, t0);
      if (elapsedMs !== null) markers.push({ elapsedMs, kind: "bin", index: i + 1, efficiency: bins[i].efficiency });
    }
  } else if (evaluatedStartMs !== null) {
    markers.push({ elapsedMs: evaluatedStartMs, kind: "warmup" });
  }
  if (evaluatedEndMs !== null) markers.push({ elapsedMs: evaluatedEndMs, kind: "cooldown" });

  const output = result.mode === "constant_output_hr"
    ? []
    : buildHeartRateDriftOutputSeries(intervals, streams, evaluatedSegment, result.mode, config, t0);

  const heartRate: Array<[number, number | null]> = sorted.map((record) => [
    record.timestamp_ms - t0,
    isPositive(record.heart_rate) ? record.heart_rate : null,
  ]);

  return {
    heartRate,
    output,
    ...(result.mode === "constant_output_hr" ? {} : { outputMode: result.mode }),
    markers,
    excludedRanges: normalizeExcludedRanges(excludedRanges),
  };
}
