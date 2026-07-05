# Device Product Display Lookup

## Problem

Device manufacturers regularly add devices before downstream FIT parser
dependencies have updated generated product enums. FIT files still contain raw
manufacturer, product field, product code, source type, and device type values,
but the app can only show a friendly device name when those values can be
resolved consistently.

Example:

- `23411360356_ACTIVITY.fit` stores Garmin product code `4440`.
- The app's current `fitparser` profile does not know that code, so import
  stores `product.code = 4440`, `product.name = null`, and `product.label =
  null`.
- Garmin's current FIT SDK maps `4440` to `edge_1050`.
- The app therefore displays `Garmin Product 4440` even though the raw data is
  enough to identify the device as a Garmin Edge 1050 once the newer lookup is
  known.

This is not a parsing failure. It is a stale or incomplete product-name lookup.

## Goals

- Preserve raw FIT device identity exactly as imported.
- Improve display names for known product codes without requiring users to
  reimport activities.
- Use the same display resolver in the activity list, Individual activity
  header, accessory list, and JSON export display blocks.
- Keep product-name updates small, reviewable, and independent of FIT parser
  dependency updates.
- Support both exact SDK-derived product mappings and constrained observed
  mappings where product code alone is ambiguous.
- Continue to benefit automatically when the parser dependency eventually gains
  newer SDK mappings.

## Non-Goals

- Do not replace the FIT parser solely to gain one new product name.
- Do not require a database migration for display-only product-name fixes.
- Do not overwrite user data or raw imported metadata with app display labels.
- Do not use serial numbers to identify public product models.

## Branch Base

This implementation branch is intentionally stacked on
`feature/fit-device-accessories`, because the product lookup extends that
branch's shared device metadata/display resolver. Until that work lands
upstream, any pull request for this lookup should either target the accessories
branch or wait and then be rebased onto fresh `upstream/main`.

## Current Behaviour

On upstream `main`, device handling is still mostly a single activity-level
string:

- the backend picks one resolved `device` string during import
- `metadata_json` contains limited `file_id` and `device_info` fields
- the Individual activity header still falls back to showing `SN <serial>`
- the left-side activity list does not yet render the same device display label
- JSON export includes `activity.device`, but not a richer raw/display device
  block

That means this lookup should not be implemented as another import-time string
substitution on plain upstream `main`. Doing that would bake a display decision
into `activity.device`, require reimport for some rows, and not solve accessory
or export consistency.

The intended baseline is the device metadata/display work that stores useful raw
device metadata in `metadata_json`, including:

- manufacturer code and name
- product field, such as `garmin_product`
- product code
- parser-derived product name and label, when available
- role, source type, serial number, software version, hardware version, and
  accessory identifiers

The display layer then formats this metadata. For known parser values such as
`edge_1040`, the display label can be `Garmin Edge 1040`. For unknown product
codes, the current fallback is `Garmin Product <code>`.

The current display resolver previously had a small number of contextual
substitutions for devices such as Varia RTL515 and HRM 200. Those substitutions
are useful, but hardcoding them in resolver logic does not scale well as new
manufacturers and ambiguous accessory records appear.

## Implementation Readiness

This feature is implementation-ready on this stacked branch because it is now
based on `feature/fit-device-accessories`. It is still not ready to implement
directly on plain upstream `main` unless the accessories work has landed there.

The standalone implementation path available on upstream `main` would be an
import-time fallback in the Rust parser, which conflicts with the goal of
display-only updates that apply to existing imported activities.

## Proposed Design

Add a shared supplemental product lookup used by the display resolver.

Use a tracked data file from the start, so new product mappings are data-only
changes where possible. A suitable first location is:

```text
src/data/deviceProductLookup.json
```

The lookup should be keyed by manufacturer and product field/code, with optional
constraints for ambiguous observed cases. Exact SDK-derived mappings need only
the manufacturer/product identity:

```json
[
  {
    "manufacturer": "garmin",
    "manufacturerCode": 1,
    "productField": "garmin_product",
    "productCode": 4440,
    "productName": "edge_1050",
    "displayName": "Edge 1050",
    "source": "garmin_fit_sdk_21_188"
  },
  {
    "manufacturer": "magene",
    "manufacturerCode": 107,
    "productField": "product",
    "productCode": 3,
    "productName": null,
    "displayName": "Speed Sensor",
    "source": "observed_fit_device_type",
    "roles": ["accessory"],
    "sourceTypes": ["antplus"],
    "sourceTypeCodes": [1],
    "deviceTypes": ["bike_speed"],
    "deviceTypeCodes": [123]
  }
]
```

The display resolver should use this fallback order:

1. Constrained supplemental lookup entries for known ambiguous accessory cases,
   such as Magene product `3` as speed vs cadence and Garmin `OHR` as HRM 200.
2. Product label already decoded by the parser.
3. Product name already decoded by the parser, humanised by the app.
4. Unconstrained supplemental product lookup entries, such as Garmin Edge 1050
   or Favero Assioma Duo.
5. Device type label, such as `Bike Radar`, `Heart Rate`, or `Speed Sensor`.
6. Raw product-code fallback, such as `Garmin Product 4440`.
7. Generic `Device`.

The resolver should live in one shared frontend/export path so display output is
consistent across:

- left-side activity list
- Individual activity header badge
- accessory hover/list display
- JSON export `display` blocks

Backend import can continue to store parser-derived labels when available, but
frontend/export display should not depend on the backend having the newest
Garmin product table.

## Lookup Population

Populate exact supplemental lookup entries from official FIT SDK product tables
where available. The initial generated table is from Garmin FIT SDK 21.188 and
contains all 474 `garmin_product` enum entries from that SDK release. It also
includes the two Favero `favero_product` entries from the same SDK.

Refresh the generated table with:

```bash
python3 scripts/generate_device_product_lookup.py /path/to/FitSDKRelease.zip
```

Observed device-type mappings are added manually only when the raw product code
alone is ambiguous or not present in the SDK table. These entries must include
constraints such as source type and device type so the resolver does not pretend
the product code alone identifies a public model.

The lookup includes, among others:

| Manufacturer | Manufacturer code | Product field | Product code | Product name | Display name | Source |
| --- | ---: | --- | ---: | --- | --- | --- |
| Garmin | `1` | `garmin_product` | `3992` | `fr255` | `Forerunner 255` | Garmin FIT SDK 21.188 |
| Garmin | `1` | `garmin_product` | `3843` | `edge_1040` | `Edge 1040` | Garmin FIT SDK 21.188 |
| Garmin | `1` | `garmin_product` | `4440` | `edge_1050` | `Edge 1050` | Garmin FIT SDK 21.188 |
| Garmin | `1` | `garmin_product` | `4606` | `hrm_200` | `HRM 200` | Garmin FIT SDK 21.188 |
| Garmin | `1` | `garmin_product` | `255` | `hrm_200` | `HRM 200` | observed FIT device type |
| Garmin | `1` | `garmin_product` | `3592` | `varia_rtl515` | `Varia RTL515` | observed FIT device type |
| Favero | `263` | `favero_product` | `12` | `assioma_duo` | `Assioma Duo` | Garmin FIT SDK 21.188 |
| Magene | `107` | `product` | `3` | `null` | `Speed Sensor` | observed FIT device type |
| Magene | `107` | `product` | `3` | `null` | `Cadence Sensor` | observed FIT device type |

This makes existing imports of `23411360356_ACTIVITY.fit` display as
`Garmin Edge 1050` without reimport. The full table also covers future stale
parser cases where the raw Garmin product code is known by the SDK but not by
the parser dependency bundled with the app.

Some product codes observed in FIT files, such as Garmin code `3592` for Varia
RTL515 records, are not present in Garmin FIT SDK 21.188. Others, such as Garmin
code `255` / `OHR`, are too generic to identify an accessory model without
source and device-type context. Those are represented as constrained observed
lookup rows based on device type and source metadata.

The initial lookup contains 481 rows: 474 Garmin SDK rows, two Favero SDK rows,
and five constrained observed rows.

## Data Model Impact

No database schema change is required for display-only lookup additions.

Existing imported activities already retain the raw product code. When the
display resolver gains a new supplemental mapping, existing rows can render the
new label immediately.

Future parser dependency updates may populate `product.name` at import time for
new files. That is acceptable and should take precedence over the supplemental
lookup. The supplemental lookup remains useful for older imports and for product
codes not yet covered by the dependency.

## Maintenance Workflow

When unknown products appear in the UI or exports:

1. Confirm the raw FIT device metadata:
   - manufacturer
   - product field
   - product code
   - role
   - source type
   - device type
   - software version
2. Check the current FIT SDK product table or another reliable manufacturer
   source.
3. If the mapping is confirmed in a newer SDK, refresh or add the exact
   supplemental lookup entry and keep the source value current.
4. If the mapping is only observed contextually, add constraints such as source
   type and device type rather than using a product-code-only entry.
5. Add or update resolver tests for the new code.
6. Verify the activity list, Individual header, accessory display, and JSON
   export display output.

If the current product source does not identify the code, leave the raw
fallback in place and use the audit output to review later.

## Testing

Focused tests should cover:

- decoded parser product names still win over unconstrained supplemental mappings
- Garmin product code `4440` displays as `Garmin Edge 1050`
- Garmin product code `3992` displays as `Garmin Forerunner 255`
- Garmin product code `4606` displays as `Garmin HRM 200`
- constrained entries display Garmin Varia RTL515, Garmin HRM 200, Magene Speed
  Sensor, and Magene Cadence Sensor without hardcoded resolver substitutions
- unknown products still fall back to `Garmin Product <code>`
- export display output uses the same resolver as the UI

Manual validation should include an existing import of
`23411360356_ACTIVITY.fit` to confirm no reimport is needed.

## Open Questions

- Should the unknown-device audit script be formalised as a tracked developer
  utility?
- Should app exports include both raw product identity and the display lookup
  source for easier debugging?
