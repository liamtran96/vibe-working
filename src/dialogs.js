// In-app dialog utilities — replacements for window.alert / confirm / prompt
// that match the app's modal styling.

function ensureDialogRoot() {
  let root = document.getElementById('appDialogRoot');
  if (root) return root;
  root = document.createElement('div');
  root.id = 'appDialogRoot';
  document.body.appendChild(root);
  return root;
}

function createOverlay({ title, body, buttons }) {
  const root = ensureDialogRoot();
  const overlay = document.createElement('div');
  overlay.className = 'app-dialog-overlay';
  overlay.innerHTML = `
    <div class="app-dialog-backdrop"></div>
    <div class="app-dialog-box" role="dialog" aria-modal="true">
      <header class="app-dialog-head">
        <h2>${escapeHtml(title)}</h2>
      </header>
      <div class="app-dialog-body"></div>
      <footer class="app-dialog-foot"></footer>
    </div>
  `;
  const bodyEl = overlay.querySelector('.app-dialog-body');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);

  const footEl = overlay.querySelector('.app-dialog-foot');
  buttons.forEach(b => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn btn-sm ${b.variant || 'btn-secondary'}`;
    btn.textContent = b.label;
    btn.addEventListener('click', () => b.onClick(overlay));
    footEl.appendChild(btn);
  });

  root.appendChild(overlay);
  // ESC closes (default cancel)
  overlay.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const cancel = buttons.find(b => b.cancel);
      cancel?.onClick(overlay);
    }
  });
  overlay.querySelector('.app-dialog-backdrop').addEventListener('click', () => {
    const cancel = buttons.find(b => b.cancel);
    cancel?.onClick(overlay);
  });
  return overlay;
}

function close(overlay) {
  overlay?.remove();
}

export function appAlert(message, { title = 'Notice' } = {}) {
  return new Promise(resolve => {
    const overlay = createOverlay({
      title,
      body: `<p class="app-dialog-message">${escapeHtml(message)}</p>`,
      buttons: [
        { label: 'OK', variant: 'btn-primary', cancel: true,
          onClick: o => { close(o); resolve(); } },
      ],
    });
    overlay.querySelector('button')?.focus();
  });
}

export function appConfirm(message, { title = 'Confirm', okLabel = 'OK', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise(resolve => {
    const overlay = createOverlay({
      title,
      body: `<p class="app-dialog-message">${escapeHtml(message)}</p>`,
      buttons: [
        { label: cancelLabel, cancel: true,
          onClick: o => { close(o); resolve(false); } },
        { label: okLabel, variant: danger ? 'btn-danger' : 'btn-primary',
          onClick: o => { close(o); resolve(true); } },
      ],
    });
    overlay.querySelectorAll('button')[1]?.focus();
  });
}

export function appPrompt(message, {
  title = 'Input', defaultValue = '', placeholder = '',
  okLabel = 'OK', cancelLabel = 'Cancel',
  validate, // optional fn(value) -> string | null (error message)
} = {}) {
  return new Promise(resolve => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <p class="app-dialog-message">${escapeHtml(message)}</p>
      <input type="text" class="app-dialog-input" autocomplete="off" />
      <p class="app-dialog-error" hidden></p>
    `;
    const overlay = createOverlay({
      title,
      body: wrapper,
      buttons: [
        { label: cancelLabel, cancel: true,
          onClick: o => { close(o); resolve(null); } },
        { label: okLabel, variant: 'btn-primary',
          onClick: o => {
            const val = input.value.trim();
            if (validate) {
              const err = validate(val);
              if (err) { errEl.textContent = err; errEl.hidden = false; return; }
            }
            close(o); resolve(val);
          } },
      ],
    });
    const input = overlay.querySelector('.app-dialog-input');
    const errEl = overlay.querySelector('.app-dialog-error');
    input.value = defaultValue;
    input.placeholder = placeholder;
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        overlay.querySelectorAll('button')[1]?.click();
      }
    });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

// Custom dialog with multiple choices — returns the chosen value (or null on cancel).
export function appChoice(message, choices, { title = 'Choose', cancelLabel = 'Cancel' } = {}) {
  return new Promise(resolve => {
    const buttons = choices.map(c => ({
      label: c.label,
      variant: c.variant || 'btn-secondary',
      onClick: o => { close(o); resolve(c.value); },
    }));
    buttons.unshift({
      label: cancelLabel, cancel: true,
      onClick: o => { close(o); resolve(null); },
    });
    createOverlay({
      title,
      body: `<p class="app-dialog-message">${escapeHtml(message)}</p>`,
      buttons,
    });
  });
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s == null ? '' : String(s);
  return div.innerHTML;
}
