/**
 * Score an independent league week: nflverse stats → league scoring → lineups / matchups.
 */
const scoring = require('./independent-scoring');
const weekStats = require('./independent-week-stats');

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

function scoreRosterPlayer(player, box) {
  const id = playerKey(player);
  if (isDst(player)) {
    const team = dstTeamKey(player);
    const teamRow = team ? box.teams.get(team) : null;
    if (!teamRow) return { points: 0, breakdown: null, playerId: id || team };
    const scored = scoring.scoreDstStats(teamRow, box.scoring);
    return { ...scored, playerId: id || team, team };
  }
  const row = id ? box.players.get(id) : null;
  if (!row) return { points: 0, breakdown: null, playerId: id };
  const scored = scoring.scorePlayerStats(row, box.scoring);
  return { ...scored, playerId: id };
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
    name: franchise.name,
    conferenceKey: franchise.conferenceKey || null,
    managerName: franchise.managerName || null,
    managerUserId: franchise.managerUserId || null,
    total: lineup.total,
    starters: lineup.starters,
    bench: lineup.bench,
    players: lineup.players
  };
}

/**
 * @param {object} league public or store league
 * @param {number} week
 */
async function scoreLeagueWeek(league, week) {
  if (!league || league.platform !== 'independent') {
    throw Object.assign(new Error('Independent league required'), { status: 400 });
  }
  const season = Number(league.season) || new Date().getFullYear();
  const requested = Number(week);
  const weekHint = Number.isFinite(requested) && requested >= 1 ? requested : 99;
  const boxPack = await weekStats.loadWeekBoxScores(season, weekHint);
  const scoringSettings = league.settings?.scoring || {};
  const rosterSlots = league.settings?.rosterSlots || {};
  const box = {
    ...boxPack,
    scoring: scoringSettings,
    rosterSlots
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
  if (!pairs.length) {
    pairs = roundRobinPairings(franchises.map((f) => f.id), box.week);
  }

  const matchups = pairs.map((p, i) => {
    const home = byId.get(p.homeId);
    const away = byId.get(p.awayId);
    const homeScore = home?.total ?? 0;
    const awayScore = away?.total ?? 0;
    let result = 'upcoming';
    if (box.playerCount > 0) {
      if (homeScore === awayScore) result = 'tie';
      else result = homeScore > awayScore ? 'home' : 'away';
    }
    return {
      id: `w${box.week}-m${i + 1}`,
      week: box.week,
      home: home || { franchiseId: p.homeId, name: 'Home', total: 0, starters: [], bench: [] },
      away: away || { franchiseId: p.awayId, name: 'Away', total: 0, starters: [], bench: [] },
      homeScore,
      awayScore,
      result
    };
  });

  // Standings snapshot from this week's results only (cumulative later).
  const standings = scoredFranchises
    .map((f) => {
      let w = 0;
      let l = 0;
      let t = 0;
      let pf = f.total;
      let pa = 0;
      for (const m of matchups) {
        if (m.home.franchiseId === f.franchiseId) {
          pa += m.awayScore;
          if (m.result === 'home') w += 1;
          else if (m.result === 'away') l += 1;
          else if (m.result === 'tie') t += 1;
        } else if (m.away.franchiseId === f.franchiseId) {
          pa += m.homeScore;
          if (m.result === 'away') w += 1;
          else if (m.result === 'home') l += 1;
          else if (m.result === 'tie') t += 1;
        }
      }
      return {
        franchiseId: f.franchiseId,
        name: f.name,
        conferenceKey: f.conferenceKey,
        managerName: f.managerName,
        wins: w,
        losses: l,
        ties: t,
        pointsFor: pf,
        pointsAgainst: scoring.round1(pa),
        total: f.total
      };
    })
    .sort((a, b) => (b.wins - a.wins) || (b.pointsFor - a.pointsFor));

  return {
    ok: true,
    leagueId: league.id,
    season: box.season,
    sourceSeason: box.sourceSeason,
    week: box.week,
    requestedWeek: box.requestedWeek,
    availableWeeks: box.availableWeeks,
    statsReady: box.playerCount > 0,
    playerStatCount: box.playerCount,
    scoringPreset: league.settings?.scoringPreset || 'custom',
    matchups,
    franchises: scoredFranchises,
    standings
  };
}

module.exports = {
  scoreLeagueWeek,
  scoreFranchise,
  roundRobinPairings,
  scoreRosterPlayer
};
