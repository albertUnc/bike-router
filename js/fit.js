// Minimal FIT file reader (the binary format Garmin, Wahoo, Strava exports and most bike computers
// use). It extracts the "record" messages, which hold the per-second position, altitude and power.
//
// Layout: a 12 or 14 byte header, then messages until the declared data size, then a 2 byte CRC.
// Each message is a definition (describes a message layout) or data (values in that layout).

const FIT_EPOCH_OFFSET_S = 631065600; // seconds between 1970-01-01 and the FIT epoch, 1989-12-31
const SEMICIRCLES_TO_DEGREES = 180 / 2 ** 31;
const RECORD_MESSAGE = 20;

// Field numbers inside a record message.
const F = {
  timestamp: 253, lat: 0, lng: 1, altitude: 2, enhancedAltitude: 78, power: 7,
};

// Base type number to size in bytes. Only the types that appear in the fields above matter, but
// every type has to be skippable.
const TYPE_SIZE = { 0: 1, 1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 7: 1, 8: 4, 9: 8, 10: 1, 11: 2, 12: 4, 13: 1, 14: 8, 15: 8, 16: 8 };

/** Reads one number of the given base type, or null for the type's "invalid" marker. */
function readNumber(view, offset, baseType, little) {
  switch (baseType) {
    case 0: case 2: case 13: { const v = view.getUint8(offset); return v === 0xff ? null : v; }
    case 1: { const v = view.getInt8(offset); return v === 0x7f ? null : v; }
    case 3: { const v = view.getInt16(offset, little); return v === 0x7fff ? null : v; }
    case 4: { const v = view.getUint16(offset, little); return v === 0xffff ? null : v; }
    case 5: { const v = view.getInt32(offset, little); return v === 0x7fffffff ? null : v; }
    case 6: { const v = view.getUint32(offset, little); return v === 0xffffffff ? null : v; }
    case 10: { const v = view.getUint8(offset); return v === 0 ? null : v; }
    case 11: { const v = view.getUint16(offset, little); return v === 0 ? null : v; }
    case 12: { const v = view.getUint32(offset, little); return v === 0 ? null : v; }
    case 8: { const v = view.getFloat32(offset, little); return Number.isNaN(v) ? null : v; }
    default: return null; // strings, 64-bit values and arrays are not needed
  }
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {{name:null, source:'fit', points:{t:number, lat:number, lng:number, ele:number|null, power:number|null}[]}}
 *   t is a Unix time in milliseconds.
 */
export function parseFit(buffer) {
  const view = new DataView(buffer);
  const invalid = () => new Error('This is not a valid FIT file.');
  if (buffer.byteLength < 14) throw invalid();

  const headerSize = view.getUint8(0);
  const tag = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
  if ((headerSize !== 12 && headerSize !== 14) || tag !== '.FIT') throw invalid();

  const end = Math.min(buffer.byteLength, headerSize + view.getUint32(4, true));
  const definitions = new Map(); // local message type -> layout
  const points = [];
  let lastTimestamp = 0;
  let pos = headerSize;

  while (pos < end) {
    const header = view.getUint8(pos++);
    const compressed = (header & 0x80) !== 0;

    if (!compressed && (header & 0x40)) {
      // Definition message.
      const hasDeveloperFields = (header & 0x20) !== 0;
      const localType = header & 0x0f;
      if (pos + 5 > end) break;
      pos++; // reserved
      const little = view.getUint8(pos++) === 0;
      const globalNumber = view.getUint16(pos, little);
      pos += 2;
      const fieldCount = view.getUint8(pos++);
      const fields = [];
      for (let i = 0; i < fieldCount; i++) {
        if (pos + 3 > end) throw invalid();
        fields.push({ num: view.getUint8(pos), size: view.getUint8(pos + 1), baseType: view.getUint8(pos + 2) & 0x1f });
        pos += 3;
      }
      let developerBytes = 0;
      if (hasDeveloperFields) {
        const devCount = view.getUint8(pos++);
        for (let i = 0; i < devCount; i++) {
          developerBytes += view.getUint8(pos + 1);
          pos += 3;
        }
      }
      definitions.set(localType, { globalNumber, little, fields, developerBytes });
      continue;
    }

    // Data message: normal header carries the local type in its low bits, compressed in bits 5-6.
    const localType = compressed ? (header >> 5) & 0x03 : header & 0x0f;
    const definition = definitions.get(localType);
    if (!definition) throw invalid();

    const values = {};
    let cursor = pos;
    for (const field of definition.fields) {
      if (cursor + field.size > end) throw invalid();
      const typeSize = TYPE_SIZE[field.baseType];
      if (typeSize && field.size === typeSize && definition.globalNumber === RECORD_MESSAGE) {
        values[field.num] = readNumber(view, cursor, field.baseType, definition.little);
      }
      cursor += field.size;
    }
    pos = cursor + definition.developerBytes;

    if (compressed) {
      // The header holds only the low 5 bits of the time; the rest comes from the last full timestamp.
      const offset = header & 0x1f;
      let timestamp = (lastTimestamp & ~0x1f) + offset;
      if (offset < (lastTimestamp & 0x1f)) timestamp += 0x20;
      values[F.timestamp] = timestamp;
    }
    if (values[F.timestamp] != null) lastTimestamp = values[F.timestamp];

    if (definition.globalNumber !== RECORD_MESSAGE) continue;
    const lat = values[F.lat];
    const lng = values[F.lng];
    if (lat == null || lng == null || values[F.timestamp] == null) continue; // no position: indoor or lost signal

    // Altitude is stored in 1/5 m steps with a 500 m offset; the "enhanced" field is the same at higher range.
    const rawAltitude = values[F.enhancedAltitude] ?? values[F.altitude] ?? null;
    points.push({
      t: (values[F.timestamp] + FIT_EPOCH_OFFSET_S) * 1000,
      lat: lat * SEMICIRCLES_TO_DEGREES,
      lng: lng * SEMICIRCLES_TO_DEGREES,
      ele: rawAltitude === null ? null : rawAltitude / 5 - 500,
      power: values[F.power] ?? null,
    });
  }

  if (!points.length) throw new Error('This FIT file has no GPS track (an indoor ride, perhaps).');
  return { name: null, source: 'fit', points };
}
