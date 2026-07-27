const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'team-logos.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads', 'team-logos');

const CONFERENCE_KEYS = new Set(['detail', 'overtime']);
const LOGO_TYPES = new Set(['icon', 'upload', 'espn']);
const PLACEHOLDER_LOGO = '/assets/team-logo-placeholder.svg';

const LOGO_SPECS = {
  minSize: 256,
  maxSize: 1024,
  recommended: 512,
  maxBytes: 2 * 1024 * 1024,
  mimeTypes: {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp'
  }
};

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, JSON.stringify({ claims: [], logos: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return {
      claims: Array.isArray(data.claims) ? data.claims : [],
      logos: Array.isArray(data.logos) ? data.logos : [],
      names: Array.isArray(data.names) ? data.names : []
    };
  } catch {
    return { claims: [], logos: [], names: [] };
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${STORE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({
    claims: data.claims || [],
    logos: data.logos || [],
    names: data.names || []
  }, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

function logoKey(conferenceKey, teamId) {
  return `${conferenceKey}:${Number(teamId)}`;
}

function normalizeConference(conferenceKey) {
  const key = String(conferenceKey || '').trim().toLowerCase();
  return CONFERENCE_KEYS.has(key) ? key : null;
}

function getClaimForUser(userId) {
  return readStore().claims.find((c) => c.userId === userId) || null;
}

function getClaimForTeam(conferenceKey, teamId) {
  const conf = normalizeConference(conferenceKey);
  const id = Number(teamId);
  return readStore().claims.find((c) => c.conferenceKey === conf && Number(c.teamId) === id) || null;
}

function claimTeam(userId, conferenceKey, teamId, teamName = '') {
  const conf = normalizeConference(conferenceKey);
  const id = Number(teamId);
  if (!conf) throw Object.assign(new Error('Pick Detail or Overtime'), { status: 400 });
  if (!Number.isFinite(id) || id <= 0) throw Object.assign(new Error('Pick a team'), { status: 400 });

  const data = readStore();
  const taken = data.claims.find((c) => c.conferenceKey === conf && Number(c.teamId) === id && c.userId !== userId);
  if (taken) throw Object.assign(new Error('That team is already claimed by another owner'), { status: 409 });

  data.claims = data.claims.filter((c) => c.userId !== userId);
  data.claims.push({
    userId,
    conferenceKey: conf,
    teamId: id,
    teamName: String(teamName || '').trim(),
    claimedAt: new Date().toISOString()
  });
  writeStore(data);
  return getClaimForUser(userId);
}

function getLogo(conferenceKey, teamId) {
  const conf = normalizeConference(conferenceKey);
  const id = Number(teamId);
  return readStore().logos.find((l) => l.conferenceKey === conf && Number(l.teamId) === id) || null;
}

function logoUrl(logo) {
  if (!logo || logo.type === 'espn') return null;
  if (logo.type === 'icon') return `/assets/team-icons/${encodeURIComponent(logo.value)}.svg`;
  if (logo.type === 'upload') return `/uploads/team-logos/${encodeURIComponent(logo.value)}`;
  return null;
}

/** Chosen logo URL, or the shared placeholder when none is set. */
function displayLogoUrl(logoOrUrl) {
  if (typeof logoOrUrl === 'string' && logoOrUrl.trim()) return logoOrUrl.trim();
  const fromEntry = logoUrl(logoOrUrl);
  return fromEntry || PLACEHOLDER_LOGO;
}

function setIconLogo(userId, conferenceKey, teamId, iconId) {
  const conf = normalizeConference(conferenceKey);
  const id = Number(teamId);
  const icon = String(iconId || '').trim();
  if (!conf || !Number.isFinite(id)) throw Object.assign(new Error('Invalid team'), { status: 400 });
  if (!/^[a-z0-9-]{2,80}$/.test(icon)) throw Object.assign(new Error('Invalid icon'), { status: 400 });

  const claim = getClaimForUser(userId);
  if (!claim || claim.conferenceKey !== conf || Number(claim.teamId) !== id) {
    throw Object.assign(new Error('Claim this team before setting a logo'), { status: 403 });
  }

  const data = readStore();
  data.logos = data.logos.filter((l) => !(l.conferenceKey === conf && Number(l.teamId) === id));
  const entry = {
    conferenceKey: conf,
    teamId: id,
    type: 'icon',
    value: icon,
    updatedBy: userId,
    updatedAt: new Date().toISOString()
  };
  data.logos.push(entry);
  writeStore(data);
  return { ...entry, url: logoUrl(entry) };
}

function setUploadLogo(userId, conferenceKey, teamId, { buffer, mimeType, width, height }) {
  const conf = normalizeConference(conferenceKey);
  const id = Number(teamId);
  if (!conf || !Number.isFinite(id)) throw Object.assign(new Error('Invalid team'), { status: 400 });

  const claim = getClaimForUser(userId);
  if (!claim || claim.conferenceKey !== conf || Number(claim.teamId) !== id) {
    throw Object.assign(new Error('Claim this team before setting a logo'), { status: 403 });
  }

  const ext = LOGO_SPECS.mimeTypes[mimeType];
  if (!ext) throw Object.assign(new Error('Use PNG, JPG, or WEBP'), { status: 400 });
  if (!buffer || buffer.length > LOGO_SPECS.maxBytes) {
    throw Object.assign(new Error('Logo must be 2 MB or smaller'), { status: 400 });
  }
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w !== h) {
    throw Object.assign(new Error(`Logo must be square (${LOGO_SPECS.recommended}×${LOGO_SPECS.recommended} recommended)`), { status: 400 });
  }
  if (w < LOGO_SPECS.minSize || w > LOGO_SPECS.maxSize) {
    throw Object.assign(new Error(`Logo must be ${LOGO_SPECS.minSize}–${LOGO_SPECS.maxSize} pixels on each side`), { status: 400 });
  }

  ensureStore();
  const filename = `${conf}-${id}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);

  const data = readStore();
  const prev = data.logos.find((l) => l.conferenceKey === conf && Number(l.teamId) === id && l.type === 'upload');
  if (prev?.value) {
    const oldPath = path.join(UPLOAD_DIR, prev.value);
    if (fs.existsSync(oldPath)) {
      try { fs.unlinkSync(oldPath); } catch { /* ignore */ }
    }
  }

  data.logos = data.logos.filter((l) => !(l.conferenceKey === conf && Number(l.teamId) === id));
  const entry = {
    conferenceKey: conf,
    teamId: id,
    type: 'upload',
    value: filename,
    width: w,
    height: h,
    updatedBy: userId,
    updatedAt: new Date().toISOString()
  };
  data.logos.push(entry);
  writeStore(data);
  return { ...entry, url: logoUrl(entry) };
}

function clearLogo(userId, conferenceKey, teamId) {
  const conf = normalizeConference(conferenceKey);
  const id = Number(teamId);
  const claim = getClaimForUser(userId);
  if (!claim || claim.conferenceKey !== conf || Number(claim.teamId) !== id) {
    throw Object.assign(new Error('Claim this team before clearing a logo'), { status: 403 });
  }
  const data = readStore();
  const prev = data.logos.find((l) => l.conferenceKey === conf && Number(l.teamId) === id);
  if (prev?.type === 'upload' && prev.value) {
    const oldPath = path.join(UPLOAD_DIR, prev.value);
    if (fs.existsSync(oldPath)) {
      try { fs.unlinkSync(oldPath); } catch { /* ignore */ }
    }
  }
  data.logos = data.logos.filter((l) => !(l.conferenceKey === conf && Number(l.teamId) === id));
  writeStore(data);
  return { ok: true };
}

function getDisplayName(conferenceKey, teamId) {
  const conf = normalizeConference(conferenceKey);
  const id = Number(teamId);
  return readStore().names.find((n) => n.conferenceKey === conf && Number(n.teamId) === id) || null;
}

function setDisplayName(userId, conferenceKey, teamId, displayName) {
  const conf = normalizeConference(conferenceKey);
  const id = Number(teamId);
  const name = String(displayName || '').trim().replace(/\s+/g, ' ');
  if (!conf || !Number.isFinite(id)) throw Object.assign(new Error('Invalid team'), { status: 400 });
  if (name.length < 2 || name.length > 40) {
    throw Object.assign(new Error('Team name must be 2–40 characters'), { status: 400 });
  }

  const claim = getClaimForUser(userId);
  if (!claim || claim.conferenceKey !== conf || Number(claim.teamId) !== id) {
    throw Object.assign(new Error('Claim this team before renaming'), { status: 403 });
  }

  const data = readStore();
  data.names = data.names.filter((n) => !(n.conferenceKey === conf && Number(n.teamId) === id));
  data.names.push({
    conferenceKey: conf,
    teamId: id,
    displayName: name,
    updatedBy: userId,
    updatedAt: new Date().toISOString()
  });
  const claimIdx = data.claims.findIndex((c) => c.userId === userId);
  if (claimIdx !== -1) data.claims[claimIdx] = { ...data.claims[claimIdx], teamName: name };
  writeStore(data);
  return { conferenceKey: conf, teamId: id, displayName: name };
}

function getNameOverrideMap() {
  const map = new Map();
  for (const entry of readStore().names) {
    if (entry.displayName) map.set(logoKey(entry.conferenceKey, entry.teamId), entry.displayName);
  }
  return map;
}

function getOverrideMap() {
  const map = new Map();
  for (const logo of readStore().logos) {
    if (logo.type !== 'icon' && logo.type !== 'upload') continue;
    const url = logoUrl(logo);
    if (url) map.set(logoKey(logo.conferenceKey, logo.teamId), url);
  }
  return map;
}

function resolveUploadPath(filename) {
  const safe = path.basename(String(filename || ''));
  if (!safe || safe !== filename) return null;
  const full = path.join(UPLOAD_DIR, safe);
  if (!full.startsWith(UPLOAD_DIR)) return null;
  return fs.existsSync(full) ? full : null;
}

module.exports = {
  LOGO_SPECS,
  PLACEHOLDER_LOGO,
  UPLOAD_DIR,
  getClaimForUser,
  getClaimForTeam,
  claimTeam,
  getLogo,
  logoUrl,
  displayLogoUrl,
  setIconLogo,
  setUploadLogo,
  clearLogo,
  getDisplayName,
  setDisplayName,
  getNameOverrideMap,
  getOverrideMap,
  resolveUploadPath,
  logoKey
};
