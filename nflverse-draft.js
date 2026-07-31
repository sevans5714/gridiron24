/**
 * Beta / lounge draft pool — current NFL fantasy players with:
 * roster + headshot (nflverse), prior-season fantasy + box stats (nflverse),
 * projections + ADP (Sleeper), bye week (schedule), team logos (nflverse teams),
 * overall / position ranks.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DRAFT_FILE = path.join(DATA_DIR, 'beta-draft.json');
const FANTASY_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K']);
const EXCLUDE_STATUS = new Set(['INA', 'RET', 'CUT', 'NWT', 'EXE']);
const POOL_CACHE_MS = 6 * 60 * 60 * 1000;
const UA = 'GridIron24-DraftPool/2.0';

const ROSTER_URL = (season) =>
  `https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_${season}.csv`;
const STATS_URL = (season) =>
  `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_reg_${season}.csv`;
const SCHEDULE_URL = 'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv';
const TEAMS_URL = 'https://github.com/nflverse/nflverse-data/releases/download/teams/teams_colors_logos.csv';
const SLEEPER_PLAYERS_URL = 'https://api.sleeper.app/v1/players/nfl';
const SLEEPER_PROJ_URL = (season) => `https://api.sleeper.app/v1/projections/nfl/regular/${season}`;
const SLEEPER_HEADSHOT = (id) => `https://sleepercdn.com/content/nfl/players/thumb/${id}.jpg`;

let poolCache = { key: '', at: 0, players: null, meta: null };

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
    .replace(/[^a-z0-9]/g, '');
}

function matchKey(name, team, position) {
  return `${normName(name)}|${String(team || '').toUpperCase()}|${String(position || '').toUpperCase()}`;
}

function toNum(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function normalizePlayer(row, season) {
  const position = String(row.position || '').trim().toUpperCase();
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
    team: String(row.team || '').trim().toUpperCase() || null,
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
    const abbr = String(row.team_abbr || '').trim().toUpperCase();
    if (!abbr) continue;
    const logo = String(row.team_logo_espn || row.team_logo_squared || '').trim();
    if (logo) map.set(abbr, logo);
  }
  return map;
}

function buildStats2025Map(statRows) {
  const map = new Map();
  for (const row of statRows) {
    const id = String(row.player_id || '').trim();
    if (!id) continue;
    const ppr = toNum(row.fantasy_points_ppr);
    const std = toNum(row.fantasy_points);
    const pts = ppr != null ? ppr : std;
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

function buildSleeperMaps(sleeperPlayers, projections) {
  const byGsis = new Map();
  const byKey = new Map();
  for (const [sleeperId, row] of Object.entries(sleeperPlayers || {})) {
    if (!row || typeof row !== 'object') continue;
    const pos = String(row.position || '').toUpperCase();
    if (!FANTASY_POSITIONS.has(pos)) continue;
    const team = String(row.team || row.team_abbr || '').toUpperCase() || null;
    const name = String(row.full_name || `${row.first_name || ''} ${row.last_name || ''}`).trim();
    if (!name) continue;
    const projRow = projections?.[sleeperId] || null;
    const projected = toNum(projRow?.pts_ppr ?? projRow?.pts_half_ppr ?? projRow?.pts_std);
    const payload = {
      sleeperId: String(sleeperId),
      projectedPoints2026: projected != null ? Math.round(projected * 10) / 10 : null,
      adp: cleanAdp(projRow?.adp_ppr ?? projRow?.adp_half_ppr ?? projRow?.adp_std),
      projPassYds: toNum(projRow?.pass_yd),
      projPassTd: toNum(projRow?.pass_td),
      projPassInt: toNum(projRow?.pass_int),
      projRushYds: toNum(projRow?.rush_yd),
      projRushTd: toNum(projRow?.rush_td),
      projRec: toNum(projRow?.rec),
      projRecYds: toNum(projRow?.rec_yd),
      projRecTd: toNum(projRow?.rec_td),
      headshot: SLEEPER_HEADSHOT(sleeperId),
      team,
      position: pos,
      name,
      injuryStatus: String(row.injury_status || '').trim() || null,
      injuryBodyPart: String(row.injury_body_part || '').trim() || null,
      injuryNotes: String(row.injury_notes || '').trim() || null,
      practiceStatus: String(row.practice_participation || '').trim() || null,
      practiceDescription: String(row.practice_description || '').trim() || null
    };
    const gsis = String(row.gsis_id || '').trim();
    if (gsis) byGsis.set(gsis, payload);
    byKey.set(matchKey(name, team, pos), payload);
    byKey.set(matchKey(name, '', pos), payload);
  }
  return { byGsis, byKey };
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

async function loadDraftPool({ season, activeOnly = true, force = false } = {}) {
  const year = Number(season) || new Date().getFullYear();
  const priorSeason = year - 1;
  const key = `${year}:${activeOnly ? 'active' : 'all'}:enriched-v4`;
  if (!force && poolCache.players && poolCache.key === key && Date.now() - poolCache.at < POOL_CACHE_MS) {
    return {
      ok: true,
      source: poolCache.meta.source,
      season: poolCache.meta.season,
      statsSeason: poolCache.meta.statsSeason,
      projectionSeason: poolCache.meta.projectionSeason,
      fetchedAt: new Date(poolCache.at).toISOString(),
      cacheMs: POOL_CACHE_MS,
      counts: poolCache.meta.counts,
      players: poolCache.players
    };
  }

  const roster = await loadRoster(year);

  const [statsCsv, scheduleCsv, teamsCsv, sleeperPlayers, sleeperProj] = await Promise.all([
    fetchText(STATS_URL(priorSeason)).catch(() => ''),
    fetchText(SCHEDULE_URL).catch(() => ''),
    fetchText(TEAMS_URL).catch(() => ''),
    fetchJson(SLEEPER_PLAYERS_URL).catch(() => ({})),
    fetchJson(SLEEPER_PROJ_URL(year)).catch(() => ({}))
  ]);

  const statsMap = buildStats2025Map(statsCsv ? parseCsv(statsCsv) : []);
  const byeMap = buildByeMap(scheduleCsv ? parseCsv(scheduleCsv) : [], year);
  const logoMap = buildTeamLogoMap(teamsCsv ? parseCsv(teamsCsv) : []);
  const sleeper = buildSleeperMaps(sleeperPlayers, sleeperProj);

  const normalized = roster.rows
    .map((row) => normalizePlayer(row, roster.season))
    .filter(Boolean);

  const players = filterDraftPool(normalized, { activeOnly }).map((p) => {
    const stats = (p.gsisId && statsMap.get(p.gsisId)) || null;
    const sleeperHit = (p.gsisId && sleeper.byGsis.get(p.gsisId))
      || sleeper.byKey.get(matchKey(p.name, p.team, p.position))
      || sleeper.byKey.get(matchKey(p.name, '', p.position))
      || null;
    const fantasyPoints2025 = stats?.fantasyPoints ?? null;
    const projectedPoints2026 = sleeperHit?.projectedPoints2026 ?? null;
    const delta = (projectedPoints2026 != null && fantasyPoints2025 != null)
      ? Math.round((projectedPoints2026 - fantasyPoints2025) * 10) / 10
      : null;

    return {
      ...p,
      byeWeek: (p.team && byeMap.get(p.team)) || null,
      teamLogo: (p.team && logoMap.get(p.team)) || null,
      fantasyPoints2025,
      projectedPoints2026,
      avgPpg: stats?.avgPpg ?? null,
      games: stats?.games ?? null,
      adp: sleeperHit?.adp ?? null,
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
      overallRank: null,
      posRank: null
    };
  }).sort((a, b) => {
    const pa = a.projectedPoints2026 != null ? a.projectedPoints2026 : -1;
    const pb = b.projectedPoints2026 != null ? b.projectedPoints2026 : -1;
    if (pb !== pa) return pb - pa;
    const aa = a.adp != null ? a.adp : 9999;
    const ab = b.adp != null ? b.adp : 9999;
    if (aa !== ab) return aa - ab;
    const fa = a.fantasyPoints2025 != null ? a.fantasyPoints2025 : -1;
    const fb = b.fantasyPoints2025 != null ? b.fantasyPoints2025 : -1;
    if (fb !== fa) return fb - fa;
    const pos = a.position.localeCompare(b.position);
    if (pos) return pos;
    return a.name.localeCompare(b.name);
  });

  const posCounts = {};
  players.forEach((p, i) => {
    p.overallRank = i + 1;
    const pos = p.position || '?';
    posCounts[pos] = (posCounts[pos] || 0) + 1;
    p.posRank = posCounts[pos];
  });

  const counts = { total: players.length };
  for (const p of players) counts[p.position] = (counts[p.position] || 0) + 1;

  const meta = {
    source: 'nflverse+sleeper',
    season: roster.season,
    statsSeason: priorSeason,
    projectionSeason: year,
    counts
  };

  poolCache = {
    key,
    at: Date.now(),
    players,
    meta
  };

  return {
    ok: true,
    source: meta.source,
    season: meta.season,
    statsSeason: meta.statsSeason,
    projectionSeason: meta.projectionSeason,
    fetchedAt: new Date().toISOString(),
    cacheMs: POOL_CACHE_MS,
    counts,
    players
  };
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
  FANTASY_POSITIONS
};
