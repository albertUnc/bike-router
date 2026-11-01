// Interactive elevation profile drawn as inline SVG.
// Hovering or dragging a finger along it reports the matching point so the map can show it.
import { gradeAt } from './elevation.js';
import {
  distanceFactor, distanceUnit, elevationFactor, elevationUnit,
  formatDistance, formatElevation, formatGrade, formatSpeed,
} from './format.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PAD = { left: 42, right: 10, top: 12, bottom: 20 };
const Y_STEPS = [5, 10, 20, 50, 100, 200, 500, 1000];
const X_STEPS = [0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 500];
const MIN_Y_SPAN = { metric: 50, imperial: 150 }; // keeps flat routes from looking mountainous
const MAX_Y_TICKS = 4;

function svgEl(name, attrs = {}, text) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  if (text !== undefined) el.textContent = text;
  return el;
}

/** Smallest step from `steps` that yields at most `maxTicks` ticks over `span`. */
function niceStep(span, maxTicks, steps) {
  return steps.find((s) => span / s <= maxTicks) ?? steps[steps.length - 1];
}

/**
 * @param {HTMLElement} container
 * @param {{onHover:(p:{lng:number,lat:number,index:number})=>void, onLeave:()=>void}} handlers
 */
export function createElevationChart(container, { onHover, onLeave }) {
  const svg = svgEl('svg');
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  container.classList.add('empty');
  container.append(svg, tip);

  let profile = null;
  let speeds = null; // estimated km/h per profile sample, or null when there is no estimate
  let units = 'metric';
  let layout = null; // scales and sizes of the last draw
  let cursor = null; // { line, dot } of the last draw

  function hide() {
    if (cursor) {
      cursor.line.setAttribute('visibility', 'hidden');
      cursor.dot.setAttribute('visibility', 'hidden');
    }
    tip.hidden = true;
    onLeave();
  }

  function draw() {
    svg.replaceChildren();
    cursor = null;
    layout = null;
    tip.hidden = true;
    if (!profile) return;

    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w < 60 || h < 60) return; // hidden or collapsed; redrawn by the resize observer

    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const df = distanceFactor(units);
    const ef = elevationFactor(units);
    const plotW = w - PAD.left - PAD.right;
    const plotH = h - PAD.top - PAD.bottom;
    const total = profile.distance || 1;

    // Vertical range in display units, widened to a minimum span and rounded to tick steps.
    const lo = profile.min / ef;
    const hi = profile.max / ef;
    const span = Math.max(hi - lo, MIN_Y_SPAN[units]);
    const mid = (lo + hi) / 2;
    const yStep = niceStep(span, MAX_Y_TICKS, Y_STEPS);
    const yMin = Math.floor((mid - span / 2) / yStep) * yStep;
    const yMax = Math.ceil((mid + span / 2) / yStep) * yStep;

    const sx = (metres) => PAD.left + (metres / total) * plotW;
    const sy = (value) => PAD.top + (1 - (value - yMin) / (yMax - yMin)) * plotH;
    const baseY = PAD.top + plotH;

    for (let k = 0; yMin + k * yStep <= yMax; k++) {
      const v = yMin + k * yStep;
      svg.append(svgEl('line', { class: 'grid', x1: PAD.left, x2: w - PAD.right, y1: sy(v), y2: sy(v) }));
      svg.append(svgEl('text', { class: 'tick', x: PAD.left - 5, y: sy(v) + 3, 'text-anchor': 'end' }, String(v)));
    }
    svg.append(svgEl('text', { class: 'tick', x: 2, y: 9 }, elevationUnit(units)));

    const xMax = total / df;
    const xStep = niceStep(xMax, Math.max(2, Math.floor(plotW / 70)), X_STEPS);
    for (let k = 0; k * xStep <= xMax; k++) {
      const v = k * xStep;
      svg.append(svgEl('text', {
        class: 'tick',
        x: sx(v * df),
        y: h - 5,
        'text-anchor': k === 0 ? 'start' : 'middle',
      }, `${Number(v.toFixed(1))} ${distanceUnit(units)}`));
    }

    // Draw at most about two samples per pixel.
    const stride = Math.max(1, Math.floor(profile.count / (plotW * 2)));
    const xs = [];
    const ys = [];
    for (let i = 0; i < profile.count; i += stride) {
      xs.push(sx(profile.d[i]));
      ys.push(sy(profile.ele[i] / ef));
    }
    if ((profile.count - 1) % stride !== 0) {
      xs.push(sx(profile.d[profile.count - 1]));
      ys.push(sy(profile.ele[profile.count - 1] / ef));
    }
    const points = xs.map((x, i) => `${x.toFixed(1)} ${ys[i].toFixed(1)}`);
    const linePath = `M${points.join(' L')}`;

    svg.append(svgEl('path', { class: 'area', d: `${linePath} L${xs[xs.length - 1].toFixed(1)} ${baseY} L${xs[0].toFixed(1)} ${baseY} Z` }));
    svg.append(svgEl('path', { class: 'line', d: linePath }));

    const line = svgEl('line', { class: 'cursor', y1: PAD.top, y2: baseY, visibility: 'hidden' });
    const dot = svgEl('circle', { class: 'dot', r: 4, visibility: 'hidden' });
    svg.append(line, dot);
    cursor = { line, dot };
    layout = { w, plotW, sx, sy, ef };
  }

  function show(clientX) {
    if (!profile || !layout) return;
    const x = clientX - svg.getBoundingClientRect().left;
    const fraction = Math.min(1, Math.max(0, (x - PAD.left) / layout.plotW));
    const i = Math.min(profile.count - 1, Math.round((fraction * profile.distance) / profile.stepM));

    const px = layout.sx(profile.d[i]);
    const py = layout.sy(profile.ele[i] / layout.ef);
    cursor.line.setAttribute('x1', px);
    cursor.line.setAttribute('x2', px);
    cursor.dot.setAttribute('cx', px);
    cursor.dot.setAttribute('cy', py);
    cursor.line.setAttribute('visibility', 'visible');
    cursor.dot.setAttribute('visibility', 'visible');

    tip.textContent = [
      formatDistance(profile.d[i], units),
      formatElevation(profile.ele[i], units),
      formatGrade(gradeAt(profile, i)),
      ...(speeds ? [formatSpeed(speeds[i], units)] : []),
    ].join(' · ');
    tip.hidden = false;
    const half = tip.offsetWidth / 2;
    tip.style.left = `${Math.min(Math.max(px, half), layout.w - half)}px`;

    onHover({ lng: profile.lng[i], lat: profile.lat[i], index: i });
  }

  svg.addEventListener('pointermove', (e) => show(e.clientX));
  svg.addEventListener('pointerdown', (e) => show(e.clientX));
  svg.addEventListener('pointerleave', (e) => {
    // On touch screens the cursor stays where the finger lifted.
    if (e.pointerType === 'mouse') hide();
  });

  new ResizeObserver(draw).observe(container);

  return {
    setProfile(nextProfile, nextUnits, nextSpeeds = null) {
      profile = nextProfile;
      units = nextUnits;
      speeds = nextSpeeds;
      container.classList.toggle('empty', !profile);
      draw();
      onLeave();
    },
    clear() {
      this.setProfile(null, units);
    },
  };
}
