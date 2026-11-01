# Bike Router

Personal cycling route planner for Romania. Static site, no backend, no build step.
Everything user-specific is kept in the browser (localStorage).

## Run locally

ES modules do not load from `file://`, so serve the folder. `serve.py` is a static server that
disables caching, so edits show up on a normal reload:

    cd bike-router
    python3 serve.py

Then open http://localhost:8000 (`python3 -m http.server 8000` also works, but the browser may keep
old copies of the JS files). Geolocation works on localhost and on https. Solver checks:
http://localhost:8000/tests/index.html, or `node tests/run.mjs`.

## Getting a routing key

1. Sign up for free at https://account.heigit.org/ (HeiGIT, the organisation behind openrouteservice).
2. Confirm your email, log in and open the Dashboard.
3. Copy your API key (the whole string; it can be long).
4. In the app, open Settings (top right of the search bar), paste it and press Save.

The key is stored only in this browser. The free plan allows 2000 route requests per day and 40 per
minute. If openrouteservice.org is down, the same links are on https://api.heigit.org/.

## Features

- Plan routes by tapping the map; drag stops, tap the route line to insert a stop, reorder or duplicate stops in the list.
- Elevation profile, surface mix, estimated time per segment and in total for the chosen rider profile.
- Save, load and delete routes (kept in the browser's IndexedDB); export a route as GPX.
- Loop generator: a loop of a target distance or ride time from the first stop, three candidates compared on the map.
- Backup: export or import riders, saved routes, imported rides and settings as one JSON file (the API key is never included).
- Ride history: import .gpx or .fit files of rides you have done. The app estimates your FTP from your best efforts (from a power meter, or estimated from speed and slope when there is none), and suggests stop penalty, descent speed and power fade. It can also calibrate the speed model per slope against your real speeds. Nothing is applied until you press a button.
- Strava: log in once and new rides are imported automatically (when the app opens, or with Sync). Needs a small free helper, see `worker/README.md`. Your login tokens stay in your browser; the helper stores nothing.
- Saved places: name a stop and keep it for reuse. Tap a stop on the map (or right-click it) for Rename, Save place and Remove; the Stops list has a bookmark button; the bookmark in the search bar lists your places.

## Testing on a phone

1. Put the phone and the computer on the same network. A computer on ethernet and a phone on Wi-Fi
   is fine when both come from the same router (their addresses start with the same three numbers,
   e.g. 192.168.1.x).
2. Run `python3 serve.py` and open the "On a phone" address it prints. If it prints several
   (ethernet and Wi-Fi), use the one whose first three numbers match the phone's.
3. If the page does not load, the computer's firewall is blocking the port (on Ubuntu: `sudo ufw allow 8000/tcp`),
   or the router isolates Wi-Fi devices from wired ones (guest networks and some "AP isolation" settings do).

Over plain http the location button does not work (browsers only allow geolocation on https or
localhost); everything else does. Hosted on GitHub Pages (https) it works too.

## Layout

    index.html          page shell and settings dialog
    css/style.css       mobile-first styles, light and dark
    js/main.js          app state and wiring
    js/map.js           MapLibre map, markers, route line, chart cursor
    js/routing/         routing adapter (index.js) and the OpenRouteService engine (ors.js)
    js/elevation.js     resampling and smoothing, ascent and descent
    js/physics.js       power-balance speed solver
    js/rider.js         rider/bike profiles, validation, power-vs-duration curve
    js/estimator.js     per-segment speeds, total and leg times
    js/waypoints.js     stop list model and edit operations (pure, no DOM)
    js/stops.js         stop list UI: reorder, duplicate, rename, leg info
    js/gpx.js           GPX export
    js/routes.js        saved-route records (pack, unpack, validate)
    js/routestore.js    saved routes in IndexedDB
    js/backup.js        JSON backup export and import
    js/generator.js     loop generator: candidates, scoring, overlap detection
    js/library.js       save dialog and saved-routes list
    js/loops.js         loop dialog and candidate list
    js/dialogs.js       dialog button wiring
    js/download.js      file download helper
    js/id.js            id generation that also works over plain http
    js/db.js            shared IndexedDB access (routes and rides)
    js/gpxread.js       reads recorded rides from GPX
    js/fit.js           reads recorded rides from FIT (binary)
    js/rides.js         ride records: resampling, pauses, validation
    js/ridestore.js     imported rides in IndexedDB
    js/rideanalysis.js  FTP, stops, descents, power fade and slope calibration from rides
    js/calibration.js   speed factors per grade band
    js/ridesui.js       ride history dialog
    js/strava.js        Strava client: login code exchange, token refresh, rate limits, streams to ride points
    js/stravasync.js    imports new Strava rides in rate-limit-friendly batches
    js/stravaflow.js    connect, disconnect and sync orchestration
    js/stravaui.js      Strava dialog
    js/places.js        saved places (pure helpers)
    js/placesui.js      saved places dialog
    worker/             the Strava helper (Cloudflare Worker) and its setup guide
    serve.py            local development server (no caching, prints phone addresses)
    tests/              logic checks: open tests/index.html, or run node tests/run.mjs
    js/chart.js         SVG elevation profile
    js/surface.js       surface share of a route
    js/geocode.js       place search
    js/search.js        search box UI
    js/storage.js       settings and the working route in localStorage
    js/ui.js            stats, status line, settings dialog
    js/format.js        units and formatting
    js/geo.js           distance helpers

## Deploy

Push the folder to a GitHub repository and enable Pages for the branch root.
