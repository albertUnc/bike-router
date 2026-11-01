// What imported rides say about the rider: FTP, stops, descent speed, how power fades on long rides,
// and how the speed model compares with real speeds on each grade.
//
// Rides recorded without a power meter get an *estimated* power from their speed, slope and the
// bike's physics (no wind, GPS speed). That is rougher than a meter, so results from it are labelled.
import { MAX_FACTOR, MIN_FACTOR, GRADE_BUCKET_CENTERS_PCT, bucketOf } from './calibration.js';
import { buildProfile, movingAverage } from './elevation.js';
import { estimate } from './estimator.js';
import { powerAtSpeed } from './physics.js';
import { totalMassKg } from './rider.js';
import { rideRoute } from './rides.js';

export const EFFORT_DURATIONS_S = [300, 1200, 3600];

const MOVING_MS = 0.8;
const PEDALLING_MS = 1;
const SPEED_SMOOTH_HALF = 3;   // samples each side
const GRADE_HALF = 6;
const MAX_GRADE = 0.25;
const MAX_POWER_W = 1500;      // an estimated power above this is noise
const FTP_FROM_20_MIN = 0.95;
const MAX_STOP_S = 180;        // longer stops are breaks, not traffic
const MIN_KM_FOR_STOPS = 10;
const MIN_DESCENT_SAMPLES = 60;
const DESCENT_GRADE = -0.03;
const FADE_MIN_RIDE_S = 2400;
const FADE_MIN_PEDALLING_S = 1800;
const FADE_MIN_SPREAD = 1.4;   // longest ride at least this many times the shortest
const RIDE_SMOOTH_HALF = 5;    // elevation smoothing for rides, samples each side at 20 m
const MIN_BUCKET_COVERAGE_M = 1500;
const MIN_CALIBRATION_RIDE_M = 2000;

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

/** Smoothed speed, grade and acceleration for every sample of a ride. */
function motion(ride) {
  const { dist, ele, speed } = ride.streams;
  const n = dist.length;
  const step = ride.stepS;
  const v = movingAverage(Float64Array.from(speed), SPEED_SMOOTH_HALF);
  const smoothEle = ride.hasElevation ? movingAverage(Float64Array.from(ele), GRADE_HALF) : null;

  const grade = new Float64Array(n);
  const accel = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (smoothEle) {
      const lo = Math.max(0, i - GRADE_HALF);
      const hi = Math.min(n - 1, i + GRADE_HALF);
      const run = dist[hi] - dist[lo];
      grade[i] = run > 20 ? clamp((smoothEle[hi] - smoothEle[lo]) / run, -MAX_GRADE, MAX_GRADE) : 0;
    }
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    accel[i] = b > a ? (v[b] - v[a]) / ((b - a) * step) : 0;
  }
  return { speed: v, grade, accel };
}

/** Power implied by the ride's speed and slope for this rider's bike and weight. */
export function virtualPower(ride, rider) {
  const { speed, grade, accel } = motion(ride);
  const massKg = totalMassKg(rider);
  const watts = new Float64Array(speed.length);
  for (let i = 0; i < speed.length; i++) {
    if (speed[i] < PEDALLING_MS) continue;
    const w = powerAtSpeed({ speed: speed[i], grade: grade[i], accel: accel[i], massKg, crr: rider.crr, cdA: rider.cdA });
    watts[i] = clamp(w, 0, MAX_POWER_W);
  }
  return watts;
}

/** Watts per sample: the recorded power if the ride has it, otherwise the estimate from speed. */
function powerSeries(ride, rider) {
  return ride.hasPower
    ? { watts: Float64Array.from(ride.streams.power), measured: true }
    : { watts: virtualPower(ride, rider), measured: false };
}

/** Best average over any `window` consecutive samples, or null if the series is shorter. */
function bestMean(series, window) {
  if (series.length < window) return null;
  const prefix = new Float64Array(series.length + 1);
  for (let i = 0; i < series.length; i++) prefix[i + 1] = prefix[i] + series[i];
  let best = -Infinity;
  for (let i = 0; i + window <= series.length; i++) best = Math.max(best, (prefix[i + window] - prefix[i]) / window);
  return best;
}

/** Best average power over 5, 20 and 60 minutes, kept separately for measured and estimated power. */
export function bestEfforts(rides, rider) {
  const out = { measured: {}, estimated: {} };
  for (const ride of rides) {
    const { watts, measured } = powerSeries(ride, rider);
    const bucket = measured ? out.measured : out.estimated;
    for (const duration of EFFORT_DURATIONS_S) {
      const best = bestMean(watts, Math.round(duration / ride.stepS));
      if (best !== null && (!bucket[duration] || best > bucket[duration].watts)) {
        bucket[duration] = { watts: best, rideName: ride.name };
      }
    }
  }
  return out;
}

/** FTP from the best 20 minutes (95 %) or best 60 minutes, whichever is higher. Null if no ride is long enough. */
export function estimateFtp(rides, rider) {
  const efforts = bestEfforts(rides, rider);
  const pick = (set) => {
    const options = [];
    if (set[1200]) options.push({ ftpW: FTP_FROM_20_MIN * set[1200].watts, basis: 'best 20 min × 0.95', best: set[1200] });
    if (set[3600]) options.push({ ftpW: set[3600].watts, basis: 'best 60 min', best: set[3600] });
    return options.sort((a, b) => b.ftpW - a.ftpW)[0] ?? null;
  };

  const fromMeter = pick(efforts.measured);
  const chosen = fromMeter ?? pick(efforts.estimated);
  if (!chosen) return null;
  return {
    ftpW: Math.round(chosen.ftpW),
    basis: chosen.basis,
    bestWatts: Math.round(chosen.best.watts),
    rideName: chosen.best.rideName,
    measured: Boolean(fromMeter),
  };
}

/** Time lost to stops and traffic, in seconds per km. Long stops (breaks) and the ends of a ride are left out. */
export function stopPenalty(rides) {
  let km = 0;
  let stoppedS = 0;
  for (const ride of rides) {
    const { speed } = ride.streams;
    const n = speed.length;
    km += ride.distanceM / 1000;
    for (let i = 0; i < n;) {
      if (speed[i] >= MOVING_MS) {
        i++;
        continue;
      }
      let j = i;
      while (j < n && speed[j] < MOVING_MS) j++;
      const run = (j - i) * ride.stepS;
      if (i > 0 && j < n && run <= MAX_STOP_S) stoppedS += run;
      i = j;
    }
  }
  return km >= MIN_KM_FOR_STOPS ? { secPerKm: stoppedS / km, km } : null;
}

/** Fastest sustained descent speed (98th percentile on grades steeper than -3 %), in km/h. */
export function maxDescent(rides) {
  const speeds = [];
  for (const ride of rides) {
    if (!ride.hasElevation) continue;
    const { speed, grade } = motion(ride);
    for (let i = 0; i < speed.length; i++) {
      if (grade[i] <= DESCENT_GRADE && speed[i] > 1.5) speeds.push(speed[i] * 3.6);
    }
  }
  if (speeds.length < MIN_DESCENT_SAMPLES) return null;
  speeds.sort((a, b) => a - b);
  return { kmh: Math.round(speeds[Math.floor(0.98 * (speeds.length - 1))]), samples: speeds.length };
}

/**
 * Fits sustainable power against ride length, as fraction1h * hours^(-exponent), from long rides.
 * Uses pedalling time only (not descents), matching how the estimator applies power.
 */
export function fadeFit(rides, rider, ftpW) {
  const points = [];
  for (const ride of rides) {
    if (ride.elapsedS < FADE_MIN_RIDE_S || !ride.hasElevation) continue;
    const { watts } = powerSeries(ride, rider);
    const { speed, grade } = motion(ride);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < watts.length; i++) {
      if (speed[i] >= PEDALLING_MS && grade[i] >= -0.02) {
        sum += watts[i];
        count++;
      }
    }
    if (count * ride.stepS < FADE_MIN_PEDALLING_S || sum <= 0) continue;
    points.push({ x: Math.log(ride.elapsedS / 3600), y: Math.log(sum / count / ftpW) });
  }
  if (points.length < 3) return null;

  const xs = points.map((p) => p.x);
  if (Math.exp(Math.max(...xs) - Math.min(...xs)) < FADE_MIN_SPREAD) return null;

  const meanX = xs.reduce((a, b) => a + b, 0) / points.length;
  const meanY = points.reduce((a, p) => a + p.y, 0) / points.length;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.x - meanX) ** 2;
    sxy += (p.x - meanX) * (p.y - meanY);
  }
  if (sxx === 0) return null;

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  return {
    fraction1h: Math.round(clamp(Math.exp(intercept), 0.5, 1.1) * 100) / 100,
    exponent: Math.round(clamp(-slope, 0, 0.5) * 100) / 100,
    rides: points.length,
  };
}

/** Index of the first sample at or beyond the distance. */
function indexAtDistance(dist, metres) {
  let lo = 0;
  let hi = dist.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dist[mid] < metres) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Compares real moving speeds with what the model predicts for the same ground, grade by grade.
 * Returns one speed factor per grade band (real speed divided by model speed), or null if the
 * rides do not cover enough ground. Bands without enough data take their nearest neighbour's value.
 * The model is evaluated without any existing calibration, so the factors replace it rather than stack.
 */
export function calibrateGrades(rides, rider) {
  const bands = GRADE_BUCKET_CENTERS_PCT.length;
  const sumLog = new Float64Array(bands);
  const weight = new Float64Array(bands);
  const model = { ...rider, calibration: null };
  let usedRides = 0;

  for (const ride of rides) {
    if (!ride.hasElevation) continue;
    const route = rideRoute(ride);
    if (!(route.distanceM > MIN_CALIBRATION_RIDE_M)) continue;
    const profile = buildProfile(route, { smoothHalf: RIDE_SMOOTH_HALF });
    const result = profile && estimate(route, profile, model);
    if (!result) continue;

    const { dist, speed } = ride.streams;
    const step = ride.stepS;
    const movingTime = new Float64Array(dist.length);
    const stopped = new Int32Array(dist.length);
    for (let i = 0; i < dist.length; i++) {
      const moving = speed[i] >= MOVING_MS;
      movingTime[i] = (i ? movingTime[i - 1] : 0) + (moving ? step : 0);
      stopped[i] = (i ? stopped[i - 1] : 0) + (moving ? 0 : 1);
    }

    let usedHere = false;
    for (const seg of result.segments) {
      const a = indexAtDistance(dist, seg.startM);
      const b = indexAtDistance(dist, seg.endM);
      if (b <= a || stopped[b] - stopped[a] > 0) continue; // a stop inside would distort the speed
      const metres = dist[b] - dist[a];
      const seconds = movingTime[b] - movingTime[a];
      if (seconds <= 0 || metres < 0.8 * seg.lengthM) continue;

      const ratio = clamp(metres / seconds / seg.speedMs, 0.3, 3);
      const band = bucketOf(seg.grade * 100);
      sumLog[band] += seg.lengthM * Math.log(ratio);
      weight[band] += seg.lengthM;
      usedHere = true;
    }
    if (usedHere) usedRides++;
  }

  const measured = [];
  for (let k = 0; k < bands; k++) {
    measured.push(weight[k] >= MIN_BUCKET_COVERAGE_M ? clamp(Math.exp(sumLog[k] / weight[k]), MIN_FACTOR, MAX_FACTOR) : null);
  }
  if (measured.every((f) => f === null)) return null;

  const gradeFactors = measured.map((f, k) => {
    if (f !== null) return f;
    for (let d = 1; d < bands; d++) {
      if (k - d >= 0 && measured[k - d] !== null) return measured[k - d];
      if (k + d < bands && measured[k + d] !== null) return measured[k + d];
    }
    return 1;
  });

  return {
    gradeFactors,
    coverageKm: Array.from(weight, (m) => m / 1000),
    measuredBands: measured.filter((f) => f !== null).length,
    rideCount: usedRides,
  };
}

/** Everything the rides say about this rider, for the analysis panel. Null when there are no rides. */
export function analyzeRides(rides, rider) {
  if (!rides.length) return null;
  const ftp = estimateFtp(rides, rider);
  return {
    rideCount: rides.length,
    powerRideCount: rides.filter((r) => r.hasPower).length,
    ftp,
    stops: stopPenalty(rides),
    descent: maxDescent(rides),
    fade: ftp ? fadeFit(rides, rider, ftp.ftpW) : null,
    calibration: calibrateGrades(rides, rider),
  };
}
