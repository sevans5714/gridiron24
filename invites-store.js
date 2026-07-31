const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const INVITES_FILE = path.join(DATA_DIR, 'invites.json');

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

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function ensureInviteToken(invite) {
  if (invite.token) {
    if (!invite.tokenHash) invite.tokenHash = hashToken(invite.token);
    return invite.token;
  }
  // Only mint when no plaintext token is stored. Prefer keeping an existing hash
  // so previously emailed links keep working when we are not resending.
  const token = makeToken();
  invite.token = token;
  invite.tokenHash = hashToken(token);
  return token;
}

function publicInvite(invite) {
  if (!invite) return null;
  return {
    id: invite.id,
    email: invite.email,
    status: invite.status,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt || null,
    acceptedAt: invite.acceptedAt || null,
    invitedByName: invite.invitedByName || null,
    loungeOnly: Boolean(invite.loungeOnly),
    accountType: invite.loungeOnly ? 'social' : 'member'
  };
}

function listInvites() {
  const store = readStore();
  // Revive invites that were auto-marked expired — links stay valid until used or revoked.
  let changed = false;
  for (const invite of store.invites) {
    if (invite.status === 'expired') {
      invite.status = 'pending';
      invite.expiresAt = null;
      changed = true;
    }
  }
  if (changed) writeStore(store);
  return store.invites
    .map(publicInvite)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function createInvite({ email, invitedBy, loungeOnly }) {
  const emailKey = normalizeEmail(email);
  if (!emailKey || !emailKey.includes('@')) {
    const err = new Error('Enter a valid email address');
    err.status = 400;
    throw err;
  }

  const social = Boolean(loungeOnly);
  const store = readStore();
  const existingOpen = store.invites.find(
    (i) => i.email === emailKey && (i.status === 'pending' || i.status === 'expired')
  );
  if (existingOpen) {
    const err = new Error(
      'An invite is already pending for that email. Use Resend if you need to send it again.'
    );
    err.status = 409;
    throw err;
  }
  const alreadyAccepted = store.invites.find(
    (i) => i.email === emailKey && i.status === 'accepted'
  );
  if (alreadyAccepted) {
    const err = new Error('That email already accepted an invite.');
    err.status = 409;
    throw err;
  }

  const token = makeToken();
  const invite = {
    id: crypto.randomUUID(),
    email: emailKey,
    token,
    tokenHash: hashToken(token),
    status: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt: null,
    acceptedAt: null,
    invitedById: invitedBy?.id || null,
    invitedByName: invitedBy?.name || invitedBy?.loginName || null,
    loungeOnly: social
  };
  store.invites.unshift(invite);
  writeStore(store);
  return { invite: publicInvite(invite), token };
}

function findByToken(token) {
  const raw = String(token || '').trim();
  if (!raw) return null;
  const hash = hashToken(raw);
  const store = readStore();
  const invite = store.invites.find(
    (i) => i.tokenHash === hash || i.token === raw
  );
  if (!invite) return null;
  // Pending (and formerly expired) invites stay usable until accepted or revoked.
  if (invite.status === 'expired') {
    invite.status = 'pending';
    invite.expiresAt = null;
    writeStore(store);
  }
  if (invite.status !== 'pending') return null;
  return invite;
}

function acceptInvite(token, email) {
  const invite = findByToken(token);
  if (!invite) {
    const err = new Error('Invite link is invalid or was revoked');
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
  if (store.invites[idx].status === 'pending' || store.invites[idx].status === 'expired') {
    store.invites[idx].status = 'revoked';
    writeStore(store);
  }
  return publicInvite(store.invites[idx]);
}

/** Resend uses the same token so earlier emails keep working. */
function refreshInvite(id, invitedBy) {
  const store = readStore();
  const idx = store.invites.findIndex((i) => i.id === id);
  if (idx === -1) {
    const err = new Error('Invite not found');
    err.status = 404;
    throw err;
  }
  const invite = store.invites[idx];
  if (invite.status === 'accepted' || invite.status === 'revoked') {
    const err = new Error('Only open invites can be resent');
    err.status = 400;
    throw err;
  }
  invite.status = 'pending';
  invite.expiresAt = null;
  let token = invite.token || null;
  if (!token) {
    // Older invites may only have a hash — mint once and store so future resends stay stable.
    token = ensureInviteToken(invite);
  }
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
