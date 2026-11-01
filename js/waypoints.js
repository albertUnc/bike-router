// Waypoint list model and pure editing operations. Nothing here touches the DOM or the map,
// so saved routes, GPX export and the loop generator can reuse it unchanged.
//
// A waypoint is { id, lng, lat, name }. The id is stable across reordering and duplication;
// an empty name means "use the default label for its position".

import { newId } from './id.js';

const SAME_PLACE_DEGREES = 1e-6; // about 0.1 m

export function createWaypoint(lng, lat, name = '') {
  return { id: newId(), lng, lat, name };
}

/** Copy of a waypoint at the same place, with its own id. */
export function copyWaypoint(waypoint) {
  return { ...waypoint, id: newId() };
}

/** Cleans a list that came from storage or an import: drops invalid entries, guarantees unique ids. */
export function normalizeWaypoints(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list
    .filter((w) => w && Number.isFinite(w.lng) && Number.isFinite(w.lat))
    .map((w) => {
      const id = typeof w.id === 'string' && w.id && !seen.has(w.id) ? w.id : newId();
      seen.add(id);
      return { id, lng: w.lng, lat: w.lat, name: typeof w.name === 'string' ? w.name.slice(0, 60) : '' };
    });
}

/** New list with `waypoint` inserted at `index` (clamped to the ends). */
export function insertWaypoint(list, index, waypoint) {
  const at = Math.max(0, Math.min(index, list.length));
  return [...list.slice(0, at), waypoint, ...list.slice(at)];
}

export function removeWaypoint(list, index) {
  return list.filter((_, i) => i !== index);
}

/** Inserts a copy of the waypoint right after the original. */
export function duplicateWaypoint(list, index) {
  if (index < 0 || index >= list.length) return list;
  return insertWaypoint(list, index + 1, copyWaypoint(list[index]));
}

/** Moves the waypoint at `from` so it ends up at index `to`. */
export function moveWaypoint(list, from, to) {
  if (from === to || from < 0 || from >= list.length || to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function reverseWaypoints(list) {
  return [...list].reverse();
}

export function defaultLabel(index, count) {
  if (index === 0) return 'Start';
  if (index === count - 1) return 'Finish';
  return `Stop ${index}`;
}

/** Short marker text and role for a position in the list: A, 1, 2 ... B. */
export function badge(index, count) {
  if (index === 0) return { text: 'A', role: 'start' };
  if (index === count - 1) return { text: 'B', role: 'end' };
  return { text: String(index), role: 'via' };
}

/**
 * Removes consecutive waypoints at the same place; routing engines reject zero-length legs.
 * `indexMap[i]` is the position in `unique` of the original waypoint i.
 */
export function dedupeAdjacent(list) {
  const unique = [];
  const indexMap = [];
  for (const w of list) {
    const last = unique[unique.length - 1];
    const same = last
      && Math.abs(last.lng - w.lng) < SAME_PLACE_DEGREES
      && Math.abs(last.lat - w.lat) < SAME_PLACE_DEGREES;
    if (!same) unique.push(w);
    indexMap.push(unique.length - 1);
  }
  return { unique, indexMap };
}

/**
 * Which leg (between waypoint k and k+1) a route coordinate belongs to.
 * @param {number[]} waypointIndices coordinate index of every waypoint along the route
 */
export function legIndexAt(waypointIndices, coordIndex) {
  for (let k = waypointIndices.length - 2; k >= 0; k--) {
    if (waypointIndices[k] <= coordIndex) return k;
  }
  return 0;
}
