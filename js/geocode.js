// Place search through the OpenRouteService geocoder, limited to Romania.

const URL = 'https://api.openrouteservice.org/geocode/search';
const RESULT_COUNT = 6;

/**
 * @param {string} text
 * @param {{apiKey:string, focus?:[number,number], signal?:AbortSignal}} options
 *   focus is [lng, lat]; results near it are ranked higher.
 * @returns {Promise<{label:string, lng:number, lat:number, bbox:number[]|null}[]>}
 */
export async function searchPlaces(text, { apiKey, focus, signal }) {
  const params = new URLSearchParams({
    api_key: apiKey,
    text,
    'boundary.country': 'RO',
    size: String(RESULT_COUNT),
  });
  if (focus) {
    params.set('focus.point.lon', String(focus[0]));
    params.set('focus.point.lat', String(focus[1]));
  }

  const res = await fetch(`${URL}?${params}`, { signal });
  if (res.status === 401 || res.status === 403) throw new Error('The search service rejected the API key.');
  if (res.status === 429) throw new Error('Search request limit reached.');
  if (!res.ok) throw new Error(`Search failed (HTTP ${res.status}).`);

  const data = await res.json();
  return (data.features ?? []).map((f) => ({
    label: f.properties.label,
    lng: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
    bbox: f.bbox ?? null,
  }));
}
