// Everything the user keeps in the browser. Values are JSON in localStorage under one prefix.
import { sanitizeProfile } from './rider.js';
import { sanitizePlaces } from './places.js';
import { normalizeWaypoints } from './waypoints.js';

const PREFIX = 'bikerouter:v1:';

const DEFAULT_SETTINGS = {
  apiKey: '',
  units: 'metric',
  routingProfile: 'cycling-road',
  activeProfileId: null,
  stopsOpen: true,
  panelHeight: null, // details panel height as a percent of the viewport; null is the default size
  loopPrefs: null,   // last options used in the loop generator; null until first use
  strava: null,      // Strava connection settings (see strava.js); the login tokens are kept separately
  mapDefault: null, // { center: [lng, lat], zoom }
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...read('settings', {}) };
}

export function saveSettings(settings) {
  return write('settings', settings);
}

/** Rider/bike profiles. Always sanitised, so a hand-edited or imported file cannot break the model. */
export function loadProfiles() {
  const stored = read('profiles', []);
  return Array.isArray(stored) ? stored.map(sanitizeProfile) : [];
}

export function saveProfiles(profiles) {
  return write('profiles', profiles);
}

/** The waypoints of the route being edited, so a page reload does not lose them. */
export function loadDraft() {
  return normalizeWaypoints(read('draft', []));
}

export function saveDraft(waypoints) {
  return write('draft', waypoints);
}

/** Saved places (named points kept for reuse). */
export function loadPlaces() {
  return sanitizePlaces(read('places', []));
}

export function savePlaces(places) {
  return write('places', places);
}

/**
 * Strava login tokens. Kept apart from the settings so they are never part of a backup.
 * Shape: { accessToken, refreshToken, expiresAt, athlete }.
 */
export function loadStravaAuth() {
  const auth = read('strava-auth', null);
  const valid = auth && typeof auth.accessToken === 'string' && typeof auth.refreshToken === 'string' && Number.isFinite(auth.expiresAt);
  return valid ? auth : null;
}

export function saveStravaAuth(auth) {
  return write('strava-auth', auth);
}

export function clearStravaAuth() {
  try {
    localStorage.removeItem(PREFIX + 'strava-auth');
  } catch { /* storage unavailable */ }
}

/** The random value sent to Strava when logging in; it must come back unchanged. */
export function saveStravaState(state) {
  return write('strava-state', state);
}

export function takeStravaState() {
  const state = read('strava-state', null);
  try {
    localStorage.removeItem(PREFIX + 'strava-state');
  } catch { /* storage unavailable */ }
  return typeof state === 'string' ? state : null;
}
