#!/usr/bin/env python3
"""Generate the device product lookup table from a Garmin FIT SDK zip.

Usage:
    python3 scripts/generate_device_product_lookup.py /path/to/FitSDKRelease.zip

The generated table combines SDK-derived exact product mappings with a small
set of observed, constrained accessory mappings that are not fully identified
by product code alone.
"""

from __future__ import annotations

import argparse
import json
import re
import zipfile
from pathlib import Path
from typing import Any

SOURCE = "garmin_fit_sdk_21_188"
DEFAULT_OUTPUT = Path("src/data/deviceProductLookup.json")

ACRONYMS = {
    "ant": "ANT",
    "antfs": "ANT-FS",
    "antplus": "ANT+",
    "ble": "BLE",
    "bt": "BT",
    "gps": "GPS",
    "gnss": "GNSS",
    "glonass": "GLONASS",
    "hr": "HR",
    "hrm": "HRM",
    "ohr": "OHR",
    "whr": "WHR",
    "ut": "UT",
    "duo": "Duo",
    "uno": "Uno",
    "id": "ID",
    "bsm": "BSM",
    "bcm": "BCM",
    "axs": "AXS",
    "axh": "AXH",
    "axb": "AXB",
    "dsi": "DSI",
    "alf": "ALF",
    "rct": "RCT",
}

EXACT_LABELS = {
    "OHR": "OHR",
    "edge_1040": "Edge 1040",
    "edge_1050": "Edge 1050",
    "hrm_200": "HRM 200",
    "assioma_duo": "Assioma Duo",
    "assioma_uno": "Assioma Uno",
}

PREFIX_MODEL_LABELS = {
    "edge": "Edge",
    "fenix": "fenix",
    "epix": "epix",
    "venu": "Venu",
    "vivoactive": "vivoactive",
    "vivofit": "vivofit",
    "vivosmart": "vivosmart",
    "vivomove": "vivomove",
    "vivoki": "vivoki",
    "approach": "Approach",
    "descent": "Descent",
    "instinct": "Instinct",
    "marq": "MARQ",
    "d2": "D2",
    "tactix": "tactix",
    "quatix": "quatix",
    "gpsmap": "GPSMAP",
    "etrex": "eTrex",
    "oregon": "Oregon",
    "rino": "Rino",
    "alpha": "Alpha",
    "montana": "Montana",
    "inreach": "inReach",
    "zumo": "zumo",
    "nuvi": "nuvi",
    "virb": "VIRB",
    "vector": "Vector",
    "varia": "Varia",
    "index": "Index",
    "lily": "Lily",
    "bounce": "Bounce",
}

COMPACT_ACRONYM_PREFIXES = ("hrm", "bsm", "bcm", "axs", "axh", "axb", "dsi", "alf", "rct", "ut")

OBSERVED_ENTRIES: list[dict[str, Any]] = [
    {
        "manufacturer": "garmin",
        "manufacturerCode": 1,
        "productField": "garmin_product",
        "productCode": 255,
        "productName": "hrm_200",
        "displayName": "HRM 200",
        "source": "observed_fit_device_type",
        "roles": ["accessory"],
        "sourceTypes": ["antplus"],
        "sourceTypeCodes": [1],
        "deviceTypes": ["heart_rate"],
        "deviceTypeCodes": [120],
    },
    {
        "manufacturer": "garmin",
        "manufacturerCode": 1,
        "productField": "garmin_product",
        "productCode": 3592,
        "productName": "varia_rtl515",
        "displayName": "Varia RTL515",
        "source": "observed_fit_device_type",
        "roles": ["accessory"],
        "sourceTypes": ["antplus"],
        "sourceTypeCodes": [1],
        "deviceTypes": ["bike_radar", "bike_light_main", "bike_light_shared"],
        "deviceTypeCodes": [35, 40],
    },
    {
        "manufacturer": "magene",
        "manufacturerCode": 107,
        "productField": "product",
        "productCode": 0,
        "productName": None,
        "displayName": "Speed Sensor",
        "source": "observed_fit_device_type",
        "roles": ["accessory"],
        "sourceTypes": ["antplus"],
        "sourceTypeCodes": [1],
        "deviceTypes": ["bike_speed"],
        "deviceTypeCodes": [123],
    },
    {
        "manufacturer": "magene",
        "manufacturerCode": 107,
        "productField": "product",
        "productCode": 3,
        "productName": None,
        "displayName": "Speed Sensor",
        "source": "observed_fit_device_type",
        "roles": ["accessory"],
        "sourceTypes": ["antplus"],
        "sourceTypeCodes": [1],
        "deviceTypes": ["bike_speed"],
        "deviceTypeCodes": [123],
    },
    {
        "manufacturer": "magene",
        "manufacturerCode": 107,
        "productField": "product",
        "productCode": 3,
        "productName": None,
        "displayName": "Cadence Sensor",
        "source": "observed_fit_device_type",
        "roles": ["accessory"],
        "sourceTypes": ["antplus"],
        "sourceTypeCodes": [1],
        "deviceTypes": ["bike_cadence"],
        "deviceTypeCodes": [122],
    },
]


def title_token(token: str) -> str:
    lower = token.lower()
    if lower in ACRONYMS:
        return ACRONYMS[lower]
    for prefix in COMPACT_ACRONYM_PREFIXES:
        suffix = lower.removeprefix(prefix)
        if suffix != lower and suffix:
            return f"{ACRONYMS[prefix]}{suffix.upper()}"
    return lower[:1].upper() + lower[1:]


def humanize_identifier(value: str) -> str:
    return " ".join(title_token(part) for part in value.split("_") if part)


def forerunner_label(value: str) -> str | None:
    match = re.match(r"^fr(\d+)(xt|m)?(?:_(.*))?$", value, re.IGNORECASE)
    if not match:
        return None
    model, raw_model_suffix, raw_rest = match.groups()
    model_suffix = ""
    descriptors: list[str] = []
    if (raw_model_suffix or "").lower() == "xt":
        model_suffix += "XT"
    elif (raw_model_suffix or "").lower() == "m":
        descriptors.append("Music")
    for part in [p for p in (raw_rest or "").split("_") if p]:
        lower = part.lower()
        descriptor = None
        if lower in {"small", "s"}:
            model_suffix += "S"
        elif lower == "large":
            pass
        elif lower in {"m", "music"}:
            descriptor = "Music"
        elif lower == "lte":
            descriptor = "LTE"
        elif lower == "asia":
            descriptor = "Asia"
        elif lower == "apac":
            descriptor = "APAC"
        elif lower == "japan":
            descriptor = "Japan"
        elif lower == "korea":
            descriptor = "Korea"
        elif lower == "china":
            descriptor = "China"
        elif lower == "sea":
            descriptor = "SEA"
        else:
            descriptor = humanize_identifier(lower)
        if descriptor and descriptor not in descriptors:
            descriptors.append(descriptor)
    suffix = f" {' '.join(descriptors)}" if descriptors else ""
    return f"Forerunner {model}{model_suffix}{suffix}"


def compact_prefix_label(value: str) -> str | None:
    for prefix, label in sorted(PREFIX_MODEL_LABELS.items(), key=lambda item: len(item[0]), reverse=True):
        match = re.match(rf"^{re.escape(prefix)}(\d+[a-z]?)(?:_(.*))?$", value, re.IGNORECASE)
        if match:
            model, raw_rest = match.groups()
            rest = humanize_identifier(raw_rest) if raw_rest else ""
            model_label = model.upper() if model.endswith("x") else model
            return " ".join(part for part in [label, model_label, rest] if part)
    return None


def display_name(product_name: str) -> str:
    if product_name in EXACT_LABELS:
        return EXACT_LABELS[product_name]
    return forerunner_label(product_name) or compact_prefix_label(product_name) or humanize_identifier(product_name)


def sdk_profile(sdk_zip: Path) -> dict[str, Any]:
    with zipfile.ZipFile(sdk_zip) as archive:
        module_text = archive.read("py/garmin_fit_sdk/profile.py").decode("utf-8")
    namespace: dict[str, Any] = {}
    exec(compile(module_text, "profile.py", "exec"), namespace)
    return namespace["Profile"]


def sdk_entries(profile: dict[str, Any]) -> list[dict[str, Any]]:
    garmin_products = profile["types"]["garmin_product"]
    favero_products = profile["types"].get("favero_product", {})

    entries = [
        {
            "manufacturer": "garmin",
            "manufacturerCode": 1,
            "productField": "garmin_product",
            "productCode": int(raw_code),
            "productName": product_name,
            "displayName": display_name(product_name),
            "source": SOURCE,
        }
        for raw_code, product_name in sorted(garmin_products.items(), key=lambda item: int(item[0]))
    ]

    entries.extend(
        {
            "manufacturer": "favero_electronics",
            "manufacturerCode": 263,
            "productField": "favero_product",
            "productCode": int(raw_code),
            "productName": product_name,
            "displayName": display_name(product_name),
            "source": SOURCE,
        }
        for raw_code, product_name in sorted(favero_products.items(), key=lambda item: int(item[0]))
    )

    return entries


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sdk_zip", type=Path, help="Path to Garmin FIT SDK release zip")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    entries = sdk_entries(sdk_profile(args.sdk_zip))
    entries.extend(OBSERVED_ENTRIES)
    args.output.write_text(json.dumps(entries, indent=2) + "\n")
    print(f"wrote {len(entries)} entries to {args.output}")


if __name__ == "__main__":
    main()
