/**
 * Official live draft for independent leagues only.
 * Reuses mock-draft clock/CPU/snake mechanics; rooms are league-scoped and never TTL-pruned.
 * GridIron 24 / ESPN drafts are not touched here.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MockDraftCpu = require('./public/js/mock-draft-cpu');
const leagues = require('./leagues-store');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'independent-draft-rooms.json');
const CPU_PICK_GAP_MS = 2500;

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

function startersFromSettings(settings) {
  const slots = settings?.rosterSlots || {};
  return {
    QB: Number(slots.QB) || 1,
    RB: Number(slots.RB) || 2,
    WR: Number(slots.WR) || 2,
    TE: Number(slots.TE) || 1,
    FLEX: Number(slots.FLEX) || 1,
    DST: Number(slots.DST) || 0,
    K: Number(slots.K) || 1
  };
}

function bestAvailable(pool, room, settings) {
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
    starters: startersFromSettings(settings),
    style: MockDraftCpu.cpuStyleForTeam(slot.teamIndex)
  }) || avail[0];
}

function applyPick(room, player, { cpu = false, timeout = false } = {}) {
  const slot = currentSlot(room);
  if (!slot) throw err(400, 'Draft is complete');
  const id = playerKey(player?.id);
  if (!id) throw err(400, 'Invalid player');
  if (takenIds(room).has(id)) throw err(400, 'Already drafted');
  const franchiseId = room.franchiseIds[slot.teamIndex];
  room.picks.push({
    overall: slot.overall,
    round: slot.round,
    pick: slot.pick,
    teamIndex: slot.teamIndex,
    franchiseId,
    teamName: room.teamNames[slot.teamIndex],
    playerId: id,
    playerName: player.name || player.fullName || `Player ${id}`,
    position: player.position || '',
    nflTeam: player.team || player.nflTeam || '',
    headshot: player.headshot || null,
    teamLogo: player.teamLogo || null,
    byeWeek: player.byeWeek ?? null,
    cpu: Boolean(cpu),
    timeout: Boolean(timeout),
    pickedAt: new Date().toISOString()
  });
  room.updatedAt = new Date().toISOString();
  if (room.picks.length >= room.teamCount * room.rounds) {
    room.status = 'done';
    room.pickDeadline = null;
    room.cpuReadyAt = null;
  }
}

function advanceRoom(room, pool, settings) {
  if (!room || room.status === 'done') return false;
  if (room.status !== 'live') return false;
  let changed = false;
  let guard = 0;
  const max = room.teamCount * room.rounds + 4;

  function armNextClock() {
    const next = currentSlot(room);
    if (!next) {
      room.cpuReadyAt = null;
      room.pickDeadline = null;
      return;
    }
    const nextHuman = Boolean(room.seats[next.teamIndex]?.userId);
    if (nextHuman) {
      room.cpuReadyAt = null;
      room.pickDeadline = new Date(Date.now() + room.pickSeconds * 1000).toISOString();
    } else {
      room.pickDeadline = null;
      room.cpuReadyAt = new Date(Date.now() + CPU_PICK_GAP_MS).toISOString();
    }
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
      const player = bestAvailable(pool, room, settings);
      if (!player) break;
      applyPick(room, player, { cpu: true });
      armNextClock();
      changed = true;
      break;
    }
    // Claimed seat: manager can pick until the clock expires; then CPU autopicks.
    const deadline = room.pickDeadline ? Date.parse(room.pickDeadline) : NaN;
    if (Number.isFinite(deadline) && Date.now() >= deadline) {
      const player = bestAvailable(pool, room, settings);
      if (!player) break;
      applyPick(room, player, { cpu: true, timeout: true });
      armNextClock();
      changed = true;
      break;
    }
    if (!room.pickDeadline) {
      room.pickDeadline = new Date(Date.now() + room.pickSeconds * 1000).toISOString();
      room.cpuReadyAt = null;
      changed = true;
    }
    break;
  }
  return changed;
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
    mode: 'official',
    leagueId: room.leagueId,
    conferenceKey: room.conferenceKey || null,
    status: room.status,
    teamCount: room.teamCount,
    rounds: room.rounds,
    pickSeconds: room.pickSeconds,
    teamNames: room.teamNames.slice(),
    franchiseIds: room.franchiseIds.slice(),
    seats: room.seats.map((s) => ({
      index: s.index,
      franchiseId: s.franchiseId,
      userId: s.userId || null,
      userName: s.userName || null,
      isCpu: Boolean(s.isCpu || !s.userId),
      isMe: Boolean(viewerId && s.userId && s.userId === viewerId)
    })),
    picks: room.picks.slice(),
    pickDeadline: room.pickDeadline || null,
    secondsRemaining: (() => {
      if (!room.pickDeadline) return null;
      const ms = Date.parse(room.pickDeadline) - Date.now();
      if (!Number.isFinite(ms)) return null;
      return Math.max(0, Math.ceil(ms / 1000));
    })(),
    onClock: onClock
      ? {
          teamIndex: slot.teamIndex,
          franchiseId: room.franchiseIds[slot.teamIndex],
          teamName: room.teamNames[slot.teamIndex],
          userId: onClock.userId || null,
          userName: onClock.userName || null,
          isCpu: Boolean(onClock.isCpu || !onClock.userId),
          isMe: Boolean(viewerId && onClock.userId === viewerId),
          overall: slot.overall,
          round: slot.round,
          // Manager can pick while connected; CPU fills only after the clock hits zero.
          awaitsHuman: Boolean(onClock.userId)
        }
      : null,
    mySeatIndex: mySeat ? mySeat.index : null,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt
  };
}

function getRoom(roomId) {
  const store = readStore();
  return store.rooms.find((r) => r.id === roomId) || null;
}

function saveRoom(room) {
  const store = readStore();
  const idx = store.rooms.findIndex((r) => r.id === room.id);
  if (idx >= 0) store.rooms[idx] = room;
  else store.rooms.push(room);
  writeStore(store);
  return room;
}

function roomsForLeague(leagueId) {
  return readStore().rooms.filter((r) => r.leagueId === leagueId);
}

function shuffle(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function orderFranchises(franchises, settings) {
  const preferred = Array.isArray(settings.draftOrder) ? settings.draftOrder : [];
  if (preferred.length) {
    const byId = new Map(franchises.map((f) => [String(f.id), f]));
    const ordered = [];
    const used = new Set();
    for (const id of preferred) {
      const f = byId.get(String(id));
      if (f && !used.has(f.id)) {
        ordered.push(f);
        used.add(f.id);
      }
    }
    for (const f of franchises) {
      if (!used.has(f.id)) ordered.push(f);
    }
    return ordered;
  }
  return shuffle(franchises);
}

function buildRoomFromFranchises({ league, franchises, conferenceKey = null }) {
  const settings = leagues.defaultIndependentSettings(league.settings || {});
  const ordered = orderFranchises(franchises, settings);
  if (ordered.length < 2) throw err(400, 'Need at least two franchises to draft');
  const fillCpu = settings.draftFillEmptySeats !== 'hold';
  const seats = ordered.map((f, index) => {
    const hasManager = Boolean(f.managerUserId);
    if (!hasManager && !fillCpu) {
      throw err(400, `Franchise “${f.name}” has no manager — assign managers or allow CPU seats`);
    }
    return {
      index,
      franchiseId: f.id,
      userId: hasManager ? f.managerUserId : null,
      userName: hasManager ? (f.managerName || 'Manager') : null,
      isCpu: !hasManager
    };
  });
  const now = new Date().toISOString();
  const firstHuman = Boolean(seats[0]?.userId);
  // Human managers get a full pick clock (they pick while connected; CPU autopicks only when it expires).
  // Unclaimed CPU seats use a short gap between picks.
  return {
    id: crypto.randomUUID(),
    mode: 'official',
    leagueId: league.id,
    conferenceKey,
    status: 'live',
    teamCount: ordered.length,
    rounds: settings.draftRounds,
    pickSeconds: settings.draftSecondsPerPick,
    teamNames: ordered.map((f) => f.name),
    franchiseIds: ordered.map((f) => f.id),
    seats,
    picks: [],
    pickDeadline: firstHuman
      ? new Date(Date.now() + settings.draftSecondsPerPick * 1000).toISOString()
      : null,
    cpuReadyAt: firstHuman
      ? null
      : new Date(Date.now() + CPU_PICK_GAP_MS).toISOString(),
    createdAt: now,
    updatedAt: now
  };
}

function managersReady(league) {
  const settings = leagues.defaultIndependentSettings(league.settings || {});
  if (settings.draftFillEmptySeats === 'cpu') return true;
  const franchises = Array.isArray(league.franchises) ? league.franchises : [];
  return franchises.length > 0 && franchises.every((f) => f.managerUserId);
}

function startOfficialDraft(leagueId, { force = false } = {}) {
  const league = leagues.findById(leagueId);
  if (!league || league.platform !== 'independent' || league.isSystem) {
    throw err(400, 'Official draft is only for independent leagues');
  }
  const draft = leagues.defaultIndependentDraft(league.draft || {});
  if (draft.status === 'complete') throw err(400, 'Draft already complete');
  if (draft.status === 'live' && draft.roomIds?.length) {
    return { league: leagues.publicLeague(league), rooms: draft.roomIds.map(getRoom).filter(Boolean) };
  }
  const settings = leagues.defaultIndependentSettings(league.settings || {});
  if (!force) {
    if (!settings.draftAt) throw err(400, 'Set a draft date/time in league settings first');
    const at = Date.parse(settings.draftAt);
    if (!Number.isFinite(at) || Date.now() < at) {
      throw err(400, 'Draft start time has not arrived yet');
    }
  }
  if (!managersReady(league)) {
    throw err(400, 'Every franchise needs a manager before this draft can start');
  }

  const franchises = Array.isArray(league.franchises) ? league.franchises : [];
  const rooms = [];
  if (settings.draftScope === 'conference') {
    const byConf = new Map();
    for (const f of franchises) {
      const key = String(f.conferenceKey || '');
      if (!byConf.has(key)) byConf.set(key, []);
      byConf.get(key).push(f);
    }
    for (const [conferenceKey, list] of byConf) {
      rooms.push(buildRoomFromFranchises({ league, franchises: list, conferenceKey }));
    }
  } else {
    rooms.push(buildRoomFromFranchises({ league, franchises, conferenceKey: null }));
  }

  const store = readStore();
  store.rooms = store.rooms.filter((r) => r.leagueId !== leagueId);
  for (const room of rooms) store.rooms.push(room);
  writeStore(store);

  const order = rooms.flatMap((r) => r.franchiseIds);
  leagues.setIndependentDraftState(leagueId, {
    status: 'live',
    roomIds: rooms.map((r) => r.id),
    order,
    picks: [],
    startedAt: new Date().toISOString(),
    completedAt: null
  });

  return { league: leagues.publicLeague(leagues.findById(leagueId)), rooms };
}

function finalizeIfDone(leagueId) {
  const league = leagues.findById(leagueId);
  if (!league || league.platform !== 'independent') return null;
  const draft = leagues.defaultIndependentDraft(league.draft || {});
  if (draft.status === 'complete') return leagues.publicLeague(league);
  const rooms = (draft.roomIds || []).map(getRoom).filter(Boolean);
  if (!rooms.length) return null;
  if (!rooms.every((r) => r.status === 'done')) return null;

  const byFranchise = {};
  const allPicks = [];
  for (const room of rooms) {
    for (const pick of room.picks || []) {
      const fid = pick.franchiseId || room.franchiseIds[pick.teamIndex];
      if (!fid) continue;
      const row = {
        playerId: pick.playerId,
        name: pick.playerName,
        position: pick.position,
        nflTeam: pick.nflTeam,
        headshot: pick.headshot,
        draftOverall: pick.overall,
        round: pick.round,
        pick: pick.pick,
        conferenceKey: room.conferenceKey || null,
        pickedAt: pick.pickedAt || null,
        cpu: Boolean(pick.cpu)
      };
      if (!byFranchise[fid]) byFranchise[fid] = [];
      byFranchise[fid].push(row);
      allPicks.push({ ...row, franchiseId: fid, teamName: pick.teamName });
    }
  }
  return leagues.applyIndependentDraftRosters(leagueId, byFranchise, allPicks);
}

function tickLeague(leagueId, pool, viewerId = null) {
  const league = leagues.findById(leagueId);
  if (!league || league.platform !== 'independent') return null;
  const settings = leagues.defaultIndependentSettings(league.settings || {});
  let draft = leagues.defaultIndependentDraft(league.draft || {});

  if (draft.status === 'scheduled' || !draft.status) {
    if (settings.draftAt && Date.parse(settings.draftAt) <= Date.now() && managersReady(league)) {
      try {
        startOfficialDraft(leagueId);
        draft = leagues.defaultIndependentDraft(leagues.findById(leagueId)?.draft || {});
      } catch {
        /* not ready */
      }
    }
  }

  if (draft.status !== 'live') {
    return {
      league: leagues.publicLeague(leagues.findById(leagueId)),
      rooms: (draft.roomIds || []).map(getRoom).filter(Boolean).map((r) => publicRoom(r, viewerId))
    };
  }

  const store = readStore();
  let changed = false;
  for (const room of store.rooms) {
    if (room.leagueId !== leagueId) continue;
    if (advanceRoom(room, pool, settings)) changed = true;
  }
  if (changed) writeStore(store);

  const finalized = finalizeIfDone(leagueId);
  const latest = leagues.findById(leagueId);
  const roomIds = leagues.defaultIndependentDraft(latest?.draft || {}).roomIds || [];
  return {
    league: leagues.publicLeague(latest),
    rooms: roomIds.map(getRoom).filter(Boolean).map((r) => publicRoom(r, viewerId)),
    finalized: Boolean(finalized)
  };
}

function tickAll(pool) {
  const results = [];
  for (const league of leagues.listIndependentLeaguesForDraftTick()) {
    const draft = leagues.defaultIndependentDraft(league.draft || {});
    const settings = leagues.defaultIndependentSettings(league.settings || {});
    const due = settings.draftAt && Date.parse(settings.draftAt) <= Date.now();
    if (draft.status === 'live' || (draft.status === 'scheduled' && due)) {
      try {
        results.push(tickLeague(league.id, pool));
      } catch {
        /* ignore per-league errors */
      }
    }
  }
  return results;
}

function humanPick(leagueId, roomId, user, playerId, pool) {
  const league = leagues.findById(leagueId);
  if (!league || league.platform !== 'independent') throw err(400, 'Independent league required');
  const room = getRoom(roomId);
  if (!room || room.leagueId !== leagueId) throw err(404, 'Draft room not found');
  if (room.status !== 'live') throw err(400, 'Draft is not live');
  const slot = currentSlot(room);
  if (!slot) throw err(400, 'Draft is complete');
  const seat = room.seats[slot.teamIndex];
  const isOwner = leagues.canManageIndependentLeague(user, league);
  if (!seat?.userId || (seat.userId !== user.id && !isOwner)) {
    throw err(403, 'It is not your turn to pick');
  }
  const id = playerKey(playerId);
  const player = (pool || []).find((p) => playerKey(p.id) === id);
  if (!player) throw err(404, 'Player not found in the pool');
  applyPick(room, player, { cpu: false });
  const settings = leagues.defaultIndependentSettings(league.settings || {});
  const next = currentSlot(room);
  if (next) {
    const nextHuman = Boolean(room.seats[next.teamIndex]?.userId);
    if (nextHuman) {
      room.pickDeadline = new Date(Date.now() + room.pickSeconds * 1000).toISOString();
      room.cpuReadyAt = null;
    } else {
      room.pickDeadline = null;
      room.cpuReadyAt = new Date(Date.now() + CPU_PICK_GAP_MS).toISOString();
    }
  }
  advanceRoom(room, pool, settings);
  saveRoom(room);
  finalizeIfDone(leagueId);
  return publicRoom(getRoom(roomId), user.id);
}

function claimSeat(leagueId, franchiseId, user) {
  const league = leagues.findById(leagueId);
  if (!league || league.platform !== 'independent') throw err(400, 'Independent league required');
  const draft = leagues.defaultIndependentDraft(league.draft || {});
  if (draft.status === 'live' || draft.status === 'complete') {
    throw err(400, 'Cannot claim a franchise after the draft starts');
  }
  const fid = String(franchiseId || '');
  const franchise = (league.franchises || []).find((f) => String(f.id) === fid);
  if (!franchise) throw err(404, 'Franchise not found');
  if (franchise.managerUserId && franchise.managerUserId !== user.id) {
    throw err(409, 'That franchise already has a manager');
  }
  // Clear this user from other franchises in the same league
  const nextFranchises = (league.franchises || []).map((f) => {
    if (String(f.id) === fid) {
      return {
        ...f,
        managerUserId: user.id,
        managerName: user.name || user.loginName || 'Manager'
      };
    }
    if (f.managerUserId === user.id) {
      return { ...f, managerUserId: null, managerName: null };
    }
    return f;
  });
  return leagues.updateIndependentFranchises(leagueId, nextFranchises);
}

module.exports = {
  startOfficialDraft,
  tickLeague,
  tickAll,
  humanPick,
  claimSeat,
  getRoom,
  publicRoom,
  roomsForLeague,
  finalizeIfDone,
  managersReady,
  currentSlot
};
