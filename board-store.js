const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const BOARD_FILE = path.join(DATA_DIR, 'board.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(BOARD_FILE)) {
    fs.writeFileSync(BOARD_FILE, JSON.stringify({ news: [], messages: [], ticker: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8'));
    return {
      news: Array.isArray(data.news) ? data.news : [],
      messages: Array.isArray(data.messages) ? data.messages : [],
      ticker: Array.isArray(data.ticker) ? data.ticker : []
    };
  } catch {
    return { news: [], messages: [], ticker: [] };
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${BOARD_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, BOARD_FILE);
}

function listNews(limit = 20) {
  return readStore().news
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);
}

function listMessages(limit = 50) {
  return readStore().messages
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);
}

function addNews({ title, body, author }) {
  const cleanTitle = String(title || '').trim();
  const cleanBody = String(body || '').trim();
  if (!cleanTitle) throw Object.assign(new Error('News title is required'), { status: 400 });
  if (!cleanBody) throw Object.assign(new Error('News body is required'), { status: 400 });
  if (cleanTitle.length > 140) throw Object.assign(new Error('Title is too long'), { status: 400 });
  if (cleanBody.length > 8000) throw Object.assign(new Error('Body is too long'), { status: 400 });

  const store = readStore();
  const item = {
    id: crypto.randomUUID(),
    title: cleanTitle,
    body: cleanBody,
    authorId: author?.id || null,
    authorName: author?.name || author?.loginName || 'Commissioner',
    createdAt: new Date().toISOString()
  };
  store.news.unshift(item);
  store.news = store.news.slice(0, 100);
  writeStore(store);
  return item;
}

function addMessage({ body, author }) {
  const cleanBody = String(body || '').trim();
  if (!cleanBody) throw Object.assign(new Error('Message is required'), { status: 400 });
  if (cleanBody.length > 2000) throw Object.assign(new Error('Message is too long'), { status: 400 });
  if (!author?.id) throw Object.assign(new Error('Sign in required'), { status: 401 });

  const store = readStore();
  const item = {
    id: crypto.randomUUID(),
    body: cleanBody,
    authorId: author.id,
    authorName: author.name || author.loginName || 'Member',
    authorRole: author.role || 'user',
    createdAt: new Date().toISOString()
  };
  store.messages.unshift(item);
  store.messages = store.messages.slice(0, 300);
  writeStore(store);
  return item;
}

function deleteNews(id, requester) {
  const store = readStore();
  const idx = store.news.findIndex((n) => n.id === id);
  if (idx === -1) throw Object.assign(new Error('News item not found'), { status: 404 });
  const item = store.news[idx];
  const isOwner = item.authorId && item.authorId === requester?.id;
  const isCommish = requester?.role === 'commissioner';
  if (!isOwner && !isCommish) {
    throw Object.assign(new Error('Not allowed to delete this post'), { status: 403 });
  }
  store.news.splice(idx, 1);
  writeStore(store);
  return true;
}

function deleteMessage(id, requester) {
  const store = readStore();
  const idx = store.messages.findIndex((m) => m.id === id);
  if (idx === -1) throw Object.assign(new Error('Message not found'), { status: 404 });
  const item = store.messages[idx];
  const isOwner = item.authorId && item.authorId === requester?.id;
  const isStaff = requester?.role === 'commissioner' || requester?.role === 'conference_admin';
  if (!isOwner && !isStaff) {
    throw Object.assign(new Error('Not allowed to delete this message'), { status: 403 });
  }
  store.messages.splice(idx, 1);
  writeStore(store);
  return true;
}

function listTicker() {
  return readStore().ticker
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function addTicker({ text, author }) {
  const clean = String(text || '').trim().replace(/\s+/g, ' ');
  if (!clean) throw Object.assign(new Error('Ticker message is required'), { status: 400 });
  if (clean.length > 240) throw Object.assign(new Error('Ticker message is too long'), { status: 400 });

  const store = readStore();
  const item = {
    id: crypto.randomUUID(),
    text: clean,
    authorId: author?.id || null,
    authorName: author?.name || author?.loginName || 'Commissioner',
    createdAt: new Date().toISOString()
  };
  store.ticker.unshift(item);
  store.ticker = store.ticker.slice(0, 40);
  writeStore(store);
  return item;
}

function deleteTicker(id, requester) {
  const store = readStore();
  const idx = store.ticker.findIndex((t) => t.id === id);
  if (idx === -1) throw Object.assign(new Error('Ticker item not found'), { status: 404 });
  const isStaff = requester?.role === 'commissioner' || requester?.role === 'conference_admin';
  if (!isStaff) {
    throw Object.assign(new Error('Not allowed to delete ticker items'), { status: 403 });
  }
  store.ticker.splice(idx, 1);
  writeStore(store);
  return true;
}

module.exports = {
  listNews,
  listMessages,
  listTicker,
  addNews,
  addMessage,
  addTicker,
  deleteNews,
  deleteMessage,
  deleteTicker
};
