// Saved routes in IndexedDB. Route geometry can be hundreds of kilobytes, which would quickly
// fill localStorage's small quota.
import { STORES, transact } from './db.js';
import { sanitizeRouteRecord } from './routes.js';

/** All saved routes, newest first. Records that fail validation are skipped. */
export async function listRoutes() {
  const all = await transact(STORES.routes, 'readonly', (store) => store.getAll());
  return all
    .map(sanitizeRouteRecord)
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function putRoute(record) {
  return transact(STORES.routes, 'readwrite', (store) => store.put(record));
}

export function putRoutes(records) {
  return transact(STORES.routes, 'readwrite', (store) => {
    for (const record of records) store.put(record);
  });
}

export function deleteRoute(id) {
  return transact(STORES.routes, 'readwrite', (store) => store.delete(id));
}
