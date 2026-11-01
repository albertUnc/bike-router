// Ride history dialog: the list of imported rides and what they say about the rider, with a button
// for each suggested change to the rider profile. Holds no app state; main.js supplies the data.
import { formatDistance, formatDuration, formatElevation } from './format.js';
import { GRADE_BUCKET_CENTERS_PCT } from './calibration.js';

const $ = (id) => document.getElementById(id);
const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

const BAND_LABELS = [
  'Steep descent (below −8 %)', '−8 to −5 %', '−5 to −3 %', '−3 to −1 %', 'Flat (−1 to 1 %)',
  '1 to 3 %', '3 to 5 %', '5 to 8 %', 'Steep climb (above 8 %)',
];

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function button(label, onClick, { primary = false, disabled = false } = {}) {
  const el = element('button', `btn${primary ? ' primary' : ''}`, label);
  el.type = 'button';
  el.disabled = disabled;
  el.addEventListener('click', onClick);
  return el;
}

/**
 * @param {{onImport:(files:File[])=>void, onDelete:(id:string)=>void,
 *          onApply:(change:object)=>void}} handlers
 *   onApply gets { kind: 'ftp'|'stops'|'descent'|'fade'|'calibration'|'clearCalibration', ... }
 */
export function createRidesUI({ onImport, onDelete, onApply }) {
  const dialog = $('rides-dialog');
  const fileInput = $('rides-file');
  const note = $('rides-note');
  const empty = $('rides-empty');
  const list = $('rides-list');
  const analysisSection = $('analysis');
  const analysisBody = $('analysis-body');

  $('btn-import-rides').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files];
    fileInput.value = ''; // allows choosing the same files again
    if (files.length) onImport(files);
  });

  function setNote(text, { error = false } = {}) {
    note.textContent = text;
    note.style.color = error ? 'var(--danger)' : '';
  }

  function renderList(rides, units) {
    empty.hidden = rides.length > 0;
    list.replaceChildren(...rides.map((ride) => {
      const info = element('span', 'route-info');
      const meta = [
        formatDistance(ride.distanceM, units),
        formatDuration(ride.movingS),
        ride.hasElevation ? `+${formatElevation(ride.ascentM, units)}` : null,
        DATE_FORMAT.format(ride.startTime ?? ride.importedAt),
        ride.hasPower ? 'power meter' : 'no power data',
      ].filter(Boolean).join(' · ');
      info.append(element('span', 'route-name', ride.name), element('span', 'route-meta', meta));

      const actions = element('span', 'route-actions');
      actions.append(button('Delete', () => {
        if (confirm(`Remove "${ride.name}" from the ride history?`)) onDelete(ride.id);
      }));

      const item = document.createElement('li');
      item.append(info, actions);
      return item;
    }));
  }

  /** One suggestion: a headline, the evidence, and the button that applies it. */
  function suggestion(title, detail, ...controls) {
    const box = element('div', 'suggestion');
    const text = element('div', 'suggestion-text');
    text.append(element('strong', null, title), element('span', 'suggestion-detail', detail));
    box.append(text);
    if (controls.length) {
      const actions = element('div', 'suggestion-actions');
      actions.append(...controls);
      box.append(actions);
    }
    return box;
  }

  function calibrationTable(calibration) {
    const table = element('table', 'band-table');
    for (let k = 0; k < BAND_LABELS.length; k++) {
      const row = table.insertRow();
      row.insertCell().textContent = BAND_LABELS[k];
      row.insertCell().textContent = `×${calibration.gradeFactors[k].toFixed(2)}`;
      const km = calibration.coverageKm?.[k] ?? 0;
      const cell = row.insertCell();
      cell.textContent = km >= 1.5 ? `${km.toFixed(0)} km` : 'no data';
      cell.className = 'band-km';
    }
    return table;
  }

  function renderAnalysis(analysis, rider) {
    analysisSection.hidden = !analysis;
    if (!analysis) return;
    $('analysis-rider').textContent = rider.name;

    const parts = [];
    parts.push(element('p', 'note',
      `${analysis.rideCount} ride${analysis.rideCount === 1 ? '' : 's'}, ${analysis.powerRideCount} with power data. `
      + 'Suggestions only change your profile when you press a button.'));

    const { ftp, stops, descent, fade, calibration } = analysis;

    parts.push(ftp
      ? suggestion(
        `FTP ${ftp.ftpW} W`,
        `${ftp.basis}: ${ftp.bestWatts} W in "${ftp.rideName}". ${ftp.measured ? 'From a power meter.' : 'Estimated from speed and slope, which is rougher than a power meter.'} Your profile says ${rider.ftpW} W.`,
        button(`Use ${ftp.ftpW} W`, () => onApply({ kind: 'ftp', value: ftp.ftpW }), { primary: true, disabled: ftp.ftpW === rider.ftpW }),
      )
      : suggestion('FTP', 'No ride has a hard 20-minute stretch yet, so there is nothing to estimate it from.'));

    if (stops) {
      const value = Math.round(stops.secPerKm);
      parts.push(suggestion(
        `Stops and traffic: ${value} s per km`,
        `Short stops over ${stops.km.toFixed(0)} km of rides (breaks over 3 minutes are ignored). Your profile says ${rider.stopSecPerKm} s per km.`,
        button(`Use ${value} s`, () => onApply({ kind: 'stops', value }), { disabled: value === rider.stopSecPerKm }),
      ));
    }

    if (descent) {
      parts.push(suggestion(
        `Fastest descents: ${descent.kmh} km/h`,
        `Your profile caps descents at ${rider.maxDescentKmh} km/h.`,
        button(`Use ${descent.kmh} km/h`, () => onApply({ kind: 'descent', value: descent.kmh }), { disabled: descent.kmh === rider.maxDescentKmh }),
      ));
    }

    if (fade) {
      const current = `${Math.round(rider.powerCurve.fraction1h * 100)} % at 1 h, fade ${rider.powerCurve.exponent}`;
      parts.push(suggestion(
        `Power on long rides: ${Math.round(fade.fraction1h * 100)} % of FTP at 1 h, fade ${fade.exponent}`,
        `Fitted to ${fade.rides} long rides. Your profile says ${current}.`,
        button('Use these', () => onApply({ kind: 'fade', fraction1h: fade.fraction1h, exponent: fade.exponent })),
      ));
    }

    if (calibration) {
      const controls = [button('Apply calibration', () => onApply({
        kind: 'calibration', gradeFactors: calibration.gradeFactors, rideCount: calibration.rideCount,
      }), { primary: true })];
      if (rider.calibration) controls.push(button('Remove calibration', () => onApply({ kind: 'clearCalibration' })));

      const box = suggestion(
        `Speed by slope${rider.calibration ? ' (calibration is active)' : ''}`,
        'How your real speed compares with the model on each slope. Above 1 means you ride faster than the model says. '
        + 'If you also apply a new FTP, do that first and calibrate afterwards, so the two do not overlap.',
        ...controls,
      );
      box.append(calibrationTable(calibration));
      parts.push(box);
    } else {
      parts.push(suggestion('Speed by slope', 'Not enough rides with elevation data yet to compare speeds slope by slope.'));
    }

    analysisBody.replaceChildren(...parts);
  }

  /**
   * @param {{rides:object[], units:string, rider:object, analysis:object|null}} data
   */
  function render({ rides, units, rider, analysis }) {
    renderList(rides, units);
    renderAnalysis(analysis, rider);
  }

  return {
    open: () => {
      setNote('');
      dialog.showModal();
    },
    render,
    setNote,
  };
}
