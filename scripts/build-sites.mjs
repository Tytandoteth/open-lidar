// Pulls key sites from the US National Register of Historic Places (NPS) into
// public/sites/us-nrhp.geojson, which the map shows as clickable pins.
//   node scripts/build-sites.mjs
// NPS only publishes non-restricted locations; sensitive archaeology is withheld.
import { writeFile } from 'node:fs/promises';

const SERVICE = 'https://mapservices.nps.gov/arcgis/rest/services/cultural_resources/nrhp_locations/MapServer';
// Layer 0: points. Layer 1: boundary polygons — most major earthworks (Cahokia, Serpent Mound…) are only here.
const LAYERS = [0, 1];
const ARCH = /mounds?\b|earthwork|archaeolog|archeolog|pueblo|petroglyph|pictograph|rock art|rock ?shelter|cliff dwelling|ruins?\b|village site|town site|camp site|midden|shell ring|effigy|kiva|quarry site|intaglio|geoglyph|works\b|\(\d{1,2}[A-Z]{1,2}\d+\)|fort ancient|hopewell|adena|mississippian|indian (village|town|fort)/i;
const BATTLE = /battlefield|battle of|battleground/i;
const KEYWORDS = ['Mound', 'Earthwork', 'Archaeolog', 'Archeolog', 'Pueblo', 'Petroglyph', 'Pictograph', 'Rock Art', 'Shelter', 'Ruin', 'Village', 'Midden', 'Shell Ring', 'Effigy', 'Cliff Dwelling', 'Site'];

async function query(layer, where) {
  const out = [];
  const page = layer ? 500 : 2000; // polygons are heavier
  for (let offset = 0; ; offset += page) {
    const u = new URL(`${SERVICE}/${layer}/query`);
    Object.entries({
      where, outFields: 'RESNAME,ResType,City,County,State,Vicinity,NRIS_Refnum,CertDate,NARA_URL,Is_NHL',
      returnGeometry: 'true', outSR: '4326', maxAllowableOffset: '0.0005', geometryPrecision: '5',
      resultOffset: String(offset), resultRecordCount: String(page), f: 'json',
    }).forEach(([k, v]) => u.searchParams.set(k, v));
    const r = await fetch(u);
    if (!r.ok) throw new Error(`${r.status} ${where}`);
    const d = await r.json();
    out.push(...d.features);
    if (!d.exceededTransferLimit) break;
  }
  return out;
}

// Wikidata: every US item that is (a subclass of) "archaeological site", with
// its NRHP number and Wikipedia article. Used to (a) mark NRHP listings as
// archaeology even when the name doesn't say so (Moundville, Poverty Point) and
// (b) add well-documented sites whose NRHP location is restricted or missing.
const SPARQL = `SELECT DISTINCT ?item ?itemLabel ?itemDescription ?coord ?nrhp ?article WHERE {
  ?item wdt:P31/wdt:P279* wd:Q839954 ; wdt:P17 wd:Q30 .
  OPTIONAL { ?item wdt:P625 ?coord }
  OPTIONAL { ?item wdt:P649 ?nrhp }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;
const wd = await fetch(`https://query.wikidata.org/sparql?query=${encodeURIComponent(SPARQL)}`, {
  headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'open-lidar-site-pins/1.0' },
}).then((r) => r.json());
const wdByRef = new Map();
const wdItems = new Map();
for (const b of wd.results.bindings) {
  const id = b.item.value.split('/').pop();
  const it = wdItems.get(id) ?? { id, name: b.itemLabel?.value ?? '', desc: b.itemDescription?.value ?? '', coord: null, refs: new Set(), wiki: '' };
  const m = b.coord?.value.match(/Point\(([-\d.]+) ([-\d.]+)\)/);
  if (m && !it.coord) it.coord = [+(+m[1]).toFixed(5), +(+m[2]).toFixed(5)];
  if (b.nrhp) it.refs.add(b.nrhp.value);
  if (b.article && !it.wiki) it.wiki = b.article.value;
  wdItems.set(id, it);
}
for (const it of wdItems.values()) for (const r of it.refs) wdByRef.set(r, it);

const title = (s) => (s ?? '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const likes = KEYWORDS.map((k) => `UPPER(RESNAME) LIKE '%${k.toUpperCase()}%'`).join(' OR ');
const raw = [];
for (const layer of LAYERS) {
  raw.push(...(await query(layer, `ResType='site'`)), ...(await query(layer, `ResType<>'site' AND (${likes})`)));
}

/** Point or polygon → centre point and [w, s, e, n] extent. */
function locate(g) {
  if (!g) return null;
  if (Number.isFinite(g.x)) return { c: [g.x, g.y], bbox: null };
  const pts = (g.rings ?? []).flat();
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return { c: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2], bbox };
}

const seen = new Set();
const features = [];
for (const f of raw) {
  const a = f.attributes;
  const loc = locate(f.geometry);
  if (!loc || seen.has(a.NRIS_Refnum)) continue;
  const [x, y] = loc.c;
  const name = a.RESNAME ?? '';
  const w = wdByRef.get(a.NRIS_Refnum);
  const arch = !!w || ARCH.test(name) && !/house|church|school|bank|hotel|hall|store|bridge|cemetery|plantation|mill\b|depot|hospital|shipwreck|mine\b|smelter/i.test(name);
  const kind = arch ? 'archaeology' : BATTLE.test(name) ? 'battlefield' : a.ResType === 'site' ? 'historic' : null;
  if (!kind) continue; // keyword hit on an ordinary building, e.g. "Mound Bayou Bank"
  seen.add(a.NRIS_Refnum);
  features.push({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [+x.toFixed(5), +y.toFixed(5)] },
    properties: {
      name,
      kind,
      place: [a.City, a.County && `${title(a.County)} County`, title(a.State)].filter(Boolean).join(', '),
      ref: a.NRIS_Refnum,
      year: (a.CertDate ?? '').slice(0, 4),
      nara: a.NARA_URL ?? '',
      nhl: a.Is_NHL === 'Y' ? 1 : 0,
      desc: w?.desc ?? '',
      wiki: w?.wiki ?? '',
      ...(loc.bbox && { bbox: loc.bbox.map((v) => +v.toFixed(5)).join(',') }),
    },
  });
}
// Wikidata-only sites (NRHP location restricted, unlisted, or not mapped by NPS).
let extra = 0;
for (const it of wdItems.values()) {
  if (!it.coord || /^Q\d+$/.test(it.name) || [...it.refs].some((r) => seen.has(r))) continue;
  extra++;
  features.push({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: it.coord },
    properties: { name: it.name, kind: 'archaeology', place: '', ref: [...it.refs][0] ?? '', year: '', nara: '', nhl: 0, desc: it.desc, wiki: it.wiki, wd: it.id },
  });
}
console.log(`${wdItems.size} Wikidata archaeological sites, ${extra} added that NPS doesn't map`);
await writeFile('public/sites/us-nrhp.geojson', JSON.stringify({ type: 'FeatureCollection', features }));
const count = (k) => features.filter((f) => f.properties.kind === k).length;
console.log(`${features.length} sites: ${count('archaeology')} archaeology, ${count('battlefield')} battlefields, ${count('historic')} other historic sites`);
