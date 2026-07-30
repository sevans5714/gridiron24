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
const buildInfo = require('./build-info');
const users = require('./users-store');
const board = require('./board-store');
const membersChat = require('./members-chat-store');
const logos = require('./logos-store');
const invites = require('./invites-store');
const weeklyWrap = require('./weekly-wrap');
const calendar = require('./calendar-store');
const powerRankings = require('./power-rankings-store');
const rulesSyncStore = require('./rules-sync-store');
const rosterViolations = require('./roster-violations-store');
const keepers = require('./keepers-store');
const career = require('./career-store');
const polls = require('./polls-store');
const inbox = require('./inbox-store');
const welcomeMessage = require('./welcome-message');
const presence = require('./presence-store');
const ruleProposals = require('./rule-proposals-store');
const leagues = require('./leagues-store');
const { compareSettings } = require('./rules-diff');
const nflverseLive = require('./nflverse-live');
const sportsScoreboard = require('./sports-scoreboard');
const nflverseDraft = require('./nflverse-draft');
const {
  sendPasswordResetEmail,
  sendInviteEmail,
  sendAccountApprovedEmail,
  sendWeeklyWrapEmail,
  sendRulesSyncAlert,
  sendConferenceOwnerEmail,
  sendRosterViolationEmail,
  buildWeeklyWrapEmail,
  buildConferenceOwnerEmail,
  mailConfig
} = require('./mail');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_MS = 30_000;
const cache = new Map();
const ESPN_NEWS_CACHE_MS = 5 * 60_000;
let espnNewsCache = { at: 0, items: [] };

function espnAuthHeaders() {
  const headers = {
    Accept: 'application/json,text/plain,*/*',
    'User-Agent': 'GridIron24/0.1 (+local proof-of-concept)'
  };
  const swid = String(process.env.ESPN_SWID || '').trim();
  const s2 = String(process.env.ESPN_S2 || '').trim();
  if (swid && s2) {
    headers.Cookie = `SWID=${swid}; espn_s2=${s2}`;
  }
  return headers;
}

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
const LEAGUE_COOKIE = 'gi24_league';
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
  '/api/cron/rules-sync',
  '/api/cron/roster-violations',
  '/manifest.webmanifest',
  '/sw.js'
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

function preferredLeagueCookieHeader(league) {
  const value = league === 'aaa' ? 'aaa' : 'gridiron';
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  const secure = process.env.NODE_ENV === 'production' || process.env.RENDER ? '; Secure' : '';
  return `${LEAGUE_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function clearPreferredLeagueCookieHeader() {
  const secure = process.env.NODE_ENV === 'production' || process.env.RENDER ? '; Secure' : '';
  return `${LEAGUE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function getPreferredLeague(req) {
  const cookies = parseCookies(req?.headers?.cookie);
  const value = String(cookies[LEAGUE_COOKIE] || '').trim().toLowerCase();
  if (value === 'aaa' || value === 'gridiron') return value;
  return null;
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
  const next = encodeURIComponent(pathname === '/' ? '/hq' : pathname);
  res.writeHead(302, { Location: `/enter?next=${next}` });
  res.end();
  return false;
}

function requireSiteOwner(req, res) {
  const user = getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { ok: false, error: 'Authentication required' });
    return null;
  }
  if (!users.isSiteOwner(user)) {
    sendJson(res, 403, { ok: false, error: 'Site owner access required' });
    return null;
  }
  return user;
}

function staffRecipients() {
  return users.listUsers().filter((u) => users.isStaff(u) && u.approved !== false);
}

function eligibleVoters() {
  return users.listUsers().filter((u) => u.approved !== false);
}

let draftGateCache = { at: 0, value: null };

async function getDraftGateStatus() {
  if (process.env.RULE_PROPOSALS_FORCE_OPEN === '1') {
    return {
      proposalsOpen: true,
      forced: true,
      leagues: [],
      generatedAt: new Date().toISOString()
    };
  }
  const now = Date.now();
  if (draftGateCache.value && now - draftGateCache.at < 5 * 60 * 1000) {
    return draftGateCache.value;
  }

  const targets = listEspnLeagues();
  const leaguesStatus = [];
  for (const league of targets) {
    try {
      const board = await loadDraftBoard(league.key);
      leaguesStatus.push({
        key: league.key,
        name: league.shortName || league.name,
        ok: true,
        drafted: Boolean(board?.draft?.drafted),
        inProgress: Boolean(board?.draft?.inProgress)
      });
    } catch (err) {
      leaguesStatus.push({
        key: league.key,
        name: league.shortName || league.name,
        ok: false,
        drafted: false,
        inProgress: false,
        error: err.message || 'Unavailable'
      });
    }
  }

  // Button stays until every league draft is complete (not in progress).
  const proposalsOpen = !leaguesStatus.every((l) => l.ok && l.drafted && !l.inProgress);
  const value = {
    proposalsOpen,
    forced: false,
    leagues: leaguesStatus,
    generatedAt: new Date().toISOString()
  };
  draftGateCache = { at: now, value };
  return value;
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

function resolveStaffConferenceKey(user, requestedKey) {
  const allowed = new Set(listAdminLeagues().map((l) => l.key));
  if (user.role === 'conference_admin') {
    const key = String(user.conference || '').trim().toLowerCase();
    if (!key || !allowed.has(key)) {
      const err = new Error('Your account is missing a conference assignment');
      err.status = 400;
      throw err;
    }
    return key;
  }
  const key = String(requestedKey || '').trim().toLowerCase();
  if (!key || !allowed.has(key)) {
    const err = new Error('Pick a conference');
    err.status = 400;
    throw err;
  }
  return key;
}

/** Franchise claim conference, else conference_admin assignment. */
function memberConferenceKey(user) {
  if (!user?.id) return null;
  if (user.role === 'conference_admin' && user.conference) {
    return String(user.conference).toLowerCase();
  }
  try {
    const claim = logos.getClaimForUser(user.id);
    if (claim?.conferenceKey) return String(claim.conferenceKey).toLowerCase();
  } catch { /* ignore */ }
  return null;
}

async function loadConferenceOwnerRoster(conferenceKey) {
  const conference = resolveEspnLeague(conferenceKey)
    || listAdminLeagues().find((l) => l.key === conferenceKey);
  if (!conference || !(Number(conference.espnLeagueId) > 0)) {
    const err = new Error('Unknown conference');
    err.status = 404;
    throw err;
  }
  const league = await fetchEspnLeague(conference);
  const claimByTeam = new Map(
    logos.listClaims()
      .filter((c) => c.conferenceKey === conferenceKey)
      .map((c) => [Number(c.teamId), c])
  );
  const teams = (league.teams || []).map((t) => {
    const claim = claimByTeam.get(Number(t.id));
    const ownerUser = claim ? users.findById(claim.userId) : null;
    const ownerEmail = ownerUser?.email || null;
    return {
      teamId: t.id,
      teamName: t.name,
      logo: t.logo || null,
      espnOwnerName: t.owner || null,
      claimed: Boolean(claim),
      ownerUserId: ownerUser?.id || null,
      ownerName: ownerUser?.name || t.owner || null,
      ownerEmail,
      emailable: Boolean(ownerEmail)
    };
  });
  return {
    conference: {
      key: conference.key,
      name: conference.name,
      shortName: conference.shortName,
      logo: conference.logo || null
    },
    teams,
    mail: mailConfig()
  };
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
      '.webmanifest': 'application/manifest+json; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
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

function conferenceAdminName(conferenceKey) {
  const key = String(conferenceKey || '').trim().toLowerCase();
  if (!key) return null;
  const admin = users.listUsers().find((u) => u.role === 'conference_admin'
    && String(u.conference || '').toLowerCase() === key
    && u.approved !== false);
  const name = String(admin?.name || '').trim();
  return name || null;
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
    admin: conferenceAdminName(conference.key),
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

async function fetchEspnRaw(conference, views, cacheSuffix = '', query = {}, seasonOverride = null) {
  const season = Number(seasonOverride) || Number(config.season);
  const queryKey = Object.keys(query || {})
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join('&');
  const cacheKey = `${season}:${conference.espnLeagueId}:${cacheSuffix || views.join(',')}${queryKey ? `:${queryKey}` : ''}`;
  const existing = cache.get(cacheKey);
  if (existing && Date.now() - existing.at < CACHE_MS) return existing.data;

  const endpoint = new URL(
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${conference.espnLeagueId}`
  );
  for (const view of views) endpoint.searchParams.append('view', view);
  for (const [key, value] of Object.entries(query || {})) {
    if (value != null && value !== '') endpoint.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(endpoint, {
      headers: espnAuthHeaders(),
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text();
      const err = new Error(
        response.status === 401
          ? 'ESPN league is private for that season — make it publicly viewable in ESPN settings'
          : response.status === 404
            ? 'No ESPN league found for that season / league ID'
            : `ESPN returned ${response.status}`
      );
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

const PRO_TEAM_ABBREV = {
  0: 'FA', 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET',
  9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN',
  17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC',
  25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WSH', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU'
};

/** 2026 NFL bye weeks by ESPN proTeamId (NFL.com schedule release). */
const NFL_BYE_WEEK_BY_PRO_TEAM = {
  1: 11, // ATL
  2: 7,  // BUF
  3: 10, // CHI
  4: 6,  // CIN
  5: 11, // CLE
  6: 14, // DAL
  7: 10, // DEN
  8: 6,  // DET
  9: 11, // GB
  10: 9, // TEN
  11: 13, // IND
  12: 5, // KC
  13: 13, // LV
  14: 11, // LAR
  15: 6, // MIA
  16: 6, // MIN
  17: 11, // NE
  18: 8, // NO
  19: 8, // NYG
  20: 13, // NYJ
  21: 10, // PHI
  22: 14, // ARI
  23: 9, // PIT
  24: 7, // LAC
  25: 8, // SF
  26: 11, // SEA
  27: 10, // TB
  28: 7, // WSH
  29: 5, // CAR
  30: 7, // JAX
  33: 13, // BAL
  34: 8  // HOU
};

function byeWeekForProTeam(proTeamId) {
  const id = Number(proTeamId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return NFL_BYE_WEEK_BY_PRO_TEAM[id] || null;
}

async function fetchEspnPlayersByIds(playerIds, season) {
  const unique = [...new Set((playerIds || []).map(Number).filter((id) => Number.isFinite(id) && id > 0))];
  const map = new Map();
  if (!unique.length) return map;
  const seasonNum = Number(season) || Number(config.season);
  const chunkSize = 40;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const endpoint = new URL(
      `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${seasonNum}/players`
    );
    endpoint.searchParams.set('scoringPeriodId', '0');
    endpoint.searchParams.set('view', 'players_wl');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(endpoint, {
        headers: {
          ...espnAuthHeaders(),
          'X-Fantasy-Filter': JSON.stringify({ filterIds: { value: chunk } })
        },
        signal: controller.signal
      });
      if (!response.ok) continue;
      const raw = await response.json();
      const list = Array.isArray(raw) ? raw : (raw.players || []);
      for (const player of list) {
        if (!player?.id) continue;
        map.set(Number(player.id), {
          id: Number(player.id),
          fullName: playerName(player),
          firstName: player.firstName || '',
          lastName: player.lastName || player.fullName || 'Unknown',
          position: POSITION_LABELS[player.defaultPositionId] || '—',
          proTeamId: player.proTeamId || 0,
          proTeam: PRO_TEAM_ABBREV[player.proTeamId] || 'FA'
        });
      }
    } catch {
      /* ignore chunk failures */
    } finally {
      clearTimeout(timeout);
    }
  }
  return map;
}

function splitPlayerName(fullName, firstName, lastName) {
  const first = String(firstName || '').trim();
  const last = String(lastName || '').trim();
  if (first || last) return { firstName: first, lastName: last || fullName || 'Unknown' };
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: 'Unknown' };
  if (parts.length === 1) return { firstName: '', lastName: parts[0] };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

async function loadDraftBoard(conferenceKey, seasonOverride = null) {
  const conference = resolveEspnLeague(conferenceKey);
  if (!conference) {
    const err = new Error('Unknown conference');
    err.status = 400;
    throw err;
  }
  const season = Number(seasonOverride) || Number(config.season);
  const historyEntry = historySeasonEntries().find((e) => e.season === season);
  let espnLeagueId = conference.espnLeagueId;
  if (historyEntry) {
    if (conference.key === 'detail' && historyEntry.detailEspnLeagueId) {
      espnLeagueId = historyEntry.detailEspnLeagueId;
    } else if (conference.key === 'overtime' && historyEntry.overtimeEspnLeagueId) {
      espnLeagueId = historyEntry.overtimeEspnLeagueId;
    }
  }
  if (!espnLeagueId) {
    const err = new Error('Conference has no ESPN league ID for that season');
    err.status = 400;
    throw err;
  }
  const conferenceForFetch = { ...conference, espnLeagueId };
  const raw = await fetchEspnRaw(
    conferenceForFetch,
    ['mDraftDetail', 'mTeam', 'mSettings', 'mStatus'],
    'draft',
    {},
    season
  );
  const draftDetail = raw.draftDetail || {};
  const settings = raw.settings?.draftSettings || {};
  const nameOverrides = logos.getNameOverrideMap();
  const membersById = new Map((raw.members || []).map((m) => [m.id, m]));
  const teamsById = new Map();
  for (const team of raw.teams || []) {
    const key = logos.logoKey(conference.key, team.id);
    const overrideLogo = logos.getOverrideMap().get(key);
    const espnName = (team.name || `${team.location || ''} ${team.nickname || ''}`).trim() || `Team ${team.id}`;
    const ownerId = team.primaryOwner || (team.owners || [])[0];
    teamsById.set(Number(team.id), {
      id: Number(team.id),
      name: nameOverrides.get(key) || espnName,
      abbreviation: team.abbrev || '',
      logo: logos.displayLogoUrl(overrideLogo),
      owner: ownerName(membersById.get(ownerId))
    });
  }

  const pickOrder = (settings.pickOrder || []).map(Number).filter((id) => teamsById.has(id));
  const columnIds = pickOrder.length
    ? pickOrder
    : [...teamsById.keys()].sort((a, b) => a - b);

  const rawPicks = Array.isArray(draftDetail.picks) ? draftDetail.picks : [];
  const playerIds = rawPicks.map((p) => Number(p.playerId)).filter((id) => id > 0);
  const playersById = await fetchEspnPlayersByIds(playerIds, season);

  const picks = rawPicks.map((pick) => {
    const playerId = Number(pick.playerId);
    const player = playersById.get(playerId);
    const names = splitPlayerName(player?.fullName, player?.firstName, player?.lastName);
    const filled = Number.isFinite(playerId) && playerId > 0;
    return {
      id: pick.id,
      overall: Number(pick.overallPickNumber) || null,
      round: Number(pick.roundId) || null,
      roundPick: Number(pick.roundPickNumber) || null,
      teamId: Number(pick.teamId) || null,
      playerId: filled ? playerId : null,
      firstName: filled ? names.firstName : '',
      lastName: filled ? names.lastName : '',
      fullName: filled ? (player?.fullName || names.lastName) : '',
      position: filled ? (player?.position || '—') : '',
      proTeam: filled ? (player?.proTeam || 'FA') : '',
      keeper: Boolean(pick.keeper),
      filled
    };
  });

  const rounds = Math.max(
    0,
    ...picks.map((p) => Number(p.round) || 0),
    Number(settings.availableSlots || 0) && columnIds.length
      ? Math.ceil(Number(settings.availableSlots) / columnIds.length)
      : 0
  );

  const byTeamRound = new Map();
  for (const pick of picks) {
    if (!pick.teamId || !pick.round) continue;
    byTeamRound.set(`${pick.teamId}:${pick.round}`, pick);
  }

  const board = [];
  for (let round = 1; round <= rounds; round += 1) {
    board.push({
      round,
      cells: columnIds.map((teamId) => byTeamRound.get(`${teamId}:${round}`) || {
        overall: null,
        round,
        roundPick: null,
        teamId,
        playerId: null,
        firstName: '',
        lastName: '',
        fullName: '',
        position: '',
        proTeam: '',
        keeper: false,
        filled: false
      })
    });
  }

  const filledCount = picks.filter((p) => p.filled).length;
  const drafted = Boolean(draftDetail.drafted) || (filledCount > 0 && !draftDetail.inProgress);
  const inProgress = Boolean(draftDetail.inProgress);

  return {
    ok: true,
    season,
    conference: {
      key: conference.key,
      name: conference.name,
      shortName: conference.shortName,
      logo: conference.logo || null,
      leagueId: espnLeagueId
    },
    draft: {
      type: settings.type || 'SNAKE',
      drafted,
      inProgress,
      visible: drafted || inProgress || filledCount > 0,
      filledCount,
      totalSlots: picks.length || (rounds * columnIds.length),
      rounds,
      auctionBudget: settings.auctionBudget || null
    },
    columns: columnIds.map((id) => teamsById.get(id)),
    board,
    picks,
    generatedAt: new Date().toISOString()
  };
}

function historySeasonEntries() {
  const configured = leagues.normalizeHistorySeasons
    ? leagues.normalizeHistorySeasons(config.historySeasons || [])
    : (Array.isArray(config.historySeasons) ? config.historySeasons : []);
  const current = Number(config.season);
  const maxPriorYear = configured.reduce((max, row) => Math.max(max, Number(row.yearNumber) || 0), 0);
  const currentYearNumber = maxPriorYear > 0 ? maxPriorYear + 1 : (configured.length ? configured.length + 1 : null);
  const entries = [
    {
      season: current,
      yearNumber: currentYearNumber,
      label: currentYearNumber
        ? `Year ${currentYearNumber} (${current}) · current`
        : `${current} (current)`,
      inaugural: configured.length === 0,
      detailEspnLeagueId: config.conferences.find((c) => c.key === 'detail')?.espnLeagueId || null,
      overtimeEspnLeagueId: config.conferences.find((c) => c.key === 'overtime')?.espnLeagueId || null,
      notes: configured.length
        ? null
        : 'Add prior seasons in League Tools → Season Archive so managers can view standings and draft boards.'
    },
    ...configured.map((row) => ({
      season: Number(row.season),
      yearNumber: row.yearNumber || null,
      label: row.label || String(row.season),
      inaugural: false,
      detailEspnLeagueId: row.detailEspnLeagueId || null,
      overtimeEspnLeagueId: row.overtimeEspnLeagueId || null,
      notes: row.notes || null
    }))
  ];
  const seen = new Set();
  return entries.filter((e) => {
    if (!Number.isFinite(e.season) || seen.has(e.season)) return false;
    seen.add(e.season);
    return true;
  }).sort((a, b) => b.season - a.season);
}

async function loadHistorySeason(seasonParam) {
  const season = Number(seasonParam) || Number(config.season);
  const catalog = historySeasonEntries();
  const entry = catalog.find((e) => e.season === season) || catalog[0];
  const conferences = [];
  const fetchedIds = new Map();

  for (const conf of config.conferences) {
    const leagueId = conf.key === 'detail'
      ? entry.detailEspnLeagueId
      : (conf.key === 'overtime' ? entry.overtimeEspnLeagueId : conf.espnLeagueId);
    if (!leagueId) {
      // Pre-split archives often only have one ESPN league — skip empty side quietly.
      if (entry.detailEspnLeagueId || entry.overtimeEspnLeagueId) continue;
      conferences.push({
        ok: false,
        key: conf.key,
        name: conf.name,
        shortName: conf.shortName,
        logo: conf.logo || null,
        error: 'No ESPN league ID configured for this season'
      });
      continue;
    }
    if (fetchedIds.has(leagueId)) {
      // Same ESPN league mapped to both conferences (legacy single-league years).
      continue;
    }
    const confForFetch = { ...conf, espnLeagueId: leagueId };
    try {
      const raw = await fetchEspnRaw(confForFetch, ['mTeam', 'mSettings', 'mStatus'], 'history', {}, season);
      const data = normalizeLeague(raw, confForFetch);
      const singleLeague = entry.detailEspnLeagueId
        && entry.overtimeEspnLeagueId
        && Number(entry.detailEspnLeagueId) === Number(entry.overtimeEspnLeagueId);
      const onlyOneConfigured = Boolean(entry.detailEspnLeagueId) !== Boolean(entry.overtimeEspnLeagueId)
        || singleLeague
        || (!entry.overtimeEspnLeagueId && entry.detailEspnLeagueId)
        || (!entry.detailEspnLeagueId && entry.overtimeEspnLeagueId);
      fetchedIds.set(leagueId, true);
      conferences.push({
        ok: true,
        ...data,
        key: onlyOneConfigured ? 'archive' : conf.key,
        name: onlyOneConfigured
          ? (data.espnLeagueName || `Season ${season}`)
          : conf.name,
        shortName: onlyOneConfigured ? String(season) : conf.shortName,
        logo: onlyOneConfigured ? (config.brand?.logo || conf.logo || null) : (conf.logo || null),
        leagueId,
        admin: data.admin || conferenceAdminName(conf.key)
      });
    } catch (error) {
      conferences.push({
        ok: false,
        key: conf.key,
        name: conf.name,
        shortName: conf.shortName,
        logo: conf.logo || null,
        leagueId,
        error: error.message || 'Could not load season',
        detail: error.detail || null
      });
    }
  }

  return {
    ok: true,
    season,
    seasons: catalog,
    entry,
    brand: config.brand,
    espnAuthConfigured: Boolean(process.env.ESPN_SWID && process.env.ESPN_S2),
    conferences,
    generatedAt: new Date().toISOString()
  };
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
    const proTeamId = player.proTeamId || null;
    return {
      id: player.id || entry.playerId || null,
      name: playerName(player),
      position: POSITION_LABELS[player.defaultPositionId] || '—',
      slotId,
      slot: SLOT_LABELS[slotId] || `Slot ${slotId}`,
      proTeamId,
      proTeam: PRO_TEAM_ABBREV[proTeamId] || 'FA',
      byeWeek: byeWeekForProTeam(proTeamId),
      injuryStatus: player.injuryStatus || null,
      acquisitionType: entry.acquisitionType || pool.acquisitionType || null,
      weekPoints: null,
      weekProjected: null
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

function collectPlayerWeekStats(raw, teamId, week) {
  const map = new Map();
  const tid = Number(teamId);
  for (const match of (raw?.schedule || [])) {
    if (Number(match.matchupPeriodId) !== Number(week)) continue;
    for (const sideKey of ['home', 'away']) {
      const side = match[sideKey];
      if (!side || Number(side.teamId) !== tid) continue;
      for (const entry of matchupSideEntries(side)) {
        const pool = entry.playerPoolEntry || {};
        const player = pool.player || {};
        const pid = Number(player.id || entry.playerId);
        if (!Number.isFinite(pid) || pid <= 0) continue;
        map.set(pid, {
          points: playerWeekPoints(entry, week),
          projected: playerWeekProjected(entry, week)
        });
      }
    }
  }
  return map;
}

function applyWeekStatsToRoster(roster, statsMap) {
  return (roster || []).map((p) => {
    const hit = p?.id != null ? statsMap.get(Number(p.id)) : null;
    return {
      ...p,
      weekPoints: hit?.points ?? null,
      weekProjected: hit?.projected ?? null
    };
  });
}

async function loadTeamDetail(conferenceKey, teamId) {
  const conference = resolveEspnLeague(conferenceKey);
  if (!conference) throw Object.assign(new Error('Unknown conference'), { status: 404 });
  const raw = await fetchEspnRaw(conference, ['mTeam', 'mRoster', 'mStatus'], `roster:${teamId}`);
  const membersById = new Map((raw.members || []).map((m) => [m.id, m]));
  const team = (raw.teams || []).find((t) => Number(t.id) === Number(teamId));
  if (!team) throw Object.assign(new Error('Team not found'), { status: 404 });
  const detail = normalizeRosterTeam(team, conference, membersById);
  const scheduleRaw = await fetchEspnRaw(
    conference,
    ['mTeam', 'mMatchup', 'mScoreboard', 'mStatus'],
    'matchup-scoreboard'
  );
  const currentWeek = Number(scheduleRaw.status?.currentMatchupPeriod || 1);
  const schedule = normalizeSchedule(scheduleRaw, conference, currentWeek);
  const weekStats = collectPlayerWeekStats(scheduleRaw, teamId, currentWeek);
  detail.roster = applyWeekStatsToRoster(detail.roster, weekStats);

  let currentMatchup = null;
  for (const m of schedule.matchups || []) {
    if (Number(m.home?.id) === Number(teamId) || Number(m.away?.id) === Number(teamId)) {
      currentMatchup = {
        week: currentWeek,
        ...m,
        isHome: Number(m.home?.id) === Number(teamId)
      };
      break;
    }
  }

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
      logo: conference.logo,
      kind: conference.kind || 'conference'
    },
    team: detail,
    currentMatchup,
    recentMatchups: recent,
    currentMatchupPeriod: currentWeek,
    keeper: keepers.getKeeper(conference.key, teamId, Number(config.season) + 1),
    keeperWindow: keepers.getKeeperWindow(calendar.listEvents(), config.season),
    generatedAt: new Date().toISOString()
  };
}

async function loadConferenceRosters(conferenceKey) {
  const conference = resolveEspnLeague(conferenceKey);
  if (!conference) throw Object.assign(new Error('Unknown conference'), { status: 404 });
  const raw = await fetchEspnRaw(conference, ['mTeam', 'mRoster', 'mMatchup', 'mScoreboard', 'mStatus'], `rosters:${conference.key}`);
  const membersById = new Map((raw.members || []).map((m) => [m.id, m]));
  const currentWeek = Number(raw.status?.currentMatchupPeriod || 1);
  const schedule = normalizeSchedule(raw, conference, currentWeek);
  const teams = (raw.teams || [])
    .map((t) => {
      const detail = normalizeRosterTeam(t, conference, membersById);
      const weekStats = collectPlayerWeekStats(raw, detail.id, currentWeek);
      detail.roster = applyWeekStatsToRoster(detail.roster, weekStats);
      let currentMatchup = null;
      for (const m of schedule.matchups || []) {
        if (Number(m.home?.id) === Number(detail.id) || Number(m.away?.id) === Number(detail.id)) {
          currentMatchup = {
            week: currentWeek,
            ...m,
            isHome: Number(m.home?.id) === Number(detail.id)
          };
          break;
        }
      }
      return { ...detail, currentMatchup };
    })
    .sort((a, b) => Number(a.playoffSeed || 99) - Number(b.playoffSeed || 99) || a.name.localeCompare(b.name));

  return {
    ok: true,
    conference: {
      key: conference.key,
      name: conference.name,
      shortName: conference.shortName,
      logo: conference.logo,
      kind: conference.kind || 'conference'
    },
    week: currentWeek,
    teams,
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
  const [bowl, survival] = await Promise.all([
    buildBowlPayload(),
    buildSurvivalPayload()
  ]);

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
    bowl,
    survival
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

function collectInjuredStarterFindings(raw, conference) {
  const findings = [];
  const logoOverrides = logos.getOverrideMap();
  const nameOverrides = logos.getNameOverrideMap();
  for (const team of raw.teams || []) {
    const key = logos.logoKey(conference.key, team.id);
    const espnName = (team.name || `${team.location || ''} ${team.nickname || ''}`).trim() || `Team ${team.id}`;
    const teamName = nameOverrides.get(key) || espnName;
    const teamLogo = logos.displayLogoUrl(logoOverrides.get(key));
    for (const entry of team.roster?.entries || []) {
      const slotId = Number(entry.lineupSlotId);
      if (BENCH_OR_IR_SLOTS.has(slotId)) continue;
      const pool = entry.playerPoolEntry || {};
      const player = pool.player || {};
      const injuryStatus = player.injuryStatus || null;
      if (!rosterViolations.isViolationInjuryStatus(injuryStatus)) continue;
      const playerId = player.id || entry.playerId;
      if (playerId == null) continue;
      findings.push({
        conferenceKey: conference.key,
        conferenceName: conference.name,
        teamId: Number(team.id),
        teamName,
        teamLogo,
        playerId: Number(playerId),
        playerName: playerName(player),
        position: POSITION_LABELS[player.defaultPositionId] || '—',
        slotId,
        slot: SLOT_LABELS[slotId] || `Slot ${slotId}`,
        injuryStatus: rosterViolations.normalizeInjuryLabel(injuryStatus)
      });
    }
  }
  return findings;
}

async function scanRosterViolationsAcrossConferences() {
  const weekCandidates = [];
  const findings = [];
  const conferenceErrors = [];

  for (const conference of listEspnLeagues()) {
    try {
      const raw = await fetchEspnRaw(conference, ['mTeam', 'mRoster', 'mStatus'], 'roster-violations');
      const week = Number(raw.status?.currentMatchupPeriod || 0) || null;
      if (week) weekCandidates.push(week);
      findings.push(...collectInjuredStarterFindings(raw, conference));
    } catch (err) {
      conferenceErrors.push({
        conferenceKey: conference.key,
        error: err.name === 'AbortError' ? 'ESPN request timed out' : (err.message || 'ESPN error')
      });
    }
  }

  const week = weekCandidates.sort((a, b) => b - a)[0] || 1;
  return { findings, week, conferenceErrors };
}

async function notifyRosterViolationManagers(openRows, { force = false, week } = {}) {
  const byTeam = new Map();
  for (const row of openRows || []) {
    if (!rosterViolations.needsWarning(row, { force })) continue;
    const key = `${row.conferenceKey}:${row.teamId}`;
    if (!byTeam.has(key)) byTeam.set(key, []);
    byTeam.get(key).push(row);
  }

  const results = [];
  const warnedKeys = [];

  for (const [, rows] of byTeam) {
    const sample = rows[0];
    const claim = logos.getClaimForTeam(sample.conferenceKey, sample.teamId);
    const ownerUser = claim ? users.findById(claim.userId) : null;
    const email = ownerUser?.email || null;
    if (!email) {
      results.push({
        conferenceKey: sample.conferenceKey,
        teamId: sample.teamId,
        teamName: sample.teamName,
        sent: false,
        skipped: claim ? 'missing_email' : 'unclaimed',
        playerCount: rows.length
      });
      continue;
    }

    const sendResult = await sendRosterViolationEmail({
      to: email,
      recipientName: ownerUser.name || claim.ownerName || 'Manager',
      teamName: sample.teamName,
      conferenceName: sample.conferenceName,
      conferenceKey: sample.conferenceKey,
      week: week || sample.week,
      players: rows.map((r) => ({
        playerName: r.playerName,
        position: r.position,
        slot: r.slot,
        injuryStatus: r.injuryStatus
      }))
    });

    if (sendResult.sent || sendResult.method === 'log') {
      for (const r of rows) warnedKeys.push(r.key);
    }
    results.push({
      conferenceKey: sample.conferenceKey,
      teamId: sample.teamId,
      teamName: sample.teamName,
      email,
      playerCount: rows.length,
      ...sendResult
    });
  }

  if (warnedKeys.length) rosterViolations.markWarned(warnedKeys);
  return results;
}

async function runRosterViolationsJob({
  triggeredBy = 'system',
  notify = true,
  forceNotify = false,
  onlyIfFirstQuarter = false
} = {}) {
  let firstQuarter = null;
  if (onlyIfFirstQuarter) {
    firstQuarter = await nflverseLive.getFirstQuarterPatrolState({
      season: config.season,
      seasontype: 2
    });
    if (!firstQuarter.active) {
      return {
        ok: true,
        skipped: true,
        reason: 'no_first_quarter_games',
        triggeredBy,
        season: config.season,
        firstQuarter,
        openCount: rosterViolations.listOpen({ season: config.season }).length,
        generatedAt: new Date().toISOString()
      };
    }
  }

  const { findings, week, conferenceErrors } = await scanRosterViolationsAcrossConferences();
  const merged = rosterViolations.mergeScan({
    season: config.season,
    week,
    findings,
    triggeredBy
  });
  const open = rosterViolations.listOpen({ season: config.season, week });
  let notifications = [];
  if (notify) {
    notifications = await notifyRosterViolationManagers(open, { force: forceNotify, week });
  }
  return {
    ok: true,
    skipped: false,
    season: config.season,
    week,
    lastScan: merged.lastScan,
    openCount: open.length,
    open,
    created: merged.created,
    resolved: merged.resolved,
    unchanged: merged.unchanged,
    conferenceErrors,
    notifications,
    firstQuarter,
    mail: mailConfig(),
    generatedAt: new Date().toISOString()
  };
}

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

async function fantasyLeadersForConference(conference, weekParam, cachePrefix = 'leaders') {
  try {
    const base = await fetchEspnRaw(conference, ['mTeam', 'mMatchup', 'mStatus'], `${cachePrefix}-base`);
    const week = Number(weekParam || base.status?.currentMatchupPeriod || 1);
    const raw = await fetchEspnRaw(
      conference,
      ['mTeam', 'mMatchup', 'mScoreboard', 'mStatus'],
      `${cachePrefix}:${week}`,
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
}

async function apiFantasyLeaders(res, weekParam, leagueScope = null) {
  let results;
  if (leagueScope?.scope === 'aaa') {
    const affiliate = getAffiliatedLeague(leagueScope.conferenceKey || 'aaa');
    const espnId = Number(affiliate?.espnLeagueId);
    if (!affiliate || !Number.isFinite(espnId) || espnId <= 0) {
      return sendJson(res, 200, {
        ok: true,
        season: config.season,
        week: Number(weekParam || 1),
        hasLivePoints: false,
        leagueScope,
        generatedAt: new Date().toISOString(),
        players: [],
        teams: [],
        conferences: []
      });
    }
    const conference = {
      key: affiliate.key,
      name: affiliate.name,
      shortName: affiliate.shortName || 'AAA',
      espnLeagueId: espnId,
      logo: affiliate.logo || '/assets/aaa-league.png'
    };
    results = [await fantasyLeadersForConference(conference, weekParam, 'aaa-leaders')];
  } else {
    results = await Promise.all(
      config.conferences.map((conference) => fantasyLeadersForConference(conference, weekParam))
    );
  }

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
    leagueScope: leagueScope || { scope: 'gridiron' },
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

async function scheduleForConference(conference, weekParam, cacheTag = 'matchup') {
  try {
    const raw = await fetchEspnRaw(conference, ['mTeam', 'mMatchup', 'mStatus'], cacheTag);
    const week = Number(weekParam || raw.status?.currentMatchupPeriod || 1);
    return { ok: true, ...normalizeSchedule(raw, conference, week) };
  } catch (error) {
    return {
      ok: false,
      key: conference.key,
      name: conference.name,
      shortName: conference.shortName,
      logo: conference.logo || null,
      error: error.name === 'AbortError' ? 'ESPN request timed out' : error.message
    };
  }
}

async function apiSchedule(res, weekParam, leagueScope = null) {
  let results;
  if (leagueScope?.scope === 'aaa') {
    const affiliate = getAffiliatedLeague(leagueScope.conferenceKey || 'aaa');
    const espnId = Number(affiliate?.espnLeagueId);
    if (!affiliate || !Number.isFinite(espnId) || espnId <= 0) {
      return sendJson(res, 200, {
        season: config.season,
        week: Number(weekParam || 1),
        leagueScope,
        generatedAt: new Date().toISOString(),
        conferences: [{
          ok: false,
          key: 'aaa',
          name: affiliate?.name || 'AAA League',
          shortName: affiliate?.shortName || 'AAA',
          logo: affiliate?.logo || '/assets/aaa-league.png',
          error: 'AAA League ESPN ID is not configured yet'
        }]
      });
    }
    const conference = {
      key: affiliate.key,
      name: affiliate.name,
      shortName: affiliate.shortName || 'AAA',
      espnLeagueId: espnId,
      logo: affiliate.logo || '/assets/aaa-league.png'
    };
    results = [await scheduleForConference(conference, weekParam, 'aaa-matchup')];
  } else {
    results = await Promise.all(
      config.conferences.map((conference) => scheduleForConference(conference, weekParam))
    );
  }

  const week = results.find((r) => r.ok)?.week || Number(weekParam || 1);
  sendJson(res, 200, {
    season: config.season,
    week,
    leagueScope: leagueScope || { scope: 'gridiron' },
    generatedAt: new Date().toISOString(),
    conferences: results
  });
}

async function apiLeagues(res) {
  const results = await Promise.all(
    config.conferences.map(async (conference) => {
      try {
        const data = await fetchEspnLeague(conference);
        return { ok: true, ...data, admin: data.admin || conferenceAdminName(conference.key) };
      } catch (error) {
        return {
          ok: false,
          key: conference.key,
          name: conference.name,
          shortName: conference.shortName,
          leagueId: conference.espnLeagueId,
          logo: conference.logo || null,
          admin: conferenceAdminName(conference.key),
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
        return { ok: true, ...data, admin: data.admin || conferenceAdminName(conference.key) };
      } catch (error) {
        return {
          ok: false,
          key: conference.key,
          name: conference.name,
          shortName: conference.shortName,
          leagueId: conference.espnLeagueId,
          logo: conference.logo || null,
          admin: conferenceAdminName(conference.key),
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

function survivalSideFromConference(standConf, survivalConf, confMeta, label) {
  const teams = standConf?.ok ? (standConf.teams || []) : [];
  const last = teams.length ? teams[teams.length - 1] : null;
  const scoring = last ? teamWeekEntry(survivalConf, last.id) : null;
  const matchupCount = (survivalConf?.matchups || []).length;
  return {
    conferenceKey: confMeta?.key || standConf?.key || survivalConf?.key || null,
    conferenceName: label,
    ok: Boolean(standConf?.ok && survivalConf?.ok),
    team: last
      ? {
          id: last.id,
          name: last.name,
          logo: last.logo || null,
          wins: last.wins,
          losses: last.losses,
          ties: last.ties,
          pointsFor: last.pointsFor
        }
      : null,
    score: scoring ? Number(scoring.score || 0) : null,
    projected: scoring ? Number(scoring.projected || 0) : null,
    hasWeek17Matchup: Boolean(scoring),
    week17MatchupCount: matchupCount,
    espnOpponent: scoring?.opponentName || null
  };
}

async function buildSurvivalPayload() {
  const survivalCfg = config.survival || { enabled: true, week: 17, name: "Mayor's Cup" };
  if (survivalCfg.enabled === false) {
    return {
      ok: true,
      enabled: false,
      season: config.season,
      name: survivalCfg.name || "Mayor's Cup",
      week: Number(survivalCfg.week) || 17,
      sides: [],
      phase: 'disabled',
      message: "Mayor's Cup is disabled for this season.",
      generatedAt: new Date().toISOString()
    };
  }

  const SURVIVAL_WEEK = Number(survivalCfg.week) || Number(config.championship?.bowlWeek) || 17;
  const survivalName = survivalCfg.name || "Mayor's Cup";
  const [standings, survivalWeek] = await Promise.all([
    loadStandingsPayload(),
    loadSchedulePayload(SURVIVAL_WEEK)
  ]);

  const standByKey = new Map((standings.conferences || []).map((c) => [c.key, c]));
  const weekByKey = new Map((survivalWeek.conferences || []).map((c) => [c.key, c]));
  const confs = config.conferences || [];
  const sides = confs.map((conf) =>
    survivalSideFromConference(
      standByKey.get(conf.key),
      weekByKey.get(conf.key),
      conf,
      `${conf.shortName || conf.name} Last Place`
    )
  );

  while (sides.length < 2) {
    sides.push({
      team: null,
      score: null,
      hasWeek17Matchup: false,
      conferenceKey: null,
      conferenceName: null
    });
  }

  const left = sides[0];
  const right = sides[1];
  const teamsReady = Boolean(left.team && right.team);
  const scoresReady = Boolean(left.hasWeek17Matchup && right.hasWeek17Matchup);
  let phase = 'waiting';
  let message = `${survivalName}: last place in each conference meet in Week ${SURVIVAL_WEEK}. Scores pull from each team’s ESPN Week ${SURVIVAL_WEEK} lineup.`;

  if (teamsReady && scoresReady) {
    const d = Number(left.score || 0);
    const o = Number(right.score || 0);
    if (d > 0 || o > 0) {
      phase = 'live';
      message = `Live ESPN Week ${SURVIVAL_WEEK} scoring · ${confs[0]?.shortName || 'A'} last vs ${confs[1]?.shortName || 'B'} last`;
    } else {
      phase = 'ready';
      message = `Cellar dwellers locked. Waiting on Week ${SURVIVAL_WEEK} NFL kickoff for ESPN scores.`;
    }
  } else if (teamsReady && !scoresReady) {
    phase = 'needs_week17';
    message = `Last-place teams are set, but ESPN needs a Week ${SURVIVAL_WEEK} matchup for each so lineups score.`;
  } else if ((weekByKey.get(confs[0]?.key)?.matchups || []).length || (weekByKey.get(confs[1]?.key)?.matchups || []).length) {
    phase = 'week17_open';
    message = `Week ${SURVIVAL_WEEK} ESPN matchups exist. Survival names fill from conference standings.`;
  }

  let leader = null;
  let winner = null;
  let loser = null;
  if (teamsReady && scoresReady) {
    const d = Number(left.score || 0);
    const o = Number(right.score || 0);
    if (d > o) {
      leader = confs[0]?.key || 'left';
      winner = left.team;
      loser = right.team;
    } else if (o > d) {
      leader = confs[1]?.key || 'right';
      winner = right.team;
      loser = left.team;
    } else if (d > 0 || o > 0) {
      leader = 'tie';
    }
  }

  const byKey = {};
  confs.forEach((c, i) => {
    byKey[c.key] = sides[i];
  });

  return {
    ok: true,
    enabled: true,
    season: config.season,
    name: survivalName,
    week: SURVIVAL_WEEK,
    phase,
    message,
    leader,
    winner,
    loser,
    stakes: {
      winner: 'Stays in GridIron 24',
      loser: 'Leaves GridIron 24'
    },
    sides,
    detail: byKey.detail || left,
    overtime: byKey.overtime || right,
    generatedAt: new Date().toISOString()
  };
}

function isAffiliateLeagueKey(key) {
  const k = String(key || '').trim().toLowerCase();
  if (!k) return false;
  return (config.affiliatedLeagues || []).some((l) => String(l.key || '').toLowerCase() === k);
}

/** Profile-based HQ landing. Site owner uses preferred-league cookie; others use claim/admin. */
function homePathForUser(user, req = null) {
  if (!user) return '/home.html';
  if (users.isSiteOwner(user)) {
    const preferred = getPreferredLeague(req) || 'gridiron';
    return preferred === 'aaa' ? '/aaa.html' : '/home.html';
  }
  try {
    const claim = logos.getClaimForUser(user.id);
    if (claim?.conferenceKey && isAffiliateLeagueKey(claim.conferenceKey)) {
      return claim.conferenceKey === 'aaa' ? '/aaa.html' : `/${claim.conferenceKey}.html`;
    }
  } catch { /* ignore */ }
  if (user.role === 'conference_admin' && isAffiliateLeagueKey(user.conference)) {
    return user.conference === 'aaa' ? '/aaa.html' : `/${user.conference}.html`;
  }
  return '/home.html';
}

/**
 * One-time welcome inbox on first successful login / session.
 * Copy lives in welcome-message.js — edit there anytime.
 */
function deliverWelcomeInboxIfNeeded(user) {
  if (!user?.id || user.approved === false) return null;
  if (!users.claimWelcomeInbox(user.id)) return null;
  try {
    const msg = welcomeMessage.buildWelcome({ name: user.name || user.loginName });
    return inbox.sendMessage({
      toUserId: user.id,
      from: { name: msg.fromName },
      subject: msg.subject,
      body: msg.body,
      type: msg.type || 'welcome',
      meta: { kind: 'first_login_welcome' }
    });
  } catch (err) {
    console.warn('[welcome-inbox] failed', err.message || err);
    return null;
  }
}

/**
 * Which league HQ/nav/scoreboard a user should see.
 * Site owner: preferred-league cookie (exclusive switcher).
 * Members: claim / conference_admin assignment.
 */
function leagueScopeForUser(user, req = null) {
  const canSwitch = users.isSiteOwner(user);
  if (!user) {
    return {
      scope: 'gridiron',
      conferenceKey: null,
      homePath: '/home.html',
      label: 'GridIron 24',
      canSwitchLeagues: false,
      preferredLeague: null
    };
  }

  if (canSwitch) {
    const preferred = getPreferredLeague(req) || 'gridiron';
    if (preferred === 'aaa') {
      const affiliate = getAffiliatedLeague('aaa');
      return {
        scope: 'aaa',
        conferenceKey: 'aaa',
        homePath: '/aaa.html',
        label: affiliate?.name || 'AAA League',
        canSwitchLeagues: true,
        preferredLeague: 'aaa'
      };
    }
    return {
      scope: 'gridiron',
      conferenceKey: null,
      homePath: '/home.html',
      label: 'GridIron 24',
      canSwitchLeagues: true,
      preferredLeague: 'gridiron'
    };
  }

  let conferenceKey = null;
  try {
    const claim = logos.getClaimForUser(user.id);
    if (claim?.conferenceKey) conferenceKey = String(claim.conferenceKey).toLowerCase();
  } catch { /* ignore */ }
  if (!conferenceKey && user.role === 'conference_admin' && user.conference) {
    conferenceKey = String(user.conference).toLowerCase();
  }
  if (conferenceKey && isAffiliateLeagueKey(conferenceKey)) {
    const affiliate = getAffiliatedLeague(conferenceKey);
    return {
      scope: 'aaa',
      conferenceKey,
      homePath: homePathForUser(user, req),
      label: affiliate?.name || (conferenceKey === 'aaa' ? 'AAA League' : conferenceKey),
      canSwitchLeagues: false,
      preferredLeague: null
    };
  }
  return {
    scope: 'gridiron',
    conferenceKey: conferenceKey || null,
    homePath: homePathForUser(user, req),
    label: 'GridIron 24',
    canSwitchLeagues: false,
    preferredLeague: null
  };
}

/** GridIron-only HTML pages — AAA assignees are redirected to the AAA portal. */
const GRIDIRON_ONLY_PAGES = new Set([
  '/standings.html',
  '/teams.html',
  '/draft.html',
  '/history.html',
  '/transactions.html',
  '/rankings.html',
  '/schedules.html',
  '/playoffs.html'
]);

function isDefaultHomeNext(nextPath) {
  const value = String(nextPath || '').trim();
  if (!value) return true;
  try {
    const url = new URL(value, 'http://local');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    return path === '/'
      || path === '/home'
      || path === '/home.html'
      || path === '/hq'
      || path === '/index.html';
  } catch {
    return value === '/home.html' || value === '/home' || value === '/hq' || value === '/';
  }
}

function getAffiliatedLeague(key = 'aaa') {
  const list = Array.isArray(config.affiliatedLeagues) ? config.affiliatedLeagues : [];
  return list.find((l) => l.key === key) || list[0] || null;
}

/** GridIron conferences plus affiliated leagues (for admin assignment keys). */
function listAdminLeagues() {
  const main = (config.conferences || []).map((c) => ({
    key: c.key,
    name: c.name,
    shortName: c.shortName,
    espnLeagueId: c.espnLeagueId,
    logo: c.logo || null,
    kind: 'conference'
  }));
  const affiliates = (config.affiliatedLeagues || []).map((l) => ({
    key: l.key,
    name: l.name,
    shortName: l.shortName || l.name,
    espnLeagueId: l.espnLeagueId,
    logo: l.logo || null,
    kind: 'affiliate'
  }));
  return [...main, ...affiliates];
}

/** Leagues with a usable ESPN ID (rosters, violations, schedules). */
function listEspnLeagues() {
  return listAdminLeagues().filter((l) => {
    const id = Number(l.espnLeagueId);
    return Number.isFinite(id) && id > 0;
  }).map((l) => ({
    ...l,
    espnLeagueId: Number(l.espnLeagueId)
  }));
}

function resolveEspnLeague(key) {
  const k = String(key || '').trim().toLowerCase();
  if (!k) return null;
  return listEspnLeagues().find((l) => l.key === k) || null;
}

function aaaPayoutsFromAffiliate(affiliate) {
  const p = affiliate?.payouts || {};
  const buyIn = Number(p.buyInPerTeam);
  const min = Number(p.teamCountMin) || 10;
  const max = Number(p.teamCountMax) || 14;
  const fixed = Number(p.teamCount);
  const teamCount = Number.isFinite(fixed) && fixed > 0 ? fixed : null;
  const prizes = Array.isArray(p.prizes) ? p.prizes : [];
  const resolvedBuyIn = Number.isFinite(buyIn) ? buyIn : 50;
  return {
    seasonLabel: p.seasonLabel || 'AAA Season',
    buyInPerTeam: resolvedBuyIn,
    teamCountMin: min,
    teamCountMax: max,
    teamCount,
    teamCountLabel: teamCount
      ? String(teamCount)
      : `${min}–${max} (interest)`,
    currency: p.currency || 'USD',
    notes: p.notes || '',
    prizes: prizes.map((row, index) => ({
      place: Number(row.place) || index + 1,
      label: String(row.label || `Place ${index + 1}`).trim(),
      amount: Number(row.amount) || 0
    })),
    poolMin: resolvedBuyIn * min,
    poolMax: resolvedBuyIn * max,
    pool: teamCount != null ? resolvedBuyIn * teamCount : null
  };
}

function teamHeatIndex(t) {
  const winStreak = t.streakType === 'WIN' ? Number(t.streakLength || 0) : 0;
  const lossStreak = t.streakType === 'LOSS' ? Number(t.streakLength || 0) : 0;
  const ppg = Number(t.pointsPerGame || 0);
  const pf = Number(t.pointsFor || 0);
  return winStreak * 55 + ppg * 2.2 + pf * 0.08 - lossStreak * 40;
}

function teamColdIndex(t) {
  const winStreak = t.streakType === 'WIN' ? Number(t.streakLength || 0) : 0;
  const lossStreak = t.streakType === 'LOSS' ? Number(t.streakLength || 0) : 0;
  const ppg = Number(t.pointsPerGame || 0);
  const pf = Number(t.pointsFor || 0);
  return lossStreak * 55 - ppg * 2.2 - pf * 0.08 - winStreak * 40;
}

function pickHotCold(teams) {
  const list = Array.isArray(teams) ? teams.slice() : [];
  const slim = (t) => (t
    ? {
        id: t.id,
        name: t.name,
        logo: t.logo || null,
        wins: t.wins,
        losses: t.losses,
        ties: t.ties,
        streakType: t.streakType,
        streakLength: t.streakLength,
        pointsFor: t.pointsFor,
        pointsPerGame: t.pointsPerGame,
        gamesPlayed: t.gamesPlayed
      }
    : null);
  if (list.length < 2) {
    return { hot: slim(list[0]), cold: null };
  }
  const byHeat = list.slice().sort((a, b) => teamHeatIndex(b) - teamHeatIndex(a));
  const hot = byHeat[0];
  const byCold = list
    .filter((t) => t.id !== hot.id)
    .sort((a, b) => teamColdIndex(b) - teamColdIndex(a));
  const cold = byCold[0] || byHeat[byHeat.length - 1];
  return { hot: slim(hot), cold: slim(cold) };
}

async function loadGridironOfficialScoringSummary() {
  try {
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
    const official = sync.officialScoring;
    const useOfficial = Boolean(official && (cmp.matched || sync.lastCheck?.matched));
    const scoring = useOfficial
      ? {
          ok: true,
          source: 'official',
          key: official.conferenceKey,
          name: official.conferenceName,
          shortName: official.shortName,
          playerRankType: official.playerRankType,
          scoringType: official.scoringType,
          scoringItems: refreshScoringDisplays(official.scoringItems),
          lineup: official.lineup
        }
      : detail
        ? {
            ...detail,
            source: 'live-detail',
            scoringItems: refreshScoringDisplays(detail.scoringItems)
          }
        : null;
    return {
      scoring,
      gridironSynced: Boolean(cmp.matched),
      source: scoring?.source || null
    };
  } catch {
    return { scoring: null, gridironSynced: false, source: null };
  }
}

function compareAaaScoringToGridiron(gridironScoring, aaaSettings) {
  if (!gridironScoring || !aaaSettings) return null;
  const cmp = compareSettings(
    { ...gridironScoring, ok: true },
    { ...aaaSettings, ok: true }
  );
  const diffs = (cmp.diffs || []).filter((d) => d.kind === 'Scoring' || d.kind === 'Lineup' || d.kind === 'Setting');
  return {
    matched: diffs.length === 0,
    bothOk: true,
    diffCount: diffs.length,
    diffs: diffs.slice(0, 25)
  };
}

async function buildAaaPayload() {
  const affiliate = getAffiliatedLeague('aaa') || {
    key: 'aaa',
    name: 'AAA League',
    shortName: 'AAA',
    espnLeagueId: null,
    role: 'feeder',
    logo: '/assets/aaa-league.png',
    payouts: {
      buyInPerTeam: 50,
      teamCountMin: 10,
      teamCountMax: 14,
      teamCount: null,
      currency: 'USD',
      prizes: []
    }
  };
  const espnId = Number(affiliate.espnLeagueId);
  const configured = Number.isFinite(espnId) && espnId > 0;
  const payouts = aaaPayoutsFromAffiliate(affiliate);
  const officialPack = await loadGridironOfficialScoringSummary();

  const base = {
    ok: true,
    configured,
    key: affiliate.key,
    name: affiliate.name,
    shortName: affiliate.shortName,
    role: affiliate.role || 'feeder',
    logo: affiliate.logo || '/assets/aaa-league.png',
    season: config.season,
    payouts,
    scoring: officialPack.scoring,
    scoringPolicy: {
      matchesGridiron24: true,
      note: 'AAA is a separate league with its own draft, league admin, and player pool. Scoring and lineup settings mirror GridIron 24 (Detail Conference source of truth) so promotees enter familiar rules.'
    },
    hot: null,
    cold: null,
    week: null,
    matchups: [],
    generatedAt: new Date().toISOString()
  };

  if (!configured) {
    return {
      ...base,
      espnLeagueId: null,
      teams: [],
      champion: null,
      promotee: null,
      scoringSync: null,
      message: 'AAA League ESPN ID is not configured yet. Scoring follows GridIron 24; standings and hot/cold unlock when the ESPN league ID is set.'
    };
  }

  const conference = {
    key: affiliate.key,
    name: affiliate.name,
    shortName: affiliate.shortName,
    espnLeagueId: espnId,
    logo: affiliate.logo || null
  };

  try {
    const [data, settingsRaw, scheduleRaw] = await Promise.all([
      fetchEspnLeague(conference),
      fetchEspnRaw(conference, ['mSettings', 'mStatus'], 'aaa-settings').catch(() => null),
      fetchEspnRaw(conference, ['mTeam', 'mMatchup', 'mStatus'], 'aaa-matchup').catch(() => null)
    ]);
    const teams = data.teams || [];
    const { hot, cold } = pickHotCold(teams);
    const champion = teams[0]
      ? {
          id: teams[0].id,
          name: teams[0].name,
          logo: teams[0].logo || null,
          wins: teams[0].wins,
          losses: teams[0].losses,
          ties: teams[0].ties,
          pointsFor: teams[0].pointsFor
        }
      : null;

    let week = null;
    let matchups = [];
    if (scheduleRaw) {
      week = Number(scheduleRaw.status?.currentMatchupPeriod || 1);
      try {
        matchups = normalizeSchedule(scheduleRaw, conference, week).matchups || [];
      } catch {
        matchups = [];
      }
    }

    let scoringSync = null;
    if (settingsRaw && officialPack.scoring) {
      const aaaSettings = normalizeSettings(settingsRaw, conference);
      scoringSync = compareAaaScoringToGridiron(officialPack.scoring, aaaSettings);
    }

    return {
      ...base,
      ok: true,
      espnLeagueId: espnId,
      espnLeagueName: data.espnLeagueName || null,
      teamCount: teams.length,
      week,
      matchups,
      teams,
      champion,
      promotee: champion
        ? {
            ...champion,
            label: 'Promotes to GridIron 24 next season'
          }
        : null,
      hot,
      cold,
      scoringSync,
      message: champion
        ? `${champion.name} leads AAA standings and is the next-season GridIron 24 promotee (display only).`
        : 'AAA standings loaded; champion TBD.'
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      espnLeagueId: espnId,
      teams: [],
      champion: null,
      promotee: null,
      scoringSync: null,
      week: null,
      matchups: [],
      error: error.name === 'AbortError' ? 'ESPN request timed out' : error.message
    };
  }
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
        authConfigured: true,
        version: buildInfo.version,
        build: buildInfo.build
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

    if (pathname === '/api/cron/roster-violations' && (req.method === 'POST' || req.method === 'GET')) {
      if (!authorizeCron(req)) {
        return sendJson(res, 401, { ok: false, error: 'Invalid cron secret' });
      }
      try {
        const when = String(requestUrl.searchParams.get('when') || '').trim().toLowerCase();
        const onlyIfFirstQuarter = when === 'first-quarter' || when === 'q1';
        const result = await runRosterViolationsJob({
          triggeredBy: onlyIfFirstQuarter ? 'cron-q1' : 'cron',
          notify: requestUrl.searchParams.get('notify') !== '0',
          forceNotify: requestUrl.searchParams.get('force') === '1',
          onlyIfFirstQuarter
        });
        return sendJson(res, 200, result);
      } catch (err) {
        console.error('[roster-violations] cron failed', err);
        return sendJson(res, 500, { ok: false, error: err.message || 'Roster violations scan failed' });
      }
    }

    if (pathname === '/api/auth') {
      const user = getSessionUser(req);
      if (user) deliverWelcomeInboxIfNeeded(user);
      return sendJson(res, 200, {
        authenticated: Boolean(user),
        authConfigured: true,
        user,
        homePath: homePathForUser(user, req),
        leagueScope: leagueScopeForUser(user, req)
      });
    }

    if (pathname === '/api/preferred-league' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      if (!users.isSiteOwner(user)) {
        return sendJson(res, 403, { ok: false, error: 'Only the site owner can switch leagues' });
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const league = String(body.league || '').trim().toLowerCase() === 'aaa' ? 'aaa' : 'gridiron';
      const affiliate = getAffiliatedLeague('aaa');
      const scope = league === 'aaa'
        ? {
            scope: 'aaa',
            conferenceKey: 'aaa',
            homePath: '/aaa.html',
            label: affiliate?.name || 'AAA League',
            canSwitchLeagues: true,
            preferredLeague: 'aaa'
          }
        : {
            scope: 'gridiron',
            conferenceKey: null,
            homePath: '/home.html',
            label: 'GridIron 24',
            canSwitchLeagues: true,
            preferredLeague: 'gridiron'
          };
      return sendJson(res, 200, {
        ok: true,
        preferredLeague: league,
        homePath: scope.homePath,
        leagueScope: scope
      }, { 'Set-Cookie': preferredLeagueCookieHeader(league) });
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
        deliverWelcomeInboxIfNeeded(user);
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
      deliverWelcomeInboxIfNeeded(user);
      const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
      const token = signSession(user.id, expiresAt);
      return sendJson(res, 200, {
        ok: true,
        user,
        homePath: homePathForUser(user, req),
        leagueScope: leagueScopeForUser(user, req)
      }, { 'Set-Cookie': sessionCookieHeader(token) });
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

    if (pathname === '/api/preferences' && req.method === 'POST') {
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
      try {
        const user = users.updatePreferences(sessionUser.id, {
          theme: body.theme
        });
        return sendJson(res, 200, { ok: true, user });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not save preferences' });
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

    if (pathname === '/hq' || pathname === '/home') {
      const user = getSessionUser(req);
      if (!user) {
        res.writeHead(302, { Location: '/enter?next=' + encodeURIComponent('/hq') });
        return res.end();
      }
      res.writeHead(302, {
        Location: homePathForUser(user, req),
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache'
      });
      return res.end();
    }

    if (pathname === '/home.html') {
      const user = getSessionUser(req);
      if (user) {
        const dest = homePathForUser(user, req);
        if (dest !== '/home.html') {
          res.writeHead(302, {
            Location: dest,
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            Pragma: 'no-cache'
          });
          return res.end();
        }
      }
    }

    if (GRIDIRON_ONLY_PAGES.has(pathname)) {
      const user = getSessionUser(req);
      // Site owner may browse either league; members stay scoped to their assignment.
      if (user && !users.isSiteOwner(user) && leagueScopeForUser(user, req).scope === 'aaa') {
        res.writeHead(302, {
          Location: '/aaa.html',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache'
        });
        return res.end();
      }
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
            calendar.ensureDefaults(league.calendarDefaults || []);
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

    if (pathname === '/app' || pathname === '/app/' || pathname === '/app/index.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'app', 'index.html'));
    }

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
        const season = requestUrl.searchParams.get('season');
        const payload = await nflverseLive.getLiveScoring({ week, seasontype, dates, season });
        return sendJson(res, 200, payload);
      } catch (err) {
        return sendJson(res, err.status || 502, {
          ok: false,
          error: err.message || 'Live scoring unavailable'
        });
      }
    }

    if (pathname === '/api/sports-scores' && req.method === 'GET') {
      try {
        const leagues = requestUrl.searchParams.get('leagues');
        const payload = await sportsScoreboard.getSportsScores({ leagues });
        return sendJson(res, 200, payload);
      } catch (err) {
        return sendJson(res, err.status || 502, {
          ok: false,
          error: err.message || 'Sports scores unavailable'
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

    if (pathname === '/api/presence' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      presence.touch(users.publicUser(user));
      return sendJson(res, 200, {
        ok: true,
        online: presence.listOnline(),
        unread: inbox.unreadCount(user.id),
        generatedAt: new Date().toISOString()
      });
    }

    if (pathname === '/api/presence' && req.method === 'GET') {
      const viewer = getSessionUser(req);
      if (!viewer) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      presence.touch(users.publicUser(viewer));
      return sendJson(res, 200, {
        ok: true,
        online: presence.listOnline(),
        viewerId: viewer.id,
        generatedAt: new Date().toISOString()
      });
    }

    if (pathname === '/api/members-chat' && req.method === 'GET') {
      const viewer = getSessionUser(req);
      if (!viewer) {
        return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      }
      presence.touch(users.publicUser(viewer));
      const since = requestUrl.searchParams.get('since');
      const after = requestUrl.searchParams.get('after');
      const limit = Number(requestUrl.searchParams.get('limit') || 120);
      return sendJson(res, 200, {
        ok: true,
        messages: membersChat.listMessages({ limit, since, after }),
        online: presence.listOnline(),
        viewerId: viewer.id,
        generatedAt: new Date().toISOString()
      });
    }

    if (pathname === '/api/members-chat' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const publicAuthor = users.publicUser(user);
        presence.touch(publicAuthor);
        const item = membersChat.addMessage({
          body: body.body,
          author: publicAuthor
        });
        const directory = users.listUsers().filter((u) => u.approved !== false);
        const mentioned = membersChat.resolveMentionedUsers(item.body, {
          users: directory,
          mentionIds: Array.isArray(body.mentions) ? body.mentions : [],
          excludeUserId: publicAuthor.id
        });
        for (const target of mentioned) {
          try {
            inbox.sendMessage({
              toUserId: target.id,
              from: publicAuthor,
              subject: `${publicAuthor.name} mentioned you`,
              body: [
                `${publicAuthor.name} tagged you in the Roll Call Room.`,
                '',
                'Jump back into the Members Lounge to reply.'
              ].join('\n'),
              type: 'chat_mention',
              relatedId: item.id,
              meta: {
                link: '/members.html#room',
                linkLabel: 'Open Roll Call Room',
                chatMessageId: item.id,
                quote: item.body,
                authorName: publicAuthor.name
              }
            });
          } catch { /* don't fail the chat post if inbox write fails */ }
        }
        return sendJson(res, 201, {
          ok: true,
          item,
          mentioned: mentioned.map((u) => ({ id: u.id, name: u.name })),
          online: presence.listOnline()
        });
      } catch (err) {
        return sendJson(res, err.status || 400, {
          ok: false,
          error: err.message || 'Could not post message'
        });
      }
    }

    if (pathname.startsWith('/api/members-chat/') && req.method === 'DELETE') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      const id = pathname.slice('/api/members-chat/'.length).replace(/\/+$/, '');
      try {
        membersChat.deleteMessage(id, users.publicUser(user));
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, err.status || 400, {
          ok: false,
          error: err.message || 'Could not delete message'
        });
      }
    }

    if (pathname === '/api/members' && req.method === 'GET') {
      const viewer = getSessionUser(req);
      if (!viewer) {
        return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      }
      try {
        const roster = users.listLeagueMembers();
        const giBuyIn = Number(config.payouts?.buyInPerTeam || 100);
        const aaaBuyIn = Number(getAffiliatedLeague('aaa')?.payouts?.buyInPerTeam || 50);
        const treasurer = {
          name: config.treasurer?.name || 'Jamie Aceto',
          email: config.treasurer?.email || 'jaceto53@gmail.com',
          venmoUsername: config.treasurer?.venmoUsername || 'jaceto53',
          note: config.treasurer?.note || 'League dues — GridIron 24 HQ'
        };
        const canManage = users.isCommissioner(viewer) || users.isSiteOwner(viewer);
        return sendJson(res, 200, {
          ok: true,
          canManage,
          viewer: users.publicUser(viewer),
          treasurer,
          dues: {
            gridiron: giBuyIn,
            aaa: aaaBuyIn,
            currency: 'USD'
          },
          caps: roster.caps,
          gridiron: roster.gridiron,
          aaa: roster.aaa,
          members: roster.members || [],
          unassigned: canManage ? roster.unassigned : [],
          generatedAt: new Date().toISOString()
        });
      } catch (err) {
        console.error('[members]', err);
        return sendJson(res, err.status || 500, {
          ok: false,
          error: err.message || 'Could not load members'
        });
      }
    }

    if (pathname.startsWith('/api/members/') && req.method === 'POST') {
      const admin = requireCommissioner(req, res);
      if (!admin) return;
      const userId = pathname.slice('/api/members/'.length).replace(/\/+$/, '');
      if (!userId || userId.includes('/')) {
        return sendJson(res, 400, { ok: false, error: 'Invalid member id' });
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const patch = {};
        if (Object.prototype.hasOwnProperty.call(body, 'league')) patch.league = body.league;
        if (Object.prototype.hasOwnProperty.call(body, 'name')) patch.name = body.name;
        if (Object.prototype.hasOwnProperty.call(body, 'duesPaid')) patch.duesPaid = Boolean(body.duesPaid);
        if (body.clearDues) patch.clearDues = true;
        const updated = users.setLeagueMembership(userId, patch);
        return sendJson(res, 200, {
          ok: true,
          user: updated,
          roster: users.listLeagueMembers()
        });
      } catch (err) {
        return sendJson(res, err.status || 400, {
          ok: false,
          error: err.message || 'Could not update member',
          code: err.code || null
        });
      }
    }

    if (pathname === '/api/users' && req.method === 'GET') {
      if (!requireCommissioner(req, res)) return;
      const claims = logos.listClaims();
      const claimByUser = new Map(claims.map((c) => [c.userId, c]));
      const adminLeagues = listAdminLeagues();
      let teamsByConference = {};
      try {
        const leagues = await Promise.all(
          adminLeagues.map(async (conference) => {
            const espnId = Number(conference.espnLeagueId);
            if (!(Number.isFinite(espnId) && espnId > 0)) {
              return { key: conference.key, name: conference.name, kind: conference.kind, teams: [] };
            }
            try {
              const league = await fetchEspnLeague({
                ...conference,
                espnLeagueId: espnId
              });
              return {
                key: conference.key,
                name: conference.name,
                kind: conference.kind,
                teams: (league.teams || []).map((t) => ({
                  id: t.id,
                  name: t.name,
                  owner: t.owner || null
                }))
              };
            } catch {
              return { key: conference.key, name: conference.name, kind: conference.kind, teams: [] };
            }
          })
        );
        for (const league of leagues) teamsByConference[league.key] = league;
      } catch { /* ignore */ }

      return sendJson(res, 200, {
        ok: true,
        users: users.listUsers().map((u) => ({
          ...u,
          claim: claimByUser.get(u.id) || null,
          career: career.listForUser(u.id)
        })),
        claims,
        archiveSeasons: historySeasonEntries(),
        conferences: adminLeagues.map((c) => ({
          key: c.key,
          name: c.name,
          shortName: c.shortName,
          kind: c.kind,
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
            const conference = resolveEspnLeague(conferenceKey);
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

    if (pathname.startsWith('/api/users/') && pathname.endsWith('/career') && req.method === 'GET') {
      if (!requireCommissioner(req, res)) return;
      const userId = pathname.slice('/api/users/'.length, -'/career'.length);
      const target = users.findById(userId);
      if (!target) return sendJson(res, 404, { ok: false, error: 'User not found' });
      return sendJson(res, 200, {
        ok: true,
        user: users.publicUser(target),
        career: career.listForUser(userId)
      });
    }

    if (pathname.startsWith('/api/users/') && pathname.endsWith('/career') && req.method === 'POST') {
      const admin = requireCommissioner(req, res);
      if (!admin) return;
      const userId = pathname.slice('/api/users/'.length, -'/career'.length);
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const target = users.findById(userId);
        if (!target) return sendJson(res, 404, { ok: false, error: 'User not found' });

        const season = Number(body.season);
        let espnLeagueId = Number(body.espnLeagueId) || null;
        let conferenceKey = String(body.conferenceKey || '').trim().toLowerCase() || null;
        let teamId = Number(body.teamId);
        let teamName = String(body.teamName || '').trim();
        let yearNumber = Number(body.yearNumber) || null;
        let label = String(body.label || '').trim() || null;
        let snapshot = {
          ownerName: null,
          wins: null,
          losses: null,
          ties: null,
          pointsFor: null,
          pointsAgainst: null,
          playoffSeed: null
        };

        const archive = historySeasonEntries().find((e) => Number(e.season) === season);
        if (archive) {
          yearNumber = yearNumber || archive.yearNumber || null;
          label = label || archive.label || null;
          if (!espnLeagueId) {
            if (conferenceKey === 'overtime' && archive.overtimeEspnLeagueId) {
              espnLeagueId = Number(archive.overtimeEspnLeagueId);
            } else if (archive.detailEspnLeagueId) {
              espnLeagueId = Number(archive.detailEspnLeagueId);
            } else if (archive.overtimeEspnLeagueId) {
              espnLeagueId = Number(archive.overtimeEspnLeagueId);
            }
          }
        }

        if (espnLeagueId && Number.isFinite(teamId)) {
          try {
            const confForFetch = {
              key: conferenceKey || 'archive',
              name: label || `Season ${season}`,
              shortName: String(season),
              espnLeagueId
            };
            const raw = await fetchEspnRaw(confForFetch, ['mTeam', 'mSettings', 'mStatus'], 'career', {}, season);
            const data = normalizeLeague(raw, confForFetch);
            const found = (data.teams || []).find((t) => Number(t.id) === teamId);
            if (found) {
              teamName = teamName || found.name;
              snapshot = {
                ownerName: found.owner || null,
                wins: found.wins,
                losses: found.losses,
                ties: found.ties,
                pointsFor: found.pointsFor,
                pointsAgainst: found.pointsAgainst,
                playoffSeed: found.playoffSeed
              };
            }
          } catch { /* keep manual fields */ }
        }

        const entry = career.assignPastTeam({
          userId,
          season,
          yearNumber,
          label,
          espnLeagueId,
          conferenceKey,
          teamId,
          teamName,
          ownerName: body.ownerName || snapshot.ownerName,
          wins: body.wins ?? snapshot.wins,
          losses: body.losses ?? snapshot.losses,
          ties: body.ties ?? snapshot.ties,
          pointsFor: body.pointsFor ?? snapshot.pointsFor,
          pointsAgainst: body.pointsAgainst ?? snapshot.pointsAgainst,
          playoffSeed: body.playoffSeed ?? snapshot.playoffSeed,
          notes: body.notes,
          assignedBy: admin.id
        });
        return sendJson(res, 200, {
          ok: true,
          entry,
          career: career.listForUser(userId),
          user: users.publicUser(target)
        });
      } catch (err) {
        return sendJson(res, err.status || 400, {
          ok: false,
          error: err.message || 'Could not assign past team'
        });
      }
    }

    if (pathname.match(/^\/api\/users\/[^/]+\/career\/[^/]+$/) && req.method === 'DELETE') {
      if (!requireCommissioner(req, res)) return;
      const parts = pathname.split('/');
      const userId = parts[3];
      const entryId = parts[5];
      try {
        career.removeEntry(userId, entryId);
        return sendJson(res, 200, {
          ok: true,
          career: career.listForUser(userId)
        });
      } catch (err) {
        return sendJson(res, err.status || 400, {
          ok: false,
          error: err.message || 'Could not remove career entry'
        });
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
        const result = users.setUserRole(userId, body.role, body.conference);
        const updated = result?.user || result;
        return sendJson(res, 200, {
          ok: true,
          user: updated
        });
      } catch (err) {
        return sendJson(res, err.status || 400, {
          ok: false,
          error: err.message || 'Could not update role',
          code: err.code || null,
          existingAdmin: err.existingAdmin || null
        });
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
      const user = requireStaff(req, res);
      if (!user) return;
      const { buildInviteEmail } = require('./mail');
      const origin = requestOrigin(req);
      const content = buildInviteEmail({
        inviteUrl: `${origin}/register?invite=preview-sample-token`,
        invitedByName: user.name || user.loginName || 'Staff',
        leagueName: config.brand.name,
        baseUrl: origin
      });
      const format = String(requestUrl.searchParams.get('format') || 'html').toLowerCase();
      if (format === 'json') {
        return sendJson(res, 200, {
          ok: true,
          subject: content.subject,
          text: content.text,
          html: content.html,
          copy: content.copy || null,
          sourceFile: 'invite-email-message.js',
          editHint: 'Edit invite-email-message.js then refresh this preview.'
        });
      }
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

    if (pathname === '/api/conference/teams' && req.method === 'GET') {
      const user = requireStaff(req, res);
      if (!user) return;
      try {
        const conferenceKey = resolveStaffConferenceKey(user, requestUrl.searchParams.get('conference'));
        const roster = await loadConferenceOwnerRoster(conferenceKey);
        return sendJson(res, 200, {
          ok: true,
          ...roster,
          viewer: {
            role: user.role,
            conference: user.conference || null,
            name: user.name || user.loginName
          }
        });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not load conference teams' });
      }
    }

    if (pathname === '/api/conference/email-owners/preview' && req.method === 'GET') {
      const user = requireStaff(req, res);
      if (!user) return;
      try {
        const conferenceKey = resolveStaffConferenceKey(user, requestUrl.searchParams.get('conference'));
        const conference = config.conferences.find((c) => c.key === conferenceKey);
        const origin = requestOrigin(req);
        const content = buildConferenceOwnerEmail({
          subject: requestUrl.searchParams.get('subject') || 'Conference update',
          headline: requestUrl.searchParams.get('headline') || 'Conference update',
          body: requestUrl.searchParams.get('body') || 'This is a preview of your branded conference email to selected team owners.',
          recipientName: 'Alex Manager',
          fromName: user.name || user.loginName || 'Conference Admin',
          conferenceKey,
          conferenceName: conference?.name,
          ctaLabel: requestUrl.searchParams.get('ctaLabel') || 'Open League HQ',
          ctaUrl: requestUrl.searchParams.get('ctaUrl') || '/home.html',
          baseUrl: origin
        });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        return res.end(content.html);
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not build preview' });
      }
    }

    if (pathname === '/api/conference/email-owners' && req.method === 'POST') {
      const user = requireStaff(req, res);
      if (!user) return;
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const conferenceKey = resolveStaffConferenceKey(user, body.conference);
        const conference = config.conferences.find((c) => c.key === conferenceKey);
        const roster = await loadConferenceOwnerRoster(conferenceKey);
        const selectedIds = new Set(
          (Array.isArray(body.teamIds) ? body.teamIds : [])
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id))
        );
        if (!selectedIds.size) {
          return sendJson(res, 400, { ok: false, error: 'Select at least one team' });
        }
        const subject = String(body.subject || '').trim();
        const messageBody = String(body.body || '').trim();
        const headline = String(body.headline || subject || 'Conference update').trim();
        if (!subject) return sendJson(res, 400, { ok: false, error: 'Subject is required' });
        if (!messageBody) return sendJson(res, 400, { ok: false, error: 'Message body is required' });
        if (subject.length > 160) return sendJson(res, 400, { ok: false, error: 'Subject is too long' });
        if (messageBody.length > 8000) return sendJson(res, 400, { ok: false, error: 'Message is too long' });

        const byId = new Map(roster.teams.map((t) => [Number(t.teamId), t]));
        const results = [];
        const skipped = [];
        let sentCount = 0;
        for (const teamId of selectedIds) {
          const team = byId.get(Number(teamId));
          if (!team) {
            skipped.push({ teamId, reason: 'not_in_conference' });
            continue;
          }
          if (!team.emailable || !team.ownerEmail) {
            skipped.push({
              teamId,
              teamName: team.teamName,
              reason: team.claimed ? 'missing_email' : 'unclaimed'
            });
            continue;
          }
          try {
            const mailResult = await sendConferenceOwnerEmail({
              to: team.ownerEmail,
              subject,
              headline,
              body: messageBody,
              recipientName: team.ownerName || 'Manager',
              fromName: user.name || user.loginName || 'Conference Admin',
              conferenceKey,
              conferenceName: conference?.name,
              ctaLabel: String(body.ctaLabel || 'Open League HQ').trim() || 'Open League HQ',
              ctaUrl: String(body.ctaUrl || '/home.html').trim() || '/home.html',
              baseUrl: requestOrigin(req)
            });
            if (mailResult.sent) sentCount += 1;
            results.push({
              ok: true,
              teamId: team.teamId,
              teamName: team.teamName,
              email: team.ownerEmail,
              ownerName: team.ownerName,
              sent: Boolean(mailResult.sent),
              method: mailResult.method || null
            });
          } catch (mailErr) {
            results.push({
              ok: false,
              teamId: team.teamId,
              teamName: team.teamName,
              email: team.ownerEmail,
              ownerName: team.ownerName,
              sent: false,
              error: mailErr.message || 'Email send failed'
            });
          }
        }

        const okCount = results.filter((r) => r.ok).length;
        const mailReady = mailConfig().configured;
        let message;
        if (!okCount) message = 'No emails were sent. Selected teams may be unclaimed or missing emails.';
        else if (!mailReady) message = `Prepared ${okCount} branded email${okCount === 1 ? '' : 's'} (mail not configured — logged only).`;
        else if (sentCount === okCount) message = `Emailed ${sentCount} team owner${sentCount === 1 ? '' : 's'}.`;
        else message = `Emailed ${sentCount} of ${okCount}. Check results for failures.`;

        return sendJson(res, 200, {
          ok: true,
          conference: roster.conference,
          results,
          skipped,
          sentCount,
          preparedCount: okCount,
          mail: mailConfig(),
          message
        });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not email owners' });
      }
    }

    if (pathname === '/api/invites' && req.method === 'GET') {
      if (!requireStaff(req, res)) return;
      return sendJson(res, 200, {
        ok: true,
        invites: invites.listInvites(),
        mail: mailConfig()
      });
    }

    if (pathname === '/api/invites' && req.method === 'POST') {
      const user = requireStaff(req, res);
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
      const user = requireStaff(req, res);
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
      if (!requireStaff(req, res)) return;
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

    if (pathname === '/api/polls' && req.method === 'GET') {
      const user = getSessionUser(req);
      const conferenceKey = memberConferenceKey(user);
      return sendJson(res, 200, {
        ok: true,
        polls: polls.listPollsForBoard({ user, conferenceKey, includeClosed: true }),
        myConference: conferenceKey,
        generatedAt: new Date().toISOString()
      });
    }

    if (pathname === '/api/polls/admin' && req.method === 'GET') {
      const user = requireStaff(req, res);
      if (!user) return;
      return sendJson(res, 200, {
        ok: true,
        polls: polls.listPollsAdmin(),
        leagues: listAdminLeagues().map((l) => ({
          key: l.key,
          name: l.name,
          shortName: l.shortName,
          kind: l.kind
        })),
        generatedAt: new Date().toISOString()
      });
    }

    if (pathname === '/api/polls' && req.method === 'POST') {
      const user = requireStaff(req, res);
      if (!user) return;
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const limitToConference = body.limitToConference === true
          || String(body.audience || '').toLowerCase() === 'conference';
        let audienceConference = null;
        if (limitToConference) {
          audienceConference = resolveStaffConferenceKey(user, body.conference || body.audienceConference);
        }
        const item = polls.createPoll({
          question: body.question,
          options: body.options,
          audience: limitToConference ? 'conference' : 'all',
          audienceConference,
          author: user
        });
        return sendJson(res, 201, {
          ok: true,
          poll: polls.publicPoll(item, { user, includeAdmin: true })
        });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not create poll' });
      }
    }

    if (pathname.startsWith('/api/polls/') && pathname.endsWith('/vote') && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      const id = pathname.slice('/api/polls/'.length, -'/vote'.length);
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const conferenceKey = memberConferenceKey(user);
        const updated = polls.castVote(id, body.optionId, { user, conferenceKey });
        return sendJson(res, 200, {
          ok: true,
          poll: polls.publicPoll(updated, { user, conferenceKey })
        });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not record vote' });
      }
    }

    if (pathname.startsWith('/api/polls/') && pathname.endsWith('/close') && req.method === 'POST') {
      const user = requireStaff(req, res);
      if (!user) return;
      const id = pathname.slice('/api/polls/'.length, -'/close'.length);
      try {
        const updated = polls.closePoll(id, { by: user });
        return sendJson(res, 200, {
          ok: true,
          poll: polls.publicPoll(updated, { user, includeAdmin: true })
        });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not close poll' });
      }
    }

    if (pathname.startsWith('/api/polls/') && req.method === 'DELETE') {
      const user = requireStaff(req, res);
      if (!user) return;
      const id = pathname.slice('/api/polls/'.length);
      try {
        polls.deletePoll(id);
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not delete poll' });
      }
    }

    if (pathname === '/api/inbox' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      return sendJson(res, 200, {
        ok: true,
        messages: inbox.listForUser(user.id),
        unread: inbox.unreadCount(user.id),
        generatedAt: new Date().toISOString()
      });
    }

    if (pathname === '/api/inbox/unread' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      return sendJson(res, 200, {
        ok: true,
        unread: inbox.unreadCount(user.id)
      });
    }

    if (pathname === '/api/inbox/read-all' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      const marked = inbox.markAllRead(user.id);
      return sendJson(res, 200, { ok: true, marked, unread: 0 });
    }

    if (pathname.startsWith('/api/inbox/') && pathname.endsWith('/read') && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      const id = pathname.slice('/api/inbox/'.length, -'/read'.length);
      try {
        const message = inbox.markRead(id, user.id);
        return sendJson(res, 200, {
          ok: true,
          message: message || null,
          removed: !message,
          unread: inbox.unreadCount(user.id)
        });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not mark read' });
      }
    }

    if (pathname.startsWith('/api/inbox/') && req.method === 'DELETE') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      const id = pathname.slice('/api/inbox/'.length);
      try {
        inbox.deleteMessage(id, user.id);
        return sendJson(res, 200, {
          ok: true,
          unread: inbox.unreadCount(user.id)
        });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not delete message' });
      }
    }

    if (pathname === '/api/rule-proposals/status' && req.method === 'GET') {
      try {
        const status = await getDraftGateStatus();
        return sendJson(res, 200, { ok: true, ...status });
      } catch (err) {
        return sendJson(res, err.status || 500, {
          ok: false,
          error: err.message || 'Could not load draft status',
          proposalsOpen: true
        });
      }
    }

    if (pathname === '/api/rule-proposals' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      const filter = String(requestUrl.searchParams.get('status') || '').trim().toLowerCase() || null;
      const isOwner = users.isSiteOwner(user);
      const isStaffUser = users.isStaff(user);
      let list = ruleProposals.listProposals({ status: filter || undefined, limit: 60 });
      if (!isStaffUser) {
        list = list.filter((p) =>
          p.status === ruleProposals.STATUS.VOTING
          || p.status === ruleProposals.STATUS.PASSED
          || p.status === ruleProposals.STATUS.FAILED
          || p.authorId === user.id
        );
      }
      return sendJson(res, 200, {
        ok: true,
        proposals: list.map((p) => ruleProposals.publicProposal(p, { user, includeVotes: isOwner })),
        isOwner,
        isStaff: isStaffUser,
        generatedAt: new Date().toISOString()
      });
    }

    if (pathname === '/api/rule-proposals' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const gate = await getDraftGateStatus();
        if (!gate.proposalsOpen) {
          return sendJson(res, 400, {
            ok: false,
            error: 'Rule change proposals are closed — drafts are complete for all leagues'
          });
        }
        const item = ruleProposals.createProposal({ text: body.text || body.proposal, author: user });
        const staff = staffRecipients().filter((u) => u.id !== user.id);
        const subject = `Rule change proposal from ${user.name || user.loginName || 'member'}`;
        const msgBody = [
          `${user.name || user.loginName || 'A member'} submitted a rule change proposal:`,
          '',
          item.text,
          '',
          'Open Inbox to review. The site owner can send this to a league-wide vote.'
        ].join('\n');
        inbox.sendToUsers({
          toUserIds: staff.map((u) => u.id),
          from: user,
          subject,
          body: msgBody,
          type: 'rule_proposal',
          relatedId: item.id,
          meta: { proposalId: item.id, status: item.status }
        });
        // Also leave a copy in the author's inbox for tracking.
        inbox.sendMessage({
          toUserId: user.id,
          from: user,
          subject: 'Your rule change proposal was submitted',
          body: [
            'Your proposal was sent to league admins and the site owner:',
            '',
            item.text
          ].join('\n'),
          type: 'rule_proposal',
          relatedId: item.id,
          meta: { proposalId: item.id, status: item.status }
        });
        return sendJson(res, 201, {
          ok: true,
          proposal: ruleProposals.publicProposal(item, { user })
        });
      } catch (err) {
        return sendJson(res, err.status || 400, {
          ok: false,
          error: err.message || 'Could not submit proposal'
        });
      }
    }

    if (pathname.startsWith('/api/rule-proposals/') && pathname.endsWith('/open-vote') && req.method === 'POST') {
      const user = requireSiteOwner(req, res);
      if (!user) return;
      const id = pathname.slice('/api/rule-proposals/'.length, -'/open-vote'.length);
      try {
        const eligible = eligibleVoters();
        const updated = ruleProposals.openVote(id, { by: user, eligibleUsers: eligible });
        const pub = ruleProposals.publicProposal(updated, { user });
        const subject = 'League vote: rule change proposal';
        const msgBody = [
          'The site owner opened a league-wide vote on this rule change proposal.',
          '',
          updated.text,
          '',
          `Majority needed to pass or fail: ${pub.majorityNeeded} of ${pub.eligibleCount} members.`,
          '',
          'Vote Yes or No from your Inbox.'
        ].join('\n');
        inbox.sendToUsers({
          toUserIds: eligible.map((u) => u.id),
          from: user,
          subject,
          body: msgBody,
          type: 'rule_vote',
          relatedId: updated.id,
          meta: {
            proposalId: updated.id,
            status: updated.status,
            majorityNeeded: pub.majorityNeeded,
            eligibleCount: pub.eligibleCount
          }
        });
        return sendJson(res, 200, { ok: true, proposal: pub });
      } catch (err) {
        return sendJson(res, err.status || 400, {
          ok: false,
          error: err.message || 'Could not open vote'
        });
      }
    }

    if (pathname.startsWith('/api/rule-proposals/') && pathname.endsWith('/dismiss') && req.method === 'POST') {
      const user = requireSiteOwner(req, res);
      if (!user) return;
      const id = pathname.slice('/api/rule-proposals/'.length, -'/dismiss'.length);
      try {
        const updated = ruleProposals.dismissProposal(id, { by: user });
        return sendJson(res, 200, {
          ok: true,
          proposal: ruleProposals.publicProposal(updated, { user })
        });
      } catch (err) {
        return sendJson(res, err.status || 400, {
          ok: false,
          error: err.message || 'Could not dismiss proposal'
        });
      }
    }

    if (pathname.startsWith('/api/rule-proposals/') && pathname.endsWith('/vote') && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      const id = pathname.slice('/api/rule-proposals/'.length, -'/vote'.length);
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const before = ruleProposals.findProposal(id);
        const updated = ruleProposals.castVote(id, body.choice || body.vote, { user });
        const pub = ruleProposals.publicProposal(updated, { user });
        if (before?.status === ruleProposals.STATUS.VOTING
          && (updated.status === ruleProposals.STATUS.PASSED || updated.status === ruleProposals.STATUS.FAILED)) {
          const staff = staffRecipients();
          const resultLabel = updated.status === ruleProposals.STATUS.PASSED ? 'PASSED' : 'FAILED';
          inbox.sendToUsers({
            toUserIds: staff.map((u) => u.id),
            from: null,
            subject: `Rule vote ${resultLabel}`,
            body: [
              `The rule change proposal has ${resultLabel} by majority vote.`,
              '',
              updated.text,
              '',
              `Final tally: Yes ${pub.yes} · No ${pub.no} (needed ${pub.majorityNeeded} of ${pub.eligibleCount}).`
            ].join('\n'),
            type: 'rule_result',
            relatedId: updated.id,
            meta: {
              proposalId: updated.id,
              status: updated.status,
              yes: pub.yes,
              no: pub.no
            }
          });
        }
        return sendJson(res, 200, { ok: true, proposal: pub });
      } catch (err) {
        return sendJson(res, err.status || 400, {
          ok: false,
          error: err.message || 'Could not record vote'
        });
      }
    }

    if (pathname.startsWith('/api/rule-proposals/') && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      const id = pathname.slice('/api/rule-proposals/'.length);
      const item = ruleProposals.findProposal(id);
      if (!item) return sendJson(res, 404, { ok: false, error: 'Proposal not found' });
      const isStaffUser = users.isStaff(user);
      if (!isStaffUser
        && item.authorId !== user.id
        && item.status === ruleProposals.STATUS.SUBMITTED) {
        return sendJson(res, 403, { ok: false, error: 'Not allowed' });
      }
      return sendJson(res, 200, {
        ok: true,
        proposal: ruleProposals.publicProposal(item, {
          user,
          includeVotes: users.isSiteOwner(user)
        }),
        isOwner: users.isSiteOwner(user),
        isStaff: isStaffUser
      });
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
        res.writeHead(302, { Location: homePathForUser(user, req) || '/hq' });
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

    if (pathname === '/aaa' || pathname === '/aaa/') {
      res.writeHead(302, { Location: '/aaa.html' });
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

    if (pathname === '/api/draft' && req.method === 'GET') {
      const conferenceKey = String(requestUrl.searchParams.get('conference') || 'detail').trim();
      const seasonParam = requestUrl.searchParams.get('season');
      try {
        const payload = await loadDraftBoard(conferenceKey, seasonParam);
        return sendJson(res, 200, payload);
      } catch (err) {
        return sendJson(res, err.status || 500, {
          ok: false,
          error: err.message || 'Could not load draft',
          detail: err.detail || null
        });
      }
    }

    if (pathname === '/api/history' && req.method === 'GET') {
      const seasonParam = requestUrl.searchParams.get('season');
      try {
        const payload = await loadHistorySeason(seasonParam);
        return sendJson(res, 200, payload);
      } catch (err) {
        return sendJson(res, err.status || 500, {
          ok: false,
          error: err.message || 'Could not load history',
          detail: err.detail || null
        });
      }
    }

    if (pathname === '/api/history-seasons' && req.method === 'GET') {
      if (!requireCommissioner(req, res)) return;
      return sendJson(res, 200, {
        ok: true,
        seasons: historySeasonEntries(),
        configured: config.historySeasons || [],
        espnAuthConfigured: Boolean(process.env.ESPN_SWID && process.env.ESPN_S2)
      });
    }

    if (pathname === '/api/history-seasons' && req.method === 'POST') {
      const user = requireCommissioner(req, res);
      if (!user) return;
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const leagueId = config.leagueId || leagues.getActiveLeagueId();
        if (!leagueId) {
          return sendJson(res, 400, { ok: false, error: 'No active league' });
        }
        const updated = leagues.setHistorySeasons(leagueId, body.seasons || []);
        return sendJson(res, 200, {
          ok: true,
          seasons: historySeasonEntries(),
          configured: updated.historySeasons || []
        });
      } catch (err) {
        return sendJson(res, err.status || 400, {
          ok: false,
          error: err.message || 'Could not save history seasons'
        });
      }
    }

    if (pathname === '/api/my-team' && req.method === 'GET') {
      const user = getSessionUser(req);
      const claim = logos.getClaimForUser(user.id);
      const logo = logos.resolveLogoForUser(user.id);
      const keeperWindow = keepers.getKeeperWindow(calendar.listEvents(), config.season);
      let team = null;
      let roster = [];
      let keeper = null;
      let currentMatchup = null;
      let currentMatchupPeriod = null;
      let recentMatchups = [];
      let conferenceMeta = null;
      if (claim) {
        const nameEntry = logos.getDisplayName(claim.conferenceKey, claim.teamId);
        try {
          const conference = resolveEspnLeague(claim.conferenceKey);
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
            try {
              const detail = await loadTeamDetail(claim.conferenceKey, claim.teamId);
              roster = detail?.team?.roster || [];
              if (detail?.team) {
                team = {
                  ...(team || {}),
                  id: detail.team.id,
                  name: detail.team.name || team?.name,
                  logo: detail.team.logo || team?.logo,
                  conferenceKey: claim.conferenceKey,
                  conferenceName: conference.name,
                  wins: detail.team.wins ?? team?.wins,
                  losses: detail.team.losses ?? team?.losses,
                  ties: detail.team.ties ?? team?.ties,
                  pointsFor: detail.team.pointsFor ?? team?.pointsFor,
                  playoffSeed: detail.team.playoffSeed ?? team?.playoffSeed,
                  waiverRank: detail.team.waiverRank ?? team?.waiverRank,
                  owner: detail.team.owner
                };
              }
              currentMatchup = detail?.currentMatchup || null;
              currentMatchupPeriod = detail?.currentMatchupPeriod || null;
              recentMatchups = detail?.recentMatchups || [];
              conferenceMeta = detail?.conference || {
                key: conference.key,
                name: conference.name,
                shortName: conference.shortName,
                logo: conference.logo,
                kind: conference.kind || 'conference'
              };
            } catch { /* roster optional if ESPN roster view fails */ }
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
        keeper = keepers.getKeeper(claim.conferenceKey, claim.teamId, keeperWindow.forSeason);
      }
      return sendJson(res, 200, {
        ok: true,
        claim,
        logo,
        team,
        roster,
        currentMatchup,
        currentMatchupPeriod,
        recentMatchups,
        conference: conferenceMeta,
        keeper,
        keeperWindow,
        career: career.listForUser(user.id),
        homePath: homePathForUser(user, req),
        leagueScope: leagueScopeForUser(user, req),
        user: users.publicUser(user),
        specs: logos.LOGO_SPECS
      });
    }

    if (pathname === '/api/my-team/keeper' && req.method === 'POST') {
      try {
        const user = getSessionUser(req);
        const claim = logos.getClaimForUser(user.id);
        if (!claim) {
          return sendJson(res, 400, { ok: false, error: 'Claim a team first' });
        }
        const body = await readJsonBody(req);
        const windowInfo = keepers.getKeeperWindow(calendar.listEvents(), config.season);
        if (!windowInfo.open) {
          return sendJson(res, 403, {
            ok: false,
            error: windowInfo.message || 'Keeper declarations are locked',
            keeperWindow: windowInfo
          });
        }

        if (body.clear) {
          keepers.clearKeeper(claim.conferenceKey, claim.teamId, windowInfo.forSeason);
          return sendJson(res, 200, {
            ok: true,
            keeper: null,
            keeperWindow: windowInfo
          });
        }

        const playerId = Number(body.playerId);
        let playerName = String(body.playerName || '').trim();
        let position = String(body.position || '').trim() || null;
        if (!playerName || !position) {
          try {
            const detail = await loadTeamDetail(claim.conferenceKey, claim.teamId);
            const hit = (detail.team?.roster || []).find((p) => Number(p.id) === playerId);
            if (hit) {
              playerName = playerName || hit.name;
              position = position || hit.position || null;
            }
          } catch { /* ignore */ }
        }

        const keeper = keepers.setKeeper({
          conferenceKey: claim.conferenceKey,
          teamId: claim.teamId,
          forSeason: windowInfo.forSeason,
          playerId,
          playerName,
          position,
          originalDraftRound: body.originalDraftRound,
          keepNumber: body.keepNumber,
          declaredBy: user.id
        });
        return sendJson(res, 200, { ok: true, keeper, keeperWindow: windowInfo });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not save keeper' });
      }
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

    if (pathname === '/api/roster-violations' && req.method === 'GET') {
      const user = requireStaff(req, res);
      if (!user) return;
      const weekParam = requestUrl.searchParams.get('week');
      const filters = { season: config.season };
      if (weekParam) filters.week = Number(weekParam);
      if (user.role === 'conference_admin' && user.conference) {
        filters.conferenceKey = user.conference;
      }
      return sendJson(res, 200, {
        ok: true,
        ...rosterViolations.getStatus(),
        open: rosterViolations.listOpen(filters),
        history: rosterViolations.listHistory(40),
        mail: mailConfig(),
        generatedAt: new Date().toISOString()
      });
    }

    if (pathname === '/api/roster-violations/scan' && req.method === 'POST') {
      const user = requireStaff(req, res);
      if (!user) return;
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      try {
        const result = await runRosterViolationsJob({
          triggeredBy: user.loginName || user.name || 'staff',
          notify: body.notify !== false,
          forceNotify: Boolean(body.force)
        });
        if (user.role === 'conference_admin' && user.conference) {
          result.open = (result.open || []).filter((v) => v.conferenceKey === user.conference);
          result.openCount = result.open.length;
          result.notifications = (result.notifications || []).filter((n) => n.conferenceKey === user.conference);
        }
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message || 'Roster violations scan failed' });
      }
    }

    if (pathname === '/api/roster-violations/acknowledge' && req.method === 'POST') {
      const user = requireStaff(req, res);
      if (!user) return;
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const openRow = rosterViolations.listOpen().find((v) => v.id === String(body.id || ''));
        if (!openRow) {
          return sendJson(res, 404, { ok: false, error: 'Violation not found' });
        }
        if (user.role === 'conference_admin' && user.conference && openRow.conferenceKey !== user.conference) {
          return sendJson(res, 403, { ok: false, error: 'Not your conference' });
        }
        const closed = rosterViolations.acknowledge(String(body.id || ''), {
          by: user.loginName || user.name || 'staff',
          notes: body.notes
        });
        return sendJson(res, 200, { ok: true, violation: closed });
      } catch (err) {
        return sendJson(res, err.status || 500, { ok: false, error: err.message || 'Could not acknowledge' });
      }
    }

    if (pathname === '/api/schedule') {
      const scope = leagueScopeForUser(getSessionUser(req), req);
      return await apiSchedule(res, requestUrl.searchParams.get('week'), scope);
    }

    if (pathname === '/api/fantasy-leaders') {
      const scope = leagueScopeForUser(getSessionUser(req), req);
      return await apiFantasyLeaders(res, requestUrl.searchParams.get('week'), scope);
    }

    if (pathname === '/api/bowl') {
      try {
        const payload = await buildBowlPayload();
        return sendJson(res, 200, payload);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message || 'Could not load GridIron Bowl' });
      }
    }

    if (pathname === '/api/survival') {
      try {
        const payload = await buildSurvivalPayload();
        return sendJson(res, 200, payload);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message || "Could not load Mayor's Cup" });
      }
    }

    if (pathname === '/api/aaa') {
      try {
        const payload = await buildAaaPayload();
        return sendJson(res, payload.ok === false ? 502 : 200, payload);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message || 'Could not load AAA League' });
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

    if (pathname === '/api/rosters' && req.method === 'GET') {
      const conferenceKey = String(requestUrl.searchParams.get('conference') || '').trim();
      if (!conferenceKey) {
        return sendJson(res, 400, { ok: false, error: 'conference is required' });
      }
      try {
        const payload = await loadConferenceRosters(conferenceKey);
        return sendJson(res, 200, payload);
      } catch (err) {
        return sendJson(res, err.status || 500, { ok: false, error: err.message || 'Could not load rosters' });
      }
    }

    if (pathname === '/api/calendar' && req.method === 'GET') {
      try {
        calendar.ensureDefaults(config.calendarDefaults || []);
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

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { ok: false, error: `Unknown API route: ${pathname}` });
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
  users.ensureBootstrapOwnerAccounts();
  try { users.migrateApprovalFlags(); } catch (err) {
    console.warn('Approval migration failed:', err.message || err);
  }
  try {
    calendar.ensureDefaults(config.calendarDefaults || []);
  } catch (err) {
    console.warn('Calendar seed failed:', err.message || err);
  }
  const active = leagues.getActiveLeague();
  console.log(`\n${config.brand?.name || 'League HQ'} is running.`);
  console.log(`Open: http://localhost:${PORT}`);
  console.log(`API:  http://localhost:${PORT}/api/leagues`);
  console.log(`Active league: ${active?.slug || 'none'} (${active?.brand?.name || '—'})`);
  console.log(`Register a league: http://localhost:${PORT}/register-league`);
  console.log(`Auth: invite + owner / commissioner approval`);
  console.log(`Users: ${users.DATA_DIR}`);
  const ownerLogin = process.env.SITE_OWNER_LOGIN || process.env.COMMISSIONER_LOGIN;
  if (ownerLogin) {
    console.log(`GridIron 24 site owner: ${ownerLogin}`);
  }
  if (process.env.AAA_ADMIN_LOGIN) {
    console.log(`AAA league admin: ${process.env.AAA_ADMIN_LOGIN}`);
  }
  console.log('');
});
