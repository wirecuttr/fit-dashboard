# Manual Power Zones Investigation

This document outlines the required implementation steps for replacing hardcoded power zones with manual setting overrides, mirroring the existing `HeartRateZonePreferences` implementation.

## 1. Constants & Types (`src/lib/zones.ts` or new `src/lib/powerZones.ts`)

Extract or add power zone preference logic:

- `POWER_ZONE_PREFERENCES_VERSION = 1`
- `ManualPowerZoneUsage` type (`"fallback" | "always"`)
- `PowerZonePreferences` type:
  ```typescript
  export type PowerZonePreferences = {
    version: typeof POWER_ZONE_PREFERENCES_VERSION;
    bounds_watts: number[];
    usage: ManualPowerZoneUsage;
  };
  ```
- Validation constants:
  - `MANUAL_PWR_BOUND_MIN_WATTS = 0`
  - `MANUAL_PWR_BOUND_MAX_WATTS = 4000`
  - `MANUAL_PWR_BOUND_MIN_GAP_WATTS = 5`
  - `MANUAL_PWR_SLIDER_MAX_WATTS = 1000` (for UI display bounds)
- `DEFAULT_PWR_ZONE_BOUNDS` should be an array of 8 values (since `POWER_ZONE_COLORS` has 9 colours and `fit_parser.rs` generates 8 bounds). E.g., `[137, 187, 225, 262, 300, 375, 500, 4000]` based on a nominal 250W FTP.
- `validateManualPowerZoneBounds(bounds: unknown): bounds is number[]`
- `normalizePowerZonePreferences(value: unknown): PowerZonePreferences`
- `resolvePowerZoneSelection(fitBoundsWatts, manualBoundsWatts, usage)` to determine the final source.

## 2. API Bindings (`src/lib/api.ts`)

Add the following methods matching the heart rate implementation:
- `getPowerZonePreferences(): Promise<PowerZonePreferences>`
  - Tauri: `invoke("get_power_zone_preferences")`
  - Web: `webClient.get("/settings/power-zones")`
- `setPowerZonePreferences(preferences: PowerZonePreferences): Promise<PowerZonePreferences>`
  - Tauri: `invoke("set_power_zone_preferences", { preferences })`
  - Web: `webClient.post("/settings/power-zones", preferences)`

## 3. Global State (`src/stores/powerZonePreferenceSlice.ts` & `settingsStore.ts`)

- Create `powerZonePreferenceSlice.ts` matching `heartRateZonePreferenceSlice.ts`:
  - `PowerZonePreferenceStatus` ("idle" | "loading" | "ready" | "error")
  - `loadPowerZonePreferences()`
  - `saveManualPowerZoneBounds(boundsWatts: number[])`
  - `setManualPowerZoneUsage(usage: ManualPowerZoneUsage)`
- Merge this slice into `settingsStore.ts`.

## 4. UI Adjustments (`src/components/SettingsPanel.tsx`)

- Replicate the `HeartRateZoneDialog` as `PowerZoneDialog`.
  - Adjust slider logic for Wattage ranges instead of BPM.
  - The highest bound (4000W) should be handled cleanly, perhaps pinning the slider visual maximum to a sensible range like 1000W while retaining the 4000W absolute maximum for the final segment.
- Add UI controls to the `SettingsPanel.tsx` in a new "Power Zone Settings" section.
  - Radio buttons for "Fallback" and "Always".
  - Button to open `PowerZoneDialog`.

## 5. Main View Logic (`src/components/ActivityInsights.tsx`)

- Retrieve `manualPowerZoneBoundsWatts` and `manualPowerZoneUsage` from `useSettingsStore`.
- Use `resolvePowerZoneSelection` to calculate the final power zones.
- Pass the resolved zones into `buildPowerZones` and ensure `powerVisualMap` and table rows consume these accurately.

## 6. Rust Backend (`src-tauri/src/`)

### Database (`database.rs`)
- Add queries to store and retrieve a JSON string for `power_zone_preferences` in the settings/preferences table.

### State & API Handlers (`state.rs`, `auth.rs` / `tauri_app.rs`)
- Define Rust structs for `PowerZonePreferences`.
- Implement `get_power_zone_preferences` and `set_power_zone_preferences` as Tauri commands using `#[tauri::command]`.

### Web Server (`server.rs`)
- Add GET and POST routes for `/settings/power-zones` for non-Tauri clients, bound to the same DB logic.
