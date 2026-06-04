# Heart Rate Drift Output Options

## Purpose

This document captures investigation notes for output choices in Heart Rate Drift. It covers cycling and running-style activities, including power, speed, grade-adjusted speed/pace, TrainingPeaks Normalized Graded Pace (NGP), and running power.

This is not part of the first-slice implementation scope beyond documenting the current behavior. The current first slice uses normalized power first for cycling, speed as a low-confidence cycling fallback, and raw speed internally for running, walking, hiking, and other speed-based activities.

## Output Problem

Heart Rate Drift compares output against heart rate across an evaluated activity section. The hard part is choosing an output stream that represents the external work or physiological cost of the activity.

Possible output choices include:

- Cycling normalized power.
- Cycling speed.
- Cycling grade-adjusted speed or estimated power from speed/grade.
- Running raw speed or pace.
- Running grade-adjusted speed or pace.
- TrainingPeaks-style Normalized Graded Pace.
- Running power.

Each option has different data requirements, assumptions, and failure modes.

## Current Cycling Behavior

For cycling-like activities, the current first slice uses this selection order:

1. Use computed normalized power when record-level power, HR, paired coverage, and normalized-power rolling-window coverage pass quality checks.
2. If normalized power is unavailable, use speed/distance as a low-confidence fallback when speed/distance and paired HR/output coverage pass quality checks.
3. If neither normalized power nor speed is usable, Heart Rate Drift is unavailable.

Average power is not used as an automatic fallback.

## Cycling Normalized Power

Cycling normalized-power mode uses:

```text
EF = normalized_power_w / average_heart_rate_bpm
```

Benefits:

- Matches the TrainingPeaks-style cycling Efficiency Factor convention more closely than average power.
- Accounts for variable cycling power better than simple average power.
- Uses direct power-meter output when available.
- Is familiar to cyclists who already use NP, IF, TSS, or Pw:Hr.

Limitations:

- Requires reliable record-level power.
- Normalized-power windows can fail coverage where average power would still be computable.
- NP weights surges, so it may be less intuitive for users expecting simple average power per half.
- Indoor steady rides may show little difference between NP and average power.

Recommendation: keep normalized power as the default cycling output when available.

## Cycling Speed Fallback

Cycling speed fallback uses:

```text
EF = average_speed_m_s / average_heart_rate_bpm
```

Benefits:

- Allows cycling HR drift to be calculated when no usable power stream exists.
- Useful for indoor cycling files with speed/distance but no power.
- Simple and broadly available.

Limitations:

- Outdoor cycling speed is strongly affected by wind, drafting, terrain, rolling resistance, stops, traffic, road surface, and bike/rider aerodynamics.
- Indoor trainer speed can be arbitrary or trainer-model dependent.
- Speed is generally a weaker cycling output metric than power.

Recommendation: keep cycling speed as a fallback only, and mark it low confidence.

## Cycling Grade-Adjusted Speed or Estimated Power

Cycling does not appear to have a widely standardized equivalent to running Grade Adjusted Pace. Cycling analysis normally uses direct power when available. When power is unavailable, cycling effort can be estimated from speed and environment with a physics model:

```text
P = (F_roll + F_aero + F_grade) * velocity
```

Typical components include:

- Rolling resistance from rider+bike mass, gravity, road grade, and rolling resistance coefficient.
- Aerodynamic drag from air density, CdA, and apparent wind speed.
- Gravitational climbing force from rider+bike mass and road grade.
- Optional drivetrain losses and acceleration terms.

A theoretical grade-adjusted cycling speed could estimate the flat-ground speed that would require the same modeled power. However, that requires assumptions or user settings for mass, CdA, rolling resistance, wind, drafting, bike type, surface, and drivetrain losses.

Benefits:

- Could make speed fallback more meaningful on hilly rides when no power meter exists.
- Could estimate an output closer to power than raw speed.

Limitations:

- Highly assumption-sensitive.
- Wind and drafting can dominate cycling speed but may not be recorded.
- CdA and rider position changes are usually unknown.
- Rolling resistance varies by tire, pressure, and surface.
- Stop/start and traffic effects are hard to model.
- It may create a false sense of precision.

Recommendation: defer cycling grade-adjusted speed or estimated-power-from-speed. If added, label it clearly as an estimate and keep it lower priority than direct power.

## Current Running-Style Behavior: Raw Speed/Pace

For speed-based Heart Rate Drift modes:

```text
EF = average_speed_m_s / average_heart_rate_bpm
```

The calculation uses speed internally so higher output means better efficiency. For running, walking, and hiking UI copy, the selected output can be displayed as pace because that is the common user-facing convention.

Benefits:

- Simple and transparent.
- Works for indoor and outdoor activities when speed or distance is available.
- Does not depend on elevation quality or vendor-specific power models.
- Easy to explain and test.
- Suitable for flat routes, treadmills, tracks, or controlled steady efforts.

Limitations:

- Hilly terrain can distort interpretation because the same raw pace can have very different physiological costs uphill or downhill.
- Technical surfaces, wind, heat, stops, and fatigue are not corrected.
- GPS-derived pace can be noisy, although long time-weighted halves and bins reduce calculation noise.

Recommendation for first slice: keep raw speed/pace as the default running-style output. It is understandable and broadly available.

## Running Grade-Adjusted Pace

Grade-adjusted pace attempts to estimate the flat-ground pace equivalent of running on uphill or downhill terrain.

A defensible open calculation can be based on Minetti et al. 2002, which measured metabolic cost for walking and running across uphill and downhill slopes.

For running, a commonly cited metabolic cost polynomial is:

```text
C(g) = 155.4g^5 - 30.4g^4 - 43.3g^3 + 46.3g^2 + 19.5g + 3.6
```

Where:

- `g` is grade as a decimal, for example `0.05` for 5% uphill.
- `C(g)` is running metabolic cost in `J/kg/m`.
- `C(0)` is flat-ground cost, about `3.6 J/kg/m` in this model.

A simple grade-adjusted speed estimate can treat each distance step as equivalent flat distance:

```text
equivalent_flat_distance += actual_distance_step * (C(grade) / C(0))
grade_adjusted_speed = equivalent_flat_distance / elapsed_time
grade_adjusted_pace = elapsed_time / equivalent_flat_distance
```

Potential future Heart Rate Drift mode:

```text
mode = "grade_adjusted_speed"
EF = average_grade_adjusted_speed_m_s / average_heart_rate_bpm
```

Benefits:

- More appropriate than raw pace on hilly routes.
- Based on published metabolic-cost research.
- Can be documented transparently if the exact method is owned by FIT Dashboard.

Limitations:

- Requires reliable distance and elevation streams.
- Requires elevation smoothing before grade calculation.
- Requires grade calculation over distance windows rather than noisy point-to-point elevation deltas.
- Requires clamping or explicit handling outside the model's supported grade range.
- Does not account for technical terrain, footing, wind, heat, or surface.
- May be inappropriate for treadmill or indoor files without meaningful elevation.

If added, label it as FIT Dashboard's grade-adjusted estimate, not TrainingPeaks NGP.

## TrainingPeaks Normalized Graded Pace

TrainingPeaks describes running Efficiency Factor as using Normalized Graded Pace over average heart rate. NGP adjusts pace for uphill/downhill terrain and includes an intensity-weighting concept inspired by Normalized Power.

TrainingPeaks publishes the concept and examples, but does not appear to publish a complete reproducible production formula. Missing details include:

- Exact grade adjustment curve used in production.
- Elevation smoothing and grade-window rules.
- Intensity or exponential weighting details.
- Handling for GPS/elevation noise, stops, steep descents, treadmills, and bad data.

Because of this, FIT Dashboard should not claim TrainingPeaks-equivalent NGP unless the implementation is explicitly validated against TrainingPeaks outputs or documented as an approximation.

## Running Power

Running power is another attempt to represent running output more directly than raw pace. In principle, it tries to estimate the mechanical or metabolic cost of running while accounting for some combination of speed, grade, acceleration, wind, body mass, and running dynamics.

Potential future Heart Rate Drift mode:

```text
mode = "running_power"
EF = average_running_power_w / average_heart_rate_bpm
```

Benefits:

- Can represent effort better than raw pace on hills or windy routes when the power model is good.
- Uses the same output/heart-rate framing as cycling power.
- May be valuable for users with Stryd, Garmin running power, Coros, Apple, or other running-power sources.
- Avoids building and maintaining a grade-adjusted pace model inside FIT Dashboard.

Limitations:

- Running power is device- and vendor-dependent.
- Different ecosystems may produce different wattage for the same run.
- Some devices estimate running power from the same data that grade-adjusted pace would use, so it is not necessarily independent.
- FIT files may contain power for some runs and not others.
- Users may not expect running power to replace pace-based Pa:Hr by default.

Recommendation: running power should be a future optional mode when record-level running power and HR pass coverage checks. It should not silently replace raw speed/pace as the first default.

## Mode Comparison

| Mode | Activity family | Data required | Strength | Main risk |
|---|---|---|---|---|
| Normalized power | Cycling | Time, HR, power | Strong cycling convention, direct output | Requires reliable power stream |
| Speed fallback | Cycling | Time, HR, speed or distance | Works without power | Wind, drafting, terrain, and trainer-speed assumptions |
| Grade-adjusted speed / estimated power | Cycling | Time, HR, speed, distance, elevation, plus model assumptions | Could improve no-power outdoor cycling | Highly sensitive to CdA, wind, mass, rolling resistance, drafting |
| Raw speed/pace | Running-style | Time plus speed or distance | Simple, available, transparent | Terrain changes distort output |
| Grade-adjusted speed/pace | Running-style | Time, distance, elevation | Better for hills, open model possible | Elevation noise and model assumptions |
| TrainingPeaks NGP-like | Running-style | Time, distance, elevation, weighting model | Familiar to TrainingPeaks users | Exact algorithm is not public |
| Running power | Running-style | Time, HR, power | Potentially good effort output | Vendor-specific and inconsistent |

## Recommendation

Keep the first slice behavior:

1. Cycling: normalized power first.
2. Cycling: speed fallback only when normalized power is unavailable, with low confidence.
3. Running-style activities: raw speed internally and pace display where appropriate.

Future work can add optional output modes in this rough order if user value justifies the complexity:

1. Running power when `RecordPoint.power` exists and passes coverage checks.
2. FIT Dashboard running grade-adjusted speed/pace based on a documented open method.
3. Average-power cycling mode only if users need comparison with tools or manual calculations that use average power instead of normalized power.
4. Cycling estimated-power or grade-adjusted-speed mode only if no-power cycling support becomes important enough to accept the modeling assumptions.
5. A normalized or weighted grade-adjusted pace mode only if the weighting method is clearly defined and validated.

Raw speed/pace should remain available even if additional modes are added, because it is easiest to understand and works best for controlled flat efforts.

## References

- TrainingPeaks Help Center, `Aerobic Decoupling (Pw:Hr and Pa:HR) and Efficiency Factor EF`: https://help.trainingpeaks.com/hc/en-us/articles/204071724-Aerobic-Decoupling-Pw-Hr-and-Pa-HR-and-Efficiency-Factor-EF
- TrainingPeaks, `What is Normalized Graded Pace?`: https://www.trainingpeaks.com/learn/articles/what-is-normalized-graded-pace/
- TrainingPeaks Help Center, `Glossary`: https://help.trainingpeaks.com/hc/en-us/articles/115001271712-Glossary
- Minetti et al., `Energy cost of walking and running at extreme uphill and downhill slopes`, Journal of Applied Physiology, 2002: https://pubmed.ncbi.nlm.nih.gov/12183501/
- di Prampero, `Mechanical efficiency, work and heat output in running uphill or downhill`, which cites the Minetti running-cost polynomial: https://ojs.zrs-kp.si/index.php/AK/article/view/50
- Martin et al.-style cycling power modeling background, summarized in public calculators such as: https://fitmetriclab.com/en/tools/cycling/cycling-power/
- Cycling power/speed model component overview: https://mcpcalc.com/health/cycling-power
- Stryd, `Train With Power`: https://www.stryd.com/us/en/pages/training-with-power
- Stryd Help Center, `Stryd Metrics`: https://help.stryd.com/en/articles/6879522-stryd-metrics
