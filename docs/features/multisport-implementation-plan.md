# Multisport Support Implementation Plan

## Status

First-pass implementation plan for issue #21, reconciled with the 15 July 2026
[implementation investigation](multisport-implementation-spike.md). The spike
records the accepted product defaults and the implementation follows this plan.
The product design is in [multisport-support.md](multisport-support.md).

## Implementation Principles

- Keep the first pass narrow: parent and child selections reuse the existing
  Individual tab layout.
- Put multisport selection in the activity list. Parent rows expand to child
  leg rows.
- Child rows appear on parent expansion. Child-aware global search and filtering
  are deferred until their Overview aggregation semantics are defined.
- Do not double-count child rows in overview totals.
- Preserve existing single-sport behaviour.
- Limit multisport support to FIT files. Garmin Connect FIT downloads from the
  parent or from selected legs can contain the same full parent multisport FIT
  payload. Garmin Connect TCX and GPX downloads from selected legs are
  leg-specific exports, not parent multisport exports, and stay out of scope for
  multisport detection.
- Include automatic additive migration in the first implementation so persistent
  databases survive an application rebuild.

## Upstream Baseline Used for Planning

### Backend

- `src-tauri/src/fit_parser.rs`
  - Parses `record`, `session`, and `lap` messages.
  - Session fields are stored in single local variables, so multiple sessions
    overwrite earlier session values.
  - Laps are collected into `metadata_json.laps`.
- `src-tauri/src/models.rs`
  - `ParsedActivity` has one flat activity summary and one flat record list.
  - `RecordPoint` has no segment identifier.
- `src-tauri/src/database.rs`
  - `activities` stores one row per imported file.
  - `records` stores telemetry rows keyed only by `activity_id`.
  - There is no `activity_segments` table.
  - There is no `activity_laps` table.
  - `delete_activity` deletes `records`, then `activities`.
  - `records_downsampled(activity_id, resolution_ms)` returns all records for
    one activity.
- `src-tauri/src/server.rs`
  - `GET /api/records/{activity_id}` returns downsampled activity records.
  - There are no segment or lap endpoints.

### Frontend

- `src/stores/activityStore.ts`
  - Stores one selected activity and one `records` array.
  - `selectActivity(activity)` fetches all records for `activity.id`.
- `src/components/Dashboard.tsx`
  - The sidebar renders one row per imported activity.
  - Sport/search/date/duration filtering is based on the activity list.
  - Activity details, charts, map, stats, and insights render from the selected
    activity and selected `records`.
  - The lap table is built from `selectedActivity.metadata_json.laps`.
- `src/components/ActivityInsights.tsx`
  - Existing upstream insights are telemetry charts, not persisted calculations.
  - There is no heart-rate drift feature in upstream at the time of this plan.

## Decisions For First Pass

### Migration Timing

Automatic additive migration is required in the first implementation. The local
deployment preserves its DuckDB database across container rebuilds, so a
fresh-database-only release is not acceptable.

Implementation requirements:

- Add `activity_kind`, `segment_index`, and the existing coordinate columns before
  the numeric rebuild check so a rebuild can copy them safely.
- Update numeric rebuild table definitions so they preserve the new columns.
- Create and re-assert the segment table and dependent indexes after any rebuild.
- Backfill existing activities as `single`; existing records remain unassigned.
- Require manual reimport only for already-imported multisport payloads, whose
  folded metadata cannot reconstruct every session.

### Lap Scope

First pass: keep laps in `metadata_json.laps` and add segment assignment fields
to those lap objects for multisport imports. Defer first-class `activity_laps`.

Current app support:

- Laps are supported in the UI today, but only through `metadata_json.laps`.
- Laps are not supported as database rows or API resources.

Implementation choice:

- Keep existing `metadata_json.laps` shape unchanged for compatibility.
- For single-sport activities, continue using existing metadata-backed laps.
- For multisport, add fields such as `segment_index`, `segment_type`, `sport`,
  and `sub_sport` to each lap metadata object when assignment is known.
- Parent view reads all `metadata_json.laps`.
- Child view filters `metadata_json.laps` by selected `segment_index`.
- Laps with unknown segment assignment remain visible only in the parent view.
- Do not add `activity_laps` or migrate all activity types to first-class laps in
  the first pass.

Deferred/future cleanup:

- Add `activity_laps` for first-class lap storage.
- Migrate all lap display to `activity_laps`.
- Add a general lap API for every activity type.
- Stop relying on `metadata_json.laps` for display after compatibility is proven.

### Child Row Naming and Editing

Child rows should have generated display names, not independent user-editable
activity names in the first pass.

Recommended generated names:

- Sport legs: use the same sport/sub-sport display logic as normal activities,
  but without location. For example, `Indoor Cycling`, `Running`, `Walking`,
  `Cycling`, or repeated labels such as `Indoor Cycling 2` when needed.
- Transition legs: `T1`, `T2`, etc.

Parent activity names remain user-editable through the existing rename path.

Do not add child rename support in the first pass because child rows are not
standalone activities and should not be updated by the existing
`renameActivity(activity_id, name)` endpoint. If editable child labels are later
needed, add a separate `activity_segments.display_name` or
`activity_segments.custom_name` field and a segment-specific rename endpoint.

### Parent Calculation Policy

Accepted first-pass behaviour:

- The parent shows whole-activity duration, distance, heart rate, elevation,
  calories, the complete map, laps, and neutral time-based telemetry.
- Mixed-sport parent views suppress pace, power, cadence, zone, training-load,
  VO2 max, and similar interpretations that assume one coherent sport/output
  stream.
- Selected sport legs use the normal sport-specific detail view with scoped
  summary metadata, laps, records, charts, and map.
- Transition legs reuse the detail view with the generic data streams available
  in that segment.
- If heart-rate drift is added later, keep it disabled on multisport parents and
  evaluate it only on eligible child legs.

## Build Sequence

### 1. Add Domain Types

Add typed parser/domain structures for:

- FIT activity summary.
- FIT session summary.
- FIT lap summary.
- Parsed segment.
- Parsed lap metadata with optional segment assignment.
- Parsed activity with optional segments and segment-tagged lap metadata.

Keep existing `ParsedActivity` behaviour for single-sport imports while expanding
it to carry child data.

Only FIT files participate in multisport detection and segment extraction. TCX and
GPX parsers keep their existing single-activity behaviour. Garmin Connect
leg-specific TCX/GPX exports should import as ordinary single activities, not as
multisport parents.

### 2. Preserve FIT Activity, Sessions, and Laps

Update `fit_parser.rs` to preserve:

- The FIT `activity` message.
- Every FIT `session` message in message order.
- Every FIT `lap` message in message order.
- Session and lap sport/sub-sport.
- Session and lap `start_time`, `total_timer_time`, and
  `total_elapsed_time`.
- Session `first_lap_index` and `num_laps`.

Do not rely on `session.timestamp` or `lap.timestamp` as an end time for
multisport assignment.

### 3. Detect Multisport

Require at least two meaningful sessions with distinct start times, plus at
least one of:

- FIT activity type `auto_multi_sport`;
- a transition session; or
- an adjacent sport/sub-sport change.

A meaningful session has a valid start and positive timer duration, elapsed
duration, or distance. This rejects the inspected single-session activities that
incorrectly carry `auto_multi_sport` while supporting a retained manual
cycling-to-running file. Record the detection reason in diagnostics.

### 4. Assign Records and Laps to Segments

Derive segment boundaries from session `start_time` and adjacent session starts.

Use half-open intervals `[start, end)` for assignment.

Record assignment:

- Assign each record to the segment interval containing its timestamp.
- If overlapping intervals exist, assign to the matching segment with the latest
  start time.
- Count unassigned and overlapping records in import diagnostics.

Lap assignment:

- Prefer the session `first_lap_index` and `num_laps` range.
- Fall back to lap `start_time` against segment intervals.
- Then use FIT message order and lap sport/sub-sport.
- If ambiguous, omit `segment_index` so the lap remains parent-only.

### 5. Add Schema and Migration Support

Add and migrate:

- `activities.activity_kind`;
- `records.segment_index`; and
- `activity_segments` keyed by `(activity_id, segment_index)`, including
  `record_distance_offset_m`.

Do not add `activity_laps` in the first pass. Update numeric rebuild table
definitions, then apply idempotent additive migration during schema
initialization.

### 6. Update Insert, Delete, and Rollback

Update insert flow in one transaction:

1. Insert parent activity and metadata-backed laps.
2. Insert segments and their record-distance offsets.
3. Insert records with `segment_index`.

Update delete and rollback flow:

1. Delete records.
2. Delete segments.
3. Delete parent activity.

Keep blacklist behaviour unchanged: user deletion still adds the file hash to the
blacklist after DB rows are removed.

Backend validation checkpoint:

- Multisport FIT import stores the parent activity, segments, segment-tagged lap
  metadata, and segment-scoped records.
- Deleting a multisport parent removes records, segments, and the parent row.
- Failed import rollback removes any partial child rows.
- Single-sport FIT, TCX, and GPX imports keep existing single-activity behaviour.

### 7. Add Segment APIs and Record Scoping

Web:

- Include lightweight ordered segment summaries in `GET /api/activities`.
- Add `GET /api/activities/{activity_id}/segments` for explicit refresh.
- Do not add a lap endpoint in the first pass; keep laps in activity metadata.
- Extend `GET /api/records/{activity_id}` with optional segment filtering.

Desktop/Tauri:

- Add matching command for segment list.
- Extend `get_records` with optional segment filtering.

Adapters:

- Keep web and desktop API behaviour aligned.
- Use `activity_id` plus stable `segment_index` in frontend state and APIs.
- Defer route/query-string support; if later added, expose `segment_index`.
- Normalize cumulative distance for child responses before returning records.

### 8. Update Frontend State

Use a discriminated parent-or-segment selection that retains the parent activity
and, for a child, the complete segment summary. Derive display title, sport,
start/end, duration, distance, session metadata, laps, and records from that
selection. Do not change only the records array: current detail statistics and
actions also read the selected activity object.

When no segment is selected, fetch parent records and use parent laps.

When a segment is selected, fetch segment-scoped records and show only laps for
that segment when lap scoping is available.

### 9a. Add Expandable Activity List Rows

Add expandable parent rows:

- Parent row opens the whole activity.
- Expanding the row shows child legs.
- Child row opens the same Individual tab scoped to that segment.
- Child rows are visually subordinate.
- Transition rows are visible and selectable, but visually de-emphasized.

### 9b. Keep Global Filters Parent-based

For the first pass, search and sport filters operate on parent activities. A
multisport parent appears under `Multisport`; expanding it exposes every leg.
Defer child-aware filtering until leg-versus-parent Overview aggregation is
designed.

### 10. Reuse Individual Tab Layout

Do not add a detail-page segment selector in the first pass.

Parent selected:

- Existing Individual tab layout renders full parent activity data.

Child selected:

- Existing Individual tab layout renders selected segment data.

Transition selected:

- Existing Individual tab layout renders transition data as a generic GPS
  movement segment when streams exist.

### 11. Update Overview UI

Overview remains parent-activity based in the first pass. The current Overview
page does use the sidebar filters because `Dashboard.tsx` passes the filtered
activity array into the overview cards, heatmap, donut, map, weekly trend, and
table. A multisport event and its child legs count as one activity for overview
statistics. Child legs do not add separate overview counts, totals, averages,
heatmap cells, weekly trend entries, sport donut slices, or overview table rows.

Overview cards:

- Filtered activity count counts the parent once.
- Total distance uses the parent activity distance.
- Total duration uses the parent activity duration.
- Average distance and average duration divide by the number of parent
  activities, not by the number of child legs.
- Unique sports should include `Multisport` as the parent sport/category. It
  should not count every child sport as a separate overview activity type unless
  a later leg-level overview is added.

Activity Contributions heatmap:

- Current implementation counts activities per calendar day. It does not use
  distance, duration, or intensity.
- For each activity, `ActivityContributionHeatmap` buckets
  `activity.start_ts_utc` by local day and increments that day by one.
- Cell colour is relative to the busiest day in the displayed range:
  - `0`: grey `rgba(148, 163, 184, 0.20)`
  - `count / maxCount < 0.25`: `#155e75`
  - `count / maxCount < 0.5`: `#0891b2`
  - `count / maxCount < 0.75`: `#06b6d4`
  - otherwise: `#22d3ee`
- A multisport parent contributes one count on its parent start date. Child legs
  do not add additional heatmap counts.

Weekly Training Trend:

- Current implementation sums distance and duration per parent activity week.
- A multisport parent contributes its parent distance and parent duration once.
- Child legs do not create separate weekly entries.

Sport Type Donut:

- Current implementation is the Activity Types donut. It counts parent
  activities by `activity.sport`; it does not measure distance, duration, or leg
  composition.
- Multisport parents should use a parent sport/category such as `Multisport`.
- Child legs should not be counted in the donut in the first pass. A leg-aware
  donut or separate leg composition chart, such as showing bike/run/transition
  share inside a multisport event or inside filtered/search results, is future
  enhancement.

Overview activity table:

- Show one row for the multisport parent.
- Do not show child legs as separate rows in the overview table for the first
  pass.
- The parent row may show a small multisport/leg-count indicator if it can be
  done without changing table behaviour.

Filtering nuance:

- First-pass global filters operate on parent activities only.
- A multisport event appears under `Multisport` and contributes parent metrics
  once.
- Child-aware filters and leg-aware Overview aggregation are deferred together
  so a Running filter cannot silently include cycling and transition totals.

### 12. Exports and Compare

Preserve existing single-sport behaviour. Defer multisport parent and child
export and compare until segment selection, derived display metadata, and
normalized distance are proven.

## Test Plan

Backend parser tests:

- TCX and GPX imports keep existing single-activity behaviour and do not enter
  multisport detection.
- TCX distance correction is tracked separately in issue #29 and is not part
  of this multisport implementation.
- Single-sport FIT import remains unchanged.
- Multisport FIT preserves all sessions.
- Multisport FIT preserves all laps.
- Session fields are not overwritten by later sessions.
- Activity message data is preserved.
- Transition sessions are detected as child legs.
- Single-session `auto_multi_sport` files remain ordinary activities.
- Manual multi-session sport changes follow the confirmed detection policy.

Segment assignment tests:

- Records assign to expected segment by timestamp.
- Explicit session lap ranges take priority; start time remains a fallback.
- Missing or ambiguous laps remain parent-only.
- Overlap and unassigned diagnostics are recorded.

Database tests:

- Fresh databases create the new tables and columns.
- Existing databases migrate automatically without losing current columns or rows.
- A later numeric rebuild preserves the multisport columns.
- Multisport insert writes parent metadata with segment-tagged laps, segments,
  and records.
- Delete removes records, segments, and parent.
- Failed import rollback removes all child rows.
- Overview totals count parent only.

API/Tauri tests:

- Parent records endpoint returns all parent records.
- Segment-scoped records endpoint returns only child records and normalizes
  cumulative distance to the segment origin.
- Parent view reads all metadata laps.
- Child view filters metadata laps by selected segment index.
- Web and Tauri commands return matching shapes.

Frontend tests:

- Parent row expands to child rows.
- Child row selection scopes records, map, charts, stats, and laps.
- Global search and sport filters remain parent-based in the first pass.
- Overview totals do not double-count children.
- Parent rename still works.
- Child rows are not user-editable in the first pass.

## Deferred

Deferred and second-pass items are tracked in
`docs/features/multisport-deferred.md`.
