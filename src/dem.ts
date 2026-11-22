// Client-side lidar elevation (Mapterhorn worldwide; US, France, Netherlands, Canada direct).
//
// Instead of asking servers for pre-rendered pictures, we fetch raw elevation
// (LERC from USGS, GeoTIFF from the others), decode it, and hand MapLibre a
// Terrarium-encoded DEM tile. MapLibre then does the
// hillshade, colour relief and 3D terrain on the GPU, so lighting, exaggeration
// and colour stretch can change instantly without refetching anything.

import * as maplibregl from 'maplibre-gl';
import * as Lerc from 'lerc';
import lercWasm from 'lerc/lerc-wasm.wasm?url';
import { fromArrayBuffer } from 'geotiff';

const WORLD = 40075016.68557849;
const HALF = WORLD / 2;

// ---------- polite networking: per-host concurrency + retries ----------

// USGS queues work server-side; 12 in flight measured ~2x faster than 6 with
// no extra failures. Still a cap so a fast pan can't fire hundreds at once.
const MAX_PER_HOST = 12;
// Static CDNs (pre-built tiles) can take far more in parallel.
const HOST_LIMIT: Record<string, number> = { 'tiles.mapterhorn.com': 32 };
const active = new Map<string, number>();
const waiting = new Map<string, Array<() => void>>();

async function withSlot<T>(host: string, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  if ((active.get(host) ?? 0) >= (HOST_LIMIT[host] ?? MAX_PER_HOST)) {
    await new Promise<void>((resolve, reject) => {
      const q = waiting.get(host) ?? [];
      waiting.set(host, q);
      // FIFO: MapLibre requests the tiles nearest the centre first.
      q.push(resolve);
      signal.addEventListener('abort', () => {
        const i = q.indexOf(resolve);
        if (i >= 0) q.splice(i, 1);
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });
  }
  active.set(host, (active.get(host) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    active.set(host, (active.get(host) ?? 1) - 1);
    waiting.get(host)?.shift()?.();
  }
}

// ---------- load progress ----------
// One "batch" spans from the first request until nothing is in flight. Cancelled
// requests (the user panned away) leave the batch instead of counting as done.

export interface Progress {
  done: number;
  total: number;
  retrying: number;
}
const progress: Progress = { done: 0, total: 0, retrying: 0 };
const listeners = new Set<(p: Progress) => void>();
export function onProgress(fn: (p: Progress) => void) {
  listeners.add(fn);
}
const emit = () => listeners.forEach((fn) => fn({ ...progress }));

// ---------- persistent tile store ----------
// Several lidar servers send no cache headers (or 2 minutes), so the browser
// would re-download every tile on each visit. Keep the raw bytes in Cache
// Storage ourselves; trimmed oldest-first when the origin passes ~600 MB.

const STORE_NAME = 'open-lidar-tiles-v1';
const STORE_LIMIT = 600 * 1024 * 1024;
const store: Promise<Cache | null> =
  typeof caches !== 'undefined' ? caches.open(STORE_NAME).catch(() => null) : Promise.resolve(null);
let putsSinceTrim = 0;

async function fromStore(url: string): Promise<ArrayBuffer | null> {
  try {
    const hit = await (await store)?.match(url);
    return hit ? await hit.arrayBuffer() : null;
  } catch {
    return null;
  }
}

async function toStore(url: string, data: ArrayBuffer) {
  try {
    const c = await store;
    if (!c) return;
    await c.put(url, new Response(data.slice(0)));
    if (++putsSinceTrim >= 40) {
      putsSinceTrim = 0;
      const { usage = 0 } = (await navigator.storage?.estimate?.()) ?? {};
      if (usage > STORE_LIMIT) {
        const keys = await c.keys(); // insertion order: oldest first
        await Promise.all(keys.slice(0, Math.ceil(keys.length * 0.25)).map((k) => c.delete(k)));
      }
    }
  } catch {
    /* quota or private mode: just don't persist */
  }
}

// ---------- shared CDN cache (production) ----------
// On the deployed site, slow or uncacheable servers go through /api/tile, which
// Vercel's CDN caches for every visitor. Must match the allowlist in api/tile.ts.
const PROXIED = [
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage',
  'https://index.nationalmap.gov/arcgis/rest/services/3DEPElevationIndex/MapServer/export',
  'https://data.geopf.fr/wms-r',
  'https://service.pdok.nl/rws/ahn/',
  'https://datacube.services.geo.ca/wrapper/ogc/elevation-hrdem-mosaic',
  'https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wms',
  'https://geo.api.vlaanderen.be/DHMV/wms',
  'https://www.wms.nrw.de/geobasis/wms_nw_dgm-schummerung',
  'https://wms.geonorge.no/skwms1/wms.hoyde-dtm-nhm-25833',
];
const viaProxy = (url: string) =>
  import.meta.env.PROD && PROXIED.some((p) => url.startsWith(p)) ? `/api/tile?u=${encodeURIComponent(url)}` : url;

/**
 * Fetch a tile: browser store first, then the network (via the CDN proxy in
 * production) with a per-host slot and backoff retries, counted in the progress batch.
 */
export async function politeFetch(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const stored = await fromStore(url);
  if (stored) return stored;
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

  if (progress.total === progress.done) progress.done = progress.total = 0; // new batch
  progress.total++;
  emit();
  try {
    const data = await fetchWithRetry(viaProxy(url), new URL(url).host, signal);
    progress.done++;
    void toStore(url, data);
    return data;
  } catch (e) {
    // Cancelled → not part of what's left to load. Failed for good → counts as finished.
    if ((e as Error).name === 'AbortError') progress.total--;
    else progress.done++;
    throw e;
  } finally {
    emit();
  }
}

async function fetchWithRetry(url: string, host: string, signal: AbortSignal): Promise<ArrayBuffer> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const res = await withSlot(host, signal, () => fetch(url, { signal }));
      if (res.ok) return await res.arrayBuffer();
      if (res.status < 500 && res.status !== 429) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      if ((e as Error).name === 'AbortError' || (e as { fatal?: boolean }).fatal) throw e;
      lastErr = e; // 5xx without CORS headers surfaces as a TypeError here
    }
    progress.retrying++;
    emit();
    // USGS fails fast while it's still busy rendering, so give it real time to recover.
    await new Promise((r) => setTimeout(r, 800 * 2 ** attempt + Math.random() * 400));
    progress.retrying--;
  }
  throw lastErr;
}

/** retry://https://… — any raster tile URL, fetched politely. */
maplibregl.addProtocol('retry', async (params, abort) => ({
  data: await politeFetch(params.url.replace(/^retry:\/\//, ''), abort.signal),
}));

// ---------- per-tile elevation samples, for stretching colours to the view ----------

interface TileStats {
  provider: string;
  z: number;
  x: number;
  y: number;
  samples: Float32Array; // ~1k evenly spaced valid elevations
}
const stats = new Map<string, TileStats>();

/**
 * Robust low/high elevation (0.5th/99.7th percentile) of the lidar tiles covering
 * the given lng/lat bounds, or null when none are loaded there yet.
 */
export function viewRange(
  bounds: maplibregl.LngLatBounds,
  zoom: number,
): { lo: number; hi: number } | null {
  const toX = (lng: number) => ((lng + 180) / 360);
  const toY = (lat: number) =>
    (1 - Math.asinh(Math.tan((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180)) / Math.PI) / 2;
  const fx0 = toX(bounds.getWest()), fx1 = toX(bounds.getEast());
  const fy0 = toY(bounds.getNorth()), fy1 = toY(bounds.getSouth());

  // Prefer tiles at the zoom MapLibre is actually showing; fall back to any zoom.
  // MapLibre picks round(zoom) for 512 px tiles.
  const target = Math.min(17, Math.max(10, Math.round(zoom)));
  let picked: TileStats[] = [];
  for (const exactOnly of [true, false]) {
    picked = [];
    for (const t of stats.values()) {
      if (exactOnly && t.z !== target) continue;
      const n = 2 ** t.z;
      if (t.x + 1 < fx0 * n || t.x > fx1 * n || t.y + 1 < fy0 * n || t.y > fy1 * n) continue;
      picked.push(t);
    }
    if (picked.length) break;
  }
  if (!picked.length) return null;
  const all = new Float32Array(picked.reduce((s, t) => s + t.samples.length, 0));
  let o = 0;
  for (const t of picked) {
    all.set(t.samples, o);
    o += t.samples.length;
  }
  if (!all.length) return null;
  all.sort();
  // Trim only the extreme 0.5% so summits (the interesting bit) keep their detail.
  const lo = all[Math.floor(all.length * 0.005)];
  const hi = all[Math.min(all.length - 1, Math.floor(all.length * 0.997))];
  return { lo, hi: Math.max(hi, lo + 1) };
}

// ---------- raw elevation providers ----------

export type DemKind = 'dtm' | 'dsm'; // bare earth | surface (buildings, trees)
type Box = [number, number, number, number]; // EPSG:3857 minx, miny, maxx, maxy

// 512 px tiles: the slow servers take about as long for 512 px as for 256 px,
// so bigger tiles mean ~4x fewer slow requests per screen.
export const DEM_TILE = 512;
/** Elevation written where a provider has no data; colour relief renders it transparent. */
export const NODATA = -32000;

export interface DemProvider {
  id: string;
  name: string;
  /** lng/lat box; tiles outside aren't requested. */
  bounds: [number, number, number, number];
  minzoom: number;
  maxzoom: number;
  hasDsm: boolean;
  attribution: string;
  /** Skip tiles that are certainly outside the country (bounds boxes overlap). */
  skip?: (w: number, s: number, e: number, n: number) => boolean;
  /** Ordered list of URLs per kind: later ones fill pixels the earlier ones lack. */
  urls: (kind: DemKind, b: Box) => string[];
  format: 'lerc' | 'tiff';
}

const wcs20 = (base: string, coverage: string, b: Box) =>
  `${base}?service=WCS&request=GetCoverage&version=2.0.1&coverageId=${coverage}&format=image/tiff` +
  `&subset=x(${b[0]},${b[2]})&subset=y(${b[1]},${b[3]})` +
  '&subsettingCrs=http://www.opengis.net/def/crs/EPSG/0/3857&outputCrs=http://www.opengis.net/def/crs/EPSG/0/3857' +
  `&scaleSize=x(${DEM_TILE}),y(${DEM_TILE})`;

const ignWms = (layer: string, b: Box) =>
  `https://data.geopf.fr/wms-r?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${layer}&STYLES=` +
  `&CRS=EPSG:3857&BBOX=${b.join(',')}&WIDTH=${DEM_TILE}&HEIGHT=${DEM_TILE}&FORMAT=image/geotiff`;

export const DEM_PROVIDERS: DemProvider[] = [
  {
    id: 'nl',
    name: 'AHN (Netherlands)',
    bounds: [3.2, 50.7, 7.3, 53.7],
    minzoom: 11,
    maxzoom: 17, // 0.5 m data; 512 px at z17 ≈ 0.6 m
    hasDsm: true,
    attribution: 'Lidar: AHN / Rijkswaterstaat, PDOK',
    format: 'tiff',
    urls: (k, b) => [wcs20('https://service.pdok.nl/rws/ahn/wcs/v1_0', k === 'dtm' ? 'dtm_05m' : 'dsm_05m', b)],
  },
  {
    id: 'fr',
    name: 'IGN LiDAR HD (France)',
    bounds: [-5.3, 41.3, 9.7, 51.2],
    minzoom: 11,
    maxzoom: 17,
    hasDsm: true,
    attribution: 'Lidar: © IGN LiDAR HD / RGE ALTI',
    format: 'tiff',
    // LiDAR HD (0.5 m) is still being completed; RGE ALTI (1 m, nationwide) fills gaps.
    urls: (k, b) =>
      k === 'dtm'
        ? [ignWms('IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93', b), ignWms('ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES', b)]
        : [ignWms('IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93', b), ignWms('ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES.MNS', b)],
  },
  {
    id: 'us',
    name: 'USGS 3DEP',
    bounds: [-170, 18, -66, 71.5],
    minzoom: 10,
    maxzoom: 16, // 512 px at z16 ≈ 1.2 m/pixel; MapLibre overzooms beyond
    hasDsm: false, // 3DEP only publishes bare earth
    attribution: 'Lidar: USGS 3D Elevation Program',
    format: 'lerc',
    // Canada north of the 49th parallel (Alaska is west of -141).
    skip: (w, s) => s > 49.1 && w > -141,
    urls: (_k, b) => [
      'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage' +
        `?bbox=${b.join(',')}&bboxSR=3857&imageSR=3857` +
        `&size=${DEM_TILE},${DEM_TILE}&format=lerc&pixelType=F32&interpolation=RSP_BilinearInterpolation` +
        // 5 cm max error — below lidar's own ~10 cm vertical accuracy, and 2.7x smaller.
        '&compressionTolerance=0.05&f=image',
    ],
  },
  {
    id: 'ca',
    name: 'HRDEM (Canada)',
    bounds: [-141, 41.6, -52.6, 83],
    minzoom: 10,
    maxzoom: 16,
    hasDsm: true,
    attribution: 'Lidar: © NRCan HRDEM',
    format: 'tiff',
    // West of Ontario the border is the 49th parallel.
    skip: (w, s, e, n) => n < 48.9 && e < -95.2,
    urls: (k, b) => {
      const res = (b[2] - b[0]) / DEM_TILE;
      return [
        'https://datacube.services.geo.ca/wrapper/ogc/elevation-hrdem-mosaic?service=WCS&version=1.1.1' +
          `&request=GetCoverage&identifier=${k}&boundingbox=${b.join(',')},urn:ogc:def:crs:EPSG::3857` +
          `&gridBaseCRS=urn:ogc:def:crs:EPSG::3857&gridOffsets=${res},${-res}&format=image/geotiff`,
      ];
    },
  },
];

const lercReady = Lerc.load({ locateFile: () => lercWasm });

/** A decoded raster: values with NaN for "no data", and the 3857 box it covers. */
interface Raster {
  w: number;
  h: number;
  v: Float32Array;
  box: Box;
}

const bad = (x: number, nd: number | null) => !Number.isFinite(x) || x === nd || x < -1000 || x > 9000;

async function decode(buf: ArrayBuffer, format: 'lerc' | 'tiff', req: Box): Promise<Raster> {
  if (format === 'lerc') {
    await lercReady;
    const img = Lerc.decode(buf);
    const px = img.pixels[0] as Float32Array;
    const v = new Float32Array(px.length);
    for (let i = 0; i < px.length; i++) v[i] = (img.mask && !img.mask[i]) || bad(px[i], null) ? NaN : px[i];
    return { w: img.width, h: img.height, v, box: req };
  }
  const tiff = await fromArrayBuffer(buf);
  const img = await tiff.getImage();
  const nd = img.getGDALNoData();
  const [band] = (await img.readRasters({ interleave: false })) as unknown as ArrayLike<number>[];
  const v = new Float32Array(band.length);
  for (let i = 0; i < band.length; i++) v[i] = bad(band[i], nd) ? NaN : band[i];
  let box = req;
  try {
    box = img.getBoundingBox() as Box; // WCS 1.1 pads by half a pixel
  } catch {
    /* no georeferencing → assume it's exactly what we asked for */
  }
  return { w: img.getWidth(), h: img.getHeight(), v, box };
}

/** Nearest-neighbour sample of `src` onto a DEM_TILE grid covering `dst`. */
function toGrid(src: Raster, dst: Box, out: Float32Array) {
  const n = DEM_TILE;
  const sx = src.w / (src.box[2] - src.box[0]);
  const sy = src.h / (src.box[3] - src.box[1]);
  const px = (dst[2] - dst[0]) / n;
  for (let row = 0; row < n; row++) {
    const y = dst[3] - (row + 0.5) * px;
    const r = Math.floor((src.box[3] - y) * sy);
    if (r < 0 || r >= src.h) continue;
    for (let col = 0; col < n; col++) {
      const i = row * n + col;
      if (!Number.isNaN(out[i])) continue; // already filled by a better source
      const c = Math.floor((dst[0] + (col + 0.5) * px - src.box[0]) * sx);
      if (c >= 0 && c < src.w) out[i] = src.v[r * src.w + c];
    }
  }
}

/**
 * Fill NaN gaps in place by linear interpolation along rows and columns
 * (averaged where both exist). O(n). Returns the fallback for anything left.
 */
function fillHoles(g: Float32Array, n: number): number {
  const h = new Float32Array(g.length).fill(NaN);
  const v = new Float32Array(g.length).fill(NaN);
  const line = (src: Float32Array, dst: Float32Array, start: number, stride: number) => {
    let prev = -1;
    for (let k = 0; k < n; k++) {
      const i = start + k * stride;
      if (Number.isNaN(src[i])) continue;
      if (prev >= 0 && k - prev > 1) {
        const a = src[start + prev * stride], b = src[i];
        for (let m = prev + 1; m < k; m++) dst[start + m * stride] = a + ((b - a) * (m - prev)) / (k - prev);
      } else if (prev < 0) {
        for (let m = 0; m < k; m++) dst[start + m * stride] = src[i]; // leading edge
      }
      prev = k;
    }
    if (prev >= 0) for (let m = prev + 1; m < n; m++) dst[start + m * stride] = src[start + prev * stride];
  };
  for (let r = 0; r < n; r++) line(g, h, r * n, 1);
  for (let c = 0; c < n; c++) line(g, v, c, n);
  let min = Infinity;
  for (let i = 0; i < g.length; i++) if (g[i] < min) min = g[i];
  for (let i = 0; i < g.length; i++) {
    if (!Number.isNaN(g[i])) continue;
    const a = h[i], b = v[i];
    g[i] = Number.isNaN(a) ? (Number.isNaN(b) ? min : b) : Number.isNaN(b) ? a : (a + b) / 2;
  }
  return min;
}

function emptyTile(): ImageData {
  const out = new ImageData(DEM_TILE, DEM_TILE);
  encodeInto(out.data, 0, NODATA);
  for (let i = 4; i < out.data.length; i += 4) out.data.copyWithin(i, 0, 4);
  return out;
}

// Terrarium: elevation = R*256 + G + B/256 - 32768
function encodeInto(d: Uint8ClampedArray, o: number, v: number) {
  const e = Math.max(0, Math.min(65535.99, v + 32768));
  d[o] = Math.floor(e / 256);
  d[o + 1] = Math.floor(e) % 256;
  d[o + 2] = Math.floor((e % 1) * 256);
  d[o + 3] = 255;
}

async function loadDem(p: DemProvider, kind: DemKind, z: number, x: number, y: number, signal: AbortSignal) {
  // Fast path: Mapterhorn has the same public lidar pre-built as static CDN
  // tiles for much of the world. If it has a real tile at this zoom, use it and
  // skip the slow on-demand server entirely (bare earth only — no surface model there).
  if (kind === 'dtm' && MH_FAST) {
    const mh = await mhNative(z, x, y);
    if (mh) return finish(Float32Array.from(mh), p.id, z, x, y);
  }

  const size = WORLD / 2 ** z;
  const minx = -HALF + x * size;
  const maxy = HALF - y * size;
  const box: Box = [minx, maxy - size, minx + size, maxy];

  const n = DEM_TILE;
  const grid = new Float32Array(n * n).fill(NaN);
  let missing = grid.length;
  for (const url of p.urls(kind, box)) {
    if (missing < grid.length * 0.002) break; // good enough; don't fetch the fallback
    toGrid(await decode(await politeFetch(url, signal), p.format, box), box, grid);
    missing = 0;
    for (let i = 0; i < grid.length; i++) if (Number.isNaN(grid[i])) missing++;
  }
  return finish(grid, kind === 'dtm' ? p.id : null, z, x, y);
}

/** Fill holes, encode to Terrarium, and remember height samples for the colour stretch. */
function finish(grid: Float32Array, statsId: string | null, z: number, x: number, y: number): ImageData {
  const n = DEM_TILE;
  let missing = 0;
  for (let i = 0; i < grid.length; i++) if (Number.isNaN(grid[i])) missing++;
  // Mostly outside coverage → transparent tile. Otherwise interpolate across
  // holes (e.g. AHN cuts out every building from its bare-earth model) so
  // they read as ground, not pits; anything left gets the tile's lowest value.
  const valid = grid.length - missing;
  const fill = valid > grid.length * 0.02 ? (missing ? fillHoles(grid, n) : 0) : NODATA;

  const out = new ImageData(n, n);
  const step = Math.max(1, Math.floor(Math.sqrt(grid.length / 1024)));
  const samples: number[] = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const i = row * n + col;
      const ok = !Number.isNaN(grid[i]);
      if (ok && fill !== NODATA && row % step === 0 && col % step === 0) samples.push(grid[i]);
      encodeInto(out.data, i * 4, ok && fill !== NODATA ? grid[i] : fill);
    }
  }
  if (statsId) {
    stats.set(`${statsId}/${z}/${x}/${y}`, { provider: statsId, z, x, y, samples: Float32Array.from(samples) });
    if (stats.size > 600) stats.delete(stats.keys().next().value!);
  }
  return out;
}

// ---------- Mapterhorn: pre-built terrain tiles on a CDN ----------
// https://mapterhorn.com — open terrain merged from national lidar (US 3DEP,
// England, every German state, Scandinavia, Spain, Japan, …) over a 30 m
// global base, as 512 px Terrarium WebP. Each area stops at its native zoom
// (404 above it); there we upsample the deepest real ancestor ourselves.

const MH_URL = (z: number, x: number, y: number) => `https://tiles.mapterhorn.com/${z}/${x}/${y}.webp`;
export const MH_MAXZOOM = 17;
// Dev: ?nomh skips the fast path, for before/after timing.
const MH_FAST = !(import.meta.env.DEV && location.search.includes('nomh'));
const mhMissing = new Set<string>(); // tiles known to 404 (so their children do too)
const mhTiles = new Map<string, Promise<Float32Array | null>>();
const MH_CACHE = 24; // decoded float tiles are 1 MB each

let decodeCanvas: OffscreenCanvas | null = null;
async function decodeTerrarium(buf: ArrayBuffer): Promise<Float32Array> {
  const bmp = await createImageBitmap(new Blob([buf], { type: 'image/webp' }), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  const { width: w, height: h } = bmp;
  decodeCanvas ??= new OffscreenCanvas(w, h);
  if (decodeCanvas.width !== w || decodeCanvas.height !== h) {
    decodeCanvas.width = w;
    decodeCanvas.height = h;
  }
  const ctx = decodeCanvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const d = ctx.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h);
  for (let i = 0, o = 0; i < out.length; i++, o += 4) out[i] = d[o] * 256 + d[o + 1] + d[o + 2] / 256 - 32768;
  return out;
}

const mhKnownMissing = (z: number, x: number, y: number) => {
  for (let k = 0; k <= z; k++) if (mhMissing.has(`${z - k}/${x >> k}/${y >> k}`)) return true;
  return false;
};

/** The real Mapterhorn tile at z/x/y, or null if it doesn't go that deep here. */
function mhNative(z: number, x: number, y: number): Promise<Float32Array | null> {
  if (z > MH_MAXZOOM || mhKnownMissing(z, x, y)) return Promise.resolve(null);
  const key = `${z}/${x}/${y}`;
  let t = mhTiles.get(key);
  if (t) {
    mhTiles.delete(key); // refresh LRU position
  } else {
    // Not cancellable: these are quick CDN hits, and siblings reuse the parent.
    t = politeFetch(MH_URL(z, x, y), new AbortController().signal).then(decodeTerrarium, (e) => {
      if (/HTTP 404/.test(String(e))) mhMissing.add(key);
      mhTiles.delete(key);
      return null;
    });
    if (mhTiles.size >= MH_CACHE) mhTiles.delete(mhTiles.keys().next().value!);
  }
  mhTiles.set(key, t);
  return t;
}

/** Bilinear upsample of the part of an ancestor tile (k levels up) that covers this tile. */
function upsample(src: Float32Array, k: number, ox: number, oy: number): Float32Array {
  const n = DEM_TILE;
  const f = 2 ** k;
  const out = new Float32Array(n * n);
  const at = (c: number, r: number) =>
    src[Math.min(n - 1, Math.max(0, r)) * n + Math.min(n - 1, Math.max(0, c))];
  for (let row = 0; row < n; row++) {
    const sy = (oy * n + row + 0.5) / f - 0.5;
    const y0 = Math.floor(sy), fy = sy - y0;
    for (let col = 0; col < n; col++) {
      const sx = (ox * n + col + 0.5) / f - 0.5;
      const x0 = Math.floor(sx), fx = sx - x0;
      const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
      const bot = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
      out[row * n + col] = top * (1 - fy) + bot * fy;
    }
  }
  return out;
}

async function loadMh(z: number, x: number, y: number): Promise<ImageData> {
  for (let k = 0; k <= Math.min(z, 8); k++) {
    const t = await mhNative(z - k, x >> k, y >> k);
    if (!t) continue;
    const grid = k === 0 ? Float32Array.from(t) : upsample(t, k, x - ((x >> k) << k), y - ((y >> k) << k));
    return finish(grid, 'mh', z, x, y);
  }
  return emptyTile();
}

// Small LRU so sources sharing tiles (hillshade, terrain, swipe overlay) share
// one download. Downloads are ref-counted: cancelled once no map request wants them.
interface Entry {
  p: Promise<ImageData>;
  ctrl: AbortController;
  refs: number;
  done: boolean;
}
const cache = new Map<string, Entry>();
const CACHE_MAX = 48;

const tileLngLat = (z: number, x: number, y: number) => {
  const n = 2 ** z;
  const lat = (t: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * t) / n))) * 180) / Math.PI;
  return { w: (x / n) * 360 - 180, e: ((x + 1) / n) * 360 - 180, n: lat(y), s: lat(y + 1) };
};

const bitmap = (d: ImageData) => createImageBitmap(d, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });

/** Share one in-flight load per tile between every map request for it. */
async function serve(key: string, signal: AbortSignal, load: (s: AbortSignal) => Promise<ImageData>) {
  let entry = cache.get(key);
  if (!entry) {
    const ctrl = new AbortController();
    const e: Entry = { ctrl, refs: 0, done: false, p: load(ctrl.signal) };
    e.p.then(
      () => (e.done = true),
      () => cache.get(key) === e && cache.delete(key),
    );
    entry = e;
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  } else {
    cache.delete(key); // refresh LRU position
  }
  cache.set(key, entry);
  const e = entry;
  e.refs++;
  const onAbort = () => {
    if (--e.refs === 0 && !e.done) {
      e.ctrl.abort();
      if (cache.get(key) === e) cache.delete(key);
    }
  };
  signal.addEventListener('abort', onAbort, { once: true });
  let data: ImageData;
  try {
    data = await Promise.race([
      e.p,
      new Promise<never>((_, reject) =>
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))),
      ),
    ]);
  } finally {
    if (!signal.aborted) {
      e.refs--;
      signal.removeEventListener('abort', onAbort);
    }
  }
  return { data: await bitmap(data) };
}

/** dem://{provider}/{dtm|dsm}/{z}/{x}/{y} */
maplibregl.addProtocol('dem', async (params, abort) => {
  const [pid, kind, ...zxy] = params.url.replace('dem://', '').split('/');
  const [z, x, y] = zxy.map(Number);
  const p = DEM_PROVIDERS.find((d) => d.id === pid)!;
  const t = tileLngLat(z, x, y);
  if (p.skip?.(t.w, t.s, t.e, t.n)) return { data: await bitmap(emptyTile()) };
  return serve(params.url, abort.signal, (s) => loadDem(p, kind as DemKind, z, x, y, s));
});

/** mh://{z}/{x}/{y} — Mapterhorn, upsampled past its native zoom. */
maplibregl.addProtocol('mh', async (params, abort) => {
  const [z, x, y] = params.url.replace('mh://', '').split('/').map(Number);
  return serve(params.url, abort.signal, () => loadMh(z, x, y));
});

/** Fraction of loaded bare-earth samples near a point that came back valid, per provider. */
export function hasDataAt(providerId: string, lng: number, lat: number): boolean {
  let best: TileStats | null = null;
  const fx = (lng + 180) / 360;
  const fy = (1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2;
  for (const t of stats.values()) {
    if (t.provider !== providerId) continue;
    const n = 2 ** t.z;
    if (Math.floor(fx * n) !== t.x || Math.floor(fy * n) !== t.y) continue;
    if (!best || t.z > best.z) best = t;
  }
  return !!best && best.samples.length > 50;
}
