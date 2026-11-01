// Strava dialog: the helper address, Client ID, sync options, and the connect, sync and disconnect
// buttons. Holds no app state; stravaflow.js supplies the state and does the work.

const $ = (id) => document.getElementById(id);
const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * @param {{onConnect:(values:object)=>string|null, onSave:(values:object)=>string|null,
 *          onDisconnect:()=>void, onSync:()=>void}} handlers
 *   onConnect and onSave return an error message to show (the dialog reopens), or null when fine.
 */
export function createStravaUI({ onConnect, onSave, onDisconnect, onSync }) {
  const dialog = $('strava-dialog');
  const workerInput = $('strava-worker');
  const clientInput = $('strava-client-id');
  const autoBox = $('strava-auto');
  const windowSelect = $('strava-window');
  const statusEl = $('strava-status');
  const connectBtn = $('strava-connect');
  const saveBtn = $('strava-save');
  const disconnectBtn = $('strava-disconnect');
  const syncBtn = $('strava-sync');
  const quickSync = $('btn-sync-strava');

  $('strava-domain').textContent = window.location.hostname;
  $('strava-origin').textContent = window.location.origin;

  let lastState = null;

  function values() {
    return {
      workerUrl: workerInput.value,
      clientId: clientInput.value,
      autoSync: autoBox.checked,
      windowDays: Number(windowSelect.value),
    };
  }

  function setStatus(text, { error = false } = {}) {
    statusEl.textContent = text;
    statusEl.style.color = error ? 'var(--danger)' : '';
  }

  /** Updates what depends on the connection: status text, which buttons show, which one Enter triggers. */
  function refresh(state) {
    lastState = state;
    const { config, athlete, connected, syncing } = state;

    connectBtn.hidden = connected;
    connectBtn.type = connected ? 'button' : 'submit';
    saveBtn.hidden = !connected;
    saveBtn.type = connected ? 'submit' : 'button';
    disconnectBtn.hidden = !connected;
    syncBtn.hidden = !connected;
    syncBtn.disabled = syncing;
    quickSync.hidden = !connected;
    quickSync.disabled = syncing;

    if (!connected) {
      setStatus('Not connected.');
    } else {
      const who = athlete?.name ? ` as ${athlete.name}` : '';
      const last = config.lastSyncSec ? `Last sync: ${DATE_FORMAT.format(config.lastSyncSec * 1000)}.` : 'Not synced yet.';
      setStatus(`Connected${who}. ${syncing ? 'Syncing…' : last}`);
    }
  }

  function fill(state, error) {
    workerInput.value = state.config.workerUrl;
    clientInput.value = state.config.clientId;
    autoBox.checked = state.config.autoSync;
    windowSelect.value = String(state.config.windowDays);
    refresh(state);
    if (error) setStatus(error, { error: true });
  }

  dialog.addEventListener('close', () => {
    const action = dialog.returnValue;
    if (action !== 'connect' && action !== 'save') return;
    const error = action === 'connect' ? onConnect(values()) : onSave(values());
    if (error && lastState) {
      fill({ ...lastState, config: { ...lastState.config, ...values() } }, error);
      dialog.returnValue = '';
      dialog.showModal();
    }
  });

  disconnectBtn.addEventListener('click', onDisconnect);
  syncBtn.addEventListener('click', onSync);
  quickSync.addEventListener('click', onSync);

  return {
    open: (state) => {
      fill(state);
      dialog.returnValue = '';
      dialog.showModal();
    },
    refresh,
    setStatus,
  };
}
