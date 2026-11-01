// Cloudflare Worker: the small server-side half of the Strava connection.
//
// Why it exists: Strava's login needs the app's client SECRET to swap a login code for tokens, and a
// secret cannot live in a web page. Strava's data API also does not allow calls straight from a
// browser (no CORS), so data requests go through here too.
//
// What it does: nothing is stored or logged. It forwards a handful of calls to Strava, adding the
// secret where Strava needs it, and answers only to the web addresses listed in ALLOWED_ORIGINS.
//
// Settings (Worker "Variables and Secrets"):
//   STRAVA_CLIENT_ID      your Strava app's Client ID
//   STRAVA_CLIENT_SECRET  your Strava app's Client Secret (keep it secret)
//   ALLOWED_ORIGINS       comma separated list of the addresses the app runs at,
//                         e.g. http://localhost:8000,https://yourname.github.io

const STRAVA = 'https://www.strava.com';
const MAX_BODY_CHARS = 4096;
const MAX_QUERY_CHARS = 600;

// The only Strava API paths the app may reach through this Worker.
const API_PATHS = [
  /^athlete$/,
  /^athlete\/activities$/,
  /^activities\/\d+$/,
  /^activities\/\d+\/streams$/,
];

// Rate-limit information the app uses to pace itself.
const FORWARDED_HEADERS = ['content-type', 'x-ratelimit-limit', 'x-ratelimit-usage', 'retry-after'];
const EXPOSED_HEADERS = 'X-RateLimit-Limit, X-RateLimit-Usage, Retry-After';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Expose-Headers': EXPOSED_HEADERS,
    'Access-Control-Max-Age': '86400',
  };
}

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) throw new HttpError(413, 'Request body too large.');
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object') throw new Error('not an object');
    return value;
  } catch {
    throw new HttpError(400, 'Request body must be a JSON object.');
  }
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value || value.length > 300) throw new HttpError(400, `Missing or invalid "${name}".`);
  return value;
}

/** Asks Strava for tokens. Only the fields the app needs are passed back to the browser. */
async function tokenRequest(env, params, cors) {
  if (!env.STRAVA_CLIENT_ID || !env.STRAVA_CLIENT_SECRET) {
    throw new HttpError(500, 'The Worker is missing STRAVA_CLIENT_ID or STRAVA_CLIENT_SECRET.');
  }
  const response = await fetch(`${STRAVA}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.STRAVA_CLIENT_ID, client_secret: env.STRAVA_CLIENT_SECRET, ...params }),
  });
  if (!response.ok) return json({ error: 'strava_rejected', status: response.status }, response.status === 400 ? 400 : 502, cors);

  const data = await response.json();
  return json({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
    athlete: data.athlete ? { id: data.athlete.id, firstname: data.athlete.firstname, lastname: data.athlete.lastname } : undefined,
  }, 200, cors);
}

async function proxyApi(request, url, cors) {
  const path = url.pathname.slice('/api/'.length).replace(/\/+$/, '');
  if (!API_PATHS.some((pattern) => pattern.test(path))) throw new HttpError(404, 'That Strava path is not available through this Worker.');

  const authorization = request.headers.get('Authorization');
  if (!authorization) throw new HttpError(401, 'Missing Authorization header.');
  if (url.search.length > MAX_QUERY_CHARS) throw new HttpError(414, 'Query too long.');

  const upstream = await fetch(`${STRAVA}/api/v3/${path}${url.search}`, { headers: { Authorization: authorization } });
  const headers = { ...cors, 'Cache-Control': 'no-store' };
  for (const name of FORWARDED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

async function handle(request, env) {
  const url = new URL(request.url);
  const origin = (request.headers.get('Origin') ?? '').replace(/\/+$/, '');

  // Health check for setup: open the Worker's address in a browser. Reveals no secrets.
  if (request.method === 'GET' && url.pathname === '/') {
    return json({
      ok: true,
      configured: Boolean(env.STRAVA_CLIENT_ID && env.STRAVA_CLIENT_SECRET),
      allowedOrigins: allowedOrigins(env).length,
    }, 200);
  }

  if (!origin || !allowedOrigins(env).includes(origin)) throw new HttpError(403, 'This address is not allowed to use the Worker.');
  const cors = corsHeaders(origin);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  if (request.method === 'POST' && url.pathname === '/token') {
    const body = await readJson(request);
    return tokenRequest(env, { code: requireString(body.code, 'code'), grant_type: 'authorization_code' }, cors);
  }
  if (request.method === 'POST' && url.pathname === '/refresh') {
    const body = await readJson(request);
    return tokenRequest(env, { refresh_token: requireString(body.refresh_token, 'refresh_token'), grant_type: 'refresh_token' }, cors);
  }
  if (request.method === 'POST' && url.pathname === '/deauthorize') {
    const authorization = request.headers.get('Authorization');
    if (!authorization) throw new HttpError(401, 'Missing Authorization header.');
    const response = await fetch(`${STRAVA}/oauth/deauthorize`, { method: 'POST', headers: { Authorization: authorization } });
    return json({ ok: response.ok }, response.ok ? 200 : 502, cors);
  }
  if (request.method === 'GET' && url.pathname.startsWith('/api/')) return proxyApi(request, url, cors);

  throw new HttpError(404, 'Not found.');
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      if (err instanceof HttpError) {
        // Errors to an allowed browser carry CORS headers so the app can read the message.
        const origin = (request.headers.get('Origin') ?? '').replace(/\/+$/, '');
        const cors = origin && allowedOrigins(env).includes(origin) ? corsHeaders(origin) : {};
        return json({ error: err.message }, err.status, cors);
      }
      return json({ error: 'Unexpected error in the Worker.' }, 500);
    }
  },
};
