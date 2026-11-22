// Public lidar-derived terrain services. Each serves bare-earth (trees removed)
// terrain models built from airborne lidar, as map tiles with CORS enabled.

export type LidarStyle = 'hillshade' | 'tinted' | 'slope';

export interface LidarSource {
  id: string;
  name: string;
  resolution: string;
  /** [west, south, east, north] — tiles are only requested inside this box. */
  bounds: [number, number, number, number];
  maxzoom: number;
  attribution: string;
  /** Tile URL per style; a style missing here falls back to hillshade. */
  tiles: Partial<Record<LidarStyle, string>> & { hillshade: string };
}

const usgs = (fn: string) =>
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage' +
  '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png&f=image' +
  '&renderingRule=' +
  encodeURIComponent(JSON.stringify({ rasterFunction: fn }));

const wms = (base: string, layer: string) =>
  `${base}?service=WMS&request=GetMap&version=1.3.0&layers=${encodeURIComponent(layer)}` +
  '&styles=&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=256&height=256&format=image/png&transparent=true';

const UK = 'https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wms';
const NL = 'https://service.pdok.nl/rws/ahn/wms/v1_0';

export const LIDAR_SOURCES: LidarSource[] = [
  {
    id: 'us-3dep',
    name: 'USGS 3DEP',
    resolution: 'up to 1 m',
    bounds: [-180, 13, -64, 72],
    maxzoom: 18,
    attribution: 'Lidar: USGS 3D Elevation Program',
    // Hillshade + height colours are rendered client-side from raw elevation
    // (see dem.ts); only the slope map still comes pre-rendered from USGS.
    tiles: {
      hillshade: usgs('Hillshade Gray'),
      slope: usgs('Slope Map'),
    },
  },
  {
    id: 'uk-ea',
    name: 'Environment Agency (England)',
    resolution: '1 m',
    bounds: [-6.5, 49.8, 2.0, 55.9],
    maxzoom: 18,
    attribution: 'Lidar: © Environment Agency, OGL',
    tiles: {
      hillshade: wms(UK, 'Lidar_Composite_Hillshade_DTM_1m'),
      tinted: wms(UK, 'Lidar_Composite_Elevation_DTM_1m'),
    },
  },
  {
    id: 'nl-ahn',
    name: 'AHN (Netherlands)',
    resolution: '0.5 m',
    bounds: [3.2, 50.7, 7.3, 53.7],
    maxzoom: 19,
    attribution: 'Lidar: AHN / Rijkswaterstaat, PDOK',
    tiles: { hillshade: wms(NL, 'dtm_05m') },
  },
  {
    id: 'fr-ign',
    name: 'IGN LiDAR HD (France)',
    resolution: '0.5 m',
    bounds: [-5.3, 41.3, 9.7, 51.2],
    maxzoom: 18,
    attribution: 'Lidar: © IGN LiDAR HD',
    tiles: {
      hillshade:
        'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
        '&LAYER=IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW&STYLE=normal' +
        '&TILEMATRIXSET=PM_0_18&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png',
    },
  },
  {
    id: 'ch-swisstopo',
    name: 'swissALTI3D (Switzerland)',
    resolution: '0.5 m',
    bounds: [5.9, 45.8, 10.5, 47.9],
    maxzoom: 19,
    attribution: 'Lidar: © swisstopo',
    tiles: {
      hillshade:
        'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissalti3d-reliefschattierung/default/current/3857/{z}/{x}/{y}.png',
    },
  },
  {
    id: 'be-flanders',
    name: 'DHM Vlaanderen II (Flanders, Belgium)',
    resolution: '0.25 m',
    bounds: [2.5, 50.67, 5.95, 51.51],
    maxzoom: 20,
    attribution: 'Lidar: © Digitaal Vlaanderen',
    tiles: { hillshade: wms('https://geo.api.vlaanderen.be/DHMV/wms', 'DHMV_II_HILL_25cm') },
  },
  {
    id: 'de-nrw',
    name: 'DGM1 (North Rhine-Westphalia, Germany)',
    resolution: '1 m',
    bounds: [5.8, 50.3, 9.5, 52.6],
    maxzoom: 19,
    attribution: 'Lidar: © Geobasis NRW',
    tiles: {
      hillshade: wms('https://www.wms.nrw.de/geobasis/wms_nw_dgm-schummerung', 'nw_dgm-schummerung_pan'),
    },
  },
  {
    id: 'no-kartverket',
    name: 'Nasjonal høydemodell (Norway)',
    resolution: '1 m',
    bounds: [4.0, 57.9, 31.5, 71.3],
    maxzoom: 18,
    attribution: 'Lidar: © Kartverket',
    tiles: {
      hillshade: wms('https://wms.geonorge.no/skwms1/wms.hoyde-dtm-nhm-25833', 'NHM_DTM_skyggerelieff_25833'),
    },
  },
  {
    id: 'ca-hrdem',
    name: 'HRDEM (Canada)',
    resolution: '1–2 m',
    bounds: [-141, 41.7, -52.6, 83],
    maxzoom: 17,
    attribution: 'Lidar: © NRCan HRDEM',
    tiles: {
      hillshade: wms('https://datacube.services.geo.ca/wrapper/ogc/elevation-hrdem-mosaic', 'dtm-hillshade'),
      slope: wms('https://datacube.services.geo.ca/wrapper/ogc/elevation-hrdem-mosaic', 'dtm-slope'),
    },
  },
];

/** Where the 3DEP index says 1 m lidar DEMs exist (layer 1 = "1 meter"). */
export const US_COVERAGE_TILES =
  'https://index.nationalmap.gov/arcgis/rest/services/3DEPElevationIndex/MapServer/export' +
  '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true' +
  '&layers=show:1&f=image';

export const US_COVERAGE_QUERY =
  'https://index.nationalmap.gov/arcgis/rest/services/3DEPElevationIndex/MapServer/1/query';

export interface Preset {
  name: string;
  note: string;
  lng: number;
  lat: number;
  zoom: number;
}

export const PRESETS: Preset[] = [
  { name: 'Cahokia Mounds', note: 'Illinois · Mississippian city', lng: -90.0622, lat: 38.6603, zoom: 16 },
  { name: 'Serpent Mound', note: 'Ohio · effigy earthwork', lng: -83.4305, lat: 39.0253, zoom: 17.5 },
  { name: 'Poverty Point', note: 'Louisiana · 3,400-yr-old ridges', lng: -91.4072, lat: 32.6362, zoom: 15.5 },
  { name: 'Mount St. Helens', note: 'Washington · crater & lahars', lng: -122.1944, lat: 46.1912, zoom: 13 },
  { name: 'Avebury', note: 'England · henge & barrows', lng: -1.8544, lat: 51.4286, zoom: 15.5 },
  { name: 'Maiden Castle', note: 'England · Iron Age hillfort', lng: -2.4696, lat: 50.6947, zoom: 15.5 },
  { name: 'Bourtange', note: 'Netherlands · star fort', lng: 7.1919, lat: 53.0067, zoom: 16 },
  { name: 'Gergovie', note: 'France · Gallic oppidum', lng: 3.1225, lat: 45.7097, zoom: 16 },
];
