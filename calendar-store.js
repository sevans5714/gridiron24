const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'calendar.json');

const TYPES = new Set(['draft', 'deadline', 'dues', 'bowl', 'survival', 'event', 'other']);

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({ events: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { events: Array.isArray(data.events) ? data.events : [] };
  } catch {
    return { events: [] };
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

function seedIfEmpty(defaults = []) {
  const store = readStore();
  if (store.events.length) return store.events;
  if (!defaults.length) return [];
  store.events = defaults.map((e) => ({
    id: crypto.randomUUID(),
    title: e.title,
    type: TYPES.has(e.type) ? e.type : 'event',
    date: e.date || null,
    notes: e.notes || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }));
  writeStore(store);
  return store.events;
}

/** Add any default events that are missing (by type or title), without replacing existing ones. */
function ensureDefaults(defaults = []) {
  if (!Array.isArray(defaults) || !defaults.length) return listEvents();
  seedIfEmpty(defaults);
  const store = readStore();
  let dirty = false;
  for (const e of defaults) {
    const type = TYPES.has(e.type) ? e.type : 'event';
    const title = String(e.title || '').trim();
    const exists = store.events.some((ev) => {
      if (type !== 'event' && ev.type === type) return true;
      return title && String(ev.title || '').toLowerCase() === title.toLowerCase();
    });
    if (exists) continue;
    store.events.push({
      id: crypto.randomUUID(),
      title: title || 'League Event',
      type,
      date: e.date || null,
      notes: e.notes || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    dirty = true;
  }
  if (dirty) writeStore(store);
  return listEvents();
}

function listEvents() {
  return readStore().events
    .slice()
    .sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')));
}

function addEvent({ title, type, date, notes }) {
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) throw Object.assign(new Error('Title is required'), { status: 400 });
  if (cleanTitle.length > 120) throw Object.assign(new Error('Title is too long'), { status: 400 });
  const store = readStore();
  const item = {
    id: crypto.randomUUID(),
    title: cleanTitle,
    type: TYPES.has(type) ? type : 'event',
    date: date ? String(date).slice(0, 10) : null,
    notes: String(notes || '').trim().slice(0, 500),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  store.events.push(item);
  writeStore(store);
  return item;
}

function updateEvent(id, patch = {}) {
  const store = readStore();
  const idx = store.events.findIndex((e) => e.id === id);
  if (idx === -1) throw Object.assign(new Error('Event not found'), { status: 404 });
  const cur = store.events[idx];
  if (patch.title != null) {
    const t = String(patch.title).trim();
    if (!t) throw Object.assign(new Error('Title is required'), { status: 400 });
    cur.title = t.slice(0, 120);
  }
  if (patch.type != null) cur.type = TYPES.has(patch.type) ? patch.type : cur.type;
  if (patch.date !== undefined) cur.date = patch.date ? String(patch.date).slice(0, 10) : null;
  if (patch.notes != null) cur.notes = String(patch.notes).trim().slice(0, 500);
  cur.updatedAt = new Date().toISOString();
  store.events[idx] = cur;
  writeStore(store);
  return cur;
}

function deleteEvent(id) {
  const store = readStore();
  const idx = store.events.findIndex((e) => e.id === id);
  if (idx === -1) throw Object.assign(new Error('Event not found'), { status: 404 });
  store.events.splice(idx, 1);
  writeStore(store);
  return true;
}

module.exports = {
  listEvents,
  addEvent,
  updateEvent,
  deleteEvent,
  seedIfEmpty,
  ensureDefaults
};
