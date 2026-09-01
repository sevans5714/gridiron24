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
const draftOrderShow = require('./draft-order-show-store');
const powerRankingsCompute = require('./power-rankings-compute');
const rulesSyncStore = require('./rules-sync-store');
const officialRules = require('./official-rules');
const seasonRulesLock = require('./season-rules-lock');
const espnResilient = require('./espn-resilient');
const rosterViolations = require('./roster-violations-store');
const keepers = require('./keepers-store');
const career = require('./career-store');
const recordsLib = require('./records');
const polls = require('./polls-store');
const inbox = require('./inbox-store');
const welcomeMessage = require('./welcome-message');
const commsSettings = require('./comms-settings-store');
const presence = require('./presence-store');
const ruleProposals = require('./rule-proposals-store');
const featureRequests = require('./feature-requests-store');
const leagues = require('./leagues-store');
const { compareScoringSettings } = require('./rules-diff');
const nflverseLive = require('./nflverse-live');
const sportsScoreboard = require('./sports-scoreboard');
const nflverseDraft = require('./nflverse-draft');
const survivorPool = require('./survivor-pool-store');
const paperBook = require('./paper-book-store');
const deathPool = require('./death-pool-store');
const deathPoolNews = require('./death-pool-news');
const mockDraftRooms = require('./mock-draft-rooms-store');
const independentDraft = require('./independent-draft-store');
const conferenceDraft = require('./conference-draft-store');
const independentScoreboard = require('./independent-scoreboard');
const independentWire = require('./independent-wire');
const independentPlayoffs = require('./independent-playoffs');
const independentKeepers = require('./independent-keepers');
const customPools = require('./custom-pool-store');
const futuresMarkets = require('./futures-markets');
const matchupDisplayWeek = require('./matchup-display-week');
const { startInProcessCrons } = require('./in-process-cron');
const preDraftRefresh = require('./pre-draft-refresh');
const {
  sendPasswordResetEmail,
  sendInviteEmail,
  sendAccountApprovedEmail,
  sendWeeklyWrapEmail,
  sendRulesSyncAlert,
  sendConferenceOwnerEmail,
  sendRosterViolationEmail,
  sendPwaInstallEmail,
  sendOwnerOpsEmail,
  buildWeeklyWrapEmail,
  buildConferenceOwnerEmail,
  buildPwaInstallEmail,
  mailConfig,
  siteBaseUrl
} = require('./mail');
const { GUIDE: pwaInstallGuide } = require('./pwa-install-guide');

function draftPoolOpts(roomOrSettings = {}, extra = {}) {
  const scoring = extra.scoring
    || roomOrSettings.scoring
    || nflverseDraft.scoringFromSettings(roomOrSettings.settings || roomOrSettings);
  const teams = extra.teams
    || roomOrSettings.teamCount
    || roomOrSettings.teams;
  return {
    activeOnly: true,
    scoring,
    teams,
    ...extra
  };
}

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_MS = 30_000;
const ESPN_NEWS_CACHE_MS = 5 * 60_000;
let espnNewsCache = { at: 0, items: [], source: null };

function espnAuthHeaders() {
  const headers = {
    Accept: 'application/json,text/plain,*/*',
    'User-Agent': 'GridIron24/0.1 (+local proof-of-concept)',
    Referer: 'https://fantasy.espn.com/',
    Origin: 'https://fantasy.espn.com',
    'X-Fantasy-Source': 'kona'
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
    const hit = await espnResilient.fetchJsonResilient({
      urls: espnResilient.siteApiUrls(`apis/site/v2/sports/football/nfl/news?limit=${limit}`),
      cacheKey: `news:nfl:${limit}`,
      ttlMs: ESPN_NEWS_CACHE_MS,
      headers: { Accept: 'application/json', 'User-Agent': 'GridIron24/1.0' },
      lane: 'news'
    });
    const items = (hit.data.articles || [])
      .map((a) => ({
        id: `espn-${a.id || a.published || Math.random()}`,
        source: 'espn',
        label: 'ESPN',
        text: String(a.headline || a.description || '').trim(),
        href: a.links?.web?.href || a.link || null
      }))
      .filter((a) => a.text);
    espnNewsCache = {
      at: hit.fetchedAt || Date.now(),
      items,
      source: hit.source
    };
    return items;
  } catch (err) {
    console.error('ESPN news fetch failed:', err.message || err);
    return [];
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
  '/create-league',
  '/create-league.html',
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
  '/api/create-league',
  '/api/create-league/draft',
  '/api/create-league/asset',
  '/api/create-league/template',
  '/api/cron/weekly-wrap',
  '/api/cron/rules-sync',
  '/api/cron/roster-violations',
  '/api/cron/death-pool-news',
  '/api/cron/paper-book-settle',
  '/api/cron/pre-draft-refresh',
  '/install-app',
  '/install-app.html',
  '/api/docs/pwa-install',
  '/docs/gridiron24-app-install.pdf',
  '/espn-setup',
  '/espn-setup.html',
  '/favicon.ico',
  '/favicon.png',
  '/favicon-32.png',
  '/favicon-48.png',
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
  '/manifest.webmanifest',
  '/sw.js',
  '/api/lounge/fresh-start',
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

/** Fantasy franchise name for lounge mock draft seats (display override → custom ESPN name → owner). */
function personKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function independentFranchiseForUser(user) {
  if (!user?.id || !user.leagueId) return null;
  try {
    const league = leagues.findById(user.leagueId);
    if (!league) return null;
    return (league.franchises || []).find((f) => f.managerUserId === user.id) || null;
  } catch {
    return null;
  }
}

function chipFranchiseForUser(user) {
  if (!user?.id || user.loungeOnly) return null;
  try {
    const claim = logos.getClaimForUser(user.id);
    if (claim) {
      const nameEntry = logos.getDisplayName(claim.conferenceKey, claim.teamId);
      const name = String(nameEntry?.displayName || claim.teamName || '').trim();
      const conf = listAdminLeagues().find((c) => c.key === claim.conferenceKey);
      return {
        name: name || null,
        teamId: claim.teamId,
        conferenceKey: claim.conferenceKey,
        conferenceName: conf?.name || null,
        source: 'claim',
        claim
      };
    }
  } catch { /* ignore */ }
  try {
    const franchise = independentFranchiseForUser(user);
    if (franchise) {
      const name = String(franchise.name || franchise.teamName || '').trim();
      return {
        name: name || null,
        teamId: franchise.id,
        conferenceKey: franchise.conferenceKey || franchise.conference || null,
        conferenceName: null,
        source: 'independent',
        claim: {
          teamId: franchise.id,
          teamName: name,
          conferenceKey: franchise.conferenceKey || franchise.conference || null,
          independent: true
        }
      };
    }
  } catch { /* ignore */ }
  return null;
}

function fantasyTeamNameForUser(user) {
  if (!user?.id) return null;
  const chip = chipFranchiseForUser(user);
  const named = String(chip?.name || '').trim();
  if (named) return named;
  const owner = String(user?.name || user?.loginName || '').trim();
  return owner || null;
}

async function maybeLinkEspnFranchise(user) {
  if (!user?.id || user.loungeOnly) return null;
  if (logos.getClaimForUser(user.id)) return logos.getClaimForUser(user.id);
  const needle = personKey(user.name);
  const login = personKey(user.loginName);
  if (!needle && !login) return null;
  const hits = [];
  for (const conf of listAdminLeagues()) {
    if (!(Number(conf.espnLeagueId) > 0)) continue;
    try {
      const league = await fetchEspnLeague(conf);
      for (const t of league.teams || []) {
        const owner = personKey(t.owner);
        if (!owner) continue;
        if (owner !== needle && owner !== login) continue;
        const taken = logos.getClaimForTeam(conf.key, t.id);
        if (taken && taken.userId !== user.id) continue;
        hits.push({ conf, team: t });
      }
    } catch { /* ignore */ }
  }
  if (hits.length !== 1) return null;
  const hit = hits[0];
  const existing = logos.getClaimForTeam(hit.conf.key, hit.team.id);
  if (existing) return existing.userId === user.id ? existing : null;
  try {
    return logos.assignTeam(user.id, hit.conf.key, hit.team.id, hit.team.name, user.id);
  } catch {
    return null;
  }
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

function preferredLeagueCookieValue(league) {
  if (!league) return 'gridiron';
  if (typeof league === 'object') {
    if (league.kind === 'independent' && league.id) return `independent:${league.id}`;
    if (league.kind === 'aaa') return 'aaa';
    return 'gridiron';
  }
  const raw = String(league).trim();
  const lower = raw.toLowerCase();
  if (lower === 'aaa') return 'aaa';
  if (lower === 'gridiron' || lower === 'gridiron24' || lower === 'gi24') return 'gridiron';
  if (lower.startsWith('independent:')) {
    const id = raw.slice(raw.indexOf(':') + 1).trim();
    return id ? `independent:${id}` : 'gridiron';
  }
  return `independent:${raw}`;
}

function preferredLeagueCookieHeader(league) {
  const value = preferredLeagueCookieValue(league);
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
  const raw = String(cookies[LEAGUE_COOKIE] || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === 'aaa' || lower === 'gridiron') return lower;
  if (lower.startsWith('independent:')) {
    const id = raw.slice(raw.indexOf(':') + 1).trim();
    return id ? { kind: 'independent', id } : null;
  }
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
  if (pathname.startsWith('/docs/') && pathname.endsWith('.pdf')) return true;
  // App shell HTML embeds (casino iframe lives under /app/ so PWA scope allows it)
  if (
    pathname.startsWith('/app/')
    && pathname !== '/app/index.html'
    && pathname !== '/app/'
    && pathname !== '/app'
    && /\.(js|css|map|svg|png|jpe?g|webp|woff2?|html)$/i.test(pathname)
  ) {
    return true;
  }
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

/** Paths social (lounge-only) accounts may use after sign-in — Members Lounge only. */
function isLoungeOnlyAllowedPath(pathname) {
  const exact = new Set([
    '/members',
    '/members.html',
    '/restricted.html',
    '/install-app',
    '/install-app.html',
    '/api/docs/pwa-install',
    '/docs/gridiron24-app-install.pdf',
    '/api/preferences',
    '/api/presence',
    '/api/survivor-pool',
    '/api/death-pool',
    '/api/custom-pools',
    '/api/paper-book',
    '/api/members-chat',
    '/api/members',
    '/api/sports-scores',
    '/api/leagues',
    '/api/beta/draft-pool',
    '/api/beta/player-news',
    '/api/beta/draft',
    '/api/mock-draft'
  ]);
  if (exact.has(pathname)) return true;
  if (pathname.startsWith('/api/members-chat/')) return true;
  if (pathname === '/profile' || pathname === '/profile.html') return true;
  if (pathname === '/api/profile' || pathname === '/api/change-password') return true;
  if (pathname === '/api/my-team' || pathname.startsWith('/api/my-team/')) return true;
  if (/^\/api\/users\/[^/]+\/profile$/.test(pathname)) return true;
  return false;
}

/**
 * Social accounts may only use the Members Lounge.
 * Returns false when the response was already sent.
 */
function enforceLoungeOnlyAccess(req, res, pathname) {
  const user = getSessionUser(req);
  if (!user || !users.isLoungeOnly(user)) return true;
  if (isPublicPath(pathname)) return true;
  if (isLoungeOnlyAllowedPath(pathname)) return true;
  if (pathname.startsWith('/api/')) {
    sendJson(res, 403, {
      ok: false,
      error: 'Social accounts can only use the Members Lounge.',
      code: 'lounge_only'
    });
    return false;
  }
  res.writeHead(302, {
    Location: '/members.html',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache'
  });
  res.end();
  return false;
}

function requireLoungeMember(req, res) {
  const user = getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { ok: false, error: 'Authentication required' });
    return null;
  }
  if (!users.hasLoungeAccess(user)) {
    sendJson(res, 403, {
      ok: false,
      error: users.isLoungeOpenToMembers()
        ? 'Members Lounge is restricted. You need an approved account with lounge access.'
        : 'Members Lounge is not open yet.',
      code: 'lounge_restricted',
      redirect: '/restricted.html?area=lounge'
    });
    return null;
  }
  return user;
}

function requireSiteOwner(req, res) {
  const user = getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { ok: false, error: 'Authentication required' });
    return null;
  }
  if (!users.isSiteOwner(user) && !users.isReadOnly(user)) {
    sendJson(res, 403, { ok: false, error: 'Site owner access required' });
    return null;
  }
  return user;
}

/** Mutations that must not include view-only accounts. */
function requireSiteOwnerWrite(req, res) {
  const user = getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { ok: false, error: 'Authentication required' });
    return null;
  }
  if (!users.isSiteOwner(user)) {
    sendJson(res, 403, { ok: false, error: 'Only the site owner can do that' });
    return null;
  }
  return user;
}

function streamRequestToFile(req, destPath, { maxBytes }) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    let size = 0;
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      req.unpipe(out);
      out.destroy();
      req.destroy();
      fs.unlink(destPath, () => {});
      reject(err);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        fail(Object.assign(new Error('Video must be under 2GB'), { status: 413 }));
      }
    });
    req.pipe(out);
    out.on('finish', () => {
      if (!failed) resolve(size);
    });
    out.on('error', (err) => fail(err));
    req.on('error', (err) => fail(err));
    req.on('aborted', () => fail(Object.assign(new Error('Upload aborted'), { status: 400 })));
  });
}

function sendMediaFile(req, res, absPath, mimeType) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  const size = stat.size;
  const type = mimeType || 'video/mp4';
  const range = String(req.headers.range || '');
  const headersBase = {
    'Accept-Ranges': 'bytes',
    'Content-Type': type,
    'Cache-Control': 'private, max-age=3600'
  };
  if (!range) {
    res.writeHead(200, { ...headersBase, 'Content-Length': size });
    fs.createReadStream(absPath).pipe(res);
    return;
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m) {
    res.writeHead(416, { ...headersBase, 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  let start = m[1] ? Number(m[1]) : 0;
  let end = m[2] ? Number(m[2]) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    res.writeHead(416, { ...headersBase, 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  if (end >= size) end = size - 1;
  res.writeHead(206, {
    ...headersBase,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${size}`
  });
  fs.createReadStream(absPath, { start, end }).pipe(res);
}

function siteHqRoleLabel(u) {
  if (!u) return 'Member';
  if (users.isSiteOwner(u)) return 'Site owner';
  if (users.isReadOnly(u)) return 'View only';
  if (u.leagueOwner) return 'League owner';
  if (u.role === 'commissioner') return 'Commissioner';
  if (u.role === 'conference_admin') {
    return u.conference === 'aaa' ? 'AAA admin' : 'Conference admin';
  }
  if (u.loungeOnly) return 'Social';
  return 'Member';
}

function siteHqLeagueLabel(u) {
  if (!u) return null;
  if (u.loungeOnly) return 'Lounge';
  if (u.membershipLeague === 'aaa') return 'AAA';
  if (u.membershipLeague === 'gridiron') return 'GridIron 24';
  if (u.leagueId) {
    try {
      const linked = leagues.findById(u.leagueId);
      if (linked?.brand?.name || linked?.slug) return linked.brand?.name || linked.slug;
    } catch { /* ignore */ }
  }
  return 'GridIron 24';
}

function listStaffPlacementLeagues() {
  return leagues.listIndependentLeagues()
    .filter((l) => l.status !== 'archived' && l.status !== 'rejected')
    .map((l) => ({
      id: l.id,
      name: l.brand?.name || l.slug,
      slug: l.slug,
      status: l.status,
      setupComplete: l.setupComplete !== false,
      homePath: l.homePath || leagues.independentHomePath(l)
    }));
}

function grantLoungeAdmission(userId, actorId = null) {
  const current = users.findById(userId);
  if (!current || current.approved === false) return users.publicUser(current);
  let next = users.publicUser(current);
  if (!users.isSiteOwner(current) && !users.isReadOnly(current)) {
    try {
      const result = users.setLoungeToken(userId, true, actorId);
      next = result.user || next;
    } catch { /* already admitted */ }
  }
  try { paperBook.grantLoungeBankroll(next); } catch { /* ignore */ }
  return users.publicUser(users.findById(userId));
}

function placementLeagueName(leagueId) {
  if (!leagueId) return '';
  try {
    const league = leagues.findById(leagueId);
    return league?.brand?.name || league?.slug || '';
  } catch {
    return '';
  }
}

function applyStaffPlacement(userId, membershipRaw, actor) {
  const before = users.findById(userId);
  if (!before) {
    throw Object.assign(new Error('Account not found'), { status: 404 });
  }
  if (users.isSiteOwner(before) || users.isReadOnly(before)) {
    throw Object.assign(new Error('That account cannot be reassigned'), { status: 400 });
  }
  const parsed = users.parseMembershipPlacement(membershipRaw);
  if (parsed.kind === 'independent') {
    const leagueId = parsed.leagueId;
    const league = leagueId ? leagues.findById(leagueId) : null;
    if (!league || league.platform !== 'independent') {
      throw Object.assign(new Error('Pick an independent league'), { status: 400 });
    }
    if (league.status === 'archived' || league.status === 'rejected') {
      throw Object.assign(new Error('That league is not available'), { status: 400 });
    }
    if (before.leagueOwner && before.leagueId && before.leagueId !== league.id) {
      throw Object.assign(
        new Error('Transfer league ownership first — this account owns another independent league'),
        { status: 400 }
      );
    }
    users.setLoungeOnly(userId, false, actor.id);
    users.setLeagueMembership(userId, { league: null });
    users.setUserLeagueOwner(
      userId,
      league.id,
      Boolean(before.leagueOwner && before.leagueId === league.id)
    );
    try { logos.unassignTeam(userId); } catch { /* ignore */ }
    return grantLoungeAdmission(userId, actor.id);
  }
  if (parsed.kind === 'aaa') {
    throw Object.assign(
      new Error('AAA League is not running in 2026. Assign GridIron 24, social, or an independent league.'),
      { status: 400 }
    );
  }
  if (parsed.kind === 'social') {
    if (before.leagueOwner && before.leagueId) {
      throw Object.assign(
        new Error('League owners cannot be social-only. Transfer ownership first.'),
        { status: 400 }
      );
    }
    const updated = users.setLoungeOnly(userId, true, actor.id);
    if (before.leagueId && !before.leagueOwner) {
      users.setUserLeagueOwner(userId, null, false);
    }
    try { logos.unassignTeam(userId); } catch { /* ignore */ }
    return grantLoungeAdmission(updated.id, actor.id);
  }
  users.setLoungeOnly(userId, false, actor.id);
  users.setLeagueMembership(userId, {
    league: parsed.kind === 'aaa' ? 'aaa' : 'gridiron'
  });
  if (before.leagueId && !before.leagueOwner) {
    users.setUserLeagueOwner(userId, null, false);
  }
  if (parsed.kind === 'aaa') {
    const claim = logos.getClaimForUser(userId);
    if (claim && (claim.conferenceKey === 'detail' || claim.conferenceKey === 'overtime')) {
      try { logos.unassignTeam(userId); } catch { /* ignore */ }
    }
  }
  return grantLoungeAdmission(userId, actor.id);
}

function buildSiteHqPayload(viewer) {
  try { presence.touch(users.publicUser(viewer)); } catch { /* ignore */ }
  const allUsers = users.listUsers();
  const pendingAccounts = allUsers.filter((u) => u.approved === false);
  const independent = leagues.listIndependentLeagues();
  const pendingLeagues = independent.filter((l) => l.status === 'pending_approval');
  const byId = new Map(allUsers.map((u) => [u.id, u]));
  const online = presence.listOnline().map((row) => {
    const u = byId.get(row.id);
    return {
      id: row.id,
      name: u?.name || row.name,
      loginName: u?.loginName || row.loginName,
      email: u?.email || null,
      role: siteHqRoleLabel(u),
      league: u ? siteHqLeagueLabel(u) : null,
      lastSeen: row.lastSeen
    };
  });
  const espn = listEspnLeagueBindings();
  const mail = mailConfig();
  const upstream = upstreamMeta();
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    counts: {
      online: online.length,
      accounts: allUsers.filter((u) => u.approved !== false).length,
      pendingAccounts: pendingAccounts.length,
      pendingLeagues: pendingLeagues.length,
      independentLeagues: independent.length,
      independentLive: independent.filter((l) => l.status === 'approved').length
    },
    online,
    pendingAccounts: pendingAccounts.map((u) => ({
      id: u.id,
      name: u.name,
      loginName: u.loginName,
      email: u.email,
      loungeOnly: Boolean(u.loungeOnly),
      membershipLeague: u.membershipLeague || null,
      leagueId: u.leagueId || null,
      createdAt: u.createdAt || null
    })),
    accounts: allUsers.map((u) => ({
      id: u.id,
      name: u.name,
      loginName: u.loginName,
      email: u.email || null,
      role: siteHqRoleLabel(u),
      roleKey: u.role || 'user',
      conference: u.conference || null,
      hqConference: u.hqConference || null,
      membershipLeague: u.membershipLeague || null,
      leagueId: u.leagueId || null,
      league: siteHqLeagueLabel(u),
      loungeOnly: Boolean(u.loungeOnly),
      loungeToken: Boolean(u.loungeToken),
      duesPaid: Boolean(u.duesPaid),
      leagueOwner: Boolean(u.leagueOwner),
      siteOwner: users.isSiteOwner(u),
      approved: u.approved !== false,
      createdAt: u.createdAt || null
    })),
    pendingLeagues: pendingLeagues.map((l) => ({
      id: l.id,
      name: l.brand?.name || l.slug,
      slug: l.slug,
      ownerName: l.ownerName,
      ownerEmail: l.ownerEmail,
      teamCount: l.structure?.totalTeams || null,
      submittedAt: l.submittedAt || l.createdAt,
      homePath: l.homePath || null
    })),
    espn: {
      season: espn.season,
      leagues: espn.leagues || []
    },
    leagues: {
      platform: {
        name: config.brand?.name || 'GridIron 24',
        season: config.season,
        conferences: (espn.leagues || []).map((row) => ({
          key: row.key,
          name: row.name,
          kind: row.kind,
          espnLeagueId: row.espnLeagueId || null
        }))
      },
      independent: independent.map((l) => ({
        id: l.id,
        name: l.brand?.name || l.slug,
        slug: l.slug,
        status: l.status,
        season: l.season || null,
        format: l.settings?.leagueFormat || 'redraft',
        draftStatus: l.draft?.status || null,
        setupComplete: l.setupComplete !== false,
        ownerName: l.ownerName,
        ownerEmail: l.ownerEmail,
        teamCount: l.structure?.totalTeams || null,
        submittedAt: l.submittedAt || l.createdAt,
        approvedAt: l.approvedAt || null,
        renewedAt: l.renewedAt || null,
        archivedAt: l.archivedAt || null,
        homePath: l.homePath || null
      }))
    },
    health: {
      app: config.brand?.name || 'GridIron 24',
      version: buildInfo.version,
      build: buildInfo.build,
      season: config.season,
      mail: {
        configured: Boolean(mail.configured),
        provider: mail.provider || null,
        from: mail.from || null
      },
      upstream
    }
  };
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
  if (!users.isStaff(user) && !users.isReadOnly(user)) {
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
  if (!canAccessGi24OwnerTools(user)) {
    sendJson(res, 403, { ok: false, error: 'Owner access required' });
    return null;
  }
  return user;
}

/** Detail / Overtime / AAA admin scope. Site owner and overall commissioner see everyone. */
function staffConferenceScope(user) {
  if (!user || users.isSiteOwner(user) || users.isCommissioner(user) || users.isReadOnly(user)) return null;
  if (String(user.role || '') !== 'conference_admin') return null;
  return String(user.conference || '').trim().toLowerCase() || null;
}

function userVisibleToStaff(admin, target) {
  if (!admin || !target) return false;
  const scope = staffConferenceScope(admin);
  if (!scope) return true;
  if (target.id === admin.id) return true;
  if (target.approved === false) return false;
  if (scope === 'aaa') return users.hqMembershipOf(target) === 'aaa';
  if (users.hqMembershipOf(target) !== 'gridiron') return false;
  const conf = users.hqConferenceOf(target) || memberConferenceKey(target);
  return !conf || conf === scope;
}

function assertStaffCanManageUser(admin, target) {
  if (!target) {
    throw Object.assign(new Error('User not found'), { status: 404 });
  }
  if (users.isSiteOwner(target) && !users.isSiteOwner(admin)) {
    throw Object.assign(new Error('Cannot change the site owner account'), { status: 403 });
  }
  if (!userVisibleToStaff(admin, target)) {
    throw Object.assign(new Error('That account is not in your conference'), { status: 403 });
  }
}

function inviteVisibleToStaff(admin, invite, req = null) {
  const leagueScope = leagueScopeForUser(admin, req);
  if (leagueScope?.scope === 'independent' || leagueScope?.platform === 'independent') {
    return Boolean(invite?.leagueId && String(invite.leagueId) === String(leagueScope.leagueId || ''));
  }
  if (invite?.leagueId) return false;
  const scope = staffConferenceScope(admin);
  if (!scope) return true;
  if (scope === 'aaa') return String(invite.membershipLeague || '') === 'aaa';
  return !invite.loungeOnly && String(invite.membershipLeague || '') !== 'aaa';
}

function staffInviteMembership(admin, requested) {
  const scope = staffConferenceScope(admin);
  if (!scope) {
    const membershipRaw = String(requested || '').trim().toLowerCase();
    const loungeOnly = membershipRaw === 'social';
    return {
      loungeOnly,
      membershipLeague: loungeOnly ? null : (membershipRaw === 'aaa' ? 'aaa' : 'gridiron')
    };
  }
  if (scope === 'aaa') return { loungeOnly: false, membershipLeague: 'aaa' };
  return { loungeOnly: false, membershipLeague: 'gridiron' };
}

function removeMemberAccount(userId, actor) {
  const target = users.findById(userId);
  if (!target) {
    throw Object.assign(new Error('User not found'), { status: 404 });
  }
  try { logos.wipeUser(userId); } catch { /* ignore */ }
  try { logos.unassignTeam(userId); } catch { /* no franchise */ }
  try { career.removeAllForUser(userId); } catch { /* ignore */ }
  try { invites.revokeInvitesForEmail(target.email); } catch { /* ignore */ }
  try { paperBook.purgeUser(userId); } catch { /* ignore */ }
  try { inbox.purgeUser(userId); } catch { /* ignore */ }
  try { membersChat.purgeUser(userId); } catch { /* ignore */ }
  try { presence.drop(userId); } catch { /* ignore */ }
  return users.deleteUser(userId, actor?.id);
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

function canAccessGi24OwnerTools(user) {
  return Boolean(user && (users.isSiteOwner(user) || users.isReadOnly(user)));
}

function canAccessSiteTools(user) {
  return Boolean(user && (users.isSiteOwner(user) || users.isReadOnly(user)));
}

function canInspectAsOwner(user) {
  return users.isSiteOwner(user) || users.isReadOnly(user);
}

function isIndependentLeagueOwner(user) {
  if (!user?.leagueOwner || !user.leagueId || users.isSiteOwner(user)) return false;
  try {
    const owned = leagues.findById(user.leagueId);
    return Boolean(owned && owned.platform === 'independent');
  } catch {
    return false;
  }
}

function isConferenceAdminOnly(user) {
  return Boolean(
    user
    && users.isStaff(user)
    && !users.isCommissioner(user)
    && !user.canSwitchLeagues
    && !user.leagueOwner
    && String(user.role || '') === 'conference_admin'
  );
}

function ownerDashboardPath(user) {
  if (isIndependentLeagueOwner(user)) {
    try {
      const owned = leagues.findById(user.leagueId);
      return leagues.independentSectionPath(owned, 'settings') || leagues.independentHomePath(owned);
    } catch {
      return '/my-league.html';
    }
  }
  if (isConferenceAdminOnly(user)) return '/admin.html';
  if (canAccessGi24OwnerTools(user)) return '/owner.html';
  return '/profile.html';
}

function staffDashboardPath(user) {
  return ownerDashboardPath(user);
}

function sendLeagueToolsPage(res) {
  return sendFile(res, path.join(PUBLIC_DIR, 'league-tools.html'));
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
      '.woff2': 'font/woff2',
      '.pdf': 'application/pdf',
      '.ico': 'image/x-icon'
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
    // Allow the root service worker to control the /app/ shell scope.
    if (fileName === 'sw.js') {
      headers['Service-Worker-Allowed'] = '/app/';
      headers['Cache-Control'] = 'no-cache';
    }
    if (fileName === 'manifest.webmanifest') {
      headers['Cache-Control'] = 'no-cache';
    }

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

function espnDisplayNameLooksDefault(name) {
  return /^team(\s+\S+)?$/i.test(String(name || '').trim());
}

function espnTeamNameIsCustom(team) {
  const location = String(team?.location || '').trim();
  const nickname = String(team?.nickname || '').trim();
  const name = String(team?.name || `${location} ${nickname}`).trim();
  if (!name) return false;
  // ESPN default franchises are "Team" / "Team LastName".
  return !espnDisplayNameLooksDefault(name);
}

function ownerAbbrev(label, fallback = '') {
  const parts = String(label || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return String(fallback || '');
  const last = parts[parts.length - 1];
  return last.slice(0, 4).toUpperCase() || String(fallback || '');
}

function gridironOwnerForEspnTeam(conferenceKey, teamId) {
  try {
    const claim = logos.getClaimForTeam(conferenceKey, teamId);
    if (!claim?.userId) return null;
    const user = users.findById(claim.userId);
    return String(user?.name || user?.loginName || '').trim() || null;
  } catch {
    return null;
  }
}

function resolveEspnTeamIdentity(conferenceKey, team, membersById) {
  const ownerId = team?.primaryOwner || (team?.owners || [])[0];
  const espnOwner = ownerName(membersById?.get(ownerId));
  const claimOwner = conferenceKey ? gridironOwnerForEspnTeam(conferenceKey, team?.id) : null;
  const owner = claimOwner || (espnOwner !== 'Owner pending' ? espnOwner : null) || espnOwner;
  const espnName = (team?.name || `${team?.location || ''} ${team?.nickname || ''}`).trim()
    || (team?.id != null ? `Team ${team.id}` : '');
  const key = conferenceKey && team?.id != null ? logos.logoKey(conferenceKey, team.id) : null;
  const overrideName = key ? logos.getNameOverrideMap().get(key) : null;
  const custom = espnTeamNameIsCustom(team);
  const name = overrideName
    || (custom ? espnName : (owner && owner !== 'Owner pending' ? owner : espnName));
  const abbreviation = (custom && team?.abbrev)
    ? team.abbrev
    : (ownerAbbrev(name, team?.abbrev || '') || team?.abbrev || '');
  return { espnName, name, owner, abbreviation };
}

function teamHighPoints(raw, teamId) {
  let high = 0;
  for (const m of raw?.schedule || []) {
    if (Number(m.home?.teamId) === Number(teamId)) {
      high = Math.max(high, Number(m.home?.totalPoints || 0));
    }
    if (Number(m.away?.teamId) === Number(teamId)) {
      high = Math.max(high, Number(m.away?.totalPoints || 0));
    }
  }
  return high;
}

function normalizeStreakType(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (s === 'W' || s === 'WIN' || s === 'WINS') return 'WIN';
  if (s === 'L' || s === 'LOSS' || s === 'LOSSES') return 'LOSS';
  if (s === 'T' || s === 'TIE' || s === 'TIES') return 'TIE';
  return 'NONE';
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
  const teams = (raw.teams || []).map((team) => {
    const record = team.record?.overall || team.record || {};

    const wins = record.wins || 0;
    const losses = record.losses || 0;
    const ties = record.ties || 0;
    const gamesPlayed = wins + losses + ties;
    const pointsFor = Number(record.pointsFor || team.points || 0);
    const streakType = normalizeStreakType(record.streakType || team.streakType);
    const streakLength = Number(record.streakLength || team.streakLength || 0);
    const identity = resolveEspnTeamIdentity(conference.key, team, membersById);
    const key = logos.logoKey(conference.key, team.id);
    const overrideLogo = logoOverrides.get(key);

    return {
      id: team.id,
      name: identity.name,
      espnName: identity.espnName,
      abbreviation: identity.abbreviation,
      logo: logos.displayLogoUrl(overrideLogo),
      logoSource: overrideLogo ? 'gridiron' : 'placeholder',
      espnLogo: team.logo || null,
      owner: identity.owner,
      wins,
      losses,
      ties,
      gamesPlayed,
      pointsFor,
      pointsAgainst: Number(record.pointsAgainst || 0),
      pointsPerGame: gamesPlayed > 0 ? pointsFor / gamesPlayed : 0,
      streakType,
      streakLength,
      highPoints: teamHighPoints(raw, team.id),
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

  const pathBase = `apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${conference.espnLeagueId}`;
  const params = new URLSearchParams();
  for (const view of views) params.append('view', view);
  for (const [key, value] of Object.entries(query || {})) {
    if (value != null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  const pathAndQuery = qs ? `${pathBase}?${qs}` : pathBase;

  try {
    const hit = await espnResilient.fetchJsonResilient({
      urls: espnResilient.fantasyLeagueUrls(pathAndQuery),
      cacheKey: `fantasy:${cacheKey}`,
      ttlMs: CACHE_MS,
      headers: espnAuthHeaders(),
      timeoutMs: 10_000,
      lane: 'fantasy'
    });
    return hit.data;
  } catch (err) {
    if (err.status === 401) {
      err.message = espnAuthHeaders().Cookie
        ? 'ESPN league exists but is private — this ESPN login cannot view it. In ESPN: League settings → make it viewable to anyone (invite-only to join).'
        : 'ESPN league exists but is private. In ESPN: League settings → anyone can view, invite-only to join — then look up again.';
    } else if (err.status === 404) {
      err.message = 'No ESPN league found for that season / league ID';
    } else if (!err.message || /Upstream|All ESPN/.test(err.message)) {
      err.message = err.detail
        ? `ESPN unavailable — ${String(err.detail).slice(0, 120)}`
        : 'ESPN unavailable and no cached snapshot';
    }
    throw err;
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
    const pathAndQuery = `apis/v3/games/ffl/seasons/${seasonNum}/players?scoringPeriodId=0&view=players_wl`;
    try {
      const hit = await espnResilient.fetchJsonResilient({
        urls: espnResilient.fantasyLeagueUrls(pathAndQuery),
        cacheKey: `players:${seasonNum}:${chunk.join(',')}`,
        ttlMs: CACHE_MS,
        headers: {
          ...espnAuthHeaders(),
          'X-Fantasy-Filter': JSON.stringify({ filterIds: { value: chunk } })
        },
        lane: 'fantasy'
      });
      const raw = hit.data;
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
  const membersById = new Map((raw.members || []).map((m) => [m.id, m]));
  const teamsById = new Map();
  for (const team of raw.teams || []) {
    const key = logos.logoKey(conference.key, team.id);
    const overrideLogo = logos.getOverrideMap().get(key);
    const identity = resolveEspnTeamIdentity(conference.key, team, membersById);
    teamsById.set(Number(team.id), {
      id: Number(team.id),
      name: identity.name,
      abbreviation: identity.abbreviation,
      logo: logos.displayLogoUrl(overrideLogo),
      owner: identity.owner
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

/**
 * Build franchise record book from current + archived seasons (matchups + standings).
 */
async function loadRecordBook() {
  const catalog = historySeasonEntries();
  const bags = [];
  const errors = [];
  const fetched = new Set();

  for (const entry of catalog) {
    const season = Number(entry.season);
    const yearLabel = entry.yearNumber
      ? `Year ${entry.yearNumber} (${season})`
      : String(season);
    const confSpecs = [];
    for (const conf of config.conferences) {
      const leagueId = conf.key === 'detail'
        ? entry.detailEspnLeagueId
        : (conf.key === 'overtime' ? entry.overtimeEspnLeagueId : conf.espnLeagueId);
      if (!leagueId) continue;
      confSpecs.push({ conf, leagueId: Number(leagueId) });
    }
    // Deduplicate same ESPN league mapped to both conferences
    const seenLeague = new Set();
    for (const { conf, leagueId } of confSpecs) {
      const fetchKey = `${season}:${leagueId}`;
      if (seenLeague.has(leagueId) || fetched.has(fetchKey)) continue;
      seenLeague.add(leagueId);
      fetched.add(fetchKey);
      const confForFetch = { ...conf, espnLeagueId: leagueId };
      try {
        const raw = await fetchEspnRaw(
          confForFetch,
          ['mTeam', 'mMatchup', 'mStatus'],
          'records',
          {},
          season
        );
        const normalized = normalizeLeague(raw, confForFetch);
        const teamsById = new Map();
        for (const t of normalized.teams || []) {
          teamsById.set(Number(t.id), {
            ...t,
            conferenceKey: conf.key,
            conferenceName: conf.shortName || conf.name
          });
        }
        bags.push({
          season,
          yearLabel,
          conferenceKey: conf.key,
          conferenceName: conf.shortName || conf.name,
          teamsById,
          schedule: raw.schedule || []
        });
      } catch (err) {
        errors.push({
          season,
          conferenceKey: conf.key,
          leagueId,
          error: err.message || 'Could not load'
        });
      }
    }
  }

  const book = recordsLib.buildRecordBook(bags);
  return {
    ok: true,
    records: book.records,
    seasonsScanned: book.seasonsScanned,
    gamesScanned: book.gamesScanned,
    seasonsAvailable: catalog.map((e) => ({
      season: e.season,
      label: e.label,
      yearNumber: e.yearNumber || null
    })),
    errors: errors.length ? errors : undefined,
    espnAuthConfigured: Boolean(process.env.ESPN_SWID && process.env.ESPN_S2),
    generatedAt: new Date().toISOString()
  };
}

/**
 * Live system power rankings for Detail + Overtime.
 * Hidden until both drafts complete; preseason uses Week 1 projections.
 */
async function loadSystemPowerRankings() {
  const generatedAt = new Date().toISOString();
  const season = Number(config.season);
  const conferences = Array.isArray(config.conferences) ? config.conferences : [];

  const draftStatus = [];
  for (const conf of conferences) {
    try {
      const board = await loadDraftBoard(conf.key);
      draftStatus.push({
        key: conf.key,
        name: conf.shortName || conf.name,
        ok: true,
        drafted: Boolean(board?.draft?.drafted),
        inProgress: Boolean(board?.draft?.inProgress)
      });
    } catch (err) {
      draftStatus.push({
        key: conf.key,
        name: conf.shortName || conf.name,
        ok: false,
        drafted: false,
        inProgress: false,
        error: err.message || 'Unavailable'
      });
    }
  }

  const draftsComplete = draftStatus.length > 0
    && draftStatus.every((d) => d.ok && d.drafted && !d.inProgress);

  if (!draftsComplete) {
    return {
      ok: true,
      mode: 'pre_draft',
      message: 'Power rankings will be displayed after the draft.',
      latest: null,
      rankings: [],
      draftStatus,
      season,
      generatedAt
    };
  }

  const leagueBags = await Promise.all(conferences.map(async (conference) => {
    try {
      const raw = await fetchEspnRaw(conference, ['mTeam', 'mMatchup', 'mStatus'], 'power-rankings');
      const data = normalizeLeague(raw, conference);
      const week1 = normalizeSchedule(raw, conference, 1);
      const projectedById = new Map();
      for (const m of week1.matchups || []) {
        if (m.home?.id != null) projectedById.set(Number(m.home.id), Number(m.home.projected) || 0);
        if (m.away?.id != null) projectedById.set(Number(m.away.id), Number(m.away.projected) || 0);
      }
      const teams = (data.teams || []).map((t) => ({
        conferenceKey: conference.key,
        conferenceName: conference.shortName || conference.name,
        teamId: Number(t.id),
        teamName: t.name,
        logo: t.logo || null,
        wins: Number(t.wins) || 0,
        losses: Number(t.losses) || 0,
        ties: Number(t.ties) || 0,
        gamesPlayed: Number(t.gamesPlayed) || 0,
        pointsFor: Number(t.pointsFor) || 0,
        pointsAgainst: Number(t.pointsAgainst) || 0,
        streakType: t.streakType || 'NONE',
        streakLength: Number(t.streakLength) || 0,
        week1Projected: projectedById.get(Number(t.id)) || 0
      }));
      return {
        ok: true,
        key: conference.key,
        currentMatchupPeriod: data.currentMatchupPeriod,
        teams
      };
    } catch (err) {
      return {
        ok: false,
        key: conference.key,
        error: err.message || 'Could not load',
        teams: []
      };
    }
  }));

  const errors = leagueBags.filter((b) => !b.ok).map((b) => ({
    conferenceKey: b.key,
    error: b.error
  }));
  const allTeams = leagueBags.flatMap((b) => b.teams || []);
  if (!allTeams.length) {
    return {
      ok: true,
      mode: 'unavailable',
      message: 'Power rankings are unavailable right now.',
      latest: null,
      rankings: [],
      draftStatus,
      errors: errors.length ? errors : undefined,
      season,
      generatedAt
    };
  }

  const preseason = !powerRankingsCompute.seasonHasStarted(allTeams);
  const currentWeek = leagueBags
    .map((b) => Number(b.currentMatchupPeriod))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => b - a)[0] || 1;

  const ranks = powerRankingsCompute.buildRankRows(allTeams, { preseason });
  const week = preseason ? 1 : currentWeek;
  const notes = preseason
    ? 'Preseason power rankings — ordered by Week 1 projected fantasy points.'
    : 'System power rankings — record, points scored, point differential, and recent form.';

  const latest = {
    id: 'system',
    week,
    season,
    mode: preseason ? 'preseason' : 'in_season',
    notes,
    ranks,
    authorId: null,
    authorName: 'System',
    createdAt: generatedAt,
    system: true
  };

  return {
    ok: true,
    mode: latest.mode,
    message: null,
    latest,
    rankings: [latest],
    draftStatus,
    errors: errors.length ? errors : undefined,
    season,
    generatedAt
  };
}

async function fetchEspnLeague(conference) {
  const raw = await fetchEspnRaw(conference, ['mTeam', 'mMatchup', 'mSettings', 'mStatus'], 'league');
  return normalizeLeague(raw, conference);
}

function playerName(player) {
  if (!player) return 'Unknown player';
  return player.fullName
    || `${player.firstName || ''} ${player.lastName || ''}`.trim()
    || `Player ${player.id || ''}`;
}

function normalizeRosterTeam(team, conference, membersById, lineupSlotCounts = null) {
  const key = logos.logoKey(conference.key, team.id);
  const overrideLogo = logos.getOverrideMap().get(key);
  const identity = resolveEspnTeamIdentity(conference.key, team, membersById);
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
      weekProjected: null,
      empty: false,
      isStarter: !BENCH_OR_IR_SLOTS.has(slotId)
    };
  }).sort((a, b) => {
    return slotSortKey(a.slot) - slotSortKey(b.slot) || String(a.name || '').localeCompare(String(b.name || ''));
  });

  const counts = lineupSlotCounts || DEFAULT_STARTER_SLOT_COUNTS;
  const lineup = fillStarterSlots(
    entries.filter((e) => e.isStarter),
    counts,
    { weekStats: true }
  );
  const bench = entries.filter((e) => !e.isStarter);
  const record = team.record?.overall || {};
  return {
    id: team.id,
    name: identity.name,
    espnName: identity.espnName,
    abbreviation: identity.abbreviation,
    logo: logos.displayLogoUrl(overrideLogo),
    owner: identity.owner,
    wins: record.wins || 0,
    losses: record.losses || 0,
    ties: record.ties || 0,
    pointsFor: Number(record.pointsFor || team.points || 0),
    playoffSeed: Number(team.playoffSeed || 0),
    waiverRank: Number(team.waiverRank || 0),
    lineupSlots: starterSlotPlan(counts),
    lineup,
    bench,
    roster: [...lineup, ...bench]
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

function slotSortKey(slot) {
  const order = { QB: 1, RB: 2, WR: 3, TE: 4, FLEX: 5, 'D/ST': 6, K: 7, Bench: 8, IR: 9 };
  return order[slot] || 50;
}

/** Classic starter shape when ESPN lineupSlotCounts are missing. */
const DEFAULT_STARTER_SLOT_COUNTS = {
  0: 1, // QB
  2: 2, // RB
  4: 2, // WR
  6: 1, // TE
  23: 1, // FLEX
  16: 1, // D/ST
  17: 1 // K
};

const STARTER_SLOT_ORDER = [0, 2, 4, 6, 23, 16, 17];

function lineupSlotCountsFromRaw(raw) {
  const counts = raw?.settings?.rosterSettings?.lineupSlotCounts;
  if (counts && typeof counts === 'object') {
    const hasStarter = Object.keys(counts).some((id) => {
      const n = Number(id);
      return Number(counts[id]) > 0 && !BENCH_OR_IR_SLOTS.has(n) && SLOT_LABELS[n];
    });
    if (hasStarter) return counts;
  }
  return DEFAULT_STARTER_SLOT_COUNTS;
}

function starterSlotPlan(counts) {
  const src = counts && typeof counts === 'object' ? counts : DEFAULT_STARTER_SLOT_COUNTS;
  const plan = [];
  const seen = new Set();
  for (const id of STARTER_SLOT_ORDER) {
    const n = Number(src[id] ?? src[String(id)] ?? 0);
    if (!(n > 0) || !SLOT_LABELS[id]) continue;
    seen.add(id);
    for (let i = 0; i < n; i += 1) {
      plan.push({ slotId: id, slot: SLOT_LABELS[id] });
    }
  }
  for (const [idStr, count] of Object.entries(src)) {
    const id = Number(idStr);
    if (!Number.isFinite(id) || seen.has(id) || BENCH_OR_IR_SLOTS.has(id) || !SLOT_LABELS[id]) continue;
    const n = Number(count) || 0;
    for (let i = 0; i < n; i += 1) {
      plan.push({ slotId: id, slot: SLOT_LABELS[id] });
    }
  }
  return plan.length ? plan : starterSlotPlan(DEFAULT_STARTER_SLOT_COUNTS);
}

function emptySlotPlayer(slotId, slot, { weekStats = false } = {}) {
  return {
    id: null,
    name: null,
    empty: true,
    position: slot || '—',
    slotId,
    slot: slot || SLOT_LABELS[slotId] || '—',
    proTeamId: null,
    proTeam: '',
    byeWeek: null,
    injuryStatus: null,
    acquisitionType: null,
    points: null,
    projected: null,
    weekPoints: weekStats ? null : undefined,
    weekProjected: weekStats ? null : undefined,
    isStarter: !BENCH_OR_IR_SLOTS.has(Number(slotId))
  };
}

function fillStarterSlots(players, counts, { weekStats = false } = {}) {
  const plan = starterSlotPlan(counts);
  const pool = (players || []).filter((p) => {
    const sid = Number(p.slotId);
    if (Number.isFinite(sid) && BENCH_OR_IR_SLOTS.has(sid)) return false;
    if (p.isStarter === false) return false;
    return true;
  });
  const used = new Set();
  const filled = plan.map(({ slotId, slot }) => {
    let idx = pool.findIndex((p, i) => !used.has(i) && Number(p.slotId) === slotId);
    if (idx < 0) {
      idx = pool.findIndex((p, i) => !used.has(i) && String(p.slot) === String(slot));
    }
    if (idx >= 0) {
      used.add(idx);
      return { ...pool[idx], empty: false, slot, slotId };
    }
    return emptySlotPlayer(slotId, slot, { weekStats });
  });
  pool.forEach((p, i) => {
    if (!used.has(i)) filled.push({ ...p, empty: false });
  });
  return filled;
}

function normalizeMatchupLineupEntry(entry, week) {
  const pool = entry?.playerPoolEntry || {};
  const player = pool.player || {};
  const slotId = Number(entry.lineupSlotId);
  const proTeamId = player.proTeamId || null;
  const slot = SLOT_LABELS[slotId] || `Slot ${slotId}`;
  return {
    id: player.id || entry.playerId || null,
    name: playerName(player),
    position: POSITION_LABELS[player.defaultPositionId] || slot || '—',
    slotId,
    slot,
    proTeamId,
    proTeam: PRO_TEAM_ABBREV[proTeamId] || 'FA',
    injuryStatus: player.injuryStatus || null,
    points: playerWeekPoints(entry, week),
    projected: playerWeekProjected(entry, week),
    isStarter: !BENCH_OR_IR_SLOTS.has(slotId)
  };
}

/** Team mRoster entries → same shape as matchup lineup players (ESPN slot assignments). */
function rosterTeamEntriesAsPlayers(rosterTeam) {
  return (rosterTeam?.roster?.entries || []).map((entry) => {
    const pool = entry.playerPoolEntry || {};
    const player = pool.player || {};
    const slotId = Number(entry.lineupSlotId);
    const proTeamId = player.proTeamId || null;
    const slot = SLOT_LABELS[slotId] || `Slot ${slotId}`;
    return {
      id: player.id || entry.playerId || null,
      name: playerName(player),
      position: POSITION_LABELS[player.defaultPositionId] || slot || '—',
      slotId,
      slot,
      proTeamId,
      proTeam: PRO_TEAM_ABBREV[proTeamId] || 'FA',
      injuryStatus: player.injuryStatus || null,
      points: null,
      projected: null,
      isStarter: !BENCH_OR_IR_SLOTS.has(slotId)
    };
  });
}

function lineupHasNamedPlayers(players) {
  return (players || []).some((p) => p && !p.empty && p.name);
}

function applyPointsToLineup(players, statsMap) {
  return (players || []).map((p) => {
    if (p?.empty || p?.id == null) return p;
    const hit = statsMap.get(Number(p.id));
    if (!hit) return p;
    return {
      ...p,
      points: hit.points ?? p.points,
      projected: hit.projected ?? p.projected
    };
  });
}

function normalizeMatchupBoxSide(side, teams, week, lineupSlotCounts, rosterTeam = null, statsMap = null) {
  if (!side) return null;
  const team = teams.get(side.teamId) || {
    id: side.teamId,
    name: `Team ${side.teamId}`,
    logo: logos.PLACEHOLDER_LOGO
  };
  let entries = matchupSideEntries(side)
    .map((entry) => normalizeMatchupLineupEntry(entry, week))
    .sort((a, b) => slotSortKey(a.slot) - slotSortKey(b.slot) || String(a.name || '').localeCompare(String(b.name || '')));
  // Scoreboard payloads often omit lineups until kickoff — use ESPN roster slots after draft.
  if (!lineupHasNamedPlayers(entries.filter((e) => e.isStarter)) && rosterTeam) {
    entries = rosterTeamEntriesAsPlayers(rosterTeam)
      .sort((a, b) => slotSortKey(a.slot) - slotSortKey(b.slot) || String(a.name || '').localeCompare(String(b.name || '')));
  }
  const starters = entries.filter((e) => e.isStarter);
  let bench = entries.filter((e) => !e.isStarter);
  // Matchup scoreboard payloads often include starters only — fill bench from roster.
  if ((!bench.length || !bench.some((p) => p.name)) && rosterTeam) {
    bench = rosterTeamEntriesAsPlayers(rosterTeam)
      .filter((e) => !e.isStarter)
      .sort((a, b) => slotSortKey(a.slot) - slotSortKey(b.slot) || String(a.name || '').localeCompare(String(b.name || '')));
  }
  let lineup = fillStarterSlots(starters, lineupSlotCounts);
  if (statsMap) {
    lineup = applyPointsToLineup(lineup, statsMap);
    bench = applyPointsToLineup(bench, statsMap);
  }
  return {
    id: team.id,
    name: team.name,
    logo: team.logo || logos.PLACEHOLDER_LOGO,
    score: Number(side.totalPoints ?? 0),
    projected: Number(side.totalProjectedPointsLive ?? side.totalProjectedPoints ?? 0),
    lineup,
    bench
  };
}

function buildMatchupBox(raw, conference, week, focusTeamId, lineupSlotCounts = null, rosterRaw = null) {
  const teams = teamMapFromRaw(raw, conference.key);
  const tid = Number(focusTeamId);
  const match = (raw.schedule || []).find((m) =>
    Number(m.matchupPeriodId) === Number(week)
    && (Number(m.home?.teamId) === tid || Number(m.away?.teamId) === tid)
  );
  if (!match) return null;
  const counts = lineupSlotCounts || lineupSlotCountsFromRaw(rosterRaw || raw);
  const rosterById = new Map((rosterRaw?.teams || raw?.teams || []).map((t) => [Number(t.id), t]));
  const homeId = Number(match.home?.teamId);
  const awayId = Number(match.away?.teamId);
  const homeStats = collectPlayerWeekStats(raw, homeId, week);
  const awayStats = collectPlayerWeekStats(raw, awayId, week);
  const home = normalizeMatchupBoxSide(match.home, teams, week, counts, rosterById.get(homeId), homeStats);
  const away = normalizeMatchupBoxSide(match.away, teams, week, counts, rosterById.get(awayId), awayStats);
  if (!home || !away) return null;
  return {
    week: Number(week),
    winner: String(match.winner || 'UNDECIDED').toUpperCase(),
    home,
    away,
    isHome: Number(match.home?.teamId) === tid,
    lineupSlots: starterSlotPlan(counts),
    generatedAt: new Date().toISOString()
  };
}

async function loadTeamDetail(conferenceKey, teamId) {
  const conference = resolveEspnLeague(conferenceKey);
  if (!conference) throw Object.assign(new Error('Unknown conference'), { status: 404 });
  const raw = await fetchEspnRaw(conference, ['mTeam', 'mRoster', 'mStatus'], `roster:${teamId}`);
  const membersById = new Map((raw.members || []).map((m) => [m.id, m]));
  const team = (raw.teams || []).find((t) => Number(t.id) === Number(teamId));
  if (!team) throw Object.assign(new Error('Team not found'), { status: 404 });
  const detail = normalizeRosterTeam(team, conference, membersById, lineupSlotCountsFromRaw(raw));

  const baseSchedule = await fetchEspnRaw(
    conference,
    ['mTeam', 'mMatchup', 'mStatus'],
    'matchup-base'
  );
  const espnWeek = Number(baseSchedule.status?.currentMatchupPeriod || 1);
  const display = await matchupDisplayWeek.resolveDisplayMatchupWeek(espnWeek);
  const currentWeek = Number(display.week || espnWeek);
  const scheduleRaw = await fetchEspnRaw(
    conference,
    ['mTeam', 'mMatchup', 'mScoreboard', 'mStatus'],
    `matchup-scoreboard:${currentWeek}`,
    { scoringPeriodId: currentWeek }
  );
  const schedule = normalizeSchedule(scheduleRaw, conference, currentWeek);
  const weekStats = collectPlayerWeekStats(scheduleRaw, teamId, currentWeek);
  detail.lineup = applyWeekStatsToRoster(detail.lineup, weekStats);
  detail.bench = applyWeekStatsToRoster(detail.bench, weekStats);
  detail.roster = [...detail.lineup, ...detail.bench];
  const matchupBox = buildMatchupBox(
    scheduleRaw,
    conference,
    currentWeek,
    teamId,
    lineupSlotCountsFromRaw(raw),
    raw
  );

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
  if (matchupBox && currentMatchup) {
    currentMatchup = {
      ...currentMatchup,
      home: {
        ...currentMatchup.home,
        score: matchupBox.home.score,
        projected: matchupBox.home.projected
      },
      away: {
        ...currentMatchup.away,
        score: matchupBox.away.score,
        projected: matchupBox.away.projected
      },
      winner: matchupBox.winner || currentMatchup.winner
    };
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
    matchupBox,
    recentMatchups: recent,
    currentMatchupPeriod: espnWeek,
    displayMatchupPeriod: currentWeek,
    matchupWeekHeld: Boolean(display.held),
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
  const counts = lineupSlotCountsFromRaw(raw);
  const teams = (raw.teams || [])
    .map((t) => {
      const detail = normalizeRosterTeam(t, conference, membersById, counts);
      const weekStats = collectPlayerWeekStats(raw, detail.id, currentWeek);
      detail.lineup = applyWeekStatsToRoster(detail.lineup, weekStats);
      detail.bench = applyWeekStatsToRoster(detail.bench, weekStats);
      detail.roster = [...detail.lineup, ...detail.bench];
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

async function loadTransactionsPayload(leagueScope = null) {
  if (leagueScope?.scope === 'aaa') {
    const affiliate = getAffiliatedLeague(leagueScope.conferenceKey || 'aaa');
    const espnId = Number(affiliate?.espnLeagueId);
    if (!affiliate || !Number.isFinite(espnId) || espnId <= 0) {
      return {
        season: config.season,
        generatedAt: new Date().toISOString(),
        leagueScope,
        conferences: [{
          ok: false,
          key: 'aaa',
          name: affiliate?.name || 'AAA League',
          shortName: affiliate?.shortName || 'AAA',
          logo: affiliate?.logo || '/assets/aaa-league.png?v=7',
          error: 'AAA League ESPN ID is not configured yet',
          transactions: []
        }]
      };
    }
    const conference = {
      key: affiliate.key,
      name: affiliate.name,
      shortName: affiliate.shortName || 'AAA',
      espnLeagueId: espnId,
      logo: affiliate.logo || '/assets/aaa-league.png?v=7'
    };
    let row;
    try {
      const raw = await fetchEspnRaw(conference, ['mTeam', 'mTransactions2'], 'aaa-transactions');
      row = { ok: true, ...normalizeTransactions(raw, conference) };
    } catch (error) {
      row = {
        ok: false,
        key: conference.key,
        name: conference.name,
        shortName: conference.shortName,
        logo: conference.logo,
        error: error.message || 'Unavailable',
        transactions: []
      };
    }
    return {
      season: config.season,
      generatedAt: new Date().toISOString(),
      leagueScope,
      conferences: [row]
    };
  }

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
    leagueScope: leagueScope || { scope: 'gridiron' },
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
      const seed = Number(t.playoffSeed || 0);
      if (seed >= 1 && seed <= 6) bySeed.set(seed, t);
    }
    // Fallback: top 6 standings as provisional seeds before ESPN sets playoffSeed 1–6
    if (bySeed.size < 6) {
      teams.slice(0, 6).forEach((t, i) => {
        if (!bySeed.has(i + 1)) bySeed.set(i + 1, { ...t, playoffSeed: i + 1, provisional: true });
      });
    }
    const seedByTeamId = new Map();
    for (const [seed, t] of bySeed) {
      if (t?.id != null) seedByTeamId.set(Number(t.id), seed);
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
        owner: t.owner || null,
        provisional: Boolean(t.provisional) || Number(t.playoffSeed || 0) === 0
      };
    };

    const withSeed = (side) => {
      if (!side) return null;
      const seed = seedByTeamId.get(Number(side.id)) || Number(byId.get(side.id)?.playoffSeed || 0) || null;
      return { ...side, seed };
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
        home: withSeed(m.home),
        away: withSeed(m.away),
        playoffTierType: m.playoffTierType || null
      };
    };

    const sideFromSeed = (seedNum) => {
      const s = slot(seedNum);
      if (!s) return null;
      return {
        id: s.id,
        name: s.name,
        logo: s.logo || null,
        owner: s.owner || null,
        seed: s.seed,
        score: 0,
        projected: 0
      };
    };
    const seededGame = (espnMatchup, seedA, seedB, label) => {
      const real = espnMatchup && (isWinnersBracketMatchup(espnMatchup) || isConsolationMatchup(espnMatchup));
      if (real) return { ...formatGame(espnMatchup, label), hypothetical: false };
      return {
        label,
        status: 'upcoming',
        winner: 'UNDECIDED',
        hypothetical: true,
        home: sideFromSeed(seedA),
        away: sideFromSeed(seedB),
        playoffTierType: null
      };
    };

    const playable14 = (w14?.matchups || []).filter((m) => m.home && m.away);
    const playoff14 = playable14.filter((m) => isWinnersBracketMatchup(m) || isConsolationMatchup(m));
    const game45 = seededGame(pickMatchupForSeeds(playoff14, 4, 5, byId), 4, 5, '#4 vs #5');
    const game36 = seededGame(pickMatchupForSeeds(playoff14, 3, 6, byId), 3, 6, '#3 vs #6');

    const playable15 = (w15?.matchups || []).filter((m) => m.home && m.away);
    const winners15 = playable15.filter(isWinnersBracketMatchup);
    const semisEspn = (winners15.length ? winners15 : []).slice(0, 2);
    const semis = [
      seededGame(semisEspn[0], 1, 4, 'Semifinal 1'),
      seededGame(semisEspn[1], 2, 3, 'Semifinal 2')
    ];

    const playable16 = (w16?.matchups || []).filter((m) => m.home && m.away);
    const title16 = playable16.find(isWinnersBracketMatchup) || null;
    const third16 = playable16.find(isConsolationMatchup) || null;

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
          game45,
          game36
        },
        semifinals: {
          week: 15,
          games: semis
        },
        finals: {
          week: 16,
          title: seededGame(title16, 1, 2, 'Conference Title'),
          third: seededGame(third16, 3, 4, 'Third Place')
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
    playoffReseed: schedule.playoffReseed == null ? null : Boolean(schedule.playoffReseed),
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
  const map = new Map();
  for (const team of raw.teams || []) {
    const key = conferenceKey ? logos.logoKey(conferenceKey, team.id) : null;
    const overrideLogo = key ? logoOverrides.get(key) : null;
    const identity = resolveEspnTeamIdentity(conferenceKey, team, membersById);
    map.set(team.id, {
      id: team.id,
      name: identity.name,
      logo: logos.displayLogoUrl(overrideLogo),
      logoSource: overrideLogo ? 'gridiron' : 'placeholder',
      owner: identity.owner,
      abbreviation: identity.abbreviation,
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
  const membersById = new Map((raw.members || []).map((m) => [m.id, m]));
  for (const team of raw.teams || []) {
    const key = logos.logoKey(conference.key, team.id);
    const identity = resolveEspnTeamIdentity(conference.key, team, membersById);
    const teamName = identity.name;
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

    let sendResult;
    try {
      sendResult = await sendRosterViolationEmail({
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
    } catch (err) {
      sendResult = { sent: false, method: 'error', error: err.message || String(err) };
    }

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
    try {
      firstQuarter = await nflverseLive.getFirstQuarterPatrolState({
        season: config.season,
        seasontype: 2
      });
    } catch (err) {
      return {
        ok: true,
        skipped: true,
        reason: 'scoreboard_unavailable',
        error: err.message || String(err),
        triggeredBy,
        season: config.season,
        openCount: rosterViolations.listOpen({ season: config.season }).length,
        generatedAt: new Date().toISOString()
      };
    }
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

  try {
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
      try {
        notifications = await notifyRosterViolationManagers(open, { force: forceNotify, week });
      } catch (err) {
        notifications = [{ sent: false, error: err.message || String(err) }];
      }
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
  } catch (err) {
    console.error('[roster-violations] job failed', err);
    return {
      ok: false,
      skipped: true,
      reason: 'job_failed',
      error: err.message || String(err),
      triggeredBy,
      season: config.season,
      firstQuarter,
      generatedAt: new Date().toISOString()
    };
  }
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
      logo: affiliate.logo || '/assets/aaa-league.png?v=7'
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

async function loadAaaLeagueSettings() {
  const affiliate = getAffiliatedLeague('aaa');
  const espnId = Number(affiliate?.espnLeagueId);
  if (!affiliate || !Number.isFinite(espnId) || espnId <= 0) {
    return {
      ok: false,
      configured: false,
      key: 'aaa',
      name: affiliate?.name || 'AAA League',
      shortName: affiliate?.shortName || 'AAA',
      leagueId: null,
      logo: affiliate?.logo || '/assets/aaa-league.png?v=7',
      error: 'AAA League ESPN ID is not configured'
    };
  }
  const conference = {
    key: affiliate.key || 'aaa',
    name: affiliate.name || 'AAA League',
    shortName: affiliate.shortName || 'AAA',
    espnLeagueId: espnId,
    logo: affiliate.logo || '/assets/aaa-league.png?v=7'
  };
  try {
    const raw = await fetchEspnRaw(conference, ['mSettings', 'mStatus'], 'aaa-settings');
    return {
      ok: true,
      configured: true,
      ...normalizeSettings(raw, conference)
    };
  } catch (error) {
    return {
      ok: false,
      configured: true,
      key: conference.key,
      name: conference.name,
      shortName: conference.shortName,
      leagueId: espnId,
      logo: conference.logo,
      error: error.name === 'AbortError' ? 'ESPN request timed out' : error.message
    };
  }
}

function espnLeagueSeasonQuery(season) {
  const yr = Number(season) || Number(config.season);
  return Number.isFinite(yr) && yr > 0 ? `?seasonId=${yr}` : '';
}

function espnLeagueOfficeUrl(leagueId, season) {
  const id = Number(leagueId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return `https://fantasy.espn.com/football/league/_/leagueId/${id}${espnLeagueSeasonQuery(season)}`;
}

function espnSettingsUrl(leagueId, season) {
  const id = Number(leagueId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return `https://fantasy.espn.com/football/league/_/leagueId/${id}/settings${espnLeagueSeasonQuery(season)}`;
}

function seedEspnLeagueIds() {
  // Retired ESPN IDs from the previous Detail / Overtime leagues.
  // New 2026 recreations must not be flagged as "previous."
  return new Set([559054421, 236438046]);
}

function parseEspnLeagueId(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const fromQuery = text.match(/[?&#]leagueId=(\d+)/i);
  if (fromQuery) return Number(fromQuery[1]);
  const fromPathKey = text.match(/\/(?:leagueId)\/(\d+)/i);
  if (fromPathKey) return Number(fromPathKey[1]);
  const fromIdSegment = text.match(/\/_\/id\/(\d+)/i);
  if (fromIdSegment) return Number(fromIdSegment[1]);
  const fromLeagues = text.match(/\/leagues\/(\d+)/i);
  if (fromLeagues) return Number(fromLeagues[1]);
  if (/^\d{4,}$/.test(text)) return Number(text);
  const matches = [...text.matchAll(/(\d{6,})/g)].map((m) => Number(m[1]));
  const notSeason = matches.filter((n) => n < 1990 || n > 2100);
  if (notSeason.length) return notSeason[0];
  return null;
}

function espnBindingLogo(row) {
  if (row?.logo) return row.logo;
  if (row?.key === 'detail') return '/assets/detail-conference.png';
  if (row?.key === 'overtime') return '/assets/overtime-conference.png';
  if (row?.key === 'aaa') return '/assets/aaa-league.png?v=7';
  return null;
}

function espnBindingUrls(leagueId, season) {
  return {
    leagueUrl: espnLeagueOfficeUrl(leagueId, season),
    settingsUrl: espnSettingsUrl(leagueId, season)
  };
}

function listEspnLeagueBindings() {
  const season = Number(config.season);
  const seeds = seedEspnLeagueIds();
  const toRow = (row, kind) => {
    const espnLeagueId = Number(row.espnLeagueId) > 0 ? Number(row.espnLeagueId) : null;
    return {
      key: row.key,
      kind,
      name: row.name,
      shortName: row.shortName,
      logo: espnBindingLogo(row),
      espnLeagueId,
      previousEspnId: espnLeagueId != null && seeds.has(espnLeagueId),
      ...espnBindingUrls(espnLeagueId, season)
    };
  };
  const conferences = (config.conferences || []).map((c) => toRow(c, 'conference'));
  const affiliates = (config.affiliatedLeagues || []).map((l) => toRow(l, 'affiliate'));
  return {
    season,
    leagues: [...conferences, ...affiliates]
  };
}

async function peekEspnLeagueById(espnLeagueId, seasonOverride = null) {
  const id = Number(espnLeagueId);
  if (!Number.isFinite(id) || id <= 0) {
    throw Object.assign(new Error('Enter a valid ESPN league ID'), { status: 400 });
  }
  const season = Number(seasonOverride) || Number(config.season);
  const raw = await fetchEspnRaw(
    { key: 'peek', name: 'ESPN', espnLeagueId: id },
    ['mTeam', 'mSettings', 'mStatus'],
    'espn-id-peek',
    {},
    season
  );
  const teams = Array.isArray(raw.teams) ? raw.teams : [];
  return {
    ok: true,
    espnLeagueId: id,
    season,
    name: raw.settings?.name || raw.settings?.naming?.name || `ESPN League ${id}`,
    size: Number(raw.settings?.size || teams.length) || teams.length,
    isViewable: raw.status?.isViewable ?? raw.settings?.isPublic ?? null,
    settingsUrl: espnSettingsUrl(id, season),
    leagueUrl: espnLeagueOfficeUrl(id, season),
    previousEspnId: seedEspnLeagueIds().has(id)
  };
}

async function runRulesSyncJob({
  triggeredBy = 'system',
  notify = true,
  notifyOnMatch = false
} = {}) {
  const [conferences, aaa, nflLock] = await Promise.all([
    loadConferenceSettings(),
    loadAaaLeagueSettings(),
    seasonRulesLock.getStatus(config.season)
  ]);
  const detail = conferences.find((c) => c.key === 'detail') || null;
  const overtime = conferences.find((c) => c.key === 'overtime') || null;
  const freeze = Boolean(nflLock.locked);
  const adoptDetail = !freeze && Boolean(detail?.ok);
  const officialSnap = freeze
    ? rulesSyncStore.getOfficialScoring()
    : (detail?.ok
      ? officialRules.snapshotFromDetail(detail, { season: config.season })
      : rulesSyncStore.getOfficialScoring());
  const official = officialRules.asComparable(officialSnap);
  const detailCmp = compareScoringSettings(official, detail);
  const overtimeCmp = compareScoringSettings(official, overtime);
  const gi24Ok = Boolean(detail?.ok && overtime?.ok);
  const gi24Matched = gi24Ok && detailCmp.matched && overtimeCmp.matched;
  const diffs = [
    ...(detailCmp.diffs || []).map((d) => ({ ...d, peer: 'detail' })),
    ...(overtimeCmp.diffs || []).map((d) => ({ ...d, peer: 'overtime' }))
  ];
  const aaaCmp = aaa.configured === false
    ? {
        matched: false,
        bothOk: false,
        configured: false,
        diffCount: 0,
        diffs: [],
        byKind: { Setting: [], Playoff: [], Scoring: [], Lineup: [] }
      }
    : {
        ...compareScoringSettings(official, aaa),
        configured: true
      };
  aaaCmp.diffCount = (aaaCmp.diffs || []).length;
  const detailDrift = detail?.ok && (!detailCmp.matched || freeze)
    ? detailCmp
    : null;

  const store = rulesSyncStore.saveCheck({
    matched: gi24Matched,
    bothOk: gi24Ok,
    diffs,
    detail,
    triggeredBy,
    season: config.season,
    aaaSync: aaaCmp,
    adoptDetail,
    seasonLock: nflLock,
    detailDrift,
    detailSync: detailCmp,
    overtimeSync: overtimeCmp
  });

  const result = {
    ok: true,
    matched: gi24Matched,
    bothOk: gi24Ok,
    diffCount: diffs.length,
    diffs,
    aaaSync: {
      matched: aaaCmp.matched,
      bothOk: aaaCmp.bothOk,
      configured: aaaCmp.configured !== false,
      diffCount: aaaCmp.diffCount,
      diffs: aaaCmp.diffs,
      leagueId: aaa.leagueId || null,
      name: aaa.name || 'AAA League'
    },
    detailSync: {
      matched: Boolean(detailCmp.matched),
      bothOk: Boolean(detailCmp.bothOk),
      diffCount: (detailCmp.diffs || []).length
    },
    overtimeSync: {
      matched: Boolean(overtimeCmp.matched),
      bothOk: Boolean(overtimeCmp.bothOk),
      diffCount: (overtimeCmp.diffs || []).length
    },
    detailDrift: detailDrift
      ? {
          matched: detailDrift.matched,
          bothOk: detailDrift.bothOk,
          diffCount: (detailDrift.diffs || []).length
        }
      : null,
    officialUpdated: Boolean(adoptDetail && store.officialScoring),
    rulesLocked: Boolean(store.seasonRulesLock?.locked || store.officialScoring?.lockedAt),
    seasonRulesLock: store.seasonRulesLock,
    lastCheck: store.lastCheck,
    officialScoring: store.officialScoring,
    generatedAt: new Date().toISOString()
  };

  const conferenceDrift = gi24Ok && !gi24Matched;
  const aaaDrift = aaaCmp.configured !== false && aaaCmp.bothOk && !aaaCmp.matched;
  const shouldMail = notify && (
    conferenceDrift ||
    aaaDrift ||
    (notifyOnMatch && gi24Matched && (aaaCmp.configured === false || aaaCmp.matched))
  );
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
          matched: gi24Matched,
          diffs,
          detailSync: result.detailSync,
          overtimeSync: result.overtimeSync,
          aaaSync: result.aaaSync,
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

  console.log(
    `[rules-sync] matched=${gi24Matched} detailDiffs=${(detailCmp.diffs || []).length} overtimeDiffs=${(overtimeCmp.diffs || []).length} aaaMatched=${aaaCmp.matched} aaaDiffs=${aaaCmp.diffCount} by=${triggeredBy}`
  );
  return result;
}

async function apiSettings(res) {
  const [results, aaa, nflLock] = await Promise.all([
    loadConferenceSettings(),
    loadAaaLeagueSettings(),
    seasonRulesLock.getStatus(config.season)
  ]);
  const detail = results.find((c) => c.key === 'detail') || null;
  if (!nflLock.locked && detail?.ok) {
    rulesSyncStore.refreshFromDetail(detail, { season: config.season, seasonLock: nflLock });
  }
  const sync = rulesSyncStore.getStatus();
  const seasonLock = nflLock.locked
    ? { ...nflLock, lockedAt: sync.seasonRulesLock?.lockedAt || nflLock.lockedAt }
    : { ...nflLock, locked: false };
  const official = officialRules.asComparable(sync.officialScoring);
  const aaaCmp = aaa.configured === false
    ? null
    : compareScoringSettings(official, aaa);

  sendJson(res, 200, {
    season: config.season,
    brand: config.brand,
    championship: config.championship || null,
    structure: config.structure || null,
    generatedAt: new Date().toISOString(),
    conferences: results,
    aaa,
    aaaSync: aaaCmp
      ? {
          ...aaaCmp,
          configured: true,
          diffCount: aaaCmp.diffs.length,
          espn: {
            detail: espnSettingsUrl(detail?.leagueId, config.season),
            aaa: espnSettingsUrl(aaa.leagueId, config.season)
          }
        }
      : {
          matched: false,
          bothOk: false,
          configured: false,
          diffCount: 0,
          diffs: [],
          espn: {
            detail: espnSettingsUrl(detail?.leagueId, config.season),
            aaa: null
          }
        },
    espnLinks: {
      detail: espnSettingsUrl(
        results.find((c) => c.key === 'detail')?.leagueId,
        config.season
      ),
      overtime: espnSettingsUrl(
        results.find((c) => c.key === 'overtime')?.leagueId,
        config.season
      ),
      aaa: espnSettingsUrl(aaa.leagueId, config.season)
    },
    rulesSync: sync.lastCheck,
    officialScoring: sync.officialScoring,
    seasonRulesLock: seasonLock
  });
}

async function apiOfficialScoring(res) {
  const [live, nflLock] = await Promise.all([
    loadConferenceSettings(),
    seasonRulesLock.getStatus(config.season)
  ]);
  const secondaryKey = (config.conferences || []).find((c) => c.key !== 'detail')?.key
    || (config.conferences || [])[1]?.key
    || 'overtime';
  const overtime = live.find((c) => c.key === secondaryKey) || live[1] || null;
  const detail = live.find((c) => c.key === 'detail') || live[0] || null;
  if (!nflLock.locked && detail?.ok) {
    rulesSyncStore.refreshFromDetail(detail, { season: config.season, seasonLock: nflLock });
  }
  const sync = rulesSyncStore.getStatus();
  const seasonLock = nflLock.locked ? nflLock : sync.seasonRulesLock;
  const official = officialRules.asComparable(sync.officialScoring);
  const detailCmp = compareScoringSettings(official, detail);
  const overtimeCmp = compareScoringSettings(official, overtime);
  const bothOk = Boolean(detailCmp.bothOk && overtimeCmp.bothOk);
  const matched = bothOk && detailCmp.matched && overtimeCmp.matched;

  sendJson(res, 200, {
    ok: true,
    season: config.season,
    generatedAt: new Date().toISOString(),
    source: 'official',
    synced: matched,
    aaaEnabled: Boolean(config.aaaEnabled) && Array.isArray(config.affiliatedLeagues) && config.affiliatedLeagues.length > 0,
    rulesSync: sync.lastCheck,
    officialScoring: sync.officialScoring,
    seasonRulesLock: seasonLock,
    scoring: {
      ok: true,
      key: official.key,
      name: official.name,
      shortName: official.shortName,
      playerRankType: official.playerRankType,
      scoringType: official.scoringType,
      scoringItems: refreshScoringDisplays(official.scoringItems),
      lineup: official.lineup,
      playoffTeamCount: official.playoffTeamCount,
      playoffReseed: official.playoffReseed,
      matchupPeriodCount: official.matchupPeriodCount,
      playoffMatchupPeriodLength: official.playoffMatchupPeriodLength,
      playoffSeedingRule: official.playoffSeedingRule,
      finalScoringPeriod: official.finalScoringPeriod,
      firstPlayoffWeek: official.firstPlayoffWeek,
      playoffWeekCount: official.playoffWeekCount
    },
    conferences: live,
    compare: {
      matched,
      bothOk,
      diffCount: (detailCmp.diffs || []).length + (overtimeCmp.diffs || []).length,
      detail: {
        matched: Boolean(detailCmp.matched),
        bothOk: Boolean(detailCmp.bothOk),
        diffCount: (detailCmp.diffs || []).length
      },
      overtime: {
        matched: Boolean(overtimeCmp.matched),
        bothOk: Boolean(overtimeCmp.bothOk),
        diffCount: (overtimeCmp.diffs || []).length
      }
    }
  });
}

async function scheduleForConference(conference, weekParam, cacheTag = 'matchup') {
  try {
    const raw = await fetchEspnRaw(conference, ['mTeam', 'mMatchup', 'mStatus'], cacheTag);
    const espnWeek = Number(raw.status?.currentMatchupPeriod || 1);
    let week = Number(weekParam || 0);
    let held = false;
    if (!(week > 0)) {
      const display = await matchupDisplayWeek.resolveDisplayMatchupWeek(espnWeek);
      week = Number(display.week || espnWeek);
      held = Boolean(display.held);
    }
    return {
      ok: true,
      ...normalizeSchedule(raw, conference, week),
      espnMatchupPeriod: espnWeek,
      matchupWeekHeld: held
    };
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

/** Fantasy boards for the Members Lounge sports scoreboard (GI24 + AAA). */
async function loadFantasySportsBoards() {
  const boards = [];
  try {
    const confResults = await Promise.all(
      (config.conferences || []).map((conference) => scheduleForConference(conference))
    );
    boards.push(sportsScoreboard.boardFromFantasyConferences({
      id: 'gi24',
      label: 'GridIron 24',
      logo: '/assets/gridiron24-league.png?v=8'
    }, confResults));
  } catch (err) {
    console.error('[sports-scores] GridIron 24 board failed', err.message || err);
    boards.push({
      ok: false,
      id: 'gi24',
      label: 'GridIron 24',
      kind: 'team',
      fantasy: true,
      logo: '/assets/gridiron24-league.png?v=8',
      error: err.message || 'Unavailable',
      counts: { live: 0, final: 0, upcoming: 0 },
      games: []
    });
  }

  try {
    const affiliate = getAffiliatedLeague('aaa');
    const espnId = Number(affiliate?.espnLeagueId);
    if (affiliate && Number.isFinite(espnId) && espnId > 0) {
      const conference = {
        key: affiliate.key || 'aaa',
        name: affiliate.name || 'AAA League',
        shortName: affiliate.shortName || 'AAA',
        espnLeagueId: espnId,
        logo: affiliate.logo || '/assets/aaa-league.png?v=7'
      };
      const aaa = await scheduleForConference(conference, null, 'aaa-matchup');
      boards.push(sportsScoreboard.boardFromFantasyConferences({
        id: 'aaa',
        label: affiliate.shortName || 'AAA',
        logo: '/assets/aaa-league.png?v=7'
      }, [aaa]));
    }
  } catch (err) {
    console.error('[sports-scores] AAA board failed', err.message || err);
    boards.push({
      ok: false,
      id: 'aaa',
      label: 'AAA',
      kind: 'team',
      fantasy: true,
      logo: '/assets/aaa-league.png?v=7',
      error: err.message || 'Unavailable',
      counts: { live: 0, final: 0, upcoming: 0 },
      games: []
    });
  }

  return boards;
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
          logo: affiliate?.logo || '/assets/aaa-league.png?v=7',
          error: 'AAA League ESPN ID is not configured yet'
        }]
      });
    }
    const conference = {
      key: affiliate.key,
      name: affiliate.name,
      shortName: affiliate.shortName || 'AAA',
      espnLeagueId: espnId,
      logo: affiliate.logo || '/assets/aaa-league.png?v=7'
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
    upstream: upstreamMeta(),
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
    upstream: upstreamMeta(),
    conferences: results
  });
}

function leagueRosterDisplayName(user) {
  if (!user) return null;
  const name = String(user.name || '').trim();
  const login = String(user.loginName || '').trim();
  return name || login || null;
}

/** HQ membership for a pending invite. Independent-league and social invites are excluded. */
function inviteHqMembership(invite) {
  if (!invite || invite.loungeOnly || invite.leagueId) return null;
  return users.normalizeMembershipLeague(invite.membershipLeague) || 'gridiron';
}

function rosterToken(value) {
  return String(value || '').trim().toLowerCase();
}

function rosterMemberKeys(name, email) {
  const keys = new Set();
  const display = rosterToken(name);
  if (display) keys.add(`name:${display}`);
  const mail = rosterToken(email);
  if (mail) keys.add(`email:${mail}`);
  return keys;
}

function rosterInviteKeys(name, email) {
  const keys = rosterMemberKeys(name, email);
  const display = rosterToken(name);
  const mail = rosterToken(email) || display;
  const local = mail.includes('@') ? mail.split('@')[0] : mail;
  const pretty = local.replace(/[._+-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (pretty) keys.add(`name:${pretty}`);
  const lastFromName = display.split(/\s+/).filter(Boolean).pop();
  if (lastFromName && lastFromName.length >= 4) keys.add(`last:${lastFromName}`);
  const lastFromEmail = pretty.split(/\s+/).filter(Boolean).pop();
  if (lastFromEmail && lastFromEmail.length >= 4) keys.add(`last:${lastFromEmail}`);
  if (local && lastFromName && lastFromName.length >= 4 && local.includes(lastFromName)) {
    keys.add(`last:${lastFromName}`);
  }
  return keys;
}

function preferRosterMember(a, b) {
  const rank = (u) => {
    if (u?.siteOwner) return 0;
    if (u?.role === 'commissioner') return 1;
    if (u?.role === 'conference_admin') return 2;
    return 3;
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra < rb ? a : b;
  return String(a?.loginName || '').localeCompare(String(b?.loginName || '')) <= 0 ? a : b;
}

function padLeagueRosterSlots(entries, slotCount) {
  const seen = new Set();
  const names = [];
  function take(entry) {
    const invited = Boolean(entry.invited);
    const name = String(entry?.name || '').trim();
    if (!name) return;
    const email = entry.email || (invited ? name : '');
    // Invites must not collapse against member last names / email local-parts.
    // Only skip an invite when that exact email is already on the board.
    if (invited) {
      const mail = rosterToken(email);
      if (!mail || seen.has(`email:${mail}`)) return;
      seen.add(`email:${mail}`);
      names.push({
        name,
        userId: entry.userId || null,
        invited: true,
        pendingApproval: Boolean(entry.pendingApproval)
      });
      return;
    }
    const matchKeys = rosterMemberKeys(name, email);
    if ([...matchKeys].some((key) => seen.has(key))) return;
    for (const key of rosterInviteKeys(name, email)) seen.add(key);
    names.push({
      name,
      userId: entry.userId || null,
      invited: false
    });
  }
  for (const entry of entries) {
    if (!entry?.invited) take(entry);
  }
  for (const entry of entries) {
    if (entry?.invited) take(entry);
  }
  const count = Math.max(Number(slotCount) || 0, names.length);
  const slots = [];
  for (let i = 0; i < count; i++) {
    const member = names[i] || null;
    slots.push({
      slot: i + 1,
      name: member?.name || null,
      userId: member?.userId || null,
      invited: Boolean(member?.invited),
      pendingApproval: Boolean(member?.pendingApproval),
      vacant: !member
    });
  }
  return slots;
}

function loadLeagueRoster() {
  try {
    users.syncHqConferenceFromClaims(logos.listClaims());
  } catch (err) {
    console.warn('[league-roster] conference sync failed', err.message || err);
  }
  const allUsers = users.listUsers();
  const members = allUsers.filter((u) => u.approved !== false && !u.loungeOnly);
  const emailsWithAccounts = new Set(
    allUsers.map((u) => String(u.email || '').trim().toLowerCase()).filter(Boolean)
  );
  const acceptedByEmail = new Map();
  for (const inv of invites.listInvites()) {
    if (inv.status !== 'accepted') continue;
    const mail = String(inv.email || '').trim().toLowerCase();
    if (mail) acceptedByEmail.set(mail, inv);
  }
  const pendingInvites = invites.listInvites().filter((inv) => {
    if (inv.status !== 'pending') return false;
    if (!inviteHqMembership(inv)) return false;
    return !emailsWithAccounts.has(String(inv.email || '').trim().toLowerCase());
  });

  function intendedMembership(u) {
    if (!u || u.loungeOnly) return null;
    if (u.approved !== false) return users.hqMembershipOf(u);
    const explicit = users.normalizeMembershipLeague(u.membershipLeague);
    if (explicit) return explicit;
    const inv = acceptedByEmail.get(String(u.email || '').trim().toLowerCase());
    return inviteHqMembership(inv);
  }

  function memberMatchesBoard(u, leagueKey) {
    const membership = users.hqMembershipOf(u);
    if (leagueKey === 'aaa') return membership === 'aaa';
    if (leagueKey === 'detail' || leagueKey === 'overtime') {
      return membership === 'gridiron' && users.hqConferenceOf(u) === leagueKey;
    }
    if (leagueKey === 'unassigned') {
      return membership === 'gridiron' && !users.hqConferenceOf(u);
    }
    return membership === leagueKey;
  }

  function assignedEntries(leagueKey) {
    const byName = new Map();
    for (const u of members.filter((row) => memberMatchesBoard(row, leagueKey))) {
      const name = leagueRosterDisplayName(u);
      if (!name) continue;
      const key = rosterToken(name);
      const prev = byName.get(key);
      byName.set(key, prev ? preferRosterMember(prev, u) : u);
    }
    return [...byName.values()]
      .map((u) => ({
        name: leagueRosterDisplayName(u),
        userId: u.id,
        email: String(u.email || '').trim().toLowerCase(),
        invited: false
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  function waitingEntries(leagueKey) {
    const inviteLeague = leagueKey === 'unassigned' ? 'gridiron' : leagueKey;
    if (leagueKey === 'detail' || leagueKey === 'overtime') return [];
    return allUsers
      .filter((u) => u.approved === false && !u.loungeOnly)
      .filter((u) => intendedMembership(u) === inviteLeague)
      .map((u) => ({
        name: leagueRosterDisplayName(u) || String(u.email || '').trim().toLowerCase(),
        email: String(u.email || '').trim().toLowerCase(),
        userId: u.id,
        invited: true,
        pendingApproval: true
      }))
      .filter((row) => row.name)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  function invitedEntries(leagueKey) {
    const inviteLeague = leagueKey === 'unassigned' ? 'gridiron' : leagueKey;
    if (leagueKey === 'detail' || leagueKey === 'overtime') return [];
    return pendingInvites
      .filter((inv) => inviteHqMembership(inv) === inviteLeague)
      .map((inv) => ({
        name: String(inv.email || '').trim().toLowerCase(),
        email: String(inv.email || '').trim().toLowerCase(),
        userId: null,
        invited: true,
        pendingApproval: false
      }))
      .filter((row) => row.name)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  function entriesFor(leagueKey) {
    return [...assignedEntries(leagueKey), ...waitingEntries(leagueKey), ...invitedEntries(leagueKey)];
  }

  function leaguePayload(key, slotCount, meta, opts = {}) {
    const cap = Number(slotCount) || 0;
    const slots = padLeagueRosterSlots(entriesFor(key), cap);
    const assigned = slots.filter((s) => !s.vacant && !s.invited).length;
    const invited = slots.filter((s) => s.invited).length;
    const holding = Boolean(opts.holding);
    return {
      key,
      name: meta.name,
      shortName: meta.shortName,
      logo: meta.logo,
      slotCount: holding ? assigned + invited : cap,
      assigned,
      invited,
      open: holding ? 0 : Math.max(0, cap - assigned),
      filled: assigned,
      holding,
      slots
    };
  }

  const aaa = getAffiliatedLeague('aaa');
  const detail = (config.conferences || []).find((c) => c.key === 'detail') || {};
  const overtime = (config.conferences || []).find((c) => c.key === 'overtime') || {};
  const confCap = users.GRIDIRON_CONFERENCE_CAP || 12;
  const leagues = [
    leaguePayload('detail', confCap, {
      name: detail.name || 'Detail Conference',
      shortName: detail.shortName || 'DETAIL',
      logo: detail.logo || '/assets/detail-conference.png'
    }),
    leaguePayload('overtime', confCap, {
      name: overtime.name || 'Overtime Conference',
      shortName: overtime.shortName || 'OVERTIME',
      logo: overtime.logo || '/assets/overtime-conference.png'
    })
  ];
  const unassigned = leaguePayload('unassigned', 0, {
    name: 'GridIron 24 — no conference yet',
    shortName: 'OPEN',
    logo: config.brand?.logo || '/assets/gridiron24-league.png?v=8'
  }, { holding: true });
  if ((unassigned.assigned || 0) + (unassigned.invited || 0) > 0) {
    if (!(unassigned.assigned) && unassigned.invited) {
      unassigned.name = 'Invited / waiting';
      unassigned.shortName = 'INVITED';
    }
    leagues.push(unassigned);
  }
  leagues.push(leaguePayload('aaa', users.LEAGUE_MEMBERSHIP_CAPS.aaa || 12, {
    name: aaa?.name || 'AAA',
    shortName: aaa?.shortName || 'AAA',
    logo: aaa?.logo || '/assets/aaa-league.png?v=7'
  }));
  return {
    ok: true,
    season: config.season,
    brand: config.brand,
    source: 'app',
    leagues,
    generatedAt: new Date().toISOString()
  };
}

function upstreamMeta() {
  const u = espnResilient.getUpstreamStatus();
  const fantasyMode = u.fantasy?.mode || 'unknown';
  const siteMode = u.site?.mode || 'unknown';
  const degraded = fantasyMode === 'down' || siteMode === 'down';
  return {
    degraded,
    fantasy: u.fantasy,
    site: u.site,
    news: u.news
  };
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
    upstream: upstreamMeta(),
    conferences: results
  };
}

async function loadSchedulePayload(weekParam) {
  const explicit = weekParam != null && Number(weekParam) > 0 ? Number(weekParam) : null;
  let displayWeek = explicit;
  let held = false;
  let espnWeek = null;
  if (displayWeek == null) {
    try {
      const probe = config.conferences?.[0]
        ? await fetchEspnRaw(config.conferences[0], ['mStatus'], 'matchup-week-probe')
        : null;
      espnWeek = Number(probe?.status?.currentMatchupPeriod || 1);
      const display = await matchupDisplayWeek.resolveDisplayMatchupWeek(espnWeek);
      displayWeek = Number(display.week || espnWeek);
      held = Boolean(display.held);
    } catch {
      displayWeek = 1;
    }
  }
  const results = await Promise.all(
    config.conferences.map(async (conference) => {
      try {
        const raw = await fetchEspnRaw(conference, ['mTeam', 'mMatchup', 'mStatus'], 'matchup');
        const week = Number(displayWeek || raw.status?.currentMatchupPeriod || 1);
        return {
          ok: true,
          ...normalizeSchedule(raw, conference, week),
          espnMatchupPeriod: Number(raw.status?.currentMatchupPeriod || week),
          matchupWeekHeld: held
        };
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
  const week = results.find((r) => r.ok)?.week || Number(displayWeek || 1);
  return {
    season: config.season,
    week,
    espnMatchupPeriod: espnWeek || results.find((r) => r.ok)?.espnMatchupPeriod || week,
    matchupWeekHeld: held,
    generatedAt: new Date().toISOString(),
    upstream: upstreamMeta(),
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
  const survivalCfg = config.survival || { enabled: true, week: 17, name: 'MAYORS CUP' };
  if (survivalCfg.enabled === false) {
    return {
      ok: true,
      enabled: false,
      season: config.season,
      name: survivalCfg.name || 'MAYORS CUP',
      week: Number(survivalCfg.week) || 17,
      sides: [],
      phase: 'disabled',
      message: 'MAYORS CUP is disabled for this season.',
      generatedAt: new Date().toISOString()
    };
  }

  const SURVIVAL_WEEK = Number(survivalCfg.week) || Number(config.championship?.bowlWeek) || 17;
  const survivalName = survivalCfg.name || 'MAYORS CUP';
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
  if (users.isLoungeOnly(user)) {
    return users.hasLoungeAccess(user)
      ? '/members.html'
      : '/restricted.html?area=lounge';
  }
  if (userCanSwitchLeagues(user)) {
    const fromCookie = leagueScopeFromPreferred(user, getPreferredLeague(req), { canSwitchLeagues: true });
    if (fromCookie?.homePath) return fromCookie.homePath;
  }
  if (user.leagueId) {
    try {
      const linked = leagues.findById(user.leagueId);
      if (linked?.platform === 'independent'
        && canViewIndependentLeague(user, linked)
        && !userHasGridironFranchise(user)
        && !userHasAaaAccess(user)) {
        return leagues.independentHomePath(linked);
      }
    } catch { /* ignore */ }
  }
  if (users.isReadOnly(user) || users.isSiteOwner(user)) {
    const preferred = getPreferredLeague(req);
    if (preferred && typeof preferred === 'object' && preferred.kind === 'independent') {
      try {
        const linked = leagues.findById(preferred.id);
        if (linked?.platform === 'independent' && canViewIndependentLeague(user, linked)) {
          return leagues.independentHomePath(linked);
        }
      } catch { /* ignore */ }
    }
    const key = preferred === 'aaa' ? 'aaa' : 'gridiron';
    return key === 'aaa' && getAffiliatedLeague('aaa') ? '/aaa.html' : '/home.html';
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
  const membership = users.normalizeMembershipLeague(user.membershipLeague);
  if (membership === 'aaa') return getAffiliatedLeague('aaa') ? '/aaa.html' : '/home.html';
  if (membership === 'gridiron') return '/home.html';
  return '/home.html';
}

const INDEPENDENT_HQ_SECTIONS = new Set([
  'standings', 'schedules', 'my-roster', 'team-rosters', 'rankings', 'draft',
  'transactions', 'playoffs', 'calendar', 'rulebook', 'scoreboard', 'payouts',
  'settings', 'manage', 'team', 'keepers', 'scoring', 'conference-draft'
]);

function parseIndependentHqPath(pathname) {
  const raw = String(pathname || '');
  let m = raw.match(/^\/([a-z0-9-]+)\.html$/i);
  if (m) {
    const slug = leagues.slugify(m[1]);
    if (!slug || leagues.isReservedLeagueSlug(slug)) return null;
    return { slug, section: 'home' };
  }
  m = raw.match(/^\/([a-z0-9-]+)\/([a-z0-9-]+)\.html$/i);
  if (m) {
    const slug = leagues.slugify(m[1]);
    const section = String(m[2] || '').toLowerCase();
    if (!slug || leagues.isReservedLeagueSlug(slug)) return null;
    if (!INDEPENDENT_HQ_SECTIONS.has(section)) return null;
    return { slug, section };
  }
  return null;
}

function independentLeagueRouteParts(pathname) {
  const parts = String(pathname || '').split('/').filter(Boolean);
  if (parts[0] === 'api') parts.shift();
  return parts;
}

function userHasGridironFranchise(user) {
  if (!user || users.isLoungeOnly(user)) return false;
  if (users.hqMembershipOf(user) === 'gridiron') return true;
  try {
    const key = String(logos.getClaimForUser(user.id)?.conferenceKey || '').toLowerCase();
    return key === 'detail' || key === 'overtime';
  } catch {
    return false;
  }
}

function userHasAaaAccess(user) {
  if (!user || users.isLoungeOnly(user) || !getAffiliatedLeague('aaa')) return false;
  if (users.hqMembershipOf(user) === 'aaa') return true;
  try {
    const key = String(logos.getClaimForUser(user.id)?.conferenceKey || '').toLowerCase();
    if (key === 'aaa') return true;
  } catch { /* ignore */ }
  return user.role === 'conference_admin' && String(user.conference || '').toLowerCase() === 'aaa';
}

function canViewIndependentLeague(user, league) {
  if (!league || league.platform !== 'independent') return false;
  if (!user) return false;
  const isOwner = Boolean(league.ownerUserId && league.ownerUserId === user.id);
  if (league.status === 'rejected' || league.status === 'archived') return isOwner;
  if (isOwner) return true;
  if (league.status === 'pending_approval') return false;
  if (user.leagueId && user.leagueId === league.id) return true;
  if ((league.franchises || []).some((f) => f.managerUserId && f.managerUserId === user.id)) {
    return true;
  }
  return false;
}

function independentLeagueScope(league, extras = {}) {
  const homePath = leagues.independentHomePath(league);
  const slug = league.slug;
  return {
    scope: 'independent',
    conferenceKey: null,
    leagueId: league.id,
    slug,
    homePath,
    scoreboardPath: leagues.independentSectionPath(league, 'scoreboard'),
    settingsPath: leagues.independentSectionPath(league, 'settings'),
    ownerDashboardPath: leagues.independentSectionPath(league, 'settings'),
    label: league.brand?.name || slug,
    logo: league.brand?.logo || league.brand?.crest || null,
    canSwitchLeagues: Boolean(extras.canSwitchLeagues),
    preferredLeague: extras.preferredLeague || null,
    platform: 'independent',
    status: league.status,
    conferenceDraftEnabled: league.conferenceDraftEnabled === true,
    isLeagueOwner: Boolean(extras.isLeagueOwner),
    role: extras.isLeagueOwner ? 'owner' : 'member'
  };
}

function resolveIndependentLeagueForUser(user) {
  if (!user) return null;
  if (user.leagueId) {
    try {
      const linked = leagues.findById(user.leagueId);
      if (linked?.platform === 'independent'
        && linked.status !== 'rejected'
        && linked.status !== 'pending_approval') {
        return linked;
      }
    } catch { /* ignore */ }
  }
  try {
    const memberships = leagues.listIndependentMembershipsForUser(user.id);
    if (memberships.length === 1) {
      return leagues.findById(memberships[0].leagueId) || null;
    }
  } catch { /* ignore */ }
  return null;
}

function isIndependentHqScope(scope) {
  return Boolean(scope && (scope.scope === 'independent' || scope.platform === 'independent'));
}

function independentCreateLeagueHref(league) {
  if (!league?.id) return '/create-league';
  return `/create-league?leagueId=${encodeURIComponent(league.id)}`;
}

/** League the Create-a-League page should act on — current HQ first, never a random other request. */
function resolveCreateLeagueSubject(user, req, requestedId = '') {
  if (!user) return null;
  const canSee = (raw) => {
    if (!raw || raw.platform !== 'independent') return false;
    return Boolean(raw.ownerUserId && raw.ownerUserId === user.id);
  };
  const want = String(requestedId || '').trim();
  if (want) {
    const hit = leagues.findById(want);
    if (canSee(hit)) return hit;
  }
  const scope = leagueScopeForUser(user, req);
  if (isIndependentHqScope(scope) && scope.leagueId) {
    const scoped = leagues.findById(scope.leagueId);
    if (canSee(scoped)) return scoped;
  }
  if (user.leagueId) {
    const linked = leagues.findById(user.leagueId);
    if (canSee(linked)) return linked;
  }
  const owned = leagues.listIndependentLeaguesForOwner(user.id);
  const pending = owned.find((l) => l.status === 'pending_approval');
  if (pending) return leagues.findById(pending.id);
  const setup = owned.find((l) => l.status === 'approved' && l.setupComplete === false);
  if (setup) return leagues.findById(setup.id);
  return null;
}

function inboxMessageVisibleForScope(msg, scope) {
  const metaLeague = String(msg?.meta?.leagueId || '').trim();
  const independentMail = msg?.type === 'league_invite'
    || msg?.type === 'league_approved'
    || msg?.type === 'league_request'
    || (msg?.type === 'welcome' && msg?.meta?.membershipKind === 'independent');

  if (isIndependentHqScope(scope)) {
    const leagueId = String(scope.leagueId || '');
    if (!leagueId) return false;
    if (metaLeague) return metaLeague === leagueId;
    return false;
  }

  if (independentMail) return false;
  if (metaLeague && metaLeague !== 'gridiron' && metaLeague !== 'aaa') return false;
  return true;
}

function scopedInboxForUser(user, req) {
  const scope = leagueScopeForUser(user, req);
  const messages = inbox.listForUser(user.id).filter((m) => inboxMessageVisibleForScope(m, scope));
  return {
    messages,
    unread: messages.filter((m) => m.unread).length
  };
}

function conferenceDraftTargetSeason(league = null) {
  if (league?.season) return Number(league.season) + 1;
  return Number(config.season || 2026) + 1;
}

function resolveConferenceDraftContext(req, requestUrl, body = {}) {
  const raw = String(body.leagueId || requestUrl.searchParams.get('leagueId') || '').trim();
  if (raw && raw !== 'gridiron' && raw !== 'gridiron24') {
    const league = leagues.findById(raw) || leagues.findBySlug(raw);
    if (!league || league.platform !== 'independent') {
      const e = new Error('Independent league not found');
      e.status = 404;
      throw e;
    }
    return {
      scope: 'independent',
      leagueId: league.id,
      league,
      targetSeason: conferenceDraftTargetSeason(league)
    };
  }
  return {
    scope: 'gridiron',
    leagueId: conferenceDraft.GRIDIRON_KEY,
    league: null,
    targetSeason: conferenceDraftTargetSeason()
  };
}

function conferenceDraftPayload(room, user, ctx) {
  const pub = conferenceDraft.publicRoom(room, user?.id, { league: ctx.league });
  return {
    ok: true,
    room: pub,
    canManage: conferenceDraft.canManage(room, user, ctx.league),
    viewer: user ? { id: user.id, name: user.name || user.loginName } : null,
    targetSeason: ctx.targetSeason
  };
}

/**
 * One-time welcome inbox on first successful login / session.
 * Copy lives in welcome-message.js — edit there anytime.
 */
function deliverWelcomeInboxIfNeeded(user) {
  if (!user?.id || user.approved === false) return null;
  try {
    if (!commsSettings.isEnabled('inbox.welcome')) return null;
  } catch { /* continue */ }
  if (!users.claimWelcomeInbox(user.id)) return null;
  try {
    let kind = users.membershipKindOf(user);
    let leagueName = '';
    let href = '';
    if (user.leagueId) {
      const linked = leagues.findById(user.leagueId);
      if (linked?.platform === 'independent') {
        kind = 'independent';
        leagueName = linked.brand?.name || linked.slug || '';
        href = leagues.independentHomePath(linked);
      }
    }
    const msg = welcomeMessage.buildWelcome({
      name: user.name || user.loginName,
      kind,
      leagueName
    });
    return inbox.sendMessage({
      toUserId: user.id,
      from: { name: msg.fromName },
      subject: msg.subject,
      body: msg.body,
      type: msg.type || 'welcome',
      meta: {
        kind: 'first_login_welcome',
        membershipKind: kind,
        leagueId: user.leagueId || undefined,
        leagueName: leagueName || undefined,
        href: href || undefined,
        hrefLabel: href ? 'Open League HQ' : undefined
      }
    });
  } catch (err) {
    console.warn('[welcome-inbox] failed', err.message || err);
    return null;
  }
}

function staffOpsEmailRecipients(excludeUserId = null) {
  return users.listUsers().filter((u) => {
    if (!u || u.approved === false) return false;
    if (excludeUserId && u.id === excludeUserId) return false;
    if (!u.email || !String(u.email).includes('@')) return false;
    if (users.isReadOnly(u)) return false;
    return users.isSiteOwner(u) || users.isCommissioner(u);
  });
}

function emailStaffOpsAlert({
  commsId,
  excludeUserId,
  subject,
  headline,
  preheader,
  lines,
  ctaLabel,
  ctaPath
}) {
  const origin = siteBaseUrl();
  const ctaUrl = `${origin}${ctaPath || '/owner.html'}`;
  const recipients = staffOpsEmailRecipients(excludeUserId);
  Promise.all(recipients.map((u) => sendOwnerOpsEmail({
    to: u.email,
    commsId,
    subject,
    headline,
    preheader,
    lines,
    ctaLabel,
    ctaUrl
  }))).catch((err) => {
    console.warn('[owner-ops] batch failed', err.message || err);
  });
}

/** Alert site owner inbox + email when someone creates an account. */
function notifySiteOwnersOfNewAccount(user, { source = 'register' } = {}) {
  if (!user?.id) return;
  if (users.isSiteOwner(user)) return;
  try {
    const owners = users.listUsers().filter(
      (u) => users.isSiteOwner(u) && u.approved !== false && u.id !== user.id
    );
    if (!owners.length && !staffOpsEmailRecipients(user.id).length) return;

    const pending = user.approved === false;
    const kind = pending
      ? 'Pending approval'
      : user.loungeOnly
        ? 'Social (Members Lounge only)'
        : user.leagueOwner
          ? 'League owner'
          : user.loungeMember
            ? 'Member'
            : 'Pending approval';
    const subject = pending
      ? `Pending account: ${user.name || user.loginName}`
      : `New account: ${user.name || user.loginName}`;
    const body = [
      pending ? 'ACCOUNT AWAITING APPROVAL' : 'NEW ACCOUNT CREATED',
      '',
      `Name: ${user.name || '—'}`,
      `Login: ${user.loginName}`,
      `Email: ${user.email || '—'}`,
      `Type: ${kind}`,
      `Source: ${source}`,
      '',
      pending
        ? 'Waiting for commissioner approval. They cannot sign in yet.'
        : 'They can sign in now.',
      '',
      'Open Owner Dashboard → Players → Approve.'
    ].join('\n');

    if (commsSettings.isEnabled('inbox.account_created')) {
      for (const ownerUser of owners) {
        inbox.sendMessage({
          toUserId: ownerUser.id,
          from: { name: 'League HQ' },
          subject,
          body,
          type: 'account_created',
          relatedId: user.id,
          meta: {
            href: '/owner.html#account-requests',
            hrefLabel: 'Open Owner Dashboard',
            userId: user.id,
            source,
            pendingApprovals: pending
          }
        });
      }
    }

    emailStaffOpsAlert({
      commsId: 'email.account_created',
      excludeUserId: user.id,
      subject: `GridIron 24 · ${subject}`,
      headline: pending ? 'Account awaiting approval' : 'New account created',
      preheader: pending
        ? `${user.name || user.loginName} created an account and is waiting for approval.`
        : `${user.name || user.loginName} created an account.`,
      lines: body.split('\n'),
      ctaLabel: pending ? 'Review request' : 'Open dashboard',
      ctaPath: pending ? '/owner.html#account-requests' : '/site.html#accounts'
    });
  } catch (err) {
    console.warn('[account-created] owner notify failed', err.message || err);
  }
}

function notifySiteOwnersOfLeagueRequest(league, ownerUser) {
  if (!league) return;
  const name = league.brand?.name || league.slug || 'Independent league';
  const teams = league.structure?.totalTeams || '?';
  const conferences = Number(league.structure?.conferenceCount) === 2 ? 'Two conferences' : 'One conference';
  const subject = `League request: ${name}`;
  const bodyLines = [
    'NEW LEAGUE REGISTRATION',
    '',
    `League: ${name}`,
    ownerUser
      ? `Owner: ${ownerUser.name || ownerUser.loginName} (${ownerUser.loginName}) · ${ownerUser.email || '—'}`
      : `Owner: ${league.ownerName || league.ownerEmail || '—'}`,
    `Teams: ${teams}`,
    `Type: ${conferences}`,
    '',
    'This request is pending your approval.',
    '',
    '1. Review in Owner Dashboard → Players → League requests.',
    '2. After approval, the owner sets up the league on /create-league.'
  ];
  try {
    if (commsSettings.isEnabled('inbox.league_request')) {
      const owners = users.listUsers().filter((u) => users.isSiteOwner(u) && u.approved !== false);
      for (const recipient of owners) {
        inbox.sendMessage({
          toUserId: recipient.id,
          from: { name: 'League HQ' },
          subject,
          body: bodyLines.join('\n'),
          type: 'league_request',
          meta: {
            href: '/owner.html#league-requests',
            hrefLabel: 'Open Owner Dashboard',
            leagueId: league.id
          }
        });
      }
    }
  } catch (err) {
    console.warn('[league-request] inbox notify failed', err.message || err);
  }
  emailStaffOpsAlert({
    commsId: 'email.league_request',
    excludeUserId: ownerUser?.id,
    subject: `GridIron 24 · ${subject}`,
    headline: 'League request pending',
    preheader: `${name} is waiting for approval.`,
    lines: bodyLines,
    ctaLabel: 'Review league request',
    ctaPath: '/owner.html#league-requests'
  });
}

async function inviteIndependentPlayer(req, { league, actor, email, franchiseId = null }) {
  const leagueId = league.id;
  const address = String(email || '').trim();
  const seat = String(franchiseId || '').trim() || null;
  if (!address) {
    throw Object.assign(new Error('Email is required'), { status: 400 });
  }
  if (seat && !(league.franchises || []).some((f) => f.id === seat)) {
    throw Object.assign(new Error('Franchise not found'), { status: 400 });
  }
  const existing = users.findByEmail(address);
  if (existing) {
    const publicExisting = users.publicUser(existing);
    if (publicExisting.leagueId && publicExisting.leagueId !== leagueId && !users.isSiteOwner(publicExisting)) {
      throw Object.assign(new Error('That account is already linked to another league'), { status: 409 });
    }
    users.setUserLeagueOwner(existing.id, leagueId, false);
    grantLoungeAdmission(existing.id, actor.id);
    let updatedLeague = leagues.publicLeague(league);
    if (seat) {
      updatedLeague = leagues.assignFranchiseManager(leagueId, seat, existing);
    }
    try {
      inbox.sendMessage({
        toUserId: existing.id,
        from: { name: league.brand?.name || 'League HQ' },
        subject: `You're in · ${league.brand?.name || 'league'}`,
        body: [
          `${actor.name || actor.loginName} added you to ${league.brand?.name || 'their league'}.`,
          '',
          `Open HQ: ${leagues.independentHomePath(league)}`
        ].join('\n'),
        type: 'league_invite',
        meta: {
          href: leagues.independentHomePath(league),
          leagueId,
          leagueName: league.brand?.name || league.slug || null
        }
      });
    } catch { /* ignore */ }
    return {
      ok: true,
      attached: true,
      email: users.normalizeEmail(address),
      user: users.publicUser(users.findById(existing.id)),
      league: updatedLeague,
      message: 'Existing account linked to this league.'
    };
  }
  const created = invites.createInvite({
    email: address,
    invitedBy: actor,
    loungeOnly: false,
    leagueId,
    franchiseId: seat
  });
  const inviteUrl = `${requestOrigin(req)}/register?invite=${encodeURIComponent(created.token)}`;
  let mailResult = { sent: false, method: 'none' };
  try {
    mailResult = await sendInviteEmail({
      to: created.invite.email,
      inviteUrl,
      invitedByName: actor.name || actor.loginName,
      leagueName: league.brand?.name || 'your league',
      baseUrl: requestOrigin(req),
      loungeOnly: false,
      independent: true
    });
  } catch (mailErr) {
    mailResult = {
      sent: false,
      method: 'error',
      error: mailErr.message || 'Email send failed'
    };
  }
  return {
    ok: true,
    attached: false,
    email: created.invite.email,
    invite: created.invite,
    inviteUrl,
    sent: Boolean(mailResult.sent),
    method: mailResult.method,
    mailError: mailResult.error || null,
    message: mailResult.sent
      ? 'Invite emailed. They can create an account and join immediately.'
      : 'Invite created — copy the link if email did not send.'
  };
}

const pendingInboxSyncAt = new Map();

/**
 * Keep owner/commissioner inboxes stocked with digests for open work:
 * pending account approvals, rule proposals awaiting owner, feature requests, roster patrol.
 */
function syncPendingInboxDigests(user, { force = false } = {}) {
  if (!user?.id || user.approved === false) return;
  const isOwner = users.isSiteOwner(user);
  const isCommish = users.isCommissioner(user);
  if (!isOwner && !isCommish) return;

  const now = Date.now();
  const last = pendingInboxSyncAt.get(user.id) || 0;
  if (!force && now - last < 90_000) return;
  pendingInboxSyncAt.set(user.id, now);

  try {
    const pendingUsers = users.listUsers().filter((u) => u.approved === false);
    const pendingNames = pendingUsers
      .map((u) => `• ${u.name || u.loginName} (${u.loginName}) — ${u.email || 'no email'}`)
      .join('\n');
    const showPendingUsers = pendingUsers.length && commsSettings.isEnabled('digest.pending_users');
    inbox.upsertDigest({
      toUserId: user.id,
      digestKey: 'digest:pending-users',
      type: 'pending_approvals',
      fingerprint: pendingUsers.map((u) => u.id).sort().join(',') || 'none',
      subject: showPendingUsers
        ? `${pendingUsers.length} account${pendingUsers.length === 1 ? '' : 's'} awaiting approval`
        : null,
      body: showPendingUsers
        ? [
          'PENDING APPROVALS',
          '',
          pendingNames,
          '',
          'Open Owner Dashboard → Players → Approve.'
        ].join('\n')
        : null,
      meta: {
        digest: true,
        href: '/owner.html#account-requests',
        hrefLabel: 'Open Owner Dashboard',
        count: pendingUsers.length,
        pendingApprovals: true
      }
    });

    if (isOwner) {
      const pendingLeagues = leagues.listPendingIndependentLeagues();
      const leagueLines = pendingLeagues
        .map((l) => `• ${l.brand?.name || l.slug} — ${l.ownerName || l.ownerEmail || 'owner'} (${l.structure?.totalTeams || '?'} teams)`)
        .join('\n');
      const showPendingLeagues = pendingLeagues.length && commsSettings.isEnabled('digest.pending_leagues');
      inbox.upsertDigest({
        toUserId: user.id,
        digestKey: 'digest:pending-leagues',
        type: 'pending_league_approvals',
        fingerprint: pendingLeagues.map((l) => l.id).sort().join(',') || 'none',
        subject: showPendingLeagues
          ? `${pendingLeagues.length} league${pendingLeagues.length === 1 ? '' : 's'} awaiting approval`
          : null,
        body: showPendingLeagues
          ? [
            'PENDING LEAGUE REQUESTS',
            '',
            leagueLines,
            '',
            'Open Owner Dashboard → Players → League requests.'
          ].join('\n')
          : null,
        meta: {
          digest: true,
          href: '/owner.html#league-requests',
          hrefLabel: 'Open Owner Dashboard',
          count: pendingLeagues.length,
          pendingLeagueApprovals: true
        }
      });
    }

    const openViolations = rosterViolations.listOpen({ season: config.season });
    const violationLines = openViolations
      .slice(0, 12)
      .map((v) => `• ${v.teamName || 'Team'} — ${v.playerName || 'player'} (${v.conferenceKey || 'league'})`)
      .join('\n');
    const showViolations = openViolations.length && commsSettings.isEnabled('digest.roster_violations');
    inbox.upsertDigest({
      toUserId: user.id,
      digestKey: 'digest:roster-violations',
      type: 'roster_violations',
      fingerprint: openViolations.map((v) => v.id).sort().join(',') || 'none',
      subject: showViolations
        ? `${openViolations.length} open roster violation${openViolations.length === 1 ? '' : 's'}`
        : null,
      body: showViolations
        ? [
          'ROSTER PATROL',
          '',
          violationLines,
          openViolations.length > 12 ? `…and ${openViolations.length - 12} more.` : '',
          '',
          'Open Owner Dashboard → ESPN → Roster patrol.'
        ].filter(Boolean).join('\n')
        : null,
      meta: {
        digest: true,
        href: '/owner.html#roster-violations',
        count: openViolations.length,
        rosterViolations: true
      }
    });

    if (!isOwner) return;

    const waitingRules = ruleProposals.listProposals({
      status: ruleProposals.STATUS.SUBMITTED,
      limit: 50
    });
    for (const p of waitingRules) {
      inbox.ensureRelatedMessage({
        toUserId: user.id,
        relatedId: p.id,
        type: 'rule_proposal',
        subject: `RULE CHANGE — from ${p.authorName || 'member'}`,
        body: [
          'RULE CHANGE PROPOSAL',
          '',
          `From: ${p.authorName || 'member'}`,
          '',
          p.text,
          '',
          'Open your inbox on the full site to Open Vote or Dismiss.'
        ].join('\n'),
        meta: {
          ruleChange: true,
          proposalId: p.id,
          status: p.status
        }
      });
    }
    inbox.upsertDigest({
      toUserId: user.id,
      digestKey: 'digest:rule-proposals',
      type: 'pending_approvals',
      fingerprint: waitingRules.map((p) => p.id).sort().join(',') || 'none',
      subject: waitingRules.length && commsSettings.isEnabled('digest.rule_proposals')
        ? `${waitingRules.length} rule proposal${waitingRules.length === 1 ? '' : 's'} awaiting you`
        : null,
      body: waitingRules.length && commsSettings.isEnabled('digest.rule_proposals')
        ? [
          'RULE PROPOSALS AWAITING OWNER',
          '',
          ...waitingRules.map((p) => `• ${p.authorName || 'member'} — ${(p.text || '').slice(0, 90)}`),
          '',
          'Open each RULE CHANGE letter in your inbox to Open Vote or Dismiss.'
        ].join('\n')
        : null,
      meta: {
        digest: true,
        href: '/inbox.html',
        count: waitingRules.length,
        ruleProposals: true
      }
    });

    const openFeatures = featureRequests.listRequests({ status: 'submitted', limit: 50 });
    for (const f of openFeatures) {
      inbox.ensureRelatedMessage({
        toUserId: user.id,
        relatedId: f.id,
        type: 'feature_request',
        subject: `FEATURE REQUEST — from ${f.authorName || 'member'}`,
        body: [
          'FEATURE REQUEST',
          '',
          `From: ${f.authorName || 'member'}`,
          '',
          f.text
        ].join('\n'),
        meta: {
          featureRequest: true,
          requestId: f.id,
          authorName: f.authorName,
          authorId: f.authorId
        }
      });
    }
    inbox.upsertDigest({
      toUserId: user.id,
      digestKey: 'digest:feature-requests',
      type: 'pending_approvals',
      fingerprint: openFeatures.map((f) => f.id).sort().join(',') || 'none',
      subject: openFeatures.length && commsSettings.isEnabled('digest.feature_requests')
        ? `${openFeatures.length} feature request${openFeatures.length === 1 ? '' : 's'} open`
        : null,
      body: openFeatures.length && commsSettings.isEnabled('digest.feature_requests')
        ? [
          'OPEN FEATURE REQUESTS',
          '',
          ...openFeatures.map((f) => `• ${f.authorName || 'member'} — ${(f.text || '').slice(0, 90)}`),
          '',
          'Each request also has its own FEATURE REQUEST letter in this inbox.'
        ].join('\n')
        : null,
      meta: {
        digest: true,
        href: '/inbox.html',
        count: openFeatures.length,
        featureRequests: true
      }
    });
  } catch (err) {
    console.warn('[pending-inbox] sync failed', err.message || err);
  }
}

function userAccessibleIndependentLeagues(user) {
  if (!user || users.isLoungeOnly(user)) return [];
  const out = [];
  const seen = new Set();
  const add = (raw) => {
    if (!raw || raw.platform !== 'independent' || seen.has(raw.id)) return;
    if (raw.status === 'rejected' || raw.status === 'archived') return;
    if (raw.status === 'pending_approval' && raw.ownerUserId !== user.id) return;
    seen.add(raw.id);
    out.push(raw);
  };
  for (const row of leagues.listIndependentLeaguesForOwner(user.id)) add(leagues.findById(row.id) || row);
  for (const row of leagues.listIndependentLeagues()) {
    const raw = leagues.findById(row.id) || row;
    if (canViewIndependentLeague(user, raw)) add(raw);
  }
  return out;
}

function userCanSwitchLeagues(user) {
  if (!user || users.isLoungeOnly(user)) return false;
  const independents = userAccessibleIndependentLeagues(user);
  let n = independents.length;
  if (userHasGridironFranchise(user)) n += 1;
  if (userHasAaaAccess(user)) n += 1;
  return n > 1;
}

function userMayAccessPreferred(user, preferred) {
  if (!user || !preferred) return false;
  if (typeof preferred === 'object' && preferred.kind === 'independent') {
    return canViewIndependentLeague(user, leagues.findById(preferred.id));
  }
  if (preferred === 'aaa') {
    return userHasAaaAccess(user);
  }
  if (preferred === 'gridiron') {
    if (userHasAaaAccess(user) && !userHasGridironFranchise(user)) return false;
    return userHasGridironFranchise(user);
  }
  return false;
}

function leagueScopeFromPreferred(user, preferred, extras = {}) {
  if (!preferred || !userMayAccessPreferred(user, preferred)) return null;
  if (typeof preferred === 'object' && preferred.kind === 'independent') {
    const linked = leagues.findById(preferred.id);
    if (!linked || linked.platform !== 'independent') return null;
    return independentLeagueScope(linked, {
      canSwitchLeagues: extras.canSwitchLeagues !== false,
      preferredLeague: `independent:${linked.id}`,
      isLeagueOwner: Boolean(user && linked.ownerUserId === user.id)
    });
  }
  if (preferred === 'aaa') {
    const affiliate = getAffiliatedLeague('aaa');
    if (!affiliate) return null;
    return {
      scope: 'aaa',
      conferenceKey: 'aaa',
      homePath: '/aaa.html',
      scoreboardPath: '/aaa-scoreboard',
      label: affiliate?.name || 'AAA League',
      logo: affiliate?.logo || '/assets/aaa-league.png?v=7',
      canSwitchLeagues: extras.canSwitchLeagues !== false,
      preferredLeague: 'aaa'
    };
  }
  if (preferred === 'gridiron') {
    return {
      scope: 'gridiron',
      conferenceKey: null,
      homePath: '/home.html',
      scoreboardPath: '/scoreboard',
      label: 'GridIron 24',
      logo: '/assets/gridiron24-league.png?v=8',
      canSwitchLeagues: extras.canSwitchLeagues !== false,
      preferredLeague: 'gridiron'
    };
  }
  return null;
}

function menuLeaguesForUser(user, req = null) {
  if (!user || users.isLoungeOnly(user)) return [];
  const current = leagueScopeForUser(user, req);
  const items = [];

  if (userHasGridironFranchise(user)) {
    items.push({
      id: 'gridiron',
      kind: 'gridiron',
      label: 'GridIron 24',
      homePath: '/home.html',
      logo: '/assets/gridiron24-league.png?v=8',
      role: users.isCommissioner(user) && users.hqMembershipOf(user) === 'gridiron' ? 'commissioner' : 'member',
      current: current.scope === 'gridiron' && current.platform !== 'independent'
    });
  }
  if (userHasAaaAccess(user)) {
    const affiliate = getAffiliatedLeague('aaa');
    if (affiliate) {
      items.push({
        id: 'aaa',
        kind: 'aaa',
        label: affiliate?.name || 'AAA League',
        homePath: '/aaa.html',
        logo: affiliate?.logo || '/assets/aaa-league.png?v=7',
        role: 'member',
        current: current.scope === 'aaa' && current.platform !== 'independent'
      });
    }
  }

  const seen = new Set();
  for (const raw of userAccessibleIndependentLeagues(user)) {
    if (!raw?.id || seen.has(raw.id)) continue;
    seen.add(raw.id);
    const pub = leagues.publicLeague(raw);
    const isOwner = Boolean(raw.ownerUserId && raw.ownerUserId === user.id);
    items.push({
      id: pub.id,
      kind: 'independent',
      label: pub.brand?.name || pub.slug || 'League',
      homePath: pub.homePath || leagues.independentHomePath(raw),
      logo: pub.brand?.logo || pub.brand?.crest || null,
      role: isOwner ? 'owner' : 'member',
      current: current.leagueId === pub.id || current.slug === pub.slug
    });
  }
  return items;
}

/**
 * Which league HQ/nav/scoreboard a user should see.
 * Site owner and anyone in more than one league: preferred-league cookie.
 * Single-league members: that league only.
 */
function leagueScopeForUser(user, req = null) {
  if (!user) {
    return {
      scope: 'gridiron',
      conferenceKey: null,
      homePath: '/home.html',
      scoreboardPath: '/scoreboard',
      label: 'GridIron 24',
      logo: '/assets/gridiron24-league.png?v=8',
      canSwitchLeagues: false,
      preferredLeague: null
    };
  }

  const switchable = userCanSwitchLeagues(user);
  const extras = { canSwitchLeagues: switchable };
  if (switchable) {
    const fromCookie = leagueScopeFromPreferred(user, getPreferredLeague(req), extras);
    if (fromCookie) return fromCookie;
  }

  const linked = resolveIndependentLeagueForUser(user);
  const hq = users.hqMembershipOf(user);
  if (linked && hq !== 'gridiron' && hq !== 'aaa') {
    return independentLeagueScope(linked, {
      ...extras,
      isLeagueOwner: linked.ownerUserId === user.id
    });
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
      scoreboardPath: '/aaa-scoreboard',
      label: affiliate?.name || (conferenceKey === 'aaa' ? 'AAA League' : conferenceKey),
      logo: affiliate?.logo || '/assets/aaa-league.png?v=7',
      canSwitchLeagues: switchable,
      preferredLeague: null
    };
  }
  return {
    scope: 'gridiron',
    conferenceKey: conferenceKey || null,
    homePath: homePathForUser(user, req),
    scoreboardPath: '/scoreboard',
    label: 'GridIron 24',
    logo: '/assets/gridiron24-league.png?v=8',
    canSwitchLeagues: switchable,
    preferredLeague: null
  };
}

function profileToolsForUser(user, req, memberships = []) {
  const scope = leagueScopeForUser(user, req);
  const independent = scope.platform === 'independent' || (memberships.length && !logos.getClaimForUser(user.id));
  const tools = [];
  const primary = memberships[0] || null;
  if (primary?.paths?.myRoster) {
    tools.push({
      href: primary.paths.myRoster,
      title: 'My Team',
      kicker: primary.name,
      blurb: 'Roster, IR, taxi, and keepers for this league.',
      tone: 'overtime'
    });
  }
  if (primary?.isOwner && primary.paths?.settings) {
    tools.push({
      href: primary.paths.settings,
      title: 'Owner Dashboard',
      kicker: primary.name,
      blurb: 'Settings, invites, and operations.',
      tone: 'gold'
    });
  }
  if (primary?.paths?.draft) {
    tools.push({
      href: primary.paths.draft,
      title: 'Draft',
      kicker: primary.name,
      blurb: 'Board and results for this league.',
      tone: 'blue'
    });
  }
  if (!independent && !users.isLoungeOnly(user)) {
    tools.push({
      href: '/my-roster.html',
      title: 'My Team',
      kicker: scope.label || 'League',
      blurb: 'This week’s roster and matchup.',
      tone: 'overtime'
    });
  }
  tools.push(
    { href: '/inbox.html', title: 'Inbox', kicker: 'Mail', blurb: 'Messages from the league.', tone: 'good' },
    { href: '/members.html', title: 'Members Lounge', kicker: 'Clubhouse', blurb: 'Chat, pools, and the board.', tone: 'detail' },
    { href: '/install-app.html', title: 'Install app', kicker: 'Phone', blurb: 'Add GridIron to your home screen.', tone: 'blue' }
  );
  return tools;
}

function liveIndependentCareerRows(memberships = []) {
  return memberships
    .filter((m) => m.franchise)
    .map((m) => ({
      id: `live:${m.leagueId}:${m.season}:${m.franchise.id}`,
      platform: 'independent',
      season: m.season,
      label: `${m.name} ${m.season}`,
      leagueId: m.leagueId,
      leagueName: m.name,
      teamName: m.franchise.name,
      franchiseId: m.franchise.id,
      wins: m.franchise.wins,
      losses: m.franchise.losses,
      ties: m.franchise.ties,
      pointsFor: m.franchise.pointsFor,
      pointsAgainst: m.franchise.pointsAgainst,
      playoff: Boolean(m.franchise.playoff),
      champion: Boolean(m.champion),
      live: true
    }));
}

function mergeCareerWithLive(stored, liveRows) {
  const keys = new Set(
    stored.map((e) => `ind:${e.leagueId}:${e.season}:${e.franchiseId || e.teamId}`)
  );
  const extra = liveRows.filter((row) => !keys.has(`ind:${row.leagueId}:${row.season}:${row.franchiseId}`));
  return [...extra, ...stored].sort((a, b) => (Number(b.season) - Number(a.season))
    || String(a.leagueName || '').localeCompare(String(b.leagueName || ''))
    || String(a.teamName || '').localeCompare(String(b.teamName || '')));
}

function publicProfileCard(target, req = null) {
  const user = users.publicUser(target);
  const logo = logos.resolveLogoForUser(user.id);
  const memberships = leagues.listIndependentMembershipsForUser(user.id);
  const stored = career.listForUser(user.id);
  const rows = mergeCareerWithLive(stored, liveIndependentCareerRows(memberships));
  const claim = logos.getClaimForUser(user.id);
  const chip = chipFranchiseForUser(target);
  return {
    ok: true,
    user: {
      id: user.id,
      name: user.name,
      loginName: user.loginName,
      bio: user.bio || null,
      role: user.role,
      loungeOnly: user.loungeOnly,
      leagueOwner: user.leagueOwner,
      createdAt: user.createdAt || null
    },
    logo: (logo?.type === 'icon' || logo?.type === 'upload') ? { url: logo.url, type: logo.type } : null,
    memberships: memberships.map((m) => ({
      name: m.name,
      slug: m.slug,
      season: m.season,
      isOwner: m.isOwner,
      franchiseName: m.franchise?.name || null,
      record: m.franchise
        ? { wins: m.franchise.wins, losses: m.franchise.losses, ties: m.franchise.ties }
        : null
    })),
    gi24Team: chip ? { name: chip.name, conferenceName: chip.conferenceName } : (claim ? { name: claim.teamName } : null),
    career: rows,
    careerSummary: career.summarize(rows)
  };
}

function buildOwnProfile(user, req) {
  const memberships = leagues.listIndependentMembershipsForUser(user.id);
  const stored = career.listForUser(user.id);
  const rows = mergeCareerWithLive(stored, liveIndependentCareerRows(memberships));
  const claim = logos.getClaimForUser(user.id);
  const logo = logos.resolveLogoForUser(user.id);
  const scope = leagueScopeForUser(user, req);
  return {
    ok: true,
    user: users.publicUser(user),
    logo,
    leagueScope: scope,
    memberships,
    gi24Claim: Boolean(claim),
    career: rows,
    careerSummary: career.summarize(rows),
    tools: profileToolsForUser(user, req, memberships),
    specs: logos.LOGO_SPECS,
    homePath: homePathForUser(user, req)
  };
}

/** Scoreboard pages can request a specific league via ?league=aaa|gridiron. */
function resolveLeagueScope(user, req, requestedLeague) {
  const personal = leagueScopeForUser(user, req);
  const want = String(requestedLeague || '').trim().toLowerCase();
  if (want !== 'aaa' && want !== 'gridiron') return personal;
  if (user && !personal.canSwitchLeagues && personal.scope !== want) {
    return personal;
  }
  if (want === 'aaa') {
    const affiliate = getAffiliatedLeague('aaa');
    if (!affiliate) return personal.scope === 'aaa'
      ? {
          scope: 'gridiron',
          conferenceKey: null,
          homePath: '/home.html',
          scoreboardPath: '/scoreboard',
          label: 'GridIron 24',
          logo: '/assets/gridiron24-league.png?v=8',
          canSwitchLeagues: personal.canSwitchLeagues,
          preferredLeague: personal.preferredLeague
        }
      : personal;
    return {
      scope: 'aaa',
      conferenceKey: 'aaa',
      homePath: '/aaa.html',
      scoreboardPath: '/aaa-scoreboard',
      label: affiliate?.name || 'AAA League',
      logo: affiliate?.logo || '/assets/aaa-league.png?v=7',
      canSwitchLeagues: personal.canSwitchLeagues,
      preferredLeague: personal.preferredLeague
    };
  }
  return {
    scope: 'gridiron',
    conferenceKey: null,
    homePath: '/home.html',
    scoreboardPath: '/scoreboard',
    label: 'GridIron 24',
    logo: '/assets/gridiron24-league.png?v=8',
    canSwitchLeagues: personal.canSwitchLeagues,
    preferredLeague: personal.preferredLeague
  };
}

/** GridIron-only HTML pages — AAA assignees are redirected to the AAA portal. */
const GRIDIRON_ONLY_PAGES = new Set([
  '/standings.html',
  '/teams.html',
  '/history.html',
  '/playoffs.html',
  '/draft-order-show.html'
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

/** AAA playoff field size: 10→5, 12→6, 14→8 (default 6 for the current 12-team setting). */
function aaaPlayoffSlots(teamCount) {
  const n = Number(teamCount);
  if (n === 10) return 5;
  if (n === 14) return 8;
  if (n === 12) return 6;
  if (Number.isFinite(n) && n > 0 && n < 12) return 5;
  if (Number.isFinite(n) && n > 12) return 8;
  const locked = Number(getAffiliatedLeague('aaa')?.payouts?.teamCount);
  if (locked === 10) return 5;
  if (locked === 14) return 8;
  return 6;
}

function aaaConferenceFromAffiliate(affiliate) {
  const espnId = Number(affiliate?.espnLeagueId);
  return {
    key: affiliate?.key || 'aaa',
    name: affiliate?.name || 'AAA League',
    shortName: affiliate?.shortName || 'AAA',
    espnLeagueId: Number.isFinite(espnId) && espnId > 0 ? espnId : null,
    logo: affiliate?.logo || '/assets/aaa-league.png?v=7'
  };
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
  const type = normalizeStreakType(t.streakType);
  const n = Number(t.streakLength || 0);
  const winStreak = type === 'WIN' ? n : 0;
  const lossStreak = type === 'LOSS' ? n : 0;
  const ppg = Number(t.pointsPerGame || 0);
  const pf = Number(t.pointsFor || 0);
  const high = Number(t.highPoints || 0);
  return winStreak * 120 + ppg * 3.2 + high * 0.4 + pf * 0.1 - lossStreak * 100;
}

function teamColdIndex(t) {
  const type = normalizeStreakType(t.streakType);
  const n = Number(t.streakLength || 0);
  const winStreak = type === 'WIN' ? n : 0;
  const lossStreak = type === 'LOSS' ? n : 0;
  const ppg = Number(t.pointsPerGame || 0);
  const pf = Number(t.pointsFor || 0);
  const high = Number(t.highPoints || 0);
  return lossStreak * 120 - ppg * 3.2 - high * 0.25 - pf * 0.1 - winStreak * 100;
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
        gamesPlayed: t.gamesPlayed,
        highPoints: t.highPoints
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
    const overtime = live.find((c) => c.key === 'overtime') || live[1] || null;
    const detail = live.find((c) => c.key === 'detail') || live[0] || null;
    const official = officialRules.asComparable(sync.officialScoring);
    const detailCmp = compareScoringSettings(official, detail);
    const overtimeCmp = compareScoringSettings(official, overtime);
    return {
      scoring: {
        ok: true,
        source: 'official',
        key: official.key,
        name: official.name,
        shortName: official.shortName,
        playerRankType: official.playerRankType,
        scoringType: official.scoringType,
        scoringItems: refreshScoringDisplays(official.scoringItems),
        lineup: official.lineup
      },
      gridironSynced: Boolean(detailCmp.matched && overtimeCmp.matched),
      source: 'official'
    };
  } catch {
    return { scoring: null, gridironSynced: false, source: null };
  }
}

function compareAaaScoringToGridiron(gridironScoring, aaaSettings) {
  if (!gridironScoring || !aaaSettings) return null;
  const cmp = compareScoringSettings(
    { ...gridironScoring, ok: true },
    { ...aaaSettings, ok: true }
  );
  return {
    matched: cmp.matched,
    bothOk: cmp.bothOk,
    diffCount: cmp.diffs.length,
    diffs: cmp.diffs.slice(0, 25)
  };
}

async function buildAaaPayload() {
  const affiliate = getAffiliatedLeague('aaa') || {
    key: 'aaa',
    name: 'AAA League',
    shortName: 'AAA',
    espnLeagueId: null,
    role: 'feeder',
    logo: '/assets/aaa-league.png?v=7',
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
    logo: affiliate.logo || '/assets/aaa-league.png?v=7',
    season: config.season,
    payouts,
    scoring: officialPack.scoring,
    scoringPolicy: {
      matchesGridiron24: true,
      note: 'AAA is a separate league with its own draft, league admin, and player pool. Scoring and lineup settings mirror the GridIron 24 Rule Book so promotees enter familiar rules.'
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
      playoffSlots: aaaPlayoffSlots(affiliate.payouts?.teamCount || 12),
      playoffCutRank: aaaPlayoffSlots(affiliate.payouts?.teamCount || 12) + 1,
      message: 'AAA League ESPN ID is not configured yet. Scoring follows GridIron 24; standings and hot/cold unlock when the ESPN league ID is set.'
    };
  }

  const conference = {
    key: affiliate.key,
    name: affiliate.name,
    shortName: affiliate.shortName,
    espnLeagueId: espnId,
    logo: affiliate.logo || '/assets/aaa-league.png?v=7'
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
      playoffSlots: aaaPlayoffSlots(teams.length || affiliate.payouts?.teamCount || 12),
      playoffCutRank: aaaPlayoffSlots(teams.length || affiliate.payouts?.teamCount || 12) + 1,
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

async function buildAaaPlayoffsPayload() {
  const affiliate = getAffiliatedLeague('aaa') || {
    key: 'aaa',
    name: 'AAA League',
    shortName: 'AAA',
    espnLeagueId: null,
    logo: '/assets/aaa-league.png?v=7',
    payouts: { teamCount: 12 }
  };
  const conference = aaaConferenceFromAffiliate(affiliate);
  const configured = Number.isFinite(Number(conference.espnLeagueId)) && Number(conference.espnLeagueId) > 0;
  const lockedCount = Number(affiliate.payouts?.teamCount) || 12;
  const base = {
    ok: true,
    configured,
    season: config.season,
    generatedAt: new Date().toISOString(),
    key: conference.key,
    name: conference.name,
    shortName: conference.shortName,
    logo: conference.logo,
    teamCount: lockedCount,
    playoffSlots: aaaPlayoffSlots(lockedCount),
    playoffCutRank: aaaPlayoffSlots(lockedCount) + 1,
    formatNote: 'AAA playoffs: 10 teams → 5 make it · 12 teams → 6 make it · 14 teams → 8 make it'
  };

  if (!configured) {
    return {
      ...base,
      ok: false,
      error: 'AAA League ESPN ID is not configured yet',
      seeds: [],
      rounds: null,
      superBowl: null
    };
  }

  try {
    const [league, w14, w15, w16, w17] = await Promise.all([
      fetchEspnLeague(conference),
      scheduleForConference(conference, 14, 'aaa-matchup'),
      scheduleForConference(conference, 15, 'aaa-matchup'),
      scheduleForConference(conference, 16, 'aaa-matchup'),
      scheduleForConference(conference, 17, 'aaa-matchup')
    ]);
    const teams = league.teams || [];
    const teamCount = teams.length || lockedCount;
    const slots = aaaPlayoffSlots(teamCount);
    const byId = new Map(teams.map((t) => [t.id, t]));
    const bySeed = new Map();
    for (const t of teams) {
      if (Number(t.playoffSeed) > 0) bySeed.set(Number(t.playoffSeed), t);
    }
    if (bySeed.size < slots) {
      teams.slice(0, slots).forEach((t, i) => {
        if (!bySeed.has(i + 1)) bySeed.set(i + 1, { ...t, playoffSeed: i + 1, provisional: true });
      });
    }

    const slot = (seedNum) => {
      const t = bySeed.get(seedNum);
      if (!t) return { seed: seedNum, name: `#${seedNum} Seed`, logo: null, id: null, provisional: true };
      return {
        seed: seedNum,
        id: t.id,
        name: t.name,
        logo: t.logo || null,
        owner: t.owner || null,
        provisional: Boolean(t.provisional) || Number(t.playoffSeed || 0) === 0
      };
    };

    const withSeed = (side) => {
      if (!side) return null;
      const seed = Number(byId.get(side.id)?.playoffSeed || 0) || null;
      return { ...side, seed };
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
        home: withSeed(m.home),
        away: withSeed(m.away),
        playoffTierType: m.playoffTierType || null
      };
    };

    const playable = (weekPayload) => (weekPayload?.matchups || []).filter((m) => m.home && m.away);
    const p14 = playable(w14);
    const p15 = playable(w15);
    const p16 = playable(w16);
    const p17 = playable(w17);

    let rounds;
    if (slots === 8) {
      const r1 = [
        pickMatchupForSeeds(p14, 1, 8, byId) || p14[0] || null,
        pickMatchupForSeeds(p14, 4, 5, byId) || p14[1] || null,
        pickMatchupForSeeds(p14, 2, 7, byId) || p14[2] || null,
        pickMatchupForSeeds(p14, 3, 6, byId) || p14[3] || null
      ];
      const winners15 = p15.filter(isWinnersBracketMatchup);
      const semis = (winners15.length ? winners15 : p15).slice(0, 2);
      const title16 = p16.find(isWinnersBracketMatchup) || p16[0] || null;
      const third16 = p16.find(isConsolationMatchup)
        || p16.find((m) => m.id !== title16?.id)
        || null;
      rounds = {
        format: 'eight',
        wildCard: {
          week: 14,
          label: 'Week 14 · Round of 8',
          games: [
            formatGame(r1[0], '#1 vs #8'),
            formatGame(r1[1], '#4 vs #5'),
            formatGame(r1[2], '#2 vs #7'),
            formatGame(r1[3], '#3 vs #6')
          ]
        },
        semifinals: {
          week: 15,
          label: 'Week 15 · Semifinals',
          games: [
            formatGame(semis[0], 'Semifinal 1'),
            formatGame(semis[1], 'Semifinal 2')
          ]
        },
        finals: {
          week: 16,
          label: 'Week 16 · Title + 3rd',
          title: formatGame(title16, 'AAA Championship'),
          third: formatGame(third16, 'Third Place')
        }
      };
    } else if (slots === 5) {
      const game45 = pickMatchupForSeeds(p14, 4, 5, byId) || p14[0] || null;
      const game23 = pickMatchupForSeeds(p14, 2, 3, byId) || p14[1] || p14[0] || null;
      const winners15 = p15.filter(isWinnersBracketMatchup);
      const semis = (winners15.length ? winners15 : p15).slice(0, 2);
      const title16 = p16.find(isWinnersBracketMatchup) || p16[0] || null;
      const third16 = p16.find(isConsolationMatchup)
        || p16.find((m) => m.id !== title16?.id)
        || null;
      rounds = {
        format: 'five',
        wildCard: {
          week: 14,
          label: 'Week 14 · Wild Card',
          bye1: slot(1),
          game45: formatGame(game45, '#4 vs #5'),
          game23: formatGame(game23, '#2 vs #3')
        },
        semifinals: {
          week: 15,
          label: 'Week 15 · Semifinals',
          games: [
            formatGame(semis[0], 'Semifinal 1'),
            formatGame(semis[1], 'Semifinal 2')
          ]
        },
        finals: {
          week: 16,
          label: 'Week 16 · Title + 3rd',
          title: formatGame(title16, 'AAA Championship'),
          third: formatGame(third16, 'Third Place')
        }
      };
    } else {
      // 6 make it (12-team setting) — same shape as one GridIron conference
      const game45 = pickMatchupForSeeds(p14, 4, 5, byId) || p14[0] || null;
      const game36 = pickMatchupForSeeds(p14, 3, 6, byId) || p14[1] || p14[0] || null;
      const winners15 = p15.filter(isWinnersBracketMatchup);
      const semis = (winners15.length ? winners15 : p15).slice(0, 2);
      const title16 = p16.find(isWinnersBracketMatchup) || p16[0] || null;
      const third16 = p16.find(isConsolationMatchup)
        || p16.find((m) => m.id !== title16?.id)
        || null;
      rounds = {
        format: 'six',
        wildCard: {
          week: 14,
          label: 'Week 14 · Wild Card',
          bye1: slot(1),
          bye2: slot(2),
          game45: formatGame(game45, '#4 vs #5'),
          game36: formatGame(game36, '#3 vs #6')
        },
        semifinals: {
          week: 15,
          label: 'Week 15 · Semifinals',
          games: [
            formatGame(semis[0], 'Semifinal 1'),
            formatGame(semis[1], 'Semifinal 2')
          ]
        },
        finals: {
          week: 16,
          label: 'Week 16 · Title + 3rd',
          title: formatGame(title16, 'AAA Championship'),
          third: formatGame(third16, 'Third Place')
        }
      };
    }

    const titleFrom16 = rounds.finals?.title || null;
    const bowl17 = p17.find(isWinnersBracketMatchup) || p17[0] || null;
    const superBowl = bowl17
      ? formatGame(bowl17, 'AAA Super Bowl')
      : (titleFrom16
        ? { ...titleFrom16, label: 'AAA Super Bowl' }
        : formatGame(null, 'AAA Super Bowl'));

    return {
      ...base,
      ok: true,
      teamCount,
      playoffSlots: slots,
      playoffCutRank: slots + 1,
      seeds: Array.from({ length: slots }, (_, i) => slot(i + 1)),
      rounds,
      superBowl,
      weeks: {
        14: Boolean(w14?.ok),
        15: Boolean(w15?.ok),
        16: Boolean(w16?.ok),
        17: Boolean(w17?.ok)
      }
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: error.name === 'AbortError' ? 'ESPN request timed out' : error.message,
      seeds: [],
      rounds: null,
      superBowl: null
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

/**
 * Grade open sportsbook slips against finals and credit/debit bankrolls.
 * Stake leaves Funds on place; winners get payout (stake + profit) on settle.
 */
async function settlePaperBookFromScores() {
  const openLegs = paperBook.listOpenUngradedLegs();
  if (!openLegs.length && !paperBook.hasOpenTickets()) {
    return { settled: 0, openLegs: 0 };
  }
  const boards = await sportsScoreboard.getSettlementBoards({ openLegs });
  const settled = paperBook.settleOpenSlips(boards);
  return { settled, openLegs: openLegs.length, boards: boards.length };
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
      const upstream = upstreamMeta();
      return sendJson(res, 200, {
        ok: true,
        app: config.brand.name,
        season: config.season,
        conferenceLeagueIds: config.conferences.map((c) => c.espnLeagueId),
        authConfigured: true,
        version: buildInfo.version,
        build: buildInfo.build,
        upstream
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
        // Not-ready (no finals yet) is an expected skip — do not 409 or Render
        // cron jobs email a crash report every Tuesday in preseason/offseason.
        if (!result.ok && !result.skipped) {
          return sendJson(res, 200, { ...result, skipped: true });
        }
        return sendJson(res, 200, result);
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
        return sendJson(res, 200, {
          ok: false,
          skipped: true,
          reason: 'job_failed',
          error: err.message || 'Roster violations scan failed'
        });
      }
    }

    if (pathname === '/api/cron/death-pool-news' && (req.method === 'POST' || req.method === 'GET')) {
      if (!authorizeCron(req)) {
        return sendJson(res, 401, { ok: false, error: 'Invalid cron secret' });
      }
      try {
        const force = requestUrl.searchParams.get('force') === '1';
        const result = await deathPoolNews.runDeathNewsScan({ force });
        return sendJson(res, 200, result);
      } catch (err) {
        console.error('[death-pool-news] cron failed', err);
        return sendJson(res, 500, { ok: false, error: err.message || 'Death pool news scan failed' });
      }
    }

    if (pathname === '/api/cron/paper-book-settle' && (req.method === 'POST' || req.method === 'GET')) {
      if (!authorizeCron(req)) {
        return sendJson(res, 401, { ok: false, error: 'Invalid cron secret' });
      }
      try {
        const result = await settlePaperBookFromScores();
        return sendJson(res, 200, { ok: true, ...result, triggeredBy: 'cron' });
      } catch (err) {
        console.error('[paper-book-settle] cron failed', err);
        return sendJson(res, 500, { ok: false, error: err.message || 'Sportsbook settle failed' });
      }
    }

    if (pathname === '/api/cron/pre-draft-refresh' && (req.method === 'POST' || req.method === 'GET')) {
      if (!authorizeCron(req)) {
        return sendJson(res, 401, { ok: false, error: 'Invalid cron secret' });
      }
      try {
        const result = await preDraftRefresh.refreshAheadOfDrafts({
          force: requestUrl.searchParams.get('force') === '1'
        });
        return sendJson(res, 200, { ...result, triggeredBy: 'cron' });
      } catch (err) {
        console.error('[pre-draft-refresh] cron failed', err);
        return sendJson(res, 200, {
          ok: false,
          skipped: true,
          reason: 'job_failed',
          error: err.message || 'Pre-draft pool refresh failed'
        });
      }
    }

    const mutatingApi = pathname.startsWith('/api/')
      && !pathname.startsWith('/api/cron/')
      && !['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase());
    if (mutatingApi) {
      const sessionUser = getSessionUser(req);
      if (sessionUser && users.isReadOnly(sessionUser)) {
        const allowed = pathname === '/api/login'
          || pathname === '/api/logout'
          || pathname === '/api/presence'
          || pathname === '/api/preferred-league'
          || pathname === '/api/preferences'
          || pathname === '/api/change-password'
          || pathname === '/api/inbox/read-all'
          || (pathname.startsWith('/api/inbox/') && pathname.endsWith('/read'));
        if (!allowed) {
          return sendJson(res, 403, {
            ok: false,
            error: 'This account is view only. Nothing can be changed.',
            readOnly: true
          });
        }
      }
    }

    if (pathname === '/api/auth') {
      const user = getSessionUser(req);
      if (user) {
        deliverWelcomeInboxIfNeeded(user);
        syncPendingInboxDigests(user, { force: true });
      }
      return sendJson(res, 200, {
        authenticated: Boolean(user),
        authConfigured: true,
        user,
        franchise: user ? chipFranchiseForUser(user) : null,
        homePath: homePathForUser(user, req),
        leagueScope: leagueScopeForUser(user, req),
        leagues: user ? menuLeaguesForUser(user, req) : [],
        loungeOpen: users.isLoungeOpenToMembers(),
        loungeAccess: users.hasLoungeAccess(user)
      });
    }

    if (pathname === '/api/preferred-league' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      if (users.isLoungeOnly(user)) {
        return sendJson(res, 403, { ok: false, error: 'Social accounts stay in the Members Lounge' });
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const raw = String(body.league || body.id || '').trim();
      const lower = raw.toLowerCase();
      let preferred = 'gridiron';
      if (lower === 'aaa') preferred = 'aaa';
      else if (lower.startsWith('independent:') || (raw && lower !== 'gridiron' && lower !== 'gridiron24' && lower !== 'gi24' && lower !== 'aaa')) {
        const id = lower.startsWith('independent:') ? raw.slice(raw.indexOf(':') + 1).trim() : raw;
        preferred = { kind: 'independent', id };
      }
      if (!userMayAccessPreferred(user, preferred)) {
        return sendJson(res, 403, { ok: false, error: 'You do not have access to that league' });
      }
      const stamped = leagueScopeFromPreferred(user, preferred, { canSwitchLeagues: true })
        || leagueScopeForUser(user, req);
      const cookieVal = typeof preferred === 'object'
        ? `independent:${preferred.id}`
        : preferred;
      return sendJson(res, 200, {
        ok: true,
        preferredLeague: stamped.preferredLeague || cookieVal,
        homePath: stamped.homePath,
        leagueScope: stamped,
        stayInApp: true
      }, { 'Set-Cookie': preferredLeagueCookieHeader(cookieVal) });
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
        inviteEmail = users.normalizeEmail(invite.email);
        if (body.email && users.normalizeEmail(body.email) !== inviteEmail) {
          return sendJson(res, 400, { ok: false, error: 'Use the email address this invite was sent to' });
        }
        body.email = inviteEmail;
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
      if (users.findByEmail(body.email)) {
        return sendJson(res, 409, {
          ok: false,
          code: 'email_taken',
          error: users.EMAIL_TAKEN_MESSAGE
        });
      }
      try {
        const bootstrap = existingUsers.length === 0 && !inviteToken;
        const admittedByToken = Boolean(inviteToken);
        let inviteRecord = null;
        if (inviteToken) {
          inviteRecord = invites.findByToken(inviteToken);
        }
        const socialInvite = Boolean(inviteRecord?.loungeOnly);
        const independentInvite = Boolean(inviteRecord?.leagueId);
        let user = users.createUser({
          name: body.name,
          email: body.email,
          loginName: body.loginName,
          password: body.password,
          approved: bootstrap || independentInvite,
          loungeMember: bootstrap || socialInvite || admittedByToken || independentInvite,
          loungeOnly: socialInvite
        });
        if (inviteToken) {
          try { invites.acceptInvite(inviteToken, user.email); } catch { /* non-fatal */ }
          if (inviteRecord?.leagueId) {
            try {
              users.setUserLeagueOwner(user.id, inviteRecord.leagueId, false);
              grantLoungeAdmission(user.id, user.id);
              user = users.findById(user.id) || user;
              if (inviteRecord.franchiseId) {
                leagues.assignFranchiseManager(
                  inviteRecord.leagueId,
                  inviteRecord.franchiseId,
                  user
                );
              }
            } catch (attachErr) {
              console.warn('[register] league attach failed', attachErr.message || attachErr);
            }
          } else if (!socialInvite) {
            const membership = inviteHqMembership(inviteRecord);
            if (membership) {
              try {
                users.setLeagueMembership(user.id, { league: membership });
                user = users.findById(user.id) || user;
              } catch (memErr) {
                console.warn('[register] membership assign failed', memErr.message || memErr);
              }
            }
          }
        }
        user = users.publicUser(users.findById(user.id) || user);
        notifySiteOwnersOfNewAccount(user, {
          source: socialInvite
            ? 'lounge_invite'
            : (independentInvite ? 'league_invite' : (inviteToken ? 'invite' : 'bootstrap'))
        });
        // GI24/AAA invites still wait for commissioner approval. Independent league
        // owner invites are approved immediately so players can sign in.
        if (!user.approved) {
          for (const staffUser of users.listUsers()) {
            if (users.isSiteOwner(staffUser) || users.isCommissioner(staffUser)) {
              syncPendingInboxDigests(staffUser, { force: true });
            }
          }
          return sendJson(res, 201, {
            ok: true,
            pendingApproval: true,
            user,
            message: 'Account created. Wait for commissioner approval, then sign in.'
          });
        }
        deliverWelcomeInboxIfNeeded(user);
        const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
        const token = signSession(user.id, expiresAt);
        return sendJson(res, 201, {
          ok: true,
          user,
          homePath: homePathForUser(user, req)
        }, { 'Set-Cookie': sessionCookieHeader(token) });
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
      syncPendingInboxDigests(user, { force: true });
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
      const identifier = String(body.email || body.loginName || body.identifier || '').trim();
      const generic = {
        ok: true,
        message: 'If that login or email is on file, a reset link has been sent. Check spam — the link expires in one hour.'
      };
      if (!identifier) return sendJson(res, 200, generic);

      const created = users.createResetToken(identifier);
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
        return sendJson(res, 200, {
          ok: true,
          user,
          homePath: homePathForUser(user, req)
        }, { 'Set-Cookie': sessionCookieHeader(token) });
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

    if (pathname === '/api/profile' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      try {
        return sendJson(res, 200, buildOwnProfile(user, req));
      } catch (err) {
        return sendJson(res, err.status || 500, { ok: false, error: err.message || 'Could not load profile' });
      }
    }

    if (pathname === '/api/profile' && req.method === 'PATCH') {
      const sessionUser = getSessionUser(req);
      if (!sessionUser) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const patch = {};
        if (Object.prototype.hasOwnProperty.call(body, 'name')) patch.name = body.name;
        if (Object.prototype.hasOwnProperty.call(body, 'bio')) patch.bio = body.bio;
        const user = users.updateProfile(sessionUser.id, patch);
        return sendJson(res, 200, { ok: true, user });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not update profile' });
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

    if (GRIDIRON_ONLY_PAGES.has(pathname) || pathname === '/scoreboard' || pathname === '/scoreboard.html'
      || pathname === '/rankings.html' || pathname === '/schedules.html' || pathname === '/team-rosters.html') {
      const user = getSessionUser(req);
      const scope = leagueScopeForUser(user, req);
      if (user && isIndependentHqScope(scope)) {
        res.writeHead(302, {
          Location: scope.homePath || '/restricted.html?area=league',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache'
        });
        return res.end();
      }
      if (user && !canInspectAsOwner(user) && scope.scope === 'aaa' && getAffiliatedLeague('aaa')) {
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
      const session = getSessionUser(req);
      if (session) {
        res.writeHead(302, {
          Location: homePathForUser(session, req),
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache'
        });
        return res.end();
      }
      return sendFile(res, path.join(PUBLIC_DIR, 'login.html'));
    }
    if (pathname === '/register' || pathname === '/register.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'register.html'));
    }

    if (pathname === '/register-league' || pathname === '/register-league.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'register-league.html'));
    }

    if (pathname === '/create-league' || pathname === '/create-league.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'create-league.html'));
    }

    if (pathname === '/my-league' || pathname === '/my-league.html') {
      const user = getSessionUser(req);
      if (!user) {
        res.writeHead(302, { Location: '/enter?next=' + encodeURIComponent('/my-league.html') });
        return res.end();
      }
      try {
        const owned = leagues.listIndependentLeaguesForOwner(user.id);
        const league = owned[0] || (user.leagueId ? leagues.findById(user.leagueId) : null);
        if (league?.platform === 'independent' && league.slug) {
          res.writeHead(302, {
            Location: leagues.independentHomePath(league),
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            Pragma: 'no-cache'
          });
          return res.end();
        }
      } catch { /* fall through */ }
      return sendFile(res, path.join(PUBLIC_DIR, 'my-league.html'));
    }

    // Independent league HQ: /{slug}.html and /{slug}/{section}.html
    {
      const il = parseIndependentHqPath(pathname);
      if (il) {
        const league = leagues.findBySlug(il.slug);
        if (league?.platform === 'independent') {
          const user = getSessionUser(req);
          if (!user) {
            res.writeHead(302, {
              Location: '/enter?next=' + encodeURIComponent(pathname)
            });
            return res.end();
          }
          if (!canViewIndependentLeague(user, league)) {
            res.writeHead(302, {
              Location: '/restricted.html?area=league',
              'Cache-Control': 'no-store, no-cache, must-revalidate',
              Pragma: 'no-cache'
            });
            return res.end();
          }
          return sendFile(res, path.join(PUBLIC_DIR, 'league-hq.html'));
        }
      }
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
        aaaEnabled: Boolean(config.aaaEnabled) && Array.isArray(config.affiliatedLeagues) && config.affiliatedLeagues.length > 0,
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
        users.assertEmailAvailable(owner.email);
        const draftId = String(body.draftId || '').trim() || crypto.randomUUID();
        const uploadedAssets = leagues.listDraftAssets(draftId);

        const user = users.createUser({
          name: owner.name,
          email: owner.email,
          loginName: owner.loginName,
          password: owner.password,
          role: 'commissioner',
          approved: true,
          loungeMember: true,
          leagueOwner: true
        });
        notifySiteOwnersOfNewAccount(user, { source: 'league_registration' });

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

    if (pathname === '/api/create-league/template' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        open: leagues.registrationEnabled(),
        template: leagues.vanillaIndependentTemplate()
      });
    }

    if (pathname === '/api/create-league/draft' && req.method === 'POST') {
      const user = getSessionUser(req);
      const needsSetup = user
        && leagues.listIndependentLeaguesForOwner(user.id).some((l) =>
          l.status === 'approved' && l.setupComplete === false
        );
      if (!leagues.registrationEnabled() && !needsSetup) {
        return sendJson(res, 403, { ok: false, error: 'League creation is disabled' });
      }
      const draftId = crypto.randomUUID();
      fs.mkdirSync(path.join(leagues.UPLOAD_DIR, draftId), { recursive: true });
      return sendJson(res, 201, { ok: true, draftId });
    }

    if (pathname === '/api/create-league/asset' && req.method === 'POST') {
      const user = getSessionUser(req);
      const needsSetup = user
        && leagues.listIndependentLeaguesForOwner(user.id).some((l) =>
          l.status === 'approved' && l.setupComplete === false
        );
      if (!leagues.registrationEnabled() && !needsSetup) {
        return sendJson(res, 403, { ok: false, error: 'League creation is disabled' });
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

    if (pathname === '/api/create-league' && req.method === 'POST') {
      if (!leagues.registrationEnabled()) {
        return sendJson(res, 403, { ok: false, error: 'League creation is disabled' });
      }
      let body;
      try {
        body = await readJsonBody(req, { maxBytes: 1_000_000 });
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        // Step 1 only: register owner + league type + team count + name.
        // Full setup (brand/rules/etc.) is step 3 after site-owner approval.
        const sessionUser = getSessionUser(req);
        let user = sessionUser || null;
        let setCookie = null;

        if (!user) {
          const owner = body.owner || {};
          if (owner.password !== owner.confirmPassword) {
            return sendJson(res, 400, { ok: false, error: 'Passwords do not match' });
          }
          users.assertEmailAvailable(owner.email);
          user = users.createUser({
            name: owner.name,
            email: owner.email,
            loginName: owner.loginName,
            password: owner.password,
            role: 'user',
            approved: true,
            loungeMember: true,
            leagueOwner: true
          });
          notifySiteOwnersOfNewAccount(user, { source: 'create_league' });
          const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
          setCookie = sessionCookieHeader(signSession(user.id, expiresAt));
        } else if (user.approved === false) {
          return sendJson(res, 403, { ok: false, error: 'Your account is not approved yet' });
        }

        const existingOwned = leagues.listIndependentLeaguesForOwner(user.id);
        if (existingOwned.some((l) => l.status === 'pending_approval' || (l.status === 'approved' && l.setupComplete === false))) {
          return sendJson(res, 409, {
            ok: false,
            error: 'You already have a league waiting on approval or setup. Open Create a League to continue.'
          });
        }
        const current = resolveCreateLeagueSubject(user, req);
        if (current && current.status === 'approved' && isIndependentHqScope(leagueScopeForUser(user, req))) {
          return sendJson(res, 409, {
            ok: false,
            error: 'This league is already approved. Open HQ — do not submit another request.',
            homePath: leagues.independentHomePath(current)
          });
        }

        const brandName = String(body.brand?.name || '').trim();
        const leagueType = String(body.leagueType || '').trim();
        const conferenceCount = Number(body.structure?.conferenceCount) === 2
          || leagueType === 'two-conferences'
          ? 2
          : 1;
        const totalTeams = Number(body.structure?.totalTeams);

        const league = leagues.createIndependentLeague({
          ownerUserId: user.id,
          ownerName: user.name,
          ownerEmail: user.email,
          brand: { name: brandName },
          structure: {
            totalTeams,
            conferenceCount,
            teamsPerConference: conferenceCount === 2 ? totalTeams / 2 : totalTeams
          }
        });

        leagues.attachOwner(league.id, user.id);
        users.setUserLeagueOwner(user.id, league.id, true);

        try {
          notifySiteOwnersOfLeagueRequest(league, user);
        } catch (mailErr) {
          console.warn('[create-league] owner notify failed', mailErr.message || mailErr);
        }

        const payload = {
          ok: true,
          league,
          user: users.publicUser(users.findById(user.id)),
          homePath: leagues.independentHomePath(league),
          message: 'Your request has been sent! Please keep an eye on your email for approval from GridIron 24.'
        };
        return setCookie
          ? sendJson(res, 201, payload, { 'Set-Cookie': setCookie })
          : sendJson(res, 201, payload);
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not create league' });
      }
    }

    if (pathname === '/api/create-league/complete' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      let body;
      try {
        body = await readJsonBody(req, { maxBytes: 1_000_000 });
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const leagueId = String(body.leagueId || '').trim();
        if (!leagueId) return sendJson(res, 400, { ok: false, error: 'leagueId required' });
        const existing = leagues.findById(leagueId);
        if (!existing || existing.platform !== 'independent') {
          return sendJson(res, 404, { ok: false, error: 'League not found' });
        }
        if (!leagues.canManageIndependentLeague(user, existing)) {
          return sendJson(res, 403, { ok: false, error: 'Only the league owner can finish setup' });
        }
        const draftId = String(body.draftId || '').trim();
        const uploadedAssets = draftId ? leagues.listDraftAssets(draftId) : {};
        const actor = { ...users.publicUser(user), siteOwner: users.isSiteOwner(user) };
        const league = leagues.completeIndependentLeagueSetup(leagueId, body, actor, uploadedAssets);
        return sendJson(res, 200, {
          ok: true,
          league,
          homePath: leagues.independentHomePath(league),
          message: 'League setup complete. Your HQ is ready.'
        });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not complete setup' });
      }
    }

    if (pathname === '/api/my-league' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      const owned = leagues.listIndependentLeaguesForOwner(user.id);
      const requestedId = String(requestUrl.searchParams.get('leagueId') || '').trim();
      const raw = resolveCreateLeagueSubject(user, req, requestedId);
      const byId = user.leagueId ? leagues.findById(user.leagueId) : null;
      const league = raw
        ? leagues.publicLeague(raw)
        : (owned[0] || (byId?.platform === 'independent' ? leagues.publicLeague(byId) : null));
      return sendJson(res, 200, { ok: true, league: league || null, leagues: owned });
    }

    if (pathname === '/api/independent-hq' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      const slug = leagues.slugify(requestUrl.searchParams.get('slug') || '');
      if (!slug) return sendJson(res, 400, { ok: false, error: 'League slug required' });
      const league = leagues.findBySlug(slug);
      if (!league || league.platform !== 'independent') {
        return sendJson(res, 404, { ok: false, error: 'League not found' });
      }
      if (!canViewIndependentLeague(user, league)) {
        return sendJson(res, 403, { ok: false, error: 'You do not have access to this league HQ' });
      }
      const pub = leagues.publicLeague(league);
      const section = String(requestUrl.searchParams.get('section') || 'home').toLowerCase();
      let nflLock = { locked: false, season: league.season || config.season };
      try {
        nflLock = await seasonRulesLock.getStatus(league.season || config.season);
      } catch { /* NFL schedule lookup is optional for HQ */ }
      const persistedLock = rulesSyncStore.getSeasonRulesLock(league.season || config.season);
      const seasonLock = (persistedLock?.locked ? persistedLock : nflLock);
      const isLeagueOwner = Boolean(league.ownerUserId && league.ownerUserId === user.id);
      const extras = {
        canSwitchLeagues: userCanSwitchLeagues(user),
        preferredLeague: `independent:${league.id}`,
        isLeagueOwner
      };
      const headers = { 'Set-Cookie': preferredLeagueCookieHeader(`independent:${league.id}`) };
      return sendJson(res, 200, {
        ok: true,
        league: pub,
        section: INDEPENDENT_HQ_SECTIONS.has(section) ? section : 'home',
        leagueScope: independentLeagueScope(league, extras),
        seasonRulesLock: seasonLock,
        viewer: {
          id: user.id,
          isOwner: isLeagueOwner,
          canManage: isLeagueOwner,
          isMember: true
        },
        pages: {
          home: leagues.independentHomePath(league),
          standings: leagues.independentSectionPath(league, 'standings'),
          schedules: leagues.independentSectionPath(league, 'schedules'),
          myRoster: leagues.independentSectionPath(league, 'my-roster'),
          teamRosters: leagues.independentSectionPath(league, 'team-rosters'),
          rankings: leagues.independentSectionPath(league, 'rankings'),
          draft: leagues.independentSectionPath(league, 'draft'),
          conferenceDraft: leagues.independentSectionPath(league, 'conference-draft'),
          transactions: leagues.independentSectionPath(league, 'transactions'),
          playoffs: leagues.independentSectionPath(league, 'playoffs'),
          calendar: leagues.independentSectionPath(league, 'calendar'),
          rulebook: leagues.independentSectionPath(league, 'rulebook'),
          scoreboard: leagues.independentSectionPath(league, 'scoreboard'),
          payouts: leagues.independentSectionPath(league, 'payouts'),
          keepers: leagues.independentSectionPath(league, 'keepers'),
          settings: leagues.independentSectionPath(league, 'settings'),
          scoring: leagues.independentSectionPath(league, 'scoring'),
          manage: leagues.independentSectionPath(league, 'manage'),
          team: leagues.independentSectionPath(league, 'team')
        }
      }, headers);
    }

    if (pathname === '/api/conference-draft') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Sign in to join the conference draft' });
      let body = {};
      if (req.method === 'POST') {
        try { body = await readJsonBody(req); } catch {
          return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
        }
      }
      let ctx;
      try {
        ctx = resolveConferenceDraftContext(req, requestUrl, body);
      } catch (e) {
        return sendJson(res, e.status || 400, { ok: false, error: e.message });
      }
      if (ctx.scope === 'independent') {
        if (!canViewIndependentLeague(user, ctx.league)) {
          return sendJson(res, 403, { ok: false, error: 'You do not have access to this league' });
        }
        if (ctx.league.conferenceDraftEnabled !== true && !leagues.canManageIndependentLeague(user, ctx.league)) {
          return sendJson(res, 404, { ok: false, error: 'Conference draft is not enabled for this league' });
        }
        if ((ctx.league.conferences || []).length < 2) {
          return sendJson(res, 400, { ok: false, error: 'Conference draft needs two conferences' });
        }
      } else if (!conferenceDraft.inLeague({ scope: 'gridiron' }, user, null)) {
        return sendJson(res, 403, { ok: false, error: 'GridIron 24 members only' });
      }
      const enabled = ctx.scope === 'gridiron' || ctx.league.conferenceDraftEnabled === true
        || leagues.canManageIndependentLeague(user, ctx.league);
      let room = conferenceDraft.ensureRoom({
        scope: ctx.scope,
        leagueId: ctx.leagueId,
        targetSeason: ctx.targetSeason,
        league: ctx.league,
        enabled
      });
      if (!conferenceDraft.inLeague(room, user, ctx.league)) {
        return sendJson(res, 403, { ok: false, error: 'Not in this league' });
      }
      try {
        conferenceDraft.tickRoom(room);
        room = conferenceDraft.getRoom(ctx.scope, ctx.leagueId) || room;
        if (req.method === 'GET') {
          return sendJson(res, 200, conferenceDraftPayload(room, user, ctx));
        }
        const action = String(body.action || '').toLowerCase();
        const manage = conferenceDraft.canManage(room, user, ctx.league);
        if (action === 'setup') {
          if (!manage) return sendJson(res, 403, { ok: false, error: 'Captains or staff only' });
          room = conferenceDraft.setupRoom(room, body, user);
          if (room.draftAt) {
            try {
              const d = new Date(room.draftAt);
              const date = Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
              if (date && ctx.scope === 'gridiron') {
                calendar.addEvent({
                  title: `${room.targetSeason} Conference Draft`,
                  type: 'conference-draft',
                  date,
                  notes: 'League winner and runner-up draft managers into Detail and Overtime. Whole league can watch.'
                });
              }
            } catch { /* ignore duplicate calendar */ }
          }
        } else if (action === 'choose-conference') {
          room = conferenceDraft.chooseConference(room, body.conferenceKey, user);
        } else if (action === 'start') {
          if (!manage) return sendJson(res, 403, { ok: false, error: 'Captains or staff only' });
          if (room.status === 'lobby') room = conferenceDraft.beginLive(room);
          else room = conferenceDraft.openLobby(room);
        } else if (action === 'join') {
          room = conferenceDraft.joinWatch(room, user);
        } else if (action === 'pick') {
          room = conferenceDraft.humanPick(room, user, body.userId, { league: ctx.league });
        } else if (action === 'chat') {
          room = conferenceDraft.addChat(room, user, body.text);
        } else if (action === 'mayor-switch') {
          room = conferenceDraft.mayorSwitch(room, user, body.conferenceKey);
        } else if (action === 'apply') {
          room = conferenceDraft.applyAssignments(room, user, { league: ctx.league });
        } else {
          return sendJson(res, 400, { ok: false, error: 'Unknown action' });
        }
        room = conferenceDraft.getRoom(ctx.scope, ctx.leagueId) || room;
        return sendJson(res, 200, conferenceDraftPayload(room, user, ctx));
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Conference draft failed' });
      }
    }

    if (pathname.startsWith('/api/independent-leagues/') && req.method === 'PATCH') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      const parts = independentLeagueRouteParts(pathname);
      // independent-leagues/:id/settings
      if (parts.length !== 3 || parts[2] !== 'settings') {
        return sendJson(res, 404, { ok: false, error: 'Not found' });
      }
      const leagueId = parts[1];
      const league = leagues.findById(leagueId);
      if (!league || league.platform !== 'independent') {
        return sendJson(res, 404, { ok: false, error: 'League not found' });
      }
      if (!leagues.canManageIndependentLeague(user, league)) {
        return sendJson(res, 403, { ok: false, error: 'Only the league owner can change settings' });
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      try {
        const lock = await seasonRulesLock.getStatus(league.season || config.season);
        const persisted = rulesSyncStore.isSeasonRulesLocked(league.season || config.season);
        if ((lock.locked || persisted) && seasonRulesLock.patchTouchesSeasonRules(body)) {
          return sendJson(res, 400, {
            ok: false,
            error: 'Season rules are locked at kickoff of Week 1',
            code: 'season_rules_locked'
          });
        }
        const actor = { ...users.publicUser(user), siteOwner: users.isSiteOwner(user) };
        const updated = leagues.updateIndependentSettings(leagueId, body, actor);
        return sendJson(res, 200, { ok: true, league: updated });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not save settings' });
      }
    }

    if (pathname.startsWith('/api/independent-leagues/') && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      const parts = independentLeagueRouteParts(pathname);
      // independent-leagues/:id/asset | invites | invites/:inviteId/resend | franchises/assign | franchises/rename
      if (parts.length < 3) {
        return sendJson(res, 404, { ok: false, error: 'Not found' });
      }
      const leagueId = parts[1];
      const league = leagues.findById(leagueId);
      if (!league || league.platform !== 'independent') {
        return sendJson(res, 404, { ok: false, error: 'League not found' });
      }
      const isOwner = leagues.canManageIndependentLeague(user, league);
      let body = {};
      try {
        body = await readJsonBody(req, { maxBytes: 3_500_000 });
      } catch {
        body = {};
      }

      if (parts.length === 3 && parts[2] === 'asset') {
        if (!isOwner) return sendJson(res, 403, { ok: false, error: 'Only the league owner can upload logos' });
        if (league.status !== 'approved') {
          return sendJson(res, 403, { ok: false, error: 'League must be approved before uploads' });
        }
        try {
          const assetType = String(body.assetType || '').trim();
          if (!leagues.ASSET_TYPES.has(assetType)) {
            return sendJson(res, 400, { ok: false, error: 'Unknown asset type' });
          }
          if (assetType.startsWith('conferenceLogo')) {
            const idx = Number(assetType.replace('conferenceLogo', ''));
            if (!Number.isFinite(idx) || idx < 0 || idx >= (league.conferences || []).length) {
              return sendJson(res, 400, { ok: false, error: 'That conference logo slot is not available' });
            }
          }
          const dataUrl = String(body.dataUrl || '');
          const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([a-zA-Z0-9+/=\s]+)$/);
          if (!match) {
            return sendJson(res, 400, { ok: false, error: 'Upload a PNG, JPG, WEBP, or SVG image' });
          }
          const url = leagues.saveAssetBuffer(
            leagueId,
            assetType,
            Buffer.from(match[2].replace(/\s+/g, ''), 'base64'),
            match[1]
          );
          const updated = leagues.updateLeagueAssets(leagueId, { [assetType]: url });
          return sendJson(res, 200, { ok: true, assetType, url, league: updated });
        } catch (err) {
          return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Upload failed' });
        }
      }

      if (parts.length === 3 && parts[2] === 'invites') {
        if (!isOwner) return sendJson(res, 403, { ok: false, error: 'Only the league owner can invite players' });
        if (league.status !== 'approved') {
          return sendJson(res, 403, { ok: false, error: 'League must be approved before inviting players' });
        }
        const rawEmails = Array.isArray(body.emails)
          ? body.emails.map((e) => String(e || '').trim()).filter(Boolean)
          : String(body.email || body.emails || '')
            .split(/[,;\n]+/)
            .map((e) => e.trim())
            .filter(Boolean);
        const seen = new Set();
        const emails = [];
        for (const email of rawEmails) {
          const key = email.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          emails.push(email);
        }
        if (!emails.length) return sendJson(res, 400, { ok: false, error: 'Enter at least one email address' });
        const franchiseId = emails.length === 1
          ? (String(body.franchiseId || '').trim() || null)
          : null;
        const results = [];
        let latestLeague = leagues.publicLeague(league);
        for (const email of emails) {
          try {
            const row = await inviteIndependentPlayer(req, {
              league: leagues.findById(leagueId) || league,
              actor: user,
              email,
              franchiseId
            });
            if (row.league) latestLeague = row.league;
            results.push(row);
          } catch (err) {
            results.push({
              ok: false,
              email: users.normalizeEmail(email) || email,
              error: err.message || 'Could not invite'
            });
          }
        }
        const okCount = results.filter((r) => r.ok).length;
        const one = results.length === 1 ? results[0] : null;
        return sendJson(res, okCount ? 201 : 400, {
          ok: okCount > 0,
          attached: Boolean(one?.attached),
          invite: one?.invite || null,
          inviteUrl: one?.inviteUrl || null,
          sent: Boolean(one?.sent),
          method: one?.method || null,
          mailError: one?.mailError || null,
          message: one
            ? (one.message || one.error)
            : `Sent ${okCount} of ${results.length} invites.`,
          results,
          league: latestLeague
        });
      }

      if (parts.length === 4 && parts[2] === 'invites' && parts[3] !== 'resend') {
        // POST .../invites/:inviteId/resend handled below with length 5
      }

      if (parts.length === 5 && parts[2] === 'invites' && parts[4] === 'resend') {
        if (!isOwner) return sendJson(res, 403, { ok: false, error: 'Only the league owner can resend invites' });
        const inviteId = parts[3];
        try {
          const existing = invites.listInvitesForLeague(leagueId).find((i) => i.id === inviteId);
          if (!existing) return sendJson(res, 404, { ok: false, error: 'Invite not found' });
          const refreshed = invites.refreshInvite(inviteId, user);
          const inviteUrl = `${requestOrigin(req)}/register?invite=${encodeURIComponent(refreshed.token)}`;
          const sendMail = body.send !== false;
          let mailResult = { sent: false, method: 'none' };
          if (sendMail) {
            try {
              mailResult = await sendInviteEmail({
                to: refreshed.invite.email,
                inviteUrl,
                invitedByName: user.name || user.loginName,
                leagueName: league.brand?.name || 'your league',
                baseUrl: requestOrigin(req),
                loungeOnly: false,
                independent: true
              });
            } catch (mailErr) {
              mailResult = { sent: false, method: 'error', error: mailErr.message || 'Email send failed' };
            }
          }
          return sendJson(res, 200, {
            ok: true,
            invite: refreshed.invite,
            inviteUrl,
            sent: Boolean(mailResult.sent),
            method: sendMail ? mailResult.method : 'copy',
            mailError: mailResult.error || null
          });
        } catch (err) {
          return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not resend' });
        }
      }

      if (parts.length === 4 && parts[2] === 'franchises' && parts[3] === 'assign') {
        if (!isOwner) return sendJson(res, 403, { ok: false, error: 'Only the league owner can assign franchises' });
        const franchiseId = String(body.franchiseId || '').trim();
        const userId = body.userId == null || body.userId === '' ? null : String(body.userId);
        if (!franchiseId) return sendJson(res, 400, { ok: false, error: 'franchiseId required' });
        try {
          let manager = null;
          if (userId) {
            manager = users.findById(userId);
            if (!manager) return sendJson(res, 404, { ok: false, error: 'User not found' });
            if (manager.leagueId && manager.leagueId !== leagueId && manager.id !== league.ownerUserId) {
              return sendJson(res, 400, { ok: false, error: 'That user is not in this league' });
            }
            if (!manager.leagueId) users.setUserLeagueOwner(manager.id, leagueId, false);
            manager = users.findById(manager.id);
          }
          const updated = leagues.assignFranchiseManager(leagueId, franchiseId, manager);
          return sendJson(res, 200, { ok: true, league: updated });
        } catch (err) {
          return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not assign' });
        }
      }

      if (parts.length === 4 && parts[2] === 'franchises' && parts[3] === 'rename') {
        if (!isOwner) return sendJson(res, 403, { ok: false, error: 'Only the league owner can rename franchises' });
        try {
          const updated = leagues.renameIndependentFranchise(leagueId, body.franchiseId, {
            name: body.name,
            abbrev: body.abbrev
          });
          return sendJson(res, 200, { ok: true, league: updated });
        } catch (err) {
          return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not rename' });
        }
      }

      if (parts.length === 3 && parts[2] === 'lineup') {
        try {
          const poolPayload = await nflverseDraft.loadDraftPool(draftPoolOpts(league));
          const injuries = independentKeepers.injuryMapFromPool(poolPayload.players || []);
          const updated = leagues.setIndependentLineup(leagueId, body.franchiseId, body.lineup, {
            userId: user.id,
            id: user.id,
            name: user.name || user.loginName,
            loginName: user.loginName,
            isSiteOwner: users.isSiteOwner(user),
            injuries
          });
          return sendJson(res, 200, { ok: true, league: updated });
        } catch (err) {
          return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not save lineup' });
        }
      }

      if (parts.length === 3 && parts[2] === 'wire') {
        if (!canViewIndependentLeague(user, league)) {
          return sendJson(res, 403, { ok: false, error: 'You do not have access to this league' });
        }
        const actor = {
          id: user.id,
          userId: user.id,
          name: user.name || user.loginName,
          loginName: user.loginName,
          isSiteOwner: users.isSiteOwner(user)
        };
        const action = String(body.action || '').toLowerCase();
        try {
          if (action === 'add') {
            const poolPayload = await nflverseDraft.loadDraftPool(draftPoolOpts(league));
            const poolPlayer = (poolPayload.players || []).find((p) =>
              String(p.id) === String(body.playerId) || String(p.playerId) === String(body.playerId)
            );
            if (!poolPlayer) return sendJson(res, 404, { ok: false, error: 'Player not found in the pool' });
            const result = independentWire.addFreeAgent(leagueId, {
              franchiseId: body.franchiseId,
              player: poolPlayer,
              dropPlayerId: body.dropPlayerId || null,
              actor
            });
            return sendJson(res, 200, result);
          }
          if (action === 'drop') {
            const result = independentWire.dropPlayer(leagueId, {
              franchiseId: body.franchiseId,
              playerId: body.playerId,
              actor
            });
            return sendJson(res, 200, result);
          }
          if (action === 'claim') {
            const result = independentWire.claimWaiver(leagueId, {
              franchiseId: body.franchiseId,
              playerId: body.playerId,
              dropPlayerId: body.dropPlayerId || null,
              bid: body.bid,
              actor
            });
            return sendJson(res, 200, result);
          }
          if (action === 'cancel-claim') {
            const result = independentWire.cancelClaim(leagueId, { claimId: body.claimId, actor });
            return sendJson(res, 200, result);
          }
          if (action === 'process') {
            const result = independentWire.processWaivers(leagueId, { force: true, actor });
            return sendJson(res, 200, result);
          }
          if (action === 'propose-trade') {
            const result = independentWire.proposeTrade(leagueId, body, actor);
            return sendJson(res, 200, result);
          }
          if (action === 'trade') {
            const result = independentWire.respondTrade(leagueId, {
              tradeId: body.tradeId,
              action: body.tradeAction || body.response,
              actor
            });
            return sendJson(res, 200, result);
          }
          return sendJson(res, 400, { ok: false, error: 'Unknown wire action' });
        } catch (err) {
          return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Wire request failed' });
        }
      }

      if (parts.length === 3 && parts[2] === 'playoffs') {
        if (!canViewIndependentLeague(user, league)) {
          return sendJson(res, 403, { ok: false, error: 'You do not have access to this league' });
        }
        const actor = {
          id: user.id,
          userId: user.id,
          isSiteOwner: users.isSiteOwner(user)
        };
        const action = String(body.action || '').toLowerCase();
        try {
          if (action === 'lock') {
            return sendJson(res, 200, independentPlayoffs.lockPlayoffs(leagueId, actor));
          }
          if (action === 'reseed') {
            return sendJson(res, 200, independentPlayoffs.reseedPlayoffs(leagueId, actor));
          }
          if (action === 'set-winner') {
            return sendJson(res, 200, independentPlayoffs.setWinner(leagueId, {
              gameId: body.gameId,
              winnerId: body.winnerId,
              actor
            }));
          }
          return sendJson(res, 400, { ok: false, error: 'Unknown playoff action' });
        } catch (err) {
          return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Playoff request failed' });
        }
      }

      if (parts.length === 3 && parts[2] === 'keepers') {
        if (!canViewIndependentLeague(user, league)) {
          return sendJson(res, 403, { ok: false, error: 'You do not have access to this league' });
        }
        const actor = {
          id: user.id,
          userId: user.id,
          isSiteOwner: users.isSiteOwner(user)
        };
        const action = String(body.action || '').toLowerCase();
        try {
          if (action === 'declare') {
            return sendJson(res, 200, independentKeepers.declareKeeper(leagueId, {
              franchiseId: body.franchiseId,
              playerId: body.playerId,
              actor
            }));
          }
          if (action === 'undeclare') {
            return sendJson(res, 200, independentKeepers.undeclareKeeper(leagueId, {
              franchiseId: body.franchiseId,
              playerId: body.playerId,
              actor
            }));
          }
          if (action === 'lock') {
            return sendJson(res, 200, independentKeepers.lockKeepers(leagueId, actor));
          }
          if (action === 'rollover') {
            return sendJson(res, 200, independentKeepers.rolloverSeason(leagueId, actor));
          }
          return sendJson(res, 400, { ok: false, error: 'Unknown keeper action' });
        } catch (err) {
          return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Keeper request failed' });
        }
      }

      return sendJson(res, 404, { ok: false, error: 'Not found' });
    }

    if (pathname.startsWith('/api/independent-leagues/') && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      const parts = independentLeagueRouteParts(pathname);
      // independent-leagues/:id/invites | members
      if (parts.length !== 3) {
        // draft GET is handled elsewhere with includes('/draft')
        if (!(parts.length === 3 && (parts[2] === 'invites' || parts[2] === 'members'))) {
          /* fall through below only for invites/members */
        }
      }
      if (parts.length === 3 && (parts[2] === 'invites' || parts[2] === 'members' || parts[2] === 'scoreboard' || parts[2] === 'wire' || parts[2] === 'playoffs' || parts[2] === 'keepers')) {
        const leagueId = parts[1];
        const league = leagues.findById(leagueId);
        if (!league || league.platform !== 'independent') {
          return sendJson(res, 404, { ok: false, error: 'League not found' });
        }
        if (parts[2] === 'scoreboard') {
          if (!canViewIndependentLeague(user, league)) {
            return sendJson(res, 403, { ok: false, error: 'You do not have access to this league' });
          }
          try {
            try { leagues.ensureIndependentSchedule(leagueId); } catch { /* schedule optional */ }
            const fresh = leagues.findById(leagueId);
            const week = Number(requestUrl.searchParams.get('week')) || 0;
            const scored = await independentScoreboard.scoreLeagueWeek(
              leagues.publicLeague(fresh || league),
              week || undefined
            );
            return sendJson(res, 200, scored);
          } catch (err) {
            console.error('independent scoreboard', leagueId, err);
            return sendJson(res, 200, {
              ok: true,
              leagueId,
              week: Number(requestUrl.searchParams.get('week')) || 1,
              matchups: [],
              standings: [],
              franchises: [],
              statsReady: false,
              live: false,
              statsSource: 'unavailable',
              error: err.message || 'Could not score week'
            });
          }
        }
        if (parts[2] === 'wire') {
          if (!canViewIndependentLeague(user, league)) {
            return sendJson(res, 403, { ok: false, error: 'You do not have access to this league' });
          }
          try {
            const poolPayload = await nflverseDraft.loadDraftPool(draftPoolOpts(league));
            const payload = independentWire.getWire(leagueId, {
              id: user.id,
              userId: user.id,
              name: user.name || user.loginName,
              loginName: user.loginName,
              isSiteOwner: users.isSiteOwner(user)
            }, poolPayload.players || [], {
              q: requestUrl.searchParams.get('q') || '',
              pos: requestUrl.searchParams.get('pos') || '',
              limit: Number(requestUrl.searchParams.get('limit')) || 60
            });
            return sendJson(res, 200, payload);
          } catch (err) {
            return sendJson(res, err.status || 500, {
              ok: false,
              error: err.message || 'Could not load the wire'
            });
          }
        }
        if (parts[2] === 'playoffs') {
          if (!canViewIndependentLeague(user, league)) {
            return sendJson(res, 403, { ok: false, error: 'You do not have access to this league' });
          }
          try {
            const week = Number(requestUrl.searchParams.get('week')) || 0;
            const payload = independentPlayoffs.getPlayoffs(leagueId, { week: week || undefined });
            return sendJson(res, 200, payload);
          } catch (err) {
            return sendJson(res, err.status || 500, {
              ok: false,
              error: err.message || 'Could not load playoffs'
            });
          }
        }
        if (parts[2] === 'keepers') {
          if (!canViewIndependentLeague(user, league)) {
            return sendJson(res, 403, { ok: false, error: 'You do not have access to this league' });
          }
          try {
            const payload = independentKeepers.getKeepers(leagueId, {
              id: user.id,
              userId: user.id,
              isSiteOwner: users.isSiteOwner(user)
            });
            return sendJson(res, 200, payload);
          } catch (err) {
            return sendJson(res, err.status || 500, {
              ok: false,
              error: err.message || 'Could not load keepers'
            });
          }
        }
        if (!leagues.canManageIndependentLeague(user, league)) {
          return sendJson(res, 403, { ok: false, error: 'Only the league owner can view this' });
        }
        if (parts[2] === 'invites') {
          return sendJson(res, 200, {
            ok: true,
            invites: invites.listInvitesForLeague(leagueId),
            mail: mailConfig()
          });
        }
        const members = users.listUsers()
          .filter((u) => u.leagueId === leagueId || u.id === league.ownerUserId)
          .map((u) => {
            const pub = users.publicUser(u);
            const franchise = (league.franchises || []).find((f) => f.managerUserId === u.id) || null;
            return {
              ...pub,
              isOwner: u.id === league.ownerUserId,
              franchiseId: franchise?.id || null,
              franchiseName: franchise?.name || null
            };
          });
        return sendJson(res, 200, { ok: true, members });
      }
    }

    if (pathname.startsWith('/api/independent-leagues/') && req.method === 'DELETE') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      const parts = independentLeagueRouteParts(pathname);
      // independent-leagues/:id/invites/:inviteId
      if (parts.length === 4 && parts[2] === 'invites') {
        const leagueId = parts[1];
        const inviteId = parts[3];
        const league = leagues.findById(leagueId);
        if (!league || league.platform !== 'independent') {
          return sendJson(res, 404, { ok: false, error: 'League not found' });
        }
        if (!leagues.canManageIndependentLeague(user, league)) {
          return sendJson(res, 403, { ok: false, error: 'Only the league owner can revoke invites' });
        }
        const existing = invites.listInvitesForLeague(leagueId).find((i) => i.id === inviteId);
        if (!existing) return sendJson(res, 404, { ok: false, error: 'Invite not found' });
        try {
          const revoked = invites.revokeInvite(inviteId);
          return sendJson(res, 200, { ok: true, invite: revoked });
        } catch (err) {
          return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not revoke' });
        }
      }
    }

    if (pathname.startsWith('/api/independent-leagues/') && pathname.includes('/draft') && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      const parts = independentLeagueRouteParts(pathname);
      // independent-leagues/:id/draft
      if (parts.length !== 3 || parts[2] !== 'draft') {
        return sendJson(res, 404, { ok: false, error: 'Not found' });
      }
      const leagueId = parts[1];
      const league = leagues.findById(leagueId);
      if (!league || league.platform !== 'independent') {
        return sendJson(res, 404, { ok: false, error: 'League not found' });
      }
      if (!canViewIndependentLeague(user, league)) {
        return sendJson(res, 403, { ok: false, error: 'You do not have access to this league' });
      }
      try {
        const poolPayload = await nflverseDraft.loadDraftPool(draftPoolOpts(league));
        const pool = independentKeepers.filterDraftPool(league, poolPayload.players || []);
        const tick = independentDraft.tickLeague(leagueId, pool, user.id) || {
          league: leagues.publicLeague(league),
          rooms: []
        };
        const taken = new Set(
          (tick.rooms || []).flatMap((r) => (r.picks || []).map((p) => String(p.playerId)))
        );
        const serializePlayer = (p) => ({
          id: p.id,
          gsisId: p.gsisId || null,
          espnId: p.espnId || null,
          sleeperId: p.sleeperId || null,
          name: p.name || p.fullName,
          position: p.position,
          team: p.team || p.nflTeam,
          jersey: p.jersey || null,
          headshot: p.headshot || null,
          teamLogo: p.teamLogo || null,
          adp: p.adp ?? null,
          adpFfc: p.adpFfc ?? null,
          adpSleeper: p.adpSleeper ?? null,
          adpSource: p.adpSource || null,
          overallRank: p.overallRank ?? null,
          posRank: p.posRank ?? null,
          rankScore: p.rankScore ?? null,
          rankInputs: p.rankInputs || null,
          vorp: p.vorp ?? null,
          fantasyPoints2025: p.fantasyPoints2025 ?? null,
          projectedPoints2026: p.projectedPoints2026 ?? null,
          avgPpg: p.avgPpg ?? null,
          games: p.games ?? null,
          delta: p.delta ?? null,
          injuryStatus: p.injuryStatus || null,
          injuryBodyPart: p.injuryBodyPart || null,
          injuryNotes: p.injuryNotes || null,
          practiceStatus: p.practiceStatus || null,
          practiceDescription: p.practiceDescription || null,
          byeWeek: p.byeWeek ?? null,
          stats: p.stats || null,
          projStats: p.projStats || null,
          sources: p.sources || null
        });
        const players = pool.filter((p) => p?.id).map(serializePlayer);
        const available = players.filter((p) => !taken.has(String(p.id)));
        return sendJson(res, 200, {
          ok: true,
          league: tick.league,
          rooms: tick.rooms || [],
          players,
          available,
          poolMeta: {
            statsSeason: poolPayload.statsSeason || poolPayload.meta?.statsSeason || null,
            projectionSeason: poolPayload.projectionSeason || poolPayload.meta?.projectionSeason || null,
            scoring: poolPayload.scoring || poolPayload.meta?.scoring || null,
            scoringLabel: poolPayload.scoringLabel || poolPayload.meta?.scoringLabel || null
          },
          viewer: {
            id: user.id,
            isOwner: Boolean(league.ownerUserId && league.ownerUserId === user.id),
            isSiteOwner: users.isSiteOwner(user)
          },
          now: new Date().toISOString()
        });
      } catch (err) {
        return sendJson(res, err.status || 500, { ok: false, error: err.message || 'Draft unavailable' });
      }
    }

    if (pathname.startsWith('/api/independent-leagues/') && pathname.includes('/draft') && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      const parts = independentLeagueRouteParts(pathname);
      // independent-leagues/:id/draft
      if (parts.length !== 3 || parts[2] !== 'draft') {
        return sendJson(res, 404, { ok: false, error: 'Not found' });
      }
      const leagueId = parts[1];
      const league = leagues.findById(leagueId);
      if (!league || league.platform !== 'independent') {
        return sendJson(res, 404, { ok: false, error: 'League not found' });
      }
      if (!canViewIndependentLeague(user, league)) {
        return sendJson(res, 403, { ok: false, error: 'You do not have access to this league' });
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const action = String(body.action || 'tick').toLowerCase();
      try {
        const poolPayload = await nflverseDraft.loadDraftPool(draftPoolOpts(league));
        const pool = independentKeepers.filterDraftPool(league, poolPayload.players || []);
        const actor = { ...users.publicUser(user), siteOwner: users.isSiteOwner(user) };

        if (action === 'claim') {
          const updated = independentDraft.claimSeat(leagueId, body.franchiseId, actor);
          return sendJson(res, 200, { ok: true, league: updated });
        }
        if (action === 'start') {
          if (!leagues.canManageIndependentLeague(actor, league)) {
            return sendJson(res, 403, { ok: false, error: 'Only the league owner can force-start' });
          }
          const started = independentDraft.startOfficialDraft(leagueId, { force: Boolean(body.force) });
          const tick = independentDraft.tickLeague(leagueId, pool, user.id);
          return sendJson(res, 200, {
            ok: true,
            league: tick?.league || started.league,
            rooms: tick?.rooms || (started.rooms || []).map((r) => independentDraft.publicRoom(r, user.id))
          });
        }
        if (action === 'join') {
          const joined = independentDraft.joinDraftSeat(
            leagueId,
            body.roomId,
            actor,
            body.seatIndex
          );
          const tick = independentDraft.tickLeague(leagueId, pool, user.id);
          return sendJson(res, 200, {
            ok: true,
            room: joined,
            league: tick?.league || leagues.publicLeague(leagues.findById(leagueId)),
            rooms: tick?.rooms || [joined]
          });
        }
        if (action === 'skip-join' || action === 'skip-join-window') {
          const skipped = independentDraft.skipJoinWindow(leagueId, body.roomId, actor);
          const tick = independentDraft.tickLeague(leagueId, pool, user.id);
          return sendJson(res, 200, {
            ok: true,
            room: skipped,
            league: tick?.league || leagues.publicLeague(leagues.findById(leagueId)),
            rooms: tick?.rooms || [skipped]
          });
        }
        if (action === 'pick') {
          const room = independentDraft.humanPick(
            leagueId,
            body.roomId,
            actor,
            body.playerId,
            pool
          );
          const tick = independentDraft.tickLeague(leagueId, pool, user.id);
          return sendJson(res, 200, {
            ok: true,
            room,
            league: tick?.league || leagues.publicLeague(leagues.findById(leagueId)),
            rooms: tick?.rooms || [room]
          });
        }
        if (action === 'chat') {
          const sent = independentDraft.addChatMessage({
            leagueId,
            roomId: body.roomId,
            user: actor,
            body: body.body
          });
          const tick = independentDraft.tickLeague(leagueId, pool, user.id);
          return sendJson(res, 200, {
            ok: true,
            room: sent.room,
            message: sent.message,
            league: tick?.league || leagues.publicLeague(leagues.findById(leagueId)),
            rooms: tick?.rooms || [sent.room]
          });
        }
        // tick (default)
        const tick = independentDraft.tickLeague(leagueId, pool, user.id);
        return sendJson(res, 200, {
          ok: true,
          league: tick?.league || leagues.publicLeague(league),
          rooms: tick?.rooms || []
        });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Draft action failed' });
      }
    }

    if (pathname === '/api/leagues/pending' && req.method === 'GET') {
      if (!requireSiteOwner(req, res)) return;
      return sendJson(res, 200, {
        ok: true,
        leagues: leagues.listPendingIndependentLeagues()
      });
    }

    if (pathname.startsWith('/api/leagues/') && pathname.endsWith('/approve') && req.method === 'POST') {
      const actor = requireSiteOwner(req, res);
      if (!actor) return;
      const leagueId = pathname.slice('/api/leagues/'.length, -'/approve'.length);
      try {
        const league = leagues.approveIndependentLeague(leagueId, actor.id);
        try {
          if (league.ownerUserId) {
            inbox.sendMessage({
              toUserId: league.ownerUserId,
              from: { name: 'League HQ' },
              subject: `${league.brand?.name || 'Your league'} was approved`,
              body: [
                `Your league “${league.brand?.name || league.slug}” was approved.`,
                '',
                'Open HQ and set it up: logos, conferences, scoring, roster slots, draft, playoffs, and invites.',
                '',
                leagues.independentSectionPath(league, 'settings')
              ].join('\n'),
              type: 'league_approved',
              meta: { href: leagues.independentSectionPath(league, 'settings'), leagueId: league.id }
            });
          }
        } catch { /* ignore */ }
        return sendJson(res, 200, { ok: true, league });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not approve' });
      }
    }

    if (pathname.startsWith('/api/leagues/') && pathname.endsWith('/reject') && req.method === 'POST') {
      const actor = requireSiteOwner(req, res);
      if (!actor) return;
      const leagueId = pathname.slice('/api/leagues/'.length, -'/reject'.length);
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      try {
        const league = leagues.rejectIndependentLeague(leagueId, body.reason, actor.id);
        try {
          if (league.ownerUserId) {
            inbox.sendMessage({
              toUserId: league.ownerUserId,
              from: { name: 'League HQ' },
              subject: `${league.brand?.name || 'Your league'} was not approved`,
              body: [
                `Your independent league “${league.brand?.name || league.slug}” was not approved.`,
                '',
                league.rejectionReason || 'No reason provided.'
              ].join('\n'),
              type: 'league_rejected',
              meta: { href: independentCreateLeagueHref(league), leagueId: league.id }
            });
          }
        } catch { /* ignore */ }
        return sendJson(res, 200, { ok: true, league });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not reject' });
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
        expiresAt: invite.expiresAt,
        loungeOnly: Boolean(invite.loungeOnly),
        accountType: invite.loungeOnly ? 'social' : 'member',
        accountExists: Boolean(users.findByEmail(invite.email))
      });
    }

    if (pathname === '/forgot' || pathname === '/forgot.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'forgot.html'));
    }
    if (pathname === '/reset' || pathname === '/reset.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'reset.html'));
    }

    if (!requireAuth(req, res, pathname)) return;
    if (!enforceLoungeOnlyAccess(req, res, pathname)) return;

    const aaaPausedPaths = new Set([
      '/aaa', '/aaa/', '/aaa.html',
      '/aaa-playoffs', '/aaa-playoffs/', '/aaa-playoffs.html',
      '/aaa-rulebook', '/aaa-rulebook/', '/aaa-rulebook.html',
      '/aaa-scoreboard', '/aaa-scoreboard.html'
    ]);
    if (!getAffiliatedLeague('aaa') && aaaPausedPaths.has(pathname)) {
      res.writeHead(302, {
        Location: '/home.html',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache'
      });
      return res.end();
    }

    if (pathname === '/app' || pathname === '/app/' || pathname === '/app/index.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'app', 'index.html'));
    }

    if (pathname === '/scoreboard' || pathname === '/scoreboard.html') {
      const user = getSessionUser(req);
      if (user && !canInspectAsOwner(user) && leagueScopeForUser(user, req).scope === 'aaa' && getAffiliatedLeague('aaa')) {
        res.writeHead(302, {
          Location: '/aaa-scoreboard',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache'
        });
        return res.end();
      }
      return sendFile(res, path.join(PUBLIC_DIR, 'scoreboard.html'));
    }

    if (pathname === '/aaa-scoreboard' || pathname === '/aaa-scoreboard.html') {
      const user = getSessionUser(req);
      if (user && !canInspectAsOwner(user) && leagueScopeForUser(user, req).scope !== 'aaa') {
        res.writeHead(302, {
          Location: '/scoreboard',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache'
        });
        return res.end();
      }
      return sendFile(res, path.join(PUBLIC_DIR, 'scoreboard.html'));
    }

    if (pathname === '/beta-scoring' || pathname === '/beta-scoring.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'beta-scoring.html'));
    }

    if (pathname === '/beta-draft' || pathname === '/beta-draft.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'beta-draft.html'));
    }

    if (pathname === '/roster-2026' || pathname === '/roster-2026.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'roster-2026.html'));
    }

    if (pathname === '/espn-setup' || pathname === '/espn-setup.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'espn-setup.html'));
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
        // Default lounge pull includes fantasy boards; explicit ?leagues=nfl (etc.) skips them.
        const extraBoards = leagues ? [] : await loadFantasySportsBoards();
        // One week of day-based slates so preseason can show without
        // next month's openers.
        const payload = await sportsScoreboard.getSportsScores({
          leagues,
          extraBoards,
          daysAhead: 7
        });
        return sendJson(res, 200, payload);
      } catch (err) {
        return sendJson(res, err.status || 502, {
          ok: false,
          error: err.message || 'Sports scores unavailable'
        });
      }
    }

    if (pathname === '/api/survivor-pool' && req.method === 'GET') {
      const viewer = requireLoungeMember(req, res);
      if (!viewer) return;
      try {
        // Auto-settle current NFL week when finals exist.
        const scores = await sportsScoreboard.getSportsScores({ leagues: 'nfl' });
        const nfl = (scores.leagues || []).find((l) => l.id === 'nfl');
        const weekNum = Number(nfl?.week?.number) || null;
        if (weekNum && nfl?.games?.length) {
          survivorPool.settleWeek(weekNum, nfl.games);
        }
        return sendJson(res, 200, {
          ...survivorPool.getPool(users.publicUser(viewer)),
          nflWeek: weekNum,
          nflSlate: (nfl?.games || []).map((g) => ({
            id: g.id,
            date: g.date,
            status: g.status,
            away: g.away,
            home: g.home
          })),
          generatedAt: new Date().toISOString()
        });
      } catch (err) {
        return sendJson(res, err.status || 500, {
          ok: false,
          error: err.message || 'Survivor pool unavailable'
        });
      }
    }

    if (pathname === '/api/survivor-pool' && req.method === 'POST') {
      const user = requireLoungeMember(req, res);
      if (!user) return;
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      try {
        const action = String(body.action || '').toLowerCase();
        if (action === 'join') {
          return sendJson(res, 200, survivorPool.joinPool(users.publicUser(user)));
        }
        if (action === 'pick') {
          return sendJson(res, 200, survivorPool.makePick(users.publicUser(user), {
            week: body.week,
            teamAbbr: body.teamAbbr
          }));
        }
        return sendJson(res, 400, { ok: false, error: 'Unknown survivor action' });
      } catch (err) {
        return sendJson(res, err.status || 400, {
          ok: false,
          error: err.message || 'Survivor action failed'
        });
      }
    }

    if (pathname === '/api/death-pool' && req.method === 'GET') {
      const viewer = requireLoungeMember(req, res);
      if (!viewer) return;
      try {
        const poolId = requestUrl.searchParams.get('poolId');
        const newsWatch = await deathPoolNews.getNewsWatch({
          refreshIfStale: requestUrl.searchParams.get('skipNews') !== '1'
        });
        if (poolId) {
          return sendJson(res, 200, {
            ...deathPool.getPool(poolId, users.publicUser(viewer)),
            newsWatch,
            generatedAt: new Date().toISOString()
          });
        }
        return sendJson(res, 200, {
          ...deathPool.getOverview(users.publicUser(viewer)),
          newsWatch,
          generatedAt: new Date().toISOString()
        });
      } catch (err) {
        return sendJson(res, err.status || 500, {
          ok: false,
          error: err.message || 'Death pool unavailable'
        });
      }
    }

    if (pathname === '/api/custom-pools' && req.method === 'GET') {
      const viewer = requireLoungeMember(req, res);
      if (!viewer) return;
      try {
        const poolId = requestUrl.searchParams.get('poolId');
        if (poolId) {
          return sendJson(res, 200, {
            ...customPools.getPool(poolId, users.publicUser(viewer)),
            generatedAt: new Date().toISOString()
          });
        }
        return sendJson(res, 200, {
          ...customPools.getOverview(users.publicUser(viewer)),
          generatedAt: new Date().toISOString()
        });
      } catch (err) {
        return sendJson(res, err.status || 500, {
          ok: false,
          error: err.message || 'Custom pools unavailable'
        });
      }
    }

    if (pathname === '/api/custom-pools' && req.method === 'POST') {
      const user = requireLoungeMember(req, res);
      if (!user) return;
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      try {
        return sendJson(res, 200, customPools.handleAction(users.publicUser(user), body));
      } catch (err) {
        return sendJson(res, err.status || 400, {
          ok: false,
          error: err.message || 'Pool action failed'
        });
      }
    }

    if (pathname === '/api/death-pool' && req.method === 'POST') {
      const user = requireLoungeMember(req, res);
      if (!user) return;
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      try {
        const publicAuthor = users.publicUser(user);
        const action = String(body.action || '').toLowerCase();
        if (action === 'scan_news' || action === 'refresh_news') {
          const result = await deathPoolNews.runDeathNewsScan({ force: true });
          return sendJson(res, 200, {
            ...deathPool.getOverview(publicAuthor),
            ok: true,
            skipped: result.skipped,
            added: result.added,
            poolHitCount: result.poolHitCount,
            newsWatch: result.newsWatch
          });
        }
        if (action === 'create') {
          return sendJson(res, 200, deathPool.createPool(publicAuthor, body));
        }
        if (action === 'join') {
          return sendJson(res, 200, deathPool.joinPool(publicAuthor, body.poolId));
        }
        if (action === 'assign' || action === 'assign_member') {
          return sendJson(res, 200, deathPool.assignMember(publicAuthor, body));
        }
        if (action === 'import' || action === 'import_noms') {
          return sendJson(res, 200, deathPool.importNoms(publicAuthor, body));
        }
        if (action === 'nominate' || action === 'draft_pick' || action === 'pick') {
          return sendJson(res, 200, deathPool.nominate(publicAuthor, body));
        }
        if (action === 'bid') {
          return sendJson(res, 200, deathPool.placeBid(publicAuthor, body));
        }
        if (action === 'deceased' || action === 'mark_deceased') {
          return sendJson(res, 200, deathPool.markDeceased(publicAuthor, body));
        }
        if (action === 'set_draft_order' || action === 'draft_order') {
          return sendJson(res, 200, deathPool.setDraftOrder(publicAuthor, body));
        }
        if (action === 'start_draft') {
          return sendJson(res, 200, deathPool.startDraft(publicAuthor, body));
        }
        if (action === 'end_draft') {
          return sendJson(res, 200, deathPool.endDraft(publicAuthor, body));
        }
        if (action === 'update_settings' || action === 'settings') {
          return sendJson(res, 200, deathPool.updatePoolSettings(publicAuthor, body));
        }
        if (action === 'delete') {
          return sendJson(res, 200, deathPool.deletePool(publicAuthor, body.poolId));
        }
        return sendJson(res, 400, { ok: false, error: 'Unknown death pool action' });
      } catch (err) {
        return sendJson(res, err.status || 400, {
          ok: false,
          error: err.message || 'Death pool action failed'
        });
      }
    }

    if (pathname === '/api/paper-book' && req.method === 'GET') {
      const viewer = requireLoungeMember(req, res);
      if (!viewer) return;
      try {
        const openLegs = paperBook.listOpenUngradedLegs();
        const boards = await sportsScoreboard.getSettlementBoards({ openLegs });
        const book = paperBook.getBook(users.publicUser(viewer), boards);
        const futuresBoard = await futuresMarkets.getFuturesBoard().catch(() => ({
          ok: false,
          markets: [],
          errors: [{ error: 'Futures unavailable' }]
        }));
        const fantasyIds = sportsScoreboard.FANTASY_LEAGUE_IDS || new Set();
        const ticketBoard = boards
          .filter((b) => {
            if (b.ok === false) return false;
            if (b.fantasy) return false;
            const id = String(b.id || '').toLowerCase();
            if (fantasyIds.has(id)) return false;
            return true;
          })
          .map((b) => ({
            id: b.id,
            label: b.label,
            logo: b.logo || null,
            kind: b.kind || 'team',
            games: (b.games || [])
              .filter((g) => g.status?.bucket !== 'final')
              .sort((a, b) => {
                const ao = a.odds || (a.leaders && a.leaders.length) ? 0 : 1;
                const bo = b.odds || (b.leaders && b.leaders.length) ? 0 : 1;
                if (ao !== bo) return ao - bo;
                const order = { live: 0, upcoming: 1, final: 2 };
                const as = order[a.status?.bucket] ?? 3;
                const bs = order[b.status?.bucket] ?? 3;
                if (as !== bs) return as - bs;
                return String(a.date || '').localeCompare(String(b.date || ''));
              })
              .slice(0, 80)
              .map((g) => ({
                id: g.id,
                date: g.date,
                status: g.status,
                kind: g.kind || b.kind || 'team',
                name: g.name,
                shortName: g.shortName,
                away: g.away,
                home: g.home,
                odds: g.odds,
                leaders: Array.isArray(g.leaders)
                  ? g.leaders.slice(0, (b.kind === 'golf' || b.kind === 'racing' || g.kind === 'golf' || g.kind === 'racing') ? 40 : 20)
                  : undefined,
                broadcasts: g.broadcasts || []
              }))
          }))
          .filter((b) => b.games.length);
        return sendJson(res, 200, {
          ...book,
          boards: ticketBoard,
          futures: futuresBoard,
          generatedAt: new Date().toISOString()
        });
      } catch (err) {
        return sendJson(res, err.status || 500, {
          ok: false,
          error: err.message || 'Sportsbook unavailable'
        });
      }
    }

    if (pathname === '/api/paper-book' && req.method === 'POST') {
      const user = requireLoungeMember(req, res);
      if (!user) return;
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      try {
        const publicAuthor = users.publicUser(user);
        const action = String(body.action || 'bet').toLowerCase();
        if (action === 'ack-settled' || action === 'ack-settlements') {
          const result = paperBook.ackSettlements(publicAuthor, body.ids);
          return sendJson(res, 200, result);
        }
        const openLegs = paperBook.listOpenUngradedLegs();
        const boards = await sportsScoreboard.getSettlementBoards({ openLegs });

        if (action === 'draft' || action === 'slip') {
          const book = paperBook.saveDraft(publicAuthor, body);
          return sendJson(res, 200, book);
        }

        if (action === 'future') {
          paperBook.settleOpenSlips(boards);
          const futuresBoard = await futuresMarkets.getFuturesBoard();
          const book = paperBook.placeFuture(publicAuthor, body, futuresBoard);
          if (book.placedFuture) {
            try {
              const chatPayload = paperBook.formatSlipChat(book.placedFuture);
              if (chatPayload) {
                membersChat.addMessage({
                  body: chatPayload.body,
                  author: publicAuthor,
                  kind: 'bet',
                  meta: chatPayload.meta,
                  skipRateLimit: true
                });
              }
            } catch { /* don't fail the pick if chat announce fails */ }
          }
          return sendJson(res, 200, {
            ...book,
            futures: futuresBoard
          });
        }

        if (action === 'bet') {
          // placeBet deducts stake from Funds immediately, then settleOpenSlips grades any finals.
          const book = paperBook.placeBet(publicAuthor, body, boards);
          if (book.placedSlip) {
            try {
              const chatPayload = paperBook.formatSlipChat(book.placedSlip);
              if (chatPayload) {
                membersChat.addMessage({
                  body: chatPayload.body,
                  author: publicAuthor,
                  kind: 'bet',
                  meta: chatPayload.meta,
                  skipRateLimit: true
                });
              }
            } catch {
              /* don't fail the bet if chat announce fails */
            }
          }
          return sendJson(res, 200, book);
        }
        return sendJson(res, 400, { ok: false, error: 'Unknown sportsbook action' });
      } catch (err) {
        return sendJson(res, err.status || 400, {
          ok: false,
          error: err.message || 'Bet failed'
        });
      }
    }

    if (pathname === '/api/mock-draft' && req.method === 'GET') {
      const user = requireLoungeMember(req, res);
      if (!user) return;
      const roomId = String(requestUrl.searchParams.get('roomId') || '').trim();
      try {
        if (roomId) {
          let room = mockDraftRooms.getRoom(roomId);
          if (!room) return sendJson(res, 404, { ok: false, error: 'Mock draft not found' });
          const roomPool = (await nflverseDraft.loadDraftPool(draftPoolOpts(room))).players || [];
          if (mockDraftRooms.advanceRoom(room, roomPool)) {
            room = mockDraftRooms.saveRoom(room);
          }
          return sendJson(res, 200, {
            ok: true,
            room: mockDraftRooms.publicRoom(room, user.id),
            generatedAt: new Date().toISOString()
          });
        }
        const rooms = [];
        for (const r of mockDraftRooms.listActiveRooms()) {
          const roomPool = (await nflverseDraft.loadDraftPool(draftPoolOpts(r))).players || [];
          mockDraftRooms.advanceRoom(r, roomPool);
          mockDraftRooms.saveRoom(r);
          rooms.push(mockDraftRooms.publicRoom(r, user.id));
        }
        return sendJson(res, 200, { ok: true, rooms, generatedAt: new Date().toISOString() });
      } catch (err) {
        return sendJson(res, err.status || 500, { ok: false, error: err.message || 'Could not load mock draft' });
      }
    }

    if (pathname === '/api/mock-draft' && req.method === 'POST') {
      const user = requireLoungeMember(req, res);
      if (!user) return;
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      const action = String(body.action || '').trim().toLowerCase();
      const publicAuthor = users.publicUser(user);
      try {
        async function poolFor(roomLike) {
          const payload = await nflverseDraft.loadDraftPool(draftPoolOpts(roomLike || {
            scoring: body.scoring,
            teamCount: body.teamCount
          }));
          return payload.players || [];
        }

        if (action === 'create') {
          const room = mockDraftRooms.createRoom({
            user: publicAuthor,
            teamCount: body.teamCount,
            rounds: body.rounds,
            scoring: body.scoring,
            pickSeconds: body.pickSeconds,
            seatIndex: body.seatIndex,
            teamNames: body.teamNames,
            hostTeamName: fantasyTeamNameForUser(user) || body.hostTeamName || null
          });
          const pub = mockDraftRooms.publicRoom(room, user.id);
          let chatItem = null;
          try {
            chatItem = membersChat.addMessage({
              body: 'opened a mock draft lobby · join before the host starts',
              author: publicAuthor,
              kind: 'mock',
              meta: {
                type: 'mock_start',
                roomId: room.id,
                teams: room.teamCount,
                rounds: room.rounds,
                pickSeconds: room.pickSeconds,
                pickDeadline: room.pickDeadline,
                lobbyEndsAt: room.lobbyEndsAt,
                order: 'snake',
                seat: room.teamNames[room.seats.find((s) => s.userId === user.id)?.index] || null,
                openSeats: room.seats.filter((s) => !s.userId).length,
                status: room.status,
                link: `/members.html#mock-draft?room=${encodeURIComponent(room.id)}`,
                linkLabel: 'Join Mock Draft'
              },
              skipRateLimit: true
            });
          } catch { /* best-effort */ }
          return sendJson(res, 201, { ok: true, room: pub, chatItem });
        }

        if (action === 'start') {
          const existing = mockDraftRooms.getRoom(body.roomId);
          const pool = await poolFor(existing);
          const room = mockDraftRooms.startDraft({
            roomId: body.roomId,
            user: publicAuthor,
            pool
          });
          const pub = mockDraftRooms.publicRoom(room, user.id);
          let chatItem = null;
          try {
            chatItem = membersChat.addMessage({
              body: 'started the mock draft',
              author: publicAuthor,
              kind: 'mock',
              meta: {
                type: 'mock_live',
                roomId: room.id,
                teams: room.teamCount,
                rounds: room.rounds,
                pickSeconds: room.pickSeconds,
                pickDeadline: room.pickDeadline,
                status: room.status,
                link: `/members.html#mock-draft?room=${encodeURIComponent(room.id)}`,
                linkLabel: 'Open Mock Draft'
              },
              skipRateLimit: true
            });
          } catch { /* best-effort */ }
          return sendJson(res, 200, { ok: true, room: pub, chatItem });
        }

        if (action === 'lock-positions') {
          const room = mockDraftRooms.lockPositions({
            roomId: body.roomId,
            user: publicAuthor
          });
          return sendJson(res, 200, { ok: true, room: mockDraftRooms.publicRoom(room, user.id) });
        }

        if (action === 'skip-join-window') {
          const room = mockDraftRooms.skipJoinWindow({
            roomId: body.roomId,
            user: publicAuthor
          });
          return sendJson(res, 200, { ok: true, room: mockDraftRooms.publicRoom(room, user.id) });
        }

        if (action === 'move-seat') {
          const room = mockDraftRooms.moveSeat({
            roomId: body.roomId,
            user: publicAuthor,
            toIndex: body.seatIndex
          });
          return sendJson(res, 200, { ok: true, room: mockDraftRooms.publicRoom(room, user.id) });
        }

        if (action === 'join') {
          const teamName = fantasyTeamNameForUser(user) || body.teamName || null;
          let room = body.seatIndex != null
            ? mockDraftRooms.joinSeat({
                roomId: body.roomId,
                user: publicAuthor,
                seatIndex: body.seatIndex,
                teamName
              })
            : mockDraftRooms.claimOpenSeat({
                roomId: body.roomId,
                user: publicAuthor,
                teamName
              });
          mockDraftRooms.advanceRoom(room, await poolFor(room));
          room = mockDraftRooms.saveRoom(room);
          return sendJson(res, 200, { ok: true, room: mockDraftRooms.publicRoom(room, user.id) });
        }

        if (action === 'pick') {
          const existing = mockDraftRooms.getRoom(body.roomId);
          const room = mockDraftRooms.humanPick({
            roomId: body.roomId,
            user: publicAuthor,
            playerId: body.playerId,
            pool: await poolFor(existing)
          });
          return sendJson(res, 200, { ok: true, room: mockDraftRooms.publicRoom(room, user.id) });
        }

        if (action === 'tick') {
          let room = mockDraftRooms.getRoom(body.roomId);
          if (!room) return sendJson(res, 404, { ok: false, error: 'Mock draft not found' });
          if (mockDraftRooms.advanceRoom(room, await poolFor(room))) room = mockDraftRooms.saveRoom(room);
          return sendJson(res, 200, { ok: true, room: mockDraftRooms.publicRoom(room, user.id) });
        }

        if (action === 'chat') {
          const { room } = mockDraftRooms.addChatMessage({
            roomId: body.roomId,
            user: publicAuthor,
            body: body.body || body.message
          });
          return sendJson(res, 200, { ok: true, room: mockDraftRooms.publicRoom(room, user.id) });
        }

        return sendJson(res, 400, { ok: false, error: 'Unknown mock draft action' });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Mock draft action failed' });
      }
    }

    if (pathname === '/api/beta/draft-pool' && req.method === 'GET') {
      try {
        const season = requestUrl.searchParams.get('season');
        const activeOnly = requestUrl.searchParams.get('activeOnly') !== '0';
        const refresh = String(requestUrl.searchParams.get('refresh') || requestUrl.searchParams.get('force') || '') === '1';
        const payload = await nflverseDraft.loadDraftPool({
          season,
          activeOnly,
          force: refresh,
          scoring: requestUrl.searchParams.get('scoring'),
          teams: requestUrl.searchParams.get('teams')
        });
        return sendJson(res, 200, payload);
      } catch (err) {
        return sendJson(res, err.status || 502, {
          ok: false,
          error: err.message || 'Draft pool unavailable'
        });
      }
    }

    if (pathname === '/api/beta/player-news' && req.method === 'GET') {
      try {
        const payload = await nflverseDraft.getPlayerNews({
          espnId: requestUrl.searchParams.get('espnId'),
          sleeperId: requestUrl.searchParams.get('sleeperId'),
          name: requestUrl.searchParams.get('name'),
          limit: requestUrl.searchParams.get('limit')
        });
        return sendJson(res, 200, payload);
      } catch (err) {
        return sendJson(res, err.status || 502, {
          ok: false,
          error: err.message || 'Player news unavailable',
          items: []
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
      syncPendingInboxDigests(user);
      return sendJson(res, 200, {
        ok: true,
        online: presence.listOnline(),
        unread: scopedInboxForUser(user, req).unread,
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
      const viewer = requireLoungeMember(req, res);
      if (!viewer) return;
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
      const user = requireLoungeMember(req, res);
      if (!user) return;
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const publicAuthor = users.publicUser(user);
        presence.touch(publicAuthor);
        const postType = String(body.type || body.kind || 'chat').toLowerCase();
        let item;
        if (postType === 'mock_start' || postType === 'mock') {
          const teams = Math.max(2, Math.min(16, Number(body.teams) || 12));
          const rounds = Math.max(1, Math.min(20, Number(body.rounds) || 15));
          const pickSeconds = mockDraftRooms.clampPickSeconds(body.pickSeconds || 60);
          const firstPick = String(body.firstPick || '').trim().slice(0, 80);
          const firstPos = String(body.firstPos || '').trim().slice(0, 8);
          const seat = String(body.seatName || '').trim().slice(0, 60);
          const roomId = String(body.roomId || '').trim() || null;
          const bits = [`${teams} teams`, `${rounds} rounds`, 'snake', `${Math.round(pickSeconds / 60)}:00 clock`];
          if (seat) bits.push(`seat ${seat}`);
          item = membersChat.addMessage({
            body: firstPick
              ? `kicked off a mock draft — first pick ${firstPick}${firstPos ? ` (${firstPos})` : ''}`
              : 'kicked off a mock draft',
            author: publicAuthor,
            kind: 'mock',
            meta: {
              type: 'mock_start',
              roomId,
              teams,
              rounds,
              pickSeconds,
              pickDeadline: body.pickDeadline || null,
              order: 'snake',
              firstPick: firstPick || null,
              firstPos: firstPos || null,
              seat: seat || null,
              openSeats: body.openSeats != null ? Number(body.openSeats) : null,
              status: body.status || 'live',
              link: roomId
                ? `/members.html#mock-draft?room=${encodeURIComponent(roomId)}`
                : '/members.html#mock-draft',
              linkLabel: roomId ? 'Join Mock Draft' : 'Open Mock Draft'
            },
            skipRateLimit: true
          });
        } else {
          item = membersChat.addMessage({
            body: body.body,
            author: publicAuthor
          });
        }
        const directory = users.listLeagueMembers().members;
        const mentioned = postType === 'mock_start' || postType === 'mock'
          ? []
          : membersChat.resolveMentionedUsers(item.body, {
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
      const user = requireLoungeMember(req, res);
      if (!user) return;
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

    if (pathname === '/api/lounge/fresh-start' && req.method === 'POST') {
      const cronOk = authorizeCron(req);
      const admin = cronOk ? null : requireCommissioner(req, res);
      if (!cronOk && !admin) return;
      try {
        const chat = membersChat.clearAllMessages();
        const book = paperBook.resetBook();
        return sendJson(res, 200, {
          ok: true,
          chat,
          book,
          message: 'Lounge chat and sportsbook reset'
        });
      } catch (err) {
        return sendJson(res, err.status || 500, {
          ok: false,
          error: err.message || 'Could not reset lounge'
        });
      }
    }

    if (pathname === '/api/members' && req.method === 'GET') {
      const viewer = requireLoungeMember(req, res);
      if (!viewer) return;
      try {
        const roster = users.listLeagueMembers();
        const giBuyIn = Number(config.payouts?.buyInPerTeam || 100);
        const aaaBuyIn = Number(getAffiliatedLeague('aaa')?.payouts?.buyInPerTeam || 50);
        const treasurer = {
          name: config.treasurer?.name || 'Jamie Aceto',
          email: config.treasurer?.email || 'jaceto53@gmail.com',
          venmoUsername: config.treasurer?.venmoUsername || 'James-Aceto',
          note: config.treasurer?.note || 'League dues — GridIron 24 HQ'
        };
        const canManage = users.isCommissioner(viewer) || users.isSiteOwner(viewer);
        const claimByUser = new Map(logos.listClaims().map((c) => [c.userId, c]));
        const confMeta = new Map(
          listAdminLeagues().map((l) => [String(l.key).toLowerCase(), {
            key: l.key,
            name: l.shortName || l.name,
            logo: l.logo || null
          }])
        );
        const decorateMember = (m) => {
          if (!m) return m;
          const claim = claimByUser.get(m.id);
          const membership = String(m.membershipLeague || '').toLowerCase();
          let conferenceKey = null;
          let conferenceLogo = null;
          let conferenceLabel = null;
          if (m.siteOwner) {
            conferenceKey = 'brand';
            conferenceLogo = '/assets/gridiron24-brand.png?v=3';
            conferenceLabel = 'GridIron 24';
          } else if (claim?.conferenceKey) {
            const conf = confMeta.get(String(claim.conferenceKey).toLowerCase());
            conferenceKey = String(claim.conferenceKey).toLowerCase();
            conferenceLogo = conf?.logo || null;
            conferenceLabel = conf?.name || claim.conferenceKey;
          } else if (membership === 'aaa') {
            const conf = confMeta.get('aaa');
            conferenceKey = 'aaa';
            conferenceLogo = conf?.logo || '/assets/aaa-league.png?v=7';
            conferenceLabel = conf?.name || 'AAA';
          } else if (membership === 'gridiron') {
            conferenceKey = 'gridiron';
            conferenceLogo = '/assets/gridiron24-league-sm.png?v=8';
            conferenceLabel = 'GridIron 24';
          }
          const display = claim
            ? (logos.getDisplayName(claim.conferenceKey, claim.teamId)?.displayName || claim.teamName || null)
            : null;
          const avatar = logos.resolveLogoForUser(m.id);
          const avatarUrl = (avatar?.type === 'icon' || avatar?.type === 'upload') ? avatar.url : null;
          return {
            ...m,
            conferenceKey,
            conferenceLogo,
            conferenceLabel,
            teamName: display,
            avatarUrl
          };
        };
        const decorateList = (list) => (Array.isArray(list) ? list.map(decorateMember) : []);
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
          gridiron: decorateList(roster.gridiron),
          aaa: decorateList(roster.aaa),
          members: decorateList(roster.members || []),
          unassigned: canManage ? decorateList(roster.unassigned) : [],
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

    if (pathname === '/api/site-hq' && req.method === 'GET') {
      const owner = requireSiteOwner(req, res);
      if (!owner) return;
      return sendJson(res, 200, buildSiteHqPayload(owner));
    }

    if (pathname === '/api/site-hq/users' && req.method === 'POST') {
      const owner = requireSiteOwner(req, res);
      if (!owner) return;
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const accessRaw = String(body.access || body.role || 'user').trim();
        let role = 'user';
        let roleConference = null;
        if (accessRaw.startsWith('conference_admin:')) {
          role = 'conference_admin';
          roleConference = accessRaw.slice('conference_admin:'.length);
        } else if (accessRaw === 'viewer' || accessRaw === 'view_only' || accessRaw === 'readonly') {
          role = 'viewer';
        } else if (accessRaw === 'commissioner' || accessRaw === 'conference_admin') {
          role = accessRaw;
          roleConference = String(body.roleConference || body.adminConference || '').trim() || null;
        }
        const membership = role === 'viewer'
          ? 'gridiron'
          : String(body.membership || body.kind || 'gridiron').trim();
        const placement = users.parseMembershipPlacement(membership);
        const social = placement.kind === 'social';
        if (social && role !== 'user') {
          throw Object.assign(new Error('Staff access cannot be a social (lounge-only) account'), { status: 400 });
        }
        let user = users.createUser({
          name: body.name,
          email: body.email,
          loginName: body.loginName,
          password: body.password,
          role,
          conference: roleConference,
          approved: true,
          loungeMember: true,
          loungeOnly: social
        });
        try {
          if (role !== 'viewer') {
            user = applyStaffPlacement(user.id, membership, owner);
            const conference = String(body.conference || body.hqConference || '').trim();
            if (placement.kind === 'gridiron' && conference && role === 'user') {
              user = users.setLeagueMembership(user.id, { hqConference: conference });
            }
            if (body.duesPaid === true && (placement.kind === 'gridiron' || placement.kind === 'aaa')) {
              user = users.setLeagueMembership(user.id, { duesPaid: true });
            }
          }
          user = grantLoungeAdmission(user.id, owner.id);
        } catch (assignErr) {
          return sendJson(res, 201, {
            ok: true,
            user,
            membershipKind: users.membershipKindOf(user),
            hq: buildSiteHqPayload(owner),
            warning: assignErr.message || 'Account created, but membership could not be assigned.',
            message: `${user.loginName} can sign in. ${assignErr.message || 'Membership was not assigned.'}`
          });
        }
        deliverWelcomeInboxIfNeeded(user);
        return sendJson(res, 201, {
          ok: true,
          user,
          membershipKind: users.membershipKindOf(user),
          hq: buildSiteHqPayload(owner),
          message: `${user.loginName} can sign in now.`
        });
      } catch (err) {
        return sendJson(res, err.status || 400, {
          ok: false,
          error: err.message || 'Could not create account'
        });
      }
    }

    {
      const manage = pathname.match(/^\/api\/site-hq\/leagues\/([^/]+)\/(renew|archive|restore|delete)$/);
      if (manage && req.method === 'POST') {
        const owner = requireSiteOwner(req, res);
        if (!owner) return;
        const leagueId = decodeURIComponent(manage[1]);
        const action = manage[2];
        let body = {};
        try { body = await readJsonBody(req); } catch { body = {}; }
        try {
          let league;
          if (action === 'renew') {
            league = leagues.renewIndependentLeague(leagueId, { season: body.season });
            independentDraft.deleteRoomsForLeague(leagueId);
          } else if (action === 'archive') {
            league = leagues.archiveIndependentLeague(leagueId);
          } else if (action === 'restore') {
            league = leagues.restoreIndependentLeague(leagueId);
          } else {
            const existing = leagues.findById(leagueId);
            const expected = String(existing?.brand?.name || existing?.slug || '').trim();
            const typed = String(body.confirmName || body.name || '').trim();
            if (!expected || typed.toLowerCase() !== expected.toLowerCase()) {
              return sendJson(res, 400, {
                ok: false,
                error: `Type the league name (${expected || 'the league'}) to delete it`
              });
            }
            league = leagues.deleteIndependentLeague(leagueId);
            independentDraft.deleteRoomsForLeague(leagueId);
            invites.revokeInvitesForLeague(leagueId);
            users.detachUsersFromLeague(leagueId);
          }
          return sendJson(res, 200, {
            ok: true,
            action,
            league: {
              id: league.id,
              name: league.brand?.name || league.slug,
              slug: league.slug,
              status: league.status,
              season: league.season
            },
            hq: buildSiteHqPayload(owner)
          });
        } catch (err) {
          return sendJson(res, err.status || 400, {
            ok: false,
            error: err.message || 'Could not update league'
          });
        }
      }
    }

    {
      const manageUser = pathname.match(/^\/api\/site-hq\/users\/([^/]+)\/(delete|reset-email|password)$/);
      if (manageUser && req.method === 'POST') {
        const owner = requireSiteOwner(req, res);
        if (!owner) return;
        const userId = decodeURIComponent(manageUser[1]);
        const action = manageUser[2];
        let body = {};
        try { body = await readJsonBody(req); } catch { body = {}; }
        try {
          const target = users.findById(userId);
          if (!target) return sendJson(res, 404, { ok: false, error: 'Account not found' });
          if (action === 'delete') {
            const expected = String(target.loginName || target.email || target.name || '').trim();
            const typed = String(body.confirmName || body.loginName || '').trim();
            if (!expected || typed.toLowerCase() !== expected.toLowerCase()) {
              return sendJson(res, 400, {
                ok: false,
                error: `Type the login name (${expected || 'the account'}) to delete it`
              });
            }
            const removed = removeMemberAccount(userId, owner);
            syncPendingInboxDigests(owner, { force: true });
            return sendJson(res, 200, {
              ok: true,
              action,
              user: removed,
              hq: buildSiteHqPayload(owner)
            });
          }
          if (action === 'password') {
            const password = String(body.password || '');
            if (password.length < 6) {
              return sendJson(res, 400, { ok: false, error: 'Password must be at least 6 characters' });
            }
            const updated = users.adminSetCredentials(userId, { password });
            return sendJson(res, 200, {
              ok: true,
              action,
              user: { id: updated.id, name: updated.name, loginName: updated.loginName },
              hq: buildSiteHqPayload(owner)
            });
          }
          const created = users.createResetTokenForUser(userId);
          const resetUrl = `${requestOrigin(req)}/reset?token=${encodeURIComponent(created.token)}`;
          let sent = false;
          try {
            const mailResult = await sendPasswordResetEmail({
              to: created.user.email,
              name: created.user.name,
              resetUrl,
              baseUrl: requestOrigin(req)
            });
            sent = Boolean(mailResult.sent);
          } catch (mailErr) {
            console.error('[site-hq] reset email failed', mailErr.message || mailErr);
          }
          return sendJson(res, 200, {
            ok: true,
            action,
            sent,
            email: created.user.email,
            resetUrl,
            user: { id: created.user.id, name: created.user.name, loginName: created.user.loginName },
            message: sent
              ? `Reset email sent to ${created.user.email}.`
              : 'Mail did not send. Copy the reset link and give it to them.'
          });
        } catch (err) {
          return sendJson(res, err.status || 400, {
            ok: false,
            error: err.message || 'Could not update account'
          });
        }
      }
    }

    if (pathname === '/api/users/pending' && req.method === 'GET') {
      if (!requireCommissioner(req, res)) return;
      const pending = users.listUsers()
        .filter((u) => u.approved === false)
        .map((u) => users.publicUser(u));
      return sendJson(res, 200, { ok: true, users: pending, count: pending.length });
    }

    if (pathname === '/api/users' && req.method === 'GET') {
      const admin = requireStaff(req, res);
      if (!admin) return;
      const claims = logos.listClaims();
      const claimByUser = new Map(claims.map((c) => [c.userId, c]));
      const scope = staffConferenceScope(admin);
      const adminLeagues = listAdminLeagues().filter((conference) => !scope || conference.key === scope);
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

      try {
        users.syncHqConferenceFromClaims(claims);
      } catch { /* ignore */ }

      const listed = users.listUsers().filter((u) => userVisibleToStaff(admin, u));
      return sendJson(res, 200, {
        ok: true,
        scope: scope
          ? { kind: 'admin', conference: scope }
          : { kind: 'owner' },
        users: listed.map((u) => ({
          ...u,
          claim: claimByUser.get(u.id) || null,
          career: career.listForUser(u.id)
        })),
        independentLeagues: listStaffPlacementLeagues(),
        claims: claims.filter((c) => !scope || c.conferenceKey === scope),
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
      const admin = requireStaff(req, res);
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
        assertStaffCanManageUser(admin, target);

        if (body.clear || body.conferenceKey === '' || body.teamId === '' || body.teamId == null) {
          logos.unassignTeam(userId);
          return sendJson(res, 200, { ok: true, claim: null, user: users.publicUser(target) });
        }

        const conferenceKey = String(body.conferenceKey || '').trim();
        const scope = staffConferenceScope(admin);
        if (scope && conferenceKey !== scope) {
          return sendJson(res, 403, { ok: false, error: 'You can only assign franchises in your conference' });
        }
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
        if (conferenceKey === 'detail' || conferenceKey === 'overtime') {
          try {
            if (users.hqMembershipOf(target) !== 'gridiron') {
              users.setLeagueMembership(userId, { league: 'gridiron' });
            }
            users.setLeagueMembership(userId, { hqConference: conferenceKey });
          } catch (confErr) {
            try { logos.unassignTeam(userId); } catch { /* ignore */ }
            throw confErr;
          }
        }
        return sendJson(res, 200, { ok: true, claim, user: users.findById(userId) });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not assign team' });
      }
    }

    if (pathname.startsWith('/api/users/') && pathname.endsWith('/hq-conference') && req.method === 'POST') {
      const admin = requireCommissioner(req, res);
      if (!admin) return;
      const userId = pathname.slice('/api/users/'.length, -'/hq-conference'.length);
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      try {
        const target = users.findById(userId);
        if (!target) return sendJson(res, 404, { ok: false, error: 'User not found' });
        const raw = Object.prototype.hasOwnProperty.call(body, 'conference')
          ? body.conference
          : body.hqConference;
        const next = raw === '' || raw == null || body.clear ? null : String(raw).trim().toLowerCase();
        const claim = logos.getClaimForUser(userId);
        const claimConf = claim?.conferenceKey === 'detail' || claim?.conferenceKey === 'overtime'
          ? claim.conferenceKey
          : null;
        if (claimConf && claimConf !== next) {
          logos.unassignTeam(userId);
        }
        const updated = users.setLeagueMembership(userId, { hqConference: next });
        return sendJson(res, 200, {
          ok: true,
          user: updated,
          conference: updated.hqConference,
          conferenceLabel: users.hqConferenceLabel(updated.hqConference),
          claim: logos.getClaimForUser(userId)
        });
      } catch (err) {
        return sendJson(res, err.status || 400, {
          ok: false,
          error: err.message || 'Could not assign conference'
        });
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

    if (pathname.match(/^\/api\/users\/[^/]+\/profile$/) && req.method === 'GET') {
      const viewer = getSessionUser(req);
      if (!viewer) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      const userId = pathname.slice('/api/users/'.length, -'/profile'.length);
      const target = users.findById(userId);
      if (!target || target.approved === false) {
        return sendJson(res, 404, { ok: false, error: 'Member not found' });
      }
      try {
        return sendJson(res, 200, publicProfileCard(target, req));
      } catch (err) {
        return sendJson(res, err.status || 500, { ok: false, error: err.message || 'Could not load profile' });
      }
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

    if (pathname.startsWith('/api/users/') && pathname.endsWith('/credentials') && req.method === 'POST') {
      const admin = requireStaff(req, res);
      if (!admin) return;
      const userId = pathname.slice('/api/users/'.length, -'/credentials'.length);
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        assertStaffCanManageUser(admin, users.findById(userId));
        const updated = users.adminSetCredentials(userId, {
          loginName: body.loginName,
          password: body.password
        });
        return sendJson(res, 200, { ok: true, user: updated });
      } catch (err) {
        return sendJson(res, err.status || 400, {
          ok: false,
          error: err.message || 'Could not update login'
        });
      }
    }

    if (pathname.startsWith('/api/users/') && pathname.endsWith('/lounge-only') && req.method === 'POST') {
      const admin = requireCommissioner(req, res);
      if (!admin) return;
      const userId = pathname.slice('/api/users/'.length, -'/lounge-only'.length);
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      try {
        const updated = users.setLoungeOnly(userId, Boolean(body.loungeOnly), admin.id);
        if (updated.loungeOnly) {
          try { logos.unassignTeam(userId); } catch { /* may have no team */ }
        }
        return sendJson(res, 200, { ok: true, user: updated });
      } catch (err) {
        return sendJson(res, err.status || 400, {
          ok: false,
          error: err.message || 'Could not update social access'
        });
      }
    }

    if (pathname.startsWith('/api/users/') && pathname.endsWith('/lounge-token') && req.method === 'POST') {
      const admin = requireCommissioner(req, res);
      if (!admin) return;
      const userId = pathname.slice('/api/users/'.length, -'/lounge-token'.length);
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      try {
        const result = users.setLoungeToken(userId, body.granted !== false && body.loungeToken !== false, admin.id);
        let inboxMessage = null;
        let bankroll = null;
        if (result.changed && result.granted) {
          try {
            bankroll = paperBook.grantLoungeBankroll(result.user);
          } catch (err) {
            console.error('[lounge-token] bankroll seed failed', err);
          }
          try {
            const cash = Number(bankroll?.bankroll ?? paperBook.STARTING_BANKROLL);
            const cashLabel = cash.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
            inboxMessage = inbox.sendMessage({
              toUserId: result.user.id,
              from: users.publicUser(admin),
              subject: 'Members Lounge access granted',
              body: [
                `Hey ${result.user.name || result.user.loginName || 'there'},`,
                '',
                'You’ve been given a Members Lounge pass.',
                `Casala’s Palace is ready — you start with ${cashLabel} in fun money. Every ticket stakes cash and counts on the board.`,
                'Head in for the sports board, Roll Call, paper games, and the dues desk.',
                '',
                'Open the lounge anytime from the site nav (or your home path if you’re a social account).'
              ].join('\n'),
              type: 'lounge_token',
              meta: {
                link: '/members.html',
                linkLabel: 'Open Members Lounge',
                loungeToken: true,
                startingBankroll: cash
              }
            });
          } catch (err) {
            console.error('[lounge-token] inbox notify failed', err);
          }
        }
        return sendJson(res, 200, {
          ok: true,
          user: result.user,
          granted: result.granted,
          changed: result.changed,
          notified: Boolean(inboxMessage),
          inboxMessage,
          bankroll: bankroll ? {
            funded: Boolean(bankroll.funded),
            amount: bankroll.bankroll
          } : null
        });
      } catch (err) {
        return sendJson(res, err.status || 400, {
          ok: false,
          error: err.message || 'Could not update lounge token'
        });
      }
    }

    if (pathname.startsWith('/api/users/') && pathname.endsWith('/membership') && req.method === 'POST') {
      const admin = requireCommissioner(req, res);
      if (!admin) return;
      const userId = pathname.slice('/api/users/'.length, -'/membership'.length);
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      try {
        const before = users.findById(userId);
        const updated = applyStaffPlacement(userId, body.membership || body.kind, admin);
        const kind = users.membershipKindOf(updated);
        const leagueName = kind === 'independent'
          ? placementLeagueName(updated.leagueId)
          : (kind === 'aaa'
            ? (getAffiliatedLeague('aaa')?.brand?.name || 'AAA League')
            : config.brand.name);
        let mail = { sent: false, method: 'none' };
        const shouldWelcome = Boolean(before)
          && before.approved !== false
          && updated?.email
          && !before.welcomeMailSentAt;
        if (shouldWelcome) {
          try {
            mail = await sendAccountApprovedEmail({
              to: updated.email,
              name: updated.name || updated.loginName,
              leagueName,
              baseUrl: requestOrigin(req),
              membershipKind: kind,
              hqPath: kind === 'independent' && updated.leagueId
                ? leagues.independentHomePath(leagues.findById(updated.leagueId))
                : undefined
            });
            if (mail.sent) {
              try { users.markWelcomeMailSent(userId); } catch { /* ignore */ }
            }
            deliverWelcomeInboxIfNeeded(updated);
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
          membershipKind: kind,
          membershipLabel: users.membershipKindLabel(kind, leagueName),
          mailSent: Boolean(mail.sent),
          mailMethod: mail.method || null,
          mailError: mail.error || null
        });
      } catch (err) {
        return sendJson(res, err.status || 400, {
          ok: false,
          error: err.message || 'Could not update membership'
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
        const hasMembership = Object.prototype.hasOwnProperty.call(body, 'membership')
          || Object.prototype.hasOwnProperty.call(body, 'kind');
        const membershipRaw = body.membership || body.kind
          || (before?.loungeOnly ? 'social' : before?.membershipLeague);
        let updated = users.setUserApproved(userId, body.approved !== false, admin.id, {});
        let placementWarning = null;
        if (body.approved !== false && hasMembership) {
          try {
            updated = applyStaffPlacement(userId, membershipRaw, admin);
          } catch (placeErr) {
            placementWarning = placeErr.message || 'Membership could not be assigned.';
            if (updated.loungeOnly) {
              try { logos.unassignTeam(userId); } catch { /* ignore */ }
            }
          }
        } else if (updated.loungeOnly) {
          try { logos.unassignTeam(userId); } catch { /* ignore */ }
        }
        grantLoungeAdmission(userId, admin.id);
        updated = users.publicUser(users.findById(userId));
        let mail = { sent: false, method: 'none' };
        if (newlyApproved && hasMembership && updated.email) {
          try {
            const kind = users.membershipKindOf(updated);
            const leagueName = kind === 'independent'
              ? placementLeagueName(updated.leagueId)
              : (kind === 'aaa'
                ? (getAffiliatedLeague('aaa')?.brand?.name || 'AAA League')
                : config.brand.name);
            mail = await sendAccountApprovedEmail({
              to: updated.email,
              name: updated.name || updated.loginName,
              leagueName,
              baseUrl: requestOrigin(req),
              membershipKind: kind,
              hqPath: kind === 'independent' && updated.leagueId
                ? leagues.independentHomePath(leagues.findById(updated.leagueId))
                : undefined
            });
            if (mail.sent) {
              try { users.markWelcomeMailSent(userId); } catch { /* ignore */ }
            }
            deliverWelcomeInboxIfNeeded(updated);
          } catch (mailErr) {
            mail = {
              sent: false,
              method: 'error',
              error: mailErr.message || 'Email send failed'
            };
          }
        }
        syncPendingInboxDigests(admin, { force: true });
        const kind = users.membershipKindOf(updated);
        return sendJson(res, 200, {
          ok: true,
          user: updated,
          membershipKind: kind,
          membershipLabel: users.membershipKindLabel(kind, placementLeagueName(updated.leagueId)),
          warning: placementWarning || undefined,
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
        const removed = removeMemberAccount(userId, admin);
        syncPendingInboxDigests(admin, { force: true });
        return sendJson(res, 200, { ok: true, user: removed });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not reject account' });
      }
    }

    if (pathname.startsWith('/api/users/') && pathname.endsWith('/remove') && req.method === 'POST') {
      const admin = requireCommissioner(req, res);
      if (!admin) return;
      const userId = pathname.slice('/api/users/'.length, -'/remove'.length);
      try {
        const removed = removeMemberAccount(userId, admin);
        syncPendingInboxDigests(admin, { force: true });
        return sendJson(res, 200, { ok: true, user: removed });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not delete account' });
      }
    }

    if (pathname.startsWith('/api/users/') && pathname.endsWith('/delete') && req.method === 'POST') {
      const admin = requireCommissioner(req, res);
      if (!admin) return;
      const userId = pathname.slice('/api/users/'.length, -'/delete'.length);
      try {
        const removed = removeMemberAccount(userId, admin);
        syncPendingInboxDigests(admin, { force: true });
        return sendJson(res, 200, { ok: true, user: removed });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not delete account' });
      }
    }

    if (pathname === '/api/docs/pwa-install' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, guide: pwaInstallGuide });
    }

    if (pathname === '/api/mail/preview-pwa-install' && req.method === 'GET') {
      if (!requireStaff(req, res)) return;
      const content = buildPwaInstallEmail({
        recipientName: 'Alex Manager',
        fromName: 'League HQ',
        baseUrl: requestOrigin(req)
      });
      const format = String(requestUrl.searchParams.get('format') || 'html').toLowerCase();
      if (format === 'json') {
        return sendJson(res, 200, {
          ok: true,
          subject: content.subject,
          text: content.text,
          html: content.html,
          guideUrl: content.guideUrl,
          pdfUrl: content.pdfUrl
        });
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      return res.end(content.html);
    }

    if (pathname === '/api/comms/send-pwa-install' && req.method === 'POST') {
      const admin = requireCommissioner(req, res);
      if (!admin) return;
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
          const member = users.findByEmail(email);
          const mailResult = await sendPwaInstallEmail({
            to: email,
            recipientName: member?.name || member?.loginName || email.split('@')[0],
            fromName: admin.name || admin.loginName || 'League HQ',
            baseUrl: requestOrigin(req)
          });
          results.push({
            ok: !mailResult.skipped,
            email,
            sent: Boolean(mailResult.sent),
            method: mailResult.method,
            skipped: Boolean(mailResult.skipped),
            guideUrl: mailResult.guideUrl || null,
            pdfUrl: mailResult.pdfUrl || null
          });
        } catch (err) {
          results.push({ ok: false, email, error: err.message || 'Send failed' });
        }
      }
      const sentCount = results.filter((r) => r.sent).length;
      const okCount = results.filter((r) => r.ok).length;
      return sendJson(res, 200, {
        ok: okCount > 0,
        results,
        mail: mailConfig(),
        message: sentCount
          ? `Sent install guide to ${sentCount} address${sentCount === 1 ? '' : 'es'}.`
          : okCount
            ? 'Guide prepared (email delivery offline — share the PDF or /install-app.html link).'
            : 'No guides were sent.'
      });
    }

    if (pathname === '/api/comms' && req.method === 'GET') {
      if (!requireSiteOwner(req, res)) return;
      return sendJson(res, 200, { ok: true, ...commsSettings.publicSnapshot() });
    }

    if (pathname === '/api/comms/brand' && req.method === 'POST') {
      if (!requireSiteOwner(req, res)) return;
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const brand = commsSettings.updateBrand(body || {});
        return sendJson(res, 200, { ok: true, brand });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not save brand' });
      }
    }

    if (pathname.startsWith('/api/comms/') && pathname.endsWith('/reset') && req.method === 'POST') {
      if (!requireSiteOwner(req, res)) return;
      const id = pathname.slice('/api/comms/'.length, -'/reset'.length);
      try {
        const item = commsSettings.resetItem(id);
        return sendJson(res, 200, { ok: true, id, item });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not reset' });
      }
    }

    if (pathname.startsWith('/api/comms/') && pathname.endsWith('/defaults') && req.method === 'GET') {
      if (!requireSiteOwner(req, res)) return;
      const id = pathname.slice('/api/comms/'.length, -'/defaults'.length);
      const meta = require('./comms-catalog').getCatalogItem(id);
      if (!meta) return sendJson(res, 404, { ok: false, error: 'Unknown communication' });
      const defaults = {};
      if (id === 'email.invite') Object.assign(defaults, require('./invite-email-message').copy);
      if (id === 'email.invite_social') Object.assign(defaults, require('./invite-email-message').socialCopy);
      if (id === 'inbox.welcome') {
        const variant = String(requestUrl.searchParams.get('variant') || 'gridiron').toLowerCase();
        defaults.subject = welcomeMessage.subjectFor(variant, { allowOverride: false });
        defaults.body = welcomeMessage.bodyFor('{{who}}', { kind: variant, allowOverride: false });
      }
      return sendJson(res, 200, { ok: true, id, defaults, editable: meta.editable || [], placeholders: meta.placeholders || [] });
    }

    if (pathname.startsWith('/api/comms/') && req.method === 'POST') {
      if (!requireSiteOwner(req, res)) return;
      const id = pathname.slice('/api/comms/'.length);
      if (!id || id.includes('/')) {
        return sendJson(res, 404, { ok: false, error: 'Unknown communication' });
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const item = commsSettings.updateItem(id, body || {});
        return sendJson(res, 200, { ok: true, id, item });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not save' });
      }
    }

    if (pathname === '/api/invites/preview-email' && req.method === 'GET') {
      const user = requireStaff(req, res);
      if (!user) return;
      const { buildInviteEmail } = require('./mail');
      const origin = requestOrigin(req);
      const social = ['1', 'true', 'yes', 'social', 'lounge'].includes(
        String(requestUrl.searchParams.get('social') || requestUrl.searchParams.get('lounge') || '')
          .trim()
          .toLowerCase()
      );
      const content = buildInviteEmail({
        inviteUrl: `${origin}/register?invite=preview-sample-token`,
        invitedByName: user.name || user.loginName || 'Staff',
        leagueName: config.brand.name,
        baseUrl: origin,
        loungeOnly: social
      });
      const format = String(requestUrl.searchParams.get('format') || 'html').toLowerCase();
      if (format === 'json') {
        return sendJson(res, 200, {
          ok: true,
          loungeOnly: social,
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
      const kind = users.normalizeMembershipKind(requestUrl.searchParams.get('kind') || 'gridiron');
      const content = buildAccountApprovedEmail({
        name: 'Alex Manager',
        leagueName: kind === 'aaa'
          ? (getAffiliatedLeague('aaa')?.brand?.name || 'AAA League')
          : config.brand.name,
        signInUrl: `${origin}/enter`,
        baseUrl: origin,
        membershipKind: kind
      });
      const format = String(requestUrl.searchParams.get('format') || 'html').toLowerCase();
      if (format === 'json') {
        return sendJson(res, 200, {
          ok: true,
          membershipKind: kind,
          subject: content.subject,
          text: content.text,
          html: content.html
        });
      }
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
      const user = requireStaff(req, res);
      if (!user) return;
      const byEmail = new Map();
      for (const u of users.listUsers()) {
        const key = String(u.email || '').trim().toLowerCase();
        if (key) byEmail.set(key, u);
      }
      const listed = invites.listInvites()
        .filter((inv) => inviteVisibleToStaff(user, inv, req))
        .map((inv) => {
        const u = byEmail.get(String(inv.email || '').trim().toLowerCase());
        return {
          ...inv,
          account: u
            ? {
                id: u.id,
                name: u.name || u.loginName || null,
                approved: u.approved !== false,
                loungeOnly: Boolean(u.loungeOnly)
              }
            : null
        };
      });
      return sendJson(res, 200, {
        ok: true,
        invites: listed,
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
      const rawEmails = Array.isArray(body.emails)
        ? body.emails.map((e) => String(e || '').trim()).filter(Boolean)
        : String(body.email || body.emails || '')
          .split(/[,;\n]+/)
          .map((e) => e.trim())
          .filter(Boolean);
      if (!rawEmails.length) {
        return sendJson(res, 400, { ok: false, error: 'Enter at least one email address' });
      }
      const seen = new Set();
      const emails = [];
      for (const email of rawEmails) {
        const key = String(email || '').trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        emails.push(email.trim());
      }
      const membershipRaw = String(body.membership || body.kind || body.league || '').trim().toLowerCase();
      const requestedKind = (body.loungeOnly || body.social || body.accountType === 'social' || membershipRaw === 'social')
        ? 'social'
        : membershipRaw;
      const scopedInvite = staffInviteMembership(user, requestedKind);
      const loungeOnly = scopedInvite.loungeOnly;
      const membershipLeague = scopedInvite.membershipLeague;
      const inviteLeagueName = loungeOnly
        ? config.brand.name
        : membershipLeague === 'aaa'
          ? (getAffiliatedLeague('aaa')?.name || 'AAA')
          : config.brand.name;
      const results = [];
      for (const email of emails) {
        try {
          if (users.findByEmail(email)) {
            results.push({
              ok: false,
              email: users.normalizeEmail(email),
              error: 'That email already has an account. They should sign in instead of registering again.'
            });
            continue;
          }
          const created = invites.createInvite({
            email,
            invitedBy: user,
            loungeOnly,
            membershipLeague
          });
          const inviteUrl = `${requestOrigin(req)}/register?invite=${encodeURIComponent(created.token)}`;
          let mailResult = { sent: false, method: 'none' };
          try {
            mailResult = await sendInviteEmail({
              to: created.invite.email,
              inviteUrl,
              invitedByName: user.name || user.loginName,
              leagueName: inviteLeagueName,
              baseUrl: requestOrigin(req),
              loungeOnly
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
            inviteUrl,
            loungeOnly
          });
        } catch (err) {
          results.push({ ok: false, email, error: err.message || 'Could not invite' });
        }
      }
      const sentCount = results.filter((r) => r.ok && r.sent).length;
      const okCount = results.filter((r) => r.ok).length;
      const failCount = results.length - okCount;
      const mailReady = mailConfig().configured;
      const failNote = failCount
        ? ` Skipped ${failCount}: ${results.filter((r) => !r.ok).map((r) => `${r.email} (${r.error})`).join('; ')}.`
        : '';
      let message;
      if (sentCount && sentCount === okCount) {
        message = `Emailed ${sentCount} invite${sentCount === 1 ? '' : 's'}.${failNote}`;
      } else if (sentCount) {
        message = `Emailed ${sentCount} of ${okCount}. Copy the remaining invite links below.${failNote}`;
      } else if (okCount) {
        message = (mailReady
          ? 'Invites created, but email delivery failed. Copy the invite links below and share them manually.'
          : 'Invites created. Email is not configured yet — copy the invite links below (or set RESEND_API_KEY + MAIL_FROM on the server).') + failNote;
      } else {
        message = failCount
          ? `No invites were created.${failNote}`
          : 'No invites were created.';
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
        const existing = invites.listInvites().find((inv) => inv.id === id);
        if (!existing || !inviteVisibleToStaff(user, existing, req)) {
          return sendJson(res, 404, { ok: false, error: 'Invite not found' });
        }
        const refreshed = invites.refreshInvite(id, user);
        const inviteUrl = `${requestOrigin(req)}/register?invite=${encodeURIComponent(refreshed.token)}`;
        let mailResult = { sent: false, method: 'none' };
        try {
            mailResult = await sendInviteEmail({
              to: refreshed.invite.email,
              inviteUrl,
              invitedByName: user.name || user.loginName,
              leagueName: inviteHqMembership(refreshed.invite) === 'aaa'
                ? (getAffiliatedLeague('aaa')?.name || 'AAA')
                : config.brand.name,
              baseUrl: requestOrigin(req),
              loungeOnly: Boolean(refreshed.invite.loungeOnly)
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
      const user = requireStaff(req, res);
      if (!user) return;
      const id = pathname.slice('/api/invites/'.length);
      if (id.includes('/')) {
        return sendJson(res, 404, { ok: false, error: 'Not found' });
      }
      try {
        const existing = invites.listInvites().find((inv) => inv.id === id);
        if (!existing || !inviteVisibleToStaff(user, existing, req)) {
          return sendJson(res, 404, { ok: false, error: 'Invite not found' });
        }
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
      const box = scopedInboxForUser(user, req);
      const scope = leagueScopeForUser(user, req);
      return sendJson(res, 200, {
        ok: true,
        messages: box.messages,
        unread: box.unread,
        canSend: users.canSendInbox(user) && !isIndependentHqScope(scope),
        isStaff: users.isStaff(user) && !isIndependentHqScope(scope),
        isOwner: users.isSiteOwner(user) && !isIndependentHqScope(scope),
        generatedAt: new Date().toISOString()
      });
    }

    if (pathname === '/api/inbox/recipients' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      if (!users.canSendInbox(user)) {
        return sendJson(res, 403, { ok: false, error: 'Only admins and the owner can message members' });
      }
      if (isIndependentHqScope(leagueScopeForUser(user, req))) {
        return sendJson(res, 403, { ok: false, error: 'Inbox compose is for GridIron 24 staff' });
      }
      const recipients = users.listUsers()
        .filter((u) => u.approved !== false && u.id !== user.id && (userHasGridironFranchise(u) || userHasAaaAccess(u)))
        .map((u) => ({
          id: u.id,
          name: u.name || u.loginName || 'Member',
          role: u.role || 'user'
        }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return sendJson(res, 200, { ok: true, recipients });
    }

    if (pathname === '/api/inbox' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      if (!users.canSendInbox(user)) {
        return sendJson(res, 403, { ok: false, error: 'Members cannot send or reply in Inbox' });
      }
      if (isIndependentHqScope(leagueScopeForUser(user, req))) {
        return sendJson(res, 403, { ok: false, error: 'Inbox compose is for GridIron 24 staff' });
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const text = String(body.body || body.text || '').trim();
        let subject = String(body.subject || '').trim();
        let toUserId = String(body.toUserId || body.to || '').trim() || null;
        let threadId = null;
        let inReplyTo = null;
        const replyToId = String(body.replyToId || body.inReplyTo || '').trim() || null;
        const broadcast = body.broadcast === true || body.toAll === true;

        if (replyToId) {
          const original = inbox.findForUser(replyToId, user.id);
          if (!original) {
            return sendJson(res, 404, { ok: false, error: 'Original message not found' });
          }
          toUserId = original.fromUserId;
          if (!toUserId) {
            return sendJson(res, 400, { ok: false, error: 'Cannot reply to a system message' });
          }
          threadId = original.threadId || original.id;
          inReplyTo = original.id;
          if (!subject) {
            const base = String(original.subject || 'Message').replace(/^Re:\s*/i, '');
            subject = `Re: ${base}`.slice(0, 180);
          }
        }

        if (!subject) subject = 'Message from GridIron 24 HQ';
        if (!text) return sendJson(res, 400, { ok: false, error: 'Message body is required' });

        if (broadcast) {
          const ids = eligibleVoters().map((u) => u.id).filter((id) => id !== user.id);
          const sent = inbox.sendToUsers({
            toUserIds: ids,
            from: user,
            subject,
            body: text,
            type: 'general',
            meta: { broadcast: true }
          });
          return sendJson(res, 201, { ok: true, sent: sent.length, broadcast: true });
        }

        if (!toUserId) {
          return sendJson(res, 400, { ok: false, error: 'Recipient is required' });
        }
        const target = users.listUsers().find((u) => u.id === toUserId);
        if (!target || target.approved === false) {
          return sendJson(res, 404, { ok: false, error: 'Recipient not found' });
        }
        const message = inbox.sendMessage({
          toUserId,
          from: user,
          subject,
          body: text,
          type: 'general',
          threadId,
          inReplyTo,
          meta: inReplyTo ? { reply: true } : {}
        });
        return sendJson(res, 201, { ok: true, message });
      } catch (err) {
        return sendJson(res, err.status || 400, {
          ok: false,
          error: err.message || 'Could not send message'
        });
      }
    }

    if (pathname === '/api/inbox/unread' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      return sendJson(res, 200, {
        ok: true,
        unread: scopedInboxForUser(user, req).unread
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
          unread: scopedInboxForUser(user, req).unread
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
          unread: scopedInboxForUser(user, req).unread
        });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not delete message' });
      }
    }

    if (pathname === '/api/feature-requests' && req.method === 'POST') {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      return sendJson(res, 403, { ok: false, error: 'Feature requests are closed' });
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
        const proposer = user.name || user.loginName || 'member';
        const subject = `RULE CHANGE — proposal from ${proposer}`;
        const msgBody = [
          'RULE CHANGE',
          '',
          `Proposed by: ${proposer}`,
          '',
          item.text,
          '',
          'The site owner must send this for a league-wide vote from Inbox.'
        ].join('\n');
        inbox.sendToUsers({
          toUserIds: staff.map((u) => u.id),
          from: user,
          subject,
          body: msgBody,
          type: 'rule_proposal',
          relatedId: item.id,
          meta: {
            proposalId: item.id,
            status: item.status,
            authorName: proposer,
            authorId: user.id,
            ruleChange: true
          }
        });
        // Also leave a copy in the author's inbox for tracking.
        inbox.sendMessage({
          toUserId: user.id,
          from: user,
          subject: 'RULE CHANGE — your proposal was submitted',
          body: [
            'RULE CHANGE',
            '',
            'Your proposal was sent to league admins and the site owner:',
            '',
            item.text,
            '',
            'It will not go to a league vote until the owner sends it.'
          ].join('\n'),
          type: 'rule_proposal',
          relatedId: item.id,
          meta: {
            proposalId: item.id,
            status: item.status,
            authorName: proposer,
            ruleChange: true
          }
        });
        for (const staffUser of staff) {
          if (users.isSiteOwner(staffUser) || users.isCommissioner(staffUser)) {
            syncPendingInboxDigests(staffUser, { force: true });
          }
        }
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
        const proposer = updated.authorName || 'A member';
        const subject = 'RULE CHANGE — league vote open';
        const msgBody = [
          'RULE CHANGE',
          '',
          `Proposed by: ${proposer}`,
          `Opened for vote by: ${user.name || user.loginName || 'Owner'}`,
          '',
          updated.text,
          '',
          `Every approved member must vote (${pub.eligibleCount} ballots).`,
          'Vote YES or NO from your Inbox.',
          'Running tallies appear after you vote. Final results are delivered to everyone when all ballots are in.'
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
            authorName: proposer,
            authorId: updated.authorId,
            eligibleCount: pub.eligibleCount,
            ruleChange: true
          }
        });
        syncPendingInboxDigests(user, { force: true });
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
        syncPendingInboxDigests(user, { force: true });
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
          const voters = Array.isArray(updated.eligibleUserIds) && updated.eligibleUserIds.length
            ? updated.eligibleUserIds
            : eligibleVoters().map((u) => u.id);
          const resultLabel = updated.status === ruleProposals.STATUS.PASSED ? 'PASSED' : 'FAILED';
          const proposer = updated.authorName || 'A member';
          inbox.sendToUsers({
            toUserIds: voters,
            from: null,
            subject: `RULE CHANGE — ${resultLabel}`,
            body: [
              'RULE CHANGE',
              '',
              `Proposed by: ${proposer}`,
              `Final result: ${resultLabel}`,
              '',
              updated.text,
              '',
              `Final tally: Yes ${pub.yes} · No ${pub.no} (${pub.totalVotes} of ${pub.eligibleCount} voted).`
            ].join('\n'),
            type: 'rule_result',
            relatedId: updated.id,
            meta: {
              proposalId: updated.id,
              status: updated.status,
              authorName: proposer,
              yes: pub.yes,
              no: pub.no,
              ruleChange: true
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
          includeVotes: canInspectAsOwner(user)
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

    if (pathname === '/commissioner.html' || pathname === '/commissioner') {
      const user = getSessionUser(req);
      if (!canAccessCommissionerPage(user)) {
        res.writeHead(302, { Location: homePathForUser(user, req) || '/hq' });
        return res.end();
      }
      res.writeHead(302, { Location: staffDashboardPath(user) });
      return res.end();
    }

    if (pathname === '/dashboard.html' || pathname === '/dashboard') {
      const user = getSessionUser(req);
      if (!user) {
        res.writeHead(302, { Location: '/enter?next=' + encodeURIComponent('/dashboard.html') });
        return res.end();
      }
      res.writeHead(302, { Location: staffDashboardPath(user) });
      return res.end();
    }

    if (pathname === '/site.html' || pathname === '/site') {
      const user = getSessionUser(req);
      if (!user) {
        res.writeHead(302, { Location: '/enter?next=' + encodeURIComponent('/site.html') });
        return res.end();
      }
      if (!canAccessSiteTools(user)) {
        res.writeHead(302, { Location: ownerDashboardPath(user) });
        return res.end();
      }
      return sendFile(res, path.join(PUBLIC_DIR, 'site.html'));
    }

    if (pathname === '/owner.html' || pathname === '/owner') {
      const user = getSessionUser(req);
      if (!user) {
        res.writeHead(302, { Location: '/enter?next=' + encodeURIComponent('/owner.html') });
        return res.end();
      }
      if (isIndependentLeagueOwner(user)) {
        res.writeHead(302, { Location: ownerDashboardPath(user) });
        return res.end();
      }
      if (isConferenceAdminOnly(user)) {
        res.writeHead(302, { Location: '/admin.html' });
        return res.end();
      }
      if (!canAccessGi24OwnerTools(user)) {
        res.writeHead(302, { Location: '/profile.html' });
        return res.end();
      }
      return sendLeagueToolsPage(res);
    }

    if (pathname === '/admin.html' || pathname === '/admin') {
      const user = getSessionUser(req);
      if (!user) {
        res.writeHead(302, { Location: '/enter?next=' + encodeURIComponent('/admin.html') });
        return res.end();
      }
      if (!isConferenceAdminOnly(user)) {
        res.writeHead(302, { Location: ownerDashboardPath(user) });
        return res.end();
      }
      return sendLeagueToolsPage(res);
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

    if (pathname === '/aaa-playoffs' || pathname === '/aaa-playoffs/') {
      res.writeHead(302, { Location: '/aaa-playoffs.html' });
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
      if (!user) {
        res.writeHead(302, { Location: '/enter?next=' + encodeURIComponent('/owner.html') });
        return res.end();
      }
      if (isIndependentLeagueOwner(user)) {
        res.writeHead(302, { Location: ownerDashboardPath(user) });
        return res.end();
      }
      if (isConferenceAdminOnly(user)) {
        res.writeHead(302, { Location: '/admin.html' });
        return res.end();
      }
      if (!canAccessGi24OwnerTools(user)) {
        res.writeHead(302, { Location: '/profile.html' });
        return res.end();
      }
      res.writeHead(302, { Location: '/owner.html' });
      return res.end();
    }

    if (pathname === '/api/leagues') {
      const user = getSessionUser(req);
      const scope = leagueScopeForUser(user, req);
      if (isIndependentHqScope(scope) || (user && !userHasGridironFranchise(user) && !userHasAaaAccess(user))) {
        return sendJson(res, 200, {
          ok: true,
          espn: false,
          brand: config.brand,
          season: config.season,
          generatedAt: new Date().toISOString(),
          conferences: [],
          leagueScope: scope
        });
      }
      return await apiLeagues(res);
    }

    if (pathname === '/api/league-roster') {
      try {
        return sendJson(res, 200, loadLeagueRoster());
      } catch (err) {
        return sendJson(res, err.status || 500, {
          ok: false,
          error: err.message || 'Could not load 2026 roster'
        });
      }
    }

    if (pathname === '/api/espn-leagues' && req.method === 'GET') {
      const user = requireStaff(req, res);
      if (!user) return;
      const bindings = listEspnLeagueBindings();
      if (!canInspectAsOwner(user)) {
        if (user.role === 'conference_admin' && user.conference) {
          const conf = String(user.conference).toLowerCase();
          bindings.leagues = (bindings.leagues || []).filter(
            (row) => String(row.key || '').toLowerCase() === conf
          );
        } else {
          return sendJson(res, 403, { ok: false, error: 'Owner access required' });
        }
      }
      const peek = String(requestUrl.searchParams.get('peek') || '').trim() === '1';
      if (!peek) {
        return sendJson(res, 200, { ok: true, ...bindings });
      }
      const leagues = await Promise.all((bindings.leagues || []).map(async (row) => {
        if (!row.espnLeagueId) return { ...row, lookup: null };
        try {
          return { ...row, lookup: await peekEspnLeagueById(row.espnLeagueId, bindings.season) };
        } catch (err) {
          return {
            ...row,
            lookup: {
              ok: false,
              espnLeagueId: row.espnLeagueId,
              error: err.message || 'ESPN lookup failed',
              private: Number(err.status) === 401
            }
          };
        }
      }));
      return sendJson(res, 200, { ok: true, season: bindings.season, leagues });
    }

    if (pathname === '/api/espn-leagues/peek' && req.method === 'POST') {
      if (!requireStaff(req, res)) return;
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const lookup = await peekEspnLeagueById(parseEspnLeagueId(body.espnLeagueId) || body.espnLeagueId, body.season);
        return sendJson(res, 200, lookup);
      } catch (err) {
        return sendJson(res, err.status && err.status < 500 ? err.status : 400, {
          ok: false,
          espnLeagueId: parseEspnLeagueId(body.espnLeagueId) || body.espnLeagueId || null,
          error: err.message || 'Could not look up ESPN league',
          private: Number(err.status) === 401
        });
      }
    }

    if (pathname === '/api/espn-leagues' && req.method === 'POST') {
      const actor = requireCommissioner(req, res);
      if (!actor) return;
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      const rows = Array.isArray(body.leagues) ? body.leagues : [];
      if (!rows.length) {
        return sendJson(res, 400, { ok: false, error: 'No ESPN league IDs to save' });
      }
      try {
        const lookups = [];
        for (const row of rows) {
          const id = parseEspnLeagueId(row.espnLeagueId);
          if (!id) continue;
          row.espnLeagueId = id;
          try {
            lookups.push({ key: row.key, lookup: await peekEspnLeagueById(id, body.season) });
          } catch (err) {
            lookups.push({
              key: row.key,
              lookup: {
                ok: false,
                espnLeagueId: id,
                error: err.message || 'Could not look up ESPN league',
                private: Number(err.status) === 401
              }
            });
          }
        }
        const leagueId = config.leagueId || leagues.getActiveLeagueId();
        const updated = leagues.setEspnLeagueBindings(leagueId, rows);
        const bindings = listEspnLeagueBindings();
        return sendJson(res, 200, {
          ok: true,
          leagues: bindings.leagues,
          season: bindings.season,
          updatedAt: updated.updatedAt || null,
          lookups
        });
      } catch (err) {
        return sendJson(res, err.status || 400, {
          ok: false,
          error: err.message || 'Could not save ESPN league IDs'
        });
      }
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

    if (pathname === '/api/records' && req.method === 'GET') {
      try {
        const payload = await loadRecordBook();
        return sendJson(res, 200, payload);
      } catch (err) {
        return sendJson(res, err.status || 500, {
          ok: false,
          error: err.message || 'Could not load record book',
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
      if (!user) return sendJson(res, 401, { ok: false, error: 'Authentication required' });
      const teamScope = leagueScopeForUser(user, req);
      if (isIndependentHqScope(teamScope)) {
        return sendJson(res, 200, {
          ok: true,
          espn: false,
          team: null,
          claim: null,
          leagueScope: teamScope
        });
      }
      if (!userHasGridironFranchise(user) && !userHasAaaAccess(user)) {
        return sendJson(res, 403, { ok: false, error: 'Not a GridIron 24 or AAA member' });
      }
      let claim = logos.getClaimForUser(user.id);
      if (!claim) {
        try { claim = await maybeLinkEspnFranchise(user); } catch { /* keep unlinked */ }
      }
      const chip = chipFranchiseForUser(user);
      const logo = logos.resolveLogoForUser(user.id);
      const keeperWindow = keepers.getKeeperWindow(calendar.listEvents(), config.season);
      let team = chip
        ? {
          id: chip.teamId,
          name: chip.name || null,
          conferenceKey: chip.conferenceKey,
          conferenceName: chip.conferenceName,
          logo: logo?.url || null
        }
        : null;
      let roster = [];
      let lineup = [];
      let bench = [];
      let keeper = null;
      let currentMatchup = null;
      let currentMatchupPeriod = null;
      let recentMatchups = [];
      let matchupBox = null;
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
              lineup = detail?.team?.lineup || [];
              bench = detail?.team?.bench || [];
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
              matchupBox = detail?.matchupBox || null;
              conferenceMeta = detail?.conference || {
                key: conference.key,
                name: conference.name,
                shortName: conference.shortName,
                logo: conference.logo,
                kind: conference.kind || 'conference'
              };
            } catch {
              // ESPN roster optional — still return empty starter/bench skeleton for PWA.
              if (!lineup.length) {
                lineup = fillStarterSlots([], DEFAULT_STARTER_SLOT_COUNTS, { weekStats: true });
              }
              if (!bench.length) {
                const benchCount = 6;
                bench = Array.from({ length: benchCount }, () => emptySlotPlayer(20, 'Bench', { weekStats: true }));
              }
              if (!roster.length) roster = [...lineup, ...bench];
            }
          }
        } catch { /* ignore ESPN lookup failures for avatar */ }
        if (nameEntry?.displayName) {
          team = {
            ...(team || { id: claim.teamId, conferenceKey: claim.conferenceKey }),
            name: nameEntry.displayName
          };
        } else if (claim.teamName && team && !espnDisplayNameLooksDefault(claim.teamName)) {
          team.name = claim.teamName;
        }
        keeper = keepers.getKeeper(claim.conferenceKey, claim.teamId, keeperWindow.forSeason);
      }
      if (team && !team.name) {
        team.name = chip?.name || claim?.teamName || null;
      }
      return sendJson(res, 200, {
        ok: true,
        claim: claim || chip?.claim || null,
        logo,
        team,
        roster,
        lineup,
        bench,
        currentMatchup,
        matchupBox,
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
        syncPendingInboxDigests(user, { force: true });
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
        syncPendingInboxDigests(user, { force: true });
        return sendJson(res, 200, { ok: true, violation: closed });
      } catch (err) {
        return sendJson(res, err.status || 500, { ok: false, error: err.message || 'Could not acknowledge' });
      }
    }

    if (pathname === '/api/schedule') {
      const user = getSessionUser(req);
      const scope = resolveLeagueScope(user, req, requestUrl.searchParams.get('league'));
      if (isIndependentHqScope(scope) || (user && !userHasGridironFranchise(user) && !userHasAaaAccess(user))) {
        return sendJson(res, 200, { ok: true, espn: false, week: null, conferences: [], leagueScope: scope });
      }
      return await apiSchedule(res, requestUrl.searchParams.get('week'), scope);
    }

    if (pathname === '/api/fantasy-leaders') {
      const user = getSessionUser(req);
      const scope = resolveLeagueScope(user, req, requestUrl.searchParams.get('league'));
      return await apiFantasyLeaders(res, requestUrl.searchParams.get('week'), scope);
    }

    if (pathname === '/api/bowl') {
      const bowlUser = getSessionUser(req);
      if (isIndependentHqScope(leagueScopeForUser(bowlUser, req))) {
        return sendJson(res, 200, { ok: true, espn: false, enabled: false });
      }
      try {
        const payload = await buildBowlPayload();
        return sendJson(res, 200, payload);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message || 'Could not load GridIron Bowl' });
      }
    }

    if (pathname === '/api/survival') {
      const cupUser = getSessionUser(req);
      if (isIndependentHqScope(leagueScopeForUser(cupUser, req))) {
        return sendJson(res, 200, { ok: true, espn: false, enabled: false });
      }
      try {
        const payload = await buildSurvivalPayload();
        return sendJson(res, 200, payload);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message || 'Could not load MAYORS CUP' });
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

    if (pathname === '/api/aaa/playoffs') {
      try {
        const payload = await buildAaaPlayoffsPayload();
        return sendJson(res, payload.ok === false && payload.error ? 502 : 200, payload);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message || 'Could not load AAA playoffs' });
      }
    }

    if (pathname === '/api/playoffs') {
      const playoffUser = getSessionUser(req);
      const playoffScope = leagueScopeForUser(playoffUser, req);
      if (isIndependentHqScope(playoffScope)) {
        return sendJson(res, 200, { ok: true, espn: false, conferences: [], leagueScope: playoffScope });
      }
      try {
        const payload = await buildPlayoffsPayload();
        return sendJson(res, 200, payload);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message || 'Could not load playoffs' });
      }
    }

    if (pathname === '/api/transactions') {
      try {
        const user = getSessionUser(req);
        const scope = leagueScopeForUser(user, req);
        const payload = await loadTransactionsPayload(scope);
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
      const calUser = getSessionUser(req);
      const calScope = leagueScopeForUser(calUser, req);
      if (isIndependentHqScope(calScope)) {
        const il = calScope.leagueId ? leagues.findById(calScope.leagueId) : null;
        return sendJson(res, 200, {
          ok: true,
          events: il?.calendarDefaults || [],
          leagueScope: calScope
        });
      }
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

    if (pathname === '/api/draft-order-show' && req.method === 'GET') {
      const viewer = getSessionUser(req);
      return sendJson(res, 200, {
        ok: true,
        videos: draftOrderShow.listVideos(),
        canManage: Boolean(viewer && users.isSiteOwner(viewer)),
        generatedAt: new Date().toISOString()
      });
    }

    if (pathname === '/api/draft-order-show' && req.method === 'POST') {
      if (!requireSiteOwnerWrite(req, res)) return;
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
      }
      try {
        const item = draftOrderShow.saveEmbed(body);
        return sendJson(res, 201, { ok: true, item });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not save video' });
      }
    }

    if (pathname === '/api/draft-order-show/upload' && req.method === 'POST') {
      if (!requireSiteOwnerWrite(req, res)) return;
      const mimeType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      let dest;
      try {
        draftOrderShow.extForMime(mimeType);
        dest = draftOrderShow.newUploadPath(requestUrl.searchParams.get('year'), mimeType);
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Upload MP4, WebM, or MOV' });
      }
      try {
        const size = await streamRequestToFile(req, dest.abs, { maxBytes: draftOrderShow.MAX_BYTES });
        const item = draftOrderShow.saveFileMeta({
          year: requestUrl.searchParams.get('year'),
          title: requestUrl.searchParams.get('title'),
          notes: requestUrl.searchParams.get('notes'),
          filename: dest.filename,
          mimeType,
          size
        });
        return sendJson(res, 201, { ok: true, item });
      } catch (err) {
        try { fs.unlinkSync(dest.abs); } catch { /* ignore */ }
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not upload video' });
      }
    }

    if (pathname.startsWith('/api/draft-order-show/') && pathname.endsWith('/media') && req.method === 'GET') {
      const id = pathname.slice('/api/draft-order-show/'.length, -'/media'.length).replace(/\/$/, '');
      const media = draftOrderShow.resolveMediaPath(id);
      if (!media) {
        return sendJson(res, 404, { ok: false, error: 'Video not found' });
      }
      return sendMediaFile(req, res, media.path, media.mimeType);
    }

    if (pathname.startsWith('/api/draft-order-show/') && req.method === 'DELETE') {
      if (!requireSiteOwnerWrite(req, res)) return;
      const id = pathname.slice('/api/draft-order-show/'.length);
      try {
        draftOrderShow.remove(id);
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, err.status || 400, { ok: false, error: err.message || 'Could not remove video' });
      }
    }

    if (pathname === '/api/power-rankings' && req.method === 'GET') {
      try {
        const payload = await loadSystemPowerRankings();
        return sendJson(res, 200, payload);
      } catch (err) {
        return sendJson(res, err.status || 500, {
          ok: false,
          error: err.message || 'Could not load power rankings',
          detail: err.detail || null
        });
      }
    }

    if (pathname === '/api/power-rankings' && req.method === 'POST') {
      return sendJson(res, 410, {
        ok: false,
        error: 'Power rankings are system-generated now — publishing from League Tools is retired.'
      });
    }

    if (pathname.startsWith('/api/power-rankings/') && req.method === 'DELETE') {
      return sendJson(res, 410, {
        ok: false,
        error: 'Power rankings are system-generated now — there is nothing to delete.'
      });
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

    if (pathname === '/members.html' || pathname === '/members') {
      const loungeUser = getSessionUser(req);
      if (!loungeUser) {
        res.writeHead(302, { Location: '/enter?next=' + encodeURIComponent('/members.html') });
        return res.end();
      }
      if (!users.hasLoungeAccess(loungeUser)) {
        res.writeHead(302, { Location: '/restricted.html?area=lounge' });
        return res.end();
      }
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
  try {
    const owner = users.listUsers().find((u) => u.siteOwner);
    if (owner?.id) logos.unassignConference(owner.id, 'aaa');
  } catch (err) {
    console.warn('Could not drop owner AAA franchise claim:', err.message || err);
  }
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
  console.log(`Create a league: http://localhost:${PORT}/create-league`);
  console.log(`Register ESPN league: http://localhost:${PORT}/register-league`);
  console.log(`Auth: commissioner invite token admits Members Lounge`);
  console.log(`Users: ${users.DATA_DIR}`);
  const ownerLogin = process.env.SITE_OWNER_LOGIN || process.env.COMMISSIONER_LOGIN;
  if (ownerLogin) {
    console.log(`GridIron 24 site owner: ${ownerLogin}`);
  }
  if (process.env.AAA_ADMIN_LOGIN) {
    console.log(`AAA league admin: ${process.env.AAA_ADMIN_LOGIN}`);
  }
  // Background sportsbook settle — stake already deducted on place; finals credit Funds/Earnings.
  const PAPER_BOOK_SETTLE_MS = 60 * 1000;
  setTimeout(() => {
    settlePaperBookFromScores().catch((err) => {
      console.warn('[paper-book-settle] startup pass failed', err.message || err);
    });
  }, 20_000);
  setInterval(() => {
    settlePaperBookFromScores().catch((err) => {
      console.warn('[paper-book-settle] interval failed', err.message || err);
    });
  }, PAPER_BOOK_SETTLE_MS);
  setTimeout(() => {
    nflverseDraft.loadDraftPool({ activeOnly: true, force: true }).catch((err) => {
      console.warn('[draft-pool] startup refresh failed', err.message || err);
    });
  }, 8_000);
  const INDEPENDENT_DRAFT_TICK_MS = 4_000;
  setInterval(() => {
    preDraftRefresh.refreshAheadOfDrafts().catch((err) => {
      console.warn('[pre-draft-refresh] failed', err.message || err);
    });
    nflverseDraft.loadDraftPool({ activeOnly: true })
      .then((payload) => {
        independentDraft.tickAll(payload.players || []);
        try { conferenceDraft.tickAll(); } catch { /* ignore */ }
        try { independentWire.processDueLeagues(); } catch { /* ignore */ }
      })
      .catch((err) => {
        console.warn('[independent-draft] tick failed', err.message || err);
      });
  }, INDEPENDENT_DRAFT_TICK_MS);
  if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
    startInProcessCrons([
      {
        name: 'weekly-wrap',
        days: [2],
        hour: 14,
        minute: 0,
        run: () => runWeeklyWrapJob({ triggeredBy: 'in-process', sendEmail: true, postNews: true })
      },
      {
        name: 'rules-sync',
        days: [1, 4],
        hour: 14,
        minute: 0,
        run: () => runRulesSyncJob({ triggeredBy: 'in-process', notify: true })
      },
      {
        name: 'roster-violations',
        hour: 14,
        minute: 0,
        run: () => runRosterViolationsJob({ triggeredBy: 'in-process', notify: true })
      },
      {
        name: 'death-pool-news',
        hour: 13,
        minute: 0,
        run: () => deathPoolNews.runDeathNewsScan({ force: true })
      },
      {
        name: 'pre-draft-refresh',
        everyMinutes: 1,
        run: () => preDraftRefresh.refreshAheadOfDrafts()
      },
      {
        name: 'roster-violations-q1',
        days: [0, 1, 2, 4, 5],
        hours: [0, 1, 2, 3, 16, 17, 18, 19, 20, 21, 22, 23],
        everyMinutes: 10,
        run: () => runRosterViolationsJob({
          triggeredBy: 'in-process-q1',
          notify: true,
          onlyIfFirstQuarter: true
        })
      }
    ]);
    console.log('In-process crons: weekly-wrap, rules-sync, roster-violations, death-pool-news, pre-draft-refresh, roster-violations-q1');
  }
  console.log('');
});
