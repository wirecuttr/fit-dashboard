# Map and Telemetry Chart Synchronisation

## Status

- Status: design reviewed; implementation investigation complete
- Working branch: `feat/map-chart-sync`
- Branch base: local `main` at `42308a0`
- Intended destination: local/private `main`
- Upstream pull request: not planned as part of this feature
- Implementation: not started

This document combines the product design and implementation plan for linking
GPS route playback with the Individual page's time- and distance-based
telemetry charts.

## Summary

Add a `Sync` checkbox beside the existing Time/Distance, Moving/Total, Reset
Charts, and help controls. It is off by default and applies immediately.

When Sync is on:

- map playback moves an exact vertical cursor through every eligible telemetry
  chart;
- each chart displays its normal tooltip when ECharts' nearest axis row contains
  a finite metric value and is sufficiently close to the playhead;
- scrubbing the map timeline updates every eligible chart;
- clicking anywhere inside an eligible chart's plot area stops playback, seeks
  the map, and updates all other eligible charts; and
- changing Time/Distance or Moving/Total reprojects the same activity moment
  instead of choosing a new moment.

The shared value is the source timeline timestamp, not a chart pixel, record
index, moving-time value, or distance. This is the only value that can map
reliably between GPS playback, both time bases, distance axes, charts with
different data coverage, and recorded pauses.

The feature is frontend-only. It does not change imported activity data, FIT
parsing, chart calculations, or stored preferences.

## Goals

- Make map playback position visible on the telemetry charts.
- Show the chart's existing axis tooltip at the synchronised position whenever
  ECharts' nearest axis row has a finite metric value and is sufficiently close.
- Give map scrubbing and chart clicking the same seek behaviour.
- Support both Time and Distance chart axes.
- Support both Moving and Total time, including continuously advancing through
  recorded pauses in Total mode.
- Keep the cursor exact while allowing the normal tooltip to describe the
  accepted nearest axis row.
- Avoid full React and ECharts option re-renders at playback-frame frequency.
- Preserve chart zoom, smoothing, lap markers, route colouring, Follow mode,
  playback speed, and telemetry overlays.
- Use the existing compact control and help-popover patterns.
- Apply user-facing strings consistently in every supported language.

## Non-Goals

- Persisting Sync in browser storage or DuckDB.
- Synchronising Overview-page charts or the Overview location map.
- Seeking by hovering over a chart; chart seeking is click or tap based.
- Automatically changing chart zoom to keep the cursor visible.
- Recalculating chart data at the synchronised position.
- Adding a cursor to zone-time bars, histograms, scatterplots, or other charts
  without a one-dimensional activity-position axis.
- Changing the map's current discrete telemetry-record selection or Follow
  camera interpolation.
- Changing the 10-second display-record resolution or requesting extra backend
  data solely for synchronisation.

## User Experience

### Control

Add a compact labelled checkbox to the existing activity-detail control row:

```text
[ Time | Distance ] [ Moving | Total ] [ ] Sync [ Reset Charts ] [?]
```

The checkbox should use the same compact checkbox language as the activity
map's Follow and Telemetry controls, adjusted to the existing 29-pixel detail
control height.

Sync:

- is unchecked by default;
- applies immediately when checked or unchecked;
- is session-only and is not saved;
- remains selected while the user changes activities during the same session;
- is disabled when the selected activity has no usable GPS route, no positive
  activity timeline, or no eligible telemetry chart; and
- does not change Time/Distance, Moving/Total, or chart zoom when toggled.

When Sync is enabled, immediately publish the map's current playhead. A newly
selected activity initialises the playhead using the map's existing end-of-route
behaviour and then publishes that new activity timestamp. Never carry the prior
activity's timestamp into the new activity. During controller replacement, a
checked Sync control may be temporarily disabled at a zero registered-chart
count; the first eligible chart registration re-enables it without another user
action.

Turning Sync off must remove all programmatic cursors and tooltips and restore
the charts' ordinary hover tooltip behaviour.

Add a fourth entry to the existing help popover:

- heading: `Sync`
- help: `Links map playback and telemetry charts. Click a chart or scrub the map timeline to move all synchronised views.`

Add `detail.syncUnavailable` with this English copy:

`Sync requires a GPS route, a usable activity timeline, and a telemetry chart.`

Expose this explanation through the control's title or adjacent accessible
description and repeat it in the focusable help popover, because a native
disabled checkbox is not keyboard-focusable. Use Canadian spelling in the
English source and translate the label, help, unavailable explanation, and
accessibility text in all 14 locale files.

Programmatic playback tooltips are visual context and must not be `aria-live`;
announcing updates 10-15 times per second would be unusable. Keyboard chart
seeking is deferred. The native map range remains the keyboard-accessible seek
path while Sync is on.

### Map Playback and Scrubbing

While Sync is on:

- Play publishes the current source timestamp as playback advances.
- Pressing the playback Pause button leaves every synchronised cursor and
  tooltip at the current moment.
- Dragging the map range control stops playback and seeks the map locally on
  every input. Controller publication is coalesced to 10-15 Hz with a trailing
  update; pointer-up, keyboard completion, and exact endpoints flush
  immediately.
- Reaching the start or end publishes the exact endpoint.
- The map's position, time counter, route reveal, Follow camera, and Timeline
  Telemetry continue to use their existing behaviour.

While Sync is off, playback must not perform synchronisation work beyond its
existing map updates.

### Chart Cursor and Tooltip

Every eligible chart shows one vertical cursor at the exact x-axis projection
of the shared source timestamp.

ECharts selects the nearest x-axis row, which can contain a null metric value
because the current series deliberately preserve gaps. Show the chart's normal
axis tooltip only when that ECharts-nearest row contains at least one finite
series value and passes the proximity rule. This retains the chart's existing
formatting, units, series rows, absolute time, relative time, and distance
context without searching forward to a different, more convenient row.

The cursor and tooltip do not need to use the same x value: the cursor represents
the exact playhead, while the tooltip describes an accepted real sample. For
each chart, calculate the median positive source-timestamp gap between valid
axis rows. Accept the nearest row when its timestamp delta is no more than
`clamp(1.5 times the median gap, 15 seconds, 60 seconds)`. With fewer than two valid
rows, use a 15-second acceptance window.

Inside a known stopped interval, accept only a sample from that same stopped
interval. If the nearest row is null, outside the acceptance window, or across a
pause boundary, retain the exact cursor and hide the tooltip. Keep
`tooltip.alwaysShowContent` false or omitted so `hideTip` can remove rejected
content.

While Sync is on, ordinary pointer hover does not take ownership of the cursor.
Clicking or tapping changes the shared position. Turning Sync off restores the
current hover and click tooltip triggers.

If the synchronised x value is outside the chart's current data-zoom window,
hide that chart's cursor and tooltip. Do not pan, expand, or reset the user's
zoom. Reset Charts restores the full range, at which point the current cursor
can be shown again.

### Chart Click or Tap

A click or tap anywhere inside an eligible chart's plot grid:

1. converts the pointer pixel to that chart's x-axis value;
2. maps the x value to a source timestamp;
3. stops map playback, matching map-slider scrubbing;
4. seeks the map to the timestamp; and
5. updates the cursor and tooltip on every eligible chart.

Clicks on chart headings, legends, axis labels, help content, controls, and
outside the plot grid do nothing. Ctrl/Cmd-wheel zoom and ordinary scrolling
retain their current behaviour.

### Time and Distance Axes

For a Time x-axis:

- Moving maps the clicked basis-elapsed value through the reliable stopped
  intervals to a source timestamp; and
- Total maps the clicked elapsed value directly from the activity timeline
  start.

For a Distance x-axis:

- map-to-chart projection interpolates distance around the shared source
  timestamp using the ordered telemetry points;
- chart-to-map projection interpolates timestamp around the selected cumulative
  distance;
- stopped intervals remain excluded, matching the existing Distance chart
  semantics; and
- a repeated-distance plateau resolves to the point closest to the current
  canonical timestamp when one exists, or to the earliest matching active point
  when no current position exists.

Distance values are expected to be cumulative but imported data can be flat,
missing, or slightly non-monotonic. Mapping helpers must clamp to the available
range and ignore non-finite values. Use binary interpolation only for
non-decreasing finite distance data; fall back to a linear nearest-point search
for non-monotonic input. Never search the geographic route.

Changing Time/Distance reprojects the current source timestamp. It does not
seek the map.

### Moving and Total Time

The source timestamp remains canonical when the user changes Moving/Total.
Both the map and charts reproject that same timestamp into the newly selected
basis.

In Moving mode, recorded stopped intervals are compressed out of the chart and
playback timelines.

In Total mode, the source timestamp and chart cursor continue advancing through
a recorded pause while the map marker and Follow camera remain at the pause
location. If telemetry samples exist during the pause, the ordinary tooltip can
show them. If no sufficiently close sample exists, keep the cursor moving and
hide the tooltip rather than displaying stale values.

### Eligible Charts

The first implementation includes all ECharts line charts with a defined
activity-position x-axis:

- Pace or Speed;
- Heart Rate;
- Cadence;
- Elevation;
- Power;
- Stamina;
- Performance Condition;
- Respiration Rate;
- Temperature; and
- Heart Rate Drift.

The regular telemetry charts use the selected Time/Distance axis and
Moving/Total basis. Heart Rate Drift remains a source-elapsed/Total-time chart
regardless of the selected controls and does not change to a Distance axis. Add
`timelineStartMs`, derived from the first sorted cardiac-analysis record, to
`HeartRateDriftChartData`; map both directions with
`sourceTimestampMs = timelineStartMs + elapsedMs`, and use the same origin for
its absolute-time tooltip header.

The following are excluded because a horizontal position does not represent a
unique activity moment:

- metric-vs-metric scatterplots;
- Heart Rate and Power zone-time bars;
- histograms and distribution charts; and
- non-ECharts summaries and badges.

## Canonical Synchronisation Model

Introduce a small frontend-only controller, for example
`src/lib/activitySync.ts`:

```ts
export type ActivitySyncOrigin = "map" | "chart";

export type ActivitySyncPosition = {
  activityId: number;
  sourceTimestampMs: number;
  origin: ActivitySyncOrigin;
};

export type ActivitySyncController = {
  publish(position: ActivitySyncPosition, options?: { immediate?: boolean }): void;
  getCurrent(): ActivitySyncPosition | null;
  subscribe(listener: (position: ActivitySyncPosition | null) => void): () => void;
  registerChart(chartKey: string): () => void;
  getRegisteredChartCount(): number;
  subscribeRegisteredChartCount(listener: (count: number) => void): () => void;
  clear(): void;
  dispose(): void;
};
```

The exact API can vary, but it must provide these properties:

- each controller is created for one activity ID and rejects mismatched events;
- listeners update imperatively without putting every playback tick in React
  component state;
- a chart-origin update is delivered even when its timestamp equals the current
  position, because the map must still stop playback;
- feedback prevention lives in origin-aware subscribers or local publication
  suppression, not timestamp-only event deduplication;
- normal playback and continuous map-slider publication are coalesced to 10-15
  updates per second with a trailing update;
- chart clicks, Sync activation, exact playback endpoints, and map-slider
  pointer-up or keyboard completion publish immediately;
- charts register and unregister themselves without exposing chart types or
  mappings to the controller;
- chart-count subscribers are notified only when registration changes, not on
  playback updates;
- `clear()` notifies registered views with `null` so they hide stale UI; and
- `dispose()` cancels pending throttled work before listeners are released.

Registration stores only opaque stable instance keys and a distinct mounted
count; it never stores ECharts instances or mapping adapters. The unregister
function must be idempotent. `clear()` clears the position without changing
registration, while `dispose()` cancels pending work, notifies count subscribers
of zero, and releases both listener sets.

The `telemetrySyncEnabled` checkbox remains ordinary Dashboard React state. Do
not call it `isSyncing`, because Dashboard already uses that name for import
synchronisation state.

Create an activity-scoped controller for `selectedActivity.id`. On activity
change, dispose the old controller before creating the next one so a trailing
old playback event cannot race into the new activity. The
`telemetrySyncEnabled` checkbox remains stable across that controller change.

## Mapping Helpers

Add pure helpers, either to `src/lib/activitySync.ts` or a focused
`src/lib/telemetrySync.ts` module:

- project a source timestamp to the selected Time x value;
- project a source timestamp to an interpolated Distance x value;
- map a Time x value to a source timestamp through
  `sourceTimestampAtBasisElapsed`;
- map a Distance x value to a source timestamp;
- clamp timestamps and x values to the activity/chart extent;
- locate ECharts' nearest axis row and verify that it contains a finite metric;
- apply the defined median-cadence and stopped-interval tooltip rules; and
- project Heart Rate Drift source-elapsed values.

Reuse `basisElapsedMsAtTimestamp`, `sourceTimestampAtBasisElapsed`, and the
resolved stopped intervals from `src/lib/activityTime.ts`. Do not reproduce
pause arithmetic in map or chart components.

Use ordered telemetry points for chart projection. Do not use spatial nearest
GPS matching: nearby switchback legs can represent very different times.

## Component Design

### Dashboard

`src/components/Dashboard.tsx` should:

- own `telemetrySyncEnabled`;
- create one controller per selected activity ID;
- dispose the old controller, including pending trailing work, when the selected
  activity changes;
- render the Sync checkbox and help entry;
- subscribe to the controller's registered-chart count;
- determine control availability from `hasDetailRoute`, a positive time range,
  and `controller.getRegisteredChartCount() > 0`; and
- pass the controller, enabled state, and selected activity ID to ActivityMap
  and ActivityInsights.

Do not store the current playback timestamp in Dashboard React state. Doing so
would re-render the complete Individual page and recreate all ECharts options
through `notMerge` during playback.

### ActivityMap

`src/components/ActivityMap.tsx` should:

- publish the source timestamp already calculated by `updatePlayhead`;
- coalesce playback and continuous slider publications while preserving local
  map updates on every input;
- flush slider completion and exact endpoints immediately;
- subscribe to chart-origin controller updates while Sync is enabled;
- convert a received source timestamp with `basisElapsedMsAtTimestamp` and seek
  through the existing `updatePlayhead` path;
- stop playback on every chart-origin seek, including the current timestamp;
- avoid republishing subscriber-driven seeks;
- move the Follow camera immediately after a chart-origin seek when Follow is
  enabled; and
- publish an immediate current position when Sync is enabled or the new
  activity controller is attached.

Keep the existing distinction between the advancing source timestamp and the
pause-held marker timestamp. The canonical sync value is the former.

Playback can continue updating its own map state at its existing frame rate.
Only controller publication is throttled. Time/Distance and Moving/Total option
changes should reproject `controller.getCurrent()` after the option update; they
do not publish a synthetic control-origin event.

### ActivityInsights and ECharts

Create a small synchronised-chart wrapper or hook rather than duplicating
instance lifecycle code for every chart. It should:

- compose the current `enableChartWheelPageScroll` ready callback;
- retain the ECharts instance without putting it in render state;
- register an opaque chart key on mount and unregister it on unmount;
- register and unregister a controller position subscription;
- attach and remove one ZRender click handler;
- verify clicks with `containPixel({ gridIndex: 0 }, point)`;
- convert clicks through `convertFromPixel`;
- project source timestamps to x-axis values;
- convert projected x values back to pixels with `convertToPixel`;
- update the ECharts axis pointer and normal tooltip using public
  `dispatchAction` APIs;
- hide the tooltip but preserve the cursor across a known no-data gap;
- reapply `controller.getCurrent()` after every option or mapping change because
  `notMerge` can erase an imperative pointer while playback is paused;
- hide both when disabled, unmounted, outside zoom, or on activity change;
- on disable, dispatch `updateAxisPointer` with `currTrigger: "leave"`, then
  dispatch `hideTip`;
- on unmount or instance replacement, call
  `getZr().off("click", handler)`, unsubscribe, and guard `chart.isDisposed()`;
  and
- clean up listeners even when chart availability or ordering changes.

The controller must not contain a chart-ID switch, metric list, ECharts option,
or axis-mapping rule. Each wrapper receives its own timestamp-to-x and
x-to-timestamp adapter. Consequently, adding, removing, reordering, or
conditionally hiding a chart automatically changes the registered count and
requires no Dashboard or controller edit. A newly registered chart immediately
applies `controller.getCurrent()` when Sync is already active.

The installed ECharts 6.1 implementation supports the required public APIs.
For an exact cursor plus a nearest-sample tooltip:

- set `xAxis.axisPointer.snap` to `false` on eligible charts;
- dispatch `updateAxisPointer` using an in-grid pixel x/y point so ECharts can
  position both the pointer and tooltip;
- let the normal axis tooltip select the nearest series sample; and
- dispatch `hideTip` after the pointer update when the proximity rule rejects
  that sample.

The `snap: false` setting belongs on the x-axis axis-pointer model, not only on
`tooltip.axisPointer`; ECharts' value-axis model can otherwise replace the
tooltip-level value while collecting series axes.

When Sync is enabled, set `tooltip.triggerOn` to `"none"` so mousemove does not
displace the synchronised cursor. When Sync is disabled,
omit or reset `triggerOn` so ECharts restores its existing default behaviour
rather than hardcoding a replacement. The current wheel pass-through helper is
idempotent but has no cleanup API; the new wrapper composes it but does not claim
to remove that pre-existing listener.

Direct `echarts.connect` is not suitable. The charts can have different Time,
Distance, and Heart Rate Drift axes, and ECharts cannot seek the map or apply
the app's pause semantics by itself.

## Implementation Investigation

The current code provides most of the required data but not a shared playhead:

- Dashboard owns Time/Distance, Moving/Total, and shared chart zoom state and
  already renders the intended control row.
- `ActivityMap.updatePlayhead` already calculates the exact source timestamp,
  the pause-held marker timestamp, the timeline record index, and the displayed
  elapsed second.
- ActivityMap playback runs through `requestAnimationFrame`; Follow camera
  updates are separately capped at 30 frames per second.
- Map route records are display-downsampled, filtered to exclude reliable
  stopped intervals, and capped at 6,000 points. Chart sync must therefore use
  timestamps rather than assuming chart and map indexes match.
- The default frontend activity records are downsampled to 10-second buckets.
  `analysisRecords` use one-second buckets but are not the common display-chart
  source.
- Standard telemetry series rows already retain x, metric value, basis-relative
  time, source timestamp, and distance as
  `[x, value, relMs, timestampMs, distanceMeters]`.
- Heart Rate Drift is the exception: its rows use elapsed milliseconds but its
  returned chart data does not expose the origin. Add `timelineStartMs` from the
  first sorted cardiac-analysis record and use it for both sync mapping and the
  tooltip's absolute-time header.
- Every eligible chart currently uses a value x-axis and an axis-triggered
  tooltip, so the existing formatter can be retained.
- ECharts `showTip`, `hideTip`, `updateAxisPointer`, `convertFromPixel`,
  `convertToPixel`, and `containPixel` are present in the installed versions.
- `ReactECharts` currently receives `notMerge`, making React state updates at
  playback frequency unnecessarily expensive.
- `onChartReady` currently installs only wheel pass-through behaviour. The sync
  work needs a composed ready callback and explicit ZRender/controller cleanup.
- Visible chart arrays already change with activity data. Wrapper-owned
  registration lets that existing conditional rendering determine Sync
  availability without duplicating the metric list in Dashboard.
- Scatterplot points happen to retain timestamps, but the plot axes do not
  represent activity position. They are deliberately excluded from the first
  interaction model rather than providing inconsistent point-only seeking.

No backend, database, Rust, Tauri, or FIT parser change is required.

## Implementation Slices

### Slice 1: Pure Controller and Projection Helpers

- Add the activity-scoped imperative sync controller with an injectable clock
  or scheduler for deterministic throttle tests.
- Add timestamp-to-Time, timestamp-to-Distance, Time-to-timestamp, and
  Distance-to-timestamp helpers.
- Add finite-row, median-cadence, and stopped-interval tooltip rules.
- Add focused TypeScript regression tests and an npm test command.

### Slice 2: Control and Shared Wiring

- Add Dashboard state, availability, control, and help content.
- Drive Sync availability from the controller's registered-chart count rather
  than a hardcoded metric list.
- Add translations to every locale.
- Pass the controller and activity context to map and insights components.
- Dispose old activity controllers and disable cleanly when no route is
  available.

### Slice 3: Map Publication and Seeking

- Coalesce playback and continuous slider publication to 10-15 Hz with a
  trailing update while keeping local map seeks immediate.
- Flush Sync activation, slider completion, and exact endpoints immediately.
- Subscribe to chart seeks, stop playback even for a same-timestamp click,
  update the playhead, and refresh the Follow camera without a feedback loop.
- Reproject the controller's current timestamp after axis or basis changes
  without publishing a synthetic event.

### Slice 4: Chart Cursors, Tooltips, and Clicks

- Add the reusable synchronised ECharts wrapper/hook.
- Add exact axis pointers and programmatic normal tooltips to all eligible
  standard telemetry charts.
- Add the Heart Rate Drift `timelineStartMs` metadata, mapping adapter, and
  corrected absolute-time tooltip origin.
- Add plot-area click/tap seeking and cleanup.
- Preserve zoom and hide out-of-window cursors without changing zoom.

### Slice 5: Integrated Validation and Tuning

- Merge the committed feature branch into local `main` before testing, per the
  repository workflow.
- Run the focused frontend synchronisation tests on local `main`.
- Rebuild and deploy the local Docker application from `main`.
- Validate representative FIT activities with pauses, missing metrics,
  distance axes, low-speed GPS playback, Follow mode, and long durations.
- Measure playback with every eligible chart visible and tune the publication
  cap within the proposed 10-15 Hz range if needed.

No Rust test is expected because this feature does not change Rust code.

## Automated Validation

Add pure tests covering:

- Moving and Total timestamp projection with reliable stopped intervals;
- a Total-time timestamp inside a pause;
- start/end clamping and zero-duration input;
- Time-axis click-to-timestamp round trips;
- Distance interpolation in both directions;
- kilometre/mile distance interpolation, plateaus, missing values, small
  regressions, and unusable distance;
- chart and map points with different sampling intervals;
- Heart Rate Drift elapsed-time projection and tooltip origin;
- stale activity IDs being rejected;
- pending trailing work being cancelled on activity change and controller
  disposal;
- subscriber updates not republishing recursively;
- chart registration count changes, unregistration, and duplicate-cleanup
  behaviour without position-event notifications;
- a same-timestamp chart click still stopping playback;
- throttled playback and slider input plus immediate completion/endpoints;
- finite and null axis-row tooltip acceptance, median-cadence limits, and known
  pause-gap rejection.

Keep controller and projection tests independent from MapLibre, ECharts canvas,
and the backend so they run quickly in Node. Use the injected clock or scheduler
rather than real delays; the current Node harness has no fake-timer framework.
A focused wrapper-level test should cover the public cursor-hide actions,
ordinary tooltip trigger restoration, and pointer reapplication after a
`notMerge` option update or Reset Charts. If the current harness cannot exercise
an ECharts canvas reliably, retain these as explicit integrated manual checks.

## Manual Validation

Validate at least the following on integrated local `main`:

- Sync off leaves current map and chart behaviour unchanged.
- Enabling Sync at the route end shows aligned cursors and normal tooltips.
- 1x and 32x playback remain smooth without tooltip/cursor lag building up.
- Dragging the map slider stops playback and updates every eligible chart.
- Clicking near the start, middle, and end of each eligible chart seeks the map
  and all other charts.
- The click works in both Time and Distance modes and at partial chart zoom.
- A click outside the plot grid does not seek.
- Reset Charts changes only zoom, restores an out-of-window cursor, and
  reapplies it after the `notMerge` option update.
- Switching Time/Distance or Moving/Total preserves the same source moment and
  reapplies the cursor without publishing a new position.
- In a Total-time pause, the counter and cursor advance while the map position
  holds; a missing sample does not produce a stale tooltip.
- Follow moves immediately to chart-origin seeks and remains enabled.
- Manual map interaction retains the existing Follow-off behaviour.
- Changing activity clears the old position and publishes the new route's
  current position.
- An activity without GPS disables Sync and retains normal chart interaction.
- Toggling Sync off removes programmatic UI and restores ordinary hover
  tooltips.
- The disabled explanation is available from the focusable help control, the
  map range remains keyboard-seekable, and playback tooltips are not announced
  as live updates.
- Narrow layouts wrap the new checkbox without overlap or excessive height.
- Light and dark themes keep cursor and tooltip contrast readable.
- Every locale renders a label and help entry without raw translation keys.

## Risks and Mitigations

### Playback Performance

Dispatching an ECharts update to every chart on every animation frame could be
expensive. Keep map rendering independent and coalesce synchronisation updates
to approximately 10-15 Hz. Direct instance actions avoid rebuilding options or
re-rendering ActivityInsights.

### Cursor and Tooltip Disagreement

The exact playhead can fall between downsampled records. Preserve that truth by
keeping the cursor exact and using the normal tooltip only for an accepted
nearby sample. Do not snap the map playhead to chart data.

### Pauses and Data Gaps

Total time can advance where no record exists. Keep the cursor moving, hold the
map marker through the existing pause logic, and hide an unrepresentative
tooltip. Known stopped intervals are stronger evidence than a generic gap
threshold.

### Feedback Loops

A chart-origin event seeks the map, which could otherwise publish back into the
controller. Carry an origin or a local suppression flag and make subscriber
updates one-way.

### Stale Controllers and Chart Instances

Activity changes can leave a pending trailing playback publication. Dispose the
old activity-scoped controller and cancel that work before attaching the new
one. Chart availability and ordering also change with activity data, so a
wrapper or hook must unregister its controller and ZRender listeners on unmount
and before replacing an instance.

### Distance Ambiguity

Repeated or slightly decreasing distance values can correspond to more than one
timestamp. Use binary interpolation only for non-decreasing finite data. On a
plateau, prefer the point closest to the current canonical timestamp or the
earliest point when no current position exists; use a linear nearest search for
non-monotonic input. Never infer time from geographic proximity.

## Acceptance Criteria

- A visible, unchecked-by-default Sync checkbox appears beside the current
  activity chart controls and is explained in the help popover.
- With Sync enabled, map playback and scrubbing show an exact vertical cursor
  on every eligible visible chart.
- Eligible charts display their existing normal tooltip only when ECharts'
  nearest axis row contains a finite value and passes the defined proximity and
  stopped-interval rules.
- Clicking or tapping an eligible chart plot seeks the map and all other
  eligible charts to the same source activity timestamp and stops playback.
- Time/Distance, Moving/Total, zoom, pauses, and activity changes behave as
  specified without stale cross-activity state.
- Scatterplots, zone bars, and other non-position charts remain unchanged.
- Sync off restores existing chart hover behaviour and adds no playback work.
- Playback remains responsive with all eligible charts visible.
- Adding or removing a synchronised chart requires only its local adapter and
  wrapper usage; Dashboard and controller logic remain unchanged.
- All new pure tests pass, the frontend builds, and the integrated Docker app
  starts successfully on local `main`.
