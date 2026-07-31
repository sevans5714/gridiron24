/**
 * Inbox store — delivery only.
 *
 * Human compose / broadcast is restricted to conference admins, commissioners,
 * and the site owner (see users.canSendInbox). Call sites that accept a user
 * "from" for outreach must check that helper first. System automations may
 * write with a nameless/system from (no user id).
 */
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
    threadId: msg.threadId || msg.id,
    inReplyTo: msg.inReplyTo || null,
    meta: msg.meta && typeof msg.meta === 'object' ? msg.meta : {},
    readAt: msg.readAt || null,
    createdAt: msg.createdAt,
    unread: !msg.readAt
  };
}

function findForUser(messageId, userId) {
  if (!messageId || !userId) return null;
  const store = readStore();
  return store.messages.find((m) => m.id === messageId && m.toUserId === userId) || null;
}

function sendMessage({
  toUserId,
  from = null,
  subject,
  body,
  type = 'general',
  relatedId = null,
  meta = {},
  threadId = null,
  inReplyTo = null
} = {}) {
  const cleanSubject = String(subject || '').trim();
  const cleanBody = String(body || '').trim();
  if (!toUserId) throw Object.assign(new Error('Recipient required'), { status: 400 });
  if (!cleanSubject) throw Object.assign(new Error('Subject required'), { status: 400 });
  if (!cleanBody) throw Object.assign(new Error('Message body required'), { status: 400 });
  if (cleanSubject.length > 180) throw Object.assign(new Error('Subject is too long'), { status: 400 });
  if (cleanBody.length > 8000) throw Object.assign(new Error('Message is too long'), { status: 400 });

  const store = readStore();
  const id = crypto.randomUUID();
  const item = {
    id,
    toUserId,
    fromUserId: from?.id || null,
    fromName: from?.name || from?.loginName || 'System',
    subject: cleanSubject,
    body: cleanBody,
    type: String(type || 'general'),
    relatedId: relatedId || null,
    threadId: threadId || id,
    inReplyTo: inReplyTo || null,
    meta: meta && typeof meta === 'object' ? meta : {},
    readAt: null,
    createdAt: new Date().toISOString()
  };
  store.messages.unshift(item);
  if (store.messages.length > MAX_MESSAGES) {
    store.messages = store.messages.slice(0, MAX_MESSAGES);
  }
  writeStore(store);
  return publicMessage(item);
}

function sendToUsers({
  toUserIds,
  from = null,
  subject,
  body,
  type = 'general',
  relatedId = null,
  meta = {},
  threadId = null,
  inReplyTo = null
} = {}) {
  const ids = [...new Set((toUserIds || []).filter(Boolean))];
  const sent = [];
  const sharedThread = threadId || (ids.length ? crypto.randomUUID() : null);
  for (const toUserId of ids) {
    sent.push(sendMessage({
      toUserId,
      from,
      subject,
      body,
      type,
      relatedId,
      meta,
      threadId: sharedThread,
      inReplyTo
    }));
  }
  return sent;
}

function listForUser(userId, { limit = 100 } = {}) {
  if (!userId) return [];
  const store = readStore();
  return store.messages
    .filter((m) => m.toUserId === userId)
    .slice(0, Math.max(1, Number(limit) || 100))
    .map(publicMessage);
}

function unreadCount(userId) {
  if (!userId) return 0;
  const store = readStore();
  return store.messages.filter((m) => m.toUserId === userId && !m.readAt).length;
}

function markRead(messageId, userId) {
  const store = readStore();
  const msg = store.messages.find((m) => m.id === messageId && m.toUserId === userId);
  if (!msg) throw Object.assign(new Error('Message not found'), { status: 404 });
  if (!msg.readAt) {
    msg.readAt = new Date().toISOString();
    writeStore(store);
  }
  return publicMessage(msg);
}

function markAllRead(userId) {
  if (!userId) return 0;
  const store = readStore();
  let marked = 0;
  const now = new Date().toISOString();
  for (const msg of store.messages) {
    if (msg.toUserId === userId && !msg.readAt) {
      msg.readAt = now;
      marked += 1;
    }
  }
  if (marked) writeStore(store);
  return marked;
}

function deleteMessage(messageId, userId) {
  const store = readStore();
  const idx = store.messages.findIndex((m) => m.id === messageId && m.toUserId === userId);
  if (idx < 0) throw Object.assign(new Error('Message not found'), { status: 404 });
  store.messages.splice(idx, 1);
  writeStore(store);
  return true;
}

/** Keep one digest row per relatedId (fingerprint). Clears the row when subject/body are empty. */
function upsertDigest({
  toUserId,
  digestKey,
  subject = null,
  body = null,
  type = 'general',
  fingerprint = '',
  meta = {}
} = {}) {
  if (!toUserId || !digestKey) return null;
  const store = readStore();
  const idx = store.messages.findIndex(
    (m) => m.toUserId === toUserId && m.relatedId === digestKey && m.meta?.digest
  );
  const cleanSubject = String(subject || '').trim();
  const cleanBody = String(body || '').trim();
  if (!cleanSubject || !cleanBody) {
    if (idx >= 0) {
      store.messages.splice(idx, 1);
      writeStore(store);
    }
    return null;
  }
  const nextMeta = {
    ...(meta && typeof meta === 'object' ? meta : {}),
    digest: true,
    fingerprint: String(fingerprint || ''),
    updatedAt: new Date().toISOString()
  };
  if (idx >= 0) {
    const existing = store.messages[idx];
    const same = String(existing.meta?.fingerprint || '') === nextMeta.fingerprint
      && existing.subject === cleanSubject
      && existing.body === cleanBody;
    existing.subject = cleanSubject;
    existing.body = cleanBody;
    existing.type = String(type || existing.type || 'general');
    existing.meta = { ...existing.meta, ...nextMeta };
    if (!same) {
      existing.readAt = null;
      // Bump to top when content changes.
      store.messages.splice(idx, 1);
      store.messages.unshift(existing);
    }
    writeStore(store);
    return publicMessage(existing);
  }
  const id = crypto.randomUUID();
  const item = {
    id,
    toUserId,
    fromUserId: null,
    fromName: 'System',
    subject: cleanSubject,
    body: cleanBody,
    type: String(type || 'general'),
    relatedId: digestKey,
    threadId: id,
    inReplyTo: null,
    meta: nextMeta,
    readAt: null,
    createdAt: new Date().toISOString()
  };
  store.messages.unshift(item);
  if (store.messages.length > MAX_MESSAGES) {
    store.messages = store.messages.slice(0, MAX_MESSAGES);
  }
  writeStore(store);
  return publicMessage(item);
}

/** Create a message only if this user does not already have one for relatedId (+ optional type). */
function ensureRelatedMessage({
  toUserId,
  relatedId,
  subject,
  body,
  type = 'general',
  meta = {}
} = {}) {
  if (!toUserId || !relatedId) return null;
  const store = readStore();
  const existing = store.messages.find(
    (m) => m.toUserId === toUserId
      && m.relatedId === relatedId
      && (!type || m.type === type)
  );
  if (existing) return publicMessage(existing);
  return sendMessage({
    toUserId,
    subject,
    body,
    type,
    relatedId,
    meta
  });
}

module.exports = {
  sendMessage,
  sendToUsers,
  listForUser,
  findForUser,
  unreadCount,
  markRead,
  markAllRead,
  deleteMessage,
  upsertDigest,
  ensureRelatedMessage,
  publicMessage
};
