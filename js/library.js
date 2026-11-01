// Save dialog and the saved-routes list. Holds no app state; main.js supplies the records.
import { formatDistance, formatDuration, formatElevation } from './format.js';

const $ = (id) => document.getElementById(id);
const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * @param {{onSave:(r:{name:string, mode:'new'|'update'})=>void, onLoad:(id:string)=>void,
 *          onExportGpx:(id:string)=>void, onDelete:(id:string)=>void}} handlers
 */
export function createLibrary({ onSave, onLoad, onExportGpx, onDelete }) {
  const saveDialog = $('save-dialog');
  const nameInput = $('save-name');
  const newButton = $('save-new');
  const updateButton = $('save-update');

  const routesDialog = $('routes-dialog');
  const list = $('routes-list');
  const empty = $('routes-empty');

  saveDialog.addEventListener('close', () => {
    const mode = saveDialog.returnValue;
    if (mode === 'new' || mode === 'update') onSave({ name: nameInput.value, mode });
  });

  /** @param {{name:string, canUpdate:boolean}} options canUpdate: the route was loaded from, or saved to, an entry */
  function openSave({ name, canUpdate }) {
    nameInput.value = name;
    updateButton.hidden = !canUpdate;
    // With nothing to update, "Save as new" is the main action, so Enter in the name field triggers it.
    newButton.type = canUpdate ? 'button' : 'submit';
    newButton.classList.toggle('primary', !canUpdate);
    saveDialog.returnValue = '';
    saveDialog.showModal();
    nameInput.select();
  }

  function button(label, onClick) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'btn';
    el.textContent = label;
    el.addEventListener('click', onClick);
    return el;
  }

  /** (Re)draws the list. @param {object[]} records saved-route records, newest first */
  function renderRoutes(records, units) {
    empty.hidden = records.length > 0;
    list.replaceChildren(...records.map((record) => {
      const item = document.createElement('li');

      const name = document.createElement('span');
      name.className = 'route-name';
      name.textContent = record.name;

      const meta = document.createElement('span');
      meta.className = 'route-meta';
      const { distanceM, ascentM, timeSec } = record.stats;
      meta.textContent = [
        formatDistance(distanceM, units),
        `+${formatElevation(ascentM, units)}`,
        timeSec > 0 ? formatDuration(timeSec) : null,
        DATE_FORMAT.format(record.updatedAt),
      ].filter(Boolean).join(' · ');

      const info = document.createElement('span');
      info.className = 'route-info';
      info.append(name, meta);

      const actions = document.createElement('span');
      actions.className = 'route-actions';
      actions.append(
        button('Load', () => {
          routesDialog.close();
          onLoad(record.id);
        }),
        button('GPX', () => onExportGpx(record.id)),
        button('Delete', () => {
          if (confirm(`Delete "${record.name}"? This cannot be undone.`)) onDelete(record.id);
        }),
      );

      item.append(info, actions);
      return item;
    }));
  }

  function openRoutes(records, units) {
    renderRoutes(records, units);
    routesDialog.showModal();
  }

  return { openSave, openRoutes, renderRoutes };
}
