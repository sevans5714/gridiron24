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

const CONFERENCE_KEYS = new Set(['detail', 'overtime', 'aaa']);

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

const EMAIL_TAKEN_MESSAGE = 'That email already has an account. Sign in instead.';

function normalizeEmail(email) {
  return String(email || '')
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, '')
    .toLowerCase();
}

function emailTaken(email, exceptUserId = null) {
  const key = normalizeEmail(email);
  if (!key) return false;
  return readStore().users.some(
    (u) => normalizeEmail(u.email) === key && (!exceptUserId || u.id !== exceptUserId)
  );
}

function assertEmailAvailable(email, exceptUserId = null) {
  if (emailTaken(email, exceptUserId)) {
    throw Object.assign(new Error(EMAIL_TAKEN_MESSAGE), { status: 409, code: 'email_taken' });
  }
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

/** Find the existing conference admin for a conference (optional exceptUserId). */
function findConferenceAdmin(store, conferenceKey, exceptUserId = null) {
  const key = normalizeConference(conferenceKey);
  if (!key) return null;
  return store.users.find((user) => {
    if (exceptUserId && user.id === exceptUserId) return false;
    return normalizeRole(user.role) === ROLES.CONFERENCE_ADMIN
      && normalizeConference(user.conference) === key;
  }) || null;
}

/** Demote any other conference admins for this conference to member. Returns demoted public users. */
function clearOtherConferenceAdmins(store, conferenceKey, exceptUserId = null) {
  const key = normalizeConference(conferenceKey);
  if (!key) return [];
  const demoted = [];
  for (const user of store.users) {
    if (exceptUserId && user.id === exceptUserId) continue;
    if (normalizeRole(user.role) !== ROLES.CONFERENCE_ADMIN) continue;
    if (normalizeConference(user.conference) !== key) continue;
    demoted.push(publicUser({ ...user }));
    user.role = ROLES.USER;
    user.conference = null;
  }
  return demoted;
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
  const siteOwner = Boolean(user.siteOwner);
  const loungeMember = Boolean(user.loungeMember);
  const loungeToken = Boolean(user.loungeToken);
  // Social accounts: lounge admission without franchise / HQ access.
  const loungeOnly = Boolean(user.loungeOnly) && !siteOwner && role === ROLES.USER;
  let membershipLeague = normalizeMembershipLeague(user.membershipLeague);
  if (membershipLeague === 'aaa' && (siteOwner || isOwnerLogin(user))) {
    membershipLeague = 'gridiron';
  }
  if (membershipLeague === 'aaa' && isAaaAdminAlt(user)) {
    membershipLeague = null;
  }
  if (!membershipLeague && !loungeOnly && (siteOwner || role === ROLES.COMMISSIONER)) {
    membershipLeague = 'gridiron';
  }
  let hqConference = null;
  if (!loungeOnly && membershipLeague === 'gridiron') {
    if (role === ROLES.CONFERENCE_ADMIN) {
      const adminConf = normalizeConference(user.conference);
      if (adminConf === 'detail' || adminConf === 'overtime') hqConference = adminConf;
    }
    if (!hqConference) hqConference = normalizeHqConference(user.hqConference);
  }
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    loginName: user.loginName,
    role,
    conference: role === ROLES.CONFERENCE_ADMIN ? normalizeConference(user.conference) : null,
    leagueId: user.leagueId || null,
    leagueOwner: Boolean(user.leagueOwner),
    siteOwner,
    canSwitchLeagues: siteOwner,
    approved,
    loungeMember,
    loungeToken,
    loungeTokenGrantedAt: user.loungeTokenGrantedAt || null,
    loungeOnly,
    accountType: loungeOnly ? 'social' : 'member',
    theme: normalizeTheme(user.theme),
    bio: String(user.bio || '').trim() || null,
    membershipLeague,
    hqConference,
    duesPaid: Boolean(user.duesPaid),
    duesPaidAt: user.duesPaidAt || null,
    createdAt: user.createdAt || null,
    approvedAt: user.approvedAt || null,
    welcomeMailSentAt: user.welcomeMailSentAt || null
  };
}

function normalizeMembershipLeague(league) {
  const key = String(league || '').trim().toLowerCase();
  if (key === 'gridiron' || key === 'gridiron24' || key === 'gi24') return 'gridiron';
  if (key === 'aaa') return 'aaa';
  return null;
}

/** Welcome / access bucket: social | aaa | gridiron */
function normalizeMembershipKind(raw, user = null) {
  const key = String(raw || '').trim().toLowerCase();
  if (key === 'social' || key === 'lounge' || key === 'lounge_only') return 'social';
  if (key === 'aaa') return 'aaa';
  if (key === 'gridiron' || key === 'gridiron24' || key === 'gi24') return 'gridiron';
  if (user) {
    if (isLoungeOnly(user)) return 'social';
    if (isOwnerLogin(user) || isAaaAdminAlt(user)) return 'gridiron';
    const league = normalizeMembershipLeague(user.membershipLeague);
    if (league === 'aaa') return 'aaa';
  }
  return 'gridiron';
}

function membershipKindOf(user) {
  return normalizeMembershipKind(null, user);
}

function siteOwnerLogin() {
  return normalizeLoginName(process.env.SITE_OWNER_LOGIN || process.env.COMMISSIONER_LOGIN || 'sevans');
}

function aaaAdminLogin() {
  return normalizeLoginName(process.env.AAA_ADMIN_LOGIN || `${siteOwnerLogin()}-aaa`);
}

function isOwnerLogin(user) {
  if (!user) return false;
  if (isSiteOwner(user)) return true;
  return normalizeLoginName(user.loginName) === siteOwnerLogin();
}

function isAaaAdminAlt(user) {
  return Boolean(user) && normalizeLoginName(user.loginName) === aaaAdminLogin();
}

/** HQ roster league: explicit assignment, else site owner / commissioner → GridIron 24. */
function hqMembershipOf(user) {
  if (!user || user.approved === false) return null;
  if (isLoungeOnly(user)) return null;
  if (isOwnerLogin(user)) {
    const explicit = normalizeMembershipLeague(user.membershipLeague);
    return explicit === 'aaa' ? 'gridiron' : (explicit || 'gridiron');
  }
  if (isAaaAdminAlt(user)) {
    const explicit = normalizeMembershipLeague(user.membershipLeague);
    return explicit === 'gridiron' ? 'gridiron' : null;
  }
  return normalizeMembershipLeague(user.membershipLeague);
}

function membershipKindLabel(kind) {
  if (kind === 'social') return 'Social Membership';
  if (kind === 'aaa') return 'AAA League';
  return 'GridIron 24';
}

const LEAGUE_MEMBERSHIP_CAPS = {
  gridiron: 24,
  aaa: 12
};

const GRIDIRON_CONFERENCE_CAP = 12;
const GRIDIRON_CONFERENCE_KEYS = new Set(['detail', 'overtime']);

function normalizeHqConference(value) {
  const key = String(value || '').trim().toLowerCase();
  return GRIDIRON_CONFERENCE_KEYS.has(key) ? key : null;
}

/** Detail / Overtime assignment for a GridIron 24 member. */
function hqConferenceOf(user) {
  if (!user || user.approved === false) return null;
  if (isLoungeOnly(user)) return null;
  if (hqMembershipOf(user) !== 'gridiron') return null;
  if (normalizeRole(user.role) === ROLES.CONFERENCE_ADMIN) {
    const adminConf = normalizeConference(user.conference);
    if (GRIDIRON_CONFERENCE_KEYS.has(adminConf)) return adminConf;
  }
  return normalizeHqConference(user.hqConference);
}

function countHqConference(store, conferenceKey, exceptUserId = null) {
  const key = normalizeHqConference(conferenceKey);
  if (!key) return 0;
  return store.users.filter((u) => {
    if (exceptUserId && u.id === exceptUserId) return false;
    return hqConferenceOf(u) === key;
  }).length;
}

function hqConferenceLabel(key) {
  if (key === 'detail') return 'Detail';
  if (key === 'overtime') return 'Overtime';
  return null;
}

function membershipCap(league) {
  return LEAGUE_MEMBERSHIP_CAPS[normalizeMembershipLeague(league)] || 0;
}

function countMembership(store, league, exceptUserId = null) {
  const key = normalizeMembershipLeague(league);
  if (!key) return 0;
  return store.users.filter((u) => {
    if (exceptUserId && u.id === exceptUserId) return false;
    return hqMembershipOf(u) === key;
  }).length;
}

/**
 * Assign / update league membership, display name, and dues.
 * league: 'gridiron' | 'aaa' | null (clear)
 */
function setLeagueMembership(userId, patch = {}) {
  const store = readStore();
  const idx = store.users.findIndex((u) => u.id === userId);
  if (idx === -1) {
    throw Object.assign(new Error('Account not found'), { status: 404 });
  }
  const user = store.users[idx];
  if (user.approved === false) {
    throw Object.assign(new Error('Approve the account before assigning a league'), { status: 400 });
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'league')) {
    const raw = patch.league;
    const nextLeague = raw === '' || raw == null ? null : normalizeMembershipLeague(raw);
    if (raw != null && raw !== '' && !nextLeague) {
      throw Object.assign(new Error('League must be GridIron 24 or AAA'), { status: 400 });
    }
    if (nextLeague === 'aaa' && (isSiteOwner(user) || isOwnerLogin(user) || isAaaAdminAlt(user))) {
      throw Object.assign(new Error('Site owner stays on GridIron 24 — not AAA'), { status: 400 });
    }
    if (nextLeague) {
      const cap = membershipCap(nextLeague);
      const current = normalizeMembershipLeague(user.membershipLeague);
      if (current !== nextLeague && countMembership(store, nextLeague, userId) >= cap) {
        throw Object.assign(
          new Error(`${nextLeague === 'aaa' ? 'AAA' : 'GridIron 24'} is full (${cap} members).`),
          { status: 409 }
        );
      }
    }
    user.membershipLeague = nextLeague;
    if (!nextLeague || nextLeague === 'aaa') {
      user.hqConference = null;
    }
    if (!nextLeague) {
      user.duesPaid = false;
      user.duesPaidAt = null;
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'hqConference')) {
    const nextConf = patch.hqConference === '' || patch.hqConference == null
      ? null
      : normalizeHqConference(patch.hqConference);
    if (patch.hqConference != null && patch.hqConference !== '' && !nextConf) {
      throw Object.assign(new Error('Conference must be Detail or Overtime'), { status: 400 });
    }
    if (nextConf && hqMembershipOf(user) !== 'gridiron') {
      throw Object.assign(new Error('Assign GridIron 24 membership before a conference'), { status: 400 });
    }
    if (nextConf) {
      const current = hqConferenceOf(user);
      if (current !== nextConf && countHqConference(store, nextConf, userId) >= GRIDIRON_CONFERENCE_CAP) {
        throw Object.assign(
          new Error(`${hqConferenceLabel(nextConf)} Conference is full (${GRIDIRON_CONFERENCE_CAP} members).`),
          { status: 409 }
        );
      }
    }
    user.hqConference = nextConf;
  }

  if (typeof patch.name === 'string') {
    const nextName = patch.name.trim();
    if (!nextName) {
      throw Object.assign(new Error('Name is required'), { status: 400 });
    }
    if (nextName.length > 80) {
      throw Object.assign(new Error('Name is too long'), { status: 400 });
    }
    user.name = nextName;
  }

  if (patch.clearDues) {
    user.duesPaid = false;
    user.duesPaidAt = null;
  } else if (typeof patch.duesPaid === 'boolean') {
    user.duesPaid = patch.duesPaid;
    user.duesPaidAt = patch.duesPaid ? (user.duesPaidAt || new Date().toISOString()) : null;
  }

  writeStore(store);
  return publicUser(user);
}

function syncHqConferenceFromClaims(claims) {
  const store = readStore();
  let changed = false;
  const byUser = new Map((claims || []).map((c) => [c.userId, c]));
  for (const user of store.users) {
    if (hqMembershipOf(user) !== 'gridiron') continue;
    const claim = byUser.get(user.id);
    const fromClaim = normalizeHqConference(claim?.conferenceKey);
    if (fromClaim && user.hqConference !== fromClaim) {
      user.hqConference = fromClaim;
      changed = true;
    }
  }
  if (changed) writeStore(store);
  return changed;
}

function preferRollMember(a, b) {
  const rank = (u) => {
    if (u?.siteOwner) return 0;
    if (u?.role === ROLES.COMMISSIONER) return 1;
    if (u?.role === ROLES.CONFERENCE_ADMIN) return 2;
    return 3;
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra < rb ? a : b;
  return String(a?.loginName || '').localeCompare(String(b?.loginName || '')) <= 0 ? a : b;
}

/** One row per display name on the lounge roll (alt accounts share a name). */
function dedupeRollByName(list) {
  const map = new Map();
  for (const m of list) {
    const key = String(m?.name || '').trim().toLowerCase();
    if (!key) continue;
    const prev = map.get(key);
    map.set(key, prev ? preferRollMember(prev, m) : m);
  }
  return [...map.values()].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

function listLeagueMembers() {
  const store = readStore();
  // Lounge roll = accounts admitted by commissioner invite token (loungeMember).
  // League assignment (GridIron / AAA) is optional and unrelated to lounge entry.
  const lounge = dedupeRollByName(
    store.users
      .map(publicUser)
      .filter((u) => u.loungeMember)
  );

  const byLeague = (key) => lounge.filter((u) => hqMembershipOf(u) === key);
  const unassigned = lounge.filter((u) => !hqMembershipOf(u));

  return {
    members: lounge,
    gridiron: byLeague('gridiron'),
    aaa: byLeague('aaa'),
    unassigned,
    caps: { ...LEAGUE_MEMBERSHIP_CAPS }
  };
}

function isLoungeOpenToMembers() {
  const v = String(process.env.LOUNGE_OPEN || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function hasLoungeAccess(user) {
  if (!user) return false;
  if (user.siteOwner) return true;
  // Soft-launch pass: individually granted lounge tokens work even before LOUNGE_OPEN.
  if (user.loungeToken) return true;
  if (!isLoungeOpenToMembers()) return false;
  if (typeof user.loungeMember === 'boolean') return Boolean(user.loungeMember);
  return Boolean(publicUser(user)?.loungeMember);
}

/**
 * Grant or revoke an individual Members Lounge soft-launch token.
 * Distinct from loungeMember (legacy admission flag) so the lounge can stay
 * closed to the league while selected accounts are waved in.
 */
function setLoungeToken(userId, granted, actorId = null) {
  const store = readStore();
  const idx = store.users.findIndex((u) => u.id === userId);
  if (idx === -1) throw Object.assign(new Error('User not found'), { status: 404 });
  const target = store.users[idx];
  if (target.siteOwner) {
    throw Object.assign(new Error('Owner already has lounge access'), { status: 400 });
  }
  if (target.approved === false) {
    throw Object.assign(new Error('Approve the account before granting a lounge token'), { status: 400 });
  }
  const next = Boolean(granted);
  const prev = Boolean(target.loungeToken);
  store.users[idx].loungeToken = next;
  if (next) {
    store.users[idx].loungeMember = true;
    store.users[idx].loungeTokenGrantedAt = new Date().toISOString();
    store.users[idx].loungeTokenGrantedBy = actorId || null;
  } else {
    store.users[idx].loungeTokenGrantedAt = null;
    store.users[idx].loungeTokenGrantedBy = null;
  }
  writeStore(store);
  return {
    user: publicUser(store.users[idx]),
    changed: prev !== next,
    granted: next
  };
}

/** Social / lounge-only accounts — Members Lounge desk, no league HQ. */
function isLoungeOnly(user) {
  if (!user) return false;
  if (user.siteOwner) return false;
  const role = normalizeRole(user.role);
  if (role !== ROLES.USER) return false;
  if (typeof user.loungeOnly === 'boolean') return user.loungeOnly;
  return Boolean(publicUser(user)?.loungeOnly);
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
      const aRank = a.siteOwner ? -1 : (rank[a.role] ?? 9);
      const bRank = b.siteOwner ? -1 : (rank[b.role] ?? 9);
      const roleDiff = aRank - bRank;
      if (roleDiff !== 0) return roleDiff;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
}

function isSiteOwner(user) {
  return Boolean(user?.siteOwner);
}

function isStaff(user) {
  const role = normalizeRole(user?.role);
  return role === ROLES.COMMISSIONER || role === ROLES.CONFERENCE_ADMIN || isSiteOwner(user);
}

/** Who may compose / broadcast inbox messages (not system automations). */
function canSendInbox(user) {
  return isStaff(user);
}

/** Platform-wide ops: commissioners and the site owner. */
function isCommissioner(user) {
  return normalizeRole(user?.role) === ROLES.COMMISSIONER || isSiteOwner(user);
}

function createUser({ name, email, loginName, password, role, conference, approved, loungeMember, loungeOnly, leagueId, leagueOwner }) {
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
    throw Object.assign(new Error(EMAIL_TAKEN_MESSAGE), { status: 409, code: 'email_taken' });
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
  // Invite token can mark lounge eligibility, but new signups still wait for approval.
  const finalLoungeMember = isCommissionerAccount || loungeMember === true;
  const finalApproved = isCommissionerAccount || approved === true;
  // Social invites: lounge-only. Never apply to staff / owner accounts.
  const finalLoungeOnly =
    Boolean(loungeOnly) && !isCommissionerAccount && nextRole === ROLES.USER;

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
    loungeMember: finalLoungeMember || finalLoungeOnly,
    loungeOnly: finalLoungeOnly,
    passwordSalt: salt,
    passwordHash: hash,
    createdAt: new Date().toISOString(),
    resetTokenHash: null,
    resetTokenExpires: null
  };
  if (nextRole === ROLES.CONFERENCE_ADMIN && nextConference) {
    const existing = findConferenceAdmin(store, nextConference, null);
    if (existing) {
      const label = existing.name || existing.loginName || 'another member';
      throw Object.assign(
        new Error(
          `${label} is already the ${nextConference} conference admin. Set them to Member first, then assign the new admin.`
        ),
        { status: 409, code: 'conference_admin_taken' }
      );
    }
  }
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
    const existing = findConferenceAdmin(store, nextConference, userId);
    if (existing) {
      const label = existing.name || existing.loginName || 'another member';
      throw Object.assign(
        new Error(
          `${label} is already the ${nextConference} conference admin. Set them to Member first, then assign the new admin.`
        ),
        { status: 409, code: 'conference_admin_taken', existingAdmin: publicUser(existing) }
      );
    }
  }

  // Keep at least one commissioner if demoting — site owner covers platform ops.
  if (
    normalizeRole(store.users[idx].role) === ROLES.COMMISSIONER &&
    nextRole !== ROLES.COMMISSIONER
  ) {
    const otherCommissioners = store.users.filter(
      (u, i) => i !== idx && normalizeRole(u.role) === ROLES.COMMISSIONER
    );
    const ownerCovers = Boolean(store.users[idx].siteOwner)
      || store.users.some((u, i) => i !== idx && u.siteOwner);
    if (otherCommissioners.length === 0 && !ownerCovers) {
      throw Object.assign(new Error('Cannot remove the last commissioner'), { status: 400 });
    }
  }

  store.users[idx].role = nextRole;
  store.users[idx].conference = nextConference;
  if (nextRole === ROLES.COMMISSIONER) {
    store.users[idx].approved = true;
    store.users[idx].approvedAt = store.users[idx].approvedAt || new Date().toISOString();
    store.users[idx].loungeMember = true;
  }
  // Staff roles are full members — clear social restriction.
  if (nextRole !== ROLES.USER) {
    store.users[idx].loungeOnly = false;
  }
  writeStore(store);
  return {
    user: publicUser(store.users[idx]),
    previousConferenceAdmins: []
  };
}

/**
 * Toggle social (lounge-only) access. Social accounts keep lounge admission
 * but cannot use franchise HQ / league tools.
 */
function setLoungeOnly(userId, loungeOnly, actorId = null) {
  const store = readStore();
  const idx = store.users.findIndex((u) => u.id === userId);
  if (idx === -1) throw Object.assign(new Error('User not found'), { status: 404 });
  if (userId === actorId) {
    throw Object.assign(new Error('You cannot change your own social access here'), { status: 400 });
  }
  const target = store.users[idx];
  if (target.siteOwner) {
    throw Object.assign(new Error('Site owner cannot be a social account'), { status: 400 });
  }
  const role = normalizeRole(target.role);
  if (loungeOnly && role !== ROLES.USER) {
    throw Object.assign(new Error('Demote to User before marking as social (lounge only)'), { status: 400 });
  }
  store.users[idx].loungeOnly = Boolean(loungeOnly);
  if (loungeOnly) {
    store.users[idx].loungeMember = true;
    store.users[idx].approved = true;
    store.users[idx].approvedAt = store.users[idx].approvedAt || new Date().toISOString();
    store.users[idx].membershipLeague = null;
    store.users[idx].hqConference = null;
  }
  writeStore(store);
  return publicUser(store.users[idx]);
}

function setUserApproved(userId, approved, actorId = null, options = {}) {
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
  // Approving unlocks the account; league / social / lounge pass are assigned after.
  if (approved) {
    store.users[idx].loungeMember = true;
    const hasMembership = Object.prototype.hasOwnProperty.call(options, 'membership')
      || Object.prototype.hasOwnProperty.call(options, 'kind');
    if (hasMembership) {
      const kind = normalizeMembershipKind(options.membership || options.kind, store.users[idx]);
      if (kind === 'social') {
        store.users[idx].loungeOnly = true;
        store.users[idx].membershipLeague = null;
      } else {
        store.users[idx].loungeOnly = false;
        store.users[idx].membershipLeague = kind === 'aaa' ? 'aaa' : 'gridiron';
      }
    }
  }
  writeStore(store);
  return publicUser(store.users[idx]);
}

function markWelcomeMailSent(userId) {
  const store = readStore();
  const idx = store.users.findIndex((u) => u.id === userId);
  if (idx === -1) throw Object.assign(new Error('User not found'), { status: 404 });
  store.users[idx].welcomeMailSentAt = new Date().toISOString();
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
  if (Boolean(target.siteOwner) || isOwnerLogin(target)) {
    throw Object.assign(new Error('Cannot delete the site owner'), { status: 400 });
  }
  if (normalizeRole(target.role) === ROLES.COMMISSIONER) {
    const otherCommissioners = store.users.filter(
      (u, i) => i !== idx && normalizeRole(u.role) === ROLES.COMMISSIONER
    );
    if (otherCommissioners.length === 0) {
      throw Object.assign(new Error('Cannot delete the last commissioner'), { status: 400 });
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
    // Lounge access is invite-token admission. Preserve existing members; staff always in.
    if (user.loungeMember === undefined || user.loungeMember === null) {
      const isStaffUser = normalizeRole(user.role) === ROLES.COMMISSIONER
        || Boolean(user.siteOwner)
        || normalizeRole(user.role) === ROLES.CONFERENCE_ADMIN;
      user.loungeMember = isStaffUser || user.approved !== false;
      changed = true;
    }
  }
  // One conference admin per conference — keep the earliest account, demote the rest.
  const keepers = new Map();
  const admins = store.users
    .filter((u) => normalizeRole(u.role) === ROLES.CONFERENCE_ADMIN && normalizeConference(u.conference))
    .slice()
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  for (const user of admins) {
    const key = normalizeConference(user.conference);
    if (keepers.has(key)) {
      user.role = ROLES.USER;
      user.conference = null;
      changed = true;
    } else {
      keepers.set(key, user.id);
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
 * Free Render disks wipe users.json on every deploy. Recreate owner admin
 * accounts from env (with safe defaults) whenever those logins are missing.
 *
 * GridIron 24 overall commissioner: COMMISSIONER_LOGIN (default sevans)
 * AAA League Admin: AAA_ADMIN_LOGIN (default sevans-aaa)
 */
function syncBootstrapPassword(store, idx, password) {
  const { salt, hash } = hashPassword(password);
  store.users[idx].passwordSalt = salt;
  store.users[idx].passwordHash = hash;
  store.users[idx].approved = true;
  store.users[idx].approvedAt = store.users[idx].approvedAt || new Date().toISOString();
}

/**
 * Site owner (default login: sevans) — platform owner with league switching.
 * Not labeled "commissioner"; retains commissioner-level tools via siteOwner flag.
 */
function ensureBootstrapCommissioner() {
  if (!process.env.COMMISSIONER_LOGIN && !process.env.SITE_OWNER_LOGIN) {
    process.env.COMMISSIONER_LOGIN = 'sevans';
  }
  const login = normalizeLoginName(process.env.SITE_OWNER_LOGIN || process.env.COMMISSIONER_LOGIN);
  const password = String(
    process.env.SITE_OWNER_PASSWORD
      || process.env.COMMISSIONER_PASSWORD
      || 'ChangeMe123!'
  );
  const email = normalizeEmail(
    process.env.SITE_OWNER_EMAIL || process.env.COMMISSIONER_EMAIL || 'sevans5714@gmail.com'
  );
  const name = String(
    process.env.SITE_OWNER_NAME || process.env.COMMISSIONER_NAME || 'Steve Evans'
  ).trim() || 'Steve Evans';

  const existing = findByLoginName(login);
  if (existing) {
    const store = readStore();
    const idx = store.users.findIndex((u) => normalizeLoginName(u.loginName) === login);
    if (idx !== -1) {
      if (process.env.SITE_OWNER_PASSWORD || process.env.COMMISSIONER_PASSWORD) {
        syncBootstrapPassword(store, idx, password);
      }
      // Owner account: siteOwner flag, not overall commissioner role.
      store.users[idx].siteOwner = true;
      store.users[idx].role = ROLES.USER;
      store.users[idx].conference = null;
      store.users[idx].approved = true;
      store.users[idx].approvedAt = store.users[idx].approvedAt || new Date().toISOString();
      store.users[idx].loungeMember = true;
      store.users[idx].loungeOnly = false;
      store.users[idx].membershipLeague = 'gridiron';
      writeStore(store);
      return publicUser(store.users[idx]);
    }
    return ensureCommissionerFromEnv() || publicUser(existing);
  }

  const emailOwner = findByEmail(email);
  if (emailOwner && normalizeLoginName(emailOwner.loginName) !== login) {
    console.warn(`Bootstrap site owner skipped: email ${email} belongs to ${emailOwner.loginName}`);
    return ensureCommissionerFromEnv();
  }

  try {
    const user = createUser({
      name,
      email,
      loginName: login,
      password,
      role: ROLES.USER,
      approved: true,
      loungeMember: true
    });
    const store = readStore();
    const idx = store.users.findIndex((u) => u.id === user.id);
    if (idx !== -1) {
      store.users[idx].siteOwner = true;
      store.users[idx].loungeMember = true;
      store.users[idx].loungeOnly = false;
      store.users[idx].membershipLeague = 'gridiron';
      writeStore(store);
      console.log(`Bootstrap GridIron 24 site owner created: ${login}`);
      return publicUser(store.users[idx]);
    }
    return user;
  } catch (err) {
    console.warn(`Bootstrap site owner failed: ${err.message}`);
    return ensureCommissionerFromEnv();
  }
}

function ensureBootstrapAaaAdmin() {
  if (!process.env.AAA_ADMIN_LOGIN) {
    process.env.AAA_ADMIN_LOGIN = 'sevans-aaa';
  }
  const login = normalizeLoginName(process.env.AAA_ADMIN_LOGIN);
  const password = String(
    process.env.AAA_ADMIN_PASSWORD
      || process.env.COMMISSIONER_PASSWORD
      || 'ChangeMe123!'
  );
  const email = normalizeEmail(process.env.AAA_ADMIN_EMAIL || 'sevans5714+aaa@gmail.com');
  const name = String(process.env.AAA_ADMIN_NAME || 'Steve Evans').trim() || 'Steve Evans';
  const conference = 'aaa';

  // Claim AAA admin slot for this bootstrap login.
  // Never demote the site owner login to a plain member — restore owner instead.
  const store0 = readStore();
  const otherAdmin = findConferenceAdmin(store0, conference);
  const ownerLogin = normalizeLoginName(
    process.env.SITE_OWNER_LOGIN || process.env.COMMISSIONER_LOGIN || 'sevans'
  );
  if (otherAdmin && normalizeLoginName(otherAdmin.loginName) !== login) {
    const idx = store0.users.findIndex((u) => u.id === otherAdmin.id);
    if (idx !== -1) {
      const otherLogin = normalizeLoginName(store0.users[idx].loginName);
      if (otherLogin === ownerLogin || store0.users[idx].siteOwner) {
        store0.users[idx].siteOwner = true;
        store0.users[idx].role = ROLES.USER;
        store0.users[idx].conference = null;
      } else {
        store0.users[idx].role = ROLES.USER;
        store0.users[idx].conference = null;
      }
      writeStore(store0);
      console.warn(`Bootstrap AAA admin: cleared AAA admin from ${otherAdmin.loginName} so ${login} can own AAA`);
    }
  }

  const existing = findByLoginName(login);
  if (existing) {
    const store = readStore();
    const idx = store.users.findIndex((u) => normalizeLoginName(u.loginName) === login);
    if (idx === -1) return publicUser(existing);
    if (process.env.AAA_ADMIN_PASSWORD || process.env.COMMISSIONER_PASSWORD) {
      syncBootstrapPassword(store, idx, password);
    }
    store.users[idx].role = ROLES.CONFERENCE_ADMIN;
    store.users[idx].conference = conference;
    store.users[idx].approved = true;
    store.users[idx].approvedAt = store.users[idx].approvedAt || new Date().toISOString();
    store.users[idx].membershipLeague = null;
    writeStore(store);
    console.log(`Bootstrap AAA league admin ready: ${login}`);
    return publicUser(store.users[idx]);
  }

  const emailOwner = findByEmail(email);
  if (emailOwner && normalizeLoginName(emailOwner.loginName) !== login) {
    console.warn(`Bootstrap AAA admin skipped: email ${email} belongs to ${emailOwner.loginName}`);
    return null;
  }

  try {
    const user = createUser({
      name,
      email,
      loginName: login,
      password,
      role: ROLES.CONFERENCE_ADMIN,
      conference,
      approved: true,
      loungeMember: true
    });
    const store = readStore();
    const idx = store.users.findIndex((u) => u.id === user.id);
    if (idx !== -1) {
      store.users[idx].membershipLeague = null;
      writeStore(store);
      console.log(`Bootstrap AAA league admin created: ${login}`);
      return publicUser(store.users[idx]);
    }
    console.log(`Bootstrap AAA league admin created: ${login}`);
    return user;
  } catch (err) {
    console.warn(`Bootstrap AAA admin failed: ${err.message}`);
    return null;
  }
}

function ensureBootstrapOwnerAccounts() {
  const commissioner = ensureBootstrapCommissioner();
  const aaaAdmin = ensureBootstrapAaaAdmin();
  return { commissioner, aaaAdmin };
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

/** Commissioner: set login name and/or password without knowing the current password. */
function adminSetCredentials(userId, { loginName, password } = {}) {
  const store = readStore();
  const idx = store.users.findIndex((u) => u.id === userId);
  if (idx === -1) {
    throw Object.assign(new Error('Account not found'), { status: 404 });
  }
  const user = store.users[idx];
  let changed = false;

  if (loginName != null && String(loginName).trim() !== '') {
    const loginKey = normalizeLoginName(loginName);
    if (!loginKey || loginKey.length < 3) {
      throw Object.assign(new Error('Login name must be at least 3 characters'), { status: 400 });
    }
    if (loginKey.length > 40) {
      throw Object.assign(new Error('Login name is too long'), { status: 400 });
    }
    if (!/^[a-z0-9._-]+$/i.test(loginKey)) {
      throw Object.assign(new Error('Login name may only use letters, numbers, . _ -'), { status: 400 });
    }
    const taken = store.users.some(
      (u, i) => i !== idx && normalizeLoginName(u.loginName) === loginKey
    );
    if (taken) {
      throw Object.assign(new Error('That login name is already taken'), { status: 409 });
    }
    if (normalizeLoginName(user.loginName) !== loginKey) {
      user.loginName = loginKey;
      changed = true;
    }
  }

  if (password != null && String(password) !== '') {
    if (String(password).length < 6) {
      throw Object.assign(new Error('Password must be at least 6 characters'), { status: 400 });
    }
    const { salt, hash } = hashPassword(password);
    user.passwordSalt = salt;
    user.passwordHash = hash;
    user.resetTokenHash = null;
    user.resetTokenExpires = null;
    changed = true;
  }

  if (!changed) {
    throw Object.assign(new Error('Provide a new login name and/or password'), { status: 400 });
  }
  writeStore(store);
  return publicUser(user);
}

function setUserLeagueOwner(userId, leagueId, isOwner = true) {
  const store = readStore();
  const idx = store.users.findIndex((u) => u.id === userId);
  if (idx === -1) {
    throw Object.assign(new Error('Account not found'), { status: 404 });
  }
  store.users[idx].leagueId = leagueId || null;
  store.users[idx].leagueOwner = Boolean(isOwner && leagueId);
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

function updateProfile(userId, patch = {}) {
  const store = readStore();
  const idx = store.users.findIndex((u) => u.id === userId);
  if (idx === -1) {
    throw Object.assign(new Error('Account not found'), { status: 404 });
  }
  const user = store.users[idx];
  if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
    const nextName = String(patch.name || '').trim().replace(/\s+/g, ' ');
    if (!nextName) throw Object.assign(new Error('Name is required'), { status: 400 });
    if (nextName.length > 80) throw Object.assign(new Error('Name is too long'), { status: 400 });
    user.name = nextName;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'bio')) {
    const nextBio = String(patch.bio || '').trim();
    if (nextBio.length > 280) throw Object.assign(new Error('Bio must be 280 characters or less'), { status: 400 });
    user.bio = nextBio || null;
  }
  user.updatedAt = new Date().toISOString();
  writeStore(store);
  return publicUser(user);
}

/** Returns true once — marks welcome as sent so it only fires on first login. */
function claimWelcomeInbox(userId) {
  if (!userId) return false;
  const store = readStore();
  const idx = store.users.findIndex((u) => u.id === userId);
  if (idx === -1) return false;
  if (store.users[idx].welcomeInboxSentAt) return false;
  store.users[idx].welcomeInboxSentAt = new Date().toISOString();
  writeStore(store);
  return true;
}

function hasReceivedWelcomeInbox(userId) {
  if (!userId) return false;
  const user = findById(userId);
  return Boolean(user?.welcomeInboxSentAt);
}

module.exports = {
  DATA_DIR,
  ROLES,
  CONFERENCE_KEYS,
  LEAGUE_MEMBERSHIP_CAPS,
  GRIDIRON_CONFERENCE_CAP,
  setAllowedConferenceKeys,
  getAllowedConferenceKeys,
  EMAIL_TAKEN_MESSAGE,
  normalizeEmail,
  emailTaken,
  assertEmailAvailable,
  createUser,
  authenticate,
  createResetToken,
  resetPasswordWithToken,
  changePassword,
  adminSetCredentials,
  updatePreferences,
  updateProfile,
  setUserLeagueOwner,
  claimWelcomeInbox,
  hasReceivedWelcomeInbox,
  findById,
  findByEmail,
  listUsers,
  isStaff,
  canSendInbox,
  isCommissioner,
  isSiteOwner,
  setUserRole,
  setUserApproved,
  markWelcomeMailSent,
  deleteUser,
  setLeagueMembership,
  listLeagueMembers,
  hasLoungeAccess,
  isLoungeOpenToMembers,
  isLoungeOnly,
  setLoungeOnly,
  setLoungeToken,
  normalizeMembershipLeague,
  normalizeMembershipKind,
  membershipKindOf,
  hqMembershipOf,
  hqConferenceOf,
  normalizeHqConference,
  hqConferenceLabel,
  syncHqConferenceFromClaims,
  membershipKindLabel,
  migrateApprovalFlags,
  ensureCommissionerFromEnv,
  ensureBootstrapCommissioner,
  ensureBootstrapAaaAdmin,
  ensureBootstrapOwnerAccounts,
  publicUser
};
