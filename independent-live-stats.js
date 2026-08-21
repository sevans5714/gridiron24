/**
 * In-game NFL player/DST stats for independent league scoring.
 * Overlay on nflverse weekly CSVs (those files lag until games are posted).
 *
 * Source: ESPN site summary boxscore (same family as nflverse-live scoreboard).
 * Mapped onto roster ids via espnId, then name+team.
 */
const espnResilient = require('./espn-resilient');
const nflverseLive = require('./nflverse-live');

const CACHE_MS = 20_000;
const mem = new Map();

function toNum(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'string' && v.includes('/')) {
    const made = Number(String(v).split('/')[0]);
    return Number.isFinite(made) ? made : 0;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function emptyPlayerStats() {
  return {
    playerId: '',
    espnId: '',
    name: '',
    position: '',
    team: '',
    passingYards: 0,
    passingTds: 0,
    passingInterceptions: 0,
    rushingYards: 0,
    rushingTds: 0,
    receptions: 0,
    receivingYards: 0,
    receivingTds: 0,
    fumblesLost: 0,
    twoPointConversions: 0,
    specialTeamsTds: 0,
    patMade: 0,
    fgMade: 0,
    fgMissed: 0,
    fgMade0to19: 0,
    fgMade20to29: 0,
    fgMade30to39: 0,
    fgMade40to49: 0,
    fgMade50to59: 0,
    fgMade60plus: 0,
    live: true
  };
}

function keyIndex(keys) {
  const map = new Map();
  (keys || []).forEach((k, i) => map.set(String(k || '').toLowerCase(), i));
  return map;
}

function statAt(stats, indexMap, aliases) {
  for (const name of aliases) {
    if (indexMap.has(name)) return toNum(stats[indexMap.get(name)]);
  }
  return 0;
}

function ensurePlayer(store, athlete, teamAbbr) {
  const espnId = String(athlete?.id || athlete?.athlete?.id || '').trim();
  const name = String(athlete?.displayName || athlete?.athlete?.displayName || athlete?.name || '').trim();
  const key = espnId || `${name.toLowerCase()}|${teamAbbr}`;
  if (!store.players.has(key)) {
    store.players.set(key, {
      ...emptyPlayerStats(),
      playerId: espnId ? `espn-${espnId}` : key,
      espnId,
      name,
      team: teamAbbr
    });
  }
  return store.players.get(key);
}

function applyGroup(store, group, teamAbbr) {
  const name = String(group?.name || group?.type || '').toLowerCase();
  const keys = keyIndex(group?.keys || group?.names);
  const athletes = Array.isArray(group?.athletes) ? group.athletes : [];
  for (const row of athletes) {
    const athlete = row.athlete || row;
    const stats = Array.isArray(row.stats) ? row.stats : [];
    const player = ensurePlayer(store, athlete, teamAbbr);
    if (name.includes('pass')) {
      player.passingYards += statAt(stats, keys, ['passingyards', 'yds', 'yards']);
      player.passingTds += statAt(stats, keys, ['passingtouchdowns', 'td', 'tds']);
      player.passingInterceptions += statAt(stats, keys, ['interceptions', 'int']);
    } else if (name.includes('rush')) {
      player.rushingYards += statAt(stats, keys, ['rushingyards', 'yds', 'yards']);
      player.rushingTds += statAt(stats, keys, ['rushingtouchdowns', 'td', 'tds']);
    } else if (name.includes('receiv')) {
      player.receptions += statAt(stats, keys, ['receptions', 'rec']);
      player.receivingYards += statAt(stats, keys, ['receivingyards', 'yds', 'yards']);
      player.receivingTds += statAt(stats, keys, ['receivingtouchdowns', 'td', 'tds']);
    } else if (name.includes('kick')) {
      player.fgMade += statAt(stats, keys, ['fieldgoalsmade', 'fgmade', 'fg']);
      const fgAtt = statAt(stats, keys, ['fieldgoalattempts', 'fgatt']);
      if (fgAtt > player.fgMade) player.fgMissed += fgAtt - player.fgMade;
      player.patMade += statAt(stats, keys, ['extrapointsmade', 'xpmade', 'pat']);
    } else if (name.includes('fumb')) {
      player.fumblesLost += statAt(stats, keys, ['fumbleslost', 'lost']);
    }
  }
}

function parseTeamTotals(groups) {
  const out = { sacks: 0, interceptions: 0, fumbleRecoveries: 0, defTouchdowns: 0, safeties: 0, blockedKicks: 0 };
  for (const group of groups || []) {
    const name = String(group?.name || '').toLowerCase();
    const keys = keyIndex(group?.keys || group?.names);
    const totals = Array.isArray(group?.totals) ? group.totals : (Array.isArray(group?.stats) ? group.stats : []);
    if (!name.includes('defen') && !name.includes('misc')) continue;
    const read = (...aliases) => statAt(totals, keys, aliases);
    out.sacks += read('sacks', 'totalsacks', 'defensivesacks');
    out.interceptions += read('interceptions', 'ints');
    out.fumbleRecoveries += read('fumblesrecovered', 'fumberecoveries');
    out.defTouchdowns += read('defensivetouchdowns', 'td', 'tds');
    out.safeties += read('safeties');
    out.blockedKicks += read('blockedkicks', 'blocks');
  }
  return out;
}

function parseSummary(raw, game) {
  const store = { players: new Map(), teams: new Map() };
  const boxPlayers = raw?.boxscore?.players || [];
  for (const side of boxPlayers) {
    const teamAbbr = String(side?.team?.abbreviation || side?.team?.shortDisplayName || '').trim().toUpperCase();
    if (!teamAbbr) continue;
    for (const group of side.statistics || []) applyGroup(store, group, teamAbbr);
  }

  const homeAbbr = String(game?.home?.abbreviation || '').toUpperCase();
  const awayAbbr = String(game?.away?.abbreviation || '').toUpperCase();
  const homeScore = Number(game?.home?.score);
  const awayScore = Number(game?.away?.score);
  const homeDef = parseTeamTotals(boxPlayers.find((s) => String(s?.team?.abbreviation || '').toUpperCase() === homeAbbr)?.statistics);
  const awayDef = parseTeamTotals(boxPlayers.find((s) => String(s?.team?.abbreviation || '').toUpperCase() === awayAbbr)?.statistics);

  if (homeAbbr) {
    store.teams.set(homeAbbr, {
      team: homeAbbr,
      ...homeDef,
      pointsAllowed: Number.isFinite(awayScore) ? awayScore : 0,
      live: true
    });
  }
  if (awayAbbr) {
    store.teams.set(awayAbbr, {
      team: awayAbbr,
      ...awayDef,
      pointsAllowed: Number.isFinite(homeScore) ? homeScore : 0,
      live: true
    });
  }
  return store;
}

async function fetchSummary(eventId) {
  const id = String(eventId || '').trim();
  if (!id) return null;
  const pathPart = `apis/site/v2/sports/football/nfl/summary?event=${encodeURIComponent(id)}`;
  try {
    const hit = await espnResilient.fetchJsonResilient({
      urls: espnResilient.siteApiUrls(pathPart),
      cacheKey: `nfl-summary:${id}`,
      ttlMs: CACHE_MS,
      lane: 'site'
    });
    return hit?.data || null;
  } catch {
    return null;
  }
}

/**
 * @returns {{
 *   live: boolean,
 *   liveGames: number,
 *   finalGames: number,
 *   players: Map,
 *   playersByEspn: Map,
 *   playersByNameTeam: Map,
 *   teams: Map,
 *   fetchedAt: string
 * } | null}
 */
async function loadLiveWeekOverlay(season, week) {
  const seasonNum = Number(season) || new Date().getFullYear();
  const weekNum = Number(week);
  if (!Number.isFinite(weekNum) || weekNum < 1) return null;
  const memKey = `live:${seasonNum}:${weekNum}`;
  const hit = mem.get(memKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.payload;

  let slate;
  try {
    slate = await nflverseLive.getLiveScoring({ week: weekNum, seasontype: 2, season: seasonNum });
  } catch {
    return null;
  }
  const slateWeek = Number(slate?.week?.number);
  if (slateWeek && slateWeek !== weekNum) {
    const empty = {
      live: false,
      liveGames: 0,
      finalGames: 0,
      games: [],
      gamesByTeam: new Map(),
      players: new Map(),
      playersByEspn: new Map(),
      playersByNameTeam: new Map(),
      teams: new Map(),
      fetchedAt: new Date().toISOString()
    };
    mem.set(memKey, { at: Date.now(), payload: empty });
    return empty;
  }

  const allGames = Array.isArray(slate?.games) ? slate.games : [];
  const games = allGames.filter((g) => {
    const bucket = g?.status?.bucket;
    return bucket === 'live' || bucket === 'final';
  });
  const liveGames = games.filter((g) => g.status?.bucket === 'live').length;
  const finalGames = games.filter((g) => g.status?.bucket === 'final').length;

  const players = new Map();
  const playersByEspn = new Map();
  const playersByNameTeam = new Map();
  const teams = new Map();

  const batch = games.slice(0, 16);
  const summaries = await Promise.all(batch.map((g) => fetchSummary(g.id)));
  summaries.forEach((raw, i) => {
    if (!raw) return;
    const parsed = parseSummary(raw, batch[i]);
    for (const row of parsed.players.values()) {
      players.set(row.playerId, row);
      if (row.espnId) playersByEspn.set(String(row.espnId), row);
      if (row.name && row.team) {
        playersByNameTeam.set(`${row.name.toLowerCase()}|${row.team}`, row);
      }
    }
    for (const [abbr, row] of parsed.teams) teams.set(abbr, row);
  });

  const nflGames = allGames.map((g) => ({
    id: g.id,
    name: g.name || '',
    shortName: g.shortName || '',
    status: {
      bucket: g.status?.bucket || 'upcoming',
      detail: g.status?.shortDetail || g.status?.detail || g.status?.description || '',
      clock: g.status?.clock || null,
      period: g.status?.period || 0
    },
    home: {
      abbr: String(g.home?.abbreviation || '').toUpperCase(),
      score: g.home?.score ?? null,
      logo: g.home?.logo || null
    },
    away: {
      abbr: String(g.away?.abbreviation || '').toUpperCase(),
      score: g.away?.score ?? null,
      logo: g.away?.logo || null
    }
  }));
  const gamesByTeam = new Map();
  for (const g of nflGames) {
    if (g.home.abbr) gamesByTeam.set(g.home.abbr, g);
    if (g.away.abbr) gamesByTeam.set(g.away.abbr, g);
  }

  const payload = {
    live: liveGames > 0,
    liveGames,
    finalGames,
    games: nflGames,
    gamesByTeam,
    players,
    playersByEspn,
    playersByNameTeam,
    teams,
    fetchedAt: new Date().toISOString()
  };
  mem.set(memKey, { at: Date.now(), payload });
  return payload;
}

module.exports = {
  loadLiveWeekOverlay,
  CACHE_MS
};
