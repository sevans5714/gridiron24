/**
 * Next-season conference draft: captains (league winner + runner-up) snake
 * remaining managers into Detail / Overtime (or an independent league’s two
 * conferences). Results stay pending until staff applies them — they do not
 * move this season’s seats.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const users = require('./users-store');
const logos = require('./logos-store');
const career = require('./career-store');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'conference-draft.json');
const JOIN_LOBBY_SECONDS = 240;
const GRIDIRON_CAP = 12;
const GRIDIRON_KEY = 'gridiron24';

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({ rooms: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { rooms: Array.isArray(data.rooms) ? data.rooms : [] };
  } catch {
    return { rooms: [] };
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ rooms: data.rooms || [] }, null, 2));
  fs.renameSync(tmp, FILE);
}

function err(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function snakeTeamIndex(overallZeroBased, teamCount) {
  const round = Math.floor(overallZeroBased / teamCount);
  const pos = overallZeroBased % teamCount;
  return round % 2 === 0 ? pos : teamCount - 1 - pos;
}

function lastSeasonYear(targetSeason) {
  const y = Number(targetSeason);
  return Number.isFinite(y) ? y - 1 : new Date().getFullYear();
}

function formatRecord(wins, losses, ties) {
  if (wins == null && losses == null) return '—';
  const w = Number(wins) || 0;
  const l = Number(losses) || 0;
  const t = Number(ties) || 0;
  return t ? `${w}-${l}-${t}` : `${w}-${l}`;
}

function lastYearLine(userId, targetSeason, leagueId = null) {
  const year = lastSeasonYear(targetSeason);
  const rows = career.listForUser(userId).filter((e) => Number(e.season) === year);
  let row = null;
  if (leagueId) {
    row = rows.find((e) => String(e.leagueId || '') === String(leagueId)) || null;
  }
  if (!row) {
    row = rows.find((e) => e.platform !== 'independent') || rows[0] || null;
  }
  if (!row) {
    return {
      lastSeason: year,
      teamName: '',
      wins: null,
      losses: null,
      ties: null,
      pointsFor: null,
      record: '—'
    };
  }
  return {
    lastSeason: year,
    teamName: row.teamName || '',
    wins: row.wins,
    losses: row.losses,
    ties: row.ties,
    pointsFor: row.pointsFor,
    record: formatRecord(row.wins, row.losses, row.ties)
  };
}

function gridironMembers() {
  return users.listUsers().filter((u) => {
    if (!u?.id || u.approved === false) return false;
    if (u.loungeOnly) return false;
    if (typeof users.occupiesLeagueSeat === 'function' && !users.occupiesLeagueSeat(u)) return false;
    return users.normalizeMembershipLeague(u.membershipLeague) === 'gridiron';
  });
}

function independentMembers(league) {
  const out = [];
  for (const f of league?.franchises || []) {
    if (!f?.managerUserId) continue;
    const u = users.findById(f.managerUserId);
    if (!u || u.approved === false) continue;
    out.push({
      userId: u.id,
      name: u.name || u.loginName || 'Manager',
      teamName: f.name || '',
      franchiseId: f.id
    });
  }
  return out;
}

function enrichMember(base, targetSeason, leagueId) {
  const stats = lastYearLine(base.userId, targetSeason, leagueId);
  const claim = logos.getClaimForUser(base.userId);
  return {
    userId: base.userId,
    name: base.name,
    franchiseId: base.franchiseId || null,
    teamName: base.teamName || stats.teamName || claim?.teamName || '',
    lastSeason: stats.lastSeason,
    wins: stats.wins,
    losses: stats.losses,
    ties: stats.ties,
    pointsFor: stats.pointsFor,
    record: stats.record
  };
}

function buildPool(room, league = null) {
  const targetSeason = room.targetSeason;
  if (room.scope === 'independent' && league) {
    return independentMembers(league).map((m) => enrichMember(m, targetSeason, league.id));
  }
  return gridironMembers().map((u) => enrichMember({
    userId: u.id,
    name: u.name || u.loginName || 'Member',
    teamName: logos.getClaimForUser(u.id)?.teamName || ''
  }, targetSeason, null));
}

function defaultConferences(scope, league = null) {
  if (scope === 'independent' && league) {
    const confs = (league.conferences || []).slice(0, 2);
    if (confs.length < 2) return [];
    const cap = Number(league.structure?.teamsPerConference) || 12;
    return confs.map((c) => ({
      key: String(c.key || '').toLowerCase(),
      name: c.name || c.shortName || c.key,
      shortName: c.shortName || c.name || c.key,
      logo: c.logo || null,
      adminUserId: null,
      slots: Array.from({ length: cap }, () => null)
    }));
  }
  return [
    {
      key: 'detail',
      name: 'Detail Conference',
      shortName: 'DETAIL',
      logo: '/assets/detail-conference.png',
      adminUserId: null,
      slots: Array.from({ length: GRIDIRON_CAP }, () => null)
    },
    {
      key: 'overtime',
      name: 'Overtime Conference',
      shortName: 'OVERTIME',
      logo: '/assets/overtime-conference.png',
      adminUserId: null,
      slots: Array.from({ length: GRIDIRON_CAP }, () => null)
    }
  ];
}

function emptyRoom({ scope, leagueId, targetSeason, league = null }) {
  const conferences = defaultConferences(scope, league);
  const cap = conferences[0]?.slots?.length || GRIDIRON_CAP;
  return {
    id: crypto.randomUUID(),
    scope,
    leagueId,
    targetSeason,
    enabled: scope === 'gridiron',
    status: 'setup',
    draftAt: null,
    pickSeconds: 90,
    lobbyEndsAt: null,
    pickDeadline: null,
    conferences,
    cap,
    championUserId: null,
    runnerUpUserId: null,
    mayorUserId: null,
    championConferenceKey: null,
    captainsPresent: [],
    spectators: [],
    picks: [],
    messages: [],
    mayorSwitch: null,
    appliedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function roomMatch(scope, leagueId) {
  return (r) => r.scope === scope && String(r.leagueId) === String(leagueId);
}

function getRoom(scope, leagueId) {
  return readStore().rooms.find(roomMatch(scope, leagueId)) || null;
}

function saveRoom(room) {
  const store = readStore();
  const idx = store.rooms.findIndex(roomMatch(room.scope, room.leagueId));
  room.updatedAt = new Date().toISOString();
  if (idx >= 0) store.rooms[idx] = room;
  else store.rooms.push(room);
  writeStore(store);
  return room;
}

function ensureRoom({ scope, leagueId, targetSeason, league = null, enabled = null }) {
  let room = getRoom(scope, leagueId);
  if (!room) {
    room = emptyRoom({ scope, leagueId, targetSeason, league });
    if (enabled != null) room.enabled = Boolean(enabled);
    return saveRoom(room);
  }
  if (Number(room.targetSeason) !== Number(targetSeason) && room.status === 'setup' && !room.picks?.length) {
    room.targetSeason = targetSeason;
  }
  if (enabled != null && room.status === 'setup') room.enabled = Boolean(enabled);
  if (!Array.isArray(room.conferences) || room.conferences.length < 2) {
    room.conferences = defaultConferences(scope, league);
  }
  return saveRoom(room);
}

function conferenceOrder(room) {
  const champKey = room.championConferenceKey;
  const list = room.conferences || [];
  if (!champKey) return list;
  const first = list.find((c) => c.key === champKey);
  const rest = list.filter((c) => c.key !== champKey);
  return first ? [first, ...rest] : list;
}

function remainingRounds(room) {
  const cap = Number(room.cap) || GRIDIRON_CAP;
  return Math.max(0, cap - 1);
}

function currentSlot(room) {
  if (!room.championConferenceKey) return null;
  const teams = conferenceOrder(room);
  const teamCount = teams.length;
  const rounds = remainingRounds(room);
  const total = teamCount * rounds;
  const taken = new Set((room.picks || []).map((p) => Number(p.overall)));
  for (let i = 0; i < total; i += 1) {
    if (taken.has(i + 1)) continue;
    const teamIndex = snakeTeamIndex(i, teamCount);
    return {
      overall: i + 1,
      round: Math.floor(i / teamCount) + 1,
      pick: (i % teamCount) + 1,
      teamIndex,
      conferenceKey: teams[teamIndex].key
    };
  }
  return null;
}

function seatedIds(room) {
  const ids = new Set();
  for (const c of room.conferences || []) {
    for (const uid of c.slots || []) {
      if (uid) ids.add(String(uid));
    }
  }
  return ids;
}

function seedCaptains(room) {
  if (!room.championUserId || !room.runnerUpUserId || !room.championConferenceKey) return;
  if (Array.isArray(room.picks) && room.picks.length) return;
  const champConf = room.conferences.find((c) => c.key === room.championConferenceKey);
  const other = room.conferences.find((c) => c.key !== room.championConferenceKey);
  if (!champConf || !other) return;
  champConf.adminUserId = room.championUserId;
  other.adminUserId = room.runnerUpUserId;
  champConf.slots = champConf.slots.map(() => null);
  other.slots = other.slots.map(() => null);
  champConf.slots[0] = room.championUserId;
  other.slots[0] = room.runnerUpUserId;
  room.picks = [];
}

function placePick(room, conferenceKey, userId) {
  const conf = room.conferences.find((c) => c.key === conferenceKey);
  if (!conf) throw err(400, 'Unknown conference');
  const idx = conf.slots.findIndex((s) => !s);
  if (idx < 0) throw err(400, 'That conference is full');
  conf.slots[idx] = userId;
}

function lastPickedUser(room, conferenceKey) {
  const picks = (room.picks || []).filter((p) => p.conferenceKey === conferenceKey);
  if (!picks.length) return null;
  return picks[picks.length - 1];
}

function isCaptain(room, userId) {
  if (!userId) return false;
  return userId === room.championUserId || userId === room.runnerUpUserId;
}

function isStaffActor(user) {
  if (!user) return false;
  if (users.isSiteOwner(user)) return true;
  if (user.role === 'commissioner') return true;
  return false;
}

function canManage(room, user, league = null) {
  if (!user) return false;
  if (isStaffActor(user)) return true;
  if (room.scope === 'independent' && league?.ownerUserId === user.id) return true;
  return isCaptain(room, user.id);
}

function inLeague(room, user, league = null) {
  if (!user) return false;
  if (isStaffActor(user) || users.isReadOnly(user)) return true;
  if (room.scope === 'independent') {
    if (!league) return false;
    if (league.ownerUserId === user.id) return true;
    if (user.leagueId === league.id) return true;
    return (league.franchises || []).some((f) => f.managerUserId === user.id);
  }
  const mem = users.normalizeMembershipLeague(user.membershipLeague);
  return mem === 'gridiron' || user.siteOwner || user.role === 'commissioner' || user.role === 'viewer';
}

function publicMember(m, taken) {
  return {
    ...m,
    available: !taken.has(String(m.userId))
  };
}

function publicRoom(room, viewerId, { league = null, pool = null } = {}) {
  if (!room) return null;
  const members = pool || buildPool(room, league);
  const taken = seatedIds(room);
  const slot = room.status === 'live' ? currentSlot(room) : null;
  const order = conferenceOrder(room);
  const onConf = slot ? order[slot.teamIndex] : null;
  const onAdmin = onConf?.adminUserId || null;
  const lobbyMs = room.lobbyEndsAt ? Date.parse(room.lobbyEndsAt) - Date.now() : null;
  const clockMs = room.pickDeadline ? Date.parse(room.pickDeadline) - Date.now() : null;
  return {
    id: room.id,
    scope: room.scope,
    leagueId: room.leagueId,
    targetSeason: room.targetSeason,
    lastSeason: lastSeasonYear(room.targetSeason),
    enabled: room.enabled !== false,
    status: room.status,
    draftAt: room.draftAt,
    pickSeconds: room.pickSeconds,
    championUserId: room.championUserId,
    runnerUpUserId: room.runnerUpUserId,
    mayorUserId: room.mayorUserId,
    championConferenceKey: room.championConferenceKey,
    conferences: (room.conferences || []).map((c) => ({
      key: c.key,
      name: c.name,
      shortName: c.shortName,
      logo: c.logo,
      adminUserId: c.adminUserId,
      slots: (c.slots || []).map((uid) => {
        if (!uid) return null;
        const m = members.find((x) => x.userId === uid);
        return m || { userId: uid, name: 'Member', teamName: '', record: '—', pointsFor: null };
      })
    })),
    pool: members.map((m) => publicMember(m, taken)),
    picks: room.picks || [],
    messages: Array.isArray(room.messages) ? room.messages.slice(-80) : [],
    spectators: room.spectators || [],
    spectatorCount: (room.spectators || []).length,
    mayorSwitch: room.mayorSwitch || null,
    appliedAt: room.appliedAt || null,
    lobbyEndsAt: room.lobbyEndsAt,
    lobbySecondsRemaining: Number.isFinite(lobbyMs) ? Math.max(0, Math.ceil(lobbyMs / 1000)) : null,
    pickDeadline: room.pickDeadline,
    secondsRemaining: Number.isFinite(clockMs) ? Math.max(0, Math.ceil(clockMs / 1000)) : null,
    onClock: slot
      ? {
          overall: slot.overall,
          round: slot.round,
          pick: slot.pick,
          conferenceKey: slot.conferenceKey,
          conferenceName: onConf?.name,
          adminUserId: onAdmin,
          isMe: Boolean(viewerId && onAdmin === viewerId)
        }
      : null,
    iAmChampion: Boolean(viewerId && viewerId === room.championUserId),
    iAmRunnerUp: Boolean(viewerId && viewerId === room.runnerUpUserId),
    iAmMayor: Boolean(viewerId && viewerId === room.mayorUserId),
    iAmCaptain: Boolean(viewerId && isCaptain(room, viewerId)),
    watching: Boolean(viewerId && (room.spectators || []).includes(viewerId)),
    createdAt: room.createdAt,
    updatedAt: room.updatedAt
  };
}

function setupRoom(room, patch, actor) {
  if (room.status === 'live' || room.status === 'done') {
    throw err(400, 'Conference draft is locked after it starts');
  }
  if (patch.championUserId != null) room.championUserId = String(patch.championUserId || '').trim() || null;
  if (patch.runnerUpUserId != null) room.runnerUpUserId = String(patch.runnerUpUserId || '').trim() || null;
  if (patch.mayorUserId != null) room.mayorUserId = String(patch.mayorUserId || '').trim() || null;
  if (patch.pickSeconds != null) {
    const n = Number(patch.pickSeconds);
    if ([30, 45, 60, 90, 120, 180, 240, 300].includes(n)) room.pickSeconds = n;
  }
  if (patch.draftAt != null) {
    const raw = String(patch.draftAt || '').trim();
    if (!raw) {
      room.draftAt = null;
      if (room.status === 'scheduled') room.status = 'setup';
    } else {
      const t = Date.parse(raw);
      if (!Number.isFinite(t)) throw err(400, 'Invalid draft date');
      room.draftAt = new Date(t).toISOString();
      if (room.championUserId && room.runnerUpUserId) room.status = 'scheduled';
    }
  }
  if (patch.enabled != null && room.scope === 'independent' && room.status === 'setup') {
    room.enabled = Boolean(patch.enabled);
  }
  room.updatedAt = new Date().toISOString();
  return saveRoom(room);
}

function chooseConference(room, conferenceKey, actor) {
  if (!actor) throw err(401, 'Sign in');
  if (room.status === 'live' || room.status === 'done') {
    throw err(400, 'Conference pick is locked');
  }
  const staff = isStaffActor(actor);
  if (!staff && actor.id !== room.championUserId) {
    throw err(403, 'The league winner picks the conference first');
  }
  const key = String(conferenceKey || '').toLowerCase();
  if (!(room.conferences || []).some((c) => c.key === key)) {
    throw err(400, 'Pick a conference');
  }
  if (!room.championUserId || !room.runnerUpUserId) {
    throw err(400, 'Set the league winner and runner-up first');
  }
  if (room.championUserId === room.runnerUpUserId) {
    throw err(400, 'Winner and runner-up must be different');
  }
  room.championConferenceKey = key;
  seedCaptains(room);
  if (room.draftAt && room.status === 'setup') room.status = 'scheduled';
  return saveRoom(room);
}

function openLobby(room) {
  if (!room.championConferenceKey) throw err(400, 'League winner must pick a conference first');
  if (!room.championUserId || !room.runnerUpUserId) throw err(400, 'Set both conference captains first');
  seedCaptains(room);
  room.status = 'lobby';
  room.lobbyEndsAt = new Date(Date.now() + JOIN_LOBBY_SECONDS * 1000).toISOString();
  room.pickDeadline = null;
  return saveRoom(room);
}

function beginLive(room) {
  if (room.status === 'done') return room;
  if (!room.championConferenceKey) throw err(400, 'League winner must pick a conference first');
  seedCaptains(room);
  room.status = 'live';
  room.lobbyEndsAt = null;
  const slot = currentSlot(room);
  room.pickDeadline = slot
    ? new Date(Date.now() + room.pickSeconds * 1000).toISOString()
    : null;
  if (!slot) room.status = 'done';
  return saveRoom(room);
}

function joinWatch(room, user) {
  if (!user?.id) throw err(401, 'Sign in');
  if (room.status === 'setup') throw err(400, 'Draft is not open yet');
  const ids = new Set(room.spectators || []);
  ids.add(user.id);
  room.spectators = [...ids];
  if (isCaptain(room, user.id) && !(room.captainsPresent || []).includes(user.id)) {
    room.captainsPresent = [...(room.captainsPresent || []), user.id];
  }
  return saveRoom(room);
}

function humanPick(room, user, targetUserId, { pool = null, league = null } = {}) {
  if (room.status !== 'live') throw err(400, 'Picks are not live');
  const slot = currentSlot(room);
  if (!slot) throw err(400, 'Draft is complete');
  const onAdmin = conferenceOrder(room)[slot.teamIndex]?.adminUserId;
  const staff = isStaffActor(user);
  if (!staff && user?.id !== onAdmin) {
    throw err(403, 'It is not your pick');
  }
  const uid = String(targetUserId || '').trim();
  const members = pool || buildPool(room, league);
  const member = members.find((m) => m.userId === uid);
  if (!member) throw err(400, 'That manager is not in the pool');
  if (seatedIds(room).has(uid)) throw err(400, 'Already drafted');
  if (uid === room.championUserId || uid === room.runnerUpUserId) {
    throw err(400, 'Captains are already seated');
  }
  placePick(room, slot.conferenceKey, uid);
  room.picks.push({
    overall: slot.overall,
    round: slot.round,
    pick: slot.pick,
    conferenceKey: slot.conferenceKey,
    conferenceName: conferenceOrder(room)[slot.teamIndex]?.name,
    userId: uid,
    playerName: member.name,
    teamName: member.teamName,
    record: member.record,
    pointsFor: member.pointsFor,
    lastSeason: member.lastSeason,
    pickedAt: new Date().toISOString(),
    pickedBy: user?.id || null
  });
  const next = currentSlot(room);
  if (!next) {
    room.status = 'done';
    room.pickDeadline = null;
  } else {
    room.pickDeadline = new Date(Date.now() + room.pickSeconds * 1000).toISOString();
  }
  return saveRoom(room);
}

function mayorSwitch(room, user, conferenceKey) {
  if (room.status !== 'done') throw err(400, 'Mayor switch is after the draft');
  if (room.mayorSwitch?.used) throw err(400, 'Mayor switch already used');
  if (!user?.id || user.id !== room.mayorUserId) {
    throw err(403, 'Only the MAYORS CUP winner can switch');
  }
  const destKey = String(conferenceKey || '').toLowerCase();
  const dest = (room.conferences || []).find((c) => c.key === destKey);
  if (!dest) throw err(400, 'Pick a conference');
  const currentConf = (room.conferences || []).find((c) => (c.slots || []).includes(user.id));
  if (!currentConf) throw err(400, 'You are not seated in a conference');
  if (currentConf.key === destKey) throw err(400, 'You are already in that conference');
  const last = lastPickedUser(room, destKey);
  if (!last?.userId) throw err(400, 'That conference has no last pick to replace');
  if (last.userId === dest.adminUserId || last.userId === currentConf.adminUserId) {
    throw err(400, 'Cannot replace a conference admin');
  }
  dest.slots = dest.slots.map((id) => (id === last.userId ? user.id : id));
  currentConf.slots = currentConf.slots.map((id) => (id === user.id ? last.userId : id));
  room.mayorSwitch = {
    used: true,
    fromKey: currentConf.key,
    toKey: destKey,
    swappedUserId: last.userId,
    at: new Date().toISOString()
  };
  return saveRoom(room);
}

function addChat(room, user, text) {
  const body = String(text || '').trim().slice(0, 280);
  if (!body) throw err(400, 'Message required');
  if (!user?.id) throw err(401, 'Sign in');
  room.messages = room.messages || [];
  room.messages.push({
    id: crypto.randomUUID(),
    userId: user.id,
    name: user.name || user.loginName || 'Member',
    text: body,
    at: new Date().toISOString()
  });
  if (room.messages.length > 200) room.messages = room.messages.slice(-200);
  return saveRoom(room);
}

function assignments(room) {
  const rows = [];
  for (const c of room.conferences || []) {
    (c.slots || []).forEach((uid, i) => {
      if (!uid) return;
      rows.push({
        userId: uid,
        conferenceKey: c.key,
        conferenceName: c.name,
        slot: i + 1,
        isAdmin: c.adminUserId === uid
      });
    });
  }
  return rows;
}

function applyAssignments(room, actor, { league = null } = {}) {
  if (!isStaffActor(actor) && !(room.scope === 'independent' && league?.ownerUserId === actor?.id)) {
    throw err(403, 'Only staff can lock in next-season conferences');
  }
  if (room.status !== 'done') throw err(400, 'Finish the conference draft first');
  if (room.appliedAt) throw err(400, 'Already applied');
  const rows = assignments(room);
  if (room.scope === 'gridiron') {
    for (const row of rows) {
      try {
        users.setLeagueMembership(row.userId, { hqConference: row.conferenceKey });
      } catch (e) {
        if (e.status !== 409) throw e;
      }
    }
    if (typeof users.assignConferenceAdminExclusive === 'function') {
      for (const c of room.conferences || []) {
        if (c.adminUserId) users.assignConferenceAdminExclusive(c.adminUserId, c.key);
      }
    }
  } else if (league) {
    const leaguesStore = require('./leagues-store');
    const byUser = new Map(rows.map((r) => [r.userId, r.conferenceKey]));
    leaguesStore.withIndependentLeague(league.id, (live) => {
      live.franchises = (live.franchises || []).map((f) => {
        const key = f.managerUserId ? byUser.get(f.managerUserId) : null;
        return key ? { ...f, conferenceKey: key } : f;
      });
    });
  }
  room.appliedAt = new Date().toISOString();
  return saveRoom(room);
}

function tickRoom(room) {
  if (!room || room.enabled === false) return false;
  let changed = false;
  if (room.status === 'scheduled' && room.draftAt) {
    const t = Date.parse(room.draftAt);
    if (Number.isFinite(t) && Date.now() >= t) {
      try {
        openLobby(room);
        changed = true;
        room = getRoom(room.scope, room.leagueId);
      } catch { /* missing conference pick */ }
    }
  }
  room = getRoom(room.scope, room.leagueId) || room;
  if (room.status === 'lobby' && room.lobbyEndsAt) {
    const t = Date.parse(room.lobbyEndsAt);
    if (Number.isFinite(t) && Date.now() >= t) {
      beginLive(room);
      changed = true;
    }
  }
  return changed;
}

function tickAll() {
  const store = readStore();
  for (const room of store.rooms) {
    try { tickRoom(room); } catch { /* ignore */ }
  }
}

function memberOptions(room, league = null) {
  return buildPool(room, league).map((m) => ({
    userId: m.userId,
    name: m.name,
    teamName: m.teamName,
    record: m.record,
    pointsFor: m.pointsFor,
    lastSeason: m.lastSeason
  }));
}

module.exports = {
  GRIDIRON_KEY,
  JOIN_LOBBY_SECONDS,
  lastSeasonYear,
  getRoom,
  ensureRoom,
  publicRoom,
  buildPool,
  setupRoom,
  chooseConference,
  openLobby,
  beginLive,
  joinWatch,
  humanPick,
  mayorSwitch,
  addChat,
  applyAssignments,
  assignments,
  tickRoom,
  tickAll,
  canManage,
  inLeague,
  isStaffActor,
  isCaptain,
  memberOptions
};
