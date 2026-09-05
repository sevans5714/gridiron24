/**
 * Score an independent league week: nflverse stats → league scoring → lineups / matchups.
 */
const scoring = require('./independent-scoring');
const weekStats = require('./independent-week-stats');
const liveStats = require('./independent-live-stats');
const leagues = require('./leagues-store');
const independentPlayoffs = require('./independent-playoffs');

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function playerKey(p) {
  return String(p?.playerId || p?.id || p?.gsisId || '').trim();
}

function isDst(player) {
  const pos = String(player?.position || '').toUpperCase();
  return pos === 'DST' || pos === 'DEF' || pos === 'D/ST';
}

function dstTeamKey(player) {
  const team = String(player?.nflTeam || player?.team || player?.abbrev || '').trim().toUpperCase();
  if (team) return team;
  // Some pools encode DST as "KC" name / id
  const name = String(player?.name || '').trim().toUpperCase();
  if (/^[A-Z]{2,3}$/.test(name)) return name;
  return '';
}

function lookupPlayerRow(player, box) {
  const espn = String(player?.espnId || '').replace(/^espn-/i, '').trim();
  if (espn && box.playersByEspn?.has(espn)) return box.playersByEspn.get(espn);
  const name = String(player?.name || player?.playerName || '').trim().toLowerCase();
  const team = String(player?.nflTeam || player?.team || '').trim().toUpperCase();
  if (name && team && box.playersByNameTeam?.has(`${name}|${team}`)) {
    return box.playersByNameTeam.get(`${name}|${team}`);
  }
  const id = playerKey(player);
  if (id && box.players.has(id)) return box.players.get(id);
  if (espn && box.players.has(`espn-${espn}`)) return box.players.get(`espn-${espn}`);
  return null;
}

function scoreRosterPlayer(player, box) {
  const id = playerKey(player);
  const teamAbbr = isDst(player)
    ? dstTeamKey(player)
    : String(player?.nflTeam || player?.team || '').trim().toUpperCase();
  const game = teamAbbr && box.gamesByTeam?.get
    ? box.gamesByTeam.get(teamAbbr)
    : null;
  const gameStatus = game?.status || null;
  const gameClock = gameStatus?.detail || gameStatus?.clock || null;
  if (isDst(player)) {
    const team = dstTeamKey(player);
    const teamRow = team ? box.teams.get(team) : null;
    if (!teamRow) {
      return { points: 0, breakdown: null, playerId: id || team, gameStatus, gameClock };
    }
    const scored = scoring.scoreDstStats(teamRow, box.scoring);
    return {
      ...scored,
      playerId: id || team,
      team,
      live: Boolean(teamRow.live) || gameStatus?.bucket === 'live',
      gameStatus,
      gameClock
    };
  }
  const row = lookupPlayerRow(player, box);
  if (!row) return { points: 0, breakdown: null, playerId: id, gameStatus, gameClock };
  const scored = scoring.scorePlayerStats(row, box.scoring);
  return {
    ...scored,
    playerId: id,
    live: Boolean(row.live) || gameStatus?.bucket === 'live',
    gameStatus,
    gameClock
  };
}

/** Deterministic round-robin pairings for N franchises over many weeks. */
function roundRobinPairings(franchiseIds, week) {
  const ids = [...franchiseIds];
  if (ids.length < 2) return [];
  if (ids.length % 2 === 1) ids.push(null); // bye
  const n = ids.length;
  const rounds = n - 1;
  const half = n / 2;
  const arr = [...ids];
  const roundIndex = ((Math.max(1, num(week, 1)) - 1) % rounds);
  // rotate
  for (let r = 0; r < roundIndex; r += 1) {
    const fixed = arr[0];
    const rest = arr.slice(1);
    rest.unshift(rest.pop());
    arr.splice(0, arr.length, fixed, ...rest);
  }
  const pairs = [];
  for (let i = 0; i < half; i += 1) {
    const home = arr[i];
    const away = arr[n - 1 - i];
    if (!home || !away) continue;
    pairs.push({ homeId: home, awayId: away });
  }
  return pairs;
}

function scoreFranchise(franchise, box) {
  const scoredById = new Map();
  for (const p of franchise.roster || []) {
    const scored = scoreRosterPlayer(p, box);
    const key = scored.playerId || playerKey(p);
    if (key) scoredById.set(key, scored);
    // Also map DST by team abbrev
    if (scored.team) scoredById.set(scored.team, scored);
  }
  const lineup = scoring.buildLineup(
    franchise.roster || [],
    scoredById,
    box.rosterSlots || {}
  );
  return {
    franchiseId: franchise.id,
    name: franchise.managerUserId ? franchise.name : 'Open',
    vacant: !franchise.managerUserId,
    logo: franchise.logo || franchise.crest || null,
    conferenceKey: franchise.conferenceKey || null,
    managerName: franchise.managerName || null,
    managerUserId: franchise.managerUserId || null,
    total: lineup.total,
    starters: lineup.starters,
    bench: lineup.bench,
    players: lineup.players
  };
}

function weekLeaders(scoredFranchises) {
  const rows = [];
  for (const f of scoredFranchises) {
    for (const p of [...(f.starters || []), ...(f.bench || [])]) {
      if (p.empty || !p.playerId) continue;
      rows.push({
        playerId: p.playerId,
        name: p.name || p.playerName || 'Player',
        position: p.position,
        nflTeam: p.nflTeam || p.team || '',
        points: p.weekPoints,
        live: Boolean(p.live),
        franchiseName: f.name,
        starter: p.isStarter !== false
      });
    }
  }
  return rows.sort((a, b) => (Number(b.points) || 0) - (Number(a.points) || 0)).slice(0, 12);
}

function cumulativeStandings(franchises, weekResults, currentWeek, currentMatchups, opts = {}) {
  const rows = new Map();
  for (const f of franchises) {
    rows.set(f.franchiseId, {
      franchiseId: f.franchiseId,
      name: f.name,
      conferenceKey: f.conferenceKey,
      managerName: f.managerName,
      logo: f.logo || null,
      wins: 0,
      losses: 0,
      ties: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      highPoints: 0,
      outcomes: [],
      total: f.total
    });
  }
  function pushOutcome(row, letter) {
    if (!row) return;
    row.outcomes.push(letter);
  }
  function apply(matchups, skipUpcoming) {
    for (const m of matchups || []) {
      const result = m.result;
      if (skipUpcoming && result === 'upcoming') continue;
      const homeId = m.home?.franchiseId || m.homeId;
      const awayId = m.away?.franchiseId || m.awayId;
      const hs = Number(m.homeScore ?? m.home?.total) || 0;
      const as = Number(m.awayScore ?? m.away?.total) || 0;
      const home = rows.get(homeId);
      const away = rows.get(awayId);
      if (home) {
        home.pointsFor = scoring.round1(home.pointsFor + hs);
        home.pointsAgainst = scoring.round1(home.pointsAgainst + as);
        home.highPoints = Math.max(home.highPoints, hs);
      }
      if (away) {
        away.pointsFor = scoring.round1(away.pointsFor + as);
        away.pointsAgainst = scoring.round1(away.pointsAgainst + hs);
        away.highPoints = Math.max(away.highPoints, as);
      }
      if (result === 'home') {
        if (home) home.wins += 1;
        if (away) away.losses += 1;
        pushOutcome(home, 'W');
        pushOutcome(away, 'L');
      } else if (result === 'away') {
        if (away) away.wins += 1;
        if (home) home.losses += 1;
        pushOutcome(away, 'W');
        pushOutcome(home, 'L');
      } else if (result === 'tie') {
        if (home) home.ties += 1;
        if (away) away.ties += 1;
        pushOutcome(home, 'T');
        pushOutcome(away, 'T');
      }
    }
  }
  const wr = weekResults || {};
  const pastWeeks = Object.keys(wr)
    .map((k) => wr[k])
    .filter((week) => {
      const w = Number(week?.week);
      if (!Number.isFinite(w) || w >= currentWeek) return false;
      if (week?.phase === 'playoff') return false;
      if (Number.isFinite(opts.regularEnd) && w > opts.regularEnd) return false;
      return true;
    })
    .sort((a, b) => Number(a.week) - Number(b.week));
  for (const week of pastWeeks) apply(week.matchups || [], true);
  if (!opts.skipCurrent) apply(currentMatchups, false);
  return [...rows.values()].map((row) => {
    const gp = row.wins + row.losses + row.ties;
    const outcomes = row.outcomes || [];
    let streakType = 'NONE';
    let streakLength = 0;
    if (outcomes.length) {
      const last = outcomes[outcomes.length - 1];
      streakLength = 1;
      for (let i = outcomes.length - 2; i >= 0 && outcomes[i] === last; i -= 1) streakLength += 1;
      streakType = last === 'W' ? 'WIN' : last === 'L' ? 'LOSS' : 'TIE';
    }
    const { outcomes: _drop, ...rest } = row;
    return {
      ...rest,
      gamesPlayed: gp,
      pointsPerGame: gp ? Math.round((row.pointsFor / gp) * 10) / 10 : 0,
      streakType,
      streakLength
    };
  }).sort((a, b) =>
    (b.wins - a.wins) || (b.ties - a.ties) || (b.pointsFor - a.pointsFor)
  );
}

/**
 * @param {object} league public or store league
 * @param {number} week
 */
async function scoreLeagueWeek(league, week, opts = {}) {
  if (!league || league.platform !== 'independent') {
    throw Object.assign(new Error('Independent league required'), { status: 400 });
  }
  const season = Number(league.season) || new Date().getFullYear();
  const requested = Number(week);
  const weekHint = Number.isFinite(requested) && requested >= 1 ? requested : 99;
  let boxPack;
  try {
    boxPack = await weekStats.loadWeekBoxScores(season, weekHint);
  } catch {
    const w = Number.isFinite(requested) && requested >= 1 ? requested : 1;
    boxPack = {
      season,
      week: w,
      requestedWeek: w,
      sourceSeason: season,
      players: new Map(),
      teams: new Map(),
      availableWeeks: [w],
      playerCount: 0,
      teamCount: 0
    };
  }
  let overlay = null;
  if (!opts.skipLive) {
    try {
      overlay = await liveStats.loadLiveWeekOverlay(season, boxPack.week);
    } catch { /* nflverse weekly file still scores */ }
  }

  if (overlay) {
    for (const [espnId, row] of overlay.playersByEspn || []) {
      boxPack.players.set(`espn-${espnId}`, row);
    }
    for (const [id, row] of overlay.players || []) {
      if (!boxPack.players.has(id)) boxPack.players.set(id, row);
    }
    boxPack.playersByEspn = overlay.playersByEspn || new Map();
    boxPack.playersByNameTeam = overlay.playersByNameTeam || new Map();
    for (const [abbr, row] of overlay.teams || []) {
      const prev = boxPack.teams.get(abbr) || {};
      boxPack.teams.set(abbr, { ...prev, ...row });
    }
  }

  const scoringSettings = league.settings?.scoring || {};
  const rosterSlots = league.settings?.rosterSlots || {};
  const box = {
    ...boxPack,
    scoring: scoringSettings,
    rosterSlots,
    gamesByTeam: overlay?.gamesByTeam || new Map()
  };

  const franchises = Array.isArray(league.franchises) ? league.franchises : [];
  const scoredFranchises = franchises.map((f) => scoreFranchise(f, box));
  const byId = new Map(scoredFranchises.map((f) => [f.franchiseId, f]));

  const stored = Array.isArray(league.schedule?.weeks)
    ? league.schedule.weeks.find((w) => Number(w.week) === Number(box.week))
    : null;
  let pairs = Array.isArray(stored?.matchups)
    ? stored.matchups.map((m) => ({
      homeId: m.homeId || m.homeFranchiseId,
      awayId: m.awayId || m.awayFranchiseId
    })).filter((m) => m.homeId && m.awayId)
    : [];

  const rawLeague = league.id ? (leagues.findById(league.id) || league) : league;
  let playoffs = null;
  const playoffWeek = independentPlayoffs.isPlayoffWeek(rawLeague, box.week);
  try {
    playoffs = independentPlayoffs.ensurePlayoffs(rawLeague, { week: box.week });
  } catch { /* projected bracket optional */ }
  if (playoffWeek && playoffs) {
    const games = independentPlayoffs.liveGamesForWeek(playoffs, box.week);
    pairs = games.map((g) => ({
      homeId: g.home.franchiseId,
      awayId: g.away.franchiseId,
      playoffGameId: g.id,
      label: g.label,
      homeSeed: g.home.seed,
      awaySeed: g.away.seed
    }));
  } else if (!pairs.length && !playoffWeek) {
    pairs = roundRobinPairings(franchises.map((f) => f.id), box.week);
  }

  const statsReady = box.playerCount > 0
    || Boolean(overlay?.liveGames)
    || Boolean(overlay?.finalGames);
  const matchups = pairs.map((p, i) => {
    const home = byId.get(p.homeId);
    const away = byId.get(p.awayId);
    const homeScore = home?.total ?? 0;
    const awayScore = away?.total ?? 0;
    let result = 'upcoming';
    if (statsReady) {
      if (homeScore === awayScore) result = 'tie';
      else result = homeScore > awayScore ? 'home' : 'away';
    }
    return {
      id: p.playoffGameId || `w${box.week}-m${i + 1}`,
      week: box.week,
      label: p.label || null,
      homeSeed: p.homeSeed || null,
      awaySeed: p.awaySeed || null,
      home: home || { franchiseId: p.homeId, name: 'Home', total: 0, starters: [], bench: [] },
      away: away || { franchiseId: p.awayId, name: 'Away', total: 0, starters: [], bench: [] },
      homeScore,
      awayScore,
      result
    };
  });

  if (playoffs && playoffWeek) {
    independentPlayoffs.applyWeekScores(playoffs, box.week, matchups);
  }

  let weekResults = {};
  try {
    const fresh = league.id ? leagues.findById(league.id) : league;
    weekResults = leagues.independentWeekResults(fresh);
  } catch { weekResults = league.weekResults || {}; }

  const regularEnd = independentPlayoffs.regularSeasonEnd(rawLeague);
  const standings = cumulativeStandings(scoredFranchises, weekResults, box.week, matchups, {
    regularEnd,
    skipCurrent: playoffWeek
  });

  const payload = {
    ok: true,
    leagueId: league.id,
    season: box.season,
    sourceSeason: box.sourceSeason,
    week: box.week,
    requestedWeek: box.requestedWeek,
    availableWeeks: box.availableWeeks,
    statsReady,
    playerStatCount: box.playerCount,
    scoringPreset: league.settings?.scoringPreset || 'custom',
    live: Boolean(overlay?.live),
    liveGames: overlay?.liveGames || 0,
    finalGames: overlay?.finalGames || 0,
    nflGames: overlay?.games || [],
    statsSource: overlay?.live
      ? 'live'
      : (overlay?.finalGames ? 'box + week file' : (box.playerCount ? 'week file' : 'unavailable')),
    statsFetchedAt: overlay?.fetchedAt || null,
    matchups,
    franchises: scoredFranchises,
    standings,
    leaders: weekLeaders(scoredFranchises),
    phase: playoffWeek ? 'playoff' : 'regular',
    playoffs
  };

  if (!opts.skipPersist && league.id) {
    try {
      leagues.recordIndependentWeekResults(league.id, payload);
      if (playoffs) {
        independentPlayoffs.persistPlayoffs(league.id, playoffs, {
          force: Boolean(
            playoffWeek
            && playoffs.locked
            && (
              (statsReady && !payload.live)
              || (playoffs.lockedAt && Date.now() - Date.parse(playoffs.lockedAt) < 60_000)
            )
          )
        });
      }
      if (!opts.skipFill) {
        const storedNow = leagues.independentWeekResults(leagues.findById(league.id));
        let filled = 0;
        for (let w = 1; w < box.week; w += 1) {
          if (storedNow[String(w)]) continue;
          if (filled >= 4) break;
          try {
            const past = await scoreLeagueWeek(league, w, { skipFill: true, skipLive: true });
            leagues.recordIndependentWeekResults(league.id, { ...past, live: false });
            storedNow[String(w)] = true;
            filled += 1;
          } catch { /* skip a missing week file */ }
        }
        payload.standings = cumulativeStandings(
          scoredFranchises,
          leagues.independentWeekResults(leagues.findById(league.id)),
          box.week,
          matchups,
          { regularEnd, skipCurrent: playoffWeek }
        );
      }
    } catch { /* persist is best-effort */ }
  }

  return payload;
}

module.exports = {
  scoreLeagueWeek,
  scoreFranchise,
  roundRobinPairings,
  scoreRosterPlayer
};
