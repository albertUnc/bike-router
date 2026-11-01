// Geographic helpers. Coordinates are [lng, lat] pairs, distances are in metres.

const EARTH_RADIUS_M = 6371008.8;
const RAD = Math.PI / 180;

/** Great-circle distance between two [lng, lat] points. */
export function haversine(a, b) {
  const dLat = (b[1] - a[1]) * RAD;
  const dLng = (b[0] - a[0]) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Running distance along a line: result[i] is the length from the first point to point i. */
export function cumulativeDistances(coords) {
  const out = new Float64Array(coords.length);
  for (let i = 1; i < coords.length; i++) {
    out[i] = out[i - 1] + haversine(coords[i - 1], coords[i]);
  }
  return out;
}

/** Bounding box as [[minLng, minLat], [maxLng, maxLat]]. */
export function boundsOf(coords) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const [lng, lat] of coords) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [[minLng, minLat], [maxLng, maxLat]];
}

/** Index of the coordinate closest to the given point (flat-earth distance, fine at route scale). */
export function nearestIndex(coords, lng, lat) {
  const lngScale = Math.cos(lat * RAD);
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const dx = (coords[i][0] - lng) * lngScale;
    const dy = coords[i][1] - lat;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}
