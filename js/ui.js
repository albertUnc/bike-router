// Panel, status line and dialogs. Holds no app state; main.js drives it.
import { formatDistance, formatDuration, formatElevation, formatSpeed } from './format.js';
import { FIELDS } from './rider.js';
import { SURFACE_LABELS } from './surface.js';

const $ = (id) => document.getElementById(id);
const MIN_SURFACE_SHARE = 0.01;
const LEGEND_STOPS_KMH = { low: 5, high: 38 }; // matches the colour ramp in map.js

// Panel resizing.
const PANEL_DRAG_THRESHOLD_PX = 4;     // movement below this is a tap, not a drag
const PANEL_MIN_OPEN_PX = 120;         // flung or released lower than this, the panel closes
const PANEL_MAX_FRACTION = 0.8;        // tallest the panel can be, as a share of the viewport
const PANEL_MOMENTUM_MS = 180;         // a flick carries the panel as far as this long at release speed
const PANEL_VELOCITY_WINDOW_MS = 100;  // release speed is measured over the last moments of the drag
const PANEL_RESISTANCE = 0.3;          // how much of a pull beyond the limit is followed
const PANEL_SNAP_MS = 360;
const PANEL_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'; // fast start, long soft landing, like iOS sheets

// Editor inputs, in display order. fraction1h is shown as a percentage.
const RIDER_FIELD_ORDER = [
  'weightKg', 'bikeKg', 'ftpW', 'cdA', 'crr', 'maxDescentKmh',
  'fraction1h', 'exponent', 'stopSecPerKm', 'settlementSec',
];

/** Value of an editor field taken from a profile. */
function fieldValue(profile, key) {
  if (key === 'fraction1h') return Math.round(profile.powerCurve.fraction1h * 100);
  if (key === 'exponent') return profile.powerCurve.exponent;
  return profile[key];
}

/**
 * @param {{profiles:{id:string,label:string}[],
 *          onUndo:()=>void, onReverse:()=>void, onClear:()=>void, onFit:()=>void,
 *          onSaveSettings:(values:{apiKey:string, routingProfile:string, units:string})=>void,
 *          onSetMapDefault:()=>void, onOpenSettings:()=>void,
 *          onSelectRider:(id:string)=>void, onEditRider:()=>void, onNewRider:()=>void,
 *          onSaveRider:(raw:object)=>void, onDeleteRider:(id:string)=>void,
 *          panelHeight:number|null, onPanelHeight:(percent:number)=>void,
 *          onExportBackup:()=>void, onImportBackup:(file:File)=>void}} handlers
 */
export function initUI({
  profiles, onUndo, onReverse, onClear, onFit, onSaveSettings, onSetMapDefault, onOpenSettings,
  onSelectRider, onEditRider, onNewRider, onSaveRider, onDeleteRider, panelHeight, onPanelHeight,
  onExportBackup, onImportBackup,
}) {
  const panel = $('panel');
  const status = $('status');

  // Settings dialog.
  const dialog = $('settings-dialog');
  const keyInput = $('set-key');
  const profileSelect = $('set-profile');
  const unitsSelect = $('set-units');
  const defaultNote = $('set-default-note');

  for (const p of profiles) profileSelect.append(new Option(p.label, p.id));

  // Resizable details panel. Dragging the handle follows the finger. On release the panel keeps the
  // momentum of the flick, like a sheet on iOS: it glides to where the flick would have carried it
  // and eases to a stop. Pulling past the limits resists, then springs back. Tapping the handle
  // animates the panel open or shut.
  const toggle = $('panel-toggle');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let savedHeight = panelHeight ?? null; // percent of the viewport height, or null for the default size
  let drag = null;
  let suppressClick = false;
  let animationToken = 0; // a new animation or a grab invalidates the callbacks of an older one

  const maxPx = () => window.innerHeight * PANEL_MAX_FRACTION;

  function setCollapsed(collapsed) {
    panel.classList.toggle('collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
  }

  function applyHeight(value) {
    panel.classList.toggle('sized', value !== null);
    if (value === null) panel.style.removeProperty('--panel-h');
    else panel.style.setProperty('--panel-h', typeof value === 'number' ? `${value}dvh` : value);
  }

  applyHeight(savedHeight);

  /** Height of the panel with only its header showing. */
  function headerHeight() {
    const wasCollapsed = panel.classList.contains('collapsed');
    panel.classList.add('collapsed');
    const height = panel.getBoundingClientRect().height;
    panel.classList.toggle('collapsed', wasCollapsed);
    return height;
  }

  /** Height the open panel rests at: the saved size, or its natural height if none was chosen. */
  function restingOpenHeight() {
    if (savedHeight !== null) return Math.min(maxPx(), (savedHeight / 100) * window.innerHeight);
    const wasSized = panel.classList.contains('sized');
    const wasCollapsed = panel.classList.contains('collapsed');
    panel.classList.remove('sized', 'collapsed');
    const height = panel.getBoundingClientRect().height;
    panel.classList.toggle('sized', wasSized);
    panel.classList.toggle('collapsed', wasCollapsed);
    return height;
  }

  /** Eases the panel between two pixel heights, then calls `done`. */
  function animateHeight(fromPx, toPx, done) {
    const token = ++animationToken;
    const finish = () => {
      if (token !== animationToken) return;
      panel.style.transition = '';
      done();
    };

    if (reduceMotion.matches || Math.abs(toPx - fromPx) < 1) {
      applyHeight(`${toPx}px`);
      finish();
      return;
    }
    applyHeight(`${fromPx}px`);
    void panel.offsetHeight; // commit the starting height before the transition begins
    panel.style.transition = `height ${PANEL_SNAP_MS}ms ${PANEL_EASE}`;
    applyHeight(`${toPx}px`);

    panel.addEventListener('transitionend', (e) => {
      if (e.target === panel && e.propertyName === 'height') finish();
    }, { once: true });
    setTimeout(finish, PANEL_SNAP_MS + 100); // in case the transition event never arrives
  }

  /** Dragging past the limits meets resistance instead of a hard stop. */
  function withResistance(rawPx) {
    const max = maxPx();
    if (rawPx > max) return max + (rawPx - max) * PANEL_RESISTANCE;
    return Math.max(0, rawPx);
  }

  toggle.addEventListener('pointerdown', (e) => {
    toggle.setPointerCapture(e.pointerId);

    // Grabbing the panel mid-animation freezes it where it currently is.
    const current = panel.getBoundingClientRect().height;
    if (panel.style.transition) {
      animationToken++;
      panel.style.transition = '';
      applyHeight(`${current}px`);
    }
    drag = { startY: e.clientY, startHeight: current, moved: false, px: current, samples: [{ t: e.timeStamp, y: e.clientY }] };
  });

  toggle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.samples.push({ t: e.timeStamp, y: e.clientY });
    while (drag.samples.length > 2 && e.timeStamp - drag.samples[0].t > PANEL_VELOCITY_WINDOW_MS) drag.samples.shift();

    const delta = drag.startY - e.clientY; // dragging up makes the panel taller
    if (!drag.moved && Math.abs(delta) < PANEL_DRAG_THRESHOLD_PX) return;
    if (!drag.moved) {
      drag.moved = true;
      setCollapsed(false);
    }
    drag.px = withResistance(drag.startHeight + delta);
    applyHeight(`${drag.px}px`);
  });

  function endDrag() {
    if (!drag) return;
    const finished = drag;
    drag = null;
    if (!finished.moved) return;

    suppressClick = true; // the click that follows a drag must not also toggle the panel
    setTimeout(() => { suppressClick = false; }, 0);

    // Release velocity in px/ms, positive while the panel was growing.
    const first = finished.samples[0];
    const last = finished.samples[finished.samples.length - 1];
    const elapsed = last.t - first.t;
    const velocity = elapsed > 0 ? (first.y - last.y) / elapsed : 0;
    const projected = finished.px + velocity * PANEL_MOMENTUM_MS;

    if (projected < PANEL_MIN_OPEN_PX) {
      // Dragged or flicked shut: slide down to the header, but remember the last proper size.
      animateHeight(finished.px, headerHeight(), () => {
        setCollapsed(true);
        applyHeight(savedHeight);
      });
      return;
    }

    const target = Math.min(maxPx(), Math.max(PANEL_MIN_OPEN_PX, projected));
    animateHeight(finished.px, target, () => {
      savedHeight = Math.round((target / window.innerHeight) * 1000) / 10;
      applyHeight(savedHeight);
      onPanelHeight(savedHeight);
    });
  }

  toggle.addEventListener('pointerup', endDrag);
  toggle.addEventListener('pointercancel', endDrag);

  toggle.addEventListener('click', () => {
    if (suppressClick) return;
    if (panel.classList.contains('collapsed')) {
      const from = headerHeight();
      const target = restingOpenHeight();
      setCollapsed(false);
      animateHeight(from, target, () => applyHeight(savedHeight));
    } else {
      animateHeight(panel.getBoundingClientRect().height, headerHeight(), () => {
        setCollapsed(true);
        applyHeight(savedHeight);
      });
    }
  });

  $('btn-undo').addEventListener('click', onUndo);
  $('btn-reverse').addEventListener('click', onReverse);
  $('btn-clear').addEventListener('click', onClear);
  $('btn-fit').addEventListener('click', onFit);

  $('set-default-view').addEventListener('click', () => {
    onSetMapDefault();
    defaultNote.textContent = 'Saved';
  });

  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'save') return;
    onSaveSettings({
      apiKey: keyInput.value.trim(),
      routingProfile: profileSelect.value,
      units: unitsSelect.value,
    });
  });

  function openSettings(settings) {
    keyInput.value = settings.apiKey;
    profileSelect.value = settings.routingProfile;
    unitsSelect.value = settings.units;
    defaultNote.textContent = '';
    setBackupNote('');
    dialog.returnValue = '';
    dialog.showModal();
  }

  $('settings-btn').addEventListener('click', onOpenSettings);

  // Backup export and import (inside the settings dialog).
  const importFile = $('import-file');
  const backupNote = $('backup-note');
  $('btn-export-backup').addEventListener('click', onExportBackup);
  $('btn-import-backup').addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', () => {
    const file = importFile.files[0];
    importFile.value = ''; // allows choosing the same file again
    if (file) onImportBackup(file);
  });

  function setBackupNote(text, { error = false } = {}) {
    backupNote.textContent = text;
    backupNote.style.color = error ? 'var(--danger)' : '';
  }

  // Rider profile selector and editor.
  const riderSelect = $('rider-select');
  const riderDialog = $('rider-dialog');
  const riderName = $('rider-name');
  const riderFields = $('rider-fields');
  const riderInputs = {};
  let editingId = null;

  for (const key of RIDER_FIELD_ORDER) {
    const spec = FIELDS[key];
    const label = document.createElement('label');
    label.append(spec.label);
    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any'; // out-of-range values are clamped on save instead of blocking the form
    input.required = true;
    input.inputMode = 'decimal';
    label.append(input);
    riderFields.append(label);
    riderInputs[key] = input;
  }

  riderSelect.addEventListener('change', () => onSelectRider(riderSelect.value));
  $('btn-rider-edit').addEventListener('click', onEditRider);
  $('btn-rider-new').addEventListener('click', onNewRider);

  riderDialog.addEventListener('close', () => {
    if (riderDialog.returnValue === 'delete') {
      onDeleteRider(editingId);
      return;
    }
    if (riderDialog.returnValue !== 'save') return;

    const v = (key) => Number(riderInputs[key].value);
    onSaveRider({
      id: editingId,
      name: riderName.value,
      weightKg: v('weightKg'),
      bikeKg: v('bikeKg'),
      ftpW: v('ftpW'),
      cdA: v('cdA'),
      crr: v('crr'),
      maxDescentKmh: v('maxDescentKmh'),
      powerCurve: { fraction1h: v('fraction1h') / 100, exponent: v('exponent') },
      stopSecPerKm: v('stopSecPerKm'),
      settlementSec: v('settlementSec'),
    });
  });

  function setRiders(riders, activeId) {
    riderSelect.replaceChildren(...riders.map((r) => new Option(r.name, r.id)));
    riderSelect.value = activeId;
  }

  function openRider(rider, { canDelete }) {
    editingId = rider.id;
    riderName.value = rider.name;
    for (const key of RIDER_FIELD_ORDER) riderInputs[key].value = fieldValue(rider, key);
    $('rider-delete').hidden = !canDelete;
    riderDialog.returnValue = '';
    riderDialog.showModal();
  }

  /** Shows a message under the stats, optionally with a clickable action. */
  function setStatus(message, { kind = 'info', actionLabel, onAction } = {}) {
    status.className = `status ${kind}`;
    status.replaceChildren();
    if (!message) return;
    status.append(message);
    if (actionLabel) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'link-btn';
      button.textContent = actionLabel;
      button.addEventListener('click', onAction);
      status.append(' ', button);
    }
  }

  /**
   * @param {{distanceM:number, ascentM:number, descentM:number, timeSec?:number, avgKmh?:number}|null} stats
   */
  function setStats(stats, units) {
    const has = (value) => stats && Number.isFinite(value);
    $('stat-distance').textContent = stats ? formatDistance(stats.distanceM, units) : '–';
    $('stat-ascent').textContent = stats ? formatElevation(stats.ascentM, units) : '–';
    $('stat-descent').textContent = stats ? formatElevation(stats.descentM, units) : '–';
    $('stat-time').textContent = has(stats?.timeSec) ? formatDuration(stats.timeSec) : '–';
    $('stat-speed').textContent = has(stats?.avgKmh) ? formatSpeed(stats.avgKmh, units) : '–';
    $('legend').hidden = !has(stats?.timeSec);
    if (!$('legend').hidden) {
      const factor = units === 'imperial' ? 1 / 1.609344 : 1;
      $('legend-low').textContent = String(Math.round(LEGEND_STOPS_KMH.low * factor));
      $('legend-high').textContent = `${Math.round(LEGEND_STOPS_KMH.high * factor)}+ ${units === 'imperial' ? 'mph' : 'km/h'}`;
    }
  }

  /** @param {{type:string, share:number}[]|null} breakdown */
  function setSurface(breakdown) {
    $('surface-summary').textContent = (breakdown ?? [])
      .filter((s) => s.share >= MIN_SURFACE_SHARE)
      .map((s) => `${SURFACE_LABELS[s.type] ?? s.type} ${Math.round(s.share * 100)}%`)
      .join(' · ');
  }

  /** One line stating what the time estimate assumed. */
  function setEstimateNote(text) {
    $('estimate-note').textContent = text ?? '';
  }

  return {
    openSettings, setStatus, setStats, setSurface, setEstimateNote, setRiders, openRider, setBackupNote,
    /** Opens the panel if it was collapsed, so something that needs attention is visible. */
    expandPanel: () => setCollapsed(false),
  };
}
