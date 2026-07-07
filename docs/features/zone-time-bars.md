# Zone Time Bar Charts

## Branch

- Branch: `feature-graph-changes`
- Base: `upstream/main`

## Problem

The current time-in-zone charts use pie/donut charts for heart-rate and power
zones. They are crowded in the available panel space, the pie itself is small
relative to the tile, and labels such as `0.0 min` add visual noise without
helping comparison.

Zone data is ordered range data. A pie chart emphasizes share of total, but the
common user task is to compare time spent in each ordered zone.

## Design Direction

Replace heart-rate time-in-zone pie charts with ordered horizontal bar charts,
similar to Garmin's zone summaries. Power zone bars should use the same component
model after power-zone data is available in the app model.

Each row should show:

- Zone label, such as `Z1`, `Z2`, `Z3`.
- Zone value range, such as `<=110 bpm`, `111-128 bpm`, or `>165 bpm`.
- Duration, formatted as clock time rather than decimal minutes.
- Horizontal bar scaled against the largest zone duration in that chart.

Example heart-rate layout:

```text
Z1   <=110 bpm      0:37      |
Z2   111-128 bpm    3:52      | ###
Z3   129-146 bpm    1:13:09   | #######################
Z4   147-165 bpm    27:38     | ########
Z5   >165 bpm       0:00      |
```

Example power layout:

```text
Z1   <=118 W        1:53:48   | #######################
Z2   119-161 W      1:32      | ##
Z3   162-194 W      0:00      |
Z4   195-226 W      0:00      |
```

## Value Ranges

The value range should be shown once per row. Do not repeat the range in labels
inside the bar or in a separate legend.

Range formatting:

- First zone: `<=upper unit`
- Middle zones: `previous_upper + 1-upper unit`
- Last open-ended zone: `>previous_upper unit`

Use `bpm` for heart rate and `W` for power.

## Zero Values

Keep zero-duration zones visible because they are part of the configured zone
model. Make them visually subdued:

- Show duration as `0:00`.
- Do not draw a filled bar.
- Use muted text or lower emphasis for the row.
- Do not show noisy labels such as `0.0 min`.

## Interaction

Tooltips are optional. If retained, keep them minimal:

```text
Z3
129-146 bpm
1:13:09
52%
```

The chart should not need a legend because the row already contains the zone
label and range.

## Component Direction

Use one shared zone-time component model for heart-rate and power zones. In this
upstream-based branch, only heart-rate zone data is available, so the first code
slice implements heart-rate bars. Power bars should follow the same API once the
power-zone persistence work lands. Inputs should
be ordered zone definitions plus time values:

```tsx
<ZoneTimeBars
  title="Heart Rate Zone Time"
  zones={hrZones}
  seconds={hrZoneSeconds}
  unit="bpm"
/>

<ZoneTimeBars
  title="Power Zone Time"
  zones={powerZones}
  seconds={powerZoneSeconds}
  unit="W"
/>
```

The component should not know whether zones came from FIT, inferred FTP values,
or future user-entered zone profiles. Source handling belongs upstream in the
zone data model.

## Layout

- Fit naturally inside the existing insight panel grid.
- Avoid chart labels that can collide with neighbouring elements.
- Use stable columns for zone label, range, and duration so rows align.
- Let the bar area flex to available width.
- Preserve responsive behaviour on narrow screens.

## Time-Series Graph Direction

The current grouped time-series charts are awkward. The fixed Heart Rate and Pace
panel should be split into separate metric charts rather than kept as a hard-coded
combined chart.

Default time-series charts should be activity-dependent:

- Running, walking, and hiking should default to a Pace chart.
- Cycling and similar wheeled activities should default to Speed when power is
  absent, and Power when power is present and meaningful.
- Heart Rate should be its own chart when HR data exists.
- Cadence should be its own lower-priority chart when cadence data exists.
- The non-primary pace/speed metric can become optional later.

This means the first slice should move away from fixed paired charts such as
`Heart Rate + Pace` and `Cadence + Power`. A single chart card should have one
primary metric by default. Future overlays can intentionally add a second series,
but the default layout should not force unrelated metrics together.

Recommended default ordering:

Running, walking, and hiking:

1. Pace
2. Heart Rate
3. Cadence, when present
4. Power, when present
5. Zone time bars, when zone data exists

Cycling and similar activities:

1. Power, when present
2. Heart Rate, when present
3. Speed, when present
4. Cadence, when present
5. Zone time bars, when zone data exists

Elevation overlay support is a future-compatible design constraint for this
branch, not a required UI control in this slice. The implementation should not
remove altitude data or make later overlays harder. Elevation should remain
available as an overlay on the primary time-series metrics:

- Heart Rate with elevation overlay.
- Pace with elevation overlay.
- Speed with elevation overlay.
- Cadence with elevation overlay.
- Power with elevation overlay.

The first slice does not need full Garmin-style selectable overlays for every
metric combination, but the graph design should not prevent it. Elevation is the
required shared overlay because it explains changes in HR, pace, speed, cadence,
and power without needing its own full-width chart in every activity.

## HR Histogram

The existing HR histogram is only modestly useful once real HR zone-time bars are
available. It shows the distribution of HR samples across bpm buckets, but it
does not show when the effort happened, workout structure, or zone compliance as
clearly as the HR line chart and zone bars.

For this branch, treat the HR histogram as an advanced/optional chart and hide it
by default. Do not delete the implementation permanently; keep a path to restore
it later through optional/custom graph controls.

## Non-Goals

- Do not add user-editable zone settings in this branch.
- Do not change zone extraction or persistence.
- Do not add a new database table.
- Do not change the activity detail statistic tiles.
- Do not implement full user-customizable graph overlays in this branch unless
  explicitly added to scope.
- Do not keep fixed paired time-series charts as the default graph model.

## Acceptance Criteria

- Heart-rate zone time renders as horizontal bars when HR zone data exists.
- Power zone bars can be added through the same component model when power
  zone data exists in the app model.
- Zone ranges are visible exactly once per row.
- Durations use clock-style formatting, not decimal minutes.
- Zero-duration zones remain visible but subdued.
- No separate legend is required for zone labels or ranges.
- The panel is less crowded than the current pie/donut display.
- The fixed Heart Rate and Pace chart is split into separate metric charts.
- Pace versus speed defaults are selected by activity type.
- The implementation preserves a future path for elevation overlays on HR,
  pace, speed, cadence, and power charts, without adding overlay controls in
  this slice.
