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

const config = require('./config');
const users = require('./users-store');
const board = require('./board-store');
const logos = require('./logos-store');
const invites = require('./invites-store');
const weeklyWrap = require('./weekly-wrap');
const {
  sendPasswordResetEmail,
  sendInviteEmail,
  sendWeeklyWrapEmail,
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
        label: 'NFL',
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
  '/api/cron/weekly-wrap'
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
  return verifySession(cookies[SESSION_COOKIE]);
}

function isAuthenticated(req) {
  return Boolean(getSessionUser(req));
}

function sessionCookieHeader(token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function clearSessionCookieHeader() {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
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
      '.gif': 'image/gif'
    }[ext] || 'application/octet-stream';

    const fileName = path.basename(filePath);
    const isAuthPage = ['login.html', 'register.html', 'forgot.html', 'reset.html', 'setup.html'].includes(fileName);
    const cacheControl = isAuthPage
      ? 'no-store, no-cache, must-revalidate'
      : ext === '.html'
        ? 'no-cache'
        : (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp' || ext === '.css' || ext === '.js')
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

async function fetchEspnRaw(conference, views, cacheSuffix = '') {
  const cacheKey = `${config.season}:${conference.espnLeagueId}:${cacheSuffix || views.join(',')}`;
  const existing = cache.get(cacheKey);
  if (existing && Date.now() - existing.at < CACHE_MS) return existing.data;

  const endpoint = new URL(
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${config.season}/segments/0/leagues/${conference.espnLeagueId}`
  );
  for (const view of views) endpoint.searchParams.append('view', view);

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
  // Match ESPN settings fields (pts per yard), with a yards-per-point hint.
  if (PER_YARD_STAT_IDS.has(statId) && p !== 0) {
    const yardsPerPoint = 1 / p;
    const rounded = Math.round(yardsPerPoint * 100) / 100;
    const yds = Math.abs(yardsPerPoint - Math.round(yardsPerPoint)) < 1e-6
      ? String(Math.round(yardsPerPoint))
      : String(rounded);
    return `${formatPointsNumber(p)}/yd (1/${yds})`;
  }
  return formatPointsNumber(p);
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

async function apiSettings(res) {
  const results = await Promise.all(
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

  sendJson(res, 200, {
    season: config.season,
    generatedAt: new Date().toISOString(),
    conferences: results
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
  const TITLE_WEEK = 16;
  const BOWL_WEEK = 17;
  const [titleWeek, bowlWeek] = await Promise.all([
    loadSchedulePayload(TITLE_WEEK),
    loadSchedulePayload(BOWL_WEEK)
  ]);

  const titleByKey = new Map((titleWeek.conferences || []).map((c) => [c.key, c]));
  const bowlByKey = new Map((bowlWeek.conferences || []).map((c) => [c.key, c]));

  const detail = bowlSideFromConference(
    titleByKey.get('detail'),
    bowlByKey.get('detail'),
    'Detail Champion'
  );
  const overtime = bowlSideFromConference(
    titleByKey.get('overtime'),
    bowlByKey.get('overtime'),
    'Overtime Champion'
  );

  const champsReady = Boolean(detail.champion && overtime.champion);
  const scoresReady = Boolean(detail.hasWeek17Matchup && overtime.hasWeek17Matchup);
  let phase = 'waiting';
  let message = 'Conference titles crown in Week 16. GridIron Bowl scores pull from each champ’s ESPN Week 17 lineup.';

  if (champsReady && scoresReady) {
    const d = Number(detail.score || 0);
    const o = Number(overtime.score || 0);
    if (d > 0 || o > 0) {
      phase = 'live';
      message = 'Live ESPN Week 17 scoring · Detail champ vs Overtime champ';
    } else {
      phase = 'ready';
      message = 'Champions locked. Waiting on Week 17 NFL kickoff for ESPN scores.';
    }
  } else if (champsReady && !scoresReady) {
    phase = 'needs_week17';
    message = 'Champions are set, but ESPN needs a Week 17 matchup for each champ so lineups score.';
  } else if ((bowlByKey.get('detail')?.matchups || []).length || (bowlByKey.get('overtime')?.matchups || []).length) {
    phase = 'week17_open';
    message = 'Week 17 ESPN matchups exist. Bowl names fill in after Week 16 conference title games.';
  }

  let leader = null;
  if (champsReady && scoresReady) {
    const d = Number(detail.score || 0);
    const o = Number(overtime.score || 0);
    if (d > o) leader = 'detail';
    else if (o > d) leader = 'overtime';
    else if (d > 0 || o > 0) leader = 'tie';
  }

  return {
    ok: true,
    season: config.season,
    titleWeek: TITLE_WEEK,
    bowlWeek: BOWL_WEEK,
    phase,
    message,
    leader,
    detail,
    overtime,
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
          return sendJson(res, 400, { ok: false, error: 'Invite link is invalid or expired' });
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
        const user = users.createUser({
          name: body.name,
          email: body.email,
          loginName: body.loginName,
          password: body.password
        });
        if (inviteToken) {
          try { invites.acceptInvite(inviteToken, user.email); } catch { /* non-fatal */ }
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
      const user = users.authenticate(body.loginName, body.password);
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
        return sendJson(res, 404, { ok: false, error: 'Invite link is invalid or expired' });
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

    if (pathname === '/api/users' && req.method === 'GET') {
      if (!requireCommissioner(req, res)) return;
      return sendJson(res, 200, {
        ok: true,
        users: users.listUsers(),
        conferences: config.conferences.map((c) => ({ key: c.key, name: c.name }))
      });
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
    }

    if (pathname === '/api/leagues') {
      return await apiLeagues(res);
    }

    if (pathname === '/api/my-team' && req.method === 'GET') {
      const user = getSessionUser(req);
      const claim = logos.getClaimForUser(user.id);
      let logo = null;
      let team = null;
      if (claim) {
        const entry = logos.getLogo(claim.conferenceKey, claim.teamId);
        logo = entry ? { ...entry, url: logos.logoUrl(entry) } : null;
        const nameEntry = logos.getDisplayName(claim.conferenceKey, claim.teamId);
        try {
          const conference = config.conferences.find((c) => c.key === claim.conferenceKey);
          if (conference) {
            const league = await fetchEspnLeague(conference);
            const found = (league.teams || []).find((t) => Number(t.id) === Number(claim.teamId));
            if (found) {
              team = {
                id: found.id,
                name: found.name,
                espnName: found.espnName || found.name,
                logo: found.logo || null,
                conferenceKey: claim.conferenceKey
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
      try {
        const user = getSessionUser(req);
        const body = await readJsonBody(req);
        const claim = logos.claimTeam(user.id, body.conferenceKey, body.teamId, body.teamName);
        return sendJson(res, 200, { ok: true, claim });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not claim team' });
      }
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
        if (!claim) return sendJson(res, 400, { ok: false, error: 'Claim a team first' });
        const iconPath = path.join(PUBLIC_DIR, 'assets', 'team-icons', `${path.basename(String(body.iconId || ''))}.svg`);
        if (!fs.existsSync(iconPath)) {
          return sendJson(res, 400, { ok: false, error: 'Unknown icon' });
        }
        const logo = logos.setIconLogo(user.id, claim.conferenceKey, claim.teamId, body.iconId);
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
        if (!claim) return sendJson(res, 400, { ok: false, error: 'Claim a team first' });
        const dataUrl = String(body.dataUrl || '');
        const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([a-zA-Z0-9+/=\s]+)$/);
        if (!match) {
          return sendJson(res, 400, { ok: false, error: 'Upload a PNG, JPG, or WEBP image' });
        }
        const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
        const logo = logos.setUploadLogo(user.id, claim.conferenceKey, claim.teamId, {
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
        if (!claim) return sendJson(res, 400, { ok: false, error: 'Claim a team first' });
        logos.clearLogo(user.id, claim.conferenceKey, claim.teamId);
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

    if (pathname === '/api/settings') {
      return await apiSettings(res);
    }

    if (pathname === '/api/schedule') {
      return await apiSchedule(res, requestUrl.searchParams.get('week'));
    }

    if (pathname === '/api/bowl') {
      try {
        const payload = await buildBowlPayload();
        return sendJson(res, 200, payload);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message || 'Could not load GridIron Bowl' });
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
  users.ensureBootstrapCommissioner();
  console.log(`\nGridIron 24 is running.`);
  console.log(`Open: http://localhost:${PORT}`);
  console.log(`API:  http://localhost:${PORT}/api/leagues`);
  console.log(`Auth: invite-only registration · accounts enabled`);
  console.log(`Users: ${users.DATA_DIR}`);
  if (process.env.COMMISSIONER_LOGIN) {
    console.log(`Commissioner login: ${process.env.COMMISSIONER_LOGIN}`);
  }
  console.log('');
});
