const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'inbox.json');
const MAX_MESSAGES = 2000;

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({ messages: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { messages: Array.isArray(data.messages) ? data.messages : [] };
  } catch {
    return { messages: [] };
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

function publicMessage(msg) {
  if (!msg) return null;
  return {
    id: msg.id,
    toUserId: msg.toUserId,
    fromUserId: msg.fromUserId || null,
    fromName: msg.fromName || 'System',
    subject: msg.subject,
    body: msg.body,
    type: msg.type || 'general',
    relatedId: msg.relatedId || null,
    meta: msg.meta && typeof msg.meta === 'object' ? msg.meta : {},
    readAt: msg.readAt || null,
    createdAt: msg.createdAt,
    unread: !msg.readAt
  };
}

function sendMessage({
  toUserId,
  from = null,
  subject,
  body,
  type = 'general',
  relatedId = null,
  meta = {}
} = {}) {
  const cleanSubject = String(subject || '').trim();
  const cleanBody = String(body || '').trim();
  if (!toUserId) throw Object.assign(new Error('Recipient required'), { status: 400 });
  if (!cleanSubject) throw Object.assign(new Error('Subject required'), { status: 400 });
  if (!cleanBody) throw Object.assign(new Error('Message body required'), { status: 400 });
  if (cleanSubject.length > 180) throw Object.assign(new Error('Subject is too long'), { status: 400 });
  if (cleanBody.length > 8000) throw Object.assign(new Error('Message is too long'), { status: 400 });

  const store = readStore();
  const item = {
    id: crypto.randomUUID(),
    toUserId,
    fromUserId: from?.id || null,
    fromName: from?.name || from?.loginName || 'System',
    subject: cleanSubject,
    body: cleanBody,
    type: String(type || 'general'),
    relatedId: relatedId || null,
    meta: meta && typeof meta === 'object' ? meta : {},
    readAt: null,
    createdAt: new Date().toISOString()
  };
  store.messages.unshift(item);
  store.messages = store.messages.slice(0, MAX_MESSAGES);
  writeStore(store);
  return publicMessage(item);
}

function sendToUsers({
  toUserIds = [],
  from = null,
  subject,
  body,
  type = 'general',
  relatedId = null,
  meta = {}
} = {}) {
  const ids = [...new Set((toUserIds || []).filter(Boolean))];
  const sent = [];
  for (const toUserId of ids) {
    sent.push(sendMessage({
      toUserId,
      from,
      subject,
      body,
      type,
      relatedId,
      meta
    }));
  }
  return sent;
}

function listForUser(userId, { limit = 80 } = {}) {
  if (!userId) return [];
  return readStore().messages
    .filter((m) => m.toUserId === userId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit)
    .map(publicMessage);
}

function unreadCount(userId) {
  if (!userId) return 0;
  return readStore().messages.filter((m) => m.toUserId === userId && !m.readAt).length;
}

function getMessage(id, userId) {
  const msg = readStore().messages.find((m) => m.id === id && m.toUserId === userId);
  return publicMessage(msg);
}

function isDisposableMessage(msg) {
  if (!msg) return false;
  if (msg.type === 'welcome') return true;
  const kind = msg.meta?.kind;
  return kind === 'first_login_welcome' || kind === 'welcome_preview';
}

function markRead(id, userId) {
  const store = readStore();
  const idx = store.messages.findIndex((m) => m.id === id && m.toUserId === userId);
  if (idx === -1) throw Object.assign(new Error('Message not found'), { status: 404 });
  const msg = store.messages[idx];
  // Welcome (and similar one-shots) disappear once read.
  if (isDisposableMessage(msg)) {
    store.messages.splice(idx, 1);
    writeStore(store);
    return null;
  }
  if (!msg.readAt) {
    msg.readAt = new Date().toISOString();
    writeStore(store);
  }
  return publicMessage(store.messages[idx]);
}

function markAllRead(userId) {
  if (!userId) return 0;
  const store = readStore();
  let n = 0;
  const now = new Date().toISOString();
  const kept = [];
  for (const msg of store.messages) {
    if (msg.toUserId !== userId) {
      kept.push(msg);
      continue;
    }
    if (isDisposableMessage(msg)) {
      n += 1;
      continue; // drop welcome once "read"
    }
    if (!msg.readAt) {
      msg.readAt = now;
      n += 1;
    }
    kept.push(msg);
  }
  if (n) {
    store.messages = kept;
    writeStore(store);
  }
  return n;
}

function deleteMessage(id, userId) {
  const store = readStore();
  const before = store.messages.length;
  store.messages = store.messages.filter((m) => !(m.id === id && m.toUserId === userId));
  if (store.messages.length === before) {
    throw Object.assign(new Error('Message not found'), { status: 404 });
  }
  writeStore(store);
  return true;
}

module.exports = {
  sendMessage,
  sendToUsers,
  listForUser,
  unreadCount,
  getMessage,
  markRead,
  markAllRead,
  deleteMessage,
  publicMessage
};
