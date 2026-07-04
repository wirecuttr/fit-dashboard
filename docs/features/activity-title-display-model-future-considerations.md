# Activity Title Display Model Future Considerations

This document records follow-up ideas for the activity title display model. These
items are intentionally out of scope for the first implementation in
`activity-title-display-model.md`.

## Backfill and Reset Handling

The first implementation assumes reimport for older activities and does not
reverse-parse existing `activity_name` values. A later feature could add explicit
reset or regeneration actions:

```text
Reset title to source title
Reset title to generated title
Regenerate generated title from current naming rules
```

Supporting those actions cleanly may require tracking title provenance, for
example:

```text
title_source = source | generated | user
```

Do not add this field unless reset/regenerate behaviour is implemented or clearly
planned.

## Ambiguous City Names

The first implementation should prefer compact city-only generated titles, such
as:

```text
Calgary Road Cycling
```

If city ambiguity becomes a practical problem, add region/province/state in
secondary list context rather than in the primary title:

```text
Road Cycling - Calgary, Alberta - 102 km
```

Avoid defaulting primary titles back to heavier labels such as
`Calgary, Alberta - Road Cycling`.

## Non-FIT Source Titles

The initial source-title scope should be FIT metadata with concrete samples,
especially Garmin planned-workout metadata such as `Workout.wkt_name`.

Future source-title support could inspect other formats if useful:

```text
TCX activity names, notes, or IDs
GPX metadata name
```

Those formats have more variable title semantics, so defer them until there are
real sample files and a clear user-facing need.

## Search Strategy

The first implementation can keep search simple by matching loaded activity-list
fields client-side. Useful fields include:

```text
activity_name
file_name
sport
activity_type_label
location_city
location_label
source_title
generated_title
device
```

This lets search find an imported source title even after the displayed
`activity_name` has been edited. A formal search index is only needed if list
size or performance makes the client-side approach inadequate.

## Future Sub-Sport Icons

Icons are not part of the first implementation. If icons are added later, they
should be derived from `sport + sub_sport`, with graceful fallback:

```text
exact sport/sub_sport icon
sport-level icon
no icon
```

A useful first icon pass would need sub-sport-level coverage for common cases,
for example:

```text
Road Cycling
Indoor Cycling
Mountain Biking
Gravel Cycling
eBiking / eMTB
Running
Trail Running
Treadmill Running
Walking / Hiking
Lap Swimming / Open Water Swimming
Strength / Cardio / Yoga
```

Garmin uses sub-sport-level icons, so a very small sport-only icon set would not
match the Garmin-style activity identity model.
