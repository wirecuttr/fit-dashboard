# Cardiac Decoupling Design

## Summary

Cardiac decoupling, also called heart-rate drift or aerobic decoupling, measures how much cardiovascular cost rises relative to output during a sustained aerobic activity. FIT Dashboard should calculate this as a derived activity insight for eligible endurance activities.

The first implementation should produce one or more mode-specific percentage values plus enough supporting fields to explain why values are available or unavailable.

The first slice is a frontend-only implementation shown on the Individual activity detail view. It calculates from existing activity metadata and records already exposed by the backend. Backend ownership, persistence, export, activity-list integration, and overview integration are deferred unless they are later judged valuable.

## Goals

- Calculate cardiac decoupling from recorded time-series data rather than relying on optional FIT summary fields.
- Support steady endurance activities where decoupling is meaningful.
- Avoid showing misleading values for short, interval-heavy, or low-data-quality activities.
- Make the calculation transparent enough that users can understand the result.
- Keep the first implementation simple and testable.
- Make clear that the metric is most meaningful for steady aerobic efforts and repeated comparisons under similar conditions.

## Non-Goals

- No medical interpretation or diagnosis.
- No training plan recommendations.
- No dependency on FIT `normalized_power` fields; normalized power should be computed from records when needed.
- No automatic rewriting of historical activities outside normal derived metric refresh behavior.
- No complex interval detection in the first release.
- No assumption that every eligible activity is a formal heart-rate drift test.
- No backend API, database persistence, activity-list column, overview aggregation, or export support in the first slice.

## Definitions

Efficiency factor for a segment:

```text
EF = output / heart_rate
```

For cycling with normalized power:

```text
EF = normalized_power_w / average_heart_rate_bpm
```

For speed/pace-based activities:

```text
EF = average_speed_m_s / average_heart_rate_bpm
```

Here `average_heart_rate_bpm` and `average_speed_m_s` are time-weighted averages over the included samples in the evaluated bin or segment. If a raw average-power mode is added later, its efficiency factor would use the same bin/segment scope:

```text
EF = average_power_w / average_heart_rate_bpm
```

Cardiac decoupling:

```text
decoupling_pct = ((EF_first_half - EF_second_half) / EF_first_half) * 100
```

This uses the TrainingPeaks-style first-half baseline, where the first-half EF is the denominator.

Positive values mean output per heartbeat declined in the second half. Negative values are possible when the second half is more efficient than the first.

## Configuration

The calculation should use explicit configuration rather than hard-coded thresholds. A config object/file makes the feature easier to tune without changing the calculation logic.

Initial configurable values:

```ts
type CardiacDecouplingConfig = {
  minActivityDurationS: number;       // default: 60 minutes, in seconds
  warmupIgnoreS: number;              // default: 10 minutes, in seconds
  ignoreLastS: number;                // default: 5 minutes, in seconds
  targetBinDurationS: number;         // default: 30 minutes, in seconds
  minBinDurationS: number;            // default: 20 minutes, in seconds
  minHrCoveragePct: number;           // default: 80
  minOutputCoveragePct: number;       // default: 80
  minPairedCoveragePct: number;       // default: 80
  resampleIntervalS: number;          // default: 1
  maxInterpolationGapS: number;       // default: 5
  maxRecordGapS: number;              // default: 15
  minRollingWindowCoveragePct: number; // default: 90
  highVariabilityIndexThreshold: number; // default: 1.05
  lowDriftThresholdPct: number;       // default: 5
  highDriftThresholdPct: number;      // default: 10
};
```

Keep these defaults internal/constants in the first release; a user-facing settings UI is not required initially. The first slice stores them in `src/lib/cardiacDecoupling.ts` as `DEFAULT_CARDIAC_DECOUPLING_CONFIG`. If the calculation moves backend-side later, mirror the defaults in Rust or load them from app settings.

## Eligibility

The metric should be calculated only when all required conditions are met.

Minimum conditions:

- Activity duration is at least `minActivityDurationS` (default: 60 minutes).
- The evaluated duration can be split into at least two bins of `minBinDurationS` each.
- The activity belongs to a supported sport group.
- Heart-rate coverage meets `minHrCoveragePct` for all required halves and bins.
- At least one output-based mode has `minOutputCoveragePct` and `minPairedCoveragePct` for all required halves and bins, or the activity uses a supported constant-output machine mode.
- Average HR is greater than 0 in all required halves and bins.
- Average output is greater than 0 in all required halves and bins for output-based modes.

Supported sport groups are allowlists based on canonical FIT-derived `sport` and `sub_sport` values. Do not infer calculation eligibility from `activity_name` or `file_name`, because names are user-editable, can be generated identifiers, and can be localized. Activities outside these groups are unavailable by default. This is preferable to maintaining an excluded list because Garmin's FIT `sport` and `sub_sport` enums are large and still evolving.

Cycling-like activities:

- `cycling`
- `cycling` with sub-sports such as `indoor_cycling`, `spin`, `road`, `mountain`, `gravel_cycling`, or `commuting`
- `fitness_equipment` with `sub_sport=indoor_cycling`

Output rule: use computed normalized power when it meets power, paired-coverage, and rolling-window coverage thresholds. If normalized power cannot be calculated reliably, use speed/distance as a low-confidence fallback when speed meets the output and paired-coverage thresholds. Indoor and outdoor cycling follow the same rule.

Running/walking-like activities:

- `running`
- `walking`
- `hiking`
- `running` with sub-sports such as `treadmill`, `trail`, `track`, or `indoor_running`
- `walking` with sub-sports such as `indoor_walking`, `casual_walking`, or `speed_walking`

Output rule: require speed/distance to meet the output and paired-coverage thresholds. Indoor and outdoor running/walking follow the same rule.

Other supported speed-based endurance activities:

- `rowing`
- `cross_country_skiing`
- `training` with `sub_sport=cardio_training`
- `fitness_equipment` with `sub_sport=indoor_rowing`

Output rule: require speed/distance to meet the output and paired-coverage thresholds unless a sport-specific output rule is added. Cardio training support may be limited by whether the FIT file records a meaningful output stream.

Machine-based constant-output activities:

- `fitness_equipment` with `sub_sport=elliptical`
- `fitness_equipment` with `sub_sport=stair_climbing`
- `fitness_equipment` with `sub_sport=stair_stepper`

Output rule: use speed/distance if it meets the output and paired-coverage thresholds. If no usable output stream is recorded, calculate constant-output heart-rate drift from HR only. This is supported in the initial implementation, but the UI must clearly state that the result assumes the machine effort, pace, resistance, or cadence was held steady across the evaluated window.

All other sport/sub-sport combinations are unavailable until explicitly evaluated and added to the allowlist.

Sport support is necessary but not sufficient for a meaningful value. The metric is most useful for steady Zone 1/Zone 2 or aerobic-threshold efforts. Interval-heavy workouts, efforts above aerobic threshold, long stops, major terrain changes, heat, dehydration, caffeine, poor sleep, accumulated fatigue, and sensor accuracy problems can all make the value harder to interpret.

## FIT Sport Reference

The authoritative list of Garmin FIT sport and sub-sport values is the FIT SDK `Profile.xlsx` file. The current Garmin FIT SDK Tools release exposes 82 top-level `sport` values and 112 `sub_sport` values. Activity files store sport classification in the Session message `sport` and `sub_sport` fields.

Relevant values for this feature include:

- Top-level `sport`: `running`, `cycling`, `fitness_equipment`, `walking`, `cross_country_skiing`, `rowing`, `hiking`, `training`.
- Relevant `sub_sport`: `treadmill`, `trail`, `track`, `spin`, `indoor_cycling`, `road`, `mountain`, `gravel_cycling`, `commuting`, `indoor_rowing`, `elliptical`, `stair_climbing`, `stair_stepper`, `indoor_walking`, `indoor_running`, `cardio_training`.

Design implication: support should be implemented as a positive allowlist of sport/sub-sport combinations. Unknown or newly added Garmin types should be unavailable until explicitly evaluated.

Source: Garmin FIT SDK Tools `Profile.xlsx` in `garmin/fit-sdk-tools`.

## Time Base

Use one deterministic active timeline for all windows, bins, coverage, and averages. This is the calculation time base, not necessarily the same as the stored activity/session duration.

Initial implementation:

- Build an active timeline from sorted `RecordPoint.timestamp` values.
- Each adjacent record interval `[timestamp_i, timestamp_i+1)` contributes to active timeline duration when `0 < delta_time <= maxRecordGapS`.
- A record interval with `delta_time > maxRecordGapS` is treated as a device pause or auto-pause and is omitted from the active timeline before warmup/end exclusions, binning, and coverage calculations.
- Active timeline duration is the sum of contributing record intervals. It is shorter than raw elapsed session duration when there are full-record gaps longer than `maxRecordGapS`.
- Activity start on the active timeline is 0. Activity end on the active timeline is total active timeline duration.
- Do not infer moving time and do not remove stopped/coasting intervals that were actually recorded.
- If the device stops recording during a pause, the full-record gap is removed by the active-timeline rule and does not count against stream coverage.
- Use half-open intervals `[start, end)` for evaluated windows, halves, bins, and coverage intervals. This prevents boundary samples from being double-counted.
- Apply stream gap and interpolation rules after mapping records onto the active timeline. Per-stream sensor dropouts still affect coverage; full-record device pauses do not.
- If FIT timer-event active intervals are parsed later, they can become a separate configurable time-base option. They are not part of the initial calculation.

## Evaluation Window

Initial window selection:

1. Require activity duration to be at least `minActivityDurationS` (default: 60 minutes).
2. Always exclude the first `warmupIgnoreS` (default: 10 minutes) as warmup.
3. Always exclude the final `ignoreLastS` (default: 5 minutes) to avoid cooldown, device stop/start noise, and post-workout idle records.
4. Use the remaining evaluated duration as `[warmupIgnoreS, active_timeline_duration - ignoreLastS)`.
5. Require evaluated duration to be at least `2 * minBinDurationS` (default: 40 minutes). If not, return unavailable.
6. Build analysis bins using the binning rules below.
7. Calculate EF for each bin where the selected mode supports EF.
8. Calculate activity decoupling from the first half of evaluated duration vs the second half of evaluated duration.

With default config, an activity with 60 minutes of duration and no full-record gaps evaluates active minutes 10-55, giving 45 evaluated minutes and two 22.5-minute bins. A shorter evaluated duration that cannot produce at least two 20-minute bins is unavailable.

This is a minimum availability rule, not a claim that 45 evaluated minutes is ideal for every use. The reviewed coaching guidance commonly describes either a 40-60 minute controlled test segment or at least a one-hour endurance workout, excluding warmup and cooldown. The UI should expose evaluated duration so users can judge whether the analyzed section is comparable to their usual method.

## Binning

All cardiac decoupling calculations are based on evaluated duration after the active timeline is built and warmup/end exclusions are applied. Detail bins are equal-duration half-open slices of that evaluated duration.

Default auto-binning:

```text
if evaluated_duration < 2 * minBinDurationS:
    unavailable

bin_count = floor((evaluated_duration + (targetBinDurationS / 2)) / targetBinDurationS)
bin_count = max(2, bin_count)

while evaluated_duration / bin_count < minBinDurationS:
    bin_count -= 1

if bin_count < 2:
    unavailable

bin_duration = evaluated_duration / bin_count
```

Rules:

- `bin_count` must be at least 2.
- The `floor((evaluated_duration + targetBinDurationS / 2) / targetBinDurationS)` formula defines round-half-up behavior and avoids language-dependent `round()` behavior.
- `bin_duration` must be at least `minBinDurationS`.
- Bins must cover the evaluated duration evenly as half-open intervals.
- The final bin ends exactly at the evaluated window end.
- Do not create a short trailing bin.
- If no valid `bin_count` can satisfy `minBinDurationS`, return unavailable.

`targetBinDurationS` (default: 30 minutes) drives auto bin count, but actual bin duration is adjusted so all bins are equal. Example: after warmup and end exclusions, a 140-minute evaluated duration with a 30-minute target creates 5 bins of 28 minutes each.

Each bin has:

- Average HR
- Average output for output-based modes
- Efficiency factor for output-based modes
- HR coverage
- Output coverage for output-based modes
- Paired HR/output coverage for output-based modes
- Rolling-window coverage for normalized-power mode

Activity decoupling should remain compatible with the classic first-half vs second-half definition:

```text
activity_decoupling = ((EF_first_half - EF_second_half) / EF_first_half) * 100
```

For two-bin output-based activities:

```text
EF_first_half = bins[0].efficiency
EF_second_half = bins[1].efficiency
```

For longer activities with more than two bins, calculate first-half and second-half EF by aggregating the underlying records across each half of the evaluated duration, not by averaging bin EF values. This keeps the activity decoupling value stable even when bin count changes.

Additional bin data can support future charts or trend summaries. There are two useful bin-drift views:

Overall bin drift compares the first bin with the last bin:

```text
overall_bin_drift = ((EF_first_bin - EF_last_bin) / EF_first_bin) * 100
```

Adjacent bin drift compares each neighboring bin pair:

```text
adjacent_bin_drift[i] = ((EF_bin_i - EF_bin_i_plus_1) / EF_bin_i) * 100
```

For a two-bin activity, activity decoupling and overall bin drift are usually equivalent because the bins are the first and second evaluated halves. For activities with more than two bins, overall bin drift and adjacent bin drift are supporting detail, not replacements for activity decoupling.

Future options:

- Allow users to select a steady section manually.
- Use lap boundaries when laps are meaningful and cover similar durations.
- Add a steadiness check for output variability so interval-heavy workouts can be marked as lower-confidence or unavailable.
- Detect and exclude long stops or obvious interval blocks.

## Time-Series Normalization and Gap Handling

Use one shared time-series method for heart rate, power, speed, and distance-derived speed after records have been mapped onto the active timeline. Normalized power uses the same method, then adds explicit 1-second resampling and centered 30-second rolling-window calculation.

Stream validity:

- HR sample is valid when it is finite and greater than 0 bpm.
- Power sample is valid when it is finite and greater than or equal to 0 W. Zero watts is valid output and should be included in averages.
- Instantaneous speed sample is valid when it is finite and greater than or equal to 0 m/s. Zero speed is valid output and should be included in averages.
- Cumulative distance sample is valid when it is finite and non-negative.
- Output-based segment averages must still be greater than 0. A segment with only zero output is unavailable because EF would be zero or undefined for decoupling.

Rules:

1. Sort records by timestamp and discard duplicate or non-monotonic timestamps.
2. Clip records to the evaluated window before building halves and bins.
3. Treat each stream independently. HR coverage, power coverage, speed coverage, and distance coverage can differ in the same segment.
4. Define a stream gap as active elapsed time between adjacent valid samples for that stream. For example, HR has an HR gap, power has a power gap, and speed has a speed gap.
5. Use elapsed-time-weighted averages for HR, average power, and instantaneous speed.
6. Prefer distance-over-time speed when cumulative distance is usable for the segment. Distance-derived speed uses adjacent valid distance samples.
7. For distance-derived speed, each adjacent distance pair creates one covered interval when `delta_time > 0`, `delta_time <= maxInterpolationGapS`, and `delta_distance >= 0`. The interval speed is `delta_distance / delta_time`. A zero-distance interval is valid and has speed 0. A negative distance delta indicates a reset or corrupt value; that interval is uncovered and a new distance span starts at the later sample.
8. Segment average distance-derived speed is `sum(delta_distance) / sum(covered_elapsed_time)` across covered distance intervals in that segment.
9. Bridge sample-value gaps less than or equal to `maxInterpolationGapS` only for continuity, bin-boundary values, and 1-second resampling. This is gap handling, not smoothing.
10. Bridge means linearly interpolating between valid samples on both sides of a short gap. Do not forward-fill from one side of a gap, and do not extrapolate before the first valid sample or after the last valid sample in a half/bin. For cumulative distance, bridge by interpolating distance across the short gap, then derive speed from distance-over-time.
11. Treat gaps greater than `maxInterpolationGapS` as uncovered time for that stream. Large per-stream gaps do not automatically fail a mode; they reduce coverage and fail the mode only when coverage falls below threshold. Full-record gaps greater than `maxRecordGapS` are already removed from the active timeline and are not stream gaps.
12. At the start or end of a half/bin, count time before the first valid sample or after the last valid sample as uncovered unless it is bridged by a valid sample within `maxInterpolationGapS`.
13. Do not remove uncovered intervals globally. A gap in one stream affects only modes that require that stream.
14. For output-based EF modes, calculate averages from paired intervals where both HR and the selected output stream are valid or bridged. Unpaired intervals are excluded from that mode average and count against `minPairedCoveragePct`.
15. Constant-output machine mode uses HR-valid intervals only because it has no recorded output stream.
16. Require each half and bin to satisfy `minHrCoveragePct` and, for output-based modes, `minOutputCoveragePct` and `minPairedCoveragePct`.
17. If gap handling leaves too little valid data for any required half, bin, or rolling-window set, return the relevant mode as unavailable rather than approximating silently.

Coverage should be reported per mode so the UI can explain whether a value is unavailable because HR, power, speed, paired-stream, or normalized-power rolling-window coverage failed.

## Output Source Selection

Power-based cycling mode:

- Use `RecordPoint.power`.
- Cycling-like activities use normalized power when it can be calculated reliably from record-level power.
- Calculate normalized-power decoupling by computing normalized power from the power time series for each evaluated half and bin.
- Do not depend on session-level or lap-level FIT `normalized_power` fields. Those fields are optional and may not align with the evaluated halves or bins.
- Do not use average-power decoupling as an automatic cycling fallback. Average power may still be calculated internally for variability index or future diagnostics, but it should not be selected/displayed automatically.
- If normalized power cannot be calculated reliably, attempt speed as a low-confidence cycling fallback. If speed/distance is also unavailable, the cycling result is unavailable.

Computed normalized power:

```text
rolling_30s_power[t_center] = average power over [t_center - 15s, t_center + 15s)
normalized_power = fourth_root(mean(rolling_30s_power[t_center]^4))
```

Normalized-power rules:

1. Build a 1-second power series using `resampleIntervalS` after the shared gap handling.
2. Build normalized-power rolling values as a continuous centered 30-second time series over the evaluated activity. A rolling sample at `t_center` covers `[t_center - 15s, t_center + 15s)`.
3. Only rolling windows fully inside the evaluated window can contribute. Windows can cross half and bin boundaries; assignment to a half or bin is based on the centered timestamp.
4. A rolling window contributes only when its power coverage is at least `minRollingWindowCoveragePct`.
5. The first possible contributing rolling sample is centered 15 seconds after the evaluated window starts. The last possible contributing rolling sample is centered 15 seconds before the evaluated window ends.
6. HR for normalized-power EF is averaged over the same half/bin segment as the normalized-power output. Do not time-shift HR to match power.
7. If a half/bin has no accepted centered rolling samples, or accepted samples do not meet coverage requirements, normalized-power mode is unavailable for that half/bin.

Speed/pace-based mode:

- Use speed internally whenever a speed-based result is selected, including cycling speed fallback and supported speed-first activities.
- Treat running, walking, and hiking UI copy as pace-based HR drift (`Pa:Hr`) because that is the common running convention, but calculate EF from speed so higher output still means better efficiency.
- Internal formula: `EF = speed / HR`. Do not calculate EF as raw `pace / HR`, because pace is the inverse of speed and would reverse the efficiency direction.
- For running, walking, and hiking charts, display the selected output as pace in `min/km` or `min/mi` with an inverted y-axis, matching the existing pace chart behavior. Zero-speed pace points should render as gaps rather than huge pace spikes.
- For other speed-based sports such as rowing or cross-country skiing, display the selected output as speed unless a sport-specific convention is added later.
- Prefer distance-over-time speed when cumulative distance is usable, because it is usually less noisy than instantaneous speed.
- Use `RecordPoint.speed_m_s` when distance-based speed cannot be calculated.
- If speed is missing but distance and timestamps are present, derive speed from distance deltas using the distance-derived speed rules above.
- Ignore invalid or negative instantaneous speeds.
- Do not apply arbitrary smoothing in the first implementation. A 1-second moving average is usually equivalent to no smoothing because FIT record samples are commonly about 1 second apart or less frequent. If instantaneous speed must be used, calculate time-weighted averages per half/bin and add a longer explicit smoothing window only if test fixtures show unacceptable noise.

Running-power mode:

- Running power is useful when recorded by devices such as Stryd, Garmin, or Coros, but it is more device/ecosystem-dependent than cycling power and should not silently replace pace-based running drift in the first implementation.
- The first implementation should keep running/walking default mode pace-based. Running power can be added later as an additional selectable mode when a run has adequate power and HR coverage.

Implementation convention references:

- TrainingPeaks names aerobic decoupling as `Pa:Hr` for pace-to-heart-rate and `Pw:Hr` for power-to-heart-rate, and describes running use cases in terms of pace while cycling uses power.
- Runalyze names the running variant pace-based, but its aerobic-efficiency formula uses `Speed [m/s] / Heart rate [bpm]`. This matches the internal speed/HR calculation while preserving runner-facing pace terminology.
- Stryd documents running power as a useful run-training metric for hills, wind, and consistent effort, but this supports treating running power as an optional additional mode rather than the initial default.

Constant-output machine mode:

- Include this in the first implementation for supported machine activities with no usable output stream.
- Apply to elliptical, stair machine, and similar supported machine activities when HR meets coverage thresholds and speed/distance output is unavailable or fails coverage/quality checks.
- The calculation assumes the evaluated window was performed at steady machine effort, pace, resistance, or cadence.
- In that case, output cancels out and drift can be represented as the TrainingPeaks-equivalent HR drift between halves:

```text
constant_output_drift = ((HR_second_half - HR_first_half) / HR_second_half) * 100
```

- This should be labeled separately from speed and normalized-power decoupling because it depends on a steady-effort assumption rather than recorded output.

Mode selection:

```text
results = []

if sport is cycling-like:
    add normalized_power result
    if normalized_power is unavailable:
        add speed result with cycling_speed_fallback assumption
else if sport is constant-output-machine:
    if speed meets output and paired-coverage thresholds:
        add speed result
    else:
        add constant_output_hr result
else if sport is speed-supported:
    add speed result
else:
    unavailable
```

Each added result is independently marked available or unavailable with a reason. Top-level availability is true when at least one result is available. Unsupported sport groups return top-level `available=false`, `reason=unsupported_activity_type`, and an empty `results` array.

## Data Quality Rules

For each evaluated half, bin, and mode:

- Heart-rate coverage must be at least `minHrCoveragePct`.
- Output coverage must be at least `minOutputCoveragePct` for output-based modes.
- Paired HR/output coverage must be at least `minPairedCoveragePct` for output-based modes.
- Constant-output machine mode does not require output or paired coverage.
- Segment or bin duration must be at least `minBinDurationS`.
- Average HR must be greater than 0.
- Average output must be greater than 0 for output-based modes.

Coverage should use the shared time-series method, not a raw record count. A stream is covered for elapsed intervals where valid samples exist or short gaps are bridged within `maxInterpolationGapS`. HR coverage requires positive heart-rate values. Output coverage requires finite non-negative power or speed values for that mode. Paired coverage is elapsed time where both HR and the selected output stream are valid for the same interval. Constant-output machine mode uses HR coverage only and must carry the steady-effort assumption through to the UI.

The calculation should return an unavailable reason when quality checks fail.

Suggested unavailable reasons:

- `duration_too_short`
- `unsupported_activity_type`
- `missing_heart_rate`
- `missing_power`
- `missing_speed`
- `insufficient_heart_rate_coverage`
- `insufficient_output_coverage`
- `insufficient_paired_coverage`
- `insufficient_rolling_window_coverage`
- `invalid_segment_average`

## Result Shape

Frontend/internal result for the first slice:

```ts
type CardiacDecouplingMode = "average_power" | "normalized_power" | "speed" | "constant_output_hr";

type CardiacDecouplingWarning = "high_variability_effort";

type CardiacDecouplingUnavailableReason =
  | "duration_too_short"
  | "unsupported_activity_type"
  | "missing_heart_rate"
  | "missing_power"
  | "missing_speed"
  | "insufficient_heart_rate_coverage"
  | "insufficient_output_coverage"
  | "insufficient_paired_coverage"
  | "insufficient_rolling_window_coverage"
  | "invalid_segment_average";

type CardiacDecouplingModeResult = {
  available: boolean;
  reason?: CardiacDecouplingUnavailableReason;
  mode: CardiacDecouplingMode;
  decouplingPct?: number;
  firstHalfEfficiency?: number;
  secondHalfEfficiency?: number;
  firstHalfAvgHr?: number;
  secondHalfAvgHr?: number;
  firstHalfAvgOutput?: number;
  secondHalfAvgOutput?: number;
  firstHalfHrCoveragePct?: number;
  secondHalfHrCoveragePct?: number;
  firstHalfOutputCoveragePct?: number;
  secondHalfOutputCoveragePct?: number;
  firstHalfPairedCoveragePct?: number;
  secondHalfPairedCoveragePct?: number;
  firstHalfRollingWindowCoveragePct?: number;
  secondHalfRollingWindowCoveragePct?: number;
  overallBinDriftPct?: number;
  adjacentBinDriftPct?: number[];
  assumption?: "constant_output" | "cycling_speed_fallback";
  bins?: Array<{
    startS: number;
    endS: number;
    efficiency?: number;
    avgHr: number;
    avgOutput?: number;
    hrCoveragePct: number;
    outputCoveragePct?: number;
    pairedCoveragePct?: number;
    rollingWindowCoveragePct?: number;
  }>;
};

type CardiacDecouplingResult = {
  available: boolean;
  reason?: CardiacDecouplingUnavailableReason;
  evaluatedDurationS?: number;
  warmupExcludedS?: number;
  endExcludedS?: number;
  defaultMode?: CardiacDecouplingMode;
  variabilityIndex?: number;
  warnings?: CardiacDecouplingWarning[];
  results: CardiacDecouplingModeResult[];
};
```

The exact TypeScript type lives in the frontend for the first slice. If the calculation becomes backend-owned later, mirror this shape in Rust models or introduce an equivalent serialized API response.

Result behavior:

- `results` contains every mode added by the deterministic mode-selection rules above.
- Modes not applicable to the sport group are omitted.
- A mode result is included as unavailable when that mode was attempted but failed quality checks.
- Top-level `available` is true when at least one mode result is available.
- Top-level `reason` is set only when no mode result is available. Use the reason from the highest-priority attempted mode, where priority is the order in which mode-selection adds results.
- `defaultMode` is selected from available results only.
- Cycling default mode is `normalized_power` when available. If normalized power is unavailable and speed fallback is available, cycling defaults to `speed` with low confidence. Average power is not an automatic cycling default or fallback.
- Non-cycling speed-supported activities default to `speed` when available.
- Constant-output machine activities default to `speed` when speed is available, otherwise `constant_output_hr`.

## Confidence Flags

Confidence flags do not make a result unavailable. They give the UI context when the activity is eligible but interpretation is weaker. The UI should always show a confidence label for available results.

Confidence levels:

- `High confidence`: output-based result using the preferred output for that activity group, all coverage thresholds passed, and no confidence warnings or fallback assumptions are present.
- `Medium confidence`: constant-output heart-rate drift result that depends on the assumption that machine effort stayed steady, with no low-confidence warning.
- `Low confidence`: any available result with `high_variability_effort`, or any cycling result that uses speed because normalized power was unavailable. Low confidence overrides medium or high confidence.

Cycling variability flag:

```text
variability_index = normalized_power / average_power
```

Rules:

- Calculate cycling variability index when both normalized-power and average-power values can be calculated internally for the evaluated activity.
- If `variability_index > highVariabilityIndexThreshold` (default: 1.05), add warning `high_variability_effort`.
- The warning means the effort may be too variable for clean aerobic decoupling interpretation.
- Do not apply this warning to speed or constant-output modes in the first implementation.
- If normalized power is unavailable, skip the warning. Cycling may still fall back to speed with low confidence when speed/distance passes coverage checks.

## UI Placement

Show the metric on the Individual activity detail view, in the existing insights grid below the main chart/map area. `ActivityInsights` is the internal React component name; the app does not currently show a visible section heading called "Activity Insights".

Place the card near other effort and endurance panels such as heart-rate zones, cadence/power, effort heatmap, and power-vs-heart-rate.

Display:

- Label: `Heart Rate Drift`, with `HR Drift` acceptable in compact chart titles.
- Value: percentage with one decimal place, for example `4.8%`
- Mode selector/badge: `Normalized Power`, `Pace`/`Speed`, or `Constant Effort HR Drift`. Use `Pace` for running, walking, and hiking speed-mode results; use `Speed` for cycling fallback and other speed-mode sports.
- Show evaluated duration and excluded warmup/end time in the detailed view, for example `Analyzed 45 min after excluding 10 min warmup and 5 min cooldown`.
- Add a `?` help button in the HR Drift detail chart header. For now the help text can be English-only until the copy is finalized for localization. It should explain the chart, the high-level drift calculation, normalized-power vs speed fallback, pace display for speed-based run/walk/hike results, grey excluded regions, and steady-effort caveats such as intervals, stops, terrain, heat, dehydration, caffeine, poor sleep, fatigue, or bad sensor data.
- For `Constant Effort HR Drift`, add mode-specific help: `This assumes the machine effort stayed steady. Changes in resistance, incline, cadence, or machine program can distort the result.`
- Always show confidence when a result is available: `High confidence`, `Medium confidence`, or `Low confidence`. In the chart header, show confidence as plain text rather than a badge, with a short reason when applicable: `highly variable effort`, `speed fallback`, or `steady-effort assumption`.
- For `high_variability_effort`, show low confidence plus the short reason rather than hiding the metric.
- Replace the standalone summary card with a detail chart panel in the existing chart grid. The chart panel should show a large decoupling percentage plus a color-coded drift badge, the EF or constant-output HR summary, and confidence text in its header. Do not duplicate the selected output mode or analyzed-window text in the chart header because the chart legend and visual excluded regions already show that context.
- The detail chart should plot HR plus the selected output mode: centered normalized power for `normalized_power`, pace display for running/walking/hiking `speed` mode, and speed display for cycling fallback and other `speed` mode activities. For `constant_output_hr`, show an HR-only detail chart because no output stream is used. Do not show a normalized-power overlay for speed-based results.
- The detail chart should shade excluded warmup, cooldown, and full-record gap ranges in grey. Show horizontal labels for warmup and cooldown shaded regions, but do not label shaded gap regions. For display, trim or hide gap ranges that overlap warmup/cooldown ranges so nested exclusions do not draw redundant shaded regions. This is visual cleanup only and must not change active-time, coverage, binning, or EF calculations.
- The detail chart should draw vertical dashed markers for the start of each evaluated bin and the evaluated-end/cooldown-start boundary. The first evaluated marker should be labeled `Bin 1`, not `Warmup`, because the warmup range is already shown by the grey excluded area. Draw the evaluated-end/cooldown-start line without a text label because the cooldown shaded region carries that label.
- The detail chart should use dynamic padded y-axis bounds. HR bounds round to multiples of 10 and clamp the lower bound to at least `30 bpm`; power bounds round to multiples of 10 and clamp the lower bound to at least `0 W`; speed and pace bounds round to whole display units and clamp the lower bound to at least `0`.
- Detail chart smoothing is display-only. When graph smoothing is enabled, smooth the plotted HR and selected output series using the shared chart smoothing helper so the detail chart is visually consistent with the main pace chart. Do not feed the smoothed chart series back into the HR drift calculation, bin averages, EF values, or summary metric.
- Smoothing rationale: HR drift is a slow segment-level trend, while second-by-second speed and GPS-derived pace can be visually noisy. The calculation already reduces noise through long time-weighted halves/bins and explicit coverage/gap rules. Display smoothing improves readability without changing the metric or reducing comparability with Pa:Hr/Pw:Hr implementations that compare segment-level efficiency.
- Show negative decoupling as a raw negative percentage with neutral or positive wording, for example `-2.1%, increased efficiency`. Do not treat it as an error.
- Supporting text for output-based modes:

```text
First half EF 2.21, second half EF 2.10
```

Use enough EF precision for the selected output mode. Power-based EF can use two decimals, while speed-based EF should use four decimals because speed divided by heart rate is usually a small value.

- Supporting text for constant-effort machine mode:

```text
First half HR 132 bpm, second half HR 141 bpm
```

Unavailable state:

- Do not show a scary warning.
- Show a neutral unavailable message only in the detailed insight area.
- Example: `Cardiac decoupling is unavailable: insufficient power coverage.`

Interpretation bands should use configurable thresholds:

```text
< lowDriftThresholdPct: low drift
lowDriftThresholdPct-highDriftThresholdPct: moderate drift
> highDriftThresholdPct: high drift
```

Default values are `lowDriftThresholdPct=5` and `highDriftThresholdPct=10`. Apply these bands to positive drift. Negative drift should be displayed as increased efficiency with neutral/positive wording rather than classified as high drift. These are TrainingPeaks-style guidance bands, not hard physiological cutoffs. TrainingPeaks describes less than 5% decoupling as strong aerobic endurance at that intensity, 5-10% as moderate endurance limitations or fatigue, and greater than 10% as likely above aerobic threshold or insufficient endurance for the effort.

Reference: TrainingPeaks, `Aerobic Decoupling and Heart Rate Drift Explained`: https://www.trainingpeaks.com/coach-blog/aerobic-endurance-and-decoupling/

These labels should be descriptive, not prescriptive.

Context copy should avoid presenting decoupling as a standalone fitness verdict. It should note that values are most useful on steady aerobic efforts and are best compared against similar workouts under similar conditions.

## Implementation Location

First-slice implementation:

- Add a frontend utility that calculates the metric from `RecordPoint[]` and selected activity metadata.
- Keep the calculation pure and unit-testable.
- Use existing parsed records and metadata without a database migration.
- Fetch a 1-second downsampled record stream for analysis through the existing `getRecords(activityId, 1000)` path.
- Show the result only in the Individual activity detail view.
- Do not persist the result in DuckDB.
- Do not expose a dedicated backend REST endpoint or Tauri command.

Deferred implementation options:

- Move calculation to Rust if metrics need to be persisted, exported, or shared through API responses.
- Store derived metrics in `metadata_json` or a dedicated derived-metrics table if recalculation becomes expensive or if list/overview/export use cases need queryable values.
- Add a dedicated REST endpoint and Tauri command if the metric needs to be shared outside the current frontend detail component.

See `heart-rate-drift-implementation.md` for the first-slice implementation notes and `heart-rate-drift-deferred.md` for optional future work.

## Testing

Unit tests should cover:

- Eligible cycling activity with power and HR returns a normalized-power result when normalized-power calculation is available.
- Zero-watt cycling samples count as valid power coverage and reduce power averages without invalidating normalized-power windows or variability diagnostics.
- Segment/bin average output of 0 returns `invalid_segment_average` for output-based modes.
- Cycling with unusable normalized-power windows falls back to speed with a `cycling_speed_fallback` assumption when speed/distance quality checks pass; otherwise it is unavailable.
- Time base uses the active timeline, omits full-record gaps greater than `maxRecordGapS`, and keeps recorded stopped/coasting intervals.
- Bin count uses round-half-up formula at `.5` target-duration boundaries.
- Coverage is measured by elapsed time, not raw record count.
- Short HR, power, or speed gaps up to `maxInterpolationGapS` are linearly interpolated consistently across halves and bins.
- Long HR, power, or speed gaps reduce stream coverage and can make the relevant mode unavailable.
- A gap in one stream does not remove the interval from unrelated modes.
- Output-based modes use paired HR/output intervals and fail when paired coverage is too low.
- Result behavior includes attempted-but-unavailable modes and selects `defaultMode` only from available results.
- Normalized-power mode uses centered 30-second windows and assigns each accepted window to halves/bins by center timestamp.
- Distance-derived speed treats zero-distance intervals as valid zero speed and negative distance deltas as uncovered reset/corrupt intervals.
- Eligible running activity with speed and HR.
- Speed-mode activity prefers distance-over-time segment average when distance data is present.
- Indoor cycling without power but with speed and HR returns a speed result.
- Indoor cycling without power, speed, or distance returns unavailable.
- Elliptical or stair machine with HR and no output stream returns a `constant_output_hr` result with a `constant_output` assumption.
- Machine activity with usable speed/distance returns a speed result instead of constant-output HR drift.
- Activity duration shorter than 60 minutes returns unavailable.
- Evaluated duration shorter than `2 * minBinDurationS` returns unavailable.
- Missing HR returns unavailable.
- Low HR coverage in one half returns unavailable.
- Low output coverage in one half returns unavailable.
- Low paired coverage in one half returns unavailable.
- First and second half EF produce the expected TrainingPeaks-style decoupling percentage using first-half EF as denominator.
- Negative decoupling is allowed and displayed as a raw negative value with neutral or positive wording.
- Cycling variability index above `highVariabilityIndexThreshold` adds `high_variability_effort` without making the result unavailable.

Fixture strategy:

- Build synthetic `RecordPoint[]` sequences in tests.
- Avoid relying on large binary FIT fixtures for the calculation tests.

## Open Questions

- Are the initial defaults for `maxInterpolationGapS`, `maxRecordGapS`, and `minRollingWindowCoveragePct` strict enough for real FIT files?
- Are backend ownership, database persistence, activity-list visibility, overview aggregation, or export support valuable enough to justify the added implementation and migration scope?

## References

- TrainingPeaks, `Aerobic Decoupling and Heart Rate Drift Explained`: https://www.trainingpeaks.com/coach-blog/aerobic-endurance-and-decoupling/
  - Supports the Pa:Hr/Pw:Hr framing, first-half vs second-half comparison, common interpretation bands, endurance-use context, and warmup/cooldown exclusion for target test portions.
- TrainingPeaks Help Center, `Glossary`: https://help.trainingpeaks.com/hc/en-us/articles/115001271712-Glossary
  - Defines Pw:Hr/Pa:Hr as aerobic decoupling, EF as normalized power or normalized graded pace over average HR, and Pa:Hr/Pw:Hr as pace/power heart-rate decoupling.
- TrainingPeaks Help Center, `Aerobic Decoupling (Pw:Hr and Pa:HR) and Efficiency Factor (EF)`: https://help.trainingpeaks.com/hc/en-us/articles/204071724-Aerobic-Decoupling-Pw-Hr-and-Pa-HR-and-Efficiency-Factor-EF
  - Supports EF as output over heart rate, cycling power plus HR requirements, running pace plus HR requirements, first-half vs second-half decoupling, steady-state/endurance-zone caveats, section selection, and less-than-5-percent guidance.
- RUNALYZE, `Aerobic Efficiency`: https://runalyze.com/glossary/aerobic-efficiency?_locale=en
  - Names the pace variant while defining pace-based AE with speed over HR, supporting internal `speed / HR` calculation for runner-facing pace terminology.
- RUNALYZE, `Aerobic Decoupling`: https://runalyze.com/glossary/aerobic-decoupling?_locale=en
  - Supports first-half vs second-half aerobic-efficiency comparison and typical 0-10 percent decoupling range for consistent efforts.
- JOIN, `Heart rate decoupling`: https://join.cc/cycling-tips/heart-rate-decoupling
  - Supports the power-to-HR two-half calculation, at-least-one-hour guidance, low-intensity/steady-workout requirement, and cautions around caffeine, sleep, dehydration, HR lag, and interval workouts.
- Santa Barbara Triathlon Club, `Decoupling: How to Determine if you are Aerobically Fit`: https://www.sbtriclub.com/decoupling-how-to-determine-if-you-are-aerobically-fit/
  - Supports input-vs-output framing, less-than-5-percent endurance target, two-half calculation, use of normalized power for cycling, and speed/pace for running.
- Uphill Athlete, `Understanding the Heart Rate Drift Test`: https://uphillathlete.com/aerobic-training/heart-rate-drift/
  - Supports steady aerobic test conditions, warmup and cooldown exclusion, 40-60 minute controlled test guidance, lap/manual section selection, and cautions about HR monitor quality.
- Marathon Pace KM, `Cardiac Drift (Heart Rate Drift): What It Means + How to Adjust Pace`: https://marathonpacekm.com/adjust-marathon-pace/cardiac-drift/
  - Supports runner-facing cardiac-drift terminology, pace-vs-heart-rate framing, steady 60-minute field-test examples, first-half vs second-half comparison, and practical caveats around heat, dehydration, fatigue, pacing errors, and accumulated fatigue.
- Stryd, `Train With Power`: https://www.stryd.com/us/en/pages/training-with-power
  - Supports running power as a useful output metric for hills, wind, and effort consistency, but not as a universal default for all running files.
- Stryd Help Center, `Stryd Metrics`: https://help.stryd.com/en/articles/6879522-stryd-metrics
  - Documents running-power calculation context and related device-specific running metrics.
- Garmin FIT SDK Tools `Profile.xlsx`: https://github.com/garmin/fit-sdk-tools
  - Source for FIT `sport` and `sub_sport` enum values used by the activity allowlist.

