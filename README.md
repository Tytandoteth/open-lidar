# Open Lidar

Search any place, then flip from satellite to bare-earth lidar to see what's under the trees.

**Live:** [open-lidar.vercel.app](https://open-lidar.vercel.app) · **Story:** [tyblackard.com/openlidar](https://tyblackard.com/openlidar)

Inspired by [pietromiotti.com/latest/maya-site](https://pietromiotti.com/latest/maya-site/).

## Run it

Needs Node 20+. No API keys.

```bash
npm install
npm run dev
```

`npm run build` type-checks and writes a static site to `dist/`. `api/tile.ts` is an optional Vercel function that proxies a short allowlist of tile servers that lack CORS headers.

## How it works

| Region | Source | Resolution | Rendering |
|---|---|---|---|
| Worldwide (first choice) | [Mapterhorn](https://mapterhorn.com) pre-built Terrarium WebP tiles on a CDN: national lidar for the US, England, all of Germany, Scandinavia, Spain, Japan and more, ~30 m elsewhere | up to 0.25–1 m | Client-side; upsampled in float past each area's native zoom |
| United States | USGS 3DEP ImageServer (raw elevation as LERC) | up to 1 m | Client-side: decoded in the browser, then hillshade, height colours and 3D terrain on the GPU. Only fetched where Mapterhorn has no tile |
| England | Environment Agency lidar, via Mapterhorn | 1 m | Client-side (the slow EA WMS is no longer used) |
| Netherlands | AHN via PDOK WCS (raw GeoTIFF) | 0.5 m | Client-side, bare earth + surface model |
| France | IGN LiDAR HD, gaps filled from RGE ALTI (WMS-R raw GeoTIFF) | 0.5 m / 1 m | Client-side, bare earth + surface model |
| Switzerland | swisstopo swissALTI3D (WMTS) | 0.5 m | Server hillshade |
| Flanders, Belgium | Digitaal Vlaanderen DHMV II (WMS) | 0.25 m | Server hillshade |
| Germany | State DGM1 models, via Mapterhorn | 1 m | Client-side |
| Norway | Kartverket national elevation model, via Mapterhorn | 1 m | Client-side |
| Canada | NRCan HRDEM mosaic (WCS raw GeoTIFF) | 1–2 m | Client-side, bare earth + surface model; slope from server |

- **Speed:** every bare-earth tile tries Mapterhorn first (a static CDN, ~0.2–0.5 s per tile). The slow on-demand servers (USGS, IGN, PDOK, NRCan) are only asked for tiles Mapterhorn doesn't have at that zoom, and for surface models. In dev, add `?nomh` to the URL to time the old path.
- **Site pins:** registered US sites from the National Park Service's National Register of Historic Places, plus Wikidata's archaeological sites. Click a pin for details, Wikipedia and NRHP nomination links, and a jump to its lidar. Site names also show up in search. Rebuild with `node scripts/build-sites.mjs`. NPS withholds restricted archaeological locations, so only public ones appear.
- **Europe:** every site Wikidata classes as archaeological, by country. Wikidata imports the national registers (Historic England, Mérimée, Rijksmonumenten, Fornsök, …), and popups link to the official entry. Notable sites (an English Wikipedia article or 3+ Wikipedias) show at every zoom; the rest load in 1° cells from zoom 8. Rebuild with `node scripts/build-sites-eu.mjs [country codes]`.
- A progress bar at the top counts lidar tile downloads for the current view and notes when USGS is busy and tiles are being retried.
- **Swipe + 3D**: the lidar side shows bare earth; the satellite side is draped over the *surface* model (buildings, trees) where the country publishes one (France, Netherlands, Canada), so you can compare what stands there today with the ground beneath. The US only publishes bare earth.
- `src/dem.ts`: per-host request limiter, retries for USGS's intermittent 5xx errors, LERC decoding into Terrarium tiles, and per-tile elevation samples.
- **Height** mode stretches the colour ramp across the elevation range of what's on screen (0.5–99.7th percentile), so a 3 m earthwork stands out as much as a mountain would.
- **Relief depth** controls hillshade strength and 3D exaggeration. **Sun angle** rotates the light.
- Search suggests featured places and heritage sites locally. Submit a search to request remote place results, or paste `lat, lon` to jump directly.
- Remote search uses public OpenStreetMap Nominatim by default for light use. The browser caches repeated queries during a session and spaces requests at least 1.1 seconds apart per tab. Configure `VITE_GEOCODER_URL` with a hosted or self-managed Nominatim-compatible HTTPS search endpoint before a high-traffic rollout. See the [public service policy](https://operations.osmfoundation.org/policies/nominatim/).
- Featured places open in Compare mode. Use **Share view** to copy or send the current camera and display settings. A featured landing page can link to `/?place=cahokia-mounds`.
- Keys: `1`/`2`/`3` switch mode, `L` toggles satellite/lidar, `/` focuses search.

## Data and credits

Code is MIT. The data stays under its own terms:

- Elevation: [Mapterhorn](https://mapterhorn.com) (see its per-source attribution), USGS 3DEP (public domain), Environment Agency (OGL), AHN/PDOK (CC0), IGN (Etalab Open Licence), swisstopo, Digitaal Vlaanderen, Kartverket (CC BY 4.0), NRCan (OGL-Canada).
- Imagery and labels: Esri World Imagery and World Boundaries and Places, under Esri's terms. Place search: OpenStreetMap Nominatim (ODbL).
- Sites: National Register of Historic Places, National Park Service (public domain); [Wikidata](https://www.wikidata.org) (CC0).
- Map rendering: [MapLibre GL JS](https://maplibre.org) (BSD-3-Clause).

The in-map attribution control lists the sources for the current view.

## Contributing

Issues and pull requests welcome. Please run `npm run build` before opening a PR.

## Author

Made by Ty Blackard: [tyblackard.com](https://tyblackard.com) · [TikTok @ty.prompts.ai](https://www.tiktok.com/@ty.prompts.ai) · [X @TyPrompts](https://x.com/TyPrompts) · [GitHub](https://github.com/Tytandoteth)
