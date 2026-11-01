// Map view: base map, waypoint markers, route line and the chart hover cursor.
// MapLibre is loaded as a global (`maplibregl`) from the script tag in index.html.
import { boundsOf } from './geo.js';
import { CANDIDATE_COLORS } from './palette.js';
import { badge, defaultLabel } from './waypoints.js';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const EMPTY_ROUTE = { type: 'FeatureCollection', features: [] };
const COORD_DECIMALS = 6;
const ROUTE_HIT_PX = 7; // how close a tap must be to the route line to count as "on the route"
const DOUBLE_TAP_MS = 240; // adding a point waits this long, so a double-tap zoom does not add two

// Speed (km/h) to colour, from slow red to fast green. The legend in index.html uses the same stops.
const SPEED_COLOR = [
  'interpolate', ['linear'], ['get', 'kmh'],
  5, '#c92a2a',
  12, '#f76707',
  20, '#fab005',
  28, '#82c91e',
  38, '#2b8a3e',
];

function round(value) {
  return Number(value.toFixed(COORD_DECIMALS));
}

/**
 * @param {string} containerId
 * @param {{center:[number,number], zoom:number,
 *          onAdd:(p:{lng:number,lat:number}, opts:{onRoute:boolean})=>void,
 *          onMove:(index:number, p:{lng:number,lat:number})=>void,
 *          onRename:(index:number)=>void, onSavePlace:(index:number)=>void,
 *          onRemove:(index:number)=>void}} options
 */
export function createMapView(containerId, { center, zoom, onAdd, onMove, onRename, onSavePlace, onRemove }) {
  const map = new maplibregl.Map({
    container: containerId,
    style: STYLE_URL,
    center,
    zoom,
    dragRotate: false,
    pitchWithRotate: false,
    maxPitch: 0, // flat map only; a two-finger tilt by accident is more annoying than useful
    attributionControl: { compact: true },
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.addControl(
    new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: false,
      showAccuracyCircle: false,
    }),
    'bottom-right',
  );

  // The map container changes size when the details panel is collapsed or expanded.
  new ResizeObserver(() => map.resize()).observe(document.getElementById(containerId));

  // Route line. Data set before the style finishes loading is applied once it has.
  let routeData = EMPTY_ROUTE;
  let speedData = EMPTY_ROUTE;
  let candidateData = EMPTY_ROUTE;
  let styleLoaded = false;

  map.on('load', () => {
    map.addSource('route', { type: 'geojson', data: routeData });
    map.addSource('route-speed', { type: 'geojson', data: speedData });
    map.addSource('candidates', { type: 'geojson', data: candidateData });
    map.addLayer({
      id: 'route-casing',
      type: 'line',
      source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.9 },
    });
    // Plain line shown until a speed estimate exists; the coloured segments are drawn over it.
    map.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#1971c2', 'line-width': 5 },
    });
    map.addLayer({
      id: 'route-speed',
      type: 'line',
      source: 'route-speed',
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: { 'line-color': SPEED_COLOR, 'line-width': 5 },
    });

    // Loop candidates: the selected one is drawn thicker and on top of the others.
    const isSelected = ['==', ['get', 'selected'], 1];
    map.addLayer({
      id: 'candidates-casing',
      type: 'line',
      source: 'candidates',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': ['case', isSelected, 10, 6.5], 'line-opacity': 0.85 },
    });
    map.addLayer({
      id: 'candidates-line',
      type: 'line',
      source: 'candidates',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['match', ['get', 'idx'], 0, CANDIDATE_COLORS[0], 1, CANDIDATE_COLORS[1], 2, CANDIDATE_COLORS[2], '#868e96'],
        'line-width': ['case', isSelected, 6.5, 3.5],
        'line-opacity': ['case', isSelected, 1, 0.8],
      },
    });
    styleLoaded = true;
  });

  /**
   * Shows loop candidates side by side, the selected one on top.
   * @param {{coords:number[][]}[]|null} candidates  null or empty removes them
   * @param {number} selected index of the highlighted candidate
   */
  function setCandidates(candidates, selected = 0) {
    candidateData = EMPTY_ROUTE;
    if (candidates?.length) {
      const features = candidates.map((c, i) => ({
        type: 'Feature',
        properties: { idx: i, selected: i === selected ? 1 : 0 },
        geometry: { type: 'LineString', coordinates: c.coords },
      }));
      features.sort((a, b) => a.properties.selected - b.properties.selected); // later features draw on top
      candidateData = { type: 'FeatureCollection', features };
    }
    if (styleLoaded) map.getSource('candidates').setData(candidateData);
  }

  function setRoute(coords) {
    routeData = coords
      ? {
          type: 'FeatureCollection',
          features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }],
        }
      : EMPTY_ROUTE;
    if (styleLoaded) map.getSource('route').setData(routeData);
  }

  /**
   * Colours the route by estimated speed.
   * @param {{lng:Float64Array, lat:Float64Array}|null} profile  resampled route (elevation.buildProfile)
   * @param {{i0:number, i1:number, speedMs:number}[]|null} segments  from estimator.estimate
   */
  function setRouteSpeeds(profile, segments) {
    speedData = EMPTY_ROUTE;
    if (profile && segments) {
      speedData = {
        type: 'FeatureCollection',
        features: segments.map((seg) => {
          const coordinates = [];
          for (let i = seg.i0; i <= seg.i1; i++) coordinates.push([profile.lng[i], profile.lat[i]]);
          return {
            type: 'Feature',
            properties: { kmh: Math.round(seg.speedMs * 36) / 10 },
            geometry: { type: 'LineString', coordinates },
          };
        }),
      };
    }
    if (styleLoaded) map.getSource('route-speed').setData(speedData);
  }

  // Waypoint markers. Tap (or right-click) a marker for its menu: rename, save as a place, remove.
  // Drag a marker to move it.
  const markers = [];

  function menuButton(label, className = '') {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `popup-btn ${className}`.trim();
    el.textContent = label;
    return el;
  }

  function createMarker() {
    const el = document.createElement('div');
    el.className = 'wp-marker';

    const menu = document.createElement('div');
    menu.className = 'wp-menu';
    const title = document.createElement('div');
    title.className = 'wp-menu-title';
    const rename = menuButton('Rename');
    const save = menuButton('Save place');
    const remove = menuButton('Remove point', 'danger');
    menu.append(title, rename, save, remove);

    const popup = new maplibregl.Popup({ offset: 20, closeButton: false }).setDOMContent(menu);
    const marker = new maplibregl.Marker({ element: el, draggable: true }).setPopup(popup);
    marker.menuTitle = title;

    marker.on('dragend', () => {
      const { lng, lat } = marker.getLngLat();
      onMove(markers.indexOf(marker), { lng: round(lng), lat: round(lat) });
      // Releasing a drag also produces a click, which would open the popup.
      setTimeout(() => { if (popup.isOpen()) popup.remove(); }, 0);
    });

    const choose = (handler) => () => {
      popup.remove();
      handler(markers.indexOf(marker));
    };
    rename.addEventListener('click', choose(onRename));
    save.addEventListener('click', choose(onSavePlace));
    remove.addEventListener('click', choose(onRemove));

    // Right-click opens the menu as well; a long press does the same on many phones.
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!popup.isOpen()) marker.togglePopup();
    });
    return marker;
  }

  function setWaypoints(waypoints) {
    while (markers.length > waypoints.length) markers.pop().remove();

    waypoints.forEach((w, i) => {
      let marker = markers[i];
      if (!marker) {
        marker = createMarker();
        markers[i] = marker;
        marker.setLngLat([w.lng, w.lat]).addTo(map);
      } else {
        marker.setLngLat([w.lng, w.lat]);
      }

      const el = marker.getElement();
      const { text, role } = badge(i, waypoints.length);
      const label = w.name || defaultLabel(i, waypoints.length);
      el.classList.toggle('start', role === 'start');
      el.classList.toggle('end', role === 'end');
      el.textContent = text;
      el.title = label;
      marker.menuTitle.textContent = label;
    });
  }

  let pendingAdd = null;

  map.on('click', (e) => {
    // Clicks on markers and popups bubble up to the map; they are not new points.
    if (e.originalEvent.target.closest('.wp-marker, .maplibregl-popup')) return;

    // A click on the drawn route inserts the point into that leg instead of appending it.
    let onRoute = false;
    if (styleLoaded) {
      const { x, y } = e.point;
      onRoute = map.queryRenderedFeatures(
        [[x - ROUTE_HIT_PX, y - ROUTE_HIT_PX], [x + ROUTE_HIT_PX, y + ROUTE_HIT_PX]],
        { layers: ['route-casing'] },
      ).length > 0;
    }
    const point = { lng: round(e.lngLat.lng), lat: round(e.lngLat.lat) };

    // A second tap shortly after the first is a double-tap zoom, not two new points. So adding waits
    // a moment, and a second tap in that time cancels it.
    if (pendingAdd) {
      clearTimeout(pendingAdd);
      pendingAdd = null;
      return;
    }
    pendingAdd = setTimeout(() => {
      pendingAdd = null;
      onAdd(point, { onRoute });
    }, DOUBLE_TAP_MS);
  });

  // Cursor dot that follows the pointer on the elevation chart.
  const cursorEl = document.createElement('div');
  cursorEl.className = 'cursor-dot';
  const cursor = new maplibregl.Marker({ element: cursorEl });
  let cursorShown = false;

  function showCursor(lng, lat) {
    cursor.setLngLat([lng, lat]);
    if (!cursorShown) {
      cursor.addTo(map);
      cursorShown = true;
    }
  }

  function hideCursor() {
    cursor.remove();
    cursorShown = false;
  }

  function fitTo(coords) {
    map.fitBounds(boundsOf(coords), { padding: 50, maxZoom: 15, duration: 500 });
  }

  /** Move to a search result: its bounding box when it has one, otherwise a street-level zoom. */
  function goTo({ lng, lat, bbox }) {
    if (bbox) {
      map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 40, maxZoom: 15, duration: 600 });
    } else {
      map.easeTo({ center: [lng, lat], zoom: 13, duration: 600 });
    }
  }

  /** Centre the map on a point, keeping the current zoom unless it is too far out to be useful. */
  function panTo({ lng, lat }) {
    map.easeTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 12), duration: 500 });
  }

  function getView() {
    const c = map.getCenter();
    return { center: [round(c.lng), round(c.lat)], zoom: Number(map.getZoom().toFixed(2)) };
  }

  return { setRoute, setRouteSpeeds, setCandidates, setWaypoints, showCursor, hideCursor, fitTo, goTo, panTo, getView };
}
