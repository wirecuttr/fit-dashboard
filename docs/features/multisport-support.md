# Multisport Activity Support

## Problem

FIT Dashboard currently treats an imported FIT file as one activity. Garmin
multisport files can contain one parent activity with multiple sessions, such as
indoor bike, transition, run, transition, indoor bike. Flattening those records
into one activity produces misleading names, summaries, maps, charts, filters,
and activity-type behavior.

An observed Garmin FIT file used `activity.type = auto_multi_sport` with five
sessions:

| Leg | Sport | Sub-sport | Duration | Distance | GPS |
| --- | --- | --- | ---: | ---: | --- |
| 1 | cycling | indoor_cycling | 1:55:23 | 40.33 km | no |
| 2 | transition | generic | 4:52 | 0.13 km | yes |
| 3 | running | generic | 52:45 | 8.09 km | yes |
| 4 | transition | generic | 2:50 | 0.04 km | yes |
| 5 | cycling | indoor_cycling | 59:56 | 20.23 km | no |

The whole file had a combined duration of about 3:55:46 and 68.82 km. Because
some legs had GPS and others did not, a single flattened activity can be named
or displayed as if all records belong to one sport/location.

## Goals

- Preserve the parent multisport activity.
- Preserve each session/leg as a selectable child view.
- Let users open either the whole activity or an individual leg.
- Avoid duplicating records as unrelated activities.
- Keep activity totals, filters, charts, maps, and calculations scoped to the
  selected parent or child view.
- Support Garmin Connect-like navigation without taking over the existing UI.

## Non-Goals

- Do not split a multisport FIT into unrelated standalone activities without a
  parent relationship.
- Do not infer legs from sport changes alone when FIT session boundaries are
  available.
- Do not solve every multisport type in the first pass if the data model can
  support them later.

## Recommended Model

Store one parent activity and a set of child segments.

The parent activity represents the whole FIT file:

- activity type: multisport, brick, or another formatted summary
- duration/distance/calories from the parent activity/session data
- records from all child legs
- child segment list

Each child segment represents one FIT session:

- segment order
- sport and sub-sport
- display name
- start and end time
- duration, distance, calories, ascent/descent, average/max metrics
- whether it is a transition
- source FIT session index

Records and laps should be associated with a segment, either by storing a
`segment_id` on imported records/laps or by storing segment time ranges and
filtering records by time. A stored `segment_id` is more deterministic and
avoids ambiguity at boundaries.

## Activity List

The activity list can be the primary selector for parent and child activity
views.

Example:

```text
v Multisport · 3h55m · 68.8 km
    Bike Indoor · 1h55m · 40.3 km
    T1 · 4m52s
    Run · 52m45s · 8.1 km
    T2 · 2m50s
    Bike Indoor · 59m56s · 20.2 km
```

Click behavior:

- Parent row opens the whole activity.
- Child row opens the same activity detail page scoped to that leg.
- Transition rows can be shown in the expanded group, but visually de-emphasized.
- A user preference could later hide transition rows by default.

The list should avoid making child rows look like unrelated imported files.
Indentation, connector lines, icons, or grouped row styling should make the
parent/child relationship obvious.

## Activity Detail View

The detail page should accept an activity scope:

- parent scope: all records and all legs
- child scope: records, laps, stats, charts, maps, and calculations for one leg

Possible URL forms:

```text
/activity/:activityId
/activity/:activityId?segment=:segmentId
```

or:

```text
/activity/:activityId/segments/:segmentId
```

The page can also show a compact leg selector:

```text
Entire Activity | Bike 1 | T1 | Run | T2 | Bike 2
```

This selector should not replace activity-list selection, but it lets users move
between legs after opening the detail page.

## Naming

Parent naming should describe the multisport activity, not just the first or
last sport.

Examples:

- `Bike Indoor + Run + Bike Indoor`
- `Multisport: Bike Indoor, Run, Bike Indoor`
- `Brick: Bike Indoor + Run + Bike Indoor` if the source data clearly supports
  that label

Child naming should use the session sport and sub-sport:

- `Bike Indoor`
- `Run`
- `Transition`

If GPS exists only on some legs, reverse-geocoded location should not be allowed
to make the entire parent look like a single GPS activity. Location can be shown
on the parent as contextual metadata, but the sport label should come from the
session structure.

## Database Sketch

One possible schema direction:

```text
activities
  id
  parent_activity_id nullable
  source_file_id
  activity_kind: single | multisport_parent | multisport_segment
  segment_index nullable
  is_transition
  sport
  sub_sport
  name
  start_time
  end_time
  duration_s
  distance_m
  summary metrics...

activity_records
  id
  activity_id       -- parent activity id, or existing owning activity id
  segment_id nullable
  timestamp
  telemetry fields...

activity_laps
  id
  activity_id
  segment_id nullable
  lap_index
  summary fields...
```

An alternative is a separate `activity_segments` table instead of representing
segments in `activities`. That is probably cleaner long term:

```text
activities
  id
  activity_kind: single | multisport
  parent-level fields...

activity_segments
  id
  activity_id
  segment_index
  is_transition
  sport
  sub_sport
  name
  start_time
  end_time
  duration_s
  distance_m
  summary metrics...
```

The separate `activity_segments` table is the preferred long-term design because
it preserves one imported activity while still making legs first-class scoped
views.

## Import Behavior

During FIT import:

1. Detect `activity.type = auto_multi_sport` or multiple FIT `session` messages.
2. Create one parent activity.
3. Create one child segment per FIT session.
4. Assign laps to segments using FIT `first_lap_index` and `num_laps` when
   available.
5. Assign records to segments by timestamp range.
6. Preserve transition sessions instead of silently merging them into adjacent
   sport legs.

For single-session FIT files, keep the current activity import behavior.

## Dedupe

Dedupe should remain based on the imported source activity/file identity, not on
each generated segment. Reimporting the same multisport FIT should update or
skip the parent and its child segments as one import unit.

Child segments should not be deduped as if they were separate source FIT files.

## Filters And Statistics

Filtering needs clear semantics:

- Filtering by `Running` should match running child segments.
- Filtering by `Cycling` should match cycling child segments.
- Parent multisport activities can remain visible if any child segment matches,
  with only matching children highlighted or shown.
- Overview totals should avoid double counting parent and child values.

Recommended default for overview totals:

- Count parent multisport activity once for total activity count.
- Use parent totals for combined duration, distance, and calories.
- Sport-specific totals should use child segment totals.

## Charts, Maps, And Calculations

All detail-page components should receive an activity scope:

- parent scope includes all records
- child scope includes only records for the selected segment

Maps should handle mixed GPS availability. A parent multisport view may show only
legs with GPS, while indoor child legs may show no route.

Calculations that are sport-specific should usually run on child scopes, not the
whole parent, unless the calculation explicitly supports mixed-sport input.

## Implementation Phases

### Phase 1: Parse And Store Segments

- Detect multisport FIT files.
- Store parent activity and child segments.
- Assign records/laps to segments.
- Preserve existing single-activity import behavior.

### Phase 2: Activity List Grouping

- Show expandable parent rows.
- Show child segment rows under the parent.
- Support clicking parent or child rows.
- Prevent child rows from being mistaken for duplicate imports.

### Phase 3: Detail Scoping

- Add parent/segment route state.
- Scope stats, charts, laps, maps, and calculations by selected segment.
- Add compact leg selector on the detail page.

### Phase 4: Overview And Filters

- Update sport/sub-sport filters to understand child segments.
- Prevent overview totals from double counting parent and child values.
- Add tests for mixed indoor/outdoor multisport files.

## Open Questions

- Should transitions be visible by default, collapsed by default, or controlled
  by a user setting?
- Should parent activities have a distinct `Multisport` filter value?
- How should parent activity distance be displayed when child distances come
  from different sources, such as indoor bike sensor distance plus GPS run
  distance?
- Should importing a multisport file optionally create exportable child
  activities, or should child legs remain internal views only?
- How should manual edits to a parent activity propagate to child segment names
  or metadata?
