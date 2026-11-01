// Reads the track points of a recorded ride from GPX text. Uses patterns rather than a DOM parser
// so it behaves the same in every browser and can be tested outside one.
//
// Power is read from the usual extension tags: <power> (Strava and others), <watts>, and
// <PowerInWatts> (Garmin). Namespace prefixes are ignored.

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

function decodeEntities(text) {
  return text.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m]);
}

function attribute(attributes, name) {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return match ? Number(match[1] ?? match[2]) : NaN;
}

/** Text of the first <name> element in `body`, ignoring any namespace prefix. */
function tagText(body, name) {
  const match = body.match(new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([^<]*)</(?:[\\w-]+:)?${name}>`));
  return match ? match[1].trim() : null;
}

function firstNumber(body, names) {
  for (const name of names) {
    const text = tagText(body, name);
    if (text !== null && text !== '') {
      const value = Number(text);
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

/**
 * @param {string} text
 * @returns {{name:string|null, source:'gpx', points:{t:number, lat:number, lng:number, ele:number|null, power:number|null}[]}}
 *   t is a Unix time in milliseconds, NaN where the point has no timestamp.
 */
export function parseGpx(text) {
  if (!/<gpx\b/i.test(text)) throw new Error('This is not a GPX file.');

  const points = [];
  for (const match of text.matchAll(/<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/g)) {
    const attrs = match[1];
    const body = match[2] ?? '';
    const lat = attribute(attrs, 'lat');
    const lng = attribute(attrs, 'lon');
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const time = tagText(body, 'time');
    points.push({
      t: time ? Date.parse(time) : NaN,
      lat,
      lng,
      ele: firstNumber(body, ['ele']),
      power: firstNumber(body, ['power', 'watts', 'PowerInWatts']),
    });
  }
  if (!points.length) throw new Error('This GPX file has no track points (it may only contain a planned route).');

  const track = text.match(/<trk\b[^>]*>([\s\S]*?)<name>([^<]*)<\/name>/);
  const meta = text.match(/<metadata\b[^>]*>[\s\S]*?<name>([^<]*)<\/name>/);
  const raw = track?.[2] ?? meta?.[1] ?? null;
  return { name: raw ? decodeEntities(raw.trim()) || null : null, source: 'gpx', points };
}
