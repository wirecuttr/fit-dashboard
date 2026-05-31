import type { Activity, RecordPoint } from "../types";

export type CardiacDecouplingMode = "average_power" | "normalized_power" | "speed" | "constant_output_hr";
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
  defaultCyclingDisplayMode: "normalized_power" | "average_power";
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
  assumption?: "constant_output";
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
  defaultCyclingDisplayMode: "normalized_power",
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

type NormalizedPowerStats = {
  normalizedPower: number | null;
  rollingWindowCoveragePct: number;
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

function containsAny(value: string, tokens: string[]): boolean {
  return tokens.some((token) => value.includes(token));
}

function classifyActivity(activity: Pick<Activity, "sport" | "activity_name" | "file_name">): ActivityClass {
  const sport = normalizeText(activity.sport);
  const name = normalizeText(`${activity.activity_name} ${activity.file_name}`);
  const combined = `${sport} ${name}`;

  if (containsAny(combined, ["cycling", "biking", "bike", "spin"])) return "cycling";
  if (containsAny(combined, ["elliptical", "stair_climbing", "stair_stepper", "stairs"])) return "constant_output_machine";
  if (containsAny(combined, ["running", "walking", "hiking", "rowing", "cross_country_skiing", "skiing", "cardio", "training", "fitness_equipment"])) {
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

function intervalHr(interval: ActiveInterval, config: CardiacDecouplingConfig): number | null {
  if (interval.dtS > config.maxInterpolationGapS) return null;
  return isPositive(interval.startRecord.heart_rate) ? interval.startRecord.heart_rate : null;
}

function intervalPower(interval: ActiveInterval, config: CardiacDecouplingConfig): number | null {
  if (interval.dtS > config.maxInterpolationGapS) return null;
  return isNonNegative(interval.startRecord.power) ? interval.startRecord.power : null;
}

function intervalDistanceSpeed(interval: ActiveInterval, config: CardiacDecouplingConfig): number | null {
  if (interval.dtS > config.maxInterpolationGapS) return null;
  const startDistance = interval.startRecord.distance_m;
  const endDistance = interval.endRecord.distance_m;
  if (!isNonNegative(startDistance) || !isNonNegative(endDistance)) return null;
  const deltaDistance = endDistance - startDistance;
  if (deltaDistance < 0) return null;
  return deltaDistance / interval.dtS;
}

function intervalSpeed(interval: ActiveInterval, config: CardiacDecouplingConfig): number | null {
  const distanceSpeed = intervalDistanceSpeed(interval, config);
  if (distanceSpeed !== null) return distanceSpeed;
  if (interval.dtS > config.maxInterpolationGapS) return null;
  return isNonNegative(interval.startRecord.speed_m_s) ? interval.startRecord.speed_m_s : null;
}

function intervalOutput(interval: ActiveInterval, mode: CardiacDecouplingMode, config: CardiacDecouplingConfig): number | null {
  if (mode === "average_power" || mode === "normalized_power") return intervalPower(interval, config);
  if (mode === "speed") return intervalSpeed(interval, config);
  return null;
}

function measureSegment(
  intervals: ActiveInterval[],
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

    const hr = intervalHr(interval, config);
    if (hr !== null) {
      hrCoveredS += duration;
      hrSum += hr * duration;
    }

    if (!requiresOutput) continue;

    const output = intervalOutput(interval, mode, config);
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

function validateOutputSegment(stats: SegmentStats, config: CardiacDecouplingConfig): CardiacDecouplingUnavailableReason | null {
  if (stats.avgHr === null) return "missing_heart_rate";
  if (stats.hrCoveragePct < config.minHrCoveragePct) return "insufficient_heart_rate_coverage";
  if (stats.avgOutput === null) return "insufficient_output_coverage";
  if (stats.outputCoveragePct < config.minOutputCoveragePct) return "insufficient_output_coverage";
  if (stats.pairedCoveragePct < config.minPairedCoveragePct) return "insufficient_paired_coverage";
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
  binSegments: SegmentBounds[],
  mode: CardiacDecouplingMode,
  config: CardiacDecouplingConfig
): { bins?: CardiacDecouplingBin[]; reason?: CardiacDecouplingUnavailableReason } {
  const bins: CardiacDecouplingBin[] = [];
  for (const segment of binSegments) {
    const stats = measureSegment(intervals, segment, mode, config);
    const reason = validateOutputSegment(stats, config);
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
  binSegments: SegmentBounds[],
  config: CardiacDecouplingConfig
): { bins?: CardiacDecouplingBin[]; reason?: CardiacDecouplingUnavailableReason } {
  const bins: CardiacDecouplingBin[] = [];
  for (const segment of binSegments) {
    const stats = measureSegment(intervals, segment, "constant_output_hr", config);
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

function sampleStream(
  intervals: ActiveInterval[],
  segment: SegmentBounds,
  config: CardiacDecouplingConfig,
  stream: "power" | "hr"
): Array<number | null> {
  const intervalS = Math.max(1, config.resampleIntervalS);
  const count = Math.floor((segment.endS - segment.startS) / intervalS);
  const samples: Array<number | null> = [];
  let intervalIndex = 0;

  for (let i = 0; i < count; i += 1) {
    const sampleAtS = segment.startS + i * intervalS + intervalS / 2;
    while (intervalIndex < intervals.length && intervals[intervalIndex].activeEndS <= sampleAtS) {
      intervalIndex += 1;
    }

    const interval = intervals[intervalIndex];
    if (!interval || interval.activeStartS > sampleAtS || interval.activeEndS <= sampleAtS) {
      samples.push(null);
      continue;
    }

    samples.push(stream === "power" ? intervalPower(interval, config) : intervalHr(interval, config));
  }

  return samples;
}

function measureNormalizedPower(intervals: ActiveInterval[], segment: SegmentBounds, config: CardiacDecouplingConfig): NormalizedPowerStats {
  const powerSamples = sampleStream(intervals, segment, config, "power");
  const intervalS = Math.max(1, config.resampleIntervalS);
  const windowSize = Math.round(30 / intervalS);
  const possibleWindows = Math.max(0, powerSamples.length - windowSize + 1);
  if (windowSize <= 0 || possibleWindows <= 0) {
    return { normalizedPower: null, rollingWindowCoveragePct: 0 };
  }

  const acceptedAverages: number[] = [];
  for (let end = windowSize; end <= powerSamples.length; end += 1) {
    const window = powerSamples.slice(end - windowSize, end);
    const valid = window.filter((value): value is number => isNonNegative(value));
    const coveragePct = percent(valid.length, window.length);
    if (coveragePct < config.minRollingWindowCoveragePct) continue;
    acceptedAverages.push(valid.reduce((sum, value) => sum + value, 0) / valid.length);
  }

  const rollingWindowCoveragePct = percent(acceptedAverages.length, possibleWindows);
  if (rollingWindowCoveragePct < config.minRollingWindowCoveragePct || !acceptedAverages.length) {
    return { normalizedPower: null, rollingWindowCoveragePct };
  }

  const meanFourthPower = acceptedAverages.reduce((sum, value) => sum + value ** 4, 0) / acceptedAverages.length;
  return {
    normalizedPower: meanFourthPower > 0 ? meanFourthPower ** 0.25 : 0,
    rollingWindowCoveragePct,
  };
}

function buildAverageOutputResult(
  intervals: ActiveInterval[],
  halfSegments: [SegmentBounds, SegmentBounds],
  binSegments: SegmentBounds[],
  mode: "average_power" | "speed",
  config: CardiacDecouplingConfig
): CardiacDecouplingModeResult {
  const first = measureSegment(intervals, halfSegments[0], mode, config);
  const second = measureSegment(intervals, halfSegments[1], mode, config);
  const firstReason = validateOutputSegment(first, config);
  if (firstReason) return makeUnavailable(mode, firstReason);
  const secondReason = validateOutputSegment(second, config);
  if (secondReason) return makeUnavailable(mode, secondReason);

  const binResult = buildOutputBins(intervals, binSegments, mode, config);
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
    ...binDrift(binResult.bins),
    bins: binResult.bins,
  };
}

function buildNormalizedPowerResult(
  intervals: ActiveInterval[],
  halfSegments: [SegmentBounds, SegmentBounds],
  binSegments: SegmentBounds[],
  config: CardiacDecouplingConfig
): CardiacDecouplingModeResult {
  const mode: CardiacDecouplingMode = "normalized_power";
  const first = measureSegment(intervals, halfSegments[0], mode, config);
  const second = measureSegment(intervals, halfSegments[1], mode, config);
  const firstReason = validateOutputSegment(first, config);
  if (firstReason) return makeUnavailable(mode, firstReason);
  const secondReason = validateOutputSegment(second, config);
  if (secondReason) return makeUnavailable(mode, secondReason);

  const firstNp = measureNormalizedPower(intervals, halfSegments[0], config);
  const secondNp = measureNormalizedPower(intervals, halfSegments[1], config);
  if (firstNp.normalizedPower === null || firstNp.rollingWindowCoveragePct < config.minRollingWindowCoveragePct) {
    return makeUnavailable(mode, "insufficient_rolling_window_coverage");
  }
  if (secondNp.normalizedPower === null || secondNp.rollingWindowCoveragePct < config.minRollingWindowCoveragePct) {
    return makeUnavailable(mode, "insufficient_rolling_window_coverage");
  }

  const bins: CardiacDecouplingBin[] = [];
  for (const segment of binSegments) {
    const stats = measureSegment(intervals, segment, mode, config);
    const reason = validateOutputSegment(stats, config);
    if (reason) return makeUnavailable(mode, reason);
    const np = measureNormalizedPower(intervals, segment, config);
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
  halfSegments: [SegmentBounds, SegmentBounds],
  binSegments: SegmentBounds[],
  config: CardiacDecouplingConfig
): CardiacDecouplingModeResult {
  const mode: CardiacDecouplingMode = "constant_output_hr";
  const first = measureSegment(intervals, halfSegments[0], mode, config);
  const second = measureSegment(intervals, halfSegments[1], mode, config);
  const firstReason = validateHrSegment(first, config);
  if (firstReason) return makeUnavailable(mode, firstReason);
  const secondReason = validateHrSegment(second, config);
  if (secondReason) return makeUnavailable(mode, secondReason);

  const binResult = buildConstantOutputBins(intervals, binSegments, config);
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

function hasOutputCoverage(intervals: ActiveInterval[], segment: SegmentBounds, mode: "average_power" | "speed", config: CardiacDecouplingConfig): boolean {
  const stats = measureSegment(intervals, segment, mode, config);
  return stats.outputCoveragePct > 0;
}

function chooseDefaultMode(
  results: CardiacDecouplingModeResult[],
  activityClass: ActivityClass,
  config: CardiacDecouplingConfig
): CardiacDecouplingMode | undefined {
  const availableModes = new Set(results.filter((result) => result.available).map((result) => result.mode));
  if (!availableModes.size) return undefined;

  if (activityClass === "cycling") {
    if (availableModes.has(config.defaultCyclingDisplayMode)) return config.defaultCyclingDisplayMode;
    for (const mode of ["normalized_power", "average_power", "speed"] as const) {
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
  segment: SegmentBounds,
  config: CardiacDecouplingConfig
): number | undefined {
  const averageStats = measureSegment(intervals, segment, "average_power", config);
  const normalized = measureNormalizedPower(intervals, segment, config);
  if ((averageStats.avgOutput ?? 0) <= 0 || (normalized.normalizedPower ?? 0) <= 0) return undefined;
  return (normalized.normalizedPower ?? 0) / (averageStats.avgOutput ?? 1);
}

export function calculateCardiacDecoupling(
  activity: Pick<Activity, "sport" | "activity_name" | "file_name" | "duration_s">,
  records: RecordPoint[],
  configOverrides: Partial<CardiacDecouplingConfig> = {}
): CardiacDecouplingResult {
  const config = { ...DEFAULT_CARDIAC_DECOUPLING_CONFIG, ...configOverrides };
  const activityClass = classifyActivity(activity);
  if (activityClass === "unsupported") {
    return { available: false, reason: "unsupported_activity_type", results: [] };
  }

  const intervals = buildActiveIntervals(records, config);
  const activeDurationS = getActiveDurationS(intervals);
  if (activeDurationS < config.minActivityDurationS) {
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
  const results: CardiacDecouplingModeResult[] = [];

  if (activityClass === "cycling") {
    const hasPower = hasOutputCoverage(intervals, evaluatedSegment, "average_power", config);
    if (hasPower) {
      results.push(buildAverageOutputResult(intervals, halfSegments, binSegments, "average_power", config));
      results.push(buildNormalizedPowerResult(intervals, halfSegments, binSegments, config));
    }
    if (!results.some((result) => result.available && (result.mode === "average_power" || result.mode === "normalized_power"))) {
      if (hasOutputCoverage(intervals, evaluatedSegment, "speed", config)) {
        results.push(buildAverageOutputResult(intervals, halfSegments, binSegments, "speed", config));
      } else if (!hasPower) {
        results.push(makeUnavailable("speed", "missing_speed"));
      }
    }
  } else if (activityClass === "constant_output_machine") {
    if (hasOutputCoverage(intervals, evaluatedSegment, "speed", config)) {
      const speedResult = buildAverageOutputResult(intervals, halfSegments, binSegments, "speed", config);
      results.push(speedResult);
      if (!speedResult.available) {
        results.push(buildConstantOutputResult(intervals, halfSegments, binSegments, config));
      }
    } else {
      results.push(buildConstantOutputResult(intervals, halfSegments, binSegments, config));
    }
  } else {
    if (hasOutputCoverage(intervals, evaluatedSegment, "speed", config)) {
      results.push(buildAverageOutputResult(intervals, halfSegments, binSegments, "speed", config));
    } else {
      results.push(makeUnavailable("speed", "missing_speed"));
    }
  }

  const available = results.some((result) => result.available);
  const defaultMode = chooseDefaultMode(results, activityClass, config);
  const warnings: CardiacDecouplingWarning[] = [];
  const variabilityIndex = activityClass === "cycling" ? calculateVariabilityIndex(intervals, evaluatedSegment, config) : undefined;
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
  const absValue = Math.abs(decouplingPct);
  if (absValue < config.lowDriftThresholdPct) return "low";
  if (absValue <= config.highDriftThresholdPct) return "moderate";
  return "high";
}
