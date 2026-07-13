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
} from "../lib/hrZones";
import {
  IconActivity, IconAvg, IconBarChart, IconBattery, IconBug, IconChainring, IconCheck,
  IconChevron, IconClipboard, IconClock, IconCollapse, IconCrank, IconDevice, IconDiscord,
  IconDistance, IconLocation, IconDownload, IconEdit, IconExpand, IconFile, IconFlame, IconGauge, IconGlobe,
  IconHeart, IconLogout, IconMail, IconMenu, IconMetronome, IconMoon, IconMountain, IconPower,
  IconRefresh, IconSearch, IconShoe, IconSettings, IconSort, IconSortDirection, IconSport, IconSun, IconTrash, IconUser, IconVo2, IconX
} from "./Icons";


const ICON_PREVIEW_ITEMS = [
  { name: "IconActivity", icon: <IconActivity /> },
  { name: "IconAvg", icon: <IconAvg /> },
  { name: "IconBarChart", icon: <IconBarChart size={18} /> },
  { name: "IconBattery", icon: <IconBattery /> },
  { name: "IconBug", icon: <IconBug /> },
  { name: "IconChainring", icon: <IconChainring /> },
  { name: "IconGauge", icon: <IconGauge /> },
  { name: "IconCheck", icon: <IconCheck /> },
  { name: "IconChevron", icon: <IconChevron /> },
  { name: "IconClipboard", icon: <IconClipboard /> },
  { name: "IconClock", icon: <IconClock /> },
  { name: "IconCollapse", icon: <IconCollapse /> },
  { name: "IconCrank", icon: <IconCrank /> },
  { name: "IconDevice", icon: <IconDevice /> },
  { name: "IconDiscord", icon: <IconDiscord /> },
  { name: "IconDistance", icon: <IconDistance /> },
  { name: "IconLocation", icon: <IconLocation /> },
  { name: "IconDownload", icon: <IconDownload /> },
  { name: "IconEdit", icon: <IconEdit /> },
  { name: "IconExpand", icon: <IconExpand /> },
  { name: "IconFile", icon: <IconFile /> },
  { name: "IconFlame", icon: <IconFlame /> },
  { name: "IconGlobe", icon: <IconGlobe /> },
  { name: "IconHeart", icon: <IconHeart /> },
  { name: "IconLogout", icon: <IconLogout /> },
  { name: "IconMail", icon: <IconMail /> },
  { name: "IconMenu", icon: <IconMenu /> },
  { name: "IconMetronome", icon: <IconMetronome /> },
  { name: "IconMoon", icon: <IconMoon /> },
  { name: "IconMountain", icon: <IconMountain /> },
  { name: "IconPower", icon: <IconPower /> },
  { name: "IconRefresh", icon: <IconRefresh /> },
  { name: "IconSearch", icon: <IconSearch /> },
  { name: "IconSettings", icon: <IconSettings /> },
  { name: "IconShoe", icon: <IconShoe /> },
  { name: "IconSort", icon: <IconSort /> },
  { name: "IconSortDirection asc", icon: <IconSortDirection direction="asc" /> },
  { name: "IconSortDirection desc", icon: <IconSortDirection direction="desc" /> },
  { name: "IconSport", icon: <IconSport /> },
  { name: "IconSun", icon: <IconSun /> },
  { name: "IconTrash", icon: <IconTrash /> },
  { name: "IconUser", icon: <IconUser /> },
  { name: "IconVo2", icon: <IconVo2 /> },
  { name: "IconX", icon: <IconX /> },
];

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
  saving,
  saveError,
  onSave,
  onClose,
  t,
}: {
  bounds: number[];
  saving: boolean;
  saveError: boolean;
  onSave: (boundsBpm: number[]) => Promise<boolean>;
  onClose: () => void;
  t: Translate;
}) {
  const [draft, setDraft] = useState(() => [...bounds]);
  const [dragging, setDragging] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
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
      if (event.key === "Escape" && !saving) onClose();
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [role="slider"][tabindex="0"]'
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
            onClick={() => setDraft([...DEFAULT_HR_ZONE_BOUNDS])}
            disabled={saving}
          >
            {t("settings.hrZonesReset")}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void onSave(draft).then((saved) => { if (saved) onClose(); })}
            disabled={saving || !validateManualHeartRateZoneBounds(draft)}
          >
            {saving ? t("settings.hrZonesSaving") : t("settings.hrZonesSave")}
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
    mapStyle,
    smoothGraphs,
    supporterBadge,
    manualHeartRateZoneBoundsBpm,
    manualHeartRateZoneUsage,
    heartRateZonePreferenceStatus,
    heartRateZonePreferenceSaving,
    heartRateZonePreferenceError,
    setTheme,
    setDistanceUnit,
    setTimeFormat,
    setMapStyle,
    setSmoothGraphs,
    loadHeartRateZonePreferences,
    saveManualHeartRateZoneBounds,
    setManualHeartRateZoneUsage,
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

          <label><span>{t("settings.mapStyle")}</span><select value={mapStyle} onChange={(e) => setMapStyle(e.target.value as any)}>
              <option value="default">{t("settings.mapDefault")}</option>
              <option value="light">{t("settings.mapLight")}</option>
              <option value="dark">{t("settings.mapDark")}</option>
              <option value="openstreet">{t("settings.mapOpenStreet")}</option>
              <option value="topo">{t("settings.mapTopo")}</option>
              <option value="satellite">{t("settings.mapSatellite")}</option>
            </select>
          </label>

          <label className="settings-checkbox" title={t("settings.smoothGraphsTooltip")}>
            <span>{t("settings.smoothGraphs")}</span>
            <input
              type="checkbox"
              checked={smoothGraphs}
              onChange={(e) => setSmoothGraphs(e.target.checked)}
            />
          </label>
        </div>

        <section className="hr-zone-settings" aria-labelledby="manual-hr-zone-settings-title">
          <div className="hr-zone-settings-header">
            <div>
              <strong id="manual-hr-zone-settings-title">{t("settings.hrZonesManualTitle")}</strong>
              <p className="small">{t("settings.hrZonesManualDescription")}</p>
            </div>
            <IconHeart />
          </div>

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
                {t("settings.customizeHrZones")}
              </button>

              <fieldset className="hr-zone-policy" disabled={heartRateZonePreferenceSaving}>
                <legend>{t("settings.hrZonesUsage")}</legend>
                <label>
                  <input
                    type="radio"
                    name="heart-rate-zone-usage"
                    value="fallback"
                    checked={manualHeartRateZoneUsage === "fallback"}
                    onChange={() => void setManualHeartRateZoneUsage("fallback")}
                  />
                  <span>
                    <strong>{t("settings.hrZonesFallback")}</strong>
                    <small>{t("settings.hrZonesFallbackHelp")}</small>
                  </span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="heart-rate-zone-usage"
                    value="always"
                    checked={manualHeartRateZoneUsage === "always"}
                    onChange={() => void setManualHeartRateZoneUsage("always")}
                  />
                  <span>
                    <strong>{t("settings.hrZonesAlways")}</strong>
                    <small>{t("settings.hrZonesAlwaysHelp")}</small>
                  </span>
                </label>
              </fieldset>

              {heartRateZonePreferenceSaving && (
                <p className="hr-zone-status" role="status">{t("settings.hrZonesSaving")}</p>
              )}
              {heartRateZonePreferenceError && !showHrZoneDialog && (
                <p className="hr-zone-status error" role="alert">{t("settings.hrZonesSaveFailed")}</p>
              )}
            </>
          )}
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


        <div className="icon-preview-box">
          <strong>Icon Preview</strong>
          <div className="icon-preview-grid">
            {ICON_PREVIEW_ITEMS.map((item) => (
              <div key={item.name} className="icon-preview-item">
                <span className="icon-preview-glyph">{item.icon}</span>
                <span>{item.name}</span>
              </div>
            ))}
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
          saving={heartRateZonePreferenceSaving}
          saveError={!!heartRateZonePreferenceError}
          onSave={saveManualHeartRateZoneBounds}
          onClose={() => setShowHrZoneDialog(false)}
          t={t}
        />
      )}
    </div>
  );
}
