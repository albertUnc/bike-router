# Romania Bike Route Planner - Spec

## 1. Goal

A website where I plan bike routes in Romania, see elevation, and get realistic time and speed estimates based on my own fitness. Users: me, maybe a few friends. No accounts, no server database.

## 2. Bike and rider defaults

Default bike profile is a gravel-class bike with slim tires, road-like. Default surface preference: paved first, good gravel acceptable, avoid rough tracks and busy main roads where an alternative exists. Bike profile (mass, CdA, rolling resistance) is editable.

## 3. Tech stack

- **Map**: MapLibre GL JS with free vector tiles (OpenFreeMap or similar, no API key). OpenStreetMap data covers every Romanian city and street.
- **Routing and elevation**: OpenRouteService public API (free key, entered by the user in settings, stored locally). It provides cycling profiles, elevation in the route geometry, and a round-trip option. All routing calls go through one adapter module so the engine can later be swapped for BRouter, Valhalla or self-hosted GraphHopper without touching the rest.
- **Elevation chart**: a lightweight chart library or a hand-drawn canvas/SVG chart.
- **Storage**: localStorage or IndexedDB, plus export/import of all data as one JSON file.
- **Hosting**: GitHub Pages.
- **Strava**: NOT in M1-M3. Strava's token exchange needs a client secret, so a static site cannot do it alone. Phase 2 will use a tiny serverless function (e.g. Cloudflare Worker, free tier). Until then, ride history comes from uploaded GPX/FIT files.

## 4. Architecture

Modules (suggested):
- `map` - map view, markers, route line, click/long-press to add points.
- `routing` - the adapter. Input: list of waypoints, profile, options. Output: geometry with elevation, distance, ascent/descent, surface and road-type info if available.
- `rider` - profile data and the speed model.
- `estimator` - turns a route into per-segment speeds and total time using the rider model.
- `generator` - loop and detour route generation.
- `storage` - profiles, saved routes, settings, import/export.
- `ui` - panels, forms, elevation chart, mobile layout.

## 5. Rider model

**MVP (manual)**: the user enters FTP (W), body weight, bike weight, and optionally CdA and Crr. Defaults come from the bike profile.

**Speed per segment**: split the route into short segments (e.g. 50-100 m) with their grade. For each segment, solve for speed `v` from the power balance: rider power x drivetrain efficiency (~0.97) equals the sum of rolling resistance, gravity (grade) and air drag. Use a numeric solver (bisection or Newton). Rules:
- Target power depends on ride duration, as a fraction of FTP (higher for short rides, lower for long ones). Expose this as a single adjustable curve.
- Cap descent speed at a configurable maximum (e.g. 50-60 km/h) and a lower cap on bad surfaces.
- Surface multiplier on rolling resistance (asphalt, compacted gravel, loose gravel, cobbles, unknown).
- Add a configurable stop/traffic penalty, per km and per settlement crossed.
- Smooth the elevation data first. Raw DEM data is noisy and inflates climbing.

**Later (phase 2)**: estimate FTP/power curve from Strava history, and calibrate the speed per grade and surface from the user's real rides, which should beat pure physics.

## 6. Route generation

Three modes:
1. **A to B**: plain route between points, with optional waypoints.
2. **Loop from A**: user gives a start, and a target distance OR a target time. Use the engine's round-trip option with a random seed and direction. Generate several candidates, estimate each, and pick the best. For target time, adjust the requested length iteratively until the estimated time is within a tolerance (e.g. +-5%).
3. **A to B with target length** (after the first two work): if the direct route is shorter than the target, add detour waypoints placed on a ring or ellipse around the direct line, route through them, and keep the best match.

Candidate score: closeness to the target distance/time, low overlap with itself (no out-and-back unless allowed), preference for paved/quiet roads, and an optional elevation preference (flat / rolling / hilly). Show the top 3 candidates and let the user pick. Bad loops are the main failure mode, so always show candidates visually before committing.

## 7. Features for the MVP

Must have:
- Map of Romania, centered on the user's location or a saved default.
- Add waypoints by tap/click, drag to move, remove. Search box to find a place.
- Route drawn on the map, with total distance, ascent, descent.
- Elevation profile chart, interactive (hover/touch shows the point on the map and the grade).
- Time estimate from the manual rider profile, plus per-segment speed shown as a colored route line or in the chart.
- Profiles: create, edit, switch, delete. Stored locally.
- Save, load, delete routes. Export a route as GPX.
- Loop generator (mode 2) by distance or by time.
- Settings: API key, units, default bike profile, JSON export/import.

Nice to have after M3:
- GPX/FIT upload of past rides, estimating FTP and calibrating the model.
- Strava login via serverless function.
- Mode 3.
- Route sharing by link.
- Offline map area, PWA install on phone.

Out of scope: turn-by-turn navigation, accounts, social features, multi-user server.

## 8. Data model (JSON, stored locally)

- `profile`: id, name, weightKg, bikeKg, ftpW, cdA, crr, powerCurve settings, max descent speed.
- `route`: id, name, waypoints, geometry with elevation, stats, surface info, createdAt, profileIdUsed.
- `settings`: API key, units, active profile, map default.
- `ride` (phase 2): summary and sampled streams (distance, elevation, power, speed, time).

## 9. Milestones and acceptance criteria

- **M1 - Map and routing**: MapLibre map, waypoint editing, ORS routing through the adapter, distance/ascent/descent, elevation chart. Works on phone and desktop, deployable to GitHub Pages.
- **M2 - Profiles and time model**: profile editor, physics speed solver, per-segment speeds, total time, colored line. Include a small test page or script that checks the solver against known values (flat 200 W ~ 30 km/h range on a road bike, sanity checks on climbs and descents).
- **M3 - Storage and loops**: save/load/export (GPX, JSON), loop generator by distance and by time with 3 candidates.
- **M4 - Ride import**: GPX/FIT upload, FTP estimate, calibration.
- **M5 - Strava**: serverless OAuth, activity and stream import.

## 10. Notes and risks

- ORS free tier has daily request limits; cache results and avoid calling on every map drag (debounce, call on release).
- Never commit API keys. The key is entered in settings and stored locally.
- Elevation from routing engines is DEM-based and noisy, so smooth it before computing climbs and time.
- Romanian road quality and surface tags in OSM are incomplete, so treat "unknown" surface as its own category with a conservative default.
- Strava API terms restrict public third-party use; personal use and a few friends is fine, a public app is not.
