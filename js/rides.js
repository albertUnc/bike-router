// Imported rides: turning parsed track points into a compact, evenly sampled record.
//
// Real files have irregular timing and pauses. The record is resampled to one sample every
// STEP_S seconds. During a pause (a gap with no points) the rider is held in place, so stopped time
// shows up as zero speed rather than as slow movement.
import { haversine } from './geo.js';
import { newId } from './id.js';
import { movingAverage } from './elevation.js';
import { parseFit } from './fit.js';
import { parseGpx } from './gpxread.js';

export const STEP_S = 5;
const MAX_GAP_S = 30;          // a gap longer than this between points is a pause
const MIN_POINTS = 20;
const MIN_DURATION_S = 60;
const MAX_SAMPLES = 60000;     // 83 hours at 5 s
const MOVING_SPEED_MS = 0.8;
const ASCENT_SMOOTH_HALF = 6;  // samples each side, 1 minute of data around each point
const MAX_NAME_LENGTH = 80;

const round = (value, decimals) => Number(value.toFixed(decimals));

/** Unpacks gzip data (Strava's bulk export stores activities as .fit.gz and .gpx.gz). */
async function gunzip(buffer) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('this browser cannot unpack .gz files, so unpack the file first');
  }
  try {
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).arrayBuffer();
  } catch {
    throw new Error('the .gz file is damaged or not gzip data');
  }
}

/** Reads a GPX or FIT file (optionally gzipped) into points. Rejects with a readable message if it cannot. */
export async function parseRideFile(fileName, buffer) {
  let name = fileName.toLowerCase();
  let data = buffer;
  if (name.endsWith('.gz')) {
    data = await gunzip(buffer);
    name = name.slice(0, -3);
  }
  if (name.endsWith('.fit')) return parseFit(data);
  if (name.endsWith('.gpx')) return parseGpx(new TextDecoder('utf-8').decode(data));
  throw new Error('only .gpx and .fit files (or .gpx.gz and .fit.gz) can be imported');
}

/** Fills missing elevations from the nearest known neighbour. Returns false if there are none at all. */
function fillElevations(points) {
  const known = points.some((p) => Number.isFinite(p.ele));
  if (!known) return false;
  let last = null;
  for (const p of points) {
    if (Number.isFinite(p.ele)) last = p.ele;
    else if (last !== null) p.ele = last;
  }
  let next = null;
  for (let i = points.length - 1; i >= 0; i--) {
    if (Number.isFinite(points[i].ele)) next = points[i].ele;
    else points[i].ele = next;
  }
  return true;
}

/**
 * @param {{name:string|null, source:'gpx'|'fit'|'strava', points:object[]}} parsed output of parseGpx / parseFit
 * @param {string} fileName
 * @returns a ride record; throws an Error with a readable message if the points cannot make a ride
 */
export function buildRide(parsed, fileName) {
  const points = parsed.points
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180)
    .map((p) => ({ ...p }));
  if (points.length < MIN_POINTS) throw new Error('This file has too few GPS points to be a ride.');
  if (points.some((p) => !Number.isFinite(p.t))) throw new Error('This file has no timestamps, so speeds cannot be worked out.');

  points.sort((a, b) => a.t - b.t);
  const unique = points.filter((p, i) => i === 0 || p.t > points[i - 1].t);
  const t0 = unique[0].t;
  for (const p of unique) p.s = (p.t - t0) / 1000;

  const total = unique[unique.length - 1].s;
  if (total < MIN_DURATION_S) throw new Error('This ride is shorter than a minute.');
  if (total / STEP_S > MAX_SAMPLES) throw new Error('This ride is too long to import.');

  const hasElevation = fillElevations(unique);
  const hasPower = unique.some((p) => p.power != null && p.power > 0);

  // Distance along the recorded path at every original point.
  unique[0].dist = 0;
  for (let i = 1; i < unique.length; i++) {
    unique[i].dist = unique[i - 1].dist + haversine([unique[i - 1].lng, unique[i - 1].lat], [unique[i].lng, unique[i].lat]);
  }

  // Power readings summed into 5 s bins, so 1 s data is averaged rather than sampled.
  const n = Math.floor(total / STEP_S) + 1;
  const binSum = new Float64Array(n);
  const binCount = new Uint16Array(n);
  if (hasPower) {
    for (const p of unique) {
      if (p.power == null) continue;
      const bin = Math.min(n - 1, Math.round(p.s / STEP_S));
      binSum[bin] += p.power;
      binCount[bin]++;
    }
  }

  const lat = new Float64Array(n);
  const lng = new Float64Array(n);
  const ele = new Float64Array(n);
  const dist = new Float64Array(n);
  const power = new Float64Array(n);

  let j = 0;
  for (let i = 0; i < n; i++) {
    const g = i * STEP_S;
    while (j < unique.length - 2 && unique[j + 1].s <= g) j++;
    const a = unique[j];
    const b = unique[j + 1];
    const gap = b.s - a.s;
    const paused = gap > MAX_GAP_S && g < b.s;
    const f = paused || gap <= 0 ? 0 : Math.min(1, Math.max(0, (g - a.s) / gap));

    lat[i] = a.lat + (b.lat - a.lat) * f;
    lng[i] = a.lng + (b.lng - a.lng) * f;
    ele[i] = hasElevation ? a.ele + (b.ele - a.ele) * f : 0;
    dist[i] = a.dist + (b.dist - a.dist) * f;

    if (hasPower) {
      if (binCount[i] > 0) power[i] = binSum[i] / binCount[i];
      else if (!paused && a.power != null && b.power != null) power[i] = a.power + (b.power - a.power) * f;
      else power[i] = 0;
    }
  }

  const speed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - 1);
    const hi = Math.min(n - 1, i + 1);
    speed[i] = hi > lo ? (dist[hi] - dist[lo]) / ((hi - lo) * STEP_S) : 0;
  }

  let movingSamples = 0;
  for (const v of speed) if (v >= MOVING_SPEED_MS) movingSamples++;

  let ascentM = 0;
  if (hasElevation) {
    const smooth = movingAverage(ele, ASCENT_SMOOTH_HALF);
    for (let i = 1; i < n; i++) if (smooth[i] > smooth[i - 1]) ascentM += smooth[i] - smooth[i - 1];
  }

  const baseName = fileName.replace(/\.gz$/i, '').replace(/\.[^.]+$/, '');
  return {
    id: newId(),
    name: (parsed.name || baseName || 'Ride').slice(0, MAX_NAME_LENGTH),
    source: parsed.source,
    fileName,
    startTime: t0 > 1e11 ? t0 : null,
    importedAt: Date.now(),
    distanceM: dist[n - 1],
    elapsedS: total,
    movingS: movingSamples * STEP_S,
    ascentM,
    hasPower,
    hasElevation,
    stravaId: null, // set by the Strava sync for rides that came from there
    stepS: STEP_S,
    streams: {
      lat: Array.from(lat, (v) => round(v, 5)),
      lng: Array.from(lng, (v) => round(v, 5)),
      ele: hasElevation ? Array.from(ele, (v) => round(v, 1)) : [],
      dist: Array.from(dist, (v) => round(v, 1)),
      speed: Array.from(speed, (v) => round(v, 2)),
      power: hasPower ? Array.from(power, (v) => Math.round(v)) : [],
    },
  };
}

const finiteArray = (a, length) => Array.isArray(a) && a.length === length && a.every(Number.isFinite);

/** Validates a record from storage or an import file. Returns a clean record, or null if unusable. */
export function sanitizeRideRecord(raw) {
  const s = raw?.streams;
  const n = s?.lat?.length;
  if (!Number.isInteger(n) || n < 2 || n > MAX_SAMPLES + 1) return null;
  if (!finiteArray(s.lat, n) || !finiteArray(s.lng, n) || !finiteArray(s.dist, n) || !finiteArray(s.speed, n)) return null;

  const hasElevation = s.ele?.length === n;
  const hasPower = s.power?.length === n;
  if (hasElevation && !finiteArray(s.ele, n)) return null;
  if (hasPower && !finiteArray(s.power, n)) return null;
  if (s.dist.some((d, i) => i > 0 && d < s.dist[i - 1])) return null; // distance never goes backwards

  const num = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, MAX_NAME_LENGTH) : 'Ride',
    source: raw.source === 'fit' || raw.source === 'strava' ? raw.source : 'gpx',
    stravaId: Number.isFinite(raw.stravaId) ? raw.stravaId : null,
    fileName: typeof raw.fileName === 'string' ? raw.fileName.slice(0, 120) : '',
    startTime: Number.isFinite(raw.startTime) ? raw.startTime : null,
    importedAt: num(raw.importedAt, Date.now()),
    distanceM: num(raw.distanceM, s.dist[n - 1]),
    elapsedS: num(raw.elapsedS),
    movingS: num(raw.movingS),
    ascentM: num(raw.ascentM),
    hasPower,
    hasElevation,
    stepS: STEP_S,
    streams: {
      lat: s.lat, lng: s.lng, dist: s.dist, speed: s.speed,
      ele: hasElevation ? s.ele : [],
      power: hasPower ? s.power : [],
    },
  };
}

/** The ride's ground track as a route-shaped object, so the estimator can be run over it. */
export function rideRoute(ride) {
  const { lat, lng, ele, dist } = ride.streams;
  return {
    engine: 'ride',
    coords: lat.map((la, i) => [lng[i], la]),
    elevations: ride.hasElevation ? ele : lat.map(() => NaN),
    distances: Float64Array.from(dist),
    distanceM: dist[dist.length - 1],
    surface: [],
    wayType: [],
    waypointIndices: [],
  };
}

const SAME_START_TOLERANCE_MS = 5000;

/** The same ride imported twice: same start (within a few seconds) and, within one percent, the same length. */
export function isSameRide(a, b) {
  const sameStart = a.startTime !== null && b.startTime !== null
    ? Math.abs(a.startTime - b.startTime) <= SAME_START_TOLERANCE_MS
    : a.fileName === b.fileName;
  return sameStart && Math.abs(a.distanceM - b.distanceM) <= 0.01 * Math.max(a.distanceM, b.distanceM);
}
