// Share of the route per surface category or road type.

export const SURFACE_LABELS = {
  asphalt: 'Paved',
  compactedGravel: 'Compacted gravel',
  looseGravel: 'Loose gravel',
  cobbles: 'Cobbles / stones',
  dirt: 'Dirt / unpaved',
  unknown: 'Unknown',
};

/** Share of the route length per type, for a list of { from, to, type } coordinate-index ranges. */
function shares(ranges, route) {
  if (!ranges.length || !(route.distanceM > 0)) return [];

  const metres = {};
  let covered = 0;
  for (const { from, to, type } of ranges) {
    const length = route.distances[to] - route.distances[from];
    metres[type] = (metres[type] ?? 0) + length;
    covered += length;
  }

  // Stretches the engine reported nothing for count as unknown.
  const gap = route.distanceM - covered;
  if (gap > 1) metres.unknown = (metres.unknown ?? 0) + gap;

  return Object.entries(metres)
    .map(([type, m]) => ({ type, share: m / route.distanceM }))
    .filter((s) => s.share > 0)
    .sort((a, b) => b.share - a.share);
}

/** @returns {{type:string, share:number}[]} sorted by share, largest first */
export function surfaceBreakdown(route) {
  return shares(route.surface ?? [], route);
}

/** Same for road types (stateRoad, road, street, path, track, cycleway, ...). */
export function wayTypeBreakdown(route) {
  return shares(route.wayType ?? [], route);
}
