// Routing adapter. The rest of the app only talks to this module, so the engine
// (ORS today) can be replaced by swapping the import below.
import * as engine from './ors.js';
import { RoutingError } from './errors.js';
import { cumulativeDistances } from '../geo.js';
import { dedupeAdjacent } from '../waypoints.js';

export { RoutingError };

/** Routing profiles the active engine offers, as { id, label }. */
export const profiles = engine.PROFILES;

const CACHE_LIMIT = 60;
const cache = new Map(); // insertion order doubles as age for eviction

function remember(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

function cacheKey(profile, waypoints) {
  const points = waypoints.map((w) => `${w.lng.toFixed(5)},${w.lat.toFixed(5)}`).join(';');
  return `${engine.ID}|${profile}|${points}`;
}

/** Engine output to the app's route shape. */
function buildResult(raw, profile) {
  const distances = cumulativeDistances(raw.coordinates);
  return {
    engine: engine.ID,
    profile,
    coords: raw.coordinates,
    elevations: raw.elevations,
    distances,
    distanceM: distances[distances.length - 1],
    surface: raw.surface,
    wayType: raw.wayType,
    engineWaypointIndices: raw.waypointIndices,
  };
}

/**
 * Route through the waypoints in order.
 *
 * Result:
 *   coords          [lng, lat][] of the route line
 *   elevations      metres per coord (NaN where the engine gave none)
 *   distances       Float64Array, metres from the start to each coord
 *   distanceM       total length in metres
 *   surface         { from, to, type }[] coord-index ranges, type is a normalised category
 *   wayType         { from, to, type }[] coord-index ranges
 *   waypointIndices coord index of each requested waypoint, same length and order as the input
 *                   (empty when the engine did not report them)
 *
 * Consecutive waypoints at the same place are sent to the engine once, since zero-length legs
 * are rejected; their entries in waypointIndices point at the same coordinate.
 *
 * @param {{lng:number, lat:number}[]} waypoints
 * @param {{profile:string, apiKey:string, signal?:AbortSignal}} options
 */
export async function route(waypoints, { profile, apiKey, signal }) {
  if (waypoints.length < 2) throw new RoutingError('At least two points are needed.', 'input');
  if (!apiKey) throw new RoutingError('No API key set.', 'nokey');

  const { unique, indexMap } = dedupeAdjacent(waypoints);
  if (unique.length < 2) throw new RoutingError('The route needs at least two different points.', 'input');

  const key = cacheKey(profile, unique);
  let base = cache.get(key);

  if (!base) {
    const raw = await engine.fetchRoute({
      coordinates: unique.map((w) => [w.lng, w.lat]),
      profile,
      apiKey,
      signal,
    });
    base = buildResult(raw, profile);
    remember(key, base);
  }

  const reported = base.engineWaypointIndices.length === unique.length;
  const { engineWaypointIndices, ...rest } = base;
  return {
    ...rest,
    waypointIndices: reported ? indexMap.map((u) => engineWaypointIndices[u]) : [],
  };
}

/**
 * A loop of roughly `lengthM` metres that starts and ends at `start`.
 * Same result shape as route(); waypointIndices is [start index, end index].
 * `seed` and `points` change the shape of the loop, so different values give different candidates.
 *
 * @param {{lng:number, lat:number}} start
 * @param {{lengthM:number, seed:number, points:number, profile:string, apiKey:string, signal?:AbortSignal}} options
 */
export async function roundTrip(start, { lengthM, seed, points, profile, apiKey, signal }) {
  if (!apiKey) throw new RoutingError('No API key set.', 'nokey');

  const key = `${cacheKey(profile, [start])}|rt|${Math.round(lengthM / 50)}|${seed}|${points}`;
  let base = cache.get(key);

  if (!base) {
    const raw = await engine.fetchRoute({
      coordinates: [[start.lng, start.lat]],
      profile,
      apiKey,
      signal,
      roundTrip: { lengthM, points, seed },
    });
    base = buildResult(raw, profile);
    remember(key, base);
  }

  const { engineWaypointIndices, ...rest } = base;
  return { ...rest, waypointIndices: [0, base.coords.length - 1] };
}
