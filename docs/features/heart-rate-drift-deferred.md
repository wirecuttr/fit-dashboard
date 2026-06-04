# Heart Rate Drift Deferred Work

## Purpose

This document parks optional future work that is not part of the first Heart Rate Drift slice. These items are not required for the current feature to be useful. They should be revisited only if the added value justifies the extra backend, database, migration, or UI scope.

## Backend-Owned Calculation

Possible future direction:

- Port the calculator from TypeScript to Rust.
- Add Rust result models equivalent to the frontend `CardiacDecouplingResult` shape.
- Calculate from database records directly instead of from frontend-loaded `analysisRecords`.
- Keep frontend and backend defaults aligned, or move defaults to shared settings.

Value added:

- One canonical calculation source outside the UI.
- Better access to full-resolution records.
- Easier reuse by exports, activity lists, overview summaries, and background processing.

Cost:

- Duplicates or replaces a substantial TypeScript calculator.
- Requires careful test parity between frontend and backend behavior.
- May need API and model versioning if results are exposed externally.

## API Surface

Possible endpoints and commands:

- Web: `GET /api/activities/{id}/heart-rate-drift`
- Tauri: `get_heart_rate_drift(activity_id)`

Possible behavior:

- Calculate on demand from database records.
- Return the same result shape currently used by the frontend.
- Include unavailable results and reasons so the UI can explain failures.

This is unnecessary while the metric is only displayed in `ActivityInsights`.

## Persistence

Possible storage options:

- Store derived results in `activities.metadata_json`.
- Add a dedicated derived-metrics table keyed by `activity_id`, metric name, config version, and calculation version.

Value added:

- Faster repeated display for large activities.
- Queryable values for activity list, overview, export, and future filters.
- Stable historical values if calculation versions are tracked.

Cost:

- Requires invalidation when records, parser behavior, or config defaults change.
- May require migration logic.
- Adds schema and lifecycle complexity for a derived value that can currently be recalculated.

## Import-Time Calculation

Possible future direction:

- Calculate Heart Rate Drift after successful import.
- Store the result or a compact derived-metric summary.

Value added:

- Makes the metric immediately available for lists and overview pages.
- Avoids recalculating when opening the Individual activity page.

Cost:

- Slower imports.
- More failure modes during sync/import.
- Requires a clear policy for recalculation when the algorithm changes.

## Activity List and Search

Possible future direction:

- Show Heart Rate Drift as an optional activity-list column.
- Allow sorting or filtering by drift percentage, confidence, mode, or availability.

This likely requires persistence or backend-owned calculation. Calculating values client-side for every listed activity would be expensive and would require loading record streams for many activities.

## Overview Integration

Possible future direction:

- Show trend summaries such as recent low/moderate/high drift counts.
- Show median drift for comparable activity groups.
- Show confidence-filtered summaries.

This should wait until there is evidence users want aggregate drift views. Aggregating across different sports, modes, terrain, weather, and workout structures can be misleading.

## Export Support

Possible future direction:

- Add Heart Rate Drift fields to CSV/JSON activity export.
- Include mode, drift percentage, confidence, EF values, evaluated duration, exclusions, and unavailable reason.

This requires either backend calculation during export or stored derived metrics. It is not part of the first slice.

## Settings UI

Possible future direction:

- Expose thresholds such as warmup ignore, cooldown ignore, bin duration, minimum bin duration, coverage thresholds, and drift bands.
- Support user-selected defaults for output mode where more than one mode is available.

This should wait until defaults have been validated against real files. Adding settings too early can make the feature harder to explain and test.

## Manual Segment Selection

Possible future direction:

- Let users select a steady section manually.
- Calculate HR drift for that selected section.
- Optionally use lap boundaries when laps represent meaningful test segments.

Value added:

- Better support for formal field tests and activities with long warmups/cooldowns.

Cost:

- Requires more UI, persisted selection state if saved, and careful interaction with existing chart zoom/selection behavior.

## Running Power Mode

Possible future direction:

- Add running power as an optional selectable mode when record-level running power and HR pass coverage checks.

This is deferred because running power is device/ecosystem-dependent, while pace-based Pa:Hr is the more common default convention for running.

## Recalculation and Versioning

If results are persisted later, add:

- Calculation version.
- Config version.
- Source record/import version if available.
- A policy for stale values after parser fixes or algorithm changes.

Without persistence, this is unnecessary because the value is recalculated from current records and current code.
