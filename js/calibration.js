// Calibration of the speed model to real rides: one speed factor per band of road grade.
// Bands are centred on the values below; a grade between two centres gets an interpolated factor.

export const GRADE_BUCKET_EDGES_PCT = [-8, -5, -3, -1, 1, 3, 5, 8];            // 9 bands
export const GRADE_BUCKET_CENTERS_PCT = [-10, -6.5, -4, -2, 0, 2, 4, 6.5, 10];
export const MIN_FACTOR = 0.5;
export const MAX_FACTOR = 1.6;

const BUCKET_COUNT = GRADE_BUCKET_CENTERS_PCT.length;

/** Index of the band a grade (in percent) falls in. */
export function bucketOf(gradePct) {
  let i = 0;
  while (i < GRADE_BUCKET_EDGES_PCT.length && gradePct >= GRADE_BUCKET_EDGES_PCT[i]) i++;
  return i;
}

/** Validates stored calibration. Returns null if it is missing or unusable. */
export function cleanCalibration(raw) {
  const factors = raw?.gradeFactors;
  if (!Array.isArray(factors) || factors.length !== BUCKET_COUNT || !factors.every(Number.isFinite)) return null;
  return {
    gradeFactors: factors.map((f) => Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, f))),
    rideCount: Number.isInteger(raw.rideCount) && raw.rideCount >= 0 ? raw.rideCount : 0,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
  };
}

/** Speed factor for a grade given as rise over run (0.05 is 5 %). 1 when there is no calibration. */
export function gradeFactor(calibration, grade) {
  if (!calibration) return 1;
  const factors = calibration.gradeFactors;
  const pct = grade * 100;
  const centers = GRADE_BUCKET_CENTERS_PCT;
  if (pct <= centers[0]) return factors[0];
  if (pct >= centers[BUCKET_COUNT - 1]) return factors[BUCKET_COUNT - 1];

  let k = 0;
  while (pct >= centers[k + 1]) k++;
  const t = (pct - centers[k]) / (centers[k + 1] - centers[k]);
  return factors[k] + (factors[k + 1] - factors[k]) * t;
}
