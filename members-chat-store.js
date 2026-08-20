const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CHAT_FILE = path.join(DATA_DIR, 'members-chat.json');
const MAX_MESSAGES = 400;
const MAX_BODY = 1000;
const MIN_INTERVAL_MS = 700;

const lastPostByUser = new Map();

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CHAT_FILE)) {
    fs.writeFileSync(CHAT_FILE, JSON.stringify({ messages: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8'));
    return { messages: Array.isArray(data.messages) ? data.messages : [] };
  } catch {
    return { messages: [] };
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${CHAT_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, CHAT_FILE);
}

function publicMessage(m) {
  return {
    id: m.id,
    body: m.body,
    authorId: m.authorId,
    authorName: m.authorName,
    authorLeague: m.authorLeague || null,
    createdAt: m.createdAt,
    kind: m.kind || 'chat',
    meta: m.meta && typeof m.meta === 'object' ? m.meta : null
  };
}

/** Chronological (oldest → newest). Optional since ISO / after id for incremental polls. */
function listMessages({ limit = 120, since = null, after = null } = {}) {
  let messages = readStore().messages.slice();
  if (after) {
    const idx = messages.findIndex((m) => m.id === after);
    messages = idx >= 0 ? messages.slice(idx + 1) : messages;
  } else if (since) {
    const t = Date.parse(since);
    if (Number.isFinite(t)) {
      messages = messages.filter((m) => Date.parse(m.createdAt) > t);
    }
  }
  const cap = Math.min(Math.max(Number(limit) || 120, 1), MAX_MESSAGES);
  if (messages.length > cap) messages = messages.slice(-cap);
  return messages.map(publicMessage);
}

function addMessage({ body, author, kind = 'chat', meta = null, skipRateLimit = false } = {}) {
  const cleanBody = String(body || '').trim();
  if (!cleanBody) throw Object.assign(new Error('Message is required'), { status: 400 });
  if (cleanBody.length > MAX_BODY) {
    throw Object.assign(new Error(`Message is too long (max ${MAX_BODY} characters)`), { status: 400 });
  }
  if (!author?.id) throw Object.assign(new Error('Sign in required'), { status: 401 });

  if (!skipRateLimit) {
    const now = Date.now();
    const prev = lastPostByUser.get(author.id) || 0;
    if (now - prev < MIN_INTERVAL_MS) {
      throw Object.assign(new Error('Slow down a second'), { status: 429 });
    }
    lastPostByUser.set(author.id, now);
  }

  const store = readStore();
  const item = {
    id: crypto.randomUUID(),
    body: cleanBody,
    authorId: author.id,
    authorName: author.name || author.loginName || 'Member',
    authorLeague: author.membershipLeague || null,
    createdAt: new Date().toISOString(),
    kind: kind === 'bet' || kind === 'mock' ? kind : 'chat',
    meta: meta && typeof meta === 'object' ? meta : null
  };
  store.messages.push(item);
  if (store.messages.length > MAX_MESSAGES) {
    store.messages = store.messages.slice(-MAX_MESSAGES);
  }
  writeStore(store);
  return publicMessage(item);
}

function deleteMessage(id, requester) {
  const store = readStore();
  const idx = store.messages.findIndex((m) => m.id === id);
  if (idx === -1) throw Object.assign(new Error('Message not found'), { status: 404 });
  const item = store.messages[idx];
  const isOwner = item.authorId && item.authorId === requester?.id;
  const isStaff = requester?.role === 'commissioner'
    || requester?.role === 'conference_admin'
    || Boolean(requester?.siteOwner);
  if (!isOwner && !isStaff) {
    throw Object.assign(new Error('Not allowed to delete this message'), { status: 403 });
  }
  store.messages.splice(idx, 1);
  writeStore(store);
  return true;
}

function purgeUser(userId) {
  const id = String(userId || '');
  if (!id) return 0;
  const store = readStore();
  const before = (store.messages || []).length;
  store.messages = (store.messages || []).filter((m) => String(m.authorId) !== id);
  writeStore(store);
  lastPostByUser.delete(id);
  return before - store.messages.length;
}

/** Wipe the lounge chat (all kinds: chat, bet, mock). Staff-only caller responsibility. */
function clearAllMessages() {
  const store = readStore();
  const cleared = (store.messages || []).length;
  writeStore({ messages: [] });
  return { cleared };
}

/**
 * Resolve @mentions from explicit ids and/or @Name text matches.
 * Names match approved users (longest name first to avoid partial collisions).
 */
function resolveMentionedUsers(body, { users = [], mentionIds = [], excludeUserId = null } = {}) {
  const byId = new Map(users.map((u) => [u.id, u]));
  const found = new Map();

  for (const raw of mentionIds || []) {
    const id = String(raw || '').trim();
    const u = byId.get(id);
    if (!u || u.id === excludeUserId) continue;
    found.set(u.id, u);
  }

  const text = String(body || '');
  const named = users
    .filter((u) => u?.id && u.id !== excludeUserId && String(u.name || '').trim())
    .slice()
    .sort((a, b) => String(b.name).length - String(a.name).length);

  for (const u of named) {
    const name = String(u.name).trim();
    // @Name with word boundary-ish end (space, punctuation, or EOS)
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|\\s)@${escaped}(?=$|[\\s.,!?;:)'"\\]])`, 'i');
    if (re.test(text)) found.set(u.id, u);
  }

  return [...found.values()];
}

module.exports = {
  listMessages,
  addMessage,
  deleteMessage,
  purgeUser,
  clearAllMessages,
  resolveMentionedUsers,
  MAX_BODY
};
