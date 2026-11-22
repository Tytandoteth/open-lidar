// European archaeological sites → public/sites/eu/
//   node scripts/build-sites-eu.mjs [country codes…]   (default: all)
//
// Europe has no single register, so this pulls every item Wikidata classes as
// an archaeological site (or a subclass: barrows, hillforts, henges, …) per
// country. Wikidata imports the national registers (Historic England's list,
// France's Mérimée, the Dutch Rijksmonumenten, German state lists, Sweden's
// Fornsök, …), and we keep those reference numbers for links to the official
// entry.
//
// Re-running resumes from scripts/.cache/eu/; pass country codes to refetch them.
//
// Output (too big for one file — ~200k sites):
//   eu/notable.json         sites with an English Wikipedia article or ≥3
//                           Wikipedias; shown at every zoom
//   eu/cells/{x}_{y}.json   everything else, in 1° cells; loaded as you zoom in
//   eu/index.json           which cells exist
// Rows are compact arrays: [lng, lat, name, description, wikipedia, wikidataId, registerUrl]

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

// Country → [Wikidata id, label languages tried in order after English].
const COUNTRIES = {
  gb: ['Q145', 'en'], ie: ['Q27', 'ga'], fr: ['Q142', 'fr'], de: ['Q183', 'de'], nl: ['Q55', 'nl'],
  be: ['Q31', 'nl,fr'], lu: ['Q32', 'fr,lb'], ch: ['Q39', 'de,fr,it'], at: ['Q40', 'de'], it: ['Q38', 'it'],
  es: ['Q29', 'es,ca'], pt: ['Q45', 'pt'], dk: ['Q35', 'da'], se: ['Q34', 'sv'], no: ['Q20', 'nb,nn'],
  fi: ['Q33', 'fi,sv'], is: ['Q189', 'is'], pl: ['Q36', 'pl'], cz: ['Q213', 'cs'], sk: ['Q214', 'sk'],
  hu: ['Q28', 'hu'], si: ['Q215', 'sl'], hr: ['Q224', 'hr'], gr: ['Q41', 'el'], mt: ['Q233', 'mt'],
  ee: ['Q191', 'et'], lv: ['Q211', 'lv'], lt: ['Q37', 'lt'], ro: ['Q218', 'ro'], bg: ['Q219', 'bg'],
  rs: ['Q403', 'sr'], ba: ['Q225', 'bs,hr,sr'], me: ['Q236', 'sr'], al: ['Q222', 'sq'], mk: ['Q221', 'mk'],
  cy: ['Q229', 'el,tr'], ua: ['Q212', 'uk'], md: ['Q217', 'ro'], by: ['Q184', 'be,ru'], ad: ['Q228', 'ca'],
  sm: ['Q238', 'it'], li: ['Q347', 'de'], mc: ['Q235', 'fr'],
};

// National register ids on Wikidata → link to the official entry.
const REGISTERS = {
  P1216: (id) => `https://historicengland.org.uk/listing/the-list/list-entry/${id}`, // England (NHLE)
  P380: (id) => `https://www.pop.culture.gouv.fr/notice/merimee/${id}`, // France (Mérimée)
  P359: (id) => `https://monumentenregister.cultureelerfgoed.nl/monumenten/${id}`, // Netherlands
  P1260: (id) => `https://kulturarvsdata.se/${id}`, // Sweden (KMR / Fornsök)
  P709: (id) => `https://portal.historicenvironment.scot/designation/${id}`, // Scotland (Historic Scotland)
  P1459: (id) => `https://coflein.gov.uk/en/site/${id}`, // Wales (Coflein)
  P2783: (id) => `https://www.kulturarv.dk/fundogfortidsminder/Lokalitet/${id}/`, // Denmark
  P4009: (id) => `https://www.kulturminnesok.no/kulturminnesok/kulturminne/?LOKALID=${id}`, // Norway (Askeladden)
};

const UA = 'open-lidar-site-pins/1.0 (https://open-lidar.vercel.app)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Step 1 (cheap): ids + coordinates. Step 2: details for batches of ids. Asking
// for labels and register ids in the same query as the subclass search times
// out for the big countries (Germany, Sweden, UK).
const idsQuery = (qid) => `SELECT ?item ?coord WHERE {
  ?item wdt:P17 wd:${qid} ; wdt:P31/wdt:P279* wd:Q839954 ; wdt:P625 ?coord .
}`;
const detailQuery = (ids, langs) => `SELECT ?item ?itemLabel ?itemDescription ?ldesc ?tlabel ?enwiki ?links ${Object.keys(REGISTERS).map((p) => `?${p}`).join(' ')} WHERE {
  VALUES ?item { ${ids.map((id) => `wd:${id}`).join(' ')} }
  ?item wikibase:sitelinks ?links .
  OPTIONAL { ?enwiki schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
  OPTIONAL { ?item schema:description ?ldesc FILTER(LANG(?ldesc) = "${langs.split(',')[0]}") }
  OPTIONAL { ?item wdt:P31 ?t . ?t rdfs:label ?tlabel FILTER(LANG(?tlabel) = "en") }
  ${Object.keys(REGISTERS).map((p) => `OPTIONAL { ?item wdt:${p} ?${p} }`).join('\n  ')}
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul,${langs}". }
}`;

async function run(query) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch('https://query.wikidata.org/sparql', {
      method: 'POST',
      headers: { Accept: 'application/sparql-results+json', 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ query }),
      signal: AbortSignal.timeout(75_000),
    }).catch((e) => ({ ok: false, status: 0, e }));
    if (res.ok) {
      try {
        return JSON.parse(await res.text()).results.bindings;
      } catch {
        // Dropped connection mid-body, or a timeout that arrived as a truncated 200.
        await sleep(5000);
        continue;
      }
    }
    if (res.status === 429) {
      await sleep((Number(res.headers.get('retry-after')) || 30) * 1000);
      continue;
    }
    return null; // timeout / 5xx → caller splits the query
  }
  return null;
}

/** All of a country's sites: coordinates first, then details 1,000 ids at a time. */
async function fetchCountry(code) {
  const [qid, langs] = COUNTRIES[code];
  const base = await run(idsQuery(qid));
  if (!base) {
    console.warn(`  ${code}: id query failed`);
    return [];
  }
  const coords = new Map();
  for (const b of base) {
    const id = b.item.value.split('/').pop();
    if (!coords.has(id)) coords.set(id, b.coord.value);
  }
  const ids = [...coords.keys()];
  const rows = [];
  for (let i = 0; i < ids.length; i += 1000) {
    let batch = await run(detailQuery(ids.slice(i, i + 1000), langs));
    if (!batch) {
      await sleep(5000);
      batch = await run(detailQuery(ids.slice(i, i + 1000), langs));
    }
    if (!batch) {
      console.warn(`  ${code}: details failed for ${i}–${i + 1000}`);
      continue;
    }
    for (const b of batch) rows.push({ ...b, coord: { value: coords.get(b.item.value.split('/').pop()) } });
    await sleep(300);
  }
  return rows;
}

// Bulk-imported register entries are often labelled only by their number
// ("Cultural heritage D-1-7534-0162 in Petershausen"); their real content is
// the local-language description and the type.
const GENERIC_NAME = /^(cultural heritage|bodendenkmal|kulturdenkmal|baudenkmal|fornlämning|fortidsminne|scheduled monument)\b|#?[A-Z]-\d-\d{4}-\d{4}|^[A-Z]{1,4}[ -]?\d{3,}$/i;
const GENERIC_DESC = /^(cultural heritage monument|archaeological site|ground monument|heritage site)\b/i;
const GENERIC_TYPE = /^(archaeological site|cultural heritage|cultural property|monument|heritage site|ground monument|ancient monument|scheduled monument)$/i;
const PERIOD = /age\b|period|neolith|mesolith|palaeolith|paleolith|roman|celtic|la t[eè]ne|hallstatt|urnfield|medieval|viking|iron|bronze|copper/i;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const placeOf = (desc) => desc?.match(/\bin (.+)$/)?.[1]?.replace(/, Germany$/, '') ?? '';

const short = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s ?? '');

// Each country is saved under scripts/.cache/eu/ as it finishes, so a failed
// run resumes where it stopped. Pass country codes to refetch just those.
const CACHE_DIR = 'scripts/.cache/eu';
await mkdir(CACHE_DIR, { recursive: true });
const refetch = new Set(process.argv.slice(2));
const sites = new Map(); // wikidata id → row + notability
for (const code of Object.keys(COUNTRIES)) {
  const file = `${CACHE_DIR}/${code}.json`;
  if (!refetch.has(code)) {
    try {
      for (const [id, s] of JSON.parse(await readFile(file, 'utf8'))) if (!sites.has(id)) sites.set(id, s);
      continue;
    } catch {
      // not fetched yet
    }
  }
  const t0 = Date.now();
  const rows = await fetchCountry(code);
  const mine = new Map();
  let added = 0;
  for (const b of rows) {
    const id = b.item.value.split('/').pop();
    const name = b.itemLabel?.value ?? '';
    if (/^Q\d+$/.test(name)) continue; // no usable label
    const m = b.coord.value.match(/Point\(([-\d.eE]+) ([-\d.eE]+)\)/);
    if (!m) continue;
    let s = (mine.get(id) ?? sites.get(id));
    if (!s) {
      const enDesc = b.itemDescription?.value ?? '';
      const local = b.ldesc?.value ?? '';
      let desc = enDesc && !GENERIC_DESC.test(enDesc) ? enDesc : local || enDesc;
      if (desc === local && local && placeOf(enDesc)) desc = `${local} · ${placeOf(enDesc)}`;
      s = {
        row: [+(+m[1]).toFixed(5), +(+m[2]).toFixed(5), name, short(desc, 160), '', id, ''],
        notable: false,
        generic: GENERIC_NAME.test(name),
      };
      mine.set(id, s);
      sites.set(id, s);
      added++;
    }
    // Swap a register-number label for the site's type ("Stone Age site", "Barrow", …),
    // preferring the most specific one, i.e. one that names a period.
    const type = b.tlabel?.value;
    if ((s.generic || s.typed) && type && !GENERIC_TYPE.test(type)) {
      const score = PERIOD.test(type) ? 2 : 1;
      if (score > (s.typeScore ?? 0)) {
        s.row[2] = cap(type);
        s.typeScore = score;
        s.typed = true;
        s.generic = false;
      }
    }
    if (b.enwiki) s.row[4] = b.enwiki.value.replace('https://en.wikipedia.org/wiki/', '');
    s.notable ||= !!b.enwiki || Number(b.links?.value) >= 3;
    if (!s.row[6]) {
      for (const [p, url] of Object.entries(REGISTERS)) {
        if (b[p]) {
          s.row[6] = url(b[p].value);
          break;
        }
      }
    }
  }
  await writeFile(file, JSON.stringify([...mine]));
  console.log(`${code}: ${added} sites (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  await sleep(1500);
}

const out = 'public/sites/eu';

await rm(out, { recursive: true, force: true });
await mkdir(`${out}/cells`, { recursive: true });
const notable = [];
const cells = new Map();
// Register-number names (Sweden's "Håtuna 23:1", Denmark's "Fredningsnr. …"):
// lead with the type from the description, keep the number in brackets.
const NUMBERED = /^[\p{L} .-]+ \d+:\d+$|^[\p{L}.]+ ?\d[\d.-]*$/u;
for (const { row } of sites.values()) {
  const type = row[3].match(/^([^·,]+?) in /)?.[1];
  if (NUMBERED.test(row[2]) && type && !GENERIC_DESC.test(type) && type.length < 40) {
    row[2] = `${cap(type)} (${row[2]})`;
  }
}
for (const { row, notable: n } of sites.values()) {
  if (n) {
    notable.push(row);
    continue;
  }
  const key = `${Math.floor(row[0])}_${Math.floor(row[1])}`;
  if (!cells.has(key)) cells.set(key, []);
  cells.get(key).push(row);
}
await writeFile(`${out}/notable.json`, JSON.stringify(notable));
for (const [k, rows] of cells) await writeFile(`${out}/cells/${k}.json`, JSON.stringify(rows));
await writeFile(`${out}/index.json`, JSON.stringify(Object.fromEntries([...cells].map(([k, r]) => [k, r.length]))));
console.log(`${sites.size} sites: ${notable.length} notable, ${sites.size - notable.length} in ${cells.size} cells`);
