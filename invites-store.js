const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const INVITES_FILE = path.join(DATA_DIR, 'invites.json');
const INVITE_DAYS = 14;

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(INVITES_FILE)) {
    fs.writeFileSync(INVITES_FILE, JSON.stringify({ invites: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(INVITES_FILE, 'utf8'));
    if (!Array.isArray(data.invites)) return { invites: [] };
    return data;
  } catch {
    return { invites: [] };
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${INVITES_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, INVITES_FILE);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function publicInvite(invite) {
  if (!invite) return null;
  return {
    id: invite.id,
    email: invite.email,
    status: invite.status,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    acceptedAt: invite.acceptedAt || null,
    invitedByName: invite.invitedByName || null
  };
}

function listInvites() {
  const now = Date.now();
  const store = readStore();
  let changed = false;
  for (const invite of store.invites) {
    if (invite.status === 'pending' && Date.parse(invite.expiresAt) < now) {
      invite.status = 'expired';
      changed = true;
    }
  }
  if (changed) writeStore(store);
  return store.invites
    .map(publicInvite)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function createInvite({ email, invitedBy }) {
  const emailKey = normalizeEmail(email);
  if (!emailKey || !emailKey.includes('@')) {
    const err = new Error('Enter a valid email address');
    err.status = 400;
    throw err;
  }

  const store = readStore();
  const existingIdx = store.invites.findIndex(
    (i) => i.email === emailKey && i.status === 'pending' && Date.parse(i.expiresAt) > Date.now()
  );

  const token = crypto.randomBytes(24).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  if (existingIdx !== -1) {
    store.invites[existingIdx].tokenHash = tokenHash;
    store.invites[existingIdx].expiresAt = new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    store.invites[existingIdx].invitedById = invitedBy?.id || store.invites[existingIdx].invitedById;
    store.invites[existingIdx].invitedByName =
      invitedBy?.name || invitedBy?.loginName || store.invites[existingIdx].invitedByName;
    writeStore(store);
    return { invite: publicInvite(store.invites[existingIdx]), token, reused: true };
  }

  const invite = {
    id: crypto.randomUUID(),
    email: emailKey,
    tokenHash,
    status: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    acceptedAt: null,
    invitedById: invitedBy?.id || null,
    invitedByName: invitedBy?.name || invitedBy?.loginName || null
  };
  store.invites.unshift(invite);
  writeStore(store);
  return { invite: publicInvite(invite), token, reused: false };
}

function findByToken(token) {
  const hash = crypto.createHash('sha256').update(String(token || '')).digest('hex');
  const store = readStore();
  const invite = store.invites.find((i) => i.tokenHash === hash);
  if (!invite) return null;
  if (invite.status === 'pending' && Date.parse(invite.expiresAt) < Date.now()) {
    invite.status = 'expired';
    writeStore(store);
    return null;
  }
  if (invite.status !== 'pending') return null;
  return invite;
}

function acceptInvite(token, email) {
  const invite = findByToken(token);
  if (!invite) {
    const err = new Error('Invite link is invalid or expired');
    err.status = 400;
    throw err;
  }
  const emailKey = normalizeEmail(email);
  if (emailKey && emailKey !== invite.email) {
    const err = new Error('Use the email address this invite was sent to');
    err.status = 400;
    throw err;
  }
  const store = readStore();
  const idx = store.invites.findIndex((i) => i.id === invite.id);
  if (idx === -1) {
    const err = new Error('Invite not found');
    err.status = 404;
    throw err;
  }
  store.invites[idx].status = 'accepted';
  store.invites[idx].acceptedAt = new Date().toISOString();
  writeStore(store);
  return publicInvite(store.invites[idx]);
}

function revokeInvite(id) {
  const store = readStore();
  const idx = store.invites.findIndex((i) => i.id === id);
  if (idx === -1) {
    const err = new Error('Invite not found');
    err.status = 404;
    throw err;
  }
  if (store.invites[idx].status === 'pending') {
    store.invites[idx].status = 'revoked';
    writeStore(store);
  }
  return publicInvite(store.invites[idx]);
}

/** Refresh a pending invite token so the commissioner can resend / copy a new link. */
function refreshInvite(id, invitedBy) {
  const store = readStore();
  const idx = store.invites.findIndex((i) => i.id === id);
  if (idx === -1) {
    const err = new Error('Invite not found');
    err.status = 404;
    throw err;
  }
  const invite = store.invites[idx];
  if (invite.status !== 'pending') {
    const err = new Error('Only pending invites can be resent');
    err.status = 400;
    throw err;
  }
  if (Date.parse(invite.expiresAt) < Date.now()) {
    invite.status = 'expired';
    writeStore(store);
    const err = new Error('Invite has expired — create a new one');
    err.status = 400;
    throw err;
  }

  const token = crypto.randomBytes(24).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  invite.tokenHash = tokenHash;
  invite.expiresAt = new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  if (invitedBy) {
    invite.invitedById = invitedBy.id || invite.invitedById;
    invite.invitedByName = invitedBy.name || invitedBy.loginName || invite.invitedByName;
  }
  writeStore(store);
  return { invite: publicInvite(invite), token };
}

module.exports = {
  listInvites,
  createInvite,
  findByToken,
  acceptInvite,
  revokeInvite,
  refreshInvite,
  publicInvite
};
