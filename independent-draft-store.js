/**
 * Official live draft for independent leagues only.
 * Owner schedules a time → lobby opens with live franchise slots → managers join → picks start.
 * Reuses mock-draft clock/CPU/snake mechanics; rooms are league-scoped and never TTL-pruned.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MockDraftCpu = require('./public/js/mock-draft-cpu');
const leagues = require('./leagues-store');
const keepers = require('./independent-keepers');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'independent-draft-rooms.json');
const CPU_PICK_GAP_MS = 2500;
const HUMAN_PICK_GAP_MS = CPU_PICK_GAP_MS + 900;
const JOIN_LOBBY_SECONDS = 240;

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
  const taken = new Set((room.picks || []).map((p) => Number(p.overall)));
  for (let i = 0; i < total; i += 1) {
    if (taken.has(i + 1)) continue;
    const teamIndex = snakeTeamIndex(i, room.teamCount);
    return {
      overall: i + 1,
      round: Math.floor(i / room.teamCount) + 1,
      pick: (i % room.teamCount) + 1,
      teamIndex
    };
  }
  return null;
}

function playerKey(id) {
  return String(id ?? '').trim();
}

function takenIds(room) {
  const set = new Set(
    (room.picks || [])
      .map((p) => playerKey(p.playerId))
      .filter(Boolean)
  );
  for (const id of room.reservedPlayerIds || []) {
    if (id) set.add(String(id));
  }
  return set;
}

function startersFromSettings(settings) {
  const slots = settings?.rosterSlots || {};
  return {
    QB: Number(slots.QB) || 1,
    RB: Number(slots.RB) || 2,
    WR: Number(slots.WR) || 2,
    TE: Number(slots.TE) || 1,
    FLEX: Number(slots.FLEX) || 1,
    SFLEX: Number(slots.SFLEX) || 0,
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
    espnId: player.espnId || null,
    gsisId: player.gsisId || null,
    headshot: player.headshot || null,
    teamLogo: player.teamLogo || null,
    byeWeek: player.byeWeek ?? null,
    cpu: Boolean(cpu),
    timeout: Boolean(timeout),
    pickedAt: new Date().toISOString()
  });
  room.updatedAt = new Date().toISOString();
  if (!currentSlot(room)) {
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
      const player = bestAvailable(pool, room, settings);
      if (!player) break;
      applyPick(room, player, { cpu: true });
      armNextClock();
      changed = true;
      break;
    }
    const revealAt = room.cpuReadyAt ? Date.parse(room.cpuReadyAt) : 0;
    if (Number.isFinite(revealAt) && Date.now() < revealAt) break;
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
  const slot = room.status === 'live' ? currentSlot(room) : null;
  const onClock = slot ? room.seats[slot.teamIndex] : null;
  const mySeat = viewerId
    ? room.seats.find((s) => s.userId === viewerId || s.managerUserId === viewerId)
    : null;
  const lobbyMs = room.lobbyEndsAt ? Date.parse(room.lobbyEndsAt) - Date.now() : null;
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
    seats: room.seats.map((s) => {
      const assigned = Boolean(s.managerUserId);
      const present = Boolean(s.present && s.userId);
      const canJoin = Boolean(
        viewerId
        && !present
        && (room.status === 'lobby' || room.status === 'live')
        && (!assigned || s.managerUserId === viewerId)
        && !(room.seats || []).some((other) => other !== s && other.userId === viewerId)
      );
      return {
        index: s.index,
        franchiseId: s.franchiseId,
        userId: s.userId || null,
        userName: s.userName || s.managerName || null,
        managerUserId: s.managerUserId || null,
        managerName: s.managerName || null,
        present,
        open: !assigned,
        canJoin,
        isCpu: Boolean(s.isCpu || !s.userId),
        isMe: Boolean(viewerId && (s.userId === viewerId || s.managerUserId === viewerId))
      };
    }),
    picks: room.picks.slice(),
    messages: Array.isArray(room.messages) ? room.messages.slice(-80) : [],
    pickDeadline: room.pickDeadline || null,
    cpuReadyAt: room.cpuReadyAt || null,
    lobbyEndsAt: room.lobbyEndsAt || null,
    lobbySecondsRemaining: Number.isFinite(lobbyMs)
      ? Math.max(0, Math.ceil(lobbyMs / 1000))
      : null,
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
          awaitsHuman: Boolean(onClock.userId)
        }
      : null,
    mySeatIndex: mySeat ? mySeat.index : null,
    joinedCount: (room.seats || []).filter((s) => s.present && s.userId).length,
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
  const room = {
    id: crypto.randomUUID(),
    mode: 'official',
    leagueId: league.id,
    conferenceKey,
    status: 'lobby',
    teamCount: ordered.length,
    rounds: settings.draftRounds,
    pickSeconds: settings.draftSecondsPerPick,
    teamNames: ordered.map((f) => f.name),
    franchiseIds: ordered.map((f) => f.id),
    seats: seats.map((s) => ({
      ...s,
      present: false,
      managerUserId: s.userId || null,
      managerName: s.userName || null,
      userId: null,
      userName: s.userName || null,
      isCpu: true
    })),
    picks: [],
    messages: [],
    pickDeadline: null,
    cpuReadyAt: null,
    lobbyEndsAt: new Date(Date.now() + JOIN_LOBBY_SECONDS * 1000).toISOString(),
    createdAt: now,
    updatedAt: now,
    reservedPlayerIds: [...keepers.rosteredPlayerIds(league)]
  };
  keepers.seedKeeperPicks(room, league);
  return room;
}

function beginLivePicks(room) {
  if (!room || room.status !== 'lobby') return false;
  room.status = 'live';
  room.lobbyEndsAt = null;
  for (const seat of room.seats || []) {
    if (seat.present && seat.userId) {
      seat.isCpu = false;
    } else {
      seat.present = false;
      seat.userId = null;
      seat.isCpu = true;
    }
  }
  const first = currentSlot(room);
  if (!first) {
    room.status = 'done';
    room.pickDeadline = null;
    room.cpuReadyAt = null;
    room.updatedAt = new Date().toISOString();
    return true;
  } else if (room.seats[first.teamIndex]?.userId) {
    room.cpuReadyAt = null;
    room.pickDeadline = new Date(Date.now() + room.pickSeconds * 1000).toISOString();
  } else {
    room.pickDeadline = null;
    room.cpuReadyAt = new Date(Date.now() + CPU_PICK_GAP_MS).toISOString();
  }
  room.updatedAt = new Date().toISOString();
  return true;
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
  if (draft.roomIds?.length) {
    const existing = draft.roomIds.map(getRoom).filter(Boolean);
        if (existing.length) {
          return { league: leagues.publicLeague(leagues.findById(leagueId)), rooms: existing };
        }
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
        espnId: pick.espnId || null,
        gsisId: pick.gsisId || null,
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
  pool = keepers.filterDraftPool(league, pool);
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

  const store = readStore();
  let changed = false;
  for (const room of store.rooms) {
    if (room.leagueId !== leagueId) continue;
    if (room.status === 'lobby') {
      const ends = room.lobbyEndsAt ? Date.parse(room.lobbyEndsAt) : 0;
      if (Number.isFinite(ends) && Date.now() >= ends) {
        if (beginLivePicks(room)) changed = true;
      }
      continue;
    }
    if (room.status === 'live' && advanceRoom(room, pool, settings)) changed = true;
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
  const readyAt = room.cpuReadyAt ? Date.parse(room.cpuReadyAt) : 0;
  if (Number.isFinite(readyAt) && Date.now() < readyAt) {
    throw err(400, 'Wait for the next pick');
  }
  const id = playerKey(playerId);
  const player = (pool || []).find((p) => playerKey(p.id) === id);
  if (!player) throw err(404, 'Player not found in the pool');
  applyPick(room, player, { cpu: false });
  const settings = leagues.defaultIndependentSettings(league.settings || {});
  const next = currentSlot(room);
  if (!next) {
    room.pickDeadline = null;
    room.cpuReadyAt = null;
  } else {
    room.pickDeadline = null;
    room.cpuReadyAt = new Date(Date.now() + HUMAN_PICK_GAP_MS).toISOString();
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
  if (draft.status === 'complete') {
    throw err(400, 'Cannot claim a franchise after the draft is complete');
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

function joinDraftSeat(leagueId, roomId, user, seatIndex) {
  if (!user?.id) throw err(401, 'Sign in required');
  const league = leagues.findById(leagueId);
  if (!league || league.platform !== 'independent') throw err(400, 'Independent league required');
  const room = getRoom(roomId);
  if (!room || room.leagueId !== leagueId) throw err(404, 'Draft room not found');
  if (room.status !== 'lobby' && room.status !== 'live') {
    throw err(400, 'This draft is not taking seats');
  }
  const idx = Number(seatIndex);
  if (!Number.isFinite(idx) || idx < 0 || idx >= room.teamCount) {
    throw err(400, 'Choose a slot');
  }
  const seat = room.seats[idx];
  if (!seat) throw err(400, 'Choose a slot');
  const fid = String(seat.franchiseId || '');
  const franchise = (league.franchises || []).find((f) => String(f.id) === fid);
  if (!franchise) throw err(404, 'Franchise not found');
  if (franchise.managerUserId && franchise.managerUserId !== user.id) {
    throw err(403, 'That franchise already has a manager');
  }
  if (seat.present && seat.userId && seat.userId !== user.id) {
    throw err(409, 'That slot is already live');
  }
  if (!franchise.managerUserId) {
    claimSeat(leagueId, fid, user);
  }
  for (const other of room.seats) {
    if (other === seat) continue;
    if (other.userId === user.id) {
      other.present = false;
      other.userId = null;
      other.isCpu = true;
    }
  }
  const name = user.name || user.loginName || 'Manager';
  seat.present = true;
  seat.userId = user.id;
  seat.userName = name;
  seat.managerUserId = user.id;
  seat.managerName = name;
  seat.isCpu = false;
  if (room.status === 'live') {
    const slot = currentSlot(room);
    if (slot && slot.teamIndex === idx) {
      room.cpuReadyAt = null;
      room.pickDeadline = new Date(Date.now() + room.pickSeconds * 1000).toISOString();
    }
  }
  room.updatedAt = new Date().toISOString();
  saveRoom(room);
  return publicRoom(getRoom(roomId), user.id);
}

function skipJoinWindow(leagueId, roomId, user) {
  const league = leagues.findById(leagueId);
  if (!league || league.platform !== 'independent') throw err(400, 'Independent league required');
  if (!leagues.canManageIndependentLeague(user, league)) {
    throw err(403, 'Only the league owner can skip the join window');
  }
  const room = getRoom(roomId);
  if (!room || room.leagueId !== leagueId) throw err(404, 'Draft room not found');
  if (room.status !== 'lobby') throw err(400, 'Join window is not open');
  beginLivePicks(room);
  saveRoom(room);
  return publicRoom(getRoom(roomId), user.id);
}

function addChatMessage({ leagueId, roomId, user, body }) {
  if (!user?.id) throw err(401, 'Sign in required');
  const text = String(body || '').trim().replace(/\s+/g, ' ');
  if (!text) throw err(400, 'Message required');
  if (text.length > 240) throw err(400, 'Keep messages under 240 characters');
  const league = leagues.findById(leagueId);
  if (!league || league.platform !== 'independent') throw err(400, 'Independent league required');
  const room = getRoom(roomId);
  if (!room || room.leagueId !== leagueId) throw err(404, 'Draft room not found');
  if (room.status !== 'live' && room.status !== 'done' && room.status !== 'lobby') {
    throw err(400, 'Draft chat is closed');
  }
  const seated = (room.seats || []).some((s) => s.userId === user.id || s.managerUserId === user.id);
  const isOwner = leagues.canManageIndependentLeague(user, league);
  if (!seated && !isOwner) throw err(403, 'Claim a franchise to chat');
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
  saveRoom(room);
  return { room: publicRoom(room, user.id), message: msg };
}

function deleteRoomsForLeague(leagueId) {
  const id = String(leagueId || '').trim();
  if (!id) return 0;
  const store = readStore();
  const before = store.rooms.length;
  store.rooms = store.rooms.filter((r) => String(r.leagueId || '') !== id);
  const removed = before - store.rooms.length;
  if (removed) writeStore(store);
  return removed;
}

module.exports = {
  startOfficialDraft,
  tickLeague,
  tickAll,
  humanPick,
  claimSeat,
  joinDraftSeat,
  skipJoinWindow,
  addChatMessage,
  getRoom,
  publicRoom,
  roomsForLeague,
  deleteRoomsForLeague,
  finalizeIfDone,
  managersReady,
  currentSlot
};
