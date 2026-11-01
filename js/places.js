// Saved places: named points the user keeps for reuse (home, a café, a good start). Pure helpers.
import { newId } from './id.js';

const MAX_NAME_LENGTH = 60;
const MAX_PLACES = 500;

export function createPlace(name, lng, lat) {
  return { id: newId(), name: name.trim().slice(0, MAX_NAME_LENGTH) || 'Place', lng, lat, createdAt: Date.now() };
}

/** Validates one place from storage or an import. Returns a clean place, or null if unusable. */
export function sanitizePlace(raw) {
  if (!raw || !Number.isFinite(raw.lng) || !Number.isFinite(raw.lat)) return null;
  if (Math.abs(raw.lng) > 180 || Math.abs(raw.lat) > 90) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, MAX_NAME_LENGTH) : 'Place',
    lng: raw.lng,
    lat: raw.lat,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
  };
}

/** Cleans a list: drops invalid entries, guarantees unique ids, keeps the newest MAX_PLACES. */
export function sanitizePlaces(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const place = sanitizePlace(raw);
    if (!place) continue;
    if (seen.has(place.id)) place.id = newId();
    seen.add(place.id);
    out.push(place);
  }
  return out.slice(-MAX_PLACES);
}

/** New list with the place added, or replacing the one with the same id. */
export function upsertPlace(places, place) {
  const index = places.findIndex((p) => p.id === place.id);
  if (index < 0) return [...places, place];
  return places.map((p, i) => (i === index ? place : p));
}

export function removePlace(places, id) {
  return places.filter((p) => p.id !== id);
}

/** Merges imported places into the existing ones: same id replaces, everything else is kept. */
export function mergePlaces(existing, incoming) {
  return incoming.reduce((list, place) => upsertPlace(list, place), existing);
}
