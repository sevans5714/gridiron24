/**
 * Beta platform draft — player pool from nflverse season rosters.
 * Independent of ESPN Fantasy (main HQ stays on ESPN).
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DRAFT_FILE = path.join(DATA_DIR, 'beta-draft.json');
const FANTASY_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K']);
const EXCLUDE_STATUS = new Set(['INA', 'RET', 'CUT', 'NWT', 'EXE']);
const POOL_CACHE_MS = 6 * 60 * 60 * 1000;

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

function rosterUrl(season) {
  return `https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_${season}.csv`;
}

async function fetchRosterCsv(season) {
  const url = rosterUrl(season);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'GridIron24-BetaDraft/1.0', Accept: 'text/csv' },
    redirect: 'follow'
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Could not load nflverse roster ${season} (${res.status})`), {
      status: 502
    });
  }
  return res.text();
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
    season: Number(season)
  };
}

function filterDraftPool(players, { activeOnly = true } = {}) {
  return players.filter((p) => {
    if (!FANTASY_POSITIONS.has(p.position)) return false;
    if (activeOnly && EXCLUDE_STATUS.has(p.status)) return false;
    return true;
  });
}

async function loadDraftPool({ season, activeOnly = true, force = false } = {}) {
  const year = Number(season) || new Date().getFullYear();
  const key = `${year}:${activeOnly ? 'active' : 'all'}`;
  if (!force && poolCache.players && poolCache.key === key && Date.now() - poolCache.at < POOL_CACHE_MS) {
    return {
      ok: true,
      source: 'nflverse-rosters',
      season: year,
      fetchedAt: new Date(poolCache.at).toISOString(),
      cacheMs: POOL_CACHE_MS,
      counts: poolCache.meta.counts,
      players: poolCache.players
    };
  }

  let csv;
  let usedSeason = year;
  try {
    csv = await fetchRosterCsv(year);
  } catch (err) {
    if (year !== year - 1) {
      usedSeason = year - 1;
      csv = await fetchRosterCsv(usedSeason);
    } else {
      throw err;
    }
  }

  const rows = parseCsv(csv);
  const normalized = rows
    .map((row) => normalizePlayer(row, usedSeason))
    .filter(Boolean);
  const players = filterDraftPool(normalized, { activeOnly })
    .sort((a, b) => {
      const pos = a.position.localeCompare(b.position);
      if (pos) return pos;
      return a.name.localeCompare(b.name);
    });

  const counts = { total: players.length };
  for (const p of players) counts[p.position] = (counts[p.position] || 0) + 1;

  poolCache = {
    key: `${usedSeason}:${activeOnly ? 'active' : 'all'}`,
    at: Date.now(),
    players,
    meta: { counts }
  };

  return {
    ok: true,
    source: 'nflverse-rosters',
    season: usedSeason,
    requestedSeason: year,
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

module.exports = {
  loadDraftPool,
  getDraftBoard,
  resetDraft,
  makePick,
  undoPick,
  FANTASY_POSITIONS
};
