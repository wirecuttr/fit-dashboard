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
<Z1  <92 bpm        0:37      |
Z1   92-109 bpm     3:52      | ###
Z2   110-127 bpm    1:13:09   | #######################
Z3   128-145 bpm    27:38     | ########
Z4   146-164 bpm    0:00      |
Z5   >164 bpm       0:00      |
```

Example power layout:

```text
<Z1  <118 W         1:53:48   | #######################
Z1   118-160 W      1:32      | ##
Z2   161-193 W      0:00      |
Z3   194-225 W      0:00      |
Z4   226-257 W      0:00      |
Z5   >257 W         0:00      |
```

## Value Ranges

The value range should be shown once per row. Do not repeat the range in labels
inside the bar or in a separate legend.

Range formatting uses FIT upper-bound arrays as bucket cut points. The app keeps the below-zone bucket visible instead of dropping it:

- Below zone 1: `<Z1`, rendered as `<first_upper unit`.
- Named middle zones: `Z1`, `Z2`, etc., rendered from the previous boundary to one less than the next boundary.
- Last named zone: open-ended, rendered as `>previous_upper - 1 unit`.

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

Use one shared zone-time component model for heart-rate and power zones. Inputs are ordered zone definitions plus duration values in minutes:

```tsx
<ZoneTimeBars
  title="Heart Rate Zone Time"
  zones={hrZones}
  minutes={hrZoneMinutes}
  unit="bpm"
/>

<ZoneTimeBars
  title="Power Zone Time"
  zones={powerZones}
  minutes={powerZoneMinutes}
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

Implemented default ordering:

Running, walking, and hiking:

1. Pace
2. Heart Rate
3. Heart Rate Zone Time, when available
4. Cadence, when present
5. Elevation, when present
6. Power, when present
7. Power Zone Time immediately after Power, when available

Cycling and similar activities:

1. Power, when present
2. Power Zone Time immediately after Power, when available
3. Heart Rate, when present
4. Heart Rate Zone Time immediately after Heart Rate, when available
5. Speed, when present
6. Cadence, when present
7. Elevation, when present

If a FIT zone-time summary exists without the corresponding record-based line
chart, keep it visible after the primary metric sequence and before supplemental
charts. Supplemental charts otherwise render after the paired metric and zone
summary sequence.

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

Elevation remains a standalone supplemental chart in this slice. Its y-axis uses
a padded data range with rounded bounds instead of always starting at zero, while
still clamping the lower bound to zero when the padded range would go negative.

## HR Histogram

The HR histogram remains available as a supplemental chart. It shows the
distribution of HR samples across bpm buckets, with the y-axis labelled as
samples. Zone labels and zone durations are shown below the matching bucket
ranges when HR zone data exists.

A future graph customisation feature may make the histogram optional, but hiding
it is not part of this implementation slice.

## Non-Goals

- Do not add user-editable zone settings in this branch.
- Do not add a new database table.
- Do not implement full user-customizable graph overlays in this branch unless
  explicitly added to scope.
- Do not keep fixed paired time-series charts as the default graph model.

## Acceptance Criteria

- Heart-rate zone time renders as horizontal bars when HR zone data exists.
- Power zone time renders through the same component model when power zone data
  exists in the app model.
- Zone ranges are visible exactly once per row.
- Durations use clock-style formatting, not decimal minutes.
- Zero-duration zones remain visible but subdued.
- No separate legend is required for zone labels or ranges.
- The panel is less crowded than the current pie/donut display.
- The fixed Heart Rate and Pace chart is split into separate metric charts.
- The fixed Cadence and Power chart is split into separate metric charts.
- Pace versus speed defaults are selected by activity type.
- Elevation uses a padded data-range y-axis instead of always starting at zero.
- The implementation preserves a future path for elevation overlays on HR,
  pace, speed, cadence, and power charts, without adding overlay controls in
  this slice.
