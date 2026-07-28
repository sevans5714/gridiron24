const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// Load local .env if present (no dependency). Render uses dashboard env vars.
(() => {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] == null) process.env[key] = val;
    }
  } catch {
    /* ignore */
  }
})();

const config = require('./league-runtime');
const staticConfig = require('./config');
const users = require('./users-store');
const board = require('./board-store');
const logos = require('./logos-store');
const invites = require('./invites-store');
const weeklyWrap = require('./weekly-wrap');
const calendar = require('./calendar-store');
const powerRankings = require('./power-rankings-store');
const rulesSyncStore = require('./rules-sync-store');
const leagues = require('./leagues-store');
const { compareSettings } = require('./rules-diff');
const nflverseLive = require('./nflverse-live');
const nflverseDraft = require('./nflverse-draft');
const {
  sendPasswordResetEmail,
  sendInviteEmail,
  sendAccountApprovedEmail,
  sendWeeklyWrapEmail,
  sendRulesSyncAlert,
  buildWeeklyWrapEmail,
  mailConfig
} = require('./mail');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_MS = 30_000;
const cache = new Map();
const ESPN_NEWS_CACHE_MS = 5 * 60_000;
let espnNewsCache = { at: 0, items: [] };

async function fetchEspnNflNews(limit = 10) {
  if (Date.now() - espnNewsCache.at < ESPN_NEWS_CACHE_MS && espnNewsCache.items.length) {
    return espnNewsCache.items;
  }
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=${limit}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'GridIron24/1.0' }
    });
    if (!res.ok) throw new Error(`ESPN news ${res.status}`);
    const data = await res.json();
    const items = (data.articles || [])
      .map((a) => ({
        id: `espn-${a.id || a.published || Math.random()}`,
        source: 'espn',
        label: 'ESPN',
        text: String(a.headline || a.description || '').trim(),
        href: a.links?.web?.href || a.link || null
      }))
      .filter((a) => a.text);
    espnNewsCache = { at: Date.now(), items };
    return items;
  } catch (err) {
    console.error('ESPN news fetch failed:', err.message || err);
    return espnNewsCache.items || [];
  }
}

const SESSION_COOKIE = 'gi24_session';
const SESSION_DAYS = 30;
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, '');

function sessionSecret() {
  return process.env.SESSION_SECRET || 'gridiron24-dev-secret';
}

const PUBLIC_PATHS = new Set([
  '/',
  '/index.html',
  '/login.html',
  '/enter',
  '/enter.html',
  '/register.html',
  '/register',
  '/register-league',
  '/register-league.html',
  '/forgot.html',
  '/forgot',
  '/reset.html',
  '/reset',
  '/setup',
  '/setup.html',
  '/api/health',
  '/api/login',
  '/api/register',
  '/api/setup',
  '/api/invites/peek',
  '/api/forgot-password',
  '/api/reset-password',
  '/api/logout',
  '/api/auth',
  '/api/league',
  '/api/league-registration',
  '/api/league-registration/draft',
  '/api/league-registration/asset',
  '/api/league-registration/espn-peek',
  '/api/cron/weekly-wrap',
  '/api/cron/rules-sync'
]);

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders
  });
  res.end(body);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function signSession(userId, expiresAt) {
  const payload = `u.${userId}.${expiresAt}`;
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'u') return null;
  const userId = parts[1];
  const expiresAt = Number(parts[2]);
  if (!userId || !Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;
  const expected = signSession(userId, expiresAt);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  const user = users.findById(userId);
  return user ? users.publicUser(user) : null;
}

function getSessionUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  const user = verifySession(cookies[SESSION_COOKIE]);
  if (user && user.approved === false) return null;
  return user;
}

function isAuthenticated(req) {
  return Boolean(getSessionUser(req));
}

function clearSessionCookieHeader() {
  const secure = process.env.NODE_ENV === 'production' || process.env.RENDER ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function sessionCookieHeader(token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  const secure = process.env.NODE_ENV === 'production' || process.env.RENDER ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function requestOrigin(req) {
  if (APP_BASE_URL) return APP_BASE_URL;
  const host = req.headers.host || `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${host}`;
}

function readJsonBody(req, { maxBytes = 1_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function isPublicPath(pathname) {
  if (PUBLIC_PATHS.has(pathname)) return true;
  if (pathname.startsWith('/assets/')) return true;
  if (pathname.startsWith('/css/')) return true;
  if (pathname.startsWith('/js/')) return true;
  if (pathname.startsWith('/uploads/')) return true;
  return false;
}

function requireAuth(req, res, pathname) {
  if (isPublicPath(pathname) || isAuthenticated(req)) return true;
  if (pathname.startsWith('/api/')) {
    sendJson(res, 401, { ok: false, error: 'Authentication required' });
    return false;
  }
  const next = encodeURIComponent(pathname === '/' ? '/home.html' : pathname);
  res.writeHead(302, { Location: `/enter?next=${next}` });
  res.end();
  return false;
}

function requireStaff(req, res) {
  const user = getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { ok: false, error: 'Authentication required' });
    return null;
  }
  if (!users.isStaff(user)) {
    sendJson(res, 403, { ok: false, error: 'Commissioner or conference admin access required' });
    return null;
  }
  return user;
}

function requireCommissioner(req, res) {
  const user = getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { ok: false, error: 'Authentication required' });
    return null;
  }
  if (!users.isCommissioner(user)) {
    sendJson(res, 403, { ok: false, error: 'Commissioner access required' });
    return null;
  }
  return user;
}

function canAccessCommissionerPage(user) {
  return users.isStaff(user);
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.ttf': 'font/ttf',
      '.otf': 'font/otf',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2'
    }[ext] || 'application/octet-stream';

    const fileName = path.basename(filePath);
    const isAuthPage = ['login.html', 'register.html', 'forgot.html', 'reset.html', 'setup.html'].includes(fileName);
    const isFont = ['.ttf', '.otf', '.woff', '.woff2'].includes(ext);
    const cacheControl = isAuthPage
      ? 'no-store, no-cache, must-revalidate'
      : ext === '.html'
        ? 'no-cache'
        : (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp' || ext === '.css' || ext === '.js' || isFont)
          ? 'public, max-age=300'
          : 'public, max-age=3600';

    const headers = {
      'Content-Type': contentType,
      'Cache-Control': cacheControl
    };
    if (isAuthPage) headers.Pragma = 'no-cache';

    res.writeHead(200, headers);
    res.end(data);
  });
}

function ownerName(member) {
  if (!member) return 'Owner pending';
  const first = (member.firstName || '').trim();
  const last = (member.lastName || '').trim();
  const full = `${first} ${last}`.trim();
  return full || member.displayName || 'Owner';
}

function normalizeLeague(raw, conference) {
  const membersById = new Map((raw.members || []).map((m) => [m.id, m]));
  const logoOverrides = logos.getOverrideMap();
  const nameOverrides = logos.getNameOverrideMap();
  const teams = (raw.teams || []).map((team) => {
    const ownerId = team.primaryOwner || (team.owners || [])[0];
    const record = team.record?.overall || {};

    const wins = record.wins || 0;
    const losses = record.losses || 0;
    const ties = record.ties || 0;
    const gamesPlayed = wins + losses + ties;
    const pointsFor = Number(record.pointsFor || team.points || 0);
    const streakType = record.streakType || 'NONE';
    const streakLength = Number(record.streakLength || 0);
    const key = logos.logoKey(conference.key, team.id);
    const overrideLogo = logoOverrides.get(key);
    const espnName = (team.name || `${team.location || ''} ${team.nickname || ''}`).trim() || `Team ${team.id}`;
    const overrideName = nameOverrides.get(key);

    return {
      id: team.id,
      name: overrideName || espnName,
      espnName,
      abbreviation: team.abbrev || '',
      logo: logos.displayLogoUrl(overrideLogo),
      logoSource: overrideLogo ? 'gridiron' : 'placeholder',
      espnLogo: team.logo || null,
      owner: ownerName(membersById.get(ownerId)),
      wins,
      losses,
      ties,
      gamesPlayed,
      pointsFor,
      pointsAgainst: Number(record.pointsAgainst || 0),
      pointsPerGame: gamesPlayed > 0 ? pointsFor / gamesPlayed : 0,
      streakType,
      streakLength,
      playoffSeed: Number(team.playoffSeed || 0),
      waiverRank: Number(team.waiverRank || 0)
    };
  });

  teams.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (a.losses !== b.losses) return a.losses - b.losses;
    if (b.ties !== a.ties) return b.ties - a.ties;
    // Playoff tiebreaker: points for
    return b.pointsFor - a.pointsFor;
  });

  return {
    key: conference.key,
    name: conference.name,
    shortName: conference.shortName,
    leagueId: conference.espnLeagueId,
    logo: conference.logo || null,
    espnLeagueName: raw.settings?.name || `ESPN League ${conference.espnLeagueId}`,
    season: raw.seasonId || config.season,
    teamCount: teams.length,
    teamsJoined: raw.status?.teamsJoined ?? teams.length,
    currentMatchupPeriod: raw.status?.currentMatchupPeriod ?? null,
    finalScoringPeriod: raw.status?.finalScoringPeriod ?? null,
    isViewable: raw.status?.isViewable ?? raw.settings?.isPublic ?? null,
    teams
  };
}

async function fetchEspnRaw(conference, views, cacheSuffix = '', query = {}) {
  const queryKey = Object.keys(query || {})
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join('&');
  const cacheKey = `${config.season}:${conference.espnLeagueId}:${cacheSuffix || views.join(',')}${queryKey ? `:${queryKey}` : ''}`;
  const existing = cache.get(cacheKey);
  if (existing && Date.now() - existing.at < CACHE_MS) return existing.data;

  const endpoint = new URL(
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${config.season}/segments/0/leagues/${conference.espnLeagueId}`
  );
  for (const view of views) endpoint.searchParams.append('view', view);
  for (const [key, value] of Object.entries(query || {})) {
    if (value != null && value !== '') endpoint.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(endpoint, {
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'User-Agent': 'GridIron24/0.1 (+local proof-of-concept)'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text();
      const err = new Error(`ESPN returned ${response.status}`);
      err.status = response.status;
      err.detail = text.slice(0, 300);
      throw err;
    }

    const raw = await response.json();
    cache.set(cacheKey, { at: Date.now(), data: raw });
    return raw;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchEspnLeague(conference) {
  const raw = await fetchEspnRaw(conference, ['mTeam', 'mSettings', 'mStatus'], 'league');
  return normalizeLeague(raw, conference);
}

function playerName(player) {
  if (!player) return 'Unknown player';
  return player.fullName
    || `${player.firstName || ''} ${player.lastName || ''}`.trim()
    || `Player ${player.id || ''}`;
}

function normalizeRosterTeam(team, conference, membersById) {
  const ownerId = team.primaryOwner || (team.owners || [])[0];
  const key = logos.logoKey(conference.key, team.id);
  const overrideLogo = logos.getOverrideMap().get(key);
  const nameOverrides = logos.getNameOverrideMap();
  const espnName = (team.name || `${team.location || ''} ${team.nickname || ''}`).trim() || `Team ${team.id}`;
  const entries = (team.roster?.entries || []).map((entry) => {
    const pool = entry.playerPoolEntry || {};
    const player = pool.player || {};
    const slotId = Number(entry.lineupSlotId);
    return {
      id: player.id || entry.playerId || null,
      name: playerName(player),
      position: POSITION_LABELS[player.defaultPositionId] || '—',
      slotId,
      slot: SLOT_LABELS[slotId] || `Slot ${slotId}`,
      proTeamId: player.proTeamId || null,
      injuryStatus: player.injuryStatus || null,
      acquisitionType: entry.acquisitionType || pool.acquisitionType || null
    };
  }).sort((a, b) => {
    const order = { QB: 1, RB: 2, WR: 3, TE: 4, FLEX: 5, 'D/ST': 6, K: 7, Bench: 8, IR: 9 };
    return (order[a.slot] || 50) - (order[b.slot] || 50) || a.name.localeCompare(b.name);
  });

  const record = team.record?.overall || {};
  return {
    id: team.id,
    name: nameOverrides.get(key) || espnName,
    espnName,
    abbreviation: team.abbrev || '',
    logo: logos.displayLogoUrl(overrideLogo),
    owner: ownerName(membersById.get(ownerId)),
    wins: record.wins || 0,
    losses: record.losses || 0,
    ties: record.ties || 0,
    pointsFor: Number(record.pointsFor || team.points || 0),
    playoffSeed: Number(team.playoffSeed || 0),
    waiverRank: Number(team.waiverRank || 0),
    roster: entries
  };
}

async function loadTeamDetail(conferenceKey, teamId) {
  const conference = config.conferences.find((c) => c.key === conferenceKey);
  if (!conference) throw Object.assign(new Error('Unknown conference'), { status: 404 });
  const raw = await fetchEspnRaw(conference, ['mTeam', 'mRoster', 'mStatus'], `roster:${teamId}`);
  const membersById = new Map((raw.members || []).map((m) => [m.id, m]));
  const team = (raw.teams || []).find((t) => Number(t.id) === Number(teamId));
  if (!team) throw Object.assign(new Error('Team not found'), { status: 404 });
  const detail = normalizeRosterTeam(team, conference, membersById);
  const scheduleRaw = await fetchEspnRaw(conference, ['mTeam', 'mMatchup', 'mStatus'], 'matchup');
  const currentWeek = Number(scheduleRaw.status?.currentMatchupPeriod || 1);
  const schedule = normalizeSchedule(scheduleRaw, conference, currentWeek);
  const recent = [];
  for (let w = Math.max(1, currentWeek - 2); w <= currentWeek; w += 1) {
    const weekSched = w === currentWeek ? schedule : normalizeSchedule(scheduleRaw, conference, w);
    for (const m of weekSched.matchups || []) {
      if (Number(m.home?.id) === Number(teamId) || Number(m.away?.id) === Number(teamId)) {
        recent.push({ week: w, ...m });
      }
    }
  }
  return {
    ok: true,
    conference: {
      key: conference.key,
      name: conference.name,
      shortName: conference.shortName,
      logo: conference.logo
    },
    team: detail,
    recentMatchups: recent,
    currentMatchupPeriod: currentWeek,
    generatedAt: new Date().toISOString()
  };
}

function normalizeTransactions(raw, conference) {
  const teams = teamMapFromRaw(raw, conference.key);
  const list = (raw.transactions || [])
    .slice()
    .sort((a, b) => Number(b.processDate || b.proposedDate || 0) - Number(a.processDate || a.proposedDate || 0))
    .slice(0, 40)
    .map((tx) => {
      const items = (tx.items || []).map((item) => ({
        type: item.type || null,
        playerId: item.playerId || null,
        playerName: item.playerName || item.player?.fullName || null,
        fromTeamId: item.fromTeamId ?? null,
        toTeamId: item.toTeamId ?? null,
        fromTeam: item.fromTeamId != null ? teams.get(item.fromTeamId)?.name || null : null,
        toTeam: item.toTeamId != null ? teams.get(item.toTeamId)?.name || null : null
      }));
      const teamIds = new Set();
      for (const it of items) {
        if (it.fromTeamId != null) teamIds.add(it.fromTeamId);
        if (it.toTeamId != null) teamIds.add(it.toTeamId);
      }
      if (tx.teamId != null) teamIds.add(tx.teamId);
      const when = Number(tx.processDate || tx.proposedDate || 0);
      return {
        id: tx.id || `${tx.type}-${when}`,
        type: tx.type || 'UNKNOWN',
        typeLabel: TX_TYPE_LABELS[tx.type] || tx.type || 'Transaction',
        status: tx.status || null,
        when: when ? new Date(when).toISOString() : null,
        teams: [...teamIds].map((id) => teams.get(id)?.name || `Team ${id}`),
        items
      };
    });

  return {
    key: conference.key,
    name: conference.name,
    shortName: conference.shortName,
    logo: conference.logo,
    transactions: list
  };
}

async function loadTransactionsPayload() {
  const conferences = await Promise.all(
    config.conferences.map(async (conference) => {
      try {
        const raw = await fetchEspnRaw(conference, ['mTeam', 'mTransactions2'], 'transactions');
        return { ok: true, ...normalizeTransactions(raw, conference) };
      } catch (error) {
        return {
          ok: false,
          key: conference.key,
          name: conference.name,
          shortName: conference.shortName,
          logo: conference.logo,
          error: error.message || 'Unavailable',
          transactions: []
        };
      }
    })
  );
  return {
    season: config.season,
    generatedAt: new Date().toISOString(),
    conferences
  };
}

function seedLabel(seed) {
  const n = Number(seed || 0);
  return n > 0 ? `#${n}` : null;
}

function pickMatchupForSeeds(matchups, seedA, seedB, teamsById) {
  const list = matchups || [];
  for (const m of list) {
    const hs = Number(teamsById.get(m.home?.id)?.playoffSeed || 0);
    const as = Number(teamsById.get(m.away?.id)?.playoffSeed || 0);
    if ((hs === seedA && as === seedB) || (hs === seedB && as === seedA)) return m;
  }
  return null;
}

async function buildPlayoffsPayload() {
  const standings = await loadStandingsPayload();
  const weeks = {};
  for (const w of [14, 15, 16]) {
    weeks[w] = await loadSchedulePayload(w);
  }
  const bowl = await buildBowlPayload();

  const conferences = config.conferences.map((conf) => {
    const stand = (standings.conferences || []).find((c) => c.key === conf.key);
    const teams = stand?.ok ? stand.teams || [] : [];
    const byId = new Map(teams.map((t) => [t.id, t]));
    const bySeed = new Map();
    for (const t of teams) {
      if (Number(t.playoffSeed) > 0) bySeed.set(Number(t.playoffSeed), t);
    }
    // Fallback: top 6 standings as provisional seeds before ESPN sets playoffSeed
    if (bySeed.size < 6) {
      teams.slice(0, 6).forEach((t, i) => {
        if (!bySeed.has(i + 1)) bySeed.set(i + 1, { ...t, playoffSeed: i + 1, provisional: true });
      });
    }

    const w14 = (weeks[14].conferences || []).find((c) => c.key === conf.key);
    const w15 = (weeks[15].conferences || []).find((c) => c.key === conf.key);
    const w16 = (weeks[16].conferences || []).find((c) => c.key === conf.key);

    const slot = (seedNum) => {
      const t = bySeed.get(seedNum);
      if (!t) return { seed: seedNum, name: `#${seedNum} Seed`, logo: null, id: null, provisional: true };
      return {
        seed: seedNum,
        id: t.id,
        name: t.name,
        logo: t.logo || null,
        provisional: Boolean(t.provisional) || Number(t.playoffSeed || 0) === 0
      };
    };

    const formatGame = (m, fallbackLabel) => {
      if (!m) {
        return {
          label: fallbackLabel,
          status: 'upcoming',
          home: null,
          away: null,
          winner: 'UNDECIDED'
        };
      }
      const decided = m.winner === 'HOME' || m.winner === 'AWAY';
      return {
        label: fallbackLabel,
        status: decided ? 'final' : (Number(m.home?.score || 0) + Number(m.away?.score || 0) > 0 ? 'live' : 'upcoming'),
        winner: m.winner || 'UNDECIDED',
        home: m.home,
        away: m.away,
        playoffTierType: m.playoffTierType || null
      };
    };

    const playable14 = (w14?.matchups || []).filter((m) => m.home && m.away);
    const game45 = pickMatchupForSeeds(playable14, 4, 5, byId) || playable14[0] || null;
    const game36 = pickMatchupForSeeds(playable14, 3, 6, byId) || playable14[1] || playable14[0] || null;

    const playable15 = (w15?.matchups || []).filter((m) => m.home && m.away);
    const winners15 = playable15.filter(isWinnersBracketMatchup);
    const semis = (winners15.length ? winners15 : playable15).slice(0, 2);

    const playable16 = (w16?.matchups || []).filter((m) => m.home && m.away);
    const title16 = playable16.find(isWinnersBracketMatchup) || playable16[0] || null;
    const third16 = playable16.find(isConsolationMatchup)
      || playable16.find((m) => m.id !== title16?.id)
      || null;

    return {
      key: conf.key,
      name: conf.name,
      shortName: conf.shortName,
      logo: conf.logo,
      ok: Boolean(stand?.ok),
      seeds: [1, 2, 3, 4, 5, 6].map(slot),
      rounds: {
        wildCard: {
          week: 14,
          bye1: slot(1),
          bye2: slot(2),
          game45: formatGame(game45, '#4 vs #5'),
          game36: formatGame(game36, '#3 vs #6')
        },
        semifinals: {
          week: 15,
          games: [
            formatGame(semis[0], 'Semifinal 1'),
            formatGame(semis[1], 'Semifinal 2')
          ]
        },
        finals: {
          week: 16,
          title: formatGame(title16, 'Conference Title'),
          third: formatGame(third16, 'Third Place')
        }
      }
    };
  });

  return {
    season: config.season,
    generatedAt: new Date().toISOString(),
    conferences,
    bowl
  };
}

const SCORING_LABELS = {
  0: 'Pass attempt',
  1: 'Pass completion',
  2: 'Pass incompletion',
  3: 'Passing yards',
  4: 'Passing TD',
  5: 'Every 5 passing yards',
  6: 'Every 10 passing yards',
  7: 'Every 20 passing yards',
  8: 'Every 25 passing yards',
  9: 'Every 50 passing yards',
  10: 'Every 100 passing yards',
  15: '40+ yard TD pass bonus',
  16: '50+ yard TD pass bonus',
  17: '300–399 yard passing game',
  18: '400+ yard passing game',
  19: '2-pt passing conversion',
  20: 'Interception thrown',
  23: 'Rushing attempts',
  24: 'Rushing yards',
  25: 'Rushing TD',
  26: '2-pt rushing conversion',
  27: 'Every 5 rushing yards',
  28: 'Every 10 rushing yards',
  35: '40+ yard TD rush bonus',
  36: '50+ yard TD rush bonus',
  37: '100–199 yard rushing game',
  38: '200+ yard rushing game',
  41: 'Receptions (alt)',
  42: 'Receiving yards',
  43: 'Receiving TD',
  44: '2-pt receiving conversion',
  45: '40+ yard TD reception bonus',
  46: '50+ yard TD reception bonus',
  47: 'Every 5 receiving yards',
  48: 'Every 10 receiving yards',
  53: 'Reception',
  56: '100–199 yard receiving game',
  57: '200+ yard receiving game',
  63: 'Fumble recovered for TD',
  72: 'Fumble lost',
  74: 'FG made (50+ yards)',
  76: 'FG missed (50+ yards)',
  77: 'FG made (40–49 yards)',
  79: 'FG missed (40–49 yards)',
  80: 'FG made (0–39 yards)',
  82: 'FG missed (0–39 yards)',
  83: 'Total FG made',
  85: 'FG missed',
  86: 'PAT made',
  88: 'PAT missed',
  89: '0 points allowed',
  90: '1–6 points allowed',
  91: '7–13 points allowed',
  92: '14–17 points allowed',
  93: 'Blocked punt/FG return TD',
  95: 'Interception',
  96: 'Fumble recovery',
  97: 'Blocked kick',
  98: 'Safety',
  99: 'Sack',
  100: 'Half sack',
  101: 'Kickoff return TD',
  102: 'Punt return TD',
  103: 'Interception return TD',
  104: 'Fumble return TD',
  106: 'Forced fumble',
  114: 'Kickoff return yards',
  115: 'Punt return yards',
  121: '18–21 points allowed',
  122: '22–27 points allowed',
  123: '28–34 points allowed',
  124: '35–45 points allowed',
  125: '46+ points allowed',
  128: 'Less than 100 yards allowed',
  129: '100–199 yards allowed',
  130: '200–299 yards allowed',
  131: '300–349 yards allowed',
  132: '350–399 yards allowed',
  133: '400–449 yards allowed',
  134: '450–499 yards allowed',
  135: '500–549 yards allowed',
  136: '550+ yards allowed',
  198: 'FG made (50–59 yards)',
  200: 'FG missed (50–59 yards)',
  201: 'FG made (60+ yards)',
  203: 'FG missed (60+ yards)',
  204: 'Offensive 2-pt return',
  205: 'Defensive 2-pt return',
  206: '2-pt return',
  209: '1-pt safety'
};

const SLOT_LABELS = {
  0: 'QB',
  2: 'RB',
  4: 'WR',
  6: 'TE',
  16: 'D/ST',
  17: 'K',
  20: 'Bench',
  21: 'IR',
  23: 'FLEX'
};

const POSITION_LABELS = {
  1: 'QB',
  2: 'RB',
  3: 'WR',
  4: 'TE',
  5: 'K',
  16: 'D/ST'
};

const TX_TYPE_LABELS = {
  FREEAGENT: 'Free agent',
  WAIVER: 'Waiver',
  TRADE: 'Trade',
  DROP: 'Drop',
  DRAFT: 'Draft'
};

// Per-yard continuous stats (ESPN stores points-per-yard in the settings field).
const PER_YARD_STAT_IDS = new Set([3, 24, 42, 114, 115]);

const SCORING_GROUPS = [
  { key: 'passing', label: 'Passing', ids: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 16, 17, 18, 19, 20] },
  { key: 'rushing', label: 'Rushing', ids: [23, 24, 25, 26, 27, 28, 35, 36, 37, 38] },
  { key: 'receiving', label: 'Receiving', ids: [41, 42, 43, 44, 45, 46, 47, 48, 53, 56, 57] },
  { key: 'misc-off', label: 'Misc. Offense', ids: [63, 72, 204, 206] },
  { key: 'kicking', label: 'Kicking', ids: [74, 76, 77, 79, 80, 82, 83, 85, 86, 88, 198, 200, 201, 203] },
  { key: 'defense', label: 'Defense / Special Teams', ids: [89, 90, 91, 92, 93, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 106, 114, 115, 121, 122, 123, 124, 125, 128, 129, 130, 131, 132, 133, 134, 135, 136, 205, 209] }
];

function effectiveScoringPoints(item) {
  const base = Number(item.points);
  const overrides = item.pointsOverrides || {};
  // Prefer the base points value whenever ESPN sets one (including negatives).
  // D/ST (slot 16) and K (slot 17) often leave base at 0 and put the real value in overrides.
  // Some leagues also put RB/WR/TE values in positional overrides (1–4, 15) with base 0.
  if (Number.isFinite(base) && base !== 0) return base;
  if (overrides['16'] != null && overrides['16'] !== '') {
    const n = Number(overrides['16']);
    if (Number.isFinite(n)) return n;
  }
  if (overrides['17'] != null && overrides['17'] !== '') {
    const n = Number(overrides['17']);
    if (Number.isFinite(n)) return n;
  }
  const values = Object.values(overrides).map(Number).filter((n) => Number.isFinite(n) && n !== 0);
  if (values.length) return values[0];
  return Number.isFinite(base) ? base : 0;
}

function formatPointsNumber(points) {
  const p = Number(points);
  if (!Number.isFinite(p)) return '—';
  if (Number.isInteger(p)) return String(p);
  return String(p)
    .replace(/(\.\d*?[1-9])0+$/, '$1')
    .replace(/\.0+$/, '');
}

function formatScoringDisplay(statId, points) {
  const p = Number(points);
  if (!Number.isFinite(p)) return '—';
  if (PER_YARD_STAT_IDS.has(statId) && p !== 0) {
    return `${formatPointsNumber(p)}/yd`;
  }
  return formatPointsNumber(p);
}

function refreshScoringDisplays(items = []) {
  return (items || []).map((item) => ({
    ...item,
    display: formatScoringDisplay(item.statId, item.points)
  }));
}

function scoringGroupFor(statId) {
  const group = SCORING_GROUPS.find((g) => g.ids.includes(statId));
  return group ? group.label : 'Other';
}

function normalizeSettings(raw, conference) {
  const scoring = raw.settings?.scoringSettings || {};
  const roster = raw.settings?.rosterSettings || {};
  const schedule = raw.settings?.scheduleSettings || {};
  const items = (scoring.scoringItems || [])
    .map((item) => {
      const points = effectiveScoringPoints(item);
      return {
        statId: item.statId,
        label: SCORING_LABELS[item.statId] || `Stat ${item.statId}`,
        points,
        display: formatScoringDisplay(item.statId, points),
        group: scoringGroupFor(item.statId)
      };
    })
    .filter((item) => Number(item.points) !== 0)
    .sort((a, b) => a.statId - b.statId);

  const slots = Object.entries(roster.lineupSlotCounts || {})
    .map(([id, count]) => ({ id: Number(id), label: SLOT_LABELS[id] || `Slot ${id}`, count: Number(count) }))
    .filter((s) => s.count > 0 && SLOT_LABELS[s.id])
    .sort((a, b) => a.id - b.id);

  const status = raw.status || {};
  const matchupPeriodCount = schedule.matchupPeriodCount ?? null;
  const finalScoringPeriod = status.finalScoringPeriod ?? null;
  const firstPlayoffWeek = matchupPeriodCount != null ? Number(matchupPeriodCount) + 1 : null;
  const playoffWeekCount =
    matchupPeriodCount != null && finalScoringPeriod != null
      ? Math.max(0, Number(finalScoringPeriod) - Number(matchupPeriodCount))
      : null;

  return {
    key: conference.key,
    name: conference.name,
    shortName: conference.shortName,
    leagueId: conference.espnLeagueId,
    logo: conference.logo || null,
    scoringType: scoring.scoringType || null,
    playerRankType: scoring.playerRankType || null,
    scoringItems: items,
    lineup: slots,
    playoffTeamCount: schedule.playoffTeamCount ?? null,
    playoffReseed: schedule.playoffReseed ?? null,
    matchupPeriodCount,
    playoffMatchupPeriodLength: schedule.playoffMatchupPeriodLength ?? null,
    playoffSeedingRule: schedule.playoffSeedingRule ?? null,
    finalScoringPeriod,
    firstPlayoffWeek,
    playoffWeekCount,
    currentMatchupPeriod: status.currentMatchupPeriod ?? null
  };
}

function teamMapFromRaw(raw, conferenceKey) {
  const membersById = new Map((raw.members || []).map((m) => [m.id, m]));
  const logoOverrides = logos.getOverrideMap();
  const nameOverrides = logos.getNameOverrideMap();
  const map = new Map();
  for (const team of raw.teams || []) {
    const ownerId = team.primaryOwner || (team.owners || [])[0];
    const key = conferenceKey ? logos.logoKey(conferenceKey, team.id) : null;
    const overrideLogo = key ? logoOverrides.get(key) : null;
    const espnName = (team.name || `${team.location || ''} ${team.nickname || ''}`).trim() || `Team ${team.id}`;
    const overrideName = key ? nameOverrides.get(key) : null;
    map.set(team.id, {
      id: team.id,
      name: overrideName || espnName,
      logo: logos.displayLogoUrl(overrideLogo),
      logoSource: overrideLogo ? 'gridiron' : 'placeholder',
      owner: ownerName(membersById.get(ownerId)),
      record: team.record?.overall || {}
    });
  }
  return map;
}

function normalizeSchedule(raw, conference, week) {
  const teams = teamMapFromRaw(raw, conference.key);
  const matchups = (raw.schedule || [])
    .filter((m) => Number(m.matchupPeriodId) === Number(week))
    .map((m) => {
      const home = teams.get(m.home?.teamId) || {
        id: m.home?.teamId,
        name: `Team ${m.home?.teamId}`,
        logo: logos.PLACEHOLDER_LOGO,
        logoSource: 'placeholder'
      };
      const away = teams.get(m.away?.teamId) || {
        id: m.away?.teamId,
        name: `Team ${m.away?.teamId}`,
        logo: logos.PLACEHOLDER_LOGO,
        logoSource: 'placeholder'
      };
      return {
        id: m.id,
        matchupPeriodId: m.matchupPeriodId,
        winner: m.winner || 'UNDECIDED',
        playoffTierType: m.playoffTierType || null,
        home: {
          ...home,
          score: Number(m.home?.totalPoints ?? 0),
          projected: Number(m.home?.totalProjectedPointsLive ?? m.home?.totalProjectedPoints ?? 0)
        },
        away: {
          ...away,
          score: Number(m.away?.totalPoints ?? 0),
          projected: Number(m.away?.totalProjectedPointsLive ?? m.away?.totalProjectedPoints ?? 0)
        }
      };
    });

  return {
    key: conference.key,
    name: conference.name,
    shortName: conference.shortName,
    leagueId: conference.espnLeagueId,
    logo: conference.logo || null,
    week: Number(week),
    currentMatchupPeriod: raw.status?.currentMatchupPeriod ?? null,
    matchups
  };
}

const BENCH_OR_IR_SLOTS = new Set([20, 21]);

function weekStatTotal(entry, week, sourceId) {
  const stats = entry?.playerPoolEntry?.player?.stats || [];
  const hit = stats.find((s) => (
    Number(s.scoringPeriodId) === Number(week)
    && Number(s.statSourceId) === Number(sourceId)
    && (s.statSplitTypeId == null || Number(s.statSplitTypeId) === 1)
  ));
  return hit?.appliedTotal != null ? Number(hit.appliedTotal) : null;
}

function playerWeekPoints(entry, week) {
  const pool = entry?.playerPoolEntry || {};
  if (pool.appliedStatTotal != null && Number.isFinite(Number(pool.appliedStatTotal))) {
    return Number(pool.appliedStatTotal);
  }
  const actual = weekStatTotal(entry, week, 0);
  if (actual != null) return actual;
  return 0;
}

function playerWeekProjected(entry, week) {
  const projected = weekStatTotal(entry, week, 1);
  return projected != null ? projected : 0;
}

function matchupSideEntries(side) {
  return side?.rosterForCurrentScoringPeriod?.entries
    || side?.rosterForMatchupPeriod?.entries
    || side?.rosterForMatchupPeriodDelayed?.entries
    || [];
}

function extractConferenceLeaders(raw, conference, week) {
  const teams = teamMapFromRaw(raw, conference.key);
  const players = [];
  const teamScores = [];

  for (const match of (raw.schedule || []).filter((m) => Number(m.matchupPeriodId) === Number(week))) {
    for (const sideKey of ['home', 'away']) {
      const side = match[sideKey];
      if (!side) continue;
      const team = teams.get(side.teamId) || {
        id: side.teamId,
        name: `Team ${side.teamId}`,
        logo: logos.PLACEHOLDER_LOGO
      };
      const score = Number(side.totalPoints ?? 0);
      const projected = Number(side.totalProjectedPointsLive ?? side.totalProjectedPoints ?? 0);
      teamScores.push({
        kind: 'team',
        conferenceKey: conference.key,
        conference: conference.shortName,
        teamId: team.id,
        teamName: team.name,
        teamLogo: team.logo,
        points: score,
        projected,
        live: score > 0 || projected > 0
      });

      for (const entry of matchupSideEntries(side)) {
        const slotId = Number(entry.lineupSlotId);
        if (BENCH_OR_IR_SLOTS.has(slotId)) continue;
        const pool = entry.playerPoolEntry || {};
        const player = pool.player || {};
        const points = playerWeekPoints(entry, week);
        const projectedPts = playerWeekProjected(entry, week);
        if (!(points > 0 || projectedPts > 0)) continue;
        players.push({
          kind: 'player',
          id: player.id || entry.playerId || null,
          name: playerName(player),
          position: POSITION_LABELS[player.defaultPositionId] || SLOT_LABELS[slotId] || '—',
          slot: SLOT_LABELS[slotId] || `Slot ${slotId}`,
          points,
          projected: projectedPts,
          conferenceKey: conference.key,
          conference: conference.shortName,
          teamId: team.id,
          teamName: team.name,
          teamLogo: team.logo
        });
      }
    }
  }

  players.sort((a, b) => b.points - a.points || b.projected - a.projected || a.name.localeCompare(b.name));
  teamScores.sort((a, b) => b.points - a.points || b.projected - a.projected || a.teamName.localeCompare(b.teamName));

  return {
    players,
    teams: teamScores,
    currentMatchupPeriod: raw.status?.currentMatchupPeriod ?? null,
    latestScoringPeriod: raw.status?.latestScoringPeriod ?? null
  };
}

async function apiFantasyLeaders(res, weekParam) {
  const results = await Promise.all(
    config.conferences.map(async (conference) => {
      try {
        const base = await fetchEspnRaw(conference, ['mTeam', 'mMatchup', 'mStatus'], 'matchup');
        const week = Number(weekParam || base.status?.currentMatchupPeriod || 1);
        const raw = await fetchEspnRaw(
          conference,
          ['mTeam', 'mMatchup', 'mScoreboard', 'mStatus'],
          `leaders:${week}`,
          { scoringPeriodId: week }
        );
        return { ok: true, key: conference.key, week, ...extractConferenceLeaders(raw, conference, week) };
      } catch (error) {
        return {
          ok: false,
          key: conference.key,
          name: conference.name,
          error: error.name === 'AbortError' ? 'ESPN request timed out' : error.message,
          players: [],
          teams: []
        };
      }
    })
  );

  const week = results.find((r) => r.ok)?.week || Number(weekParam || 1);
  const players = results.flatMap((r) => r.players || [])
    .sort((a, b) => b.points - a.points || b.projected - a.projected || a.name.localeCompare(b.name))
    .slice(0, 20);
  const teams = results.flatMap((r) => r.teams || [])
    .sort((a, b) => b.points - a.points || b.projected - a.projected || a.teamName.localeCompare(b.teamName))
    .slice(0, 12);
  const hasLivePoints = players.some((p) => p.points > 0) || teams.some((t) => t.points > 0);

  sendJson(res, 200, {
    ok: true,
    season: config.season,
    week,
    hasLivePoints,
    generatedAt: new Date().toISOString(),
    players,
    teams,
    conferences: results.map((r) => ({
      ok: r.ok,
      key: r.key || r.players?.[0]?.conferenceKey,
      error: r.error || null,
      playerCount: (r.players || []).length,
      teamCount: (r.teams || []).length
    }))
  });
}

async function loadConferenceSettings() {
  return Promise.all(
    config.conferences.map(async (conference) => {
      try {
        const raw = await fetchEspnRaw(conference, ['mSettings', 'mStatus'], 'settings');
        return { ok: true, ...normalizeSettings(raw, conference) };
      } catch (error) {
        return {
          ok: false,
          key: conference.key,
          name: conference.name,
          error: error.name === 'AbortError' ? 'ESPN request timed out' : error.message
        };
      }
    })
  );
}

async function runRulesSyncJob({
  triggeredBy = 'system',
  notify = true,
  notifyOnMatch = false
} = {}) {
  const conferences = await loadConferenceSettings();
  const detail = conferences.find((c) => c.key === 'detail') || null;
  const overtime = conferences.find((c) => c.key === 'overtime') || null;
  const cmp = compareSettings(detail, overtime);
  const store = rulesSyncStore.saveCheck({
    matched: cmp.matched,
    bothOk: cmp.bothOk,
    diffs: cmp.diffs,
    detail,
    triggeredBy,
    season: config.season
  });

  const result = {
    ok: true,
    matched: cmp.matched,
    bothOk: cmp.bothOk,
    diffCount: cmp.diffs.length,
    diffs: cmp.diffs,
    officialUpdated: Boolean(cmp.matched && store.officialScoring),
    lastCheck: store.lastCheck,
    officialScoring: store.officialScoring,
    generatedAt: new Date().toISOString()
  };

  const shouldMail = notify && ((cmp.bothOk && !cmp.matched) || (notifyOnMatch && cmp.matched));
  if (shouldMail) {
    const recipients = users.listUsers()
      .filter((u) => u.role === 'commissioner' && u.email)
      .map((u) => u.email);
    const fallback = process.env.COMMISSIONER_EMAIL;
    const toList = recipients.length ? recipients : (fallback ? [fallback] : []);
    result.notifications = [];
    for (const to of toList) {
      try {
        const sent = await sendRulesSyncAlert({
          to,
          matched: cmp.matched,
          diffs: cmp.diffs,
          checkedAt: store.lastCheck?.checkedAt,
          baseUrl: process.env.APP_BASE_URL
        });
        result.notifications.push({ to, ...sent });
      } catch (err) {
        console.error('[rules-sync] notify failed', to, err);
        result.notifications.push({ to, sent: false, error: err.message });
      }
    }
  }

  console.log(`[rules-sync] matched=${cmp.matched} diffs=${cmp.diffs.length} by=${triggeredBy}`);
  return result;
}

async function apiSettings(res) {
  const results = await loadConferenceSettings();
  const sync = rulesSyncStore.getStatus();

  sendJson(res, 200, {
    season: config.season,
    brand: config.brand,
    championship: config.championship || null,
    structure: config.structure || null,
    generatedAt: new Date().toISOString(),
    conferences: results,
    rulesSync: sync.lastCheck,
    officialScoring: sync.officialScoring
  });
}

async function apiOfficialScoring(res) {
  const sync = rulesSyncStore.getStatus();
  const live = await loadConferenceSettings();
  const primaryKey = (config.conferences || []).find((c) => c.isRulesPrimary)?.key
    || (config.conferences || [])[0]?.key
    || 'detail';
  const secondaryKey = (config.conferences || []).find((c) => c.key !== primaryKey)?.key
    || (config.conferences || [])[1]?.key
    || 'overtime';
  const detail = live.find((c) => c.key === primaryKey) || live[0] || null;
  const overtime = live.find((c) => c.key === secondaryKey) || live[1] || null;
  const cmp = compareSettings(detail, overtime);

  // Prefer persisted official snapshot when conferences are known synced.
  const official = sync.officialScoring;
  const useOfficial = Boolean(official && (cmp.matched || sync.lastCheck?.matched));

  sendJson(res, 200, {
    ok: true,
    season: config.season,
    generatedAt: new Date().toISOString(),
    source: useOfficial ? 'official' : 'live-detail',
    synced: cmp.matched,
    rulesSync: sync.lastCheck,
    officialScoring: official,
    scoring: useOfficial
      ? {
          ok: true,
          key: official.conferenceKey,
          name: official.conferenceName,
          shortName: official.shortName,
          playerRankType: official.playerRankType,
          scoringType: official.scoringType,
          scoringItems: refreshScoringDisplays(official.scoringItems),
          lineup: official.lineup
        }
      : detail
        ? { ...detail, scoringItems: refreshScoringDisplays(detail.scoringItems) }
        : detail,
    conferences: live,
    compare: {
      matched: cmp.matched,
      bothOk: cmp.bothOk,
      diffCount: cmp.diffs.length
    }
  });
}

async function apiSchedule(res, weekParam) {
  const results = await Promise.all(
    config.conferences.map(async (conference) => {
      try {
        const raw = await fetchEspnRaw(conference, ['mTeam', 'mMatchup', 'mStatus'], 'matchup');
        const week = Number(weekParam || raw.status?.currentMatchupPeriod || 1);
        return { ok: true, ...normalizeSchedule(raw, conference, week) };
      } catch (error) {
        return {
          ok: false,
          key: conference.key,
          name: conference.name,
          error: error.name === 'AbortError' ? 'ESPN request timed out' : error.message
        };
      }
    })
  );

  const week = results.find((r) => r.ok)?.week || Number(weekParam || 1);
  sendJson(res, 200, {
    season: config.season,
    week,
    generatedAt: new Date().toISOString(),
    conferences: results
  });
}

async function apiLeagues(res) {
  const results = await Promise.all(
    config.conferences.map(async (conference) => {
      try {
        const data = await fetchEspnLeague(conference);
        return { ok: true, ...data };
      } catch (error) {
        return {
          ok: false,
          key: conference.key,
          name: conference.name,
          shortName: conference.shortName,
          leagueId: conference.espnLeagueId,
          error: error.name === 'AbortError' ? 'ESPN request timed out' : error.message,
          detail: error.detail || null
        };
      }
    })
  );

  sendJson(res, 200, {
    brand: config.brand,
    season: config.season,
    generatedAt: new Date().toISOString(),
    conferences: results
  });
}

async function loadStandingsPayload() {
  const results = await Promise.all(
    config.conferences.map(async (conference) => {
      try {
        const data = await fetchEspnLeague(conference);
        return { ok: true, ...data };
      } catch (error) {
        return {
          ok: false,
          key: conference.key,
          name: conference.name,
          shortName: conference.shortName,
          leagueId: conference.espnLeagueId,
          error: error.name === 'AbortError' ? 'ESPN request timed out' : error.message
        };
      }
    })
  );
  return {
    brand: config.brand,
    season: config.season,
    generatedAt: new Date().toISOString(),
    conferences: results
  };
}

async function loadSchedulePayload(weekParam) {
  const results = await Promise.all(
    config.conferences.map(async (conference) => {
      try {
        const raw = await fetchEspnRaw(conference, ['mTeam', 'mMatchup', 'mStatus'], 'matchup');
        const week = Number(weekParam || raw.status?.currentMatchupPeriod || 1);
        return { ok: true, ...normalizeSchedule(raw, conference, week) };
      } catch (error) {
        return {
          ok: false,
          key: conference.key,
          name: conference.name,
          error: error.name === 'AbortError' ? 'ESPN request timed out' : error.message
        };
      }
    })
  );
  const week = results.find((r) => r.ok)?.week || Number(weekParam || 1);
  return {
    season: config.season,
    week,
    generatedAt: new Date().toISOString(),
    conferences: results
  };
}

function matchupWinnerTeam(m) {
  const w = String(m?.winner || '').toUpperCase();
  if (w === 'HOME') return m.home || null;
  if (w === 'AWAY') return m.away || null;
  return null;
}

function isWinnersBracketMatchup(m) {
  const tier = String(m?.playoffTierType || '').toUpperCase();
  return tier.includes('WINNER');
}

function isConsolationMatchup(m) {
  const tier = String(m?.playoffTierType || '').toUpperCase();
  return tier.includes('LOSER') || tier.includes('CONSOL');
}

function conferenceTitleWinner(conf) {
  if (!conf?.ok) return null;
  const matchups = conf.matchups || [];
  if (!matchups.length) return null;
  const winners = matchups.filter(isWinnersBracketMatchup);
  const pool = winners.length
    ? winners
    : matchups.filter((m) => !isConsolationMatchup(m));
  const list = pool.length ? pool : matchups;
  for (const m of list) {
    const winner = matchupWinnerTeam(m);
    if (winner) return { ...winner, sourceMatchupId: m.id, playoffTierType: m.playoffTierType || null };
  }
  return null;
}

function teamWeekEntry(conf, teamId) {
  if (!conf?.ok || teamId == null) return null;
  for (const m of conf.matchups || []) {
    if (Number(m.home?.id) === Number(teamId)) {
      return {
        ...m.home,
        side: 'home',
        opponentName: m.away?.name || null,
        matchupWinner: m.winner || 'UNDECIDED',
        matchupId: m.id
      };
    }
    if (Number(m.away?.id) === Number(teamId)) {
      return {
        ...m.away,
        side: 'away',
        opponentName: m.home?.name || null,
        matchupWinner: m.winner || 'UNDECIDED',
        matchupId: m.id
      };
    }
  }
  return null;
}

function bowlSideFromConference(titleConf, bowlConf, label) {
  const champion = conferenceTitleWinner(titleConf);
  const scoring = champion ? teamWeekEntry(bowlConf, champion.id) : null;
  const matchupCount = (bowlConf?.matchups || []).length;
  return {
    conferenceKey: titleConf?.key || bowlConf?.key || null,
    conferenceName: label,
    ok: Boolean(titleConf?.ok && bowlConf?.ok),
    champion: champion
      ? {
          id: champion.id,
          name: champion.name,
          logo: champion.logo || null
        }
      : null,
    score: scoring ? Number(scoring.score || 0) : null,
    projected: scoring ? Number(scoring.projected || 0) : null,
    hasWeek17Matchup: Boolean(scoring),
    week17MatchupCount: matchupCount,
    espnOpponent: scoring?.opponentName || null
  };
}

async function buildBowlPayload() {
  const champ = config.championship || {};
  const TITLE_WEEK = Number(champ.titleWeek) || 16;
  const BOWL_WEEK = Number(champ.bowlWeek) || 17;
  const bowlName = champ.name || 'Championship';
  const [titleWeek, bowlWeek] = await Promise.all([
    loadSchedulePayload(TITLE_WEEK),
    loadSchedulePayload(BOWL_WEEK)
  ]);

  const titleByKey = new Map((titleWeek.conferences || []).map((c) => [c.key, c]));
  const bowlByKey = new Map((bowlWeek.conferences || []).map((c) => [c.key, c]));
  const confs = config.conferences || [];
  const sides = confs.map((conf) =>
    bowlSideFromConference(
      titleByKey.get(conf.key),
      bowlByKey.get(conf.key),
      `${conf.shortName || conf.name} Champion`
    )
  );

  while (sides.length < 2) {
    sides.push({
      champion: null,
      score: null,
      hasWeek17Matchup: false,
      conferenceKey: null,
      conferenceName: null
    });
  }

  const left = sides[0];
  const right = sides[1];
  const champsReady = Boolean(left.champion && right.champion);
  const scoresReady = Boolean(left.hasWeek17Matchup && right.hasWeek17Matchup);
  let phase = 'waiting';
  let message = `Conference titles crown in Week ${TITLE_WEEK}. ${bowlName} scores pull from each champ’s ESPN Week ${BOWL_WEEK} lineup.`;

  if (champsReady && scoresReady) {
    const d = Number(left.score || 0);
    const o = Number(right.score || 0);
    if (d > 0 || o > 0) {
      phase = 'live';
      message = `Live ESPN Week ${BOWL_WEEK} scoring · ${confs[0]?.shortName || 'A'} champ vs ${confs[1]?.shortName || 'B'} champ`;
    } else {
      phase = 'ready';
      message = `Champions locked. Waiting on Week ${BOWL_WEEK} NFL kickoff for ESPN scores.`;
    }
  } else if (champsReady && !scoresReady) {
    phase = 'needs_week17';
    message = `Champions are set, but ESPN needs a Week ${BOWL_WEEK} matchup for each champ so lineups score.`;
  } else if ((bowlByKey.get(confs[0]?.key)?.matchups || []).length || (bowlByKey.get(confs[1]?.key)?.matchups || []).length) {
    phase = 'week17_open';
    message = `Week ${BOWL_WEEK} ESPN matchups exist. Bowl names fill in after Week ${TITLE_WEEK} conference title games.`;
  }

  let leader = null;
  if (champsReady && scoresReady) {
    const d = Number(left.score || 0);
    const o = Number(right.score || 0);
    if (d > o) leader = confs[0]?.key || 'left';
    else if (o > d) leader = confs[1]?.key || 'right';
    else if (d > 0 || o > 0) leader = 'tie';
  }

  const byKey = {};
  confs.forEach((c, i) => {
    byKey[c.key] = sides[i];
  });

  return {
    ok: true,
    season: config.season,
    titleWeek: TITLE_WEEK,
    bowlWeek: BOWL_WEEK,
    championship: {
      name: bowlName,
      logo: champ.logo || null
    },
    phase,
    message,
    leader,
    sides,
    // Legacy aliases for existing UI (Detail / Overtime keys or first two sides)
    detail: byKey.detail || left,
    overtime: byKey.overtime || right,
    generatedAt: new Date().toISOString()
  };
}

function authorizeCron(req) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  if (!secret) return false;
  const header = String(req.headers.authorization || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const alt = String(req.headers['x-cron-secret'] || '').trim();
  const provided = bearer || alt;
  if (!provided || provided.length !== secret.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
  } catch {
    return false;
  }
}

function wrapRecipients() {
  const mode = String(process.env.WRAP_EMAIL_MODE || 'all').trim().toLowerCase();
  const list = users.listUsers().filter((u) => u.email);
  if (mode === 'staff') {
    return list.filter((u) => u.role === 'commissioner' || u.role === 'conference_admin');
  }
  return list;
}

async function runWeeklyWrapJob({
  week: weekParam = null,
  force = false,
  sendEmail = true,
  postNews = true,
  dryRun = false,
  triggeredBy = 'system'
} = {}) {
  const currentSchedule = await loadSchedulePayload();
  const currentPeriod = currentSchedule.conferences.find((c) => c.ok)?.currentMatchupPeriod
    || currentSchedule.week;
  const week = weeklyWrap.resolveWrapWeek({
    requestedWeek: weekParam,
    currentMatchupPeriod: currentPeriod,
    scheduleConferences: currentSchedule.conferences
  });

  const existing = weeklyWrap.findExistingWrap(config.season, week);
  if (existing && !force && !dryRun) {
    return {
      ok: true,
      skipped: true,
      reason: `Week ${week} wrap already published`,
      week,
      season: config.season,
      existing
    };
  }

  const [standings, schedule] = await Promise.all([
    loadStandingsPayload(),
    week === currentSchedule.week ? Promise.resolve(currentSchedule) : loadSchedulePayload(week)
  ]);

  const stats = weeklyWrap.buildStatsPack({
    season: config.season,
    week,
    standings,
    schedule
  });

  if (!stats.ready && !force) {
    return {
      ok: false,
      error: `Week ${week} has no final scores yet`,
      week,
      season: config.season,
      stats
    };
  }

  const narrative = await weeklyWrap.generateNarrative(stats);
  const title = weeklyWrap.buildTitle(week, config.season);
  const body = String(narrative.body || '').slice(0, 8000);

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      week,
      season: config.season,
      title,
      body,
      provider: narrative.provider,
      aiConfigured: weeklyWrap.aiConfigured(),
      mail: mailConfig(),
      recipientCount: wrapRecipients().length,
      stats,
      emailPreview: buildWeeklyWrapEmail({
        week,
        season: config.season,
        title,
        body,
        stats,
        recipientName: 'Manager',
        baseUrl: process.env.APP_BASE_URL
      })
    };
  }

  let newsItem = null;
  if (postNews) {
    newsItem = board.addNews({
      title,
      body,
      author: {
        id: null,
        name: 'GridIron Wrap',
        loginName: 'gridiron-wrap'
      }
    });
  }

  const emailResults = [];
  if (sendEmail) {
    const recipients = wrapRecipients();
    for (const user of recipients) {
      try {
        const result = await sendWeeklyWrapEmail({
          to: user.email,
          week,
          season: config.season,
          title,
          body,
          stats,
          recipientName: user.name || user.loginName,
          baseUrl: process.env.APP_BASE_URL
        });
        emailResults.push({
          email: user.email,
          ok: true,
          sent: Boolean(result.sent),
          method: result.method
        });
      } catch (err) {
        emailResults.push({
          email: user.email,
          ok: false,
          error: err.message || 'Send failed'
        });
      }
    }
  }

  const record = {
    id: crypto.randomUUID(),
    season: config.season,
    week,
    title,
    newsId: newsItem?.id || null,
    provider: narrative.provider,
    emailed: emailResults.filter((r) => r.sent).length,
    emailAttempted: emailResults.length,
    triggeredBy,
    createdAt: new Date().toISOString()
  };
  weeklyWrap.saveWrapRecord(record);

  return {
    ok: true,
    week,
    season: config.season,
    title,
    body,
    provider: narrative.provider,
    newsItem,
    emailResults,
    record,
    mail: mailConfig(),
    aiConfigured: weeklyWrap.aiConfigured()
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = requestUrl.pathname;

    if (pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        app: config.brand.name,
        season: config.season,
        conferenceLeagueIds: config.conferences.map((c) => c.espnLeagueId),
        authConfigured: true
      });
    }

    if (pathname === '/api/cron/weekly-wrap' && (req.method === 'POST' || req.method === 'GET')) {
      if (!authorizeCron(req)) {
        return sendJson(res, 401, { ok: false, error: 'Invalid cron secret' });
      }
      const weekParam = requestUrl.searchParams.get('week');
      const force = requestUrl.searchParams.get('force') === '1';
      const dryRun = requestUrl.searchParams.get('dryRun') === '1';
      try {
        const result = await runWeeklyWrapJob({
          week: weekParam ? Number(weekParam) : null,
          force,
          dryRun,
          sendEmail: requestUrl.searchParams.get('email') !== '0',
          postNews: requestUrl.searchParams.get('news') !== '0',
          triggeredBy: 'cron'
        });
        return sendJson(res, result.ok || result.skipped ? 200 : 409, result);
      } catch (err) {
        console.error('[weekly-wrap] cron failed', err);
        return sendJson(res, 500, { ok: false, error: err.message || 'Weekly wrap failed' });
      }
    }

    if (pathname === '/api/cron/rules-sync' && (req.method === 'POST' || req.method === 'GET')) {
      if (!authorizeCron(req)) {
        return sendJson(res, 401, { ok: false, error: 'Invalid cron secret' });
      }
      try {
        const result = await runRulesSyncJob({
          triggeredBy: 'cron',
          notify: requestUrl.searchParams.get('notify') !== '0',
          notifyOnMatch: requestUrl.searchParams.get('notifyOnMatch') === '1'
        });
        return sendJson(res, 200, result);
      } catch (err) {
        console.error('[rules-sync] cron failed', err);
        return sendJson(res, 500, { ok: false, error: err.message || 'Rules sync check failed' });
      }
    }

    if (pathname === '/api/auth') {
      const user = getSessionUser(req);
      return sendJson(res, 200, {
        authenticated: Boolean(user),
        authConfigured: true,
        user
      });
    }

    if (pathname === '/api/setup' && req.method === 'POST') {
      return sendJson(res, 410, {
        ok: false,
        error: 'Site access passwords are retired. Accounts join by commissioner invite.'
      });
    }

    if (pathname === '/api/register' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      const inviteToken = String(body.inviteToken || '').trim();
      const existingUsers = users.listUsers();
      let inviteEmail = null;

      if (inviteToken) {
        const invite = invites.findByToken(inviteToken);
        if (!invite) {
          return sendJson(res, 400, { ok: false, error: 'Invite link is invalid or was revoked' });
        }
        inviteEmail = invite.email;
        if (body.email && String(body.email).trim().toLowerCase() !== inviteEmail) {
          return sendJson(res, 400, { ok: false, error: 'Use the email address this invite was sent to' });
        }
        body.email = body.email || inviteEmail;
      } else if (existingUsers.length > 0) {
        return sendJson(res, 403, {
          ok: false,
          error: 'Registration is by commissioner invite only. Ask for an invite link.'
        });
      }
      // Empty league: allow the first bootstrap account without an invite.
      if (body.password !== body.confirmPassword) {
        return sendJson(res, 400, { ok: false, error: 'Passwords do not match' });
      }
      try {
        const bootstrap = existingUsers.length === 0 && !inviteToken;
        const user = users.createUser({
          name: body.name,
          email: body.email,
          loginName: body.loginName,
          password: body.password,
          approved: bootstrap
        });
        if (inviteToken) {
          try { invites.acceptInvite(inviteToken, user.email); } catch { /* non-fatal */ }
        }
        // Pending members do not get a session until the commissioner approves them.
        if (!user.approved) {
          return sendJson(res, 201, {
            ok: true,
            pendingApproval: true,
            user,
            message: 'Account created. A commissioner must approve you before you can sign in.'
          });
        }
        const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
        const token = signSession(user.id, expiresAt);
        return sendJson(res, 201, { ok: true, user }, { 'Set-Cookie': sessionCookieHeader(token) });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not create account' });
      }
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      let user;
      try {
        user = users.authenticate(body.loginName, body.password);
      } catch (err) {
        if (err.code === 'pending_approval') {
          return sendJson(res, 403, {
            ok: false,
            pendingApproval: true,
            error: err.message || 'Your account is waiting for commissioner approval'
          });
        }
        return sendJson(res, err.status || 401, { ok: false, error: err.message || 'Incorrect login name or password' });
      }
      if (!user) {
        return sendJson(res, 401, { ok: false, error: 'Incorrect login name or password' });
      }
      const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
      const token = signSession(user.id, expiresAt);
      return sendJson(res, 200, { ok: true, user }, { 'Set-Cookie': sessionCookieHeader(token) });
    }

    if (pathname === '/api/forgot-password' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      const email = String(body.email || '').trim();
      const generic = {
        ok: true,
        message: 'If that email is on file, a reset link has been sent.'
      };
      if (!email) return sendJson(res, 200, generic);

      const created = users.createResetToken(email);
      if (!created) return sendJson(res, 200, generic);

      const resetUrl = `${requestOrigin(req)}/reset?token=${encodeURIComponent(created.token)}`;
      try {
        const mailResult = await sendPasswordResetEmail({
          to: created.user.email,
          name: created.user.name,
          resetUrl,
          baseUrl: requestOrigin(req)
        });
        const payload = { ...generic };
        if (!mailResult.sent && process.env.NODE_ENV !== 'production') {
          payload.devResetUrl = resetUrl;
        }
        return sendJson(res, 200, payload);
      } catch (err) {
        console.error(err);
        return sendJson(res, 500, { ok: false, error: 'Could not send reset email' });
      }
    }

    if (pathname === '/api/reset-password' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      if (body.password !== body.confirmPassword) {
        return sendJson(res, 400, { ok: false, error: 'Passwords do not match' });
      }
      try {
        const user = users.resetPasswordWithToken(body.token, body.password);
        const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
        const token = signSession(user.id, expiresAt);
        return sendJson(res, 200, { ok: true, user }, { 'Set-Cookie': sessionCookieHeader(token) });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not reset password' });
      }
    }

    if (pathname === '/api/change-password' && req.method === 'POST') {
      const sessionUser = getSessionUser(req);
      if (!sessionUser) {
        return sendJson(res, 401, { ok: false, error: 'Sign in required' });
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      if (body.password !== body.confirmPassword) {
        return sendJson(res, 400, { ok: false, error: 'Passwords do not match' });
      }
      try {
        const user = users.changePassword(sessionUser.id, body.currentPassword, body.password);
        return sendJson(res, 200, { ok: true, user });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not change password' });
      }
    }

    if (pathname === '/api/logout' && (req.method === 'POST' || req.method === 'GET')) {
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookieHeader() });
    }

    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(302, {
        Location: '/enter',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache'
      });
      return res.end();
    }

    if (pathname === '/login.html') {
      const next = requestUrl.searchParams.get('next');
      const dest = next ? `/enter?next=${encodeURIComponent(next)}` : '/enter';
      res.writeHead(302, {
        Location: dest,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache'
      });
      return res.end();
    }

    if (pathname === '/enter' || pathname === '/enter.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'login.html'));
    }
    if (pathname === '/register' || pathname === '/register.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'register.html'));
    }

    if (pathname === '/register-league' || pathname === '/register-league.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'register-league.html'));
    }

    if (pathname === '/api/league' && req.method === 'GET') {
      const active = leagues.getActiveLeague();
      return sendJson(res, 200, {
        ok: true,
        registrationOpen: leagues.registrationEnabled(),
        league: active ? leagues.publicLeague(active) : null,
        brand: config.brand,
        season: config.season,
        championship: config.championship || null,
        structure: config.structure || null,
        conferences: (config.conferences || []).map((c) => ({
          key: c.key,
          name: c.name,
          shortName: c.shortName,
          logo: c.logo,
          color: c.color || null,
          espnLeagueId: c.espnLeagueId
        }))
      });
    }

    if (pathname === '/api/league-registration' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        open: leagues.registrationEnabled(),
        steps: [
          { id: 'owner', title: 'League owner' },
          { id: 'brand', title: 'Brand' },
          { id: 'conferences', title: 'Conferences & ESPN' },
          { id: 'championship', title: 'Championship' },
          { id: 'money', title: 'Structure & payouts' },
          { id: 'calendar', title: 'Calendar' },
          { id: 'review', title: 'Review & launch' }
        ],
        assetTypes: [...leagues.ASSET_TYPES]
      });
    }

    if (pathname === '/api/league-registration/draft' && req.method === 'POST') {
      if (!leagues.registrationEnabled()) {
        return sendJson(res, 403, { ok: false, error: 'League registration is disabled' });
      }
      const draftId = crypto.randomUUID();
      fs.mkdirSync(path.join(leagues.UPLOAD_DIR, draftId), { recursive: true });
      return sendJson(res, 201, { ok: true, draftId });
    }

    if (pathname === '/api/league-registration/asset' && req.method === 'POST') {
      if (!leagues.registrationEnabled()) {
        return sendJson(res, 403, { ok: false, error: 'League registration is disabled' });
      }
      try {
        const body = await readJsonBody(req, { maxBytes: 3_500_000 });
        const draftId = String(body.draftId || '').trim();
        const assetType = String(body.assetType || '').trim();
        if (!draftId || !/^[a-f0-9-]{36}$/i.test(draftId)) {
          return sendJson(res, 400, { ok: false, error: 'Valid draftId required' });
        }
        if (!leagues.ASSET_TYPES.has(assetType)) {
          return sendJson(res, 400, { ok: false, error: 'Unknown asset type' });
        }
        const dataUrl = String(body.dataUrl || '');
        const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([a-zA-Z0-9+/=\s]+)$/);
        if (!match) {
          return sendJson(res, 400, { ok: false, error: 'Upload a PNG, JPG, WEBP, or SVG image' });
        }
        const url = leagues.saveAssetBuffer(
          draftId,
          assetType,
          Buffer.from(match[2].replace(/\s+/g, ''), 'base64'),
          match[1]
        );
        return sendJson(res, 200, { ok: true, assetType, url });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Upload failed' });
      }
    }

    if (pathname === '/api/league-registration/espn-peek' && req.method === 'POST') {
      if (!leagues.registrationEnabled()) {
        return sendJson(res, 403, { ok: false, error: 'League registration is disabled' });
      }
      try {
        const body = await readJsonBody(req);
        const espnLeagueId = Number(body.espnLeagueId);
        const season = Number(body.season) || config.season || staticConfig.season;
        if (!Number.isFinite(espnLeagueId) || espnLeagueId <= 0) {
          return sendJson(res, 400, { ok: false, error: 'Valid ESPN league ID required' });
        }
        const url =
          `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${espnLeagueId}` +
          `?view=mSettings`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12_000);
        let resEspn;
        try {
          resEspn = await fetch(url, {
            headers: { Accept: 'application/json' },
            signal: controller.signal
          });
        } finally {
          clearTimeout(timer);
        }
        if (!resEspn.ok) {
          return sendJson(res, 400, {
            ok: false,
            error: `ESPN returned ${resEspn.status}. Confirm the league ID is public and the season is correct.`
          });
        }
        const raw = await resEspn.json();
        const teamCount = Array.isArray(raw.teams) ? raw.teams.length : null;
        return sendJson(res, 200, {
          ok: true,
          espnLeagueId,
          season,
          name: raw.settings?.name || raw.settings?.naming?.name || `ESPN League ${espnLeagueId}`,
          size: raw.settings?.size || teamCount,
          isPublic: true
        });
      } catch (err) {
        return sendJson(res, 400, {
          ok: false,
          error: err.name === 'AbortError' ? 'ESPN request timed out' : (err.message || 'Could not reach ESPN')
        });
      }
    }

    if (pathname === '/api/league-registration' && req.method === 'POST') {
      if (!leagues.registrationEnabled()) {
        return sendJson(res, 403, { ok: false, error: 'League registration is disabled' });
      }
      let body;
      try {
        body = await readJsonBody(req, { maxBytes: 1_000_000 });
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const owner = body.owner || {};
        if (owner.password !== owner.confirmPassword) {
          return sendJson(res, 400, { ok: false, error: 'Passwords do not match' });
        }
        const draftId = String(body.draftId || '').trim() || crypto.randomUUID();
        const uploadedAssets = leagues.listDraftAssets(draftId);

        const user = users.createUser({
          name: owner.name,
          email: owner.email,
          loginName: owner.loginName,
          password: owner.password,
          role: 'commissioner',
          approved: true,
          leagueOwner: true
        });

        const activate = body.activate !== false;
        const league = leagues.createLeague({
          id: draftId,
          ownerUserId: user.id,
          season: body.season,
          brand: body.brand,
          conferences: body.conferences,
          championship: body.championship,
          structure: body.structure,
          payouts: body.payouts,
          calendarDefaults: body.calendarDefaults,
          uploadedAssets,
          activate
        });

        // Attach leagueId on owner (createUser already ran — patch store via attach + recreate public)
        leagues.attachOwner(league.id, user.id);
        try {
          const storePath = path.join(users.DATA_DIR, 'users.json');
          const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
          const idx = (store.users || []).findIndex((u) => u.id === user.id);
          if (idx !== -1) {
            store.users[idx].leagueId = league.id;
            store.users[idx].leagueOwner = true;
            fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
          }
        } catch { /* non-fatal */ }

        if (activate) {
          config.refresh();
          try {
            calendar.seedIfEmpty(league.calendarDefaults || []);
          } catch { /* ignore */ }
        }

        const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
        const token = signSession(user.id, expiresAt);
        return sendJson(
          res,
          201,
          {
            ok: true,
            league,
            user: users.publicUser(users.findById(user.id)),
            activated: activate,
            message: activate
              ? 'League registered and activated. You are signed in as league owner.'
              : 'League registered. Activate it from League Tools when ready.'
          },
          { 'Set-Cookie': sessionCookieHeader(token) }
        );
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not register league' });
      }
    }

    if (pathname === '/api/league/activate' && req.method === 'POST') {
      const user = requireCommissioner(req, res);
      if (!user) return;
      try {
        const body = await readJsonBody(req);
        const leagueId = String(body.leagueId || '').trim();
        const league = leagues.findById(leagueId);
        if (!league) return sendJson(res, 404, { ok: false, error: 'League not found' });
        if (!league.isSystem && league.ownerUserId && league.ownerUserId !== user.id && !user.leagueOwner) {
          // Allow any commissioner on this deploy for now
        }
        const activated = leagues.setActiveLeague(leagueId);
        config.refresh();
        return sendJson(res, 200, { ok: true, league: activated });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not activate league' });
      }
    }
    if (pathname === '/setup' || pathname === '/setup.html') {
      // Never show a league/site setup form — GridIron 24 already exists.
      res.writeHead(302, {
        Location: '/enter',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache'
      });
      return res.end();
    }
    if (pathname === '/api/invites/peek' && req.method === 'GET') {
      const token = String(requestUrl.searchParams.get('token') || '').trim();
      const invite = invites.findByToken(token);
      if (!invite) {
        return sendJson(res, 404, { ok: false, error: 'Invite link is invalid or was revoked' });
      }
      return sendJson(res, 200, {
        ok: true,
        email: invite.email,
        invitedByName: invite.invitedByName || null,
        expiresAt: invite.expiresAt
      });
    }

    if (pathname === '/forgot' || pathname === '/forgot.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'forgot.html'));
    }
    if (pathname === '/reset' || pathname === '/reset.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'reset.html'));
    }

    if (!requireAuth(req, res, pathname)) return;

    if (pathname === '/scoreboard' || pathname === '/scoreboard.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'scoreboard.html'));
    }

    if (pathname === '/beta-scoring' || pathname === '/beta-scoring.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'beta-scoring.html'));
    }

    if (pathname === '/beta-draft' || pathname === '/beta-draft.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'beta-draft.html'));
    }

    if (pathname === '/api/beta/live-scoring' && req.method === 'GET') {
      try {
        const week = requestUrl.searchParams.get('week');
        const seasontype = requestUrl.searchParams.get('seasontype');
        const dates = requestUrl.searchParams.get('dates');
        const payload = await nflverseLive.getLiveScoring({ week, seasontype, dates });
        return sendJson(res, 200, payload);
      } catch (err) {
        return sendJson(res, err.status || 502, {
          ok: false,
          error: err.message || 'Live scoring unavailable'
        });
      }
    }

    if (pathname === '/api/beta/draft-pool' && req.method === 'GET') {
      try {
        const season = requestUrl.searchParams.get('season');
        const activeOnly = requestUrl.searchParams.get('activeOnly') !== '0';
        const payload = await nflverseDraft.loadDraftPool({ season, activeOnly });
        return sendJson(res, 200, payload);
      } catch (err) {
        return sendJson(res, err.status || 502, {
          ok: false,
          error: err.message || 'Draft pool unavailable'
        });
      }
    }

    if (pathname === '/api/beta/draft' && req.method === 'GET') {
      try {
        const payload = await nflverseDraft.getDraftBoard();
        return sendJson(res, 200, payload);
      } catch (err) {
        return sendJson(res, err.status || 500, {
          ok: false,
          error: err.message || 'Draft board unavailable'
        });
      }
    }

    if (pathname === '/api/beta/draft' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      try {
        if (body.action === 'reset') {
          nflverseDraft.resetDraft({
            teams: body.teams,
            rounds: body.rounds,
            order: body.order,
            season: body.season,
            teamNames: body.teamNames
          });
          const payload = await nflverseDraft.getDraftBoard();
          return sendJson(res, 200, payload);
        }
        if (body.action === 'undo') {
          const payload = await nflverseDraft.undoPick(user);
          return sendJson(res, 200, payload);
        }
        if (body.action === 'pick') {
          const payload = await nflverseDraft.makePick(body.playerId, user);
          return sendJson(res, 200, payload);
        }
        return sendJson(res, 400, { ok: false, error: 'Unknown draft action' });
      } catch (err) {
        return sendJson(res, err.status || 400, {
          ok: false,
          error: err.message || 'Draft action failed'
        });
      }
    }

    if (pathname === '/api/users' && req.method === 'GET') {
      if (!requireCommissioner(req, res)) return;
      const claims = logos.listClaims();
      const claimByUser = new Map(claims.map((c) => [c.userId, c]));
      let teamsByConference = {};
      try {
        const leagues = await Promise.all(
          config.conferences.map(async (conference) => {
            try {
              const league = await fetchEspnLeague(conference);
              return {
                key: conference.key,
                name: conference.name,
                teams: (league.teams || []).map((t) => ({
                  id: t.id,
                  name: t.name,
                  owner: t.owner || null
                }))
              };
            } catch {
              return { key: conference.key, name: conference.name, teams: [] };
            }
          })
        );
        for (const league of leagues) teamsByConference[league.key] = league;
      } catch { /* ignore */ }

      return sendJson(res, 200, {
        ok: true,
        users: users.listUsers().map((u) => ({
          ...u,
          claim: claimByUser.get(u.id) || null
        })),
        claims,
        conferences: config.conferences.map((c) => ({
          key: c.key,
          name: c.name,
          teams: (teamsByConference[c.key]?.teams) || []
        }))
      });
    }

    if (pathname.startsWith('/api/users/') && pathname.endsWith('/team') && req.method === 'POST') {
      const admin = requireCommissioner(req, res);
      if (!admin) return;
      const userId = pathname.slice('/api/users/'.length, -'/team'.length);
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const target = users.findById(userId);
        if (!target) return sendJson(res, 404, { ok: false, error: 'User not found' });

        if (body.clear || body.conferenceKey === '' || body.teamId === '' || body.teamId == null) {
          logos.unassignTeam(userId);
          return sendJson(res, 200, { ok: true, claim: null, user: users.publicUser(target) });
        }

        const conferenceKey = String(body.conferenceKey || '').trim();
        const teamId = Number(body.teamId);
        let teamName = String(body.teamName || '').trim();
        if (!teamName) {
          try {
            const conference = config.conferences.find((c) => c.key === conferenceKey);
            if (conference) {
              const league = await fetchEspnLeague(conference);
              const found = (league.teams || []).find((t) => Number(t.id) === teamId);
              if (found) teamName = found.name;
            }
          } catch { /* ignore */ }
        }
        const claim = logos.assignTeam(userId, conferenceKey, teamId, teamName, admin.id);
        return sendJson(res, 200, { ok: true, claim, user: users.publicUser(target) });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not assign team' });
      }
    }

    if (pathname.startsWith('/api/users/') && pathname.endsWith('/role') && req.method === 'POST') {
      if (!requireCommissioner(req, res)) return;
      const userId = pathname.slice('/api/users/'.length, -'/role'.length);
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const updated = users.setUserRole(userId, body.role, body.conference);
        return sendJson(res, 200, { ok: true, user: updated });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not update role' });
      }
    }

    if (pathname.startsWith('/api/users/') && pathname.endsWith('/approve') && req.method === 'POST') {
      const admin = requireCommissioner(req, res);
      if (!admin) return;
      const userId = pathname.slice('/api/users/'.length, -'/approve'.length);
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      try {
        const before = users.findById(userId);
        const newlyApproved = Boolean(before) && before.approved === false && body.approved !== false;
        const updated = users.setUserApproved(userId, body.approved !== false, admin.id);
        let mail = { sent: false, method: 'none' };
        if (newlyApproved && updated.email) {
          try {
            mail = await sendAccountApprovedEmail({
              to: updated.email,
              name: updated.name || updated.loginName,
              leagueName: config.brand.name,
              baseUrl: requestOrigin(req)
            });
          } catch (mailErr) {
            mail = {
              sent: false,
              method: 'error',
              error: mailErr.message || 'Email send failed'
            };
          }
        }
        return sendJson(res, 200, {
          ok: true,
          user: updated,
          mailSent: Boolean(mail.sent),
          mailMethod: mail.method || null,
          mailError: mail.error || null
        });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not update approval' });
      }
    }

    if (pathname.startsWith('/api/users/') && pathname.endsWith('/reject') && req.method === 'POST') {
      const admin = requireCommissioner(req, res);
      if (!admin) return;
      const userId = pathname.slice('/api/users/'.length, -'/reject'.length);
      try {
        // Reject = delete pending account (and clear any team assignment).
        try { logos.unassignTeam(userId); } catch { /* may have no team */ }
        const removed = users.deleteUser(userId, admin.id);
        return sendJson(res, 200, { ok: true, user: removed });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not reject account' });
      }
    }

    if (pathname === '/api/invites/preview-email' && req.method === 'GET') {
      const user = requireCommissioner(req, res);
      if (!user) return;
      const { buildInviteEmail } = require('./mail');
      const origin = requestOrigin(req);
      const content = buildInviteEmail({
        inviteUrl: `${origin}/register?invite=preview-sample-token`,
        invitedByName: user.name || user.loginName || 'Commissioner',
        leagueName: config.brand.name,
        baseUrl: origin
      });
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      return res.end(content.html);
    }

    if (pathname === '/api/mail/preview-approved' && req.method === 'GET') {
      const user = requireCommissioner(req, res);
      if (!user) return;
      const { buildAccountApprovedEmail } = require('./mail');
      const origin = requestOrigin(req);
      const content = buildAccountApprovedEmail({
        name: 'Alex Manager',
        leagueName: config.brand.name,
        signInUrl: `${origin}/enter`,
        baseUrl: origin
      });
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      return res.end(content.html);
    }

    if (pathname === '/api/mail/preview-reset' && req.method === 'GET') {
      const user = requireCommissioner(req, res);
      if (!user) return;
      const { buildPasswordResetEmail } = require('./mail');
      const origin = requestOrigin(req);
      const content = buildPasswordResetEmail({
        resetUrl: `${origin}/reset?token=preview-sample-token`,
        name: user.name || user.loginName || 'Manager',
        leagueName: config.brand.name,
        baseUrl: origin
      });
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      return res.end(content.html);
    }

    if (pathname === '/api/invites' && req.method === 'GET') {
      if (!requireCommissioner(req, res)) return;
      return sendJson(res, 200, {
        ok: true,
        invites: invites.listInvites(),
        mail: mailConfig()
      });
    }

    if (pathname === '/api/invites' && req.method === 'POST') {
      const user = requireCommissioner(req, res);
      if (!user) return;
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      const emails = Array.isArray(body.emails)
        ? body.emails.map((e) => String(e || '').trim()).filter(Boolean)
        : String(body.email || body.emails || '')
          .split(/[,;\n]+/)
          .map((e) => e.trim())
          .filter(Boolean);
      if (!emails.length) {
        return sendJson(res, 400, { ok: false, error: 'Enter at least one email address' });
      }
      const results = [];
      for (const email of emails) {
        try {
          const created = invites.createInvite({ email, invitedBy: user });
          const inviteUrl = `${requestOrigin(req)}/register?invite=${encodeURIComponent(created.token)}`;
          let mailResult = { sent: false, method: 'none' };
          try {
            mailResult = await sendInviteEmail({
              to: created.invite.email,
              inviteUrl,
              invitedByName: user.name || user.loginName,
              leagueName: config.brand.name,
              baseUrl: requestOrigin(req)
            });
          } catch (mailErr) {
            mailResult = {
              sent: false,
              method: 'error',
              error: mailErr.message || 'Email send failed'
            };
          }
          results.push({
            ok: true,
            email: created.invite.email,
            invite: created.invite,
            sent: Boolean(mailResult.sent),
            method: mailResult.method,
            mailError: mailResult.error || null,
            inviteUrl
          });
        } catch (err) {
          results.push({ ok: false, email, error: err.message || 'Could not invite' });
        }
      }
      const sentCount = results.filter((r) => r.ok && r.sent).length;
      const okCount = results.filter((r) => r.ok).length;
      const mailReady = mailConfig().configured;
      let message;
      if (sentCount && sentCount === okCount) {
        message = `Emailed ${sentCount} invite${sentCount === 1 ? '' : 's'}.`;
      } else if (sentCount) {
        message = `Emailed ${sentCount} of ${okCount}. Copy the remaining invite links below.`;
      } else if (okCount) {
        message = mailReady
          ? 'Invites created, but email delivery failed. Copy the invite links below and share them manually.'
          : 'Invites created. Email is not configured yet — copy the invite links below (or set RESEND_API_KEY + MAIL_FROM on the server).';
      } else {
        message = 'No invites were created.';
      }
      return sendJson(res, 200, {
        ok: okCount > 0,
        results,
        mail: mailConfig(),
        message
      });
    }

    if (pathname.match(/^\/api\/invites\/[^/]+\/resend$/) && req.method === 'POST') {
      const user = requireCommissioner(req, res);
      if (!user) return;
      const id = pathname.split('/')[3];
      try {
        const refreshed = invites.refreshInvite(id, user);
        const inviteUrl = `${requestOrigin(req)}/register?invite=${encodeURIComponent(refreshed.token)}`;
        let mailResult = { sent: false, method: 'none' };
        try {
          mailResult = await sendInviteEmail({
            to: refreshed.invite.email,
            inviteUrl,
            invitedByName: user.name || user.loginName,
            leagueName: config.brand.name,
            baseUrl: requestOrigin(req)
          });
        } catch (mailErr) {
          mailResult = {
            sent: false,
            method: 'error',
            error: mailErr.message || 'Email send failed'
          };
        }
        return sendJson(res, 200, {
          ok: true,
          invite: refreshed.invite,
          inviteUrl,
          sent: Boolean(mailResult.sent),
          method: mailResult.method,
          mailError: mailResult.error || null,
          mail: mailConfig(),
          message: mailResult.sent
            ? `Invite resent to ${refreshed.invite.email}.`
            : `Invite link refreshed for ${refreshed.invite.email}. Copy and share it manually.`
        });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not resend invite' });
      }
    }

    if (pathname.startsWith('/api/invites/') && req.method === 'DELETE') {
      if (!requireCommissioner(req, res)) return;
      const id = pathname.slice('/api/invites/'.length);
      if (id.includes('/')) {
        return sendJson(res, 404, { ok: false, error: 'Not found' });
      }
      try {
        const invite = invites.revokeInvite(id);
        return sendJson(res, 200, { ok: true, invite });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not revoke invite' });
      }
    }

    if (pathname === '/api/news' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        news: board.listNews(),
        generatedAt: new Date().toISOString()
      });
    }

    if (pathname === '/api/weekly-wrap/preview' && req.method === 'GET') {
      const user = requireCommissioner(req, res);
      if (!user) return;
      const weekParam = requestUrl.searchParams.get('week');
      try {
        const result = await runWeeklyWrapJob({
          week: weekParam ? Number(weekParam) : null,
          force: true,
          dryRun: true,
          sendEmail: false,
          postNews: false,
          triggeredBy: user.loginName || 'commissioner'
        });
        if (requestUrl.searchParams.get('format') === 'html' && result.emailPreview?.html) {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store'
          });
          return res.end(result.emailPreview.html);
        }
        return sendJson(res, result.ok ? 200 : 409, result);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message || 'Could not preview wrap' });
      }
    }

    if (pathname === '/api/weekly-wrap' && req.method === 'POST') {
      const user = requireCommissioner(req, res);
      if (!user) return;
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      try {
        const result = await runWeeklyWrapJob({
          week: body.week != null ? Number(body.week) : null,
          force: Boolean(body.force),
          dryRun: Boolean(body.dryRun),
          sendEmail: body.sendEmail !== false,
          postNews: body.postNews !== false,
          triggeredBy: user.loginName || user.name || 'commissioner'
        });
        return sendJson(res, result.ok || result.skipped ? 200 : 409, result);
      } catch (err) {
        console.error('[weekly-wrap] manual failed', err);
        return sendJson(res, 500, { ok: false, error: err.message || 'Weekly wrap failed' });
      }
    }

    if (pathname === '/api/news' && req.method === 'POST') {
      const user = requireStaff(req, res);
      if (!user) return;
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const item = board.addNews({ title: body.title, body: body.body, author: user });
        return sendJson(res, 201, { ok: true, item });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not post news' });
      }
    }

    if (pathname.startsWith('/api/news/') && req.method === 'DELETE') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      const id = pathname.slice('/api/news/'.length);
      try {
        board.deleteNews(id, user);
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not delete news' });
      }
    }

    if (pathname === '/api/messages' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        messages: board.listMessages(),
        generatedAt: new Date().toISOString()
      });
    }

    if (pathname === '/api/messages' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const item = board.addMessage({ body: body.body, author: user });
        return sendJson(res, 201, { ok: true, item });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not post message' });
      }
    }

    if (pathname.startsWith('/api/messages/') && req.method === 'DELETE') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      const id = pathname.slice('/api/messages/'.length);
      try {
        board.deleteMessage(id, user);
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not delete message' });
      }
    }

    if (pathname === '/api/ticker' && req.method === 'GET') {
      const custom = board.listTicker().map((t) => ({
        id: t.id,
        source: 'custom',
        label: 'LEAGUE',
        text: t.text,
        href: null,
        createdAt: t.createdAt
      }));
      const espn = await fetchEspnNflNews(10);
      const items = [...custom, ...espn];
      return sendJson(res, 200, {
        ok: true,
        items,
        custom: board.listTicker(),
        generatedAt: new Date().toISOString()
      });
    }

    if (pathname === '/api/ticker' && req.method === 'POST') {
      const user = requireStaff(req, res);
      if (!user) return;
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const item = board.addTicker({ text: body.text, author: user });
        return sendJson(res, 201, { ok: true, item });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not add ticker message' });
      }
    }

    if (pathname.startsWith('/api/ticker/') && req.method === 'DELETE') {
      const user = requireStaff(req, res);
      if (!user) return;
      const id = pathname.slice('/api/ticker/'.length);
      try {
        board.deleteTicker(id, user);
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not delete ticker item' });
      }
    }

    if (pathname === '/commissioner.html' || pathname === '/admin.html') {
      const user = getSessionUser(req);
      if (!canAccessCommissionerPage(user)) {
        res.writeHead(302, { Location: '/home.html' });
        return res.end();
      }
      res.writeHead(302, { Location: '/league-tools.html' });
      return res.end();
    }

    if (pathname === '/scoring.html' || pathname === '/scoring') {
      res.writeHead(302, { Location: '/rulebook.html#article-iv' });
      return res.end();
    }

    if (pathname === '/payouts.html' || pathname === '/payouts') {
      res.writeHead(302, { Location: '/rulebook.html#article-vi' });
      return res.end();
    }

    if (pathname === '/team-logo.html') {
      res.writeHead(302, { Location: '/profile.html#logo' });
      return res.end();
    }

    if (pathname === '/profile.html' || pathname === '/profile') {
      return sendFile(res, path.join(PUBLIC_DIR, 'profile.html'));
    }

    if (pathname === '/league-tools.html' || pathname === '/league-tools') {
      const user = getSessionUser(req);
      if (!canAccessCommissionerPage(user)) {
        res.writeHead(302, { Location: user ? '/profile.html' : '/enter?next=' + encodeURIComponent('/league-tools.html') });
        return res.end();
      }
      return sendFile(res, path.join(PUBLIC_DIR, 'league-tools.html'));
    }

    if (pathname === '/api/leagues') {
      return await apiLeagues(res);
    }

    if (pathname === '/api/my-team' && req.method === 'GET') {
      const user = getSessionUser(req);
      const claim = logos.getClaimForUser(user.id);
      const logo = logos.resolveLogoForUser(user.id);
      let team = null;
      if (claim) {
        const nameEntry = logos.getDisplayName(claim.conferenceKey, claim.teamId);
        try {
          const conference = config.conferences.find((c) => c.key === claim.conferenceKey);
          if (conference) {
            const league = await fetchEspnLeague(conference);
            const found = (league.teams || []).find((t) => Number(t.id) === Number(claim.teamId));
            if (found) {
              const rank = (league.teams || []).findIndex((t) => Number(t.id) === Number(found.id)) + 1;
              team = {
                id: found.id,
                name: found.name,
                espnName: found.espnName || found.name,
                abbreviation: found.abbreviation || '',
                logo: found.logo || null,
                conferenceKey: claim.conferenceKey,
                conferenceName: conference.name,
                wins: found.wins ?? 0,
                losses: found.losses ?? 0,
                ties: found.ties ?? 0,
                pointsFor: found.pointsFor ?? 0,
                pointsAgainst: found.pointsAgainst ?? 0,
                pointsPerGame: found.pointsPerGame ?? 0,
                playoffSeed: found.playoffSeed ?? 0,
                waiverRank: found.waiverRank ?? 0,
                streakType: found.streakType || 'NONE',
                streakLength: found.streakLength ?? 0,
                standingRank: rank || null,
                teamCount: (league.teams || []).length
              };
            }
          }
        } catch { /* ignore ESPN lookup failures for avatar */ }
        if (nameEntry?.displayName) {
          team = {
            ...(team || { id: claim.teamId, conferenceKey: claim.conferenceKey }),
            name: nameEntry.displayName
          };
        } else if (claim.teamName && team) {
          team.name = claim.teamName;
        }
      }
      return sendJson(res, 200, {
        ok: true,
        claim,
        logo,
        team,
        user: users.publicUser(user),
        specs: logos.LOGO_SPECS
      });
    }

    if (pathname === '/api/my-team/claim' && req.method === 'POST') {
      return sendJson(res, 403, {
        ok: false,
        error: 'Teams are assigned by the commissioner. Ask them to link your franchise.'
      });
    }

    if (pathname === '/api/my-team/name' && req.method === 'POST') {
      try {
        const user = getSessionUser(req);
        const body = await readJsonBody(req);
        const claim = logos.getClaimForUser(user.id);
        if (!claim) return sendJson(res, 400, { ok: false, error: 'Claim a team first' });
        const result = logos.setDisplayName(user.id, claim.conferenceKey, claim.teamId, body.name);
        return sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not rename team' });
      }
    }

    if (pathname === '/api/my-team/logo/icon' && req.method === 'POST') {
      try {
        const user = getSessionUser(req);
        const body = await readJsonBody(req);
        const claim = logos.getClaimForUser(user.id);
        const iconPath = path.join(PUBLIC_DIR, 'assets', 'team-icons', `${path.basename(String(body.iconId || ''))}.svg`);
        if (!fs.existsSync(iconPath)) {
          return sendJson(res, 400, { ok: false, error: 'Unknown icon' });
        }
        const logo = logos.setIconLogo(
          user.id,
          claim?.conferenceKey,
          claim?.teamId,
          body.iconId
        );
        return sendJson(res, 200, { ok: true, logo });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not set icon' });
      }
    }

    if (pathname === '/api/my-team/logo/upload' && req.method === 'POST') {
      try {
        const user = getSessionUser(req);
        const body = await readJsonBody(req, { maxBytes: 3_500_000 });
        const claim = logos.getClaimForUser(user.id);
        const dataUrl = String(body.dataUrl || '');
        const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([a-zA-Z0-9+/=\s]+)$/);
        if (!match) {
          return sendJson(res, 400, { ok: false, error: 'Upload a PNG, JPG, or WEBP image' });
        }
        const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
        const logo = logos.setUploadLogo(user.id, claim?.conferenceKey, claim?.teamId, {
          buffer,
          mimeType: match[1],
          width: body.width,
          height: body.height
        });
        return sendJson(res, 200, { ok: true, logo });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not upload logo' });
      }
    }

    if (pathname === '/api/my-team/logo' && req.method === 'DELETE') {
      try {
        const user = getSessionUser(req);
        const claim = logos.getClaimForUser(user.id);
        logos.clearLogo(user.id, claim?.conferenceKey, claim?.teamId);
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not clear logo' });
      }
    }

    if (pathname.startsWith('/uploads/team-logos/')) {
      const file = logos.resolveUploadPath(pathname.slice('/uploads/team-logos/'.length));
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }
      return sendFile(res, file);
    }

    if (pathname.startsWith('/uploads/leagues/')) {
      const file = leagues.resolveLeagueUploadPath(pathname.slice('/uploads/leagues/'.length));
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }
      return sendFile(res, file);
    }

    if (pathname === '/api/settings') {
      return await apiSettings(res);
    }

    if (pathname === '/api/scoring') {
      return await apiOfficialScoring(res);
    }

    if (pathname === '/api/rules-sync' && req.method === 'GET') {
      const sync = rulesSyncStore.getStatus();
      return sendJson(res, 200, { ok: true, ...sync, generatedAt: new Date().toISOString() });
    }

    if (pathname === '/api/rules-sync/check' && req.method === 'POST') {
      const user = requireStaff(req, res);
      if (!user) return;
      try {
        const result = await runRulesSyncJob({
          triggeredBy: user.loginName || user.name || 'staff',
          notify: false
        });
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message || 'Rules sync check failed' });
      }
    }

    if (pathname === '/api/schedule') {
      return await apiSchedule(res, requestUrl.searchParams.get('week'));
    }

    if (pathname === '/api/fantasy-leaders') {
      return await apiFantasyLeaders(res, requestUrl.searchParams.get('week'));
    }

    if (pathname === '/api/bowl') {
      try {
        const payload = await buildBowlPayload();
        return sendJson(res, 200, payload);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message || 'Could not load GridIron Bowl' });
      }
    }

    if (pathname === '/api/playoffs') {
      try {
        const payload = await buildPlayoffsPayload();
        return sendJson(res, 200, payload);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message || 'Could not load playoffs' });
      }
    }

    if (pathname === '/api/transactions') {
      try {
        const payload = await loadTransactionsPayload();
        return sendJson(res, 200, payload);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message || 'Could not load transactions' });
      }
    }

    if (pathname === '/api/team') {
      const conferenceKey = String(requestUrl.searchParams.get('conference') || '').trim();
      const teamId = Number(requestUrl.searchParams.get('teamId'));
      if (!conferenceKey || !Number.isFinite(teamId)) {
        return sendJson(res, 400, { ok: false, error: 'conference and teamId are required' });
      }
      try {
        const payload = await loadTeamDetail(conferenceKey, teamId);
        return sendJson(res, 200, payload);
      } catch (err) {
        return sendJson(res, err.status || 500, { ok: false, error: err.message || 'Could not load team' });
      }
    }

    if (pathname === '/api/calendar' && req.method === 'GET') {
      try {
        calendar.seedIfEmpty(config.calendarDefaults || []);
      } catch { /* ignore */ }
      return sendJson(res, 200, {
        ok: true,
        events: calendar.listEvents(),
        generatedAt: new Date().toISOString()
      });
    }

    if (pathname === '/api/calendar' && req.method === 'POST') {
      const user = requireCommissioner(req, res);
      if (!user) return;
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const item = calendar.addEvent(body);
        return sendJson(res, 201, { ok: true, item });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not add event' });
      }
    }

    if (pathname.startsWith('/api/calendar/') && req.method === 'DELETE') {
      if (!requireCommissioner(req, res)) return;
      const id = pathname.slice('/api/calendar/'.length);
      try {
        calendar.deleteEvent(id);
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not delete event' });
      }
    }

    if (pathname === '/api/power-rankings' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        latest: powerRankings.latestRanking(),
        rankings: powerRankings.listRankings(),
        generatedAt: new Date().toISOString()
      });
    }

    if (pathname === '/api/power-rankings' && req.method === 'POST') {
      const user = requireCommissioner(req, res);
      if (!user) return;
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const item = powerRankings.saveRanking({
          week: body.week,
          season: config.season,
          ranks: body.ranks,
          notes: body.notes,
          author: user
        });
        return sendJson(res, 201, { ok: true, item });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not save rankings' });
      }
    }

    if (pathname.startsWith('/api/power-rankings/') && req.method === 'DELETE') {
      const user = requireCommissioner(req, res);
      if (!user) return;
      const id = pathname.slice('/api/power-rankings/'.length);
      try {
        powerRankings.deleteRanking(id, user);
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not delete ranking' });
      }
    }

    if (pathname === '/api/payouts') {
      return sendJson(res, 200, {
        season: config.season,
        brand: config.brand,
        payouts: config.payouts || null,
        generatedAt: new Date().toISOString()
      });
    }

    const requested = pathname === '/' ? '/index.html' : pathname;
    const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(PUBLIC_DIR, safePath);

    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    return sendFile(res, filePath);
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { ok: false, error: 'Internal server error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  try {
    config.bootstrap();
  } catch (err) {
    console.warn('League bootstrap failed:', err.message || err);
  }
  users.ensureBootstrapCommissioner();
  try { users.migrateApprovalFlags(); } catch (err) {
    console.warn('Approval migration failed:', err.message || err);
  }
  try {
    calendar.seedIfEmpty(config.calendarDefaults || []);
  } catch (err) {
    console.warn('Calendar seed failed:', err.message || err);
  }
  const active = leagues.getActiveLeague();
  console.log(`\n${config.brand?.name || 'League HQ'} is running.`);
  console.log(`Open: http://localhost:${PORT}`);
  console.log(`API:  http://localhost:${PORT}/api/leagues`);
  console.log(`Active league: ${active?.slug || 'none'} (${active?.brand?.name || '—'})`);
  console.log(`Register a league: http://localhost:${PORT}/register-league`);
  console.log(`Auth: invite + commissioner approval`);
  console.log(`Users: ${users.DATA_DIR}`);
  if (process.env.COMMISSIONER_LOGIN) {
    console.log(`Commissioner login: ${process.env.COMMISSIONER_LOGIN}`);
  }
  console.log('');
});
