import { useEffect, useState } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import { api } from "../lib/api";
import { openExternalLink } from "../lib/links";
import { useTranslation, LANGUAGES } from "../lib/i18n";
import {
  IconActivity, IconAvg, IconBarChart, IconBattery, IconBug, IconCadence, IconCheck,
  IconChevron, IconClipboard, IconClock, IconCollapse, IconCrank, IconDevice, IconDiscord,
  IconDistance, IconLocation, IconDownload, IconEdit, IconExpand, IconFile, IconFlame, IconGlobe,
  IconHeart, IconLogout, IconMail, IconMenu, IconMetronome, IconMoon, IconMountain, IconPower,
  IconRefresh, IconSearch, IconSettings, IconSort, IconSortDirection, IconSport,
  IconSpeed, IconSun, IconTrash, IconUser, IconVo2, IconX
} from "./Icons";


const ICON_PREVIEW_ITEMS = [
  { name: "IconActivity", icon: <IconActivity /> },
  { name: "IconAvg", icon: <IconAvg /> },
  { name: "IconBarChart", icon: <IconBarChart size={18} /> },
  { name: "IconBattery", icon: <IconBattery /> },
  { name: "IconBug", icon: <IconBug /> },
  { name: "IconCadence", icon: <IconCadence /> },
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
  { name: "IconSort", icon: <IconSort /> },
  { name: "IconSortDirection asc", icon: <IconSortDirection direction="asc" /> },
  { name: "IconSortDirection desc", icon: <IconSortDirection direction="desc" /> },
  { name: "IconSport", icon: <IconSport /> },
  { name: "IconSpeed", icon: <IconSpeed /> },
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



export function SettingsPanel({ appVersion, versionBadgeStatus }: Props) {
  const {
    showSettings,
    theme,
    distanceUnit,
    timeFormat,
    mapStyle,
    supporterBadge,
    setTheme,
    setDistanceUnit,
    setTimeFormat,
    setMapStyle,
    verifySupporterCode,
    removeSupporterBadge,
    toggleSettings
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
        </div>

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
    </div>
  );
}
