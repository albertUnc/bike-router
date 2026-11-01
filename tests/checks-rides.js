// Checks for ride import (GPX and FIT), FTP estimation and model calibration.
// Shared by tests/index.html (browser) and tests/run.mjs (Node).
import { parseGpx } from '../js/gpxread.js';
import { parseFit } from '../js/fit.js';
import { buildRide, sanitizeRideRecord } from '../js/rides.js';
import {
  analyzeRides, bestEfforts, calibrateGrades, estimateFtp, fadeFit, maxDescent, stopPenalty, virtualPower,
} from '../js/rideanalysis.js';
import { cleanCalibration, gradeFactor } from '../js/calibration.js';
import { buildProfile } from '../js/elevation.js';
import { estimate } from '../js/estimator.js';
import { cumulativeDistances } from '../js/geo.js';
import { powerAtSpeed, solveSpeed } from '../js/physics.js';
import { defaultProfile, sanitizeProfile, totalMassKg } from '../js/rider.js';
import { buildBackup, parseBackup } from '../js/backup.js';

const LNG0 = 25;
const LAT0 = 46;
const M_PER_DEG_LNG = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const START_MS = Date.UTC(2026, 5, 1, 8, 0, 0);

/** Straight west-east route whose elevation follows eleAt(metres from start). */
function straightRoute(km, eleAt) {
  const coords = [];
  const elevations = [];
  for (let i = 0; i <= km * 20; i++) {
    coords.push([LNG0 + (i * 50) / M_PER_DEG_LNG, LAT0]);
    elevations.push(eleAt(i * 50));
  }
  const distances = cumulativeDistances(coords);
  return { coords, elevations, distances, distanceM: distances[distances.length - 1], surface: [], wayType: [], waypointIndices: [] };
}

/** A ride recorded while following a route at the speeds the estimator predicts for `rider`. */
function simulateRide(route, rider, { withPower = false } = {}) {
  const profile = buildProfile(route);
  const result = estimate(route, profile, rider);
  const points = [];
  let s = 0;
  let t = 0;
  while (s < route.distanceM) {
    const seg = result.segments[Math.min(Math.floor(s / 100), result.segments.length - 1)];
    const k = Math.min(route.coords.length - 2, Math.floor(s / 50));
    const f = (s - k * 50) / 50;
    points.push({
      t: START_MS + t * 1000,
      lat: LAT0,
      lng: route.coords[k][0] + (route.coords[k + 1][0] - route.coords[k][0]) * f,
      ele: route.elevations[k] + (route.elevations[k + 1] - route.elevations[k]) * f,
      power: withPower ? (seg.grade >= -0.02 ? result.powerW : 0) : null,
    });
    s += seg.speedMs;
    t += 1;
  }
  return buildRide({ name: 'sim', source: 'gpx', points }, 'sim.gpx');
}

/** A ride at constant speed and grade, a sample every 5 s; `stops` is a list of { atS, forS } pauses in place. */
function steadyRide({ speed, grade, minutes, power = null, stops = [], name = 'steady' }) {
  const points = [];
  let s = 0;
  let t = 0;
  const end = minutes * 60;
  while (t <= end) {
    points.push({ t: START_MS + t * 1000, lat: LAT0, lng: LNG0 + s / M_PER_DEG_LNG, ele: 300 + grade * s, power });
    const stop = stops.find((p) => t >= p.atS && t < p.atS + p.forS);
    if (!stop) s += speed * 5;
    t += 5;
  }
  return buildRide({ name, source: 'gpx', points }, `${name}.gpx`);
}

// ---- FIT builder -------------------------------------------------------------------------------

const FIT_EPOCH = 631065600;
const semicircles = (deg) => Math.round((deg * 2 ** 31) / 180);

function u16(v, le = true) { const a = [v & 255, (v >> 8) & 255]; return le ? a : a.reverse(); }
function u32(v, le = true) { const a = [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; return le ? a : a.reverse(); }

function fitFile(body) {
  const header = [14, 0x20, ...u16(2132), ...u32(body.length), 0x2e, 0x46, 0x49, 0x54, 0, 0];
  return new Uint8Array([...header, ...body, 0, 0]).buffer;
}

const RECORD_FIELDS = [[253, 4, 0x86], [0, 4, 0x85], [1, 4, 0x85], [2, 2, 0x84], [7, 2, 0x84]];

function recordDefinition(local, { le = true, developer = false, withTimestamp = true } = {}) {
  const fields = withTimestamp ? RECORD_FIELDS : RECORD_FIELDS.slice(1);
  const out = [0x40 | (developer ? 0x20 : 0) | local, 0, le ? 0 : 1, ...u16(20, le), fields.length];
  for (const f of fields) out.push(...f);
  if (developer) out.push(1, 0, 3, 0); // one developer field of 3 bytes
  return out;
}

function recordValues(ts, lat, lng, altRaw, power, le = true) {
  return [...u32(ts, le), ...u32(semicircles(lat) >>> 0, le), ...u32(semicircles(lng) >>> 0, le), ...u16(altRaw, le), ...u16(power, le)];
}

// ---- Checks ------------------------------------------------------------------------------------

export function runRideChecks() {
  const results = [];
  const check = (name, pass, detail = '') => results.push({ name, pass: Boolean(pass), detail });
  const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
  const rider = defaultProfile();

  // Physics inverse.
  const inverse = [0, 0.06, -0.03].map((grade) => {
    const v = solveSpeed({ powerW: 180, grade, massKg: 85, crr: 0.005, cdA: 0.4 });
    return powerAtSpeed({ speed: v, grade, massKg: 85, crr: 0.005, cdA: 0.4 });
  });
  check('Power needed at a speed is the inverse of the speed solver', inverse.every((p) => near(p, 180, 0.5)),
    inverse.map((p) => p.toFixed(1)).join(', '));

  // GPX reading.
  const gpx = `<?xml version="1.0"?><gpx version="1.1" xmlns:gpxtpx="x"><metadata><name>Sunday &amp; hills</name></metadata>
    <trk><name>Sunday &amp; hills</name><trkseg>
    <trkpt lat="46.1" lon="25.2"><ele>310.5</ele><time>2026-06-01T08:00:00Z</time><extensions><power>201</power></extensions></trkpt>
    <trkpt lat="46.1001" lon="25.2001"><ele>311</ele><time>2026-06-01T08:00:01Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:PowerInWatts>187</gpxtpx:PowerInWatts></gpxtpx:TrackPointExtension></extensions></trkpt>
    <trkpt lat="46.1002" lon="25.2002"/></trkseg></trk></gpx>`;
  const parsedGpx = parseGpx(gpx);
  check('GPX: positions, elevation, time and both power tag styles are read',
    parsedGpx.points.length === 3 && parsedGpx.points[0].ele === 310.5 && parsedGpx.points[0].power === 201
    && parsedGpx.points[1].power === 187 && parsedGpx.points[1].t - parsedGpx.points[0].t === 1000
    && Number.isNaN(parsedGpx.points[2].t) && parsedGpx.points[2].ele === null, '');
  check('GPX: the name is read and decoded', parsedGpx.name === 'Sunday & hills', parsedGpx.name);

  const rejectsText = (fn) => { try { fn(); return false; } catch { return true; } };
  check('GPX: files that are not tracks are refused',
    rejectsText(() => parseGpx('hello')) && rejectsText(() => parseGpx('<gpx><rte><rtept lat="1" lon="2"/></rte></gpx>')), '');

  // FIT reading.
  const ts = Math.floor(START_MS / 1000) - FIT_EPOCH;
  const body = [
    ...recordDefinition(0),
    0x00, ...recordValues(ts, 46.0, 25.0, 4000, 200),
    0x00, ...recordValues(ts + 1, 46.0001, 25.0001, 0xffff, 210),
    0x00, ...recordValues(ts + 2, 46.0002, 25.0002, 4010, 0xffff),
    ...recordDefinition(1, { withTimestamp: false }),
    0x80 | (1 << 5) | ((ts + 3) & 0x1f), ...recordValues(0, 46.0003, 25.0003, 4020, 220).slice(4),
    0x40 | 2, 0, 0, ...u16(21), 2, 253, 4, 0x86, 0, 1, 0x00,   // an event message, to be skipped
    0x02, ...u32(ts + 3), 7,
    ...recordDefinition(3, { developer: true }),
    0x03, ...recordValues(ts + 4, 46.0004, 25.0004, 4030, 230), 9, 9, 9,
    ...recordDefinition(4, { le: false }),
    0x04, ...recordValues(ts + 5, 46.0005, 25.0005, 4040, 240, false),
  ];
  const fit = parseFit(fitFile(body));
  const p = fit.points;
  check('FIT: all record messages are found, other messages skipped', p.length === 6, `${p.length} points`);
  check('FIT: position, altitude, power and time are decoded',
    near(p[0].lat, 46.0, 1e-6) && near(p[0].lng, 25.0, 1e-6) && near(p[0].ele, 300, 1e-9) && p[0].power === 200
    && p[0].t === START_MS && p[1].t === START_MS + 1000, `${p[0].lat.toFixed(5)}, ${p[0].ele} m, ${p[0].power} W`);
  check('FIT: invalid values come out as missing, not as huge numbers', p[1].ele === null && p[2].power === null, '');
  check('FIT: compressed timestamps, developer fields and big-endian data work',
    p[3].t === START_MS + 3000 && p[3].power === 220 && near(p[4].lat, 46.0004, 1e-6) && p[4].power === 230
    && near(p[5].lng, 25.0005, 1e-6) && p[5].power === 240, '');
  check('FIT: garbage and empty-track files are refused',
    rejectsText(() => parseFit(new ArrayBuffer(20))) && rejectsText(() => parseFit(fitFile(recordDefinition(0)))), '');

  // Building a ride.
  const gappy = [];
  for (let t = 0; t <= 600; t += 1) {
    if (t > 200 && t < 320) continue; // a two-minute pause with no points
    gappy.push({ t: START_MS + t * 1000, lat: LAT0, lng: LNG0 + (t < 200 ? t : t - 120) * 5 / M_PER_DEG_LNG, ele: 300, power: 150 });
  }
  const gapRide = buildRide({ name: null, source: 'gpx', points: gappy }, 'gappy.gpx');
  const stoppedSamples = gapRide.streams.speed.filter((v) => v < 0.3).length;
  check('A pause is held in place and shows as stopped time, not slow riding',
    stoppedSamples >= 20 && gapRide.movingS < gapRide.elapsedS - 100, `${stoppedSamples} stopped samples`);
  check('A ride record has distance, duration, power and a name from the file', gapRide.hasPower && gapRide.name === 'gappy'
    && near(gapRide.elapsedS, 600, 1) && gapRide.distanceM > 2000, `${gapRide.distanceM.toFixed(0)} m`);

  const refused = (points, message) => { try { buildRide({ name: null, source: 'gpx', points }, 'x.gpx'); return false; } catch (e) { return e.message.includes(message); } };
  check('Files without timestamps or with too few points are refused with a reason',
    refused(Array.from({ length: 30 }, (_, i) => ({ t: NaN, lat: 46, lng: 25 + i * 0.001 })), 'timestamps')
    && refused(Array.from({ length: 5 }, (_, i) => ({ t: i * 1000, lat: 46, lng: 25 + i * 0.001 })), 'too few'), '');

  const record = JSON.parse(JSON.stringify(gapRide));
  const backwards = JSON.parse(JSON.stringify(gapRide));
  backwards.streams.dist[10] = backwards.streams.dist[9] - 5;
  check('Stored rides are validated: good ones pass, damaged ones are rejected',
    sanitizeRideRecord(record) !== null && sanitizeRideRecord(backwards) === null && sanitizeRideRecord({ streams: { lat: [1] } }) === null, '');

  // Power, FTP and best efforts.
  const meterRide = steadyRide({ speed: 8, grade: 0, minutes: 45, power: 230, name: 'meter' });
  const efforts = bestEfforts([meterRide], rider);
  check('Best 20 minute power is read from a power meter ride', near(efforts.measured[1200].watts, 230, 1) && !efforts.measured[3600], `${efforts.measured[1200].watts.toFixed(0)} W`);
  const ftpMeter = estimateFtp([meterRide], rider);
  check('FTP is 95 % of the best 20 minutes, labelled as measured', ftpMeter && near(ftpMeter.ftpW, 218, 1) && ftpMeter.measured, `${ftpMeter?.ftpW} W`);

  const longRide = steadyRide({ speed: 8, grade: 0, minutes: 75, power: 200, name: 'long' });
  check('A full hour at a steady power counts as FTP when that is higher', near(estimateFtp([longRide], rider).ftpW, 200, 1), '');
  check('Rides shorter than 20 minutes give no FTP', estimateFtp([steadyRide({ speed: 8, grade: 0, minutes: 12, power: 250 })], rider) === null, '');

  // Estimated power from speed, for rides without a meter.
  const grade = 0.04;
  const climbSpeed = solveSpeed({ powerW: 200, grade, massKg: totalMassKg(rider), crr: rider.crr, cdA: rider.cdA });
  const climb = steadyRide({ speed: climbSpeed, grade, minutes: 30, name: 'climb' });
  const virtual = virtualPower(climb, rider);
  const middle = Array.from(virtual).slice(30, -30);
  const meanVirtual = middle.reduce((a, b) => a + b, 0) / middle.length;
  check('Power estimated from speed and slope recovers the real effort on a steady climb', near(meanVirtual, 200, 8), `${meanVirtual.toFixed(0)} W`);

  const ftpEstimated = estimateFtp([climb], rider);
  check('FTP from a ride without power is flagged as an estimate', ftpEstimated && !ftpEstimated.measured && near(ftpEstimated.ftpW, 190, 12), `${ftpEstimated?.ftpW} W`);

  // Stops and descents.
  const withStops = steadyRide({ speed: 7, grade: 0, minutes: 50, stops: [{ atS: 600, forS: 40 }, { atS: 1400, forS: 40 }, { atS: 2200, forS: 40 }], name: 'stops' });
  const stops = stopPenalty([withStops]);
  const expectedStops = 120 / (withStops.distanceM / 1000);
  check('Stop penalty counts short stops per km', stops && near(stops.secPerKm, expectedStops, 1.5), `${stops?.secPerKm.toFixed(1)} s/km, expected about ${expectedStops.toFixed(1)}`);
  check('A long break is not counted as traffic', stopPenalty([steadyRide({ speed: 7, grade: 0, minutes: 50, stops: [{ atS: 900, forS: 900 }] })]).secPerKm < 1, '');

  const descentSpeed = solveSpeed({ powerW: 0, grade: -0.06, massKg: totalMassKg(rider), crr: rider.crr, cdA: rider.cdA });
  const descent = maxDescent([steadyRide({ speed: descentSpeed, grade: -0.06, minutes: 12, name: 'descent' })]);
  check('Top descent speed matches what was ridden', descent && near(descent.kmh, descentSpeed * 3.6, 2), `${descent?.kmh} vs ${(descentSpeed * 3.6).toFixed(1)} km/h`);

  // Power fade.
  const fadeRides = [1, 2, 3.5, 5].map((hours) => steadyRide({
    speed: 7, grade: 0, minutes: hours * 60, power: 200 * 0.9 * hours ** -0.15, name: `fade${hours}`,
  }));
  const fade = fadeFit(fadeRides, rider, 200);
  check('Power fade is recovered from long rides of different lengths', fade && near(fade.fraction1h, 0.9, 0.02) && near(fade.exponent, 0.15, 0.03),
    fade ? `${fade.fraction1h} at 1 h, fade ${fade.exponent}` : 'no fit');
  check('Power fade needs several rides of different lengths', fadeFit(fadeRides.slice(0, 2), rider, 200) === null && fadeFit([fadeRides[0], fadeRides[0], fadeRides[0]], rider, 200) === null, '');

  // Calibration.
  const hilly = straightRoute(30, (d) => 300 + 40 * Math.sin(d / 1800) + d * 0.001);
  const strongRider = { ...rider, ftpW: 240 };
  const realRide = simulateRide(hilly, strongRider);
  const profile = buildProfile(hilly);
  const truth = estimate(hilly, profile, strongRider);
  const before = estimate(hilly, profile, rider);
  const calibration = calibrateGrades([realRide], rider);
  const calibrated = calibration && estimate(hilly, profile, { ...rider, calibration: { gradeFactors: calibration.gradeFactors, rideCount: 1, updatedAt: 0 } });
  check('Calibration against a faster rider speeds the model up', calibration && calibration.gradeFactors.some((f) => f > 1.05), calibration ? calibration.gradeFactors.map((f) => f.toFixed(2)).join(' ') : 'none');
  check('After calibration the model reproduces the rider\'s moving time within 4 %', calibrated
    && Math.abs(calibrated.movingSec - truth.movingSec) / truth.movingSec < 0.04
    && Math.abs(before.movingSec - truth.movingSec) / truth.movingSec > 0.04,
  calibrated ? `before ${(before.movingSec / 60).toFixed(0)} min, after ${(calibrated.movingSec / 60).toFixed(0)} min, real ${(truth.movingSec / 60).toFixed(0)} min` : '');
  check('Calibration is not stacked on an existing calibration',
    calibrateGrades([realRide], { ...rider, calibration: { gradeFactors: Array(9).fill(1.3), rideCount: 1, updatedAt: 0 } }).gradeFactors.join()
    === calibration.gradeFactors.join(), '');

  const flatOnly = calibrateGrades([steadyRide({ speed: 7, grade: 0, minutes: 30, name: 'flat' })], rider);
  check('Grades never ridden take the nearest ridden grade; short rides give nothing',
    flatOnly && flatOnly.measuredBands === 1 && new Set(flatOnly.gradeFactors).size === 1
    && calibrateGrades([steadyRide({ speed: 7, grade: 0, minutes: 3 })], rider) === null, '');

  const summary = analyzeRides([realRide, meterRide], rider);
  check('The full analysis reports rides, FTP, stops, calibration and the number with power',
    summary.rideCount === 2 && summary.powerRideCount === 1 && summary.ftp && summary.calibration, '');
  check('No rides means no analysis', analyzeRides([], rider) === null, '');

  // Calibration data in profiles.
  check('Calibration factors are interpolated between grade bands and default to 1',
    gradeFactor(null, 0.03) === 1
    && near(gradeFactor({ gradeFactors: [1, 1, 1, 1, 1, 1.2, 1, 1, 1] }, 0.03), 1.1, 1e-9)
    && near(gradeFactor({ gradeFactors: [1.5, 1, 1, 1, 1, 1, 1, 1, 1] }, -0.2), 1.5, 1e-9), '');
  check('A calibration factor scales the estimated speed',
    near(estimate(hilly, profile, { ...rider, calibration: { gradeFactors: Array(9).fill(1.1), rideCount: 1, updatedAt: 0 } }).movingSec / before.movingSec, 1 / 1.1, 0.03), '');
  check('Stored calibration is validated and survives profile sanitising',
    cleanCalibration({ gradeFactors: [1, 2] }) === null && cleanCalibration({ gradeFactors: Array(9).fill(9) }).gradeFactors[0] === 1.6
    && sanitizeProfile({ ...rider, calibration: { gradeFactors: Array(9).fill(1.1), rideCount: 4, updatedAt: 5 } }).calibration.rideCount === 4
    && sanitizeProfile({ ...rider, calibration: 'x' }).calibration === null, '');

  // Backup carries rides.
  const settings = { apiKey: 'SECRET', units: 'metric', routingProfile: 'cycling-road', activeProfileId: null, mapDefault: null };
  const text = JSON.stringify(buildBackup({ settings, profiles: [rider], routes: [], rides: [gapRide] }));
  const restored = parseBackup(text);
  check('A backup restores imported rides and skips damaged ones',
    restored.rides.length === 1 && restored.rides[0].streams.lat.length === gapRide.streams.lat.length
    && parseBackup(JSON.stringify({ ...JSON.parse(text), rides: [JSON.parse(JSON.stringify(gapRide)), { id: 'junk' }] })).skippedRides === 1, '');

  return results;
}
