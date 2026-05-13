// Modern Notes view: three-column layout, auto-save, live preview,
// command palette, slash menu, keyboard navigation.

import { loadLlmConfig, mountLlmSettingsForm } from './llm-settings.js';
import { appAlert, appConfirm, appPrompt, appChoice } from './dialogs.js';

const { invoke, Channel } = window.__TAURI__.core;

// ============================================================
// State
// ============================================================

let notes = [];
let folders = [];                       // string[] from list_folders
let availableTags = [];                 // string[] from list_all_tags
let editingTags = [];                   // mutable copy of selected note's tags
let selectedId = null;
let dirty = false;
let saveTimer = null;
let lastSavedAt = 0;
let searchQuery = '';
let activeTag = null;
let activeFolder = null;                // null = "All"; "" = root only; "Work/Q2" = subtree
let folderCollapsed = new Map();        // path -> bool
let tagSelection = new Set();           // bulk-select in tag manager
let tagSearchQuery = '';
let folderFilter = '';
let tagFilter = '';
let tagSort = localStorage.getItem('notesTagSort') === 'name' ? 'name' : 'usage';

// Per-block editor state. `source` is the canonical markdown for the open note;
// `blocks` are tokenized regions (heading/paragraph/list/code/...) with offsets
// into `source` so we can splice individual blocks back into the document.
let editorState = {
  source: '',
  blocks: [],
  editingBlockId: null,
  blockSeq: 0,
};

let listCollapsed = localStorage.getItem('notesListCollapsed') === '1';
let inited = false;
let savedRelativeTimer = null;
let llmFormMounted = false;

const FOLDER_COLLAPSE_KEY = 'notesFolderCollapsed';
const ACTIVE_FOLDER_KEY = 'notesActiveFolder';

try {
  const raw = localStorage.getItem(FOLDER_COLLAPSE_KEY);
  if (raw) folderCollapsed = new Map(JSON.parse(raw));
} catch {}
try {
  const raw = localStorage.getItem(ACTIVE_FOLDER_KEY);
  if (raw === 'null' || raw == null) activeFolder = null;
  else activeFolder = raw;
} catch {}

function persistFolderCollapsed() {
  localStorage.setItem(FOLDER_COLLAPSE_KEY, JSON.stringify([...folderCollapsed.entries()]));
}
function persistActiveFolder() {
  localStorage.setItem(ACTIVE_FOLDER_KEY, activeFolder == null ? 'null' : activeFolder);
}

const SAVE_DEBOUNCE_MS = 600;
const SLASH_ITEMS = [
  { key: 'h1',     title: 'Heading 1',     desc: 'Large section heading',   snippet: '# ' },
  { key: 'h2',     title: 'Heading 2',     desc: 'Medium section heading',  snippet: '## ' },
  { key: 'h3',     title: 'Heading 3',     desc: 'Small section heading',   snippet: '### ' },
  { key: 'ul',     title: 'Bullet list',   desc: 'Simple bulleted list',    snippet: '- ' },
  { key: 'ol',     title: 'Numbered list', desc: 'Numbered list',           snippet: '1. ' },
  { key: 'todo',   title: 'To-do',         desc: 'Checkbox task',           snippet: '- [ ] ' },
  { key: 'quote',  title: 'Quote',         desc: 'Blockquote',              snippet: '> ' },
  { key: 'code',   title: 'Code block',    desc: 'Fenced code block',       snippet: '```\n\n```\n', cursorOffset: -5 },
  { key: 'hr',     title: 'Divider',       desc: 'Horizontal rule',         snippet: '---\n' },
  { key: 'ai-summarize', title: 'AI: Summarize note',     desc: 'Insert a summary of the whole note', aiMode: 'summarize' },
  { key: 'ai-rewrite',   title: 'AI: Rewrite paragraph',  desc: 'Rewrite the paragraph above',        aiMode: 'rewrite' },
  { key: 'ai-expand',    title: 'AI: Expand paragraph',   desc: 'Expand the paragraph above',         aiMode: 'expand' },
];

const AI_SYSTEM_PROMPTS = {
  summarize:
    'You summarize notes. Write a concise 3-5 sentence summary in plain prose. ' +
    'Do not preface with "Here is" or quote the input. Output only the summary text.',
  rewrite:
    'You rewrite text to be clearer, tighter, and more readable while preserving meaning and tone. ' +
    'Output only the rewritten text — no preamble, no quotes, no commentary.',
  expand:
    'You expand a brief outline or note into a fuller paragraph that develops the ideas naturally. ' +
    'Output only the expanded prose — no preamble, no headings, no commentary.',
};

let aiRunning = false;

let slashOpen = false;
let slashStartPos = -1;       // position of the `/` in textarea
let slashFiltered = SLASH_ITEMS.slice();
let slashActiveIdx = 0;

let paletteResults = [];
let paletteActiveIdx = 0;

let wikiOpen = false;
let wikiStartPos = -1;          // position of the first `[` of the `[[`
let wikiResults = [];           // [{ title, id }]
let wikiActiveIdx = 0;
let backlinksCollapsed = localStorage.getItem('notesBacklinksCollapsed') === '1';
let backlinksExpanded = false;

// Backlink index: avoids rescanning every note's body on each render/save.
//   linksByTarget: lowercased title -> [{ noteId, index, length }]
//   linksBySource: noteId -> [titleLower] (so we can clean up on edit/delete)
let linksByTarget = new Map();
let linksBySource = new Map();

const BACKLINKS_CAP = 50;
const WIKI_LINK_RE = /\[\[\s*([^\[\]|\n]+?)(?:\s*\|[^\[\]\n]+?)?\s*\]\]/g;

// ============================================================
// Public init
// ============================================================

export async function initNotes() {
  if (inited) {
    // If already initialized (notes view re-entered), still refresh data.
    await loadNotes();
    return;
  }
  inited = true;
  applyPersistedUiState();
  bindEvents();
  await loadNotes();
  await loadNotesFolderPath();
  if (notes.length > 0) {
    selectNote(notes[0].id, { focus: false });
  } else {
    showEditorEmpty();
  }
  startSavedRelativeTicker();
}

async function loadNotesFolderPath() {
  try {
    const folder = await invoke('get_notes_folder');
    const el = document.getElementById('notesFolderPath');
    if (el) {
      el.textContent = formatFolderTail(folder);
      el.title = folder;
    }
    const btn = document.getElementById('openNotesFolderBtn');
    if (btn) btn.title = `Open in Explorer\n${folder}`;
  } catch (e) {
    console.error('get_notes_folder error', e);
  }
}

// Show the last 2 segments of a path, preceded by an ellipsis when shortened.
// Keeps the meaningful tail (".../VibeWorking/notes") visible without the
// jagged-looking RTL truncation trick.
function formatFolderTail(p) {
  if (!p) return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return p;
  return '…' + (p.includes('\\') ? '\\' : '/') + parts.slice(-2).join(p.includes('\\') ? '\\' : '/');
}

export function openCommandPalette() {
  if (!inited) return;
  document.getElementById('cmdPalette').classList.remove('hidden');
  const input = document.getElementById('cmdInput');
  input.value = '';
  refreshPalette('');
  setTimeout(() => input.focus(), 0);
}

// ============================================================
// Loading / persistence
// ============================================================

async function loadNotes() {
  try {
    const [n, f, t] = await Promise.all([
      invoke('get_notes'),
      invoke('list_folders'),
      invoke('list_all_tags'),
    ]);
    notes = n;
    folders = f || [];
    availableTags = t || [];
    rebuildLinkIndex();
    invalidateTitleIndex();
    renderFolderTree();
    renderList();
    renderTagPicker();
    if (isSettingsOpen()) renderTagManager();
  } catch (e) {
    console.error('loadNotes error:', e);
  }
}

function sortNotes() {
  notes.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
}

function applyPersistedUiState() {
  document.getElementById('view-notes').classList.toggle('list-collapsed', listCollapsed);
  document.getElementById('listToggleBtn')?.classList.toggle('active', listCollapsed);
}

function toggleListCollapsed() {
  listCollapsed = !listCollapsed;
  localStorage.setItem('notesListCollapsed', listCollapsed ? '1' : '0');
  document.getElementById('view-notes').classList.toggle('list-collapsed', listCollapsed);
  document.getElementById('listToggleBtn')?.classList.toggle('active', listCollapsed);
}

// ============================================================
// Block editor — Obsidian-style click-to-edit
// ============================================================

// Walk marked's lexer tokens, accumulating start/end offsets via raw.length.
// Concatenated `block.source` is guaranteed to equal `source`.
function tokenizeBlocks(source) {
  const m = window.marked;
  if (!m || typeof m.lexer !== 'function') {
    return [{ id: 'b' + (++editorState.blockSeq), type: 'paragraph', source, start: 0, end: source.length }];
  }
  let tokens;
  try {
    tokens = m.lexer(source || '', { gfm: true, breaks: true });
  } catch (e) {
    console.error('lexer error', e);
    return [{ id: 'b' + (++editorState.blockSeq), type: 'paragraph', source, start: 0, end: source.length }];
  }
  const blocks = [];
  let cursor = 0;
  for (const t of tokens) {
    const raw = t.raw ?? '';
    const start = cursor;
    const end = cursor + raw.length;
    blocks.push({
      id: 'b' + (++editorState.blockSeq),
      type: t.type,
      source: raw,
      start,
      end,
    });
    cursor = end;
  }
  if (cursor < source.length) {
    // Defensive: if marked drops trailing whitespace, append a space block so
    // offsets round-trip and we don't lose user text.
    blocks.push({
      id: 'b' + (++editorState.blockSeq),
      type: 'space',
      source: source.slice(cursor),
      start: cursor,
      end: source.length,
    });
  }
  return blocks;
}

function loadNoteIntoEditor(body) {
  editorState.source = body || '';
  editorState.blocks = tokenizeBlocks(editorState.source);
  editorState.editingBlockId = null;
  if (editorState.blocks.length === 0) {
    // Synthesize an empty paragraph so the user has something to click into.
    editorState.blocks = [{
      id: 'b' + (++editorState.blockSeq),
      type: 'paragraph',
      source: '',
      start: 0,
      end: 0,
    }];
  }
  renderBlocks();
}

function renderBlocks() {
  const container = document.getElementById('noteBody');
  if (!container) return;
  const inner = document.createElement('div');
  inner.className = 'note-blocks-inner';
  for (const b of editorState.blocks) {
    inner.appendChild(
      b.id === editorState.editingBlockId ? buildBlockTextarea(b) : buildRenderedBlock(b)
    );
  }
  container.replaceChildren(inner);
  decorateWikiLinks(inner);
}

function buildRenderedBlock(b) {
  const wrap = document.createElement('div');
  wrap.className = `nb-block nb-${b.type}`;
  wrap.dataset.blockId = b.id;
  if (b.type === 'space') {
    wrap.classList.add('nb-spacer');
    return wrap;
  }
  const m = window.marked;
  let html = '';
  try {
    if (m && typeof m.parse === 'function') {
      html = m.parse(b.source || '', { gfm: true, breaks: true });
    } else {
      html = escapeHtml(b.source);
    }
  } catch (e) {
    console.error('marked parse error', e);
    html = escapeHtml(b.source);
  }
  const clean = window.DOMPurify ? window.DOMPurify.sanitize(html) : html;
  wrap.innerHTML = clean;
  return wrap;
}

function buildBlockTextarea(b) {
  const ta = document.createElement('textarea');
  ta.className = 'nb-block nb-editing';
  ta.dataset.blockId = b.id;
  ta.value = b.source;
  ta.spellcheck = false;
  ta.placeholder = b.type === 'paragraph' && !b.source ? 'Type / for blocks, [[ to link…' : '';
  return ta;
}

function autosizeBlockTextarea(ta) {
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

function getActiveTextarea() {
  if (!editorState.editingBlockId) return null;
  return document.querySelector(
    `textarea[data-block-id="${editorState.editingBlockId}"]`
  );
}

function findBlockById(id) {
  return editorState.blocks.find(b => b.id === id) || null;
}

function enterBlockEdit(blockId, clickX, clickY) {
  if (editorState.editingBlockId === blockId) return;

  const b = findBlockById(blockId);
  if (!b) return;

  // Resolve the caret while the original rendered DOM is still in place —
  // committing a prior edit re-renders and would invalidate the click coords.
  const sourceCaret = (typeof clickX === 'number' && typeof clickY === 'number')
    ? mapClickToSourceOffset(b, clickX, clickY)
    : visibleSourceLength(b.source);

  if (editorState.editingBlockId) commitBlockEdit(editorState.editingBlockId);

  editorState.editingBlockId = blockId;
  renderBlocks();

  const ta = getActiveTextarea();
  if (!ta) return;
  autosizeBlockTextarea(ta);
  ta.focus();
  ta.setSelectionRange(sourceCaret, sourceCaret);
}

// End of visible text — excludes trailing newlines/whitespace so the caret
// doesn't land on a blank line below the block.
function visibleSourceLength(src) {
  return (src || '').replace(/\s+$/, '').length;
}

// Map a click point to a caret offset in the block's markdown source.
// Uses caretRangeFromPoint against the still-rendered block, computes the
// rendered-text offset, then walks source and rendered text together,
// skipping markdown syntax chars that don't appear in the rendered output.
function mapClickToSourceOffset(block, clickX, clickY) {
  if (!block.source) return 0;
  const fallback = visibleSourceLength(block.source);

  const blockEl = document.querySelector(`.nb-block[data-block-id="${block.id}"]`);
  if (!blockEl) return fallback;

  let node = null, offset = 0;
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(clickX, clickY);
    if (r) { node = r.startContainer; offset = r.startOffset; }
  } else if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(clickX, clickY);
    if (p) { node = p.offsetNode; offset = p.offset; }
  }
  if (!node || !blockEl.contains(node) || node.nodeType !== Node.TEXT_NODE) {
    return fallback;
  }

  // Concatenate rendered text from the start of the block up to the caret.
  let renderedBefore = '';
  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
  let cur;
  while ((cur = walker.nextNode())) {
    if (cur === node) {
      renderedBefore += cur.nodeValue.slice(0, offset);
      break;
    }
    renderedBefore += cur.nodeValue;
  }

  // Walk source and renderedBefore in sync; skip source chars that aren't
  // present in the rendered output (markdown syntax like #, *, [, ], (, ) ).
  let si = 0, ri = 0;
  const src = block.source;
  while (ri < renderedBefore.length && si < src.length) {
    if (src[si] === renderedBefore[ri]) { si++; ri++; }
    else { si++; }
  }
  return Math.min(si, fallback);
}

function commitBlockEdit(blockId) {
  const ta = document.querySelector(`textarea[data-block-id="${blockId}"]`);
  if (!ta) {
    editorState.editingBlockId = null;
    return;
  }
  const newSource = ta.value;
  const idx = editorState.blocks.findIndex(b => b.id === blockId);
  if (idx < 0) {
    editorState.editingBlockId = null;
    renderBlocks();
    return;
  }
  const old = editorState.blocks[idx];
  editorState.editingBlockId = null;
  if (newSource === old.source) {
    renderBlocks();
    return;
  }
  const before = editorState.source.slice(0, old.start);
  const after = editorState.source.slice(old.end);
  editorState.source = before + newSource + after;
  editorState.blocks = tokenizeBlocks(editorState.source);
  if (editorState.blocks.length === 0) {
    editorState.blocks = [{
      id: 'b' + (++editorState.blockSeq),
      type: 'paragraph',
      source: '',
      start: 0,
      end: 0,
    }];
  }
  renderBlocks();
  dirty = true;
  scheduleSave();
  updateWordCount();
}

function flushActiveBlockEdit() {
  if (editorState.editingBlockId) commitBlockEdit(editorState.editingBlockId);
}

// ============================================================
// List rendering
// ============================================================

function renderList() {
  renderTagFilters();

  const listEl = document.getElementById('noteList');
  const emptyEl = document.getElementById('noteEmptyState');

  const q = searchQuery.toLowerCase();
  const filtered = notes.filter(n => {
    const matchesSearch = !q ||
      (n.title || '').toLowerCase().includes(q) ||
      (n.body || '').toLowerCase().includes(q);
    const matchesTag = !activeTag || (n.tags || []).includes(activeTag);
    const f = n.folder || '';
    const matchesFolder =
      activeFolder == null ? true :
      activeFolder === ''   ? f === '' :
      f === activeFolder || f.startsWith(activeFolder + '/');
    return matchesSearch && matchesTag && matchesFolder;
  });

  if (filtered.length === 0) {
    listEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    if (notes.length > 0) {
      emptyEl.querySelector('p:first-child').textContent = 'No matches';
      emptyEl.querySelector('.hint').textContent = 'Try a different search or tag.';
    }
    return;
  }

  emptyEl.classList.add('hidden');

  listEl.innerHTML = filtered.map(noteRowHTML).join('');

  listEl.querySelectorAll('.note-row').forEach(row => {
    row.addEventListener('click', () => selectNote(row.dataset.id));
    row.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/x-note-id', row.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
    });
  });

  renderSidebarPinned();
}

let lastPinnedKey = '';

function renderSidebarPinned() {
  const wrap = document.getElementById('sidebarPinned');
  const list = document.getElementById('sidebarPinnedList');
  if (!wrap || !list) return;

  const pinned = notes.filter(n => n.pinned);
  const key = pinned.map(n => `${n.id}\t${n.title || ''}`).join('\n') + '\0' + (selectedId || '');
  if (key === lastPinnedKey) return;
  lastPinnedKey = key;

  if (pinned.length === 0) {
    wrap.classList.add('hidden');
    list.innerHTML = '';
    return;
  }
  wrap.classList.remove('hidden');

  list.innerHTML = pinned.map(n => {
    const title = (n.title || '').trim() || 'Untitled';
    const isActive = n.id === selectedId;
    return `
      <div class="sidebar-pinned-item ${isActive ? 'active' : ''}" data-id="${escapeAttr(n.id)}" title="${escapeAttr(title)}">
        <span class="sidebar-pinned-title">${escapeHtml(title)}</span>
        <button type="button" class="sidebar-pinned-unpin" title="Unpin" aria-label="Unpin">
          <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
        </button>
      </div>`;
  }).join('');

  list.querySelectorAll('.sidebar-pinned-item').forEach(row => {
    row.addEventListener('click', () => {
      document.querySelector('.nav-item[data-view="notes"]')?.click();
      selectNote(row.dataset.id);
    });
  });
  list.querySelectorAll('.sidebar-pinned-unpin').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      unpinNoteById(btn.closest('.sidebar-pinned-item').dataset.id);
    });
  });
}

async function unpinNoteById(id) {
  const note = notes.find(n => n.id === id);
  if (!note?.pinned) return;
  if (id === selectedId) {
    await togglePin();
    return;
  }
  try {
    const updated = await invoke('update_note', {
      id,
      title: note.title,
      body: note.body,
      tags: note.tags || [],
      pinned: false,
      folder: note.folder ?? '',
    });
    const idx = notes.findIndex(n => n.id === id);
    if (idx >= 0) notes[idx] = updated;
    reindexNote(updated);
    sortNotes();
    renderList();
  } catch (e) {
    console.error('unpin error', e);
  }
}

function noteRowHTML(n) {
  const isSelected = n.id === selectedId;
  const snippet = (n.body || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const tagsHtml = (n.tags || []).slice(0, 2).map(t =>
    `<span class="note-row-tag">${escapeHtml(t)}</span>`
  ).join('');
  const folderHint = n.folder
    ? `<span class="note-row-folder" title="${escapeAttr(n.folder)}">${escapeHtml(n.folder)}</span>`
    : '';
  return `
    <div class="note-row ${isSelected ? 'selected' : ''}" data-id="${escapeAttr(n.id)}" draggable="true">
      <div class="note-row-head">
        <div class="note-row-title">${escapeHtml(n.title || 'Untitled')}</div>
        ${n.pinned ? '<span class="note-row-pin" title="Pinned">📌</span>' : ''}
      </div>
      ${snippet ? `<div class="note-row-snippet">${escapeHtml(snippet)}</div>` : ''}
      <div class="note-row-meta">
        <div class="note-row-tags">${tagsHtml}${folderHint}</div>
        <span title="Created ${escapeAttr(formatFullDate(n.created_at))}\nUpdated ${escapeAttr(formatFullDate(n.updated_at))}">${formatRelativeDate(n.updated_at)}</span>
      </div>
    </div>
  `;
}

function renderTagFilters() {
  const wrap = document.getElementById('tagFilterWrap');
  const container = document.getElementById('noteTagFilters');
  const sortBtn = document.getElementById('tagSortToggle');

  const counts = new Map();
  notes.forEach(n => (n.tags || []).forEach(t => counts.set(t, (counts.get(t) || 0) + 1)));

  if (counts.size === 0) {
    wrap?.classList.add('hidden');
    container.innerHTML = '';
    return;
  }
  wrap?.classList.remove('hidden');
  if (sortBtn) sortBtn.title = tagSort === 'usage' ? 'Sorted by usage — click for A→Z' : 'Sorted A→Z — click for usage';

  const q = tagFilter.toLowerCase();
  let entries = [...counts.entries()];
  if (q) entries = entries.filter(([t]) => t.toLowerCase().includes(q));
  entries.sort(tagSort === 'usage'
    ? (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    : (a, b) => a[0].localeCompare(b[0]));

  container.innerHTML =
    `<button class="tag-chip ${activeTag === null ? 'active' : ''}" data-tag="">All</button>` +
    entries.map(([t, c]) =>
      `<button class="tag-chip ${activeTag === t ? 'active' : ''}" data-tag="${escapeAttr(t)}">${escapeHtml(t)}<span class="tag-chip-count">${c}</span></button>`
    ).join('');

  container.querySelectorAll('.tag-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const tag = chip.dataset.tag;
      activeTag = tag === '' ? null : tag;
      renderList();
    });
  });
}

// ============================================================
// Tag picker (in editor head) — chips + popover for adding from registry
// ============================================================

function renderTagPicker() {
  const host = document.getElementById('noteTagsPicker');
  if (!host) return;
  if (!selectedId) {
    host.innerHTML = '';
    return;
  }
  const chips = editingTags.map(t => `
    <span class="tag-pick-chip" data-tag="${escapeAttr(t)}">
      <span>${escapeHtml(t)}</span>
      <button type="button" class="tag-pick-remove" data-action="remove" aria-label="Remove ${escapeAttr(t)}">×</button>
    </span>
  `).join('');
  host.innerHTML = `
    ${chips}
    <button type="button" id="tagPickerAdd" class="tag-pick-add" title="Add tag">+ Tag</button>
  `;
  host.querySelectorAll('.tag-pick-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const chip = btn.closest('.tag-pick-chip');
      const tag = chip?.dataset.tag;
      if (!tag) return;
      editingTags = editingTags.filter(t => t !== tag);
      renderTagPicker();
      onMetaInput();
    });
  });
  host.querySelector('#tagPickerAdd')?.addEventListener('click', e => {
    e.stopPropagation();
    openTagPickerPopover(host.querySelector('#tagPickerAdd'));
  });
}

function openTagPickerPopover(anchor) {
  document.querySelectorAll('.tag-pick-popover').forEach(p => p.remove());
  const popover = document.createElement('div');
  popover.className = 'tag-pick-popover';
  document.body.appendChild(popover);

  let query = '';
  function render() {
    const remaining = availableTags.filter(t => !editingTags.includes(t));
    const filtered = query
      ? remaining.filter(t => t.toLowerCase().includes(query.toLowerCase()))
      : remaining;
    const items = filtered.length
      ? filtered.map(t => `<button type="button" class="tag-pick-item" data-tag="${escapeAttr(t)}">${escapeHtml(t)}</button>`).join('')
      : `<p class="tag-pick-empty">${availableTags.length === 0
          ? 'No tags configured yet. Open Settings → Tags to create one.'
          : (remaining.length === 0
            ? 'All tags are already on this note.'
            : 'No tags match your search.')}</p>`;
    popover.innerHTML = `
      <input type="text" class="tag-pick-search" placeholder="Search tags…" autocomplete="off" />
      <div class="tag-pick-list">${items}</div>
    `;
    const input = popover.querySelector('.tag-pick-search');
    input.value = query;
    input.addEventListener('input', e => { query = e.target.value; render(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { close(); }
      else if (e.key === 'Enter') {
        const first = popover.querySelector('.tag-pick-item');
        first?.click();
      }
    });
    popover.querySelectorAll('.tag-pick-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const tag = btn.dataset.tag;
        if (tag && !editingTags.includes(tag)) editingTags.push(tag);
        close();
        renderTagPicker();
        onMetaInput();
      });
    });
    setTimeout(() => input.focus(), 0);
  }
  render();

  const rect = anchor.getBoundingClientRect();
  popover.style.left = `${Math.max(8, rect.left)}px`;
  popover.style.top = `${rect.bottom + 4}px`;

  function close() {
    popover.remove();
    document.removeEventListener('mousedown', onOutside);
  }
  function onOutside(e) {
    if (!popover.contains(e.target) && e.target !== anchor) close();
  }
  setTimeout(() => document.addEventListener('mousedown', onOutside), 0);
}

// ============================================================
// Folder tree
// ============================================================

function buildFolderTree() {
  // Build a tree from flat folder paths.
  const root = { name: '', path: '', children: new Map(), depth: 0 };
  for (const path of folders) {
    const segs = path.split('/').filter(Boolean);
    let cur = root;
    let acc = '';
    segs.forEach((seg, i) => {
      acc = acc ? `${acc}/${seg}` : seg;
      if (!cur.children.has(seg)) {
        cur.children.set(seg, { name: seg, path: acc, children: new Map(), depth: i + 1 });
      }
      cur = cur.children.get(seg);
    });
  }
  return root;
}

function computeVisibleFolderPaths(tree, q) {
  const visible = new Set();
  function walk(node, ancestors) {
    for (const child of node.children.values()) {
      const trail = [...ancestors, child];
      const matches = child.path.toLowerCase().includes(q);
      if (matches) trail.forEach(n => visible.add(n.path));
      walk(child, trail);
    }
  }
  walk(tree, []);
  return visible;
}

function noteCountInFolder(path) {
  // Counts notes in `path` and all descendants.
  if (path === '') return notes.filter(n => !n.folder).length;
  return notes.filter(n => {
    const f = n.folder || '';
    return f === path || f.startsWith(path + '/');
  }).length;
}

function renderFolderTree() {
  const container = document.getElementById('folderTree');
  if (!container) return;
  const tree = buildFolderTree();

  const filterQ = folderFilter.toLowerCase();
  const visiblePaths = filterQ ? computeVisibleFolderPaths(tree, filterQ) : null;

  const rows = [];
  const ICON_FOLDER = `<svg class="folder-row-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.379a1.5 1.5 0 0 1 1.06.44l1.122 1.12A1.5 1.5 0 0 0 9.12 5H12.5A1.5 1.5 0 0 1 14 6.5v5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z" stroke="currentColor" stroke-width="1.3"/></svg>`;
  const ICON_INBOX = `<svg class="folder-row-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2 9h3l1 2h4l1-2h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 4h10l1 5v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V9l1-5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
  const ICON_ALL = `<svg class="folder-row-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M3 3.5h7l3 3v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.3"/><path d="M5 8h6M5 11h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;
  const CHEVRON = `<svg class="folder-row-chevron" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  // "All notes" — top-level filter, no tree decoration
  rows.push(`
    <div class="folder-row folder-row-special ${activeFolder == null ? 'active' : ''}"
         data-folder="" data-action="select-all">
      <span class="folder-row-guides"></span>
      <span class="folder-row-chev-slot"></span>
      ${ICON_ALL}
      <span class="folder-row-name">All notes</span>
      <span class="folder-row-count">${notes.length}</span>
      <span></span>
    </div>
  `);
  // "(root)" — notes with empty folder
  rows.push(`
    <div class="folder-row folder-row-special ${activeFolder === '' ? 'active' : ''}"
         data-folder="" data-action="select-root">
      <span class="folder-row-guides"></span>
      <span class="folder-row-chev-slot"></span>
      ${ICON_INBOX}
      <span class="folder-row-name">No folder</span>
      <span class="folder-row-count">${noteCountInFolder('')}</span>
      <span></span>
    </div>
  `);

  function walk(node, ancestorIsLast) {
    if (node.children.size === 0) return;
    let sorted = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (visiblePaths) sorted = sorted.filter(c => visiblePaths.has(c.path));
    sorted.forEach((child, idx) => {
      const isLast = idx === sorted.length - 1;
      const collapsed = visiblePaths ? false : !!folderCollapsed.get(child.path);
      const hasKids = child.children.size > 0;
      // Indent guides: one thin vertical line per ancestor whose subtree is
      // still continuing (i.e. that ancestor was NOT a last child).
      const guides = ancestorIsLast
        .map(last => `<span class="folder-guide ${last ? 'is-blank' : ''}"></span>`)
        .join('');
      const chev = hasKids
        ? `<span class="folder-row-chev-slot ${collapsed ? '' : 'expanded'}" data-action="toggle-collapse">${CHEVRON}</span>`
        : `<span class="folder-row-chev-slot"></span>`;
      rows.push(`
        <div class="folder-row ${activeFolder === child.path ? 'active' : ''}"
             data-folder="${escapeAttr(child.path)}"
             draggable="false">
          <span class="folder-row-guides">${guides}</span>
          ${chev}
          ${ICON_FOLDER}
          <span class="folder-row-name" title="${escapeAttr(child.path)}">${escapeHtml(child.name)}</span>
          <span class="folder-row-count">${noteCountInFolder(child.path)}</span>
          <button type="button" class="folder-row-menu" data-action="folder-menu" aria-label="Folder actions">⋯</button>
        </div>
      `);
      if (!collapsed) walk(child, [...ancestorIsLast, isLast]);
    });
  }
  walk(tree, []);

  container.innerHTML = rows.join('');
  wireFolderTreeEvents(container);
}

function wireFolderTreeEvents(container) {
  container.querySelectorAll('.folder-row').forEach(row => {
    const path = row.dataset.folder;
    const selectAll = row.dataset.action === 'select-all';
    const selectRoot = row.dataset.action === 'select-root';

    row.addEventListener('click', e => {
      const actionEl = e.target.closest?.('[data-action]');
      const action = actionEl?.dataset?.action;
      if (action === 'toggle-collapse') {
        e.stopPropagation();
        if (path) {
          folderCollapsed.set(path, !folderCollapsed.get(path));
          persistFolderCollapsed();
          renderFolderTree();
        }
        return;
      }
      if (action === 'folder-menu') {
        e.stopPropagation();
        openFolderContextMenu(path, actionEl);
        return;
      }
      activeFolder = selectAll ? null : (selectRoot ? '' : path);
      persistActiveFolder();
      renderFolderTree();
      renderList();
    });

    // Drop target — only real folders (skip "All notes" pseudo-row)
    if (selectAll) return;
    row.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes('text/x-note-id')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', async e => {
      row.classList.remove('drag-over');
      const noteId = e.dataTransfer.getData('text/x-note-id');
      if (!noteId) return;
      e.preventDefault();
      await moveNoteToFolder(noteId, selectRoot ? '' : path);
    });
  });
}

async function moveNoteToFolder(noteId, targetFolder) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  if ((note.folder || '') === targetFolder) return;
  await flushSaveIfDirty();
  try {
    const updated = await invoke('update_note', {
      id: note.id,
      title: note.title,
      body: note.body,
      tags: note.tags || [],
      pinned: !!note.pinned,
      folder: targetFolder,
    });
    const idx = notes.findIndex(n => n.id === noteId);
    if (idx >= 0) notes[idx] = updated;
    sortNotes();
    renderFolderTree();
    renderList();
  } catch (e) {
    appAlert('Could not move note: ' + e, { title: 'Error' });
  }
}

async function createFolderUi(parent = '') {
  const name = await appPrompt(
    parent ? `New subfolder under "${parent}":` : 'New folder name:',
    { title: parent ? 'New subfolder' : 'New folder', okLabel: 'Create' }
  );
  if (!name) return;
  const path = parent ? `${parent}/${name}` : name;
  try {
    await invoke('create_folder', { path });
    await loadNotes();
  } catch (e) {
    appAlert('Could not create folder: ' + e, { title: 'Error' });
  }
}

async function renameFolderUi(path) {
  const next = await appPrompt(`Rename "${path}" to:`, {
    title: 'Rename folder',
    defaultValue: path.split('/').pop(),
    okLabel: 'Rename',
  });
  if (!next) return;
  const segs = path.split('/');
  segs[segs.length - 1] = next;
  const newPath = segs.join('/');
  try {
    await invoke('rename_folder', { old: path, new: newPath });
    if (activeFolder === path) {
      activeFolder = newPath;
      persistActiveFolder();
    }
    await loadNotes();
  } catch (e) {
    appAlert('Could not rename folder: ' + e, { title: 'Error' });
  }
}

async function deleteFolderUi(path) {
  const count = noteCountInFolder(path);
  let mode;
  if (count === 0) {
    const ok = await appConfirm(`Delete empty folder "${path}"?`, {
      title: 'Delete folder', okLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    mode = 'delete';
  } else {
    const choice = await appChoice(
      `"${path}" contains ${count} note${count === 1 ? '' : 's'}. What should happen to them?`,
      [
        { label: 'Move notes to root', value: 'move-to-root', variant: 'btn-primary' },
        { label: 'Delete notes too', value: 'delete', variant: 'btn-danger' },
      ],
      { title: 'Delete folder' }
    );
    if (!choice) return;
    if (choice === 'delete') {
      const ok = await appConfirm(
        `Permanently delete ${count} note${count === 1 ? '' : 's'}? This cannot be undone.`,
        { title: 'Confirm delete', okLabel: 'Delete', danger: true }
      );
      if (!ok) return;
    }
    mode = choice;
  }
  try {
    await invoke('delete_folder', { path, mode });
    if (activeFolder === path || (activeFolder || '').startsWith(path + '/')) {
      activeFolder = null;
      persistActiveFolder();
    }
    await loadNotes();
  } catch (e) {
    appAlert('Could not delete folder: ' + e, { title: 'Error' });
  }
}

function openFolderContextMenu(path, anchor) {
  // Tiny inline menu — replaces the existing one if any
  document.querySelectorAll('.folder-context-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'folder-context-menu';
  menu.innerHTML = `
    <button type="button" data-action="new-sub">+ New subfolder</button>
    <button type="button" data-action="rename">Rename</button>
    <button type="button" class="danger" data-action="delete">Delete</button>
  `;
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.bottom + 2}px`;
  const close = () => menu.remove();
  menu.addEventListener('click', e => {
    const action = e.target?.dataset?.action;
    if (!action) return;
    close();
    if (action === 'new-sub') createFolderUi(path);
    else if (action === 'rename') renameFolderUi(path);
    else if (action === 'delete') deleteFolderUi(path);
  });
  setTimeout(() => {
    document.addEventListener('mousedown', function once(e) {
      if (!menu.contains(e.target)) {
        close();
        document.removeEventListener('mousedown', once);
      }
    });
  }, 0);
}

// ============================================================
// Sidebar settings panel + tag manager
// ============================================================

function isSettingsOpen() {
  const panel = document.getElementById('sidebarSettings');
  return panel && !panel.classList.contains('hidden');
}

export async function openSidebarSettings() {
  const panel = document.getElementById('sidebarSettings');
  if (!panel) return;
  panel.classList.remove('hidden');
  if (!llmFormMounted) {
    await loadLlmConfig();
    const mount = document.getElementById('llmSettingsMount');
    if (mount) {
      mountLlmSettingsForm(mount, {
        saveButton: document.getElementById('sidebarSettingsSave'),
        statusEl: document.getElementById('sidebarSettingsStatus'),
      });
      llmFormMounted = true;
    }
    wireSettingsTabs();
  }
  renderTagManager();
}

function wireSettingsTabs() {
  const tabs = document.querySelectorAll('.settings-tab');
  const panels = document.querySelectorAll('.settings-panel');
  const foot = document.querySelector('.sidebar-settings-foot');
  const activate = (key) => {
    tabs.forEach(t => {
      const active = t.dataset.settingsTab === key;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    panels.forEach(p => {
      p.classList.toggle('hidden', p.dataset.settingsPanel !== key);
    });
    if (foot) {
      foot.classList.toggle('hidden', foot.dataset.settingsFoot !== key);
    }
  };
  tabs.forEach(t => t.addEventListener('click', () => activate(t.dataset.settingsTab)));
}

function closeSidebarSettings() {
  const panel = document.getElementById('sidebarSettings');
  if (panel) panel.classList.add('hidden');
}

function tagCounts() {
  const map = new Map();
  // Seed with all configured tags so zero-count tags still appear in the manager.
  for (const t of availableTags) map.set(t, 0);
  for (const n of notes) {
    for (const t of n.tags || []) {
      map.set(t, (map.get(t) || 0) + 1);
    }
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

async function createTagUi() {
  const name = await appPrompt('Name for the new tag:', {
    title: 'New tag',
    placeholder: 'e.g. work, todo, idea',
    okLabel: 'Create',
    validate: v => {
      if (!v) return 'Tag name is required.';
      if (availableTags.some(t => t.toLowerCase() === v.toLowerCase())) {
        return 'A tag with that name already exists.';
      }
      return null;
    },
  });
  if (!name) return;
  try {
    await invoke('create_tag', { name });
    await loadNotes();
  } catch (e) {
    appAlert('Could not create tag: ' + e, { title: 'Error' });
  }
}

function renderTagManager() {
  const listEl = document.getElementById('tagManagerList');
  const emptyEl = document.getElementById('tagManagerEmpty');
  const countEl = document.getElementById('tagSectionCount');
  const bulkEl = document.getElementById('tagManagerBulk');
  const bulkCountEl = document.getElementById('tagManagerBulkCount');
  if (!listEl) return;

  const all = tagCounts();
  // Drop selections that no longer exist.
  for (const t of [...tagSelection]) {
    if (!all.some(x => x.name === t)) tagSelection.delete(t);
  }

  countEl.textContent = String(all.length);

  const q = tagSearchQuery.trim().toLowerCase();
  const visible = q ? all.filter(t => t.name.toLowerCase().includes(q)) : all;

  if (all.length === 0) {
    listEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
  } else {
    emptyEl.classList.add('hidden');
    listEl.innerHTML = visible.map(t => `
      <div class="tag-manager-row ${tagSelection.has(t.name) ? 'selected' : ''}" data-tag="${escapeAttr(t.name)}">
        <input type="checkbox" data-act="select" ${tagSelection.has(t.name) ? 'checked' : ''} aria-label="Select ${escapeAttr(t.name)}">
        <span class="tag-manager-name">${escapeHtml(t.name)}</span>
        <span class="tag-manager-count">${t.count}</span>
        <button type="button" data-act="rename" title="Rename">✎</button>
        <button type="button" data-act="merge" title="Merge into…">⇄</button>
        <button type="button" class="danger" data-act="delete" title="Delete">🗑</button>
      </div>
    `).join('') || `<p class="tag-manager-empty-search">No tags match “${escapeHtml(q)}”.</p>`;

    listEl.querySelectorAll('.tag-manager-row').forEach(row => {
      const tag = row.dataset.tag;
      row.addEventListener('click', e => {
        const act = e.target?.dataset?.act;
        if (!act) return;
        if (act === 'select') {
          if (e.target.checked) tagSelection.add(tag);
          else tagSelection.delete(tag);
          renderTagManager();
          return;
        }
        if (act === 'rename') tagRenameUi(tag);
        else if (act === 'merge') tagMergeUi(tag);
        else if (act === 'delete') tagDeleteUi(tag);
      });
    });
  }

  if (tagSelection.size > 0) {
    bulkEl.classList.remove('hidden');
    bulkCountEl.textContent = `${tagSelection.size} selected`;
  } else {
    bulkEl.classList.add('hidden');
  }
}

// ----- Tag prompt overlay (single shared dialog) -----

function showTagPrompt({ title, message, defaultValue = '', placeholder = '', datalist = null, affected = '', okLabel = 'OK', requireValue = true }) {
  return new Promise(resolve => {
    const overlay = document.getElementById('tagPromptOverlay');
    document.getElementById('tagPromptTitle').textContent = title;
    document.getElementById('tagPromptMessage').textContent = message || '';
    const input = document.getElementById('tagPromptInput');
    input.value = defaultValue;
    input.placeholder = placeholder;
    const wrap = document.getElementById('tagPromptInputWrap');
    if (defaultValue === null) {
      wrap.classList.add('hidden');
    } else {
      wrap.classList.remove('hidden');
    }
    const dl = document.getElementById('tagPromptDatalist');
    if (datalist && datalist.length) {
      dl.innerHTML = datalist.map(v => `<option value="${escapeAttr(v)}"></option>`).join('');
      input.setAttribute('list', 'tagPromptDatalist');
    } else {
      dl.innerHTML = '';
      input.removeAttribute('list');
    }
    const affEl = document.getElementById('tagPromptAffected');
    affEl.textContent = affected || '';
    const okBtn = document.getElementById('tagPromptOk');
    okBtn.textContent = okLabel;
    overlay.classList.remove('hidden');
    setTimeout(() => input.focus(), 0);

    function cleanup(result) {
      overlay.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onOk() {
      const val = (input.value || '').trim();
      if (requireValue && !val && defaultValue !== null) return;
      cleanup({ ok: true, value: val });
    }
    function onCancel() { cleanup({ ok: false }); }
    function onKey(e) {
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
      else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    }
    const cancelBtn = document.getElementById('tagPromptCancel');
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}

async function tagRenameUi(tag) {
  const count = await invoke('count_notes_with_tag', { name: tag });
  const result = await showTagPrompt({
    title: 'Rename tag',
    message: `“${tag}” →`,
    defaultValue: tag,
    placeholder: 'new name',
    affected: `Affects ${count} note${count === 1 ? '' : 's'}.`,
    okLabel: 'Rename',
  });
  if (!result.ok || !result.value || result.value === tag) return;
  await flushSaveIfDirty();
  try {
    await invoke('rename_tag', { old: tag, new: result.value });
    tagSelection.delete(tag);
    if (activeTag === tag) activeTag = result.value;
    await loadNotes();
  } catch (e) { appAlert('Rename failed: ' + e, { title: 'Error' }); }
}

async function tagMergeUi(tag) {
  const others = tagCounts().map(t => t.name).filter(n => n !== tag);
  if (others.length === 0) {
    appAlert('There are no other tags to merge into.', { title: 'Merge tags' });
    return;
  }
  const count = await invoke('count_notes_with_tag', { name: tag });
  const result = await showTagPrompt({
    title: 'Merge tags',
    message: `Merge “${tag}” into:`,
    defaultValue: '',
    placeholder: 'target tag name',
    datalist: others,
    affected: `Affects ${count} note${count === 1 ? '' : 's'}. Notes already tagged with the target are deduped automatically.`,
    okLabel: 'Merge',
  });
  if (!result.ok || !result.value || result.value === tag) return;
  await flushSaveIfDirty();
  try {
    await invoke('merge_tags', { from: tag, into: result.value });
    tagSelection.delete(tag);
    if (activeTag === tag) activeTag = result.value;
    await loadNotes();
  } catch (e) { appAlert('Merge failed: ' + e, { title: 'Error' }); }
}

async function tagDeleteUi(tag) {
  const count = await invoke('count_notes_with_tag', { name: tag });
  const result = await showTagPrompt({
    title: 'Delete tag',
    message: `Remove “${tag}” from ${count} note${count === 1 ? '' : 's'}?`,
    defaultValue: null,
    affected: 'Notes themselves stay intact — only the tag assignment is removed.',
    okLabel: 'Delete',
  });
  if (!result.ok) return;
  await flushSaveIfDirty();
  try {
    await invoke('delete_tag', { name: tag });
    tagSelection.delete(tag);
    if (activeTag === tag) activeTag = null;
    await loadNotes();
  } catch (e) { appAlert('Delete failed: ' + e, { title: 'Error' }); }
}

async function bulkTagAction(action) {
  const tags = [...tagSelection];
  if (tags.length === 0) return;
  await flushSaveIfDirty();
  try {
    if (action === 'rename') {
      const result = await showTagPrompt({
        title: `Rename ${tags.length} tags`,
        message: 'Replace selected tags with the same new name (will merge them).',
        defaultValue: '',
        placeholder: 'new name',
        affected: `Selected: ${tags.join(', ')}`,
        okLabel: 'Rename',
      });
      if (!result.ok || !result.value) return;
      for (const t of tags) {
        if (t === result.value) continue;
        await invoke('rename_tag', { old: t, new: result.value });
      }
    } else if (action === 'merge') {
      const others = tagCounts().map(t => t.name).filter(n => !tags.includes(n));
      const result = await showTagPrompt({
        title: `Merge ${tags.length} tags`,
        message: 'Merge all selected tags into:',
        defaultValue: '',
        placeholder: 'target tag name',
        datalist: others,
        affected: `Selected: ${tags.join(', ')}`,
        okLabel: 'Merge',
      });
      if (!result.ok || !result.value) return;
      for (const t of tags) {
        if (t === result.value) continue;
        await invoke('merge_tags', { from: t, into: result.value });
      }
    } else if (action === 'delete') {
      const ok = await appConfirm(
        `Remove ${tags.length} tag${tags.length === 1 ? '' : 's'} from all notes?\n\n${tags.join(', ')}\n\nNotes themselves stay intact.`,
        { title: 'Delete tags', okLabel: 'Delete', danger: true }
      );
      if (!ok) return;
      for (const t of tags) {
        await invoke('delete_tag', { name: t });
      }
    }
    tagSelection.clear();
    await loadNotes();
  } catch (e) {
    appAlert('Bulk action failed: ' + e, { title: 'Error' });
  }
}

// ============================================================
// Selection / editor population
// ============================================================

async function selectNote(id, opts = { focus: true }) {
  if (selectedId === id) return;
  await flushSaveIfDirty();
  const note = notes.find(n => n.id === id);
  if (!note) return;
  selectedId = id;
  backlinksExpanded = false;
  populateEditor(note);
  showEditorPane();
  renderList();
  // Empty notes auto-enter edit mode on the first block so the user can type immediately.
  if (opts.focus !== false && !(note.body || '').trim()) {
    setTimeout(() => {
      const first = editorState.blocks[0];
      if (first) enterBlockEdit(first.id);
    }, 0);
  }
}

function populateEditor(note) {
  document.getElementById('noteTitle').value = note.title || '';
  editingTags = [...(note.tags || [])];
  renderTagPicker();
  loadNoteIntoEditor(note.body || '');
  const pinBtn = document.getElementById('pinBtn');
  pinBtn.setAttribute('aria-pressed', String(!!note.pinned));
  updateWordCount();
  setSaveStatus('saved');
  lastSavedAt = note.updated_at || 0;
  updateSavedTimestamp();
  renderBacklinks();
}

function showEditorPane() {
  document.getElementById('editorEmpty').classList.add('hidden');
  document.getElementById('editorPane').classList.remove('hidden');
}

function showEditorEmpty() {
  selectedId = null;
  document.getElementById('editorEmpty').classList.remove('hidden');
  document.getElementById('editorPane').classList.add('hidden');
  document.getElementById('saveStatus').textContent = '';
  document.getElementById('wordCount').textContent = '';
  document.getElementById('readingTime').textContent = '';
  document.getElementById('noteUpdatedAt').textContent = '';
  document.getElementById('backlinksPane')?.classList.add('hidden');
}

// ============================================================
// CRUD
// ============================================================

async function newNote() {
  await flushSaveIfDirty();
  try {
    const targetFolder = activeFolder == null ? '' : activeFolder;
    const note = await invoke('create_note', { title: 'Untitled', folder: targetFolder });
    notes.unshift(note);
    sortNotes();
    indexNote(note);
    selectedId = note.id;
    backlinksExpanded = false;
    populateEditor(note);
    showEditorPane();
    renderList();
    setTimeout(() => document.getElementById('noteTitle').focus(), 0);
    document.getElementById('noteTitle').select?.();
  } catch (e) {
    appAlert('Error creating note: ' + e, { title: 'Error' });
  }
}

async function deleteCurrent() {
  if (!selectedId) return;
  const ok = await appConfirm('Delete this note? This cannot be undone.', {
    title: 'Delete note', okLabel: 'Delete', danger: true,
  });
  if (!ok) return;
  try {
    await invoke('delete_note', { id: selectedId });
    unindexNote(selectedId);
    notes = notes.filter(n => n.id !== selectedId);
    selectedId = null;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    dirty = false;
    if (notes.length > 0) {
      selectNote(notes[0].id, { focus: false });
    } else {
      showEditorEmpty();
    }
    renderList();
  } catch (e) {
    appAlert('Error deleting note: ' + e, { title: 'Error' });
  }
}

function readEditor() {
  flushActiveBlockEdit();
  return {
    title: document.getElementById('noteTitle').value.trim() || 'Untitled',
    tags: [...editingTags],
    pinned: document.getElementById('pinBtn').getAttribute('aria-pressed') === 'true',
    body: editorState.source,
  };
}

async function flushSave() {
  if (!selectedId || !dirty) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const data = readEditor();
  const current = notes.find(n => n.id === selectedId);
  const folder = current?.folder ?? '';
  setSaveStatus('saving');
  try {
    const updated = await invoke('update_note', { id: selectedId, ...data, folder });
    const idx = notes.findIndex(n => n.id === selectedId);
    if (idx >= 0) notes[idx] = updated;
    reindexNote(updated);
    sortNotes();
    dirty = false;
    setSaveStatus('saved');
    lastSavedAt = updated.updated_at || 0;
    updateSavedTimestamp();
    renderList();
    renderBacklinks();
  } catch (e) {
    console.error('save error', e);
    setSaveStatus('error');
  }
}

async function flushSaveIfDirty() {
  if (dirty) await flushSave();
}

function scheduleSave() {
  setSaveStatus('saving');
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
}

function onBodyInput() {
  if (!selectedId) return;
  dirty = true;
  // Keep editorState.source live by splicing the active block's textarea into
  // it, so save flushes/word counts mid-edit see fresh content.
  syncActiveBlockToSource();
  scheduleSave();
  updateWordCount();
}

function syncActiveBlockToSource() {
  const ta = getActiveTextarea();
  if (!ta) return;
  const block = findBlockById(editorState.editingBlockId);
  if (!block) return;
  const before = editorState.source.slice(0, block.start);
  const after = editorState.source.slice(block.end);
  const newVal = ta.value;
  editorState.source = before + newVal + after;
  // Update block.source / end without retokenizing — that happens on commit.
  const delta = newVal.length - block.source.length;
  block.source = newVal;
  block.end = block.start + newVal.length;
  // Shift subsequent blocks' offsets.
  if (delta) {
    const idx = editorState.blocks.indexOf(block);
    for (let i = idx + 1; i < editorState.blocks.length; i++) {
      editorState.blocks[i].start += delta;
      editorState.blocks[i].end += delta;
    }
  }
}

function onMetaInput() {
  if (!selectedId) return;
  dirty = true;
  scheduleSave();
}

async function togglePin() {
  if (!selectedId) return;
  const btn = document.getElementById('pinBtn');
  const newVal = btn.getAttribute('aria-pressed') !== 'true';
  btn.setAttribute('aria-pressed', String(newVal));
  dirty = true;
  await flushSave();
}

// ============================================================
// Save status / word count
// ============================================================

function setSaveStatus(state) {
  const el = document.getElementById('saveStatus');
  el.classList.remove('status-saving', 'status-saved', 'status-error');
  switch (state) {
    case 'saving': el.textContent = 'Saving…'; el.classList.add('status-saving'); break;
    case 'saved':  el.textContent = 'Saved';   el.classList.add('status-saved'); break;
    case 'error':  el.textContent = 'Save failed'; el.classList.add('status-error'); break;
    default:       el.textContent = '';
  }
}

function updateWordCount() {
  const body = editorState.source;
  const words = countWords(body);
  document.getElementById('wordCount').textContent = `${words} ${words === 1 ? 'word' : 'words'}`;
  const readingEl = document.getElementById('readingTime');
  if (words === 0) {
    readingEl.textContent = '0 min read';
  } else if (words < 100) {
    readingEl.textContent = '<1 min read';
  } else {
    const minutes = Math.round(words / 200);
    readingEl.textContent = `${Math.max(1, minutes)} min read`;
  }
}

function countWords(md) {
  if (!md) return 0;
  // Strip markdown so syntax characters don't count as words.
  let text = md
    .replace(/```[\s\S]*?```/g, ' ')          // fenced code blocks
    .replace(/`[^`]*`/g, ' ')                  // inline code
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')      // images
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')    // links → keep label
    .replace(/^#{1,6}\s+/gm, '')               // heading markers
    .replace(/^>\s?/gm, '')                    // blockquote markers
    .replace(/^[-*+]\s+\[[ xX]\]\s+/gm, '')    // task list markers
    .replace(/^[-*+]\s+/gm, '')                // bullet markers
    .replace(/^\d+\.\s+/gm, '')                // numbered list markers
    .replace(/^---+$/gm, '')                   // hr
    .replace(/[*_~]+/g, '')                    // emphasis markers
    .replace(/\|/g, ' ');                      // table pipes
  text = text.trim();
  if (!text) return 0;
  return text.split(/\s+/).length;
}

function updateSavedTimestamp() {
  const el = document.getElementById('noteUpdatedAt');
  if (!lastSavedAt) {
    el.textContent = '';
    return;
  }
  el.textContent = `Updated ${formatRelativeDate(lastSavedAt)}`;
}

function startSavedRelativeTicker() {
  if (savedRelativeTimer) return;
  savedRelativeTimer = setInterval(updateSavedTimestamp, 30_000);
}

// ============================================================
// Wiki-link decoration
// ============================================================

// Walks the rendered preview, replacing [[Title]] / [[Title|Display]] in text
// nodes (skipping <code> and <pre>) with anchor elements. Resolution is
// case-insensitive; unresolved targets get a "broken" class.
function decorateWikiLinks(root) {
  const titleIndex = getTitleIndex();
  const re = /\[\[\s*([^\[\]|\n]+?)(?:\s*\|\s*([^\[\]\n]+?))?\s*\]\]/g;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentNode;
      while (p && p !== root) {
        const tag = p.nodeName;
        if (tag === 'CODE' || tag === 'PRE' || tag === 'A') return NodeFilter.FILTER_REJECT;
        p = p.parentNode;
      }
      return re.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);

  for (const node of targets) {
    const text = node.nodeValue;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      if (match.index > last) {
        frag.appendChild(document.createTextNode(text.slice(last, match.index)));
      }
      const target = match[1].trim();
      const display = (match[2] || target).trim();
      const resolved = titleIndex.get(target.toLowerCase());
      const a = document.createElement('a');
      a.className = resolved ? 'wikilink' : 'wikilink wikilink-broken';
      a.dataset.target = target;
      if (resolved) a.dataset.id = resolved.id;
      a.href = '#';
      a.textContent = display;
      a.title = resolved ? `Open: ${resolved.title}` : `Create note: ${target}`;
      frag.appendChild(a);
      last = match.index + match[0].length;
    }
    if (last < text.length) {
      frag.appendChild(document.createTextNode(text.slice(last)));
    }
    node.parentNode.replaceChild(frag, node);
  }
}

let titleIndexCache = null;
function getTitleIndex() {
  if (titleIndexCache) return titleIndexCache;
  const idx = new Map();
  for (const n of notes) {
    const t = (n.title || '').trim().toLowerCase();
    if (t && !idx.has(t)) idx.set(t, n);
  }
  titleIndexCache = idx;
  return idx;
}

function invalidateTitleIndex() {
  titleIndexCache = null;
}

async function followWikiLink(target, knownId) {
  if (knownId) {
    selectNote(knownId);
    return;
  }
  const found = getTitleIndex().get(target.toLowerCase());
  if (found) {
    selectNote(found.id);
    return;
  }
  // Create a new note with this title
  await flushSaveIfDirty();
  try {
    const note = await invoke('create_note', { title: target });
    notes.unshift(note);
    sortNotes();
    indexNote(note);
    selectedId = note.id;
    backlinksExpanded = false;
    populateEditor(note);
    showEditorPane();
    renderList();
    setTimeout(() => {
      const first = editorState.blocks[0];
      if (first) enterBlockEdit(first.id);
    }, 0);
  } catch (e) {
    appAlert('Error creating note: ' + e, { title: 'Error' });
  }
}

// ============================================================
// Slash menu
// ============================================================

function maybeOpenSlash() {
  const ta = getActiveTextarea();
  if (!ta) return;
  const pos = ta.selectionStart;
  const text = ta.value;
  // `/` must be at start of line, or after whitespace.
  const prev = pos >= 2 ? text[pos - 2] : '';
  const charBefore = pos >= 1 ? text[pos - 1] : '';
  if (charBefore !== '/') return;
  if (pos > 1 && prev && !/\s/.test(prev)) return;
  slashStartPos = pos - 1;
  slashFiltered = SLASH_ITEMS.slice();
  slashActiveIdx = 0;
  slashOpen = true;
  renderSlashMenu();
  positionSlashMenu();
}

function closeSlash() {
  slashOpen = false;
  slashStartPos = -1;
  document.getElementById('slashMenu').classList.add('hidden');
}

function renderSlashMenu() {
  const menu = document.getElementById('slashMenu');
  if (slashFiltered.length === 0) {
    closeSlash();
    return;
  }
  menu.innerHTML = slashFiltered.map((it, i) => `
    <div class="slash-item ${i === slashActiveIdx ? 'active' : ''}" data-key="${escapeAttr(it.key)}">
      <div class="slash-item-title">${escapeHtml(it.title)}</div>
      <div class="slash-item-desc">${escapeHtml(it.desc)}</div>
    </div>
  `).join('');
  menu.classList.remove('hidden');
  const items = menu.querySelectorAll('.slash-item');
  items.forEach((el, i) => {
    el.addEventListener('mousedown', e => { // mousedown so we keep textarea focus
      e.preventDefault();
      slashActiveIdx = i;
      applySlashSelection();
    });
  });
  items[slashActiveIdx]?.scrollIntoView({ block: 'nearest' });
}

function filterSlash(query) {
  const q = (query || '').toLowerCase();
  slashFiltered = SLASH_ITEMS.filter(it =>
    it.title.toLowerCase().includes(q) || it.key.toLowerCase().includes(q)
  );
  slashActiveIdx = 0;
  renderSlashMenu();
}

function applySlashSelection() {
  if (slashFiltered.length === 0) { closeSlash(); return; }
  const item = slashFiltered[slashActiveIdx];
  const ta = getActiveTextarea();
  if (!ta) { closeSlash(); return; }

  if (item.aiMode) {
    const slashStart = slashStartPos;
    const slashEnd = ta.selectionStart;
    closeSlash();
    runAiCommand(item.aiMode, slashStart, slashEnd);
    return;
  }

  const before = ta.value.slice(0, slashStartPos);
  const after = ta.value.slice(ta.selectionStart);
  ta.value = before + item.snippet + after;
  let caret = before.length + item.snippet.length;
  if (typeof item.cursorOffset === 'number') caret += item.cursorOffset;
  closeSlash();
  ta.focus();
  ta.setSelectionRange(caret, caret);
  autosizeBlockTextarea(ta);
  onBodyInput();
}

function positionSlashMenu() {
  const ta = getActiveTextarea();
  if (!ta) return;
  positionFloatingMenu(document.getElementById('slashMenu'), ta, slashStartPos, 240);
}

// Compute caret pixel coords inside a textarea using a hidden mirror element.
// Returns coords relative to the textarea's content origin (i.e. inside its
// padding/border) so callers just add the textarea's content-area offset.
function getCaretCoords(textarea, position) {
  const mirror = document.getElementById('caretMirror');
  const cs = window.getComputedStyle(textarea);
  const props = [
    'boxSizing','width','overflowX','overflowY',
    'borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth',
    'paddingTop','paddingRight','paddingBottom','paddingLeft',
    'fontStyle','fontVariant','fontWeight','fontStretch','fontSize','fontSizeAdjust','lineHeight','fontFamily',
    'textAlign','textTransform','textIndent','textDecoration','letterSpacing','wordSpacing','tabSize'
  ];
  props.forEach(p => { mirror.style[p] = cs[p]; });
  // Mirror should grow vertically with content so we get a real offsetTop.
  mirror.style.height = 'auto';
  mirror.style.minHeight = cs.height;

  mirror.textContent = textarea.value.slice(0, position);
  const span = document.createElement('span');
  // Use a zero-width but visible character so offsetLeft/Top reflect the caret.
  span.textContent = '​';
  mirror.appendChild(span);
  // span.offsetLeft / Top are measured from the mirror's padding edge — i.e.
  // already include the textarea's padding contribution (since mirror copies
  // the textarea padding). Subtract padding to get a pure content-relative
  // offset that we can re-add explicitly.
  const padLeft = parseFloat(cs.paddingLeft) || 0;
  const padTop  = parseFloat(cs.paddingTop)  || 0;
  const lineHeight = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.4) || 18;
  const left = span.offsetLeft - padLeft;
  const top  = span.offsetTop  - padTop;
  return { left, top, lineHeight };
}

// Anchor a floating menu just below the caret in the notes textarea.
// Flips above the line if it would overflow the viewport bottom; clamps to
// horizontal viewport edges so it never half-renders off-screen.
function positionFloatingMenu(menu, ta, caretPos, menuWidth) {
  if (!menu || !ta) return;
  const taRect = ta.getBoundingClientRect();
  const cs = window.getComputedStyle(ta);
  const borderLeft = parseFloat(cs.borderLeftWidth) || 0;
  const borderTop  = parseFloat(cs.borderTopWidth)  || 0;
  const padLeft    = parseFloat(cs.paddingLeft)     || 0;
  const padTop     = parseFloat(cs.paddingTop)      || 0;

  const coords = getCaretCoords(ta, caretPos);

  const caretX = taRect.left + borderLeft + padLeft + coords.left - ta.scrollLeft;
  const caretLineTop = taRect.top + borderTop + padTop + coords.top - ta.scrollTop;
  const caretLineBottom = caretLineTop + coords.lineHeight;

  // Use the rendered menu size if available; fall back to an estimate so the
  // first paint isn't off.
  const menuRect = menu.getBoundingClientRect();
  const menuH = menuRect.height || 280;
  const menuW = menuRect.width  || menuWidth;

  const margin = 8;
  const gap = 4;

  let top = caretLineBottom + gap;
  if (top + menuH > window.innerHeight - margin) {
    const above = caretLineTop - menuH - gap;
    top = above >= margin ? above : Math.max(margin, window.innerHeight - menuH - margin);
  }

  let left = caretX;
  if (left + menuW > window.innerWidth - margin) {
    left = window.innerWidth - menuW - margin;
  }
  if (left < margin) left = margin;

  // Keep the menu within the textarea's left edge so it doesn't drift far left
  // when the caret is near the start of a wrapped line at the top.
  const taLeftMin = Math.max(margin, taRect.left);
  if (left < taLeftMin) left = taLeftMin;

  menu.style.left = `${left}px`;
  menu.style.top  = `${top}px`;
}

// ============================================================
// AI slash commands (/ai summarize|rewrite|expand)
// ============================================================

// Module-load assertion: every AI slash entry must have a matching system prompt,
// otherwise applySlashSelection silently fails and the typo is hard to spot.
for (const item of SLASH_ITEMS) {
  if (item.aiMode && !AI_SYSTEM_PROMPTS[item.aiMode]) {
    console.error(`SLASH_ITEMS aiMode "${item.aiMode}" has no entry in AI_SYSTEM_PROMPTS`);
  }
}

async function runAiCommand(mode, slashStart, slashEnd) {
  if (aiRunning || !selectedId) return;

  const activeBlockId = editorState.editingBlockId;
  const activeBlock = activeBlockId ? findBlockById(activeBlockId) : null;
  if (!activeBlock) {
    flashAiLoaderError('Click into a block first');
    return;
  }

  // First: write any pending textarea edits back into editorState.source so
  // the AI sees current content. This also rebuilds blocks/offsets.
  syncActiveBlockToSource();

  // Determine input text and the target block we'll stream into.
  let inputText = '';
  let targetBlockId;
  let targetInitialSource = '';

  if (mode === 'summarize') {
    inputText = editorState.source.trim();
    if (!inputText) {
      flashAiLoaderError('Note is empty — nothing to summarize');
      return;
    }
    // Insert a new paragraph block right after the active block.
    const idx = editorState.blocks.findIndex(b => b.id === activeBlockId);
    const insertAt = editorState.blocks[idx].end;
    const sep = editorState.source.slice(insertAt - 1, insertAt) === '\n' ? '\n' : '\n\n';
    editorState.source =
      editorState.source.slice(0, insertAt) + sep + editorState.source.slice(insertAt);
    editorState.blocks = tokenizeBlocks(editorState.source);
    // The new block will appear when streaming starts; pick a fresh id now.
    const placeholderStart = insertAt + sep.length;
    const newBlock = {
      id: 'b' + (++editorState.blockSeq),
      type: 'paragraph',
      source: '',
      start: placeholderStart,
      end: placeholderStart,
    };
    // Find the right insert position in blocks array.
    const insertBlockIdx = editorState.blocks.findIndex(b => b.start >= placeholderStart);
    editorState.blocks.splice(
      insertBlockIdx >= 0 ? insertBlockIdx : editorState.blocks.length,
      0,
      newBlock,
    );
    targetBlockId = newBlock.id;
    targetInitialSource = '';
  } else {
    // rewrite/expand: target = the active block itself; replace its content.
    inputText = activeBlock.source.trim();
    if (!inputText) {
      flashAiLoaderError(`Block is empty — nothing to ${mode}`);
      return;
    }
    targetBlockId = activeBlockId;
    targetInitialSource = '';
    // Empty out the active block's source.
    const before = editorState.source.slice(0, activeBlock.start);
    const after = editorState.source.slice(activeBlock.end);
    const delta = -activeBlock.source.length;
    editorState.source = before + after;
    activeBlock.source = '';
    activeBlock.end = activeBlock.start;
    const aIdx = editorState.blocks.indexOf(activeBlock);
    for (let i = aIdx + 1; i < editorState.blocks.length; i++) {
      editorState.blocks[i].start += delta;
      editorState.blocks[i].end += delta;
    }
  }

  const system = AI_SYSTEM_PROMPTS[mode];
  if (!system) return;

  // Render with the target block as the editing one (if it's the active block)
  // or simply re-render to surface the new placeholder block.
  editorState.editingBlockId = null;
  renderBlocks();
  aiRunning = true;
  dirty = true;
  showAiLoader(mode);

  let totalTokens = 0;
  let pendingDelta = '';
  let rafScheduled = false;

  const flush = () => {
    rafScheduled = false;
    if (!pendingDelta) return;
    const target = findBlockById(targetBlockId);
    if (!target) { pendingDelta = ''; return; }
    // Splice into source, update target, shift trailing blocks.
    const insertPos = target.end;
    editorState.source =
      editorState.source.slice(0, insertPos) + pendingDelta + editorState.source.slice(insertPos);
    target.source += pendingDelta;
    target.end = target.start + target.source.length;
    const tIdx = editorState.blocks.indexOf(target);
    const delta = pendingDelta.length;
    pendingDelta = '';
    for (let i = tIdx + 1; i < editorState.blocks.length; i++) {
      editorState.blocks[i].start += delta;
      editorState.blocks[i].end += delta;
    }
    // Replace just this one block's DOM rather than full re-render.
    const wrap = document.querySelector(`[data-block-id="${targetBlockId}"]`);
    const fresh = buildRenderedBlock(target);
    if (wrap && wrap.parentNode) {
      wrap.parentNode.replaceChild(fresh, wrap);
      decorateWikiLinks(fresh.parentNode || fresh);
      fresh.scrollIntoView({ block: 'nearest' });
    }
  };

  const onEvent = new Channel();
  onEvent.onmessage = (evt) => {
    if (evt.kind === 'chunk') {
      pendingDelta += evt.delta;
      totalTokens += 1;
      updateAiLoaderTokens(totalTokens);
      if (!rafScheduled) {
        rafScheduled = true;
        requestAnimationFrame(flush);
      }
    } else if (evt.kind === 'error') {
      flashAiLoaderError(evt.message || 'AI request failed');
    }
  };

  try {
    await invoke('chat_completion', {
      messages: [{ role: 'user', content: inputText }],
      opts: { system, temperature: 0.4 },
      onEvent,
    });
    flush();
  } catch (e) {
    const msg = typeof e === 'string' ? e : (e?.message || String(e));
    flashAiLoaderError(msg);
  } finally {
    flush();
    hideAiLoader();
    aiRunning = false;
    // Re-tokenize the document — the streamed text may have introduced new
    // block boundaries that should be split out from the target block.
    editorState.blocks = tokenizeBlocks(editorState.source);
    if (editorState.blocks.length === 0) {
      editorState.blocks = [{
        id: 'b' + (++editorState.blockSeq),
        type: 'paragraph',
        source: '',
        start: 0,
        end: 0,
      }];
    }
    renderBlocks();
    updateWordCount();
    scheduleSave();
  }
}

// ============================================================
// Claude-Code-style loader bar shown above the textarea while AI runs.
// JS-driven braille spinner (CSS can't reliably animate `content` cycling).
// ============================================================

const SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
const VERB_BY_MODE = {
  summarize: 'Summarizing',
  rewrite:   'Rewriting',
  expand:    'Expanding',
};
let aiLoaderSpinnerTimer = null;
let aiLoaderTimeTimer = null;
let aiLoaderErrorTimer = null;
let aiLoaderStartedAt = 0;

function showAiLoader(mode) {
  const el = document.getElementById('aiLoader');
  if (!el) return;
  if (aiLoaderErrorTimer) { clearTimeout(aiLoaderErrorTimer); aiLoaderErrorTimer = null; }
  el.classList.remove('hidden', 'is-error');
  document.getElementById('aiLoaderLabel').textContent = VERB_BY_MODE[mode] || 'Generating';
  document.getElementById('aiLoaderTokens').textContent = '';
  aiLoaderStartedAt = Date.now();
  updateAiLoaderTime();

  let frame = 0;
  const spinnerEl = document.getElementById('aiLoaderSpinner');
  spinnerEl.textContent = SPINNER_FRAMES[0];
  if (aiLoaderSpinnerTimer) clearInterval(aiLoaderSpinnerTimer);
  aiLoaderSpinnerTimer = setInterval(() => {
    frame = (frame + 1) % SPINNER_FRAMES.length;
    spinnerEl.textContent = SPINNER_FRAMES[frame];
  }, 80);

  if (aiLoaderTimeTimer) clearInterval(aiLoaderTimeTimer);
  aiLoaderTimeTimer = setInterval(updateAiLoaderTime, 1000);
}

function updateAiLoaderTime() {
  const el = document.getElementById('aiLoaderTime');
  if (!el || !aiLoaderStartedAt) return;
  const secs = Math.floor((Date.now() - aiLoaderStartedAt) / 1000);
  el.textContent = `${secs}s`;
}

function updateAiLoaderTokens(n) {
  const el = document.getElementById('aiLoaderTokens');
  if (!el) return;
  el.textContent = `${n} tok`;
}

function hideAiLoader() {
  if (aiLoaderSpinnerTimer) { clearInterval(aiLoaderSpinnerTimer); aiLoaderSpinnerTimer = null; }
  if (aiLoaderTimeTimer)    { clearInterval(aiLoaderTimeTimer);    aiLoaderTimeTimer = null; }
  if (aiLoaderErrorTimer) return; // let the error flash linger its full duration
  const el = document.getElementById('aiLoader');
  if (el) { el.classList.add('hidden'); el.classList.remove('is-error'); }
}

function flashAiLoaderError(message) {
  const el = document.getElementById('aiLoader');
  if (!el) return;
  if (aiLoaderSpinnerTimer) { clearInterval(aiLoaderSpinnerTimer); aiLoaderSpinnerTimer = null; }
  if (aiLoaderTimeTimer)    { clearInterval(aiLoaderTimeTimer);    aiLoaderTimeTimer = null; }
  el.classList.add('is-error');
  el.classList.remove('hidden');
  document.getElementById('aiLoaderSpinner').textContent = '✕';
  document.getElementById('aiLoaderLabel').textContent = message.slice(0, 120);
  document.getElementById('aiLoaderTokens').textContent = '';
  if (aiLoaderErrorTimer) clearTimeout(aiLoaderErrorTimer);
  aiLoaderErrorTimer = setTimeout(() => {
    aiLoaderErrorTimer = null;
    el.classList.add('hidden');
    el.classList.remove('is-error');
  }, 4000);
}

// ============================================================
// Wiki-link autocomplete
// ============================================================

function maybeOpenWiki() {
  const ta = getActiveTextarea();
  if (!ta) return;
  const pos = ta.selectionStart;
  if (pos < 2) return;
  const text = ta.value;
  if (text[pos - 1] !== '[' || text[pos - 2] !== '[') return;
  if (insideCodeBlock(text, pos)) return;
  wikiStartPos = pos - 2;
  wikiActiveIdx = 0;
  wikiOpen = true;
  refreshWiki('');
  positionWikiMenu();
}

function closeWiki() {
  wikiOpen = false;
  wikiStartPos = -1;
  document.getElementById('wikiMenu').classList.add('hidden');
}

function refreshWiki(query) {
  const q = (query || '').toLowerCase();
  const all = notes
    .filter(n => n.id !== selectedId)
    .map(n => ({ title: n.title || 'Untitled', id: n.id, score: q ? fuzzyScore(n.title || '', q) : 1 }))
    .filter(n => !q || n.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  wikiResults = all;
  // Always offer "Create" when we have a query and no exact match.
  const hasExact = q && all.some(r => r.title.toLowerCase() === q);
  if (q && !hasExact) {
    wikiResults.push({ title: query, id: null, isCreate: true, score: 0 });
  }
  if (wikiActiveIdx >= wikiResults.length) wikiActiveIdx = 0;
  renderWikiMenu();
}

function renderWikiMenu() {
  const menu = document.getElementById('wikiMenu');
  if (wikiResults.length === 0) {
    menu.innerHTML = `<div class="slash-item-empty">No notes match — keep typing to create</div>`;
    menu.classList.remove('hidden');
    return;
  }
  menu.innerHTML = wikiResults.map((it, i) => `
    <div class="slash-item ${i === wikiActiveIdx ? 'active' : ''}" data-idx="${i}">
      <div class="slash-item-title">${escapeHtml(it.title)}</div>
      <div class="slash-item-desc">${it.isCreate ? 'Create new note' : 'Link to existing note'}</div>
    </div>
  `).join('');
  menu.classList.remove('hidden');
  const items = menu.querySelectorAll('.slash-item');
  items.forEach(el => {
    el.addEventListener('mousedown', e => {
      e.preventDefault();
      wikiActiveIdx = parseInt(el.dataset.idx, 10);
      applyWikiSelection();
    });
  });
  items[wikiActiveIdx]?.scrollIntoView({ block: 'nearest' });
}

function applyWikiSelection() {
  if (wikiResults.length === 0) { closeWiki(); return; }
  const item = wikiResults[wikiActiveIdx];
  const ta = getActiveTextarea();
  if (!ta) { closeWiki(); return; }
  const before = ta.value.slice(0, wikiStartPos);
  const after = ta.value.slice(ta.selectionStart);
  const cleanedAfter = after.replace(/^\]\]/, '');
  const insert = `[[${item.title}]]`;
  ta.value = before + insert + cleanedAfter;
  const caret = before.length + insert.length;
  closeWiki();
  ta.focus();
  ta.setSelectionRange(caret, caret);
  autosizeBlockTextarea(ta);
  onBodyInput();
}

function positionWikiMenu() {
  const ta = getActiveTextarea();
  if (!ta) return;
  positionFloatingMenu(document.getElementById('wikiMenu'), ta, wikiStartPos, 280);
}

// Returns true when `pos` falls inside a fenced code block (```...```).
function insideCodeBlock(text, pos) {
  const before = text.slice(0, pos);
  const fences = (before.match(/^```/gm) || []).length;
  return fences % 2 === 1;
}

// ============================================================
// Backlinks
// ============================================================

function renderBacklinks() {
  const pane = document.getElementById('backlinksPane');
  const listEl = document.getElementById('backlinksList');
  const countEl = document.getElementById('backlinksCount');
  if (!pane) return;

  if (!selectedId) {
    pane.classList.add('hidden');
    return;
  }
  const current = notes.find(n => n.id === selectedId);
  const title = (current?.title || '').trim();
  if (!current || !title) {
    pane.classList.add('hidden');
    return;
  }

  const occurrences = linksByTarget.get(title.toLowerCase()) || [];
  const byNote = new Map();
  for (const o of occurrences) {
    if (o.noteId === current.id) continue;
    let arr = byNote.get(o.noteId);
    if (!arr) { arr = []; byNote.set(o.noteId, arr); }
    arr.push(o);
  }

  const hits = [];
  for (const [noteId, occs] of byNote) {
    const n = notes.find(x => x.id === noteId);
    if (!n) continue;
    const body = n.body || '';
    const snippets = occs.slice(0, 3).map(o => extractSnippet(body, o.index, o.length));
    hits.push({ note: n, snippets });
  }

  countEl.textContent = String(hits.length);

  if (hits.length === 0) {
    listEl.innerHTML = `
      <div class="backlinks-empty">
        <div>No notes link to <strong>${escapeHtml(current.title)}</strong> yet.</div>
        <div class="backlinks-empty-hint">To create a backlink, type <code>[[${escapeHtml(current.title)}]]</code> in another note.</div>
      </div>`;
  } else {
    const visible = backlinksExpanded ? hits : hits.slice(0, BACKLINKS_CAP);
    const hidden = hits.length - visible.length;
    let html = visible.map(h => `
      <div class="backlink-row" data-id="${escapeAttr(h.note.id)}">
        <div class="backlink-title">${escapeHtml(h.note.title || 'Untitled')}</div>
        ${h.snippets.map(s => `<div class="backlink-snippet">${highlightMatch(s, current.title)}</div>`).join('')}
      </div>
    `).join('');
    if (hidden > 0) {
      html += `<button type="button" class="backlinks-show-more" id="backlinksShowMore">Show ${hidden} more</button>`;
    }
    listEl.innerHTML = html;
    listEl.querySelectorAll('.backlink-row').forEach(row => {
      row.addEventListener('click', () => selectNote(row.dataset.id));
    });
    document.getElementById('backlinksShowMore')?.addEventListener('click', () => {
      backlinksExpanded = true;
      renderBacklinks();
    });
  }

  pane.classList.remove('hidden');
  pane.classList.toggle('collapsed', backlinksCollapsed);
  document.getElementById('backlinksToggle')?.setAttribute('aria-expanded', String(!backlinksCollapsed));
}

function parseLinks(body) {
  const out = [];
  if (!body) return out;
  WIKI_LINK_RE.lastIndex = 0;
  let m;
  while ((m = WIKI_LINK_RE.exec(body)) !== null) {
    const target = m[1].trim();
    if (!target) continue;
    out.push({ titleLower: target.toLowerCase(), index: m.index, length: m[0].length });
  }
  return out;
}

function rebuildLinkIndex() {
  linksByTarget = new Map();
  linksBySource = new Map();
  for (const n of notes) indexNote(n);
}

function indexNote(note) {
  const links = parseLinks(note.body || '');
  const targets = [];
  for (const l of links) {
    let arr = linksByTarget.get(l.titleLower);
    if (!arr) { arr = []; linksByTarget.set(l.titleLower, arr); }
    arr.push({ noteId: note.id, index: l.index, length: l.length });
    targets.push(l.titleLower);
  }
  linksBySource.set(note.id, targets);
  invalidateTitleIndex();
}

function unindexNote(noteId) {
  const targets = linksBySource.get(noteId);
  if (!targets) return;
  const unique = new Set(targets);
  for (const t of unique) {
    const arr = linksByTarget.get(t);
    if (!arr) continue;
    const filtered = arr.filter(e => e.noteId !== noteId);
    if (filtered.length === 0) linksByTarget.delete(t);
    else linksByTarget.set(t, filtered);
  }
  linksBySource.delete(noteId);
  invalidateTitleIndex();
}

function reindexNote(note) {
  unindexNote(note.id);
  indexNote(note);
}

function extractSnippet(body, idx, len) {
  const start = Math.max(0, idx - 40);
  const end = Math.min(body.length, idx + len + 40);
  let snip = body.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snip = '…' + snip;
  if (end < body.length) snip = snip + '…';
  return snip;
}

function highlightMatch(snippet, title) {
  const re = new RegExp(`\\[\\[\\s*${escapeRegExp(title)}(?:\\s*\\|[^\\]\\n]*)?\\s*\\]\\]`, 'gi');
  return escapeHtml(snippet).replace(re, m => `<mark>${escapeHtml(m)}</mark>`);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toggleBacklinksCollapsed() {
  backlinksCollapsed = !backlinksCollapsed;
  localStorage.setItem('notesBacklinksCollapsed', backlinksCollapsed ? '1' : '0');
  const pane = document.getElementById('backlinksPane');
  pane?.classList.toggle('collapsed', backlinksCollapsed);
  document.getElementById('backlinksToggle')?.setAttribute('aria-expanded', String(!backlinksCollapsed));
}

// ============================================================
// Command palette
// ============================================================

function refreshPalette(query) {
  const q = (query || '').toLowerCase();
  const actions = [
    { kind: 'action', title: 'New note', run: () => { closePalette(); newNote(); } },
    { kind: 'action', title: 'Toggle notes list', run: () => { closePalette(); toggleListCollapsed(); } },
  ];
  if (selectedId) {
    actions.push({ kind: 'action', title: 'Toggle pin on current note', run: () => { closePalette(); togglePin(); } });
    actions.push({ kind: 'action', title: 'Delete current note', run: () => { closePalette(); deleteCurrent(); } });
  }
  actions.push({ kind: 'action', title: 'Switch to Repos', run: () => { closePalette(); document.querySelector('.nav-item[data-view="repos"]')?.click(); } });

  const noteResults = notes.map(n => ({
    kind: 'note',
    title: n.title || 'Untitled',
    score: fuzzyScore(n.title || '', q),
    run: () => { closePalette(); selectNote(n.id); },
  }));

  const actionResults = actions
    .map(a => ({ ...a, score: q ? fuzzyScore(a.title, q) : 1 }))
    .filter(a => !q || a.score > 0);

  const noteFiltered = q
    ? noteResults.filter(n => n.score > 0).sort((a, b) => b.score - a.score)
    : noteResults.slice(0, 8);

  paletteResults = [...noteFiltered, ...actionResults];
  paletteActiveIdx = 0;
  renderPaletteResults();
}

function renderPaletteResults() {
  const container = document.getElementById('cmdResults');
  if (paletteResults.length === 0) {
    container.innerHTML = `<div class="cmd-results-empty">No matches</div>`;
    return;
  }
  container.innerHTML = paletteResults.map((r, i) => `
    <div class="cmd-result ${i === paletteActiveIdx ? 'active' : ''}" data-idx="${i}">
      <span class="cmd-result-kind">${r.kind === 'note' ? 'Note' : 'Action'}</span>
      <span class="cmd-result-title">${escapeHtml(r.title)}</span>
    </div>
  `).join('');
  container.querySelectorAll('.cmd-result').forEach(el => {
    el.addEventListener('mousedown', e => {
      e.preventDefault();
      const idx = parseInt(el.dataset.idx, 10);
      paletteResults[idx]?.run();
    });
  });
}

function closePalette() {
  document.getElementById('cmdPalette').classList.add('hidden');
}

function fuzzyScore(target, query) {
  // Simple subsequence scoring: 1 + bonuses for run length and start match.
  if (!query) return 1;
  const t = target.toLowerCase();
  const q = query.toLowerCase();
  if (t.startsWith(q)) return 100 + q.length;
  if (t.includes(q)) return 50 + q.length;
  let ti = 0, qi = 0, runs = 0, lastWasMatch = false;
  while (ti < t.length && qi < q.length) {
    if (t[ti] === q[qi]) {
      qi++;
      if (lastWasMatch) runs++;
      lastWasMatch = true;
    } else {
      lastWasMatch = false;
    }
    ti++;
  }
  if (qi < q.length) return 0;
  return 10 + runs;
}

// ============================================================
// Keyboard navigation
// ============================================================

function navigateList(dir) {
  // Build a flat list of visible note ids.
  const rows = Array.from(document.querySelectorAll('#noteList .note-row'));
  if (rows.length === 0) return;
  let idx = rows.findIndex(r => r.dataset.id === selectedId);
  if (idx < 0) idx = 0;
  else idx = Math.max(0, Math.min(rows.length - 1, idx + dir));
  const next = rows[idx];
  if (next) selectNote(next.dataset.id, { focus: false });
  next?.scrollIntoView({ block: 'nearest' });
}

// ============================================================
// Event wiring
// ============================================================

function bindEvents() {
  document.getElementById('newNoteBtn').addEventListener('click', newNote);
  document.getElementById('noteSearchInput').addEventListener('input', e => {
    searchQuery = e.target.value;
    renderList();
  });

  document.getElementById('folderFilterInput')?.addEventListener('input', e => {
    folderFilter = e.target.value;
    renderFolderTree();
  });
  document.getElementById('tagFilterInput')?.addEventListener('input', e => {
    tagFilter = e.target.value;
    renderTagFilters();
  });
  document.getElementById('tagSortToggle')?.addEventListener('click', () => {
    tagSort = tagSort === 'usage' ? 'name' : 'usage';
    localStorage.setItem('notesTagSort', tagSort);
    renderTagFilters();
  });

  document.getElementById('noteDeleteBtn').addEventListener('click', deleteCurrent);
  document.getElementById('pinBtn').addEventListener('click', togglePin);
  document.getElementById('listToggleBtn').addEventListener('click', toggleListCollapsed);

  document.getElementById('noteTitle').addEventListener('input', onMetaInput);

  const body = document.getElementById('noteBody');

  // Delegated listeners: only fire when the event target is a block textarea.
  body.addEventListener('input', e => {
    if (!e.target.matches('textarea[data-block-id]')) return;
    onBodyInput();
    autosizeBlockTextarea(e.target);
  });

  body.addEventListener('keydown', e => {
    if (!e.target.matches('textarea[data-block-id]')) return;
    if (wikiOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        wikiActiveIdx = Math.min(wikiResults.length - 1, wikiActiveIdx + 1);
        renderWikiMenu();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        wikiActiveIdx = Math.max(0, wikiActiveIdx - 1);
        renderWikiMenu();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (wikiResults.length > 0) {
          e.preventDefault();
          applyWikiSelection();
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeWiki();
        return;
      }
    }
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        slashActiveIdx = Math.min(slashFiltered.length - 1, slashActiveIdx + 1);
        renderSlashMenu();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        slashActiveIdx = Math.max(0, slashActiveIdx - 1);
        renderSlashMenu();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        applySlashSelection();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSlash();
        return;
      }
    }
  });

  body.addEventListener('keyup', e => {
    if (!e.target.matches('textarea[data-block-id]')) return;
    if (e.key === '[') { maybeOpenWiki(); return; }
    if (e.key === '/') { maybeOpenSlash(); return; }
    if ((slashOpen || wikiOpen) &&
        (e.key === 'ArrowDown' || e.key === 'ArrowUp' ||
         e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab')) {
      return;
    }
    const ta = e.target;
    if (wikiOpen) {
      if (ta.selectionStart < wikiStartPos + 2) { closeWiki(); return; }
      const query = ta.value.slice(wikiStartPos + 2, ta.selectionStart);
      if (query.includes('\n') || query.includes(']')) { closeWiki(); return; }
      refreshWiki(query);
      positionWikiMenu();
    }
    if (slashOpen) {
      if (ta.selectionStart < slashStartPos + 1) { closeSlash(); return; }
      const query = ta.value.slice(slashStartPos + 1, ta.selectionStart);
      if (/\s/.test(query) || query.includes('\n')) { closeSlash(); return; }
      filterSlash(query);
      positionSlashMenu();
    }
  }, true);  // capture so it runs even when menus reposition focus

  // Block textarea blur → commit (with 120ms debounce so slash/wiki menu
  // mousedown picks don't unmount the textarea before the click fires).
  body.addEventListener('focusout', e => {
    if (!e.target.matches('textarea[data-block-id]')) return;
    const blockId = e.target.dataset.blockId;
    setTimeout(() => {
      closeSlash();
      closeWiki();
      // If focus returned to the same block textarea (e.g. menu pick), don't commit.
      const active = document.activeElement;
      if (active && active.matches?.(`textarea[data-block-id="${blockId}"]`)) return;
      if (editorState.editingBlockId === blockId) commitBlockEdit(blockId);
    }, 120);
  });

  // Click on a non-editing block enters edit mode for that block.
  body.addEventListener('click', e => {
    // Wikilinks first — they take precedence and don't enter edit.
    const a = e.target.closest('a');
    if (a?.classList.contains('wikilink')) {
      e.preventDefault();
      followWikiLink(a.dataset.target || '', a.dataset.id || null);
      return;
    }
    if (a) {
      const href = a.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href)) {
        e.preventDefault();
        invoke('open_link_window', { url: href }).catch(err => console.error(err));
      }
      return;
    }
    // If click landed inside (or on) a non-editing block, enter edit for it.
    const blockEl = e.target.closest('.nb-block');
    if (!blockEl) return;
    if (blockEl.matches('textarea')) return; // already editing this block
    const id = blockEl.dataset.blockId;
    if (id) enterBlockEdit(id, e.clientX, e.clientY);
  });

  // Notes list keyboard navigation when list is focused
  const list = document.getElementById('noteList');
  list.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); navigateList(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); navigateList(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const first = editorState.blocks[0];
      if (first) enterBlockEdit(first.id);
    }
  });

  // View-level shortcuts
  document.getElementById('view-notes').addEventListener('keydown', e => {
    const meta = e.ctrlKey || e.metaKey;
    if (meta && e.key === 'n') {
      e.preventDefault();
      newNote();
    } else if (meta && e.key === 'f') {
      e.preventDefault();
      document.getElementById('noteSearchInput').focus();
    } else if (meta && (e.key === '\\' || e.code === 'Backslash')) {
      e.preventDefault();
      toggleListCollapsed();
    } else if (meta && e.key === 's') {
      e.preventDefault();
      flushSave();
    }
  });

  // Command palette events
  const palette = document.getElementById('cmdPalette');
  const cmdInput = document.getElementById('cmdInput');
  palette.querySelector('.cmd-palette-backdrop').addEventListener('click', closePalette);
  cmdInput.addEventListener('input', e => refreshPalette(e.target.value));
  cmdInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      paletteActiveIdx = Math.min(paletteResults.length - 1, paletteActiveIdx + 1);
      renderPaletteResults();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      paletteActiveIdx = Math.max(0, paletteActiveIdx - 1);
      renderPaletteResults();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      paletteResults[paletteActiveIdx]?.run();
    }
  });

  // Backlinks collapse
  document.getElementById('backlinksToggle')?.addEventListener('click', toggleBacklinksCollapsed);

  // Open notes folder
  document.getElementById('openNotesFolderBtn')?.addEventListener('click', async () => {
    try { await invoke('open_notes_folder'); } catch (e) { console.error(e); }
  });

  // New folder button (settings panel is wired globally in main.js)
  document.getElementById('newFolderBtn')?.addEventListener('click', () => createFolderUi(activeFolder || ''));
  // New tag button in settings
  document.getElementById('tagManagerNewBtn')?.addEventListener('click', createTagUi);

  // Tag manager search + bulk actions
  document.getElementById('tagManagerSearch')?.addEventListener('input', e => {
    tagSearchQuery = e.target.value;
    renderTagManager();
  });
  document.getElementById('tagManagerBulk')?.addEventListener('click', e => {
    const act = e.target?.dataset?.bulkAction;
    if (act) bulkTagAction(act);
  });

  // Persist save before window unload
  window.addEventListener('beforeunload', () => {
    if (dirty) flushSave();
  });
}

// ============================================================
// Helpers
// ============================================================

function formatRelativeDate(unixSec) {
  if (!unixSec) return '';
  const d = new Date(unixSec * 1000);
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}

function formatFullDate(unixSec) {
  if (!unixSec) return '—';
  const d = new Date(unixSec * 1000);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/"/g, '&quot;');
}
