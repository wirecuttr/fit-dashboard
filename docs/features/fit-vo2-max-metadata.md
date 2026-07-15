# FIT VO2 Max Metadata

## Status

Implemented design and parsing guidance. The parser preserves structured VO2-max
estimates and the UI displays safely qualified running and cycling values.

## Purpose

Garmin activity FIT files can contain several values that look like VO2 max.
Most are in proprietary messages that are not described by Garmin's public FIT
profile. Before this change, the parser read one of these values into a single scalar,
which lost its sport and session context and caused the final value to win in
multisport files.

This document records what can be identified reliably, what remains unknown,
and how parsing and UI behaviour label running and cycling VO2 max.

## Conclusions

- Garmin publicly describes separate running and cycling VO2-max estimates.
- Message 140 field 7 is the updated rolling estimate for the applicable sport
  after Garmin processes a qualifying activity. It is not best understood as a
  separate, user-facing "VO2 max for this activity" metric.
- Message 140 field 11 identifies the activity sport. In the local running,
  cycling, and multisport files it is sufficient to distinguish running from
  cycling directly.
- Message 140 field 28 is unidentified. It must not be exposed as VO2 max.
- Message 79 carries the user's estimate at the beginning of the activity.
- Multisport files can contain both running and cycling VO2-max values, and can
  contain more than one value for repeated legs of the same sport.
- The product should expose `Running VO2 Max` and `Cycling VO2 Max` as the two
  explicit Garmin sport categories. The parser must still preserve generic,
  unknown, and raw sport values instead of assuming that every message belongs
  to one of those two categories.

## Garmin Model

Garmin documentation states that compatible multisport devices maintain
separate VO2-max estimates for running and cycling. A walking activity may also
update the general running/walking estimate on compatible devices, but Garmin
does not present `Walking VO2 Max`, `Hiking VO2 Max`, or similar additional
sport-specific categories.

The standard FIT `max_met_category` enumeration likewise contains only:

- `generic`
- `cycling`

For this app, the generic estimate can be labelled `Running VO2 Max` only when
the FIT context positively associates it with running. A value found on a
walking, hiking, skiing, swimming, kayaking, generic, or training activity must
not create a new VO2-max category. If its running/cycling category cannot be
established, retain it as generic or unknown metadata and either display the
unqualified label `VO2 Max` or omit it from the UI.

References:

- [Garmin: About VO2 Max Estimates](https://www8.garmin.com/manuals/webhelp/GUID-025D75CF-3445-49E1-8D81-1AA74AB4E00F/EN-US/GUID-3E971364-A756-4057-B22D-C41250B2A82B.html)
- [Garmin: VO2 Max from a walk or run](https://www8.garmin.com/manuals/webhelp/GUID-9CC4A873-E034-4A06-B2E0-636DCFE760EE/EN-GB/GUID-544723AB-D323-480F-8A07-911E89C043A4.html)
- [Garmin FIT protocol](https://developer.garmin.com/fit/protocol/)

## FIT Sources

### Message 79: starting user metrics

Message 79 is proprietary in the activity files examined. Public decoders refer
to it as `user_data` or `user_metrics`.

- Field 0 is a lower-resolution METmax/VO2-max value with scale 1,024.
- Field 19 is a higher-resolution starting VO2-max value with scale 65,536 on
  newer files.

Conversions:

```text
field 0 VO2 max  = raw value * 3.5 / 1024
field 19 VO2 max = raw value * 3.5 / 65536
```

In the local files, fields 0 and 19 normally describe the estimate known at the
beginning of the activity. They are often numerically the same at different
resolutions.

Message 79 does not provide a documented, reliable running/cycling label in the
examined files. It is therefore useful as a before-activity or fallback value,
but not as the primary source for a sport label.

### Message 140: activity processing metrics

Message 140 is an undocumented Garmin/Firstbeat physiological metrics block.
Public reverse-engineered decoders consistently map field 7 as METmax with a
scale of 65,536:

```text
field 7 VO2 max = raw value * 3.5 / 65536
```

Field 11 carries a FIT sport code. The relevant codes are:

| Code | FIT sport | VO2-max labelling rule |
| ---: | --- | --- |
| 1 | running | `Running VO2 Max` |
| 2 | cycling | `Cycling VO2 Max` |
| any other value | activity sport or generic | Do not invent another VO2-max category |

For single-sport files, message 140 normally appears immediately before its
session message. In examined multisport files, each running or cycling field-7
value has the matching field-11 sport code and immediately precedes the
corresponding session. Both the explicit field and message ordering should be
preserved for diagnostics; field 11 is the primary sport source and the linked
session is a consistency check.

The value is best modelled as the updated rolling sport estimate:

```text
message 79 starting estimate
             |
             v
      activity is processed
             |
             v
message 140 field 7 updated estimate
             |
             v
next same-sport activity's message 79 starting estimate
```

Third-party tools sometimes call field 7 `Activity VO2 Max` because it resides
in an activity-metrics message. That describes the storage location, not a
separate Garmin metric presented to the user.

Public reverse-engineering reference:

- [fit4ruby physiological metrics mapping](https://github.com/scrapper/fit4ruby/blob/master/lib/fit4ruby/GlobalFitMessages.rb#L977-L1013)

### Message 140 field 28: unknown

Field 28 is a signed 32-bit value in the same proprietary message. Applying the
field-7 conversion produces a plausible VO2-like number in some files, but that
does not establish its meaning.

Evidence against treating field 28 as the user's VO2 max:

- established public decoders leave it undocumented;
- it is much less common than fields 7 and 79/0;
- it normally differs from both the starting and updated rolling estimate;
- it does not become the starting estimate in the next same-sport activity;
- it is often higher than the known rolling estimate; and
- its presence varies by device generation and activity.

It may be an internal Firstbeat candidate, correction, or another MET-related
intermediate. Heat or altitude correction is one plausible class of internal
value because Garmin applies environmental corrections to VO2 max, but there
is no evidence that specifically identifies field 28 that way.

Parsing rule: preserve the raw value for diagnostics if desired, but do not
convert, label, persist, or display it as VO2 max.

### Message 229: standard max-MET data

The current Garmin FIT profile defines standard `max_met_data` message 229 with
an explicit VO2-max value, sport, sub-sport, and generic/cycling category. None
of the 1,278 local activity FIT files examined contains message 229.

Parsing prefers its explicit category and sport when it is
present, while retaining message 79/140 support for the existing dataset.

## Local Dataset Evidence

The audit used Garmin's JavaScript FIT SDK with unknown data enabled and read
1,278 local FIT files successfully.

| Evidence | Running | Cycling |
| --- | ---: | ---: |
| Single-sport files examined | 535 | 502 |
| Files with message 79 field 0 | 521 | 486 |
| Files with valid message 140 field 7 | 387 | 429 |
| Files with a VO2-like message 140 field 28 | 20 | 95 |
| Single-sport files with multiple valid field-7 values | 0 | 0 |

For comparable chronological pairs, one activity's field-7 value exactly
became the next same-sport activity's high-resolution starting value in 17 of
21 running pairs and 151 of 168 cycling pairs. Missing intervening activities,
device synchronisation, and files without the newer high-resolution starting
field can account for some non-matching pairs.

Representative exact transitions:

- Running: `47.08332` after the 1 July 2026 run became `47.08332` at the
  beginning of the 11 July 2026 run.
- Cycling: `47.94492` after the 12 July 2026 ride became `47.94492` at the
  beginning of the 14 July 2026 ride.

Message 140 field 7 was also found with activity sport codes for kayaking,
hiking, walking, cross-country skiing, alpine skiing, snowboarding, swimming,
training, fitness equipment, and generic activities. In representative older
non-running/non-cycling files, field 7 closely matched message 79's starting
value instead of demonstrating a new sport-specific estimate. These records are
why the parser must preserve the raw activity sport but the UI must not expose
additional labels such as `Kayaking VO2 Max` or `Hiking VO2 Max`.

### Multisport

All six multisport files examined contain multiple field-7 values. Message 140
field 11 identifies each running or cycling leg directly.

One example contains:

```text
Cycling VO2 Max 41.4006 -> cycling session
Running VO2 Max 42.7203 -> running session
Cycling VO2 Max 41.7701 -> cycling session
```

Another contains:

```text
Running VO2 Max 44.7247 -> running session
Cycling VO2 Max 43.7378 -> cycling session
```

A multisport summary can therefore display both `Running VO2 Max` and
`Cycling VO2 Max`. If a category occurs more than once, preserve every
per-session value and use the final value for that category in a compact
activity-level summary.

## Previous App Limitation

Before this change, the parser in [`fit_parser.rs`](../../src-tauri/src/fit_parser.rs)
stored:

```rust
let mut vo2_max: Option<f64> = None;
```

Every message-140 field-7 value reassigned that scalar. Metadata consequently
contained only:

```json
{
  "activity_metrics": {
    "vo2_max": 47.94
  }
}
```

For multisport activities this discards all but the final value and loses the
sport and session association. The legacy metadata remains readable for
backward compatibility, but new extraction should use a list.

## Recommended App Behaviour

The app shows sport-qualified VO2 max only when the FIT data establishes the
running or cycling category:

- a running activity shows **Running VO2 Max**;
- a cycling activity shows **Cycling VO2 Max**;
- a multisport activity shows both labels when both categories are available;
- repeated legs retain every per-session estimate, while the compact activity
  summary shows the final estimate for each category; and
- other activity types do not show a carried VO2 value.

For each running or cycling category, use this source priority:

1. the final standard message-229 value with an explicit compatible sport or
   category;
2. the final message-140 field-7 value for that category, representing the
   estimate after Garmin processed the activity;
3. a message-79 starting estimate only when no updated value exists and the
   activity or linked session establishes the category; and
4. no displayed value when none of those sources can be associated safely.

The normal UI does not distinguish the source phase in the label. The metadata
preserves it, and a short tooltip describes the value as:

> Garmin sport-specific estimate as of this activity.

Do not introduce **Activity VO2 Max**, **Walking VO2 Max**, or labels for other
activity sports. Do not use message-140 field 28.

Where the existing UI shows the generic **VO2 Max** statistic, replace it with
the applicable sport-qualified statistic or statistics. This belongs in the
existing user-statistics group rather than in the activity performance groups.

Existing imported rows contain only the legacy scalar. For an unambiguous
single-sport running or cycling activity, the UI can safely qualify that scalar
using the activity sport already stored in the database. Reimport is required
only to recover both categories and per-session provenance from historical
multisport files, or to populate the complete structured metadata. Keep the
legacy activity_metrics.vo2_max value readable for backward compatibility
while the UI and exports move to the structured representation.

## Parsing and Display Rules

1. Preserve every standard message-229 decoded estimate, plus every message-79
   starting estimate and message-140 field-7 update with its source message and
   proprietary raw value.
2. Associate message-140 values with field 11 and the corresponding session.
3. Label field-11 running values `Running VO2 Max`.
4. Label field-11 cycling values `Cycling VO2 Max`.
5. Do not create new VO2-max categories for other activity sport codes.
6. Preserve generic, unknown, raw sport, sub-sport, session index, and message
   order so later decoding improvements do not require another FIT-file audit.
7. Preserve all per-session values in multisport files. A summary may select
   the final value per running/cycling category.
8. Use message 79 only as a starting/fallback value when a post-activity field-7
   update is unavailable, and do not infer its sport without supporting context.
9. Ignore message-140 field 28 for user-facing VO2 max.
10. Keep the storage model extensible even though the current UI has only the
    explicit `Running` and `Cycling` labels.

Persisted metadata shape:

```json
{
  "vo2_max": {
    "schema_version": 1,
    "estimates": [
      {
        "value_ml_kg_min": 44.7247,
        "phase": "after_activity",
        "category": "running",
        "activity_sport_code": 1,
        "activity_sport": "running",
        "session_index": 0,
        "source": "garmin_message_140_field_7"
      },
      {
        "value_ml_kg_min": 43.7378,
        "phase": "after_activity",
        "category": "cycling",
        "activity_sport_code": 2,
        "activity_sport": "cycling",
        "session_index": 2,
        "source": "garmin_message_140_field_7"
      }
    ]
  }
}
```

This persisted shape keeps the legacy scalar for compatibility and adds the
structured estimates used by the sport-qualified UI.
