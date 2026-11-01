// Imported rides in IndexedDB.
import { STORES, transact } from './db.js';
import { sanitizeRideRecord } from './rides.js';

/** All imported rides, most recent first. Records that fail validation are skipped. */
export async function listRides() {
  const all = await transact(STORES.rides, 'readonly', (store) => store.getAll());
  return all
    .map(sanitizeRideRecord)
    .filter(Boolean)
    .sort((a, b) => (b.startTime ?? b.importedAt) - (a.startTime ?? a.importedAt));
}

export function putRides(records) {
  return transact(STORES.rides, 'readwrite', (store) => {
    for (const record of records) store.put(record);
  });
}

export function deleteRide(id) {
  return transact(STORES.rides, 'readwrite', (store) => store.delete(id));
}
