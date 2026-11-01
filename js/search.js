// Search box: runs a place search on submit and lists the matches under the bar.
import { searchPlaces } from './geocode.js';

const MIN_QUERY_LENGTH = 2;

/**
 * @param {{form:HTMLFormElement, input:HTMLInputElement, list:HTMLElement,
 *          getApiKey:()=>string, getFocus:()=>[number,number],
 *          onPick:(place:object)=>void, onAddPlace:(place:object)=>void,
 *          onMissingKey:()=>void, onError:(message:string)=>void}} options
 */
export function initSearch({ form, input, list, getApiKey, getFocus, onPick, onAddPlace, onMissingKey, onError }) {
  let controller = null;

  function hideResults() {
    list.hidden = true;
    list.replaceChildren();
  }

  function showResults(places) {
    list.replaceChildren();
    if (!places.length) {
      const none = document.createElement('li');
      none.className = 'none';
      none.textContent = 'No places found';
      list.append(none);
    }
    for (const place of places) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = place.label;
      button.addEventListener('click', () => {
        input.value = place.label;
        hideResults();
        onPick(place);
      });

      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'add-place';
      add.textContent = '+';
      add.title = 'Add as a stop';
      add.setAttribute('aria-label', `Add ${place.label} as a stop`);
      add.addEventListener('click', () => {
        hideResults();
        onAddPlace(place);
      });

      item.append(button, add);
      list.append(item);
    }
    list.hidden = false;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (text.length < MIN_QUERY_LENGTH) return;

    const apiKey = getApiKey();
    if (!apiKey) {
      onMissingKey();
      return;
    }

    controller?.abort();
    controller = new AbortController();
    try {
      showResults(await searchPlaces(text, { apiKey, focus: getFocus(), signal: controller.signal }));
    } catch (err) {
      if (err.name === 'AbortError') return;
      hideResults();
      onError(
        err instanceof TypeError
          ? navigator.onLine
            ? 'Could not reach the search service. Check your API key and your connection.'
            : 'You appear to be offline. Check your connection.'
          : err.message,
      );
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideResults();
  });

  // Tapping the map or anywhere outside the search area dismisses the list.
  document.addEventListener('pointerdown', (e) => {
    if (!list.contains(e.target) && !form.contains(e.target)) hideResults();
  });
}
