/**
 * Weekly NFL box stats for independent league scoring (nflverse).
 * Cached under DATA_DIR — Render ephemeral disk is fine for short-lived cache.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache', 'nflverse-week');
const UA = 'GridIron24-IndependentScoring/1.0';
const CACHE_MS = 30 * 60 * 1000;

const PLAYER_WEEK_URL = (season) =>
  `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`;
const TEAM_WEEK_URL = (season) =>
  `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${season}.csv`;
const GAMES_URL = 'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv';

const mem = new Map(); // key -> { at, payload }

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function toNum(v) {
  if (v === '' || v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    if (ch === '\r') continue;
    field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => String(h || '').trim());
  return rows.slice(1).filter((r) => r.some((c) => String(c || '').trim())).map((cols) => {
    const obj = {};
    for (let i = 0; i < headers.length; i += 1) obj[headers[i]] = cols[i] == null ? '' : String(cols[i]);
    return obj;
  });
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/csv,*/*' },
    redirect: 'follow'
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Fetch failed ${url} (${res.status})`), { status: 502 });
  }
  return res.text();
}

async function loadCachedText(cacheKey, url) {
  ensureDir(CACHE_DIR);
  const file = path.join(CACHE_DIR, `${cacheKey}.csv`);
  const memHit = mem.get(cacheKey);
  if (memHit && Date.now() - memHit.at < CACHE_MS) return memHit.text;

  if (fs.existsSync(file)) {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age < CACHE_MS) {
      const text = fs.readFileSync(file, 'utf8');
      mem.set(cacheKey, { at: Date.now(), text });
      return text;
    }
  }

  const text = await fetchText(url);
  fs.writeFileSync(file, text);
  mem.set(cacheKey, { at: Date.now(), text });
  return text;
}

function normalizePlayerRow(row) {
  const fumblesLost =
    toNum(row.fumbles_lost_total)
    || (toNum(row.rushing_fumbles_lost) + toNum(row.receiving_fumbles_lost) + toNum(row.sack_fumbles_lost));
  const twoPt =
    toNum(row.passing_2pt_conversions)
    + toNum(row.rushing_2pt_conversions)
    + toNum(row.receiving_2pt_conversions);
  return {
    playerId: String(row.player_id || '').trim(),
    name: String(row.player_display_name || row.player_name || '').trim(),
    position: String(row.position || '').trim().toUpperCase(),
    team: String(row.team || '').trim().toUpperCase(),
    week: toNum(row.week),
    season: toNum(row.season),
    seasonType: String(row.season_type || 'REG').toUpperCase(),
    passingYards: toNum(row.passing_yards),
    passingTds: toNum(row.passing_tds),
    passingInterceptions: toNum(row.passing_interceptions),
    rushingYards: toNum(row.rushing_yards),
    rushingTds: toNum(row.rushing_tds),
    receptions: toNum(row.receptions),
    receivingYards: toNum(row.receiving_yards),
    receivingTds: toNum(row.receiving_tds),
    fumblesLost,
    twoPointConversions: twoPt,
    specialTeamsTds: toNum(row.special_teams_tds),
    patMade: toNum(row.pat_made),
    fgMade: toNum(row.fg_made),
    fgMissed: toNum(row.fg_missed),
    fgMade0to19: toNum(row.fg_made_0_19),
    fgMade20to29: toNum(row.fg_made_20_29),
    fgMade30to39: toNum(row.fg_made_30_39),
    fgMade40to49: toNum(row.fg_made_40_49),
    fgMade50to59: toNum(row.fg_made_50_59),
    fgMade60plus: toNum(row.fg_made_60_)
  };
}

function normalizeTeamRow(row) {
  return {
    team: String(row.team || '').trim().toUpperCase(),
    week: toNum(row.week),
    season: toNum(row.season),
    seasonType: String(row.season_type || 'REG').toUpperCase(),
    opponent: String(row.opponent_team || '').trim().toUpperCase(),
    sacks: toNum(row.def_sacks),
    interceptions: toNum(row.def_interceptions),
    fumbleRecoveries: toNum(row.fumble_recovery_opp) + toNum(row.def_fumbles),
    defTouchdowns: toNum(row.def_tds) + toNum(row.fumble_recovery_tds) + toNum(row.special_teams_tds),
    safeties: toNum(row.def_safeties),
    blockedKicks: toNum(row.fg_blocked) + toNum(row.pat_blocked) + toNum(row.pt_blocked)
  };
}

function buildPointsAllowedMap(gameRows, season, week) {
  const map = new Map(); // team -> points allowed
  for (const g of gameRows) {
    if (toNum(g.season) !== Number(season)) continue;
    if (toNum(g.week) !== Number(week)) continue;
    const type = String(g.game_type || '').toUpperCase();
    if (type && type !== 'REG' && type !== 'REGULAR') continue;
    const home = String(g.home_team || '').toUpperCase();
    const away = String(g.away_team || '').toUpperCase();
    const homeScore = g.home_score === '' || g.home_score == null ? null : toNum(g.home_score);
    const awayScore = g.away_score === '' || g.away_score == null ? null : toNum(g.away_score);
    if (home && awayScore != null) map.set(home, awayScore);
    if (away && homeScore != null) map.set(away, homeScore);
  }
  return map;
}

/**
 * Load normalized week maps for a season/week.
 * @returns {{
 *   season, week, sourceSeason,
 *   players: Map<playerId, stats>,
 *   teams: Map<teamAbbr, dstStats>,
 *   availableWeeks: number[],
 *   playerCount: number
 * }}
 */
async function loadWeekBoxScores(season, week, { allowFallbackSeason = true } = {}) {
  const seasonNum = Number(season) || new Date().getFullYear();
  const weekNum = Math.max(1, Math.min(22, Number(week) || 1));
  const memKey = `box:${seasonNum}:${weekNum}`;
  const hit = mem.get(memKey);
  if (hit?.payload && Date.now() - hit.at < CACHE_MS) return hit.payload;

  async function loadSeason(s) {
    const [playerText, teamText, gamesText] = await Promise.all([
      loadCachedText(`player_week_${s}`, PLAYER_WEEK_URL(s)),
      loadCachedText(`team_week_${s}`, TEAM_WEEK_URL(s)),
      loadCachedText('games', GAMES_URL)
    ]);
    const playerRows = parseCsv(playerText).map(normalizePlayerRow)
      .filter((r) => r.playerId && r.seasonType === 'REG');
    const teamRows = parseCsv(teamText).map(normalizeTeamRow)
      .filter((r) => r.team && r.seasonType === 'REG');
    const gameRows = parseCsv(gamesText);
    const weeks = [...new Set(playerRows.map((r) => r.week).filter((w) => w >= 1))].sort((a, b) => a - b);
    return { playerRows, teamRows, gameRows, weeks, season: s };
  }

  let pack = await loadSeason(seasonNum);
  let sourceSeason = seasonNum;
  let useWeek = weekNum;

  if ((!pack.weeks.includes(weekNum) || !pack.playerRows.some((r) => r.week === weekNum)) && allowFallbackSeason) {
    // Prefer latest week in requested season; else previous season finals.
    if (pack.weeks.length) {
      useWeek = pack.weeks[pack.weeks.length - 1];
    } else {
      pack = await loadSeason(seasonNum - 1);
      sourceSeason = seasonNum - 1;
      useWeek = pack.weeks.length ? pack.weeks[pack.weeks.length - 1] : 1;
    }
  }

  const players = new Map();
  for (const row of pack.playerRows) {
    if (row.week !== useWeek) continue;
    players.set(row.playerId, row);
  }

  const pointsAllowed = buildPointsAllowedMap(pack.gameRows, sourceSeason, useWeek);
  const teams = new Map();
  for (const row of pack.teamRows) {
    if (row.week !== useWeek) continue;
    teams.set(row.team, {
      ...row,
      pointsAllowed: pointsAllowed.has(row.team) ? pointsAllowed.get(row.team) : 0
    });
  }

  const payload = {
    season: seasonNum,
    week: useWeek,
    requestedWeek: weekNum,
    sourceSeason,
    players,
    teams,
    availableWeeks: pack.weeks,
    playerCount: players.size,
    teamCount: teams.size
  };
  mem.set(memKey, { at: Date.now(), payload });
  return payload;
}

module.exports = {
  loadWeekBoxScores,
  parseCsv,
  CACHE_DIR
};
