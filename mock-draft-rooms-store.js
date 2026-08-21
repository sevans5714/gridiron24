/**
 * Lounge multiplayer mock draft rooms.
 * Host opens lobby → players drag seats → host locks positions → join window ends → host starts → CPU fills empty seats.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MockDraftCpu = require('./public/js/mock-draft-cpu');
const logos = require('./logos-store');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'mock-draft-rooms.json');

const TEAM_COUNTS = new Set([10, 12, 14]);
const TEAM_NAME_MAX = 32;
const ROUND_OPTIONS = new Set([8, 10, 12, 15, 16, 18]);
const PICK_SECONDS_OPTIONS = new Set([60, 120, 180, 240, 300]);
const SCORING_OPTIONS = new Set(['ppr', 'half-ppr', 'standard']);
const JOIN_LOBBY_SECONDS = 240; // 4:00 for others to join after positions lock
const CPU_PICK_GAP_MS = 2500;
const HUMAN_PICK_GAP_MS = CPU_PICK_GAP_MS + 900;
const MAX_ROOMS = 12;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;

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

function clampTeamCount(n) {
  const v = Number(n);
  return TEAM_COUNTS.has(v) ? v : 12;
}

function clampRounds(n) {
  const v = Number(n);
  return ROUND_OPTIONS.has(v) ? v : 15;
}

function clampScoring(value) {
  const s = String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (s === 'std' || s === 'standard' || s === 'non-ppr') return 'standard';
  if (s === 'half' || s === 'half-ppr' || s === 'halfppr') return 'half-ppr';
  if (SCORING_OPTIONS.has(s)) return s;
  return 'ppr';
}

function clampPickSeconds(n) {
  const v = Number(n);
  if (PICK_SECONDS_OPTIONS.has(v)) return v;
  if (v === 1 || v === 2 || v === 3) return v * 60;
  return 60;
}

function padTeamNames(names, count) {
  const list = (Array.isArray(names) ? names : [])
    .map((n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, TEAM_NAME_MAX))
    .filter(Boolean)
    .slice(0, count);
  while (list.length < count) list.push(`Team ${list.length + 1}`);
  return list;
}

function snakeTeamIndex(overallZeroBased, teamCount) {
  const round = Math.floor(overallZeroBased / teamCount);
  const pos = overallZeroBased % teamCount;
  return round % 2 === 0 ? pos : teamCount - 1 - pos;
}

function currentSlot(room) {
  const total = room.teamCount * room.rounds;
  const i = room.picks.length;
  if (i >= total) return null;
  const teamIndex = snakeTeamIndex(i, room.teamCount);
  return {
    overall: i + 1,
    round: Math.floor(i / room.teamCount) + 1,
    pick: (i % room.teamCount) + 1,
    teamIndex
  };
}

function pruneRooms(store) {
  const cutoff = Date.now() - ROOM_TTL_MS;
  store.rooms = store.rooms
    .filter((r) => new Date(r.updatedAt || r.createdAt).getTime() > cutoff)
    .slice(0, MAX_ROOMS);
}

function publicSeat(seat, viewerId) {
  const isCpu = Boolean(seat.isCpu || !seat.userId);
  let avatarUrl = null;
  if (!isCpu && seat.userId) {
    try {
      const logo = logos.resolveLogoForUser(seat.userId);
      if (logo?.type === 'icon' || logo?.type === 'upload') avatarUrl = logo.url || null;
    } catch { /* optional */ }
  }
  return {
    index: seat.index,
    userId: seat.userId || null,
    userName: seat.userName || null,
    isCpu,
    isMe: Boolean(viewerId && seat.userId && seat.userId === viewerId),
    avatarUrl
  };
}

function publicRoom(room, viewerId = null) {
  if (!room) return null;
  const slot = currentSlot(room);
  const onClock = slot ? room.seats[slot.teamIndex] : null;
  const mySeat = viewerId
    ? room.seats.find((s) => s.userId === viewerId)
    : null;
  return {
    id: room.id,
    status: room.status,
    hostId: room.hostId,
    hostName: room.hostName,
    teamCount: room.teamCount,
    rounds: room.rounds,
    scoring: clampScoring(room.scoring),
    pickSeconds: room.pickSeconds,
    teamNames: room.teamNames.slice(),
    seats: room.seats.map((s) => publicSeat(s, viewerId)),
    picks: room.picks.slice(),
    pickDeadline: room.pickDeadline || null,
    cpuReadyAt: room.cpuReadyAt || null,
    onClock: onClock
      ? {
          teamIndex: slot.teamIndex,
          teamName: room.teamNames[slot.teamIndex],
          userId: onClock.userId || null,
          userName: onClock.userName || null,
          isCpu: Boolean(onClock.isCpu || !onClock.userId),
          isMe: Boolean(viewerId && onClock.userId === viewerId),
          overall: slot.overall,
          round: slot.round
        }
      : null,
    mySeatIndex: mySeat ? mySeat.index : null,
    isHost: Boolean(viewerId && room.hostId === viewerId),
    lobbyEndsAt: room.lobbyEndsAt || null,
    positionsLocked: Boolean(room.positionsLocked),
    openSeatCount: room.seats.filter((s) => !s.userId).length,
    messages: Array.isArray(room.messages) ? room.messages.slice(-80) : [],
    createdAt: room.createdAt,
    updatedAt: room.updatedAt
  };
}

function playerKey(id) {
  return String(id ?? '').trim();
}

function takenIds(room) {
  return new Set(
    (room.picks || [])
      .map((p) => playerKey(p.playerId))
      .filter(Boolean)
  );
}

function bestAvailable(pool, room) {
  const taken = takenIds(room);
  const avail = (pool || []).filter((p) => {
    const id = playerKey(p?.id);
    return id && !taken.has(id);
  });
  if (!avail.length) return null;
  const slot = currentSlot(room);
  if (!slot) {
    return avail.slice().sort((a, b) => {
      const ra = a.overallRank != null ? Number(a.overallRank) : 9999;
      const rb = b.overallRank != null ? Number(b.overallRank) : 9999;
      return ra - rb;
    })[0];
  }
  return MockDraftCpu.chooseCpuPick({
    available: avail,
    picks: room.picks || [],
    slot,
    teamCount: room.teamCount,
    rounds: room.rounds,
    starters: MockDraftCpu.DEFAULT_STARTERS,
    style: MockDraftCpu.cpuStyleForTeam(slot.teamIndex)
  }) || avail[0];
}

function applyPick(room, player, { cpu = false } = {}) {
  const slot = currentSlot(room);
  if (!slot) throw err(400, 'Draft is complete');
  const id = playerKey(player?.id);
  if (!id) throw err(400, 'Invalid player');
  if (takenIds(room).has(id)) throw err(400, 'Already drafted');
  room.picks.push({
    overall: slot.overall,
    round: slot.round,
    pick: slot.pick,
    teamIndex: slot.teamIndex,
    teamName: room.teamNames[slot.teamIndex],
    playerId: id,
    playerName: player.name || player.fullName || `Player ${id}`,
    position: player.position || '',
    nflTeam: player.team || player.nflTeam || '',
    headshot: player.headshot || null,
    teamLogo: player.teamLogo || null,
    byeWeek: player.byeWeek ?? null,
    fantasyPoints2025: player.fantasyPoints2025 ?? null,
    projectedPoints2026: player.projectedPoints2026 ?? null,
    adp: player.adp ?? null,
    cpu: Boolean(cpu)
  });
  room.updatedAt = new Date().toISOString();
  if (room.picks.length >= room.teamCount * room.rounds) {
    room.status = 'done';
    room.pickDeadline = null;
  }
}

/**
 * Advance past CPU seats and expired human clocks.
 * CPU picks are paced one-at-a-time so clients can scroll/show each name on the board.
 * @param {object} room
 * @param {Array} pool
 */
function advanceRoom(room, pool) {
  if (!room || room.status === 'done') return false;
  if (room.status !== 'live') return false;
  let changed = false;
  let guard = 0;
  const max = room.teamCount * room.rounds + 4;

  function armNextClock({ afterHuman = false } = {}) {
    const next = currentSlot(room);
    if (!next) {
      room.cpuReadyAt = null;
      room.pickDeadline = null;
      return;
    }
    room.pickDeadline = null;
    room.cpuReadyAt = new Date(Date.now() + (afterHuman ? HUMAN_PICK_GAP_MS : CPU_PICK_GAP_MS)).toISOString();
  }

  while (guard < max) {
    guard += 1;
    const slot = currentSlot(room);
    if (!slot) {
      room.status = 'done';
      room.pickDeadline = null;
      room.cpuReadyAt = null;
      changed = true;
      break;
    }
    const seat = room.seats[slot.teamIndex];
    const isHuman = Boolean(seat?.userId);
    if (!isHuman) {
      const readyAt = room.cpuReadyAt ? Date.parse(room.cpuReadyAt) : 0;
      if (Number.isFinite(readyAt) && Date.now() < readyAt) break;
      const player = bestAvailable(pool, room);
      if (!player) break;
      applyPick(room, player, { cpu: true });
      armNextClock();
      changed = true;
      break;
    }
    const deadline = room.pickDeadline ? Date.parse(room.pickDeadline) : NaN;
    if (Number.isFinite(deadline) && Date.now() > deadline) {
      const player = bestAvailable(pool, room);
      if (!player) break;
      applyPick(room, player, { cpu: true });
      armNextClock();
      changed = true;
      break;
    }
    const revealAt = room.cpuReadyAt ? Date.parse(room.cpuReadyAt) : 0;
    if (Number.isFinite(revealAt) && Date.now() < revealAt) break;
    // Human on clock — ensure deadline set
    if (!room.pickDeadline) {
      room.pickDeadline = new Date(Date.now() + room.pickSeconds * 1000).toISOString();
      room.cpuReadyAt = null;
      changed = true;
    }
    break;
  }
  return changed;
}

function createRoom({ user, teamCount, rounds, pickSeconds, scoring, seatIndex, teamNames, hostTeamName }) {
  if (!user?.id) throw err(401, 'Sign in required');
  const count = clampTeamCount(teamCount);
  const seat = Number(seatIndex);
  if (!Number.isFinite(seat) || seat < 0 || seat >= count) {
    throw err(400, 'Pick a valid draft seat first');
  }
  const store = readStore();
  pruneRooms(store);
  // End other live rooms hosted by this user
  for (const r of store.rooms) {
    if (r.hostId === user.id && (r.status === 'live' || r.status === 'lobby')) {
      r.status = 'done';
      r.updatedAt = new Date().toISOString();
    }
  }
  const names = padTeamNames(teamNames, count);
  const hostLabel = String(hostTeamName || '').replace(/\s+/g, ' ').trim().slice(0, TEAM_NAME_MAX);
  if (hostLabel) names[seat] = hostLabel;
  const seats = Array.from({ length: count }, (_, i) => ({
    index: i,
    userId: i === seat ? user.id : null,
    userName: i === seat ? (user.name || user.loginName || 'Host') : null,
    isCpu: i !== seat
  }));
  const now = new Date().toISOString();
  const room = {
    id: crypto.randomUUID(),
    hostId: user.id,
    hostName: user.name || user.loginName || 'Host',
    status: 'lobby',
    teamCount: count,
    rounds: clampRounds(rounds),
    scoring: clampScoring(scoring),
    pickSeconds: clampPickSeconds(pickSeconds),
    teamNames: names,
    seats,
    picks: [],
    messages: [],
    pickDeadline: null,
    lobbyEndsAt: null,
    positionsLocked: false,
    createdAt: now,
    updatedAt: now
  };
  store.rooms.unshift(room);
  pruneRooms(store);
  writeStore(store);
  return room;
}

function startDraft({ roomId, user, pool }) {
  if (!user?.id) throw err(401, 'Sign in required');
  let room = getRoom(roomId);
  if (!room) throw err(404, 'Mock draft not found');
  if (room.status !== 'lobby') throw err(409, 'Draft already started');
  if (String(room.hostId) !== String(user.id)) {
    throw err(403, 'Only the host can start the draft');
  }
  if (!room.positionsLocked) {
    throw err(409, 'Lock positions before starting the draft');
  }
  const endsAt = room.lobbyEndsAt ? Date.parse(room.lobbyEndsAt) : 0;
  if (Number.isFinite(endsAt) && Date.now() < endsAt) {
    const wait = Math.ceil((endsAt - Date.now()) / 1000);
    throw err(409, `Wait ${wait}s for others to join before starting`);
  }
  room.status = 'live';
  room.lobbyEndsAt = null;
  room.updatedAt = new Date().toISOString();
  advanceRoom(room, pool);
  return saveRoom(room);
}

function lockPositions({ roomId, user }) {
  if (!user?.id) throw err(401, 'Sign in required');
  const room = getRoom(roomId);
  if (!room) throw err(404, 'Mock draft not found');
  if (room.status !== 'lobby') throw err(409, 'Draft already started');
  if (String(room.hostId) !== String(user.id)) {
    throw err(403, 'Only the host can lock positions');
  }
  room.positionsLocked = true;
  // Join window starts when the host locks — others get 4:00 to claim a seat.
  room.lobbyEndsAt = new Date(Date.now() + JOIN_LOBBY_SECONDS * 1000).toISOString();
  room.updatedAt = new Date().toISOString();
  return saveRoom(room);
}

function skipJoinWindow({ roomId, user }) {
  if (!user?.id) throw err(401, 'Sign in required');
  const room = getRoom(roomId);
  if (!room) throw err(404, 'Mock draft not found');
  if (room.status !== 'lobby') throw err(409, 'Draft already started');
  if (String(room.hostId) !== String(user.id)) {
    throw err(403, 'Only the host can skip the join window');
  }
  if (!room.positionsLocked) {
    throw err(409, 'Lock positions before skipping the join window');
  }
  room.lobbyEndsAt = new Date(Date.now() - 1000).toISOString();
  room.updatedAt = new Date().toISOString();
  return saveRoom(room);
}

function moveSeat({ roomId, user, toIndex }) {
  if (!user?.id) throw err(401, 'Sign in required');
  const room = getRoom(roomId);
  if (!room) throw err(404, 'Mock draft not found');
  if (room.status !== 'lobby') throw err(400, 'Seats are locked — draft already started');
  if (room.positionsLocked) throw err(403, 'Positions are locked');
  const fromSeat = room.seats.find((s) => s.userId === user.id);
  if (!fromSeat) throw err(400, 'Claim a seat first');
  const to = Number(toIndex);
  if (!Number.isFinite(to) || to < 0 || to >= room.teamCount) {
    throw err(400, 'Choose a valid draft position');
  }
  if (to === fromSeat.index) return room;
  const target = room.seats[to];
  const from = fromSeat.index;
  const swapUser = {
    userId: target.userId,
    userName: target.userName,
    isCpu: Boolean(target.isCpu || !target.userId)
  };
  target.userId = fromSeat.userId;
  target.userName = fromSeat.userName;
  target.isCpu = false;
  fromSeat.userId = swapUser.userId;
  fromSeat.userName = swapUser.userName;
  fromSeat.isCpu = Boolean(swapUser.isCpu || !swapUser.userId);
  if (Array.isArray(room.teamNames) && room.teamNames.length > Math.max(from, to)) {
    const tmpName = room.teamNames[from];
    room.teamNames[from] = room.teamNames[to];
    room.teamNames[to] = tmpName;
  }
  room.updatedAt = new Date().toISOString();
  return saveRoom(room);
}

function getRoom(roomId) {
  const store = readStore();
  return store.rooms.find((r) => r.id === roomId) || null;
}

function saveRoom(room) {
  const store = readStore();
  const idx = store.rooms.findIndex((r) => r.id === room.id);
  if (idx === -1) store.rooms.unshift(room);
  else store.rooms[idx] = room;
  pruneRooms(store);
  writeStore(store);
  return room;
}

function joinSeat({ roomId, user, seatIndex, teamName }) {
  if (!user?.id) throw err(401, 'Sign in required');
  const room = getRoom(roomId);
  if (!room) throw err(404, 'Mock draft not found');
  if (room.status === 'done') throw err(400, 'This mock draft is finished');
  const existing = room.seats.find((s) => s.userId === user.id);
  if (existing) {
    if (room.positionsLocked || room.status !== 'lobby') return room;
    // Already seated — treat as a move to the clicked open/target seat
    return moveSeat({ roomId, user, toIndex: seatIndex });
  }
  if (room.status === 'lobby' && room.positionsLocked) {
    // Still allow claiming an open CPU seat after lock; no rearranging
  }
  const idx = Number(seatIndex);
  if (!Number.isFinite(idx) || idx < 0 || idx >= room.teamCount) {
    throw err(400, 'Choose an open seat');
  }
  const seat = room.seats[idx];
  if (seat.userId) throw err(400, 'That seat is taken');
  seat.userId = user.id;
  seat.userName = user.name || user.loginName || 'Member';
  seat.isCpu = false;
  const label = String(teamName || '').replace(/\s+/g, ' ').trim().slice(0, TEAM_NAME_MAX);
  if (label && Array.isArray(room.teamNames) && room.teamNames.length > idx) {
    room.teamNames[idx] = label;
  }
  room.updatedAt = new Date().toISOString();
  // If this seat is currently on the clock during a live draft, reset deadline for the new human
  if (room.status === 'live') {
    const slot = currentSlot(room);
    if (slot && slot.teamIndex === idx) {
      room.pickDeadline = new Date(Date.now() + room.pickSeconds * 1000).toISOString();
    }
  }
  return saveRoom(room);
}

function claimOpenSeat({ roomId, user, teamName }) {
  const room = getRoom(roomId);
  if (!room) throw err(404, 'Mock draft not found');
  const open = room.seats.find((s) => !s.userId);
  if (!open) throw err(400, 'No open seats left');
  return joinSeat({ roomId, user, seatIndex: open.index, teamName });
}

function humanPick({ roomId, user, playerId, pool }) {
  if (!user?.id) throw err(401, 'Sign in required');
  let room = getRoom(roomId);
  if (!room) throw err(404, 'Mock draft not found');
  if (room.status !== 'live') throw err(400, 'Draft is not live');
  advanceRoom(room, pool);
  room = getRoom(roomId) || room;
  const slot = currentSlot(room);
  if (!slot) throw err(400, 'Draft is complete');
  const seat = room.seats[slot.teamIndex];
  if (!seat?.userId || seat.userId !== user.id) {
    throw err(403, 'Not your turn');
  }
  const readyAt = room.cpuReadyAt ? Date.parse(room.cpuReadyAt) : 0;
  if (Number.isFinite(readyAt) && Date.now() < readyAt) {
    throw err(400, 'Wait for the next pick');
  }
  const player = (pool || []).find((p) => playerKey(p?.id) === playerKey(playerId));
  if (!player) throw err(400, 'Player not in pool');
  applyPick(room, player, { cpu: false });
  const next = currentSlot(room);
  if (!next) {
    room.pickDeadline = null;
    room.cpuReadyAt = null;
  } else {
    room.pickDeadline = null;
    room.cpuReadyAt = new Date(Date.now() + HUMAN_PICK_GAP_MS).toISOString();
  }
  advanceRoom(room, pool);
  return saveRoom(room);
}

function listActiveRooms() {
  const store = readStore();
  pruneRooms(store);
  writeStore(store);
  return store.rooms.filter((r) => r.status === 'live' || r.status === 'lobby');
}

function addChatMessage({ roomId, user, body }) {
  if (!user?.id) throw err(401, 'Sign in required');
  const text = String(body || '').trim().replace(/\s+/g, ' ');
  if (!text) throw err(400, 'Message required');
  if (text.length > 240) throw err(400, 'Keep messages under 240 characters');
  const store = readStore();
  const room = store.rooms.find((r) => r.id === roomId);
  if (!room) throw err(404, 'Mock draft not found');
  if (room.status !== 'lobby' && room.status !== 'live') {
    throw err(400, 'Draft chat is closed');
  }
  const seated = (room.seats || []).some((s) => s.userId === user.id);
  const isHost = room.hostId === user.id;
  if (!seated && !isHost) throw err(403, 'Claim a seat to chat');
  if (!Array.isArray(room.messages)) room.messages = [];
  const msg = {
    id: crypto.randomUUID(),
    body: text,
    authorId: user.id,
    authorName: user.name || user.loginName || 'Member',
    createdAt: new Date().toISOString()
  };
  room.messages.push(msg);
  if (room.messages.length > 120) room.messages = room.messages.slice(-120);
  room.updatedAt = msg.createdAt;
  writeStore(store);
  return { room, message: msg };
}

module.exports = {
  createRoom,
  startDraft,
  lockPositions,
  skipJoinWindow,
  moveSeat,
  getRoom,
  saveRoom,
  joinSeat,
  claimOpenSeat,
  humanPick,
  advanceRoom,
  publicRoom,
  listActiveRooms,
  addChatMessage,
  currentSlot,
  clampPickSeconds,
  clampScoring,
  PICK_SECONDS_OPTIONS,
  SCORING_OPTIONS,
  JOIN_LOBBY_SECONDS,
  CPU_PICK_GAP_MS
};
