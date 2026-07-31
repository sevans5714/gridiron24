const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'feature-requests.json');
const MAX_REQUESTS = 300;
const MAX_BODY = 4000;

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({ requests: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { requests: Array.isArray(data.requests) ? data.requests : [] };
  } catch {
    return { requests: [] };
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

function publicRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    text: row.text,
    authorId: row.authorId,
    authorName: row.authorName,
    createdAt: row.createdAt,
    status: row.status || 'submitted'
  };
}

function createRequest({ text, author } = {}) {
  const clean = String(text || '').trim();
  if (!clean) {
    throw Object.assign(new Error('Describe the feature you want'), { status: 400 });
  }
  if (clean.length > MAX_BODY) {
    throw Object.assign(new Error(`Feature request is too long (max ${MAX_BODY} characters)`), { status: 400 });
  }
  if (!author?.id) {
    throw Object.assign(new Error('Sign in required'), { status: 401 });
  }
  const item = {
    id: crypto.randomUUID(),
    text: clean,
    authorId: author.id,
    authorName: author.name || author.loginName || 'Member',
    createdAt: new Date().toISOString(),
    status: 'submitted'
  };
  const store = readStore();
  store.requests.unshift(item);
  store.requests = store.requests.slice(0, MAX_REQUESTS);
  writeStore(store);
  return item;
}

function listRequests({ status = null, limit = 50 } = {}) {
  let rows = readStore().requests.slice();
  if (status) {
    const key = String(status).toLowerCase();
    rows = rows.filter((r) => String(r.status || 'submitted').toLowerCase() === key);
  }
  return rows.slice(0, Math.max(1, Number(limit) || 50)).map(publicRequest);
}

module.exports = {
  createRequest,
  listRequests,
  publicRequest,
  MAX_BODY
};
