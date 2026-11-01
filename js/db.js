// Shared IndexedDB access. Saved routes and imported rides each live in their own object store.
// Every function returns a promise and rejects if the browser has no usable IndexedDB
// (for example some private-browsing modes).

const DB_NAME = 'bikerouter';
const DB_VERSION = 2; // 2 added the rides store
export const STORES = { routes: 'routes', rides: 'rides' };

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('This browser has no local database available.'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        for (const name of Object.values(STORES)) {
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not open the local database.'));
      request.onblocked = () => reject(new Error('Close the other tabs of this app and try again.'));
    });
    dbPromise.catch(() => { dbPromise = null; }); // allow a retry after a failure
  }
  return dbPromise;
}

/** Runs `work(store)` in a transaction on one store and resolves once the transaction has committed. */
export async function transact(storeName, mode, work) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? new Error('Local database error.'));
    tx.onabort = () => reject(tx.error ?? new Error('Saving was cancelled (the browser may be out of space).'));
    const request = work(tx.objectStore(storeName));
    if (request) request.onsuccess = () => { result = request.result; };
  });
}
