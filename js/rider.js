// Rider and bike profiles: defaults, validation and the ride-duration power curve.

import { cleanCalibration } from './calibration.js';
import { newId } from './id.js';

/** Allowed range and default for each editable number. Used by the editor and by sanitize(). */
export const FIELDS = {
  weightKg: { label: 'Rider weight (kg)', min: 30, max: 200, step: 0.5, default: 75 },
  bikeKg: { label: 'Bike + gear weight (kg)', min: 5, max: 40, step: 0.5, default: 10 },
  ftpW: { label: 'FTP (W)', min: 50, max: 600, step: 1, default: 200 },
  cdA: { label: 'CdA (m²)', min: 0.2, max: 0.8, step: 0.01, default: 0.4 },
  crr: { label: 'Rolling resistance Crr', min: 0.002, max: 0.02, step: 0.0005, default: 0.005 },
  maxDescentKmh: { label: 'Max descent speed (km/h)', min: 20, max: 100, step: 1, default: 55 },
  fraction1h: { label: 'Sustainable power for 1 h (% of FTP)', min: 50, max: 110, step: 1, default: 90 },
  exponent: { label: 'Power fade per doubling of duration', min: 0, max: 0.5, step: 0.01, default: 0.15 },
  stopSecPerKm: { label: 'Stop / traffic penalty (s per km)', min: 0, max: 120, step: 1, default: 10 },
  settlementSec: { label: 'Penalty per settlement crossed (s)', min: 0, max: 600, step: 5, default: 30 },
};

const POWER_CURVE_LIMITS = { min: 0.5, max: 1.05 };

function clamp(value, { min, max, default: fallback }) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Profile for a slim-tyre, road-like gravel bike. */
export function defaultProfile(name = 'Gravel bike') {
  return {
    id: newId(),
    name,
    weightKg: FIELDS.weightKg.default,
    bikeKg: FIELDS.bikeKg.default,
    ftpW: FIELDS.ftpW.default,
    cdA: FIELDS.cdA.default,
    crr: FIELDS.crr.default,
    maxDescentKmh: FIELDS.maxDescentKmh.default,
    powerCurve: {
      fraction1h: FIELDS.fraction1h.default / 100,
      exponent: FIELDS.exponent.default,
      min: POWER_CURVE_LIMITS.min,
      max: POWER_CURVE_LIMITS.max,
    },
    stopSecPerKm: FIELDS.stopSecPerKm.default,
    settlementSec: FIELDS.settlementSec.default,
    calibration: null, // speed factors per grade learned from imported rides, or null
  };
}

/** Fills missing values and clamps everything to its allowed range. Safe on imported data. */
export function sanitizeProfile(p) {
  const base = defaultProfile();
  const curve = p?.powerCurve ?? {};
  return {
    id: typeof p?.id === 'string' && p.id ? p.id : base.id,
    name: typeof p?.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 40) : base.name,
    weightKg: clamp(p?.weightKg, FIELDS.weightKg),
    bikeKg: clamp(p?.bikeKg, FIELDS.bikeKg),
    ftpW: clamp(p?.ftpW, FIELDS.ftpW),
    cdA: clamp(p?.cdA, FIELDS.cdA),
    crr: clamp(p?.crr, FIELDS.crr),
    maxDescentKmh: clamp(p?.maxDescentKmh, FIELDS.maxDescentKmh),
    powerCurve: {
      fraction1h: clamp((curve.fraction1h ?? base.powerCurve.fraction1h) * 100, FIELDS.fraction1h) / 100,
      exponent: clamp(curve.exponent, FIELDS.exponent),
      min: POWER_CURVE_LIMITS.min,
      max: POWER_CURVE_LIMITS.max,
    },
    stopSecPerKm: clamp(p?.stopSecPerKm, FIELDS.stopSecPerKm),
    settlementSec: clamp(p?.settlementSec, FIELDS.settlementSec),
    calibration: cleanCalibration(p?.calibration),
  };
}

export function totalMassKg(profile) {
  return profile.weightKg + profile.bikeKg;
}

/**
 * Fraction of FTP the rider can hold for a ride of the given length.
 * One adjustable curve: fraction1h * hours^(-exponent), limited to [min, max].
 */
export function powerFraction(curve, hours) {
  const h = Math.max(hours, 1 / 12); // very short rides are treated as five minutes
  const raw = curve.fraction1h * Math.pow(h, -curve.exponent);
  return Math.min(curve.max, Math.max(curve.min, raw));
}
