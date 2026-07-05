# Heart Rate and Power Zones

## Branch

- Branch: `feature-hr-power-zones`
- Base: `upstream/main`

## Problem

The app currently has partial heart-rate zone support and no power-zone model.
The FIT parser extracts `heart_rate_zone_bounds_bpm` into activity metadata when
zone messages are present, and the UI falls back to hard-coded default heart-rate
zones when FIT boundaries are unavailable.

Power-zone data is not currently extracted or displayed. Garmin FIT activities
can include time-in-zone data for power, FTP, calculation type, and sometimes
explicit power-zone boundaries.

## Local FIT Findings

The local audit scanned 133 activity FIT files.

- Most Garmin-recorded activity FIT files include `UserProfile`, `ZonesTarget`,
  and `TimeInZone`.
- Stopwatch/type `52` files and TrainerRoad-generated FIT uploads generally do
  not include Garmin zone/profile messages.
- Road cycling and running Garmin files consistently include
  `hr_zone_high_boundary`.
- Edge 1040 road/MTB FIT files include `time_in_power_zone`, FTP, and
  `pwr_calc_type = percent_ftp`, but omit `power_zone_high_boundary`.
- FR255 indoor cycling/multisport FIT files can include
  `power_zone_high_boundary`.
- Older FR935 cycling and indoor cycling FIT files also include
  `power_zone_high_boundary` when FTP/power-zone data is present. A full local
  scan of 768 FR935 files found 200 files with FTP, and all 200 also had
  explicit power-zone boundaries.
- TrainerRoad FIT files include session metrics such as threshold power, but do
  not include `TimeInZone`, `UserProfile`, or `ZonesTarget`.

Representative explicit power boundaries found in FIT:

```text
functional_threshold_power = 215
power_zone_high_boundary = 118|161|194|226|258|323|430|4000
```

Those map to approximately:

```text
55%, 75%, 90%, 105%, 120%, 150%, 200%, capped maximum
```

Older FR935 files used a similar percent-FTP pattern, with a leading zero lower
sentinel and a high cap:

```text
functional_threshold_power = 240
power_zone_high_boundary = 0|132|180|216|252|288|360|3880
```

## FIT Fields

Relevant `TimeInZone` fields:

- `time_in_hr_zone`
- `time_in_power_zone`
- `hr_zone_high_boundary`
- `power_zone_high_boundary`
- `hr_calc_type`
- `pwr_calc_type`
- `max_heart_rate`
- `resting_heart_rate`
- `threshold_heart_rate`
- `functional_threshold_power`

Relevant `ZonesTarget` fields:

- `max_heart_rate`
- `threshold_heart_rate`
- `functional_threshold_power`
- `hr_calc_type`
- `pwr_calc_type`

## Threshold Semantics

Do not conflate activity result fields with athlete profile or zone-setting
fields.

- `Session.max_heart_rate`: maximum heart rate reached during the activity.
- `TimeInZone.max_heart_rate` / `ZonesTarget.max_heart_rate`: configured max
  heart rate used for zone calculation.
- `TimeInZone.threshold_heart_rate` / `ZonesTarget.threshold_heart_rate`:
  configured threshold heart rate used for zone calculation. In Garmin UI terms,
  this commonly corresponds to lactate-threshold heart rate when available.
- `Session.threshold_power`: activity/session threshold power value.
- `TimeInZone.functional_threshold_power` /
  `ZonesTarget.functional_threshold_power`: configured FTP used for power-zone
  calculation.

Persist threshold heart rate under `zones.heart_rate`, not as an activity max HR
or activity result metric.

## Design Direction

Persist zone metadata in parsed activity metadata instead of keeping it only in
chart-local calculations.

Use extracted FIT values when present. When the FIT omits
`power_zone_high_boundary` but provides `pwr_calc_type = percent_ftp` and FTP,
bake in inferred default percent-FTP power boundaries for import and display.
This is expected to work for the Edge-style files in this dataset, and current
usage involves regular reimporting, so the implementation can be revised later
if validation exposes a bad assumption.

Recommended metadata shape:

```json
{
  "zones": {
    "heart_rate": {
      "source": "fit",
      "calc_type": "percent_max_hr",
      "upper_bounds_bpm": [92, 110, 128, 146, 165, 183],
      "time_in_zone_s": [36.995, 232.007, 4389.384, 1658.224, 0, 0, 0],
      "max_heart_rate": 183,
      "resting_heart_rate": 53,
      "threshold_heart_rate": 164
    },
    "power": {
      "source": "fit",
      "calc_type": "percent_ftp",
      "functional_threshold_power": 215,
      "upper_bounds_watts": [118, 161, 194, 226, 258, 323, 430, 4000],
      "time_in_zone_s": [6828.27, 93.986, 0, 0, 0, 0, 0, 0]
    }
  }
}
```

For Edge-style files without explicit power boundaries:

```json
{
  "zones": {
    "power": {
      "source": "inferred_default_percent_ftp",
      "calc_type": "percent_ftp",
      "functional_threshold_power": 215,
      "upper_bounds_watts": [118, 161, 194, 226, 258, 323, 430, 4000],
      "time_in_zone_s": [1783.3, 692.051, 544.975, 419.036, 345.013, 373.999, 193.989, 78.99, 0, 0]
    }
  }
}
```

The older `heart_rate_zone_bounds_bpm` metadata field can remain as a
compatibility alias while new code reads from `zones.heart_rate.upper_bounds_bpm`.

## Source Semantics

Use explicit source markers:

- `fit`: boundary or time-in-zone values were extracted from FIT fields.
- `inferred_default_percent_ftp`: power boundaries were inferred from FTP and
  Garmin-like default percentages because FIT did not include explicit
  boundaries. This is an active supported import path, not only a display-only
  fallback.
- `calculated_records`: time-in-zone values were calculated from record samples
  using selected boundaries.
- `fallback_default`: UI fallback because no usable FIT zone data exists.

Do not label inferred power boundaries as extracted.

## Power Boundary Inference

When `pwr_calc_type = percent_ftp` and FTP is available but
`power_zone_high_boundary` is missing, infer the common Garmin-like defaults:

```text
55%, 75%, 90%, 105%, 120%, 150%, 200%, 4000 W cap
```

This is the intended first implementation for Edge-style FIT files that provide
FIT power time-in-zone and FTP but omit explicit power-zone boundaries. Garmin
zones are user-configurable, so extracted FIT boundaries always take precedence,
but inferred default percent-FTP boundaries should be persisted and used when
that is the best available source.

## Validation

During implementation, validate inferred boundaries against Garmin-provided
`time_in_power_zone` where record-level power data is available:

1. Build power zones from explicit FIT boundaries when present, otherwise from
   inferred default percent-FTP boundaries.
2. Calculate time-in-power-zone from record samples.
3. Compare calculated durations with FIT `time_in_power_zone`.
4. Record or log enough detail to review mismatches during local testing.

This validation is a sanity check for binning, timestamp handling, stopped-time
handling, and the inferred Edge default. It is not a reason to avoid importing
inferred boundaries. If the inferred boundaries do not match a future sample,
that sample can be used to refine or remove the inference later.

Suggested validation fields:

```text
file
device
sport/sub_sport
functional_threshold_power
boundary_source
fit_time_in_power_zone_s
calculated_time_in_power_zone_s
absolute_error_s
relative_error_pct
notes
```

## UI Behaviour

Heart-rate zone chart:

- Use FIT-provided HR boundaries when available.
- Prefer FIT-provided `time_in_hr_zone` for Garmin files when present.
- If only boundaries are available, calculate time-in-zone from records.
- If no FIT boundaries exist, continue using default zones as fallback.

Power zone chart:

- Add a power-zone chart only when power-zone data is meaningful.
- Prefer FIT-provided `time_in_power_zone` when present.
- Use FIT-provided power boundaries when available.
- Use inferred default percent-FTP boundaries when explicit boundaries are
  absent and FTP plus `pwr_calc_type = percent_ftp` are available.
- If no time-in-zone exists but power records and boundaries exist, calculate
  time-in-zone from records.
- Do not render a power-zone chart for files without power samples and without
  power time-in-zone data.

## Export Behaviour

JSON export should include the persisted zone metadata. Inferred fields must keep
their source marker so consumers can distinguish extracted values from inferred
display helpers.

## Non-Goals

- No user editing of zones in this branch.
- No cross-activity zone profile history.
- No backfill of existing database rows unless the user explicitly reimports.
- No attempt to reverse-engineer custom power-zone boundaries from
  `time_in_power_zone` alone. The inference path uses FTP plus the percent-FTP
  calculation type.
- No custom UI for selecting alternate zone models.

## Acceptance Criteria

- FIT import extracts HR zone boundaries, time-in-HR-zone, HR calculation type,
  max HR, resting HR, and threshold HR when present.
- FIT import extracts power time-in-zone, power calculation type, FTP, and
  explicit power-zone boundaries when present.
- Power boundaries are inferred from FTP when explicit FIT boundaries are
  absent, `pwr_calc_type = percent_ftp` is present, and the source is marked as
  inferred.
- Local validation compares inferred/calculated power-zone durations with FIT
  `time_in_power_zone` for representative Edge, FR255, and FR935 files.
- Existing HR zone charts continue to work for files without FIT zone metadata.
- Power-zone chart is shown only when meaningful power-zone data exists.
- JSON export includes zone metadata with source markers.
