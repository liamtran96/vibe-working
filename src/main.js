import { appAlert, appConfirm, appPrompt } from './dialogs.js';

// Wait for DOM and Tauri to be ready
document.addEventListener('DOMContentLoaded', async () => {
  await new Promise(resolve => setTimeout(resolve, 100));

  if (!window.__TAURI__) {
    document.body.innerHTML = '<h1 style="color:red;padding:20px;">Error: Tauri API not available. Please restart the app.</h1>';
    return;
  }

  initRepos();
  initRouter();
  initSidebarToggle();
  initGlobalShortcuts();
  initGlobalSettings();

  loadNotesModule()
    .then(m => m.initNotes())
    .catch(err => console.error('Failed to pre-init notes', err));

  console.log('App initialized successfully');
});

function initGlobalSettings() {
  const btn = document.getElementById('sidebarSettingsBtn');
  if (!btn) return;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const mod = await loadNotesModule();
    await mod.initNotes?.();
    mod.openSidebarSettings?.();
  });

  const close = document.getElementById('sidebarSettingsClose');
  close?.addEventListener('click', () => {
    document.getElementById('sidebarSettings')?.classList.add('hidden');
  });
  document.querySelector('#sidebarSettings .settings-modal-backdrop')
    ?.addEventListener('click', () => {
      document.getElementById('sidebarSettings')?.classList.add('hidden');
    });

  initUpdates();
}

function initUpdates() {
  const btn = document.getElementById('checkUpdatesBtn');
  if (!btn) return;

  const statusEl = document.getElementById('updateStatus');
  const progressWrap = document.getElementById('updateProgress');
  const progressBar = document.getElementById('updateProgressBar');
  const progressLabel = document.getElementById('updateProgressLabel');
  const versionEl = document.getElementById('appVersion');

  const setStatus = (text, kind = '') => {
    statusEl.textContent = text || '';
    statusEl.dataset.kind = kind;
  };

  window.__TAURI__.app.getVersion()
    .then(v => { versionEl.textContent = v; })
    .catch(() => { versionEl.textContent = 'unknown'; });

  btn.addEventListener('click', async () => {
    const { updater, process: proc } = window.__TAURI__;
    if (!updater || !proc) {
      setStatus('Updater plugin unavailable. Reinstall the app.', 'error');
      return;
    }

    const errorByPhase = {
      check: e => `Could not check for updates: ${e}`,
      download: e => `Update failed: ${e}`,
      relaunch: e => `Installed, but relaunch failed: ${e}. Please restart manually.`,
    };
    let phase = 'check';

    btn.disabled = true;
    setStatus('Checking for updates…');
    progressWrap.classList.add('hidden');
    progressBar.value = 0;
    progressLabel.textContent = '0%';

    try {
      const update = await updater.check();
      if (!update) {
        setStatus('You are on the latest version.', 'ok');
        return;
      }

      setStatus(`Update available: ${update.version}. Downloading…`);
      progressWrap.classList.remove('hidden');

      let downloaded = 0;
      let contentLength = 0;
      let lastPct = -1;

      phase = 'download';
      await update.downloadAndInstall(event => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data?.contentLength || 0;
            break;
          case 'Progress': {
            downloaded += event.data?.chunkLength || 0;
            if (contentLength <= 0) break;
            const pct = Math.min(100, Math.round((downloaded / contentLength) * 100));
            if (pct === lastPct) break;
            progressBar.value = pct;
            progressLabel.textContent = `${pct}%`;
            lastPct = pct;
            break;
          }
          case 'Finished':
            setStatus('Installing… the app will restart in a moment.');
            break;
        }
      });

      phase = 'relaunch';
      await proc.relaunch();
    } catch (e) {
      setStatus(errorByPhase[phase](e), 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

let notesModulePromise = null;
function loadNotesModule() {
  if (!notesModulePromise) {
    notesModulePromise = import('./notes.js');
  }
  return notesModulePromise;
}

let chatModulePromise = null;
function loadChatModule() {
  if (!chatModulePromise) {
    chatModulePromise = import('./chat.js');
  }
  return chatModulePromise;
}

function initGlobalShortcuts() {
  window.addEventListener('keydown', async e => {
    const meta = e.ctrlKey || e.metaKey;
    if (meta && e.key === 'k') {
      e.preventDefault();
      document.querySelector('.nav-item[data-view="notes"]')?.click();
      const mod = await loadNotesModule();
      await mod.initNotes?.();
      mod.openCommandPalette?.();
    }
  });
}

function initSidebarToggle() {
  const app = document.querySelector('.app');
  const btn = document.getElementById('sidebarToggle');
  const SAVED = localStorage.getItem('sidebarCollapsed') === '1';
  if (SAVED) app.classList.add('sidebar-collapsed');
  btn.addEventListener('click', () => {
    app.classList.toggle('sidebar-collapsed');
    localStorage.setItem('sidebarCollapsed', app.classList.contains('sidebar-collapsed') ? '1' : '0');
  });
}

// ============================================================
// View router
// ============================================================

function initRouter() {
  const navItems = document.querySelectorAll('.nav-item');

  function setView(view) {
    navItems.forEach(b => {
      b.classList.toggle('active', b.dataset.view === view);
    });
    document.getElementById('view-repos').classList.toggle('hidden', view !== 'repos');
    document.getElementById('view-notes').classList.toggle('hidden', view !== 'notes');
    document.getElementById('view-chat').classList.toggle('hidden', view !== 'chat');
    document.querySelector('.view-host').scrollTop = 0;

    if (view === 'notes') {
      loadNotesModule().then(m => m.initNotes()).catch(err => {
        console.error('Failed to load notes module', err);
      });
    } else if (view === 'chat') {
      loadChatModule().then(m => m.initChat()).catch(err => {
        console.error('Failed to load chat module', err);
      });
    }
  }

  navItems.forEach(b => {
    if (!b.dataset.view) return; // skip non-view items like Settings
    b.addEventListener('click', () => setView(b.dataset.view));
  });
}

// ============================================================
// Repos view
// ============================================================

function initRepos() {
  const { invoke } = window.__TAURI__.core;
  const { open } = window.__TAURI__.dialog;

  let repos = [];
  let runningStatus = {};
  let runningLabels = {};
  let selectedLabels = {};
  let vscodeOpen = {};
  let searchQuery = '';
  let statusFilter = 'all'; // 'all' | 'running' | 'stopped'

  async function loadRepos() {
    try {
      repos = await invoke('get_repos');
      await updateRunningStatus();
      renderRepos();
    } catch (e) {
      console.error('loadRepos error:', e);
    }
  }

  async function updateRunningStatus() {
    await Promise.all(repos.map(async repo => {
      runningStatus[repo.id] = await invoke('is_running', { id: repo.id });
      runningLabels[repo.id] = runningStatus[repo.id]
        ? await invoke('running_label', { id: repo.id })
        : null;
    }));
  }

  function parseCommandsInput(input) {
    return input
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(entry => {
        const eq = entry.indexOf('=');
        if (eq > 0) {
          return { label: entry.slice(0, eq).trim(), command: entry.slice(eq + 1).trim() };
        }
        return { label: entry, command: `npm run ${entry}` };
      })
      .filter(c => c.label && c.command);
  }

  function formatCommandsForEdit(commands) {
    return commands.map(c => `${c.label}=${c.command}`).join(', ');
  }

  function renderRepos() {
    const list = document.getElementById('repoList');
    const empty = document.getElementById('emptyState');

    const filtered = repos.filter(r => {
      const matchesSearch = r.name.toLowerCase().includes(searchQuery.toLowerCase());
      const isRunning = runningStatus[r.id];
      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'running' && isRunning) ||
        (statusFilter === 'stopped' && !isRunning);
      return matchesSearch && matchesStatus;
    });

    if (filtered.length === 0) {
      list.classList.add('hidden');
      empty.classList.remove('hidden');
      return;
    }

    list.classList.remove('hidden');
    empty.classList.add('hidden');

    list.innerHTML = filtered.map(repo => {
      const isRunning = runningStatus[repo.id];
      const activeLabel = runningLabels[repo.id];
      const commands = repo.commands || [];

      const currentSelected =
        (isRunning && activeLabel) ||
        selectedLabels[repo.id] ||
        (commands[0] && commands[0].label) ||
        '__custom__';

      const options = commands.map(c =>
        `<option value="${escapeAttr(c.label)}" ${c.label === currentSelected ? 'selected' : ''}>${escapeHtml(c.label)} — ${escapeHtml(c.command)}</option>`
      ).join('') + `<option value="__custom__" ${currentSelected === '__custom__' ? 'selected' : ''}>Custom…</option>`;

      const isCustom = currentSelected === '__custom__';
      const customInput = isCustom && !isRunning
        ? `<input class="cmd-custom" type="text" placeholder="Enter command (e.g. npm run build)" />`
        : '';

      const runBtn = isRunning
        ? `<button class="btn btn-danger btn-sm" data-action="stop">Stop</button>`
        : isCustom
          ? `<button class="btn btn-success btn-sm" data-action="run-custom">Run</button>`
          : `<button class="btn btn-success btn-sm" data-action="run">Run</button>`;

      const runControl = `<div class="run-control">
          <select class="cmd-select" ${isRunning ? 'disabled' : ''} data-action="select-command">${options}</select>
          ${customInput}
          ${runBtn}
        </div>`;

      return `
        <div class="repo-card" data-id="${escapeAttr(repo.id)}">
          <div class="repo-header">
            <div class="repo-info">
              <div class="repo-name">${escapeHtml(repo.name)}</div>
              <div class="repo-path">${escapeHtml(repo.path)}</div>
            </div>
            <div class="repo-status ${isRunning ? 'running' : 'stopped'}">
              <span class="status-dot"></span>
              ${isRunning ? `Running${activeLabel ? ': ' + escapeHtml(activeLabel) : ''}` : 'Stopped'}
            </div>
          </div>
          ${runControl}
          <div class="repo-actions">
            ${vscodeOpen[repo.id]
              ? `<button class="btn btn-danger btn-sm" data-action="close-vscode">Close VS Code</button>`
              : `<button class="btn btn-primary btn-sm" data-action="open-vscode">Open</button>`
            }
            <button class="btn btn-secondary btn-sm" data-action="edit">Edit</button>
            <button class="btn btn-secondary btn-sm" data-action="remove" ${isRunning ? 'disabled' : ''}>Remove</button>
          </div>
        </div>
      `;
    }).join('');
  }

  function escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;');
  }

  async function addRepo() {
    try {
      const selected = await open({ directory: true, multiple: true, title: 'Select Repository Folders' });
      if (selected && selected.length > 0) {
        const cmdInput = await appPrompt(
          'Enter commands (comma-separated). Shortcut "main,admin" expands to "npm run main" and "npm run admin". Or use "label=command, label2=command2":',
          { title: 'Commands', defaultValue: 'main, admin', okLabel: 'Next' }
        );
        if (cmdInput === null) return;
        const commands = parseCommandsInput(cmdInput);
        if (commands.length === 0) {
          await appAlert('Please enter at least one command.', { title: 'Commands' });
          return;
        }
        for (const path of selected) {
          const defaultName = path.split(/[\\/]/).pop();
          const name = await appPrompt(`Enter a title for "${defaultName}":`, {
            title: 'Repository title', defaultValue: defaultName, okLabel: 'Add',
          });
          if (name === null) return;
          await invoke('add_repo', {
            path: path,
            commands,
            name: name || defaultName,
          });
        }
        await loadRepos();
      }
    } catch (e) {
      console.error('addRepo error:', e);
      await appAlert('Error: ' + e, { title: 'Error' });
    }
  }

  async function editCommands(id) {
    const repo = repos.find(r => r.id === id);
    if (!repo) return;
    const current = formatCommandsForEdit(repo.commands || []);
    const input = await appPrompt(
      'Edit commands. Format: "label=command, label2=command2" (or just "label" to use "npm run label"):',
      { title: 'Edit commands', defaultValue: current, okLabel: 'Save' }
    );
    if (input === null) return;
    const commands = parseCommandsInput(input);
    if (commands.length === 0) {
      await appAlert('Please enter at least one command.', { title: 'Commands' });
      return;
    }
    try {
      await invoke('update_repo_commands', { id, commands });
      await loadRepos();
    } catch (e) {
      await appAlert('Error: ' + e, { title: 'Error' });
    }
  }

  async function removeRepo(id) {
    const ok = await appConfirm('Remove this repository?', {
      title: 'Remove repository', okLabel: 'Remove', danger: true,
    });
    if (!ok) return;
    await invoke('remove_repo', { id });
    await loadRepos();
  }

  async function openInVSCode(id) {
    try {
      await invoke('open_vscode', { id });
      vscodeOpen[id] = true;
      renderRepos();
    } catch (e) {
      await appAlert('Error opening VS Code: ' + e, { title: 'Error' });
    }
  }

  async function closeVSCode(id) {
    try {
      await invoke('close_vscode', { id });
      vscodeOpen[id] = false;
      if (runningStatus[id]) {
        await invoke('stop_repo', { id });
        runningStatus[id] = false;
      }
      renderRepos();
    } catch (e) {
      await appAlert('Error closing VS Code: ' + e, { title: 'Error' });
    }
  }

  async function runRepo(id, label, openVscode) {
    try {
      await invoke('run_repo', { id, label, openVscode });
      runningStatus[id] = true;
      runningLabels[id] = label;
      if (openVscode) vscodeOpen[id] = true;
      renderRepos();
    } catch (e) {
      await appAlert('Error: ' + e, { title: 'Error' });
    }
  }

  async function stopRepo(id) {
    try {
      await invoke('stop_repo', { id });
      runningStatus[id] = false;
      runningLabels[id] = null;
      renderRepos();
    } catch (e) {
      await appAlert('Error: ' + e, { title: 'Error' });
    }
  }

  function selectCommand(id, label) {
    selectedLabels[id] = label;
    renderRepos();
  }

  function runFromCard(id) {
    const card = document.querySelector(`.repo-card[data-id="${id}"]`);
    const label = card.querySelector('.cmd-select').value;
    if (label === '__custom__') return runCustomFromCard(id);
    runRepo(id, label, false);
  }

  async function runCustomFromCard(id) {
    const card = document.querySelector(`.repo-card[data-id="${id}"]`);
    const input = card.querySelector('.cmd-custom');
    const command = input && input.value.trim();
    if (!command) {
      await appAlert('Please enter a command.', { title: 'Run command' });
      return;
    }
    try {
      const savedLabel = await invoke('run_repo_custom', { id, command, openVscode: false });
      runningStatus[id] = true;
      runningLabels[id] = savedLabel;
      selectedLabels[id] = savedLabel;
      await loadRepos();
    } catch (e) {
      await appAlert('Error: ' + e, { title: 'Error' });
    }
  }

  const repoListEl = document.getElementById('repoList');
  repoListEl.addEventListener('click', e => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const card = target.closest('.repo-card');
    const id = card?.dataset.id;
    if (!id) return;
    switch (target.dataset.action) {
      case 'stop':         return stopRepo(id);
      case 'run':          return runFromCard(id);
      case 'run-custom':   return runCustomFromCard(id);
      case 'open-vscode':  return openInVSCode(id);
      case 'close-vscode': return closeVSCode(id);
      case 'edit':         return editCommands(id);
      case 'remove':       return removeRepo(id);
    }
  });
  repoListEl.addEventListener('change', e => {
    const target = e.target.closest('[data-action="select-command"]');
    if (!target) return;
    const id = target.closest('.repo-card')?.dataset.id;
    if (id) selectCommand(id, target.value);
  });

  document.getElementById('addRepo').addEventListener('click', addRepo);
  document.getElementById('searchInput').addEventListener('input', e => {
    searchQuery = e.target.value;
    renderRepos();
  });

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      statusFilter = btn.dataset.filter;
      renderRepos();
    });
  });

  loadRepos();

  setInterval(async () => {
    const prev = JSON.stringify(runningStatus);
    await updateRunningStatus();
    if (JSON.stringify(runningStatus) !== prev) renderRepos();
  }, 2000);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
