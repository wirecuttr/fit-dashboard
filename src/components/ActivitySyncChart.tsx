import { useCallback, useEffect, useRef, type CSSProperties } from "react";
import ReactECharts from "./ModularECharts";
import { enableChartWheelPageScroll } from "../lib/chartScroll";
import {
  nearestActivitySyncAxisRow,
  shouldShowActivitySyncTooltip,
  type ActivitySyncChartAdapter,
  type ActivitySyncController,
  type ActivitySyncPosition,
} from "../lib/activitySync";

type ChartInstance = {
  isDisposed(): boolean;
  getHeight(): number;
  getZr(): {
    on(event: "click", handler: (event: { offsetX?: number; offsetY?: number }) => void): void;
    off(event: "click", handler: (event: { offsetX?: number; offsetY?: number }) => void): void;
  };
  containPixel(finder: { gridIndex: number }, value: [number, number]): boolean;
  convertFromPixel(finder: { xAxisIndex: number }, value: [number, number]): number | number[];
  convertToPixel(finder: { xAxisIndex: number }, value: number): number | number[];
  dispatchAction(payload: Record<string, unknown>): void;
  getDom(): HTMLElement;
};

type Props = {
  activityId: number;
  chartKey: string;
  controller: ActivitySyncController | null;
  active: boolean;
  adapter: ActivitySyncChartAdapter;
  option: Record<string, unknown>;
  onEvents?: Record<string, (event: unknown) => void>;
  style: CSSProperties;
};

function syncOption(
  option: Record<string, unknown>,
  active: boolean,
): Record<string, unknown> {
  if (!active) return option;

  const tooltip = option.tooltip && typeof option.tooltip === "object" && !Array.isArray(option.tooltip)
    ? option.tooltip as Record<string, unknown>
    : {};
  const addAxisPointer = (axis: unknown) => {
    if (!axis || typeof axis !== "object" || Array.isArray(axis)) return axis;
    const axisRecord = axis as Record<string, unknown>;
    const current = axisRecord.axisPointer && typeof axisRecord.axisPointer === "object"
      ? axisRecord.axisPointer as Record<string, unknown>
      : {};
    return {
      ...axisRecord,
      axisPointer: {
        ...current,
        show: true,
        snap: false,
        lineStyle: {
          color: "#f59e0b",
          width: 1.5,
          type: "solid",
        },
      },
    };
  };

  return {
    ...option,
    tooltip: { ...tooltip, triggerOn: "none" },
    xAxis: Array.isArray(option.xAxis)
      ? option.xAxis.map(addAxisPointer)
      : addAxisPointer(option.xAxis),
  };
}

function hideProgrammaticUi(chart: ChartInstance | null) {
  if (!chart || chart.isDisposed()) return;
  chart.dispatchAction({ type: "updateAxisPointer", currTrigger: "leave" });
  chart.dispatchAction({ type: "hideTip" });
}

function pixelX(value: number | number[]): number | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

function axisX(value: number | number[]): number | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

export function ActivitySyncChart({
  activityId,
  chartKey,
  controller,
  active,
  adapter,
  option,
  onEvents,
  style,
}: Props) {
  const chartRef = useRef<ChartInstance | null>(null);
  const bindingCleanupRef = useRef<(() => void) | null>(null);
  const latestRef = useRef({ activityId, controller, active, adapter });
  latestRef.current = { activityId, controller, active, adapter };

  const applyPosition = useCallback((
    chart: ChartInstance,
    position: ActivitySyncPosition | null,
  ) => {
    const latest = latestRef.current;
    if (!latest.active || !position || position.activityId !== latest.activityId || chart.isDisposed()) {
      hideProgrammaticUi(chart);
      return;
    }

    const x = latest.adapter.sourceTimestampToX(position.sourceTimestampMs);
    if (x === null || !Number.isFinite(x)) {
      hideProgrammaticUi(chart);
      return;
    }

    const converted = pixelX(chart.convertToPixel({ xAxisIndex: 0 }, x));
    const y = chart.getHeight() / 2;
    if (converted === null || !chart.containPixel({ gridIndex: 0 }, [converted, y])) {
      hideProgrammaticUi(chart);
      return;
    }

    chart.dispatchAction({
      type: "updateAxisPointer",
      currTrigger: "mousemove",
      x: converted,
      y,
    });

    const row = nearestActivitySyncAxisRow(
      latest.adapter.axisRows,
      x,
      position.sourceTimestampMs,
    );
    if (shouldShowActivitySyncTooltip(
      position.sourceTimestampMs,
      row,
      latest.adapter.axisRows,
      latest.adapter.stoppedIntervals,
    )) {
      chart.dispatchAction({ type: "showTip", x: converted, y });
    } else {
      chart.dispatchAction({ type: "hideTip" });
    }
  }, []);

  const detachBindings = useCallback(() => {
    bindingCleanupRef.current?.();
    bindingCleanupRef.current = null;
  }, []);

  const bindCurrentChart = useCallback(() => {
    detachBindings();
    const chart = chartRef.current;
    const latest = latestRef.current;
    if (!chart || chart.isDisposed()) return;
    if (!latest.active || !latest.controller) {
      hideProgrammaticUi(chart);
      return;
    }

    const listener = (position: ActivitySyncPosition | null) => applyPosition(chart, position);
    const unsubscribe = latest.controller.subscribe(listener);
    const clickHandler = (event: { offsetX?: number; offsetY?: number }) => {
      const current = latestRef.current;
      if (!current.active || !current.controller || chart.isDisposed()) return;
      const offsetX = event.offsetX;
      const offsetY = event.offsetY;
      if (typeof offsetX !== "number" || typeof offsetY !== "number") return;
      if (!chart.containPixel({ gridIndex: 0 }, [offsetX, offsetY])) return;
      const x = axisX(chart.convertFromPixel({ xAxisIndex: 0 }, [offsetX, offsetY]));
      if (x === null) return;
      const sourceTimestampMs = current.adapter.xToSourceTimestamp(
        x,
        current.controller.getCurrent()?.sourceTimestampMs ?? null,
      );
      if (sourceTimestampMs === null || !Number.isFinite(sourceTimestampMs)) return;
      current.controller.publish({
        activityId: current.activityId,
        sourceTimestampMs,
        origin: "chart",
      }, { immediate: true });
    };
    chart.getZr().on("click", clickHandler);
    bindingCleanupRef.current = () => {
      unsubscribe();
      if (!chart.isDisposed()) chart.getZr().off("click", clickHandler);
    };
    applyPosition(chart, latest.controller.getCurrent());
  }, [applyPosition, detachBindings]);

  useEffect(() => {
    if (!controller) return;
    return controller.registerChart(chartKey);
  }, [chartKey, controller]);

  useEffect(() => {
    bindCurrentChart();
    return () => {
      detachBindings();
    };
  }, [activityId, active, controller, bindCurrentChart, detachBindings]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !active || !controller) return;
    const frame = requestAnimationFrame(() => {
      if (!chart.isDisposed()) applyPosition(chart, controller.getCurrent());
    });
    return () => cancelAnimationFrame(frame);
  }, [active, adapter, controller, option, applyPosition]);

  useEffect(() => () => {
    detachBindings();
    hideProgrammaticUi(chartRef.current);
    chartRef.current = null;
  }, [detachBindings]);

  const onChartReady = useCallback((chart: ChartInstance) => {
    if (chartRef.current && chartRef.current !== chart) {
      detachBindings();
      hideProgrammaticUi(chartRef.current);
    }
    chartRef.current = chart;
    enableChartWheelPageScroll(chart);
    bindCurrentChart();
  }, [bindCurrentChart, detachBindings]);

  return (
    <ReactECharts
      option={syncOption(option, active)}
      onEvents={onEvents}
      onChartReady={onChartReady}
      notMerge
      style={style}
    />
  );
}
