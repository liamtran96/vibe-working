// Chat view: local llama.cpp chat panel.
// Conversations persisted as JSON via Tauri commands.
// Streams assistant tokens via a Tauri Channel passed into chat_completion.
// LLM settings live in the Notes sidebar settings panel — see llm-settings.js.

import { loadLlmConfig, getCachedLlmConfig, onLlmConfigChange } from './llm-settings.js';
import { appAlert, appConfirm } from './dialogs.js';

const { invoke, Channel } = window.__TAURI__.core;

let chats = [];           // ChatMeta[] for sidebar — no messages, just counts/timestamps
let activeChat = null;    // full Chat (with messages) for the open conversation
let inited = false;
let streaming = null;     // { chatId, assistantIndex, bodyNode } | null
let healthTimer = null;
let saveTimer = null;
let lastHealthOk = null;  // last rendered health state, for change-detection

const SAVE_DEBOUNCE_MS = 400;

export async function initChat() {
  if (inited) {
    await loadChats();
    return;
  }
  inited = true;
  bindEvents();
  await Promise.all([loadLlmConfig(), loadChats()]);
  if (chats.length > 0) {
    await selectChat(chats[0].id);
  } else {
    showEmpty();
  }
  pollHealth();
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(pollHealth, 15000);
  // Re-poll health right after settings change so the badge updates instantly.
  onLlmConfigChange(() => { lastHealthOk = null; pollHealth(); });
}

// ============================================================
// Data
// ============================================================

async function loadChats() {
  try {
    chats = await invoke('list_chats');
  } catch (e) {
    console.error('list_chats failed', e);
    chats = [];
  }
  renderChatList();
}

async function saveActiveChat() {
  if (!activeChat) return;
  try {
    const updated = await invoke('save_chat', { chat: activeChat });
    Object.assign(activeChat, updated);
    syncMetaFromActive();
    renderChatList();
  } catch (e) {
    console.error('save_chat failed', e);
  }
}

// Mirror the active chat's title/count/updated_at into the sidebar meta entry
// so the list reflects in-flight edits without a full reload.
function syncMetaFromActive() {
  if (!activeChat) return;
  const meta = chats.find(c => c.id === activeChat.id);
  const projection = {
    id: activeChat.id,
    title: activeChat.title,
    message_count: activeChat.messages.length,
    created_at: activeChat.created_at,
    updated_at: activeChat.updated_at,
  };
  if (meta) Object.assign(meta, projection);
  else chats.unshift(projection);
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveActiveChat, SAVE_DEBOUNCE_MS);
}

// ============================================================
// Rendering
// ============================================================

function renderChatList() {
  const listEl = document.getElementById('chatList');
  const emptyEl = document.getElementById('chatListEmpty');
  if (chats.length === 0) {
    listEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');
  const activeId = activeChat?.id;
  listEl.innerHTML = chats.map(c => {
    const count = c.message_count ?? 0;
    return `
    <button class="chat-list-item ${c.id === activeId ? 'active' : ''}" data-id="${escapeAttr(c.id)}">
      <div class="chat-list-title">${escapeHtml(c.title || 'Untitled chat')}</div>
      <div class="chat-list-meta">${count} message${count === 1 ? '' : 's'} · ${formatTime(c.updated_at)}</div>
    </button>`;
  }).join('');
}

function renderMessages() {
  const container = document.getElementById('chatMessages');
  if (!activeChat) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = activeChat.messages.map((m, i) => `
    <div class="chat-msg chat-msg-${escapeAttr(m.role)}" data-idx="${i}">
      <div class="chat-msg-role">${escapeHtml(m.role)}</div>
      <div class="chat-msg-body">${escapeHtml(m.content) || '<span class="chat-msg-placeholder">…</span>'}</div>
    </div>
  `).join('');
  container.scrollTop = container.scrollHeight;
}

function appendDeltaToActiveAssistant(delta) {
  if (!streaming || !activeChat || streaming.chatId !== activeChat.id) return;
  const msg = activeChat.messages[streaming.assistantIndex];
  if (!msg) return;
  msg.content += delta;
  if (streaming.bodyNode) {
    streaming.bodyNode.textContent = msg.content;
    const container = document.getElementById('chatMessages');
    container.scrollTop = container.scrollHeight;
  }
}

function showEmpty() {
  document.getElementById('chatEmpty').classList.remove('hidden');
  document.getElementById('chatPane').classList.add('hidden');
}

function showActive() {
  document.getElementById('chatEmpty').classList.add('hidden');
  document.getElementById('chatPane').classList.remove('hidden');
}

async function selectChat(id) {
  if (!chats.some(c => c.id === id)) {
    activeChat = null;
    showEmpty();
    return;
  }
  try {
    activeChat = await invoke('get_chat', { id });
  } catch (e) {
    console.error('get_chat failed', e);
    activeChat = null;
    showEmpty();
    return;
  }
  showActive();
  document.getElementById('chatTitle').value = activeChat.title || '';
  renderChatList();
  renderMessages();
  document.getElementById('chatInput').focus();
}

// ============================================================
// Actions
// ============================================================

async function newChat() {
  try {
    const chat = await invoke('create_chat', { title: 'New chat' });
    chats.unshift({
      id: chat.id,
      title: chat.title,
      message_count: 0,
      created_at: chat.created_at,
      updated_at: chat.updated_at,
    });
    activeChat = chat;
    showActive();
    document.getElementById('chatTitle').value = chat.title || '';
    renderChatList();
    renderMessages();
    document.getElementById('chatInput').focus();
  } catch (e) {
    appAlert('Could not create chat: ' + e, { title: 'Error' });
  }
}

async function deleteActiveChat() {
  if (!activeChat) return;
  const ok = await appConfirm('Delete this chat?', {
    title: 'Delete chat', okLabel: 'Delete', danger: true,
  });
  if (!ok) return;
  const id = activeChat.id;
  try {
    await invoke('delete_chat', { id });
    chats = chats.filter(c => c.id !== id);
    activeChat = null;
    if (chats.length > 0) await selectChat(chats[0].id);
    else { renderChatList(); showEmpty(); }
  } catch (e) {
    appAlert('Could not delete chat: ' + e, { title: 'Error' });
  }
}

async function sendMessage() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text || streaming) return;

  if (!activeChat) {
    await newChat();
    if (!activeChat) return;
  }
  const chat = activeChat;

  chat.messages.push({ role: 'user', content: text });
  if (chat.messages.length === 1 || (chat.title || 'New chat') === 'New chat') {
    chat.title = text.slice(0, 60);
    document.getElementById('chatTitle').value = chat.title;
  }
  chat.messages.push({ role: 'assistant', content: '' });
  const assistantIndex = chat.messages.length - 1;

  input.value = '';
  resizeInput(input);
  renderMessages();
  await saveActiveChat();

  // Cache the assistant body node now so streaming doesn't re-querySelector per token.
  const container = document.getElementById('chatMessages');
  const bodyNode = container.querySelector(`.chat-msg[data-idx="${assistantIndex}"] .chat-msg-body`);
  streaming = { chatId: chat.id, assistantIndex, bodyNode };
  setSendButtonState(true);

  // One channel per request — backend writes typed events into it; the
  // channel is dropped (and the listener cleaned up) when this scope ends.
  const onEvent = new Channel();
  onEvent.onmessage = (evt) => {
    if (!streaming || streaming.chatId !== chat.id) return;
    switch (evt.kind) {
      case 'chunk':
        appendDeltaToActiveAssistant(evt.delta);
        scheduleSave();
        break;
      case 'done':
        scheduleSave();
        break;
      case 'error': {
        if (activeChat?.id === streaming.chatId && activeChat.messages[streaming.assistantIndex]) {
          const cur = activeChat.messages[streaming.assistantIndex].content || '';
          activeChat.messages[streaming.assistantIndex].content =
            cur + (cur ? '\n\n' : '') + `⚠️ ${evt.message}`;
          renderMessages();
        }
        break;
      }
    }
  };

  const messages = chat.messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));

  try {
    await invoke('chat_completion', { messages, opts: null, onEvent });
  } catch (e) {
    const errMsg = typeof e === 'string' ? e : (e?.message || String(e));
    if (chat.messages[assistantIndex] && !chat.messages[assistantIndex].content) {
      chat.messages[assistantIndex].content = `⚠️ ${errMsg}`;
      renderMessages();
    }
  } finally {
    streaming = null;
    setSendButtonState(false);
    await saveActiveChat();
  }
}

function setSendButtonState(busy) {
  const btn = document.getElementById('chatSendBtn');
  btn.textContent = busy ? 'Streaming…' : 'Send';
  btn.disabled = busy;
}

// ============================================================
// Health
// ============================================================

async function pollHealth() {
  let ok = false;
  try { ok = await invoke('llm_health'); } catch { ok = false; }
  if (ok === lastHealthOk) return;
  lastHealthOk = ok;
  const dot = document.getElementById('chatHealthDot');
  const label = document.getElementById('chatHealthLabel');
  dot.classList.remove('health-ok', 'health-bad', 'health-unknown');
  dot.classList.add(ok ? 'health-ok' : 'health-bad');
  const cfg = getCachedLlmConfig();
  label.textContent = ok
    ? `Connected · ${cfg?.model || 'model'}`
    : `Offline · ${cfg?.base_url || ''}`;
}

// ============================================================
// Events
// ============================================================

function bindEvents() {
  document.getElementById('newChatBtn').addEventListener('click', newChat);
  document.getElementById('chatDeleteBtn').addEventListener('click', deleteActiveChat);

  document.getElementById('chatList').addEventListener('click', e => {
    const item = e.target.closest('.chat-list-item');
    if (item) selectChat(item.dataset.id);
  });

  const titleInput = document.getElementById('chatTitle');
  titleInput.addEventListener('input', () => {
    if (!activeChat) return;
    activeChat.title = titleInput.value;
    scheduleSave();
  });

  const composer = document.getElementById('chatComposer');
  const input = document.getElementById('chatInput');
  composer.addEventListener('submit', e => { e.preventDefault(); sendMessage(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  input.addEventListener('input', () => resizeInput(input));

}

function resizeInput(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

// ============================================================
// Helpers
// ============================================================

function escapeAttr(s) {
  return String(s ?? '').replace(/"/g, '&quot;');
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

function formatTime(epochSecs) {
  if (!epochSecs) return '';
  const d = new Date(epochSecs * 1000);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString();
}
