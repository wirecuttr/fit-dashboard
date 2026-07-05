# Activity Chart Availability and Layout

## Related Issue

- Issue #43: unavailable activity charts and map panels are still shown
- PR #44: hide unavailable activity charts and map panels

## Problem

Some activities do not contain the data required by every Individual page visual.
Examples include activities without GPS route points, altitude samples, heart
rate, power, cadence, speed, or temperature.

The UI should not show graph or map panels that cannot render meaningful data.
When those panels are removed, later available visuals should move into the open
position instead of leaving a fixed blank slot.

## Design Direction

Use one ordered visual grid for the Individual page visual area. The heart-rate
and pace panel, route map, and insight charts should be direct children of the
same grid.

The intended order is:

```ts
const visualDefinitions = [
  heartRateAndPace,
  routeMap,
  speedTrend,
  heartRateZones,
  heartRateHistogram,
  cadencePower,
  effortHeatmap,
  elevation,
  powerVsHeartRate,
];
```

Each visual should be rendered only when its data is available. The rendered
children then flow left-to-right in the shared grid.

This is intentionally different from keeping a separate top chart/map grid and a
separate insight grid. Separate grids cannot pack across section boundaries, so a
lower chart cannot move into the missing map position.

## Layout Rules

- Keep visual order stable.
- Do not reorder visuals based on availability.
- Do not use masonry packing.
- Do not dynamically span arbitrary odd final panels.
- Do not make visual order depend on translated labels.
- Allow a final empty slot when the visible count is odd in a two-column layout.

## Responsive Rules

- Narrow screens use one column.
- Wider screens use two columns for normal visual cards.
- Breakpoint behaviour should stay CSS-driven.

## Heart-Rate/Pace Panel

The heart-rate/pace visual may contain up to two stacked chart instances:

- heart rate
- pace

This can remain as two chart instances for now. Heart rate and pace use different
y-axis semantics, and pace uses an inverted axis. Combining them into one
multi-axis chart is possible, but it is a larger chart-design change than this
branch needs.

If only one of the two charts is available, the remaining chart should expand
vertically to fill the panel's intended chart area. If neither is available, the
whole heart-rate/pace visual should not render.

## Heatmap Height

The effort heatmap may contain fewer metric rows when only some streams are
available. That is correct semantically, but very short chart cards can look like
layout gaps beside standard-height charts.

The initial implementation should favour consistent card height for graph panels
where practical. The heatmap can still render fewer internal rows while keeping a
card height that aligns with neighbouring charts.

## Future Customisation

The ordered visual grid is intended to support later work such as:

- activity-type-specific default visual sets
- user-hidden optional charts
- per-chart default visibility
- chart grouping, such as primary telemetry, effort, sensors, and route
- cleaner support for visuals that need different data streams

This branch does not implement those future customisation controls.

## Acceptance Criteria

- Unavailable charts and map panels are not rendered.
- Hidden visuals do not reserve fixed slots.
- Remaining visuals render left-to-right in stable order.
- If the map is unavailable, the next available chart moves into its grid slot.
- Narrow screens use a single-column layout.
- Wider screens use a predictable two-column layout.
- A final odd desktop visual may leave an empty bottom-right slot.
- Dynamic arbitrary spanning is not used.
- Heatmap sizing does not create misleading chart-grid whitespace.
