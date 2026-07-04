const EMPTY_TYPE_VALUES = new Set(["", "unknown", "generic"]);

const SPORT_LABELS: Record<string, string> = {
  e_biking: "eBiking",
};

const SUB_SPORT_LABELS: Record<string, string> = {
  "cycling:road": "Road Cycling",
  "cycling:indoor_cycling": "Indoor Cycling",
  "cycling:spin": "Indoor Cycling",
  "cycling:mountain": "Mountain Biking",
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

function normalizeToken(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function humanizeActivityToken(value: string | null | undefined): string {
  return normalizeToken(value)
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => {
      if (["gps", "hr", "hrm", "bmx", "hiit"].includes(part)) return part.toUpperCase();
      if (part === "ebike" || part === "ebiking") return "eBiking";
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

export function formatActivityTypeLabel(sport: string | null | undefined, subSport?: string | null): string {
  const sportKey = normalizeToken(sport);
  const subSportKey = normalizeToken(subSport);

  if (!EMPTY_TYPE_VALUES.has(subSportKey)) {
    return SUB_SPORT_LABELS[`${sportKey}:${subSportKey}`] ?? humanizeActivityToken(subSportKey);
  }

  if (EMPTY_TYPE_VALUES.has(sportKey)) return "";
  return SPORT_LABELS[sportKey] ?? humanizeActivityToken(sportKey);
}
