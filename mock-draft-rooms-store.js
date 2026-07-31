/**
 * Lounge multiplayer mock draft rooms.
 * Host starts → chat announce → others claim open seats → humans get pick clock, empty seats CPU.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'mock-draft-rooms.json');

const TEAM_COUNTS = new Set([10, 12, 14]);
const ROUND_OPTIONS = new Set([8, 10, 12, 15, 16, 18]);
const PICK_SECONDS_OPTIONS = new Set([60, 120, 180]);
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

function clampPickSeconds(n) {
  const v = Number(n);
  if (PICK_SECONDS_OPTIONS.has(v)) return v;
  if (v === 1 || v === 2 || v === 3) return v * 60;
  return 60;
}

function padTeamNames(names, count) {
  const list = (Array.isArray(names) ? names : []).map((n) => String(n || '').trim()).filter(Boolean).slice(0, count);
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
  return {
    index: seat.index,
    userId: seat.userId || null,
    userName: seat.userName || null,
    isCpu: Boolean(seat.isCpu || !seat.userId),
    isMe: Boolean(viewerId && seat.userId && seat.userId === viewerId)
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
    pickSeconds: room.pickSeconds,
    teamNames: room.teamNames.slice(),
    seats: room.seats.map((s) => publicSeat(s, viewerId)),
    picks: room.picks.slice(),
    pickDeadline: room.pickDeadline || null,
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
    openSeatCount: room.seats.filter((s) => !s.userId).length,
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
  avail.sort((a, b) => {
    const aa = Number(a.adp ?? a.overallRank ?? 9999);
    const bb = Number(b.adp ?? b.overallRank ?? 9999);
    if (aa !== bb) return aa - bb;
    const pa = Number(b.projectedPoints2026 || b.fantasyPoints2025 || 0);
    const pb = Number(a.projectedPoints2026 || a.fantasyPoints2025 || 0);
    return pa - pb;
  });
  return avail[0];
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
 * @param {object} room
 * @param {Array} pool
 */
function advanceRoom(room, pool) {
  if (!room || room.status === 'done') return false;
  if (room.status !== 'live') return false;
  let changed = false;
  let guard = 0;
  const max = room.teamCount * room.rounds + 4;
  while (guard < max) {
    guard += 1;
    const slot = currentSlot(room);
    if (!slot) {
      room.status = 'done';
      room.pickDeadline = null;
      changed = true;
      break;
    }
    const seat = room.seats[slot.teamIndex];
    const isHuman = Boolean(seat?.userId);
    if (!isHuman) {
      const player = bestAvailable(pool, room);
      if (!player) break;
      applyPick(room, player, { cpu: true });
      changed = true;
      continue;
    }
    const deadline = room.pickDeadline ? Date.parse(room.pickDeadline) : NaN;
    if (Number.isFinite(deadline) && Date.now() > deadline) {
      const player = bestAvailable(pool, room);
      if (!player) break;
      applyPick(room, player, { cpu: true });
      room.pickDeadline = currentSlot(room) && room.seats[currentSlot(room).teamIndex]?.userId
        ? new Date(Date.now() + room.pickSeconds * 1000).toISOString()
        : null;
      changed = true;
      continue;
    }
    // Human on clock — ensure deadline set
    if (!room.pickDeadline) {
      room.pickDeadline = new Date(Date.now() + room.pickSeconds * 1000).toISOString();
      changed = true;
    }
    break;
  }
  return changed;
}

function createRoom({ user, teamCount, rounds, pickSeconds, seatIndex, teamNames }) {
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
    status: 'live',
    teamCount: count,
    rounds: clampRounds(rounds),
    pickSeconds: clampPickSeconds(pickSeconds),
    teamNames: names,
    seats,
    picks: [],
    pickDeadline: null,
    createdAt: now,
    updatedAt: now
  };
  store.rooms.unshift(room);
  pruneRooms(store);
  writeStore(store);
  return room;
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

function joinSeat({ roomId, user, seatIndex }) {
  if (!user?.id) throw err(401, 'Sign in required');
  const room = getRoom(roomId);
  if (!room) throw err(404, 'Mock draft not found');
  if (room.status === 'done') throw err(400, 'This mock draft is finished');
  const existing = room.seats.find((s) => s.userId === user.id);
  if (existing) return room;
  const idx = Number(seatIndex);
  if (!Number.isFinite(idx) || idx < 0 || idx >= room.teamCount) {
    throw err(400, 'Choose an open seat');
  }
  const seat = room.seats[idx];
  if (seat.userId) throw err(400, 'That seat is taken');
  seat.userId = user.id;
  seat.userName = user.name || user.loginName || 'Member';
  seat.isCpu = false;
  room.updatedAt = new Date().toISOString();
  // If this seat is currently on the clock, reset deadline for the new human
  const slot = currentSlot(room);
  if (slot && slot.teamIndex === idx) {
    room.pickDeadline = new Date(Date.now() + room.pickSeconds * 1000).toISOString();
  }
  return saveRoom(room);
}

function claimOpenSeat({ roomId, user }) {
  const room = getRoom(roomId);
  if (!room) throw err(404, 'Mock draft not found');
  const open = room.seats.find((s) => !s.userId);
  if (!open) throw err(400, 'No open seats left');
  return joinSeat({ roomId, user, seatIndex: open.index });
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
  const player = (pool || []).find((p) => playerKey(p?.id) === playerKey(playerId));
  if (!player) throw err(400, 'Player not in pool');
  applyPick(room, player, { cpu: false });
  const next = currentSlot(room);
  if (next && room.seats[next.teamIndex]?.userId) {
    room.pickDeadline = new Date(Date.now() + room.pickSeconds * 1000).toISOString();
  } else {
    room.pickDeadline = null;
  }
  advanceRoom(room, pool);
  return saveRoom(room);
}

function listActiveRooms() {
  const store = readStore();
  pruneRooms(store);
  writeStore(store);
  return store.rooms.filter((r) => r.status === 'live');
}

module.exports = {
  createRoom,
  getRoom,
  saveRoom,
  joinSeat,
  claimOpenSeat,
  humanPick,
  advanceRoom,
  publicRoom,
  listActiveRooms,
  currentSlot,
  clampPickSeconds,
  PICK_SECONDS_OPTIONS
};
