export const POWER_ZONE_PREFERENCES_VERSION = 2 as const;
export const DEFAULT_POWER_ZONE_BOUND_PERCENTS = [55, 75, 90, 105, 120, 150] as const;
export const POWER_ZONE_BOUND_COUNT = 6;
export const POWER_ZONE_BOUND_MIN_PERCENT = 1;
export const POWER_ZONE_BOUND_MAX_PERCENT = 300;
export const POWER_ZONE_BOUND_MIN_GAP_PERCENT = 5;
export const POWER_ZONE_FTP_MIN_WATTS = 50;
export const POWER_ZONE_FTP_MAX_WATTS = 2000;

export type PowerZoneTimeSource = "fit" | "calculated";

export type PowerZonePreferences = {
  version: typeof POWER_ZONE_PREFERENCES_VERSION;
  bounds_percent_ftp: number[];
  zone_time_source: PowerZoneTimeSource;
};

const LEGACY_POWER_ZONE_PREFERENCES_VERSION = 1;
const LEGACY_POWER_ZONE_BOUND_COUNT = 7;

function validatePowerZoneBounds(bounds: unknown, expectedCount: number): bounds is number[] {
  if (!Array.isArray(bounds) || bounds.length !== expectedCount) return false;
  if (bounds.some((value) => !Number.isInteger(value)
    || value < POWER_ZONE_BOUND_MIN_PERCENT
    || value > POWER_ZONE_BOUND_MAX_PERCENT)) {
    return false;
  }
  return bounds.every((value, index) => index === 0
    || value - bounds[index - 1] >= POWER_ZONE_BOUND_MIN_GAP_PERCENT);
}

export function validatePowerZoneBoundPercents(bounds: unknown): bounds is number[] {
  return validatePowerZoneBounds(bounds, POWER_ZONE_BOUND_COUNT);
}

export function normalizePowerZonePreferences(value: unknown): PowerZonePreferences {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid power-zone preferences");
  }
  const candidate = value as {
    version?: number;
    bounds_percent_ftp?: unknown;
    zone_time_source?: unknown;
  };
  if (candidate.zone_time_source !== "fit" && candidate.zone_time_source !== "calculated") {
    throw new Error("Invalid power-zone preferences");
  }

  if (candidate.version === LEGACY_POWER_ZONE_PREFERENCES_VERSION
    && validatePowerZoneBounds(candidate.bounds_percent_ftp, LEGACY_POWER_ZONE_BOUND_COUNT)) {
    return {
      version: POWER_ZONE_PREFERENCES_VERSION,
      bounds_percent_ftp: candidate.bounds_percent_ftp.slice(0, POWER_ZONE_BOUND_COUNT),
      zone_time_source: candidate.zone_time_source,
    };
  }

  if (candidate.version !== POWER_ZONE_PREFERENCES_VERSION
    || !validatePowerZoneBoundPercents(candidate.bounds_percent_ftp)) {
    throw new Error("Invalid power-zone preferences");
  }
  return {
    version: POWER_ZONE_PREFERENCES_VERSION,
    bounds_percent_ftp: [...candidate.bounds_percent_ftp],
    zone_time_source: candidate.zone_time_source,
  };
}

export function isUsablePowerZoneFtp(value: unknown): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= POWER_ZONE_FTP_MIN_WATTS
    && value <= POWER_ZONE_FTP_MAX_WATTS;
}

export function configuredPowerZoneBoundsWatts(
  ftpWatts: unknown,
  boundPercents: unknown,
): number[] | undefined {
  if (!isUsablePowerZoneFtp(ftpWatts) || !validatePowerZoneBoundPercents(boundPercents)) {
    return undefined;
  }

  const bounds = boundPercents.map((percent) => Math.round(ftpWatts * percent / 100));
  return bounds.every((value, index) => index === 0 || value > bounds[index - 1])
    ? bounds
    : undefined;
}

export function validFitPowerZoneSeconds(value: unknown): number[] | null {
  if (!Array.isArray(value)
    || value.length === 0
    || value.some((item) => typeof item !== "number" || !Number.isFinite(item) || item < 0)
    || !value.some((item) => item > 0)) {
    return null;
  }
  return [...value] as number[];
}

export function resolvePowerZoneTimeSource(
  preferred: PowerZoneTimeSource,
  fitAvailable: boolean,
  calculatedAvailable: boolean,
): PowerZoneTimeSource | undefined {
  if (preferred === "fit" && fitAvailable) return "fit";
  if (preferred === "calculated" && calculatedAvailable) return "calculated";
  if (fitAvailable) return "fit";
  if (calculatedAvailable) return "calculated";
  return undefined;
}
