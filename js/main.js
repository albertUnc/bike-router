// Wires the modules together and owns the app state: waypoints, current route, riders, saved routes
// and the loop candidates being compared.
import {
  loadSettings, saveSettings, loadDraft, saveDraft, loadProfiles, saveProfiles, loadPlaces, savePlaces,
} from './storage.js';
import { deleteRoute, listRoutes, putRoute, putRoutes } from './routestore.js';
import { packRoute, unpackRoute } from './routes.js';
import { buildGpx, slugify } from './gpx.js';
import { buildBackup, parseBackup, MAX_BACKUP_BYTES } from './backup.js';
import { createMapView } from './map.js';
import { createElevationChart } from './chart.js';
import { buildProfile } from './elevation.js';
import { estimate, timeBetween } from './estimator.js';
import { generateLoops, loopWaypoints } from './generator.js';
import { nearestIndex } from './geo.js';
import { defaultProfile, sanitizeProfile } from './rider.js';
import { surfaceBreakdown } from './surface.js';
import { route as computeRoute, roundTrip, profiles } from './routing/index.js';
import { initSearch } from './search.js';
import { createStopsList } from './stops.js';
import { createLibrary } from './library.js';
import { createLoopUI } from './loops.js';
import { analyzeRides } from './rideanalysis.js';
import { deleteRide, listRides, putRides } from './ridestore.js';
import { buildRide, isSameRide, parseRideFile } from './rides.js';
import { createRidesUI } from './ridesui.js';
import { createPlace, mergePlaces, removePlace, upsertPlace } from './places.js';
import { createPlacesUI } from './placesui.js';
import { createStravaFlow } from './stravaflow.js';
import { createStravaUI } from './stravaui.js';
import { askName, wireDialogButtons } from './dialogs.js';
import { downloadText } from './download.js';
import { initUI } from './ui.js';
import {
  copyWaypoint, createWaypoint, defaultLabel, duplicateWaypoint, insertWaypoint, legIndexAt,
  moveWaypoint, removeWaypoint, reverseWaypoints,
} from './waypoints.js';

const ROMANIA_VIEW = { center: [24.9, 45.85], zoom: 6 };
const ROUTE_DEBOUNCE_MS = 450; // wait for edits to settle; the free API tier has daily limits

const $ = (id) => document.getElementById(id);

const settings = loadSettings();
let waypoints = loadDraft();
let currentRoute = null;
let currentProfile = null;
let currentEstimate = null;
let currentLegs = null;   // { distanceM, sec }[] between consecutive stops, null while unknown
let currentSaved = null;  // { id, name, createdAt } when the route came from, or was saved to, the library
let routeDirty = false;   // true while a recalculation for the latest edit is pending
let insertAfter = null;   // when set, the next map tap adds a stop after this index
let routeTimer = null;
let routeAbort = null;
let fitOnNextRoute = waypoints.length >= 2; // restored routes are brought into view once

let libraryRecords = [];  // saved routes as of the last time the list was opened
let candidates = null;    // loop candidates being compared, or null
let candidateNote = '';
let selectedCandidate = 0;
let loopAbort = null;
let loopStart = null;     // the stop the current loop search starts from
let rideRecords = [];     // imported rides as of the last time the ride history was opened
let places = loadPlaces(); // saved places

// Rider profiles. There is always at least one.
let riders = loadProfiles();
if (!riders.length) {
  riders = [defaultProfile()];
  saveProfiles(riders);
}
let activeRider = riders.find((r) => r.id === settings.activeProfileId) ?? riders[0];

wireDialogButtons();

const startView = settings.mapDefault ?? ROMANIA_VIEW;

const mapView = createMapView('map', {
  center: startView.center,
  zoom: startView.zoom,
  onAdd: addWaypointAt,
  onMove: (i, p) => { setWaypoints(waypoints.map((w, k) => (k === i ? { ...w, ...p } : w))); },
  onRename: renameStop,
  onSavePlace: savePlaceFromStop,
  onRemove: (i) => setWaypoints(removeWaypoint(waypoints, i)),
});

const chart = createElevationChart($('chart'), {
  onHover: (p) => mapView.showCursor(p.lng, p.lat),
  onLeave: () => mapView.hideCursor(),
});

const ui = initUI({
  profiles,
  onUndo: () => setWaypoints(waypoints.slice(0, -1)),
  onReverse: () => setWaypoints(reverseWaypoints(waypoints)),
  onClear: () => setWaypoints([]),
  onFit: () => { if (currentRoute) mapView.fitTo(currentRoute.coords); },
  onOpenSettings: () => ui.openSettings(settings),
  onSaveSettings: applySettings,
  onSetMapDefault: () => {
    settings.mapDefault = mapView.getView();
    saveSettings(settings);
  },
  onSelectRider: selectRider,
  onEditRider: () => ui.openRider(activeRider, { canDelete: riders.length > 1 }),
  onNewRider: newRider,
  onSaveRider: saveRider,
  onDeleteRider: deleteRider,
  panelHeight: Number.isFinite(settings.panelHeight) ? Math.min(80, Math.max(10, settings.panelHeight)) : null,
  onPanelHeight: (percent) => {
    settings.panelHeight = percent;
    saveSettings(settings);
  },
  onExportBackup: exportBackup,
  onImportBackup: importBackup,
});

const stops = createStopsList({
  details: $('stops-details'),
  list: $('stops-list'),
  countEl: $('stops-count'),
  returnButton: $('stops-return'),
  open: settings.stopsOpen,
  handlers: {
    onMove: (from, to) => setWaypoints(moveWaypoint(waypoints, from, to)),
    onDuplicate: (i) => setWaypoints(duplicateWaypoint(waypoints, i)),
    onRemove: (i) => setWaypoints(removeWaypoint(waypoints, i)),
    // The row already shows the typed name, so the list is not redrawn (that would swallow a click on another row).
    onRename: (i, name) => setStopName(i, name, { redraw: false }),
    onSavePlace: savePlaceFromStop,
    onInsertAfter: toggleInsertMode,
    onFocus: (i) => mapView.panTo(waypoints[i]),
    // Closing a loop: a copy of the first stop goes to the end, so the ride back is part of the route.
    onReturnToStart: () => setWaypoints(insertWaypoint(waypoints, waypoints.length, copyWaypoint(waypoints[0]))),
    onToggle: (open) => {
      settings.stopsOpen = open;
      saveSettings(settings);
    },
  },
});

const library = createLibrary({
  onSave: saveCurrentRoute,
  onLoad: loadSavedRoute,
  onExportGpx: exportSavedGpx,
  onDelete: deleteSavedRoute,
});

const ridesUI = createRidesUI({
  onImport: importRideFiles,
  onDelete: deleteImportedRide,
  onApply: applyRideSuggestion,
});

const loops = createLoopUI({
  onGenerate: runLoopSearch,
  onSelect: selectCandidate,
  onUse: useCandidate,
  onDiscard: () => {
    discardCandidates();
    ui.setStatus('');
  },
});

const placesUI = createPlacesUI({
  onAddStop: addPlaceAsStop,
  onShow: (id) => { const place = places.find((p) => p.id === id); if (place) mapView.panTo(place); },
  onRename: renamePlace,
  onDelete: deletePlace,
});

// The Strava dialog and the flow need each other, so the dialog is given functions that look the flow up later.
const stravaUI = createStravaUI({
  onConnect: (values) => stravaFlow.handlers.onConnect(values),
  onSave: (values) => stravaFlow.handlers.onSave(values),
  onDisconnect: () => stravaFlow.handlers.onDisconnect(),
  onSync: () => stravaFlow.handlers.onSync(),
});
const stravaFlow = createStravaFlow({
  settings,
  saveSettings,
  notify: stravaNotify,
  onRidesChanged: reloadRides,
  ui: stravaUI,
});

$('places-btn').addEventListener('click', () => placesUI.open(places));
$('btn-strava').addEventListener('click', () => stravaFlow.openDialog());
$('btn-save').addEventListener('click', openSaveDialog);
$('btn-routes').addEventListener('click', openLibrary);
$('btn-gpx').addEventListener('click', exportCurrentGpx);
$('btn-loop').addEventListener('click', openLoopDialog);
$('btn-rides').addEventListener('click', openRides);

const settingsAction = { actionLabel: 'Open settings', onAction: () => ui.openSettings(settings) };

initSearch({
  form: $('search-form'),
  input: $('search-input'),
  list: $('search-results'),
  getApiKey: () => settings.apiKey,
  getFocus: () => mapView.getView().center,
  onPick: (place) => mapView.goTo(place),
  onAddPlace: (place) => {
    addWaypointAt({ lng: place.lng, lat: place.lat }, { name: place.label.split(',')[0].trim() });
    mapView.goTo(place);
  },
  onMissingKey: () => ui.setStatus('Add your OpenRouteService API key to use search.', { kind: 'error', ...settingsAction }),
  onError: (message) => ui.setStatus(message, { kind: 'error' }),
});

/**
 * Adds a stop. Where it goes: after the stop chosen in insert mode, else into the leg whose route
 * line was tapped, else at the end.
 */
function addWaypointAt(p, { onRoute = false, name = '' } = {}) {
  let index = waypoints.length;
  if (insertAfter !== null) {
    index = insertAfter + 1;
  } else if (onRoute && currentRoute?.waypointIndices?.length === waypoints.length) {
    const coordIndex = nearestIndex(currentRoute.coords, p.lng, p.lat);
    index = legIndexAt(currentRoute.waypointIndices, coordIndex) + 1;
  }
  setWaypoints(insertWaypoint(waypoints, index, createWaypoint(p.lng, p.lat, name)));
}

function toggleInsertMode(i) {
  if (insertAfter === i) {
    cancelInsertMode();
    return;
  }
  insertAfter = i;
  refreshStops();
  const label = waypoints[i].name || defaultLabel(i, waypoints.length);
  ui.setStatus(`Tap the map to add a stop after "${label}".`, { actionLabel: 'Cancel', onAction: cancelInsertMode });
}

function cancelInsertMode() {
  insertAfter = null;
  refreshStops();
  ui.setStatus('');
}

/** Single entry point for every change to the stop list that affects the route. */
function setWaypoints(next) {
  waypoints = next;
  insertAfter = null;
  currentLegs = null;
  if (!waypoints.length) currentSaved = null;
  cancelLoopSearch();
  discardCandidates();
  mapView.setWaypoints(waypoints);
  saveDraft(waypoints);
  refreshStops();
  scheduleRoute();
}

function refreshStops() {
  stops.render(waypoints, currentLegs, settings.units, insertAfter);
}

function resetRoute() {
  currentRoute = null;
  currentProfile = null;
  currentEstimate = null;
  currentLegs = null;
  routeDirty = false;
  mapView.setRoute(null);
  mapView.setRouteSpeeds(null, null);
  chart.clear();
  ui.setStats(null, settings.units);
  ui.setSurface(null);
  ui.setEstimateNote('');
  refreshStops();
}

function scheduleRoute() {
  clearTimeout(routeTimer);
  routeAbort?.abort();

  if (waypoints.length < 2) {
    resetRoute();
    ui.setStatus(
      waypoints.length ? 'Tap the map to add the next point.' : 'Tap the map to add the start point.',
    );
    return;
  }
  if (!settings.apiKey) {
    resetRoute();
    ui.setStatus('Add your OpenRouteService API key to calculate routes.', { kind: 'error', ...settingsAction });
    return;
  }

  routeDirty = true;
  ui.setStatus('Calculating route…');
  routeTimer = setTimeout(requestRoute, ROUTE_DEBOUNCE_MS);
}

async function requestRoute() {
  const controller = new AbortController();
  routeAbort = controller;
  try {
    const result = await computeRoute(waypoints, {
      profile: settings.routingProfile,
      apiKey: settings.apiKey,
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    showRoute(result);
  } catch (err) {
    if (err.name === 'AbortError') return;
    resetRoute();
    ui.setStatus(describeError(err), { kind: 'error', ...(needsSettings(err) ? settingsAction : {}) });
  }
}

function showRoute(result) {
  currentRoute = result;
  currentProfile = buildProfile(result);
  routeDirty = false;
  mapView.setRoute(result.coords);
  renderRouteInfo();
  ui.setSurface(surfaceBreakdown(result));
  ui.setStatus(currentProfile.hasElevation ? '' : 'The routing service returned no elevation data for this route.');

  if (fitOnNextRoute) {
    mapView.fitTo(result.coords);
    fitOnNextRoute = false;
  }
}

/**
 * Shows a route that already exists (a saved route or a chosen loop) without asking the routing
 * service. The stop list is replaced; later edits recalculate as usual.
 */
function adoptRoute(result, list) {
  clearTimeout(routeTimer);
  routeAbort?.abort();
  waypoints = list;
  insertAfter = null;
  currentLegs = null;
  mapView.setWaypoints(waypoints);
  saveDraft(waypoints);
  fitOnNextRoute = true;
  showRoute(result);
}

/** Distance and ride time of each leg between consecutive stops, or null if the route does not line up. */
function computeLegs(route, result) {
  const indices = route.waypointIndices;
  if (!indices || indices.length !== waypoints.length) return null;
  return indices.slice(1).map((end, k) => {
    const startM = route.distances[indices[k]];
    const endM = route.distances[end];
    return { distanceM: endM - startM, sec: result ? timeBetween(result, startM, endM) : null };
  });
}

/**
 * Stats, time estimate, chart, coloured line and leg list. These depend on the units and the active
 * rider, so they are redrawn on their own, without asking the routing service again.
 */
function renderRouteInfo() {
  if (!currentRoute || !currentProfile) return;

  currentEstimate = estimate(currentRoute, currentProfile, activeRider);
  const result = currentEstimate;
  ui.setStats(
    {
      distanceM: currentRoute.distanceM,
      ascentM: currentProfile.ascent,
      descentM: currentProfile.descent,
      timeSec: result?.totalSec,
      avgKmh: result?.avgKmh,
    },
    settings.units,
  );
  chart.setProfile(currentProfile, settings.units, result?.sampleSpeedKmh ?? null);
  mapView.setRouteSpeeds(currentProfile, result?.segments ?? null);
  ui.setEstimateNote(result ? describeEstimate(result) : '');

  currentLegs = computeLegs(currentRoute, result);
  refreshStops();
}

function describeEstimate(result) {
  const parts = [
    `Assumes ${Math.round(result.powerW)} W (${Math.round(result.powerFraction * 100)} % of FTP)`,
    `${Math.round(result.penaltySec / 60)} min of stops`,
  ];
  if (result.settlements) parts[1] += ` incl. ${result.settlements} settlement${result.settlements > 1 ? 's' : ''}`;
  return parts.join(' · ');
}

// Saved routes.
/** True when the displayed route matches the current stops (nothing is being recalculated). */
function routeReady() {
  return Boolean(currentRoute) && !routeDirty;
}

function requireRoute() {
  if (routeReady()) return true;
  ui.setStatus(currentRoute ? 'Wait for the route to finish calculating.' : 'Plan a route first.');
  return false;
}

function suggestRouteName() {
  const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const first = waypoints[0]?.name;
  const last = waypoints[waypoints.length - 1]?.name;
  if (first && last && first !== last) return `${first} to ${last}`;
  if (first) return `${first} ride, ${date}`;
  return `Route, ${date}`;
}

function openSaveDialog() {
  if (!requireRoute()) return;
  library.openSave({ name: currentSaved?.name ?? suggestRouteName(), canUpdate: Boolean(currentSaved) });
}

async function saveCurrentRoute({ name, mode }) {
  if (!currentRoute) return;
  const updating = mode === 'update' && currentSaved;
  try {
    const record = packRoute({
      id: updating ? currentSaved.id : undefined,
      createdAt: updating ? currentSaved.createdAt : undefined,
      name: name.trim() || suggestRouteName(),
      waypoints,
      route: currentRoute,
      stats: {
        distanceM: currentRoute.distanceM,
        ascentM: currentProfile.ascent,
        descentM: currentProfile.descent,
        timeSec: currentEstimate?.totalSec ?? 0,
      },
      riderId: activeRider.id,
      routeType: currentRoute.profile,
    });
    await putRoute(record);
    currentSaved = { id: record.id, name: record.name, createdAt: record.createdAt };
    ui.setStatus(`Saved "${record.name}".`);
  } catch (err) {
    ui.setStatus(`Could not save the route: ${err.message}`, { kind: 'error' });
  }
}

async function openLibrary() {
  try {
    libraryRecords = await listRoutes();
    library.openRoutes(libraryRecords, settings.units);
  } catch (err) {
    ui.setStatus(`Saved routes are not available: ${err.message}`, { kind: 'error' });
  }
}

function loadSavedRoute(id) {
  const record = libraryRecords.find((r) => r.id === id);
  if (!record) return;

  cancelLoopSearch();
  discardCandidates();
  // Show the time for the rider the route was saved with, if that rider still exists.
  const rider = riders.find((r) => r.id === record.profileIdUsed);
  if (rider) {
    activeRider = rider;
    settings.activeProfileId = rider.id;
    saveSettings(settings);
    ui.setRiders(riders, rider.id);
  }
  currentSaved = { id: record.id, name: record.name, createdAt: record.createdAt };
  adoptRoute(unpackRoute(record), record.waypoints);
  ui.setStatus(`Loaded "${record.name}".`);
}

async function deleteSavedRoute(id) {
  try {
    await deleteRoute(id);
    libraryRecords = libraryRecords.filter((r) => r.id !== id);
    if (currentSaved?.id === id) currentSaved = null;
    library.renderRoutes(libraryRecords, settings.units);
  } catch (err) {
    ui.setStatus(`Could not delete the route: ${err.message}`, { kind: 'error' });
  }
}

function exportCurrentGpx() {
  if (!requireRoute()) return;
  const name = currentSaved?.name ?? suggestRouteName();
  const gpx = buildGpx({ name, waypoints, coords: currentRoute.coords, elevations: currentRoute.elevations });
  downloadText(`${slugify(name)}.gpx`, gpx, 'application/gpx+xml');
}

function exportSavedGpx(id) {
  const record = libraryRecords.find((r) => r.id === id);
  if (!record) return;
  const route = unpackRoute(record);
  const gpx = buildGpx({ name: record.name, waypoints: record.waypoints, coords: route.coords, elevations: route.elevations });
  downloadText(`${slugify(record.name)}.gpx`, gpx, 'application/gpx+xml');
}

// Backup.
async function exportBackup() {
  try {
    const routes = await listRoutes();
    const rides = await listRides();
    const text = JSON.stringify(buildBackup({ settings, profiles: riders, routes, rides, places }));
    downloadText(`bike-router-backup-${new Date().toISOString().slice(0, 10)}.json`, text, 'application/json');
    ui.setBackupNote(`Exported ${riders.length} rider${riders.length === 1 ? '' : 's'}, ${routes.length} route${routes.length === 1 ? '' : 's'} and ${rides.length} ride${rides.length === 1 ? '' : 's'}.`);
  } catch (err) {
    ui.setBackupNote(`Export failed: ${err.message}`, { error: true });
  }
}

async function importBackup(file) {
  if (file.size > MAX_BACKUP_BYTES) {
    ui.setBackupNote('That file is too large to be a backup.', { error: true });
    return;
  }
  try {
    const parsed = parseBackup(await file.text());

    // Merge: entries with the same id are replaced, everything else is kept.
    for (const profile of parsed.profiles) {
      const index = riders.findIndex((r) => r.id === profile.id);
      if (index >= 0) riders[index] = profile;
      else riders.push(profile);
    }
    if (!riders.length) riders = [defaultProfile()];
    if (parsed.routes.length) await putRoutes(parsed.routes);
    if (parsed.rides.length) await putRides(parsed.rides);
    if (parsed.places.length) {
      places = mergePlaces(places, parsed.places);
      savePlaces(places);
    }

    Object.assign(settings, parsed.settings);
    activeRider = riders.find((r) => r.id === settings.activeProfileId) ?? activeRider;
    persistRiders();
    refreshStops();
    if (candidates) renderCandidates();

    const skippedCount = parsed.skippedRoutes + parsed.skippedRides;
    const skipped = skippedCount ? `, skipped ${skippedCount} invalid` : '';
    ui.setBackupNote(`Imported ${parsed.profiles.length} rider${parsed.profiles.length === 1 ? '' : 's'}, ${parsed.routes.length} route${parsed.routes.length === 1 ? '' : 's'} and ${parsed.rides.length} ride${parsed.rides.length === 1 ? '' : 's'}${skipped}.`);
  } catch (err) {
    ui.setBackupNote(err.message, { error: true });
  }
}

// Loop generator.
function openLoopDialog() {
  if (!settings.apiKey) {
    ui.setStatus('Add your OpenRouteService API key to generate loops.', { kind: 'error', ...settingsAction });
    return;
  }
  const startText = waypoints.length ? 'your first stop (A)' : 'the centre of the map (you have no stops yet)';
  loops.open(settings.loopPrefs, settings.units, startText);
}

function cancelLoopSearch() {
  loopAbort?.abort();
  loopAbort = null;
}

async function runLoopSearch(prefs) {
  settings.loopPrefs = prefs;
  saveSettings(settings);

  cancelLoopSearch();
  discardCandidates();
  const controller = new AbortController();
  loopAbort = controller;

  const cancel = {
    actionLabel: 'Cancel',
    onAction: () => {
      cancelLoopSearch();
      ui.setStatus('Loop search cancelled.');
    },
  };
  ui.setStatus('Generating loops…', cancel);

  // With no stops yet, the loop starts from the middle of the map.
  const [centreLng, centreLat] = mapView.getView().center;
  loopStart = waypoints[0] ?? createWaypoint(centreLng, centreLat);

  const target = prefs.kind === 'time'
    ? { kind: 'time', seconds: prefs.timeSec }
    : { kind: 'distance', meters: prefs.distanceM };

  try {
    const { candidates: found, warning } = await generateLoops({
      start: loopStart,
      target,
      options: { allowOutAndBack: prefs.allowOutAndBack, preferPaved: prefs.preferPaved, elevation: prefs.elevation },
      rider: activeRider,
      signal: controller.signal,
      routeFn: (start, request) => roundTrip(start, {
        ...request, profile: settings.routingProfile, apiKey: settings.apiKey,
      }),
      onProgress: ({ done }) => ui.setStatus(`Generating loops… ${done} tried`, cancel),
    });
    if (controller.signal.aborted) return;

    candidates = found;
    selectedCandidate = 0;
    candidateNote = warning ? `Stopped early: ${describeError(warning)}` : '';
    renderCandidates();
    mapView.fitTo(found.flatMap((c) => c.route.coords));
    ui.expandPanel();
    ui.setStatus('Tap a loop to compare, then choose one.');
  } catch (err) {
    if (err.name === 'AbortError') return; // the canceller already set the status
    ui.setStatus(describeError(err), { kind: 'error', ...(needsSettings(err) ? settingsAction : {}) });
  } finally {
    if (loopAbort === controller) loopAbort = null;
  }
}

function renderCandidates() {
  loops.showCandidates(candidates, selectedCandidate, settings.units, candidateNote);
  mapView.setCandidates(candidates.map((c) => ({ coords: c.route.coords })), selectedCandidate);
}

function selectCandidate(index) {
  if (!candidates?.[index]) return;
  selectedCandidate = index;
  renderCandidates();
}

function discardCandidates() {
  candidates = null;
  mapView.setCandidates(null);
  loops.hideCandidates();
}

/** Commits the highlighted loop: its geometry is shown as is, and its stops stay editable. */
function useCandidate() {
  const chosen = candidates?.[selectedCandidate];
  if (!chosen) return;

  if (waypoints.length > 1
    && !confirm(`This replaces your ${waypoints.length} current stops with stops along the loop. Continue?`)) {
    return;
  }

  const { waypoints: list, waypointIndices } = loopWaypoints(chosen.route, loopStart);
  discardCandidates();
  currentSaved = null;
  adoptRoute({ ...chosen.route, waypointIndices }, list);
  ui.setStatus(`Loop added: your start, ${list.length - 2} loop points and the way back. Drag any of them to adjust the loop.`);
}

// Ride history: imported rides, and what they say about the active rider.
const MAX_RIDE_FILE_BYTES = 30 * 1024 * 1024;
const REPORTED_PROBLEMS = 3; // how many failed files are named in the note

function renderRides() {
  ridesUI.render({ rides: rideRecords, units: settings.units, rider: activeRider, analysis: analyzeRides(rideRecords, activeRider) });
}

async function openRides() {
  try {
    rideRecords = await listRides();
    renderRides();
    ridesUI.open();
  } catch (err) {
    ui.setStatus(`The ride history is not available: ${err.message}`, { kind: 'error' });
  }
}

/** The same ride imported twice: same start time and, within one percent, the same length. */
function isDuplicateRide(ride) {
  return rideRecords.some((r) => isSameRide(r, ride));
}

async function importRideFiles(files) {
  ridesUI.setNote(`Reading ${files.length} file${files.length === 1 ? '' : 's'}…`);
  const added = [];
  const problems = [];
  let duplicates = 0;

  for (const file of files) {
    try {
      if (file.size > MAX_RIDE_FILE_BYTES) throw new Error('the file is too large (limit 30 MB)');
      const ride = buildRide(await parseRideFile(file.name, await file.arrayBuffer()), file.name);
      if (isDuplicateRide(ride)) {
        duplicates++;
      } else {
        added.push(ride);
        rideRecords.push(ride); // so duplicates inside one batch are caught too
      }
    } catch (err) {
      problems.push(`${file.name}: ${err.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve)); // let the page breathe between files
  }

  try {
    if (added.length) await putRides(added);
  } catch (err) {
    rideRecords = rideRecords.filter((r) => !added.includes(r));
    ridesUI.setNote(`Could not store the rides: ${err.message}`, { error: true });
    renderRides();
    return;
  }

  rideRecords.sort((a, b) => (b.startTime ?? b.importedAt) - (a.startTime ?? a.importedAt));
  renderRides();

  const parts = [`Imported ${added.length} ride${added.length === 1 ? '' : 's'}.`];
  if (duplicates) parts.push(`${duplicates} already imported.`);
  if (problems.length) {
    parts.push(`${problems.length} could not be read: ${problems.slice(0, REPORTED_PROBLEMS).join('; ')}${problems.length > REPORTED_PROBLEMS ? '…' : ''}`);
  }
  ridesUI.setNote(parts.join(' '), { error: problems.length > 0 && added.length === 0 });
}

async function deleteImportedRide(id) {
  try {
    await deleteRide(id);
    rideRecords = rideRecords.filter((r) => r.id !== id);
    renderRides();
  } catch (err) {
    ridesUI.setNote(`Could not remove the ride: ${err.message}`, { error: true });
  }
}

/** Applies one suggestion from the analysis to the active rider. */
function applyRideSuggestion(change) {
  const patch = {};
  switch (change.kind) {
    case 'ftp': patch.ftpW = change.value; break;
    case 'stops': patch.stopSecPerKm = change.value; break;
    case 'descent': patch.maxDescentKmh = change.value; break;
    case 'fade': patch.powerCurve = { ...activeRider.powerCurve, fraction1h: change.fraction1h, exponent: change.exponent }; break;
    case 'calibration':
      patch.calibration = { gradeFactors: change.gradeFactors, rideCount: change.rideCount, updatedAt: Date.now() };
      break;
    case 'clearCalibration': patch.calibration = null; break;
    default: return;
  }
  saveRider({ ...activeRider, ...patch });
  renderRides(); // the analysis is recomputed against the updated profile
}

// Stop names and saved places.
function setStopName(index, name, { redraw = true } = {}) {
  if (!waypoints[index]) return;
  waypoints = waypoints.map((w, k) => (k === index ? { ...w, name } : w));
  saveDraft(waypoints);
  mapView.setWaypoints(waypoints); // marker tooltips and menus show the name
  if (redraw) refreshStops();
}

async function renameStop(index) {
  const stop = waypoints[index];
  if (!stop) return;
  const name = await askName({
    title: 'Rename stop', value: stop.name, placeholder: defaultLabel(index, waypoints.length), confirmLabel: 'Rename',
  });
  if (name !== null) setStopName(index, name);
}

async function savePlaceFromStop(index) {
  const stop = waypoints[index];
  if (!stop) return;
  const name = await askName({
    title: 'Save this place', value: stop.name, placeholder: 'A name, e.g. Home or Café stop', confirmLabel: 'Save',
  });
  if (name === null) return;

  const place = createPlace(name || `Place ${places.length + 1}`, stop.lng, stop.lat);
  places = upsertPlace(places, place);
  savePlaces(places);
  if (!stop.name) setStopName(index, place.name); // an unnamed stop takes the name it was saved under
  ui.setStatus(`Saved "${place.name}" to your places.`);
}

function addPlaceAsStop(id) {
  const place = places.find((p) => p.id === id);
  if (!place) return;
  addWaypointAt({ lng: place.lng, lat: place.lat }, { name: place.name });
  mapView.panTo(place);
}

async function renamePlace(id) {
  const place = places.find((p) => p.id === id);
  if (!place) return;
  const name = await askName({ title: 'Rename place', value: place.name, confirmLabel: 'Rename' });
  if (!name) return; // a place needs a name
  places = upsertPlace(places, { ...place, name });
  savePlaces(places);
  placesUI.render(places);
}

function deletePlace(id) {
  places = removePlace(places, id);
  savePlaces(places);
  placesUI.render(places);
}

// Strava.
/** One message, shown wherever the user may be looking: the status line, the ride history and the Strava dialog. */
function stravaNotify(message, { error = false, actionLabel, onAction } = {}) {
  ui.setStatus(message, { kind: error ? 'error' : 'info', actionLabel, onAction });
  ridesUI.setNote(message, { error });
  stravaUI.setStatus(message, { error });
}

/** Rides were added in the background: refresh the list if it is on screen. */
async function reloadRides() {
  try {
    rideRecords = await listRides();
    if ($('rides-dialog').open) renderRides();
  } catch {
    /* the list is reloaded the next time the ride history is opened */
  }
}

// Rider profiles.
function persistRiders() {
  saveProfiles(riders);
  settings.activeProfileId = activeRider.id;
  saveSettings(settings);
  ui.setRiders(riders, activeRider.id);
  renderRouteInfo();
}

function selectRider(id) {
  activeRider = riders.find((r) => r.id === id) ?? activeRider;
  persistRiders();
}

function newRider() {
  const copy = sanitizeProfile({ ...activeRider, id: undefined, name: `${activeRider.name} copy` });
  riders.push(copy);
  activeRider = copy;
  persistRiders();
  ui.openRider(copy, { canDelete: true });
}

function saveRider(raw) {
  const clean = sanitizeProfile(raw);
  const index = riders.findIndex((r) => r.id === clean.id);
  if (index >= 0) riders[index] = clean;
  else riders.push(clean);
  activeRider = clean;
  persistRiders();
}

function deleteRider(id) {
  if (riders.length <= 1) return;
  riders = riders.filter((r) => r.id !== id);
  activeRider = riders[0];
  persistRiders();
}

function needsSettings(err) {
  return err.code === 'nokey' || err.code === 'auth' || (err.code === 'network' && navigator.onLine);
}

function describeError(err) {
  switch (err.code) {
    case 'nokey':
    case 'auth':
      return 'The routing service rejected the API key. Check it in settings.';
    case 'limit':
      return 'Request limit reached on the free API tier. Try again later.';
    case 'network':
      // A rejected key also surfaces as a network failure (the error response carries no CORS
      // headers, so the browser hides it); only an offline browser can be told apart.
      return navigator.onLine
        ? 'Could not reach the routing service. Check your API key and your connection.'
        : 'You appear to be offline. Check your connection.';
    case 'unroutable':
      return 'A point is too far from a road usable by bikes. Move it closer to a road.';
    default:
      return err.message || 'Routing failed.';
  }
}

function applySettings(values) {
  const routingChanged =
    values.apiKey !== settings.apiKey || values.routingProfile !== settings.routingProfile;
  Object.assign(settings, values);
  saveSettings(settings);

  renderRouteInfo();
  if (!currentRoute) ui.setStats(null, settings.units);
  refreshStops();
  if (candidates) renderCandidates();
  if (routingChanged) scheduleRoute();
}

ui.setRiders(riders, activeRider.id);
mapView.setWaypoints(waypoints);
refreshStops();
scheduleRoute();
stravaFlow.init();
