import { useCallback, useEffect, useRef, useState } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import { api } from "../lib/api";
import { openExternalLink } from "../lib/links";
import { useTranslation, LANGUAGES } from "../lib/i18n";
import {
  DEFAULT_HR_ZONE_BOUNDS,
  HR_ZONE_COLORS,
  MANUAL_HR_BOUND_MAX_BPM,
  MANUAL_HR_BOUND_MIN_BPM,
  MANUAL_HR_BOUND_MIN_GAP_BPM,
  MANUAL_HR_SLIDER_MAX_BPM,
  MANUAL_HR_SLIDER_MIN_BPM,
  validateManualHeartRateZoneBounds,
  type ManualHeartRateZoneUsage,
} from "../lib/hrZones";
import {
  DEFAULT_POWER_ZONE_BOUND_PERCENTS,
  POWER_ZONE_BOUND_MAX_PERCENT,
  POWER_ZONE_BOUND_MIN_GAP_PERCENT,
  POWER_ZONE_BOUND_MIN_PERCENT,
  validatePowerZoneBoundPercents,
} from "../lib/powerZones";
import { POWER_ZONE_COLORS } from "../lib/zones";
import {
  IconBug,
  IconDiscord,
  IconGlobe,
  IconHeart,
  IconPower,
  IconMail,
} from "./Icons";

type StorageInfo = {
  data_dir: string;
  db_path: string;
  fit_files_dir: string;
};

type VersionBadgeStatus = {
  state: "hidden" | "latest" | "update";
  latestVersion: string | null;
};

type Props = {
  appVersion: string;
  versionBadgeStatus: VersionBadgeStatus;
};

type Translate = (key: string, params?: Record<string, string | number>) => string;

function HeartRateZoneDialog({
  bounds,
  usage,
  saving,
  saveError,
  onSave,
  onClose,
  t,
}: {
  bounds: number[];
  usage: ManualHeartRateZoneUsage;
  saving: boolean;
  saveError: boolean;
  onSave: (
    boundsBpm: number[],
    usage: ManualHeartRateZoneUsage,
  ) => Promise<boolean>;
  onClose: () => void;
  t: Translate;
}) {
  const [draft, setDraft] = useState(() => [...bounds]);
  const [draftUsage, setDraftUsage] = useState(usage);
  const [dragging, setDragging] = useState<number | null>(null);
  const [usageHelpOpen, setUsageHelpOpen] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const usageHelpRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const pct = (value: number) => (
    (value - MANUAL_HR_SLIDER_MIN_BPM)
    / (MANUAL_HR_SLIDER_MAX_BPM - MANUAL_HR_SLIDER_MIN_BPM)
  ) * 100;

  const boundaryLimits = useCallback((index: number, values: number[]) => ({
    min: index === 0
      ? MANUAL_HR_BOUND_MIN_BPM
      : values[index - 1] + MANUAL_HR_BOUND_MIN_GAP_BPM,
    max: index === values.length - 1
      ? MANUAL_HR_BOUND_MAX_BPM
      : values[index + 1] - MANUAL_HR_BOUND_MIN_GAP_BPM,
  }), []);

  const updateDraftValue = useCallback((index: number, value: number) => {
    setDraft((previous) => {
      const { min, max } = boundaryLimits(index, previous);
      const next = [...previous];
      next[index] = Math.max(min, Math.min(max, Math.round(value)));
      return next;
    });
  }, [boundaryLimits]);

  const updateDraftFromPointer = useCallback((index: number, clientX: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const value = MANUAL_HR_SLIDER_MIN_BPM
      + ratio * (MANUAL_HR_SLIDER_MAX_BPM - MANUAL_HR_SLIDER_MIN_BPM);
    updateDraftValue(index, value);
  }, [updateDraftValue]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (usageHelpOpen) {
          event.preventDefault();
          setUsageHelpOpen(false);
          return;
        }
        if (!saving) onClose();
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [role="slider"][tabindex="0"]'
        ) ?? []
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving, usageHelpOpen]);

  useEffect(() => {
    if (!usageHelpOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!usageHelpRef.current?.contains(event.target as Node)) {
        setUsageHelpOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [usageHelpOpen]);

  useEffect(() => {
    if (dragging === null) return;
    const onMove = (event: PointerEvent) => updateDraftFromPointer(dragging, event.clientX);
    const onUp = () => setDragging(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, updateDraftFromPointer]);

  const segmentEdges = [MANUAL_HR_SLIDER_MIN_BPM, ...draft, MANUAL_HR_SLIDER_MAX_BPM];
  const zoneColours = HR_ZONE_COLORS.slice(0, 5);
  const zoneLabels = zoneColours.map((colour, index) => {
    const low = index === 0 ? null : draft[index - 1] + 1;
    const high = index === 4 ? null : draft[index];
    const range = low === null
      ? `≤${high} bpm`
      : high === null ? `>${draft[3]} bpm` : `${low}–${high} bpm`;
    return { name: `Z${index + 1}`, range, colour };
  });

  return (
    <div className="hr-zone-dialog-overlay">
      <div
        className="hr-zone-dialog-backdrop"
        onClick={() => { if (!saving) onClose(); }}
      />
      <div
        ref={dialogRef}
        className="hr-zone-dialog"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="hr-zone-dialog-title"
        aria-describedby="hr-zone-dialog-description"
      >
        <div className="hr-zone-dialog-header">
          <h3 id="hr-zone-dialog-title">{t("settings.hrZonesTitle")}</h3>
          <button
            ref={closeButtonRef}
            type="button"
            className="icon-btn"
            onClick={onClose}
            disabled={saving}
            aria-label={t("settings.hrZonesClose")}
          >
            &times;
          </button>
        </div>
        <p id="hr-zone-dialog-description" className="hr-zone-dialog-desc">
          {t("settings.hrZonesDescription")}
        </p>

        <div className="hr-zone-usage-row">
          <label className="hr-zone-usage-checkbox">
            <input
              type="checkbox"
              checked={draftUsage === "always"}
              disabled={saving}
              onChange={(event) => setDraftUsage(event.target.checked ? "always" : "fallback")}
            />
            <span>{t("settings.hrZonesAlwaysCustom")}</span>
          </label>
          <div className="hr-zone-usage-help" ref={usageHelpRef}>
            <button
              type="button"
              className="hr-zone-usage-help-button"
              aria-label={t("settings.hrZonesUsageHelpLabel")}
              aria-expanded={usageHelpOpen}
              disabled={saving}
              onClick={() => setUsageHelpOpen((open) => !open)}
            >
              ?
            </button>
            {usageHelpOpen && (
              <div className="hr-zone-usage-help-popover" role="dialog" aria-label={t("settings.hrZonesUsageHelpLabel")}>
                {t("settings.hrZonesUsageHelp")}
              </div>
            )}
          </div>
        </div>

        <div className="hr-zone-slider-container">
          <div className="hr-zone-slider" ref={trackRef}>
            <div className="hr-zone-track" aria-hidden="true">
              {zoneColours.map((colour, index) => {
                const left = pct(segmentEdges[index]);
                const right = pct(segmentEdges[index + 1]);
                return (
                  <span
                    key={colour}
                    className="hr-zone-segment"
                    style={{
                      left: `${left}%`,
                      width: `${right - left}%`,
                      background: colour,
                    }}
                  />
                );
              })}
            </div>

            {draft.map((value, index) => {
              const limits = boundaryLimits(index, draft);
              return (
                <div
                  key={index}
                  className={`hr-zone-handle${dragging === index ? " dragging" : ""}`}
                  style={{
                    left: `${pct(value)}%`,
                    color: zoneColours[index + 1] ?? zoneColours[index],
                  }}
                  role="slider"
                  tabIndex={saving ? -1 : 0}
                  aria-label={t("settings.hrZoneBoundaryLabel", { zone: index + 1 })}
                  aria-valuemin={limits.min}
                  aria-valuemax={limits.max}
                  aria-valuenow={value}
                  aria-valuetext={`${value} bpm`}
                  onPointerDown={(event) => {
                    if (saving) return;
                    event.preventDefault();
                    event.currentTarget.focus();
                    setDragging(index);
                    updateDraftFromPointer(index, event.clientX);
                  }}
                  onKeyDown={(event) => {
                    if (saving) return;
                    let next: number | null = null;
                    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = value - 1;
                    if (event.key === "ArrowRight" || event.key === "ArrowUp") next = value + 1;
                    if (event.key === "PageDown") next = value - 5;
                    if (event.key === "PageUp") next = value + 5;
                    if (event.key === "Home") next = limits.min;
                    if (event.key === "End") next = limits.max;
                    if (next !== null) {
                      event.preventDefault();
                      updateDraftValue(index, next);
                    }
                  }}
                >
                  <span className="hr-zone-handle-value">{value}</span>
                </div>
              );
            })}
          </div>

          <div className="hr-zone-labels">
            {zoneLabels.map((zone) => (
              <div key={zone.name} className="hr-zone-label-item">
                <span className="hr-zone-label-name" style={{ color: zone.colour }}>{zone.name}</span>
                <span className="hr-zone-label-range">{zone.range}</span>
              </div>
            ))}
          </div>
        </div>

        {saveError && (
          <p className="hr-zone-status error" role="alert">{t("settings.hrZonesSaveFailed")}</p>
        )}
        <div className="hr-zone-dialog-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              if (!window.confirm(t("settings.zoneResetConfirm"))) return;
              setDraft([...DEFAULT_HR_ZONE_BOUNDS]);
              setDraftUsage("fallback");
            }}
            disabled={saving}
          >
            {t("settings.hrZonesReset")}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void onSave(draft, draftUsage).then((saved) => { if (saved) onClose(); })}
            disabled={saving || !validateManualHeartRateZoneBounds(draft)}
          >
            {saving ? t("settings.hrZonesSaving") : t("settings.hrZonesSave")}
          </button>
        </div>
      </div>
    </div>
  );
}
function PowerZoneDialog({
  bounds,
  saving,
  saveError,
  onSave,
  onClose,
  t,
}: {
  bounds: number[];
  saving: boolean;
  saveError: boolean;
  onSave: (boundsPercentFtp: number[]) => Promise<boolean>;
  onClose: () => void;
  t: Translate;
}) {
  const [draft, setDraft] = useState(() => [...bounds]);
  const [dragging, setDragging] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const pct = (value: number) => (
    (value - POWER_ZONE_BOUND_MIN_PERCENT)
    / (POWER_ZONE_BOUND_MAX_PERCENT - POWER_ZONE_BOUND_MIN_PERCENT)
  ) * 100;

  const boundaryLimits = useCallback((index: number, values: number[]) => ({
    min: index === 0
      ? POWER_ZONE_BOUND_MIN_PERCENT
      : values[index - 1] + POWER_ZONE_BOUND_MIN_GAP_PERCENT,
    max: index === values.length - 1
      ? POWER_ZONE_BOUND_MAX_PERCENT
      : values[index + 1] - POWER_ZONE_BOUND_MIN_GAP_PERCENT,
  }), []);

  const updateDraftValue = useCallback((index: number, value: number) => {
    setDraft((previous) => {
      const { min, max } = boundaryLimits(index, previous);
      const next = [...previous];
      next[index] = Math.max(min, Math.min(max, Math.round(value)));
      return next;
    });
  }, [boundaryLimits]);

  const updateDraftFromPointer = useCallback((index: number, clientX: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const value = POWER_ZONE_BOUND_MIN_PERCENT
      + ratio * (POWER_ZONE_BOUND_MAX_PERCENT - POWER_ZONE_BOUND_MIN_PERCENT);
    updateDraftValue(index, value);
  }, [updateDraftValue]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [role="slider"][tabindex="0"]'
        ) ?? []
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  useEffect(() => {
    if (dragging === null) return;
    const onMove = (event: PointerEvent) => updateDraftFromPointer(dragging, event.clientX);
    const onUp = () => setDragging(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, updateDraftFromPointer]);

  const zoneColours = POWER_ZONE_COLORS.slice(0, 7);
  const segmentEdges = [POWER_ZONE_BOUND_MIN_PERCENT, ...draft, POWER_ZONE_BOUND_MAX_PERCENT];
  const zoneLabels = zoneColours.map((colour, index) => {
    const low = index === 0 ? null : draft[index - 1] + 1;
    const high = index === 6 ? null : draft[index];
    const range = low === null
      ? t("settings.powerZoneRangeUpTo", { high: high ?? "" })
      : high === null
        ? t("settings.powerZoneRangeAbove", { low: draft[5] })
        : t("settings.powerZoneRangeBetween", { low, high });
    return { name: `Z${index + 1}`, range, colour };
  });

  return (
    <div className="hr-zone-dialog-overlay">
      <div
        className="hr-zone-dialog-backdrop"
        onClick={() => { if (!saving) onClose(); }}
      />
      <div
        ref={dialogRef}
        className="hr-zone-dialog power-zone-dialog"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="power-zone-dialog-title"
        aria-describedby="power-zone-dialog-description"
      >
        <div className="hr-zone-dialog-header">
          <h3 id="power-zone-dialog-title">{t("settings.powerZonesTitle")}</h3>
          <button
            ref={closeButtonRef}
            type="button"
            className="icon-btn"
            onClick={onClose}
            disabled={saving}
            aria-label={t("settings.powerZonesClose")}
          >
            &times;
          </button>
        </div>
        <p id="power-zone-dialog-description" className="hr-zone-dialog-desc">
          {t("settings.powerZonesDescription")}
        </p>

        <div className="hr-zone-slider-container power-zone-slider-container">
          <div className="hr-zone-slider" ref={trackRef}>
            <div className="hr-zone-track" aria-hidden="true">
              {zoneColours.map((colour, index) => {
                const left = pct(segmentEdges[index]);
                const right = pct(segmentEdges[index + 1]);
                return (
                  <span
                    key={`${colour}-${index}`}
                    className="hr-zone-segment"
                    style={{
                      left: `${left}%`,
                      width: `${right - left}%`,
                      background: colour,
                    }}
                  />
                );
              })}
            </div>

            {draft.map((value, index) => {
              const limits = boundaryLimits(index, draft);
              return (
                <div
                  key={index}
                  className={`hr-zone-handle power-zone-handle${index % 2 ? " alternate" : ""}${dragging === index ? " dragging" : ""}`}
                  style={{
                    left: `${pct(value)}%`,
                    color: zoneColours[index + 1] ?? zoneColours[index],
                  }}
                  role="slider"
                  tabIndex={saving ? -1 : 0}
                  aria-label={t("settings.powerZoneBoundaryLabel", { zone: index + 1 })}
                  aria-valuemin={limits.min}
                  aria-valuemax={limits.max}
                  aria-valuenow={value}
                  aria-valuetext={t("settings.powerZoneValuePercentFtp", { value })}
                  onPointerDown={(event) => {
                    if (saving) return;
                    event.preventDefault();
                    event.currentTarget.focus();
                    setDragging(index);
                    updateDraftFromPointer(index, event.clientX);
                  }}
                  onKeyDown={(event) => {
                    if (saving) return;
                    let next: number | null = null;
                    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = value - 1;
                    if (event.key === "ArrowRight" || event.key === "ArrowUp") next = value + 1;
                    if (event.key === "PageDown") next = value - 5;
                    if (event.key === "PageUp") next = value + 5;
                    if (event.key === "Home") next = limits.min;
                    if (event.key === "End") next = limits.max;
                    if (next !== null) {
                      event.preventDefault();
                      updateDraftValue(index, next);
                    }
                  }}
                >
                  <span className="hr-zone-handle-value">{value}%</span>
                </div>
              );
            })}
          </div>
        </div>
        <div className="power-zone-labels">
          {zoneLabels.map((zone) => (
            <div key={zone.name}>
              <strong style={{ color: zone.colour }}>{zone.name}</strong>
              <span>{zone.range}</span>
            </div>
          ))}
        </div>

        {saveError && (
          <p className="hr-zone-status error" role="alert">{t("settings.powerZonesSaveFailed")}</p>
        )}
        <div className="hr-zone-dialog-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              if (!window.confirm(t("settings.zoneResetConfirm"))) return;
              setDraft([...DEFAULT_POWER_ZONE_BOUND_PERCENTS]);
            }}
            disabled={saving}
          >
            {t("settings.powerZonesReset")}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void onSave(draft).then((saved) => { if (saved) onClose(); })}
            disabled={saving || !validatePowerZoneBoundPercents(draft)}
          >
            {saving ? t("settings.powerZonesSaving") : t("settings.powerZonesSave")}
          </button>
        </div>
      </div>
    </div>
  );
}




export function SettingsPanel({ appVersion, versionBadgeStatus }: Props) {
  const {
    showSettings,
    theme,
    distanceUnit,
    timeFormat,
    smoothGraphs,
    supporterBadge,
    manualHeartRateZoneBoundsBpm,
    manualHeartRateZoneUsage,
    heartRateZonePreferenceStatus,
    heartRateZonePreferenceSaving,
    heartRateZonePreferenceError,
    configuredPowerZoneBoundPercents,
    powerZonePreferenceStatus,
    powerZonePreferenceSaving,
    powerZonePreferenceError,
    loadPowerZonePreferences,
    setTheme,
    setDistanceUnit,
    setTimeFormat,
    setSmoothGraphs,
    loadHeartRateZonePreferences,
    saveManualHeartRateZonePreferences,
    savePowerZoneBoundPercents,
    verifySupporterCode,
    removeSupporterBadge,
    toggleSettings,
  } = useSettingsStore();
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const language = useSettingsStore((s) => s.language);
  const { t } = useTranslation();

  const [codeInput, setCodeInput] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [codeMsg, setCodeMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [clearingBlacklist, setClearingBlacklist] = useState(false);
  const [blacklistMsg, setBlacklistMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [blacklistCount, setBlacklistCount] = useState<number | null>(null);
  const [showHrZoneDialog, setShowHrZoneDialog] = useState(false);

  const [showPowerZoneDialog, setShowPowerZoneDialog] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!showSettings) return;

    void Promise.all([api.getStorageInfo(), api.getBlacklistedHashCount()])
      .then(([info, count]) => {
        if (cancelled) return;
        setStorageInfo(info);
        setBlacklistCount(count.count);
      })
      .catch(() => {
        if (!cancelled) {
          setStorageInfo(null);
          setBlacklistCount(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [showSettings]);

  useEffect(() => {
    if (!showSettings) setShowHrZoneDialog(false);
    if (!showSettings) setShowPowerZoneDialog(false);
  }, [showSettings]);

  if (!showSettings) {
    return null;
  }

  async function handleVerifyCode() {
    if (!codeInput.trim()) return;
    setVerifying(true);
    setCodeMsg(null);
    const valid = await verifySupporterCode(codeInput.trim());
    setVerifying(false);
    if (valid) {
      setCodeMsg({ type: "success", text: t("settings.badgeActivated") });
      setCodeInput("");
    } else {
      setCodeMsg({ type: "error", text: t("settings.invalidCode") });
    }
  }

  async function handleClearBlacklist() {
    const ok = window.confirm(t("settings.confirmClearBlacklist"));
    if (!ok) return;
    setClearingBlacklist(true);
    setBlacklistMsg(null);
    try {
      const result = await api.clearBlacklistedHashes();
      setBlacklistMsg({ type: "success", text: t("settings.clearedHashes", { count: result.removed }) });
      setBlacklistCount(0);
    } catch (err) {
      setBlacklistMsg({
        type: "error",
        text: t("settings.clearBlacklistFailed", { error: err instanceof Error ? err.message : "unknown" }),
      });
    } finally {
      setClearingBlacklist(false);
    }
  }

  return (
    <div className="settings-overlay">
      <div className="settings-backdrop" onClick={toggleSettings} />
      <div className="settings-drawer">
        <div className="settings-drawer-header">
          <h3>{t("settings.title")}</h3>
          <button className="icon-btn" onClick={toggleSettings} aria-label={t("settings.closeSettings")}>&times;</button>
        </div>

        <div className="settings-grid">
          <label><span>{t("settings.language")}</span><select value={language} onChange={(e) => setLanguage(e.target.value)}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select></label>

          <label><span>{t("settings.theme")}</span><select value={theme} onChange={(e) => setTheme(e.target.value as "light" | "dark")}>
            <option value="light">{t("settings.themeLight")}</option>
            <option value="dark">{t("settings.themeDark")}</option>
          </select></label>

          <label><span>{t("settings.distanceUnit")}</span><select value={distanceUnit} onChange={(e) => setDistanceUnit(e.target.value as "km" | "mi")}>
            <option value="km">{t("settings.kilometers")}</option>
            <option value="mi">{t("settings.miles")}</option>
          </select></label>

          <label><span>{t("settings.timeFormat")}</span><select value={timeFormat} onChange={(e) => setTimeFormat(e.target.value as "12h" | "24h")}>
            <option value="24h">{t("settings.24hour")}</option>
            <option value="12h">{t("settings.12hour")}</option>
          </select></label>

          <label className="settings-checkbox" title={t("settings.smoothGraphsTooltip")}>
            <span>{t("settings.smoothGraphs")}</span>
            <input
              type="checkbox"
              checked={smoothGraphs}
              onChange={(e) => setSmoothGraphs(e.target.checked)}
            />
          </label>
        </div>

        <section className="hr-zone-settings" aria-labelledby="zone-settings-title">
          <div className="hr-zone-settings-header">
            <strong id="zone-settings-title">{t("settings.zoneSettingsTitle")}</strong>
          </div>

          <div className="zone-settings-actions">
            <div className="zone-settings-control">
              {(heartRateZonePreferenceStatus === "idle" || heartRateZonePreferenceStatus === "loading") && (
                <p className="hr-zone-status" role="status">{t("settings.hrZonesLoading")}</p>
              )}
              {heartRateZonePreferenceStatus === "error" && (
                <div className="hr-zone-load-error" role="alert">
                  <span>{t("settings.hrZonesLoadFailed")}</span>
                  <button type="button" className="btn-secondary" onClick={() => void loadHeartRateZonePreferences()}>
                    {t("app.retry")}
                  </button>
                </div>
              )}
              {heartRateZonePreferenceStatus === "ready" && (
                <>
                  <button
                    type="button"
                    className="hr-zone-btn-customize"
                    onClick={() => setShowHrZoneDialog(true)}
                    disabled={heartRateZonePreferenceSaving}
                  >
                    <IconHeart />
                    {t("settings.hrZonesButton")}
                  </button>
                  {heartRateZonePreferenceSaving && (
                    <p className="hr-zone-status" role="status">{t("settings.hrZonesSaving")}</p>
                  )}
                  {heartRateZonePreferenceError && !showHrZoneDialog && (
                    <p className="hr-zone-status error" role="alert">{t("settings.hrZonesSaveFailed")}</p>
                  )}
                </>
              )}
            </div>

            <div className="zone-settings-control">
              {(powerZonePreferenceStatus === "idle" || powerZonePreferenceStatus === "loading") && (
                <p className="hr-zone-status" role="status">{t("settings.powerZonesLoading")}</p>
              )}
              {powerZonePreferenceStatus === "error" && (
                <div className="hr-zone-load-error" role="alert">
                  <span>{t("settings.powerZonesLoadFailed")}</span>
                  <button type="button" className="btn-secondary" onClick={() => void loadPowerZonePreferences()}>
                    {t("app.retry")}
                  </button>
                </div>
              )}
              {powerZonePreferenceStatus === "ready" && (
                <>
                  <button
                    type="button"
                    className="hr-zone-btn-customize"
                    onClick={() => setShowPowerZoneDialog(true)}
                    disabled={powerZonePreferenceSaving}
                  >
                    <IconPower />
                    {t("settings.powerZonesButton")}
                  </button>
                  {powerZonePreferenceSaving && (
                    <p className="hr-zone-status" role="status">{t("settings.powerZonesSaving")}</p>
                  )}
                  {powerZonePreferenceError && !showPowerZoneDialog && (
                    <p className="hr-zone-status error" role="alert">{t("settings.powerZonesSaveFailed")}</p>
                  )}
                </>
              )}
            </div>
          </div>
        </section>
        <div className="links-box">
          <strong>{t("settings.linksAndContact")}</strong>
          <div className="settings-links-grid">
            <a className="settings-link-btn" href="https://github.com/arpanghosh8453/fit-dashboard/issues/new/choose" target="_blank" rel="noreferrer noopener" onClick={openExternalLink}>
              <IconBug /> {t("settings.bugReport")}
            </a>
            <a className="settings-link-btn" href="https://discord.gg/xVu4gK75zG" target="_blank" rel="noreferrer noopener" onClick={openExternalLink}>
              <IconDiscord /> {t("settings.joinDiscord")}
            </a>
            <a className="settings-link-btn" href="https://fitdashboard.app" target="_blank" rel="noreferrer noopener" onClick={openExternalLink}>
              <IconGlobe /> {t("settings.website")}
            </a>
            <a className="settings-link-btn" href="https://www.fitdashboard.app/#about" target="_blank" rel="noreferrer noopener" onClick={openExternalLink}>
              <IconMail /> {t("settings.contact")}
            </a>
          </div>
        </div>
        <div className="supporter-box">
          <div style={{ flex: 1 }}>
            <strong>{t("settings.supporterBadge")}</strong>
            <p className="small">
              {supporterBadge
                ? t("settings.thankYou")
                : t("settings.enterCode")}
            </p>
            {supporterBadge && (
              <div className="supporter-badge-row">
                <span className="supporter-badge-inline" title="Supporter Badge Active">{t("settings.supporter")}</span>
              </div>
            )}
          </div>
          {!supporterBadge ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" }}>
              <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                <input
                  type="text"
                  placeholder={t("settings.codePlaceholder")}
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleVerifyCode()}
                  style={{ width: "110px", fontSize: "12px", padding: "0.35rem" }}
                />
                <button
                  className="btn-primary"
                  onClick={handleVerifyCode}
                  disabled={verifying || !codeInput.trim()}
                  style={{ padding: "0.35rem 0.7rem", fontSize: "12px" }}
                >
                  {verifying ? "..." : t("settings.verify")}
                </button>
              </div>
              {codeMsg && (
                <span style={{ fontSize: "11px", color: codeMsg.type === "success" ? "var(--success)" : "var(--danger)" }}>
                  {codeMsg.text}
                </span>
              )}
            </div>
          ) : (
            <button
              className="btn-secondary"
              onClick={() => void removeSupporterBadge()}
              style={{ whiteSpace: "nowrap" }}
            >
              {t("settings.removeBadge")}
            </button>
          )}
        </div>

        <div className="storage-box">
          <strong>{t("settings.storageLocations")}</strong>
          {storageInfo ? (
            <div className="storage-meta">
              <div>
                <span>{t("settings.appVersion")}</span> <code>{appVersion}</code>
                {versionBadgeStatus.state === "latest" && (
                  <span className="version-status-badge latest" title="You are on the latest release">
                    {t("settings.latest")}
                  </span>
                )}
                {versionBadgeStatus.state === "update" && versionBadgeStatus.latestVersion && (
                  <a
                    className="version-status-badge update"
                    href="https://fitdashboard.app"
                    target="_blank"
                    rel="noreferrer noopener"
                    title={`A newer release is available: ${versionBadgeStatus.latestVersion}`}
                    onClick={openExternalLink}
                  >
                    {t("settings.updateTo", { version: versionBadgeStatus.latestVersion })}
                  </a>
                )}
              </div>
              <div><span>{t("settings.appData")}</span> <code>{storageInfo.data_dir}</code></div>
              <div><span>{t("settings.database")}</span> <code>{storageInfo.db_path}</code></div>
              <div><span>{t("settings.fitFiles")}</span> <code>{storageInfo.fit_files_dir}</code></div>
            </div>
          ) : (
            <p className="small">{t("settings.storageUnavailable")}</p>
          )}

          <div style={{ marginTop: "0.7rem", display: "flex", flexDirection: "column", gap: "0.35rem", alignItems: "flex-start" }}>
            <span className="small">
              {t("settings.blacklistedHashes")} <strong>{blacklistCount ?? "-"}</strong>
            </span>
            <button
              className="btn-danger"
              onClick={() => void handleClearBlacklist()}
              disabled={clearingBlacklist}
            >
              {clearingBlacklist ? t("settings.clearing") : t("settings.clearBlacklist")}
            </button>
            {blacklistMsg && (
              <span
                className="small"
                style={{ color: blacklistMsg.type === "success" ? "var(--success)" : "var(--danger)" }}
              >
                {blacklistMsg.text}
              </span>
            )}
          </div>
        </div>
      </div>
      {showHrZoneDialog && (
        <HeartRateZoneDialog
          bounds={manualHeartRateZoneBoundsBpm}
          usage={manualHeartRateZoneUsage}
          saving={heartRateZonePreferenceSaving}
          saveError={!!heartRateZonePreferenceError}
          onSave={saveManualHeartRateZonePreferences}
          onClose={() => setShowHrZoneDialog(false)}
          t={t}
        />
      )}
      {showPowerZoneDialog && (
        <PowerZoneDialog
          bounds={configuredPowerZoneBoundPercents}
          saving={powerZonePreferenceSaving}
          saveError={!!powerZonePreferenceError}
          onSave={savePowerZoneBoundPercents}
          onClose={() => setShowPowerZoneDialog(false)}
          t={t}
        />
      )}
    </div>
  );
}
