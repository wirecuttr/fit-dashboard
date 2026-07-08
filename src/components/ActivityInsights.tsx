import { useState } from "react";
import ReactECharts from "echarts-for-react";
import type { Activity, RecordPoint } from "../types";
import { enableChartWheelPageScroll } from "../lib/chartScroll";
import { buildHeartRateZones, resolveHeartRateZoneIndex } from "../lib/hrZones";
import { buildPowerZones, resolveNumericZoneIndex, zoneSecondsToMinutes, type ActivityZones } from "../lib/zones";
import { applyRollingAverageSeries, getDynamicSmoothingWindow } from "../lib/chartSmoothing";
import { getRecordDataAvailability } from "../lib/recordDataAvailability";
import {
  convertElevationMeters,
  convertSpeedMps,
  elevationLabel,
  paceLabel,
  speedLabel,
  type DistanceUnit,
} from "../lib/units";
import {
  buildLapMarkers,
  buildTelemetryPoints,
  buildTelemetryXAxisBounds,
  formatRelTime,
  formatTelemetryTooltipHeader,
  formatTelemetryXAxisTick,
  type TelemetryTimerMetadata,
  type TelemetryXAxisMode,
} from "../lib/telemetryAxis";
import { useTranslation } from "../lib/i18n";
import {
  buildHeartRateDriftChartData,
  calculateCardiacDecoupling,
  describeCardiacDecouplingBand,
  describeCardiacDecouplingConfidence,
  type CardiacDecouplingConfidence,
  type CardiacDecouplingWarning,
  type HeartRateDriftChartMarker,
  type HeartRateDriftExcludedRange,
  type CardiacDecouplingMode,
  type CardiacDecouplingModeResult,
} from "../lib/cardiacDecoupling";

type Props = {
  activity?: Activity | null;
  records: RecordPoint[];
  analysisRecords?: RecordPoint[];
  theme: "light" | "dark";
  distanceUnit: DistanceUnit;
  xAxisMode?: TelemetryXAxisMode;
  zones?: ActivityZones | null;
  heartRateZoneBoundsBpm?: number[];
  zoomRange?: { start: number; end: number } | null;
  onZoomChange?: (range: { start: number; end: number }) => void;
  lapTimestampsUtc?: string[];
  smoothGraphs?: boolean;
  timerMetadata?: TelemetryTimerMetadata | null;
};

type SeriesRow = [number, number | null, number, number, number | null];
type ScatterMetricKey = "heartRate" | "power" | "cadence" | "speed" | "pace" | "elevation";
type ScatterPresetKey = "power_heart_rate" | "power_cadence" | "cadence_heart_rate" | "speed_heart_rate" | "pace_heart_rate" | "elevation_heart_rate";

type ScatterPreset = {
  key: ScatterPresetKey;
  yMetric: ScatterMetricKey;
  xMetric: ScatterMetricKey;
};

const SCATTER_PRESETS: ScatterPreset[] = [
  { key: "power_heart_rate", yMetric: "power", xMetric: "heartRate" },
  { key: "power_cadence", yMetric: "power", xMetric: "cadence" },
  { key: "cadence_heart_rate", yMetric: "cadence", xMetric: "heartRate" },
  { key: "pace_heart_rate", yMetric: "pace", xMetric: "heartRate" },
  { key: "speed_heart_rate", yMetric: "speed", xMetric: "heartRate" },
  { key: "elevation_heart_rate", yMetric: "elevation", xMetric: "heartRate" },
];

function isSeriesRow(row: [number | null, number | null, number, number, number | null]): row is SeriesRow {
  return typeof row[0] === "number" && Number.isFinite(row[0]);
}

type ZoneDefinition = {
  minExclusive: number;
  maxInclusive: number | null;
  color: string;
};

type ZoneTimeBarsProps = {
  title: string;
  zones: ZoneDefinition[];
  minutes: number[];
  unit: string;
  totalMinutes: number;
};

function formatDurationClock(minutes: number): string {
  const totalSec = Math.round(Math.max(0, minutes) * 60);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type ZoneTimeRow = {
  label: string;
  range: string;
  minutes: number;
  color: string;
};

function buildZoneTimeRows(zones: ZoneDefinition[], minutes: number[], unit: string): ZoneTimeRow[] {
  const lowerBounds = zones
    .slice(0, -1)
    .map((zone) => zone.maxInclusive)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  if (lowerBounds.length >= 2 && minutes.length >= lowerBounds.length) {
    const rows: ZoneTimeRow[] = [
      {
        label: "<Z1",
        range: `<${Math.round(lowerBounds[0])} ${unit}`,
        minutes: minutes[0] ?? 0,
        color: zones[0]?.color ?? "#94a3b8",
      },
    ];

    for (let idx = 1; idx < lowerBounds.length - 1; idx += 1) {
      rows.push({
        label: `Z${idx}`,
        range: `${Math.round(lowerBounds[idx - 1])}-${Math.round(lowerBounds[idx] - 1)} ${unit}`,
        minutes: minutes[idx] ?? 0,
        color: zones[idx]?.color ?? "#94a3b8",
      });
    }

    const lastNamedZone = lowerBounds.length - 1;
    rows.push({
      label: `Z${lastNamedZone}`,
      range: `>${Math.round(lowerBounds[lastNamedZone - 1] - 1)} ${unit}`,
      minutes: minutes.slice(lastNamedZone).reduce((sum, value) => sum + value, 0),
      color: zones[lastNamedZone]?.color ?? zones[zones.length - 1]?.color ?? "#94a3b8",
    });

    return rows;
  }

  return zones.map((zone, idx) => {
    let range: string;
    if (zone.maxInclusive === null) {
      range = `>${Math.round(zone.minExclusive)} ${unit}`;
    } else if (!Number.isFinite(zone.minExclusive)) {
      range = `<=${Math.round(zone.maxInclusive)} ${unit}`;
    } else {
      range = `${Math.round(zone.minExclusive + 1)}-${Math.round(zone.maxInclusive)} ${unit}`;
    }

    return {
      label: `Z${idx + 1}`,
      range,
      minutes: minutes[idx] ?? 0,
      color: zone.color,
    };
  });
}

function ZoneTimeBars({ title, zones, minutes, unit, totalMinutes }: ZoneTimeBarsProps) {
  const rows = buildZoneTimeRows(zones, minutes, unit);
  const chartTotalMinutes = Math.max(0, totalMinutes);
  const zoneTotalMinutes = rows.reduce((sum, row) => sum + row.minutes, 0);

  return (
    <div className="zone-time-bars" aria-label={title}>
      {rows.map((row) => {
        const percentOfTotal = chartTotalMinutes > 0 ? (row.minutes / chartTotalMinutes) * 100 : 0;
        const percentOfZoneTime = zoneTotalMinutes > 0 ? (row.minutes / zoneTotalMinutes) * 100 : 0;
        const duration = formatDurationClock(row.minutes);

        return (
          <div
            key={`${row.label}-${row.range}`}
            className={`zone-time-row${row.minutes <= 0 ? " empty" : ""}`}
            title={`${row.label} - ${row.range} - ${duration} - ${percentOfTotal.toFixed(0)}% of activity - ${percentOfZoneTime.toFixed(0)}% of zone time`}
          >
            <span className="zone-time-label">{row.label}</span>
            <span className="zone-time-range">{row.range}</span>
            <span className="zone-time-duration">{duration}</span>
            <span className="zone-time-track" aria-hidden="true">
              <span
                className="zone-time-fill"
                style={{
                  width: `${Math.min(100, percentOfTotal)}%`,
                  backgroundColor: row.color,
                }}
              />
            </span>
          </div>
        );
      })}
    </div>
  );
}

function formatPercent(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}%` : "--";
}

function formatMetric(value: number | undefined, digits = 2): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "--";
}

function formatPaceValue(value: number): string {
  if (!Number.isFinite(value)) return "--";
  let minutes = Math.floor(value);
  let seconds = Math.round((value - minutes) * 60);
  if (seconds >= 60) {
    minutes += 1;
    seconds -= 60;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function normalizeActivityText(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function metadataString(metadataJson: string | null | undefined, key: string): string {
  if (!metadataJson) return "";
  try {
    const parsed = JSON.parse(metadataJson) as Record<string, unknown>;
    const value = parsed[key];
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function activityUsesPaceDisplay(activity: Pick<Activity, "sport" | "metadata_json"> | null | undefined): boolean {
  if (!activity) return false;
  const sport = normalizeActivityText(activity.sport);
  const subSport = normalizeActivityText(metadataString(activity.metadata_json, "sub_sport"));
  if (["running", "walking", "hiking"].includes(sport)) return true;
  return ["treadmill", "trail", "track", "indoor_running", "indoor_walking", "casual_walking", "speed_walking"].includes(subSport);
}

function paceFromSpeedMps(valueMps: number, distanceUnit: DistanceUnit): number | null {
  const speedInUnit = convertSpeedMps(valueMps, distanceUnit);
  return speedInUnit > 0 ? 60 / speedInUnit : null;
}

function cardiacModeLabel(mode: CardiacDecouplingMode, t: (key: string) => string, usePaceLabel = false): string {
  switch (mode) {
    case "average_power": return t("insights.cardiacModeAveragePower");
    case "normalized_power": return t("insights.cardiacModeNormalizedPower");
    case "speed": return usePaceLabel ? t("chart.pace") : t("insights.cardiacModeSpeed");
    case "constant_output_hr": return t("insights.cardiacModeConstantEffort");
  }
}

function cardiacBandLabel(decouplingPct: number | undefined, t: (key: string) => string): string {
  if (typeof decouplingPct !== "number" || !Number.isFinite(decouplingPct)) return "";
  const band = describeCardiacDecouplingBand(decouplingPct);
  if (band === "low") return t("insights.cardiacBandLow");
  if (band === "moderate") return t("insights.cardiacBandModerate");
  return t("insights.cardiacBandHigh");
}

function cardiacConfidenceLabel(confidence: CardiacDecouplingConfidence | undefined, t: (key: string) => string): string {
  if (confidence === "high") return t("insights.cardiacConfidenceHigh");
  if (confidence === "medium") return t("insights.cardiacConfidenceMedium");
  if (confidence === "low") return t("insights.cardiacConfidenceLow");
  return "";
}

function cardiacConfidenceReasonLabel(
  result: CardiacDecouplingModeResult | undefined,
  warnings: CardiacDecouplingWarning[] | undefined,
  t: (key: string) => string,
): string {
  if (!result?.available) return "";
  if (warnings?.includes("high_variability_effort")) return t("insights.cardiacConfidenceReasonHighVariability");
  if (result.assumption === "cycling_speed_fallback") return t("insights.cardiacConfidenceReasonSpeedFallback");
  if (result.assumption === "constant_output") return t("insights.cardiacConfidenceReasonConstantOutput");
  return "";
}

function cardiacEfficiencyDigits(mode: CardiacDecouplingMode): number {
  return mode === "speed" ? 4 : 2;
}

function heartRateDriftMarkerLabel(
  marker: HeartRateDriftChartMarker,
  mode: CardiacDecouplingMode,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (marker.kind === "warmup") return t("insights.hrDriftWarmup");
  if (marker.kind === "cooldown") return t("insights.hrDriftCooldown");

  const binLabel = t("insights.hrDriftBin", { index: marker.index ?? "" });
  if (typeof marker.efficiency !== "number" || !Number.isFinite(marker.efficiency)) return binLabel;

  return `${binLabel} - EF ${marker.efficiency.toFixed(cardiacEfficiencyDigits(mode))}`;
}

function heartRateDriftRangeLabel(kind: HeartRateDriftExcludedRange["kind"], t: (key: string) => string): string {
  if (kind === "warmup") return t("insights.hrDriftWarmup");
  if (kind === "cooldown") return t("insights.hrDriftCooldown");
  return t("insights.hrDriftGap");
}

function paddedAxisBounds(points: Array<[number, number | null]>, minFloor: number, minPadding: number, step = 10): { min: number; max: number } | undefined {
  const values = points.flatMap(([, value]) => typeof value === "number" && Number.isFinite(value) ? [value] : []);
  if (!values.length) return undefined;

  const axisStep = Math.max(1, step);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const range = Math.max(high - low, minPadding);
  const padding = Math.max(minPadding, range * 0.1);
  const min = Math.max(minFloor, Math.floor((low - padding) / axisStep) * axisStep);
  let max = Math.ceil((high + padding) / axisStep) * axisStep;
  if (max <= min) max = min + axisStep;
  return { min, max };
}

function paddedAxisBoundsWithMinimumRange(points: Array<[number, number | null]>, minimumRange: number, step = 1): { min: number; max: number } | undefined {
  const values = points.flatMap(([, value]) => typeof value === "number" && Number.isFinite(value) ? [value] : []);
  if (!values.length) return undefined;

  const axisStep = Math.max(0.1, step);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const observedRange = high - low;
  const targetRange = Math.max(minimumRange, observedRange > 0 ? observedRange * 1.2 : minimumRange);
  const center = (low + high) / 2;
  let min = Math.floor((center - targetRange / 2) / axisStep) * axisStep;
  let max = Math.ceil((center + targetRange / 2) / axisStep) * axisStep;
  if (max - min < minimumRange) {
    const extra = (minimumRange - (max - min)) / 2;
    min = Math.floor((min - extra) / axisStep) * axisStep;
    max = Math.ceil((max + extra) / axisStep) * axisStep;
  }
  return { min, max };
}

function selectCardiacResult(results: CardiacDecouplingModeResult[], defaultMode: CardiacDecouplingMode | undefined): CardiacDecouplingModeResult | undefined {
  return results.find((result) => result.mode === defaultMode) ?? results.find((result) => result.available) ?? results[0];
}

export function ActivityInsights({
  activity,
  records,
  analysisRecords = [],
  theme,
  distanceUnit,
  xAxisMode = "time",
  zones,
  heartRateZoneBoundsBpm,
  zoomRange,
  onZoomChange,
  lapTimestampsUtc = [],
  smoothGraphs = true,
  timerMetadata,
}: Props) {
  const hrZones = buildHeartRateZones(heartRateZoneBoundsBpm);
  const powerZones = buildPowerZones(zones?.power?.upper_bounds_watts);
  const isDark = theme === "dark";
  const { t: tr } = useTranslation();
  const [heartRateDriftHelpOpen, setHeartRateDriftHelpOpen] = useState(false);
  const [scatterPresetKey, setScatterPresetKey] = useState<ScatterPresetKey>("power_heart_rate");
  const availability = getRecordDataAvailability(records);
  const axisColor = isDark ? "#8899b8" : "#64748b";
  const gridLine = isDark ? "rgba(100, 140, 220, 0.08)" : "rgba(0, 0, 0, 0.06)";
  const heartRateDriftGridLine = isDark ? "rgba(148, 163, 184, 0.18)" : "rgba(15, 23, 42, 0.12)";
  const tooltipBg = isDark ? "rgba(14, 22, 45, 0.95)" : "rgba(255, 255, 255, 0.95)";
  const tooltipBorder = isDark ? "rgba(100, 140, 220, 0.2)" : "rgba(0, 0, 0, 0.08)";
  const tooltipText = isDark ? "#e2e8f4" : "#0f172a";

  const tooltipStyle = {
    backgroundColor: tooltipBg,
    borderColor: tooltipBorder,
    textStyle: { color: tooltipText, fontSize: 12 },
  };

  if (!records.length) {
    return (
      <div className="empty-state" style={{ minHeight: 200 }}>
        <span className="empty-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg></span>
        <span>{tr("insights.emptyState")}</span>
      </div>
    );
  }

  const t0 = records[0]?.timestamp_ms ?? 0;
  const telemetryPoints = buildTelemetryPoints(records, t0, xAxisMode, distanceUnit, timerMetadata);
  const totalDurationMs = Math.max(0, telemetryPoints[telemetryPoints.length - 1]?.relMs ?? ((records[records.length - 1]?.timestamp_ms ?? t0) - t0));
  const smoothWindow = smoothGraphs ? getDynamicSmoothingWindow(telemetryPoints.length || records.length, totalDurationMs, zoomRange) : 1;
  const xAxisBounds = buildTelemetryXAxisBounds(telemetryPoints);
  const formatTooltipHeader = (relMs: number, distanceMeters: number | null, mode: TelemetryXAxisMode = xAxisMode, timestampMs?: number) =>
    formatTelemetryTooltipHeader(mode, t0, relMs, distanceMeters, distanceUnit, timestampMs);

  const timeline = telemetryPoints.map((point, i) => {
    const r = point.record;
    const prevPoint = i > 0 ? telemetryPoints[i - 1] : undefined;
    const prevRecord = prevPoint?.record;
    const dt = prevPoint ? (point.relMs - prevPoint.relMs) / 1000 : 0;
    const derivedSpeed =
      !r.speed_m_s && prevRecord && typeof r.distance_m === "number" && typeof prevRecord.distance_m === "number" && dt > 0
        ? Math.max(0, (r.distance_m - prevRecord.distance_m) / dt)
        : undefined;
    const speedMs = r.speed_m_s ?? derivedSpeed;
    const speedInUnit = typeof speedMs === "number" ? convertSpeedMps(speedMs, distanceUnit) : null;
    const paceMinPerUnit = speedInUnit && speedInUnit > 0 ? 60 / speedInUnit : null;
    return {
      x: point.x,
      relMs: point.relMs,
      distanceMeters: point.distanceMeters,
      speedInUnit,
      altitudeInUnit: typeof r.altitude_m === "number" ? convertElevationMeters(r.altitude_m, distanceUnit) : null,
      paceMinPerUnit,
      heartRate: r.heart_rate ?? null,
      power: r.power ?? null,
      cadence: r.cadence ?? null,
      temperatureC: r.temperature_c ?? null,
      respirationRateBrpm: r.respiration_rate_brpm ?? null,
      currentStaminaPct: r.current_stamina_pct ?? null,
      potentialStaminaPct: r.potential_stamina_pct ?? null,
      performanceCondition: r.performance_condition ?? null,
      timestampMs: point.timestampMs,
    };
  });

  const heartRateLineData = timeline.map((d) => [d.x, d.heartRate, d.relMs, d.timestampMs, d.distanceMeters] as [number | null, number | null, number, number, number | null]).filter(isSeriesRow);
  const paceLineData = timeline.map((d) => [d.x, d.paceMinPerUnit, d.relMs, d.timestampMs, d.distanceMeters] as [number | null, number | null, number, number, number | null]).filter(isSeriesRow);
  const speedLineData = timeline.map((d) => [d.x, d.speedInUnit, d.relMs, d.timestampMs, d.distanceMeters] as [number | null, number | null, number, number, number | null]).filter(isSeriesRow);
  const elevationLineData = timeline.map((d) => [d.x, d.altitudeInUnit, d.relMs, d.timestampMs, d.distanceMeters] as [number | null, number | null, number, number, number | null]).filter(isSeriesRow);
  const cadenceLineData = timeline.map((d) => [d.x, d.cadence, d.relMs, d.timestampMs, d.distanceMeters] as [number | null, number | null, number, number, number | null]).filter(isSeriesRow);
  const powerLineData = timeline.map((d) => [d.x, d.power, d.relMs, d.timestampMs, d.distanceMeters] as [number | null, number | null, number, number, number | null]).filter(isSeriesRow);
  const temperatureLineData = timeline.map((d) => [d.x, d.temperatureC, d.relMs, d.timestampMs, d.distanceMeters] as [number | null, number | null, number, number, number | null]).filter(isSeriesRow);
  const respirationLineData = timeline.map((d) => [d.x, d.respirationRateBrpm, d.relMs, d.timestampMs, d.distanceMeters] as [number | null, number | null, number, number, number | null]).filter(isSeriesRow);
  const currentStaminaLineData = timeline.map((d) => [d.x, d.currentStaminaPct, d.relMs, d.timestampMs, d.distanceMeters] as [number | null, number | null, number, number, number | null]).filter(isSeriesRow);
  const potentialStaminaLineData = timeline.map((d) => [d.x, d.potentialStaminaPct, d.relMs, d.timestampMs, d.distanceMeters] as [number | null, number | null, number, number, number | null]).filter(isSeriesRow);
  const performanceConditionLineData = timeline.map((d) => [d.x, d.performanceCondition, d.relMs, d.timestampMs, d.distanceMeters] as [number | null, number | null, number, number, number | null]).filter(isSeriesRow);

  const heartRateLineDataSmoothed = smoothGraphs ? applyRollingAverageSeries(heartRateLineData, 1, smoothWindow) : heartRateLineData;
  const paceLineDataSmoothed = smoothGraphs ? applyRollingAverageSeries(paceLineData, 1, smoothWindow) : paceLineData;
  const speedLineDataSmoothed = smoothGraphs ? applyRollingAverageSeries(speedLineData, 1, smoothWindow) : speedLineData;
  const elevationLineDataSmoothed = smoothGraphs ? applyRollingAverageSeries(elevationLineData, 1, smoothWindow) : elevationLineData;
  const cadenceLineDataSmoothed = smoothGraphs ? applyRollingAverageSeries(cadenceLineData, 1, smoothWindow) : cadenceLineData;
  const powerLineDataSmoothed = smoothGraphs ? applyRollingAverageSeries(powerLineData, 1, smoothWindow) : powerLineData;
  const temperatureLineDataSmoothed = smoothGraphs ? applyRollingAverageSeries(temperatureLineData, 1, smoothWindow) : temperatureLineData;
  const respirationLineDataSmoothed = smoothGraphs ? applyRollingAverageSeries(respirationLineData, 1, smoothWindow) : respirationLineData;
  const currentStaminaLineDataSmoothed = smoothGraphs ? applyRollingAverageSeries(currentStaminaLineData, 1, smoothWindow) : currentStaminaLineData;
  const potentialStaminaLineDataSmoothed = smoothGraphs ? applyRollingAverageSeries(potentialStaminaLineData, 1, smoothWindow) : potentialStaminaLineData;

  const hasPowerData = availability.hasPower;
  const hasHeartRateData = availability.hasHeartRate;
  const hasElevationData = availability.hasElevation;
  const hasSpeedData = availability.hasSpeed;
  const hasCadenceData = availability.hasCadence;
  const hasTemperatureData = availability.hasTemperature;
  const hasRespirationData = availability.hasRespiration;
  const hasCurrentStaminaData = currentStaminaLineData.some((row) => row[1] !== null);
  const hasPotentialStaminaData = potentialStaminaLineData.some((row) => row[1] !== null);
  const hasStaminaData = hasCurrentStaminaData || hasPotentialStaminaData;
  const hasPerformanceConditionData = availability.hasPerformanceCondition;
  const cardiacRecords = analysisRecords.length ? analysisRecords : records;
  const cardiacDecoupling = activity ? calculateCardiacDecoupling(activity, cardiacRecords) : null;
  const cardiacResult = cardiacDecoupling ? selectCardiacResult(cardiacDecoupling.results, cardiacDecoupling.defaultMode) : undefined;
  const cardiacBand = cardiacResult?.available ? describeCardiacDecouplingBand(cardiacResult.decouplingPct ?? 0) : undefined;
  const cardiacConfidence = describeCardiacDecouplingConfidence(cardiacResult, cardiacDecoupling?.warnings);
  const cardiacConfidenceReason = cardiacConfidenceReasonLabel(cardiacResult, cardiacDecoupling?.warnings, tr);
  const cardiacEfficiencyPrecision = cardiacResult ? cardiacEfficiencyDigits(cardiacResult.mode) : 2;
  const cardiacIsNegative = (cardiacResult?.decouplingPct ?? 0) < 0;
  const cardiacHalfSummary = cardiacResult?.available
    ? cardiacResult.mode === "constant_output_hr"
      ? tr("insights.cardiacHrSummary", { first: formatMetric(cardiacResult.firstHalfAvgHr, 0), second: formatMetric(cardiacResult.secondHalfAvgHr, 0) })
      : tr("insights.cardiacEfSummary", { first: formatMetric(cardiacResult.firstHalfEfficiency, cardiacEfficiencyPrecision), second: formatMetric(cardiacResult.secondHalfEfficiency, cardiacEfficiencyPrecision) })
    : "";
  const usePaceDisplay = activityUsesPaceDisplay(activity);
  const heartRateDriftChartData = cardiacDecoupling && cardiacResult?.available
    ? buildHeartRateDriftChartData(cardiacRecords, cardiacDecoupling, cardiacResult)
    : null;
  const heartRateDriftShowsPace = heartRateDriftChartData?.outputMode === "speed" && usePaceDisplay;
  const heartRateDriftOutputData: Array<[number, number | null]> = heartRateDriftChartData
    ? heartRateDriftChartData.output.map(([elapsedMs, value]) => {
        if (value === null) return [elapsedMs, null];
        if (heartRateDriftShowsPace) return [elapsedMs, paceFromSpeedMps(value, distanceUnit)];
        if (heartRateDriftChartData.outputMode === "speed") return [elapsedMs, convertSpeedMps(value, distanceUnit)];
        return [elapsedMs, value];
      })
    : [];
  const heartRateDriftOutputUnit = heartRateDriftShowsPace
    ? paceLabel(distanceUnit)
    : heartRateDriftChartData?.outputMode === "speed" ? speedLabel(distanceUnit) : heartRateDriftChartData?.outputMode ? "W" : "";
  const heartRateDriftOutputLabel = heartRateDriftChartData?.outputMode
    ? cardiacModeLabel(heartRateDriftChartData.outputMode, tr, heartRateDriftShowsPace)
    : "";
  const heartRateDriftOutputDigits = heartRateDriftChartData?.outputMode === "speed" ? 2 : 1;
  const heartRateDriftHrData = smoothGraphs && heartRateDriftChartData
    ? applyRollingAverageSeries(heartRateDriftChartData.heartRate, 1, smoothWindow)
    : heartRateDriftChartData?.heartRate ?? [];
  const heartRateDriftOutputDataSmoothed = smoothGraphs
    ? applyRollingAverageSeries(heartRateDriftOutputData, 1, smoothWindow)
    : heartRateDriftOutputData;
  const hasHeartRateDriftChart = !!heartRateDriftChartData
    && heartRateDriftHrData.some(([, value]) => value !== null)
    && (!heartRateDriftChartData.outputMode || heartRateDriftOutputDataSmoothed.some(([, value]) => value !== null));
  const heartRateDriftHrAxis = heartRateDriftChartData ? paddedAxisBounds(heartRateDriftHrData, 30, 5, 10) : undefined;
  const heartRateDriftOutputAxis = heartRateDriftChartData?.outputMode
    ? paddedAxisBounds(
        heartRateDriftOutputDataSmoothed,
        0,
        heartRateDriftChartData.outputMode === "speed" ? 0.5 : 10,
        heartRateDriftChartData.outputMode === "speed" ? 1 : 10,
      )
    : undefined;

  const lapMarkers = buildLapMarkers(records, lapTimestampsUtc, t0, xAxisMode, distanceUnit, timerMetadata);

  const hrValues = timeline
    .map((d) => d.heartRate)
    .filter((n): n is number => typeof n === "number" && n > 0);
  const hasRealHeartRateZones = hrZones.length > 0;
  const fitHrZoneMinutes = hasRealHeartRateZones ? zoneSecondsToMinutes(zones?.heart_rate?.time_in_zone_s, hrZones.length) : [];
  const zoneMinutes = fitHrZoneMinutes.some((value) => value > 0) ? fitHrZoneMinutes : hrZones.map(() => 0);
  if (hasRealHeartRateZones && !fitHrZoneMinutes.some((value) => value > 0) && hrValues.length > 0) {
    for (let i = 0; i < timeline.length - 1; i += 1) {
      const hr = timeline[i].heartRate;
      if (typeof hr !== "number" || hr <= 0) continue;
      const dtMin = Math.max(0, (timeline[i + 1].relMs - timeline[i].relMs) / 60000);
      const zoneIndex = resolveHeartRateZoneIndex(hr, hrZones);
      if (zoneIndex !== null) {
        zoneMinutes[zoneIndex] += dtMin;
      }
    }
  }
  const hasHeartRateZoneData = hasRealHeartRateZones && (hasHeartRateData || zoneMinutes.some((value) => value > 0));

  const fitPowerZoneMinutes = zoneSecondsToMinutes(zones?.power?.time_in_zone_s, powerZones.length);
  const powerZoneMinutes = fitPowerZoneMinutes.some((value) => value > 0) ? fitPowerZoneMinutes : powerZones.map(() => 0);
  if (!fitPowerZoneMinutes.some((value) => value > 0) && powerZones.length > 0 && hasPowerData) {
    for (let i = 0; i < timeline.length - 1; i += 1) {
      const power = timeline[i].power;
      if (typeof power !== "number" || power < 0) continue;
      const dtMin = Math.max(0, (timeline[i + 1].relMs - timeline[i].relMs) / 60000);
      const zoneIndex = resolveNumericZoneIndex(power, powerZones);
      powerZoneMinutes[zoneIndex] += dtMin;
    }
  }
  const hasPowerZoneData = powerZones.length > 0 && (hasPowerData || powerZoneMinutes.some((value) => value > 0));
  const zoneChartTotalMinutes = totalDurationMs > 0 ? totalDurationMs / 60000 : 0;

  const sharedXAxis = {
    type: "value",
    ...xAxisBounds,
    axisLabel: { color: axisColor, fontSize: 11, formatter: (val: number) => formatTelemetryXAxisTick(val, xAxisMode, distanceUnit) },
    axisLine: { lineStyle: { color: gridLine } },
    splitLine: { show: false },
  };

  const hrVisualMap = hrZones.length > 0 ? {
    show: false,
    seriesIndex: 0,
    dimension: 1,
    pieces: hrZones.map((zone) => {
      if (zone.maxInclusive === null) {
        return { gt: zone.minExclusive, color: zone.color };
      }
      if (!Number.isFinite(zone.minExclusive)) {
        return { lte: zone.maxInclusive, color: zone.color };
      }
      return { gt: zone.minExclusive, lte: zone.maxInclusive, color: zone.color };
    }),
  } : undefined;

  const powerVisualMap = powerZones.length > 0 ? {
    show: false,
    seriesIndex: 0,
    dimension: 1,
    pieces: powerZones.map((zone) => {
      if (zone.maxInclusive === null) {
        return { gt: zone.minExclusive, color: zone.color };
      }
      if (!Number.isFinite(zone.minExclusive)) {
        return { lte: zone.maxInclusive, color: zone.color };
      }
      return { gt: zone.minExclusive, lte: zone.maxInclusive, color: zone.color };
    }),
  } : undefined;

  const heartRateOption = {
    tooltip: {
      trigger: "axis",
      ...tooltipStyle,
      formatter: (params: any[]) => {
        const p = params?.[0];
        const rel = Number(p?.value?.[2] ?? 0);
        const distanceMeters = (p?.value?.[4] ?? null) as number | null;
        let html = formatTooltipHeader(rel, distanceMeters, xAxisMode, Number(p?.value?.[3] ?? 0));
        for (const row of params) {
          if (row.value?.[1] !== null && row.value?.[1] !== undefined) {
            html += `<div>${row.marker} ${row.seriesName}: <strong>${Number(row.value[1]).toFixed(0)} bpm</strong></div>`;
          }
        }
        return html;
      }
    },
    legend: { textStyle: { color: axisColor, fontSize: 12 }, top: 0 },
    visualMap: hrVisualMap,
    grid: { left: 50, right: 16, top: 42, bottom: 46 },
    xAxis: sharedXAxis,
    yAxis: {
      type: "value", name: "bpm", min: 40,
      nameTextStyle: { color: axisColor, fontSize: 11 },
      axisLabel: { color: axisColor, fontSize: 11 },
      splitLine: { lineStyle: { color: gridLine } },
    },
    dataZoom: [
      {
        type: "inside",
        zoomOnMouseWheel: "ctrl",
        moveOnMouseWheel: false,
        start: zoomRange?.start ?? 0,
        end: zoomRange?.end ?? 100,
      },
    ],
    series: [
      {
        name: tr("chart.heartRate"), type: "line", smooth: smoothGraphs, showSymbol: false,
        lineStyle: { width: 2 },
        areaStyle: { opacity: 0.12 },
        sampling: smoothGraphs ? "lttb" : undefined,
        data: heartRateLineDataSmoothed,
        markLine: lapMarkers.length ? {
          animation: false,
          symbol: ["none", "none"],
          lineStyle: { color: isDark ? "rgba(148,163,184,0.55)" : "rgba(71,85,105,0.5)", type: "dashed", width: 1 },
          label: { color: axisColor, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
          data: lapMarkers,
        } : undefined,
      },
    ],
  };

  const paceOption = {
    tooltip: {
      trigger: "axis",
      ...tooltipStyle,
      formatter: (params: any[]) => {
        const p = params?.[0];
        const rel = Number(p?.value?.[2] ?? 0);
        const distanceMeters = (p?.value?.[4] ?? null) as number | null;
        let html = formatTooltipHeader(rel, distanceMeters, xAxisMode, Number(p?.value?.[3] ?? 0));
        for (const row of params) {
          if (row.value?.[1] !== null && row.value?.[1] !== undefined) {
            html += `<div>${row.marker} ${row.seriesName}: <strong>${formatPaceValue(Number(row.value[1]))} ${paceLabel(distanceUnit)}</strong></div>`;
          }
        }
        return html;
      }
    },
    legend: { textStyle: { color: axisColor, fontSize: 12 }, top: 0 },
    grid: { left: 50, right: 16, top: 42, bottom: 46 },
    xAxis: sharedXAxis,
    yAxis: {
      type: "value", name: paceLabel(distanceUnit), inverse: true,
      nameTextStyle: { color: axisColor, fontSize: 11 },
      axisLabel: { color: axisColor, fontSize: 11 },
      splitLine: { lineStyle: { color: gridLine } },
    },
    dataZoom: [
      {
        type: "inside",
        zoomOnMouseWheel: "ctrl",
        moveOnMouseWheel: false,
        start: zoomRange?.start ?? 0,
        end: zoomRange?.end ?? 100,
      },
    ],
    series: [
      {
        name: tr("chart.pace"), type: "line", smooth: smoothGraphs, showSymbol: false,
        lineStyle: { width: 2, color: "#f43f5e" },
        areaStyle: { color: isDark ? "rgba(244, 63, 94, 0.1)" : "rgba(244, 63, 94, 0.12)" },
        sampling: smoothGraphs ? "lttb" : undefined,
        data: paceLineDataSmoothed,
        markLine: lapMarkers.length ? {
          animation: false,
          symbol: ["none", "none"],
          lineStyle: { color: isDark ? "rgba(148,163,184,0.55)" : "rgba(71,85,105,0.5)", type: "dashed", width: 1 },
          label: { color: axisColor, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
          data: lapMarkers,
        } : undefined,
      },
    ],
  };

  const timelineOption = {
    tooltip: {
      trigger: "axis",
      ...tooltipStyle,
      formatter: (params: any[]) => {
        const p = params?.[0];
        const rel = Number(p?.value?.[2] ?? 0);
        const distanceMeters = (p?.value?.[4] ?? null) as number | null;
        let html = formatTooltipHeader(rel, distanceMeters, xAxisMode, Number(p?.value?.[3] ?? 0));
        for (const row of params) {
          if (row.value?.[1] !== null && row.value?.[1] !== undefined) {
            html += `<div>${row.marker} ${row.seriesName}: <strong>${Number(row.value[1]).toFixed(2)}</strong></div>`;
          }
        }
        return html;
      }
    },
    legend: { textStyle: { color: axisColor, fontSize: 12 }, top: 0 },
    grid: { left: 50, right: 16, top: 42, bottom: 46 },
    xAxis: sharedXAxis,
    yAxis: {
      type: "value", name: speedLabel(distanceUnit),
      nameTextStyle: { color: axisColor, fontSize: 11 },
      axisLabel: { color: axisColor, fontSize: 11 },
      splitLine: { lineStyle: { color: gridLine } },
    },
    dataZoom: [
      {
        type: "inside",
        zoomOnMouseWheel: "ctrl",
        moveOnMouseWheel: false,
        start: zoomRange?.start ?? 0,
        end: zoomRange?.end ?? 100,
      },
    ],
    series: [
      {
        name: tr("insights.speed"), type: "line", smooth: smoothGraphs, showSymbol: false,
        lineStyle: { width: 2, color: "#38bdf8" },
        areaStyle: { color: isDark ? "rgba(56, 189, 248, 0.1)" : "rgba(56, 189, 248, 0.15)" },
        sampling: smoothGraphs ? "lttb" : undefined,
        data: speedLineDataSmoothed,
        markLine: lapMarkers.length ? {
          animation: false,
          symbol: ["none", "none"],
          lineStyle: { color: isDark ? "rgba(148,163,184,0.55)" : "rgba(71,85,105,0.5)", type: "dashed", width: 1 },
          label: { color: axisColor, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
          data: lapMarkers,
        } : undefined,
      },
    ],
  };

  const elevationAxisBounds = paddedAxisBounds(
    elevationLineDataSmoothed.map((row) => [row[0], row[1]] as [number, number | null]),
    0,
    distanceUnit === "mi" ? 30 : 10,
    distanceUnit === "mi" ? 50 : 10,
  );

  const elevationOption = {
    tooltip: {
      trigger: "axis",
      ...tooltipStyle,
      formatter: (params: any[]) => {
        const p = params?.[0];
        const rel = Number(p?.value?.[2] ?? 0);
        const distanceMeters = (p?.value?.[4] ?? null) as number | null;
        const val = p?.value?.[1];
        return `${formatTooltipHeader(rel, distanceMeters, xAxisMode, Number(p?.value?.[3] ?? 0))}<div>${p?.marker ?? ""} ${tr("insights.elevation")}: <strong>${val == null ? "--" : Number(val).toFixed(2)} ${elevationLabel(distanceUnit)}</strong></div>`;
      }
    },
    legend: { textStyle: { color: axisColor, fontSize: 12 }, top: 0 },
    grid: { left: 50, right: 16, top: 42, bottom: 46 },
    xAxis: sharedXAxis,
    yAxis: {
      type: "value", name: elevationLabel(distanceUnit),
      ...elevationAxisBounds,
      nameTextStyle: { color: axisColor, fontSize: 11 },
      axisLabel: { color: axisColor, fontSize: 11 },
      splitLine: { lineStyle: { color: gridLine } },
    },
    dataZoom: [
      {
        type: "inside",
        zoomOnMouseWheel: "ctrl",
        moveOnMouseWheel: false,
        start: zoomRange?.start ?? 0,
        end: zoomRange?.end ?? 100,
      },
    ],
    series: [
      {
        name: tr("insights.elevation"), type: "line", smooth: smoothGraphs, showSymbol: false,
        lineStyle: { width: 1.5, color: "#64748b" },
        sampling: smoothGraphs ? "lttb" : undefined,
        data: elevationLineDataSmoothed,
        markLine: lapMarkers.length ? {
          animation: false,
          symbol: ["none", "none"],
          lineStyle: { color: isDark ? "rgba(148,163,184,0.55)" : "rgba(71,85,105,0.5)", type: "dashed", width: 1 },
          label: { color: axisColor, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
          data: lapMarkers,
        } : undefined,
      },
    ],
  };

  const cadenceOption = {
    tooltip: {
      trigger: "axis",
      ...tooltipStyle,
      formatter: (params: any[]) => {
        const p = params?.[0];
        const rel = Number(p?.value?.[2] ?? 0);
        const distanceMeters = (p?.value?.[4] ?? null) as number | null;
        let html = formatTooltipHeader(rel, distanceMeters, xAxisMode, Number(p?.value?.[3] ?? 0));
        for (const row of params) {
          if (row.value?.[1] !== null && row.value?.[1] !== undefined) {
            html += `<div>${row.marker} ${row.seriesName}: <strong>${Number(row.value[1]).toFixed(0)} rpm</strong></div>`;
          }
        }
        return html;
      }
    },
    legend: { textStyle: { color: axisColor, fontSize: 12 }, top: 0 },
    grid: { left: 50, right: 16, top: 42, bottom: 46 },
    xAxis: sharedXAxis,
    yAxis: {
      type: "value", name: "rpm",
      nameTextStyle: { color: axisColor, fontSize: 11 },
      axisLabel: { color: axisColor, fontSize: 11 },
      splitLine: { lineStyle: { color: gridLine } },
    },
    dataZoom: [
      {
        type: "inside",
        zoomOnMouseWheel: "ctrl",
        moveOnMouseWheel: false,
        start: zoomRange?.start ?? 0,
        end: zoomRange?.end ?? 100,
      },
    ],
    series: [
      {
        name: tr("insights.cadence"), type: "line", smooth: smoothGraphs, showSymbol: false,
        lineStyle: { width: 2, color: "#22d3ee" },
        sampling: smoothGraphs ? "lttb" : undefined,
        data: cadenceLineDataSmoothed,
        markLine: lapMarkers.length ? {
          animation: false,
          symbol: ["none", "none"],
          lineStyle: { color: isDark ? "rgba(148,163,184,0.55)" : "rgba(71,85,105,0.5)", type: "dashed", width: 1 },
          label: { color: axisColor, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
          data: lapMarkers,
        } : undefined,
      },
    ],
  };

  const powerOption = {
    tooltip: {
      trigger: "axis",
      ...tooltipStyle,
      formatter: (params: any[]) => {
        const p = params?.[0];
        const rel = Number(p?.value?.[2] ?? 0);
        const distanceMeters = (p?.value?.[4] ?? null) as number | null;
        let html = formatTooltipHeader(rel, distanceMeters, xAxisMode, Number(p?.value?.[3] ?? 0));
        for (const row of params) {
          if (row.value?.[1] !== null && row.value?.[1] !== undefined) {
            html += `<div>${row.marker} ${row.seriesName}: <strong>${Number(row.value[1]).toFixed(0)} W</strong></div>`;
          }
        }
        return html;
      }
    },
    legend: { textStyle: { color: axisColor, fontSize: 12 }, top: 0 },
    visualMap: powerVisualMap,
    grid: { left: 50, right: 16, top: 42, bottom: 46 },
    xAxis: sharedXAxis,
    yAxis: {
      type: "value", name: "W",
      nameTextStyle: { color: axisColor, fontSize: 11 },
      axisLabel: { color: axisColor, fontSize: 11 },
      splitLine: { lineStyle: { color: gridLine } },
    },
    dataZoom: [
      {
        type: "inside",
        zoomOnMouseWheel: "ctrl",
        moveOnMouseWheel: false,
        start: zoomRange?.start ?? 0,
        end: zoomRange?.end ?? 100,
      },
    ],
    series: [
      {
        name: tr("insights.power"), type: "line", smooth: smoothGraphs, showSymbol: false,
        lineStyle: { width: 2 },
        sampling: smoothGraphs ? "lttb" : undefined,
        data: powerLineDataSmoothed,
        markLine: lapMarkers.length ? {
          animation: false,
          symbol: ["none", "none"],
          lineStyle: { color: isDark ? "rgba(148,163,184,0.55)" : "rgba(71,85,105,0.5)", type: "dashed", width: 1 },
          label: { color: axisColor, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
          data: lapMarkers,
        } : undefined,
      },
    ],
  };

  const temperatureAxisBounds = paddedAxisBoundsWithMinimumRange(
    temperatureLineDataSmoothed.map((row) => [row[0], row[1]] as [number, number | null]),
    10,
    1,
  );
  const respirationAxisBounds = paddedAxisBoundsWithMinimumRange(
    respirationLineDataSmoothed.map((row) => [row[0], row[1]] as [number, number | null]),
    5,
    1,
  );
  const performanceConditionAxisBounds = paddedAxisBoundsWithMinimumRange(
    performanceConditionLineData.map((row) => [row[0], row[1]] as [number, number | null]),
    4,
    1,
  );

  const temperatureOption = {
    tooltip: {
      trigger: "axis",
      ...tooltipStyle,
      formatter: (params: any[]) => {
        const p = params?.[0];
        const rel = Number(p?.value?.[2] ?? 0);
        const distanceMeters = (p?.value?.[4] ?? null) as number | null;
        let html = formatTooltipHeader(rel, distanceMeters, xAxisMode, Number(p?.value?.[3] ?? 0));
        for (const row of params) {
          if (row.value?.[1] !== null && row.value?.[1] !== undefined) {
            html += `<div>${row.marker} ${row.seriesName}: <strong>${Number(row.value[1]).toFixed(1)} C</strong></div>`;
          }
        }
        return html;
      },
    },
    legend: { textStyle: { color: axisColor, fontSize: 12 }, top: 0 },
    grid: { left: 50, right: 16, top: 42, bottom: 46 },
    xAxis: sharedXAxis,
    yAxis: {
      type: "value", name: "C", ...temperatureAxisBounds,
      nameTextStyle: { color: axisColor, fontSize: 11 },
      axisLabel: { color: axisColor, fontSize: 11 },
      splitLine: { lineStyle: { color: gridLine } },
    },
    dataZoom: [
      {
        type: "inside",
        zoomOnMouseWheel: "ctrl",
        moveOnMouseWheel: false,
        start: zoomRange?.start ?? 0,
        end: zoomRange?.end ?? 100,
      },
    ],
    series: [
      {
        name: tr("insights.temperature"), type: "line", smooth: smoothGraphs, showSymbol: false,
        lineStyle: { width: 2, color: "#ea580c" },
        sampling: smoothGraphs ? "lttb" : undefined,
        data: temperatureLineDataSmoothed,
        markLine: lapMarkers.length ? {
          animation: false,
          symbol: ["none", "none"],
          lineStyle: { color: isDark ? "rgba(148,163,184,0.55)" : "rgba(71,85,105,0.5)", type: "dashed", width: 1 },
          label: { color: axisColor, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
          data: lapMarkers,
        } : undefined,
      },
    ],
  };

  const respirationOption = {
    tooltip: {
      trigger: "axis",
      ...tooltipStyle,
      formatter: (params: any[]) => {
        const p = params?.[0];
        const rel = Number(p?.value?.[2] ?? 0);
        const distanceMeters = (p?.value?.[4] ?? null) as number | null;
        let html = formatTooltipHeader(rel, distanceMeters, xAxisMode, Number(p?.value?.[3] ?? 0));
        for (const row of params) {
          if (row.value?.[1] !== null && row.value?.[1] !== undefined) {
            html += `<div>${row.marker} ${row.seriesName}: <strong>${Number(row.value[1]).toFixed(1)} ${tr("insights.breathsPerMinute")}</strong></div>`;
          }
        }
        return html;
      },
    },
    legend: { textStyle: { color: axisColor, fontSize: 12 }, top: 0 },
    grid: { left: 50, right: 16, top: 42, bottom: 46 },
    xAxis: sharedXAxis,
    yAxis: {
      type: "value", name: tr("insights.breathsPerMinuteShort"), ...respirationAxisBounds,
      nameTextStyle: { color: axisColor, fontSize: 11 },
      axisLabel: { color: axisColor, fontSize: 11 },
      splitLine: { lineStyle: { color: gridLine } },
    },
    dataZoom: [
      {
        type: "inside",
        zoomOnMouseWheel: "ctrl",
        moveOnMouseWheel: false,
        start: zoomRange?.start ?? 0,
        end: zoomRange?.end ?? 100,
      },
    ],
    series: [
      {
        name: tr("insights.respirationRate"), type: "line", smooth: smoothGraphs, showSymbol: false,
        lineStyle: { width: 2, color: "#0891b2" },
        sampling: smoothGraphs ? "lttb" : undefined,
        data: respirationLineDataSmoothed,
        markLine: lapMarkers.length ? {
          animation: false,
          symbol: ["none", "none"],
          lineStyle: { color: isDark ? "rgba(148,163,184,0.55)" : "rgba(71,85,105,0.5)", type: "dashed", width: 1 },
          label: { color: axisColor, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
          data: lapMarkers,
        } : undefined,
      },
    ],
  };

  const staminaOption = {
    tooltip: {
      trigger: "axis",
      ...tooltipStyle,
      formatter: (params: any[]) => {
        const p = params?.[0];
        const rel = Number(p?.value?.[2] ?? 0);
        const distanceMeters = (p?.value?.[4] ?? null) as number | null;
        let html = formatTooltipHeader(rel, distanceMeters, xAxisMode, Number(p?.value?.[3] ?? 0));
        for (const row of params) {
          if (row.value?.[1] !== null && row.value?.[1] !== undefined) {
            html += `<div>${row.marker} ${row.seriesName}: <strong>${Number(row.value[1]).toFixed(0)}%</strong></div>`;
          }
        }
        return html;
      },
    },
    legend: { textStyle: { color: axisColor, fontSize: 12 }, top: 0 },
    grid: { left: 50, right: 16, top: 42, bottom: 46 },
    xAxis: sharedXAxis,
    yAxis: {
      type: "value", name: "%", min: 0, max: 100,
      nameTextStyle: { color: axisColor, fontSize: 11 },
      axisLabel: { color: axisColor, fontSize: 11 },
      splitLine: { lineStyle: { color: gridLine } },
    },
    dataZoom: [
      {
        type: "inside",
        zoomOnMouseWheel: "ctrl",
        moveOnMouseWheel: false,
        start: zoomRange?.start ?? 0,
        end: zoomRange?.end ?? 100,
      },
    ],
    series: [
      ...(hasCurrentStaminaData ? [{
        name: tr("insights.currentStamina"), type: "line", smooth: smoothGraphs, showSymbol: false,
        lineStyle: { width: 2, color: "#dc2626" },
        sampling: smoothGraphs ? "lttb" : undefined,
        data: currentStaminaLineDataSmoothed,
        markLine: lapMarkers.length ? {
          animation: false,
          symbol: ["none", "none"],
          lineStyle: { color: isDark ? "rgba(148,163,184,0.55)" : "rgba(71,85,105,0.5)", type: "dashed", width: 1 },
          label: { color: axisColor, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
          data: lapMarkers,
        } : undefined,
      }] : []),
      ...(hasPotentialStaminaData ? [{
        name: tr("insights.potentialStamina"), type: "line", smooth: smoothGraphs, showSymbol: false,
        lineStyle: { width: 2, color: "#2563eb" },
        sampling: smoothGraphs ? "lttb" : undefined,
        data: potentialStaminaLineDataSmoothed,
      }] : []),
    ],
  };

  const performanceConditionOption = {
    tooltip: {
      trigger: "axis",
      ...tooltipStyle,
      formatter: (params: any[]) => {
        const p = params?.[0];
        const rel = Number(p?.value?.[2] ?? 0);
        const distanceMeters = (p?.value?.[4] ?? null) as number | null;
        let html = formatTooltipHeader(rel, distanceMeters, xAxisMode, Number(p?.value?.[3] ?? 0));
        for (const row of params) {
          if (row.value?.[1] !== null && row.value?.[1] !== undefined) {
            html += `<div>${row.marker} ${row.seriesName}: <strong>${Number(row.value[1]).toFixed(0)}</strong></div>`;
          }
        }
        return html;
      },
    },
    legend: { textStyle: { color: axisColor, fontSize: 12 }, top: 0 },
    grid: { left: 50, right: 16, top: 42, bottom: 46 },
    xAxis: sharedXAxis,
    yAxis: {
      type: "value", ...performanceConditionAxisBounds,
      nameTextStyle: { color: axisColor, fontSize: 11 },
      axisLabel: { color: axisColor, fontSize: 11 },
      splitLine: { lineStyle: { color: gridLine } },
    },
    dataZoom: [
      {
        type: "inside",
        zoomOnMouseWheel: "ctrl",
        moveOnMouseWheel: false,
        start: zoomRange?.start ?? 0,
        end: zoomRange?.end ?? 100,
      },
    ],
    series: [
      {
        name: tr("insights.performanceCondition"), type: "line", smooth: false, showSymbol: false,
        lineStyle: { width: 2, color: "#059669" },
        step: "middle",
        data: performanceConditionLineData,
        markLine: lapMarkers.length ? {
          animation: false,
          symbol: ["none", "none"],
          lineStyle: { color: isDark ? "rgba(148,163,184,0.55)" : "rgba(71,85,105,0.5)", type: "dashed", width: 1 },
          label: { color: axisColor, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
          data: lapMarkers,
        } : undefined,
      },
    ],
  };

  type TimelinePoint = (typeof timeline)[number];
  const scatterMetrics: Record<ScatterMetricKey, {
    label: string;
    axisName: string;
    colour: string;
    minFloor: number;
    minPadding: number;
    step: number;
    getValue: (point: TimelinePoint) => number | null;
  }> = {
    heartRate: {
      label: tr("chart.heartRate"),
      axisName: "bpm",
      colour: "#ef4444",
      minFloor: 30,
      minPadding: 5,
      step: 5,
      getValue: (point) => point.heartRate,
    },
    power: {
      label: tr("insights.power"),
      axisName: "W",
      colour: "#f59e0b",
      minFloor: 0,
      minPadding: 10,
      step: 10,
      getValue: (point) => point.power,
    },
    cadence: {
      label: tr("insights.cadence"),
      axisName: "rpm",
      colour: "#8b5cf6",
      minFloor: 0,
      minPadding: 5,
      step: 5,
      getValue: (point) => point.cadence,
    },
    speed: {
      label: tr("insights.speed"),
      axisName: speedLabel(distanceUnit),
      colour: "#0ea5e9",
      minFloor: 0,
      minPadding: 0.5,
      step: 1,
      getValue: (point) => point.speedInUnit,
    },
    pace: {
      label: tr("chart.pace"),
      axisName: paceLabel(distanceUnit),
      colour: "#10b981",
      minFloor: 0,
      minPadding: 0.25,
      step: 0.5,
      getValue: (point) => point.paceMinPerUnit,
    },
    elevation: {
      label: tr("insights.elevation"),
      axisName: elevationLabel(distanceUnit),
      colour: "#64748b",
      minFloor: Number.NEGATIVE_INFINITY,
      minPadding: 5,
      step: 10,
      getValue: (point) => point.altitudeInUnit,
    },
  };

  const availableScatterPresets = SCATTER_PRESETS.filter((preset) => {
    const xMetric = scatterMetrics[preset.xMetric];
    const yMetric = scatterMetrics[preset.yMetric];
    return timeline.some((point) => {
      const x = xMetric.getValue(point);
      const y = yMetric.getValue(point);
      return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y);
    });
  });
  const selectedScatterPreset = availableScatterPresets.find((preset) => preset.key === scatterPresetKey) ?? availableScatterPresets[0] ?? null;
  const selectedScatterXMetric = selectedScatterPreset ? scatterMetrics[selectedScatterPreset.xMetric] : null;
  const selectedScatterYMetric = selectedScatterPreset ? scatterMetrics[selectedScatterPreset.yMetric] : null;
  const scatterTitle = selectedScatterPreset && selectedScatterXMetric && selectedScatterYMetric
    ? `${selectedScatterYMetric.label} vs ${selectedScatterXMetric.label}`
    : tr("insights.scatterComparison");
  const scatterData = selectedScatterPreset && selectedScatterXMetric && selectedScatterYMetric
    ? timeline
        .map((point) => {
          const x = selectedScatterXMetric.getValue(point);
          const y = selectedScatterYMetric.getValue(point);
          return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)
            ? [x, y, point.relMs, point.timestampMs, point.distanceMeters] as [number, number, number, number, number | null]
            : null;
        })
        .filter((point): point is [number, number, number, number, number | null] => point !== null)
    : [];
  const scatterXAxisBounds = selectedScatterXMetric
    ? paddedAxisBounds(scatterData.map(([x]) => [0, x] as [number, number | null]), selectedScatterXMetric.minFloor, selectedScatterXMetric.minPadding, selectedScatterXMetric.step)
    : undefined;
  const scatterYAxisBounds = selectedScatterYMetric
    ? paddedAxisBounds(scatterData.map(([, y]) => [0, y] as [number, number | null]), selectedScatterYMetric.minFloor, selectedScatterYMetric.minPadding, selectedScatterYMetric.step)
    : undefined;

  const scatterOption = {
    tooltip: {
      trigger: "item",
      ...tooltipStyle,
      formatter: (p: any) => {
        if (!selectedScatterXMetric || !selectedScatterYMetric) return "";
        const value = p?.value ?? [];
        const x = Number(value[0]);
        const y = Number(value[1]);
        const relMs = Number(value[2] ?? 0);
        const timestampMs = Number(value[3] ?? 0);
        const distanceMeters = typeof value[4] === "number" ? value[4] : null;
        return `${formatTooltipHeader(relMs, distanceMeters, "time", timestampMs)}<div>${selectedScatterYMetric.label}: <strong>${y.toFixed(1)} ${selectedScatterYMetric.axisName}</strong></div><div>${selectedScatterXMetric.label}: <strong>${x.toFixed(1)} ${selectedScatterXMetric.axisName}</strong></div>`;
      },
    },
    grid: { left: 48, right: 56, top: 28, bottom: 42, containLabel: true },
    xAxis: {
      type: "value", name: selectedScatterXMetric?.axisName ?? "",
      scale: true,
      ...scatterXAxisBounds,
      nameTextStyle: { color: axisColor, fontSize: 11 },
      axisLabel: { color: axisColor, fontSize: 11 },
      splitLine: { lineStyle: { color: gridLine } },
    },
    yAxis: {
      type: "value", name: selectedScatterYMetric?.axisName ?? "",
      scale: true,
      ...scatterYAxisBounds,
      nameTextStyle: { color: axisColor, fontSize: 11 },
      axisLabel: { color: axisColor, fontSize: 11 },
      splitLine: { lineStyle: { color: gridLine } },
    },
    series: [
      {
        name: scatterTitle,
        type: "scatter",
        symbolSize: 5,
        itemStyle: { color: selectedScatterYMetric?.colour ?? "#f59e0b", opacity: 0.7 },
        data: scatterData,
      },
    ],
  };

  const hrHistogram = (() => {
    if (!hrValues.length) {
      return { labels: [] as string[], minutes: [] as number[], centers: [] as number[], binWidth: 1, zoneMinutes: [] as number[] };
    }
    const minHr = Math.floor(Math.min(...hrValues));
    const maxHr = Math.ceil(Math.max(...hrValues));
    const hrRange = Math.max(1, maxHr - minHr);
    const targetBins = Math.max(12, Math.min(72, Math.round(Math.sqrt(hrValues.length) * 2.2)));
    const binWidth = Math.max(1, Math.ceil(hrRange / targetBins));
    const start = Math.floor(minHr / binWidth) * binWidth;
    const end = Math.ceil(maxHr / binWidth) * binWidth;
    const binCount = Math.max(1, Math.ceil((end - start) / binWidth));
    const minutes = new Array<number>(binCount).fill(0);
    const histogramZoneMinutes = hrZones.map(() => 0);
    const positiveDeltas = timeline
      .slice(0, -1)
      .map((point, idx) => (timeline[idx + 1].relMs - point.relMs) / 60000)
      .filter((delta) => Number.isFinite(delta) && delta > 0)
      .sort((a, b) => a - b);
    const medianDeltaMin = positiveDeltas.length
      ? positiveDeltas[Math.floor(positiveDeltas.length / 2)]
      : 0;
    const maxDeltaMin = Math.max(10 / 60, medianDeltaMin * 3);

    for (let i = 0; i < timeline.length - 1; i += 1) {
      const hr = timeline[i].heartRate;
      if (typeof hr !== "number" || hr <= 0) continue;
      const rawDeltaMin = (timeline[i + 1].relMs - timeline[i].relMs) / 60000;
      if (!Number.isFinite(rawDeltaMin) || rawDeltaMin <= 0) continue;
      const dtMin = Math.min(rawDeltaMin, maxDeltaMin);
      const binIndex = Math.min(binCount - 1, Math.max(0, Math.floor((hr - start) / binWidth)));
      minutes[binIndex] += dtMin;

      const zoneIndex = resolveHeartRateZoneIndex(hr, hrZones);
      if (zoneIndex !== null && histogramZoneMinutes[zoneIndex] !== undefined) {
        histogramZoneMinutes[zoneIndex] += dtMin;
      }
    }

    const labels = minutes.map((_, idx) => {
      const left = start + idx * binWidth;
      const right = left + binWidth;
      return `${left}-${right}`;
    });

    const centers = minutes.map((_, idx) => {
      const left = start + idx * binWidth;
      return left + binWidth / 2;
    });

    return { labels, minutes, centers, binWidth, zoneMinutes: histogramZoneMinutes };
  })();

  const hrHistogramZoneRows = buildZoneTimeRows(hrZones, hrHistogram.zoneMinutes, "bpm");
  const hrHistogramZoneLabels = hrHistogramZoneRows.flatMap((row, rowIdx) => {
    const matchingBinIndexes = hrHistogram.centers
      .map((center, idx) => ({ center, idx }))
      .filter(({ center }) => {
        const zoneIndex = resolveHeartRateZoneIndex(center, hrZones);
        if (zoneIndex === null) return false;

        if (row.label === "<Z1") return zoneIndex === 0;
        if (rowIdx === hrHistogramZoneRows.length - 1) return zoneIndex >= rowIdx;
        return zoneIndex === rowIdx;
      })
      .map(({ idx }) => idx);

    if (!matchingBinIndexes.length) return [];

    const first = matchingBinIndexes[0];
    const last = matchingBinIndexes[matchingBinIndexes.length - 1];
    return [{
      x: (first + last) / 2,
      text: `${row.label} ${formatDurationClock(row.minutes)}`,
      color: row.color,
    }];
  });

  const hrHistogramOption = {
    tooltip: {
      trigger: "item",
      ...tooltipStyle,
      formatter: (p: any) => {
        const label = String(p?.name ?? "");
        const minutes = Number(p?.value ?? 0);
        return `<div><strong>${label} bpm</strong></div><div>${tr("detail.time")}: <strong>${formatDurationClock(minutes)}</strong></div>`;
      },
    },
    grid: { left: 44, right: 16, top: 28, bottom: 82 },
    xAxis: {
      type: "category",
      name: `bpm (bin ~${hrHistogram.binWidth})`,
      data: hrHistogram.labels,
      nameTextStyle: { color: axisColor, fontSize: 11, padding: [50, 0, 0, 0] },
      axisLabel: { color: axisColor, fontSize: 10, interval: Math.max(0, Math.floor(hrHistogram.labels.length / 12)) },
      axisLine: { lineStyle: { color: gridLine } },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      name: tr("detail.time"),
      nameTextStyle: { color: axisColor, fontSize: 11 },
      axisLabel: { color: axisColor, fontSize: 11, formatter: (value: number) => formatDurationClock(Number(value)) },
      splitLine: { lineStyle: { color: gridLine } },
    },
    series: [
      {
        type: "bar",
        barGap: "0%",
        barWidth: "96%",
        itemStyle: { borderRadius: [2, 2, 0, 0] },
        data: hrHistogram.minutes.map((minutes, idx) => {
          const centerHr = hrHistogram.centers[idx] ?? 0;
          const zoneIndex = resolveHeartRateZoneIndex(centerHr, hrZones);
          const color = zoneIndex === null ? (isDark ? "#64748b" : "#94a3b8") : hrZones[zoneIndex].color;
          return {
            value: minutes,
            itemStyle: { color },
          };
        }),
      },
      {
        type: "custom",
        coordinateSystem: "cartesian2d",
        silent: true,
        clip: false,
        data: hrHistogramZoneLabels.map((label) => [label.x, 0]),
        renderItem: (params: any, api: any) => {
          const label = hrHistogramZoneLabels[params.dataIndex];
          if (!label) return null;
          const coord = api.coord([api.value(0), 0]);
          const coordSys = params.coordSys;
          return {
            type: "text",
            x: coord[0],
            y: coordSys.y + coordSys.height + 48,
            style: {
              text: label.text,
              fill: axisColor,
              fontSize: 10,
              fontWeight: 700,
              align: "center",
              verticalAlign: "middle",
              backgroundColor: isDark ? "rgba(15, 23, 42, 0.82)" : "rgba(248, 250, 252, 0.88)",
              borderColor: label.color,
              borderWidth: 1,
              borderRadius: 3,
              padding: [2, 4],
            },
          };
        },
      },
    ],
  };

  const insightChartHeight = 280;

  const heartRateDriftYAxes = heartRateDriftChartData ? [
    {
      type: "value", name: "bpm",
      ...heartRateDriftHrAxis,
      nameTextStyle: { color: axisColor, fontSize: 11 },
      axisLabel: { color: axisColor, fontSize: 11 },
      splitLine: { lineStyle: { color: heartRateDriftGridLine } },
    },
    ...(heartRateDriftChartData.outputMode ? [{
      type: "value", name: heartRateDriftOutputUnit,
      ...heartRateDriftOutputAxis,
      inverse: heartRateDriftShowsPace,
      nameTextStyle: { color: axisColor, fontSize: 11 },
      axisLabel: {
        color: axisColor,
        fontSize: 11,
        formatter: heartRateDriftShowsPace ? (val: number) => formatPaceValue(val) : undefined,
      },
      splitLine: { show: false },
    }] : []),
  ] : [];

  const heartRateDriftSeries = heartRateDriftChartData ? [
    {
      name: tr("chart.heartRate"), type: "line", smooth: smoothGraphs, showSymbol: false,
      lineStyle: { width: 1.8, color: "#ef4444" },
      sampling: smoothGraphs ? "lttb" : undefined,
      data: heartRateDriftHrData,
      markArea: heartRateDriftChartData.excludedRanges.length ? {
        silent: true,
        itemStyle: { color: isDark ? "rgba(148, 163, 184, 0.16)" : "rgba(148, 163, 184, 0.22)" },
        label: { color: axisColor, fontSize: 10 },
        data: heartRateDriftChartData.excludedRanges.map((range) => [
          { xAxis: range.startMs, name: range.kind === "gap" ? "" : heartRateDriftRangeLabel(range.kind, tr) },
          { xAxis: range.endMs },
        ]),
      } : undefined,
      markLine: heartRateDriftChartData.markers.length ? {
        animation: false,
        symbol: ["none", "none"],
        label: { color: axisColor, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
        data: heartRateDriftChartData.markers.map((marker) => ({
          xAxis: marker.elapsedMs,
          name: marker.kind === "cooldown" ? "" : heartRateDriftMarkerLabel(marker, cardiacResult?.mode ?? "speed", tr),
          lineStyle: {
            color: marker.kind === "bin"
              ? (isDark ? "rgba(96, 165, 250, 0.72)" : "rgba(37, 99, 235, 0.65)")
              : (isDark ? "rgba(245, 158, 11, 0.76)" : "rgba(217, 119, 6, 0.72)"),
            type: "dashed",
            width: 1,
          },
        })),
      } : undefined,
    },
    ...(heartRateDriftChartData.outputMode ? [{
      name: heartRateDriftOutputLabel, type: "line", yAxisIndex: 1, smooth: smoothGraphs, showSymbol: false,
      lineStyle: { width: 2, color: "#f59e0b" },
      sampling: smoothGraphs ? "lttb" : undefined,
      data: heartRateDriftOutputDataSmoothed,
    }] : []),
  ] : [];

  const heartRateDriftOption = hasHeartRateDriftChart && heartRateDriftChartData ? {
    tooltip: {
      trigger: "axis",
      ...tooltipStyle,
      formatter: (params: any[]) => {
        const p = params?.[0];
        const rel = Number(p?.value?.[0] ?? 0);
        let html = formatTooltipHeader(rel, null);
        for (const row of params) {
          if (row.value?.[1] !== null && row.value?.[1] !== undefined) {
            const isHeartRate = row.seriesName === tr("chart.heartRate");
            const value = Number(row.value[1]);
            if (isHeartRate) {
              html += `<div>${row.marker} ${row.seriesName}: <strong>${value.toFixed(1)} bpm</strong></div>`;
            } else if (heartRateDriftShowsPace) {
              html += `<div>${row.marker} ${row.seriesName}: <strong>${formatPaceValue(value)} ${heartRateDriftOutputUnit}</strong></div>`;
            } else {
              html += `<div>${row.marker} ${row.seriesName}: <strong>${value.toFixed(heartRateDriftOutputDigits)} ${heartRateDriftOutputUnit}</strong></div>`;
            }
          }
        }
        return html;
      },
    },
    legend: { textStyle: { color: axisColor, fontSize: 12 }, top: 0 },
    grid: { left: 46, right: heartRateDriftChartData.outputMode ? 48 : 18, top: 44, bottom: 46 },
    xAxis: {
      type: "value",
      axisLabel: { color: axisColor, fontSize: 11, formatter: (val: number) => formatRelTime(val) },
      axisLine: { lineStyle: { color: gridLine } },
      splitLine: { show: false },
    },
    yAxis: heartRateDriftYAxes,
    dataZoom: [
      {
        type: "inside",
        zoomOnMouseWheel: "ctrl",
        moveOnMouseWheel: false,
        start: zoomRange?.start ?? 0,
        end: zoomRange?.end ?? 100,
      },
    ],
    series: heartRateDriftSeries,
  } : null;


  const zoomEvents = {
    datazoom: (evt: any) => {
      const batch = evt?.batch?.[0];
      const start = typeof batch?.start === "number" ? batch.start : (typeof evt?.start === "number" ? evt.start : null);
      const end = typeof batch?.end === "number" ? batch.end : (typeof evt?.end === "number" ? evt.end : null);
      if (start !== null && end !== null) {
        onZoomChange?.({ start, end });
      }
    },
  };

  type VisibleChart = {
    id: string;
    available: boolean;
    title: string;
    option: Record<string, unknown>;
    onEvents?: typeof zoomEvents;
    height: number;
  };

  const paceChart: VisibleChart = {
    id: "pace",
    available: hasSpeedData,
    title: tr("chart.pace"),
    option: paceOption,
    onEvents: zoomEvents,
    height: insightChartHeight,
  };
  const heartRateChart: VisibleChart = {
    id: "heart-rate",
    available: hasHeartRateData,
    title: tr("chart.heartRate"),
    option: heartRateOption,
    onEvents: zoomEvents,
    height: insightChartHeight,
  };
  const speedChart: VisibleChart = {
    id: "speed",
    available: hasSpeedData,
    title: tr("insights.speed"),
    option: timelineOption,
    onEvents: zoomEvents,
    height: insightChartHeight,
  };
  const powerChart: VisibleChart = {
    id: "power",
    available: hasPowerData,
    title: tr("insights.power"),
    option: powerOption,
    onEvents: zoomEvents,
    height: insightChartHeight,
  };
  const cadenceChart: VisibleChart = {
    id: "cadence",
    available: hasCadenceData,
    title: tr("insights.cadence"),
    option: cadenceOption,
    onEvents: zoomEvents,
    height: insightChartHeight,
  };
  const staminaChart: VisibleChart = {
    id: "stamina",
    available: hasStaminaData,
    title: tr("insights.stamina"),
    option: staminaOption,
    onEvents: zoomEvents,
    height: insightChartHeight,
  };
  const performanceConditionChart: VisibleChart = {
    id: "performance-condition",
    available: hasPerformanceConditionData,
    title: tr("insights.performanceCondition"),
    option: performanceConditionOption,
    onEvents: zoomEvents,
    height: insightChartHeight,
  };
  const respirationChart: VisibleChart = {
    id: "respiration-rate",
    available: hasRespirationData,
    title: tr("insights.respirationRate"),
    option: respirationOption,
    onEvents: zoomEvents,
    height: insightChartHeight,
  };
  const temperatureChart: VisibleChart = {
    id: "temperature",
    available: hasTemperatureData,
    title: tr("insights.temperature"),
    option: temperatureOption,
    onEvents: zoomEvents,
    height: insightChartHeight,
  };

  const elevationChart: VisibleChart = {
    id: "elevation",
    available: hasElevationData,
    title: tr("insights.elevation"),
    option: elevationOption,
    onEvents: zoomEvents,
    height: insightChartHeight,
  };

  const metricCharts = usePaceDisplay
    ? [paceChart, heartRateChart, cadenceChart, elevationChart, powerChart]
    : hasPowerData
      ? [powerChart, heartRateChart, speedChart, cadenceChart, elevationChart]
      : [speedChart, heartRateChart, cadenceChart, elevationChart];

  const visibleMetricCharts = metricCharts.filter((chart) => chart.available);

  const supplementalCharts = [
    staminaChart,
    performanceConditionChart,
    respirationChart,
    temperatureChart,
    {
      id: "heart-rate-histogram",
      available: hasHeartRateData,
      title: tr("insights.hrHistogram"),
      option: hrHistogramOption,
      onEvents: undefined,
      height: insightChartHeight,
    },
    {
      id: "scatter-comparison",
      available: scatterData.length > 0,
      title: scatterTitle,
      option: scatterOption,
      onEvents: undefined,
      height: insightChartHeight,
    },
  ].filter((chart) => chart.available);

  return (
    <>
      {heartRateDriftOption && cardiacResult?.available && (
        <article className="panel heart-rate-drift-detail-panel">
          <div className="heart-rate-drift-detail-header">
            <div className="heart-rate-drift-title-row">
              <h3>{tr("insights.cardiacDecoupling")}</h3>
              <button
                type="button"
                className="heart-rate-drift-help-button"
                aria-label="Show heart rate drift help"
                aria-expanded={heartRateDriftHelpOpen}
                onClick={() => setHeartRateDriftHelpOpen((open) => !open)}
              >
                ?
              </button>
            </div>
            <div className="heart-rate-drift-detail-summary">
              <div className={`heart-rate-drift-detail-value ${cardiacBand ?? ""}`}>{formatPercent(cardiacResult.decouplingPct)}</div>
              <div className="heart-rate-drift-detail-status">
                <div className="heart-rate-drift-detail-badges">
                  <span className={`heart-rate-drift-status-badge drift-${cardiacIsNegative ? "negative" : cardiacBand ?? "unknown"}`}>
                    {cardiacIsNegative ? tr("insights.cardiacIncreasedEfficiency") : cardiacBandLabel(cardiacResult.decouplingPct, tr)}
                  </span>
                  {cardiacHalfSummary && <span className="heart-rate-drift-half-summary">{cardiacHalfSummary}</span>}
                </div>
                {cardiacConfidence && (
                  <div className={`heart-rate-drift-confidence-text confidence-${cardiacConfidence}`}>
                    <span>{cardiacConfidenceLabel(cardiacConfidence, tr)}</span>
                    {cardiacConfidenceReason && <span className="heart-rate-drift-confidence-reason"> · {cardiacConfidenceReason}</span>}
                  </div>
                )}
              </div>
            </div>
            {heartRateDriftHelpOpen && (
              <div className="heart-rate-drift-help-panel">
                <p><strong>What this shows:</strong> Heart Rate Drift compares Efficiency Factor (EF), the activity output divided by average heart rate, between the first and second halves of the analyzed section. Constant-effort machine results compare heart rate only. Lower drift usually means steadier aerobic efficiency.</p>
                <p><strong>Chart lines:</strong> Heart rate is plotted with the selected output metric when one is used. Cycling uses normalized power when it can be calculated. If normalized power is unavailable, speed can be used as a low-confidence fallback. Running, walking, and hiking are displayed as pace, while the calculation uses speed internally.</p>
                <p><strong>Regions:</strong> Shaded regions are excluded from the calculation. Longer activities are split into approximately 30-minute bins, with each bin EF shown on its Bin label when an output metric is used.</p>
                <p><strong>Use with care:</strong> This is most useful on steady aerobic efforts. Intervals, stops, hills, heat, dehydration, caffeine, poor sleep, or bad sensor data can distort the result. Confidence reflects data quality and mode assumptions, not medical certainty.</p>
              </div>
            )}
          </div>
          <ReactECharts option={heartRateDriftOption} onEvents={zoomEvents} onChartReady={enableChartWheelPageScroll} notMerge style={{ height: insightChartHeight, width: "100%" }} />
        </article>
      )}
      {visibleMetricCharts.map((chart) => (
        <article className="panel" key={chart.id}>
          <h3>{chart.title}</h3>
          <ReactECharts option={chart.option} onEvents={chart.onEvents} onChartReady={enableChartWheelPageScroll} notMerge style={{ height: chart.height, width: "100%" }} />
        </article>
      ))}
      {supplementalCharts.map((chart) => (
        <article className="panel" key={chart.id}>
          {chart.id === "scatter-comparison" ? (
            <div className="scatter-chart-header">
              <h3>{chart.title}</h3>
              <select
                value={selectedScatterPreset?.key ?? ""}
                onChange={(event) => setScatterPresetKey(event.target.value as ScatterPresetKey)}
                aria-label={tr("insights.scatterMetric")}
              >
                {availableScatterPresets.map((preset) => {
                  const xMetric = scatterMetrics[preset.xMetric];
                  const yMetric = scatterMetrics[preset.yMetric];
                  return (
                    <option key={preset.key} value={preset.key}>
                      {`${yMetric.label} vs ${xMetric.label}`}
                    </option>
                  );
                })}
              </select>
            </div>
          ) : (
            <h3>{chart.title}</h3>
          )}
          <ReactECharts option={chart.option} onEvents={chart.onEvents} onChartReady={enableChartWheelPageScroll} notMerge style={{ height: chart.height, width: "100%" }} />
        </article>
      ))}
      {hasHeartRateZoneData && (
        <article className="panel">
          <h3>{tr("insights.heartRateZoneTime")}</h3>
          <ZoneTimeBars title={tr("insights.heartRateZoneTime")} zones={hrZones} minutes={zoneMinutes} unit="bpm" totalMinutes={zoneChartTotalMinutes} />
        </article>
      )}
      {hasPowerZoneData && (
        <article className="panel">
          <h3>{tr("insights.powerZoneTime")}</h3>
          <ZoneTimeBars title={tr("insights.powerZoneTime")} zones={powerZones} minutes={powerZoneMinutes} unit="W" totalMinutes={zoneChartTotalMinutes} />
        </article>
      )}
    </>
  );
}
