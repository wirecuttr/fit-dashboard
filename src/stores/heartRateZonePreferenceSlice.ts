import {
  DEFAULT_HR_ZONE_BOUNDS,
  HEART_RATE_ZONE_PREFERENCES_VERSION,
  normalizeHeartRateZonePreferences,
  validateManualHeartRateZoneBounds,
  type HeartRateZonePreferences,
  type ManualHeartRateZoneUsage,
} from "../lib/hrZones";

export type HeartRateZonePreferenceStatus = "idle" | "loading" | "ready" | "error";

export type HeartRateZonePreferenceData = {
  manualHeartRateZoneBoundsBpm: number[];
  manualHeartRateZoneUsage: ManualHeartRateZoneUsage;
  confirmedManualHeartRateZoneBoundsBpm: number[];
  confirmedManualHeartRateZoneUsage: ManualHeartRateZoneUsage;
  heartRateZonePreferenceStatus: HeartRateZonePreferenceStatus;
  heartRateZonePreferenceSaving: boolean;
  heartRateZonePreferenceError: string | null;
};

export type HeartRateZonePreferenceActions = {
  loadHeartRateZonePreferences: () => Promise<boolean>;
  saveManualHeartRateZoneBounds: (boundsBpm: number[]) => Promise<boolean>;
  setManualHeartRateZoneUsage: (usage: ManualHeartRateZoneUsage) => Promise<boolean>;
};

export type HeartRateZonePreferenceSlice = HeartRateZonePreferenceData
  & HeartRateZonePreferenceActions;

export type HeartRateZonePreferenceBackend = {
  getHeartRateZonePreferences: () => Promise<HeartRateZonePreferences>;
  setHeartRateZonePreferences: (
    preferences: HeartRateZonePreferences,
  ) => Promise<HeartRateZonePreferences>;
};

type SetPreferenceState = (partial: Partial<HeartRateZonePreferenceData>) => void;
type GetPreferenceState = () => HeartRateZonePreferenceData;

export function createInitialHeartRateZonePreferenceData(): HeartRateZonePreferenceData {
  return {
    manualHeartRateZoneBoundsBpm: [...DEFAULT_HR_ZONE_BOUNDS],
    manualHeartRateZoneUsage: "fallback",
    confirmedManualHeartRateZoneBoundsBpm: [...DEFAULT_HR_ZONE_BOUNDS],
    confirmedManualHeartRateZoneUsage: "fallback",
    heartRateZonePreferenceStatus: "idle",
    heartRateZonePreferenceSaving: false,
    heartRateZonePreferenceError: null,
  };
}

export function createHeartRateZonePreferenceActions(
  set: SetPreferenceState,
  get: GetPreferenceState,
  backend: HeartRateZonePreferenceBackend,
): HeartRateZonePreferenceActions {
  return {
    loadHeartRateZonePreferences: async () => {
      set({
        heartRateZonePreferenceStatus: "loading",
        heartRateZonePreferenceError: null,
      });
      try {
        const preferences = normalizeHeartRateZonePreferences(
          await backend.getHeartRateZonePreferences()
        );
        set({
          manualHeartRateZoneBoundsBpm: [...preferences.bounds_bpm],
          manualHeartRateZoneUsage: preferences.usage,
          confirmedManualHeartRateZoneBoundsBpm: [...preferences.bounds_bpm],
          confirmedManualHeartRateZoneUsage: preferences.usage,
          heartRateZonePreferenceStatus: "ready",
          heartRateZonePreferenceError: null,
        });
        return true;
      } catch (err) {
        console.warn("Failed to load heart-rate-zone preferences:", err);
        set({
          heartRateZonePreferenceStatus: "error",
          heartRateZonePreferenceError: errorMessage(err),
        });
        return false;
      }
    },

    saveManualHeartRateZoneBounds: async (boundsBpm) => {
      const state = get();
      if (state.heartRateZonePreferenceStatus !== "ready"
        || state.heartRateZonePreferenceSaving
        || !validateManualHeartRateZoneBounds(boundsBpm)) {
        return false;
      }

      set({
        heartRateZonePreferenceSaving: true,
        heartRateZonePreferenceError: null,
      });
      try {
        const preferences = normalizeHeartRateZonePreferences(
          await backend.setHeartRateZonePreferences({
            version: HEART_RATE_ZONE_PREFERENCES_VERSION,
            bounds_bpm: [...boundsBpm],
            usage: state.confirmedManualHeartRateZoneUsage,
          })
        );
        set({
          manualHeartRateZoneBoundsBpm: [...preferences.bounds_bpm],
          manualHeartRateZoneUsage: preferences.usage,
          confirmedManualHeartRateZoneBoundsBpm: [...preferences.bounds_bpm],
          confirmedManualHeartRateZoneUsage: preferences.usage,
          heartRateZonePreferenceStatus: "ready",
          heartRateZonePreferenceError: null,
        });
        return true;
      } catch (err) {
        console.warn("Failed to save heart-rate-zone boundaries:", err);
        set({ heartRateZonePreferenceError: errorMessage(err) });
        return false;
      } finally {
        set({ heartRateZonePreferenceSaving: false });
      }
    },

    setManualHeartRateZoneUsage: async (usage) => {
      const state = get();
      if (state.heartRateZonePreferenceStatus !== "ready"
        || state.heartRateZonePreferenceSaving
        || usage === state.manualHeartRateZoneUsage) {
        return false;
      }

      set({
        manualHeartRateZoneUsage: usage,
        heartRateZonePreferenceSaving: true,
        heartRateZonePreferenceError: null,
      });
      try {
        const preferences = normalizeHeartRateZonePreferences(
          await backend.setHeartRateZonePreferences({
            version: HEART_RATE_ZONE_PREFERENCES_VERSION,
            bounds_bpm: [...state.confirmedManualHeartRateZoneBoundsBpm],
            usage,
          })
        );
        set({
          manualHeartRateZoneBoundsBpm: [...preferences.bounds_bpm],
          manualHeartRateZoneUsage: preferences.usage,
          confirmedManualHeartRateZoneBoundsBpm: [...preferences.bounds_bpm],
          confirmedManualHeartRateZoneUsage: preferences.usage,
          heartRateZonePreferenceStatus: "ready",
          heartRateZonePreferenceError: null,
        });
        return true;
      } catch (err) {
        console.warn("Failed to save heart-rate-zone usage policy:", err);
        set({
          manualHeartRateZoneUsage: state.confirmedManualHeartRateZoneUsage,
          heartRateZonePreferenceError: errorMessage(err),
        });
        return false;
      } finally {
        set({ heartRateZonePreferenceSaving: false });
      }
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
