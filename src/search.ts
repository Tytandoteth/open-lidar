// Search only on explicit user submission. See the Nominatim usage policy.

export interface Place {
  label: string;
  sub: string;
  lng: number;
  lat: number;
  /** [west, south, east, north] when the result is an area. */
  bbox?: [number, number, number, number];
}

const COORDS = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/;

/** "38.66, -90.06" → a Place, so people can jump straight to coordinates. */
export function parseCoords(q: string): Place | null {
  const m = q.match(COORDS);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { label: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, sub: 'Coordinates', lat, lng };
}

interface NominatimHit {
  display_name: string;
  name?: string;
  lat: string;
  lon: string;
  boundingbox?: [string, string, string, string]; // south, north, west, east
  type?: string;
}

const cached = new Map<string, Place[]>();
let nextRequest = 0;

export async function searchPlaces(q: string, signal: AbortSignal): Promise<Place[]> {
  const key = q.toLowerCase();
  signal.throwIfAborted();
  const previous = cached.get(key);
  if (previous) return previous;
  const now = Date.now();
  if (now < nextRequest) throw new Error('Geocoder is busy');
  nextRequest = now + 1100;

  // Use a hosted or self-managed Nominatim-compatible endpoint for higher traffic.
  const url = new URL(import.meta.env.VITE_GEOCODER_URL || 'https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('q', q);
  url.searchParams.set('limit', '6');
  const res = await fetch(url, { signal, headers: { 'Accept-Language': navigator.language || 'en' } });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const hits = (await res.json()) as NominatimHit[];
  const places = hits.map((h): Place => {
    const [first, ...rest] = h.display_name.split(', ');
    const b = h.boundingbox?.map(Number);
    return {
      label: h.name || first,
      sub: rest.join(', '),
      lat: Number(h.lat),
      lng: Number(h.lon),
      bbox: b ? [b[2], b[0], b[3], b[1]] : undefined,
    };
  });
  if (cached.size >= 100) cached.delete(cached.keys().next().value!);
  cached.set(key, places);
  return places;
}
