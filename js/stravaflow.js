// Strava flow: connecting (the login redirect), disconnecting, and syncing rides into the ride history.
// Orchestration only; the pieces that need testing live in strava.js and stravasync.js.
import {
  clearStravaAuth, loadStravaAuth, saveStravaAuth, saveStravaState, takeStravaState,
} from './storage.js';
import { newId } from './id.js';
import { isSameRide } from './rides.js';
import { listRides, putRides } from './ridestore.js';
import {
  StravaError, buildAuthorizeUrl, cleanStravaSettings, createStravaClient, normalizeWorkerUrl,
} from './strava.js';
import { syncActivities } from './stravasync.js';

const AUTO_SYNC_AFTER_S = 6 * 3600;   // an automatic sync at app start only if the last one is older than this
const AUTO_SYNC_DELAY_MS = 2500;      // let the app finish drawing first
const OVERLAP_S = 24 * 3600;          // each sync re-checks the last day, in case something was edited on Strava
const MAX_SKIPPED_IDS = 1000;

/**
 * @param {{settings:object, saveSettings:(s:object)=>void,
 *          notify:(message:string, options?:{error?:boolean, actionLabel?:string, onAction?:()=>void})=>void,
 *          onRidesChanged:()=>void, ui:object}} deps  ui is the object from createStravaUI
 */
export function createStravaFlow({ settings, saveSettings, notify, onRidesChanged, ui }) {
  let syncing = false;
  const nowSec = () => Math.floor(Date.now() / 1000);

  const config = () => cleanStravaSettings(settings.strava);
  const update = (patch) => {
    settings.strava = { ...config(), ...patch };
    saveSettings(settings);
  };
  const state = () => ({
    config: config(),
    athlete: loadStravaAuth()?.athlete ?? null,
    connected: Boolean(loadStravaAuth()),
    syncing,
  });
  const refreshUi = () => ui.refresh(state());

  function makeClient() {
    const workerUrl = normalizeWorkerUrl(config().workerUrl);
    if (!workerUrl) throw new StravaError('Enter the helper address first (it starts with https://).', 'config');
    return createStravaClient({ workerUrl, getAuth: loadStravaAuth, saveAuth: saveStravaAuth });
  }

  const redirectUri = () => `${window.location.origin}${window.location.pathname}`;

  /** Saves the form. Returns an error message for the dialog, or null. */
  function save(values) {
    update({ workerUrl: values.workerUrl.trim(), clientId: values.clientId.trim(), autoSync: values.autoSync, windowDays: values.windowDays });
    refreshUi();
    return null;
  }

  /** Saves the form and sends the browser to Strava's login page. Returns an error message, or null. */
  function connect(values) {
    save(values);
    if (!normalizeWorkerUrl(values.workerUrl)) {
      return 'The helper address must start with https:// (http://localhost works for local testing).';
    }
    const clientId = values.clientId.trim();
    if (!/^\d{3,10}$/.test(clientId)) return "The Client ID is the number shown on Strava's API settings page.";

    const stateValue = newId();
    saveStravaState(stateValue);
    window.location.assign(buildAuthorizeUrl({ clientId, redirectUri: redirectUri(), state: stateValue }));
    return null;
  }

  async function disconnect() {
    if (!window.confirm('Disconnect from Strava? Rides you already imported stay in the app.')) return;
    try {
      await makeClient().deauthorize(); // revokes access on Strava's side; failing to reach it is fine
    } catch { /* no helper address: nothing to revoke through */ }
    clearStravaAuth();
    update({ lastSyncSec: 0, skippedIds: [] });
    notify('Disconnected from Strava.');
    refreshUi();
  }

  /**
   * If the page was opened by Strava's login redirect, finishes the login. Returns true if it was.
   * Strava sends ?code=...&state=... on success and ?error=access_denied when the user says no.
   */
  async function handleRedirect() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('code') && !params.has('error')) return false;
    window.history.replaceState(null, '', window.location.pathname); // the one-time code must not stay in the address bar

    const expected = takeStravaState();
    if (params.get('error')) {
      notify('Strava login was cancelled.', { error: true });
      return true;
    }
    if (!expected || params.get('state') !== expected) {
      notify('The Strava login could not be verified. Try connecting again.', { error: true });
      return true;
    }

    try {
      const auth = await makeClient().exchangeCode(params.get('code'));
      const readsActivities = (params.get('scope') ?? '').includes('activity:read');
      notify(readsActivities
        ? `Connected to Strava${auth.athlete?.name ? ` as ${auth.athlete.name}` : ''}.`
        : 'Connected, but you did not allow reading activities, so nothing can be imported. Connect again and leave that box ticked.',
      { error: !readsActivities });
      refreshUi();
      if (readsActivities) await syncNow({ initial: true });
    } catch (err) {
      notify(err.message, { error: true });
    }
    return true;
  }

  function summary(result) {
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const parts = [result.added ? `Strava: imported ${plural(result.added, 'new ride')}.` : 'Strava: no new rides.'];
    if (result.noGps) parts.push(`${plural(result.noGps, 'activity')} without GPS skipped.`);
    if (result.failed.length) parts.push(`${plural(result.failed.length, 'ride')} could not be used.`);
    if (result.stoppedBy === 'limit') {
      parts.push(`Stopped at Strava's rate limit, ${result.remaining} more waiting. Sync again in about 15 minutes.`);
    } else if (result.remaining) {
      parts.push(`${result.remaining} more waiting. Sync again to continue.`);
    }
    return parts.join(' ');
  }

  async function syncNow({ initial = false, auto = false } = {}) {
    if (syncing) return;
    if (!loadStravaAuth()) {
      notify('Connect to Strava first.', { error: true });
      return;
    }

    syncing = true;
    refreshUi();
    const controller = new AbortController();
    const cancel = { actionLabel: 'Cancel', onAction: () => controller.abort() };
    const startedSec = nowSec();

    try {
      const client = makeClient();
      const cfg = config();
      const rides = await listRides();
      const knownIds = new Set([...rides.map((r) => r.stravaId).filter(Number.isFinite), ...cfg.skippedIds]);
      const afterSec = cfg.lastSyncSec ? cfg.lastSyncSec - OVERLAP_S : (cfg.windowDays ? startedSec - cfg.windowDays * 86400 : 0);

      notify(initial ? 'Connected. Importing your recent rides from Strava…' : 'Syncing with Strava…', cancel);
      const result = await syncActivities({
        client,
        afterSec,
        knownIds,
        isDuplicate: (ride) => rides.some((r) => isSameRide(r, ride)),
        saveRide: async (ride) => {
          await putRides([ride]);
          rides.push(ride);
        },
        signal: controller.signal,
        onProgress: ({ done, total }) => notify(`Syncing with Strava… ${done} of ${total}`, cancel),
      });

      // Only a complete run moves the "last sync" mark; otherwise the next run re-lists and carries on.
      const complete = result.stoppedBy === null && result.remaining === 0;
      update({
        lastSyncSec: complete ? startedSec : cfg.lastSyncSec,
        skippedIds: [...cfg.skippedIds, ...result.skippedIds].slice(-MAX_SKIPPED_IDS),
      });
      notify(summary(result), { error: false });
      if (result.added) onRidesChanged();
    } catch (err) {
      if (err.name === 'AbortError') {
        notify('Strava sync cancelled. Rides imported so far are kept.');
        onRidesChanged();
      } else if (err instanceof StravaError || err.message) {
        // An automatic sync is quiet about "not set up" problems; a manual one explains them.
        if (!(auto && err.code === 'config')) notify(err.message, { error: true });
      }
    } finally {
      syncing = false;
      refreshUi();
    }
  }

  /** Called once at start-up. Finishes a login redirect if there is one, else maybe syncs in the background. */
  async function init() {
    refreshUi();
    if (await handleRedirect()) return;
    const cfg = config();
    if (loadStravaAuth() && cfg.autoSync && nowSec() - cfg.lastSyncSec > AUTO_SYNC_AFTER_S) {
      setTimeout(() => syncNow({ auto: true }), AUTO_SYNC_DELAY_MS);
    }
  }

  return {
    init,
    syncNow,
    openDialog: () => ui.open(state()),
    handlers: { onConnect: connect, onSave: save, onDisconnect: disconnect, onSync: () => syncNow() },
  };
}
