# Multisport Activity Support

## Status

Design and first-pass implementation specification updated by the 15 July 2026
[implementation investigation](multisport-implementation-spike.md). The product
decisions were accepted on 15 July 2026 and are implemented by the associated
feature branch.

## Problem

FIT Dashboard currently imports an activity file as one activity. Garmin
multisport files can represent one parent activity with multiple sessions or
legs, for example bike, transition, run, transition, bike. Flattening these into
one normal activity can make the activity name, map, charts, summary metrics,
filters, and sport-specific calculations misleading.

The current parser already reads `record`, `session`, and `lap` messages, but it
does not retain a first-class FIT activity summary or a list of session
summaries. Session fields are folded into one metadata object, records are stored
against only an `activity_id`, laps are stored in activity metadata JSON, and the
UI presents one activity row. There is no first-class sub-activity or leg view.

## Goals

- Detect FIT multisport activities during import.
- Preserve the parent activity and each FIT session as a child leg.
- Keep transitions as child legs, but visually de-emphasize them.
- Let users view either the whole activity or one selected leg.
- Scope stats, maps, charts, laps, and calculations to the selected view.
- Prevent child legs from being double-counted in overview totals.
- Keep existing single-sport activity behaviour unchanged.

## File Format Scope

First-pass multisport support is FIT-only.

Garmin Connect exports the multisport parent activity as a FIT file. When an
individual multisport leg is selected in Garmin Connect, downloading FIT still
returns the same full parent multisport FIT payload. In the inspected sample, FIT
files downloaded from each selected leg had different Garmin activity-id
filenames but identical file hashes and identical parent multisport content.

Garmin Connect can export selected legs as TCX or GPX, but those files represent
only that selected leg, not the multisport parent. TCX preserved the full selected
leg duration in the inspected transition export. GPX preserved only the GPS track
portion of that selected leg and omitted an initial no-GPS portion. Therefore,
this feature does not attempt to support parent multisport GPX or TCX imports.

Existing single-sport GPX and TCX import behaviour is unchanged. A separate TCX
distance issue was filed as #29 and is outside this multisport scope.

## Non-Goals

- Splitting a multisport FIT file into unrelated standalone activities.
- Supporting manual editing of leg boundaries in the first implementation.
- Supporting multisport GPX or TCX imports.
- Rewriting all chart and statistics code in one step if a narrower MVP can
  preserve correctness.
- Adding support for unrelated non-activity FIT file types.

## Before / After Implementation Summary

### Database

Before:

- `activities` stores every import as one top-level activity.
- `records` rows are linked only by `activity_id`.
- Laps are stored inside activity `metadata_json`.
- `delete_activity` removes `records` and then the activity row.

After:

- `activities` remains the parent table, with `activity_kind` (new column)
  distinguishing `single` from `multisport_parent`.
- `records` keeps `activity_id` and gains nullable `segment_index` (new column) for
  multisport record scoping.
- `activity_segments` (new table) stores one row per FIT session/leg.
- Laps remain in `metadata_json.laps` for the first pass, with added segment
  assignment fields when known. `activity_laps` is deferred/future scope.
- Insert, rollback, and delete paths treat records, segment-tagged lap metadata,
  segments, and the parent activity as one unit.

### Parser

Before:

- `ParsedActivity` exposes one activity summary and one flat record list.
- FIT `Session` fields are overwritten as the parser sees each session, so
  multisport files keep only the last session's summary values.
- FIT `Lap` details are collected into activity metadata JSON, not typed domain
  structures.
- FIT `Activity` message fields are not preserved as first-class parent summary
  data.

After:

- Parser/domain structs (new/expanded) preserve the FIT `activity` message, all
  `session` messages, all `lap` messages, records, and assignment diagnostics.
- Session order and lap order are retained before conversion to database rows.
- Segment boundaries are derived from `session.start_time`, adjacent session
  starts, and duration fields rather than blindly trusting `session.timestamp`.
- Existing single-sport parsing still produces the same parent activity,
  records, and metadata-backed laps.

### Import Lifecycle

Before:

- Duplicate checks run before import: blacklist, file hash, then exact start/end
  times.
- A successful import writes one activity row and its records.
- If file persistence fails after DB insert, failed-import cleanup calls the
  existing delete path, which removes records and then the activity row.
- Deleting an activity removes records and the activity row, then adds the file
  hash to the blacklist.
- The current manual reimport workflow is to delete the activity, clear
  blacklisted hashes in Settings, then upload the file again or run Sync while
  the source FIT file is still present.

After:

- Duplicate checks remain unchanged: blacklist, file hash, then exact start/end
  times.
- A successful multisport import writes the parent activity, `activity_segments`
  rows (new), segment-tagged laps in `metadata_json.laps`, and records with
  `segment_index` (new column).
- If file persistence fails after DB insert, failed-import cleanup removes all
  rows for that activity: records, `activity_segments`, then the parent activity
  row. Segment-tagged lap metadata is removed with the parent row.
- Deleting an activity removes all rows for that activity in the same order, then
  adds the file hash to the blacklist.
- The manual reimport workflow remains unchanged. This issue does not add an
  in-place reimport, replacement, or backfill workflow.

### API and Tauri IPC

Before:

- Web uses `GET /api/records/{activity_id}` for all activity records.
- Desktop/Tauri uses `get_records(activity_id, resolution_ms)`.
- There are no first-class segment or lap endpoints/commands.

After:

- Web keeps the existing `GET /api/records/{activity_id}` route and adds
  optional `segment_index` filtering (new query behaviour).
- Desktop/Tauri `get_records` gets matching optional `segment_index` filtering (new
  command argument/behaviour).
- `GET /api/activities/{activity_id}/segments` (new endpoint) and matching Tauri
  command list activity segments.
- First-pass laps stay in activity metadata. The existing activity payload carries
  `metadata_json.laps`, and child views filter those laps by selected segment.
- Web and desktop adapters expose the same parent/segment semantics to the
  frontend store.

### Frontend Store and UI

Before:

- `src/stores/activityStore.ts` stores one selected activity and one record
  array for the whole activity.
- Detail title, sport, times, distance, session statistics, laps, charts, maps,
  actions, and exports read the selected activity and records.
- The activity list has one row per imported activity.

After:

- The store uses an explicit parent-or-segment selection containing the parent
  `activity_id` and optional stable `segment_index`.
- A derived child display view supplies segment title, sport, time, distance,
  session metadata, laps, and normalized records. Record filtering alone is not
  sufficient.
- The activity list adds expandable child rows for leg selection.
- The Individual tab keeps its existing layout and renders the derived parent or
  child view.

## FIT Observations

An anonymized Garmin multisport sample was inspected for design guidance. It had:

- One FIT `activity` message with `type = auto_multi_sport`.
- Five FIT `session` messages.
- Twenty-five FIT `lap` messages.
- A mix of indoor cycling, transition, running, transition, and indoor cycling
  legs.
- GPS records only in the transition and running legs. The indoor cycling legs
  had no GPS records.
- Heart-rate records throughout the legs.
- Power records in the cycling legs and also in the running leg for this sample.
- Transition sessions had `sport = transition` and `sub_sport = generic`. They
  included duration, distance, average speed, total ascent/descent, calories,
  average/max heart rate, generic cadence, start/end positions, and GPS bounds.
  They did not include average power or normalized power.
- Transition records had the same basic movement streams expected from a
  pedestrian GPS segment: timestamp, distance, speed, altitude/elevation, heart
  rate, cadence, and GPS for most or all records. In the inspected sample,
  transition record coverage was:
  - T1: 75 records, 75 distance, 74 speed, 75 altitude, 75 heart rate, 75
    cadence, 55 GPS, 0 power.
  - T2: 46 records, 46 distance, 45 speed, 46 altitude, 46 heart rate, 46
    cadence, 46 GPS, 0 power.

Important parser nuance: in this sample, the FIT `session.timestamp` and
`lap.timestamp` values were not usable as segment end times. They repeated the
parent activity timestamp. The parser must not assume `timestamp` is the end of a
session or lap. Use `start_time` plus `total_timer_time` or `total_elapsed_time`,
and use adjacent session starts as assignment boundaries when available.

Garmin Connect presentation reference:

- The multisport parent shows whole-activity summary metrics such as distance,
  duration, map, and calories.
- The parent also shows a leg list. Each leg shows activity type, distance, and
  time, plus sport-specific summary fields where available, such as pace for
  running and power/watts for cycling.
- Transition legs are displayed as activity legs. A transition detail view can
  show distance, time, average speed, total ascent, calories, map, elevation,
  heart-rate, and performance-condition graphs when those streams exist.

## Data Model

Keep `activities` as the parent activity table. Add child segments rather than
creating fake child activities with duplicate file hashes.

These schema additions are compatible with existing databases and single-sport
data. The first implementation includes an automatic additive migration; a
fresh-database-only release is no longer an option for the persistent local
deployment.

Compatibility option:

- A new app binary or Docker container automatically migrates an old DuckDB file
  during normal startup/schema initialization.
- Users do not need to wipe the database or run SQL manually.
- Add the new `activity_kind` and `records.segment_index` columns with `ALTER TABLE
  ... ADD COLUMN IF NOT EXISTS` during `database.rs::init_schema`, and create the
  child tables/indexes with `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT
  EXISTS`.
- Existing rows remain valid with `activity_kind = 'single'` and
  `records.segment_index = NULL`.
- If the database does not backfill the default for existing rows, explicitly run:

```sql
UPDATE activities
SET activity_kind = 'single'
WHERE activity_kind IS NULL;
```

Existing imported rows migrate safely as single activities. Previously imported
multisport payloads still require reimport because their folded metadata cannot
recover every leg summary.

### activities

Add fields:

- `activity_kind VARCHAR DEFAULT 'single'`
  - `single`: current behaviour.
  - `multisport_parent`: a parent activity with child segments.

Do not add a separate parent summary column for the MVP. Extend the existing
parent activity `metadata_json` instead. For multisport parents it should store:

- Parent-level FIT activity fields.
- Raw session and lap summary snapshots needed for troubleshooting.
- Segment assignment diagnostics.

Metadata compatibility rules:

- Keep existing top-level metadata keys and shapes unchanged. Current frontend
  code reads `heart_rate_zone_bounds_bpm`, `file_id`, `activity_metrics`,
  `session`, and `laps` from `metadata_json`.
- Do not change `session` from the current single-session summary object to an
  array. Multisport session data should use a new namespaced object instead.
- Do not change `laps` from the current array shape. First-pass lap display
  remains backed by `metadata_json.laps`; debug/source lap snapshots can live
  under the new multisport namespace.
- Add multisport-specific metadata under `metadata_json.multisport`, for example
  `multisport.activity`, `multisport.sessions`, `multisport.laps`, and
  `multisport.assignment`.
- Keep the multisport metadata concise. `list_activities` returns
  `metadata_json` for every activity, so this should store summaries and
  diagnostics, not full record streams or large raw FIT payloads.

For multisport parents:

- `sport` should be `multisport`.
- `activity_name` should not be derived from GPS from only one child leg.
- `duration_s` should use FIT activity `total_timer_time` when present, then
  fall back to the sum of session timer durations.
- `distance_m` should use FIT activity total distance when present, then fall
  back to the sum of session distances.

### activity_segments

Create a new table:

```sql
CREATE TABLE IF NOT EXISTS activity_segments (
    activity_id BIGINT NOT NULL,
    segment_index BIGINT NOT NULL,
    segment_type VARCHAR NOT NULL,
    name VARCHAR NOT NULL,
    sport VARCHAR,
    sub_sport VARCHAR,
    start_ts_utc TIMESTAMP,
    end_ts_utc TIMESTAMP,
    timer_duration_s REAL,
    elapsed_duration_s REAL,
    distance_m REAL,
    record_distance_offset_m REAL,
    start_latitude DOUBLE,
    start_longitude DOUBLE,
    metadata_json VARCHAR,
    PRIMARY KEY (activity_id, segment_index)
);
```

Recommended `segment_type` values:

- `sport`
- `transition`

`transition` is a supported child segment type for multisport activities. It is
not treated as a standalone training sport for overview counts, but it should be
selectable and visible as a leg of the parent activity.

The composite primary key prevents duplicate segment rows. Segment index is the stable leg identifier within an activity and remains stable
when the same FIT file is deleted and imported again. Retain the original
zero-based FIT session message index separately in diagnostic metadata.

### records

Add a nullable `segment_index`:

```sql
ALTER TABLE records ADD COLUMN IF NOT EXISTS segment_index BIGINT;
CREATE INDEX IF NOT EXISTS idx_records_activity_segment_time
    ON records(activity_id, segment_index, timestamp_ms);
```

Existing single-sport records can keep `segment_index = NULL`. Multisport
records should keep their parent `activity_id` and receive the matching
`segment_index`.

The FIT record distance field is cumulative across the parent activity in the
inspected multisport files. For child record responses, subtract the segment
`record_distance_offset_m` from each valid cumulative distance. The offset is
the last valid parent record distance before the segment start, or zero for the
first segment. This retains distance travelled between the final pre-start
sample and the first in-segment sample.

### laps

The existing importer stores laps inside `metadata_json`. For the first pass, keep
that storage model and add segment assignment fields to the existing lap metadata
objects when known. Parent views read all metadata-backed laps. Child views filter
`metadata_json.laps` by selected `segment_index`. Ambiguous laps remain visible
only on the parent view.

Future scope: add a first-class lap table if metadata-backed laps become too
awkward or if a general lap API is added for all activity types:

```sql
CREATE TABLE IF NOT EXISTS activity_laps (
    activity_id BIGINT NOT NULL,
    segment_index BIGINT,
    lap_index BIGINT NOT NULL,
    start_ts_utc TIMESTAMP,
    end_ts_utc TIMESTAMP,
    timer_duration_s REAL,
    elapsed_duration_s REAL,
    distance_m REAL,
    avg_speed_m_s REAL,
    max_speed_m_s REAL,
    avg_heart_rate BIGINT,
    max_heart_rate BIGINT,
    avg_cadence BIGINT,
    max_cadence BIGINT,
    total_ascent_m REAL,
    total_descent_m REAL,
    total_calories BIGINT,
    metadata_json VARCHAR,
    PRIMARY KEY (activity_id, lap_index)
);
```

Indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_activity_laps_segment
    ON activity_laps(activity_id, segment_index, lap_index);
```

`lap_index` is global FIT lap message order within the parent activity, not a segment-local display number. Segment views can derive a
separate segment-local lap number after filtering by `segment_index`.

### Lifecycle

The database currently deletes only `records` and `activities` for an activity.
With first-pass segment support, activity write paths need to treat the parent,
segments, segment-tagged lap metadata, and records as one unit:

- Insert parent activity, child segments, segment-tagged lap metadata, and
  records in one transaction.
- If an import fails before commit, roll back the transaction.
- If a caller cannot use the shared transaction boundary, that path must run the
  same cleanup explicitly: delete records, segments, then the parent activity.
- On user deletion, delete child rows before the parent activity. The deletion
  transaction should delete in this order: `records`, `activity_segments`, then
  `activities`. This avoids orphaned telemetry rows even if foreign keys are not
  enforced. Segment-tagged lap metadata is removed with the parent activity row.
- Keep single-sport cleanup unchanged except that empty child tables should not
  leave orphans. Future `activity_laps` work must add lap-row cleanup to the same
  transaction.

## Import and Parser Rules

### Parser Extraction Prerequisites

Before detection and storage can be implemented, the FIT parser needs to preserve
more source data than it currently exposes through `ParsedActivity`:

- FIT `activity` message fields, including `type`, `total_timer_time`, and
  activity-level distance when present.
- Every FIT `session` message in message order, including `sport`, `sub_sport`,
  `start_time`, `total_timer_time`, `total_elapsed_time`, distance, heart-rate,
  cadence, calories, transition indicators, `first_lap_index`, and `num_laps`. The current parser overwrites
  session-scoped local variables on each `Session` message, so multisport files
  lose all but the last session's summary fields unless this is changed.
- Every FIT `lap` message in message order, including `sport` and `sub_sport`
  when present.
- Segment assignment metadata, including unassigned and overlapping record/lap
  counts.

This should be represented in parser/domain structs first, then converted into
database rows. Previously imported metadata should not be assumed to contain
enough session detail for reconstruction.

### Detection

Treat a FIT file as multisport only when it has at least two meaningful sessions
with distinct start times and at least one supporting signal:

- FIT `activity.type` is `auto_multi_sport`;
- at least one session is a transition;
- sport/sub-sport changes between adjacent non-transition sessions.

Do not use `auto_multi_sport` by itself. Four inspected ordinary activities
had that type but only one session. Also retain the multi-session fallback: one
inspected manual activity had distinct cycling and running sessions without the
automatic multisport activity type.

A session is meaningful for this rule when it has a valid start time and at
least one positive timer duration, elapsed duration, or distance. Record the
detection reason in import diagnostics.

### Segment Ordering

Order segments by:

1. `session.start_time` when available.
2. FIT message order as fallback.

Each segment gets a stable `segment_index` starting at 1.

### Segment Boundaries

For each session:

- `segment_start = session.start_time`.
- `segment_timer_end = segment_start + session.total_timer_time` when available.
- `segment_elapsed_end = segment_start + session.total_elapsed_time` when
  available.
- `segment_assignment_end`:
  - next session `start_time` when available;
  - otherwise `segment_elapsed_end`;
  - otherwise `segment_timer_end`;
  - otherwise the parent activity end.

Use half-open intervals `[start, end)` for assigning records and laps. This
prevents boundary samples from being double-counted.

Record/lap assignment intentionally uses the next session start before declared
duration-derived ends. That keeps all timeline samples inside a deterministic
segment when devices report timer or elapsed durations differently from the
record stream. The stored segment `timer_duration_s` and `elapsed_duration_s`
still come from the FIT session summaries. If records extend past
`segment_elapsed_end` or `segment_timer_end` before the next session starts,
count them in segment assignment diagnostics, but do not leave them unassigned
solely for that reason.

Do not use `session.timestamp` as the end time unless validation shows it is
later than `start_time` and consistent with the session duration.

### Record Assignment

Assign each `record` to matching segments by timestamp. If exactly one segment
assignment interval contains the record timestamp, use that segment. If more than
one interval matches, use the overlapping-record rule below.

If a record cannot be assigned:

- Keep it attached to the parent activity.
- Leave `segment_index = NULL`.
- Count unassigned records in import metadata.

If a record falls into overlapping segment intervals:

- Prefer the segment with the latest start time.
- Record the overlap count in import metadata.

### Lap Assignment

Assign each lap to a segment by:

1. The session's explicit `first_lap_index` and `num_laps` range, when valid.
2. Lap `start_time` inside a segment assignment interval.
3. If lap `start_time` is missing, use FIT message order and lap sport/sub-sport.
4. If still ambiguous, leave `segment_index = NULL` and keep the lap visible
   only in the parent view.

The explicit session lap ranges accounted for the laps in the inspected
multisport samples, so they are the preferred source rather than merely a
diagnostic field. As with sessions, do not assume `lap.timestamp` is a reliable
end time.

### Parent Metrics

The parent activity represents the whole multisport recording.

Parent duration priority:

1. FIT activity `total_timer_time`.
2. Sum of session `total_timer_time`.
3. Sum of session `total_elapsed_time`.
4. Existing record-span fallback.

Parent distance priority:

1. FIT activity total distance when available.
2. Sum of session distances, including transition session distance exactly as the
   FIT file reports it.
3. Existing record distance fallback.

Including transition distance keeps the parent summary aligned with the FIT
activity's whole-recording distance. Sport-specific distance summaries should be
read from the selected child segment instead.

Parent start/end:

- Start: earliest segment start, or earliest record timestamp.
- End: latest segment assignment end, or latest record timestamp.

Parent naming:

- Always use `Multisport` for the parent activity name.
- Do not reverse-geocode the parent from a child GPS leg.
- Child segment names carry the sport-specific context.

### Child Naming

Suggested generated names:

- `Bike 1`
- `T1`
- `Run`
- `T2`
- `Bike 2`

Rules:

- Use sport/sub-sport labels for sport legs.
- Use `T1`, `T2`, etc. for transitions.
- Number repeated sport legs.
- Keep raw FIT sport/sub-sport in metadata.
- Keep `transition` as `segment_type = transition`; do not convert it into a
  normal sport activity.
- Add translation keys for visible labels such as `Multisport`, `Entire
  Activity`, sport/sub-sport display names, and transition labels. Do not hardcode
  English-only UI strings.

## API Design

Add segment-aware APIs while preserving existing single-activity endpoints.

Recommended additions:

- `GET /api/activities`
  - Include `activity_kind`.
  - Include lightweight ordered child segment summaries for multisport parents
    so activity-list expansion does not create an N+1 request pattern.
- `GET /api/activities/{activity_id}/segments`
  - Returns ordered child segments.
- `GET /api/records/{activity_id}`
  - Preserve the existing route and parent behaviour.
  - Add optional `segment_index` query parameter, or add
    `GET /api/activities/{activity_id}/records` as a compatibility alias.
  - The implementation should extend the current `records_downsampled` query to
    conditionally filter by `segment_index` before downsampling.
  - Normalize cumulative record distance with the selected segment
    `record_distance_offset_m` before returning child records.
- First-pass laps remain in activity metadata. The frontend should filter
  `metadata_json.laps` by selected `segment_index` for child views. A dedicated
  laps endpoint is deferred until first-class `activity_laps` exists.

Tauri IPC must get matching command support, because the frontend uses Tauri
commands in desktop mode and HTTP endpoints in web mode. Add or update commands
such as `list_activity_segments` and `get_records` with the same parent and
`segment_index` semantics as the web API. First-pass lap filtering uses activity
metadata. The frontend `api`
adapter and activity store should expose segment-aware selection without making
web and desktop behaviour diverge.

Frontend state should keep one selected display row: either the multisport
parent or a child segment row. Child row selection should retain the parent
`activity_id` plus an optional selected `segment_index`. Use that stable
composite identity for record and lap APIs. URL/deep-link persistence is
deferred; when it is added, `?segment_index=<index>` is the recommended shape.

For the first pass, keep the Individual tab layout unchanged. Derive a complete
display activity from the parent-or-segment selection; do not scope only the
record array because summary fields, laps, actions, and charts also read the
selected activity. Do not add a separate detail-page selector or custom parent
layout in the first pass.

Do not expose child segments as unrelated top-level activity IDs unless the API
also marks them as children and prevents double-counting.

## UI Design

### Activity List

Target UX: show a multisport parent as an expandable row:

```text
v Multisport - 3h55m - 68.8 km - calories if available
    Bike 1 - 1h55m - 40.3 km - power/watts if available
    T1 - 4m52s - distance/calories if available
    Run - 52m45s - 8.1 km - pace if available
    T2 - 2m50s - distance/calories if available
    Bike 2 - 59m56s - 20.2 km - power/watts if available
```

Selection behaviour:

- Clicking the parent opens the whole activity with no segment selected.
- Clicking a child opens the same activity detail page scoped to that segment.
- Child rows should be indented and visually subordinate.
- Transition rows should be visible, selectable, and visually de-emphasized.

### Detail Page

First-pass UX: do not change the Individual tab layout. The activity list is the
only required place to choose between the parent and child legs.

When the parent is selected, the existing Individual tab should render the whole
activity using the same layout as any other activity. Summary stats, charts,
map, and laps use the full parent activity data. Sport-specific calculations
that require one coherent sport/output stream may be unavailable for the parent,
or may be limited to calculations that are valid on mixed-sport data.

When a child row is selected, the existing Individual tab should render the
selected leg using the same layout as any other activity. Summary stats, charts,
map, laps, and sport-specific calculations use only that segment's data.

Transition segment detail should also reuse the same Individual tab layout where
data exists. Treat transitions as generic GPS movement segments, similar to a
walking/running-style activity for display purposes but without assuming
running-specific fields. Show generic fields and streams such as distance,
duration/time, speed or pace, total ascent, calories, map, elevation, heart rate,
and cadence when available. Do not expect power or normalized power on transition
segments, and hide or disable sport-specific calculations that do not apply.

Future enhancement: add a richer multisport parent view, detail-page segment
selector, per-leg summary strip, segment-coloured route overlays, or Garmin
Connect-style parent presentation after the first pass is working.

### Maps

For parent multisport view:

- Show all GPS records that exist.
- Do not imply indoor/no-GPS legs had GPS routes.
- Consider using subtle segment markers or segment colours once segment route
  rendering is available.

For child view:

- Show only the selected segment route.
- If the segment has no GPS, show the normal no-map state.

### Future Child-aware Filters

A later child-aware filter design can support:

- Filtering by `running` should match a multisport parent containing a running
  leg.
- Child segments should also be searchable/filterable as separate activity-list
  rows.
- When the parent is expanded, matching child rows should be emphasized.
- Child rows must not add to activity counts in overview totals.

The first implementation instead keeps global search and sport filters
parent-based. A multisport parent appears under `Multisport`; expansion exposes
all legs.

### Overview Totals

Overview totals should count parent activities only.

Rules:

- A multisport parent contributes one activity count.
- Parent duration and distance contribute to totals.
- Child segments do not contribute separately to global totals.
- Segment-level totals may be shown only in segment-specific drilldowns.

## Export and Compare

- Existing single-sport export and compare behaviour remains unchanged.
- Parent and child multisport export are deferred until segment selection,
  display metadata, and distance normalization are proven.
- Multisport compare behaviour is separately deferred.

## Compatibility and Migration

- Automatic additive migration is required in the first implementation. App
  startup/schema initialization migrates existing databases without a database
  wipe or manual SQL.
- Existing activities remain `activity_kind = single` and existing records
  remain `segment_index = NULL`.
- Additive columns required by a numeric rebuild are created before the rebuild
  check, the rebuild definitions preserve them, and the segment table and
  dependent indexes are created or re-asserted after any rebuild.
- Existing metadata stays valid because multisport data uses a new namespace.
- Previously imported multisport files still require manual reimport because the
  folded metadata cannot reliably reconstruct every leg summary.
- The current delete, clear-blacklist, upload/sync pathway remains the first-pass
  reimport workflow.

## MVP Scope

Recommended first implementation:

1. Extend parser/domain structs to capture FIT activity, all sessions, all laps,
   and segment assignment metadata.
2. Detect multisport FIT files conservatively.
3. Add automatic migration and store parent activity plus `activity_segments`.
4. Assign records and laps to segments and retain distance offsets.
5. Make insert, rollback, and delete transactional for the full activity unit.
6. Add matching web and Tauri support for segment summaries and records.
7. Add expandable activity-list child rows and make parent and children
   selectable.
8. Prevent overview double-counting.

The MVP should not add a separate detail-page segment selector. Searchable child
rows, child-aware global filters, URL/deep-link selection, export, compare, and
segment-coloured parent maps can follow later.

## Tests

Parser tests:

- Reject single-session files even when activity type is `auto_multi_sport`.
- Detect automatic and manual multi-session sport changes.
- Preserve all FIT session summaries instead of only the last session seen.
- Preserve FIT activity-level totals used for parent duration and distance.
- Import multiple sessions in stable order.
- Assign records by session `start_time` and duration/boundaries.
- Assign overlapping records to the matching segment with the latest start time
  and count the overlap in diagnostics.
- Do not use repeated or invalid `session.timestamp` as an end time.
- Prefer explicit session lap ranges, with timestamp assignment as fallback.
- Preserve transition sessions.
- Preserve indoor/no-GPS legs without borrowing GPS from another leg.

Database tests:

- Parent and child segment rows are stored correctly.
- The composite segment key prevents duplicate child rows for the same activity.
- Metadata-backed laps retain unique global lap indexes and segment assignment.
- Records receive expected `segment_index`.
- Activity deletion and import rollback remove records, laps, segments, and the
  parent in the documented cleanup order.
- Existing single-sport imports still work.
- Overview totals count parent multisport activities once.

API/UI tests:

- Parent activity view returns all records/laps.
- Segment view returns only selected segment records/laps and normalizes
  cumulative distance to the segment origin.
- Web API and Tauri IPC return matching segment, record, and lap data.
- Map state is correct for GPS and no-GPS segments.
- Sport-specific calculations are disabled for mixed parent view or scoped to a
  selected segment.
- Activity-list expansion selects parent and child rows without double-counting
  them in overview totals.
