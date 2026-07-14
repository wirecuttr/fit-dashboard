import { create } from "zustand";
import { api } from "../lib/api";
import {
  createHeartRateZonePreferenceActions,
  createInitialHeartRateZonePreferenceData,
  type HeartRateZonePreferenceSlice,
} from "./heartRateZonePreferenceSlice";
import {
  createInitialPowerZonePreferenceData,
  createPowerZonePreferenceActions,
  type PowerZonePreferenceSlice,
} from "./powerZonePreferenceSlice";

type Theme = "light" | "dark";
type DistanceUnit = "km" | "mi";
type TimeFormat = "12h" | "24h";
export type MapStyle = "light" | "dark" | "openstreet" | "topo" | "satellite";
export type Language = string;

function isMapStyle(value: unknown): value is MapStyle {
  return value === "light" || value === "dark" || value === "openstreet" || value === "topo" || value === "satellite";
}

type SettingsState = {
  theme: Theme;
  language: Language;
  distanceUnit: DistanceUnit;
  timeFormat: TimeFormat;
  activityMapStyle: MapStyle;
  overviewMapStyle: MapStyle;
  smoothGraphs: boolean;
  overviewTableDays: number;
  supporterBadge: boolean;
  donationDismissed: boolean;
  showSettings: boolean;
  hydrate: () => void;
  toggleSettings: () => void;
  setTheme: (theme: Theme) => void;
  setLanguage: (language: Language) => void;
  setDistanceUnit: (unit: DistanceUnit) => void;
  setTimeFormat: (format: TimeFormat) => void;
  setActivityMapStyle: (style: MapStyle) => void;
  setOverviewMapStyle: (style: MapStyle) => void;
  setSmoothGraphs: (smoothGraphs: boolean) => void;
  setOverviewTableDays: (days: number) => void;
  loadSupporterStatus: () => Promise<void>;
  verifySupporterCode: (code: string) => Promise<boolean>;
  removeSupporterBadge: () => Promise<void>;
  dismissDonationBanner: () => void;
} & HeartRateZonePreferenceSlice & PowerZonePreferenceSlice;

const STORAGE_KEY = "fitDashboard.settings";

export const useSettingsStore = create<SettingsState>((set, get) => ({
  theme: "light",
  language: "en",
  distanceUnit: "km",
  timeFormat: "24h",
  activityMapStyle: "light",
  overviewMapStyle: "light",
  smoothGraphs: true,
  overviewTableDays: 7,
  supporterBadge: false,
  donationDismissed: false,
  ...createInitialHeartRateZonePreferenceData(),
  ...createInitialPowerZonePreferenceData(),
  showSettings: false,

  hydrate: () => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      set({
        theme: parsed.theme ?? "light",
        language: parsed.language ?? "en",
        distanceUnit: parsed.distanceUnit ?? "km",
        timeFormat: parsed.timeFormat ?? "24h",
        activityMapStyle: isMapStyle(parsed.activityMapStyle) ? parsed.activityMapStyle : "light",
        overviewMapStyle: isMapStyle(parsed.overviewMapStyle) ? parsed.overviewMapStyle : "light",
        smoothGraphs: typeof parsed.smoothGraphs === "boolean" ? parsed.smoothGraphs : true,
        overviewTableDays: Number.isFinite(parsed.overviewTableDays) ? Math.max(1, Math.round(parsed.overviewTableDays)) : 7,
      });
    } catch {
      // Ignore invalid persisted data.
    }
  },

  toggleSettings: () => set((s) => ({ showSettings: !s.showSettings })),

  setTheme: (theme) => {
    set({ theme });
    persist({ ...get(), theme });
  },

  setLanguage: (language) => {
    set({ language });
    persist({ ...get(), language });
  },

  setDistanceUnit: (distanceUnit) => {
    set({ distanceUnit });
    persist({ ...get(), distanceUnit });
  },

  setTimeFormat: (timeFormat) => {
    set({ timeFormat });
    persist({ ...get(), timeFormat });
  },

  setActivityMapStyle: (activityMapStyle) => {
    set({ activityMapStyle });
    persist({ ...get(), activityMapStyle });
  },

  setOverviewMapStyle: (overviewMapStyle) => {
    set({ overviewMapStyle });
    persist({ ...get(), overviewMapStyle });
  },

  setSmoothGraphs: (smoothGraphs) => {
    set({ smoothGraphs });
    persist({ ...get(), smoothGraphs });
  },

  setOverviewTableDays: (overviewTableDays) => {
    const clampedDays = Math.max(1, Math.round(overviewTableDays));
    set({ overviewTableDays: clampedDays });
    persist({ ...get(), overviewTableDays: clampedDays });
  },

  loadSupporterStatus: async () => {
    try {
      const [badgeActive, dismissed] = await Promise.all([
        api.getSupporterStatus(),
        api.getDonationDismissed(),
      ]);
      set({ supporterBadge: badgeActive, donationDismissed: dismissed });
    } catch (err) {
      console.warn("Failed to load supporter status from backend:", err);
    }
  },

  ...createHeartRateZonePreferenceActions(
    (partial) => set(partial),
    () => get(),
    api,
  ),

  ...createPowerZonePreferenceActions(
    (partial) => set(partial),
    () => get(),
    api,
  ),

  verifySupporterCode: async (code: string) => {
    try {
      const valid = await api.verifySupporterCode(code);
      if (valid) {
        set({ supporterBadge: true, donationDismissed: true });
      }
      return valid;
    } catch (err) {
      console.error("Failed to verify supporter code:", err);
      return false;
    }
  },

  removeSupporterBadge: async () => {
    try {
      await Promise.all([
        api.setSupporterStatus(false),
        api.setDonationDismissed(false),
      ]);
      set({ supporterBadge: false, donationDismissed: false });
    } catch (err) {
      console.error("Failed to remove supporter badge:", err);
    }
  },

  dismissDonationBanner: () => {
    set({ donationDismissed: true });
    api.setDonationDismissed(true).catch((err) =>
      console.warn("Failed to persist donation dismissed state:", err)
    );
  },
}));

function persist(state: SettingsState) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      theme: state.theme,
      language: state.language,
      distanceUnit: state.distanceUnit,
      timeFormat: state.timeFormat,
      activityMapStyle: state.activityMapStyle,
      overviewMapStyle: state.overviewMapStyle,
      smoothGraphs: state.smoothGraphs,
      overviewTableDays: state.overviewTableDays,
    })
  );
}
