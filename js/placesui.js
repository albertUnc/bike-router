// Saved places dialog: the list, with buttons to add a place to the route, show it, rename or delete it.
// Holds no app state; main.js supplies the places and does the work.

const $ = (id) => document.getElementById(id);

function button(label, onClick) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'btn';
  el.textContent = label;
  el.addEventListener('click', onClick);
  return el;
}

/**
 * @param {{onAddStop:(id:string)=>void, onShow:(id:string)=>void,
 *          onRename:(id:string)=>void, onDelete:(id:string)=>void}} handlers
 */
export function createPlacesUI({ onAddStop, onShow, onRename, onDelete }) {
  const dialog = $('places-dialog');
  const list = $('places-list');
  const empty = $('places-empty');

  /** (Re)draws the list. @param {{id:string, name:string, lng:number, lat:number}[]} places */
  function render(places) {
    empty.hidden = places.length > 0;
    const sorted = [...places].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    list.replaceChildren(...sorted.map((place) => {
      const name = document.createElement('span');
      name.className = 'route-name';
      name.textContent = place.name;

      const where = document.createElement('span');
      where.className = 'route-meta';
      where.textContent = `${place.lat.toFixed(4)}, ${place.lng.toFixed(4)}`;

      const info = document.createElement('span');
      info.className = 'route-info';
      info.append(name, where);

      const actions = document.createElement('span');
      actions.className = 'route-actions';
      actions.append(
        button('Add as stop', () => {
          dialog.close();
          onAddStop(place.id);
        }),
        button('Show', () => {
          dialog.close();
          onShow(place.id);
        }),
        button('Rename', () => onRename(place.id)),
        button('Delete', () => {
          if (confirm(`Delete the place "${place.name}"?`)) onDelete(place.id);
        }),
      );

      const item = document.createElement('li');
      item.append(info, actions);
      return item;
    }));
  }

  return {
    open: (places) => {
      render(places);
      dialog.showModal();
    },
    render,
  };
}
