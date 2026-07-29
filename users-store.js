const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const ROLES = {
  USER: 'user',
  CONFERENCE_ADMIN: 'conference_admin',
  COMMISSIONER: 'commissioner'
};

const CONFERENCE_KEYS = new Set(['detail', 'overtime']);

function setAllowedConferenceKeys(keys) {
  const next = (Array.isArray(keys) ? keys : [])
    .map((k) => String(k || '').trim().toLowerCase())
    .filter(Boolean);
  if (!next.length) return;
  CONFERENCE_KEYS.clear();
  for (const k of next) CONFERENCE_KEYS.add(k);
}

function getAllowedConferenceKeys() {
  return [...CONFERENCE_KEYS];
}

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.users)) return { users: [] };
    return data;
  } catch {
    return { users: [] };
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${USERS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, USERS_FILE);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeLoginName(loginName) {
  return String(loginName || '').trim().toLowerCase();
}

function normalizeRole(role) {
  const value = String(role || ROLES.USER).trim().toLowerCase();
  if (value === ROLES.COMMISSIONER) return ROLES.COMMISSIONER;
  if (value === ROLES.CONFERENCE_ADMIN) return ROLES.CONFERENCE_ADMIN;
  return ROLES.USER;
}

function normalizeConference(conference) {
  const key = String(conference || '').trim().toLowerCase();
  return CONFERENCE_KEYS.has(key) ? key : null;
}

function normalizeTheme(theme) {
  return String(theme || '').trim().toLowerCase() === 'day' ? 'day' : 'night';
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'));
  } catch {
    return false;
  }
}

function publicUser(user) {
  if (!user) return null;
  const role = normalizeRole(user.role);
  const approved = user.approved !== false;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    loginName: user.loginName,
    role,
    conference: role === ROLES.CONFERENCE_ADMIN ? normalizeConference(user.conference) : null,
    leagueId: user.leagueId || null,
    leagueOwner: Boolean(user.leagueOwner),
    approved,
    theme: normalizeTheme(user.theme),
    createdAt: user.createdAt || null,
    approvedAt: user.approvedAt || null
  };
}

function findByLoginName(loginName) {
  const key = normalizeLoginName(loginName);
  return readStore().users.find((u) => normalizeLoginName(u.loginName) === key) || null;
}

function findByEmail(email) {
  const key = normalizeEmail(email);
  return readStore().users.find((u) => normalizeEmail(u.email) === key) || null;
}

function findById(id) {
  return readStore().users.find((u) => u.id === id) || null;
}

function listUsers() {
  return readStore().users
    .map(publicUser)
    .sort((a, b) => {
      const rank = { commissioner: 0, conference_admin: 1, user: 2 };
      const roleDiff = (rank[a.role] ?? 9) - (rank[b.role] ?? 9);
      if (roleDiff !== 0) return roleDiff;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
}

function isStaff(user) {
  const role = normalizeRole(user?.role);
  return role === ROLES.COMMISSIONER || role === ROLES.CONFERENCE_ADMIN;
}

function isCommissioner(user) {
  return normalizeRole(user?.role) === ROLES.COMMISSIONER;
}

function createUser({ name, email, loginName, password, role, conference, approved, leagueId, leagueOwner }) {
  const store = readStore();
  const emailKey = normalizeEmail(email);
  const loginKey = normalizeLoginName(loginName);

  if (!name?.trim()) throw Object.assign(new Error('Name is required'), { status: 400 });
  if (!emailKey || !emailKey.includes('@')) {
    throw Object.assign(new Error('Valid email is required'), { status: 400 });
  }
  if (!loginKey || loginKey.length < 3) {
    throw Object.assign(new Error('Login name must be at least 3 characters'), { status: 400 });
  }
  if (!/^[a-z0-9._-]+$/i.test(loginKey)) {
    throw Object.assign(new Error('Login name can only use letters, numbers, . _ -'), { status: 400 });
  }
  if (!password || String(password).length < 6) {
    throw Object.assign(new Error('Password must be at least 6 characters'), { status: 400 });
  }
  if (store.users.some((u) => normalizeEmail(u.email) === emailKey)) {
    throw Object.assign(new Error('An account with that email already exists'), { status: 409 });
  }
  if (store.users.some((u) => normalizeLoginName(u.loginName) === loginKey)) {
    throw Object.assign(new Error('That login name is already taken'), { status: 409 });
  }

  let nextRole = normalizeRole(role);
  let nextConference = null;
  if (nextRole === ROLES.CONFERENCE_ADMIN) {
    nextConference = normalizeConference(conference);
    if (!nextConference) {
      throw Object.assign(new Error('Conference admin requires a valid conference'), { status: 400 });
    }
  }
  if (nextRole === ROLES.COMMISSIONER) nextConference = null;

  // Default new signups to user unless this is the designated commissioner login.
  const commissionerLogin = normalizeLoginName(process.env.COMMISSIONER_LOGIN || '');
  if (!role && commissionerLogin && loginKey === commissionerLogin) {
    nextRole = ROLES.COMMISSIONER;
    nextConference = null;
  }

  const isCommissionerAccount = nextRole === ROLES.COMMISSIONER;
  // Commissioners/bootstrap always approved. Invite signups wait for commissioner approval unless explicitly approved.
  const finalApproved = isCommissionerAccount || approved === true;

  const { salt, hash } = hashPassword(password);
  const user = {
    id: crypto.randomUUID(),
    name: String(name).trim(),
    email: emailKey,
    loginName: loginKey,
    role: nextRole,
    conference: nextConference,
    leagueId: leagueId || null,
    leagueOwner: Boolean(leagueOwner) || (isCommissionerAccount && Boolean(leagueId)),
    approved: finalApproved,
    approvedAt: finalApproved ? new Date().toISOString() : null,
    passwordSalt: salt,
    passwordHash: hash,
    createdAt: new Date().toISOString(),
    resetTokenHash: null,
    resetTokenExpires: null
  };
  store.users.push(user);
  writeStore(store);
  return publicUser(user);
}

function setUserRole(userId, role, conference) {
  const store = readStore();
  const idx = store.users.findIndex((u) => u.id === userId);
  if (idx === -1) throw Object.assign(new Error('User not found'), { status: 404 });

  const nextRole = normalizeRole(role);
  let nextConference = null;
  if (nextRole === ROLES.CONFERENCE_ADMIN) {
    nextConference = normalizeConference(conference);
    if (!nextConference) {
      throw Object.assign(new Error('Pick a conference for conference admin'), { status: 400 });
    }
  }

  // Keep at least one commissioner if demoting.
  if (
    normalizeRole(store.users[idx].role) === ROLES.COMMISSIONER &&
    nextRole !== ROLES.COMMISSIONER
  ) {
    const otherCommissioners = store.users.filter(
      (u, i) => i !== idx && normalizeRole(u.role) === ROLES.COMMISSIONER
    );
    if (otherCommissioners.length === 0) {
      throw Object.assign(new Error('Cannot remove the last commissioner'), { status: 400 });
    }
  }

  store.users[idx].role = nextRole;
  store.users[idx].conference = nextConference;
  if (nextRole === ROLES.COMMISSIONER) {
    store.users[idx].approved = true;
    store.users[idx].approvedAt = store.users[idx].approvedAt || new Date().toISOString();
  }
  writeStore(store);
  return publicUser(store.users[idx]);
}

function setUserApproved(userId, approved, actorId = null) {
  const store = readStore();
  const idx = store.users.findIndex((u) => u.id === userId);
  if (idx === -1) throw Object.assign(new Error('User not found'), { status: 404 });
  if (userId === actorId) {
    throw Object.assign(new Error('You cannot change your own approval status'), { status: 400 });
  }
  const target = store.users[idx];
  if (normalizeRole(target.role) === ROLES.COMMISSIONER && approved === false) {
    throw Object.assign(new Error('Cannot unapprove a commissioner'), { status: 400 });
  }
  store.users[idx].approved = Boolean(approved);
  store.users[idx].approvedAt = approved ? new Date().toISOString() : null;
  writeStore(store);
  return publicUser(store.users[idx]);
}

function deleteUser(userId, actorId = null) {
  const store = readStore();
  const idx = store.users.findIndex((u) => u.id === userId);
  if (idx === -1) throw Object.assign(new Error('User not found'), { status: 404 });
  if (userId === actorId) {
    throw Object.assign(new Error('You cannot delete your own account here'), { status: 400 });
  }
  const target = store.users[idx];
  if (normalizeRole(target.role) === ROLES.COMMISSIONER) {
    const otherCommissioners = store.users.filter(
      (u, i) => i !== idx && normalizeRole(u.role) === ROLES.COMMISSIONER
    );
    if (otherCommissioners.length === 0) {
      throw Object.assign(new Error('Cannot remove the last commissioner'), { status: 400 });
    }
  }
  const removed = store.users[idx];
  store.users.splice(idx, 1);
  writeStore(store);
  return publicUser(removed);
}

/** Existing accounts without an approved flag are treated as approved. */
function migrateApprovalFlags() {
  const store = readStore();
  let changed = false;
  for (const user of store.users) {
    if (user.approved === undefined || user.approved === null) {
      user.approved = true;
      user.approvedAt = user.approvedAt || user.createdAt || new Date().toISOString();
      changed = true;
    }
    if (normalizeRole(user.role) === ROLES.COMMISSIONER && user.approved !== true) {
      user.approved = true;
      user.approvedAt = user.approvedAt || new Date().toISOString();
      changed = true;
    }
  }
  if (changed) writeStore(store);
  return changed;
}

function ensureCommissionerFromEnv() {
  const login = normalizeLoginName(process.env.COMMISSIONER_LOGIN || '');
  if (!login) return null;
  const store = readStore();
  const idx = store.users.findIndex((u) => normalizeLoginName(u.loginName) === login);
  if (idx === -1) return null;
  if (normalizeRole(store.users[idx].role) === ROLES.COMMISSIONER) {
    return publicUser(store.users[idx]);
  }
  store.users[idx].role = ROLES.COMMISSIONER;
  store.users[idx].conference = null;
  writeStore(store);
  return publicUser(store.users[idx]);
}

/**
 * Free Render disks wipe users.json on every deploy. Recreate the commissioner
 * account from env (with safe defaults) whenever that login is missing.
 */
function ensureBootstrapCommissioner() {
  if (!process.env.COMMISSIONER_LOGIN) {
    process.env.COMMISSIONER_LOGIN = 'sevans';
  }
  const login = normalizeLoginName(process.env.COMMISSIONER_LOGIN);
  const password = String(process.env.COMMISSIONER_PASSWORD || 'ChangeMe123!');
  const email = normalizeEmail(process.env.COMMISSIONER_EMAIL || 'sevans5714@gmail.com');
  const name = String(process.env.COMMISSIONER_NAME || 'Steve Evans').trim() || 'Steve Evans';

  const existing = findByLoginName(login);
  if (existing) {
    // Keep password in sync when COMMISSIONER_PASSWORD is explicitly set in env.
    if (process.env.COMMISSIONER_PASSWORD) {
      const store = readStore();
      const idx = store.users.findIndex((u) => normalizeLoginName(u.loginName) === login);
      if (idx !== -1) {
        const { salt, hash } = hashPassword(password);
        store.users[idx].passwordSalt = salt;
        store.users[idx].passwordHash = hash;
        store.users[idx].role = ROLES.COMMISSIONER;
        store.users[idx].conference = null;
        writeStore(store);
        return publicUser(store.users[idx]);
      }
    }
    return ensureCommissionerFromEnv() || publicUser(existing);
  }

  const emailOwner = findByEmail(email);
  if (emailOwner && normalizeLoginName(emailOwner.loginName) !== login) {
    console.warn(`Bootstrap commissioner skipped: email ${email} belongs to ${emailOwner.loginName}`);
    return ensureCommissionerFromEnv();
  }

  try {
    const user = createUser({
      name,
      email,
      loginName: login,
      password,
      role: ROLES.COMMISSIONER,
      approved: true
    });
    console.log(`Bootstrap commissioner created: ${login}`);
    return user;
  } catch (err) {
    console.warn(`Bootstrap commissioner failed: ${err.message}`);
    return ensureCommissionerFromEnv();
  }
}

function authenticate(loginName, password) {
  const user = findByLoginName(loginName);
  if (!user) return null;
  if (!verifyPassword(password, user.passwordSalt, user.passwordHash)) return null;
  const pub = publicUser(user);
  if (!pub.approved) {
    const err = Object.assign(new Error('Your account is waiting for commissioner approval'), { status: 403, code: 'pending_approval' });
    err.user = pub;
    throw err;
  }
  return pub;
}

function createResetToken(email) {
  const store = readStore();
  const emailKey = normalizeEmail(email);
  const idx = store.users.findIndex((u) => normalizeEmail(u.email) === emailKey);
  if (idx === -1) return null;

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  store.users[idx].resetTokenHash = tokenHash;
  store.users[idx].resetTokenExpires = Date.now() + 60 * 60 * 1000; // 1 hour
  writeStore(store);
  return { token, user: publicUser(store.users[idx]) };
}

function resetPasswordWithToken(token, newPassword) {
  if (!token || !newPassword || String(newPassword).length < 6) {
    throw Object.assign(new Error('Password must be at least 6 characters'), { status: 400 });
  }
  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
  const store = readStore();
  const idx = store.users.findIndex(
    (u) => u.resetTokenHash && u.resetTokenHash === tokenHash && u.resetTokenExpires > Date.now()
  );
  if (idx === -1) {
    throw Object.assign(new Error('Reset link is invalid or expired'), { status: 400 });
  }
  const { salt, hash } = hashPassword(newPassword);
  store.users[idx].passwordSalt = salt;
  store.users[idx].passwordHash = hash;
  store.users[idx].resetTokenHash = null;
  store.users[idx].resetTokenExpires = null;
  writeStore(store);
  return publicUser(store.users[idx]);
}

function changePassword(userId, currentPassword, newPassword) {
  if (!newPassword || String(newPassword).length < 6) {
    throw Object.assign(new Error('Password must be at least 6 characters'), { status: 400 });
  }
  const store = readStore();
  const idx = store.users.findIndex((u) => u.id === userId);
  if (idx === -1) {
    throw Object.assign(new Error('Account not found'), { status: 404 });
  }
  const user = store.users[idx];
  if (!verifyPassword(currentPassword, user.passwordSalt, user.passwordHash)) {
    throw Object.assign(new Error('Current password is incorrect'), { status: 400 });
  }
  const { salt, hash } = hashPassword(newPassword);
  store.users[idx].passwordSalt = salt;
  store.users[idx].passwordHash = hash;
  store.users[idx].resetTokenHash = null;
  store.users[idx].resetTokenExpires = null;
  writeStore(store);
  return publicUser(store.users[idx]);
}

function updatePreferences(userId, prefs = {}) {
  const store = readStore();
  const idx = store.users.findIndex((u) => u.id === userId);
  if (idx === -1) {
    throw Object.assign(new Error('Account not found'), { status: 404 });
  }
  if (Object.prototype.hasOwnProperty.call(prefs, 'theme')) {
    store.users[idx].theme = normalizeTheme(prefs.theme);
  }
  writeStore(store);
  return publicUser(store.users[idx]);
}

module.exports = {
  DATA_DIR,
  ROLES,
  CONFERENCE_KEYS,
  setAllowedConferenceKeys,
  getAllowedConferenceKeys,
  createUser,
  authenticate,
  createResetToken,
  resetPasswordWithToken,
  changePassword,
  updatePreferences,
  findById,
  findByEmail,
  listUsers,
  setUserRole,
  setUserApproved,
  deleteUser,
  migrateApprovalFlags,
  ensureCommissionerFromEnv,
  ensureBootstrapCommissioner,
  isStaff,
  isCommissioner,
  publicUser
};
