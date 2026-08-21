/**
 * Beta / lounge draft pool — current NFL fantasy players with:
 * roster + headshot (nflverse), prior-season fantasy + box stats (nflverse),
 * projections (Sleeper), multi-source GridIron ranks (FFC ADP, Sleeper ADP,
 * ESPN, VORP, prior-season scoring), bye week, team logos.
 */
const { espnLogoUrl } = require('./nfl-teams');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DRAFT_FILE = path.join(DATA_DIR, 'beta-draft.json');
const FANTASY_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'D/ST']);
const EXCLUDE_STATUS = new Set(['INA', 'RET', 'CUT', 'NWT', 'EXE']);
const POOL_CACHE_MS = 2 * 60 * 60 * 1000;
const PRESEASON_POOL_CACHE_MS = 15 * 60 * 1000;
const FORCE_COALESCE_MS = 5 * 60 * 1000;
const UA = 'GridIron24-DraftPool/2.4';

const ROSTER_URL = (season) =>
  `https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_${season}.csv`;
const STATS_URL = (season) =>
  `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_reg_${season}.csv`;
const SCHEDULE_URL = 'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv';
const TEAMS_URL = 'https://github.com/nflverse/nflverse-data/releases/download/teams/teams_colors_logos.csv';
const SLEEPER_PLAYERS_URL = 'https://api.sleeper.app/v1/players/nfl';
const SLEEPER_STATE_URL = 'https://api.sleeper.app/v1/state/nfl';
const SLEEPER_PROJ_URL = (season) => `https://api.sleeper.app/v1/projections/nfl/regular/${season}`;
const SLEEPER_HEADSHOT = (id) => `https://sleepercdn.com/content/nfl/players/thumb/${id}.jpg`;
const FFC_ADP_URL = (scoring, teams, year) =>
  `https://fantasyfootballcalculator.com/api/v1/adp/${scoring}?teams=${teams}${year ? `&year=${year}` : ''}`;
const FFC_TEAM_SIZES = new Set([8, 10, 12, 14]);

function normalizeScoring(value) {
  const s = String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (s === 'std' || s === 'standard' || s === 'non-ppr' || s === 'nonppr') return 'standard';
  if (s === 'half' || s === 'half-ppr' || s === 'halfppr' || s === '0.5-ppr' || s === '0.5ppr') return 'half-ppr';
  return 'ppr';
}

function scoringLabel(scoring) {
  const s = normalizeScoring(scoring);
  if (s === 'standard') return 'Standard';
  if (s === 'half-ppr') return 'Half PPR';
  return 'PPR';
}

function scoringFromSettings(settings) {
  const preset = String(settings?.scoringPreset || settings?.preset || '').toLowerCase();
  if (preset === 'standard') return 'standard';
  if (preset === 'half-ppr' || preset === 'halfppr') return 'half-ppr';
  if (preset === 'gridiron24-vanilla' || preset === 'ppr' || preset === 'full-ppr' || preset === 'fullppr') {
    return 'ppr';
  }
  const rec = Number(settings?.scoring?.reception ?? settings?.reception);
  if (rec === 0) return 'standard';
  if (rec === 0.5) return 'half-ppr';
  return 'ppr';
}

function clampAdpTeams(n) {
  const v = Number(n);
  return FFC_TEAM_SIZES.has(v) ? v : 12;
}

function sleeperOrderBy(scoring) {
  const s = normalizeScoring(scoring);
  if (s === 'standard') return 'pts_std';
  if (s === 'half-ppr') return 'pts_half_ppr';
  return 'pts_ppr';
}

function projectedPointsForScoring(projRow, scoring) {
  if (!projRow || typeof projRow !== 'object') return null;
  const ppr = toNum(projRow.pts_ppr);
  const half = toNum(projRow.pts_half_ppr);
  const std = toNum(projRow.pts_std);
  const rec = toNum(projRow.rec) || 0;
  const s = normalizeScoring(scoring);
  if (s === 'standard') return std ?? (ppr != null ? ppr - rec : half);
  if (s === 'half-ppr') {
    if (half != null) return half;
    if (ppr != null && std != null) return (ppr + std) / 2;
    if (ppr != null) return ppr - (0.5 * rec);
    return std != null ? std + (0.5 * rec) : null;
  }
  return ppr ?? (std != null ? std + rec : half);
}

function sleeperAdpForScoring(projRow, scoring) {
  if (!projRow || typeof projRow !== 'object') return null;
  const s = normalizeScoring(scoring);
  if (s === 'standard') return cleanAdp(projRow.adp_std ?? projRow.adp_half_ppr ?? projRow.adp_ppr);
  if (s === 'half-ppr') return cleanAdp(projRow.adp_half_ppr ?? projRow.adp_ppr ?? projRow.adp_std);
  return cleanAdp(projRow.adp_ppr ?? projRow.adp_half_ppr ?? projRow.adp_std);
}

function sleeperSeasonProjListUrl(season, scoring = 'ppr') {
  const url = new URL(`https://api.sleeper.com/projections/nfl/${season}`);
  url.searchParams.set('season_type', 'regular');
  url.searchParams.set('order_by', sleeperOrderBy(scoring));
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) {
    url.searchParams.append('position[]', pos);
  }
  return url.toString();
}

const TEAM_ALIASES = {
  LA: 'LAR',
  LAR: 'LAR',
  JAC: 'JAX',
  JAX: 'JAX',
  WSH: 'WAS',
  WAS: 'WAS',
  OAK: 'LV',
  LV: 'LV',
  SD: 'LAC',
  LAC: 'LAC',
  STL: 'LAR',
  ARZ: 'ARI'
};

/** ESPN fantasy proTeamId → NFL abbr (for matching expert ranks). */
const ESPN_PRO_TEAM = {
  1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET',
  9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN',
  17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC',
  25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WAS', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU'
};
const ESPN_POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' };

function canonTeam(team) {
  const t = String(team || '').trim().toUpperCase();
  if (!t) return null;
  return TEAM_ALIASES[t] || t;
}

/** Replacement-level depth for VORP fallback when a player has no ADP. */
const REPLACEMENT_DEPTH = { QB: 12, RB: 36, WR: 48, TE: 12, K: 12, 'D/ST': 12 };
const CURRENT_NFL_TEAMS = new Set([
  'ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE',
  'DAL', 'DEN', 'DET', 'GB', 'HOU', 'IND', 'JAX', 'KC',
  'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG',
  'NYJ', 'PHI', 'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS'
]);

let poolCaches = new Map();
const poolInflight = new Map();

function cachedPoolPayload(entry) {
  return {
    ok: true,
    source: entry.meta.source,
    adpSource: entry.meta.adpSource,
    scoring: entry.meta.scoring || 'ppr',
    scoringLabel: entry.meta.scoringLabel || scoringLabel(entry.meta.scoring),
    adpTeams: entry.meta.adpTeams || 12,
    rankModel: entry.meta.rankModel || 'gridiron-composite',
    rankSources: entry.meta.rankSources || [],
    ffcDrafts: entry.meta.ffcDrafts,
    ffcWindow: entry.meta.ffcWindow || null,
    season: entry.meta.season,
    statsSeason: entry.meta.statsSeason,
    projectionSeason: entry.meta.projectionSeason,
    fetchedAt: new Date(entry.at).toISOString(),
    cacheMs: entry.meta.cacheMs || POOL_CACHE_MS,
    counts: entry.meta.counts,
    players: entry.players
  };
}

function normalizeFantasyPos(pos) {
  const p = String(pos || '').trim().toUpperCase();
  if (p === 'DEF' || p === 'DST' || p === 'D/ST') return 'D/ST';
  if (p === 'PK') return 'K';
  return p;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
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

async function fetchText(url, { accept = 'text/csv,*/*' } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: accept },
    redirect: 'follow'
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Fetch failed ${url} (${res.status})`), { status: 502 });
  }
  return res.text();
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    redirect: 'follow'
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Fetch failed ${url} (${res.status})`), { status: 502 });
  }
  return res.json();
}

function normName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function matchKey(name, team, position) {
  return `${normName(name)}|${canonTeam(team) || ''}|${String(position || '').toUpperCase()}`;
}

function toNum(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function normalizePlayer(row, season) {
  const position = normalizeFantasyPos(row.position);
  const status = String(row.status || '').trim().toUpperCase();
  const gsisId = String(row.gsis_id || '').trim();
  const espnId = String(row.espn_id || '').trim();
  const id = gsisId || (espnId ? `espn-${espnId}` : null);
  if (!id) return null;
  const name = String(row.full_name || row.football_name || '').trim();
  if (!name) return null;
  return {
    id,
    gsisId: gsisId || null,
    espnId: espnId || null,
    name,
    firstName: String(row.first_name || '').trim() || null,
    lastName: String(row.last_name || '').trim() || null,
    position,
    team: canonTeam(row.team) || String(row.team || '').trim().toUpperCase() || null,
    jersey: String(row.jersey_number || '').trim() || null,
    status,
    yearsExp: row.years_exp === '' || row.years_exp == null ? null : Number(row.years_exp),
    headshot: String(row.headshot_url || '').trim() || null,
    college: String(row.college || '').trim() || null,
    draftNumber: String(row.draft_number || '').trim() || null,
    draftClub: String(row.draft_club || '').trim() || null,
    season: Number(season),
    byeWeek: null,
    teamLogo: null,
    fantasyPoints2025: null,
    projectedPoints2026: null,
    sleeperId: null
  };
}

function filterDraftPool(players, { activeOnly = true } = {}) {
  return players.filter((p) => {
    if (!FANTASY_POSITIONS.has(p.position)) return false;
    if (activeOnly && EXCLUDE_STATUS.has(p.status)) return false;
    return true;
  });
}

function buildByeMap(scheduleRows, season) {
  const year = String(season);
  const played = new Map();
  for (const row of scheduleRows) {
    if (String(row.season) !== year) continue;
    if (String(row.game_type || 'REG').toUpperCase() !== 'REG') continue;
    const week = Number(row.week);
    if (!Number.isFinite(week) || week < 1 || week > 18) continue;
    for (const side of ['away_team', 'home_team']) {
      const team = String(row[side] || '').trim().toUpperCase();
      if (!team) continue;
      if (!played.has(team)) played.set(team, new Set());
      played.get(team).add(week);
    }
  }
  const byes = new Map();
  for (const [team, weeks] of played) {
    const missing = [];
    for (let w = 1; w <= 18; w += 1) {
      if (!weeks.has(w)) missing.push(w);
    }
    if (missing.length === 1) byes.set(team, missing[0]);
  }
  return byes;
}

function buildTeamLogoMap(teamRows) {
  const map = new Map();
  for (const row of teamRows) {
    const abbr = canonTeam(row.team_abbr) || String(row.team_abbr || '').trim().toUpperCase();
    if (!abbr) continue;
    const logo = espnLogoUrl(abbr)
      || String(row.team_logo_espn || row.team_logo_squared || '').trim();
    if (logo) map.set(abbr, logo);
  }
  for (const abbr of CURRENT_NFL_TEAMS) {
    map.set(abbr, espnLogoUrl(abbr));
  }
  map.set('ARZ', map.get('ARI'));
  return map;
}

function buildTeamMetaMap(teamRows) {
  const map = new Map();
  for (const row of teamRows) {
    const abbr = canonTeam(row.team_abbr) || String(row.team_abbr || '').trim().toUpperCase();
    if (!abbr) continue;
    map.set(abbr, {
      abbr,
      name: String(row.team_name || '').trim() || null,
      nick: String(row.team_nick || '').trim() || null,
      logo: espnLogoUrl(abbr) || String(row.team_logo_espn || row.team_logo_squared || '').trim() || null
    });
  }
  for (const abbr of CURRENT_NFL_TEAMS) {
    const cur = map.get(abbr) || { abbr, name: null, nick: null, logo: null };
    cur.logo = espnLogoUrl(abbr);
    map.set(abbr, cur);
  }
  return map;
}

function fantasyPointsForScoring(row, scoring) {
  const ppr = toNum(row.fantasy_points_ppr);
  const std = toNum(row.fantasy_points);
  const rec = toNum(row.receptions) || 0;
  const s = normalizeScoring(scoring);
  if (s === 'standard') return std ?? (ppr != null ? ppr - rec : null);
  if (s === 'half-ppr') {
    if (ppr != null && std != null) return (ppr + std) / 2;
    if (std != null) return std + (0.5 * rec);
    if (ppr != null) return ppr - (0.5 * rec);
    return null;
  }
  return ppr ?? (std != null ? std + rec : null);
}

function buildStats2025Map(statRows, scoring = 'ppr') {
  const map = new Map();
  for (const row of statRows) {
    const id = String(row.player_id || '').trim();
    if (!id) continue;
    const pts = fantasyPointsForScoring(row, scoring);
    if (pts == null) continue;
    const games = toNum(row.games);
    const rounded = Math.round(pts * 10) / 10;
    const avg = games && games > 0 ? Math.round((rounded / games) * 10) / 10 : null;
    map.set(id, {
      fantasyPoints: rounded,
      games: games != null ? Math.round(games) : null,
      avgPpg: avg,
      passYds: toNum(row.passing_yards),
      passTd: toNum(row.passing_tds),
      passInt: toNum(row.passing_interceptions),
      rushYds: toNum(row.rushing_yards),
      rushTd: toNum(row.rushing_tds),
      targets: toNum(row.targets),
      receptions: toNum(row.receptions),
      recYds: toNum(row.receiving_yards),
      recTd: toNum(row.receiving_tds),
      fgMade: toNum(row.fg_made),
      fgAtt: toNum(row.fg_att),
      xpMade: toNum(row.pat_made ?? row.xp_made)
    });
  }
  return map;
}

function cleanAdp(value) {
  const n = toNum(value);
  if (n == null || n <= 0 || n >= 900) return null;
  return Math.round(n * 10) / 10;
}

/**
 * Fantasy Football Calculator ADP — real mock-draft market order (much better
 * than ranking by raw season-long projection totals).
 */
async function loadFfcAdpMaps(year, scoring = 'ppr', teams = 12) {
  const byKey = new Map();
  const ffcScoring = normalizeScoring(scoring);
  const ffcTeams = clampAdpTeams(teams);
  const attempts = [
    FFC_ADP_URL(ffcScoring, ffcTeams, year),
    FFC_ADP_URL(ffcScoring, ffcTeams, null),
    ffcTeams !== 12 ? FFC_ADP_URL(ffcScoring, 12, year) : null,
    ffcTeams !== 12 ? FFC_ADP_URL(ffcScoring, 12, null) : null
  ].filter(Boolean);
  let meta = null;
  for (const url of attempts) {
    try {
      const data = await fetchJson(url);
      const players = Array.isArray(data?.players) ? data.players : [];
      if (!players.length) continue;
      if (!meta) meta = { ...(data.meta || {}), source: url, scoring: ffcScoring, teams: ffcTeams };
      for (const row of players) {
        const name = String(row.name || '').trim();
        const pos = normalizeFantasyPos(row.position);
        if (!name || !FANTASY_POSITIONS.has(pos)) continue;
        const team = canonTeam(row.team) || String(row.team || '').toUpperCase() || null;
        const adp = cleanAdp(row.adp);
        if (adp == null) continue;
        const payload = {
          adp,
          name,
          team,
          position: pos,
          byeWeek: toNum(row.bye),
          timesDrafted: toNum(row.times_drafted),
          stdev: toNum(row.stdev)
        };
        const withTeam = matchKey(name, team, pos);
        const noTeam = matchKey(name, '', pos);
        if (!byKey.has(withTeam)) byKey.set(withTeam, payload);
        if (!byKey.has(noTeam)) byKey.set(noTeam, payload);
        if (pos === 'D/ST' && team) {
          const dstKey = `__dst__|${team}`;
          if (!byKey.has(dstKey)) byKey.set(dstKey, payload);
        }
      }
      if (byKey.size >= 100) break;
    } catch {
      /* try next URL in the same scoring format */
    }
  }
  if (!meta) meta = { scoring: ffcScoring, teams: ffcTeams };
  return { byKey, meta, count: byKey.size };
}

function lookupFfc(ffcAdp, name, team, pos) {
  const canon = canonTeam(team);
  return ffcAdp.byKey.get(matchKey(name, canon, pos))
    || ffcAdp.byKey.get(matchKey(name, team, pos))
    || ffcAdp.byKey.get(matchKey(name, '', pos))
    || (pos === 'D/ST' && canon ? ffcAdp.byKey.get(`__dst__|${canon}`) : null)
    || null;
}

function averageNums(values) {
  const nums = [];
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) nums.push(n);
  }
  if (!nums.length) return null;
  return Math.round((nums.reduce((sum, n) => sum + n, 0) / nums.length) * 10) / 10;
}

function marketAdpFields(ffcHit, sleeperHit) {
  const adpFfc = ffcHit?.adp ?? null;
  const adpSleeper = sleeperHit?.adp ?? null;
  const adp = averageNums([adpFfc, adpSleeper]);
  let adpSource = null;
  if (adpFfc != null && adpSleeper != null) adpSource = 'market';
  else if (adpFfc != null) adpSource = 'ffc';
  else if (adpSleeper != null) adpSource = 'sleeper';
  return {
    adp,
    adpFfc,
    adpSleeper,
    adpSource,
    adpStdev: ffcHit?.stdev ?? null,
    adpSample: ffcHit?.timesDrafted ?? null
  };
}

function espnRankForScoring(draftRanks, scoring) {
  const ranks = draftRanks && typeof draftRanks === 'object' ? draftRanks : {};
  const ppr = toNum(ranks.PPR?.rank);
  const std = toNum(ranks.STANDARD?.rank);
  const s = normalizeScoring(scoring);
  if (s === 'standard') return std != null && std > 0 ? std : ppr;
  if (s === 'half-ppr') {
    if (ppr != null && std != null) return Math.round(((ppr + std) / 2) * 10) / 10;
    return ppr ?? std;
  }
  return ppr != null && ppr > 0 ? ppr : std;
}

async function loadEspnDraftRanks(year, scoring) {
  const empty = { byEspnId: new Map(), byKey: new Map(), byDst: new Map(), count: 0 };
  try {
    const espnResilient = require('./espn-resilient');
    const pathAndQuery = `apis/v3/games/ffl/seasons/${year}/segments/0/leaguedefaults/3?view=kona_player_info`;
    const hit = await espnResilient.fetchJsonResilient({
      urls: espnResilient.fantasyLeagueUrls(pathAndQuery),
      cacheKey: `espn-draft-ranks:${year}`,
      ttlMs: Math.min(POOL_CACHE_MS, 60 * 60 * 1000),
      headers: {
        Accept: 'application/json',
        'User-Agent': UA,
        'X-Fantasy-Filter': JSON.stringify({
          players: { limit: 2000, sortPercOwned: { sortPriority: 1, sortAsc: false } }
        })
      },
      lane: 'fantasy'
    });
    const list = Array.isArray(hit?.data?.players) ? hit.data.players : [];
    const byEspnId = new Map();
    const byKey = new Map();
    const byDst = new Map();
    for (const row of list) {
      const player = row?.player || row;
      const id = String(player?.id || row?.id || '').trim();
      const name = String(player?.fullName || '').trim();
      const pos = ESPN_POS[Number(player?.defaultPositionId)] || normalizeFantasyPos(player?.defaultPosition);
      const team = ESPN_PRO_TEAM[Number(player?.proTeamId)] || canonTeam(player?.proTeam) || null;
      const rank = espnRankForScoring(player?.draftRanksByRankType, scoring);
      if (rank == null || rank <= 0) continue;
      const payload = { rank, name, team, position: pos, espnId: id };
      if (id) byEspnId.set(id, payload);
      if (name && FANTASY_POSITIONS.has(pos)) {
        const withTeam = matchKey(name, team, pos);
        const noTeam = matchKey(name, '', pos);
        if (!byKey.has(withTeam)) byKey.set(withTeam, payload);
        if (!byKey.has(noTeam)) byKey.set(noTeam, payload);
      }
      if (pos === 'D/ST' && team && !byDst.has(team)) byDst.set(team, payload);
    }
    return { byEspnId, byKey, byDst, count: byEspnId.size };
  } catch {
    return empty;
  }
}

function lookupEspn(espnRanks, player) {
  if (!espnRanks || !player) return null;
  const espnId = String(player.espnId || '').trim();
  if (espnId && espnRanks.byEspnId.get(espnId)) return espnRanks.byEspnId.get(espnId);
  return espnRanks.byKey.get(matchKey(player.name, player.team, player.position))
    || espnRanks.byKey.get(matchKey(player.name, '', player.position))
    || (player.position === 'D/ST' && player.team
      ? espnRanks.byDst.get(canonTeam(player.team) || player.team)
      : null)
    || null;
}

function indexSleeperProjList(list) {
  const byId = new Map();
  for (const row of Array.isArray(list) ? list : []) {
    const stats = row?.stats;
    if (!stats || typeof stats !== 'object') continue;
    const id = String(row.player_id || '').trim();
    if (id) byId.set(id, stats);
    const team = canonTeam(row.team || row.player?.team);
    const pos = normalizeFantasyPos(row.player?.position || row.player?.fantasy_positions?.[0]);
    if (pos === 'D/ST' && team) byId.set(`def-${team}`, stats);
  }
  return byId;
}

function assignVorp(players) {
  const byPos = new Map();
  for (const p of players) {
    const pos = p.position || '?';
    if (!byPos.has(pos)) byPos.set(pos, []);
    byPos.get(pos).push(p);
  }
  for (const [pos, list] of byPos) {
    list.sort((a, b) => {
      const pa = a.projectedPoints2026 != null ? a.projectedPoints2026 : -1;
      const pb = b.projectedPoints2026 != null ? b.projectedPoints2026 : -1;
      return pb - pa;
    });
    const depth = REPLACEMENT_DEPTH[pos] || 12;
    const replIdx = Math.min(Math.max(depth - 1, 0), list.length - 1);
    const replacement = list[replIdx]?.projectedPoints2026 ?? 0;
    for (const p of list) {
      p._vorp = p.projectedPoints2026 != null
        ? Math.round((p.projectedPoints2026 - replacement) * 10) / 10
        : -999;
    }
  }
}

function rankMapAsc(players, getter) {
  const scored = [];
  for (const p of players) {
    const v = getter(p);
    if (v == null || !Number.isFinite(Number(v))) continue;
    scored.push({ p, v: Number(v) });
  }
  scored.sort((a, b) => a.v - b.v || String(a.p.name || '').localeCompare(String(b.p.name || '')));
  const map = new Map();
  scored.forEach((row, i) => map.set(row.p, i + 1));
  return map;
}

function rankDraftPool(players) {
  assignVorp(players);
  const ffc = rankMapAsc(players, (p) => p.adpFfc);
  const sleeperAdp = rankMapAsc(players, (p) => p.adpSleeper);
  const espn = rankMapAsc(players, (p) => p.espnRank);
  const vorp = rankMapAsc(players, (p) => (p._vorp != null && p._vorp > -900 ? -p._vorp : null));
  const prior = rankMapAsc(players, (p) => (p.fantasyPoints2025 != null ? -p.fantasyPoints2025 : null));
  const inputs = [
    { key: 'ffc', map: ffc },
    { key: 'sleeperAdp', map: sleeperAdp },
    { key: 'espn', map: espn },
    { key: 'vorp', map: vorp },
    { key: 'prior', map: prior }
  ];
  for (const p of players) {
    const used = [];
    const breakdown = {};
    let sum = 0;
    for (const src of inputs) {
      const r = src.map.get(p);
      if (r == null) continue;
      used.push(src.key);
      breakdown[src.key] = r;
      sum += r;
    }
    p.rankScore = used.length ? Math.round((sum / used.length) * 10) / 10 : 9999;
    p.rankInputs = used;
    p.rankBreakdown = breakdown;
  }
  players.sort((a, b) => {
    if (a.rankScore !== b.rankScore) return a.rankScore - b.rankScore;
    const va = a._vorp != null ? a._vorp : -999;
    const vb = b._vorp != null ? b._vorp : -999;
    if (vb !== va) return vb - va;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
  const posCounts = {};
  players.forEach((p, i) => {
    p.overallRank = i + 1;
    const pos = p.position || '?';
    posCounts[pos] = (posCounts[pos] || 0) + 1;
    p.posRank = posCounts[pos];
    p.vorp = p._vorp != null && p._vorp > -900 ? p._vorp : null;
    delete p._vorp;
  });
  return players;
}

function buildSleeperMaps(sleeperPlayers, projections, listById = new Map(), scoring = 'ppr') {
  const byGsis = new Map();
  const byEspn = new Map();
  const byKey = new Map();
  const byTeamDef = new Map();
  for (const [sleeperId, row] of Object.entries(sleeperPlayers || {})) {
    if (!row || typeof row !== 'object') continue;
    const pos = normalizeFantasyPos(row.position);
    if (!FANTASY_POSITIONS.has(pos)) continue;
    const team = canonTeam(row.team || row.team_abbr || sleeperId) || String(row.team || row.team_abbr || '').toUpperCase() || null;
    const name = String(row.full_name || `${row.first_name || ''} ${row.last_name || ''}`).trim();
    if (!name && pos !== 'D/ST') continue;
    const dictRow = projections?.[sleeperId] || (pos === 'D/ST' && team ? projections?.[team] : null) || {};
    const listRow = listById.get(String(sleeperId))
      || (pos === 'D/ST' && team ? listById.get(`def-${team}`) : null)
      || {};
    const projRow = { ...dictRow, ...listRow };
    const projected = projectedPointsForScoring(projRow, scoring);
    const payload = {
      sleeperId: String(sleeperId),
      espnId: String(row.espn_id || '').trim() || null,
      projectedPoints2026: projected != null ? Math.round(projected * 10) / 10 : null,
      adp: sleeperAdpForScoring(projRow, scoring),
      projPassYds: toNum(projRow?.pass_yd),
      projPassTd: toNum(projRow?.pass_td),
      projPassInt: toNum(projRow?.pass_int),
      projRushYds: toNum(projRow?.rush_yd),
      projRushTd: toNum(projRow?.rush_td),
      projRec: toNum(projRow?.rec),
      projRecYds: toNum(projRow?.rec_yd),
      projRecTd: toNum(projRow?.rec_td),
      headshot: pos === 'D/ST' ? null : SLEEPER_HEADSHOT(sleeperId),
      team,
      position: pos,
      name: name || (team ? `${team} D/ST` : 'D/ST'),
      firstName: String(row.first_name || '').trim() || null,
      lastName: String(row.last_name || '').trim() || null,
      injuryStatus: String(row.injury_status || '').trim() || null,
      injuryBodyPart: String(row.injury_body_part || '').trim() || null,
      injuryNotes: String(row.injury_notes || '').trim() || null,
      practiceStatus: String(row.practice_participation || '').trim() || null,
      practiceDescription: String(row.practice_description || '').trim() || null
    };
    const gsis = String(row.gsis_id || '').trim();
    if (gsis) byGsis.set(gsis, payload);
    if (payload.espnId) byEspn.set(payload.espnId, payload);
    byKey.set(matchKey(payload.name, team, pos), payload);
    byKey.set(matchKey(payload.name, '', pos), payload);
    if (pos === 'D/ST' && team) byTeamDef.set(team, payload);
  }
  return { byGsis, byEspn, byKey, byTeamDef };
}

/**
 * NFL team defenses aren't on the player roster CSV — stitch them from Sleeper DEF
 * units + FFC ADP + nflverse team logos/byes so mocks have a full D/ST board.
 */
function buildDefenseUnits({ sleeper, ffcAdp, espnRanks, byeMap, teamMeta, season }) {
  const teams = new Set([
    ...teamMeta.keys(),
    ...(sleeper.byTeamDef ? sleeper.byTeamDef.keys() : [])
  ]);
  // FFC sometimes lists defenses for teams not yet in the current meta snapshot
  for (const key of ffcAdp.byKey.keys()) {
    if (String(key).startsWith('__dst__|')) teams.add(String(key).slice(8));
  }

  const units = [];
  for (const team of [...teams].sort()) {
    if (!CURRENT_NFL_TEAMS.has(team)) continue;
    const meta = teamMeta.get(team) || {};
    const sleeperHit = sleeper.byTeamDef?.get(canonTeam(team) || team) || sleeper.byTeamDef?.get(team) || null;
    const ffcHit = ffcAdp.byKey.get(`__dst__|${canonTeam(team) || team}`)
      || ffcAdp.byKey.get(`__dst__|${team}`)
      || null;
    const nick = meta.nick || sleeperHit?.lastName || team;
    const name = `${nick} D/ST`;
    const market = marketAdpFields(ffcHit, sleeperHit);
    const espnHit = lookupEspn(espnRanks, {
      espnId: sleeperHit?.espnId,
      name,
      team,
      position: 'D/ST'
    });
    const sources = ['sleeper-dst'];
    if (ffcHit) sources.push('ffc');
    if (espnHit) sources.push('espn');

    units.push({
      id: `dst-${team}`,
      gsisId: null,
      espnId: sleeperHit?.espnId || espnHit?.espnId || null,
      name,
      firstName: sleeperHit?.firstName || meta.name?.split(' ')[0] || team,
      lastName: 'D/ST',
      position: 'D/ST',
      team,
      jersey: null,
      status: 'ACT',
      yearsExp: null,
      headshot: meta.logo || sleeperHit?.headshot || null,
      college: null,
      draftNumber: null,
      draftClub: null,
      season: Number(season),
      byeWeek: byeMap.get(canonTeam(team) || team) || ffcHit?.byeWeek || null,
      teamLogo: espnLogoUrl(team) || meta.logo || null,
      fantasyPoints2025: null,
      projectedPoints2026: sleeperHit?.projectedPoints2026 ?? null,
      avgPpg: null,
      games: null,
      adp: market.adp,
      adpFfc: market.adpFfc,
      adpSleeper: market.adpSleeper,
      adpSource: market.adpSource,
      adpStdev: market.adpStdev,
      adpSample: market.adpSample,
      espnRank: espnHit?.rank ?? null,
      delta: null,
      injuryStatus: null,
      injuryBodyPart: null,
      injuryNotes: null,
      practiceStatus: null,
      practiceDescription: null,
      stats: null,
      projStats: null,
      sleeperId: sleeperHit?.sleeperId || team,
      sources,
      overallRank: null,
      posRank: null
    });
  }
  return units;
}

async function loadRoster(season) {
  try {
    const csv = await fetchText(ROSTER_URL(season));
    return { season, rows: parseCsv(csv) };
  } catch (err) {
    const prior = season - 1;
    const csv = await fetchText(ROSTER_URL(prior));
    return { season: prior, rows: parseCsv(csv) };
  }
}

async function loadDraftPool({ season, activeOnly = true, force = false, scoring, teams } = {}) {
  const yearGuess = Number(season) || new Date().getFullYear();
  const scoringKey = normalizeScoring(scoring);
  const teamKey = clampAdpTeams(teams);
  const key = `${yearGuess}:${activeOnly ? 'active' : 'all'}:${scoringKey}:${teamKey}:v11-espn-logos`;
  const cached = poolCaches.get(key);
  const cacheAge = Date.now() - (cached?.at || 0);
  const cacheMs = cached?.meta?.cacheMs || POOL_CACHE_MS;
  const freshEnough = cached?.players && cacheAge < cacheMs;
  if (!force && freshEnough) {
    return cachedPoolPayload(cached);
  }
  if (force && freshEnough && cacheAge < FORCE_COALESCE_MS) {
    return cachedPoolPayload(cached);
  }
  if (poolInflight.has(key)) {
    return poolInflight.get(key);
  }

  const build = (async () => {
  const roster = await loadRoster(yearGuess);
  const priorSeason = yearGuess - 1;

  const [nflState, statsCsv, scheduleCsv, teamsCsv, sleeperPlayers, sleeperProj, sleeperProjList, ffcAdp, espnRanks] = await Promise.all([
    fetchJson(SLEEPER_STATE_URL).catch(() => null),
    fetchText(STATS_URL(priorSeason)).catch(() => ''),
    fetchText(SCHEDULE_URL).catch(() => ''),
    fetchText(TEAMS_URL).catch(() => ''),
    fetchJson(SLEEPER_PLAYERS_URL).catch(() => ({})),
    fetchJson(SLEEPER_PROJ_URL(yearGuess)).catch(() => ({})),
    fetchJson(sleeperSeasonProjListUrl(yearGuess, scoringKey)).catch(() => []),
    loadFfcAdpMaps(yearGuess, scoringKey, teamKey),
    loadEspnDraftRanks(yearGuess, scoringKey)
  ]);

  const year = Number(season) || Number(nflState?.season) || yearGuess;
  const seasonType = String(nflState?.season_type || '').toLowerCase();
  const liveCacheMs = (seasonType === 'pre' || seasonType === 'off')
    ? PRESEASON_POOL_CACHE_MS
    : POOL_CACHE_MS;

  const teamRows = teamsCsv ? parseCsv(teamsCsv) : [];
  const statsMap = buildStats2025Map(statsCsv ? parseCsv(statsCsv) : [], scoringKey);
  const byeMap = buildByeMap(scheduleCsv ? parseCsv(scheduleCsv) : [], year);
  const logoMap = buildTeamLogoMap(teamRows);
  const teamMeta = buildTeamMetaMap(teamRows);
  const sleeper = buildSleeperMaps(sleeperPlayers, sleeperProj, indexSleeperProjList(sleeperProjList), scoringKey);

  const normalized = roster.rows
    .map((row) => normalizePlayer(row, roster.season))
    .filter(Boolean);

  let ffcHits = 0;
  let blendedHits = 0;
  const players = filterDraftPool(normalized, { activeOnly }).map((p) => {
    const stats = (p.gsisId && statsMap.get(p.gsisId)) || null;
    const sleeperHit = (p.gsisId && sleeper.byGsis.get(p.gsisId))
      || (p.espnId && sleeper.byEspn.get(p.espnId))
      || sleeper.byKey.get(matchKey(p.name, p.team, p.position))
      || sleeper.byKey.get(matchKey(p.name, '', p.position))
      || null;
    const ffcHit = lookupFfc(ffcAdp, p.name, p.team, p.position);
    if (ffcHit) ffcHits += 1;
    const fantasyPoints2025 = stats?.fantasyPoints ?? null;
    const projectedPoints2026 = sleeperHit?.projectedPoints2026 ?? null;
    const delta = (projectedPoints2026 != null && fantasyPoints2025 != null)
      ? Math.round((projectedPoints2026 - fantasyPoints2025) * 10) / 10
      : null;

    const market = marketAdpFields(ffcHit, sleeperHit);
    if (market.adpFfc != null && market.adpSleeper != null) blendedHits += 1;
    const espnHit = lookupEspn(espnRanks, {
      espnId: sleeperHit?.espnId || p.espnId,
      name: p.name,
      team: p.team,
      position: p.position
    });

    const sources = ['nflverse'];
    if (stats) sources.push('nflverse-stats');
    if (sleeperHit) sources.push('sleeper');
    if (ffcHit) sources.push('ffc');
    if (espnHit) sources.push('espn');

    return {
      ...p,
      byeWeek: (p.team && byeMap.get(canonTeam(p.team) || p.team)) || ffcHit?.byeWeek || null,
      teamLogo: espnLogoUrl(p.team) || (p.team && (logoMap.get(canonTeam(p.team) || p.team) || logoMap.get(p.team))) || null,
      fantasyPoints2025,
      projectedPoints2026,
      avgPpg: stats?.avgPpg ?? null,
      games: stats?.games ?? null,
      adp: market.adp,
      adpFfc: market.adpFfc,
      adpSleeper: market.adpSleeper,
      adpSource: market.adpSource,
      adpStdev: market.adpStdev,
      adpSample: market.adpSample,
      espnRank: espnHit?.rank ?? null,
      delta,
      injuryStatus: sleeperHit?.injuryStatus || null,
      injuryBodyPart: sleeperHit?.injuryBodyPart || null,
      injuryNotes: sleeperHit?.injuryNotes || null,
      practiceStatus: sleeperHit?.practiceStatus || null,
      practiceDescription: sleeperHit?.practiceDescription || null,
      stats: stats ? {
        passYds: stats.passYds,
        passTd: stats.passTd,
        passInt: stats.passInt,
        rushYds: stats.rushYds,
        rushTd: stats.rushTd,
        targets: stats.targets,
        receptions: stats.receptions,
        recYds: stats.recYds,
        recTd: stats.recTd,
        fgMade: stats.fgMade,
        fgAtt: stats.fgAtt,
        xpMade: stats.xpMade
      } : null,
      projStats: sleeperHit ? {
        passYds: sleeperHit.projPassYds,
        passTd: sleeperHit.projPassTd,
        passInt: sleeperHit.projPassInt,
        rushYds: sleeperHit.projRushYds,
        rushTd: sleeperHit.projRushTd,
        receptions: sleeperHit.projRec,
        recYds: sleeperHit.projRecYds,
        recTd: sleeperHit.projRecTd
      } : null,
      sleeperId: sleeperHit?.sleeperId || null,
      headshot: p.headshot || sleeperHit?.headshot || null,
      sources,
      overallRank: null,
      posRank: null
    };
  });

  const defenses = buildDefenseUnits({
    sleeper,
    ffcAdp,
    espnRanks,
    byeMap,
    teamMeta,
    season: roster.season
  });
  for (const d of defenses) {
    if (d.adp != null) ffcHits += 1;
    players.push(d);
  }

  rankDraftPool(players);

  const counts = {
    total: players.length,
    ffcAdpMatched: ffcHits,
    adpBlended: blendedHits,
    espnRankMatched: espnRanks.count || 0
  };
  for (const p of players) counts[p.position] = (counts[p.position] || 0) + 1;

  const sourceParts = ['gridiron-composite', 'nflverse', 'sleeper'];
  if (ffcHits > 0) sourceParts.push('ffc-adp');
  if (espnRanks.count > 0) sourceParts.push('espn');
  const meta = {
    source: sourceParts.join('+'),
    season: roster.season,
    statsSeason: priorSeason,
    projectionSeason: year,
    scoring: scoringKey,
    scoringLabel: scoringLabel(scoringKey),
    adpTeams: teamKey,
    rankModel: 'gridiron-composite',
    rankSources: ['ffc', 'sleeperAdp', 'espn', 'vorp', 'prior'],
    adpSource: 'market',
    ffcDrafts: ffcAdp.meta?.total_drafts || null,
    ffcWindow: ffcAdp.meta?.start_date && ffcAdp.meta?.end_date
      ? { start: ffcAdp.meta.start_date, end: ffcAdp.meta.end_date }
      : null,
    cacheMs: liveCacheMs,
    counts
  };

  const entry = {
    key,
    at: Date.now(),
    players,
    meta
  };
  poolCaches.set(key, entry);
  return cachedPoolPayload(entry);
  })();

  poolInflight.set(key, build);
  try {
    return await build;
  } finally {
    poolInflight.delete(key);
  }
}

function defaultTeamNames(count) {
  return Array.from({ length: count }, (_, i) => `Team ${i + 1}`);
}

function defaultDraft(settings = {}) {
  const teams = Math.min(32, Math.max(2, Number(settings.teams) || 24));
  const rounds = Math.min(25, Math.max(1, Number(settings.rounds) || 15));
  const teamNames = Array.isArray(settings.teamNames) && settings.teamNames.length === teams
    ? settings.teamNames.map((n, i) => String(n || `Team ${i + 1}`).trim() || `Team ${i + 1}`)
    : defaultTeamNames(teams);
  return {
    id: 'beta-main',
    status: 'live',
    season: Number(settings.season) || new Date().getFullYear(),
    settings: {
      teams,
      rounds,
      order: settings.order === 'linear' ? 'linear' : 'snake',
      teamNames
    },
    picks: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function readDraft() {
  ensureDataDir();
  if (!fs.existsSync(DRAFT_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(DRAFT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeDraft(draft) {
  ensureDataDir();
  const tmp = `${DRAFT_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(draft, null, 2));
  fs.renameSync(tmp, DRAFT_FILE);
  return draft;
}

function getOrCreateDraft() {
  return readDraft() || writeDraft(defaultDraft());
}

function resetDraft(settings = {}) {
  return writeDraft(defaultDraft(settings));
}

function pickSlot(draft, overallIndex) {
  const { teams, rounds, order } = draft.settings;
  const round = Math.floor(overallIndex / teams) + 1;
  if (round > rounds) return null;
  const indexInRound = overallIndex % teams;
  const snake = order === 'snake' && round % 2 === 0;
  const teamIndex = snake ? teams - 1 - indexInRound : indexInRound;
  return {
    overall: overallIndex + 1,
    round,
    pick: indexInRound + 1,
    teamIndex
  };
}

function currentPick(draft) {
  return pickSlot(draft, draft.picks.length);
}

function draftedIds(draft) {
  return new Set((draft.picks || []).map((p) => p.playerId));
}

async function getDraftBoard() {
  const draft = getOrCreateDraft();
  const pool = await loadDraftPool({ season: draft.season });
  const taken = draftedIds(draft);
  const available = pool.players.filter((p) => !taken.has(p.id));
  const next = currentPick(draft);
  const complete = !next;
  if (complete && draft.status !== 'complete') {
    draft.status = 'complete';
    draft.updatedAt = new Date().toISOString();
    writeDraft(draft);
  }
  return {
    ok: true,
    draft: {
      ...draft,
      status: complete ? 'complete' : draft.status,
      nextPick: next
        ? {
            ...next,
            teamName: draft.settings.teamNames[next.teamIndex]
          }
        : null,
      picksRemaining: complete
        ? 0
        : draft.settings.teams * draft.settings.rounds - draft.picks.length
    },
    pool: {
      source: pool.source,
      season: pool.season,
      statsSeason: pool.statsSeason,
      projectionSeason: pool.projectionSeason,
      counts: {
        total: available.length,
        byPosition: available.reduce((acc, p) => {
          acc[p.position] = (acc[p.position] || 0) + 1;
          return acc;
        }, {})
      }
    },
    available
  };
}

async function makePick(playerId, actor = null) {
  const draft = getOrCreateDraft();
  const slot = currentPick(draft);
  if (!slot) {
    throw Object.assign(new Error('Draft is complete'), { status: 400 });
  }
  const pool = await loadDraftPool({ season: draft.season });
  const player = pool.players.find((p) => p.id === playerId);
  if (!player) {
    throw Object.assign(new Error('Player not in draft pool'), { status: 404 });
  }
  if (draftedIds(draft).has(player.id)) {
    throw Object.assign(new Error('Player already drafted'), { status: 400 });
  }

  const pick = {
    ...slot,
    teamName: draft.settings.teamNames[slot.teamIndex],
    playerId: player.id,
    playerName: player.name,
    position: player.position,
    nflTeam: player.team,
    headshot: player.headshot,
    teamLogo: player.teamLogo,
    byeWeek: player.byeWeek,
    fantasyPoints2025: player.fantasyPoints2025,
    projectedPoints2026: player.projectedPoints2026,
    pickedAt: new Date().toISOString(),
    pickedBy: actor?.loginName || actor?.name || null
  };
  draft.picks.push(pick);
  draft.status = currentPick(draft) ? 'live' : 'complete';
  draft.updatedAt = new Date().toISOString();
  writeDraft(draft);
  return getDraftBoard();
}

function undoPick(actor = null) {
  const draft = getOrCreateDraft();
  if (!draft.picks.length) {
    throw Object.assign(new Error('No picks to undo'), { status: 400 });
  }
  const removed = draft.picks.pop();
  draft.status = 'live';
  draft.updatedAt = new Date().toISOString();
  draft.lastUndo = {
    pick: removed,
    at: new Date().toISOString(),
    by: actor?.loginName || actor?.name || null
  };
  writeDraft(draft);
  return getDraftBoard();
}

const playerNewsCache = new Map(); // espnId -> { at, items }
const PLAYER_NEWS_TTL_MS = 15 * 60 * 1000;

async function getPlayerNews({ espnId, sleeperId, name, limit = 6 } = {}) {
  const id = String(espnId || '').trim();
  const max = Math.min(12, Math.max(1, Number(limit) || 6));
  if (!id) {
    return { ok: true, espnId: null, items: [], note: 'No ESPN id for this player' };
  }
  const cached = playerNewsCache.get(id);
  if (cached && Date.now() - cached.at < PLAYER_NEWS_TTL_MS) {
    return { ok: true, espnId: id, items: cached.items.slice(0, max), cached: true };
  }

  let espnResilient;
  try {
    espnResilient = require('./espn-resilient');
  } catch {
    espnResilient = null;
  }

  const pathPart = `apis/site/v2/sports/football/nfl/athletes/${encodeURIComponent(id)}/news?limit=${max}`;
  let raw = null;
  if (espnResilient?.fetchJsonResilient && espnResilient?.siteApiUrls) {
    const hit = await espnResilient.fetchJsonResilient({
      urls: espnResilient.siteApiUrls(pathPart),
      cacheKey: `player-news:${id}`,
      ttlMs: PLAYER_NEWS_TTL_MS,
      lane: 'news'
    });
    raw = hit?.data || null;
  } else {
    const res = await fetch(`https://site.api.espn.com/${pathPart}`, {
      headers: { Accept: 'application/json', 'User-Agent': UA }
    });
    if (res.ok) raw = await res.json();
  }

  const articles = Array.isArray(raw?.articles) ? raw.articles : [];
  const items = articles.slice(0, max).map((a) => ({
    id: a.id != null ? String(a.id) : null,
    headline: String(a.headline || a.description || '').trim() || 'Update',
    description: String(a.description || a.headline || '').trim() || null,
    published: a.published || a.lastModified || null,
    url: a.links?.web?.href || a.links?.mobile?.href || null
  })).filter((a) => a.headline);

  playerNewsCache.set(id, { at: Date.now(), items });
  return {
    ok: true,
    espnId: id,
    sleeperId: sleeperId || null,
    name: name || null,
    items
  };
}

module.exports = {
  loadDraftPool,
  getPlayerNews,
  getDraftBoard,
  resetDraft,
  makePick,
  undoPick,
  normalizeScoring,
  scoringLabel,
  scoringFromSettings,
  FANTASY_POSITIONS
};
