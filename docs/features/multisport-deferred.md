# Multisport Deferred Items

Parking lot for issue #21 follow-up work. These are intentionally out of scope
for the first implementation pass unless the implementation proves they are
needed sooner.

## Data Model

- First-class `activity_laps` table.
  - MVP keeps laps in `metadata_json.laps` with segment assignment fields.
  - Future work can migrate all lap display to `activity_laps` and add a general
    lap API.

## Activity List and Navigation

- URL/query-string support for opening a specific child leg directly.
  - MVP keeps selected child leg in frontend state.
  - Future URL support should use stable `segment_index`.
- Detail-page segment selector.
  - MVP selects parent/child legs from the activity list only.
- Child leg rename/custom labels.
  - MVP uses generated names from sport/sub-sport and transition order.
  - Future work could add `activity_segments.custom_name` and a segment-specific
    rename endpoint.

## Search, Filters, and Overview

- Child-aware search and sport filters.
  - MVP filters parent activities and exposes legs by expanding a Multisport row.
  - Future work must define whether a leg match contributes leg metrics or the
    complete parent to Overview totals.

## Overview

- Leg-aware Overview aggregation.
  - MVP Overview remains parent-activity based.
  - Future work could report matching child-leg distance, duration, counts,
    heatmap entries, weekly trend entries, and activity-type donut slices.
- Leg composition chart or leg-aware activity-type donut.
  - MVP Activity Types donut counts the parent as `Multisport`.
  - Future work could show bike/run/transition share inside a multisport event or
    inside filtered/search results.

## Detail Page and Maps

- Garmin Connect-style parent detail page.
  - MVP reuses the existing Individual tab layout for both parent and child
    selections.
- Segment-coloured route overlays.
  - MVP maps render the selected record set.
  - Future work could colour parent routes by segment and mark segment boundaries.
- Manual leg-boundary editing.

## Calculations and Insights

- Parent-level sport-specific calculations on mixed-sport data.
  - Parent calculation behaviour is TBD after the first implementation slice.
  - Segment-scoped calculations are the safer path because each child leg has one
    sport/sub-sport and expected output stream.
- Heart-rate drift on multisport.
  - If/when HR drift exists upstream, it should be disabled on multisport parent
    activities and evaluated on eligible child legs only.

## Export and Compare

- Multisport parent export.
  - Future work should define a deliberate parent export shape, such as parent
    summary plus child summaries, original FIT download, or a clearly labelled
    combined telemetry export.
  - Parent export should not silently reuse a normal single-sport activity export
    because parent records contain mixed sports and mixed output streams.
- Multisport parent compare.
  - Parent compare needs a deliberate design because parent data mixes sports,
    output streams, and segment semantics.
  - Future work should decide whether parent compare is disabled, summary-only,
    or represented by a multisport-specific compare view.
- Multisport child-leg compare.
  - Child-leg compare may be able to reuse existing compare behaviour, but that is
    not part of the first-slice design.
  - Future work should verify whether compare can accept `activity_id` plus
    `segment_index`, segment labels, segment summaries, and segment-scoped
    records.

## Test Fixtures

- Upstream-safe multisport FIT fixture.
  - Synthetic parsed-data tests are safest for MVP.
  - A fabricated or sanitized FIT binary requires extra tooling because FIT is a
    binary format with checksums and possible personal/GPS data.
