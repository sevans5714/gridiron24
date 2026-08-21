/**
 * Free agency, waivers, and trades for independent leagues.
 * GridIron 24 / ESPN leagues do not use this — they stay on ESPN’s wire.
 */
const crypto = require('crypto');
const leagues = require('./leagues-store');

function err(status, message) {
  return Object.assign(new Error(message), { status });
}

function playerKey(p) {
  return String(p?.playerId || p?.id || '').trim();
}

function snapshotPlayer(p, slot = 'BN') {
  const pos = String(p?.position || '').toUpperCase();
  return {
    playerId: playerKey(p),
    espnId: p?.espnId || null,
    gsisId: p?.gsisId || null,
    name: p?.name || p?.playerName || 'Player',
    position: pos === 'DEF' || pos === 'D/ST' ? 'DST' : pos,
    nflTeam: p?.nflTeam || p?.team || '',
    headshot: p?.headshot || null,
    slot
  };
}

function compactPoolPlayer(p) {
  return {
    playerId: String(p.id || p.playerId || ''),
    name: p.name || p.fullName || 'Player',
    position: p.position || '',
    nflTeam: p.team || p.nflTeam || '',
    headshot: p.headshot || null,
    overallRank: p.overallRank ?? null,
    projectedPoints2026: p.projectedPoints2026 ?? null
  };
}

function settingsOf(league) {
  return leagues.defaultIndependentSettings(league?.settings || {});
}

function rosterCap(league) {
  const slots = settingsOf(league).rosterSlots || {};
  return ['QB', 'RB', 'WR', 'TE', 'FLEX', 'DST', 'K', 'BN', 'IR', 'TAXI']
    .reduce((sum, key) => sum + (Number(slots[key]) || 0), 0);
}

function activeCount(roster) {
  return (roster || []).filter((p) => {
    const s = String(p.slot || '').toUpperCase();
    return s !== 'IR' && s !== 'TAXI';
  }).length;
}

function findFranchise(league, franchiseId) {
  const fid = String(franchiseId || '');
  const idx = (league.franchises || []).findIndex((f) => String(f.id) === fid);
  if (idx < 0) throw err(404, 'Franchise not found');
  return { franchise: league.franchises[idx], idx };
}

function actorUser(actor = {}) {
  return {
    id: actor.userId || actor.id || null,
    siteOwner: Boolean(actor.isSiteOwner || actor.siteOwner),
    canSwitchLeagues: Boolean(actor.canSwitchLeagues)
  };
}

function isLeagueOwner(league, actor = {}) {
  const user = actorUser(actor);
  return Boolean(user.siteOwner || leagues.canManageIndependentLeague(user, league));
}

function actorCanManage(league, franchise, actor = {}) {
  if (isLeagueOwner(league, actor)) return true;
  const user = actorUser(actor);
  return Boolean(franchise.managerUserId && String(franchise.managerUserId) === String(user.id));
}

function requireDraftComplete(league) {
  const status = String(league.draft?.status || 'scheduled');
  if (status !== 'complete') {
    throw err(409, 'The wire opens after the draft is complete');
  }
}

function ensureWire(league) {
  const settings = settingsOf(league);
  const ids = (league.franchises || []).map((f) => String(f.id));
  if (!league.wire || typeof league.wire !== 'object') league.wire = {};
  const w = league.wire;
  if (!w.faab || typeof w.faab !== 'object') w.faab = {};
  const budget = Number(settings.faabBudget) || 100;
  for (const id of ids) {
    if (!Number.isFinite(Number(w.faab[id]))) w.faab[id] = budget;
  }
  const prev = Array.isArray(w.waiverOrder) ? w.waiverOrder.map(String) : [];
  const kept = prev.filter((id) => ids.includes(id));
  const missing = ids.filter((id) => !kept.includes(id));
  w.waiverOrder = [...kept, ...missing];
  if (!Array.isArray(w.waivers)) w.waivers = [];
  if (!Array.isArray(w.claims)) w.claims = [];
  if (!Array.isArray(w.trades)) w.trades = [];
  return w;
}

function ownedPlayerIds(league) {
  const ids = new Set();
  for (const f of league.franchises || []) {
    for (const p of f.roster || []) {
      const id = playerKey(p);
      if (id) ids.add(id);
    }
  }
  return ids;
}

function ownerOfPlayer(league, playerId) {
  const id = String(playerId || '');
  for (const f of league.franchises || []) {
    const hit = (f.roster || []).find((p) => playerKey(p) === id);
    if (hit) return { franchise: f, player: hit };
  }
  return null;
}

function waiverEntry(league, playerId) {
  return (league.wire?.waivers || []).find((w) => String(w.playerId) === String(playerId)) || null;
}

function takeFromRoster(franchise, playerId) {
  const id = String(playerId || '');
  const roster = Array.isArray(franchise.roster) ? franchise.roster.slice() : [];
  const idx = roster.findIndex((p) => playerKey(p) === id);
  if (idx < 0) return null;
  const [removed] = roster.splice(idx, 1);
  franchise.roster = roster;
  return removed;
}

function addToRoster(franchise, player, cap) {
  const roster = Array.isArray(franchise.roster) ? franchise.roster.slice() : [];
  if (roster.some((p) => playerKey(p) === playerKey(player))) {
    throw err(409, 'That player is already on this roster');
  }
  if (roster.length >= cap) {
    throw err(400, 'Roster is full — drop a player first');
  }
  roster.push(snapshotPlayer(player, 'BN'));
  franchise.roster = roster;
}

function moveWaiverOrderToEnd(wire, franchiseId) {
  const fid = String(franchiseId);
  const rest = (wire.waiverOrder || []).filter((id) => String(id) !== fid);
  wire.waiverOrder = [...rest, fid];
}

function franchiseRecords(league) {
  const map = new Map();
  for (const f of league.franchises || []) {
    map.set(String(f.id), { wins: 0, losses: 0, ties: 0, pf: 0 });
  }
  const wr = league.weekResults && typeof league.weekResults === 'object' ? league.weekResults : {};
  for (const row of Object.values(wr)) {
    for (const m of row.matchups || []) {
      if (m.result === 'upcoming') continue;
      const homeId = String(m.homeId || m.home?.franchiseId || '');
      const awayId = String(m.awayId || m.away?.franchiseId || '');
      const hs = Number(m.homeScore) || 0;
      const as = Number(m.awayScore) || 0;
      const home = map.get(homeId);
      const away = map.get(awayId);
      if (home) home.pf += hs;
      if (away) away.pf += as;
      if (m.result === 'home') {
        if (home) home.wins += 1;
        if (away) away.losses += 1;
      } else if (m.result === 'away') {
        if (away) away.wins += 1;
        if (home) home.losses += 1;
      } else if (m.result === 'tie') {
        if (home) home.ties += 1;
        if (away) away.ties += 1;
      }
    }
  }
  return map;
}

function claimSort(league, type) {
  const order = (league.wire?.waiverOrder || []).map(String);
  const records = franchiseRecords(league);
  return (a, b) => {
    if (type === 'FAAB') {
      const bid = (Number(b.bid) || 0) - (Number(a.bid) || 0);
      if (bid) return bid;
    }
    if (type === 'reverse-standings') {
      const ra = records.get(String(a.franchiseId)) || { wins: 0, pf: 0 };
      const rb = records.get(String(b.franchiseId)) || { wins: 0, pf: 0 };
      if (ra.wins !== rb.wins) return ra.wins - rb.wins;
      if (ra.pf !== rb.pf) return ra.pf - rb.pf;
    }
    const ia = order.indexOf(String(a.franchiseId));
    const ib = order.indexOf(String(b.franchiseId));
    const oa = ia < 0 ? 999 : ia;
    const ob = ib < 0 ? 999 : ib;
    if (oa !== ob) return oa - ob;
    return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  };
}

function putOnWaivers(league, player, droppedBy) {
  const hours = Number(settingsOf(league).waiverHoldHours) || 0;
  const now = Date.now();
  const clearsAt = new Date(now + hours * 3600 * 1000).toISOString();
  const snap = snapshotPlayer(player);
  const wire = ensureWire(league);
  wire.waivers = wire.waivers.filter((w) => String(w.playerId) !== snap.playerId);
  if (hours <= 0) return { ...snap, clearsAt: new Date(now).toISOString(), immediate: true };
  wire.waivers.push({
    ...snap,
    droppedBy,
    droppedAt: new Date(now).toISOString(),
    clearsAt
  });
  return { ...snap, clearsAt, immediate: false };
}

function listFreeAgents(league, pool, { q = '', pos = '', limit = 60 } = {}) {
  ensureWire(league);
  const owned = ownedPlayerIds(league);
  const onWaivers = new Set((league.wire.waivers || []).map((w) => String(w.playerId)));
  const query = String(q || '').trim().toLowerCase();
  const position = String(pos || '').toUpperCase();
  const rows = (pool || []).filter((p) => {
    const id = String(p.id || p.playerId || '');
    if (!id || owned.has(id) || onWaivers.has(id)) return false;
    const ppos = String(p.position || '').toUpperCase();
    if (position && position !== 'ALL') {
      const want = position === 'DST' || position === 'D/ST' ? 'DST' : position;
      const got = ppos === 'DEF' || ppos === 'D/ST' ? 'DST' : ppos;
      if (got !== want) return false;
    }
    if (query) {
      const hay = `${p.name || ''} ${p.team || p.nflTeam || ''} ${p.position || ''}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });
  rows.sort((a, b) => (Number(a.overallRank) || 9999) - (Number(b.overallRank) || 9999));
  const cap = Math.max(1, Math.min(120, Number(limit) || 60));
  return rows.slice(0, cap).map(compactPoolPlayer);
}

function dropPlayer(leagueId, { franchiseId, playerId, actor }) {
  return leagues.withIndependentLeague(leagueId, (league) => {
    requireDraftComplete(league);
    const wire = ensureWire(league);
    const { franchise, idx } = findFranchise(league, franchiseId);
    if (!actorCanManage(league, franchise, actor)) throw err(403, 'Only this team’s manager can drop players');
    const removed = takeFromRoster(franchise, playerId);
    if (!removed) throw err(404, 'Player is not on this roster');
    league.franchises[idx] = franchise;
    const wa = putOnWaivers(league, removed, franchise.id);
    leagues.pushIndependentTransaction(league, {
      type: 'drop',
      franchiseId: franchise.id,
      franchiseName: franchise.name,
      actorName: actor.name || actor.loginName || 'Manager',
      summary: `Dropped ${removed.name}${wa.immediate ? '' : ' (waivers)'}`
    });
    return publicPayload(league, actor, { dropped: removed, waiver: wa });
  });
}

function addFreeAgent(leagueId, { franchiseId, player, dropPlayerId, actor }) {
  return leagues.withIndependentLeague(leagueId, (league) => {
    requireDraftComplete(league);
    const wire = ensureWire(league);
    const { franchise, idx } = findFranchise(league, franchiseId);
    if (!actorCanManage(league, franchise, actor)) throw err(403, 'Only this team’s manager can add players');
    const snap = snapshotPlayer(player);
    if (!snap.playerId) throw err(400, 'Pick a player');
    if (ownedPlayerIds(league).has(snap.playerId)) throw err(409, 'That player is already rostered');
    if (waiverEntry(league, snap.playerId)) {
      throw err(409, 'That player is on waivers — put in a claim');
    }
    if (dropPlayerId) {
      const dropped = takeFromRoster(franchise, dropPlayerId);
      if (!dropped) throw err(400, 'Drop a player who is on this roster');
      putOnWaivers(league, dropped, franchise.id);
      leagues.pushIndependentTransaction(league, {
        type: 'drop',
        franchiseId: franchise.id,
        franchiseName: franchise.name,
        actorName: actor.name || actor.loginName || 'Manager',
        summary: `Dropped ${dropped.name} (waivers)`
      });
    }
    addToRoster(franchise, snap, rosterCap(league));
    league.franchises[idx] = franchise;
    leagues.pushIndependentTransaction(league, {
      type: 'add',
      franchiseId: franchise.id,
      franchiseName: franchise.name,
      actorName: actor.name || actor.loginName || 'Manager',
      summary: `Added ${snap.name}`
    });
    return publicPayload(league, actor, { added: snap });
  });
}

function claimWaiver(leagueId, { franchiseId, playerId, dropPlayerId, bid, actor }) {
  return leagues.withIndependentLeague(leagueId, (league) => {
    requireDraftComplete(league);
    const wire = ensureWire(league);
    const settings = settingsOf(league);
    const { franchise } = findFranchise(league, franchiseId);
    if (!actorCanManage(league, franchise, actor)) throw err(403, 'Only this team’s manager can claim');
    const entry = waiverEntry(league, playerId);
    if (!entry) throw err(404, 'That player is not on waivers');
    if (dropPlayerId && !franchise.roster.some((p) => playerKey(p) === String(dropPlayerId))) {
      throw err(400, 'Drop a player who is on this roster');
    }
    const amount = Math.max(0, Math.round(Number(bid) || 0));
    if (settings.waiverType === 'FAAB') {
      const have = Number(wire.faab[franchise.id]) || 0;
      if (amount > have) throw err(400, `Bid exceeds remaining FAAB ($${have})`);
    }
    wire.claims = wire.claims.filter((c) => !(
      c.status === 'pending'
      && String(c.franchiseId) === String(franchise.id)
      && String(c.playerId) === String(playerId)
    ));
    const claim = {
      id: crypto.randomUUID(),
      franchiseId: franchise.id,
      franchiseName: franchise.name,
      playerId: entry.playerId,
      playerName: entry.name,
      dropPlayerId: dropPlayerId ? String(dropPlayerId) : null,
      bid: settings.waiverType === 'FAAB' ? amount : 0,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    wire.claims.push(claim);
    return publicPayload(league, actor, { claim });
  });
}

function cancelClaim(leagueId, { claimId, actor }) {
  return leagues.withIndependentLeague(leagueId, (league) => {
    const wire = ensureWire(league);
    const claim = wire.claims.find((c) => String(c.id) === String(claimId));
    if (!claim) throw err(404, 'Claim not found');
    if (claim.status !== 'pending') throw err(409, 'That claim is already resolved');
    const { franchise } = findFranchise(league, claim.franchiseId);
    if (!actorCanManage(league, franchise, actor)) throw err(403, 'Only this team’s manager can cancel');
    claim.status = 'cancelled';
    claim.resolvedAt = new Date().toISOString();
    return publicPayload(league, actor);
  });
}

function tryAwardClaim(league, claim) {
  const cap = rosterCap(league);
  const { franchise, idx } = findFranchise(league, claim.franchiseId);
  const wire = league.wire;
  const settings = settingsOf(league);
  if (ownedPlayerIds(league).has(String(claim.playerId))) return 'lost';
  const dropNeeded = Boolean(claim.dropPlayerId);
  if (dropNeeded && !(franchise.roster || []).some((p) => playerKey(p) === String(claim.dropPlayerId))) {
    return 'lost';
  }
  const nextLen = (franchise.roster || []).length - (dropNeeded ? 1 : 0) + 1;
  if (nextLen > cap) return 'lost';
  if (settings.waiverType === 'FAAB') {
    const have = Number(wire.faab[franchise.id]) || 0;
    const bid = Math.max(0, Number(claim.bid) || 0);
    if (bid > have) return 'lost';
  }
  if (claim.dropPlayerId) {
    const dropped = takeFromRoster(franchise, claim.dropPlayerId);
    if (!dropped) return 'lost';
    putOnWaivers(league, dropped, franchise.id);
  }
  const entry = waiverEntry(league, claim.playerId) || { playerId: claim.playerId, name: claim.playerName };
  addToRoster(franchise, entry, cap);
  if (settings.waiverType === 'FAAB') {
    const have = Number(wire.faab[franchise.id]) || 0;
    wire.faab[franchise.id] = have - Math.max(0, Number(claim.bid) || 0);
  }
  league.franchises[idx] = franchise;
  if (settings.waiverType === 'rolling') moveWaiverOrderToEnd(wire, franchise.id);
  leagues.pushIndependentTransaction(league, {
    type: 'waiver',
    franchiseId: franchise.id,
    franchiseName: franchise.name,
    summary: `Claimed ${claim.playerName || 'player'}${settings.waiverType === 'FAAB' ? ` for $${claim.bid}` : ''}`
  });
  return 'won';
}

function processWaivers(leagueId, { force = false, actor = null } = {}) {
  return leagues.withIndependentLeague(leagueId, (league) => {
    const wire = ensureWire(league);
    const settings = settingsOf(league);
    if (actor && !isLeagueOwner(league, actor)) {
      throw err(403, 'Only the league owner can process waivers');
    }
    const now = Date.now();
    const due = (wire.waivers || []).filter((w) => force || Date.parse(w.clearsAt || 0) <= now);
    if (!due.length) {
      return publicPayload(league, actor, { processed: 0 });
    }
    let processed = 0;
    for (const entry of due) {
      const pending = wire.claims.filter((c) =>
        c.status === 'pending' && String(c.playerId) === String(entry.playerId)
      );
      pending.sort(claimSort(league, settings.waiverType));
      let winner = null;
      for (const claim of pending) {
        const result = tryAwardClaim(league, claim);
        claim.status = result;
        claim.resolvedAt = new Date().toISOString();
        if (result === 'won') {
          winner = claim;
          break;
        }
      }
      for (const claim of pending) {
        if (claim.status === 'pending') {
          claim.status = 'lost';
          claim.resolvedAt = new Date().toISOString();
        }
      }
      wire.waivers = wire.waivers.filter((w) => String(w.playerId) !== String(entry.playerId));
      processed += 1;
      if (!winner) {
        /* clears to free agency */
      }
    }
    wire.lastProcessedAt = new Date().toISOString();
    return publicPayload(league, actor, { processed });
  });
}

function processDueLeagues() {
  const results = [];
  for (const league of leagues.listIndependentLeaguesForDraftTick()) {
    const due = (league.wire?.waivers || []).some((w) => Date.parse(w.clearsAt || 0) <= Date.now())
      && (league.wire?.claims || []).some((c) => c.status === 'pending');
    const expired = (league.wire?.waivers || []).some((w) => Date.parse(w.clearsAt || 0) <= Date.now());
    if (!due && !expired) continue;
    try {
      results.push(processWaivers(league.id, { force: false }));
    } catch { /* skip */ }
  }
  return results;
}

function proposeTrade(leagueId, body, actor) {
  return leagues.withIndependentLeague(leagueId, (league) => {
    requireDraftComplete(league);
    ensureWire(league);
    const fromId = String(body.fromFranchiseId || body.franchiseId || '');
    const toId = String(body.toFranchiseId || '');
    if (!fromId || !toId || fromId === toId) throw err(400, 'Pick two different teams');
    const { franchise: from } = findFranchise(league, fromId);
    const { franchise: to } = findFranchise(league, toId);
    if (!actorCanManage(league, from, actor) && !isLeagueOwner(league, actor)) {
      throw err(403, 'Only this team’s manager can propose a trade');
    }
    const sendIds = Array.isArray(body.send) ? body.send.map(String).filter(Boolean) : [];
    const receiveIds = Array.isArray(body.receive) ? body.receive.map(String).filter(Boolean) : [];
    if (!sendIds.length && !receiveIds.length && !(Number(body.sendFaab) || Number(body.receiveFaab))) {
      throw err(400, 'A trade needs players or FAAB');
    }
    for (const id of sendIds) {
      if (!from.roster.some((p) => playerKey(p) === id)) throw err(400, 'You can only send players you own');
    }
    for (const id of receiveIds) {
      if (!to.roster.some((p) => playerKey(p) === id)) throw err(400, 'They do not own one of those players');
    }
    const sendFaab = Math.max(0, Math.round(Number(body.sendFaab) || 0));
    const receiveFaab = Math.max(0, Math.round(Number(body.receiveFaab) || 0));
    const cap = rosterCap(league);
    if ((from.roster || []).length - sendIds.length + receiveIds.length > cap) {
      throw err(400, 'Your roster cannot fit this trade — drop someone first');
    }
    if ((to.roster || []).length - receiveIds.length + sendIds.length > cap) {
      throw err(400, 'Their roster cannot fit this trade');
    }
    if (sendFaab > (Number(league.wire.faab[from.id]) || 0)) throw err(400, 'Not enough FAAB to send');
    if (receiveFaab > (Number(league.wire.faab[to.id]) || 0)) throw err(400, 'They do not have that FAAB');
    const trade = {
      id: crypto.randomUUID(),
      fromId: from.id,
      fromName: from.name,
      toId: to.id,
      toName: to.name,
      send: sendIds.map((id) => snapshotPlayer(from.roster.find((p) => playerKey(p) === id))),
      receive: receiveIds.map((id) => snapshotPlayer(to.roster.find((p) => playerKey(p) === id))),
      sendFaab,
      receiveFaab,
      status: 'proposed',
      createdAt: new Date().toISOString(),
      proposedBy: actor.userId || actor.id || null
    };
    league.wire.trades.push(trade);
    return publicPayload(league, actor, { trade });
  });
}

function executeTrade(league, trade) {
  const cap = rosterCap(league);
  const { franchise: from, idx: fromIdx } = findFranchise(league, trade.fromId);
  const { franchise: to, idx: toIdx } = findFranchise(league, trade.toId);
  const wire = ensureWire(league);
  const sendIds = (trade.send || []).map((p) => playerKey(p));
  const receiveIds = (trade.receive || []).map((p) => playerKey(p));
  const sendPlayers = sendIds.map((id) => {
    const p = takeFromRoster(from, id);
    if (!p) throw err(409, 'A listed player is no longer on the roster');
    return p;
  });
  const receivePlayers = receiveIds.map((id) => {
    const p = takeFromRoster(to, id);
    if (!p) throw err(409, 'A listed player is no longer on the roster');
    return p;
  });
  for (const p of receivePlayers) addToRoster(from, p, cap);
  for (const p of sendPlayers) addToRoster(to, p, cap);
  const sendFaab = Math.max(0, Number(trade.sendFaab) || 0);
  const receiveFaab = Math.max(0, Number(trade.receiveFaab) || 0);
  if (sendFaab) {
    const have = Number(wire.faab[from.id]) || 0;
    if (sendFaab > have) throw err(400, 'Not enough FAAB to send');
    wire.faab[from.id] = have - sendFaab;
    wire.faab[to.id] = (Number(wire.faab[to.id]) || 0) + sendFaab;
  }
  if (receiveFaab) {
    const have = Number(wire.faab[to.id]) || 0;
    if (receiveFaab > have) throw err(400, 'The other team does not have that FAAB');
    wire.faab[to.id] = have - receiveFaab;
    wire.faab[from.id] = (Number(wire.faab[from.id]) || 0) + receiveFaab;
  }
  league.franchises[fromIdx] = from;
  league.franchises[toIdx] = to;
  const pieces = [
    ...(trade.send || []).map((p) => p.name),
    ...(trade.receive || []).map((p) => p.name)
  ];
  leagues.pushIndependentTransaction(league, {
    type: 'trade',
    franchiseId: from.id,
    franchiseName: from.name,
    summary: `Trade: ${from.name} ⇄ ${to.name}${pieces.length ? ` (${pieces.join(', ')})` : ''}`
  });
}

function respondTrade(leagueId, { tradeId, action, actor }) {
  return leagues.withIndependentLeague(leagueId, (league) => {
    ensureWire(league);
    const trade = league.wire.trades.find((t) => String(t.id) === String(tradeId));
    if (!trade) throw err(404, 'Trade not found');
    if (trade.status !== 'proposed') throw err(409, 'That trade is already resolved');
    const act = String(action || '').toLowerCase();
    const { franchise: from } = findFranchise(league, trade.fromId);
    const { franchise: to } = findFranchise(league, trade.toId);
    const owner = isLeagueOwner(league, actor);
    if (act === 'cancel') {
      if (!actorCanManage(league, from, actor) && !owner) throw err(403, 'Only the proposing team can cancel');
      trade.status = 'cancelled';
      trade.resolvedAt = new Date().toISOString();
      return publicPayload(league, actor, { trade });
    }
    if (act === 'reject') {
      if (!actorCanManage(league, to, actor) && !owner) throw err(403, 'Only the other team can reject');
      trade.status = 'rejected';
      trade.resolvedAt = new Date().toISOString();
      return publicPayload(league, actor, { trade });
    }
    if (act === 'veto') {
      if (!owner) throw err(403, 'Only the league owner can veto');
      trade.status = 'vetoed';
      trade.resolvedAt = new Date().toISOString();
      return publicPayload(league, actor, { trade });
    }
    if (act === 'accept' || act === 'force') {
      if (act === 'force' && !owner) throw err(403, 'Only the league owner can force a trade');
      if (act === 'accept' && !actorCanManage(league, to, actor) && !owner) {
        throw err(403, 'Only the other team can accept');
      }
      executeTrade(league, trade);
      trade.status = 'completed';
      trade.resolvedAt = new Date().toISOString();
      return publicPayload(league, actor, { trade });
    }
    throw err(400, 'Unknown trade action');
  });
}

function publicPayload(league, actor = {}, extra = {}) {
  const wire = ensureWire(league);
  const settings = settingsOf(league);
  const viewerId = actor.userId || actor.id || null;
  const mine = (league.franchises || []).find((f) => f.managerUserId && String(f.managerUserId) === String(viewerId))
    || null;
  const order = wire.waiverOrder || [];
  return {
    ok: true,
    league: leagues.publicLeague(league),
    settings: {
      waiverType: settings.waiverType,
      faabBudget: settings.faabBudget,
      waiverHoldHours: settings.waiverHoldHours
    },
    myFranchise: mine ? {
      id: mine.id,
      name: mine.name,
      faab: Number(wire.faab[mine.id]) || 0,
      waiverRank: order.indexOf(String(mine.id)) + 1,
      roster: mine.roster || []
    } : null,
    faab: wire.faab,
    waiverOrder: order.map((id, i) => {
      const f = (league.franchises || []).find((row) => String(row.id) === String(id));
      return { franchiseId: id, name: f?.name || id, rank: i + 1, faab: Number(wire.faab[id]) || 0 };
    }),
    waivers: wire.waivers.slice().sort((a, b) => String(a.clearsAt).localeCompare(String(b.clearsAt))),
    claims: wire.claims.filter((c) => c.status === 'pending' || Date.parse(c.resolvedAt || 0) > Date.now() - 7 * 86400000),
    trades: wire.trades.filter((t) => t.status === 'proposed' || Date.parse(t.resolvedAt || t.createdAt || 0) > Date.now() - 14 * 86400000),
    lastProcessedAt: wire.lastProcessedAt || null,
    ...extra
  };
}

function getWire(leagueId, actor, pool, query = {}) {
  const league = leagues.findById(leagueId);
  if (!league || league.platform !== 'independent') throw err(404, 'League not found');
  ensureWire(league);
  const payload = publicPayload(league, actor);
  payload.freeAgents = listFreeAgents(league, pool, query);
  payload.franchises = (league.franchises || []).map((f) => ({
    id: f.id,
    name: f.name,
    managerName: f.managerName || null,
    managerUserId: f.managerUserId || null,
    roster: f.roster || []
  }));
  return payload;
}

module.exports = {
  getWire,
  listFreeAgents,
  addFreeAgent,
  dropPlayer,
  claimWaiver,
  cancelClaim,
  processWaivers,
  processDueLeagues,
  proposeTrade,
  respondTrade,
  snapshotPlayer,
  ensureWire
};
