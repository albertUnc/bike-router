// JSON backup of everything the user keeps: settings, rider profiles, saved routes and imported rides.
// The API key is deliberately left out so a backup file is safe to store or share.
import { sanitizePlaces } from './places.js';
import { sanitizeProfile } from './rider.js';
import { sanitizeRideRecord } from './rides.js';
import { sanitizeRouteRecord } from './routes.js';

const FORMAT = 'bike-router-backup';
const VERSION = 1;
export const MAX_BACKUP_BYTES = 60 * 1024 * 1024;

const UNITS = ['metric', 'imperial'];

/** Settings that travel with a backup. */
function exportableSettings(settings) {
  return {
    units: settings.units,
    routingProfile: settings.routingProfile,
    activeProfileId: settings.activeProfileId,
    mapDefault: settings.mapDefault,
  };
}

export function buildBackup({ settings, profiles, routes, rides = [], places = [], time = new Date() }) {
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: time.toISOString(),
    settings: exportableSettings(settings),
    profiles,
    routes,
    rides,
    places,
  };
}

function cleanSettings(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (UNITS.includes(raw.units)) out.units = raw.units;
  if (typeof raw.routingProfile === 'string') out.routingProfile = raw.routingProfile.slice(0, 40);
  if (typeof raw.activeProfileId === 'string') out.activeProfileId = raw.activeProfileId;

  const view = raw.mapDefault;
  if (view && Array.isArray(view.center) && view.center.length === 2
    && view.center.every(Number.isFinite) && Number.isFinite(view.zoom)) {
    out.mapDefault = { center: [view.center[0], view.center[1]], zoom: view.zoom };
  }
  return out;
}

/**
 * Parses and validates backup text. Everything is sanitised, so a hand-edited file cannot
 * put invalid data into the app. Throws an Error with a readable message if the file is unusable.
 * @returns {{settings:object, profiles:object[], routes:object[], rides:object[], places:object[], skippedRoutes:number, skippedRides:number}}
 */
export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!data || data.format !== FORMAT) throw new Error('That file is not a Bike Router backup.');
  if (!Number.isInteger(data.version) || data.version > VERSION) {
    throw new Error('That backup was made by a newer version of the app.');
  }

  const profiles = Array.isArray(data.profiles) ? data.profiles.map(sanitizeProfile) : [];
  const rawRoutes = Array.isArray(data.routes) ? data.routes : [];
  const routes = rawRoutes.map(sanitizeRouteRecord).filter(Boolean);
  const rawRides = Array.isArray(data.rides) ? data.rides : [];
  const rides = rawRides.map(sanitizeRideRecord).filter(Boolean);

  return {
    settings: cleanSettings(data.settings),
    profiles,
    routes,
    rides,
    places: sanitizePlaces(data.places),
    skippedRoutes: rawRoutes.length - routes.length,
    skippedRides: rawRides.length - rides.length,
  };
}
