// Strava client. Talks only to the Worker in worker/ (never to Strava directly), which holds the
// client secret and adds the CORS headers Strava's API lacks. Tokens are kept in the browser.
//
// The pieces that matter for correctness (token refresh, rate limits, turning Strava's streams into
// ride points) take their dependencies as arguments, so they can be tested without a network.

export const SCOPE = 'read,activity:read_all';

const REFRESH_MARGIN_S = 120;      // refresh the access token when it has less than this left
const BIKE_SPORTS = new Set(['Ride', 'GravelRide', 'MountainBikeRide']);
const STREAM_KEYS = 'time,latlng,altitude,watts';

export class StravaError extends Error {
  /** @param {'config'|'auth'|'limit'|'network'|'forbidden'|'helper'|'other'} code */
  constructor(message, code) {
    super(message);
    this.name = 'StravaError';
    this.code = code;
  }
}

export const DEFAULT_STRAVA_SETTINGS = {
  workerUrl: '',
  clientId: '',
  autoSync: true,
  windowDays: 90,       // how far back the first sync reaches; 0 means all time
  lastSyncSec: 0,       // when the last complete sync started (Unix seconds)
  skippedIds: [],       // activities already looked at that have nothing to import (no GPS, too short)
};

const WINDOW_CHOICES = [30, 90, 365, 0];

/** Normalises stored settings: fills gaps and drops anything of the wrong type. */
export function cleanStravaSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    workerUrl: typeof r.workerUrl === 'string' ? r.workerUrl.trim() : '',
    clientId: typeof r.clientId === 'string' ? r.clientId.trim() : '',
    autoSync: r.autoSync !== false,
    windowDays: WINDOW_CHOICES.includes(r.windowDays) ? r.windowDays : DEFAULT_STRAVA_SETTINGS.windowDays,
    lastSyncSec: Number.isFinite(r.lastSyncSec) && r.lastSyncSec > 0 ? r.lastSyncSec : 0,
    skippedIds: Array.isArray(r.skippedIds) ? r.skippedIds.filter(Number.isFinite).slice(-1000) : [],
  };
}

/** The Worker address without a trailing slash, or null if it is not a usable address. */
export function normalizeWorkerUrl(text) {
  let url;
  try {
    url = new URL(String(text ?? '').trim());
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

export function buildAuthorizeUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: SCOPE,
    state,
  });
  return `https://www.strava.com/oauth/authorize?${params}`;
}

/** Strava's rate-limit headers ("100,1000" and "12,340") as numbers, or null if absent. */
export function parseRateLimit(headers) {
  const limit = headers?.get?.('X-RateLimit-Limit');
  const usage = headers?.get?.('X-RateLimit-Usage');
  if (!limit || !usage) return null;
  const [limit15, limitDay] = limit.split(',').map(Number);
  const [usage15, usageDay] = usage.split(',').map(Number);
  return [limit15, limitDay, usage15, usageDay].every(Number.isFinite) ? { limit15, limitDay, usage15, usageDay } : null;
}

/** Cycling activities that can have a GPS track: not virtual, not e-bike, not trainer, not typed in by hand. */
export function isBikeActivity(activity) {
  const sport = activity.sport_type ?? activity.type;
  return BIKE_SPORTS.has(sport) && !activity.trainer && !activity.manual;
}

/**
 * Turns one activity and its streams into the points the ride importer takes. Returns null when the
 * activity has no GPS track. Power is used only when it came from a power meter: Strava also fills in
 * its own estimates, and those would be mistaken for measurements.
 */
export function activityToPoints(activity, streams) {
  const time = streams?.time?.data;
  const latlng = streams?.latlng?.data;
  if (!Array.isArray(time) || !Array.isArray(latlng) || time.length < 2 || latlng.length !== time.length) return null;

  const startMs = Date.parse(activity.start_date);
  if (!Number.isFinite(startMs)) return null;

  const sameLength = (series) => (Array.isArray(series) && series.length === time.length ? series : null);
  const altitude = sameLength(streams.altitude?.data);
  const watts = activity.device_watts === true ? sameLength(streams.watts?.data) : null;

  return time.map((seconds, i) => {
    const position = latlng[i];
    return {
      t: startMs + seconds * 1000,
      lat: Array.isArray(position) ? position[0] : NaN,
      lng: Array.isArray(position) ? position[1] : NaN,
      ele: altitude ? altitude[i] : null,
      power: watts ? watts[i] : null,
    };
  });
}

/**
 * @param {{workerUrl:string, getAuth:()=>object|null, saveAuth:(auth:object)=>void,
 *          fetchFn?:typeof fetch, nowSec?:()=>number}} options
 *   auth is { accessToken, refreshToken, expiresAt (Unix s), athlete: {id, name}|null }
 */
export function createStravaClient({ workerUrl, getAuth, saveAuth, fetchFn = (...args) => fetch(...args), nowSec = () => Math.floor(Date.now() / 1000) }) {
  let usage = null;

  async function call(path, init) {
    let response;
    try {
      response = await fetchFn(`${workerUrl}${path}`, init);
    } catch {
      throw new StravaError('Could not reach the Strava helper. Check its address and your connection.', 'network');
    }
    usage = parseRateLimit(response.headers) ?? usage;
    return response;
  }

  async function postJson(path, body, failureCode) {
    const response = await call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.json()).error ?? ''; } catch { /* no readable body */ }
      if (response.status === 403) throw new StravaError('The Strava helper does not accept this web address. Add it to ALLOWED_ORIGINS in the Worker.', 'helper');
      throw new StravaError(detail ? `Strava login failed: ${detail}` : `Strava login failed (${response.status}).`, failureCode);
    }
    return response.json();
  }

  function authFromTokens(data, previous) {
    if (!data?.access_token || !data?.refresh_token || !Number.isFinite(data.expires_at)) {
      throw new StravaError('The Strava helper returned an unexpected answer.', 'helper');
    }
    const athlete = data.athlete
      ? { id: data.athlete.id, name: `${data.athlete.firstname ?? ''} ${data.athlete.lastname ?? ''}`.trim() }
      : previous?.athlete ?? null;
    return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: data.expires_at, athlete };
  }

  /** Swaps the one-time code from the login redirect for tokens, and stores them. */
  async function exchangeCode(code) {
    const auth = authFromTokens(await postJson('/token', { code }, 'auth'), null);
    saveAuth(auth);
    return auth;
  }

  async function refresh() {
    const current = getAuth();
    if (!current?.refreshToken) throw new StravaError('Not connected to Strava.', 'auth');
    const auth = authFromTokens(await postJson('/refresh', { refresh_token: current.refreshToken }, 'auth'), current);
    saveAuth(auth);
    return auth;
  }

  async function accessToken() {
    let auth = getAuth();
    if (!auth) throw new StravaError('Not connected to Strava.', 'auth');
    if (auth.expiresAt - nowSec() < REFRESH_MARGIN_S) auth = await refresh();
    return auth.accessToken;
  }

  /** GET through the Worker. Resolves to the JSON body, or null if Strava has nothing at that path. */
  async function api(path, query = {}, retry = true) {
    const token = await accessToken();
    const search = new URLSearchParams(query).toString();
    const response = await call(`/api/${path}${search ? `?${search}` : ''}`, { headers: { Authorization: `Bearer ${token}` } });

    if (response.status === 401) {
      if (!retry) throw new StravaError('Strava rejected the login. Connect again.', 'auth');
      await refresh();
      return api(path, query, false);
    }
    if (response.status === 429) throw new StravaError('Strava rate limit reached. Try again in about 15 minutes.', 'limit');
    if (response.status === 404) return null;
    if (response.status === 403) {
      throw new StravaError('Strava refused access to the activities. Connect again and allow reading your activities.', 'forbidden');
    }
    if (!response.ok) throw new StravaError(`Strava answered with an error (${response.status}).`, 'other');
    return response.json();
  }

  return {
    exchangeCode,
    rateLimit: () => usage,
    getAthlete: () => api('athlete'),
    listActivities: async ({ after, page = 1, perPage = 100 }) =>
      (await api('athlete/activities', { after, page, per_page: perPage })) ?? [],
    getStreams: (id) => api(`activities/${id}/streams`, { keys: STREAM_KEYS, key_by_type: 'true' }),
    /** Revokes the app's access on Strava's side. Best effort: failing to reach Strava is not an error here. */
    async deauthorize() {
      try {
        const token = await accessToken();
        await call('/deauthorize', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      } catch {
        /* the local tokens are removed by the caller either way */
      }
    },
  };
}
