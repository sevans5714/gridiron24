/**
 * IR, taxi, keepers, and dynasty for independent leagues.
 * Format is per-league (redraft / keeper / dynasty) — not GridIron 24.
 */
const leagues = require('./leagues-store');

function err(status, message) {
  return Object.assign(new Error(message), { status });
}

function playerKey(p) {
  return String(p?.playerId || p?.id || '').trim();
}

function settingsOf(league) {
  return leagues.defaultIndependentSettings(league?.settings || {});
}

const IR_STATUSES = new Set([
  'OUT', 'IR', 'PUP', 'DOUBTFUL', 'D', 'O',
  'INJURED_RESERVE', 'INJURY_RESERVE', 'NA', 'NFI',
  'SUS', 'SUSPENDED', 'COVID', 'COV', 'INACTIVE'
]);

function normalizeInjury(status) {
  return String(status || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
}

function irEligible(status, settings = {}) {
  if (settings.irOpen === true) return true;
  const s = normalizeInjury(status);
  if (!s || s === 'ACTIVE' || s === 'HEALTHY' || s === 'NORMAL' || s === 'QUESTIONABLE' || s === 'Q') {
    return false;
  }
  return IR_STATUSES.has(s) || s.includes('RESERVE') || s.includes('PUP');
}

function isReserveSlot(slot) {
  const s = String(slot || '').toUpperCase();
  return s === 'IR' || s === 'TAXI';
}

function taxiEligible(player, league) {
  const settings = settingsOf(league);
  if (settings.taxiRookieOnly === false) return true;
  const exp = Number(player?.yearsExp);
  if (Number.isFinite(exp) && exp <= 0) return true;
  const season = Number(league?.season) || new Date().getFullYear();
  if (Number(player?.acquiredYear) === season && String(player?.acquiredType || '') === 'draft') return true;
  return false;
}

function keepersOn(settings = {}) {
  return Boolean(settings.keepersEnabled) && settings.leagueFormat !== 'dynasty';
}

function keeperCostRound(player, settings, seasonsKept = 0) {
  const format = settings.leagueFormat || 'redraft';
  const cost = settings.keeperCost || 'none';
  if (!keepersOn(settings) || format === 'dynasty' || cost === 'none') return null;
  const last = Math.max(1, Number(settings.draftRounds) || 15);
  const base = Number(player?.acquiredRound);
  const start = Number.isFinite(base) && base >= 1 ? base : last;
  if (cost === 'round') return Math.min(last, Math.max(1, start));
  return Math.min(last, Math.max(1, start - Math.max(0, Number(seasonsKept) || 0)));
}

function maxKeepers(league) {
  const s = settingsOf(league);
  if (!keepersOn(s)) return 0;
  return Math.max(0, Number(s.keeperCount) || 0);
}

function nextSeason(league) {
  return (Number(league?.season) || new Date().getFullYear()) + 1;
}

function ensureKeepers(league) {
  const year = nextSeason(league);
  if (!league.keepers || typeof league.keepers !== 'object') {
    league.keepers = { season: year, status: 'open', declarations: [] };
  }
  if (!Array.isArray(league.keepers.declarations)) league.keepers.declarations = [];
  if (!league.keepers.season) league.keepers.season = year;
  return league.keepers;
}

function isOwnerActor(league, actor = {}) {
  return leagues.canManageIndependentLeague({
    id: actor.id || actor.userId
  }, league);
}

function canActForFranchise(league, franchise, actor = {}) {
  if (isOwnerActor(league, actor)) return true;
  return Boolean(franchise?.managerUserId && String(franchise.managerUserId) === String(actor.id || actor.userId));
}

function declarationsFor(league, franchiseId) {
  return (ensureKeepers(league).declarations || []).filter((d) =>
    d.status !== 'cancelled' && String(d.franchiseId) === String(franchiseId)
  );
}

function findFranchise(league, franchiseId) {
  return (league.franchises || []).find((f) => String(f.id) === String(franchiseId)) || null;
}

function findPlayer(franchise, playerId) {
  return (franchise?.roster || []).find((p) => playerKey(p) === String(playerId)) || null;
}

function injuryMapFromPool(pool = []) {
  const map = new Map();
  for (const p of pool) {
    const status = p.injuryStatus || null;
    const ids = [p.id, p.playerId, p.gsisId, p.espnId ? `espn-${p.espnId}` : ''];
    for (const id of ids) {
      if (id) map.set(String(id), status);
    }
  }
  return map;
}

function playerInjury(player, injuries) {
  if (player?.injuryStatus) return player.injuryStatus;
  if (!injuries) return null;
  for (const key of [playerKey(player), player?.gsisId, player?.espnId]) {
    if (key && injuries.has(String(key))) return injuries.get(String(key));
  }
  return null;
}

function validateReserveSlots(league, franchise, nextRoster, injuries) {
  const settings = settingsOf(league);
  const slots = settings.rosterSlots || {};
  const irCap = Number(slots.IR) || 0;
  const taxiCap = Number(slots.TAXI) || 0;
  let irCount = 0;
  let taxiCount = 0;
  for (const p of nextRoster) {
    const slot = String(p.slot || '').toUpperCase();
    if (slot === 'IR') {
      irCount += 1;
      if (irCap <= 0) throw err(400, 'This league has no IR slots');
      if (irCount > irCap) throw err(400, `Only ${irCap} IR slot${irCap === 1 ? '' : 's'} allowed`);
      const status = playerInjury(p, injuries);
      if (!irEligible(status, settings)) {
        throw err(400, `${p.name || 'Player'} is not IR-eligible (needs Out / IR / PUP / Doubtful)`);
      }
    }
    if (slot === 'TAXI') {
      taxiCount += 1;
      if (taxiCap <= 0) throw err(400, 'This league has no taxi squad');
      if (taxiCount > taxiCap) throw err(400, `Only ${taxiCap} taxi slot${taxiCap === 1 ? '' : 's'} allowed`);
      if (!taxiEligible(p, league)) {
        throw err(400, `${p.name || 'Player'} cannot go on taxi (rookies / first-year draftees only)`);
      }
    }
  }
}

function rosteredPlayerIds(league) {
  const ids = new Set();
  for (const f of league.franchises || []) {
    for (const p of f.roster || []) {
      const id = playerKey(p);
      if (id) ids.add(id);
    }
  }
  return ids;
}

function isRookie(player) {
  const exp = Number(player?.yearsExp);
  if (Number.isFinite(exp)) return exp <= 0;
  return false;
}

function filterDraftPool(league, pool = []) {
  const settings = settingsOf(league);
  const owned = rosteredPlayerIds(league);
  let rows = (pool || []).filter((p) => {
    const id = String(p.id || p.playerId || '');
    return id && !owned.has(id);
  });
  const rookieDraft = settings.draftPool === 'rookies'
    || (settings.leagueFormat === 'dynasty' && settings.draftPool !== 'all');
  if (rookieDraft) {
    const tagged = rows.some((p) => Number.isFinite(Number(p.yearsExp)));
    if (tagged) rows = rows.filter((p) => isRookie(p));
  }
  return rows;
}

function consumedKeeperSlots(league) {
  const settings = settingsOf(league);
  if (!keepersOn(settings) || (settings.keeperCost || 'none') === 'none') return [];
  const keepers = ensureKeepers(league);
  return (keepers.declarations || [])
    .filter((d) => d.status !== 'cancelled' && d.costRound)
    .map((d) => ({
      franchiseId: d.franchiseId,
      round: Number(d.costRound),
      playerId: d.playerId,
      playerName: d.playerName,
      position: d.position,
      nflTeam: d.nflTeam
    }));
}

function overallForFranchiseRound(franchiseIds, round, franchiseId) {
  const n = franchiseIds.length;
  if (n < 1 || round < 1) return null;
  const start = (round - 1) * n;
  for (let i = 0; i < n; i += 1) {
    const overallZero = start + i;
    const roundIndex = Math.floor(overallZero / n);
    const pos = overallZero % n;
    const teamIndex = roundIndex % 2 === 0 ? pos : n - 1 - pos;
    if (String(franchiseIds[teamIndex]) === String(franchiseId)) return overallZero + 1;
  }
  return null;
}

function seedKeeperPicks(room, league) {
  const consumed = consumedKeeperSlots(league);
  if (!consumed.length) return 0;
  const byFid = new Map();
  for (const f of league.franchises || []) byFid.set(String(f.id), f);
  let added = 0;
  const have = new Set((room.picks || []).map((p) => Number(p.overall)));
  for (const row of consumed) {
    const overall = overallForFranchiseRound(room.franchiseIds, row.round, row.franchiseId);
    if (!overall || have.has(overall)) continue;
    const n = room.teamCount;
    const i = overall - 1;
    const teamIndex = Math.floor(i / n) % 2 === 0
      ? (i % n)
      : n - 1 - (i % n);
    const franchise = byFid.get(String(row.franchiseId));
    const player = (franchise?.roster || []).find((p) => playerKey(p) === String(row.playerId));
    room.picks.push({
      overall,
      round: row.round,
      pick: (i % n) + 1,
      teamIndex,
      franchiseId: row.franchiseId,
      teamName: room.teamNames[teamIndex],
      playerId: row.playerId,
      playerName: row.playerName || player?.name || 'Keeper',
      position: row.position || player?.position || '',
      nflTeam: row.nflTeam || player?.nflTeam || '',
      espnId: player?.espnId || null,
      gsisId: player?.gsisId || null,
      headshot: player?.headshot || null,
      cpu: false,
      timeout: false,
      keeper: true,
      pickedAt: new Date().toISOString()
    });
    have.add(overall);
    added += 1;
  }
  room.picks.sort((a, b) => (Number(a.overall) || 0) - (Number(b.overall) || 0));
  return added;
}

function publicKeepers(league, actor = {}) {
  const settings = settingsOf(league);
  const keepers = ensureKeepers(league);
  const viewerId = actor.id || actor.userId || null;
  const mine = (league.franchises || []).find((f) => f.managerUserId && String(f.managerUserId) === String(viewerId))
    || null;
  const format = settings.leagueFormat || 'redraft';
  return {
    ok: true,
    league: leagues.publicLeague(league),
    format,
    settings: {
      leagueFormat: format,
      keepersEnabled: keepersOn(settings),
      keeperCount: settings.keeperCount,
      keeperMaxSeasons: settings.keeperMaxSeasons,
      keeperCost: settings.keeperCost || 'none',
      draftPool: settings.draftPool || (format === 'dynasty' ? 'rookies' : 'all'),
      irSlots: Number(settings.rosterSlots?.IR) || 0,
      taxiSlots: Number(settings.rosterSlots?.TAXI) || 0,
      irOpen: settings.irOpen === true,
      taxiRookieOnly: settings.taxiRookieOnly !== false
    },
    status: keepers.status,
    season: keepers.season,
    declarations: keepers.declarations.filter((d) => d.status !== 'cancelled'),
    myFranchise: mine ? {
      id: mine.id,
      name: mine.name,
      roster: (mine.roster || []).map((p) => ({
        ...p,
        costRound: keeperCostRound(p, settings, Number(p.keeperSeasons) || 0),
        declared: keepers.declarations.some((d) =>
          d.status !== 'cancelled' && String(d.franchiseId) === String(mine.id) && String(d.playerId) === playerKey(p)
        )
      }))
    } : null
  };
}

function getKeepers(leagueId, actor) {
  const league = leagues.findById(leagueId);
  if (!league || league.platform !== 'independent') throw err(404, 'League not found');
  ensureKeepers(league);
  return publicKeepers(league, actor);
}

function declareKeeper(leagueId, { franchiseId, playerId, actor }) {
  return leagues.withIndependentLeague(leagueId, (league) => {
    const settings = settingsOf(league);
    const format = settings.leagueFormat || 'redraft';
    if (!keepersOn(settings)) {
      throw err(400, 'Keepers are off in this league');
    }
    if (format === 'dynasty') {
      throw err(400, 'Dynasty leagues keep the whole roster automatically');
    }
    const keepers = ensureKeepers(league);
    if (keepers.status === 'locked') throw err(409, 'Keeper declarations are locked');
    const franchise = findFranchise(league, franchiseId);
    if (!franchise) throw err(404, 'Franchise not found');
    if (!canActForFranchise(league, franchise, actor)) {
      throw err(403, 'Only this team’s manager can declare keepers');
    }
    const player = findPlayer(franchise, playerId);
    if (!player) throw err(404, 'Player is not on this roster');
    const existing = declarationsFor(league, franchiseId);
    if (existing.some((d) => String(d.playerId) === playerKey(player))) {
      return publicKeepers(league, actor);
    }
    const cap = maxKeepers(league);
    if (existing.length >= cap) {
      throw err(400, `This league allows ${cap} keeper${cap === 1 ? '' : 's'} per team`);
    }
    const seasonsKept = Number(player.keeperSeasons) || 0;
    if (seasonsKept >= (Number(settings.keeperMaxSeasons) || 3)) {
      throw err(400, `${player.name || 'Player'} has reached the keeper-season limit`);
    }
    const costRound = keeperCostRound(player, settings, seasonsKept);
    if (costRound && existing.some((d) => Number(d.costRound) === Number(costRound))) {
      throw err(400, `You already have a keeper costing round ${costRound}`);
    }
    keepers.declarations.push({
      id: `${franchise.id}:${playerKey(player)}`,
      franchiseId: franchise.id,
      franchiseName: franchise.name,
      playerId: playerKey(player),
      playerName: player.name,
      position: player.position,
      nflTeam: player.nflTeam || player.team || '',
      acquiredRound: player.acquiredRound || null,
      costRound,
      seasonsKept,
      status: 'declared',
      declaredAt: new Date().toISOString()
    });
    return publicKeepers(league, actor);
  });
}

function undeclareKeeper(leagueId, { franchiseId, playerId, actor }) {
  return leagues.withIndependentLeague(leagueId, (league) => {
    const keepers = ensureKeepers(league);
    if (keepers.status === 'locked') throw err(409, 'Keeper declarations are locked');
    const franchise = findFranchise(league, franchiseId);
    if (!franchise) throw err(404, 'Franchise not found');
    if (!canActForFranchise(league, franchise, actor)) {
      throw err(403, 'Only this team’s manager can change keepers');
    }
    keepers.declarations = keepers.declarations.filter((d) => !(
      String(d.franchiseId) === String(franchiseId) && String(d.playerId) === String(playerId)
    ));
    return publicKeepers(league, actor);
  });
}

function lockKeepers(leagueId, actor) {
  return leagues.withIndependentLeague(leagueId, (league) => {
    if (!isOwnerActor(league, actor)) throw err(403, 'Only the league owner can lock keepers');
    const keepers = ensureKeepers(league);
    keepers.status = 'locked';
    keepers.lockedAt = new Date().toISOString();
    return publicKeepers(league, actor);
  });
}

function persistManagersCareer(league) {
  const career = require('./career-store');
  const season = Number(league.season) || new Date().getFullYear();
  const champId = leagues.independentChampionFranchiseId(league);
  const leagueName = (league.brand && league.brand.name) || league.slug;
  for (const f of league.franchises || []) {
    if (!f.managerUserId) continue;
    const rec = leagues.independentRecordForFranchise(league, f.id);
    try {
      career.assignPastTeam({
        userId: f.managerUserId,
        season,
        platform: 'independent',
        leagueId: league.id,
        leagueName,
        conferenceKey: f.conferenceKey,
        franchiseId: f.id,
        teamId: f.id,
        teamName: f.name,
        ownerName: f.managerName || null,
        wins: rec.wins,
        losses: rec.losses,
        ties: rec.ties,
        pointsFor: rec.pointsFor,
        pointsAgainst: rec.pointsAgainst,
        playoff: rec.playoff,
        champion: Boolean(champId && String(f.id) === String(champId)),
        assignedBy: 'rollover'
      });
    } catch { /* skip a bad seat */ }
  }
}

function rolloverSeason(leagueId, actor) {
  return leagues.withIndependentLeague(leagueId, (league) => {
    if (!isOwnerActor(league, actor)) throw err(403, 'Only the league owner can start the next season');
    persistManagersCareer(league);
    const settings = settingsOf(league);
    const format = settings.leagueFormat || 'redraft';
    const keepers = ensureKeepers(league);
    const keptIds = new Map();
    for (const d of keepers.declarations || []) {
      if (d.status === 'cancelled') continue;
      const set = keptIds.get(d.franchiseId) || new Set();
      set.add(String(d.playerId));
      keptIds.set(d.franchiseId, set);
    }
    league.franchises = (league.franchises || []).map((f) => {
      const roster = Array.isArray(f.roster) ? f.roster : [];
      let nextRoster;
      if (format === 'dynasty') {
        nextRoster = roster.map((p) => ({
          ...p,
          keeperSeasons: (Number(p.keeperSeasons) || 0) + 1,
          taxiSeasons: String(p.slot || '').toUpperCase() === 'TAXI'
            ? (Number(p.taxiSeasons) || 0) + 1
            : (Number(p.taxiSeasons) || 0)
        }));
      } else if (keepersOn(settings)) {
        const keep = keptIds.get(f.id) || new Set();
        nextRoster = roster.filter((p) => keep.has(playerKey(p))).map((p) => ({
          ...p,
          slot: 'BN',
          keeperSeasons: (Number(p.keeperSeasons) || 0) + 1
        }));
      } else {
        nextRoster = [];
      }
      return { ...f, roster: nextRoster };
    });
    league.season = (Number(league.season) || new Date().getFullYear()) + 1;
    league.weekResults = {};
    league.playoffs = null;
    league.wire = null;
    league.schedule = null;
    league.draft = leagues.defaultIndependentDraft({ status: 'scheduled' });
    league.keepers = {
      season: league.season + 1,
      status: 'open',
      declarations: keepersOn(settings) ? (keepers.declarations || []).map((d) => ({ ...d, status: 'applied' })) : []
    };
    league.transactions = Array.isArray(league.transactions) ? league.transactions : [];
    leagues.pushIndependentTransaction(league, {
      type: 'season',
      summary: `Rolled to ${league.season} (${format})`
    });
    if (league.settings) {
      league.settings.draftAt = null;
    }
    return publicKeepers(league, actor);
  });
}

function stampDraftPlayer(player, pick, season) {
  return {
    ...player,
    acquiredType: pick?.keeper ? 'keeper' : 'draft',
    acquiredYear: Number(season) || new Date().getFullYear(),
    acquiredRound: Number(pick?.round) || player.acquiredRound || null,
    keeperSeasons: pick?.keeper ? (Number(player.keeperSeasons) || 0) : 0
  };
}

module.exports = {
  keepersOn,
  irEligible,
  isReserveSlot,
  taxiEligible,
  keeperCostRound,
  maxKeepers,
  ensureKeepers,
  injuryMapFromPool,
  playerInjury,
  validateReserveSlots,
  rosteredPlayerIds,
  filterDraftPool,
  consumedKeeperSlots,
  seedKeeperPicks,
  overallForFranchiseRound,
  getKeepers,
  declareKeeper,
  undeclareKeeper,
  lockKeepers,
  rolloverSeason,
  publicKeepers,
  stampDraftPlayer
};
