/**
 * Attach NFL game matchup / live score / red-zone context to fantasy players.
 */
const nflTeams = require('./nfl-teams');

function teamKey(raw) {
  return nflTeams.normalizeAbbr(raw) || String(raw || '').trim().toUpperCase() || null;
}

function logoFor(raw, existing) {
  if (existing) return existing;
  return nflTeams.espnLogoUrl(raw);
}

function pickAbbr(side) {
  return teamKey(side?.abbreviation || side?.abbr || side?.team);
}

function pickScore(side) {
  if (side?.score == null || side.score === '') return null;
  const n = Number(side.score);
  return Number.isFinite(n) ? n : null;
}

function possessionAbbr(game) {
  const sit = game?.situation;
  if (!sit) return null;
  if (sit.possession) return teamKey(sit.possession);
  const pid = sit.possessionId || sit.possessionTeamId;
  if (pid == null) return null;
  const homeId = game.home?.id != null ? String(game.home.id) : null;
  const awayId = game.away?.id != null ? String(game.away.id) : null;
  if (homeId && String(pid) === homeId) return pickAbbr(game.home);
  if (awayId && String(pid) === awayId) return pickAbbr(game.away);
  return null;
}

function isRedZoneForTeam(game, teamAbbr) {
  const sit = game?.situation;
  if (!sit || !sit.isRedZone) return false;
  const bucket = game?.status?.bucket || 'upcoming';
  if (bucket !== 'live') return false;
  const poss = possessionAbbr(game);
  return Boolean(poss && teamAbbr && poss === teamAbbr);
}

/**
 * Build Map<teamAbbr, game> from nflverse-live (or slim overlay) games.
 */
function buildGamesByTeam(games) {
  const map = new Map();
  for (const g of games || []) {
    const home = pickAbbr(g.home);
    const away = pickAbbr(g.away);
    if (home) map.set(home, g);
    if (away) map.set(away, g);
    // Also index raw ESPN abbreviations (WSH) when normalize maps to WAS
    const homeRaw = String(g.home?.abbreviation || g.home?.abbr || '').toUpperCase();
    const awayRaw = String(g.away?.abbreviation || g.away?.abbr || '').toUpperCase();
    if (homeRaw && !map.has(homeRaw)) map.set(homeRaw, g);
    if (awayRaw && !map.has(awayRaw)) map.set(awayRaw, g);
  }
  return map;
}

/**
 * Compact per-player NFL game context for API / UI.
 */
function contextForTeam(rawTeam, gamesByTeam) {
  const team = teamKey(rawTeam);
  if (!team || team === 'FA') {
    return {
      team: team || null,
      teamLogo: logoFor(rawTeam),
      opponent: null,
      opponentLogo: null,
      isHome: null,
      matchupText: null,
      bucket: 'idle',
      live: false,
      final: false,
      upcoming: false,
      homeAbbr: null,
      awayAbbr: null,
      homeLogo: null,
      awayLogo: null,
      homeScore: null,
      awayScore: null,
      scoreText: null,
      clock: null,
      detail: null,
      shortDetail: null,
      inRedZone: false,
      gameId: null
    };
  }

  const game = gamesByTeam?.get?.(team) || gamesByTeam?.get?.(String(rawTeam || '').toUpperCase()) || null;
  const teamLogo = logoFor(team, game && (pickAbbr(game.home) === team ? game.home?.logo : game.away?.logo));

  if (!game) {
    return {
      team,
      teamLogo,
      opponent: null,
      opponentLogo: null,
      isHome: null,
      matchupText: null,
      bucket: 'idle',
      live: false,
      final: false,
      upcoming: false,
      homeAbbr: null,
      awayAbbr: null,
      homeLogo: null,
      awayLogo: null,
      homeScore: null,
      awayScore: null,
      scoreText: null,
      clock: null,
      detail: null,
      shortDetail: null,
      inRedZone: false,
      gameId: null
    };
  }

  const homeAbbr = pickAbbr(game.home);
  const awayAbbr = pickAbbr(game.away);
  const isHome = homeAbbr === team;
  const opponent = isHome ? awayAbbr : homeAbbr;
  const homeLogo = logoFor(homeAbbr, game.home?.logo);
  const awayLogo = logoFor(awayAbbr, game.away?.logo);
  const opponentLogo = isHome ? awayLogo : homeLogo;
  const homeScore = pickScore(game.home);
  const awayScore = pickScore(game.away);
  const bucket = game.status?.bucket || 'upcoming';
  const live = bucket === 'live';
  const final = bucket === 'final';
  const upcoming = bucket === 'upcoming';
  const shortDetail = game.status?.shortDetail || game.status?.detail || game.status?.description || '';
  const clock = game.status?.clock || null;
  const scoreText = (live || final) && homeScore != null && awayScore != null
    ? `${awayScore}–${homeScore}`
    : null;

  return {
    team,
    teamLogo,
    opponent,
    opponentLogo,
    isHome,
    matchupText: opponent ? `${isHome ? 'vs' : '@'} ${opponent}` : null,
    bucket,
    live,
    final,
    upcoming,
    homeAbbr,
    awayAbbr,
    homeLogo,
    awayLogo,
    homeScore,
    awayScore,
    scoreText,
    clock,
    detail: shortDetail,
    shortDetail,
    inRedZone: isRedZoneForTeam(game, team),
    gameId: game.id || null
  };
}

function playerTeamAbbr(player) {
  const pos = String(player?.position || player?.slot || '').toUpperCase();
  const isDst = pos === 'D/ST' || pos === 'DST' || pos === 'DEF';
  if (isDst) {
    return teamKey(player?.proTeam || player?.nflTeam || player?.team || player?.abbrev || player?.name);
  }
  return teamKey(player?.proTeam || player?.nflTeam || player?.team);
}

function enrichPlayer(player, gamesByTeam, week = null) {
  if (!player || player.empty) return player;
  const abbr = playerTeamAbbr(player);
  let nflGame = contextForTeam(abbr, gamesByTeam);
  if (
    week != null
    && player.byeWeek != null
    && Number(player.byeWeek) === Number(week)
    && !nflGame.opponent
  ) {
    nflGame = {
      ...nflGame,
      bucket: 'bye',
      matchupText: `Bye ${week}`,
      upcoming: false,
      live: false,
      final: false
    };
  }
  return {
    ...player,
    proTeam: player.proTeam || abbr || player.proTeam,
    nflTeam: player.nflTeam || abbr || player.nflTeam,
    teamLogo: player.teamLogo || nflGame.teamLogo || null,
    nflGame,
    live: Boolean(player.live) || nflGame.live,
    gameClock: player.gameClock || (nflGame.live
      ? (nflGame.shortDetail || nflGame.clock)
      : nflGame.final
        ? (nflGame.shortDetail || 'Final')
        : nflGame.bucket === 'bye'
          ? nflGame.matchupText
          : nflGame.shortDetail) || null,
    gameStatus: player.gameStatus || {
      bucket: nflGame.bucket,
      detail: nflGame.shortDetail || nflGame.matchupText,
      clock: nflGame.clock
    }
  };
}

function enrichPlayers(players, gamesByTeam, week = null) {
  return (players || []).map((p) => enrichPlayer(p, gamesByTeam, week));
}

function enrichTeamDetail(detail, gamesByTeam, week = null) {
  if (!detail) return detail;
  const lineup = enrichPlayers(detail.lineup, gamesByTeam, week);
  const bench = enrichPlayers(detail.bench, gamesByTeam, week);
  return {
    ...detail,
    lineup,
    bench,
    roster: [...lineup, ...bench]
  };
}

function enrichMatchupBox(box, gamesByTeam, week = null) {
  if (!box) return box;
  const side = (s) => {
    if (!s) return s;
    return {
      ...s,
      lineup: enrichPlayers(s.lineup, gamesByTeam, week),
      bench: enrichPlayers(s.bench, gamesByTeam, week)
    };
  };
  return {
    ...box,
    home: side(box.home),
    away: side(box.away)
  };
}

module.exports = {
  buildGamesByTeam,
  contextForTeam,
  enrichPlayer,
  enrichPlayers,
  enrichTeamDetail,
  enrichMatchupBox,
  teamKey,
  logoFor
};
