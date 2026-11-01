// Steady-state cycling power balance. No wind, constant air density.
//
//   power * efficiency = v * (rolling + gravity) + 0.5 * rho * CdA * v^3
//
// where rolling = crr * m * g * cos(theta) and gravity = m * g * sin(theta).

const GRAVITY = 9.80665;       // m/s^2
export const AIR_DENSITY = 1.2; // kg/m^3, about 15 C at moderate altitude
export const DRIVETRAIN_EFFICIENCY = 0.97;

const MAX_SPEED_MS = 40;       // upper bound of the search (144 km/h)
const BISECTION_STEPS = 60;

/**
 * Speed in m/s at which the given pedalling power balances all resistive forces.
 *
 * @param {{powerW:number, grade:number, massKg:number, crr:number, cdA:number,
 *          efficiency?:number, airDensity?:number}} p
 *   grade is rise over run (0.05 is a 5 % climb, negative for descents).
 *   With zero power on a descent this is the coasting terminal speed.
 */
export function solveSpeed({ powerW, grade, massKg, crr, cdA, efficiency = DRIVETRAIN_EFFICIENCY, airDensity = AIR_DENSITY }) {
  const theta = Math.atan(grade);
  const slopeForce = massKg * GRAVITY * (crr * Math.cos(theta) + Math.sin(theta)); // N, negative when it pushes forward
  const dragCoeff = 0.5 * airDensity * cdA;                                         // N per (m/s)^2
  const available = Math.max(0, powerW) * efficiency;                               // W at the wheel

  // power(v) = v * slopeForce + dragCoeff * v^3 is the power needed to hold speed v.
  const needed = (v) => v * slopeForce + dragCoeff * v * v * v;

  if (available <= 0) {
    return slopeForce < 0 ? Math.sqrt(-slopeForce / dragCoeff) : 0;
  }

  // needed(0) = 0 < available, and needed() exceeds it at the upper bound, so there is a root in between.
  // On descents needed() first dips below zero and then rises, which still crosses `available` exactly once.
  let lo = 0;
  let hi = MAX_SPEED_MS;
  for (let i = 0; i < BISECTION_STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (needed(mid) < available) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Pedalling power in watts needed to hold `speed` (m/s) on `grade`, optionally while accelerating
 * (`accel` in m/s^2). The inverse of solveSpeed for a steady speed.
 */
export function powerAtSpeed({ speed, grade, accel = 0, massKg, crr, cdA, efficiency = DRIVETRAIN_EFFICIENCY, airDensity = AIR_DENSITY }) {
  const theta = Math.atan(grade);
  const force =
    massKg * GRAVITY * (crr * Math.cos(theta) + Math.sin(theta)) +
    0.5 * airDensity * cdA * speed * speed +
    massKg * accel;
  return (force * speed) / efficiency;
}
