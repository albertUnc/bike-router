// Saved-route records: converting between a live route and the compact JSON form kept in storage.
//
// Record fields: id, name, createdAt, updatedAt, profileIdUsed, routeType, waypoints,
// geometry { coords: flat [lng, lat, ele, ...] with null for a missing elevation },
// surface, wayType, waypointIndices, stats { distanceM, ascentM, descentM, timeSec }.
import { cumulativeDistances } from './geo.js';
import { newId } from './id.js';
import { normalizeWaypoints } from './waypoints.js';

const COORD_DECIMALS = 5;   // about 1 m
const MAX_POINTS = 200000;  // refuses absurd imports
const MAX_NAME_LENGTH = 80;

const round = (value, decimals) => Number(value.toFixed(decimals));
const finiteOr = (value, fallback) => (Number.isFinite(value) ? value : fallback);

/**
 * @param {{id?:string, name:string, createdAt?:number, waypoints:object[], route:object,
 *          stats:{distanceM:number, ascentM:number, descentM:number, timeSec:number},
 *          riderId:string|null, routeType:string}} input
 */
export function packRoute({ id, name, createdAt, waypoints, route, stats, riderId, routeType }) {
  const flat = [];
  route.coords.forEach(([lng, lat], i) => {
    const ele = route.elevations[i];
    flat.push(round(lng, COORD_DECIMALS), round(lat, COORD_DECIMALS), Number.isFinite(ele) ? round(ele, 1) : null);
  });
  const now = Date.now();
  return {
    id: id ?? newId(),
    name: name.trim().slice(0, MAX_NAME_LENGTH) || 'Untitled route',
    createdAt: createdAt ?? now,
    updatedAt: now,
    profileIdUsed: riderId,
    routeType,
    waypoints: waypoints.map((w) => ({ id: w.id, lng: w.lng, lat: w.lat, name: w.name })),
    geometry: { coords: flat },
    surface: route.surface,
    wayType: route.wayType,
    waypointIndices: route.waypointIndices,
    stats: { ...stats },
  };
}

/** Rebuilds the route object the rest of the app works with (same shape as routing.route()). */
export function unpackRoute(record) {
  const flat = record.geometry.coords;
  const coords = [];
  const elevations = [];
  for (let i = 0; i < flat.length; i += 3) {
    coords.push([flat[i], flat[i + 1]]);
    elevations.push(flat[i + 2] ?? NaN);
  }
  const distances = cumulativeDistances(coords);
  return {
    engine: 'saved',
    profile: record.routeType,
    coords,
    elevations,
    distances,
    distanceM: distances[distances.length - 1],
    surface: record.surface,
    wayType: record.wayType,
    waypointIndices: record.waypointIndices,
  };
}

function cleanRanges(ranges, pointCount) {
  if (!Array.isArray(ranges)) return [];
  return ranges
    .filter((r) => r && Number.isInteger(r.from) && Number.isInteger(r.to)
      && r.from >= 0 && r.to >= r.from && r.to < pointCount && typeof r.type === 'string')
    .map((r) => ({ from: r.from, to: r.to, type: r.type.slice(0, 30) }));
}

/** Validates a record from storage or an import file. Returns a clean record, or null if unusable. */
export function sanitizeRouteRecord(raw) {
  const flat = raw?.geometry?.coords;
  if (!Array.isArray(flat) || flat.length < 6 || flat.length % 3 !== 0 || flat.length / 3 > MAX_POINTS) return null;

  for (let i = 0; i < flat.length; i += 3) {
    if (!Number.isFinite(flat[i]) || !Number.isFinite(flat[i + 1])) return null;
    if (flat[i + 2] !== null && !Number.isFinite(flat[i + 2])) return null;
  }
  const pointCount = flat.length / 3;

  const waypoints = normalizeWaypoints(raw.waypoints);
  if (!waypoints.length) return null;

  const indices = Array.isArray(raw.waypointIndices)
    && raw.waypointIndices.length === waypoints.length
    && raw.waypointIndices.every((n) => Number.isInteger(n) && n >= 0 && n < pointCount)
    ? raw.waypointIndices
    : [];

  const stats = raw.stats ?? {};
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, MAX_NAME_LENGTH) : 'Untitled route',
    createdAt: finiteOr(raw.createdAt, Date.now()),
    updatedAt: finiteOr(raw.updatedAt, finiteOr(raw.createdAt, Date.now())),
    profileIdUsed: typeof raw.profileIdUsed === 'string' ? raw.profileIdUsed : null,
    routeType: typeof raw.routeType === 'string' ? raw.routeType : 'cycling-road',
    waypoints,
    geometry: { coords: flat },
    surface: cleanRanges(raw.surface, pointCount),
    wayType: cleanRanges(raw.wayType, pointCount),
    waypointIndices: indices,
    stats: {
      distanceM: finiteOr(stats.distanceM, 0),
      ascentM: finiteOr(stats.ascentM, 0),
      descentM: finiteOr(stats.descentM, 0),
      timeSec: finiteOr(stats.timeSec, 0),
    },
  };
}
