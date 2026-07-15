# Multisport Implementation Spike

## Status

Implementation investigation completed on 15 July 2026 against
`upstream/main` commit `2d8040f`.

These findings define the accepted first-pass implementation on the associated
feature branch.

The broader product design is in [multisport-support.md](multisport-support.md);
the ordered delivery plan is in
[multisport-implementation-plan.md](multisport-implementation-plan.md). Both have
been reconciled with these findings.

## Scope

The spike traced:

- FIT activity, session, lap, and record parsing;
- DuckDB schema creation, numeric rebuild migration, insert, rollback, delete,
  overview, and downsampled record queries;
- matching web and Tauri APIs;
- frontend activity selection, sidebar filtering, detail statistics, laps,
  charts, maps, export, and overview aggregation; and
- retained FIT samples in the local corpus, decoded read-only with Garmin's FIT
  SDK and unknown messages enabled.

## Current Upstream Baseline

- `ParsedActivity` contains one parent summary and one flat record list.
- Every FIT `Session` overwrites the same scalar summary fields; only the last
  session survives in `metadata_json.session`.
- Laps remain an array under `metadata_json.laps`.
- `activities` has no parent/child discriminator.
- `records` has no segment assignment.
- Insert writes the parent first and records in a later transaction.
- Record queries accept only `activity_id` and downsampling resolution.
- Web and Tauri APIs have no segment resource or selector.
- The frontend store has only `selectedActivity` and one record array.
- Detail duration, distance, sport, title, session statistics, laps, actions,
  and exports all read the selected `Activity`, not only the selected records.

Consequently, fetching segment-scoped records alone would not create a correct
child view. It would still show parent or final-session summary fields.

## FIT Corpus Validation

The retained corpus contained 1,278 FIT files and decoded with zero failures.

### Detection

- Nine files had FIT activity `type = autoMultiSport`.
- Four of those nine had only one session and were ordinary strength, running,
  or cycling activities. The activity type alone is therefore not a safe
  multisport signal.
- Five files had both `autoMultiSport` and multiple sessions. Three of those
  were byte-identical downloads of the same parent activity, leaving three
  unique automatic multisport payloads.
- One additional file had two distinct sessions and a cycling-to-running sport
  change but activity `type = manual`.

Revised detection must first require at least two meaningful sessions with
distinct starts. Activity type, transition legs, and adjacent sport changes then
classify that multi-session structure.

### Session Boundaries

In automatic multisport samples, every session `timestamp` could repeat the
parent start and was unusable as an end. Adjacent session starts were stable.
Declared elapsed ends differed from the adjacent start by less than one second
in the inspected payloads, including small gaps and overlaps.

Using half-open intervals from one session start to the next assigned every
record in the four unique multisession payloads inspected; no record was left
unassigned.

### Laps

Sessions expose `firstLapIndex` and `numLaps`. Those explicit index ranges
accounted for every lap and agreed with timestamp assignment in the inspected
payloads.

Lap assignment should therefore prefer the explicit session lap range. Lap
`start_time` is a validation and fallback source, followed by message order and
sport matching. Session or lap `timestamp` must not be treated as an end unless
independently validated.

### Distance

Record distance is parent-cumulative across segment boundaries. For example,
the first transition in the five-leg sample began around 40,330 m and ended
around 40,463 m while its session distance was about 132 m.

A child record response must normalize distance to the child origin. Subtracting
the first child record is insufficient because it loses distance accumulated
between the preceding record and the first record inside the child. Store a
`record_distance_offset_m` derived from the last valid parent record before the
segment start, using zero for the first segment, and subtract that value from
child record responses.

### Parent Metrics

For the three unique automatic multisport payloads, FIT activity
`totalTimerTime` matched the sum of session timer time. Session distance sums
also provide the correct parent fallback. These remain the preferred parent
summary sources when an activity-level value is absent.

## Revised Technical Design

### Parser Domain

Add typed parser structures for:

- the FIT activity summary;
- ordered session summaries;
- ordered lap summaries; and
- ordered records with an optional stable segment index.

Do not use `serde_json::Value` as the primary internal representation. Convert
typed structures into compact diagnostic metadata only at the persistence
boundary.

For a multisport parent, the legacy top-level `metadata_json.session` object
must not contain the last leg's sport-specific summary. It may contain safe
parent aggregates, while full leg summaries live under
`metadata_json.multisport.sessions` and in `activity_segments`.

### Stable Segment Identity

Use `segment_index` as the stable identifier everywhere. Use a one-based display
and API index and retain the zero-based FIT session message index separately for
diagnostics.

Prefer a composite segment key instead of a global surrogate ID:

```sql
CREATE TABLE activity_segments (
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

Add nullable `segment_index` to records and index
`(activity_id, segment_index, timestamp_ms)`. This avoids allocating and
resolving an internal segment ID and matches the stable identifier exposed to
both frontend transports.

### Migration

Automatic additive migration is part of the first implementation:

- add `activities.activity_kind`;
- add `records.segment_index`;
- create `activity_segments` and indexes; and
- backfill existing activities to `single`.

Add columns needed by the numeric rebuild before its check, update the rebuild
table definitions so they preserve those columns, then create or re-assert the
segment table and dependent indexes after any rebuild. A fresh-database-only release is not acceptable for the local
persistent deployment.

Existing imported multisport files still require reimport because the folded
metadata cannot reconstruct all leg summaries reliably.

### Persistence Lifecycle

Insert parent, segments, and records in one transaction. A failed insert should
roll back without relying on a later API-layer cleanup call. Delete records,
segments, and parent in one transaction; blacklist handling remains outside the
transaction after a successful user deletion.

### API and Tauri Shape

- `list_activities` includes `activity_kind` and lightweight ordered segment
  summaries for multisport parents. This avoids an N+1 request pattern and lets
  the sidebar expand immediately.
- `get_records` accepts optional stable `segment_index` in both web and Tauri
  transports.
- Parent requests preserve current behaviour.
- Child requests filter before downsampling and normalize distance using the
  stored segment offset.
- First-pass laps remain in parent metadata and carry `segment_index` plus a
  segment-local lap index.
- URL/deep-link state remains deferred because the current app has no activity
  detail routing model.

### Frontend Selection Model

Use an explicit discriminated selection rather than pretending a child is an
independent activity:

```ts
type ActivitySelection =
  | { kind: "parent"; activity: Activity }
  | { kind: "segment"; activity: Activity; segment: ActivitySegment };
```

Derive a display activity/metadata view from that selection. A child view must
use the segment title, sport, start/end, duration, distance, session summary,
laps, and normalized records while retaining the parent activity ID for delete,
rename, and persistence semantics.

The first UI uses expandable parent rows in the activity list. A separate
detail-page selector and URL state are deferred.

## Recommended Implementation Slices

The product decisions below are accepted. Deliver:

1. Parser/domain extraction, conservative detection, boundaries, lap-index
   assignment, distance offsets, and synthetic parser tests. No database or UI
   changes.
2. Automatic schema migration and transactional parent/segment/record
   persistence, including delete and rollback tests.
3. Segment summaries plus segment-scoped record queries in matching web and
   Tauri APIs.
4. Discriminated frontend selection, expandable rows, child display metadata,
   scoped laps, and normalized charts/maps.
5. Merge into local `main` and adapt activity time basis, chart/map sync, zone
   sources, sport-specific labels, and grouped statistics to the same selection
   context before integrated Docker validation.

## Accepted Product Decisions

### 1. Manual Multi-session Files

Accepted: Require at least two meaningful, distinct-start sessions
and a transition or sport/sub-sport change. This supports manual bricks and the
retained cycling-to-running example while rejecting single-session files that
incorrectly carry `autoMultiSport`.

### 2. Mixed Parent Detail

Accepted: show the parent summary, complete map, and neutral time-based
telemetry; suppress sport-specific pace, power-zone, training-load, and similar
interpretations that would mix incompatible legs. Child selection exposes the
normal sport-specific detail view.

### 3. Child-aware Search and Sport Filters

Accepted: keep first-pass global filters parent-based. Multisport parents
appear under `Multisport`; expanding a parent exposes all legs. Add child-aware
filtering later with explicitly designed leg-versus-parent aggregation semantics.

### 4. Child Export

Accepted: defer parent and child export in the first slice. Segment CSV,
JSON, GPX, and KML require correct display metadata and normalized distance;
enable them after segment selection is proven. Compare remains disabled for
parents and children until separately designed.

### 5. Historical Reimport Workflow

Accepted: use the existing manual workflow for the first release: delete
the flattened activity, clear blacklisted hashes, then upload or sync the FIT
again. A dedicated replace/reimport operation is valuable follow-up work but
does not block the segment model.
