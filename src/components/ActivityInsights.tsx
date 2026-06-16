import { useState } from "react";
import ReactECharts from "echarts-for-react";
import type { Activity, RecordPoint } from "../types";
import { enableChartWheelPageScroll } from "../lib/chartScroll";
import { buildHeartRateZones, resolveHeartRateZoneIndex } from "../lib/hrZones";
import { applyRollingAverageSeries, getDynamicSmoothingWindow } from "../lib/chartSmoothing";
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
  heartRateZoneBoundsBpm?: number[];
  zoomRange?: { start: number; end: number } | null;
  onZoomChange?: (range: { start: number; end: number }) => void;
  lapTimestampsUtc?: string[];
  smoothGraphs?: boolean;
  timerMetadata?: TelemetryTimerMetadata | null;
};

type SeriesRow = [number, number | null, number, number, number | null];

function isSeriesRow(row: [number | null, number | null, number, number, number | null]): row is SeriesRow {
  return typeof row[0] === "number" && Number.isFinite(row[0]);
}

function safeAvg(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
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
  heartRateZoneBoundsBpm,
  zoomRange,
  onZoomChange,
  lapTimestampsUtc = [],
  smoothGraphs = true,
  timerMetadata,
}: Props) {
  const hrZones = buildHeartRateZones(heartRateZoneBoundsBpm);
  const isDark = theme === "dark";
  const { t: tr } = useTranslation();
  const [heartRateDriftHelpOpen, setHeartRateDriftHelpOpen] = useState(false);
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
      timestampMs: point.timestampMs,
    };
  });

  const speedLineData = timeline.map((d) => [d.x, d.speedInUnit, d.relMs, d.timestampMs, d.distanceMeters] as [number | null, number | null, number, number, number | null]).filter(isSeriesRow);
  const elevationLineData = timeline.map((d) => [d.x, d.altitudeInUnit, d.relMs, d.timestampMs, d.distanceMeters] as [number | null, number | null, number, number, number | null]).filter(isSeriesRow);
  const cadenceLineData = timeline.map((d) => [d.x, d.cadence, d.relMs, d.timestampMs, d.distanceMeters] as [number | null, number | null, number, number, number | null]).filter(isSeriesRow);
  const powerLineData = timeline.map((d) => [d.x, d.power, d.relMs, d.timestampMs, d.distanceMeters] as [number | null, number | null, number, number, number | null]).filter(isSeriesRow);

  const speedLineDataSmoothed = smoothGraphs ? applyRollingAverageSeries(speedLineData, 1, smoothWindow) : speedLineData;
  const elevationLineDataSmoothed = smoothGraphs ? applyRollingAverageSeries(elevationLineData, 1, smoothWindow) : elevationLineData;
  const cadenceLineDataSmoothed = smoothGraphs ? applyRollingAverageSeries(cadenceLineData, 1, smoothWindow) : cadenceLineData;
  const powerLineDataSmoothed = smoothGraphs ? applyRollingAverageSeries(powerLineData, 1, smoothWindow) : powerLineData;

  const hasPowerData = timeline.some((d) => typeof d.power === "number" && d.power > 0);
  const hasHeartRateData = timeline.some((d) => typeof d.heartRate === "number" && d.heartRate > 0);
  const hasElevationData = timeline.some((d) => typeof d.altitudeInUnit === "number" && Number.isFinite(d.altitudeInUnit));
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
  const zoneMinutes = hrZones.map(() => 0);
  if (hrValues.length > 0) {
    for (let i = 0; i < timeline.length - 1; i += 1) {
      const hr = timeline[i].heartRate;
      if (typeof hr !== "number" || hr <= 0) continue;
      const dtMin = Math.max(0, (timeline[i + 1].relMs - timeline[i].relMs) / 60000);
      const zoneIndex = resolveHeartRateZoneIndex(hr, hrZones);
      zoneMinutes[zoneIndex] += dtMin;
    }
  }

  const sharedXAxis = {
    type: "value",
    ...xAxisBounds,
    axisLabel: { color: axisColor, fontSize: 11, formatter: (val: number) => formatTelemetryXAxisTick(val, xAxisMode, distanceUnit) },
    axisLine: { lineStyle: { color: gridLine } },
    splitLine: { show: false },
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
        lineStyle: { width: 1.5, color: "#f97316" },
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

  const zoneOption = {
    tooltip: {
      trigger: "item",
      ...tooltipStyle,
      formatter: (p: any) => `${p.marker} ${p.name}: <strong>${Number(p.value).toFixed(2)} min</strong>`
    },
    legend: { bottom: 0, textStyle: { color: axisColor, fontSize: 12 } },
    series: [
      {
        type: "pie",
        radius: ["38%", "72%"],
        padAngle: 2,
        itemStyle: {
          borderRadius: 8,
          borderColor: isDark ? "#0b1220" : "#ffffff",
          borderWidth: 3,
        },
        label: { color: axisColor, fontSize: 12, formatter: (p: any) => `${p.name}\n${Number(p.value).toFixed(1)} min` },
        data: hrZones.map((zone, idx) => ({
          name: zone.name,
          value: zoneMinutes[idx],
          itemStyle: { color: zone.color },
        })),
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
            const unit = row.seriesName === tr("insights.cadence") ? " rpm" : " W";
            html += `<div>${row.marker} ${row.seriesName}: <strong>${Number(row.value[1]).toFixed(2)}${unit}</strong></div>`;
          }
        }
        return html;
      }
    },
    legend: { textStyle: { color: axisColor, fontSize: 12 }, top: 0 },
    grid: { left: 44, right: hasPowerData ? 44 : 16, top: 44, bottom: 44 },
    xAxis: sharedXAxis,
    yAxis: [
      {
        type: "value", name: "rpm",
        nameTextStyle: { color: axisColor, fontSize: 11 },
        axisLabel: { color: axisColor, fontSize: 11 },
        splitLine: { lineStyle: { color: gridLine } },
      },
      ...(hasPowerData ? [{
        type: "value", name: "W",
        nameTextStyle: { color: axisColor, fontSize: 11 },
        axisLabel: { color: axisColor, fontSize: 11 },
        splitLine: { show: false },
      }] : []),
    ],
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
      ...(hasPowerData ? [{
        name: tr("insights.power"), type: "line", yAxisIndex: 1, smooth: smoothGraphs, showSymbol: false,
        sampling: smoothGraphs ? "lttb" : undefined,
        data: powerLineDataSmoothed,
        lineStyle: { color: "#f97316" },
      }] : []),
    ],
  };

  const hrPowerScatter = timeline
    .filter((d) => typeof d.heartRate === "number" && typeof d.power === "number")
    .map((d) => [d.heartRate as number, d.power as number]);

  const scatterOption = {
    tooltip: { trigger: "item", ...tooltipStyle },
    grid: { left: 44, right: 20, top: 28, bottom: 40 },
    xAxis: {
      type: "value", name: "HR",
      nameTextStyle: { color: axisColor, fontSize: 11 },
      axisLabel: { color: axisColor, fontSize: 11 },
      splitLine: { lineStyle: { color: gridLine } },
    },
    yAxis: {
      type: "value", name: "W",
      nameTextStyle: { color: axisColor, fontSize: 11 },
      axisLabel: { color: axisColor, fontSize: 11 },
      splitLine: { lineStyle: { color: gridLine } },
    },
    series: [
      {
        type: "scatter",
        symbolSize: 5,
        itemStyle: { color: "#f59e0b", opacity: 0.7 },
        data: hrPowerScatter,
      },
    ],
  };

  const hrHistogram = (() => {
    if (!hrValues.length) {
      return { labels: [] as string[], counts: [] as number[], centers: [] as number[], binWidth: 1 };
    }
    const minHr = Math.floor(Math.min(...hrValues));
    const maxHr = Math.ceil(Math.max(...hrValues));
    const hrRange = Math.max(1, maxHr - minHr);
    const targetBins = Math.max(12, Math.min(72, Math.round(Math.sqrt(hrValues.length) * 2.2)));
    const binWidth = Math.max(1, Math.ceil(hrRange / targetBins));
    const start = Math.floor(minHr / binWidth) * binWidth;
    const end = Math.ceil(maxHr / binWidth) * binWidth;
    const binCount = Math.max(1, Math.ceil((end - start) / binWidth));
    const counts = new Array<number>(binCount).fill(0);

    for (const hr of hrValues) {
      const binIndex = Math.min(binCount - 1, Math.max(0, Math.floor((hr - start) / binWidth)));
      counts[binIndex] += 1;
    }

    const labels = counts.map((_, idx) => {
      const left = start + idx * binWidth;
      const right = left + binWidth;
      return `${left}-${right}`;
    });

    const centers = counts.map((_, idx) => {
      const left = start + idx * binWidth;
      return left + binWidth / 2;
    });

    return { labels, counts, centers, binWidth };
  })();

  const hrHistogramOption = {
    tooltip: {
      trigger: "item",
      ...tooltipStyle,
      formatter: (p: any) => {
        const label = String(p?.name ?? "");
        const count = Number(p?.value ?? 0);
        return `<div><strong>${label} bpm</strong></div><div>Samples: <strong>${count}</strong></div>`;
      },
    },
    grid: { left: 44, right: 16, top: 28, bottom: 56 },
    xAxis: {
      type: "category",
      name: `bpm (bin ~${hrHistogram.binWidth})`,
      data: hrHistogram.labels,
      nameTextStyle: { color: axisColor, fontSize: 11, padding: [26, 0, 0, 0] },
      axisLabel: { color: axisColor, fontSize: 10, interval: Math.max(0, Math.floor(hrHistogram.labels.length / 12)) },
      axisLine: { lineStyle: { color: gridLine } },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      name: "count",
      nameTextStyle: { color: axisColor, fontSize: 11 },
      axisLabel: { color: axisColor, fontSize: 11 },
      splitLine: { lineStyle: { color: gridLine } },
    },
    series: [
      {
        type: "bar",
        barGap: "0%",
        barWidth: "96%",
        itemStyle: { borderRadius: [2, 2, 0, 0] },
        data: hrHistogram.counts.map((count, idx) => {
          const centerHr = hrHistogram.centers[idx] ?? 0;
          const zone = hrZones[resolveHeartRateZoneIndex(centerHr, hrZones)];
          return {
            value: count,
            itemStyle: { color: zone.color },
          };
        }),
      },
    ],
  };

  const totalRelMs = Math.max(0, timeline[timeline.length - 1]?.relMs ?? totalDurationMs);
  const heatBins = Math.max(1, Math.ceil(totalRelMs / 60000));
  const heatMetrics = [
    {
      label: "HR",
      unit: "bpm",
      getter: (d: (typeof timeline)[number]) => d.heartRate,
      colors: isDark ? ["#2a0b12", "#dc2626", "#fb7185"] : ["#fee2e2", "#f87171", "#dc2626"],
    },
    {
      label: "Speed",
      unit: speedLabel(distanceUnit),
      getter: (d: (typeof timeline)[number]) => d.speedInUnit,
      colors: isDark ? ["#0e2a1e", "#16a34a", "#4ade80"] : ["#dcfce7", "#4ade80", "#15803d"],
    },
    {
      label: "Cadence",
      unit: "rpm",
      getter: (d: (typeof timeline)[number]) => d.cadence,
      colors: isDark ? ["#2f1a05", "#f59e0b", "#facc15"] : ["#fef3c7", "#fbbf24", "#d97706"],
    },
    {
      label: "Temp",
      unit: "degC",
      getter: (d: (typeof timeline)[number]) => d.temperatureC,
      colors: isDark ? ["#0b1a3a", "#1d4ed8", "#38bdf8"] : ["#dbeafe", "#60a5fa", "#1d4ed8"],
    },
  ] as const;

  const heatRowBounds = heatMetrics.map(() => ({ min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY }));
  const rawHeatCells: Array<Array<{ x: number; raw: number | null }>> = heatMetrics.map(() => []);

  for (let x = 0; x < heatBins; x += 1) {
    const startMs = x * 60000;
    const endMs = startMs + 60000;
    const slice = timeline.filter((d) => d.relMs >= startMs && d.relMs < endMs);
    for (let row = 0; row < heatMetrics.length; row += 1) {
      const metricValue = safeAvg(slice.map((r) => heatMetrics[row].getter(r)));
      const raw = typeof metricValue === "number" && Number.isFinite(metricValue) ? Number(metricValue.toFixed(2)) : null;
      if (raw !== null) {
        heatRowBounds[row].min = Math.min(heatRowBounds[row].min, raw);
        heatRowBounds[row].max = Math.max(heatRowBounds[row].max, raw);
      }
      rawHeatCells[row].push({ x, raw });
    }
  }

  const heatSeriesData: Array<Array<{ value: [number, number, number]; raw: number | null; label: string; unit: string }>> =
    rawHeatCells.map((rowCells, row) => {
      const bounds = heatRowBounds[row];
      const hasBounds = Number.isFinite(bounds.min) && Number.isFinite(bounds.max);
      return rowCells.map(({ x, raw }) => {
        let normalized = 0;
        if (raw !== null && hasBounds) {
          normalized = bounds.max > bounds.min ? (raw - bounds.min) / (bounds.max - bounds.min) : 0.5;
        }
        return {
          value: [x, 0, Number(normalized.toFixed(4))],
          raw,
          label: heatMetrics[row].label,
          unit: heatMetrics[row].unit,
        };
      });
    });

  const rowTop = [16, 64, 112, 160];
  const rowHeight = 34;

  const heatOption = {
    tooltip: {
      position: "top",
      ...tooltipStyle,
      formatter: (p: any) => {
        const minuteIdx = Number(p?.value?.[0] ?? 0);
        const value = (p?.data?.raw ?? null) as number | null;
        const label = String(p?.data?.label ?? "Metric");
        const unit = String(p?.data?.unit ?? "");
        const startMs = minuteIdx * 60000;
        const endMs = (minuteIdx + 1) * 60000;
        const valueText = value === null ? "--" : `${value.toFixed(2)} ${unit}`;
        return `<div><strong>${label}</strong></div>${formatTooltipHeader(startMs, null, "time")}<div>${formatRelTime(startMs)} - ${formatRelTime(endMs)}: <strong>${valueText}</strong></div>`;
      },
    },
    grid: rowTop.map((top) => ({ left: 58, right: 14, top, height: rowHeight })),
    xAxis: rowTop.map((_, idx) => ({
      type: "category",
      gridIndex: idx,
      data: Array.from({ length: heatBins }, (_, i) => formatRelTime(i * 60000)),
      axisLabel: {
        show: idx === rowTop.length - 1,
        color: axisColor,
        interval: Math.max(0, Math.floor(heatBins / 14)),
        fontSize: 11,
      },
      axisLine: { show: idx === rowTop.length - 1, lineStyle: { color: gridLine } },
      axisTick: { show: idx === rowTop.length - 1 },
      splitLine: { show: false },
    })),
    yAxis: heatMetrics.map((metric, idx) => ({
      type: "category",
      gridIndex: idx,
      data: [metric.label],
      axisLabel: { color: axisColor, fontSize: 11 },
      axisTick: { show: false },
      axisLine: { show: false },
      splitLine: { show: false },
    })),
    visualMap: heatMetrics.map((metric, idx) => ({
      show: false,
      min: 0,
      max: 1,
      dimension: 2,
      seriesIndex: idx,
      inRange: { color: metric.colors },
    })),
    series: heatMetrics.map((_, idx) => ({
      type: "heatmap",
      xAxisIndex: idx,
      yAxisIndex: idx,
      encode: { x: 0, y: 1, value: 2 },
      data: heatSeriesData[idx],
      emphasis: { itemStyle: { borderColor: isDark ? "#fff" : "#0f172a", borderWidth: 1 } },
    })),
  };

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

  return (
    <section className="insight-grid">
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
                <p><strong>Use with care:</strong> This is most useful on steady aerobic efforts. Intervals, stops, hills, heat, dehydration, fatigue, caffeine, poor sleep, or bad sensor data can distort the result. Confidence reflects data quality and mode assumptions, not medical certainty.</p>
              </div>
            )}
          </div>
          <ReactECharts option={heartRateDriftOption} onEvents={zoomEvents} onChartReady={enableChartWheelPageScroll} notMerge style={{ height: 280, width: "100%" }} />
        </article>
      )}
      <article className="panel">
        <h3>{tr("insights.speedTrend")}</h3>
        <ReactECharts option={timelineOption} onEvents={zoomEvents} onChartReady={enableChartWheelPageScroll} notMerge style={{ height: 280, width: "100%" }} />
      </article>
      {hasPowerData && hasHeartRateData && (
        <article className="panel">
          <h3>{tr("insights.heartRateZoneTime")}</h3>
          <ReactECharts option={zoneOption} onChartReady={enableChartWheelPageScroll} notMerge style={{ height: 280, width: "100%" }} />
        </article>
      )}
      {hasHeartRateData && (
        <article className="panel">
          <h3>{tr("insights.hrHistogram")}</h3>
          <ReactECharts option={hrHistogramOption} onChartReady={enableChartWheelPageScroll} notMerge style={{ height: 280, width: "100%" }} />
        </article>
      )}
      <article className="panel">
        <h3>{hasPowerData ? tr("insights.cadenceAndPower") : tr("insights.cadence")}</h3>
        <ReactECharts option={cadenceOption} onEvents={zoomEvents} onChartReady={enableChartWheelPageScroll} notMerge style={{ height: 280, width: "100%" }} />
      </article>
      <article className="panel">
        <h3>{tr("insights.effortHeatmap")}</h3>
        <ReactECharts option={heatOption} onChartReady={enableChartWheelPageScroll} notMerge style={{ height: 280, width: "100%" }} />
      </article>
      {hasElevationData && (
        <article className="panel">
          <h3>{tr("insights.elevation")}</h3>
          <ReactECharts option={elevationOption} onEvents={zoomEvents} onChartReady={enableChartWheelPageScroll} notMerge style={{ height: 280, width: "100%" }} />
        </article>
      )}
      {hasPowerData && hasHeartRateData && (
        <article className="panel">
          <h3>{tr("insights.powerVsHeartRate")}</h3>
          <ReactECharts option={scatterOption} onChartReady={enableChartWheelPageScroll} notMerge style={{ height: 280, width: "100%" }} />
        </article>
      )}
    </section>
  );
}
