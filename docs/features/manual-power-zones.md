# Configurable Power Zones

## Status and Implementation Baseline

- Document branch: `feat/manual-power-zones`
- Implementation target: local integration `main`
- Upstream pull request: not planned as part of this work

This document combines the product design and implementation plan for replacing
the app's fixed percentage-of-FTP power-zone model with user-configurable
percentage boundaries.

The implementation depends on FIT-derived power metadata, activity-time
handling, the power zone-time chart, and the database-backed heart-rate-zone
preference pattern that are present on local `main` but not on
`upstream/main`. Before implementation begins, the working branch must therefore
be based on local `main`, or this document commit must be moved onto a new branch
created from local `main`.

## Summary

The app will keep six globally configured power-zone boundaries expressed as
percentages of FTP. Those boundaries define seven zones, with the final zone
open-ended. The initial and reset values are:

```text
55%, 75%, 90%, 105%, 120%, 150%
```

For an activity with a usable FIT FTP, these percentages are converted to watt
boundaries and always control power-line colouring. There is no FIT/manual zone
policy and no manual FTP override.

The existing Time in Power Zones chart gains a source control:

- `FIT file` displays the device-reported `time_in_power_zone` buckets without
  applying the configured percentages; and
- `Calculated` rebuilds the bars from record-level power using the configured
  percentages and the activity's FIT FTP.

The configured percentages and preferred chart source are stored together in
DuckDB. Clearing browser storage must not remove them.

## Existing Behaviour

On local `main`, imported power-zone metadata can contain:

- `functional_threshold_power`;
- `pwr_calc_type`;
- `power_zone_high_boundary`; and
- `time_in_power_zone`.

Many Edge and MTB FIT files contain FTP and time-in-zone totals but omit explicit
power boundaries. During import, the parser currently infers boundaries from the
fixed 55%, 75%, 90%, 105%, 120%, 150%, and 200% FTP thresholds and appends a
4000 W FIT cap. Some other devices and FIT files can provide explicit power
boundaries. Those imported values remain activity metadata.

The current power line is coloured from the activity's imported or inferred
watt boundaries. The current power zone-time bars prefer FIT-reported totals and
fall back to record-based accumulation when totals are unavailable.

This feature changes the power line to use the configured percentage model. It
does not change imported FIT metadata or rewrite FIT-reported totals.

## Goals

- Replace the fixed power-line percentage thresholds with editable global
  percentage thresholds.
- Use the Garmin-style seven-zone percentage model as the default and reset state.
- Use the selected activity's FIT FTP to convert configured percentages to watt
  boundaries.
- Always use configured boundaries for power-line colouring when FIT FTP is
  available.
- Let the user explicitly choose FIT-reported or calculated power zone-time
  bars.
- Make calculated bars use the same boundaries as the power line.
- Keep FIT-reported bars independent of configured boundaries.
- Persist the configuration in DuckDB for both Tauri and Docker/web clients.
- Preserve existing graphs, time/distance axes, activity-time behaviour, and
  imported zone metadata.

## Non-Goals

- No manual FTP value or manual FTP override.
- No automatic tolerance comparison between FIT and calculated zone totals.
- No FIT/manual or fallback/always zone-boundary policy.
- No absolute-watt zone editor.
- No sport-specific, dated, or named power-zone profiles.
- No per-activity preference override.
- No changes to FIT parsing, imported zone metadata, or historical activity
  rows.
- No reimport or backfill requirement.

## Preference Model

Add the frontend model in `src/lib/powerZones.ts`. Keep imported FIT-zone types
and generic numeric-zone rendering helpers in `src/lib/zones.ts`.

```typescript
export const POWER_ZONE_PREFERENCES_VERSION = 2 as const;

export const DEFAULT_POWER_ZONE_BOUND_PERCENTS = [
  55, 75, 90, 105, 120, 150,
] as const;

export type PowerZoneTimeSource = "fit" | "calculated";

export type PowerZonePreferences = {
  version: typeof POWER_ZONE_PREFERENCES_VERSION;
  bounds_percent_ftp: number[];
  zone_time_source: PowerZoneTimeSource;
};
```

Version-2 defaults are:

```json
{
  "version": 2,
  "bounds_percent_ftp": [55, 75, 90, 105, 120, 150],
  "zone_time_source": "fit"
}
```

When loading a valid version-1 preference, preserve its first six boundaries and
chart source, discard the obsolete seventh boundary, and persist the result as
version 2.

`zone_time_source` is a global preferred source, not a guarantee that every
activity can provide it. An activity-level availability fallback must not
overwrite the stored preference.

### Boundary Validation

Configured boundaries must:

- contain exactly six values, producing seven zones;
- contain integers only;
- be between 1% and 300% FTP inclusive;
- be strictly increasing; and
- have a minimum gap of 5 percentage points.

Use the same limits in TypeScript and Rust. Add pure helpers:

- `validatePowerZoneBoundPercents(value)`;
- `normalizePowerZonePreferences(value)`; and
- `configuredPowerZoneBoundsWatts(ftpWatts, boundPercents)`.

An activity FTP is usable when it is finite and between 50 W and 2000 W
inclusive, matching the current FIT parser limits. Convert each percentage using
nearest-integer rounding:

```text
boundary watts = round(activity FTP × percentage / 100)
```

The resulting watt boundaries must remain strictly increasing. If FTP or the
derived boundaries are unusable, return no configured watt boundaries rather
than silently substituting a nominal FTP.

The imported 4000 W cap is not part of this preference model. The configured
six boundaries produce an implicit open-ended seventh zone.

## Zone Semantics

### Power Line

When record-level power and usable activity FTP are available:

1. Convert the configured percentage boundaries to watts.
2. Build seven numeric zones from those six watt boundaries.
3. Use those zones for the power chart's `visualMap` pieces.

Successfully saving changed or reset percentages updates power-line colours
without changing imported activity metadata.

When power samples exist but activity FTP is unavailable, continue to render the
power line in its normal single colour. Do not apply nominal or stale FTP data.

Explicit FIT boundaries, when present, remain available to the FIT source of the
zone-time chart but do not override configured power-line boundaries.

### FIT File Zone-Time Source

The `FIT file` source displays imported `time_in_power_zone` durations directly.
Editing configured percentages must never redistribute or relabel those FIT
buckets.

Retain the existing FIT presentation:

- use explicit imported boundaries when present;
- otherwise use the parser's existing standard percentage/FTP inference and FIT
  cap;
- retain the existing FIT bucket labelling and high-bucket collapsing rules;
  and
- do not recalculate FIT durations from records.

The inferred boundaries are an interpretation of the device buckets, not proof
that the device used those exact thresholds. Source help text must state that
device-reported zones can differ from the configured zones.

The FIT source is available only when `time_in_zone_s` contains finite,
non-negative values and at least one positive duration.

### Calculated Zone-Time Source

The `Calculated` source uses:

- the configured percentage boundaries;
- the activity's FIT FTP;
- unsmoothed record-level power;
- the one-second analysis record stream when available, with normal records as a
  fallback; and
- the existing moving-time timeline so reliable stopped intervals are excluded.

For each point except the final point, classify its power into the configured
zone and add the interval to the next point. Do not use display smoothing or
downsampled chart values for classification.

Calculated rows have a one-to-one configured-zone presentation:

```text
Z1 <= first boundary
Z2 first boundary + 1 through second boundary
...
Z7 > final boundary
```

The Calculated source is available only when the activity has usable FIT FTP and
valid record-level power samples.

### Source Availability and Selection

Use the following behaviour:

| FIT totals available | Calculated data available | Display behaviour |
| --- | --- | --- |
| yes | yes | Show the source control and use the stored preference. |
| yes | no | Show FIT bars and a `FIT file` source label. |
| no | yes | Show calculated bars and a `Calculated` source label. |
| no | no | Hide the Time in Power Zones chart. |

When the stored preference is unavailable for the selected activity, use the
available source temporarily. Do not write that temporary fallback to the
database. When the user explicitly changes the source through the chart control,
apply it immediately and persist it optimistically; restore the confirmed source
if persistence fails.

## User Interface

### Settings Panel

Use one `Heart Rate and Power Zones` Settings section for both zone editors.
The section has no panel-level icon; each action button retains its own icon.
The section contains the `Customise HR Zones` and `Customise Power Zones`
buttons. It does not repeat editor instructions at panel level. The power editor
contains no fallback/always zone policy and no FTP input.

Adapt the accessible heart-rate-zone dialog into a reusable zone editor or a
power-specific dialog. The power editor contains:

- six percentage handles or equivalent numeric controls;
- coloured live zone segments;
- percentage range labels;
- `Reset to defaults` using
  `DEFAULT_POWER_ZONE_BOUND_PERCENTS`;
- Save and Close/Cancel actions;
- pointer and keyboard operation;
- appropriate slider roles, values, and localised accessible labels; and
- loading, saving, validation, and persistence-error states.

Reset asks for confirmation before updating the dialog draft. The new values
become active only after a successful save, matching the heart-rate-zone editor
pattern.

### Time in Power Zones Chart

When both sources are available, add a compact source control to the chart
header:

```text
Source: [ FIT file | Calculated ]
```

Use localised labels and concise help text:

- `FIT file`: Device-reported time in power zones; these zones can differ from
  the configured zones.
- `Calculated`: Time recalculated from recorded power using the configured zones
  and activity FTP.

When only one source is available, replace the interactive control with a small
source label so the chart's provenance remains visible.

## Frontend State and Data Flow

Create `src/stores/powerZonePreferenceSlice.ts`, following the confirmed-state
and rollback pattern in `heartRateZonePreferenceSlice.ts`.

State includes:

- `configuredPowerZoneBoundPercents`;
- `confirmedPowerZoneBoundPercents`;
- `powerZoneTimeSource`;
- `confirmedPowerZoneTimeSource`;
- `powerZonePreferenceStatus` (`idle`, `loading`, `ready`, or `error`);
- `powerZonePreferenceSaving`; and
- `powerZonePreferenceError`.

Actions include:

- `loadPowerZonePreferences()`;
- `savePowerZoneBoundPercents(boundPercents)`; and
- `setPowerZoneTimeSource(source)`.

Serialise writes so a source change and boundary save cannot overwrite one
another with stale preference data. A failed source save restores the confirmed
source. A failed boundary save leaves the previously confirmed boundaries
active.

Merge the slice into `settingsStore.ts`. In `App.tsx`, load power-zone
preferences after authentication alongside dashboard data and heart-rate-zone
preferences. Do not apply unconfirmed defaults to charts while preference status
is `idle`, `loading`, or `error`.

A failed preference load must not discard an otherwise successful dashboard
refresh. In that state, keep the power line unzoned, make Calculated unavailable,
allow valid FIT bars to render with a non-interactive `FIT file` source label,
and expose a preference retry action.

For the selected activity:

1. `Dashboard` reads FIT FTP from the selected activity metadata.
2. When preferences are ready, it converts configured percentages to watt
   boundaries.
3. `Dashboard` passes configured watt boundaries, the preferred chart source,
   the source-change action, preference-saving/error state, and the existing
   imported power-zone metadata into `ActivityInsights`.
4. `ActivityInsights` always uses configured watt boundaries for power-line
   colouring.
5. `ActivityInsights` independently determines FIT and Calculated source
   availability and renders the selected or temporary fallback zone-time bars.

Keep the source-selection dependency explicit through props or a dedicated hook;
do not make the chart silently retrieve only part of its configuration directly
from the global store.

## API and Persistence

Add frontend API bindings in `src/lib/api.ts`:

```typescript
getPowerZonePreferences(): Promise<PowerZonePreferences>
setPowerZonePreferences(
  preferences: PowerZonePreferences,
): Promise<PowerZonePreferences>
```

Bindings use:

- Tauri commands `get_power_zone_preferences` and
  `set_power_zone_preferences`; and
- web endpoints `GET /settings/power-zones` and
  `POST /settings/power-zones`.

### Rust Module

Add `src-tauri/src/power_zones.rs`, following the established
`heart_rate_zones.rs` pattern. Define:

- `POWER_ZONE_PREFERENCES_KEY = "power_zone_preferences"`;
- the version, validation limits, defaults, source enum, and preferences struct;
- `load_power_zone_preferences`; and
- `save_power_zone_preferences`.

Use the existing generic `Database::get_setting` and `Database::set_setting`
methods. No database schema migration or power-specific query methods are
required.

Missing preferences return version-2 defaults. Valid version-1 preferences are
migrated automatically. Malformed, invalid, or unsupported
stored preferences log a warning and return safe defaults. Saves validate before
encoding and use the existing transactional setting-replacement behaviour so a
failed write preserves the previous complete value.

Register the module and expose the shared logic through `tauri_app.rs` and
`server.rs`. Both application modes must return the normalised, persisted object
after a successful write.

## Localisation and Accessibility

Add equivalent keys to every supported `src/i18n/*.json` file for:

- the Settings section title and explanation;
- the customise, reset, save, loading, saving, retry, and error states;
- percentage and zone labels;
- the chart source legend;
- `FIT file` and `Calculated`; and
- source help text and accessible control labels.

English copy follows Canadian spelling, including `colour` and `Customise`.
Maintain key parity across all locales and avoid hard-coded user-facing strings
in chart formatters or accessible labels.

The zone editor must support keyboard adjustment, expose its percentage value and
limits to assistive technology, trap focus while open, and restore focus when it
closes. The chart source control must be operable and understandable without
relying on colour alone.

## Implementation Slices

### 1. Establish the Correct Baseline

- Move this document onto an implementation branch based on local `main`.
- Confirm that the local FIT power-zone, activity-time, and heart-rate preference
  infrastructure is present.
- Inspect the scoped diff before coding so no upstream-only graph structure is
  accidentally reintroduced.

Completion condition: the implementation branch contains the local graph and
preference foundations described by this document.

### 2. Add the Preference and Conversion Model

- Add constants, types, validation, normalisation, percentage-to-watt
  conversion, and source-availability helpers.
- Add pure tests for limits, ordering, reset defaults, FTP validation, rounding,
  and derived-bound monotonicity.

Completion condition: configured preferences and derived watt boundaries have a
single tested definition.

### 3. Add Durable Backend Persistence

- Add the Rust model and shared load/save functions.
- Add Tauri commands and web routes.
- Add frontend API bindings.
- Cover defaults, valid round trips, invalid saves, unsupported versions, and
  transactional preservation with focused backend tests.

Completion condition: preferences survive browser-storage clearing and round-trip
through both application modes.

### 4. Add the Zustand Preference Slice

- Load preferences after authentication.
- Keep confirmed and optimistic state separately.
- Serialise writes and implement rollback.
- Expose retryable load and save failures.

Completion condition: source changes apply immediately, failed changes roll back,
and boundary saves cannot race source saves.

### 5. Add the Settings Editor

- Combine the heart-rate and power-zone actions in the icon-free `Heart Rate and
  Power Zones` Settings section.
- Add the six-boundary percentage editor and Reset to defaults.
- Add localised, keyboard-accessible controls and clear status feedback.

Completion condition: the user can edit, reset, save, and reload configured
percentages without an FTP input or usage-policy control.

### 6. Integrate Power-Line Colouring

- Derive configured watt boundaries from selected activity FIT FTP.
- Replace imported/inferred boundaries as the power-line colour source.
- Preserve a normal unzoned power line when FTP is missing.
- Retain all existing chart availability, layout, smoothing, axes, and zoom
  behaviour.

Completion condition: the power line and configured boundary changes agree for
every activity with usable FIT FTP.

### 7. Add the Zone-Time Source Control

- Keep the FIT bars on the existing imported-data path.
- Add moving-time record accumulation for Calculated bars.
- Add source availability handling, the chart control or label, persistence, and
  temporary fallback behaviour.
- Ensure configured edits affect only the power line and Calculated bars.

Completion condition: the user can switch one chart between unchanged FIT totals
and bars calculated from configured zones.

### 8. Integrate and Build

- Review the complete feature diff.
- Merge the completed implementation branch into local `main`.
- Run focused lightweight frontend and Rust tests where needed.
- Run the normal Docker rebuild/deploy from local `main` using
  `docker/docker-compose-build.yml` and the local override.
- Smoke-test the deployed app on port `8088`.

Do not run broad Rust/Tauri tests by default. If a targeted Rust test is needed,
use the constrained `fit-dashboard-rust-dev` container and stop if it begins a
cold rebuild of heavy native dependencies such as `libduckdb-sys`.

## Validation Plan

### Preference and Persistence

- Missing storage returns the six default percentages and FIT source.
- Valid edits survive app restart, browser-storage clearing, and Docker rebuilds
  with the preserved database bind mount.
- Invalid length, non-integer, out-of-range, unsorted, duplicated, and too-close
  percentage values are rejected in TypeScript and Rust.
- Confirmed Reset restores `[55, 75, 90, 105, 120, 150]` as a draft; a
  cancelled confirmation leaves the current draft unchanged.
- Malformed and unsupported persisted values recover safely.
- Failed and concurrent writes preserve the last confirmed complete preference.

### Power Line

- Default percentages produce seven configured zones, with Z7 above 150% FTP.
- Editing a percentage immediately changes the line after a successful save.
- Activities with power but no usable FIT FTP retain an unzoned power line.
- Explicit imported FIT boundaries do not override configured line boundaries.
- Imported metadata and exports remain unchanged.

### FIT File Source

- FIT bars retain their imported durations before and after configured-zone
  edits.
- Explicit FIT boundaries retain their existing presentation.
- FTP-inferred FIT boundaries and the imported cap retain their existing
  presentation.
- Invalid or empty FIT totals do not make the source available.

### Calculated Source

- Calculated bars use the same configured watt boundaries as the power line.
- Calculated durations use one-second analysis records and moving-time intervals.
- Display smoothing and chart downsampling do not change zone classification.
- Editing or resetting configured percentages updates calculated bars.
- Missing FTP or missing power samples makes Calculated unavailable.

### Source Control

- Both available sources show the interactive control.
- A single available source shows a provenance label.
- No available source hides the chart.
- Explicit selection persists in DuckDB and applies across activities.
- An unavailable preferred source falls back temporarily without overwriting the
  stored preference.
- A failed source save restores the confirmed source.

### Regression Coverage

- Heart-rate zones and heart-rate preference persistence are unchanged.
- Power chart availability remains record-data-driven.
- Time/distance axes, Moving/Total behaviour, zoom synchronisation, lap markers,
  graph smoothing, chart ordering, and map layout are unchanged.
- Every supported locale has the new keys.
- Both Tauri and Docker/web API paths compile.
- The optimised Docker build and deployment complete from local `main`.

## Acceptance Criteria

- Six percentage-of-FTP boundaries are editable and database-persisted, producing
  seven zones.
- Defaults and Reset use `55, 75, 90, 105, 120, 150`, with Z7 above 150% FTP.
- No manual FTP or FIT/manual zone policy appears in the UI.
- Once preferences are ready, the power line uses configured percentages when
  activity FIT FTP is usable.
- Editing configured percentages never changes FIT-reported zone-time bars.
- Calculated bars use configured percentages, activity FIT FTP, record power, and
  moving time.
- The chart exposes `FIT file` and `Calculated` sources when both are available.
- The preferred source persists in DuckDB and unavailable-source fallback does
  not change it.
- Activities without FTP or power data degrade without misleading zones.
- Existing imported FIT metadata, other graphs, and Settings features are
  preserved.
- English copy uses Canadian spelling and all locales remain consistent.
- The feature builds and deploys successfully from local `main`.

## Deferred Work

- Manual, dated, or per-activity FTP overrides.
- Sport-specific or named power-zone profiles.
- Absolute-watt zone definitions.
- Automated compatibility scoring between FIT and calculated zone totals.
- Using session `threshold_power` as an FTP fallback after its semantics are
  validated.
