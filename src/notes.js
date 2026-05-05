// Modern Notes view: three-column layout, auto-save, live preview,
// command palette, slash menu, keyboard navigation.

const { invoke } = window.__TAURI__.core;

// ============================================================
// State
// ============================================================

let notes = [];
let selectedId = null;
let dirty = false;
let saveTimer = null;
let previewTimer = null;
let lastSavedAt = 0;
let searchQuery = '';
let activeTag = null;
let showPreview = (localStorage.getItem('notesShowPreview') ?? '1') === '1';
let listCollapsed = localStorage.getItem('notesListCollapsed') === '1';
let inited = false;
let savedRelativeTimer = null;

const SAVE_DEBOUNCE_MS = 600;
const PREVIEW_DEBOUNCE_MS = 100;
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
];

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
      el.textContent = folder;
      el.title = folder;
    }
    const btn = document.getElementById('openNotesFolderBtn');
    if (btn) btn.title = `Open in Explorer\n${folder}`;
  } catch (e) {
    console.error('get_notes_folder error', e);
  }
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
    notes = await invoke('get_notes');
    rebuildLinkIndex();
    invalidateTitleIndex();
    renderList();
  } catch (e) {
    console.error('loadNotes error:', e);
  }
}

function sortNotes() {
  notes.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.updated_at || 0) - (a.updated_at || 0);
  });
}

function applyPersistedUiState() {
  document.getElementById('view-notes').classList.toggle('list-collapsed', listCollapsed);
  document.getElementById('listToggleBtn')?.classList.toggle('active', listCollapsed);
  applyPreviewState();
}

function toggleListCollapsed() {
  listCollapsed = !listCollapsed;
  localStorage.setItem('notesListCollapsed', listCollapsed ? '1' : '0');
  document.getElementById('view-notes').classList.toggle('list-collapsed', listCollapsed);
  document.getElementById('listToggleBtn')?.classList.toggle('active', listCollapsed);
}

function applyPreviewState() {
  const split = document.getElementById('editorSplit');
  if (!split) return;
  split.classList.toggle('preview-hidden', !showPreview);
  const btn = document.getElementById('previewToggle');
  if (btn) btn.classList.toggle('active', showPreview);
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
    return matchesSearch && matchesTag;
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

  const pinned = filtered.filter(n => n.pinned);
  const others = filtered.filter(n => !n.pinned);
  let html = '';
  if (pinned.length > 0) {
    html += `<div class="note-list-group-label">Pinned</div>`;
    html += pinned.map(noteRowHTML).join('');
  }
  if (others.length > 0) {
    html += `<div class="note-list-group-label">${pinned.length > 0 ? 'All notes' : 'Notes'}</div>`;
    html += others.map(noteRowHTML).join('');
  }
  listEl.innerHTML = html;

  listEl.querySelectorAll('.note-row').forEach(row => {
    row.addEventListener('click', () => selectNote(row.dataset.id));
  });
}

function noteRowHTML(n) {
  const isSelected = n.id === selectedId;
  const snippet = (n.body || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const tagsHtml = (n.tags || []).slice(0, 2).map(t =>
    `<span class="note-row-tag">${escapeHtml(t)}</span>`
  ).join('');
  return `
    <div class="note-row ${isSelected ? 'selected' : ''}" data-id="${escapeAttr(n.id)}">
      <div class="note-row-head">
        <div class="note-row-title">${escapeHtml(n.title || 'Untitled')}</div>
        ${n.pinned ? '<span class="note-row-pin" title="Pinned">📌</span>' : ''}
      </div>
      ${snippet ? `<div class="note-row-snippet">${escapeHtml(snippet)}</div>` : ''}
      <div class="note-row-meta">
        <div class="note-row-tags">${tagsHtml}</div>
        <span title="Created ${escapeAttr(formatFullDate(n.created_at))}\nUpdated ${escapeAttr(formatFullDate(n.updated_at))}">${formatRelativeDate(n.updated_at)}</span>
      </div>
    </div>
  `;
}

function renderTagFilters() {
  const container = document.getElementById('noteTagFilters');
  const allTags = new Set();
  notes.forEach(n => (n.tags || []).forEach(t => allTags.add(t)));

  if (allTags.size === 0) {
    container.innerHTML = '';
    return;
  }

  const sorted = [...allTags].sort();
  container.innerHTML =
    `<button class="tag-chip ${activeTag === null ? 'active' : ''}" data-tag="">All</button>` +
    sorted.map(t =>
      `<button class="tag-chip ${activeTag === t ? 'active' : ''}" data-tag="${escapeAttr(t)}">${escapeHtml(t)}</button>`
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
  if (opts.focus !== false) {
    setTimeout(() => document.getElementById('noteBody').focus(), 0);
  }
}

function populateEditor(note) {
  document.getElementById('noteTitle').value = note.title || '';
  document.getElementById('noteTags').value = (note.tags || []).join(', ');
  document.getElementById('noteBody').value = note.body || '';
  const pinBtn = document.getElementById('pinBtn');
  pinBtn.setAttribute('aria-pressed', String(!!note.pinned));
  updateWordCount();
  schedulePreviewRender();
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
    const note = await invoke('create_note', { title: 'Untitled' });
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
    alert('Error creating note: ' + e);
  }
}

async function deleteCurrent() {
  if (!selectedId) return;
  if (!confirm('Delete this note? This cannot be undone.')) return;
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
    alert('Error deleting note: ' + e);
  }
}

function readEditor() {
  return {
    title: document.getElementById('noteTitle').value.trim() || 'Untitled',
    tags: document.getElementById('noteTags').value
      .split(',').map(t => t.trim()).filter(Boolean),
    pinned: document.getElementById('pinBtn').getAttribute('aria-pressed') === 'true',
    body: document.getElementById('noteBody').value,
  };
}

async function flushSave() {
  if (!selectedId || !dirty) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const data = readEditor();
  setSaveStatus('saving');
  try {
    const updated = await invoke('update_note', { id: selectedId, ...data });
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
  scheduleSave();
  updateWordCount();
  schedulePreviewRender();
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
  const body = document.getElementById('noteBody').value;
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
// Live preview
// ============================================================

function schedulePreviewRender() {
  if (!showPreview) return;
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, PREVIEW_DEBOUNCE_MS);
}

function renderPreview() {
  const previewEl = document.getElementById('notePreview');
  if (!previewEl) return;
  const body = document.getElementById('noteBody').value;
  const m = window.marked;
  let parser = null;
  if (m) {
    if (typeof m.parse === 'function') parser = m.parse.bind(m);
    else if (typeof m === 'function') parser = m;
  }
  if (!parser) {
    previewEl.textContent = body;
    return;
  }
  try {
    if (typeof m.setOptions === 'function') {
      m.setOptions({ breaks: true, gfm: true });
    }
    const raw = parser(body || '');
    const clean = window.DOMPurify ? window.DOMPurify.sanitize(raw) : raw;
    previewEl.innerHTML = clean;
    decorateWikiLinks(previewEl);
  } catch (e) {
    console.error('marked parse error', e);
    previewEl.textContent = body;
  }
}

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
    setTimeout(() => document.getElementById('noteBody').focus(), 0);
  } catch (e) {
    alert('Error creating note: ' + e);
  }
}

function togglePreview() {
  showPreview = !showPreview;
  localStorage.setItem('notesShowPreview', showPreview ? '1' : '0');
  applyPreviewState();
  if (showPreview) renderPreview();
}

// ============================================================
// Slash menu
// ============================================================

function maybeOpenSlash() {
  const ta = document.getElementById('noteBody');
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
  positionSlashMenu();
  renderSlashMenu();
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
  const ta = document.getElementById('noteBody');
  const before = ta.value.slice(0, slashStartPos);
  const after = ta.value.slice(ta.selectionStart);
  ta.value = before + item.snippet + after;
  let caret = before.length + item.snippet.length;
  if (typeof item.cursorOffset === 'number') caret += item.cursorOffset;
  closeSlash();
  ta.focus();
  ta.setSelectionRange(caret, caret);
  onBodyInput();
}

function positionSlashMenu() {
  const ta = document.getElementById('noteBody');
  const coords = getCaretCoords(ta, slashStartPos);
  const menu = document.getElementById('slashMenu');
  const taRect = ta.getBoundingClientRect();
  // Position below the caret with a small offset.
  let left = taRect.left + coords.left - ta.scrollLeft;
  let top = taRect.top + coords.top - ta.scrollTop + 24;
  // Clamp to viewport
  const menuWidth = 240;
  if (left + menuWidth > window.innerWidth - 12) {
    left = window.innerWidth - menuWidth - 12;
  }
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top  = `${top}px`;
}

// Compute caret pixel coords inside a textarea using a hidden mirror element.
function getCaretCoords(textarea, position) {
  const mirror = document.getElementById('caretMirror');
  const cs = window.getComputedStyle(textarea);
  const props = [
    'boxSizing','width','height','overflowX','overflowY',
    'borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth',
    'paddingTop','paddingRight','paddingBottom','paddingLeft',
    'fontStyle','fontVariant','fontWeight','fontStretch','fontSize','fontSizeAdjust','lineHeight','fontFamily',
    'textAlign','textTransform','textIndent','textDecoration','letterSpacing','wordSpacing','tabSize'
  ];
  props.forEach(p => { mirror.style[p] = cs[p]; });
  mirror.textContent = textarea.value.slice(0, position);
  const span = document.createElement('span');
  span.textContent = textarea.value.slice(position) || '.';
  mirror.appendChild(span);
  const left = span.offsetLeft;
  const top = span.offsetTop;
  return { left, top };
}

// ============================================================
// Wiki-link autocomplete
// ============================================================

function maybeOpenWiki() {
  const ta = document.getElementById('noteBody');
  const pos = ta.selectionStart;
  if (pos < 2) return;
  const text = ta.value;
  if (text[pos - 1] !== '[' || text[pos - 2] !== '[') return;
  // Don't trigger inside a fenced code block.
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
  const ta = document.getElementById('noteBody');
  const before = ta.value.slice(0, wikiStartPos);
  const after = ta.value.slice(ta.selectionStart);
  // Strip a trailing `]]` if the user typed it before picking.
  const cleanedAfter = after.replace(/^\]\]/, '');
  const insert = `[[${item.title}]]`;
  ta.value = before + insert + cleanedAfter;
  const caret = before.length + insert.length;
  closeWiki();
  ta.focus();
  ta.setSelectionRange(caret, caret);
  onBodyInput();
}

function positionWikiMenu() {
  const ta = document.getElementById('noteBody');
  const coords = getCaretCoords(ta, wikiStartPos);
  const menu = document.getElementById('wikiMenu');
  const taRect = ta.getBoundingClientRect();
  let left = taRect.left + coords.left - ta.scrollLeft;
  let top = taRect.top + coords.top - ta.scrollTop + 24;
  const menuWidth = 280;
  if (left + menuWidth > window.innerWidth - 12) {
    left = window.innerWidth - menuWidth - 12;
  }
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top  = `${top}px`;
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
    { kind: 'action', title: 'Toggle preview', run: () => { closePalette(); togglePreview(); } },
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

  document.getElementById('noteDeleteBtn').addEventListener('click', deleteCurrent);
  document.getElementById('pinBtn').addEventListener('click', togglePin);
  document.getElementById('previewToggle').addEventListener('click', togglePreview);
  document.getElementById('listToggleBtn').addEventListener('click', toggleListCollapsed);

  ['noteTitle', 'noteTags'].forEach(id => {
    document.getElementById(id).addEventListener('input', onMetaInput);
  });

  const body = document.getElementById('noteBody');
  body.addEventListener('input', onBodyInput);

  body.addEventListener('keydown', e => {
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
    if (e.key === '[') {
      maybeOpenWiki();
      return;
    }
    if (e.key === '/') {
      maybeOpenSlash();
      return;
    }
    // Menu navigation keys are handled in keydown; don't let keyup
    // re-run the query filter, which would reset the active index.
    if ((slashOpen || wikiOpen) &&
        (e.key === 'ArrowDown' || e.key === 'ArrowUp' ||
         e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab')) {
      return;
    }
    if (wikiOpen) {
      const ta = body;
      if (ta.selectionStart < wikiStartPos + 2) {
        closeWiki();
        return;
      }
      const query = ta.value.slice(wikiStartPos + 2, ta.selectionStart);
      if (query.includes('\n') || query.includes(']')) {
        closeWiki();
        return;
      }
      refreshWiki(query);
      positionWikiMenu();
    }
    if (slashOpen) {
      const ta = body;
      if (ta.selectionStart < slashStartPos + 1) {
        closeSlash();
        return;
      }
      const query = ta.value.slice(slashStartPos + 1, ta.selectionStart);
      if (/\s/.test(query) || query.includes('\n')) {
        closeSlash();
        return;
      }
      filterSlash(query);
      positionSlashMenu();
    }
  });

  body.addEventListener('blur', () => {
    // Slight delay so click on slash menu can register
    setTimeout(() => { closeSlash(); closeWiki(); }, 120);
  });

  // Notes list keyboard navigation when list is focused
  const list = document.getElementById('noteList');
  list.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); navigateList(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); navigateList(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('noteBody').focus();
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
    } else if (meta && e.key === '/') {
      e.preventDefault();
      togglePreview();
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

  // Wiki-link clicks in preview
  document.getElementById('notePreview').addEventListener('click', e => {
    const a = e.target.closest('a.wikilink');
    if (!a) return;
    e.preventDefault();
    followWikiLink(a.dataset.target || '', a.dataset.id || null);
  });

  // Backlinks collapse
  document.getElementById('backlinksToggle')?.addEventListener('click', toggleBacklinksCollapsed);

  // Open notes folder
  document.getElementById('openNotesFolderBtn')?.addEventListener('click', async () => {
    try { await invoke('open_notes_folder'); } catch (e) { console.error(e); }
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
