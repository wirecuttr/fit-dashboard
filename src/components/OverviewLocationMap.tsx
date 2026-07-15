import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import maplibregl, { type StyleSpecification } from "maplibre-gl";
import type { RecordPoint } from "../types";
import type { MapStyle } from "../stores/settingsStore";
import { useTranslation } from "../lib/i18n";
import { IconZoomOut } from "./Icons";

type Props = {
  records: RecordPoint[];
  mapStyle: MapStyle;
  setMapStyle: (style: MapStyle) => void;
};

type BaseMapInfo = { labelKey: string; tileUrl: string; attribution: string };

const BASEMAPS: Record<MapStyle, BaseMapInfo> = {
  light: {
    labelKey: "settings.mapLight",
    tileUrl: "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    attribution: "(c) OpenStreetMap contributors (c) CARTO",
  },
  openstreet: {
    labelKey: "settings.mapOpenStreet",
    tileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "(c) OpenStreetMap contributors",
  },
  topo: {
    labelKey: "settings.mapTopo",
    tileUrl: "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
    attribution: "(c) OpenStreetMap contributors, SRTM | OpenTopoMap",
  },
  satellite: {
    labelKey: "settings.mapSatellite",
    tileUrl: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles (c) Esri, Maxar, Earthstar Geographics",
  },
  dark: {
    labelKey: "settings.mapDark",
    tileUrl: "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    attribution: "(c) OpenStreetMap contributors (c) CARTO",
  },
};

function styleFromMap(ms: MapStyle): StyleSpecification {
  const s = BASEMAPS[ms];
  return {
    version: 8,
    sources: {
      basemap: {
        type: "raster",
        tiles: [s.tileUrl],
        tileSize: 256,
        attribution: s.attribution,
      },
    },
    layers: [{ id: "basemap", type: "raster", source: "basemap" }],
  };
}

const HEAT_SOURCE_ID = "overview-heat-source";
const CLUSTER_SOURCE_ID = "overview-cluster-source";
const HEAT_LAYER_ID = "overview-heat-layer";
const CLUSTER_LAYER_ID = "overview-cluster-layer";
const CLUSTER_LABEL_LAYER_ID = "overview-cluster-label-layer";
const POINT_LAYER_ID = "overview-point-layer";

export function OverviewLocationMap({ records, mapStyle, setMapStyle }: Props) {
  const mapRef = useRef<maplibregl.Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const [resetZoomControlPortal, setResetZoomControlPortal] = useState<HTMLDivElement | null>(null);
  const { t } = useTranslation();

  const geojson = useMemo<GeoJSON.FeatureCollection<GeoJSON.Point>>(() => {
    const features: GeoJSON.Feature<GeoJSON.Point>[] = records
      .filter((r) => typeof r.latitude === "number" && typeof r.longitude === "number")
      .map((r) => ({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [r.longitude as number, r.latitude as number],
        },
        properties: {},
      }));
    return { type: "FeatureCollection", features };
  }, [records]);
  const hasLocations = geojson.features.length > 0;

  function fitToData(map: maplibregl.Map) {
    if (!geojson.features.length) return;
    const first = geojson.features[0].geometry.coordinates;
    const bounds = geojson.features.reduce(
      (b, f) => b.extend(f.geometry.coordinates as [number, number]),
      new maplibregl.LngLatBounds(first as [number, number], first as [number, number])
    );
    map.fitBounds(bounds, { padding: 48, maxZoom: 13, duration: 650 });
  }

  function ensureSourcesAndLayers(map: maplibregl.Map) {
    const heatSrc = map.getSource(HEAT_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    const clusterSrc = map.getSource(CLUSTER_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;

    if (heatSrc) {
      heatSrc.setData(geojson);
    } else {
      map.addSource(HEAT_SOURCE_ID, { type: "geojson", data: geojson });
    }

    if (clusterSrc) {
      clusterSrc.setData(geojson);
    } else {
      map.addSource(CLUSTER_SOURCE_ID, {
        type: "geojson",
        data: geojson,
        cluster: true,
        clusterRadius: 38,
        clusterMaxZoom: 11,
      });
    }

    if (!map.getLayer(HEAT_LAYER_ID)) {
      map.addLayer({
        id: HEAT_LAYER_ID,
        type: "heatmap",
        source: HEAT_SOURCE_ID,
        maxzoom: 11,
        paint: {
          "heatmap-weight": 1,
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 0.45, 11, 1.1],
          "heatmap-color": [
            "interpolate",
            ["linear"],
            ["heatmap-density"],
            0,
            "rgba(0,0,0,0)",
            0.2,
            "rgba(56, 189, 248, 0.12)",
            0.45,
            "rgba(14, 165, 233, 0.2)",
            0.7,
            "rgba(6, 182, 212, 0.3)",
            1,
            "rgba(8, 145, 178, 0.4)",
          ],
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 4, 11, 14],
          "heatmap-opacity": 0.7,
        },
      });
    }

    if (!map.getLayer(CLUSTER_LAYER_ID)) {
      map.addLayer({
        id: CLUSTER_LAYER_ID,
        type: "circle",
        source: CLUSTER_SOURCE_ID,
        maxzoom: 11,
        filter: ["has", "point_count"],
        paint: {
          "circle-color": [
            "interpolate",
            ["linear"],
            ["coalesce", ["ln", ["+", ["get", "point_count"], 1]], 0],
            0,
            "rgba(192, 38, 211, 0.72)",
            2,
            "rgba(168, 85, 247, 0.80)",
            4,
            "rgba(147, 51, 234, 0.88)",
          ],
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            0,
            ["step", ["get", "point_count"], 4, 25, 5, 80, 7.2],
            11,
            ["step", ["get", "point_count"], 6, 25, 7.5, 80, 10.8],
          ],
          "circle-opacity": 0.84,
          "circle-blur": 0.45,
          "circle-stroke-width": 0.6,
          "circle-stroke-color": "rgba(255,255,255,0.58)",
        },
      });
    }

    if (!map.getLayer(CLUSTER_LABEL_LAYER_ID)) {
      map.addLayer({
        id: CLUSTER_LABEL_LAYER_ID,
        type: "symbol",
        source: CLUSTER_SOURCE_ID,
        maxzoom: 11,
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-size": 11,
          "text-font": ["Open Sans Bold"],
        },
        paint: {
          "text-color": "#ffffff",
        },
      });
    }

    if (!map.getLayer(POINT_LAYER_ID)) {
      map.addLayer({
        id: POINT_LAYER_ID,
        type: "circle",
        source: CLUSTER_SOURCE_ID,
        minzoom: 10,
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2, 16, 6],
          "circle-color": "#c026d3",
          "circle-opacity": 0.35,
        },
      });
    }
  }

  useEffect(() => {
    if (!hasLocations || !mapContainerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: styleFromMap(mapStyle),
      center: [0, 0],
      zoom: 2,
      minZoom: 2,
      cooperativeGestures: true,
    });
    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

    const resetZoomControlElement = document.createElement("div");
    resetZoomControlElement.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const resetZoomControl: maplibregl.IControl = {
      onAdd: () => {
        setResetZoomControlPortal(resetZoomControlElement);
        return resetZoomControlElement;
      },
      onRemove: () => {
        resetZoomControlElement.remove();
      },
    };
    map.addControl(resetZoomControl, "top-right");

    map.on("load", () => {
      ensureSourcesAndLayers(map);
      fitToData(map);
    });

    map.on("click", CLUSTER_LAYER_ID, (e) => {
      const feature = e.features?.[0];
      if (!feature) return;
      const clusterId = feature.properties?.cluster_id;
      const source = map.getSource(CLUSTER_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      if (!source || clusterId == null) return;
      void source.getClusterExpansionZoom(clusterId)
        .then((zoom) => {
          map.easeTo({ center: (feature.geometry as GeoJSON.Point).coordinates as [number, number], zoom, duration: 450 });
        })
        .catch(() => {
          // Ignore expansion errors for stale cluster ids.
        });
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [hasLocations]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !hasLocations) return;

    map.setStyle(styleFromMap(mapStyle));
    const onIdle = () => {
      map.off("idle", onIdle);
      ensureSourcesAndLayers(map);
    };
    map.on("idle", onIdle);

    return () => {
      map.off("idle", onIdle);
    };
  }, [mapStyle, hasLocations]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !hasLocations) return;

    if (map.isStyleLoaded()) {
      ensureSourcesAndLayers(map);
    } else {
      const onIdle = () => {
        map.off("idle", onIdle);
        ensureSourcesAndLayers(map);
      };
      map.on("idle", onIdle);
      return () => {
        map.off("idle", onIdle);
      };
    }
  }, [geojson, hasLocations]);

  useEffect(() => {
    if (hasLocations || !mapRef.current) return;
    mapRef.current.remove();
    mapRef.current = null;
  }, [hasLocations]);

  if (!hasLocations) return null;

  return (
    <div className="panel overview-location-panel">
      <div className="map-header" style={{ marginBottom: "0.6rem" }}>
        <div>
          <h3 style={{ marginBottom: "0.32rem" }}>{t("map.exploredLocations")}</h3>
          <p className="panel-subtitle">{t("map.subtitle")}</p>
        </div>
        <div className="map-controls">
          <label className="map-control">
            <span className="small">{t("map.style")}</span>
            <select value={mapStyle} onChange={(e) => setMapStyle(e.target.value as MapStyle)}>
              {Object.entries(BASEMAPS).map(([value, info]) => (
                <option key={value} value={value}>{t(info.labelKey)}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="overview-map-canvas" ref={mapContainerRef} />
      {resetZoomControlPortal && createPortal(
        <button
          type="button"
          className="map-reset-zoom-control"
          title={t("map.resetZoom")}
          aria-label={t("map.resetZoom")}
          onClick={() => {
            const map = mapRef.current;
            if (map) fitToData(map);
          }}
        >
          <IconZoomOut aria-hidden="true" focusable="false" />
        </button>,
        resetZoomControlPortal,
      )}
    </div>
  );
}
