// Turns a route into per-segment speeds and a total time for a given rider profile.
//
// The route is cut into short segments (about 100 m). Each segment gets a speed from the power
// balance in physics.js, using the segment's grade and surface. Target power depends on how long
// the ride takes, so power and duration are iterated until they agree.
import { gradeFactor } from './calibration.js';
import { solveSpeed } from './physics.js';
import { powerFraction, totalMassKg } from './rider.js';

const SEGMENT_M = 100;
const MAX_GRADE = 0.25;          // steeper readings are DEM noise or walking sections anyway
const MIN_SPEED_MS = 1.5;        // about 5.4 km/h; below this the rider is walking
const DURATION_PASSES = 6;
const INITIAL_SPEED_GUESS_MS = 20 / 3.6;
const MIN_SETTLEMENT_RUN_M = 150; // a stretch of "street" at least this long counts as one settlement

/**
 * Rolling resistance multiplier and top speed per surface category.
 * Unknown surfaces are treated conservatively because OSM surface tags are patchy in Romania.
 */
export const SURFACES = {
  asphalt: { crrMultiplier: 1.0, maxKmh: 100 },
  compactedGravel: { crrMultiplier: 1.5, maxKmh: 40 },
  looseGravel: { crrMultiplier: 2.2, maxKmh: 28 },
  cobbles: { crrMultiplier: 2.5, maxKmh: 28 },
  dirt: { crrMultiplier: 2.8, maxKmh: 22 },
  unknown: { crrMultiplier: 1.25, maxKmh: 45 },
};

/** Surface category at each query distance. `ranges` are { from, to, type } over coordinate indices. */
function surfaceAt(ranges, distances, queries) {
  const out = new Array(queries.length).fill('unknown');
  let r = 0;
  for (let q = 0; q < queries.length; q++) {
    while (r < ranges.length && distances[ranges[r].to] < queries[q]) r++;
    if (r < ranges.length && distances[ranges[r].from] <= queries[q]) out[q] = ranges[r].type;
  }
  return out;
}

function buildSegments(route, profile) {
  const samplesPerSegment = Math.max(1, Math.round(SEGMENT_M / profile.stepM));
  const bounds = [];
  for (let i0 = 0; i0 < profile.count - 1; i0 += samplesPerSegment) {
    bounds.push([i0, Math.min(i0 + samplesPerSegment, profile.count - 1)]);
  }

  const mids = bounds.map(([a, b]) => (profile.d[a] + profile.d[b]) / 2);
  const surfaces = surfaceAt(route.surface ?? [], route.distances, mids);

  const segments = bounds.map(([i0, i1], k) => {
    const lengthM = profile.d[i1] - profile.d[i0];
    const rawGrade = lengthM > 0 ? (profile.ele[i1] - profile.ele[i0]) / lengthM : 0;
    return {
      i0,
      i1,
      startM: profile.d[i0],
      endM: profile.d[i1],
      lengthM,
      grade: Math.max(-MAX_GRADE, Math.min(MAX_GRADE, rawGrade)),
      surface: surfaces[k],
      speedMs: 0,
      sec: 0,
    };
  });
  return { segments, samplesPerSegment };
}

/** Number of settlements crossed, estimated from long runs of residential "street" way type. */
function countSettlements(route) {
  let count = 0;
  let runStart = null;
  let runEnd = null;
  const flush = () => {
    if (runStart !== null && runEnd - runStart >= MIN_SETTLEMENT_RUN_M) count++;
    runStart = runEnd = null;
  };
  for (const { from, to, type } of route.wayType ?? []) {
    if (type === 'street') {
      if (runStart === null) runStart = route.distances[from];
      runEnd = route.distances[to];
    } else {
      flush();
    }
  }
  flush();
  return count;
}

function segmentSpeedMs(segment, powerW, rider, massKg) {
  const surface = SURFACES[segment.surface] ?? SURFACES.unknown;
  // The physics speed, corrected by what the rider's real rides showed on this grade (1 if not calibrated).
  const physical = gradeFactor(rider.calibration, segment.grade) * solveSpeed({
    powerW,
    grade: segment.grade,
    massKg,
    crr: rider.crr * surface.crrMultiplier,
    cdA: rider.cdA,
  });
  const capMs = Math.min(rider.maxDescentKmh, surface.maxKmh) / 3.6;
  return Math.max(MIN_SPEED_MS, Math.min(physical, capMs));
}

/**
 * @param {object} route    result of routing.route()
 * @param {object} profile  result of elevation.buildProfile()
 * @param {object} rider    rider profile (see rider.js)
 * @returns {{segments:object[], sampleSpeedKmh:Float64Array, totalSec:number, movingSec:number,
 *            penaltySec:number, avgKmh:number, movingAvgKmh:number, powerW:number,
 *            powerFraction:number, settlements:number}|null}
 */
export function estimate(route, profile, rider) {
  if (!profile || !(route.distanceM > 0)) return null;

  const massKg = totalMassKg(rider);
  const { segments, samplesPerSegment } = buildSegments(route, profile);
  const settlements = countSettlements(route);
  const penaltySec = (rider.stopSecPerKm * route.distanceM) / 1000 + rider.settlementSec * settlements;

  let totalSec = route.distanceM / INITIAL_SPEED_GUESS_MS + penaltySec;
  let movingSec = 0;
  let fraction = 0;
  let powerW = 0;

  // Target power depends on ride duration, and duration depends on power: iterate to agreement.
  for (let pass = 0; pass < DURATION_PASSES; pass++) {
    fraction = powerFraction(rider.powerCurve, totalSec / 3600);
    powerW = rider.ftpW * fraction;
    movingSec = 0;
    for (const seg of segments) {
      seg.speedMs = segmentSpeedMs(seg, powerW, rider, massKg);
      seg.sec = seg.lengthM / seg.speedMs;
      movingSec += seg.sec;
    }
    totalSec = movingSec + penaltySec;
  }

  const sampleSpeedKmh = new Float64Array(profile.count);
  for (let i = 0; i < profile.count; i++) {
    const seg = segments[Math.min(Math.floor(i / samplesPerSegment), segments.length - 1)];
    sampleSpeedKmh[i] = seg.speedMs * 3.6;
  }

  return {
    segments,
    sampleSpeedKmh,
    totalSec,
    movingSec,
    penaltySec,
    avgKmh: (route.distanceM / totalSec) * 3.6,
    movingAvgKmh: (route.distanceM / movingSec) * 3.6,
    powerW,
    powerFraction: fraction,
    settlements,
  };
}

/** Moving time in seconds spent between two distances along the route (stops not included). */
export function timeBetween(result, fromM, toM) {
  let sec = 0;
  for (const seg of result.segments) {
    const lo = Math.max(seg.startM, fromM);
    const hi = Math.min(seg.endM, toM);
    if (hi > lo && seg.lengthM > 0) sec += (seg.sec * (hi - lo)) / seg.lengthM;
  }
  return sec;
}
