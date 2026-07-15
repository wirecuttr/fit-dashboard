# Manual Heart Rate Zones and Upstream v0.4 Integration

## Status

- Status: planned
- Working branch: `sync/upstream-v0.4.0-hr-zones`
- Branch base: local `main`
- Upstream merge target: `upstream/main` at `63fb7fc` (`v0.4.0`)
- Intended destination: local/private `main`
- Upstream pull request: not planned as part of this integration

This document combines the product design and implementation plan for bringing
the upstream manual heart-rate-zone feature into the private integration branch.
It supplements `docs/features/hr-power-zones.md`, which remains the source for
FIT-derived heart-rate and power-zone metadata semantics.

## Summary

Upstream `v0.4.0` adds an interactive manual heart-rate-zone editor. Local
`main` has since gained a substantially different activity-detail and chart
architecture, including FIT-derived heart-rate and power zones, expanded
telemetry charts, smoothing controls, time/distance axes, lap markers, zone-time
bars, and heart-rate drift.

The upstream feature must therefore be ported into the local architecture rather
than accepted wholesale. FIT-derived heart-rate boundaries remain the default.
Manual boundaries can be used either:

- as a fallback when the selected FIT activity has no usable heart-rate-zone
  boundaries; or
- always, as an explicit override of FIT-derived boundaries.

Manual boundaries and their usage policy are durable analysis configuration.
They are stored in DuckDB rather than browser `localStorage`.
The preference is deployment-wide: every browser connected to the same FIT
Dashboard database uses the same manual boundaries and usage policy.

## Upstream Change Being Integrated

The upstream commits are:

- `2ff59a2 feat: add interactive heart rate zone customization with slider dialog`
- `63fb7fc chore: bump project version to 0.4.0`

The feature commit adds:

- four editable upper heart-rate boundaries producing five zones;
- an interactive slider dialog in Settings;
- default boundaries of `75`, `95`, `120`, and `150` bpm;
- persisted frontend settings;
- heart-rate-zone labels and styles; and
- translations for the new controls.

The version commit updates `package.json`, `package-lock.json`, and
`src-tauri/tauri.conf.json` to `0.4.0`.

The merge forecast identifies textual conflicts in:

- `src/components/Dashboard.tsx`
- `src/components/SettingsPanel.tsx`
- `src/i18n/en.json`
- `src/i18n/ru.json`

Other overlapping files are expected to merge automatically, but their results
still require review because automatic textual resolution does not guarantee the
correct zone precedence or time-in-zone semantics.

For `src/i18n/en.json`, local values are authoritative for every key already
present on local `main`. Some local English strings have been intentionally
refined and must not be replaced by upstream wording during conflict resolution.
Upstream contributes only genuinely new keys. New English values are then
reviewed for Canadian spelling and consistency with the surrounding local copy.

## Goals

- Preserve all local graph, telemetry, metadata, layout, and settings changes.
- Keep FIT-derived heart-rate zones as the default when they are available.
- Provide editable manual boundaries for activities without FIT boundaries.
- Let the user explicitly select manual boundaries for every activity.
- Apply the selected boundaries consistently to heart-rate chart colouring and
  zone-time calculations.
- Never relabel FIT aggregate time-in-zone totals with incompatible manual
  boundaries.
- Store manual-zone configuration durably in the existing DuckDB database.
- Support both the Tauri and Docker/web application paths.
- Retain the upstream `0.4.0` version update.
- Use Canadian spelling in English user-facing copy.

## Non-Goals

- Manual power-zone editing.
- Per-sport or per-activity manual heart-rate profiles.
- Editing or rewriting boundaries inside imported FIT metadata.
- Migrating every existing presentation preference from `localStorage` to
  DuckDB in this feature.
- Changing the existing FIT parser or power-zone inference.
- Redesigning the activity-detail chart grid.
- Changing heart-rate drift calculations or chart-availability rules unrelated
  to the selected zone source.
- Creating an upstream pull request from the private integration branch.

## Existing Behaviour

Local `main` reads heart-rate boundaries from the selected activity metadata by
calling `getHeartRateZoneBounds`. The helper prefers:

1. `metadata.zones.heart_rate.upper_bounds_bpm`; then
2. the legacy `metadata.heart_rate_zone_bounds_bpm` compatibility field.

`ActivityInsights` builds zone definitions from those bounds. The current code
uses any non-zero FIT `time_in_zone_s` values after padding or truncating them to
the rendered zone count. It does not yet verify the raw aggregate bucket count.
When no non-zero totals remain but record-level heart-rate samples exist, it
calculates zone time from the normal chart record stream.

Sample-dependent heart-rate charts are hidden when the record stream has no
heart-rate data. The heart-rate zone-time chart is a deliberate exception: it
can still be displayed without record-level samples when the FIT file supplies
compatible boundaries and aggregate time-in-zone totals.

## Preference Model

The frontend model uses explicit manual naming so configured bounds are not
confused with FIT-derived bounds:

```ts
export type ManualHeartRateZoneUsage = "fallback" | "always";

export type HeartRateZonePreferences = {
  version: 1;
  boundsBpm: number[];
  usage: ManualHeartRateZoneUsage;
};
```

Defaults:

```ts
{
  version: 1,
  boundsBpm: [75, 95, 120, 150],
  usage: "fallback"
}
```

Four boundaries produce five zones:

```text
Z1 <= bound 1
Z2 > bound 1 and <= bound 2
Z3 > bound 2 and <= bound 3
Z4 > bound 3 and <= bound 4
Z5 > bound 4
```

The stored representation is versioned so validation or future zone-profile
features can evolve without silently reinterpreting old values.

## Persistence Design

### Storage Location

Use the existing DuckDB `settings` table:

```sql
CREATE TABLE IF NOT EXISTS settings (
    key VARCHAR PRIMARY KEY,
    value VARCHAR NOT NULL
);
```

Store the complete preference object under one key:

```text
key: heart_rate_zone_preferences
```

Example value:

```json
{
  "version": 1,
  "bounds_bpm": [75, 95, 120, 150],
  "usage": "fallback"
}
```

Keeping the bounds and policy in one value prevents readers from observing a
new policy with old boundaries or the reverse. The existing `get_setting` and
`set_setting` database methods can be reused, so no schema migration is needed.

The current `set_setting` helper deletes and then inserts without a transaction.
Make that replacement transactional before using it for this durable
preference. A process interruption must leave either the previous complete JSON
value or the new complete JSON value, not a missing row between delete and
insert.

### Backend Contract

Add a typed backend response and request shared conceptually by both runtimes:

```json
{
  "version": 1,
  "bounds_bpm": [75, 95, 120, 150],
  "usage": "fallback"
}
```

Add:

- Tauri commands:
  - `get_heart_rate_zone_preferences`
  - `set_heart_rate_zone_preferences`
- Docker/web route:
  - `GET /api/settings/heart-rate-zones`
  - `POST /api/settings/heart-rate-zones`
- Frontend API methods:
  - `getHeartRateZonePreferences()`
  - `setHeartRateZonePreferences(preferences)`

The backend is authoritative. It validates requests before serialization and
returns the stored, normalized value after a successful save.

### Validation

The implementation must use consistent frontend and backend rules:

- exactly four boundaries;
- finite integer bpm values;
- strictly increasing values;
- at least 5 bpm between adjacent boundaries;
- all boundaries from 40 through 260 bpm, inclusive; and
- `usage` must be `fallback` or `always`.

Use shared constants for frontend validation, backend validation, and the zone
builder:

```text
minimum boundary: 40 bpm
maximum boundary: 260 bpm, inclusive
minimum adjacent-boundary gap: 5 bpm
slider visual minimum: 30 bpm
slider visual maximum: 270 bpm
```

The visual track extends beyond both handle limits so the first and open-ended
fifth zones remain visible even when a handle is at 40 or 260 bpm. Upstream
starts the slider at `75` while also using `75` as the first default boundary,
which makes the first visual segment zero-width and prevents a moved handle from
returning cleanly to its default. The integrated zone builder must accept 260 as
an inclusive upper boundary so its validation matches the API and slider.

Malformed stored JSON or unsupported versions fall back to the version-1
defaults and emit a diagnostic message. Invalid save requests return an error
without changing the stored value.

### Preference Save Behaviour

The zone editor edits only local boundary drafts. Pressing Save:

1. validates the boundaries in the frontend;
2. sends the draft boundaries with the confirmed source policy as one complete
   preference object;
3. waits for the backend response;
4. updates the Zustand state with the confirmed normalized value; and
5. closes the dialog only after success.

On failure, the previous effective preferences remain active, the dialog stays
open, and the user sees a localized error. Disable the dialog controls while
the save is in flight. A boundary reset does not change the source policy.

### Chart Source Behaviour

The usage policy is presented on both the Heart Rate line chart and Heart Rate
Zone Time chart as one synchronized `FIT`/`Custom` zone-source choice. `FIT`
maps to stored `fallback` behaviour and `Custom` maps to stored `always`
behaviour. Changing the choice on either chart applies optimistically to both
charts and persists immediately. If saving fails, restore the confirmed source
and show a localized error.

When both sources are usable for the selected activity, render an interactive
segmented control. When only one source is usable, render a static source label.
Tooltips explain that FIT totals are preferred when compatible, FIT boundaries
are used for record-based fallback calculation, and Custom always calculates
from recorded heart rate. The same source controls line colouring and zone time
so the charts cannot silently use different zone definitions.

### Existing Browser Settings

The current presentation preferences remain in `localStorage`:

- theme;
- language;
- distance unit;
- time format;
- map style;
- graph smoothing; and
- overview-table day count.

Supporter and donation settings already use DuckDB. Moving the remaining
presentation preferences is deferred because doing so changes them from
browser-specific to deployment-wide and requires a separate startup and
migration design.

Local `main` has no existing manual-zone preference, so no mandatory data
migration is required for this feature. The upstream-only `hrZoneBounds`
`localStorage` field is not treated as authoritative in the private integration.

## Zone Selection Policy

Resolve the effective boundaries for each selected activity using the following
matrix:

| Manual-zone usage | Usable FIT bounds | Effective bounds | Source |
| --- | --- | --- | --- |
| `fallback` | yes | FIT-derived bounds | `fit` |
| `fallback` | no | manual bounds | `manual` |
| `always` | yes | manual bounds | `manual` |
| `always` | no | manual bounds | `manual` |

Use a pure resolver that returns both boundaries and provenance:

```ts
export type HeartRateZoneSelection = {
  boundsBpm: number[];
  source: "fit" | "manual";
};
```

The source is required for data correctness. Boundary values alone cannot prove
whether FIT aggregate totals were calculated against the same thresholds.

The resolver runs only after database preferences have loaded. During the
normal startup path, preference loading is awaited before the Dashboard becomes
interactive. If loading fails, render other activity charts normally but omit
heart-rate-zone colouring and the zone-time chart because the saved policy is
unknown. Keep the manual-zone controls disabled and expose a retry action.

## Time-in-Zone Semantics

FIT `time_in_zone_s` totals belong to the FIT file's configured boundaries.
They are compatible only when the effective source is `fit`, the raw aggregate
array contains finite non-negative values, its length equals the selected bound
count plus one, and its sum is greater than zero. Bucket padding or truncation
must not be used to establish compatibility.

FIT boundary values are transition points: a value equal to a boundary starts
the following bucket. For example, a FIT boundary of 98 bpm ends the lower
bucket at 97 bpm and starts the next bucket at 98 bpm. Configured manual values
remain inclusive upper bounds, so a manual boundary of 98 bpm includes 98 bpm
in the lower zone. Zone colouring and record-based zone-time calculation must
use the semantics of the selected source.

| Effective source | FIT aggregate totals | HR samples | Zone-time behaviour |
| --- | --- | --- | --- |
| FIT | compatible | any | use FIT totals |
| FIT | missing or incompatible | present | calculate from samples using FIT bounds |
| FIT | missing or incompatible | absent | hide zone-time chart |
| manual | any | present | calculate from samples using manual bounds |
| manual | any | absent | hide zone-time chart |

Manual mode must never reuse or relabel FIT aggregate buckets. When
recalculation is possible, use the existing one-second `analysisRecords` stream
instead of the normal 10-second chart stream. Build an active-time timeline with
the existing timer metadata so reliable stopped intervals are excluded, then
accumulate each sample interval into the selected zone. Use the normal chart
records only as a fallback if the one-second stream is unavailable. Display
smoothing must not affect classification or accumulated duration.

This rule affects only the zone-time chart and zone colouring. Existing
availability behaviour remains unchanged for the heart-rate line chart,
heart-rate drift, scatter plots, and other sample-dependent insights.

## User Interface Design

### Settings Panel

Keep every existing Settings control and add a Manual heart-rate zones section
containing:

- a `Heart Rate Zones` button; and
- no separate usage-policy controls.

The manual-zone editor remains available in fallback mode because its values are
used for FIT files without zone boundaries.

### Zone Editor

Adapt the upstream five-zone slider dialog rather than copying it unchanged.
The dialog includes:

- four boundary handles;
- coloured zone segments;
- live zone range labels;
- a Reset to defaults action that confirms before replacing the boundary
  drafts;
- Save and Cancel/Close actions;
- pointer interaction;
- keyboard-operable handles with appropriate slider semantics; and
- localized accessible labels.

Use the existing heart icon component rather than adding a separate inline icon
when practical.

English display copy uses Canadian spelling, including `Customise`. Existing
upstream code or translation identifiers do not need to be renamed solely to
change spelling style.

## Frontend Data Flow

1. The Zustand store starts with `idle`, `loading`, `ready`, or `error`
   preference status and version-1 defaults that are not yet applied to charts.
2. After unlock or authentication establishes the API session, the application
   loads preferences alongside the normal dashboard refresh and awaits both
   before showing the normal Dashboard state.
3. A successful response sets the confirmed database value and marks the
   preference state `ready`.
4. A failed response marks the state `error`, leaves manual controls disabled,
   omits zone-dependent rendering, and exposes a retry action without blocking
   unrelated charts.
5. `Dashboard` obtains FIT-derived bounds from the selected activity metadata.
6. Once preference state is `ready`, a pure resolver combines FIT bounds with
   the stored manual policy.
7. `Dashboard` passes the effective boundaries and source to
   `ActivityInsights` while retaining all existing chart props.
8. `ActivityInsights` exposes the synchronized source control on both HR
   charts, plus static source indicators when only one source is usable.
9. `ActivityInsights` builds heart-rate zones from the effective boundaries.
10. The source determines whether FIT aggregate zone totals are compatible or
    record-level recalculation is required.

Handle preference-load failure separately from the activity refresh rather than
allowing one rejecting combined promise to discard an otherwise successful
authenticated Dashboard load.

## Local Graph Preservation Rules

The upstream `Dashboard.tsx` conflict references an older `detail-grid`,
`ActivityChart`, and narrower `ActivityInsights` interface. Do not accept that
structure.

The integrated `Dashboard` must retain:

- `activity-visual-grid`;
- route-aware map display;
- `selectedActivity` and `analysisRecords` inputs;
- time/distance x-axis selection;
- FIT zone metadata;
- telemetry zoom state;
- lap timestamps;
- graph smoothing;
- timer metadata; and
- all current insight charts and ordering.

Only the effective heart-rate boundaries and their provenance are added to that
flow.

The Settings conflict must similarly retain the current icon catalogue,
language support, map controls, graph smoothing, supporter controls, storage
information, and blacklist controls while adding the manual-zone section.

## Expected Implementation Areas

### Backend

- `src-tauri/src/database.rs`
  - Reuse `get_setting` and make `set_setting` replacement transactional; add
    no new table.
- `src-tauri/src/tauri_app.rs`
  - Add typed get/set commands and register them with the invoke handler.
- `src-tauri/src/server.rs`
  - Add typed GET/POST handlers and routes for the Docker/web runtime.

### Frontend

- `src/lib/api.ts`
  - Add Tauri/HTTP preference methods and shared response types.
- `src/stores/settingsStore.ts`
  - Add manual bounds, usage, explicit load status, asynchronous load/retry,
    confirmed boundary saves, and immediately persisted source changes with
    optimistic rollback.
  - Do not include the new durable settings in the existing localStorage
    serializer.
- `src/lib/hrZones.ts` and/or `src/lib/zones.ts`
  - Centralize defaults, validation, and effective-source resolution.
- `src/components/SettingsPanel.tsx`
  - Integrate the boundary editor and reset confirmation without a separate
    usage-policy control.
- `src/components/Dashboard.tsx`
  - Resolve FIT versus manual bounds and pass source-aware selection to charts.
- `src/components/ActivityInsights.tsx`
  - Make aggregate time-in-zone reuse source-aware and calculate manual zone
    time from one-second `analysisRecords` with active-time handling.
  - Expose the synchronized FIT/Custom source control on both HR charts and a
    calculated-source tooltip on the Power line chart.
- `src/styles.css`
  - Adapt upstream dialog styles to the current settings and responsive layout.
- `src/i18n/*.json`
  - Merge upstream zone-editor strings and add chart-source, tooltip,
    save-error, and accessibility strings.

## Implementation Slices

### 1. Merge Upstream and Establish the Structural Baseline

- Merge `upstream/main` into the working branch.
- Accept the upstream `0.4.0` version changes.
- Resolve `src/i18n/en.json` with local values taking precedence for all
  existing keys; add only upstream keys that do not already exist locally.
- Resolve other translation conflicts by retaining all local keys and values
  while adding genuinely new upstream keys.
- Preserve the local Dashboard and Settings structures.
- Review every automatic merge touching zone helpers, the settings store, or
  CSS before proceeding.

Completion condition: upstream history and version changes are present, no local
graph or settings capability has been removed, and the working tree has no
unresolved conflict markers.

### 2. Add Durable Backend Preferences

- Define versioned request/response types.
- Add DuckDB serialization and validation around the existing settings table.
- Make setting replacement transactional.
- Add Tauri commands.
- Add Docker/web routes.
- Add frontend API wrapper methods.

Completion condition: both runtime paths can load defaults, save a valid value,
reload it, and reject invalid values.

### 3. Extend the Frontend Settings State

- Add manual bounds, usage, `idle`/`loading`/`ready`/`error` load state, and
  save-error state.
- Load the database-backed preference after authentication and await it before
  normal Dashboard rendering.
- Disable manual controls until loading succeeds and provide a retry after
  failure.
- Keep browser-persisted presentation settings unchanged.
- Keep confirmed boundaries active until a boundary save succeeds; apply source
  changes optimistically and restore the confirmed source if persistence fails.

Completion condition: refresh and browser-storage clearing do not remove the
manual preferences.

### 4. Integrate the Manual-Zone User Interface

- Port and adapt the upstream slider dialog.
- Add synchronized chart-level FIT/Custom source controls with explanatory
  tooltips and immediate persistence.
- Confirm before Reset replaces the boundary drafts.
- Fix slider range and validation consistency.
- Add keyboard and accessible-label support.
- Merge and add localized copy.
- Preserve graph smoothing and all other existing Settings controls.

Completion condition: the user can edit, reset, save, and reload the manual
configuration with clear feedback on success or failure.

### 5. Add Source-Aware Zone Selection

- Add the pure FIT/manual selection resolver.
- Use it in `Dashboard`.
- Pass effective bounds and source into `ActivityInsights` without changing the
  local graph structure.

Completion condition: the four policy/FIT-availability combinations match the
selection matrix.

### 6. Make Zone-Time Display Source-Aware

- Reuse FIT totals only for a compatible FIT selection.
- Recalculate from one-second analysis records for manual selections.
- Recalculate for FIT selections when FIT totals are missing or incompatible,
  using the same one-second active-time path.
- Hide the zone-time chart only when the selected boundaries cannot be paired
  with compatible totals or record samples.
- Leave other HR chart visibility rules unchanged.

Completion condition: no FIT aggregate total is displayed under manual zone
labels.

### 7. Review, Integrate, and Deploy

- Inspect the complete diff on the working branch.
- Commit the scoped merge and implementation changes.
- Fast-forward local `main` to the completed integration branch.
- Run the normal Docker rebuild/deploy from local `main` using
  `docker/docker-compose-build.yml` and the local override.
- Smoke-test the deployed application on port `8088`.
- Push local `main` to the private `origin` only after validation.

Do not run broad Rust/Tauri tests by default. If a targeted test is specifically
needed, use the constrained `fit-dashboard-rust-dev` container and stop if it
begins a cold rebuild of heavy native dependencies such as `libduckdb-sys`.

## Validation Plan

### Preference Persistence

- First run with no stored preference returns version-1 defaults.
- Valid custom boundaries survive application and browser restarts.
- Clearing browser site data does not remove the database preference.
- A Docker rebuild using the preserved data bind mount retains the preference.
- The preference is loaded only after the API session is established.
- Manual controls cannot overwrite stored preferences before the initial load
  completes.
- A load failure disables zone-dependent rendering and can be retried without
  blocking unrelated activity charts.
- Invalid, unsorted, duplicated, out-of-range, or wrong-length boundaries are
  rejected.
- A simulated interruption of preference replacement retains the old complete
  value rather than deleting the row.
- An unsupported stored version falls back safely.
- A failed boundary save leaves the confirmed boundaries and policy active.
- A failed source save restores the confirmed source while preserving bounds.
- A second preference save is blocked while the first is in flight.

### Selection Matrix

- FIT bounds plus `fallback` uses FIT bounds.
- No FIT bounds plus `fallback` uses manual bounds.
- FIT bounds plus `always` uses manual bounds.
- No FIT bounds plus `always` uses manual bounds.
- Changing the chart-level source updates both displayed chart colouring and
  zone-time bars without changing the imported activity metadata.

### Zone-Time Data

- Compatible FIT bounds and totals display the FIT totals in fallback mode.
- FIT bounds without totals recalculate from record samples.
- Manual fallback without FIT bounds recalculates from record samples.
- Always-manual mode recalculates even when FIT aggregate totals exist.
- Recalculation uses one-second analysis records and reliable active-time
  intervals rather than the 10-second display stream.
- Manual mode without HR samples does not display misleading FIT totals.
- FIT mode without HR samples can still display compatible FIT aggregate totals.

### Regression Coverage

- Heart-rate line chart availability remains record-data-driven.
- Heart-rate drift availability and calculations are unchanged.
- Power-zone boundaries and zone-time bars are unchanged.
- Time/distance axes, zoom synchronization, lap markers, graph smoothing, map
  layout, and chart ordering are unchanged.
- Existing Settings values still hydrate from browser storage.
- Supporter and donation state still load from DuckDB.
- Existing local English translations remain unchanged except for deliberate,
  reviewed edits required by this feature.
- Both Tauri and Docker/web API paths compile.
- The optimized Docker build and deployment complete successfully on local
  `main`.

### Automated Coverage

- Add a lightweight frontend test script, following the existing compiled
  TypeScript script pattern, for preference saving, boundary validation,
  policy/FIT selection,
  aggregate compatibility, and record-based zone accumulation.
- Add focused backend tests for JSON serialization, default loading, validation,
  transactional replacement, and invalid stored versions.
- Keep the deployed scenario checks above as manual smoke tests; they do not
  replace the pure-logic and persistence tests.

## Acceptance Criteria

- The upstream `v0.4.0` commits are present in local integration history.
- No existing local graph or Settings feature is lost.
- FIT-derived heart-rate boundaries remain the default when available.
- Manual boundaries are used as a fallback when FIT boundaries are absent.
- The user can choose to use manual boundaries for every activity.
- The synchronized chart-level FIT/Custom control applies immediately on both
  HR charts and persists in DuckDB.
- Manual-zone preferences are stored in DuckDB and survive browser-storage
  clearing.
- Preference replacement is transactional.
- Manual selections recalculate zone time from one-second active-time record
  samples.
- FIT aggregate zone totals are used only with compatible FIT-derived bounds.
- FIT transition values are classified into the following bucket, while manual
  boundaries remain inclusive upper bounds.
- HR charts remain hidden when their required underlying data is unavailable.
- English user-facing copy follows Canadian spelling.
- The completed integration builds and deploys successfully from local `main`.

## Deferred Work

- Moving presentation preferences from browser storage into DuckDB.
- A formal split between browser-specific, deployment-wide, and future
  user-account preferences.
- Multiple named manual heart-rate profiles.
- Sport-specific heart-rate profiles.
- Manual power-zone editing.
- Exporting or importing preference profiles independently of the database.
