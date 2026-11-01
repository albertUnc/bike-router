// GPX 1.1 export: the routed line as a track, the stops as waypoints. Pure text generation.
import { defaultLabel } from './waypoints.js';

const COORD_DECIMALS = 6;
const ELE_DECIMALS = 1;

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** File-name friendly version of a route name. */
export function slugify(name, fallback = 'route') {
  const slug = String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug || fallback;
}

/**
 * @param {{name:string, waypoints:{lng:number,lat:number,name:string}[],
 *          coords:number[][], elevations:number[], time?:Date}} route
 */
export function buildGpx({ name, waypoints, coords, elevations, time = new Date() }) {
  const title = escapeXml(name || 'Bike Router route');
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Bike Router" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${title}</name><time>${time.toISOString()}</time></metadata>`,
  ];

  waypoints.forEach((w, i) => {
    const label = escapeXml(w.name || defaultLabel(i, waypoints.length));
    lines.push(`  <wpt lat="${w.lat.toFixed(COORD_DECIMALS)}" lon="${w.lng.toFixed(COORD_DECIMALS)}"><name>${label}</name></wpt>`);
  });

  lines.push(`  <trk><name>${title}</name><trkseg>`);
  coords.forEach(([lng, lat], i) => {
    const ele = elevations[i];
    const eleTag = Number.isFinite(ele) ? `<ele>${ele.toFixed(ELE_DECIMALS)}</ele>` : '';
    lines.push(`    <trkpt lat="${lat.toFixed(COORD_DECIMALS)}" lon="${lng.toFixed(COORD_DECIMALS)}">${eleTag}</trkpt>`);
  });
  lines.push('  </trkseg></trk>', '</gpx>', '');

  return lines.join('\n');
}
