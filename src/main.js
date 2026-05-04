// Wait for DOM and Tauri to be ready
document.addEventListener('DOMContentLoaded', async () => {
  await new Promise(resolve => setTimeout(resolve, 100));

  if (!window.__TAURI__) {
    document.body.innerHTML = '<h1 style="color:red;padding:20px;">Error: Tauri API not available. Please restart the app.</h1>';
    return;
  }

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
    // Format: "label=command, label2=command2" or comma-separated labels -> "npm run <label>"
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
        ? `<button class="btn btn-danger btn-sm" onclick="stopRepo('${repo.id}')">Stop</button>`
        : isCustom
          ? `<button class="btn btn-success btn-sm" onclick="runCustomFromCard('${repo.id}')">Run</button>`
          : `<button class="btn btn-success btn-sm" onclick="runFromCard('${repo.id}')">Run</button>`;

      const runControl = `<div class="run-control">
          <select class="cmd-select" ${isRunning ? 'disabled' : ''} onchange="selectCommand('${repo.id}', this.value)">${options}</select>
          ${customInput}
          ${runBtn}
        </div>`;

      const emptyCommands = '';

      return `
        <div class="repo-card" data-id="${repo.id}">
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
          ${emptyCommands}
          ${runControl}
          <div class="repo-actions">
            ${vscodeOpen[repo.id]
              ? `<button class="btn btn-danger btn-sm" onclick="closeVSCode('${repo.id}')">Close VS Code</button>`
              : `<button class="btn btn-primary btn-sm" onclick="openInVSCode('${repo.id}')">Open</button>`
            }
            <button class="btn btn-secondary btn-sm" onclick="editCommands('${repo.id}')">Edit</button>
            <button class="btn btn-secondary btn-sm" onclick="removeRepo('${repo.id}')"
                    ${isRunning ? 'disabled' : ''}>Remove</button>
          </div>
        </div>
      `;
    }).join('');
  }

  function escapeAttr(s) {
    return String(s).replace(/'/g, "\\'").replace(/"/g, '&quot;');
  }

  async function addRepo() {
    try {
      const selected = await open({ directory: true, multiple: true, title: 'Select Repository Folders' });
      if (selected && selected.length > 0) {
        const cmdInput = prompt(
          'Enter commands (comma-separated). Shortcut "main,admin" expands to "npm run main" and "npm run admin". Or use "label=command, label2=command2":',
          'main, admin'
        );
        if (cmdInput === null) return;
        const commands = parseCommandsInput(cmdInput);
        if (commands.length === 0) {
          alert('Please enter at least one command.');
          return;
        }
        for (const path of selected) {
          const defaultName = path.split(/[\\/]/).pop();
          const name = prompt(`Enter a title for "${defaultName}":`, defaultName);
          if (name === null) return;
          await invoke('add_repo', {
            path: path,
            commands,
            name: name || defaultName
          });
        }
        await loadRepos();
      }
    } catch (e) {
      console.error('addRepo error:', e);
      alert('Error: ' + e);
    }
  }

  async function editCommands(id) {
    const repo = repos.find(r => r.id === id);
    if (!repo) return;
    const current = formatCommandsForEdit(repo.commands || []);
    const input = prompt(
      'Edit commands. Format: "label=command, label2=command2" (or just "label" to use "npm run label"):',
      current
    );
    if (input === null) return;
    const commands = parseCommandsInput(input);
    if (commands.length === 0) {
      alert('Please enter at least one command.');
      return;
    }
    try {
      await invoke('update_repo_commands', { id, commands });
      await loadRepos();
    } catch (e) {
      alert('Error: ' + e);
    }
  }

  async function removeRepo(id) {
    if (confirm('Remove this repository?')) {
      await invoke('remove_repo', { id });
      await loadRepos();
    }
  }

  async function openInVSCode(id) {
    try {
      await invoke('open_vscode', { id });
      vscodeOpen[id] = true;
      renderRepos();
    } catch (e) {
      alert('Error opening VS Code: ' + e);
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
      alert('Error closing VS Code: ' + e);
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
      alert('Error: ' + e);
    }
  }

  async function stopRepo(id) {
    try {
      await invoke('stop_repo', { id });
      runningStatus[id] = false;
      runningLabels[id] = null;
      renderRepos();
    } catch (e) {
      alert('Error: ' + e);
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Make functions available globally
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
      alert('Please enter a command.');
      return;
    }
    try {
      const savedLabel = await invoke('run_repo_custom', { id, command, openVscode: false });
      runningStatus[id] = true;
      runningLabels[id] = savedLabel;
      selectedLabels[id] = savedLabel;
      await loadRepos();
    } catch (e) {
      alert('Error: ' + e);
    }
  }

  window.addRepo = addRepo;
  window.selectCommand = selectCommand;
  window.runFromCard = runFromCard;
  window.runCustomFromCard = runCustomFromCard;
  window.editCommands = editCommands;
  window.removeRepo = removeRepo;
  window.openInVSCode = openInVSCode;
  window.closeVSCode = closeVSCode;
  window.runRepo = runRepo;
  window.stopRepo = stopRepo;

  // Set up event listeners
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

  // Initial load
  await loadRepos();

  setInterval(async () => {
    const prev = JSON.stringify(runningStatus);
    await updateRunningStatus();
    if (JSON.stringify(runningStatus) !== prev) renderRepos();
  }, 2000);

  console.log('App initialized successfully');
});
