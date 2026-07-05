import productLookup from "../data/deviceProductLookup.json";
import type { Activity } from "../types";
import type { TelemetryTimerMetadata } from "./telemetryAxis";

export type CodeNameLabel = {
  code?: number | null;
  name?: string | null;
  label?: string | null;
};

export type ProductMetadata = {
  field?: string | null;
  code?: number | null;
  name?: string | null;
  label?: string | null;
  lookup_source?: string | null;
};

type ProductLookupEntry = {
  manufacturer: string;
  manufacturerCode?: number;
  productField?: string;
  productCode: number;
  productName?: string | null;
  displayName: string;
  source: string;
  roles?: string[];
  sourceTypes?: string[];
  sourceTypeCodes?: number[];
  deviceTypes?: string[];
  deviceTypeCodes?: number[];
};

const DEVICE_PRODUCT_LOOKUP = productLookup as ProductLookupEntry[];

export type DeviceMetadata = {
  role?: string | null;
  device_indices?: Array<string | number | null>;
  source_type?: CodeNameLabel | null;
  device_types?: CodeNameLabel[];
  manufacturer?: CodeNameLabel | null;
  product?: ProductMetadata | null;
  serial_number?: number | null;
  software_version?: string | null;
  hardware_version?: number | null;
  battery_status?: string | null;
  battery_level?: number | null;
  battery_voltage?: number | null;
  identifiers?: {
    ant_device_number?: number | null;
    ant_transmission_type?: number | null;
    ant_network?: string | null;
    descriptor?: string | null;
  } | null;
  first_seen_utc?: string | null;
  last_seen_utc?: string | null;
};

export type DeviceInfoMetadata = {
  schema_version?: number | null;
  source_support?: string | null;
  creator_product_name?: string | null;
  creator_serial_number?: number | null;
  fallback_product_name?: string | null;
  fallback_serial_number?: number | null;
  decoded_file_id?: {
    manufacturer?: CodeNameLabel | null;
    product?: ProductMetadata | null;
    serial_number?: number | null;
    time_created_utc?: string | null;
  } | null;
  devices?: DeviceMetadata[];
  raw_device_info_record_count?: number | null;
};

export type WorkoutMetadata = {
  wkt_name?: string | number | null;
  wkt_description?: string | number | null;
  sport?: string | number | null;
  sub_sport?: string | number | null;
  num_valid_steps?: number | null;
  capabilities?: string | number | null;
};

export type WorkoutStepMetadata = {
  message_index?: number | null;
  wkt_step_name?: string | number | null;
  duration_type?: string | number | null;
  duration_value?: number | null;
  target_type?: string | number | null;
  target_value?: string | number | null;
  custom_target_value_low?: number | null;
  custom_target_value_high?: number | null;
  intensity?: string | number | null;
  notes?: string | number | null;
};

export type ActivityMetadata = {
  heart_rate_zone_bounds_bpm?: number[];
  file_id?: {
    product_name?: string | null;
    serial_number?: number | null;
  };
  device_info?: DeviceInfoMetadata | null;
  timer?: TelemetryTimerMetadata | null;
  workout?: WorkoutMetadata | null;
  workout_steps?: WorkoutStepMetadata[];
  training_file?: {
    type?: string | number | null;
    manufacturer?: string | number | null;
    garmin_product?: string | number | null;
    product?: string | number | null;
  } | null;
  activity_metrics?: {
    vo2_max?: number | null;
  };
  session?: {
    beginning_body_battery?: number | null;
    ending_body_battery?: number | null;
    max_heart_rate?: number | null;
    avg_heart_rate?: number | null;
    max_cadence?: number | null;
    avg_cadence?: number | null;
    total_elapsed_time_s?: number | null;
    total_distance_m?: number | null;
    total_calories?: number | null;
    normalized_power?: number | null;
  };
  laps?: Array<{
    start_ts_utc?: string | null;
    end_ts_utc?: string | null;
    total_elapsed_time_s?: number | null;
    total_timer_time_s?: number | null;
    total_distance_m?: number | null;
    avg_speed_m_s?: number | null;
    max_speed_m_s?: number | null;
    avg_heart_rate?: number | null;
    max_heart_rate?: number | null;
    total_ascent_m?: number | null;
    total_descent_m?: number | null;
    avg_cadence?: number | null;
    max_cadence?: number | null;
    total_calories?: number | null;
    best_speed_m_s?: number | null;
    normalized_power?: number | null;
    wkt_step_index?: number | null;
    lap_trigger?: string | null;
    intensity?: string | number | null;
  }>;
};

export function parseActivityMetadata(raw?: string): ActivityMetadata | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ActivityMetadata;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function labelFromIdentifier(value?: string | null): string | null {
  if (!value) return null;
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (["ant", "gps", "gnss", "hr", "hrm", "ble", "ohr"].includes(lower)) {
        return lower.toUpperCase();
      }
      if (lower === "antplus") return "ANT+";
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function firstDeviceTypeLabel(device: DeviceMetadata): string | null {
  return device.device_types?.find((type) => type.label || type.name)?.label
    ?? labelFromIdentifier(device.device_types?.find((type) => type.name)?.name)
    ?? null;
}

function displayManufacturerLabel(device: DeviceMetadata): string | null {
  return device.manufacturer?.label
    ?? labelFromIdentifier(device.manufacturer?.name)
    ?? null;
}

function normalizedIdentifier(value?: string | null): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function hasLookupConstraints(entry: ProductLookupEntry): boolean {
  return Boolean(
    entry.roles?.length
    || entry.sourceTypes?.length
    || entry.sourceTypeCodes?.length
    || entry.deviceTypes?.length
    || entry.deviceTypeCodes?.length
  );
}

function includesNormalized(values: string[] | undefined, value?: string | null): boolean {
  const normalized = normalizedIdentifier(value);
  return Boolean(
    normalized
    && values?.some((candidate) => normalizedIdentifier(candidate) === normalized)
  );
}

function matchesCodeNameConstraint(
  value: CodeNameLabel | null | undefined,
  names?: string[],
  codes?: number[]
): boolean {
  if (!names?.length && !codes?.length) return true;
  return includesNormalized(names, value?.name)
    || (typeof value?.code === "number" && Boolean(codes?.includes(value.code)));
}

function matchesAnyCodeNameConstraint(
  values: CodeNameLabel[] | null | undefined,
  names?: string[],
  codes?: number[]
): boolean {
  if (!names?.length && !codes?.length) return true;
  return (values ?? []).some((value) => matchesCodeNameConstraint(value, names, codes));
}

function lookupEntryMatchesDevice(entry: ProductLookupEntry, device: DeviceMetadata): boolean {
  const product = device.product;
  if (typeof product?.code !== "number" || entry.productCode !== product.code) return false;

  const manufacturerName = normalizedIdentifier(device.manufacturer?.name);
  const manufacturerCode = device.manufacturer?.code;
  const productField = normalizedIdentifier(product.field);
  const candidateManufacturer = normalizedIdentifier(entry.manufacturer);
  const candidateField = normalizedIdentifier(entry.productField);
  const manufacturerMatches =
    (
      typeof entry.manufacturerCode === "number"
      && manufacturerCode === entry.manufacturerCode
    ) || (candidateManufacturer != null && candidateManufacturer === manufacturerName);
  const fieldMatches = !candidateField || !productField || candidateField === productField;

  if (!manufacturerMatches || !fieldMatches) return false;

  if (entry.roles?.length && !includesNormalized(entry.roles, device.role)) return false;

  if (!matchesCodeNameConstraint(device.source_type, entry.sourceTypes, entry.sourceTypeCodes)) {
    return false;
  }

  if (!matchesAnyCodeNameConstraint(device.device_types, entry.deviceTypes, entry.deviceTypeCodes)) {
    return false;
  }

  return true;
}

function supplementalProductLabel(device: DeviceMetadata, constrained: boolean): string | null {
  const entry = DEVICE_PRODUCT_LOOKUP.find((candidate) => (
    hasLookupConstraints(candidate) === constrained && lookupEntryMatchesDevice(candidate, device)
  ));

  return entry?.displayName ?? null;
}

function supplementalDecodedProductLabel(
  product?: ProductMetadata | null,
  manufacturer?: CodeNameLabel | null
): string | null {
  if (typeof product?.code !== "number") return null;

  return DEVICE_PRODUCT_LOOKUP.find((candidate) => (
    !hasLookupConstraints(candidate)
    && candidate.productCode === product.code
    && (
      (
        typeof candidate.manufacturerCode === "number"
        && manufacturer?.code === candidate.manufacturerCode
      ) || normalizedIdentifier(candidate.manufacturer) === normalizedIdentifier(manufacturer?.name)
    )
    && (
      !candidate.productField
      || !product.field
      || normalizedIdentifier(candidate.productField) === normalizedIdentifier(product.field)
    )
  ))?.displayName ?? null;
}

function forerunnerLabel(value?: string | null): string | null {
  const match = value?.match(/^fr(\d+)(xt|m)?(?:_(.*))?$/i);
  if (!match) return null;

  const [, model, rawModelSuffix, rawRest] = match;
  let modelSuffix = "";
  const descriptors = new Set<string>();
  if (rawModelSuffix?.toLowerCase() === "xt") modelSuffix += "XT";
  if (rawModelSuffix?.toLowerCase() === "m") descriptors.add("Music");

  for (const part of rawRest?.split("_").filter(Boolean) ?? []) {
    const lower = part.toLowerCase();
    if (lower === "small" || lower === "s") modelSuffix += "S";
    else if (lower === "large") continue;
    else if (lower === "m" || lower === "music") descriptors.add("Music");
    else if (lower === "lte") descriptors.add("LTE");
    else if (lower === "apac") descriptors.add("APAC");
    else if (lower === "sea") descriptors.add("SEA");
    else descriptors.add(labelFromIdentifier(lower) ?? part);
  }

  const suffix = descriptors.size > 0 ? ` ${Array.from(descriptors).join(" ")}` : "";
  return `Forerunner ${model}${modelSuffix}${suffix}`;
}

function isGenericProductLabel(value?: string | null): boolean {
  return /^product[\s_-]*\d+$/i.test(value?.trim() ?? "");
}

function profileProductLabel(product?: ProductMetadata | null): string | null {
  const label = forerunnerLabel(product?.name)
    ?? product?.label
    ?? labelFromIdentifier(product?.name);

  return label && !isGenericProductLabel(label) ? label : null;
}

function rawProductCodeLabel(product?: ProductMetadata | null): string | null {
  return typeof product?.code === "number" ? `Product ${product.code}` : null;
}

function derivedProductLabel(device: DeviceMetadata): string | null {
  const product = device.product;
  return supplementalProductLabel(device, true)
    ?? profileProductLabel(product)
    ?? supplementalProductLabel(device, false);
}

export function formatDeviceLabel(device: DeviceMetadata): string {
  const manufacturer = displayManufacturerLabel(device) ?? "";
  const product = derivedProductLabel(device);
  const deviceType = firstDeviceTypeLabel(device);
  const rawProduct = rawProductCodeLabel(device.product);
  const displayPart = product ?? deviceType ?? rawProduct ?? "";

  return [manufacturer, displayPart].filter(Boolean).join(" ").trim()
    || deviceType
    || rawProduct
    || "Device";
}

function typeOrder(device: DeviceMetadata): number {
  const names = new Set((device.device_types ?? []).map((type) => type.name));
  if (names.has("heart_rate")) return 0;
  if (names.has("bike_power")) return 1;
  if (names.has("bike_cadence")) return 2;
  if (names.has("bike_speed")) return 3;
  if (names.has("bike_speed_cadence")) return 4;
  if (names.has("bike_radar")) return 5;
  if (names.has("bike_light_main") || names.has("bike_light_shared")) return 6;
  if (names.has("shifting")) return 7;
  if (names.has("temperature")) return 8;
  return 9;
}

export function getAccessoryDevices(metadata: ActivityMetadata | null): DeviceMetadata[] {
  return [...(metadata?.device_info?.devices ?? [])]
    .filter((device) => device.role === "accessory")
    .sort((a, b) => {
      const byType = typeOrder(a) - typeOrder(b);
      if (byType !== 0) return byType;
      return formatDeviceLabel(a).localeCompare(formatDeviceLabel(b));
    });
}

export function getPrimaryDevice(metadata: ActivityMetadata | null): DeviceMetadata | null {
  return metadata?.device_info?.devices?.find((device) => device.role === "primary") ?? null;
}

function decodedFileIdLabel(info?: DeviceInfoMetadata | null): string | null {
  const decoded = info?.decoded_file_id;
  if (!decoded) return null;

  const manufacturer = decoded.manufacturer?.label
    ?? labelFromIdentifier(decoded.manufacturer?.name)
    ?? null;
  const product = profileProductLabel(decoded.product)
    ?? supplementalDecodedProductLabel(decoded.product, decoded.manufacturer)
    ?? null;
  const label = [manufacturer, product].filter(Boolean).join(" ").trim();
  return label || null;
}

export function getPrimaryDeviceLabel(
  metadata: ActivityMetadata | null,
  activity?: Pick<Activity, "device"> | null
): string {
  const primary = getPrimaryDevice(metadata);
  if (primary) return formatDeviceLabel(primary);
  return decodedFileIdLabel(metadata?.device_info)
    || activity?.device
    || metadata?.file_id?.product_name
    || "";
}

function buildExportDevice(device: DeviceMetadata) {
  return {
    ...device,
    display: {
      name: formatDeviceLabel(device),
      manufacturer: displayManufacturerLabel(device),
      product: derivedProductLabel(device),
      deviceType: firstDeviceTypeLabel(device),
    },
  };
}

export function buildExportDeviceInfo(metadata: ActivityMetadata | null) {
  const info = metadata?.device_info;
  if (!info) return null;

  const devices = info.devices ?? [];
  return {
    schemaVersion: info.schema_version ?? null,
    sourceSupport: info.source_support ?? null,
    decodedFileId: info.decoded_file_id ?? null,
    primary: devices.filter((device) => device.role === "primary").map(buildExportDevice),
    accessories: getAccessoryDevices(metadata).map(buildExportDevice),
    internal: devices.filter((device) => device.role === "internal").map(buildExportDevice),
    devices: devices.map(buildExportDevice),
    rawDeviceInfoRecordCount: info.raw_device_info_record_count ?? null,
  };
}
