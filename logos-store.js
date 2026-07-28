const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'team-logos.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads', 'team-logos');

const CONFERENCE_KEYS = new Set(['detail', 'overtime']);
const LOGO_TYPES = new Set(['icon', 'upload', 'espn']);
const PLACEHOLDER_LOGO = '/assets/team-logo-placeholder.svg';

function setAllowedConferenceKeys(keys) {
  const next = (Array.isArray(keys) ? keys : [])
    .map((k) => String(k || '').trim().toLowerCase())
    .filter(Boolean);
  if (!next.length) return;
  CONFERENCE_KEYS.clear();
  for (const k of next) CONFERENCE_KEYS.add(k);
}

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
    fs.writeFileSync(STORE_FILE, JSON.stringify({ claims: [], logos: [], names: [], avatars: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return {
      claims: Array.isArray(data.claims) ? data.claims : [],
      logos: Array.isArray(data.logos) ? data.logos : [],
      names: Array.isArray(data.names) ? data.names : [],
      avatars: Array.isArray(data.avatars) ? data.avatars : []
    };
  } catch {
    return { claims: [], logos: [], names: [], avatars: [] };
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${STORE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({
    claims: data.claims || [],
    logos: data.logos || [],
    names: data.names || [],
    avatars: data.avatars || []
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

function listClaims() {
  return readStore().claims.slice();
}

/** Assign a franchise to a user. One team per user; team cannot be owned by someone else. */
function assignTeam(userId, conferenceKey, teamId, teamName = '', assignedBy = null) {
  const conf = normalizeConference(conferenceKey);
  const id = Number(teamId);
  if (!userId) throw Object.assign(new Error('User is required'), { status: 400 });
  if (!conf) throw Object.assign(new Error('Pick a conference'), { status: 400 });
  if (!Number.isFinite(id) || id <= 0) throw Object.assign(new Error('Pick a team'), { status: 400 });

  const data = readStore();
  const taken = data.claims.find((c) => c.conferenceKey === conf && Number(c.teamId) === id && c.userId !== userId);
  if (taken) throw Object.assign(new Error('That team is already assigned to another member'), { status: 409 });

  data.claims = data.claims.filter((c) => c.userId !== userId);
  data.claims.push({
    userId,
    conferenceKey: conf,
    teamId: id,
    teamName: String(teamName || '').trim(),
    claimedAt: new Date().toISOString(),
    assignedBy: assignedBy || null
  });

  // If the member already chose an avatar and this franchise has no logo yet, copy it over.
  const existingLogo = data.logos.find((l) => l.conferenceKey === conf && Number(l.teamId) === id);
  const avatar = data.avatars.find((a) => a.userId === userId);
  if (!existingLogo && avatar && (avatar.type === 'icon' || avatar.type === 'upload')) {
    data.logos.push({
      conferenceKey: conf,
      teamId: id,
      type: avatar.type,
      value: avatar.value,
      width: avatar.width || null,
      height: avatar.height || null,
      updatedBy: userId,
      updatedAt: new Date().toISOString()
    });
  }

  writeStore(data);
  return getClaimForUser(userId);
}

function unassignTeam(userId) {
  if (!userId) throw Object.assign(new Error('User is required'), { status: 400 });
  const data = readStore();
  const before = data.claims.length;
  data.claims = data.claims.filter((c) => c.userId !== userId);
  if (data.claims.length === before) {
    throw Object.assign(new Error('No team assigned to that member'), { status: 404 });
  }
  writeStore(data);
  return true;
}

/** @deprecated Use assignTeam — kept for internal callers */
function claimTeam(userId, conferenceKey, teamId, teamName = '') {
  return assignTeam(userId, conferenceKey, teamId, teamName, null);
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

function getUserAvatar(userId) {
  if (!userId) return null;
  return readStore().avatars.find((a) => a.userId === userId) || null;
}

function publicLogoEntry(entry) {
  if (!entry) return null;
  return { ...entry, url: logoUrl(entry) };
}

/** Franchise logo if claimed, otherwise the member's personal avatar. */
function resolveLogoForUser(userId) {
  const claim = getClaimForUser(userId);
  if (claim) {
    const teamLogo = getLogo(claim.conferenceKey, claim.teamId);
    if (teamLogo && (teamLogo.type === 'icon' || teamLogo.type === 'upload')) {
      return publicLogoEntry(teamLogo);
    }
  }
  return publicLogoEntry(getUserAvatar(userId));
}

function validateIconId(iconId) {
  const icon = String(iconId || '').trim();
  if (!/^[a-z0-9-]{2,80}$/.test(icon)) {
    throw Object.assign(new Error('Invalid icon'), { status: 400 });
  }
  return icon;
}

function validateUploadPayload({ buffer, mimeType, width, height }) {
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
  return { ext, w, h };
}

function saveUserAvatarEntry(userId, entry) {
  const data = readStore();
  const prev = data.avatars.find((a) => a.userId === userId);
  if (prev?.type === 'upload' && prev.value && prev.value !== entry.value) {
    const oldPath = path.join(UPLOAD_DIR, prev.value);
    if (fs.existsSync(oldPath)) {
      try { fs.unlinkSync(oldPath); } catch { /* ignore */ }
    }
  }
  data.avatars = data.avatars.filter((a) => a.userId !== userId);
  data.avatars.push(entry);
  writeStore(data);
  return publicLogoEntry(entry);
}

function setIconLogo(userId, conferenceKey, teamId, iconId) {
  const icon = validateIconId(iconId);
  const claim = getClaimForUser(userId);

  // Always keep a personal avatar so the header works even before franchise assignment.
  const avatarEntry = {
    userId,
    type: 'icon',
    value: icon,
    updatedAt: new Date().toISOString()
  };
  saveUserAvatarEntry(userId, avatarEntry);

  if (claim) {
    const conf = normalizeConference(conferenceKey || claim.conferenceKey);
    const id = Number(teamId || claim.teamId);
    if (!conf || !Number.isFinite(id)) throw Object.assign(new Error('Invalid team'), { status: 400 });
    if (claim.conferenceKey !== conf || Number(claim.teamId) !== id) {
      throw Object.assign(new Error('That franchise is not assigned to you'), { status: 403 });
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
    return publicLogoEntry(entry);
  }

  return publicLogoEntry(avatarEntry);
}

function setUploadLogo(userId, conferenceKey, teamId, payload) {
  const { ext, w, h } = validateUploadPayload(payload);
  const claim = getClaimForUser(userId);
  ensureStore();

  const personalName = `user-${userId.slice(0, 8)}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, personalName), payload.buffer);
  const avatarEntry = {
    userId,
    type: 'upload',
    value: personalName,
    width: w,
    height: h,
    updatedAt: new Date().toISOString()
  };
  saveUserAvatarEntry(userId, avatarEntry);

  if (claim) {
    const conf = normalizeConference(conferenceKey || claim.conferenceKey);
    const id = Number(teamId || claim.teamId);
    if (!conf || !Number.isFinite(id)) throw Object.assign(new Error('Invalid team'), { status: 400 });
    if (claim.conferenceKey !== conf || Number(claim.teamId) !== id) {
      throw Object.assign(new Error('That franchise is not assigned to you'), { status: 403 });
    }

    const filename = `${conf}-${id}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), payload.buffer);

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
    return publicLogoEntry(entry);
  }

  return publicLogoEntry(avatarEntry);
}

function clearLogo(userId, conferenceKey, teamId) {
  const claim = getClaimForUser(userId);
  const data = readStore();

  if (claim) {
    const conf = normalizeConference(conferenceKey || claim.conferenceKey);
    const id = Number(teamId || claim.teamId);
    if (claim.conferenceKey === conf && Number(claim.teamId) === id) {
      const prev = data.logos.find((l) => l.conferenceKey === conf && Number(l.teamId) === id);
      if (prev?.type === 'upload' && prev.value) {
        const oldPath = path.join(UPLOAD_DIR, prev.value);
        if (fs.existsSync(oldPath)) {
          try { fs.unlinkSync(oldPath); } catch { /* ignore */ }
        }
      }
      data.logos = data.logos.filter((l) => !(l.conferenceKey === conf && Number(l.teamId) === id));
    }
  }

  const prevAvatar = data.avatars.find((a) => a.userId === userId);
  if (prevAvatar?.type === 'upload' && prevAvatar.value) {
    const oldPath = path.join(UPLOAD_DIR, prevAvatar.value);
    if (fs.existsSync(oldPath)) {
      try { fs.unlinkSync(oldPath); } catch { /* ignore */ }
    }
  }
  data.avatars = data.avatars.filter((a) => a.userId !== userId);
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
    throw Object.assign(new Error('Your commissioner must assign this team before you can rename it'), { status: 403 });
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
  setAllowedConferenceKeys,
  getClaimForUser,
  getClaimForTeam,
  listClaims,
  assignTeam,
  unassignTeam,
  claimTeam,
  getLogo,
  getUserAvatar,
  resolveLogoForUser,
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
