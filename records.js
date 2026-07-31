/**
 * Franchise-style record book from ESPN matchups + season standings.
 * Streaks are within a season (fantasy seasons reset); all-time keeps the best across seasons.
 */

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function decidedMatchups(schedule) {
  return (schedule || [])
    .filter((m) => {
      const winner = String(m.winner || 'UNDECIDED').toUpperCase();
      if (winner === 'UNDECIDED') return false;
      const homeId = m.home?.teamId;
      const awayId = m.away?.teamId;
      return homeId != null && awayId != null;
    })
    .map((m) => ({
      id: m.id,
      week: num(m.matchupPeriodId),
      winner: String(m.winner || '').toUpperCase(),
      playoff: Boolean(m.playoffTierType),
      homeId: Number(m.home.teamId),
      awayId: Number(m.away.teamId),
      homeScore: num(m.home.totalPoints),
      awayScore: num(m.away.totalPoints)
    }))
    .sort((a, b) => a.week - b.week || Number(a.id) - Number(b.id));
}

function teamInfo(teamsById, teamId) {
  const t = teamsById.get(Number(teamId));
  if (!t) {
    return {
      id: Number(teamId),
      name: `Team ${teamId}`,
      owner: '—',
      logo: null,
      conferenceKey: null,
      conferenceName: null
    };
  }
  return t;
}

function holderBase(team, seasonMeta, extras = {}) {
  return {
    teamId: team.id,
    teamName: team.name || `Team ${team.id}`,
    owner: team.owner || '—',
    year: Number(seasonMeta.season) || null,
    yearLabel: seasonMeta.yearLabel || String(seasonMeta.season || ''),
    logo: team.logo || null,
    conferenceKey: team.conferenceKey || seasonMeta.conferenceKey || null,
    conferenceName: team.conferenceName || seasonMeta.conferenceName || null,
    ...extras
  };
}

function betterBy(a, b, scoreOf) {
  if (!a) return b;
  if (!b) return a;
  const sa = scoreOf(a);
  const sb = scoreOf(b);
  if (sb > sa) return b;
  if (sb < sa) return a;
  // Prefer newer seasons on ties
  const ya = Number(a.year) || 0;
  const yb = Number(b.year) || 0;
  return yb >= ya ? b : a;
}

/**
 * @param {object} seasonBag
 * @param {number} seasonBag.season
 * @param {string} [seasonBag.yearLabel]
 * @param {string} seasonBag.conferenceKey
 * @param {string} seasonBag.conferenceName
 * @param {Map<number, object>} seasonBag.teamsById - id -> {id,name,owner,logo,wins,pointsFor,...}
 * @param {Array} seasonBag.schedule - raw ESPN schedule
 */
function collectSeasonCandidates(seasonBag) {
  const seasonMeta = {
    season: seasonBag.season,
    yearLabel: seasonBag.yearLabel || String(seasonBag.season),
    conferenceKey: seasonBag.conferenceKey,
    conferenceName: seasonBag.conferenceName
  };
  const teamsById = seasonBag.teamsById;
  const games = decidedMatchups(seasonBag.schedule);
  const out = {
    winStreak: null,
    loseStreak: null,
    highScore: null,
    blowout: null,
    seasonPf: null,
    mostWins: null
  };

  // Single-game highs + blowouts
  for (const g of games) {
    const home = teamInfo(teamsById, g.homeId);
    const away = teamInfo(teamsById, g.awayId);
    const sides = [
      { team: home, score: g.homeScore, opp: away, oppScore: g.awayScore },
      { team: away, score: g.awayScore, opp: home, oppScore: g.homeScore }
    ];
    for (const s of sides) {
      const cand = {
        value: s.score,
        ...holderBase(s.team, seasonMeta, {
          week: g.week,
          opponent: s.opp.name,
          opponentOwner: s.opp.owner,
          opponentScore: s.oppScore,
          playoff: g.playoff
        })
      };
      out.highScore = betterBy(out.highScore, cand, (x) => x.value);
    }

    if (g.winner === 'HOME' || g.winner === 'AWAY') {
      const winnerIsHome = g.winner === 'HOME';
      const winner = winnerIsHome ? home : away;
      const loser = winnerIsHome ? away : home;
      const winnerScore = winnerIsHome ? g.homeScore : g.awayScore;
      const loserScore = winnerIsHome ? g.awayScore : g.homeScore;
      const margin = Math.abs(winnerScore - loserScore);
      const cand = {
        value: margin,
        ...holderBase(winner, seasonMeta, {
          week: g.week,
          opponent: loser.name,
          opponentOwner: loser.owner,
          score: winnerScore,
          opponentScore: loserScore,
          playoff: g.playoff
        })
      };
      out.blowout = betterBy(out.blowout, cand, (x) => x.value);
    }
  }

  // Per-team game results for streaks
  const resultsByTeam = new Map();
  for (const g of games) {
    const push = (teamId, result) => {
      if (!resultsByTeam.has(teamId)) resultsByTeam.set(teamId, []);
      resultsByTeam.get(teamId).push({ result, week: g.week });
    };
    if (g.winner === 'HOME') {
      push(g.homeId, 'W');
      push(g.awayId, 'L');
    } else if (g.winner === 'AWAY') {
      push(g.awayId, 'W');
      push(g.homeId, 'L');
    } else if (g.winner === 'TIE') {
      push(g.homeId, 'T');
      push(g.awayId, 'T');
    }
  }

  for (const [teamId, rows] of resultsByTeam) {
    const team = teamInfo(teamsById, teamId);
    let bestWin = null;
    let bestLoss = null;
    let curType = null;
    let curLen = 0;
    let curStart = null;
    let curEnd = null;

    const flush = () => {
      if (!curType || curLen < 1) return;
      const pack = { length: curLen, startWeek: curStart, endWeek: curEnd };
      if (curType === 'W' && (!bestWin || pack.length > bestWin.length)) bestWin = pack;
      if (curType === 'L' && (!bestLoss || pack.length > bestLoss.length)) bestLoss = pack;
    };

    for (const row of rows) {
      const type = row.result === 'W' || row.result === 'L' ? row.result : null;
      if (!type) {
        flush();
        curType = null;
        curLen = 0;
        curStart = null;
        curEnd = null;
        continue;
      }
      if (type === curType) {
        curLen += 1;
        curEnd = row.week;
      } else {
        flush();
        curType = type;
        curLen = 1;
        curStart = row.week;
        curEnd = row.week;
      }
    }
    flush();

    if (bestWin) {
      const cand = {
        value: bestWin.length,
        ...holderBase(team, seasonMeta, {
          startWeek: bestWin.startWeek,
          endWeek: bestWin.endWeek
        })
      };
      out.winStreak = betterBy(out.winStreak, cand, (x) => x.value);
    }
    if (bestLoss) {
      const cand = {
        value: bestLoss.length,
        ...holderBase(team, seasonMeta, {
          startWeek: bestLoss.startWeek,
          endWeek: bestLoss.endWeek
        })
      };
      out.loseStreak = betterBy(out.loseStreak, cand, (x) => x.value);
    }
  }

  // Season totals from standings
  for (const team of teamsById.values()) {
    const pfCand = {
      value: num(team.pointsFor),
      ...holderBase(team, seasonMeta, {
        wins: num(team.wins),
        losses: num(team.losses),
        ties: num(team.ties)
      })
    };
    out.seasonPf = betterBy(out.seasonPf, pfCand, (x) => x.value);

    const winCand = {
      value: num(team.wins) + num(team.ties) * 0.5,
      wins: num(team.wins),
      losses: num(team.losses),
      ties: num(team.ties),
      ...holderBase(team, seasonMeta)
    };
    // Prefer more wins, then fewer losses
    out.mostWins = betterBy(out.mostWins, winCand, (x) => x.value * 1000 - num(x.losses));
  }

  return out;
}

function mergeCandidates(parts) {
  const keys = ['winStreak', 'loseStreak', 'highScore', 'blowout', 'seasonPf', 'mostWins'];
  const merged = {};
  for (const key of keys) {
    let best = null;
    for (const part of parts) {
      if (!part || !part[key]) continue;
      if (key === 'mostWins') {
        best = betterBy(best, part[key], (x) => x.value * 1000 - num(x.losses));
      } else {
        best = betterBy(best, part[key], (x) => x.value);
      }
    }
    merged[key] = best;
  }
  return merged;
}

const RECORD_CATEGORIES = [
  { id: 'winStreak', label: 'Longest win streak' },
  { id: 'loseStreak', label: 'Longest losing streak' },
  { id: 'highScore', label: 'Highest points in a game' },
  { id: 'blowout', label: 'Largest margin of victory' },
  { id: 'seasonPf', label: 'Highest season points' },
  { id: 'mostWins', label: 'Most wins in a season' }
];

function vacantEntry(id, label) {
  return {
    id,
    label,
    value: null,
    valueSuffix: null,
    teamName: null,
    owner: null,
    year: null,
    yearLabel: null,
    logo: null,
    conferenceName: null,
    detail: null,
    vacant: true
  };
}

function weekSpan(startWeek, endWeek) {
  if (startWeek == null) return null;
  if (endWeek == null || endWeek === startWeek) return `Week ${startWeek}`;
  return `Weeks ${startWeek}–${endWeek}`;
}

function formatRecordLine(wins, losses, ties) {
  const w = num(wins);
  const l = num(losses);
  const t = num(ties);
  return t > 0 ? `${w}-${l}-${t}` : `${w}-${l}`;
}

function buildRecordEntries(merged) {
  const byId = Object.create(null);

  if (merged.winStreak && merged.winStreak.value > 0) {
    const h = merged.winStreak;
    byId.winStreak = {
      id: 'winStreak',
      label: 'Longest win streak',
      value: `${h.value}`,
      valueSuffix: h.value === 1 ? 'win' : 'wins',
      teamName: h.teamName,
      owner: h.owner,
      year: h.year,
      yearLabel: h.yearLabel,
      logo: h.logo,
      conferenceName: h.conferenceName,
      detail: weekSpan(h.startWeek, h.endWeek),
      vacant: false
    };
  }

  if (merged.loseStreak && merged.loseStreak.value > 0) {
    const h = merged.loseStreak;
    byId.loseStreak = {
      id: 'loseStreak',
      label: 'Longest losing streak',
      value: `${h.value}`,
      valueSuffix: h.value === 1 ? 'loss' : 'losses',
      teamName: h.teamName,
      owner: h.owner,
      year: h.year,
      yearLabel: h.yearLabel,
      logo: h.logo,
      conferenceName: h.conferenceName,
      detail: weekSpan(h.startWeek, h.endWeek),
      vacant: false
    };
  }

  if (merged.highScore && merged.highScore.value > 0) {
    const h = merged.highScore;
    byId.highScore = {
      id: 'highScore',
      label: 'Highest points in a game',
      value: h.value.toFixed(1).replace(/\.0$/, ''),
      valueSuffix: 'pts',
      teamName: h.teamName,
      owner: h.owner,
      year: h.year,
      yearLabel: h.yearLabel,
      logo: h.logo,
      conferenceName: h.conferenceName,
      detail: [
        h.week != null ? `Week ${h.week}` : null,
        h.opponent ? `vs ${h.opponent}` : null,
        h.playoff ? 'Playoffs' : null
      ].filter(Boolean).join(' · ') || null,
      vacant: false
    };
  }

  if (merged.blowout && merged.blowout.value > 0) {
    const h = merged.blowout;
    byId.blowout = {
      id: 'blowout',
      label: 'Largest margin of victory',
      value: h.value.toFixed(1).replace(/\.0$/, ''),
      valueSuffix: 'pts',
      teamName: h.teamName,
      owner: h.owner,
      year: h.year,
      yearLabel: h.yearLabel,
      logo: h.logo,
      conferenceName: h.conferenceName,
      detail: [
        h.week != null ? `Week ${h.week}` : null,
        h.score != null && h.opponentScore != null
          ? `${Number(h.score).toFixed(1).replace(/\.0$/, '')}–${Number(h.opponentScore).toFixed(1).replace(/\.0$/, '')}`
          : null,
        h.opponent ? `vs ${h.opponent}` : null
      ].filter(Boolean).join(' · ') || null,
      vacant: false
    };
  }

  if (merged.seasonPf && merged.seasonPf.value > 0) {
    const h = merged.seasonPf;
    byId.seasonPf = {
      id: 'seasonPf',
      label: 'Highest season points',
      value: h.value.toFixed(1).replace(/\.0$/, ''),
      valueSuffix: 'PF',
      teamName: h.teamName,
      owner: h.owner,
      year: h.year,
      yearLabel: h.yearLabel,
      logo: h.logo,
      conferenceName: h.conferenceName,
      detail: formatRecordLine(h.wins, h.losses, h.ties),
      vacant: false
    };
  }

  if (merged.mostWins && num(merged.mostWins.wins) > 0) {
    const h = merged.mostWins;
    byId.mostWins = {
      id: 'mostWins',
      label: 'Most wins in a season',
      value: String(h.wins),
      valueSuffix: h.wins === 1 ? 'win' : 'wins',
      teamName: h.teamName,
      owner: h.owner,
      year: h.year,
      yearLabel: h.yearLabel,
      logo: h.logo,
      conferenceName: h.conferenceName,
      detail: formatRecordLine(h.wins, h.losses, h.ties),
      vacant: false
    };
  }

  return RECORD_CATEGORIES.map((cat) => byId[cat.id] || vacantEntry(cat.id, cat.label));
}

function buildRecordBook(seasonBags) {
  const parts = (seasonBags || []).map(collectSeasonCandidates);
  const merged = mergeCandidates(parts);
  return {
    records: buildRecordEntries(merged),
    seasonsScanned: [...new Set((seasonBags || []).map((s) => s.season).filter(Boolean))].sort((a, b) => b - a),
    gamesScanned: (seasonBags || []).reduce((n, s) => n + decidedMatchups(s.schedule).length, 0)
  };
}

module.exports = {
  RECORD_CATEGORIES,
  decidedMatchups,
  collectSeasonCandidates,
  mergeCandidates,
  buildRecordBook,
  buildRecordEntries
};
