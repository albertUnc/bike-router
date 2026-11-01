// Ordered list of waypoints, like the stop list in a navigation app: each stop can be renamed,
// reordered (drag handle or arrow buttons), duplicated or removed, and the connector between two
// stops shows that leg's distance and ride time and lets you add a stop there.
import { badge, defaultLabel } from './waypoints.js';
import { formatDistance, formatDuration } from './format.js';

const SETTLE_MS = 220;          // keep in step with the transitions in style.css
const LIFT_SCALE = 1.03;        // the dragged row is lifted slightly off the list
const AUTOSCROLL_EDGE_PX = 40;  // pointer this close to the panel edge scrolls it while dragging
const AUTOSCROLL_STEP_PX = 6;

const ICONS = {
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  remove: '<path d="M6 6l12 12M18 6 6 18"/>',
  bookmark: '<path d="M6 4h12v17l-6-4-6 4z"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  grip: '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
};

function iconButton(kind, label, className) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `stop-btn ${className ?? ''}`.trim();
  button.setAttribute('aria-label', label);
  button.title = label;
  button.innerHTML =
    `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[kind]}</svg>`;
  return button;
}

/**
 * @param {{details:HTMLDetailsElement, list:HTMLElement, countEl:HTMLElement, returnButton:HTMLButtonElement,
 *          open:boolean,
 *          handlers:{onMove:(from:number,to:number)=>void, onDuplicate:(i:number)=>void,
 *                    onRemove:(i:number)=>void, onRename:(i:number,name:string)=>void,
 *                    onInsertAfter:(i:number)=>void, onFocus:(i:number)=>void, onSavePlace:(i:number)=>void,
 *                    onReturnToStart:()=>void, onToggle:(open:boolean)=>void}}} options
 */
export function createStopsList({ details, list, countEl, returnButton, open, handlers }) {
  details.open = open;
  details.addEventListener('toggle', () => handlers.onToggle(details.open));
  returnButton.addEventListener('click', handlers.onReturnToStart);

  /**
   * Drag a row by its handle. The row follows the pointer, the stops it passes slide aside to open a
   * gap, and on release it settles into the slot it was dropped on before the order is applied.
   */
  function startDrag(event, row, from) {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);

    const rows = [...list.querySelectorAll('.stop')];
    const scroller = list.closest('#panel');
    // Distance between two neighbouring stops, including the connector between them.
    const pitch = rows.length > 1 ? rows[1].offsetTop - rows[0].offsetTop : rows[0].offsetHeight;
    const startY = event.clientY;
    const startScroll = scroller ? scroller.scrollTop : 0;
    let pointerY = startY;
    let dest = from;
    let frame = 0;

    list.classList.add('reordering');
    row.classList.add('dragging');

    const update = () => {
      const scrolled = scroller ? scroller.scrollTop - startScroll : 0;
      const dy = Math.min((rows.length - 1 - from) * pitch, Math.max(-from * pitch, pointerY - startY + scrolled));
      row.style.transform = `translateY(${dy}px) scale(${LIFT_SCALE})`;
      dest = Math.min(rows.length - 1, Math.max(0, Math.round(from + dy / pitch)));

      rows.forEach((r, k) => {
        if (k === from) return;
        let shift = 0;
        if (from < dest && k > from && k <= dest) shift = -pitch;
        else if (from > dest && k >= dest && k < from) shift = pitch;
        r.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };

    // Keeps the panel scrolling while the pointer rests near its top or bottom edge.
    const tick = () => {
      if (scroller) {
        const box = scroller.getBoundingClientRect();
        if (pointerY < box.top + AUTOSCROLL_EDGE_PX) scroller.scrollTop -= AUTOSCROLL_STEP_PX;
        else if (pointerY > box.bottom - AUTOSCROLL_EDGE_PX) scroller.scrollTop += AUTOSCROLL_STEP_PX;
      }
      update();
      frame = requestAnimationFrame(tick);
    };

    const move = (e) => { pointerY = e.clientY; };

    const finish = (apply) => () => {
      cancelAnimationFrame(frame);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onCancel);

      const target = apply ? dest : from;
      row.classList.add('settling');
      row.style.transform = `translateY(${(target - from) * pitch}px) scale(1)`;

      // After the settle animation, drop all temporary styling; the re-render replaces the rows anyway.
      setTimeout(() => {
        list.classList.remove('reordering');
        rows.forEach((r) => {
          r.style.transform = '';
          r.classList.remove('dragging', 'settling');
        });
        if (apply && dest !== from) handlers.onMove(from, dest);
      }, SETTLE_MS);
    };
    const onUp = finish(true);
    const onCancel = finish(false);

    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onCancel);
    frame = requestAnimationFrame(tick);
  }

  function stopRow(waypoint, i, count) {
    const row = document.createElement('li');
    row.className = 'stop';

    const handle = iconButton('grip', 'Drag to reorder', 'stop-handle');
    handle.addEventListener('pointerdown', (e) => startDrag(e, row, i));

    const { text, role } = badge(i, count);
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = `stop-badge ${role}`;
    marker.textContent = text;
    marker.title = 'Show on map';
    marker.addEventListener('click', () => handlers.onFocus(i));

    const name = document.createElement('input');
    name.className = 'stop-name';
    name.type = 'text';
    name.maxLength = 60;
    name.value = waypoint.name;
    name.placeholder = defaultLabel(i, count);
    name.setAttribute('aria-label', `Name of stop ${i + 1}`);
    name.addEventListener('change', () => handlers.onRename(i, name.value.trim()));
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });

    const up = iconButton('up', 'Move up');
    up.disabled = i === 0;
    up.addEventListener('click', () => handlers.onMove(i, i - 1));

    const down = iconButton('down', 'Move down');
    down.disabled = i === count - 1;
    down.addEventListener('click', () => handlers.onMove(i, i + 1));

    const save = iconButton('bookmark', 'Save as a place');
    save.addEventListener('click', () => handlers.onSavePlace(i));

    const copy = iconButton('copy', 'Duplicate');
    copy.addEventListener('click', () => handlers.onDuplicate(i));

    const remove = iconButton('remove', 'Remove', 'danger');
    remove.addEventListener('click', () => handlers.onRemove(i));

    row.append(handle, marker, name, up, down, save, copy, remove);
    return row;
  }

  function legRow(i, leg, units, adding) {
    const row = document.createElement('li');
    row.className = 'leg';

    const info = document.createElement('span');
    info.className = 'leg-info';
    if (leg) {
      info.textContent = leg.distanceM < 1
        ? 'same place'
        : `${formatDistance(leg.distanceM, units)}${leg.sec ? ` · ${formatDuration(leg.sec)}` : ''}`;
    }

    const add = iconButton('add', adding ? 'Cancel adding a stop' : 'Add a stop here', adding ? 'active' : '');
    add.addEventListener('click', () => handlers.onInsertAfter(i));

    row.append(info, add);
    return row;
  }

  /**
   * @param {object[]} waypoints
   * @param {{distanceM:number, sec:number|null}[]|null} legs  one per gap between stops, or null while unknown
   * @param {'metric'|'imperial'} units
   * @param {number|null} insertAfter  index the next map tap will insert after, if in that mode
   */
  function render(waypoints, legs, units, insertAfter = null) {
    countEl.textContent = waypoints.length ? `(${waypoints.length})` : '';
    returnButton.disabled = waypoints.length < 2;

    const items = [];
    waypoints.forEach((w, i) => {
      items.push(stopRow(w, i, waypoints.length));
      if (i < waypoints.length - 1) items.push(legRow(i, legs?.[i], units, insertAfter === i));
    });
    list.replaceChildren(...items);
  }

  return { render };
}
