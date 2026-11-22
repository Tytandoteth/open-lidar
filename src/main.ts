import * as maplibregl from 'maplibre-gl';
import type {
  StyleSpecification,
  LayerSpecification,
  ExpressionSpecification,
  RasterDEMSourceSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

// MapLibre finds its worker next to its own file, which breaks once bundled.
// Ship the worker as a static asset and point at it explicitly.
maplibregl.setWorkerUrl(workerUrl);
import './style.css';
import { DEM_PROVIDERS, DEM_TILE, MH_MAXZOOM, NODATA, hasDataAt, onProgress, viewRange, type DemKind, type DemProvider } from './dem';
import {
  LIDAR_SOURCES,
  PRESETS,
  US_COVERAGE_QUERY,
  US_COVERAGE_TILES,
  type LidarStyle,
  type Preset,
} from './sources';
import { parseCoords, searchPlaces, type Place } from './search';
import { addSites, searchSites, setSiteKinds, setSitesVisible, type SiteKind } from './sites';

import { featuredId, readView, type Mode } from './view';
const STYLES: LidarStyle[] = ['hillshade', 'tinted', 'slope'];

const IMAGERY =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const IMAGERY_CREDIT = 'Imagery © Esri, Maxar, Earthstar Geographics';
const LABELS =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';

const US = LIDAR_SOURCES[0];
// Server-rendered sources replaced by client-side raw elevation (dem.ts),
// except for their slope maps. England, NRW and Norway come from Mapterhorn's
// pre-built 1 m tiles (the same national lidar), which load far faster.
const CLIENT_SIDE = new Set(['us-3dep', 'nl-ahn', 'fr-ign', 'ca-hrdem', 'uk-ea', 'de-nrw', 'no-kartverket']);

// Colour ramp for height, low → high (perceptually ordered, like a lidar viewer).
const RAMP = ['#2a186c', '#2e5fa8', '#1f9e9a', '#55c667', '#c6dc3a', '#f6b73c', '#f0702c', '#c4282a', '#fde9e3'];

// ---------- styles ----------

function satelliteStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      imagery: {
        type: 'raster',
        tiles: [IMAGERY],
        tileSize: 256,
        maxzoom: 19,
        attribution: IMAGERY_CREDIT,
      },
      labels: { type: 'raster', tiles: [LABELS], tileSize: 256, maxzoom: 19 },
    },
    layers: [
      { id: 'imagery', type: 'raster', source: 'imagery' },
      { id: 'labels', type: 'raster', source: 'labels' },
    ],
  };
}

function reliefColor(lo: number, hi: number): ExpressionSpecification {
  const stops: (number | string)[] = [NODATA, 'rgba(0,0,0,0)', NODATA + 1, RAMP[0]];
  // Everything below lo clamps to the first colour; ramp spans lo…hi.
  const first = Math.max(lo, NODATA + 2);
  RAMP.forEach((c, i) => stops.push(first + ((hi - first) * i) / (RAMP.length - 1), c));
  return ['interpolate', ['linear'], ['elevation'], ...stops] as ExpressionSpecification;
}

/** Worldwide terrain from Mapterhorn's CDN — 1 m lidar in many countries, 30 m elsewhere. */
const globalDem = (): RasterDEMSourceSpecification =>
  ({
    type: 'raster-dem',
    tiles: ['mh://{z}/{x}/{y}'],
    encoding: 'terrarium',
    tileSize: DEM_TILE,
    maxzoom: MH_MAXZOOM,
    attribution: '<a href="https://mapterhorn.com/attribution" target="_blank">© Mapterhorn</a>',
  });

/** Raw lidar elevation decoded in the browser (dem.ts). */
const demSource = (p: DemProvider, kind: DemKind): RasterDEMSourceSpecification =>
  ({
    type: 'raster-dem',
    tiles: [`dem://${p.id}/${kind}/{z}/{x}/{y}`],
    encoding: 'terrarium',
    tileSize: DEM_TILE,
    minzoom: p.minzoom,
    maxzoom: p.maxzoom,
    bounds: p.bounds,
    attribution: p.attribution,
  });

/** Satellite for swipe mode, draped over the *surface* model (buildings, trees) in 3D. */
function overlayStyle(): StyleSpecification {
  const style = satelliteStyle();
  style.sources.dem = globalDem();
  for (const p of DEM_PROVIDERS) style.sources[`dem-${p.id}-surface`] = demSource(p, p.hasDsm ? 'dsm' : 'dtm');
  return style;
}

function mainStyle(): StyleSpecification {
  const style = satelliteStyle();
  // Global terrain (lidar in many countries via Mapterhorn, ~30 m elsewhere).
  style.sources.dem = globalDem();
  // Bare-earth lidar per provider. Two sources with the same tiles: MapLibre
  // wants terrain separate from the hillshade source; dem.ts dedupes downloads.
  for (const p of DEM_PROVIDERS) {
    style.sources[`dem-${p.id}`] = demSource(p, 'dtm');
    style.sources[`dem-${p.id}-terrain`] = demSource(p, 'dtm');
  }
  style.sources.coverage = {
    type: 'raster',
    tiles: [`retry://${US_COVERAGE_TILES}`],
    tileSize: 256,
    bounds: US.bounds,
    attribution: 'Coverage: USGS 3DEP index',
  };

  const lidarLayers: LayerSpecification[] = [
    { id: 'lidar-bg', type: 'background', paint: { 'background-color': '#8c8f96' } },
    {
      id: 'global-relief',
      type: 'color-relief',
      source: 'dem',
      layout: { visibility: 'none' },
      paint: { 'color-relief-color': reliefColor(0, 100) },
    },
    { id: 'global-hillshade', type: 'hillshade', source: 'dem', paint: { 'hillshade-method': 'multidirectional' } },
  ];

  // Server-rendered lidar (England, Switzerland, …, plus US/Canada slope).
  for (const src of LIDAR_SOURCES) {
    for (const s of STYLES) {
      const url = src.tiles[s];
      if (!url || (CLIENT_SIDE.has(src.id) && s !== 'slope')) continue;
      const id = `${src.id}-${s}`;
      style.sources[id] = {
        type: 'raster',
        tiles: [`retry://${url}`],
        tileSize: 256,
        bounds: src.bounds,
        maxzoom: src.maxzoom,
        attribution: src.attribution,
      };
      lidarLayers.push({
        id,
        type: 'raster',
        source: id,
        minzoom: 7,
        layout: { visibility: 'none' },
        // A touch more contrast makes subtle earthworks pop on these hillshades.
        paint: { 'raster-contrast': s === 'hillshade' ? 0.25 : 0, 'raster-fade-duration': 150 },
      });
    }
  }

  // Client-side lidar: colour relief underneath, hillshade on top.
  for (const p of DEM_PROVIDERS) {
    lidarLayers.push(
      {
        id: `${p.id}-relief`,
        type: 'color-relief',
        source: `dem-${p.id}`,
        layout: { visibility: 'none' },
        paint: { 'color-relief-color': reliefColor(0, 100) },
      },
      {
        id: `${p.id}-hillshade`,
        type: 'hillshade',
        source: `dem-${p.id}`,
        layout: { visibility: 'none' },
        paint: { 'hillshade-method': 'multidirectional' },
      },
    );
  }
  lidarLayers.push(
    {
      id: 'coverage',
      type: 'raster',
      source: 'coverage',
      paint: { 'raster-opacity': 0.45 },
      layout: { visibility: 'none' },
    },
  );

  // Lidar stack sits above imagery and below labels.
  style.layers.splice(1, 0, ...lidarLayers);
  return style;
}

// ---------- maps ----------

const initial = readView(new URL(location.href));
let featured = initial.preset ?? (!initial.camera && !location.hash ? PRESETS[0] : undefined);
const start = featured ?? PRESETS[0];
const map = new maplibregl.Map({
  container: 'map',
  style: mainStyle(),
  center: [start.lng, start.lat],
  zoom: start.zoom,
  hash: true,
  maxPitch: 80,
  // Keep more decoded lidar tiles around so panning back is instant.
  maxTileCacheZoomLevels: 6,
  attributionControl: { compact: true, customAttribution: IMAGERY_CREDIT },
});
if (initial.camera) map.jumpTo(initial.camera);
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
map.addControl(new maplibregl.GeolocateControl({}), 'bottom-right');

// Satellite copy that sits on top during swipe mode, clipped to the left of the handle.
// pointer-events: none, so every gesture still reaches the main map.
let overlayReady = false;
const overlay = new maplibregl.Map({
  container: 'sat-overlay',
  style: overlayStyle(),
  center: map.getCenter(),
  zoom: map.getZoom(),
  interactive: false,
  attributionControl: false,
});

// ---------- state ----------

const state = {
  mode: initial.mode,
  style: initial.style,
  labels: initial.labels,
  coverage: initial.coverage,
  terrain: initial.terrain,
  swipePct: initial.swipePct,
  depth: initial.depth,
  sun: initial.sun,
};

const syncOverlay = () => {
  if (state.mode !== 'swipe') return;
  overlay.jumpTo({
    center: map.getCenter(),
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
    roll: map.getRoll(),
  });
};
map.on('move', syncOverlay);

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

function setVis(id: string, on: boolean) {
  if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
}

function applyLayers() {
  const lidarOn = state.mode !== 'satellite';
  setVis('imagery', !lidarOn);
  setVis('lidar-bg', lidarOn);
  setVis('global-relief', lidarOn && state.style === 'tinted');
  setVis('global-hillshade', lidarOn);
  for (const src of LIDAR_SOURCES) {
    const chosen: LidarStyle = src.tiles[state.style] ? state.style : 'hillshade';
    for (const s of STYLES) setVis(`${src.id}-${s}`, lidarOn && s === chosen);
  }
  for (const p of DEM_PROVIDERS) {
    setVis(`${p.id}-relief`, lidarOn && state.style === 'tinted');
    // Slope comes pre-rendered from USGS/NRCan; elsewhere keep the hillshade.
    const hasSlope = LIDAR_SOURCES.some((s) => CLIENT_SIDE.has(s.id) && s.id.startsWith(p.id) && s.tiles.slope);
    setVis(`${p.id}-hillshade`, lidarOn && (state.style !== 'slope' || !hasSlope));
  }
  setVis('coverage', state.coverage);
  setVis('labels', state.labels);
  if (overlay.getLayer('labels')) {
    overlay.setLayoutProperty('labels', 'visibility', state.labels ? 'visible' : 'none');
  }
  $('#legend').hidden = !(lidarOn && state.style === 'tinted');
  applyShading();
  updateRelief();
}

/** Hillshade strength + light direction from the sliders. */
function applyShading() {
  if (!map.getLayer('us-hillshade')) return;
  for (const p of DEM_PROVIDERS) shadeLayer(`${p.id}-hillshade`);
  shadeLayer('global-hillshade');
  if (state.terrain) applyTerrainSources();
}

function shadeLayer(id: string) {
  const d = state.depth;
  const tinted = state.style === 'tinted';
  // Four lights fanned around the sun angle: multidirectional shading keeps
  // features visible whatever direction they face (ridges *and* ditches).
  const dirs = [0, 60, -60, 180].map((o) => (state.sun + o + 360) % 360);
  const alpha = (a: number) => Math.min(1, a * (0.35 + d));
  map.setPaintProperty(id, 'hillshade-illumination-direction', dirs);
  map.setPaintProperty(id, 'hillshade-illumination-altitude', [30, 35, 35, 60]);
  map.setPaintProperty(id, 'hillshade-exaggeration', 0.25 + d * 0.75);
  map.setPaintProperty(
    id,
    'hillshade-shadow-color',
    tinted
      ? [`rgba(0,0,0,${alpha(0.85)})`, `rgba(0,0,0,${alpha(0.45)})`, `rgba(0,0,0,${alpha(0.45)})`, `rgba(0,0,0,${alpha(0.2)})`]
      : ['#000000', `rgba(0,0,0,${alpha(0.5)})`, `rgba(0,0,0,${alpha(0.5)})`, `rgba(0,0,0,${alpha(0.25)})`],
  );
  map.setPaintProperty(
    id,
    'hillshade-highlight-color',
    tinted
      ? [`rgba(255,255,255,${alpha(0.55)})`, `rgba(255,255,255,${alpha(0.15)})`, `rgba(255,255,255,${alpha(0.15)})`, 'rgba(255,255,255,0)']
      : ['#ffffff', `rgba(255,255,255,${alpha(0.4)})`, `rgba(255,255,255,${alpha(0.4)})`, 'rgba(255,255,255,0)'],
  );
}

/** Stretch the height colours across what's in view — like the article's lidar. */
let lastRange = '';
function updateRelief() {
  if (state.style !== 'tinted' || state.mode === 'satellite' || !map.getLayer('us-relief')) return;
  const r = viewRange(map.getBounds(), map.getZoom());
  if (!r) return;
  const key = `${r.lo.toFixed(1)}/${r.hi.toFixed(1)}`;
  if (key === lastRange) return;
  lastRange = key;
  for (const id of ['global', ...DEM_PROVIDERS.map((p) => p.id)]) {
    map.setPaintProperty(`${id}-relief`, 'color-relief-color', reliefColor(r.lo, r.hi));
  }
  $('#lg-lo').textContent = `${Math.round(r.lo)} m`;
  $('#lg-hi').textContent = `${Math.round(r.hi)} m`;
}
map.on('idle', updateRelief);
map.on('moveend', updateRelief);
map.on('sourcedata', (e) => {
  if (e.sourceId.startsWith('dem') && e.tile) updateRelief();
});

function applyMode() {
  document.querySelectorAll<HTMLButtonElement>('.modes button').forEach((b) => {
    const active = b.dataset.mode === state.mode;
    b.classList.toggle('on', active);
    b.setAttribute('aria-pressed', String(active));
  });
  const swipe = state.mode === 'swipe';
  $('#swipe').hidden = !swipe;
  $('#sat-overlay').classList.toggle('show', swipe);
  if (swipe) {
    overlay.resize();
    syncOverlay();
  }
  if (state.terrain) applyTerrainSources();
  applySwipe();
  applyLayers();
}

function applySwipe() {
  const pct = state.swipePct;
  $('#sat-overlay').style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
  $('#swipe').style.setProperty('--pos', `${pct}%`);
  $('.swipe-knob').setAttribute('aria-valuenow', String(Math.round(pct)));
  $('.swipe-knob').setAttribute('aria-valuetext', `${Math.round(pct)}% satellite`);
}

const inside = (b: [number, number, number, number], lng: number, lat: number) =>
  lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];

/**
 * Which lidar provider to use for 3D at the map centre. Bounding boxes overlap
 * (US/Canada), so prefer one whose loaded tiles actually have data here.
 */
function terrainProvider(): DemProvider | null {
  const { lng, lat } = map.getCenter();
  const candidates = DEM_PROVIDERS.filter(
    (p) => inside(p.bounds, lng, lat) && !p.skip?.(lng, lat, lng, lat) && map.getZoom() >= p.minzoom - 1,
  );
  return candidates.find((p) => hasDataAt(p.id, lng, lat)) ?? candidates[0] ?? null;
}

/**
 * Main map: bare earth (lidar). Swipe overlay: the surface model — buildings
 * and trees standing up under the satellite photo — where the country publishes one.
 */
function applyTerrainSources() {
  const exaggeration = 1 + state.depth * 2;
  const p = terrainProvider();
  const want = p ? `dem-${p.id}-terrain` : 'dem';
  if (map.getTerrain()?.source !== want || map.getTerrain()?.exaggeration !== exaggeration) {
    map.setTerrain({ source: want, exaggeration });
  }
  if (!overlayReady) return;
  if (state.mode === 'swipe') {
    const ow = p ? `dem-${p.id}-surface` : 'dem';
    if (overlay.getTerrain()?.source !== ow || overlay.getTerrain()?.exaggeration !== exaggeration) {
      overlay.setTerrain({ source: ow, exaggeration });
    }
  } else if (overlay.getTerrain()) {
    overlay.setTerrain(null);
  }
}

function applyTerrain() {
  if (state.terrain) {
    applyTerrainSources();
    if (map.getPitch() < 30) map.easeTo({ pitch: 60, duration: 800 });
  } else {
    map.setTerrain(null);
    overlay.setTerrain(null);
    map.easeTo({ pitch: 0, duration: 600 });
  }
}
map.on('moveend', () => state.terrain && applyTerrainSources());
map.on('idle', () => state.terrain && applyTerrainSources());

// ---------- "Here" status: which lidar covers the map centre ----------

let statusAbort: AbortController | null = null;
async function updateStatus() {
  const { lng, lat } = map.getCenter();
  const el = $('#status');
  statusAbort?.abort();
  statusAbort = new AbortController();

  // Bounding boxes overlap at borders (and Canada sits inside the US box), so
  // list every candidate; tiles are transparent where a source has no data.
  const hits = LIDAR_SOURCES.slice(1).filter((s) => inside(s.bounds, lng, lat));
  const others = hits
    .map((h) => `<div><span class="dot ok"></span><b>${h.resolution}</b> · ${h.name}</div>`)
    .join('');
  const none = '<span class="dot none"></span>No national lidar server here — showing Mapterhorn terrain (1 m lidar in many countries, ~30 m elsewhere).';

  if (!inside(US.bounds, lng, lat)) {
    el.innerHTML = others || none;
    return;
  }
  el.innerHTML = '<span class="dot wait"></span>Checking USGS 3DEP index…' + others;
  try {
    const url = new URL(US_COVERAGE_QUERY);
    url.search = new URLSearchParams({
      geometry: `${lng},${lat}`,
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      returnCountOnly: 'true',
      f: 'json',
    }).toString();
    const res = await fetch(url, { signal: statusAbort.signal });
    const { count } = (await res.json()) as { count?: number };
    const zoomHint = map.getZoom() < 11 ? ' · zoom in to load it' : '';
    const us = count ? `<div><span class="dot ok"></span><b>1 m</b> · USGS 3DEP${zoomHint}</div>` : '';
    el.innerHTML = us + others || none;
  } catch (e) {
    if ((e as Error).name !== 'AbortError') el.innerHTML = others || 'Could not reach the USGS index.';
  }
}
let statusTimer = 0;
map.on('moveend', () => {
  clearTimeout(statusTimer);
  statusTimer = window.setTimeout(updateStatus, 300);
});

// ---------- UI wiring ----------

document.querySelectorAll<HTMLButtonElement>('.modes button').forEach((b) =>
  b.addEventListener('click', () => {
    state.mode = b.dataset.mode as Mode;
    applyMode();
  }),
);

document.querySelectorAll<HTMLButtonElement>('#styles button').forEach((b) =>
  b.addEventListener('click', () => {
    state.style = b.dataset.style as LidarStyle;
    document.querySelectorAll('#styles button').forEach((x) => x.classList.toggle('on', x === b));
    if (state.mode === 'satellite') state.mode = 'lidar';
    lastRange = '';
    applyMode();
  }),
);

$<HTMLInputElement>('#s-depth').addEventListener('input', (e) => {
  state.depth = Number((e.target as HTMLInputElement).value) / 100;
  applyShading();
});
$<HTMLInputElement>('#s-sun').addEventListener('input', (e) => {
  state.sun = Number((e.target as HTMLInputElement).value);
  applyShading();
});
$<HTMLInputElement>('#t-labels').addEventListener('change', (e) => {
  state.labels = (e.target as HTMLInputElement).checked;
  applyLayers();
});
$<HTMLInputElement>('#t-coverage').addEventListener('change', (e) => {
  state.coverage = (e.target as HTMLInputElement).checked;
  applyLayers();
});
const siteKinds = () =>
  (['archaeology', 'battlefield', 'historic'] as SiteKind[]).filter(
    (k) => k === 'archaeology' || k === 'battlefield' || $<HTMLInputElement>('#t-historic').checked,
  );
$<HTMLInputElement>('#t-sites').addEventListener('change', (e) => {
  const on = (e.target as HTMLInputElement).checked;
  setSitesVisible(map, on);
  $<HTMLInputElement>('#t-historic').disabled = !on;
});
$<HTMLInputElement>('#t-historic').addEventListener('change', () => setSiteKinds(siteKinds()));
$<HTMLInputElement>('#t-3d').addEventListener('change', (e) => {
  state.terrain = (e.target as HTMLInputElement).checked;
  applyTerrain();
});
$('#side-toggle').addEventListener('click', () => {
  const open = $('.side').classList.toggle('open');
  $('#side-toggle').setAttribute('aria-expanded', String(open));
});

// Keyboard: 1/2/3 switch modes, L toggles satellite ↔ lidar.
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('input, select, textarea, button, a')) return;
  const modes: Record<string, Mode> = { '1': 'satellite', '2': 'lidar', '3': 'swipe' };
  if (modes[e.key]) state.mode = modes[e.key];
  else if (e.key.toLowerCase() === 'l') state.mode = state.mode === 'satellite' ? 'lidar' : 'satellite';
  else return;
  applyMode();
});

// Swipe handle drag.
{
  const knob = $('.swipe-knob');
  let dragging = false;
  const move = (x: number) => {
    state.swipePct = Math.min(100, Math.max(0, (x / window.innerWidth) * 100));
    applySwipe();
  };
  knob.addEventListener('pointerdown', (e) => {
    dragging = true;
    knob.setPointerCapture(e.pointerId);
  });
  knob.addEventListener('pointermove', (e) => dragging && move(e.clientX));
  knob.addEventListener('lostpointercapture', () => (dragging = false));
  knob.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 2;
    if (e.key === 'ArrowLeft') state.swipePct = Math.max(0, state.swipePct - step);
    else if (e.key === 'ArrowRight') state.swipePct = Math.min(100, state.swipePct + step);
    else if (e.key === 'Home') state.swipePct = 0;
    else if (e.key === 'End') state.swipePct = 100;
    else return;
    e.preventDefault();
    e.stopPropagation();
    applySwipe();
  });
}

// Featured places and share links.
const featuredSelect = $<HTMLSelectElement>('#featured');
featuredSelect.add(new Option('Featured places', ''));
for (const place of PRESETS) featuredSelect.add(new Option(place.name, featuredId(place.name)));

function selectFeatured(place?: Preset) {
  featured = place;
  featuredSelect.value = place ? featuredId(place.name) : '';
}

function openFeatured(place: Preset) {
  selectFeatured(place);
  state.mode = 'swipe';
  state.swipePct = 50;
  applyMode();
  map.flyTo({ center: [place.lng, place.lat], zoom: place.zoom, speed: 1.6 });
}

selectFeatured(featured);
featuredSelect.addEventListener('change', () => {
  const place = PRESETS.find((p) => featuredId(p.name) === featuredSelect.value);
  if (place) openFeatured(place);
  else selectFeatured();
});

$<HTMLInputElement>('#s-depth').value = String(state.depth * 100);
$<HTMLInputElement>('#s-sun').value = String(state.sun);
$<HTMLInputElement>('#t-labels').checked = state.labels;
$<HTMLInputElement>('#t-coverage').checked = state.coverage;
$<HTMLInputElement>('#t-3d').checked = state.terrain;
$<HTMLInputElement>('#t-sites').checked = initial.sites;
$<HTMLInputElement>('#t-historic').checked = initial.historic;
$<HTMLInputElement>('#t-historic').disabled = !initial.sites;
document.querySelectorAll<HTMLButtonElement>('#styles button').forEach((button) => {
  button.classList.toggle('on', button.dataset.style === state.style);
});

$('#share').addEventListener('click', async () => {
  const { lng, lat } = map.getCenter().wrap();
  const params = new URLSearchParams({
    lat: String(lat), lng: String(lng), zoom: String(map.getZoom()),
    bearing: String(map.getBearing()), pitch: String(map.getPitch()), roll: String(map.getRoll()),
    mode: state.mode, style: state.style, divider: String(state.swipePct),
    depth: String(state.depth), sun: String(state.sun),
    labels: state.labels ? '1' : '0', coverage: state.coverage ? '1' : '0', terrain: state.terrain ? '1' : '0',
    sites: $<HTMLInputElement>('#t-sites').checked ? '1' : '0',
    historic: $<HTMLInputElement>('#t-historic').checked ? '1' : '0',
  });
  if (featured) params.set('place', featuredId(featured.name));
  const url = new URL(location.pathname, location.origin);
  url.search = params.toString();
  const feedback = $('#share-status');
  feedback.hidden = false;
  try {
    await navigator.clipboard.writeText(url.href);
    feedback.textContent = 'View link copied.';
  } catch {
    const field = document.createElement('input');
    field.type = 'url';
    field.readOnly = true;
    field.value = url.href;
    field.setAttribute('aria-label', 'Copy this view link');
    feedback.replaceChildren(field);
    field.focus();
    field.select();
  }
});

// Local suggestions are instant. Remote geocoding requires an explicit submit.
{
  const form = $<HTMLFormElement>('.search');
  const input = $<HTMLInputElement>('#q');
  const list = $('#results');
  const feedback = $('#search-status');
  const osmCredit = document.createElement('a');
  osmCredit.href = 'https://www.openstreetmap.org/copyright';
  osmCredit.textContent = '© OpenStreetMap contributors';
  let results: Place[] = [];
  let active = -1;
  let remote = false;
  let abort: AbortController | undefined;

  const message = (text: string) => {
    feedback.textContent = text;
    feedback.hidden = !text;
  };

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };

  const go = (place: Place) => {
    abort?.abort();
    close();
    message('');
    input.value = place.label;
    input.blur();
    const preset = PRESETS.find((p) => p.name === place.label && p.lat === place.lat && p.lng === place.lng);
    if (preset) {
      openFeatured(preset);
      return;
    }
    selectFeatured();
    if (place.bbox && place.bbox[2] - place.bbox[0] > 0.002) {
      const [west, south, east, north] = place.bbox;
      map.fitBounds([[west, south], [east, north]], { maxZoom: 17, padding: 60, speed: 1.6 });
    } else {
      map.flyTo({ center: [place.lng, place.lat], zoom: 16, speed: 1.6 });
    }
  };

  const render = () => {
    list.replaceChildren();
    results.forEach((place, index) => {
      const option = document.createElement('li');
      option.id = `place-result-${index}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === active));
      option.classList.toggle('active', index === active);
      const title = document.createElement('b');
      title.textContent = place.label;
      const detail = document.createElement('small');
      detail.textContent = place.sub;
      option.append(title, detail);
      option.addEventListener('pointerdown', (event) => event.preventDefault());
      option.addEventListener('click', () => go(place));
      list.append(option);
    });
    if (!results.length) {
      close();
      return;
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (active >= 0) input.setAttribute('aria-activedescendant', `place-result-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };

  input.addEventListener('input', () => {
    abort?.abort();
    message('');
    active = -1;
    remote = false;
    const query = input.value.trim();
    const coords = parseCoords(query);
    const presets = PRESETS.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()));
    results = coords ? [coords] : query.length < 3 ? [] : [
      ...presets.map((p) => ({ ...p, label: p.name, sub: p.note })),
      ...searchSites(query).filter((p) => !presets.some((preset) => preset.name === p.label)),
    ];
    render();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = input.value.trim();
    const coords = parseCoords(query);
    if (coords) return go(coords);
    const exact = results.find((p) => p.label.toLowerCase() === query.toLowerCase());
    if (!remote && exact) return go(exact);
    if (query.length < 3) return message('Enter at least three characters or paste coordinates.');
    abort?.abort();
    const request = new AbortController();
    abort = request;
    const local = remote ? [] : results;
    message('Searching places…');
    try {
      const places = await searchPlaces(query, request.signal);
      if (request.signal.aborted) return;
      results = [...local, ...places];
      active = -1;
      remote = true;
      render();
      message(places.length ? 'Place results from ' : 'No additional places found.');
      if (places.length) feedback.append(osmCredit);
    } catch {
      if (!request.signal.aborted) message('Place search is unavailable. Try again or paste coordinates.');
    }
  });

  input.addEventListener('keydown', (event) => {
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && results.length) {
      event.preventDefault();
      active = active < 0 ? (event.key === 'ArrowDown' ? 0 : results.length - 1)
        : (active + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      render();
    } else if (event.key === 'Enter' && !list.hidden && results[active]) {
      event.preventDefault();
      go(results[active]);
    } else if (event.key === 'Escape') {
      abort?.abort();
      close();
      message('');
    }
  });
  form.addEventListener('focusout', (event) => {
    if (!form.contains(event.relatedTarget as Node | null)) {
      abort?.abort();
      close();
      if (feedback.textContent === 'Searching places…') message('');
    }
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === '/' && !(event.target instanceof HTMLInputElement)) {
      event.preventDefault();
      input.focus();
    }
  });
}

// ---------- load progress bar ----------
// Only lidar downloads are counted: they're the slow part (USGS takes 1–10 s a tile).
// Shown after a short delay so cached/fast loads don't flash it.
{
  const el = $('#loader');
  const text = $('#load-text');
  let showTimer = 0;
  let hideTimer = 0;
  onProgress(({ done, total, retrying }) => {
    const busy = total > 0 && done < total;
    const frac = total ? done / total : 1;
    el.style.setProperty('--p', String(busy ? Math.max(0.04, frac) : 1));
    el.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
    text.textContent = busy
      ? `Loading lidar · ${done} of ${total} tiles${retrying ? ` · retrying ${retrying} (USGS is busy)` : ''}`
      : 'Lidar loaded';
    clearTimeout(hideTimer);
    if (busy) {
      if (!el.classList.contains('show') && !showTimer) {
        showTimer = window.setTimeout(() => {
          showTimer = 0;
          el.classList.add('show');
        }, 250);
      }
    } else {
      clearTimeout(showTimer);
      showTimer = 0;
      hideTimer = window.setTimeout(() => el.classList.remove('show'), 600);
    }
  });
}

map.on('style.load', () => {
  // The credits list is long (one line per national source); start it collapsed behind the ⓘ.
  document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  applyMode();
  if (state.terrain && !initial.camera) applyTerrain();
  updateStatus();
});
// Pins go on as soon as the style is ready, not after the first terrain tiles ('load').
const startSites = () => {
  setSiteKinds(siteKinds());
  const ready = addSites(map, () => {
    selectFeatured();
    if (state.mode === 'satellite') {
      state.mode = 'lidar';
      applyMode();
    }
  });
  setSitesVisible(map, $<HTMLInputElement>('#t-sites').checked);
  void ready.catch(() => console.warn('Heritage sites could not be loaded.'));
};
if (map.isStyleLoaded()) startSites();
else map.once('style.load', startSites);
overlay.on('style.load', () => {
  overlayReady = true;
  applyLayers();
  if (state.terrain) applyTerrainSources();
});

// Dev-only perf instrumentation: time to idle + tile errors, readable from devtools.
if (import.meta.env.DEV) {
  const perf = { errors: 0, loaded: 0, t0: performance.now(), idleAt: 0 };
  map.on('error', () => perf.errors++);
  map.on('data', (e) => {
    if ((e as { tile?: unknown }).tile) perf.loaded++;
  });
  map.on('idle', () => (perf.idleAt = performance.now() - perf.t0));
  Object.assign(window, { __map: map, __overlay: overlay, __perf: perf });
}
