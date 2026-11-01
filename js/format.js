// Unit conversion and display formatting. Internal values are always metres.

const METRES_PER_KM = 1000;
const METRES_PER_MILE = 1609.344;
const METRES_PER_FOOT = 0.3048;

export function distanceFactor(units) {
  return units === 'imperial' ? METRES_PER_MILE : METRES_PER_KM;
}

export function distanceUnit(units) {
  return units === 'imperial' ? 'mi' : 'km';
}

export function elevationFactor(units) {
  return units === 'imperial' ? METRES_PER_FOOT : 1;
}

export function elevationUnit(units) {
  return units === 'imperial' ? 'ft' : 'm';
}

export function formatDistance(metres, units) {
  const value = metres / distanceFactor(units);
  const text = value < 10 ? value.toFixed(2) : value.toFixed(1);
  return `${text} ${distanceUnit(units)}`;
}

export function formatElevation(metres, units) {
  return `${Math.round(metres / elevationFactor(units))} ${elevationUnit(units)}`;
}

export function formatGrade(percent) {
  const rounded = Math.round(percent * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}%`;
}

export function formatSpeed(kmh, units) {
  return units === 'imperial' ? `${(kmh / 1.609344).toFixed(1)} mph` : `${kmh.toFixed(1)} km/h`;
}

/** "45 min" or "3 h 05 min", rounded to the minute. */
export function formatDuration(seconds) {
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} h ${String(minutes).padStart(2, '0')} min` : `${minutes} min`;
}
