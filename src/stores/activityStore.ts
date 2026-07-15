import { create } from "zustand";
import type { Activity, ActivitySegment, OverviewStats, RecordPoint } from "../types";
import { api } from "../lib/api";

type MetadataShape = {
  laps?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

function parseMetadata(raw?: string): MetadataShape {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as MetadataShape;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

let recordsRequestId = 0;

function deriveSegmentActivity(parent: Activity, segment: ActivitySegment): Activity {
  const parentMetadata = parseMetadata(parent.metadata_json);
  const segmentMetadata = parseMetadata(segment.metadata_json);
  const laps = (parentMetadata.laps ?? []).filter(
    (lap) => Number(lap.segment_index) === segment.segment_index
  );
  const metadata = {
    ...parentMetadata,
    ...segmentMetadata,
    sport: segment.sport,
    laps,
  };
  return {
    ...parent,
    activity_name: segment.name,
    sport: segment.sport,
    start_ts_utc: segment.start_ts_utc,
    end_ts_utc: segment.end_ts_utc,
    duration_s: segment.timer_duration_s > 0
      ? segment.timer_duration_s
      : segment.elapsed_duration_s,
    distance_m: segment.distance_m,
    start_latitude: segment.start_latitude,
    start_longitude: segment.start_longitude,
    metadata_json: JSON.stringify(metadata),
    activity_kind: "multisport_segment",
    segments: [],
  };
}

type ActivityState = {
  activities: Activity[];
  selectedActivity: Activity | null;
  selectedParentActivity: Activity | null;
  selectedSegment: ActivitySegment | null;
  overview: OverviewStats | null;
  records: RecordPoint[];
  loading: boolean;
  filterSport: string;
  setFilterSport: (sport: string) => void;
  refresh: () => Promise<void>;
  selectActivity: (activity: Activity | null, segment?: ActivitySegment | null) => Promise<void>;
};

export const useActivityStore = create<ActivityState>((set, get) => ({
  activities: [],
  selectedActivity: null,
  selectedParentActivity: null,
  selectedSegment: null,
  overview: null,
  records: [],
  loading: false,
  filterSport: "all",

  setFilterSport: (sport) => set({ filterSport: sport }),

  async refresh() {
    const requestId = ++recordsRequestId;
    set({ loading: true });
    try {
      const [activities, overview] = await Promise.all([api.listActivities(), api.getOverview()]);
      const previousParentId = get().selectedParentActivity?.id;
      const previousSegmentIndex = get().selectedSegment?.segment_index;
      const parent = activities.find((activity) => activity.id === previousParentId) ?? null;
      const segment = parent && previousSegmentIndex != null
        ? parent.segments.find((candidate) => candidate.segment_index === previousSegmentIndex) ?? null
        : null;
      const selectedActivity = parent
        ? (segment ? deriveSegmentActivity(parent, segment) : parent)
        : null;
      set({
        activities,
        overview,
        selectedParentActivity: parent,
        selectedSegment: segment,
        selectedActivity,
        records: selectedActivity ? get().records : [],
      });

      if (parent) {
        const records = await api.getRecords(parent.id, 10000, segment?.segment_index);
        if (requestId === recordsRequestId) set({ records });
      }
    } finally {
      set({ loading: false });
    }
  },

  async selectActivity(activity, segment = null) {
    const requestId = ++recordsRequestId;
    const selectedActivity = activity
      ? (segment ? deriveSegmentActivity(activity, segment) : activity)
      : null;
    set({
      selectedParentActivity: activity,
      selectedSegment: segment,
      selectedActivity,
      records: [],
    });
    if (!activity) return;
    const records = await api.getRecords(activity.id, 10000, segment?.segment_index);
    if (requestId === recordsRequestId) set({ records });
  }
}));
