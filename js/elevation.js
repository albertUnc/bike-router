// Turns the raw route line into an evenly sampled, smoothed elevation profile.
// Raw DEM elevation is noisy and would inflate the climbing total, so ascent and
// descent are computed only from the smoothed samples.

const SAMPLE_STEP_M = 20;
const SMOOTH_HALF_WINDOW = 2; // samples on each side, so a 5-sample (about 100 m) moving average

export function movingAverage(values, half) {
  const prefix = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i++) prefix[i + 1] = prefix[i] + values[i];
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length - 1, i + half);
    out[i] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
  }
  return out;
}

/**
 * @param {{coords:number[][], elevations:number[], distances:Float64Array}} route
 * @returns profile with parallel arrays d (m from start), ele (m, smoothed), lng, lat,
 *          plus count, stepM, distance, ascent, descent, min, max, hasElevation; or null.
 */
export function buildProfile(route, { stepM = SAMPLE_STEP_M, smoothHalf = SMOOTH_HALF_WINDOW } = {}) {
  const { coords, elevations, distances } = route;
  if (coords.length < 2) return null;

  const total = distances[distances.length - 1];
  const hasElevation = elevations.every(Number.isFinite);
  const count = Math.max(2, Math.ceil(total / stepM) + 1);

  const d = new Float64Array(count);
  const rawEle = new Float64Array(count);
  const lng = new Float64Array(count);
  const lat = new Float64Array(count);

  let seg = 0;
  for (let i = 0; i < count; i++) {
    const t = i === count - 1 ? total : i * stepM;
    while (seg < coords.length - 2 && distances[seg + 1] < t) seg++;
    const span = distances[seg + 1] - distances[seg];
    const f = span > 0 ? Math.min(1, Math.max(0, (t - distances[seg]) / span)) : 0;

    d[i] = t;
    lng[i] = coords[seg][0] + (coords[seg + 1][0] - coords[seg][0]) * f;
    lat[i] = coords[seg][1] + (coords[seg + 1][1] - coords[seg][1]) * f;
    rawEle[i] = hasElevation ? elevations[seg] + (elevations[seg + 1] - elevations[seg]) * f : 0;
  }

  const ele = movingAverage(rawEle, smoothHalf);

  let ascent = 0;
  let descent = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < count; i++) {
    if (ele[i] < min) min = ele[i];
    if (ele[i] > max) max = ele[i];
    if (i > 0) {
      const dz = ele[i] - ele[i - 1];
      if (dz > 0) ascent += dz;
      else descent -= dz;
    }
  }

  return { stepM, count, distance: total, d, ele, lng, lat, ascent, descent, min, max, hasElevation };
}

/** Grade in percent around sample i, measured over +/- `half` samples. */
export function gradeAt(profile, i, half = 3) {
  const a = Math.max(0, i - half);
  const b = Math.min(profile.count - 1, i + half);
  const run = profile.d[b] - profile.d[a];
  return run > 0 ? (100 * (profile.ele[b] - profile.ele[a])) / run : 0;
}
