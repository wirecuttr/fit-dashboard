# Map Playback Follow Mode Design and Implementation

## Status

- Status: design reviewed; implementation investigation complete
- Working branch: feature/map-follow-mode
- Branch base: local main at e657cec
- Intended destination: local/private main
- Upstream pull request: not planned as part of this feature

This document combines the product design and implementation plan for a
camera-following GPS playback mode on the Individual activity map.

## Summary

Replace the activity map's current Terrain button with a Follow checkbox.
When Follow is checked, GPS playback uses a zoomed and pitched camera that
tracks the current position and rotates in the direction of travel. Direction
is derived from the ordered GPS route and smoothed so normal GPS noise does not
cause camera jitter.

Replace the Telemetry button with a Telemetry checkbox at the same time. The
checkboxes remove the redundant On and Off text while preserving immediate
application of both settings.

The existing Terrain control does not provide true three-dimensional terrain.
It only permits pitch and adds a sky layer; it does not configure a digital
elevation model or initially change the pitch. Replacing it does not remove a
working terrain representation.

## Goals

- Make GPS playback follow the current route position in a closer map view.
- Apply a pitched camera that faces the smoothed direction of travel.
- Handle ordinary bends, hairpins, and repeated switchbacks without snapping
  to nearby route legs or oscillating between headings.
- Keep Follow responsive at all available playback speeds.
- Let manual map interaction take control without the follow camera fighting
  the user.
- Replace the Terrain and Telemetry buttons with compact, accessible
  checkboxes.
- Preserve the current route colouring, telemetry overlay, playback timeline,
  playback-speed selection, lap markers, and map-style selection.
- Apply all new user-facing strings consistently in every supported language.

## Non-Goals

- True three-dimensional terrain or elevation extrusion.
- Loading a raster DEM or introducing another map-tile provider.
- Map matching GPS points to roads or trails.
- Rewriting or correcting the imported GPS track.
- Persisting Follow or Telemetry state across browser sessions.
- Automatically selecting a playback speed.
- Redesigning the overview location map.
- Providing activity-specific Follow settings in the first implementation.
- Reproducing Strava's visual design exactly.

## Existing Behaviour

The activity map currently:

- samples valid GPS records to a maximum of 6,000 ordered points;
- advances playback by timestamp in a requestAnimationFrame loop;
- stores the displayed record as timelineIndex;
- redraws the visible route when timelineIndex changes;
- displays the current visible route endpoint as the moving end marker;
- starts with the full route fitted and playback positioned at the end;
- resets playback to the beginning when Play is pressed at the end;
- offers playback speeds of 1x, 2x, 4x, 8x, 16x, and 32x; and
- uses raster basemaps for every available map style.

The current Terrain state calls applyTerrainState. Enabling it raises the
allowed pitch and adds a sky layer, but it does not call map.setTerrain, add a
DEM source, or apply an initial pitch. The map therefore appears unchanged
unless the camera is manually pitched.

MapLibre GL JS 4.7.1, already installed in the project, can update centre,
zoom, pitch, and bearing. No new mapping dependency is required.

## User Experience

### Header Controls

Replace the two map buttons with labelled native checkboxes:

    [ ] Follow    [x] Telemetry

The checked state communicates On or Off, so the visible On and Off suffixes
are removed.

Follow:

- is unchecked by default;
- is disabled when fewer than two valid GPS points are available;
- applies immediately when checked or unchecked; and
- is local to the current UI session.

Telemetry:

- remains checked by default;
- keeps its existing behaviour;
- shows the Timeline Telemetry overlay when checked;
- restores route hover telemetry when unchecked; and
- remains local to the current UI session.

Use a shared compact checkbox style so both controls have the same hit area,
alignment, focus indication, and disabled appearance. The label and checkbox
must be one accessible label target so tapping either activates the control.

### Follow On

Checking Follow immediately moves the camera to the current timeline position
and applies the Follow camera.

During playback or timeline scrubbing, Follow:

- keeps the current position visible;
- centres the current position in a closer street-level view;
- applies camera pitch; and
- rotates the map using the smoothed route bearing.

Follow is tied to the timeline position, not only to the playing state. It
therefore remains useful while playback is paused and while the user scrubs the
timeline.

When playback reaches the end, Follow remains checked and holds the final
position and heading.

### Follow Off and Manual Interaction

Explicitly unchecking Follow:

- stops automated camera updates;
- returns pitch to 0 degrees and bearing to north-up;
- retains the current centre and zoom; and
- leaves the timeline position unchanged.

Reset Zoom:

- unchecks Follow;
- cancels any active camera update;
- restores pitch to 0 degrees and bearing to north-up; and
- fits the complete route using the existing route-fit behaviour.

A user-initiated drag, zoom, rotation, or pitch gesture must turn Follow off.
The gesture remains authoritative: disabling Follow in response to a gesture
must not start a competing flatten or recenter animation. Reset Zoom remains
available when the user wants the standard flat route overview.

Programmatic camera events generated by Follow must not disable Follow. Event
handlers should distinguish user events through MapLibre's original-event
metadata or an explicit internal-camera-update guard.

Selecting a different activity resets Follow to off and fits the new route.
The reset must depend on the changed coordinate collection, not only on route
length or duration, because two activities can have matching counts and times.
Telemetry retains its current session behaviour.

### Camera Terminology

Pitch is the amount of camera tilt. Bearing is the compass direction faced by
the tilted camera.

The initial design uses a stable pitch and changes bearing dynamically. The
pitch does not need to oscillate as the route turns; rotating the bearing
changes the direction in which the tilted view faces.

The initial implementation uses the same camera at every playback speed:

- target zoom: 15.5;
- target pitch: 45 degrees; and
- maximum allowed pitch while Follow is active: 60 degrees.

Changing playback speed must not unexpectedly change zoom or pitch. These are
tuning constants, not stored user settings, and must be confirmed through
manual validation.

An ahead-biased screen offset and automatic high-speed zoom changes are
deferred until the centred implementation has been validated. They are not
required for the requested Follow behaviour and complicate continuous
public-API camera updates.

## Route-Direction Model

RecordPoint does not currently expose a course or heading field. Follow must
therefore derive direction from GPS coordinates.

Direction calculations must use route order and timestamp order. They must
never find the geographically nearest segment across the complete track.
Nearby legs of a switchback can be only a few metres apart and spatial nearest
matching could jump to the wrong leg.

### Prepared Follow Data

When the route changes, prepare a Follow representation once:

- retain the ordered longitude, latitude, and timestamp;
- calculate cumulative route distance;
- calculate local segment bearings;
- unwrap bearings into a continuous angular sequence;
- identify low-motion or unreliable segments; and
- calculate curvature information used to select the heading window.

This work is O(n) at route load and is bounded by the existing 6,000-point
sample limit. It must not be repeated on every animation frame.

Prepared data can use a model such as:

    FollowPoint
      longitude
      latitude
      timestampMs
      cumulativeDistanceM
      unwrappedBearingDeg
      reliableBearing

The camera position remains on the recorded route. Direction smoothing must
not alter or shortcut the displayed route geometry.

### Position Interpolation

The existing playback loop selects the latest record at or before the current
playback timestamp. That is sufficient for telemetry values but would produce
one camera movement per GPS sample.

For smooth camera movement, find the records immediately before and after
playheadElapsedMs and interpolate the camera position between them by
timestamp. Continue using the existing discrete timelineIndex for telemetry
and visible-route reconstruction.

The existing moving endpoint marker therefore remains record-based in the
initial implementation and can trail the interpolated camera target by no more
than one GPS sample. Do not add a 30 fps GeoJSON-source update speculatively.
Integrated validation must determine whether that gap is visually distracting.
If it is, add a dedicated lightweight playhead update without increasing full
route reconstruction frequency.

Interpolation must:

- clamp to the first and final points;
- handle duplicate timestamps without division by zero;
- interpolate longitude through the shortest wrapped path at the antimeridian;
- avoid interpolation across invalid coordinates; and
- retain the existing discrete record as a safe fallback.

### Bearing Calculation

A bearing based on only two adjacent points is too sensitive to GPS noise.
A long fixed window is also unsuitable because it cuts across tight corners.

Use a local route tangent with an adaptive, distance-based window. Initial
implementation constants are:

- straight-section look-ahead: 25 metres;
- moderate-turn look-ahead: 12 metres when forward heading change is at least
  30 degrees;
- sharp-turn look-ahead: 6 metres when forward heading change is at least
  60 degrees;
- curvature inspection distance: 30 metres;
- look-behind distance: 3 metres; and
- minimum displacement before accepting a new bearing: 5 metres.

These are starting constants validated by the synthetic spike and remain
subject to integrated tuning with real activities.

Distance-based windows behave more consistently than a fixed number of records
because FIT recording intervals and activity speeds vary.

Calculate bearings with a geographic initial-bearing formula rather than
treating longitude and latitude as Cartesian coordinates.

### Angular Smoothing

Bearings are circular values. Directly averaging 359 degrees and 1 degree
produces an incorrect result near 180 degrees.

The implementation must:

- unwrap sequential bearings across north;
- interpolate through the shortest continuous angular path;
- apply a damped low-pass filter to the unwrapped bearing;
- start with a wall-clock filter time constant of max(80 ms, 300 ms divided by
  the square root of playback speed);
- start with a 240-degree-per-second visual rotation cap; and
- hold the last reliable bearing while stopped or during GPS jitter.

The time constant and rotation cap are implementation tuning values. They may
change through integrated validation without changing the product design.

The filter response should account for playback speed. A fixed one-second
filter would lag the route by 32 activity seconds at 32x. High-speed playback
therefore needs a faster target response, while a wall-clock rotation-rate cap
prevents uncontrolled spinning. Some bearing lag is acceptable at 16x and 32x;
the initial implementation does not change zoom or pitch with playback speed.

## Switchbacks and Hairpins

Switchbacks are the primary reason for adaptive heading windows.

On approach to a switchback:

1. Examine ordered forward segments over a bounded route distance.
2. Detect large cumulative heading change or high local curvature.
3. Shrink the look-ahead window before reaching the apex.
4. Blend gradually from the incoming tangent toward the outgoing tangent.
5. Preserve the continuous signed heading through the turn.

The implementation must not average the widely separated incoming and outgoing
legs across a large window. Nearly opposite vectors can cancel and produce an
unstable bearing.

Repeated switchbacks must remain associated with timeline order even when
several route legs are geographically close. Camera position is interpolated
only between adjacent timestamped records.

At high playback speeds, displaying every hairpin in exact compressed time
would force rapid camera spins. Rotation remains rate-limited, accepting some
heading lag rather than producing an unpleasant spinning effect. Automatic
high-speed zoom or pitch changes are deferred unless integrated validation
shows that the fixed camera is unusable.

## Stops, GPS Noise, and Missing Direction

A valid current position does not always imply a reliable direction.

When the route displacement across the direction window is below the minimum
threshold:

- retain the last reliable bearing;
- continue centring on the current position if it changes meaningfully; and
- do not rotate based on stationary GPS drift.

At the start of the route, use forward points. At the end, use preceding
points. If the route never establishes a reliable bearing, Follow may centre
and zoom while retaining north-up orientation.

## Camera Update Loop

Do not call a new animated easeTo operation from every React timeline render.
Repeatedly interrupting camera animations can cause lag and directional delay.

Use the existing playback animation timing and refs to drive Follow outside
React state:

1. Read the current playhead elapsed time.
2. Interpolate the target route position.
3. Obtain the prepared target bearing.
4. Update the damped camera bearing.
5. Apply centre, zoom, pitch, and bearing.
6. Schedule the next update only while playback and Follow require it.

When Follow is enabled while paused, one short easeTo transition of at most
350 ms may establish the camera. When playback is already active, seed the
camera directly so that the initial transition cannot chase a stale target.

During continuous playback, use the installed public map.jumpTo API with the
already-interpolated and smoothed camera state. This avoids overlapping
animations. map.jumpTo emits programmatic camera events without an
originalEvent, allowing interaction handlers to distinguish them from user
gestures.

Cap follow-camera work at approximately 30 frames per second within the
existing playback requestAnimationFrame loop. The map can render between those
updates, while the cap avoids unnecessary camera events and tile requests. A
paused timeline requires only one camera update when Follow is enabled or the
timeline is scrubbed.

Camera values belong in refs. Follow must not add 30 React state updates per
second.

## Route Rendering and Performance

The existing timeline effect rebuilds the visible route GeoJSON whenever
timelineIndex changes. That work may be more expensive on long activities than
the camera transform itself.

The Follow implementation must not increase the route-redraw frequency.
Performance validation should determine whether the existing redraw becomes a
problem at 16x or 32x.

If optimisation is required, prefer the smallest measured change:

- throttle visible-route source updates independently from camera updates;
- update a dedicated playhead source without rebuilding unrelated marker data;
  or
- incrementally extend the visible route rather than recreating the complete
  feature collection.

Do not add speculative route-rendering complexity until profiling or manual
validation shows that it is needed.

Raster tiles may load late when a 32x camera moves quickly through a long
route. Late tiles are acceptable temporarily; blocking input or freezing
playback is not. Speed-dependent zoom is a possible measured optimisation, not
part of the initial design.

## State and Map Lifecycle

Replace terrainEnabled and terrainEnabledRef with followEnabled and a matching
ref. Remove applyTerrainState and the Terrain-specific sky-layer state. Follow
enablement raises maxPitch to 60 degrees. Explicit disable and Reset Zoom
flatten the camera before restoring maxPitch to 0. A user gesture disables the
follow ref synchronously and remains authoritative; it must not trigger the
explicit-disable camera animation.

Follow state must be respected when:

- the map initially loads;
- a basemap style is changed and sources and layers are recreated;
- GPS coordinates change;
- the playback speed changes;
- playback starts, pauses, restarts, or ends;
- the timeline is scrubbed;
- Reset Zoom is pressed; and
- the component unmounts.

Changing map style while Follow is enabled must preserve the current follow
camera and resume route updates after the new style becomes ready.

Listen for user dragstart, zoomstart, rotatestart, and pitchstart events. A
truthy originalEvent identifies a user gesture. Set followEnabledRef to false
before scheduling the React state update so the playback frame cannot recenter
the camera during the same gesture. Programmatic jumpTo events have no
originalEvent and must be ignored by this handler.

All animation frames and MapLibre event listeners introduced by Follow must be
cancelled during cleanup.

## Checkbox Implementation

In ActivityMap:

- replace the Terrain button with a labelled Follow checkbox;
- replace the Telemetry button with an equivalent labelled checkbox;
- use onChange and the input's checked value;
- retain immediate state application;
- disable only Follow when the route cannot be played; and
- provide visible keyboard focus and a touch-friendly label area.

Add a shared map checkbox class in src/styles.css rather than duplicating
inline styles.

The visual control should remain compact beside the Style and Colour selects
and should wrap cleanly at the existing responsive breakpoints.

## Localisation

Replace the obsolete activityMap.terrain label with activityMap.follow and
ensure activityMap.telemetry exists in all 14 locale files. Russian currently
relies on English fallback for these map labels, so it needs both explicit
feature labels rather than a key replacement.

The activityMap.on and activityMap.off keys are currently used only by the two
buttons being converted. Remove them from the locale files after a final source
search confirms that the checkbox implementation has no remaining callers.

Do not rename unrelated colour-mode keys or code identifiers.

The English value is Follow and follows the project's current UK-English copy
convention.

## Suggested Code Structure

Keep geographic and smoothing calculations independent from React and MapLibre
where practical. A helper module such as src/lib/mapFollow.ts can expose pure
functions for:

- cumulative route distance;
- initial geographic bearing;
- bearing unwrapping;
- adaptive look-ahead selection;
- curvature detection;
- timestamp interpolation; and
- damped bearing updates.

ActivityMap remains responsible for:

- state and checkbox wiring;
- MapLibre camera application;
- interaction event handling;
- playback lifecycle integration; and
- map-style lifecycle integration.

Pure helpers make switchback and north-crossing behaviour testable without
creating a WebGL map.

Follow the repository's existing lightweight TypeScript test pattern:

- scripts/test-map-follow.ts for assertions;
- tsconfig.map-follow-test.json for the focused compile;
- scripts/run-map-follow-tests.mjs for temporary compilation and execution; and
- an npm test:map-follow script.

## Implementation Investigation Findings

A contained investigation spike was completed on 2026-07-13. It changed no
production source files.

### Confirmed API and Lifecycle Assumptions

- The installed MapLibre GL JS 4.7.1 map.jumpTo API supports centre, zoom,
  pitch, and bearing updates without starting an animation.
- Public jumpTo does not support a transient screen offset. MapLibre offers
  offset through animated camera methods and persistent asymmetric padding,
  both of which complicate continuous updates and manual-gesture handoff. This
  supports deferring the ahead-biased offset.
- Programmatic jumpTo camera events do not contain originalEvent. Mouse, touch,
  wheel, and navigation-control gestures propagate their originating event to
  dragstart, zoomstart, rotatestart, or pitchstart. The proposed interaction
  distinction is therefore implementable without a broad internal guard.
- The current map starts with maxPitch set to 0, so Follow must explicitly
  raise it before applying pitch.
- The existing playback requestAnimationFrame loop and elapsed-time refs can
  drive a throttled camera update without additional React state updates.
- Activity reset cannot safely depend only on coordinate count and total
  duration; coordinate collection identity must participate in the reset.

### Synthetic Route-Math Results

The spike exercised a candidate ordered, distance-based algorithm using a
two-metre sample interval:

- A 180-degree hairpin moved progressively from the incoming to outgoing
  bearing.
- The largest adjacent prepared-bearing change in that synthetic hairpin was
  25 degrees; there was no uncontrolled 180-degree snap.
- A sequence crossing north unwrapped from 350, 355, 359, 1, 5, and 10 degrees
  to the continuous sequence 350, 355, 359, 361, 365, and 370 degrees.
- Repeated stationary coordinates retained the last reliable direction.
- Preparing 6,000 synthetic points averaged approximately 3.7 ms over 200
  runs in the development environment.

The timing result demonstrates that route preparation is unlikely to be the
performance bottleneck. It is not a browser frame-time guarantee.

### Remaining Integrated Risks

The contained spike cannot establish WebGL rendering, raster-tile loading, or
full-route GeoJSON update cost. Those require the integrated ActivityMap and a
real browser view.

The two remaining measurements for Slice 4 are:

- whether 30 jumpTo updates per second remain smooth while the existing route
  source is also being rebuilt; and
- whether the record-based endpoint marker's one-sample gap from the
  interpolated camera target is visually acceptable.

Neither issue blocks implementation. Both have bounded fallbacks already
defined in the performance section.

## Implementation Slices

### Slice 1: Control and State Semantics

- Replace Terrain state, ref, button, and localisation with Follow.
- Convert Follow and Telemetry to checkboxes.
- Remove Terrain-only pitch and sky behaviour.
- Implement explicit Follow enable, disable, Reset Zoom, activity-change, and
  manual-interaction semantics.
- Preserve existing Telemetry behaviour.

### Slice 2: Prepared Direction Data

- Add pure geographic distance and bearing helpers.
- Build cumulative distance and ordered heading data when the route changes.
- Add bearing unwrapping and reliability thresholds.
- Add adaptive curvature and look-ahead calculations.
- Add focused tests for the pure helpers.

### Slice 3: Follow Camera Runtime

- Interpolate position from playback elapsed time.
- Add damped, playback-aware bearing updates.
- Apply camera centre, zoom, pitch, and bearing.
- Integrate paused scrubbing, playback restart, and playback completion.
- Preserve Follow across basemap-style reloads.
- Add cleanup for frames and event listeners.

### Slice 4: Performance and Integrated Validation

- Validate long routes at every playback speed.
- Measure whether existing route reconstruction causes dropped frames.
- Optimise route-source updates only if the result demonstrates a need.
- Tune zoom, pitch, curvature thresholds, and rotation response.
- Validate all basemap styles and responsive layouts.

These are implementation slices within one feature branch, not separate product
features.

## Automated Validation

Pure helper tests should cover:

- north crossing from 359 degrees to 1 degree;
- shortest-path angular interpolation;
- clockwise and counter-clockwise turns;
- a 180-degree hairpin;
- repeated close switchbacks;
- duplicate timestamps;
- a stopped or nearly stationary section;
- sparse GPS samples;
- the first and final route points;
- unreliable direction followed by reliable movement; and
- cumulative distance monotonicity.

The normal frontend production build must pass after integration.

## Manual Validation

Use representative real activities:

- a straight urban route;
- a route with ordinary corners;
- a mountain route with repeated switchbacks;
- a route containing stops and GPS drift;
- a long route approaching the 6,000-point sample cap; and
- a route with sparse recording intervals.

For each route, verify:

- Follow enables and disables immediately;
- the camera follows the interpolated playback position and any one-sample
  gap from the record-based endpoint marker is acceptable;
- scrubbing updates the followed position while paused;
- the direction crosses north without a full rotation;
- switchbacks rotate progressively without jumping to adjacent legs;
- stationary sections do not cause bearing jitter;
- user pan, zoom, and rotation disable Follow without camera resistance;
- Reset Zoom restores the complete flat north-up route;
- map-style changes retain Follow correctly;
- Telemetry behaviour is unchanged;
- both checkbox labels are easy to tap and keyboard accessible;
- playback remains responsive at 1x through 32x; and
- no frame or event-listener work continues after unmount.

## Acceptance Criteria

The feature is complete when:

- Terrain is no longer presented as a control on the activity map.
- Follow and Telemetry are displayed as labelled checkboxes.
- Follow defaults off and Telemetry defaults on.
- Follow tracks playback and scrubbing with a closer, pitched camera.
- Camera bearing follows a smoothed, route-ordered direction.
- Tight switchbacks do not cause spatial leg switching or uncontrolled
  oscillation.
- Manual map interaction disables Follow without fighting the gesture.
- Reset Zoom disables Follow and restores the full flat route.
- High-speed playback remains usable on a long route.
- All supported locales contain explicit Follow and Telemetry labels.
- Focused helper tests and the frontend build pass.

## Deferred Enhancements

- True DEM-backed three-dimensional terrain.
- A directional arrow for the moving playback marker.
- An ahead-biased vertical playhead offset.
- Activity-type-specific follow zoom.
- Speed-dependent zoom or pitch.
- Grade-dependent pitch.
- User-configurable Follow camera settings.
- Persisting Follow as a preference.
- Route map matching or GPS correction.
