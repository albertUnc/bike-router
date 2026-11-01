// Checks for .gz import, the Strava Worker, the Strava client, the sync logic and saved places.
// Shared by tests/index.html (browser) and tests/run.mjs (Node).
import worker from '../worker/strava-worker.js';
import {
  StravaError, activityToPoints, buildAuthorizeUrl, cleanStravaSettings, createStravaClient, isBikeActivity,
  normalizeWorkerUrl, parseRateLimit,
} from '../js/strava.js';
import { syncActivities } from '../js/stravasync.js';
import { buildRide, isSameRide, parseRideFile } from '../js/rides.js';
import { buildBackup, parseBackup } from '../js/backup.js';
import { createPlace, mergePlaces, removePlace, sanitizePlaces, upsertPlace } from '../js/places.js';
import { defaultProfile } from '../js/rider.js';

const LNG0 = 25;
const LAT0 = 46;
const SECRET = 'SECRET-VALUE-123';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const jsonResponse = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/** Streams for a ride of `seconds` seconds, in the shape Strava returns them (keyed by type). */
function rideStreams(seconds = 600, { withWatts = true } = {}) {
  const time = Array.from({ length: seconds + 1 }, (_, i) => i);
  return {
    time: { data: time },
    latlng: { data: time.map((i) => [LAT0, LNG0 + i * 0.0001]) },
    altitude: { data: time.map((i) => 300 + i * 0.05) },
    ...(withWatts ? { watts: { data: time.map(() => 180) } } : {}),
  };
}

const activity = (id, extra = {}) => ({
  id, name: `Ride ${id}`, sport_type: 'Ride', start_date: new Date(Date.UTC(2026, 5, id, 8)).toISOString(), device_watts: true, ...extra,
});

/** Calls the Worker the way a browser would. The Request is a plain object: browsers will not let a script set Origin. */
async function callWorker(env, path, { method = 'GET', origin = 'http://localhost:8000', headers = {}, body = '', upstream } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return upstream ? upstream() : jsonResponse({});
  };
  try {
    const request = {
      method,
      url: `https://helper.example${path}`,
      headers: new Headers({ ...(origin ? { Origin: origin } : {}), ...headers }),
      text: async () => body,
    };
    const response = await worker.fetch(request, env);
    return { response, calls, text: await response.text() };
  } finally {
    globalThis.fetch = original;
  }
}

export async function runStravaChecks() {
  const results = [];
  const check = (name, pass, detail = '') => results.push({ name, pass: Boolean(pass), detail });

  // .gz files.
  const gpxText = `<gpx version="1.1"><trk><name>Zipped ride</name><trkseg>${
    Array.from({ length: 40 }, (_, i) => `<trkpt lat="46.0" lon="${25 + i * 0.0003}"><ele>300</ele><time>${new Date(Date.UTC(2026, 5, 1, 8, 0, i * 5)).toISOString()}</time></trkpt>`).join('')
  }</trkseg></trk></gpx>`;
  const parsedGz = await parseRideFile('Morning.gpx.gz', await gzip(gpxText));
  check('A gzipped GPX file is unpacked and read', parsedGz.points.length === 40 && parsedGz.name === 'Zipped ride', `${parsedGz.points.length} points`);

  const rejects = async (fn, text) => { try { await fn(); return false; } catch (e) { return e.message.includes(text); } };
  check('A .gz file that is not gzip data is refused with a reason',
    await rejects(() => parseRideFile('x.gpx.gz', new TextEncoder().encode('plain text').buffer), 'damaged'), '');
  check('Other file types are still refused', await rejects(() => parseRideFile('x.txt', new ArrayBuffer(4)), 'only .gpx and .fit'), '');
  check('The ride name drops both extensions', buildRide(parsedGz, 'Evening.gpx.gz').name === 'Zipped ride'
    && buildRide({ ...parsedGz, name: null }, 'Evening.gpx.gz').name === 'Evening', '');

  // The Worker.
  const env = { STRAVA_CLIENT_ID: '12345', STRAVA_CLIENT_SECRET: SECRET, ALLOWED_ORIGINS: 'http://localhost:8000, https://me.github.io/' };

  const health = await callWorker(env, '/', { origin: null });
  check('Worker: the health page works without an origin and reveals no secret',
    health.response.status === 200 && JSON.parse(health.text).configured === true && !health.text.includes(SECRET), health.text);
  check('Worker: the health page says when it is not configured',
    JSON.parse((await callWorker({ ALLOWED_ORIGINS: 'x' }, '/', { origin: null })).text).configured === false, '');

  const blocked = await callWorker(env, '/token', { method: 'POST', origin: 'https://evil.example', body: '{"code":"a"}' });
  check('Worker: other web addresses are refused and nothing is sent to Strava', blocked.response.status === 403 && blocked.calls.length === 0, '');
  check('Worker: a request without an origin is refused', (await callWorker(env, '/token', { method: 'POST', origin: null, body: '{"code":"a"}' })).response.status === 403, '');

  const preflight = await callWorker(env, '/api/athlete', { method: 'OPTIONS', origin: 'https://me.github.io' });
  check('Worker: browser preflight is answered for an allowed address (a trailing slash in the setting is fine)',
    preflight.response.status === 204 && preflight.response.headers.get('Access-Control-Allow-Origin') === 'https://me.github.io'
    && preflight.response.headers.get('Access-Control-Allow-Headers').includes('Authorization'), '');

  const tokenUpstream = () => jsonResponse({
    access_token: 'access1', refresh_token: 'refresh1', expires_at: 1900000000, token_type: 'Bearer',
    athlete: { id: 7, firstname: 'Ada', lastname: 'Rider', email: 'private@example.com', city: 'Somewhere' },
  });
  const exchanged = await callWorker(env, '/token', { method: 'POST', body: '{"code":"abc"}', upstream: tokenUpstream });
  const sent = exchanged.calls[0];
  check('Worker: the code is exchanged at Strava together with the secret',
    sent.url === 'https://www.strava.com/oauth/token' && String(sent.init.body).includes(`client_secret=${SECRET}`)
    && String(sent.init.body).includes('code=abc') && String(sent.init.body).includes('grant_type=authorization_code'), '');
  const exchangedBody = JSON.parse(exchanged.text);
  check('Worker: the browser gets the tokens and the name, but never the secret or private details',
    exchangedBody.access_token === 'access1' && exchangedBody.athlete.firstname === 'Ada'
    && !exchanged.text.includes(SECRET) && !exchanged.text.includes('private@example.com') && exchanged.response.status === 200, '');

  const refreshed = await callWorker(env, '/refresh', { method: 'POST', body: '{"refresh_token":"r0"}', upstream: tokenUpstream });
  check('Worker: refreshing sends the refresh token and the secret', String(refreshed.calls[0].init.body).includes('refresh_token=r0')
    && String(refreshed.calls[0].init.body).includes('grant_type=refresh_token') && refreshed.response.status === 200, '');

  check('Worker: bad input is answered with 400 or 413, and never reaches Strava',
    (await callWorker(env, '/token', { method: 'POST', body: 'not json' })).response.status === 400
    && (await callWorker(env, '/token', { method: 'POST', body: '{}' })).response.status === 400
    && (await callWorker(env, '/token', { method: 'POST', body: JSON.stringify({ code: 'x'.repeat(5000) }) })).response.status === 413, '');

  check('Worker: Strava turning a code down is passed on as an error',
    (await callWorker(env, '/token', { method: 'POST', body: '{"code":"bad"}', upstream: () => jsonResponse({ message: 'Bad Request' }, 400) })).response.status === 400, '');
  check('Worker: a missing secret is reported clearly',
    (await callWorker({ ALLOWED_ORIGINS: 'http://localhost:8000' }, '/token', { method: 'POST', body: '{"code":"a"}' })).response.status === 500, '');

  const proxied = await callWorker(env, '/api/athlete/activities?after=5&page=1', {
    headers: { Authorization: 'Bearer tok' },
    upstream: () => jsonResponse([{ id: 1 }], 200, { 'X-RateLimit-Limit': '100,1000', 'X-RateLimit-Usage': '3,40' }),
  });
  check('Worker: allowed Strava reads are forwarded with the user\'s own token',
    proxied.calls[0].url === 'https://www.strava.com/api/v3/athlete/activities?after=5&page=1'
    && proxied.calls[0].init.headers.Authorization === 'Bearer tok' && proxied.response.status === 200, proxied.calls[0].url);
  check('Worker: rate-limit headers are passed back and exposed to the browser',
    proxied.response.headers.get('x-ratelimit-usage') === '3,40' && proxied.response.headers.get('Access-Control-Expose-Headers').includes('X-RateLimit-Usage'), '');
  check('Worker: streams of one activity can be read',
    (await callWorker(env, '/api/activities/123/streams?keys=time', { headers: { Authorization: 'Bearer t' } })).calls.length === 1, '');

  const forbidden = await Promise.all([
    callWorker(env, '/api/athlete/zones', { headers: { Authorization: 'Bearer t' } }),
    callWorker(env, '/api/uploads', { headers: { Authorization: 'Bearer t' } }),
    callWorker(env, '/api/activities/1/../athlete/zones', { headers: { Authorization: 'Bearer t' } }),
    callWorker(env, '/api/activities/1/streams', { method: 'POST', headers: { Authorization: 'Bearer t' } }),
  ]);
  check('Worker: anything beyond reading activities is refused without contacting Strava',
    forbidden.every((r) => r.response.status === 404 && r.calls.length === 0), forbidden.map((r) => r.response.status).join(','));
  check('Worker: reads without a token are refused', (await callWorker(env, '/api/athlete')).response.status === 401, '');

  // Client helpers.
  check('Helper address: https and local http are accepted, everything else is not',
    normalizeWorkerUrl(' https://a.workers.dev/ ') === 'https://a.workers.dev' && normalizeWorkerUrl('http://localhost:8787') === 'http://localhost:8787'
    && normalizeWorkerUrl('http://example.com') === null && normalizeWorkerUrl('nonsense') === null && normalizeWorkerUrl('') === null, '');

  const authorize = new URL(buildAuthorizeUrl({ clientId: '99', redirectUri: 'http://localhost:8000/', state: 'st' }));
  check('The Strava login address carries the client, return address, state and the read-activities permission',
    authorize.origin === 'https://www.strava.com' && authorize.searchParams.get('client_id') === '99'
    && authorize.searchParams.get('redirect_uri') === 'http://localhost:8000/' && authorize.searchParams.get('state') === 'st'
    && authorize.searchParams.get('scope').includes('activity:read_all'), '');

  const limits = parseRateLimit(new Headers({ 'X-RateLimit-Limit': '100,1000', 'X-RateLimit-Usage': '12,340' }));
  check('Rate-limit headers are read', limits.limit15 === 100 && limits.usageDay === 340 && parseRateLimit(new Headers()) === null, '');

  check('Only outdoor cycling counts',
    isBikeActivity({ sport_type: 'GravelRide' }) && isBikeActivity({ type: 'Ride' })
    && !isBikeActivity({ sport_type: 'VirtualRide' }) && !isBikeActivity({ sport_type: 'EBikeRide' }) && !isBikeActivity({ sport_type: 'Run' })
    && !isBikeActivity({ sport_type: 'Ride', trainer: true }) && !isBikeActivity({ sport_type: 'Ride', manual: true }), '');

  const settings = cleanStravaSettings({ workerUrl: 5, clientId: ' 12 ', windowDays: 7, skippedIds: [1, 'x', 2], autoSync: false });
  check('Stored Strava settings are cleaned', settings.workerUrl === '' && settings.clientId === '12' && settings.windowDays === 90
    && settings.skippedIds.join() === '1,2' && settings.autoSync === false && cleanStravaSettings(null).autoSync === true, '');

  const withMeter = activityToPoints(activity(1), rideStreams());
  const withoutMeter = activityToPoints(activity(1, { device_watts: false }), rideStreams());
  check('Strava streams become ride points; power only counts when it came from a power meter',
    withMeter.length === 601 && withMeter[0].power === 180 && withoutMeter[0].power === null
    && withMeter[10].t - withMeter[0].t === 10000 && withMeter[0].t === Date.parse(activity(1).start_date), '');
  check('An activity without a GPS track gives nothing',
    activityToPoints(activity(1), { time: { data: [0, 1] } }) === null
    && activityToPoints(activity(1), { time: { data: [0, 1, 2] }, latlng: { data: [[1, 1]] } }) === null, '');

  // The client against a fake helper.
  let stored = null;
  let nowSec = 1000;
  const calls = [];
  let handler = () => jsonResponse({});
  const client = createStravaClient({
    workerUrl: 'https://helper.example',
    getAuth: () => stored,
    saveAuth: (a) => { stored = a; },
    nowSec: () => nowSec,
    fetchFn: async (url, init) => { calls.push({ url, init }); return handler(url, init); },
  });
  const tokens = (n, expiresAt) => jsonResponse({ access_token: `a${n}`, refresh_token: `r${n}`, expires_at: expiresAt, athlete: { id: 1, firstname: 'Ada', lastname: 'Rider' } });

  handler = () => tokens(1, 5000);
  const auth = await client.exchangeCode('code');
  check('Logging in stores the tokens and the athlete\'s name', stored.accessToken === 'a1' && auth.athlete.name === 'Ada Rider' && calls[0].url === 'https://helper.example/token', '');

  handler = (url) => (url.includes('/refresh') ? tokens(2, 9000) : jsonResponse([{ id: 5 }]));
  nowSec = 4950; // 50 s before expiry
  const list = await client.listActivities({ after: 1 });
  check('An access token about to expire is refreshed before it is used',
    stored.accessToken === 'a2' && list[0].id === 5 && calls.some((c) => c.url.endsWith('/refresh'))
    && calls.at(-1).init.headers.Authorization === 'Bearer a2', '');

  let first = true;
  handler = (url) => {
    if (url.includes('/refresh')) return tokens(3, 9000);
    if (first) { first = false; return jsonResponse({}, 401); }
    return jsonResponse([{ id: 6 }]);
  };
  nowSec = 5000;
  check('A rejected token is refreshed once and the request retried', (await client.listActivities({ after: 1 }))[0].id === 6 && stored.accessToken === 'a3', '');

  const failsWith = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
  handler = () => jsonResponse({}, 429);
  check('Strava\'s rate limit is reported as such', (await failsWith(() => client.getStreams(1)))?.code === 'limit', '');
  handler = () => jsonResponse({}, 404);
  check('An activity without streams gives null, not an error', (await client.getStreams(1)) === null, '');
  handler = () => jsonResponse({}, 403);
  check('A missing permission is reported as such', (await failsWith(() => client.getStreams(1)))?.code === 'forbidden', '');
  handler = () => { throw new TypeError('offline'); };
  check('An unreachable helper is reported as a network problem', (await failsWith(() => client.getStreams(1)))?.code === 'network', '');
  handler = () => jsonResponse([], 200, { 'X-RateLimit-Limit': '100,1000', 'X-RateLimit-Usage': '88,500' });
  await client.listActivities({ after: 1 });
  check('The client remembers Strava\'s rate-limit usage', client.rateLimit()?.usage15 === 88, '');
  handler = () => jsonResponse({ error: 'x' }, 403);
  check('A helper that refuses this web address says how to fix it',
    (await failsWith(() => client.exchangeCode('c')))?.message.includes('ALLOWED_ORIGINS'), '');

  // Sync logic against a fake client.
  const fake = ({ activities, streams = {}, usage = null, failures = new Map() }) => {
    const seen = [];
    return {
      seen,
      rateLimit: () => usage,
      listActivities: async ({ page }) => (page === 1 ? activities : []),
      getStreams: async (id) => {
        seen.push(id);
        if (failures.has(id)) throw failures.get(id);
        return id in streams ? streams[id] : rideStreams();
      },
    };
  };
  const run = (client2, extra = {}) => {
    const saved = [];
    return syncActivities({
      client: client2, afterSec: 0, knownIds: new Set(), isDuplicate: () => false,
      saveRide: async (r) => { saved.push(r); }, ...extra,
    }).then((result) => ({ result, saved }));
  };

  const mixed = fake({
    activities: [activity(1), activity(2), activity(3, { sport_type: 'VirtualRide' }), activity(4), activity(5)],
    streams: { 4: null },
  });
  const basic = await run(mixed, { knownIds: new Set([5]) });
  check('Sync imports rides it does not have, newest first, and skips virtual and known ones',
    basic.result.added === 2 && basic.saved.map((r) => r.stravaId).join() === '2,1' && !mixed.seen.includes(3) && !mixed.seen.includes(5), basic.saved.map((r) => r.stravaId).join());
  check('A ride without GPS is counted and remembered so it is not fetched again',
    basic.result.noGps === 1 && basic.result.skippedIds.includes(4), '');
  check('Imported rides are marked as coming from Strava', basic.saved[0].source === 'strava' && basic.saved[0].hasPower === true, '');

  const batch = await run(fake({ activities: [activity(1), activity(2), activity(3)] }), { maxRides: 2 });
  check('A run imports at most its limit and says how many are waiting', batch.result.added === 2 && batch.result.remaining === 1 && batch.result.stoppedBy === null, '');

  const nearLimit = await run(fake({ activities: [activity(1), activity(2)], usage: { limit15: 100, usage15: 96, limitDay: 1000, usageDay: 5 } }));
  check('Sync stops before Strava\'s rate limit is reached', nearLimit.result.stoppedBy === 'limit' && nearLimit.result.added === 0 && nearLimit.result.remaining === 2, '');

  const midway = await run(fake({
    activities: [activity(1), activity(2), activity(3)], failures: new Map([[2, new StravaError('limit', 'limit')]]),
  }));
  check('A rate-limit answer mid-run keeps what was imported and reports what is left',
    midway.result.added === 1 && midway.result.stoppedBy === 'limit' && midway.result.remaining === 2, '');

  const authFailure = fake({ activities: [activity(1)], failures: new Map([[1, new StravaError('Connect again.', 'auth')]]) });
  check('A login problem stops the sync with an error', (await failsWith(() => run(authFailure)))?.code === 'auth', '');

  const tooShort = await run(fake({ activities: [activity(1)], streams: { 1: rideStreams(20) } }));
  check('A ride that cannot be used is reported and remembered', tooShort.result.failed.length === 1 && tooShort.result.skippedIds.includes(1) && tooShort.result.added === 0, '');

  const dupes = await run(fake({ activities: [activity(1)] }), { isDuplicate: () => true });
  check('A ride already imported from a file is not added twice', dupes.result.duplicates === 1 && dupes.saved.length === 0, '');

  const controller = new AbortController();
  controller.abort();
  check('Cancelling stops the sync', (await failsWith(() => run(fake({ activities: [activity(1)] }), { signal: controller.signal })))?.name === 'AbortError', '');

  const rideA = buildRide({ name: 'a', source: 'strava', points: activityToPoints(activity(1), rideStreams()) }, 'a');
  const sameRide = { ...rideA, startTime: rideA.startTime + 3000, distanceM: rideA.distanceM * 1.005 };
  check('The same ride from a file and from Strava is recognised, within a few seconds and a percent',
    isSameRide(rideA, sameRide) && !isSameRide(rideA, { ...rideA, startTime: rideA.startTime + 60000 }) && !isSameRide(rideA, { ...rideA, distanceM: rideA.distanceM * 1.2 }), '');

  // Saved places.
  const cafe = createPlace('  Café stop ', 25.5, 46.2);
  const messy = sanitizePlaces([{ id: 'a', name: 'Home', lng: 25, lat: 46 }, { id: 'a', name: 'Dup id', lng: 26, lat: 47 },
    { name: '', lng: 1, lat: 2 }, { name: 'Bad', lng: 'x', lat: 1 }, { name: 'Far', lng: 500, lat: 1 }, null]);
  check('Places: names are trimmed, invalid entries dropped, ids made unique',
    cafe.name === 'Café stop' && messy.length === 3 && new Set(messy.map((p) => p.id)).size === 3 && messy[2].name === 'Place', `${messy.length} kept`);
  const places = upsertPlace([cafe], { ...cafe, name: 'Café' });
  check('Places: saving again replaces by id, removing works, merging keeps the rest',
    places.length === 1 && places[0].name === 'Café' && removePlace(places, cafe.id).length === 0
    && mergePlaces(places, [createPlace('Lake', 1, 2), { ...cafe, name: 'Café 2' }]).length === 2, '');

  const settingsForBackup = { apiKey: SECRET, units: 'metric', routingProfile: 'cycling-road', activeProfileId: null, mapDefault: null };
  const backupText = JSON.stringify(buildBackup({ settings: settingsForBackup, profiles: [defaultProfile()], routes: [], places }));
  check('Places travel with a backup, and the API key still does not',
    parseBackup(backupText).places.length === 1 && !backupText.includes(SECRET), '');

  return results;
}
