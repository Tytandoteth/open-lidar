// Registered sites as clickable pins.
//
// Built by scripts/build-sites.mjs from the US National Register of Historic
// Places (NPS, public locations only) merged with Wikidata's archaeological
// sites. Shown clustered; click a pin for details and a jump to its lidar.

import * as maplibregl from 'maplibre-gl';
import type { Place } from './search';

export type SiteKind = 'archaeology' | 'battlefield' | 'historic';

interface SiteProps {
  name: string;
  kind: SiteKind;
  place: string;
  ref: string;
  year: string;
  nara: string;
  nhl: number;
  desc: string;
  wiki: string;
  wd?: string;
  reg?: string; // official national register entry (Europe)
  bbox?: string; // "w,s,e,n" when NPS maps a boundary
}
interface Point { type: 'Point'; coordinates: number[] }
interface SiteFeature { type: 'Feature'; geometry: Point; properties: SiteProps }

const URL_SITES = '/sites/us-nrhp.geojson';
const URL_EU = '/sites/eu';
const EU_CELL_ZOOM = 8; // load the full European lists from here in

// Name each national register by its host, for the popup link.
const REGISTER_NAMES: [RegExp, string][] = [
  [/historicengland/, 'Historic England list entry'],
  [/pop\.culture\.gouv/, 'Mérimée (French heritage register)'],
  [/cultureelerfgoed/, 'Rijksmonumentenregister'],
  [/kulturarvsdata\.se/, 'Swedish heritage register'],
  [/historicenvironment\.scot/, 'Historic Environment Scotland'],
  [/coflein/, 'Coflein (Wales)'],
  [/kulturarv\.dk/, 'Fund og Fortidsminder (Denmark)'],
  [/kulturminnesok/, 'Kulturminnesøk (Norway)'],
];
const COLORS: Record<SiteKind, string> = { archaeology: '#f2b33d', battlefield: '#e0564f', historic: '#7fa7d9' };
const LABEL: Record<SiteKind, string> = {
  archaeology: 'Archaeological site',
  battlefield: 'Battlefield',
  historic: 'Historic site',
};

let all: SiteFeature[] = [];
const ids = new Set<string>(); // Wikidata ids already loaded, to skip duplicates

/** Compact European row [lng, lat, name, description, enwiki title, wikidata id, register url] → feature. */
type EuRow = [number, number, string, string, string, string, string];
function fromEu(rows: EuRow[]): SiteFeature[] {
  const out: SiteFeature[] = [];
  for (const [lng, lat, name, desc, wiki, wd, reg] of rows) {
    if (ids.has(wd)) continue;
    ids.add(wd);
    out.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: {
        name, kind: 'archaeology', place: '', ref: '', year: '', nara: '', nhl: 0, desc, wd, reg,
        wiki: wiki ? `https://en.wikipedia.org/wiki/${encodeURIComponent(wiki)}` : '',
      },
    });
  }
  return out;
}

// European cells (1°): which exist, and which are loaded or loading.
let euIndex: Record<string, number> = {};
const euCells = new Set<string>();
let refreshTimer = 0;
async function loadEuCells(map: maplibregl.Map) {
  if (map.getZoom() < EU_CELL_ZOOM) return;
  const b = map.getBounds();
  const want: string[] = [];
  for (let x = Math.floor(b.getWest()); x <= Math.floor(b.getEast()); x++) {
    for (let y = Math.floor(b.getSouth()); y <= Math.floor(b.getNorth()); y++) {
      const k = `${x}_${y}`;
      if (euIndex[k] && !euCells.has(k)) want.push(k);
    }
  }
  await Promise.all(
    want.slice(0, 24).map(async (k) => {
      euCells.add(k);
      try {
        const rows = (await (await fetch(`${URL_EU}/cells/${k}.json`)).json()) as EuRow[];
        all.push(...fromEu(rows));
      } catch {
        euCells.delete(k); // try again next time
      }
    }),
  );
  if (want.length) {
    clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(refresh, 50);
  }
}
const shown = new Set<SiteKind>(['archaeology', 'battlefield']);
let mapRef: maplibregl.Map | null = null;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function refresh() {
  const src = mapRef?.getSource('sites') as maplibregl.GeoJSONSource | undefined;
  src?.setData({ type: 'FeatureCollection', features: all.filter((f) => shown.has(f.properties.kind)) });
}

export function setSiteKinds(kinds: SiteKind[]) {
  shown.clear();
  kinds.forEach((k) => shown.add(k));
  refresh();
}

/** Zoom to a site: its NPS boundary if there is one, otherwise close in. */
export function flyToSite(p: SiteProps, coords: [number, number], map = mapRef!) {
  const b = p.bbox?.split(',').map(Number);
  if (b && b[2] - b[0] > 0.0008) {
    map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { maxZoom: 17, padding: 80, speed: 1.6 });
  } else {
    map.flyTo({ center: coords, zoom: 16, speed: 1.6 });
  }
}

function popupHtml(p: SiteProps): string {
  const links: string[] = [];
  if (p.wiki) links.push(`<a href="${esc(p.wiki)}" target="_blank" rel="noopener">Wikipedia</a>`);
  if (p.nara) links.push(`<a href="${esc(p.nara)}" target="_blank" rel="noopener">NRHP nomination (National Archives)</a>`);
  if (p.reg) {
    const name = REGISTER_NAMES.find(([re]) => re.test(p.reg!))?.[1] ?? 'National register entry';
    links.push(`<a href="${esc(p.reg)}" target="_blank" rel="noopener">${name}</a>`);
  }
  if (p.wd) links.push(`<a href="https://www.wikidata.org/wiki/${esc(p.wd)}" target="_blank" rel="noopener">Wikidata</a>`);
  const meta = [
    p.nhl ? 'National Historic Landmark' : '',
    p.ref ? `NRHP #${esc(p.ref)}${p.year ? ` · listed ${esc(p.year)}` : ''}` : '',
  ].filter(Boolean);
  return `
    <div class="site-pop">
      <span class="site-kind" style="--c:${COLORS[p.kind]}">${LABEL[p.kind]}</span>
      <h4>${esc(p.name)}</h4>
      ${p.place ? `<div class="muted">${esc(p.place)}</div>` : ''}
      ${p.desc ? `<p>${esc(p.desc)}</p>` : ''}
      ${meta.length ? `<div class="muted small">${meta.join(' · ')}</div>` : ''}
      ${links.length ? `<div class="site-links">${links.join('')}</div>` : ''}
      <button class="site-go">View lidar here</button>
    </div>`;
}

// Start downloading straight away: the map's 'load' event waits for terrain tiles.
const prefetch = Promise.all([
  fetch(URL_SITES).then((r) => r.json() as Promise<{ features: SiteFeature[] }>),
  fetch(`${URL_EU}/notable.json`).then((r) => (r.ok ? (r.json() as Promise<EuRow[]>) : [])).catch(() => [] as EuRow[]),
  fetch(`${URL_EU}/index.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})) as Promise<Record<string, number>>,
]);

export async function addSites(map: maplibregl.Map, onGo: () => void) {
  mapRef = map;
  map.addSource('sites', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
    cluster: true,
    clusterMaxZoom: 9,
    clusterRadius: 60,
    attribution: 'Sites: NPS National Register of Historic Places, Wikidata (incl. European national registers)',
  });
  map.addLayer({
    id: 'site-clusters',
    type: 'circle',
    source: 'sites',
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': 'rgba(20,22,26,0.85)',
      'circle-stroke-color': COLORS.archaeology,
      'circle-stroke-width': 2,
      'circle-radius': ['step', ['get', 'point_count'], 13, 10, 17, 50, 22, 200, 28],
    },
  });
  map.addLayer({
    id: 'site-count',
    type: 'symbol',
    source: 'sites',
    filter: ['has', 'point_count'],
    layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Bold'], 'text-size': 12 },
    paint: { 'text-color': '#ffffff' },
  });
  map.addLayer({
    id: 'site-pins',
    type: 'circle',
    source: 'sites',
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': ['match', ['get', 'kind'], 'archaeology', COLORS.archaeology, 'battlefield', COLORS.battlefield, COLORS.historic],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, ['case', ['==', ['get', 'nhl'], 1], 5, 4], 14, ['case', ['==', ['get', 'nhl'], 1], 9, 7]],
      'circle-stroke-color': '#111316',
      'circle-stroke-width': 1.5,
    },
  });
  map.addLayer({
    id: 'site-names',
    type: 'symbol',
    source: 'sites',
    filter: ['!', ['has', 'point_count']],
    minzoom: 13,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Bold'],
      'text-size': 12,
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
      'text-max-width': 12,
      'text-optional': true,
    },
    paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.85)', 'text-halo-width': 1.5 },
  });

  const popup = new maplibregl.Popup({ maxWidth: '300px', className: 'site-popup', offset: 10 });
  map.on('click', 'site-pins', (e) => {
    const f = e.features?.[0] as unknown as SiteFeature | undefined;
    if (!f) return;
    const coords = f.geometry.coordinates.slice() as [number, number];
    popup.setLngLat(coords).setHTML(popupHtml(f.properties)).addTo(map);
    popup.getElement().querySelector('.site-go')?.addEventListener('click', () => {
      popup.remove();
      onGo();
      flyToSite(f.properties, coords, map);
    });
  });
  map.on('click', 'site-clusters', async (e) => {
    const f = e.features?.[0];
    if (!f) return;
    const src = map.getSource('sites') as maplibregl.GeoJSONSource;
    const zoom = await src.getClusterExpansionZoom(f.properties!.cluster_id);
    map.easeTo({ center: (f.geometry as Point).coordinates as [number, number], zoom });
  });
  for (const id of ['site-pins', 'site-clusters']) {
    map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
  }

  const [us, notable, index] = await prefetch;
  for (const f of us.features) if (f.properties.wd) ids.add(f.properties.wd);
  all = [...us.features, ...fromEu(notable)];
  euIndex = index;
  refresh();
  map.on('moveend', () => void loadEuCells(map));
  void loadEuCells(map);
}

export function setSitesVisible(map: maplibregl.Map, on: boolean) {
  for (const id of ['site-clusters', 'site-count', 'site-pins', 'site-names']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }
}

/** Registered sites whose name matches, for the search box. */
export function searchSites(q: string, limit = 4): (Place & { site: SiteFeature })[] {
  const needle = q.toLowerCase();
  const hits: { f: SiteFeature; score: number }[] = [];
  for (const f of all) {
    const n = f.properties.name.toLowerCase();
    const i = n.indexOf(needle);
    if (i < 0) continue;
    hits.push({ f, score: (i === 0 ? 0 : 1) + (f.properties.kind === 'archaeology' ? 0 : 0.5) + n.length / 200 });
  }
  hits.sort((a, b) => a.score - b.score);
  return hits.slice(0, limit).map(({ f }) => {
    const [lng, lat] = f.geometry.coordinates;
    const b = f.properties.bbox?.split(',').map(Number) as [number, number, number, number] | undefined;
    return { label: f.properties.name, sub: `${LABEL[f.properties.kind]}${f.properties.place ? ` · ${f.properties.place}` : ''}`, lng, lat, bbox: b, site: f };
  });
}
