// OpenRouteService engine. Talks to the public API and returns a plain, engine-neutral result.
import { RoutingError } from './errors.js';

export const ID = 'ors';
const BASE_URL = 'https://api.openrouteservice.org';

export const PROFILES = [
  { id: 'cycling-road', label: 'Paved roads (road bike)' },
  { id: 'cycling-regular', label: 'Mixed roads (regular bike)' },
  { id: 'cycling-mountain', label: 'Trails and tracks (mountain bike)' },
  { id: 'cycling-electric', label: 'Electric bike' },
];

// How far a waypoint may be from the nearest road before the engine gives up (metres).
// The default of 350 m fails too often on rural Romanian roads.
const SNAP_RADIUS_M = 1000;

// ORS surface codes grouped into the categories the rest of the app uses.
const SURFACE_CATEGORY = {
  0: 'unknown',
  1: 'asphalt',    // paved
  2: 'dirt',       // unpaved
  3: 'asphalt',
  4: 'asphalt',    // concrete
  5: 'cobbles',
  6: 'asphalt',    // metal
  7: 'asphalt',    // wood
  8: 'compactedGravel',
  9: 'compactedGravel', // fine gravel
  10: 'looseGravel',
  11: 'dirt',
  12: 'dirt',      // ground
  13: 'dirt',      // ice
  14: 'cobbles',   // paving stones
  15: 'dirt',      // sand
  16: 'dirt',      // woodchips
  17: 'dirt',      // grass
  18: 'dirt',      // grass paver
};

const WAY_TYPE = {
  0: 'unknown', 1: 'stateRoad', 2: 'road', 3: 'street', 4: 'path',
  5: 'track', 6: 'cycleway', 7: 'footway', 8: 'steps', 9: 'ferry', 10: 'construction',
};

async function errorFromResponse(res) {
  let body = null;
  try { body = await res.json(); } catch { /* body is not JSON */ }
  const detail = body?.error?.message ?? (typeof body?.error === 'string' ? body.error : '');

  if (res.status === 401 || res.status === 403) {
    return new RoutingError('The routing service rejected the API key.', 'auth');
  }
  if (res.status === 429) {
    return new RoutingError('Request limit reached.', 'limit');
  }
  if (body?.error?.code === 2010) {
    return new RoutingError('A point is too far from any road usable by bikes.', 'unroutable');
  }
  return new RoutingError(detail || `Routing failed (HTTP ${res.status}).`, 'other');
}

function parseRanges(extra, lookup) {
  return (extra?.values ?? []).map(([from, to, code]) => ({
    from,
    to,
    type: lookup[code] ?? 'unknown',
  }));
}

/**
 * @param {{coordinates: number[][], profile: string, apiKey: string, signal?: AbortSignal,
 *          roundTrip?: {lengthM:number, points:number, seed:number}}} request
 *   coordinates are [lng, lat] pairs. With `roundTrip`, a single coordinate is enough: the engine
 *   builds a loop of about that length from it. `seed` varies the loop, `points` how round it is.
 */
export async function fetchRoute({ coordinates, profile, apiKey, signal, roundTrip }) {
  const body = {
    coordinates,
    elevation: true,
    extra_info: ['surface', 'waytype'],
    instructions: false,
    radiuses: coordinates.map(() => SNAP_RADIUS_M),
  };
  if (roundTrip) {
    body.options = {
      round_trip: { length: Math.round(roundTrip.lengthM), points: roundTrip.points, seed: roundTrip.seed },
    };
  }

  let res;
  try {
    res = await fetch(`${BASE_URL}/v2/directions/${profile}/geojson`, {
      method: 'POST',
      signal,
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/geo+json, application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new RoutingError('Could not reach the routing service.', 'network');
  }

  if (!res.ok) throw await errorFromResponse(res);

  const data = await res.json();
  const feature = data.features?.[0];
  if (!feature) throw new RoutingError('The routing service returned no route.', 'other');

  const line = feature.geometry.coordinates;
  const extras = feature.properties.extras ?? {};

  return {
    coordinates: line.map((c) => [c[0], c[1]]),
    elevations: line.map((c) => (Number.isFinite(c[2]) ? c[2] : NaN)),
    surface: parseRanges(extras.surface, SURFACE_CATEGORY),
    wayType: parseRanges(extras.waytype, WAY_TYPE),
    waypointIndices: feature.properties.way_points ?? [],
  };
}
