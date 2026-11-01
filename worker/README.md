# Strava helper (Cloudflare Worker)

A tiny server-side helper so the app can log in to Strava and import your rides. It is free to run
(Cloudflare's free plan allows 100,000 requests a day; this app uses a few dozen).

**Why it is needed.** Strava's login needs a client *secret*, and a secret cannot be kept in a web
page. Strava's data API also cannot be called straight from a browser. The Worker holds the secret
and forwards a handful of calls. It stores nothing and logs nothing. Your login tokens live only in
your browser.

You do this setup once, about 10 minutes.

## 1. Create a Strava API app

1. Log in to Strava and open https://www.strava.com/settings/api
2. Fill in the form:
   - **Application Name**: anything, e.g. "Bike Router".
   - **Category**: anything.
   - **Website**: any address, e.g. `http://localhost`.
   - **Authorization Callback Domain**: the domain the app is opened from. Use `localhost` while
     testing on your computer, or e.g. `yourname.github.io` once it is hosted. Strava allows one
     domain per app.
   - Upload any small image as the icon if it asks for one.
3. Save. Note the **Client ID** (a number) and the **Client Secret** (a long string, keep it private).

## 2. Deploy the Worker

### Option A: in the browser, no tools needed

1. Create a free account at https://dash.cloudflare.com and open **Workers & Pages**.
2. Press **Create** and choose **Start with Hello World!** (a Worker template). Do **not** choose
   "Upload your static files": that path is for plain websites and refuses a script. Give the Worker
   a name (e.g. `bike-router-strava`) and press **Deploy**.
3. On the page that follows, press **Edit code**, select everything in the editor, delete it, and
   paste the whole contents of `strava-worker.js` from this folder. Press **Deploy**.
4. Open the Worker's address. Before any settings exist it should show `"ok":true,"configured":false`,
   which means the code is running.
5. Under the Worker's **Settings → Variables and Secrets** add:
   - `STRAVA_CLIENT_ID`: your Client ID (type: text)
   - `STRAVA_CLIENT_SECRET`: your Client Secret (type: secret)
   - `ALLOWED_ORIGINS`: the addresses the app runs at, e.g. `http://localhost:8000`
     (several are allowed, separated by commas, no trailing slash)
6. Deploy again if it asks. Your Worker address looks like `https://bike-router-strava.YOURNAME.workers.dev`.

Cloudflare changes its dashboard now and then, so button names may differ slightly. What matters:
the Worker must be created from a **Worker template** (not a static upload), and its code must be
replaced with `strava-worker.js`.

### Option B: with the command line

In this folder, edit `wrangler.toml` (Client ID and allowed addresses), then:

    npx wrangler deploy
    npx wrangler secret put STRAVA_CLIENT_SECRET

## 3. Check it

Open the Worker address in a browser. You should see `{"ok":true,"configured":true,...}`.
If `configured` is `false`, the Client ID or Secret is missing.

## 4. Connect in the app

Open the app, then **Rides… → Strava…**, paste the Worker address and the Client ID, and press
**Connect**. Strava asks you to approve access (reading your activities). You come back to the app
connected, and your recent rides are imported.

## Good to know

- **Testing from a phone** over the local network uses an address like `http://192.168.1.23:8000`.
  Add it to `ALLOWED_ORIGINS`, and Strava's callback domain must match it (Strava allows only one,
  so it is easier to host the app, e.g. on GitHub Pages, and use that address everywhere).
- **Strava's limits** for a personal app: 100 requests per 15 minutes and 1,000 per day. Each ride
  imported costs one request, so the app imports in batches and tells you when to wait.
- **Disconnecting** in the app also revokes the app's access on Strava's side.
- Only these Strava paths are reachable through the Worker: your profile, your activity list, and
  one activity's details and streams. Nothing can be changed or deleted on Strava.
