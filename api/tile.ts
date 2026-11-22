// Caching tile proxy: /api/tile?u=<encoded upstream URL>
//
// Several lidar servers are slow (USGS renders each tile on demand, 1–10 s) or
// send no cache headers (PDOK, NRCan). Routing them through here lets Vercel's
// CDN keep every tile, so once anyone has viewed an area it's instant for all.
//
// Only the exact endpoints below are allowed, so this can't be used as an open
// proxy. Keep in sync with PROXIED in src/dem.ts.

const ALLOWED = [
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?',
  'https://index.nationalmap.gov/arcgis/rest/services/3DEPElevationIndex/MapServer/export?',
  'https://data.geopf.fr/wms-r?',
  'https://service.pdok.nl/rws/ahn/wcs/v1_0?',
  'https://service.pdok.nl/rws/ahn/wms/v1_0?',
  'https://datacube.services.geo.ca/wrapper/ogc/elevation-hrdem-mosaic?',
  'https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wms?',
  'https://geo.api.vlaanderen.be/DHMV/wms?',
  'https://www.wms.nrw.de/geobasis/wms_nw_dgm-schummerung?',
  'https://wms.geonorge.no/skwms1/wms.hoyde-dtm-nhm-25833?',
];

const MAX_BYTES = 4_400_000; // Vercel function responses are capped at 4.5 MB
const OK_TYPES = /^(image\/|application\/octet-stream)/;

const fail = (status: number, msg: string) =>
  new Response(msg, { status, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' } });

export async function GET(request: Request): Promise<Response> {
  const target = new URL(request.url).searchParams.get('u');
  if (!target || !ALLOWED.some((p) => target.startsWith(p))) return fail(400, 'URL not allowed');

  // The servers fail intermittently under load; retry here so the browser doesn't have to.
  let lastStatus = 502;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(target, { signal: AbortSignal.timeout(25_000) });
      const type = res.headers.get('content-type') ?? 'application/octet-stream';
      if (res.ok && OK_TYPES.test(type)) {
        const body = await res.arrayBuffer();
        if (body.byteLength > MAX_BYTES) return fail(502, 'Tile too large');
        return new Response(body, {
          headers: {
            'Content-Type': type,
            // Browser: a week. Vercel CDN: a year (lidar surveys don't change).
            'Cache-Control': 'public, max-age=604800',
            'CDN-Cache-Control': 'public, s-maxage=31536000, stale-while-revalidate=604800',
          },
        });
      }
      lastStatus = res.status;
      // Error pages (WMS exceptions come back as XML with status 200) or 4xx: don't retry.
      if (res.ok || res.status < 500) return fail(res.ok ? 502 : res.status, 'Upstream error');
    } catch {
      lastStatus = 504;
    }
    await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
  }
  return fail(lastStatus, 'Upstream unavailable');
}
