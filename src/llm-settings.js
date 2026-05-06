// Shared LLM/chat settings: load + save + a mountable form.
// Used by both the Notes sidebar settings panel and (passively) by the Chat
// view's health badge.

const { invoke } = window.__TAURI__.core;

let cached = null;
const subscribers = new Set();

const DEFAULT_CONFIG = {
  base_url: 'http://127.0.0.1:11434',
  model: 'gemma3:4b',
  api_key: null,
  temperature: 0.7,
  max_tokens: 1024,
};

export async function loadLlmConfig() {
  try {
    cached = await invoke('get_llm_config');
  } catch (e) {
    console.error('get_llm_config failed', e);
    cached = { ...DEFAULT_CONFIG };
  }
  return cached;
}

export function getCachedLlmConfig() {
  return cached;
}

export async function saveLlmConfig(config) {
  await invoke('set_llm_config', { config });
  cached = config;
  for (const fn of subscribers) {
    try { fn(cached); } catch (e) { console.error(e); }
  }
}

export function onLlmConfigChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// Render the editing form into `container`. The host owns the save button and
// status element and passes them via `opts`. `onSaved` (optional) fires after
// a successful save with the new config.
export function mountLlmSettingsForm(container, opts = {}) {
  const { saveButton, statusEl, onSaved } = opts;
  const cfg = cached || DEFAULT_CONFIG;
  container.innerHTML = `
    <label class="settings-field">
      <span>Server URL</span>
      <input type="text" data-llm-field="base_url" placeholder="http://127.0.0.1:11434" />
    </label>
    <label class="settings-field">
      <span>Model</span>
      <input type="text" data-llm-field="model" placeholder="gemma3:4b" />
    </label>
    <label class="settings-field">
      <span>API key (optional)</span>
      <input type="password" data-llm-field="api_key" placeholder="leave blank if none" />
    </label>
    <div class="settings-field-row">
      <label class="settings-field">
        <span>Temperature</span>
        <input type="number" data-llm-field="temperature" min="0" max="2" step="0.1" />
      </label>
      <label class="settings-field">
        <span>Max tokens</span>
        <input type="number" data-llm-field="max_tokens" min="1" step="1" />
      </label>
    </div>
    <p class="settings-hint">
      Install Ollama, then run <code>ollama pull gemma3:4b</code>. Ollama auto-runs on
      <code>127.0.0.1:11434</code>. To switch models, change the field above to any tag
      from <code>ollama list</code> (e.g. <code>gemma3:1b</code>, <code>qwen3:4b</code>).
    </p>
  `;

  const f = (name) => container.querySelector(`[data-llm-field="${name}"]`);
  f('base_url').value = cfg.base_url || '';
  f('model').value = cfg.model || '';
  f('api_key').value = cfg.api_key || '';
  f('temperature').value = cfg.temperature ?? 0.7;
  f('max_tokens').value = cfg.max_tokens ?? 1024;

  const setStatus = (text) => { if (statusEl) statusEl.textContent = text; };

  const save = async () => {
    const apiKey = f('api_key').value.trim();
    const next = {
      base_url: f('base_url').value.trim() || DEFAULT_CONFIG.base_url,
      model: f('model').value.trim() || DEFAULT_CONFIG.model,
      api_key: apiKey || null,
      temperature: parseFloat(f('temperature').value) || 0.7,
      max_tokens: parseInt(f('max_tokens').value, 10) || 1024,
    };
    setStatus('Saving…');
    if (saveButton) saveButton.disabled = true;
    try {
      await saveLlmConfig(next);
      setStatus('Saved');
      onSaved?.(next);
      setTimeout(() => { if (statusEl && statusEl.textContent === 'Saved') statusEl.textContent = ''; }, 1800);
    } catch (e) {
      setStatus('Failed: ' + (typeof e === 'string' ? e : e?.message || e));
    } finally {
      if (saveButton) saveButton.disabled = false;
    }
  };

  if (saveButton) saveButton.addEventListener('click', save);
  return { save };
}
