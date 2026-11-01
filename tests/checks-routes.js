// Checks for GPX export, saved-route records, backups and the loop generator.
// Shared by tests/index.html (browser) and tests/run.mjs (Node).
import { buildGpx, slugify } from '../js/gpx.js';
import { packRoute, sanitizeRouteRecord, unpackRoute } from '../js/routes.js';
import { buildBackup, parseBackup } from '../js/backup.js';
import { generateLoops, loopWaypoints, retraceShare } from '../js/generator.js';
import { RoutingError } from '../js/routing/errors.js';
import { defaultProfile } from '../js/rider.js';
import { cumulativeDistances } from '../js/geo.js';
import { createWaypoint } from '../js/waypoints.js';

const LNG0 = 25;
const LAT0 = 46;
const M_PER_DEG = 111320;

function toRoute(coords, elevations = coords.map(() => 300)) {
  const distances = cumulativeDistances(coords);
  return {
    engine: 'test',
    profile: 'cycling-road',
    coords,
    elevations,
    distances,
    distanceM: distances[distances.length - 1],
    surface: [{ from: 0, to: coords.length - 1, type: 'asphalt' }],
    wayType: [{ from: 0, to: coords.length - 1, type: 'road' }],
    waypointIndices: [0, coords.length - 1],
  };
}

/** Closed loop of about `lengthM` metres; `seed` changes its shape and orientation. */
function loopRoute(lengthM, seed) {
  const r = lengthM / (2 * Math.PI);
  const stretch = 0.25 * Math.sin(seed + 1);
  const tilt = seed * 0.8;
  const coords = [];
  for (let i = 0; i <= 240; i++) {
    const a = (2 * Math.PI * i) / 240;
    const x = r * (1 + stretch) * Math.cos(a);
    const y = r * (1 - stretch) * Math.sin(a);
    const xr = x * Math.cos(tilt) - y * Math.sin(tilt);
    const yr = x * Math.sin(tilt) + y * Math.cos(tilt);
    coords.push([LNG0 + (xr - r) / (M_PER_DEG * Math.cos((LAT0 * Math.PI) / 180)), LAT0 + yr / M_PER_DEG]);
  }
  return toRoute(coords);
}

/** Straight out and straight back over the same line. */
function outAndBackRoute(lengthM) {
  const half = lengthM / 2;
  const coords = [];
  for (let i = 0; i <= 100; i++) coords.push([LNG0 + (half * (i / 100)) / (M_PER_DEG * 0.69), LAT0]);
  for (let i = 99; i >= 0; i--) coords.push([LNG0 + (half * (i / 100)) / (M_PER_DEG * 0.69), LAT0]);
  return toRoute(coords);
}

const START = { lng: LNG0, lat: LAT0 };
const OPTIONS = { allowOutAndBack: false, preferPaved: true, elevation: 'any' };

export async function runRouteChecks() {
  const results = [];
  const check = (name, pass, detail = '') => results.push({ name, pass: Boolean(pass), detail });
  const rider = defaultProfile();

  // GPX.
  const stops = [createWaypoint(25, 46, 'Café & <Co>'), createWaypoint(25.1, 46.1, '')];
  const gpx = buildGpx({
    name: 'A "test" route', waypoints: stops, coords: [[25, 46], [25.05, 46.05], [25.1, 46.1]],
    elevations: [300, NaN, 320.44], time: new Date('2026-10-30T12:00:00Z'),
  });
  check('GPX has a track point per coordinate and a waypoint per stop',
    (gpx.match(/<trkpt /g) ?? []).length === 3 && (gpx.match(/<wpt /g) ?? []).length === 2, '');
  check('GPX escapes special characters in names', gpx.includes('Café &amp; &lt;Co&gt;') && gpx.includes('A &quot;test&quot; route'), '');
  check('GPX writes elevation where known and omits it where not',
    gpx.includes('<ele>300.0</ele>') && gpx.includes('<ele>320.4</ele>') && (gpx.match(/<ele>/g) ?? []).length === 2, '');
  check('GPX falls back to Start / Finish labels', gpx.includes('<name>Finish</name>'), '');
  check('Route names become safe file names', slugify('Café Tușnad → Lake!') === 'cafe-tusnad-lake' && slugify('???') === 'route', slugify('Café Tușnad → Lake!'));

  // Saved route records.
  const line = toRoute(
    Array.from({ length: 60 }, (_, i) => [LNG0 + i * 0.001234567, LAT0 + i * 0.0005]),
    Array.from({ length: 60 }, (_, i) => (i === 7 ? NaN : 300 + i * 1.234)),
  );
  const stopList = [createWaypoint(LNG0, LAT0, 'Home'), createWaypoint(LNG0 + 0.07, LAT0 + 0.03)];
  const record = packRoute({
    name: '  Sunday ride ', waypoints: stopList, route: line,
    stats: { distanceM: line.distanceM, ascentM: 70, descentM: 5, timeSec: 3600 }, riderId: 'r1', routeType: 'cycling-road',
  });
  const restored = sanitizeRouteRecord(JSON.parse(JSON.stringify(record)));
  const back = restored && unpackRoute(restored);
  check('A saved route survives JSON storage and validation', restored && restored.name === 'Sunday ride' && restored.waypoints.length === 2, '');
  check('Unpacked geometry matches the original', back
    && back.coords.length === 60
    && Math.abs(back.coords[59][0] - line.coords[59][0]) < 1e-5
    && Math.abs(back.distanceM - line.distanceM) < 5
    && Number.isNaN(back.elevations[7]) && Math.abs(back.elevations[10] - line.elevations[10]) < 0.06,
  back ? `${back.distanceM.toFixed(0)} vs ${line.distanceM.toFixed(0)} m` : 'unpack failed');
  check('Stored waypoint indices are kept when they line up', restored && restored.waypointIndices.join() === '0,59', '');

  const broken = JSON.parse(JSON.stringify(record));
  broken.geometry.coords.pop();
  check('A record with damaged geometry is rejected', sanitizeRouteRecord(broken) === null, '');
  const hostile = JSON.parse(JSON.stringify(record));
  hostile.geometry.coords[3] = 'x';
  check('Bad coordinates are rejected and bad indices dropped',
    sanitizeRouteRecord(hostile) === null
    && sanitizeRouteRecord({ ...JSON.parse(JSON.stringify(record)), waypointIndices: [0, 999] }).waypointIndices.length === 0, '');

  // Backup.
  const settings = { apiKey: 'SECRET-KEY', units: 'imperial', routingProfile: 'cycling-regular', activeProfileId: 'r1', mapDefault: { center: [25, 46], zoom: 9 } };
  const text = JSON.stringify(buildBackup({ settings, profiles: [rider], routes: [record] }));
  const parsed = parseBackup(text);
  check('Backups never contain the API key', !text.includes('SECRET-KEY'), '');
  check('A backup restores settings, riders and routes',
    parsed.settings.units === 'imperial' && parsed.settings.mapDefault.zoom === 9 && parsed.profiles.length === 1 && parsed.routes.length === 1, '');

  const wild = JSON.parse(text);
  wild.profiles[0].weightKg = 9999;
  wild.settings.units = 'furlongs';
  wild.routes.push({ id: 'junk' });
  const cleaned = parseBackup(JSON.stringify(wild));
  check('Importing clamps values and skips invalid entries',
    cleaned.profiles[0].weightKg === 200 && cleaned.settings.units === undefined && cleaned.skippedRoutes === 1,
  `weight ${cleaned.profiles[0].weightKg}, skipped ${cleaned.skippedRoutes}`);

  const rejects = (input) => { try { parseBackup(input); return false; } catch { return true; } };
  check('Garbage, foreign files and newer versions are refused',
    rejects('not json') && rejects('{"format":"other"}') && rejects(JSON.stringify({ ...JSON.parse(text), version: 99 })), '');

  // Overlap detection.
  const circleOverlap = retraceShare(loopRoute(30000, 0));
  const outBackOverlap = retraceShare(outAndBackRoute(30000));
  check('A clean loop has almost no overlap, an out-and-back retraces about half its length',
    circleOverlap < 0.1 && outBackOverlap > 0.4 && outBackOverlap < 0.6,
    `${(circleOverlap * 100).toFixed(0)} % vs ${(outBackOverlap * 100).toFixed(0)} %`);

  // Loop generation against a fake engine whose loops come out 30 % shorter than requested.
  const shortLoops = async (_start, { lengthM, seed }) => loopRoute(lengthM * 0.7, seed);

  const byDistance = await generateLoops({
    start: START, target: { kind: 'distance', meters: 40000 }, options: OPTIONS, rider, routeFn: shortLoops,
  });
  const bestDistance = byDistance.candidates[0].metrics.distanceM;
  check('Distance target: the requested length is corrected until a loop lands within 5 %',
    Math.abs(bestDistance - 40000) / 40000 <= 0.05, `${(bestDistance / 1000).toFixed(1)} km for 40 km`);
  check('At most three candidates, best score first',
    byDistance.candidates.length >= 1 && byDistance.candidates.length <= 3
    && byDistance.candidates.every((c, i, all) => i === 0 || all[i - 1].score >= c.score), `${byDistance.candidates.length} candidates`);

  const wantedSec = 2.5 * 3600;
  const byTime = await generateLoops({
    start: START, target: { kind: 'time', seconds: wantedSec }, options: OPTIONS, rider, routeFn: shortLoops,
  });
  const bestTime = byTime.candidates[0].metrics.timeSec;
  check('Time target: estimated ride time lands within 6 % of the goal',
    Math.abs(bestTime - wantedSec) / wantedSec <= 0.06, `${(bestTime / 3600).toFixed(2)} h for 2.50 h`);

  const mixed = async (_start, { lengthM, seed }) => (seed % 2 === 0 ? loopRoute(lengthM, seed) : outAndBackRoute(lengthM));
  const preferLoops = await generateLoops({
    start: START, target: { kind: 'distance', meters: 30000 }, options: OPTIONS, rider, routeFn: mixed,
  });
  check('Loops that retrace themselves rank below real loops', preferLoops.candidates[0].metrics.overlap < 0.2,
    `${(preferLoops.candidates[0].metrics.overlap * 100).toFixed(0)} % overlap`);

  let calls = 0;
  const failsLate = async (start, request) => {
    calls++;
    if (calls > 5) throw new RoutingError('Request limit reached.', 'limit');
    return shortLoops(start, request);
  };
  const partial = await generateLoops({
    start: START, target: { kind: 'distance', meters: 40000 }, options: OPTIONS, rider, routeFn: failsLate,
  });
  check('A rate limit mid-search keeps what was found and reports it',
    partial.candidates.length >= 1 && partial.warning?.code === 'limit', `${partial.candidates.length} kept`);

  let rejected = null;
  try {
    await generateLoops({
      start: START, target: { kind: 'distance', meters: 40000 }, options: OPTIONS, rider,
      routeFn: async () => { throw new RoutingError('rejected', 'auth'); },
    });
  } catch (err) {
    rejected = err;
  }
  check('If nothing can be generated the engine error is passed on', rejected?.code === 'auth', '');

  const controller = new AbortController();
  let aborted = null;
  try {
    await generateLoops({
      start: START, target: { kind: 'distance', meters: 40000 }, options: OPTIONS, rider, signal: controller.signal,
      routeFn: async () => {
        controller.abort();
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    });
  } catch (err) {
    aborted = err;
  }
  check('Cancelling stops the search', aborted?.name === 'AbortError', '');

  // Turning a loop into stops.
  const loop = loopRoute(40000, 2);
  const startStop = createWaypoint(LNG0, LAT0, 'Home');
  const { waypoints, waypointIndices } = loopWaypoints(loop, startStop);
  check('A loop becomes start, evenly spread stops, and the start again',
    waypoints.length === 7 && waypoints[0] === startStop && waypoints[6].lng === startStop.lng && waypoints[6].id !== startStop.id,
  `${waypoints.length} stops`);
  check('Loop stop indices run in order from the first to the last coordinate',
    waypointIndices[0] === 0 && waypointIndices[6] === loop.coords.length - 1
    && waypointIndices.every((n, i, all) => i === 0 || n >= all[i - 1]), waypointIndices.join(','));

  return results;
}
