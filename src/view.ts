import { PRESETS, type LidarStyle } from './sources';

export type Mode = 'satellite' | 'lidar' | 'swipe';

export const featuredId = (name: string) => name.toLowerCase().replaceAll(' ', '-').replaceAll('.', '');

function number(params: URLSearchParams, key: string, min: number, max: number) {
  const raw = params.get(key);
  if (!raw?.trim()) return undefined;
  const value = Number(raw);
  if (Number.isFinite(value) && value >= min && value <= max) return value;
}

export function readView(url: URL) {
  const p = url.searchParams;
  const preset = PRESETS.find((place) => featuredId(place.name) === p.get('place'));
  const mode = p.get('mode');
  const style = p.get('style');
  const lat = number(p, 'lat', -90, 90);
  const lng = number(p, 'lng', -180, 180);
  const zoom = number(p, 'zoom', 0, 22);
  const camera = lat !== undefined && lng !== undefined && zoom !== undefined ? {
    center: [lng, lat] as [number, number],
    zoom,
    bearing: number(p, 'bearing', -180, 180) ?? 0,
    pitch: number(p, 'pitch', 0, 80) ?? 0,
    roll: number(p, 'roll', -180, 180) ?? 0,
  } : undefined;
  return {
    preset,
    camera,
    mode: (mode === 'satellite' || mode === 'lidar' ? mode : 'swipe') as Mode,
    style: (style === 'tinted' || style === 'slope' ? style : 'hillshade') as LidarStyle,
    swipePct: number(p, 'divider', 0, 100) ?? 50,
    depth: number(p, 'depth', 0, 1) ?? 0.7,
    sun: number(p, 'sun', 0, 359) ?? 315,
    labels: p.get('labels') !== '0',
    coverage: p.get('coverage') === '1',
    terrain: p.get('terrain') === '1',
    sites: p.get('sites') !== '0',
    historic: p.get('historic') === '1',
  };
}
