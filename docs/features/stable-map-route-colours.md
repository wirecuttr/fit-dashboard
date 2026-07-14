# Stable Map Route Colours Design and Implementation

## Status

Implemented on the `fix/stable-map-route-colours` branch.

## Purpose

Map route colours must remain stable while GPS playback reveals the route, and
the visible route must remain continuous at overview zoom and through tight
turns.

The original stability correction calculated colours against the complete
activity, but it also rendered every GPS segment as an independent two-point
feature. On long activities, many of those features are shorter than one screen
pixel. MapLibre can leave visible seams between those independent strokes,
especially at switchbacks and overlapping route sections. The dark route
outline then shows through as grey or black gaps. Because Solid used the same
segmented visible geometry, the defect appeared in every colour mode.

## Goals

- Keep route colours fixed to the full-activity scale during playback.
- Render the visible route as one continuous stroke without segment seams.
- Preserve discrete per-segment colours, including the neutral missing-data
  colour.
- Preserve playback reveal, route outline, markers, lap markers, and hover
  telemetry.
- Keep Solid as one constant route colour.

## Non-goals

- Change the colour palette, scaling rules, or missing-data policy.
- Change playback timing or route sampling.
- Change the route outline's width, opacity, or blur.
- Add new controls or user-facing strings.

## Rendering Design

The visible and interactive routes have different geometry requirements and
therefore use separate sources:

| Source | Geometry | Consumers | Purpose |
| --- | --- | --- | --- |
| Display route | One continuous `LineString` | Coloured route and outline | Seam-free visual rendering |
| Hit-test route | One two-point feature per GPS segment | Invisible wide hit layer | Segment-specific tooltip data |
| Marker sources | Points | Start/end and lap layers | Existing route annotations |

The display GeoJSON source enables MapLibre `lineMetrics`. Its coloured layer
uses a stepped `line-gradient` based on `line-progress`. The outline uses the
same continuous source, so both visible strokes follow identical geometry.

The segmented source retains speed, heart rate, elevation, cadence, power,
temperature, and elapsed-time properties. It is no longer used by a visible
layer.

## Colour and Playback Stability

Metric colours are calculated once against all sampled GPS records. Playback
does not replace or shorten the display source: it remains the complete route
for the activity.

For each redraw:

1. Calculate cumulative Web Mercator distance along the complete route, using
   the same projection as MapLibre's GeoJSON tiler.
2. Assign each non-zero-length segment its previously calculated full-activity
   colour.
3. Normalize each segment boundary by the complete route distance.
4. Build a stepped `line-gradient` from those fixed boundaries.
5. Add a transparent stop at the current full-route playback progress to hide
   the unrevealed tail.
6. Apply the same cutoff to the outline while the hit-test route, markers, and
   lap markers continue to use the revealed prefix.

MapLibre's `line-progress` is distance-based, so distance-normalized stops keep
colour changes aligned with their geographic segments. Because both the source
geometry and the gradient domain remain fixed, previously revealed colours and
their stop positions do not move while the user scrubs or plays the route.

Adjacent segments with the same colour share one gradient interval. Duplicate
coordinates do not introduce zero-length stops. If all segments have the same
colour and the route is fully revealed, including Solid mode, the gradient
collapses to a constant colour.

## Missing Data

The existing neutral colour remains the only indication of missing data.
Missing values do not participate in the metric scale. This correction does not
infer or interpolate missing telemetry.

A grey section in Solid mode is therefore always a rendering regression, since
Solid does not inspect telemetry values.

## Implementation

- `src/lib/mapRouteColor.ts`
  - retains full-activity metric scaling;
  - builds the single-feature display GeoJSON;
  - calculates full-route, Web Mercator distance-normalized stepped gradients;
  - adds a transparent playback cutoff without changing earlier stops.
- `src/components/ActivityMap.tsx`
  - enables `lineMetrics` on the display source;
  - keeps the complete display geometry fixed while scrubbing;
  - reveals the coloured route and outline through matching gradient cutoffs;
  - retains revealed-prefix segmented geometry exclusively for hit-testing.
- `scripts/test-map-route-color.ts`
  - verifies stable full-activity colour calculation;
  - verifies one complete continuous display feature;
  - verifies MapLibre-compatible distance stops;
  - verifies stable full-domain playback colours and cutoff positions;
  - verifies a matching outline cutoff;
  - verifies constant-colour Solid rendering.

## Validation

Automated focused tests must pass with:

```sh
npm run test:map-route-color
```

Manual or browser rendering validation should cover:

- Solid and every metric colour mode;
- a long route viewed at full-route zoom;
- tight switchbacks and retraced sections;
- playback at the beginning, middle, and end;
- missing metric samples;
- route hover telemetry after the visual source separation.

## Acceptance Criteria

- Solid has no grey or black gaps within its red route stroke.
- Metric modes have no outline-coloured seams between GPS samples.
- Previously revealed route colours do not shift as playback advances.
- Previously revealed route gradient stops do not shift while scrubbing.
- Missing metric segments remain neutral grey.
- Hover telemetry still resolves the corresponding segment.
- The display source remains one complete continuous `LineString` throughout
  playback and scrubbing.
