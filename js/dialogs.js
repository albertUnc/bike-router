// Shared dialog helpers.

/**
 * Dialog buttons marked data-close close their dialog with that value. Only the primary action in
 * each dialog is a submit button, so pressing Enter in a field triggers it and never Cancel or Delete.
 */
export function wireDialogButtons(root = document) {
  for (const button of root.querySelectorAll('dialog [data-close]')) {
    button.addEventListener('click', () => {
      // A button switched to type=submit (see library.js) is handled by the form itself.
      if (button.type === 'button') button.closest('dialog').close(button.dataset.close);
    });
  }
}

/**
 * Asks for a name in the shared name dialog.
 * Resolves to the trimmed text (possibly empty), or to null if the dialog was cancelled.
 */
export function askName({ title, value = '', placeholder = '', confirmLabel = 'OK' }) {
  const dialog = document.getElementById('name-dialog');
  const input = document.getElementById('name-input');
  document.getElementById('name-title').textContent = title;
  document.getElementById('name-ok').textContent = confirmLabel;
  input.value = value;
  input.placeholder = placeholder;
  dialog.returnValue = '';

  return new Promise((resolve) => {
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      resolve(dialog.returnValue === 'ok' ? input.value.trim() : null);
    };
    dialog.addEventListener('close', onClose);
    dialog.showModal();
    input.select();
  });
}
