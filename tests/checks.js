// Sanity checks for the physics solver and the time estimator.
// Shared by tests/index.html (browser) and tests/run.mjs (Node).
import { solveSpeed } from '../js/physics.js';
import { defaultProfile, powerFraction, totalMassKg } from '../js/rider.js';
import { estimate, timeBetween } from '../js/estimator.js';
import { buildProfile } from '../js/elevation.js';
import { cumulativeDistances } from '../js/geo.js';
import {
  copyWaypoint, createWaypoint, dedupeAdjacent, defaultLabel, duplicateWaypoint, insertWaypoint,
  legIndexAt, moveWaypoint, normalizeWaypoints, removeWaypoint, reverseWaypoints,
} from '../js/waypoints.js';

const kmh = (ms) => ms * 3.6;

const ROAD_BIKE = { massKg: 83, crr: 0.004, cdA: 0.32 };
const GRAVEL_BIKE = { massKg: 85, crr: 0.005, cdA: 0.4 };

/** Straight west-east route of `km` kilometres whose elevation follows `eleAt(metresFromStart)`. */
function syntheticRoute(km, eleAt, surface = []) {
  const points = Math.round(km * 20); // a point every 50 m
  const coords = [];
  const elevations = [];
  for (let i = 0; i <= points; i++) {
    coords.push([25 + (i * 50) / 78000, 46]); // about 78 km per degree of longitude at 46 N
    elevations.push(eleAt(i * 50));
  }
  const distances = cumulativeDistances(coords);
  return {
    coords,
    elevations,
    distances,
    distanceM: distances[distances.length - 1],
    surface,
    wayType: [],
  };
}

function ride(route, rider) {
  return estimate(route, buildProfile(route), rider);
}

export function runChecks() {
  const results = [];
  const check = (name, pass, detail) => results.push({ name, pass: Boolean(pass), detail });
  const inRange = (value, lo, hi) => value >= lo && value <= hi;

  // Solver on its own.
  const flatRoad = kmh(solveSpeed({ powerW: 200, grade: 0, ...ROAD_BIKE }));
  check('Flat, 200 W, road bike is in the 30 km/h range', inRange(flatRoad, 29, 36), `${flatRoad.toFixed(1)} km/h`);

  const flatGravel = kmh(solveSpeed({ powerW: 200, grade: 0, ...GRAVEL_BIKE }));
  check('Flat, 200 W, gravel bike is slower than the road bike', flatGravel < flatRoad && inRange(flatGravel, 26, 34),
    `${flatGravel.toFixed(1)} km/h`);

  const climb8 = kmh(solveSpeed({ powerW: 200, grade: 0.08, ...GRAVEL_BIKE }));
  check('8 % climb, 200 W, 85 kg total is about 10 km/h', inRange(climb8, 8.5, 11.5), `${climb8.toFixed(1)} km/h`);

  const climb12 = kmh(solveSpeed({ powerW: 200, grade: 0.12, ...GRAVEL_BIKE }));
  check('12 % climb is slower than 8 %', climb12 < climb8, `${climb12.toFixed(1)} vs ${climb8.toFixed(1)} km/h`);

  const grades = [-0.05, 0, 0.03, 0.06, 0.1];
  const speeds = grades.map((g) => solveSpeed({ powerW: 200, grade: g, ...GRAVEL_BIKE }));
  check('Speed falls steadily as the grade rises', speeds.every((s, i) => i === 0 || s < speeds[i - 1]),
    speeds.map((s) => kmh(s).toFixed(1)).join(', '));

  const coast = kmh(solveSpeed({ powerW: 0, grade: -0.08, ...GRAVEL_BIKE }));
  check('Coasting down 8 % reaches a plausible terminal speed (50-65 km/h)', inRange(coast, 50, 65), `${coast.toFixed(1)} km/h`);

  check('Coasting on the flat gives zero', solveSpeed({ powerW: 0, grade: 0, ...GRAVEL_BIKE }) === 0, '0 km/h');

  const heavy = solveSpeed({ powerW: 200, grade: 0.08, ...GRAVEL_BIKE, massKg: 105 });
  check('Heavier rider is slower on a climb', heavy < solveSpeed({ powerW: 200, grade: 0.08, ...GRAVEL_BIKE }), `${kmh(heavy).toFixed(1)} km/h`);

  const bulky = solveSpeed({ powerW: 200, grade: 0, ...GRAVEL_BIKE, cdA: 0.55 });
  check('Higher CdA is slower on the flat', bulky < solveSpeed({ powerW: 200, grade: 0, ...GRAVEL_BIKE }), `${kmh(bulky).toFixed(1)} km/h`);

  const rough = solveSpeed({ powerW: 200, grade: 0, ...GRAVEL_BIKE, crr: 0.012 });
  check('Higher rolling resistance is slower on the flat', rough < solveSpeed({ powerW: 200, grade: 0, ...GRAVEL_BIKE }), `${kmh(rough).toFixed(1)} km/h`);

  // Power curve.
  const rider = defaultProfile();
  const f1 = powerFraction(rider.powerCurve, 1);
  const f4 = powerFraction(rider.powerCurve, 4);
  const f10 = powerFraction(rider.powerCurve, 10);
  check('Sustainable power falls with ride length', f1 > f4 && f4 > f10, `1 h ${f1.toFixed(2)}, 4 h ${f4.toFixed(2)}, 10 h ${f10.toFixed(2)}`);
  check('Power fraction stays within its limits', f10 >= rider.powerCurve.min && powerFraction(rider.powerCurve, 0.01) <= rider.powerCurve.max, '');

  // Estimator on synthetic routes.
  const noStops = { ...rider, stopSecPerKm: 0, settlementSec: 0 };
  const flat = syntheticRoute(20, () => 300);
  const flatRide = ride(flat, noStops);
  const expected = kmh(solveSpeed({
    powerW: flatRide.powerW, grade: 0, massKg: totalMassKg(rider), crr: rider.crr * 1.25, cdA: rider.cdA,
  }));
  check('Flat 20 km matches the solver speed (unknown surface)', Math.abs(flatRide.avgKmh - expected) < 0.2,
    `${flatRide.avgKmh.toFixed(1)} vs ${expected.toFixed(1)} km/h`);

  const penalised = ride(flat, { ...rider, stopSecPerKm: 30, settlementSec: 0 });
  check('Stop penalty adds exactly its time', Math.abs(penalised.penaltySec - 30 * flat.distanceM / 1000) < 1e-6 && penalised.totalSec > flatRide.totalSec,
    `${penalised.penaltySec.toFixed(0)} s of stops`);

  const hill = syntheticRoute(20, (m) => 300 + Math.max(0, Math.min(m, 20000 - m)) * 0.04);
  const hillRide = ride(hill, noStops);
  check('A hilly 20 km takes longer than a flat 20 km', hillRide.totalSec > flatRide.totalSec,
    `${(hillRide.totalSec / 60).toFixed(0)} vs ${(flatRide.totalSec / 60).toFixed(0)} min`);

  const slowestClimb = Math.min(...hillRide.segments.map((s) => s.speedMs * 3.6));
  check('Climbing a 4 % ramp gives roughly 10-22 km/h', inRange(slowestClimb, 10, 22), `${slowestClimb.toFixed(1)} km/h`);

  const downhill = syntheticRoute(10, (m) => 900 - m * 0.1, [{ from: 0, to: 200, type: 'asphalt' }]);
  const downRide = ride(downhill, noStops);
  const fastest = Math.max(...downRide.segments.map((s) => s.speedMs * 3.6));
  check('Descent speed never exceeds the profile cap', fastest <= rider.maxDescentKmh + 1e-9,
    `${fastest.toFixed(1)} km/h (cap ${rider.maxDescentKmh})`);

  const looseRide = ride(syntheticRoute(10, () => 300, [{ from: 0, to: 200, type: 'looseGravel' }]), noStops);
  const pavedRide = ride(syntheticRoute(10, () => 300, [{ from: 0, to: 200, type: 'asphalt' }]), noStops);
  check('Loose gravel is slower than asphalt', looseRide.totalSec > pavedRide.totalSec,
    `${looseRide.avgKmh.toFixed(1)} vs ${pavedRide.avgKmh.toFixed(1)} km/h`);

  const longFlat = ride(syntheticRoute(120, () => 300), noStops);
  check('A long ride uses a lower fraction of FTP than a short one', longFlat.powerFraction < flatRide.powerFraction,
    `${longFlat.powerFraction.toFixed(2)} vs ${flatRide.powerFraction.toFixed(2)}`);

  // Waypoint list operations.
  const wp = (n) => createWaypoint(25 + n * 0.01, 46, `p${n}`);
  const list = [wp(0), wp(1), wp(2), wp(3)];
  const names = (l) => l.map((w) => w.name).join(',');

  check('Move reorders without losing stops', names(moveWaypoint(list, 0, 3)) === 'p1,p2,p3,p0'
    && names(moveWaypoint(list, 3, 1)) === 'p0,p3,p1,p2', names(moveWaypoint(list, 0, 3)));
  check('Move with an invalid index changes nothing', moveWaypoint(list, 2, 9) === list && moveWaypoint(list, 1, 1) === list, '');

  const duplicated = duplicateWaypoint(list, 0);
  check('Duplicate inserts a copy with its own id right after the original',
    duplicated.length === 5 && duplicated[1].lng === list[0].lng && duplicated[1].id !== list[0].id, `${duplicated.length} stops`);

  const closed = insertWaypoint(list, list.length, copyWaypoint(list[0]));
  check('Copying the start to the end closes a loop', closed.length === 5 && closed[4].lng === closed[0].lng && closed[4].id !== closed[0].id, '');

  check('Insert in the middle keeps the others in order', names(insertWaypoint(list, 2, createWaypoint(0, 0, 'new'))) === 'p0,p1,new,p2,p3', '');
  check('Remove drops only that stop', names(removeWaypoint(list, 1)) === 'p0,p2,p3', '');
  check('Reverse flips the order and leaves the original alone', names(reverseWaypoints(list)) === 'p3,p2,p1,p0' && names(list) === 'p0,p1,p2,p3', '');

  const { unique, indexMap } = dedupeAdjacent(duplicated);
  check('Adjacent duplicates are merged for routing and mapped back', unique.length === 4 && indexMap.join() === '0,0,1,2,3', indexMap.join());

  const looped = dedupeAdjacent(closed);
  check('A start copied to the end is not merged away', looped.unique.length === 5, `${looped.unique.length} unique`);

  check('A tap on the route is assigned to the right leg',
    legIndexAt([0, 100, 250, 400], 50) === 0 && legIndexAt([0, 100, 250, 400], 100) === 1
    && legIndexAt([0, 100, 250, 400], 399) === 2 && legIndexAt([0, 100, 250, 400], 400) === 2, '');

  const messy = normalizeWaypoints([{ id: 'a', lng: 1, lat: 2 }, { id: 'a', lng: 3, lat: 4, name: 7 }, { lng: 'x', lat: 1 }, null]);
  check('Loading cleans ids, names and invalid entries', messy.length === 2 && messy[0].id !== messy[1].id && messy.every((w) => w.name === ''), `${messy.length} kept`);

  check('Default labels read Start, Stop n, Finish', defaultLabel(0, 4) === 'Start' && defaultLabel(2, 4) === 'Stop 2' && defaultLabel(3, 4) === 'Finish', '');

  // Leg times.
  const legRoute = syntheticRoute(20, () => 300);
  const legRide = ride(legRoute, noStops);
  const firstHalf = timeBetween(legRide, 0, legRoute.distanceM / 2);
  const wholeRoute = timeBetween(legRide, 0, legRoute.distanceM);
  check('Leg times add up to the moving time', Math.abs(wholeRoute - legRide.movingSec) < 1e-6
    && Math.abs(firstHalf + timeBetween(legRide, legRoute.distanceM / 2, legRoute.distanceM) - wholeRoute) < 1e-6,
  `${(wholeRoute / 60).toFixed(1)} min`);

  return results;
}
