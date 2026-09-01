const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'draft-order-show.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads', 'draft-order-show');
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

const VIDEO_MIME = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov'
};

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({ videos: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { videos: Array.isArray(data.videos) ? data.videos : [] };
  } catch {
    return { videos: [] };
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({
    videos: Array.isArray(data.videos) ? data.videos : []
  }, null, 2));
  fs.renameSync(tmp, FILE);
}

function normalizeYear(raw) {
  const year = Number(raw);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw Object.assign(new Error('Enter a season year (2000–2100)'), { status: 400 });
  }
  return year;
}

function normalizeTitle(raw, year) {
  const title = String(raw || '').trim();
  return title || `Draft Order Show ${year}`;
}

function normalizeNotes(raw) {
  return String(raw || '').trim().slice(0, 500);
}

function parseEmbed(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw Object.assign(new Error('Paste a full YouTube or Vimeo URL'), { status: 400 });
  }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'youtu.be') {
    const id = u.pathname.split('/').filter(Boolean)[0];
    if (!id) throw Object.assign(new Error('Could not read that YouTube link'), { status: 400 });
    return {
      kind: 'embed',
      provider: 'youtube',
      embedUrl: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}`
    };
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    let id = u.searchParams.get('v') || '';
    if (!id && u.pathname.startsWith('/embed/')) {
      id = u.pathname.split('/')[2] || '';
    }
    if (!id && u.pathname.startsWith('/shorts/')) {
      id = u.pathname.split('/')[2] || '';
    }
    if (!id) throw Object.assign(new Error('Could not read that YouTube link'), { status: 400 });
    return {
      kind: 'embed',
      provider: 'youtube',
      embedUrl: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}`
    };
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = u.pathname.split('/').filter(Boolean).find((part) => /^\d+$/.test(part));
    if (!id) throw Object.assign(new Error('Could not read that Vimeo link'), { status: 400 });
    return {
      kind: 'embed',
      provider: 'vimeo',
      embedUrl: `https://player.vimeo.com/video/${id}`
    };
  }
  throw Object.assign(new Error('Use a YouTube or Vimeo URL, or upload a video file'), { status: 400 });
}

function extForMime(mimeType) {
  const ext = VIDEO_MIME[String(mimeType || '').toLowerCase()];
  if (!ext) {
    throw Object.assign(new Error('Upload MP4, WebM, or MOV'), { status: 400 });
  }
  return ext;
}

function publicVideo(row) {
  if (!row) return null;
  return {
    id: row.id,
    year: row.year,
    title: row.title,
    notes: row.notes || '',
    kind: row.kind,
    provider: row.provider || null,
    embedUrl: row.kind === 'embed' ? row.embedUrl : null,
    mediaUrl: row.kind === 'file' ? `/api/draft-order-show/${row.id}/media` : null,
    mimeType: row.mimeType || null,
    size: row.size || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function listVideos() {
  return readStore().videos
    .slice()
    .sort((a, b) => (b.year - a.year) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .map(publicVideo);
}

function findById(id) {
  const key = String(id || '').trim();
  return readStore().videos.find((v) => v.id === key) || null;
}

function resolveMediaPath(id) {
  const row = findById(id);
  if (!row || row.kind !== 'file' || !row.filename) return null;
  const abs = path.join(UPLOAD_DIR, row.filename);
  if (!abs.startsWith(UPLOAD_DIR) || !fs.existsSync(abs)) return null;
  return { path: abs, mimeType: row.mimeType || 'video/mp4', size: row.size || 0 };
}

function unlinkFile(filename) {
  if (!filename) return;
  const abs = path.join(UPLOAD_DIR, filename);
  if (abs.startsWith(UPLOAD_DIR) && fs.existsSync(abs)) {
    try { fs.unlinkSync(abs); } catch { /* ignore */ }
  }
}

function upsert(record) {
  const store = readStore();
  const year = record.year;
  const existing = store.videos.find((v) => v.year === year);
  const now = new Date().toISOString();
  if (existing) {
    if (existing.kind === 'file' && existing.filename && existing.filename !== record.filename) {
      unlinkFile(existing.filename);
    }
    Object.assign(existing, record, { id: existing.id, createdAt: existing.createdAt || now, updatedAt: now });
    writeStore(store);
    return publicVideo(existing);
  }
  const row = {
    id: `dos_${crypto.randomBytes(8).toString('hex')}`,
    createdAt: now,
    updatedAt: now,
    ...record,
    year
  };
  store.videos.push(row);
  writeStore(store);
  return publicVideo(row);
}

function saveEmbed({ year, title, notes, url }) {
  const y = normalizeYear(year);
  const embed = parseEmbed(url);
  if (!embed) {
    throw Object.assign(new Error('Paste a YouTube or Vimeo URL'), { status: 400 });
  }
  return upsert({
    year: y,
    title: normalizeTitle(title, y),
    notes: normalizeNotes(notes),
    kind: 'embed',
    provider: embed.provider,
    embedUrl: embed.embedUrl,
    mimeType: null,
    filename: null,
    size: null
  });
}

function newUploadPath(year, mimeType) {
  ensureStore();
  const ext = extForMime(mimeType);
  const filename = `${year}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  return { filename, abs: path.join(UPLOAD_DIR, filename), ext, mimeType: String(mimeType).toLowerCase() };
}

function saveFileMeta({ year, title, notes, filename, mimeType, size }) {
  const y = normalizeYear(year);
  if (!filename || !size) {
    throw Object.assign(new Error('Empty upload'), { status: 400 });
  }
  return upsert({
    year: y,
    title: normalizeTitle(title, y),
    notes: normalizeNotes(notes),
    kind: 'file',
    provider: null,
    embedUrl: null,
    mimeType: String(mimeType || 'video/mp4').toLowerCase(),
    filename,
    size
  });
}

function remove(id) {
  const store = readStore();
  const idx = store.videos.findIndex((v) => v.id === String(id || ''));
  if (idx < 0) throw Object.assign(new Error('Video not found'), { status: 404 });
  const [removed] = store.videos.splice(idx, 1);
  if (removed?.filename) unlinkFile(removed.filename);
  writeStore(store);
  return { ok: true };
}

module.exports = {
  MAX_BYTES,
  VIDEO_MIME,
  listVideos,
  findById,
  resolveMediaPath,
  saveEmbed,
  newUploadPath,
  saveFileMeta,
  remove,
  extForMime,
  normalizeYear,
  normalizeTitle,
  normalizeNotes
};
