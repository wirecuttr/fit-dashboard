import type { Activity } from "../types";

type ActivityMetadata = {
  sub_sport?: unknown;
  session?: {
    sub_sport?: unknown;
  };
};

const IGNORED_SUB_SPORTS = new Set(["generic", "all", "unknown", "invalid"]);

const SUB_SPORT_LABELS: Record<string, string> = {
  "cycling:road": "Road Cycling",
  "cycling:indoor_cycling": "Indoor Cycling",
  "cycling:spin": "Indoor Cycling",
  "cycling:mountain": "Mountain Biking",
  "cycling:mountain_biking": "Mountain Biking",
  "cycling:gravel_cycling": "Gravel Cycling",
  "cycling:e_bike_fitness": "eBiking",
  "e_biking:e_bike_fitness": "eBiking",
  "cycling:e_bike_mountain": "eMountain Biking",
  "e_biking:e_bike_mountain": "eMountain Biking",
  "cycling:cyclocross": "Cyclocross",
  "cycling:track_cycling": "Track Cycling",
  "running:trail": "Trail Running",
  "running:treadmill": "Treadmill Running",
  "running:indoor_running": "Treadmill Running",
  "running:track": "Track Running",
  "running:ultra": "Ultra Running",
  "swimming:lap_swimming": "Lap Swimming",
  "swimming:open_water": "Open Water Swimming",
  "training:strength_training": "Strength Training",
  "training:cardio_training": "Cardio Training",
  "training:yoga": "Yoga",
  "training:pilates": "Pilates",
};

const SUB_SPORT_ALIASES: Record<string, string> = {
  "cycling:spin": "cycling:indoor_cycling",
  "cycling:mountain_biking": "cycling:mountain",
};

function titleCaseWords(value: string): string {
  return value
    .trim()
    .split(/[\s_/-]+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
    })
    .join(" ");
}

function normalizedSport(sport?: string | null): string | null {
  const trimmed = sport?.trim().toLowerCase();
  if (!trimmed || trimmed === "unknown") return null;
  return trimmed;
}

function titleCaseSport(sport?: string | null): string {
  const sportKey = normalizedSport(sport);
  if (!sportKey) return "Activity";
  return titleCaseWords(sportKey) || "Activity";
}

function metadataSubSport(raw?: string): string | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as ActivityMetadata | null;
    if (!parsed || typeof parsed !== "object") return null;

    const value =
      typeof parsed.sub_sport === "string"
        ? parsed.sub_sport
        : typeof parsed.session?.sub_sport === "string"
          ? parsed.session.sub_sport
          : null;

    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

function normalizedSubSport(sport?: string | null, subSport?: string | null): string | null {
  const trimmedSubSport = subSport?.trim().toLowerCase();
  if (!trimmedSubSport || IGNORED_SUB_SPORTS.has(trimmedSubSport)) return null;

  const sportKey = normalizedSport(sport);
  const scopedKey = sportKey ? `${sportKey}:${trimmedSubSport}` : trimmedSubSport;
  const alias = SUB_SPORT_ALIASES[scopedKey];
  return alias ? alias.split(":")[1] ?? trimmedSubSport : trimmedSubSport;
}

export function formatActivityType(sport?: string | null, subSport?: string | null): string {
  const sportLabel = titleCaseSport(sport);
  const subSportKey = normalizedSubSport(sport, subSport);
  if (!subSportKey) return sportLabel;

  const sportKey = normalizedSport(sport) ?? "";
  const mappedLabel = SUB_SPORT_LABELS[`${sportKey}:${subSportKey}`];
  if (mappedLabel) return mappedLabel;

  const subSportLabel = titleCaseWords(subSportKey);
  if (!subSportLabel) return sportLabel;

  if (sportLabel === "Activity" || (sportKey && subSportKey.includes(sportKey))) {
    return subSportLabel;
  }

  return `${subSportLabel} ${sportLabel}`;
}

function activitySubSport(activity: Pick<Activity, "metadata_json" | "sub_sport">): string | null {
  return activity.sub_sport?.trim() || metadataSubSport(activity.metadata_json);
}

export function formatActivityTypeLabel(activity: Pick<Activity, "sport" | "metadata_json" | "sub_sport">): string {
  return formatActivityType(activity.sport, activitySubSport(activity));
}

export function formatSportLabel(sport?: string | null): string {
  return titleCaseSport(sport);
}

export function getSportFilterValue(sport?: string | null): string | null {
  const sportKey = normalizedSport(sport);
  return sportKey ? `sport:${sportKey}` : null;
}

export function getActivitySportFilterValue(activity: Pick<Activity, "sport">): string | null {
  return getSportFilterValue(activity.sport);
}

export function getActivityTypeFilterValue(activity: Pick<Activity, "sport" | "metadata_json" | "sub_sport">): string | null {
  const sportKey = normalizedSport(activity.sport);
  const subSportKey = normalizedSubSport(activity.sport, activitySubSport(activity));
  if (!sportKey || !subSportKey) return null;
  return `type:${sportKey}:${subSportKey}`;
}

export function activityMatchesTypeFilter(
  activity: Pick<Activity, "sport" | "metadata_json" | "sub_sport">,
  filterValue: string,
): boolean {
  if (filterValue === "all") return true;

  if (filterValue.startsWith("sport:")) {
    return getActivitySportFilterValue(activity) === filterValue;
  }

  if (filterValue.startsWith("type:")) {
    return getActivityTypeFilterValue(activity) === filterValue;
  }

  return activity.sport === filterValue;
}
