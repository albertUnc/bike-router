// Loop generator. Asks the routing engine for round trips from a start point, measures each
// candidate with the rider model, corrects the requested length so results land near the target,
// then scores the candidates and keeps up to three clearly different ones.
//
// The engine call is injected (`routeFn`), so the logic can be tested without network access.
import { buildProfile } from './elevation.js';
import { estimate } from './estimator.js';
import { solveSpeed } from './physics.js';
import { powerFraction, totalMassKg } from './rider.js';
import { surfaceBreakdown, wayTypeBreakdown } from './surface.js';
import { copyWaypoint, createWaypoint } from './waypoints.js';

const SEEDS_PER_ROUND = 4;
const MAX_ROUNDS = 3;
const CONCURRENCY = 3;          // parallel requests; the free API tier allows 40 per minute
const TOLERANCE = 0.05;         // stop early once the best candidate is this close to the target
const GOOD_ENOUGH = 0.1;        // and enough candidates are within this
const MIN_LENGTH_M = 2000;
const MAX_LENGTH_M = 300000;
const MAX_RATIO_STEP = 2;       // a single correction never scales the request by more than this
const TIME_GUESS_FACTOR = 0.8;  // first guess of loop length for a time target, allowing for hills and stops
const MAX_RESULTS = 3;

const RETRACE_CELL_M = 40;      // grid cell used to spot a route covering ground it already covered
const RETRACE_MIN_GAP_M = 400;  // revisiting a place less than this far along the route is not a retrace
// A pure out-and-back retraces half its length, so this cutoff keeps those out unless they are allowed.
const MAX_OVERLAP_UNLESS_ALLOWED = 0.3;
const SIMILARITY_CELL_M = 150;
const SIMILAR_ABOVE = 0.8;      // two candidates sharing this much of their path count as the same loop

const WEIGHTS = { closeness: 0.5, overlap: 0.2, surface: 0.12, quiet: 0.08, elevation: 0.1 };
const CLOSENESS_ZERO_AT = 0.3;  // 30 % away from the target scores zero closeness
const OVERLAP_ZERO_AT = 0.4;
const ELEVATION_BANDS = { flat: [0, 6], rolling: [6, 14], hilly: [14, 60] }; // metres of climbing per km
const ELEVATION_FALLOFF = 6;

const VIA_MIN = 3;
const VIA_MAX = 8;
const VIA_EVERY_KM = 8;

// Errors that mean further requests will fail too, so the search stops instead of retrying.
const FATAL_CODES = new Set(['auth', 'nokey', 'limit', 'network']);

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const metresPerDegreeLat = 111320;

/** Length of loop to ask for first. A time target is converted using the rider's flat-road speed. */
export function initialLength(target, rider) {
  if (target.kind === 'distance') return clamp(target.meters, MIN_LENGTH_M, MAX_LENGTH_M);
  const power = rider.ftpW * powerFraction(rider.powerCurve, target.seconds / 3600);
  const flatSpeed = solveSpeed({
    powerW: power, grade: 0, massKg: totalMassKg(rider), crr: rider.crr * 1.25, cdA: rider.cdA,
  });
  return clamp(flatSpeed * target.seconds * TIME_GUESS_FACTOR, MIN_LENGTH_M, MAX_LENGTH_M);
}

/** Share (0-1) of the route that runs over ground it already covered earlier, e.g. out and back. */
export function retraceShare(route) {
  const { coords, distances } = route;
  if (coords.length < 2 || !(route.distanceM > 0)) return 0;

  const kx = (metresPerDegreeLat * Math.cos((coords[0][1] * Math.PI) / 180)) / RETRACE_CELL_M;
  const ky = metresPerDegreeLat / RETRACE_CELL_M;
  const firstVisit = new Map(); // cell -> distance along the route when it was first entered
  let retraced = 0;

  for (let i = 0; i < coords.length; i++) {
    const cx = Math.floor(coords[i][0] * kx);
    const cy = Math.floor(coords[i][1] * ky);
    const d = distances[i];

    let seen = false;
    for (let dx = -1; dx <= 1 && !seen; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const earlier = firstVisit.get(`${cx + dx},${cy + dy}`);
        if (earlier !== undefined && d - earlier > RETRACE_MIN_GAP_M) {
          seen = true;
          break;
        }
      }
    }
    if (seen && i > 0) retraced += d - distances[i - 1];

    const key = `${cx},${cy}`;
    if (!firstVisit.has(key)) firstVisit.set(key, d);
  }
  return Math.min(1, retraced / route.distanceM);
}

function cellSet(route) {
  const kx = (metresPerDegreeLat * Math.cos((route.coords[0][1] * Math.PI) / 180)) / SIMILARITY_CELL_M;
  const ky = metresPerDegreeLat / SIMILARITY_CELL_M;
  const cells = new Set();
  for (const [lng, lat] of route.coords) cells.add(`${Math.floor(lng * kx)},${Math.floor(lat * ky)}`);
  return cells;
}

function similarity(a, b) {
  let shared = 0;
  for (const key of a) if (b.has(key)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Measures a route with the rider model. Returns null if it is unusable. */
function analyse(route, rider) {
  if (!route?.coords || route.coords.length < 2) return null;
  const profile = buildProfile(route);
  const result = profile && estimate(route, profile, rider);
  if (!result) return null;

  const surfaces = surfaceBreakdown(route);
  const ways = wayTypeBreakdown(route);
  const share = (list, type) => list.find((s) => s.type === type)?.share ?? 0;

  return {
    route,
    profile,
    estimate: result,
    cells: cellSet(route),
    metrics: {
      distanceM: route.distanceM,
      timeSec: result.totalSec,
      ascentM: profile.ascent,
      descentM: profile.descent,
      overlap: retraceShare(route),
      asphaltShare: share(surfaces, 'asphalt'),
      // Paved counts fully, unknown and compacted gravel partly: tags are patchy in Romania.
      pavedScore: share(surfaces, 'asphalt') + 0.6 * share(surfaces, 'unknown')
        + 0.5 * share(surfaces, 'compactedGravel') + 0.25 * share(surfaces, 'cobbles'),
      stateRoadShare: share(ways, 'stateRoad'),
    },
  };
}

function targetValue(target) {
  return target.kind === 'time' ? target.seconds : target.meters;
}

function measured(candidate, target) {
  return target.kind === 'time' ? candidate.metrics.timeSec : candidate.metrics.distanceM;
}

/** How well the candidate climbs as asked: 1 inside the wanted band, falling off outside it. */
function elevationFit(metrics, preference) {
  const [lo, hi] = ELEVATION_BANDS[preference];
  const perKm = metrics.ascentM / Math.max(metrics.distanceM / 1000, 0.1);
  const outside = perKm < lo ? lo - perKm : Math.max(0, perKm - hi);
  return Math.max(0, 1 - outside / ELEVATION_FALLOFF);
}

/**
 * Weighted score in [0, 1] and the relative error against the target.
 * @param {{allowOutAndBack:boolean, preferPaved:boolean, elevation:'any'|'flat'|'rolling'|'hilly'}} options
 */
export function scoreCandidate(candidate, target, options) {
  const error = Math.abs(measured(candidate, target) - targetValue(target)) / targetValue(target);
  const parts = [[WEIGHTS.closeness, Math.max(0, 1 - error / CLOSENESS_ZERO_AT)]];

  if (!options.allowOutAndBack) {
    parts.push([WEIGHTS.overlap, Math.max(0, 1 - candidate.metrics.overlap / OVERLAP_ZERO_AT)]);
  }
  if (options.preferPaved) {
    parts.push([WEIGHTS.surface, Math.min(1, candidate.metrics.pavedScore)]);
    parts.push([WEIGHTS.quiet, 1 - candidate.metrics.stateRoadShare]);
  }
  if (options.elevation !== 'any') {
    parts.push([WEIGHTS.elevation, elevationFit(candidate.metrics, options.elevation)]);
  }

  const weightSum = parts.reduce((sum, [w]) => sum + w, 0);
  const score = parts.reduce((sum, [w, s]) => sum + w * s, 0) / weightSum;
  return { score, error };
}

/** Best-first list of up to three candidates that differ from each other. */
function pickBest(pool, options) {
  const sorted = [...pool].sort((a, b) => b.score - a.score);
  const acceptable = sorted.filter((c) => options.allowOutAndBack || c.metrics.overlap <= MAX_OVERLAP_UNLESS_ALLOWED);
  // Loops that retrace themselves are only offered when nothing else fills the list.
  const ordered = [...acceptable, ...sorted.filter((c) => !acceptable.includes(c))];

  const chosen = [];
  for (const candidate of ordered) {
    if (chosen.length >= MAX_RESULTS) break;
    if (chosen.every((other) => similarity(other.cells, candidate.cells) < SIMILAR_ABOVE)) chosen.push(candidate);
  }
  return chosen;
}

async function runPool(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  });
  await Promise.all(runners);
}

/**
 * @param {{start:{lng:number,lat:number},
 *          target:{kind:'distance', meters:number}|{kind:'time', seconds:number},
 *          options:{allowOutAndBack:boolean, preferPaved:boolean, elevation:string},
 *          rider:object,
 *          routeFn:(start:object, request:{lengthM:number, seed:number, points:number, signal?:AbortSignal})=>Promise<object>,
 *          onProgress?:(p:{done:number})=>void, signal?:AbortSignal}} request
 * @returns {Promise<{candidates:object[], warning:Error|null}>}
 *   Each candidate: { route, profile, estimate, metrics, score, error }.
 *   Rejects with the engine's error if nothing at all could be generated.
 */
export async function generateLoops({ start, target, options, rider, routeFn, onProgress, signal }) {
  const wanted = targetValue(target);
  let lengthM = initialLength(target, rider);
  const pool = [];
  let seed = 0;
  let done = 0;
  let fatal = null;
  let lastError = null;

  for (let round = 0; round < MAX_ROUNDS && !fatal; round++) {
    const jobs = Array.from({ length: SEEDS_PER_ROUND }, (_, k) => ({ seed: seed++, points: 3 + (k % 3) }));
    const results = [];

    await runPool(jobs, CONCURRENCY, async (job) => {
      if (fatal) return;
      try {
        const route = await routeFn(start, { lengthM, seed: job.seed, points: job.points, signal });
        const candidate = analyse(route, rider);
        if (candidate) results.push(candidate);
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        if (FATAL_CODES.has(err.code)) fatal = err;
        else lastError = err;
      } finally {
        done++;
        onProgress?.({ done });
      }
    });
    pool.push(...results);
    if (!results.length) continue;

    // The engine's loops rarely match the requested length. Scale the next request by how far off
    // the typical result was.
    const ratios = results.map((c) => wanted / measured(c, target)).sort((a, b) => a - b);
    const typical = ratios[Math.floor(ratios.length / 2)];
    lengthM = clamp(lengthM * clamp(typical, 1 / MAX_RATIO_STEP, MAX_RATIO_STEP), MIN_LENGTH_M, MAX_LENGTH_M);

    const errors = pool.map((c) => Math.abs(measured(c, target) - wanted) / wanted);
    if (Math.min(...errors) <= TOLERANCE && errors.filter((e) => e <= GOOD_ENOUGH).length >= MAX_RESULTS) break;
  }

  if (!pool.length) {
    throw fatal ?? lastError ?? new Error('No loop could be generated from this start point.');
  }

  for (const candidate of pool) Object.assign(candidate, scoreCandidate(candidate, target, options));
  return { candidates: pickBest(pool, options), warning: fatal };
}

/** Index of the first coordinate at or beyond the given distance along the route. */
function indexAtDistance(distances, metres) {
  let lo = 0;
  let hi = distances.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (distances[mid] < metres) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Turns a chosen loop into editable stops: the start, a few points spread along the loop, and the
 * start again at the end. Routing through these reproduces the loop, and the user can drag them.
 * @returns {{waypoints:object[], waypointIndices:number[]}}
 */
export function loopWaypoints(route, startWaypoint) {
  const viaCount = clamp(Math.round(route.distanceM / 1000 / VIA_EVERY_KM), VIA_MIN, VIA_MAX);
  const waypoints = [startWaypoint];
  const waypointIndices = [0];

  for (let k = 1; k <= viaCount; k++) {
    const index = indexAtDistance(route.distances, (route.distanceM * k) / (viaCount + 1));
    waypoints.push(createWaypoint(route.coords[index][0], route.coords[index][1], `Loop point ${k}`));
    waypointIndices.push(index);
  }

  waypoints.push(copyWaypoint(startWaypoint));
  waypointIndices.push(route.coords.length - 1);
  return { waypoints, waypointIndices };
}
