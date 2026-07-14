import {
  DEFAULT_POWER_ZONE_BOUND_PERCENTS,
  POWER_ZONE_PREFERENCES_VERSION,
  normalizePowerZonePreferences,
  validatePowerZoneBoundPercents,
  type PowerZonePreferences,
  type PowerZoneTimeSource,
} from "../lib/powerZones";

export type PowerZonePreferenceStatus = "idle" | "loading" | "ready" | "error";
export type PowerZonePreferenceErrorContext = "load" | "bounds" | "source" | null;

export type PowerZonePreferenceData = {
  configuredPowerZoneBoundPercents: number[];
  powerZoneTimeSource: PowerZoneTimeSource;
  confirmedPowerZoneBoundPercents: number[];
  confirmedPowerZoneTimeSource: PowerZoneTimeSource;
  powerZonePreferenceStatus: PowerZonePreferenceStatus;
  powerZonePreferenceSaving: boolean;
  powerZonePreferenceError: string | null;
  powerZonePreferenceErrorContext: PowerZonePreferenceErrorContext;
};

export type PowerZonePreferenceActions = {
  loadPowerZonePreferences: () => Promise<boolean>;
  savePowerZoneBoundPercents: (boundsPercentFtp: number[]) => Promise<boolean>;
  setPowerZoneTimeSource: (source: PowerZoneTimeSource) => Promise<boolean>;
};

export type PowerZonePreferenceSlice = PowerZonePreferenceData & PowerZonePreferenceActions;

export type PowerZonePreferenceBackend = {
  getPowerZonePreferences: () => Promise<PowerZonePreferences>;
  setPowerZonePreferences: (preferences: PowerZonePreferences) => Promise<PowerZonePreferences>;
};

type SetPreferenceState = (partial: Partial<PowerZonePreferenceData>) => void;
type GetPreferenceState = () => PowerZonePreferenceData;

export function createInitialPowerZonePreferenceData(): PowerZonePreferenceData {
  return {
    configuredPowerZoneBoundPercents: [...DEFAULT_POWER_ZONE_BOUND_PERCENTS],
    powerZoneTimeSource: "fit",
    confirmedPowerZoneBoundPercents: [...DEFAULT_POWER_ZONE_BOUND_PERCENTS],
    confirmedPowerZoneTimeSource: "fit",
    powerZonePreferenceStatus: "idle",
    powerZonePreferenceSaving: false,
    powerZonePreferenceError: null,
    powerZonePreferenceErrorContext: null,
  };
}

export function createPowerZonePreferenceActions(
  set: SetPreferenceState,
  get: GetPreferenceState,
  backend: PowerZonePreferenceBackend,
): PowerZonePreferenceActions {
  return {
    loadPowerZonePreferences: async () => {
      set({ powerZonePreferenceStatus: "loading", powerZonePreferenceError: null, powerZonePreferenceErrorContext: null });
      try {
        const preferences = normalizePowerZonePreferences(await backend.getPowerZonePreferences());
        set({
          configuredPowerZoneBoundPercents: [...preferences.bounds_percent_ftp],
          powerZoneTimeSource: preferences.zone_time_source,
          confirmedPowerZoneBoundPercents: [...preferences.bounds_percent_ftp],
          confirmedPowerZoneTimeSource: preferences.zone_time_source,
          powerZonePreferenceStatus: "ready",
          powerZonePreferenceError: null,
          powerZonePreferenceErrorContext: null,
        });
        return true;
      } catch (err) {
        console.warn("Failed to load power-zone preferences:", err);
        set({
          powerZonePreferenceStatus: "error",
          powerZonePreferenceError: errorMessage(err),
          powerZonePreferenceErrorContext: "load",
        });
        return false;
      }
    },

    savePowerZoneBoundPercents: async (boundsPercentFtp) => {
      const state = get();
      if (state.powerZonePreferenceStatus !== "ready"
        || state.powerZonePreferenceSaving
        || !validatePowerZoneBoundPercents(boundsPercentFtp)) {
        return false;
      }

      set({ powerZonePreferenceSaving: true, powerZonePreferenceError: null, powerZonePreferenceErrorContext: null });
      try {
        const preferences = normalizePowerZonePreferences(
          await backend.setPowerZonePreferences({
            version: POWER_ZONE_PREFERENCES_VERSION,
            bounds_percent_ftp: [...boundsPercentFtp],
            zone_time_source: state.confirmedPowerZoneTimeSource,
          }),
        );
        set({
          configuredPowerZoneBoundPercents: [...preferences.bounds_percent_ftp],
          powerZoneTimeSource: preferences.zone_time_source,
          confirmedPowerZoneBoundPercents: [...preferences.bounds_percent_ftp],
          confirmedPowerZoneTimeSource: preferences.zone_time_source,
          powerZonePreferenceStatus: "ready",
          powerZonePreferenceError: null,
          powerZonePreferenceErrorContext: null,
        });
        return true;
      } catch (err) {
        console.warn("Failed to save power-zone boundaries:", err);
        set({ powerZonePreferenceError: errorMessage(err), powerZonePreferenceErrorContext: "bounds" });
        return false;
      } finally {
        set({ powerZonePreferenceSaving: false });
      }
    },

    setPowerZoneTimeSource: async (source) => {
      const state = get();
      if (state.powerZonePreferenceStatus !== "ready"
        || state.powerZonePreferenceSaving
        || source === state.powerZoneTimeSource) {
        return false;
      }

      set({
        powerZoneTimeSource: source,
        powerZonePreferenceSaving: true,
        powerZonePreferenceError: null,
        powerZonePreferenceErrorContext: null,
      });
      try {
        const preferences = normalizePowerZonePreferences(
          await backend.setPowerZonePreferences({
            version: POWER_ZONE_PREFERENCES_VERSION,
            bounds_percent_ftp: [...state.confirmedPowerZoneBoundPercents],
            zone_time_source: source,
          }),
        );
        set({
          configuredPowerZoneBoundPercents: [...preferences.bounds_percent_ftp],
          powerZoneTimeSource: preferences.zone_time_source,
          confirmedPowerZoneBoundPercents: [...preferences.bounds_percent_ftp],
          confirmedPowerZoneTimeSource: preferences.zone_time_source,
          powerZonePreferenceStatus: "ready",
          powerZonePreferenceError: null,
          powerZonePreferenceErrorContext: null,
        });
        return true;
      } catch (err) {
        console.warn("Failed to save power-zone time source:", err);
        set({
          powerZoneTimeSource: state.confirmedPowerZoneTimeSource,
          powerZonePreferenceError: errorMessage(err),
          powerZonePreferenceErrorContext: "source",
        });
        return false;
      } finally {
        set({ powerZonePreferenceSaving: false });
      }
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
