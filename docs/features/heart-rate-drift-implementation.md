# Heart Rate Drift First-Slice Implementation

## Purpose

This document describes the first implemented slice of the Heart Rate Drift feature. It is written after the fact to capture the current implementation shape and to separate completed scope from optional future backend work.

The first slice is intentionally frontend-only. It provides a usable Individual activity insight without changing the database schema, import pipeline, REST API, or Tauri command surface.

## Scope

Included:

- Calculate Heart Rate Drift from existing activity metadata and record data.
- Use a pure frontend calculator with explicit configuration defaults.
- Support normalized-power cycling, speed/pace-based activities, cycling speed fallback, and constant-output machine assumptions.
- Display a detail chart on the Individual activity page.
- Show drift percentage, drift band, EF or HR summary, confidence, bin markers, and excluded regions.
- Localize normal UI strings through the existing i18n files. The detailed help copy remains English-only while wording is still being refined.

Not included:

- Backend Rust calculation.
- Database persistence of derived metrics.
- Import-time derived metric calculation.
- Activity-list columns, sorting, or filtering by Heart Rate Drift.
- Overview aggregation.
- CSV/JSON export.
- User-facing settings for thresholds.

## Files

Current implementation areas:

- `src/lib/cardiacDecoupling.ts`
  - Pure calculation logic, types, defaults, result selection helpers, band/confidence helpers, and chart data preparation.
- `src/components/ActivityInsights.tsx`
  - Individual activity detail chart integration, summary display, help panel, axis scaling, smoothing display, markers, and excluded-region rendering.
- `src/styles.css`
  - Heart Rate Drift panel, badge, confidence, and help-panel styling.
- `src/i18n/*.json`
  - UI labels, bands, confidence labels, unavailable reasons, and summary strings.
- `docs/features/heart-rate-drift.md`
  - Product and calculation design.

## Data Flow

1. The activity store loads the selected activity.
2. The frontend fetches the normal chart record stream through the existing `getRecords(activityId)` API call.
3. The frontend also fetches `analysisRecords` through `getRecords(activityId, 1000)`.
4. `ActivityInsights` passes the selected activity and `analysisRecords` to `calculateCardiacDecoupling`.
5. The calculator returns a mode-specific result set and a selected default mode.
6. `ActivityInsights` builds the chart data from the same records and result metadata.
7. The UI displays the Heart Rate Drift panel when an available result exists.

There is no new backend endpoint. The existing backend only supplies activity metadata and downsampled records.

## Calculation Ownership

The first slice treats the frontend calculator as the source of truth for the displayed metric. The calculator is pure and deterministic for a given activity, record stream, and config.

This is sufficient for the first slice because the value is only shown on the Individual activity detail view. It becomes less ideal if the metric needs to be exported, queried, sorted, cached, or reused by backend-owned workflows.

## Record Resolution

The calculation uses the frontend `analysisRecords` stream requested at `resolution_ms=1000`. This gives the calculator a practical 1-second stream without changing the backend API.

Limitations:

- The stream is still produced by the backend downsampling query.
- The calculator does not currently read directly from raw database records.
- Any future backend-owned implementation should calculate from the best available record resolution rather than depending on a frontend-loaded chart stream.

## UI Behavior

The Heart Rate Drift chart is shown in the Individual activity insights grid.

The panel includes:

- Large drift percentage.
- Drift band: low, moderate, high, or increased efficiency for negative values.
- EF summary for output-based modes.
- HR summary for constant-output machine mode.
- Confidence text and short reason when applicable.
- A `?` help panel.
- HR plus selected output series, or HR-only for constant-output mode.
- Grey shaded warmup, cooldown, and gap exclusions.
- Vertical dashed bin markers.
- Dynamic y-axis bounds.

Graph smoothing is display-only. It must not feed back into the calculation.

## Current Limitations

- The result is not stored.
- The result is not available in activity lists, overview stats, exports, or backend APIs.
- The calculation depends on records fetched into the frontend.
- The detailed help copy is currently English-only.
- Config defaults are internal constants; users cannot tune them in the UI.
- Unavailable results are not shown as a separate panel in the first slice; the panel is displayed when an available default result exists.

## Validation Notes

The implementation should be validated with:

- Synthetic record fixtures for calculation edge cases.
- Real cycling files with power and HR.
- Cycling files without usable normalized power but with speed/distance.
- Running/walking files with HR and speed/distance.
- Machine activities with HR only.
- Activities near duration and bin-duration thresholds.
- Activities with pauses, stream gaps, zero power, zero speed, and negative distance deltas.

The first-slice design intentionally avoids binary fixture dependence for most calculator tests. Synthetic `RecordPoint[]` sequences are easier to reason about for coverage, gap handling, and binning behavior.
