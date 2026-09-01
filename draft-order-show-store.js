const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'draft-order-show.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads', 'draft-order-show');
const INCOMING_DIR = path.join(UPLOAD_DIR, 'incoming');
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;
const SESSION_MS = 6 * 60 * 60 * 1000;

const VIDEO_MIME = {
  'video/mp4': 'mp4',
  'video/mpeg4': 'mp4',
  'video/x-m4v': 'mp4',
  'video/m4v': 'mp4',
  'application/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-quicktime': 'mov'
};

const EXT_MIME = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  qt: 'video/quicktime'
};

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(INCOMING_DIR)) fs.mkdirSync(INCOMING_DIR, { recursive: true });
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

function mimeFromFilename(filename) {
  const ext = path.extname(String(filename || '')).replace('.', '').toLowerCase();
  return EXT_MIME[ext] || null;
}

function resolveMime(mimeType, filename) {
  const raw = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (raw === 'video/mpeg4' || raw === 'video/x-m4v' || raw === 'video/m4v' || raw === 'application/mp4') {
    return 'video/mp4';
  }
  if (raw === 'video/x-quicktime') return 'video/quicktime';
  if (VIDEO_MIME[raw]) return raw;
  const fromName = mimeFromFilename(filename);
  if (fromName) return fromName;
  throw Object.assign(new Error('Upload MP4, WebM, or MOV'), { status: 400 });
}

function extForMime(mimeType, filename) {
  const mime = resolveMime(mimeType, filename);
  const ext = VIDEO_MIME[mime];
  if (!ext) {
    throw Object.assign(new Error('Upload MP4, WebM, or MOV'), { status: 400 });
  }
  return ext;
}

function sessionPath(id) {
  return path.join(INCOMING_DIR, `${id}.json`);
}

function chunkPath(id, index) {
  return path.join(INCOMING_DIR, `${id}.${index}`);
}

function readSession(id) {
  const abs = sessionPath(id);
  if (!fs.existsSync(abs)) {
    throw Object.assign(new Error('Upload expired. Start again.'), { status: 404 });
  }
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch {
    throw Object.assign(new Error('Upload expired. Start again.'), { status: 404 });
  }
}

function writeSession(session) {
  ensureStore();
  fs.writeFileSync(sessionPath(session.id), JSON.stringify(session));
}

function removeSessionFiles(id, chunkCount) {
  try { fs.unlinkSync(sessionPath(id)); } catch { /* ignore */ }
  const n = Number(chunkCount) || 0;
  for (let i = 0; i < n; i += 1) {
    try { fs.unlinkSync(chunkPath(id, i)); } catch { /* ignore */ }
  }
}

function startUpload({ year, title, notes, mimeType, filename, size }) {
  const y = normalizeYear(year);
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw Object.assign(new Error('Empty upload'), { status: 400 });
  }
  if (bytes > MAX_BYTES) {
    throw Object.assign(new Error('Video must be under 2GB'), { status: 413 });
  }
  const mime = resolveMime(mimeType, filename);
  const ext = extForMime(mime, filename);
  const id = `upl_${crypto.randomBytes(8).toString('hex')}`;
  const session = {
    id,
    year: y,
    title: normalizeTitle(title, y),
    notes: normalizeNotes(notes),
    mimeType: mime,
    ext,
    size: bytes,
    chunkCount: Math.ceil(bytes / CHUNK_BYTES),
    received: {},
    createdAt: Date.now()
  };
  writeSession(session);
  return {
    uploadId: id,
    chunkBytes: CHUNK_BYTES,
    chunkCount: session.chunkCount
  };
}

function saveChunk(id, index, buffer) {
  const session = readSession(id);
  if (Date.now() - session.createdAt > SESSION_MS) {
    removeSessionFiles(id, session.chunkCount);
    throw Object.assign(new Error('Upload expired. Start again.'), { status: 410 });
  }
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= session.chunkCount) {
    throw Object.assign(new Error('Bad upload chunk'), { status: 400 });
  }
  if (!buffer?.length) {
    throw Object.assign(new Error('Empty upload chunk'), { status: 400 });
  }
  if (buffer.length > CHUNK_BYTES + 64) {
    throw Object.assign(new Error('Upload chunk too large'), { status: 413 });
  }
  ensureStore();
  fs.writeFileSync(chunkPath(id, idx), buffer);
  session.received[String(idx)] = buffer.length;
  writeSession(session);
  const got = Object.keys(session.received).length;
  return { ok: true, received: got, chunkCount: session.chunkCount };
}

function pipeFile(from, to) {
  return new Promise((resolve, reject) => {
    const inp = fs.createReadStream(from);
    inp.on('error', reject);
    inp.on('end', resolve);
    inp.pipe(to, { end: false });
  });
}

async function finishUpload(id) {
  const session = readSession(id);
  for (let i = 0; i < session.chunkCount; i += 1) {
    if (!fs.existsSync(chunkPath(id, i))) {
      throw Object.assign(new Error(`Upload incomplete (missing piece ${i + 1})`), { status: 400 });
    }
  }
  const dest = newUploadPath(session.year, session.mimeType);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest.abs);
    out.on('error', reject);
    out.on('finish', resolve);
    (async () => {
      try {
        for (let i = 0; i < session.chunkCount; i += 1) {
          await pipeFile(chunkPath(id, i), out);
        }
        out.end();
      } catch (err) {
        out.destroy();
        reject(err);
      }
    })();
  });
  let statSize = 0;
  try {
    statSize = fs.statSync(dest.abs).size;
  } catch {
    throw Object.assign(new Error('Could not save video'), { status: 500 });
  }
  if (statSize !== session.size) {
    try { fs.unlinkSync(dest.abs); } catch { /* ignore */ }
    throw Object.assign(new Error('Upload size did not match. Try again.'), { status: 400 });
  }
  const item = saveFileMeta({
    year: session.year,
    title: session.title,
    notes: session.notes,
    filename: dest.filename,
    mimeType: session.mimeType,
    size: statSize
  });
  removeSessionFiles(id, session.chunkCount);
  return item;
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
  CHUNK_BYTES,
  VIDEO_MIME,
  listVideos,
  findById,
  resolveMediaPath,
  saveEmbed,
  newUploadPath,
  saveFileMeta,
  startUpload,
  saveChunk,
  finishUpload,
  resolveMime,
  remove,
  extForMime,
  normalizeYear,
  normalizeTitle,
  normalizeNotes
};
