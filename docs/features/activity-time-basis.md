# Activity Time Basis, Summary Times, and Pause-Aware Playback

## Status

- Status: implemented; integrated Docker validation pending
- Working branch: `feature/activity-time-basis`
- Branch base: local `main` at `220a1fb`
- Intended destination: local/private `main`
- Upstream pull request: not planned as part of this feature

This document combines the product design and implementation plan for exposing
Moving and Total time consistently across the Individual activity summary, map
playback, and time-based telemetry charts.

## Summary

FIT Dashboard currently uses several related but different time concepts:

- the activity `duration_s` normally comes from FIT timer time;
- time-based telemetry charts automatically remove reliable stopped intervals;
- map playback advances over elapsed record timestamps; and
- the map counter displays the timestamp of the most recently selected GPS
  record rather than the continuously advancing playback clock.

That combination makes map playback stop during a recorded pause while its time
counter also appears to stop. When the next GPS record is reached, the counter
jumps forward. The behaviour is especially conspicuous on activities with many
Auto Pause events or long manual pauses.

The feature introduces one shared time basis for the Individual activity page:

```text
moving | total
```

Moving time excludes reliable stopped intervals. Total time includes them. The
selected basis controls map playback and time-based telemetry charts, while
distance-based charts retain their existing active-record semantics.

The activity summary is also made explicit:

- rename Duration to Moving time when timer time is known; and
- add Total time when a semantic elapsed-time source is available, even when it
  happens to equal Moving time.

## Existing Behaviour

### Imported activity time

For FIT activities, duration selection currently prefers:

1. the sum of session `total_timer_time` values;
2. activity `total_timer_time`;
3. the sum of lap `total_timer_time` values;
4. the sum of session `total_elapsed_time` values; and
5. the first-to-last record timestamp span.

The selected value is stored as `activities.duration_s`. The parser also stores
timer metadata in `metadata_json.timer`, including elapsed time, timer time,
timer events, stopped intervals, and interval reliability.

GPX and TCX imports require timestamped trackpoints and derive duration from the
first-to-last timestamp span. They do not currently provide a distinct moving
and total timeline.

The application model does not represent missing duration as a first-class
state. Database nulls are read as zero and a one-point activity can have a zero
duration. Control availability must therefore use a positive timestamp span,
not merely the presence of `duration_s`.

### Telemetry charts

When reliable FIT stopped intervals are available, the current telemetry helper:

- removes records inside stopped intervals;
- subtracts prior stopped duration from time-axis coordinates; and
- maps lap markers onto the resulting active-time axis.

When reliable intervals are unavailable, it falls back to elapsed timestamps.
Distance charts use the same active-record filtering when reliable intervals
exist.

### Map playback

The map currently uses elapsed milliseconds from the first GPS record as its
playhead. GPS records are selected by timestamp. The slider and its visual
progress are based on GPS record indexes.

During a timestamp gap:

- the internal playhead continues advancing;
- the selected GPS record and route endpoint do not change;
- the displayed counter remains derived from the selected record; and
- the counter jumps when the next GPS record becomes current.

The counter freeze is therefore a display-clock defect, not a stopped playback
clock. The index-based slider has the same conceptual problem because it cannot
represent time inside a pause.

## Terminology

### Moving time

Moving time is the user-facing label for recorded timer time with reliable
stopped intervals removed from its timeline.

This value is not inferred from GPS speed. FIT timer time can include stationary
periods when Auto Pause was not active, so help text should define it as recorded
timer time excluding recorded pauses.

### Total time

Total time is elapsed wall-clock time from the activity start to end, including
recorded pauses. Prefer FIT session elapsed time when available. A record span
may be used as a fallback for display, but a separate selectable timeline
requires reliable stopped intervals so Moving and Total can be mapped safely.

### Duration

Duration remains the fallback label when the source format provides only one
undifferentiated time value. It must not be relabelled Moving time when the
application only knows an elapsed record span.

### Pause

A pause is a stopped interval reconstructed from reliable FIT timer stop and
resume events. Manual pauses and device Auto Pause intervals use the same
timeline rules. Trigger metadata remains available for diagnostics but does not
change display behaviour in the first implementation.

## Goals

- Make Moving and Total time explicit in the Individual activity summary.
- Provide one time-basis setting shared by map playback and time-based charts.
- Let users either skip pauses or view their real elapsed duration.
- Keep the map clock and progress slider advancing continuously in both modes.
- Hold the map position during included pauses and explain the hold with a
  Paused indicator.
- Display stopped-period telemetry on Total-time charts when the source contains
  it.
- Make pause gaps visible without drawing misleading interpolated chart lines.
- Preserve active-record semantics for distance charts and derived analysis.
- Reuse one tested timer-interval model across maps, charts, tooltips, and lap
  markers.
- Keep the controls visually consistent with the existing segmented controls.

## Non-Goals

- Inferring moving time from speed or GPS displacement.
- Adding pause reconstruction for GPX or TCX in the first implementation.
- Changing activity-list, overview, or filter duration semantics.
- Recalculating cardiac decoupling, time in zone, or other derived metrics when
  the display basis changes.
- Changing map route geometry or low-speed Follow bearing stabilisation.
- Persisting the selected time basis in DuckDB.
- Editing, adding, or deleting timer events.
- Adding pause time as a separate summary statistic in the first implementation.
- Changing CSV or JSON export time semantics.

## Resolved Time Model

Introduce a shared frontend module, for example `src/lib/activityTime.ts`, that
owns timer interval parsing and all mappings between source timestamps, Moving
time, and Total time.

Suggested types:

```ts
export type ActivityTimeBasis = "moving" | "total";

export type ActivityTimeResolution = {
  movingDurationMs: number | null;
  totalDurationMs: number | null;
  recordSpanMs: number;
  stoppedDurationMs: number;
  stoppedIntervals: Array<{
    startMs: number;
    endMs: number;
  }>;
  intervalsReliable: boolean;
  hasPositiveTimeRange: boolean;
  hasDistinctTotalTime: boolean;
  movingLabelSupported: boolean;
};
```

The module should expose pure helpers for:

- resolving authoritative Moving and Total durations;
- merging and clamping stopped intervals;
- determining whether a timestamp is stopped;
- calculating stopped duration before a timestamp;
- mapping a source timestamp to Moving elapsed time;
- mapping Moving elapsed time back to a source timestamp;
- mapping Total elapsed time to a source timestamp; and
- resolving the effective basis when the requested basis is unavailable.

The existing timer helpers in `src/lib/telemetryAxis.ts` should move into or
delegate to this shared module. Map and chart code must not maintain separate
pause-pairing or duration-subtraction implementations.

### Source precedence

Moving duration should prefer:

1. positive `metadata.timer.timer_time_s`;
2. positive timer-derived `activity.duration_s`; and
3. no Moving-specific value.

Total duration should prefer:

1. positive `metadata.timer.elapsed_time_s`;
2. positive top-level FIT `total_elapsed_time_s`;
3. a positive activity start-to-end span; and
4. a positive first-to-last record span.

Moving-to-source timestamp mapping requires reliable stopped intervals. A timer
total alone is not enough to identify where pauses occurred.

Use a small tolerance for display availability so timestamp rounding does not
create a false distinction between nearly equal Moving and Total values.

## Activity Summary

The time statistics at the top of the Individual activity page follow this
matrix:

| Available source | Summary display |
| --- | --- |
| Timer time and elapsed time | Moving time and Total time |
| Timer time only | Moving time |
| One elapsed/record-span value only | Duration |
| Zero or invalid duration | Existing zero/unavailable fallback |

When both semantic values are available, show both even if they are equal. This
keeps the summary labels stable across activities and makes the selected time
basis understandable. Formats without two semantic values do not show duplicate
Duration statistics.

The time statistics remain in the existing clock group and precede Distance.
Suggested help text:

- Moving time: `Recorded timer time, excluding recorded pauses.`
- Total time: `Elapsed time from start to finish, including pauses.`

No database migration is required. Values are resolved from the existing
activity fields and metadata.

## Individual Activity Header

Separate informational badges from visualisation controls.

Desktop layout:

```text
Activity title                         X-axis       [ Time | Distance ]
[Date] [Sport] [Device]                Time basis   [ Moving | Total ]
                                       Chart zoom   [ Reset ]
```

The left side contains activity identity:

- activity title;
- date badge;
- sport badge; and
- primary device and accessory popover.

The right side is a compact vertical control panel with three aligned rows:

1. X-axis: Time or Distance;
2. Time basis: Moving or Total; and
3. Chart zoom: Reset.

The two option controls reuse the current segmented-button appearance. The
labels use muted compact text and a consistent label-column width. Reset uses a
normal compact button aligned with the option groups.

On narrow screens, move the complete control panel below the title and badges.
Each label and its control must wrap as one unit.

### Accessibility

Each row is a separately named control group. Use `role="group"` with an
associated label or an equivalent fieldset/legend structure. Selected segmented
buttons expose `aria-pressed`. Disabled controls explain their unavailability in
their title or accessible description.

### Availability

- Disable Time when records do not span a positive timestamp range.
- Disable Distance when no usable positive distance data exists.
- Disable Reset when synchronized chart zoom is already at its full extent.
- If neither Time nor Distance provides a meaningful range, disable the entire
  X-axis group.

Time-basis presentation follows the resolved source capability:

| Timeline capability | Time-basis control |
| --- | --- |
| Reliable, distinct Moving and Total timelines | `[ Moving | Total ]`, defaulting to Moving |
| Reliable but equal Moving and Total timelines | Moving selected; Total disabled as equivalent |
| Separate timer and elapsed totals but unreliable pause locations | Total selected; Moving disabled because it cannot be mapped safely |
| One undifferentiated elapsed/record-span timeline | A single inactive Duration value rather than misleading Moving/Total options |
| No positive time range | Entire Time-basis group disabled |

The Time basis remains enabled while Distance is selected because it still
controls map playback whenever selectable Moving and Total timelines exist.
Distance charts ignore the selected time basis.

## Shared State and Immediate Application

Store `ActivityTimeBasis` in `Dashboard`, alongside the existing chart X-axis
and synchronized zoom state. Pass it to `ActivityMap` and `ActivityInsights`.

The initial basis is Moving whenever reliable, distinct Moving and Total
timelines exist. The selection may remain in page/session state as the user
changes activities, but each activity resolves it against its own capability.
An activity with only raw elapsed timestamps uses Total internally; an activity
with only one undifferentiated timeline presents Duration rather than falsely
labelling that timeline Moving.

Changing the basis applies immediately:

- map playback and counters update;
- time-based charts rebuild their coordinates and series;
- lap markers and tooltips use the new basis; and
- synchronized chart zoom resets to its full range.

When possible, switching basis preserves the current source timestamp so the
map marker does not move. If the source timestamp is inside a pause and the user
switches to Moving, snap to the resume boundary because that interval does not
exist on the Moving timeline.

The setting is a view preference, like the current chart axis state. It is not
added to the Settings panel or backend settings table in the first slice.

## Map Playback

### Time-based playhead

Replace the GPS-record-index playback model with a time-based playhead. Keep a
source timestamp or selected-basis elapsed value as the authoritative position.
Derive the GPS record index from that time for route drawing and telemetry.

The slider uses:

- a minimum of zero;
- a maximum equal to the selected basis duration; and
- a value equal to the continuously advancing selected-basis playhead.

Slider fill must be based on elapsed time rather than GPS record index. This
allows it to advance through included pauses.

The displayed current time is derived from the playhead itself, not the selected
GPS record timestamp. Update rendered state when the displayed whole second
changes rather than forcing a React render on every animation frame.

### Moving basis

In Moving mode:

- the playhead advances over active timer time;
- stopped intervals are absent from the timeline;
- crossing a pause boundary maps immediately to the resume timestamp;
- the total counter equals Moving time; and
- the slider has no range corresponding to a pause.

The route and marker continue from the last active point to the next active
point without waiting for the removed wall-clock interval.

### Total basis

In Total mode:

- the playhead advances over elapsed wall-clock time;
- the total counter equals Total time;
- the counter and slider continue advancing during pauses;
- the route endpoint and position marker hold at the pause location;
- stopped-period GPS drift is not appended to the visible route; and
- a compact Paused indicator is shown while the playhead is stopped.

At the resume boundary, route drawing and marker movement continue. Scrubbing to
a timestamp inside a pause displays the held position and Paused state.

Map telemetry remains at the last active map record during a pause in the first
implementation. Stopped-period telemetry remains available in Total-time charts.

### Follow mode

Follow keeps the camera centred on the held pause position. Bearing should not
react to stopped-period GPS drift. On resume, the existing prepared-route
direction and low-speed bearing stabilisation continue normally.

Changing the time basis must not reset Follow, Telemetry visibility, playback
speed, map style, or path-colour selection.

### Playback completion

Playback stops when the selected-basis playhead reaches its selected-basis
duration. The marker is placed at the final active route point and both counter
values match.

## Telemetry Charts

Extend telemetry point construction with the selected time basis.

### Time axis with Moving basis

This preserves current active-time behaviour:

- remove records within reliable stopped intervals;
- subtract prior stopped duration from each x-coordinate;
- end the axis at Moving time; and
- map lap markers to Moving elapsed time.

### Time axis with Total basis

- Use raw elapsed time from the activity start for x-coordinates.
- Include telemetry records captured during stopped intervals.
- End the axis at Total time.
- Map lap markers using raw elapsed time.
- Format tooltip headers using Total elapsed time while retaining absolute
  timestamp context.
- Mark paused telemetry context where useful in the tooltip.

Add subtle pause regions across eligible time-based charts. Pause shading should
remain legible in light and dark themes and must not overpower chart series.

If no telemetry samples exist during a pause, do not connect the point before
the pause directly to the point after it as though intermediate values were
observed. Add explicit null boundaries or split the affected series so ECharts
renders a gap. Smoothing must not average across pause boundaries.

### Distance axis

Distance charts ignore the selected time basis:

- retain active-record filtering;
- retain existing distance coordinates;
- exclude stopped-period telemetry that could distort distance-based series; and
- keep lap markers mapped by distance.

The Time basis control remains available because it continues to affect map
playback.

### Charts outside the shared telemetry timeline

Distribution bars, zone-time bars, and derived analytical charts do not change
their calculation basis merely because Total is selected. Any chart that opts
into the display timeline must do so explicitly rather than inheriting the
setting accidentally.

## Derived Metrics

The time-basis selection is presentational. It does not recalculate:

- cardiac decoupling or heart-rate drift;
- heart-rate time in zone;
- normalized power;
- activity summary averages and maxima;
- lap summary calculations; or
- overview totals.

Those features retain their existing source and active-time semantics.

## Data Availability and Fallbacks

### Reliable FIT intervals

When `metadata.timer.active_time_supported` and
`metadata.timer.intervals_reliable` are true and durations are positive, expose
both Moving and Total modes.

### Timer totals without reliable intervals

Summary statistics may show Moving and Total when both authoritative totals are
present, but selectable timeline switching remains unavailable. Totals alone do
not identify where pauses occurred.

Charts and map playback use raw elapsed timestamps. Total is selected and Moving
is disabled with an explanation that pause locations are unavailable.

### GPX and TCX

Continue showing Duration. Time charts use record timestamps, distance charts
use distance when available, and the Time-basis row presents a single inactive
Duration value rather than Moving/Total options.

### Older FIT imports

Activities imported before timer metadata was added may not support a separate
timeline until reimported. Do not attempt an automatic database backfill in this
feature. Existing source FIT files can be reimported through the normal workflow
when the user wants the additional capability.

### Zero time or missing chart ranges

A zero `duration_s` does not prove that a meaningful timeline exists. Use record
timestamp range and resolved positive durations for control availability. Keep
the existing summary fallback for zero-duration activities; a nullable duration
model is deferred.

## Localisation

Add and review strings in every supported language for:

- X-axis;
- Time basis;
- Moving;
- Total;
- Chart zoom;
- Reset;
- Moving time;
- Total time;
- Paused;
- unavailable Time, Distance, and Total explanations; and
- Moving and Total help text.

Existing local English values remain authoritative. New English copy uses
Canadian spelling and terminology consistent with the surrounding interface.

## Expected Implementation Areas

### Shared frontend logic

- Add `src/lib/activityTime.ts` for interval normalisation and time mapping.
- Refactor `src/lib/telemetryAxis.ts` to consume the shared helpers.
- Extend frontend timer metadata types where necessary.

### Individual activity page

- Add shared `ActivityTimeBasis` state in `src/components/Dashboard.tsx`.
- Move activity badges beside or below the activity title.
- Build the vertical visualisation-control panel.
- Rename/add time summary statistics according to source availability.
- Pass resolved time data and basis to map and chart components.

### Map

- Refactor `src/components/ActivityMap.tsx` to a time-based playhead and slider.
- Add Moving and Total timestamp mapping.
- Drive the displayed counter from playhead state.
- Add explicit pause holding and Paused indication.
- Preserve Follow and telemetry behaviour outside pause-specific changes.

### Charts

- Extend `src/components/ActivityInsights.tsx` with the selected time basis.
- Include paused telemetry in Total-time mode.
- Add pause regions and series gaps.
- Prevent smoothing across pause boundaries.
- Update lap markers, tooltip headers, and synchronized zoom reset behaviour.

### Styling and localisation

- Add responsive header/control-panel styles in `src/styles.css`.
- Add strings to all locale files in `src/i18n/`.

No backend schema or parser change is expected unless implementation
investigation identifies missing metadata fields in the serialized activity
model.

## Implementation Slices

### 1. Shared Time Resolution

- Introduce the `ActivityTimeBasis` and resolved-time types.
- Move interval normalisation and timestamp mappings into a shared module.
- Add source-precedence, reliability, clamping, and inverse-mapping tests.
- Keep existing Moving-time chart output unchanged.

### 2. Summary and Header Layout

- Resolve Moving, Total, or fallback Duration labels and values.
- Move date, sport, and device badges to the activity identity area.
- Add the three-row control panel.
- Implement availability and disabled states.
- Add responsive and accessibility behaviour.

### 3. Map Playback Timeline

- Replace index-based progress with selected-basis elapsed time.
- Fix the counter to use the continuous playhead.
- Implement Moving pause compression and Total pause holding.
- Add Paused status and immediate basis switching.
- Verify Follow behaviour at pause/resume boundaries.

### 4. Time-Based Charts

- Add basis-aware telemetry point construction.
- Include paused telemetry and raw elapsed coordinates in Total mode.
- Add pause regions and no-data gaps.
- Prevent smoothing across pauses.
- Update lap markers, tooltips, axis bounds, and zoom reset.
- Confirm Distance mode is unchanged.

### 5. Localisation and Integrated Validation

- Add and review every locale key.
- Run targeted time-axis and map-follow tests.
- Build and deploy from local `main` using the normal Docker workflow.
- Validate representative FIT, GPX, TCX, paused, unpaused, GPS, and non-GPS
  activities.

## Automated Validation

Add focused coverage for:

- overlapping and adjacent stopped-interval normalisation;
- invalid and unreliable interval fallback;
- source timestamp to Moving elapsed mapping;
- Moving elapsed to source timestamp inverse mapping;
- timestamps before, inside, and after a pause;
- Moving and Total duration resolution;
- equal Moving and Total durations;
- zero-duration and one-record activities;
- map counter advancement during a Total-time pause;
- map pause removal in Moving mode;
- slider scrubbing into and across pauses;
- switching basis before, during, and after a pause;
- route and Follow hold behaviour during a pause;
- Moving-time chart coordinates matching current output;
- Total-time chart coordinates retaining elapsed gaps;
- paused telemetry inclusion in Total mode;
- chart line breaks when a pause contains no data;
- smoothing isolation across pause boundaries;
- lap-marker mapping in both time bases;
- Distance mode remaining independent of time basis; and
- disabled control states for unavailable Time, Distance, Total, and Reset.

Do not commit private FIT files or real GPS coordinates. Regression fixtures use
synthetic timestamps, timer events, telemetry values, and anonymized route
geometry.

## Manual Validation

Use representative local activities to verify:

1. An activity with many Auto Pause events:
   - Moving playback skips pauses;
   - Total playback holds position while its counter continues;
   - Total charts show pause context; and
   - summary times match source values.
2. An activity with one long manual pause.
3. An activity with no pauses, where both totals are equal.
4. A FIT activity with timer totals but unreliable event intervals.
5. An older FIT import without timer metadata.
6. GPX and TCX activities with time and optional distance.
7. A non-GPS activity with timer metadata.
8. A zero-duration or one-record edge case.
9. Light and dark themes.
10. Narrow and wide layouts.
11. Playback at 1x, 8x, 16x, and 32x.
12. Follow mode across pause and resume boundaries.

## Acceptance Criteria

- The activity header clearly separates metadata from interactive controls.
- X-axis, Time basis, and Chart zoom controls are vertically aligned and
  accessible.
- Moving time and Total time appear in the summary when their semantic sources
  are available.
- Formats with only one time value retain the Duration label.
- Moving is the default when reliable, distinct Moving and Total timelines are
  available; elapsed-only fallbacks are never labelled Moving.
- Map playback uses a time-based slider and continuously rendered counter.
- Moving playback removes reliable stopped intervals.
- Total playback includes pause duration, holds the marker, advances the
  counter, and shows Paused state.
- Time-based charts use the selected basis.
- Total-time charts include recorded stopped-period telemetry and clearly show
  pause gaps.
- Distance charts are unchanged by the time basis.
- Derived analysis does not change when the display basis changes.
- Unavailable controls are disabled with an explanation.
- No private activity file or real route geometry is committed.
- Targeted tests and the integrated Docker build pass on local `main`.

## Deferred Work

- Persistent time-basis preference across browser restarts.
- A backend-normalised first-class duration model.
- Nullable duration and fully untimed activity support.
- Moving-time inference for GPX or TCX.
- Overview and activity-table Moving/Total columns.
- Pause-duration summary statistics.
- Exporting per-record Moving elapsed time.
- Editing timer intervals or correcting device timer events.
