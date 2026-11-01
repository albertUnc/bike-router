// Loop generator UI: the options dialog and the list of candidates shown while a choice is pending.
// Holds no app state; main.js runs the search and owns the candidates.
import { CANDIDATE_COLORS } from './palette.js';
import { distanceFactor, distanceUnit, formatDistance, formatDuration, formatElevation } from './format.js';

const $ = (id) => document.getElementById(id);
const SECONDS_PER_HOUR = 3600;

export const DEFAULT_LOOP_PREFS = {
  kind: 'distance',        // 'distance' or 'time'
  distanceM: 40000,
  timeSec: 2 * SECONDS_PER_HOUR,
  elevation: 'any',        // 'any', 'flat', 'rolling' or 'hilly'
  preferPaved: true,
  allowOutAndBack: false,
};

const ELEVATIONS = ['any', 'flat', 'rolling', 'hilly'];

/** Stored preferences may be missing fields or hand-edited; fall back to defaults field by field. */
function cleanPrefs(raw) {
  const p = { ...DEFAULT_LOOP_PREFS, ...(raw ?? {}) };
  return {
    kind: p.kind === 'time' ? 'time' : 'distance',
    distanceM: Number.isFinite(p.distanceM) && p.distanceM > 0 ? p.distanceM : DEFAULT_LOOP_PREFS.distanceM,
    timeSec: Number.isFinite(p.timeSec) && p.timeSec > 0 ? p.timeSec : DEFAULT_LOOP_PREFS.timeSec,
    elevation: ELEVATIONS.includes(p.elevation) ? p.elevation : 'any',
    preferPaved: Boolean(p.preferPaved),
    allowOutAndBack: Boolean(p.allowOutAndBack),
  };
}

/**
 * @param {{onGenerate:(prefs:object)=>void, onSelect:(index:number)=>void,
 *          onUse:()=>void, onDiscard:()=>void}} handlers
 */
export function createLoopUI({ onGenerate, onSelect, onUse, onDiscard }) {
  const dialog = $('loop-dialog');
  const kindSelect = $('loop-kind');
  const valueInput = $('loop-value');
  const valueLabel = $('loop-value-label');
  const elevationSelect = $('loop-elevation');
  const pavedBox = $('loop-paved');
  const outBackBox = $('loop-outback');

  const panel = $('candidates');
  const listEl = $('candidates-list');
  const noteEl = $('candidates-note');

  let prefs = cleanPrefs(null);
  let units = 'metric';
  let shownKind = prefs.kind;

  /** Writes what is typed in the value box into prefs, in base units (metres or seconds). */
  function readValue() {
    const typed = Number(valueInput.value);
    if (!(typed > 0)) return;
    if (shownKind === 'distance') prefs.distanceM = typed * distanceFactor(units);
    else prefs.timeSec = typed * SECONDS_PER_HOUR;
  }

  function showValue() {
    shownKind = kindSelect.value;
    if (shownKind === 'distance') {
      valueLabel.textContent = `Length (${distanceUnit(units)})`;
      valueInput.value = String(Number((prefs.distanceM / distanceFactor(units)).toFixed(1)));
    } else {
      valueLabel.textContent = 'Ride time (hours)';
      valueInput.value = String(Number((prefs.timeSec / SECONDS_PER_HOUR).toFixed(2)));
    }
  }

  kindSelect.addEventListener('change', () => {
    readValue(); // still uses the previous kind, so what was typed is kept for it
    showValue();
  });

  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'generate') return;
    prefs.kind = kindSelect.value;
    readValue();
    prefs.elevation = elevationSelect.value;
    prefs.preferPaved = pavedBox.checked;
    prefs.allowOutAndBack = outBackBox.checked;
    onGenerate({ ...prefs });
  });

  /** @param {string} startText where the loop will start, e.g. "your first stop (A)" */
  function open(stored, nextUnits, startText) {
    $('loop-start').textContent = startText;
    prefs = cleanPrefs(stored);
    units = nextUnits;
    kindSelect.value = prefs.kind;
    elevationSelect.value = prefs.elevation;
    pavedBox.checked = prefs.preferPaved;
    outBackBox.checked = prefs.allowOutAndBack;
    showValue();
    dialog.returnValue = '';
    dialog.showModal();
  }

  $('btn-use-loop').addEventListener('click', onUse);
  $('btn-discard-loops').addEventListener('click', onDiscard);

  /**
   * @param {{metrics:object}[]} candidates
   * @param {number} selected
   * @param {string} note short text next to the heading
   */
  function showCandidates(candidates, selected, nextUnits, note = '') {
    panel.hidden = false;
    noteEl.textContent = note;
    listEl.replaceChildren(...candidates.map((candidate, i) => {
      const m = candidate.metrics;

      const dot = document.createElement('span');
      dot.className = 'candidate-dot';
      dot.style.background = CANDIDATE_COLORS[i % CANDIDATE_COLORS.length];

      const main = document.createElement('span');
      main.className = 'candidate-main';
      main.textContent = `${formatDistance(m.distanceM, nextUnits)} · ${formatDuration(m.timeSec)} · +${formatElevation(m.ascentM, nextUnits)}`;

      const sub = document.createElement('span');
      sub.className = 'candidate-sub';
      const details = [`Loop ${i + 1}`, `${Math.round(m.asphaltShare * 100)} % paved`];
      if (m.overlap >= 0.05) details.push(`${Math.round(m.overlap * 100)} % retraced`);
      sub.textContent = details.join(' · ');

      const text = document.createElement('span');
      text.append(main, sub);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = `candidate${i === selected ? ' selected' : ''}`;
      button.setAttribute('aria-pressed', String(i === selected));
      button.append(dot, text);
      button.addEventListener('click', () => onSelect(i));

      const item = document.createElement('li');
      item.append(button);
      return item;
    }));
  }

  function hideCandidates() {
    panel.hidden = true;
    listEl.replaceChildren();
  }

  return { open, showCandidates, hideCandidates };
}
