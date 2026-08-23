const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const independentScoring = require('./independent-scoring');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'leagues.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads', 'leagues');

/** Team / franchise display names — a name, not a sentence. */
const FRANCHISE_NAME_MAX = 32;

function normalizeFranchiseName(raw, { required = true } = {}) {
  const name = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!name) {
    if (required) throw Object.assign(new Error('Franchise name is required'), { status: 400 });
    return '';
  }
  if (name.length > FRANCHISE_NAME_MAX) {
    throw Object.assign(new Error(`Team name must be ${FRANCHISE_NAME_MAX} characters or fewer`), { status: 400 });
  }
  return name;
}

const ASSET_TYPES = new Set([
  'brandLogo',
  'brandCrest',
  'conferenceLogo0',
  'conferenceLogo1',
  'championshipLogo',
  'confChampLogo0',
  'confChampLogo1',
  'thirdPlaceLogo0',
  'thirdPlaceLogo1'
]);

const IMAGE_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg'
};

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(
      STORE_FILE,
      JSON.stringify({ activeLeagueId: null, leagues: [] }, null, 2)
    );
  }
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return {
      activeLeagueId: data.activeLeagueId || null,
      leagues: Array.isArray(data.leagues) ? data.leagues : []
    };
  } catch {
    return { activeLeagueId: null, leagues: [] };
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${STORE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify(
      {
        activeLeagueId: data.activeLeagueId || null,
        leagues: data.leagues || []
      },
      null,
      2
    )
  );
  fs.renameSync(tmp, STORE_FILE);
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Basenames that must never become an independent league homepage slug. */
const RESERVED_LEAGUE_SLUGS = new Set([
  'aaa', 'aaa-playoffs', 'aaa-rulebook', 'app', 'assets', 'beta-draft', 'beta-scoring',
  'calendar', 'commissioner', 'create-league', 'css', 'draft', 'enter', 'forgot',
  'history', 'home', 'hq', 'inbox', 'index', 'invite-email-preview', 'invite-lounge-preview',
  'js', 'league-hq', 'league-tools', 'login', 'members', 'my-league', 'my-roster',
  'owner', 'admin', 'dashboard', 'site',
  'payouts', 'playoffs', 'profile', 'rankings', 'register', 'register-league', 'reset',
  'restricted', 'rulebook', 'schedules', 'scoreboard', 'scoring', 'setup', 'standings',
  'team', 'team-logo', 'team-rosters', 'teams', 'transactions', 'uploads', 'api',
  'gridiron24', 'gridiron', 'www', 'favicon', 'robots', 'sitemap', 'sw', 'manifest'
]);

function isReservedLeagueSlug(slug) {
  return RESERVED_LEAGUE_SLUGS.has(slugify(slug));
}

/** Public homepage path for an independent league: /{slug}.html */
function independentHomePath(league) {
  const slug = slugify(league?.slug || league?.brand?.name);
  if (!slug || isReservedLeagueSlug(slug)) return '/my-league.html';
  return `/${slug}.html`;
}

function independentSectionPath(league, section) {
  const home = independentHomePath(league);
  if (home === '/my-league.html') return home;
  const slug = slugify(league?.slug);
  const page = String(section || '').trim().toLowerCase();
  if (!page || page === 'home') return home;
  return `/${slug}/${page}.html`;
}

function allocateLeagueSlug(brandSlugOrName, existingLeagues = []) {
  let slug = slugify(brandSlugOrName);
  if (!slug || isReservedLeagueSlug(slug)) {
    slug = `league-${crypto.randomBytes(3).toString('hex')}`;
  }
  const taken = new Set(
    (existingLeagues || []).map((l) => slugify(l.slug)).filter(Boolean)
  );
  if (!taken.has(slug) && !isReservedLeagueSlug(slug)) return slug;
  let attempt = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
  while (taken.has(attempt) || isReservedLeagueSlug(attempt)) {
    attempt = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
  }
  return attempt;
}

function conferenceKeyFromName(name, fallback) {
  const key = slugify(name).replace(/-/g, '').slice(0, 24);
  return key || fallback;
}

function defaultSurvival(seed = {}) {
  const enabled = seed.enabled === true || seed.enabled === '1' || seed.enabled === 1;
  return {
    enabled,
    week: Number.isFinite(Number(seed.week)) ? Number(seed.week) : null,
    name: String(seed.name || '').trim()
  };
}

function defaultAaaPayouts(seed = {}) {
  const min = Number(seed.teamCountMin) || 10;
  const max = Number(seed.teamCountMax) || 14;
  const fixed = Number(seed.teamCount);
  return {
    seasonLabel: String(seed.seasonLabel || 'AAA Season').trim() || 'AAA Season',
    buyInPerTeam: Number(seed.buyInPerTeam) === 0 ? 0 : (Number(seed.buyInPerTeam) || 50),
    teamCountMin: min,
    teamCountMax: max,
    teamCount: Number.isFinite(fixed) && fixed > 0 ? fixed : null,
    currency: String(seed.currency || 'USD').trim() || 'USD',
    notes: String(seed.notes || '').trim()
      || `Roster size is set by interest (${min}–${max} franchises). Buy-in is $50 per franchise; prize pool equals $50 × final roster.`,
    prizes: Array.isArray(seed.prizes) && seed.prizes.length
      ? seed.prizes.map((row, index) => ({
          place: Number(row.place) || index + 1,
          label: String(row.label || `Place ${index + 1}`).trim(),
          amount: Number(row.amount) || 0
        }))
      : [
          { place: 1, label: 'AAA Champion', amount: 300 },
          { place: 2, label: 'AAA Runner-Up', amount: 150 },
          { place: 3, label: 'AAA Third Place', amount: 100 },
          { place: 4, label: 'AAA Most Points', amount: 50 }
        ]
  };
}

function defaultAffiliatedLeagues(seedList) {
  const list = Array.isArray(seedList) ? seedList : [];
  if (!list.length) {
    return [{
      key: 'aaa',
      name: 'AAA League',
      shortName: 'AAA',
      espnLeagueId: null,
      role: 'feeder',
      logo: '/assets/aaa-league.png?v=7',
      payouts: defaultAaaPayouts()
    }];
  }
  return list.map((row) => ({
    key: String(row.key || 'aaa').trim() || 'aaa',
    name: String(row.name || 'AAA League').trim() || 'AAA League',
    shortName: String(row.shortName || 'AAA').trim() || 'AAA',
    espnLeagueId: Number(row.espnLeagueId) > 0 ? Number(row.espnLeagueId) : null,
    role: String(row.role || 'feeder').trim() || 'feeder',
    logo: String(row.logo || '/assets/aaa-league.png?v=7').trim() || '/assets/aaa-league.png?v=7',
    payouts: defaultAaaPayouts(row.payouts || {})
  }));
}

function independentChampionshipPublic(league) {
  const ch = normalizeIndependentChampionship(league?.championship || {}, league);
  const brand = String(league?.brand?.name || '').trim();
  const autoBowl = brand ? `${brand} Bowl` : '';
  if (ch.name === autoBowl || ch.name === 'League Bowl') {
    return { ...ch, name: '' };
  }
  return ch;
}

function publicLeague(league) {
  if (!league) return null;
  const pub = {
    id: league.id,
    slug: league.slug,
    status: league.status,
    platform: league.platform || (league.isSystem ? 'espn' : 'espn'),
    isSystem: Boolean(league.isSystem),
    season: league.season,
    leagueType: league.leagueType
      || ((Array.isArray(league.conferences) && league.conferences.length === 2)
        ? 'two-conferences'
        : 'one-conference'),
    setupComplete: league.setupComplete !== false,
    brand: league.brand,
    conferences: league.conferences,
    championship: league.platform === 'independent'
      ? independentChampionshipPublic(league)
      : league.championship,
    structure: league.platform === 'independent'
      ? normalizeIndependentStructure(league.structure || {}, league)
      : league.structure,
    survival: league.platform === 'independent'
      ? defaultSurvival(league.survival?.enabled === true ? league.survival : { enabled: false })
      : (league.survival || defaultSurvival()),
    affiliatedLeagues: Array.isArray(league.affiliatedLeagues)
      ? league.affiliatedLeagues
      : defaultAffiliatedLeagues(),
    historySeasons: Array.isArray(league.historySeasons) ? league.historySeasons : [],
    payouts: league.payouts,
    calendarDefaults: league.platform === 'independent'
      ? defaultIndependentCalendar(league.calendarDefaults || [], {
          championship: independentChampionshipPublic(league),
          survival: league.survival?.enabled === true ? league.survival : { enabled: false }
        })
      : league.calendarDefaults,
    settings: league.settings || null,
    rulebook: league.platform === 'independent'
      ? composeIndependentRulebook({
          ...league,
          championship: independentChampionshipPublic(league),
          survival: defaultSurvival(league.survival?.enabled === true ? league.survival : { enabled: false })
        })
      : null,
    draft: league.platform === 'independent'
      ? defaultIndependentDraft(league.draft || {})
      : null,
    franchises: Array.isArray(league.franchises) ? league.franchises : [],
    ownerUserId: league.ownerUserId || null,
    ownerName: league.ownerName || null,
    ownerEmail: league.ownerEmail || null,
    rejectionReason: league.rejectionReason || null,
    submittedAt: league.submittedAt || null,
    approvedAt: league.approvedAt || null,
    approvedBy: league.approvedBy || null,
    renewedAt: league.renewedAt || null,
    archivedAt: league.archivedAt || null,
    createdAt: league.createdAt,
    activatedAt: league.activatedAt || null
  };
  if (pub.platform === 'independent') {
    pub.homePath = independentHomePath(league);
    pub.affiliatedLeagues = []; // never tied to GridIron 24 / AAA
    pub.schedule = league.schedule || null;
    pub.playoffs = league.playoffs
      ? {
          locked: Boolean(league.playoffs.locked),
          format: league.playoffs.format || null,
          champName: league.playoffs.champName || null,
          weeks: league.playoffs.weeks || [],
          seeds: league.playoffs.seeds || []
        }
      : null;
    pub.transactions = Array.isArray(league.transactions)
      ? league.transactions.slice(-40).reverse()
      : [];
  }
  return pub;
}

function normalizeHistorySeasons(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list
    .map((row) => {
      const season = Number(row.season);
      if (!Number.isFinite(season) || season < 2000 || season > 2100) return null;
      const sharedId = Number(row.espnLeagueId || 0) || null;
      const detailId = Number(row.detailEspnLeagueId || sharedId || 0) || null;
      const overtimeId = Number(row.overtimeEspnLeagueId || sharedId || 0) || null;
      if (!detailId && !overtimeId) return null;
      const yearNumber = Number(row.yearNumber) || null;
      return {
        season,
        yearNumber: Number.isFinite(yearNumber) && yearNumber > 0 ? yearNumber : null,
        label: String(row.label || '').trim()
          || (yearNumber ? `Year ${yearNumber} (${season})` : String(season)),
        detailEspnLeagueId: detailId,
        overtimeEspnLeagueId: overtimeId,
        notes: String(row.notes || '').trim() || null
      };
    })
    .filter(Boolean)
    .filter((row) => {
      if (seen.has(row.season)) return false;
      seen.add(row.season);
      return true;
    })
    .sort((a, b) => b.season - a.season);
}

function parseEspnLeagueId(value) {
  if (value == null || String(value).trim() === '') return null;
  const id = Number(String(value).trim());
  if (!Number.isFinite(id) || id <= 0) {
    throw Object.assign(new Error('ESPN league ID must be a positive number'), { status: 400 });
  }
  return Math.trunc(id);
}

function setEspnLeagueBindings(leagueId, rows = []) {
  const store = readStore();
  const league = store.leagues.find((l) => l.id === leagueId);
  if (!league) throw Object.assign(new Error('League not found'), { status: 404 });
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    throw Object.assign(new Error('No ESPN league IDs to save'), { status: 400 });
  }

  const seen = new Set();
  for (const row of list) {
    const key = String(row?.key || '').trim().toLowerCase();
    if (!key) throw Object.assign(new Error('Each ESPN binding needs a league key'), { status: 400 });
    const espnLeagueId = parseEspnLeagueId(row.espnLeagueId);
    if (espnLeagueId) {
      const idKey = String(espnLeagueId);
      if (seen.has(idKey)) {
        throw Object.assign(new Error(`ESPN league ID ${espnLeagueId} is used more than once`), { status: 400 });
      }
      seen.add(idKey);
    }
    const conference = (league.conferences || []).find((c) => String(c.key || '').toLowerCase() === key);
    if (conference) {
      conference.espnLeagueId = espnLeagueId;
      if (typeof row.name === 'string') {
        const nextName = row.name.trim();
        if (nextName) conference.name = nextName.slice(0, 80);
      }
      if (typeof row.shortName === 'string') {
        const nextShort = row.shortName.trim();
        if (nextShort) conference.shortName = nextShort.slice(0, 24);
      }
      continue;
    }
    const affiliate = (league.affiliatedLeagues || []).find((l) => String(l.key || '').toLowerCase() === key);
    if (affiliate) {
      affiliate.espnLeagueId = espnLeagueId;
      if (typeof row.name === 'string') {
        const nextName = row.name.trim();
        if (nextName) affiliate.name = nextName.slice(0, 80);
      }
      if (typeof row.shortName === 'string') {
        const nextShort = row.shortName.trim();
        if (nextShort) affiliate.shortName = nextShort.slice(0, 24);
      }
      continue;
    }
    throw Object.assign(new Error(`Unknown league: ${key}`), { status: 400 });
  }

  league.updatedAt = new Date().toISOString();
  writeStore(store);
  return publicLeague(league);
}

function setHistorySeasons(leagueId, seasons) {
  const store = readStore();
  const league = store.leagues.find((l) => l.id === leagueId);
  if (!league) throw Object.assign(new Error('League not found'), { status: 404 });
  league.historySeasons = normalizeHistorySeasons(seasons);
  league.updatedAt = new Date().toISOString();
  writeStore(store);
  return publicLeague(league);
}

function listLeagues() {
  return readStore().leagues.map(publicLeague);
}

function findById(id) {
  return readStore().leagues.find((l) => l.id === id) || null;
}

function findBySlug(slug) {
  const key = slugify(slug);
  return readStore().leagues.find((l) => l.slug === key) || null;
}

function getActiveLeagueId() {
  const store = readStore();
  if (store.activeLeagueId && store.leagues.some((l) => l.id === store.activeLeagueId)) {
    return store.activeLeagueId;
  }
  const system = store.leagues.find((l) => l.isSystem);
  return system?.id || store.leagues[0]?.id || null;
}

function getActiveLeague() {
  const id = getActiveLeagueId();
  return id ? findById(id) : null;
}

function setActiveLeague(leagueId) {
  const store = readStore();
  const league = store.leagues.find((l) => l.id === leagueId);
  if (!league) throw Object.assign(new Error('League not found'), { status: 404 });
  store.activeLeagueId = league.id;
  league.status = 'active';
  league.activatedAt = new Date().toISOString();
  writeStore(store);
  return publicLeague(league);
}

function saveAssetBuffer(leagueId, assetType, buffer, mimeType) {
  if (!ASSET_TYPES.has(assetType)) {
    throw Object.assign(new Error('Unknown asset type'), { status: 400 });
  }
  const ext = IMAGE_MIME[mimeType];
  if (!ext) {
    throw Object.assign(new Error('Upload PNG, JPG, WEBP, or SVG'), { status: 400 });
  }
  if (!buffer?.length) {
    throw Object.assign(new Error('Empty upload'), { status: 400 });
  }
  if (buffer.length > 3 * 1024 * 1024) {
    throw Object.assign(new Error('Image must be under 3MB'), { status: 400 });
  }

  const dir = path.join(UPLOAD_DIR, leagueId);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${assetType}.${ext}`;
  const abs = path.join(dir, filename);
  fs.writeFileSync(abs, buffer);
  return `/uploads/leagues/${leagueId}/${filename}`;
}

function normalizePrize(row, index) {
  return {
    place: Number(row.place) || index + 1,
    label: String(row.label || `Place ${index + 1}`).trim(),
    amount: Number(row.amount) || 0
  };
}

function normalizeConferenceInput(raw, index, uploadedLogos = {}, { requireEspn = true } = {}) {
  const name = String(raw?.name || '').trim();
  if (!name) throw Object.assign(new Error(`Conference ${index + 1} name is required`), { status: 400 });
  const shortName = String(raw?.shortName || name).trim().toUpperCase().slice(0, 16);
  let key = slugify(raw?.key || name).replace(/-/g, '');
  if (!key) key = index === 0 ? 'conferencea' : 'conferenceb';
  let espnLeagueId = null;
  if (requireEspn) {
    const id = Number(raw?.espnLeagueId);
    if (!Number.isFinite(id) || id <= 0) {
      throw Object.assign(new Error(`Valid ESPN league ID required for ${name}`), { status: 400 });
    }
    espnLeagueId = id;
  } else if (raw?.espnLeagueId != null && String(raw.espnLeagueId).trim() !== '') {
    const id = Number(raw.espnLeagueId);
    espnLeagueId = Number.isFinite(id) && id > 0 ? id : null;
  }
  const color = String(raw?.color || (index === 0 ? '#ff7a18' : '#e2232a')).trim();
  const logoKey = `conferenceLogo${index}`;
  return {
    key,
    name,
    shortName,
    espnLeagueId,
    logo: uploadedLogos[logoKey] || raw?.logo || null,
    color: /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color : index === 0 ? '#ff7a18' : '#e2232a',
    isRulesPrimary: index === 0 || Boolean(raw?.isRulesPrimary)
  };
}

/** Vanilla GridIron 24–shaped scoring / roster for independent leagues (no ESPN). */
function passingTdForPreset(preset) {
  const p = String(preset || '').toLowerCase();
  if (p === 'gridiron24-vanilla' || p === 'ppr-4' || p === '4pt' || p === '4-pt') return 4;
  return 6;
}

function defaultIndependentScoring(seed = {}, preset = 'ppr-6') {
  const reception =
    preset === 'standard' ? 0 : preset === 'half-ppr' ? 0.5 : 1;
  const base = {
    // Passing (QB)
    passingYardsPerPoint: 25,
    passingTD: passingTdForPreset(preset),
    interception: -2,
    passing2pt: 2,
    // Rushing (RB / QB / WR)
    rushingYardsPerPoint: 10,
    rushingTD: 6,
    rushing2pt: 2,
    // Receiving (WR / TE / RB)
    receivingYardsPerPoint: 10,
    receivingTD: 6,
    reception,
    receiving2pt: 2,
    // Ball security / conversions
    fumbleLost: -2,
    twoPointConversion: 2,
    specialTeamsTD: 6,
    // Kicker
    patMade: 1,
    fg0to39: 3,
    fg40to49: 4,
    fg50plus: 5,
    fg50to59: 5,
    fg60plus: 6,
    fgMissed: -1,
    // Defense / ST
    dstSack: 1,
    dstInterception: 2,
    dstFumbleRecovery: 2,
    dstTouchdown: 6,
    dstSafety: 2,
    dstOnePointSafety: 1,
    dstBlockKick: 2,
    dstPointsAllowed0: 10,
    dstPointsAllowed1to6: 7,
    dstPointsAllowed7to13: 4,
    dstPointsAllowed14to20: 1,
    dstPointsAllowed21to27: 0,
    dstPointsAllowed28to34: -1,
    dstPointsAllowed35plus: -4,
    dstYardsAllowed0to99: 0,
    dstYardsAllowed100to199: 0,
    dstYardsAllowed200to299: 0,
    dstYardsAllowed300to349: 0,
    dstYardsAllowed350to399: 0,
    dstYardsAllowed400to449: 0,
    dstYardsAllowed450to499: 0,
    dstYardsAllowed500to549: 0,
    dstYardsAllowed550plus: 0
  };
  const custom = seed && typeof seed === 'object' ? seed : {};
  const out = { ...base };
  for (const [key, val] of Object.entries(custom)) {
    if (val === '' || val == null) continue;
    const n = Number(val);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

function defaultIndependentRosterSlots() {
  return {
    QB: 1,
    RB: 2,
    WR: 2,
    TE: 1,
    FLEX: 1,
    SFLEX: 0,
    DST: 1,
    K: 1,
    BN: 7,
    IR: 1,
    TAXI: 0
  };
}

function normalizeRosterSlots(roster = {}) {
  const n = (val, max) => {
    if (val === '' || val == null) return 0;
    const x = Number(val);
    if (!Number.isFinite(x) || x < 0) return 0;
    return Math.min(max, Math.round(x));
  };
  const out = {
    QB: n(roster.QB, 8),
    RB: n(roster.RB, 12),
    WR: n(roster.WR, 12),
    TE: n(roster.TE, 8),
    FLEX: n(roster.FLEX, 8),
    SFLEX: n(roster.SFLEX ?? roster.SUPERFLEX, 4),
    DST: n(roster.DST, 4),
    K: n(roster.K, 4),
    BN: n(roster.BN, 30),
    IR: n(roster.IR, 10),
    TAXI: n(roster.TAXI, 10)
  };
  const starterTotal = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'SFLEX', 'DST', 'K']
    .reduce((sum, key) => sum + (Number(out[key]) || 0), 0);
  if (starterTotal === 0 && (!roster || !Object.keys(roster).length)) {
    return defaultIndependentRosterSlots();
  }
  return out;
}

function defaultIndependentSettings(seed = {}) {
  const hasPreset = Object.prototype.hasOwnProperty.call(seed, 'scoringPreset')
    || Object.prototype.hasOwnProperty.call(seed, 'preset');
  const preset = hasPreset
    ? (String(seed.scoringPreset || seed.preset || 'custom').trim() || 'custom')
    : 'custom';
  const rosterSlots = normalizeRosterSlots(seed.rosterSlots || {});
  const derivedRounds = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'SFLEX', 'DST', 'K', 'BN']
    .reduce((sum, key) => sum + (Number(rosterSlots[key]) || 0), 0);
  const formatRaw = String(seed.leagueFormat || '').trim().toLowerCase();
  const hasKeepers = Object.prototype.hasOwnProperty.call(seed, 'keepersEnabled');
  const keepersEnabled = hasKeepers
    ? Boolean(seed.keepersEnabled)
    : formatRaw === 'keeper';
  let leagueFormat = 'redraft';
  if (formatRaw === 'dynasty') leagueFormat = 'dynasty';
  else if (keepersEnabled) leagueFormat = 'keeper';
  const costRaw = String(seed.keeperCost || '').trim().toLowerCase();
  const keeperCost = !keepersEnabled
    ? 'none'
    : (costRaw === 'round' || costRaw === 'round-minus-one' ? costRaw : 'none');
  const poolRaw = String(seed.draftPool || '').trim().toLowerCase();
  const draftPool = poolRaw === 'all'
    ? 'all'
    : (poolRaw === 'rookies' || leagueFormat === 'dynasty' ? 'rookies' : 'all');
  const keeperCount = Math.max(0, Math.min(40, Number(seed.keeperCount) || 0));
  const keeperMaxSeasons = Math.max(1, Math.min(20, Number(seed.keeperMaxSeasons) || 1));
  const scopeRaw = String(seed.draftScope || '').trim().toLowerCase();
  const scope = scopeRaw === 'conference' || scopeRaw === 'league' ? scopeRaw : 'league';
  const fillRaw = String(seed.draftFillEmptySeats || '').trim().toLowerCase();
  const fill = fillRaw === 'hold' ? 'hold' : 'cpu';
  let draftAt = null;
  if (seed.draftAt) {
    const t = Date.parse(seed.draftAt);
    if (Number.isFinite(t)) draftAt = new Date(t).toISOString();
  }
  const order = Array.isArray(seed.draftOrder)
    ? seed.draftOrder.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const roundsOverride = Number(seed.draftRounds);
  const scoringSeedPreset = preset === 'custom' ? 'ppr-6' : preset;
  const scoring = defaultIndependentScoring(
    seed.scoring && typeof seed.scoring === 'object' ? seed.scoring : {},
    scoringSeedPreset
  );
  return {
    scoringPreset: preset,
    rosterSlots,
    scoring,
    draftType: String(seed.draftType || 'snake').trim() || 'snake',
    draftScope: scope,
    draftAt,
    draftRounds: Number.isFinite(roundsOverride) && roundsOverride >= 1 && roundsOverride <= 30
      ? Math.round(roundsOverride)
      : Math.max(1, Math.min(30, derivedRounds || 1)),
    draftSecondsPerPick: (() => {
      const n = Number(seed.draftSecondsPerPick);
      if ([30, 45, 60, 90, 120, 180, 240, 300].includes(n)) return n;
      return 90;
    })(),
    draftFillEmptySeats: fill,
    draftOrder: order,
    waiverType: (() => {
      const raw = String(seed.waiverType || '').trim().toLowerCase();
      if (raw === 'rolling') return 'rolling';
      if (raw === 'reverse-standings' || raw === 'reverse') return 'reverse-standings';
      return 'FAAB';
    })(),
    faabBudget: (() => {
      const n = Number(seed.faabBudget);
      if (Number.isFinite(n)) return Math.max(0, Math.min(1000, Math.round(n)));
      return 100;
    })(),
    waiverHoldHours: (() => {
      const n = Number(seed.waiverHoldHours);
      if (Number.isFinite(n)) return Math.max(0, Math.min(168, Math.round(n)));
      return 48;
    })(),
    keepersEnabled: leagueFormat === 'dynasty' ? false : keepersEnabled,
    keeperCount,
    keeperMaxSeasons,
    leagueFormat,
    keeperCost: leagueFormat === 'dynasty' ? 'none' : keeperCost,
    draftPool,
    irOpen: seed.irOpen === true,
    taxiRookieOnly: seed.taxiRookieOnly === false ? false : true,
    notes: String(seed.notes || '').trim()
  };
}

function formatIndependentRulebookFromSettings(league) {
  const s = defaultIndependentSettings(league?.settings || {});
  const slots = s.rosterSlots || {};
  const scoring = s.scoring || {};
  const structure = league?.structure || {};
  const championship = league?.championship || {};
  const payouts = league?.payouts || {};
  const confs = Array.isArray(league?.conferences) ? league.conferences : [];
  const confNames = confs.map((c) => c.name || c.shortName || c.key).filter(Boolean).join(' / ') || 'Two conferences';
  const draftAt = s.draftAt
    ? new Date(s.draftAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    : 'Not scheduled yet';
  const fillLabel = s.draftFillEmptySeats === 'hold'
    ? 'Hold until every franchise has a manager'
    : 'Empty seats filled by CPU';
  const prizes = Array.isArray(payouts.prizes) && payouts.prizes.length
    ? payouts.prizes.map((p) => `${p.label || p.name || 'Prize'}: ${p.amount != null ? `$${p.amount}` : '—'}`).join('\n')
    : 'Prize labels not set yet.';

  return [
    {
      id: 'settings-structure',
      source: 'settings',
      title: 'I. League structure',
      body: [
        `${league?.brand?.name || 'This league'} · ${structure.totalTeams || '—'} teams`
          + (structure.conferenceCount === 1
            ? ' · single conference'
            : ` (${structure.teamsPerConference || '—'} per conference)`),
        `Conferences: ${confNames || 'Not set'}.`,
        `Season ${league?.season || '—'}.`,
        structure.regularSeasonEndWeek
          ? `Regular season ends week ${structure.regularSeasonEndWeek}.`
          : null,
        payouts.buyInPerTeam != null ? `Buy-in: $${payouts.buyInPerTeam} per team.` : null,
        payouts.seasonLabel ? `Payout season: ${payouts.seasonLabel}.` : null
      ].filter(Boolean).join('\n')
    },
    {
      id: 'settings-roster',
      source: 'settings',
      title: 'II. Roster slots',
      body: [
        `QB ${slots.QB} · RB ${slots.RB} · WR ${slots.WR} · TE ${slots.TE}`,
        `FLEX ${slots.FLEX} · Superflex ${slots.SFLEX ?? 0} · DST ${slots.DST} · K ${slots.K} · BN ${slots.BN} · IR ${slots.IR ?? 0}${slots.TAXI ? ` · Taxi ${slots.TAXI}` : ''}`,
        slots.IR
          ? 'IR: only Out / IR / PUP / Doubtful (does not count against the active roster). IR does not score.'
          : 'IR slots: none.',
        s.leagueFormat === 'dynasty'
          ? 'Dynasty: entire roster carries into next season. The draft is rookies only. Taxi is for first-year players. Keepers are not used — everyone stays.'
          : s.keepersEnabled
            ? `Keepers: on · ${s.keeperCount || 1} per franchise · max ${s.keeperMaxSeasons || 3} seasons · cost: ${
              s.keeperCost === 'round' ? 'lose that draft round' : s.keeperCost === 'round-minus-one' ? 'lose that round, one round earlier each year' : 'no draft-pick cost'
            }.`
            : 'Keepers: off. Full redraft each season.'
      ].join('\n')
    },
    {
      id: 'settings-scoring',
      source: 'settings',
      title: 'III. Scoring',
      body: [
        `Preset: ${s.scoringPreset || 'Custom'}.`,
        `Passing (QB): ${scoring.passingYardsPerPoint || '—'} yards/point · TD ${scoring.passingTD ?? '—'} · INT ${scoring.interception ?? '—'} · 2-pt ${scoring.passing2pt ?? scoring.twoPointConversion ?? '—'}.`,
        `Rushing: ${scoring.rushingYardsPerPoint || '—'} yards/point · TD ${scoring.rushingTD ?? '—'} · 2-pt ${scoring.rushing2pt ?? scoring.twoPointConversion ?? '—'}.`,
        `Receiving: ${scoring.receivingYardsPerPoint || '—'} yards/point · TD ${scoring.receivingTD ?? '—'} · Reception ${scoring.reception ?? '—'} · 2-pt ${scoring.receiving2pt ?? scoring.twoPointConversion ?? '—'}.`,
        `Fumble lost ${scoring.fumbleLost ?? '—'} · ST TD ${scoring.specialTeamsTD ?? '—'}.`,
        `Kicker: PAT ${scoring.patMade ?? '—'} · FG 0–39 ${scoring.fg0to39 ?? '—'} · 40–49 ${scoring.fg40to49 ?? '—'} · 50–59 ${scoring.fg50to59 ?? scoring.fg50plus ?? '—'} · 60+ ${scoring.fg60plus ?? scoring.fg50plus ?? '—'} · Miss ${scoring.fgMissed ?? '—'}.`,
        `DST: Sack ${scoring.dstSack ?? '—'} · INT ${scoring.dstInterception ?? '—'} · FR ${scoring.dstFumbleRecovery ?? '—'} · TD ${scoring.dstTouchdown ?? '—'} · Safety ${scoring.dstSafety ?? '—'} · 1-pt safety ${scoring.dstOnePointSafety ?? '—'} · Block ${scoring.dstBlockKick ?? '—'}.`,
        `DST points allowed: 0=${scoring.dstPointsAllowed0 ?? '—'}, 1–6=${scoring.dstPointsAllowed1to6 ?? '—'}, 7–13=${scoring.dstPointsAllowed7to13 ?? '—'}, 14–20=${scoring.dstPointsAllowed14to20 ?? '—'}, 21–27=${scoring.dstPointsAllowed21to27 ?? '—'}, 28–34=${scoring.dstPointsAllowed28to34 ?? '—'}, 35+=${scoring.dstPointsAllowed35plus ?? '—'}.`,
        `DST yards allowed: ≤99=${scoring.dstYardsAllowed0to99 ?? 0}, 100–199=${scoring.dstYardsAllowed100to199 ?? 0}, 200–299=${scoring.dstYardsAllowed200to299 ?? 0}, 350–399=${scoring.dstYardsAllowed350to399 ?? 0}, 400–449=${scoring.dstYardsAllowed400to449 ?? 0}, 550+=${scoring.dstYardsAllowed550plus ?? 0}.`
      ].join('\n')
    },
    {
      id: 'settings-draft',
      source: 'settings',
      title: 'IV. Draft',
      body: [
        s.draftScope === 'conference' && (structure.conferenceCount || 2) > 1
          ? 'Each conference drafts independently (separate snake boards).'
          : 'One league-wide snake draft.',
        `Type: ${s.draftType || 'snake'} · ${s.draftRounds || '—'} rounds · ${s.draftSecondsPerPick || '—'}s per pick.`,
        s.draftPool === 'rookies' || s.leagueFormat === 'dynasty'
          ? 'Draft pool: rookies (players already on rosters stay put).'
          : 'Draft pool: full player pool.',
        'Managers pick while on the clock; CPU autopicks when time expires.',
        `Empty seats: ${fillLabel}.`,
        `Scheduled: ${draftAt}.`,
        s.waiverType === 'FAAB'
          ? `Waivers: FAAB ($${s.faabBudget} budget). Dropped players stay on waivers ${s.waiverHoldHours} hours, then become free agents.`
          : s.waiverType === 'rolling'
            ? `Waivers: rolling priority. Dropped players stay on waivers ${s.waiverHoldHours} hours.`
            : `Waivers: reverse standings. Dropped players stay on waivers ${s.waiverHoldHours} hours.`
      ].filter(Boolean).join('\n')
    },
    {
      id: 'settings-playoffs',
      source: 'settings',
      title: 'V. Playoffs',
      body: [
        structure.playoffFormat === 'league-bracket' || structure.conferenceCount === 1
          ? `League playoff bracket · ${structure.playoffTeamCount || '—'} teams.`
          : `Each conference runs its own playoff (${structure.playoffTeamsPerConference || '—'} teams per conference · ${structure.playoffTeamCount || '—'} total).`,
        `Playoff weeks: ${(structure.playoffWeeks || []).join(', ') || 'Not set'}.`,
        `Seeding: ${structure.playoffSeedingRule === 'points' ? 'total points' : 'record (then points)'}.`,
        `Reseed after each round: ${structure.playoffReseed === false ? 'off' : 'on'}.`,
        structure.thirdPlaceEnabled ? 'Third-place game: on.' : null,
        championship.name
          ? `${championship.name}${championship.bowlWeek ? ` (week ${championship.bowlWeek})` : ''}${championship.titleWeek ? ` · conference title week ${championship.titleWeek}` : ''}.`
          : 'Championship name not set yet — the title game uses this league’s name.'
      ].filter(Boolean).join('\n')
    },
    {
      id: 'settings-payouts',
      source: 'settings',
      title: 'VI. Payouts',
      body: [
        payouts.buyInPerTeam != null ? `Buy-in $${payouts.buyInPerTeam} × ${payouts.teamCount || structure.totalTeams || '—'} teams.` : 'Buy-in not set.',
        prizes,
        payouts.notes || null
      ].filter(Boolean).join('\n')
    }
  ];
}

function defaultIndependentRulebook(seed = {}) {
  // Owner-authored policy only. Roster / scoring / draft / playoffs / payouts come from settings.
  const articlesIn = Array.isArray(seed.articles) ? seed.articles : null;
  const articles = (articlesIn && articlesIn.length
    ? articlesIn
    : [
      {
        id: 'owner-overview',
        title: 'House rules',
        body: 'Add conduct, trade vetoes, dues deadlines, and anything unique to your league.'
      },
      {
        id: 'owner-waivers',
        title: 'Waivers, trades & free agency',
        body: 'House policy on top of the wire: trade blackout dates, bidding etiquette, or extra veto rules. The platform already runs FAAB or rolling claims, free agents, and manager-to-manager trades.'
      }
    ]
  )
    .slice(0, 24)
    .map((a, i) => ({
      id: String(a?.id || `owner-${i + 1}`).trim() || `owner-${i + 1}`,
      source: 'owner',
      title: String(a?.title || `House rule ${i + 1}`).trim().slice(0, 120) || `House rule ${i + 1}`,
      body: String(a?.body || '').trim().slice(0, 12000)
    }))
    .filter((a) => a.title);
  return {
    articles,
    updatedAt: seed.updatedAt || null,
    updatedByName: seed.updatedByName ? String(seed.updatedByName).trim().slice(0, 80) : null
  };
}

function composeIndependentRulebook(league) {
  const owned = defaultIndependentRulebook(league?.rulebook || {});
  const fromSettings = formatIndependentRulebookFromSettings(league);
  // Settings sections first (facts), then owner house rules.
  const sections = [
    ...fromSettings,
    ...owned.articles.map((a) => ({ ...a, source: 'owner' }))
  ];
  return {
    ...owned,
    sections
  };
}

function normalizeIndependentStructure(seed = {}, league = null) {
  const existing = league?.structure || {};
  const src = { ...existing, ...(seed && typeof seed === 'object' ? seed : {}) };
  const confLen = Array.isArray(league?.conferences) ? league.conferences.length : 0;
  let conferenceCount = Number(src.conferenceCount);
  if (!Number.isFinite(conferenceCount) || conferenceCount < 1) {
    conferenceCount = confLen === 1 ? 1 : 2;
  }
  conferenceCount = conferenceCount <= 1 ? 1 : 2;

  let teamsPerConference = Number(src.teamsPerConference);
  let totalTeams = Number(src.totalTeams);

  if (conferenceCount === 1) {
    if (!Number.isFinite(totalTeams) || totalTeams < 2) {
      totalTeams = Number.isFinite(teamsPerConference) && teamsPerConference >= 2
        ? teamsPerConference
        : 0;
    }
    totalTeams = Math.max(0, Math.min(32, Math.round(totalTeams) || 0));
    teamsPerConference = totalTeams;
  } else {
    if (!Number.isFinite(teamsPerConference) || teamsPerConference < 2) {
      if (Number.isFinite(totalTeams) && totalTeams >= 2) {
        teamsPerConference = Math.max(2, Math.round(totalTeams / 2));
      } else {
        teamsPerConference = 0;
      }
    }
    teamsPerConference = Math.max(0, Math.min(20, Math.round(teamsPerConference) || 0));
    totalTeams = teamsPerConference > 0 ? teamsPerConference * 2 : 0;
  }

  let playoffTeamsPerConference = Number(src.playoffTeamsPerConference);
  let playoffTeamCount = Number(src.playoffTeamCount);
  if (conferenceCount === 1) {
    if (!Number.isFinite(playoffTeamCount) || playoffTeamCount < 0) {
      playoffTeamCount = Number.isFinite(playoffTeamsPerConference) ? playoffTeamsPerConference : 0;
    }
    playoffTeamCount = Math.max(0, Math.min(totalTeams || 32, Math.round(playoffTeamCount) || 0));
    playoffTeamsPerConference = playoffTeamCount;
  } else {
    if (!Number.isFinite(playoffTeamsPerConference) || playoffTeamsPerConference < 0) {
      if (Number.isFinite(playoffTeamCount) && playoffTeamCount >= 0) {
        playoffTeamsPerConference = playoffTeamCount <= (teamsPerConference || playoffTeamCount)
          ? playoffTeamCount
          : Math.ceil(playoffTeamCount / 2);
      } else {
        playoffTeamsPerConference = 0;
      }
    }
    playoffTeamsPerConference = Math.max(
      0,
      Math.min(teamsPerConference || 20, Math.round(playoffTeamsPerConference) || 0)
    );
    playoffTeamCount = playoffTeamsPerConference * 2;
  }

  let playoffWeeks = Array.isArray(src.playoffWeeks)
    ? src.playoffWeeks.map(Number).filter((n) => Number.isFinite(n) && n >= 1 && n <= 18)
    : [];
  playoffWeeks = [...new Set(playoffWeeks)].sort((a, b) => a - b).slice(0, 8);
  let regularSeasonEndWeek = Number.isFinite(Number(src.regularSeasonEndWeek))
    ? Math.max(0, Math.min(18, Number(src.regularSeasonEndWeek)))
    : (playoffWeeks[0] ? Math.max(0, playoffWeeks[0] - 1) : 0);

  let format = String(src.playoffFormat || '').trim().toLowerCase();
  if (format !== 'league-bracket' && format !== 'conference-brackets') {
    format = conferenceCount === 1 ? 'league-bracket' : 'conference-brackets';
  }
  if (conferenceCount === 1) format = 'league-bracket';

  const playoffReseed = src.playoffReseed !== false && src.playoffReseed !== '0';
  const seedRaw = String(src.playoffSeedingRule || src.seedingRule || '').trim().toLowerCase();
  const playoffSeedingRule = seedRaw === 'points' || seedRaw === 'total_points' || seedRaw === 'total_points_scored'
    ? 'points'
    : 'record';
  const thirdPlaceEnabled = src.thirdPlaceEnabled === true || src.thirdPlaceEnabled === '1';

  if (!regularSeasonEndWeek) regularSeasonEndWeek = 13;
  if (!playoffWeeks.length && playoffTeamCount >= 2) {
    const perTree = format === 'league-bracket'
      ? playoffTeamCount
      : playoffTeamsPerConference;
    const n = Math.max(2, perTree || 2);
    const confRounds = Math.ceil(Math.log2(n));
    const extra = format === 'conference-brackets' && conferenceCount === 2 ? 1 : 0;
    const total = Math.max(1, confRounds + extra);
    for (let i = 0; i < total; i += 1) {
      playoffWeeks.push(Math.min(18, regularSeasonEndWeek + 1 + i));
    }
  }

  return {
    conferenceCount,
    teamsPerConference,
    totalTeams,
    playoffTeamsPerConference,
    playoffTeamCount,
    playoffWeeks,
    regularSeasonEndWeek,
    playoffFormat: format,
    playoffReseed,
    playoffSeedingRule,
    thirdPlaceEnabled
  };
}

function normalizeIndependentChampionship(seed = {}, league = null) {
  const existing = league?.championship || {};
  const src = { ...existing, ...(seed && typeof seed === 'object' ? seed : {}) };
  const titleWeek = Number.isFinite(Number(src.titleWeek))
    ? Math.max(1, Math.min(18, Number(src.titleWeek)))
    : null;
  const bowlWeek = Number.isFinite(Number(src.bowlWeek))
    ? Math.max(titleWeek || 1, Math.min(18, Number(src.bowlWeek)))
    : null;
  const formatRaw = String(src.format || '').trim().toLowerCase();
  const format = formatRaw === 'single-bracket' || formatRaw === 'super-bowl'
    ? formatRaw
    : (league?.structure?.conferenceCount === 1 ? 'single-bracket' : 'super-bowl');
  return {
    ...existing,
    name: String(src.name || existing.name || '').trim().slice(0, 80),
    titleWeek,
    bowlWeek,
    format,
    logo: src.logo || existing.logo || null,
    confChampLogos: existing.confChampLogos || src.confChampLogos || {},
    thirdPlaceLogos: existing.thirdPlaceLogos || src.thirdPlaceLogos || {}
  };
}

function normalizeIndependentConferences(patchList, league) {
  const current = Array.isArray(league?.conferences) ? league.conferences.slice() : [];
  if (!Array.isArray(patchList) || !patchList.length) return current;
  const count = Math.max(1, Math.min(2, patchList.length));
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const p = patchList[i] || {};
    const cur = current[i] || {};
    const name = String(p.name || cur.name || `Conference ${i + 1}`).trim().slice(0, 48)
      || `Conference ${i + 1}`;
    const shortName = String(p.shortName || cur.shortName || name).trim().toUpperCase().slice(0, 12)
      || name.slice(0, 4).toUpperCase();
    const key = String(cur.key || p.key || `conference${i + 1}`).trim() || `conference${i + 1}`;
    out.push({
      ...cur,
      key,
      name,
      shortName,
      color: p.color || cur.color || null,
      logo: cur.logo || null,
      espnLeagueId: null,
      isRulesPrimary: i === 0
    });
  }
  return out;
}

function defaultIndependentDraft(seed = {}) {
  const status = ['scheduled', 'live', 'complete', 'cancelled'].includes(String(seed.status || ''))
    ? String(seed.status)
    : 'scheduled';
  return {
    status,
    roomIds: Array.isArray(seed.roomIds) ? seed.roomIds.map(String) : [],
    order: Array.isArray(seed.order) ? seed.order.map(String) : [],
    picks: Array.isArray(seed.picks) ? seed.picks : [],
    startedAt: seed.startedAt || null,
    completedAt: seed.completedAt || null
  };
}

/** Allowed franchise counts when submitting a new independent league for approval. */
const ALLOWED_INDEPENDENT_TEAM_COUNTS = Object.freeze([8, 10, 12, 14, 16, 18, 20, 24]);

function buildPlaceholderFranchises(conferences, teamsPerConference, customList) {
  if (Array.isArray(customList) && customList.length) {
    return customList.map((row, index) => ({
      id: String(row.id || `franchise-${index + 1}`),
      conferenceKey: String(row.conferenceKey || conferences[0]?.key || 'conferencea'),
      name: String(row.name || `Franchise ${index + 1}`).replace(/\s+/g, ' ').trim().slice(0, FRANCHISE_NAME_MAX)
        || `Franchise ${index + 1}`,
      abbrev: String(row.abbrev || '').trim().toUpperCase().slice(0, 4) || null,
      slot: Number(row.slot) || index + 1,
      managerUserId: row.managerUserId || null,
      managerName: row.managerName ? String(row.managerName).trim() : null,
      roster: Array.isArray(row.roster) ? row.roster : []
    }));
  }
  const out = [];
  const confs = Array.isArray(conferences) && conferences.length ? conferences : [{ key: 'league', shortName: 'TEAM', name: 'League' }];
  const n = Math.max(0, Math.min(24, Number(teamsPerConference) || 0));
  confs.forEach((conf) => {
    for (let i = 1; i <= n; i++) {
      out.push({
        id: `franchise-${conf.key}-${i}`,
        conferenceKey: conf.key,
        name: `${conf.shortName || conf.name || 'Team'} ${i}`,
        abbrev: null,
        slot: i,
        managerUserId: null,
        managerName: null,
        roster: []
      });
    }
  });
  return out;
}

function defaultIndependentCalendar(seed = {}, league = null) {
  const incoming = Array.isArray(seed) ? seed : [];
  const survivalOn = league?.survival?.enabled === true;
  const champName = String(league?.championship?.name || '').trim();
  return incoming.map((e) => ({
    title: String(e.title || e.label || 'Event').trim().slice(0, 80),
    type: String(e.type || 'event').trim().slice(0, 32),
    date: String(e.date || '').trim().slice(0, 32),
    notes: String(e.notes || '').trim().slice(0, 500)
  })).filter((e) => {
    if (!e.title) return false;
    const type = String(e.type || '').toLowerCase();
    if (!survivalOn && (type === 'survival' || /mayor'?s\s*cup/i.test(e.title))) return false;
    if (!champName && type === 'bowl') return false;
    return true;
  });
}

function vanillaIndependentTemplate() {
  const year = new Date().getFullYear();
  return {
    platform: 'independent',
    season: year,
    brand: {
      name: '',
      tagline: '',
      slug: ''
    },
    conferences: [
      {
        key: 'east',
        name: 'East Conference',
        shortName: 'EAST',
        color: '#ff7a18',
        espnLeagueId: null
      },
      {
        key: 'west',
        name: 'West Conference',
        shortName: 'WEST',
        color: '#e2232a',
        espnLeagueId: null
      }
    ],
    championship: {
      name: '',
      titleWeek: 16,
      bowlWeek: 17,
      format: 'super-bowl'
    },
    structure: {
      teamsPerConference: 12,
      totalTeams: 24,
      playoffTeamsPerConference: 6,
      playoffTeamCount: 12,
      playoffWeeks: [14, 15, 16],
      regularSeasonEndWeek: 13,
      playoffFormat: 'conference-brackets',
      playoffReseed: true,
      playoffSeedingRule: 'record',
      thirdPlaceEnabled: false
    },
    settings: defaultIndependentSettings({
      scoringPreset: 'ppr-6',
      rosterSlots: defaultIndependentRosterSlots(),
      draftScope: 'conference',
      draftSecondsPerPick: 90,
      draftFillEmptySeats: 'cpu',
      waiverType: 'FAAB',
      keepersEnabled: false,
      keeperCount: 0,
      keeperMaxSeasons: 1
    }),
    rulebook: defaultIndependentRulebook(),
    survival: defaultSurvival({ enabled: false }),
    payouts: {
      seasonLabel: `${year} Season`,
      buyInPerTeam: 100,
      teamCount: 24,
      currency: 'USD',
      notes: '',
      prizes: [
        { place: 1, label: 'League Champion', amount: 1000 },
        { place: 2, label: 'Runner-Up', amount: 500 }
      ]
    },
    calendarDefaults: defaultIndependentCalendar()
  };
}

function createLeague({
  id: requestedId = null,
  ownerUserId,
  season,
  brand,
  conferences,
  championship,
  structure,
  payouts,
  calendarDefaults,
  uploadedAssets = {},
  activate = false
}) {
  const store = readStore();
  const brandName = String(brand?.name || '').trim();
  if (!brandName) throw Object.assign(new Error('League name is required'), { status: 400 });

  let slug = slugify(brand?.slug || brandName);
  if (!slug) slug = `league-${crypto.randomBytes(3).toString('hex')}`;
  if (store.leagues.some((l) => l.slug === slug)) {
    slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
  }

  const confInputs = Array.isArray(conferences) ? conferences : [];
  if (confInputs.length !== 2) {
    throw Object.assign(new Error('Exactly two conferences are required'), { status: 400 });
  }
  const normalizedConfs = confInputs.map((c, i) => normalizeConferenceInput(c, i, uploadedAssets, { requireEspn: true }));
  if (normalizedConfs[0].key === normalizedConfs[1].key) {
    normalizedConfs[1].key = `${normalizedConfs[1].key}b`;
  }
  normalizedConfs[0].isRulesPrimary = true;
  normalizedConfs[1].isRulesPrimary = false;

  const year = Number(season) || new Date().getFullYear();
  const teamsPerConference = Number(structure?.teamsPerConference) || 12;
  const totalTeams = Number(structure?.totalTeams) || teamsPerConference * 2;
  const buyIn = Number(payouts?.buyInPerTeam) || 0;

  const champName = String(championship?.name || `${brandName} Championship`).trim();
  const titleWeek = Number(championship?.titleWeek) || 16;
  const bowlWeek = Number(championship?.bowlWeek) || 17;

  const leagueId = requestedId && !store.leagues.some((l) => l.id === requestedId)
    ? String(requestedId)
    : crypto.randomUUID();

  const league = {
    id: leagueId,
    slug,
    status: activate ? 'active' : 'ready',
    platform: 'espn',
    isSystem: false,
    season: year,
    brand: {
      name: brandName,
      tagline: String(brand?.tagline || '').trim(),
      logo: uploadedAssets.brandLogo || brand?.logo || null,
      crest: uploadedAssets.brandCrest || brand?.crest || uploadedAssets.brandLogo || brand?.logo || null
    },
    conferences: normalizedConfs.map((c, i) => ({
      ...c,
      logo: c.logo || uploadedAssets[`conferenceLogo${i}`] || null
    })),
    championship: {
      name: champName,
      logo: uploadedAssets.championshipLogo || championship?.logo || null,
      titleWeek,
      bowlWeek,
      confChampLogos: {
        [normalizedConfs[0].key]: uploadedAssets.confChampLogo0 || championship?.confChampLogos?.[normalizedConfs[0].key] || null,
        [normalizedConfs[1].key]: uploadedAssets.confChampLogo1 || championship?.confChampLogos?.[normalizedConfs[1].key] || null
      },
      thirdPlaceLogos: {
        [normalizedConfs[0].key]: uploadedAssets.thirdPlaceLogo0 || championship?.thirdPlaceLogos?.[normalizedConfs[0].key] || null,
        [normalizedConfs[1].key]: uploadedAssets.thirdPlaceLogo1 || championship?.thirdPlaceLogos?.[normalizedConfs[1].key] || null
      }
    },
    structure: {
      teamsPerConference,
      totalTeams,
      playoffTeamCount: Number(structure?.playoffTeamCount) || 6,
      playoffWeeks: Array.isArray(structure?.playoffWeeks) && structure.playoffWeeks.length
        ? structure.playoffWeeks.map(Number)
        : [14, 15, 16]
    },
    payouts: {
      seasonLabel: String(payouts?.seasonLabel || `${year} Season`).trim(),
      buyInPerTeam: buyIn,
      teamCount: totalTeams,
      currency: String(payouts?.currency || 'USD').trim() || 'USD',
      notes: String(payouts?.notes || '').trim(),
      prizes: (Array.isArray(payouts?.prizes) ? payouts.prizes : []).map(normalizePrize)
    },
    calendarDefaults: Array.isArray(calendarDefaults) ? calendarDefaults : [],
    survival: defaultSurvival(),
    affiliatedLeagues: defaultAffiliatedLeagues(),
    ownerUserId: ownerUserId || null,
    createdAt: new Date().toISOString(),
    activatedAt: activate ? new Date().toISOString() : null
  };

  store.leagues.push(league);
  if (activate) {
    store.activeLeagueId = league.id;
    league.status = 'active';
    league.activatedAt = league.activatedAt || new Date().toISOString();
  }
  writeStore(store);
  return publicLeague(league);
}

function ensureSystemLeague(seed) {
  const store = readStore();
  let system = store.leagues.find((l) => l.isSystem || l.slug === 'gridiron24');
  if (system) {
    let dirty = false;
    if (!system.survival) {
      system.survival = defaultSurvival(seed.survival);
      dirty = true;
    }
    if (!Array.isArray(system.affiliatedLeagues)) {
      system.affiliatedLeagues = defaultAffiliatedLeagues(seed.affiliatedLeagues);
      dirty = true;
    } else {
      const seeded = defaultAffiliatedLeagues(seed.affiliatedLeagues);
      system.affiliatedLeagues = system.affiliatedLeagues.map((row) => {
        const match = seeded.find((s) => s.key === row.key) || seeded[0] || {};
        let next = row;
        const needsPayouts = !(row.payouts?.buyInPerTeam != null
          && Array.isArray(row.payouts?.prizes)
          && row.payouts.prizes.length);
        const needsRange = row.payouts && (row.payouts.teamCountMin == null || row.payouts.teamCountMax == null);
        if (needsPayouts || needsRange) {
          dirty = true;
          next = {
            ...next,
            payouts: defaultAaaPayouts(match.payouts || row.payouts || {})
          };
        }
        if (!row.logo || (match.logo && String(row.logo) !== String(match.logo))) {
          dirty = true;
          next = {
            ...next,
            logo: match.logo || '/assets/aaa-league.png?v=7'
          };
        }
        const seedEspn = Number(match.espnLeagueId);
        const rowEspn = Number(row.espnLeagueId);
        if ((!Number.isFinite(rowEspn) || rowEspn <= 0) && Number.isFinite(seedEspn) && seedEspn > 0) {
          dirty = true;
          next = {
            ...next,
            espnLeagueId: seedEspn
          };
        }
        return next;
      });
    }
    const hasSurvivalCal = (system.calendarDefaults || []).some(
      (e) => String(e.type || '').toLowerCase() === 'survival'
        || /stay in league|toilet\s*bowl|mayor's cup/i.test(String(e.title || ''))
    );
    if (!hasSurvivalCal) {
      const fromSeed = (seed.calendarDefaults || []).find(
        (e) => String(e.type || '').toLowerCase() === 'survival'
      );
      system.calendarDefaults = [
        ...(system.calendarDefaults || []),
        fromSeed || {
          title: "Mayor's Cup",
          type: 'survival',
          date: '2026-12-29',
          notes: 'Week 17 — relegated Detail vs relegated Overtime (PF tiebreaker for last place).'
        }
      ];
      dirty = true;
    }
    if (system.survival && /stay in league|toilet\s*bowl/i.test(String(system.survival.name || ''))) {
      system.survival.name = "Mayor's Cup";
      dirty = true;
    }
    const calStay = (system.calendarDefaults || []).find((e) => /stay in league|toilet\s*bowl/i.test(String(e.title || '')));
    if (calStay) {
      calStay.title = "Mayor's Cup";
      if (!/relegat|pf|mayor/i.test(String(calStay.notes || ''))) {
        calStay.notes = 'Week 17 — relegated Detail vs relegated Overtime (PF tiebreaker for last place).';
      }
      dirty = true;
    }
    const hasAaaCal = (system.calendarDefaults || []).some(
      (e) => String(e.type || '').toLowerCase() === 'aaa'
        || /aaa\s*(super\s*)?bowl|aaa\s*championship/i.test(String(e.title || ''))
    );
    if (!hasAaaCal) {
      const fromSeed = (seed.calendarDefaults || []).find(
        (e) => String(e.type || '').toLowerCase() === 'aaa'
      );
      system.calendarDefaults = [
        ...(system.calendarDefaults || []),
        fromSeed || {
          title: 'AAA Super Bowl',
          type: 'aaa',
          date: '2026-12-29',
          notes: 'AAA League championship — ESPN title game. Winner promotes to GridIron 24 next season.'
        }
      ];
      dirty = true;
    }
    if (Array.isArray(system.conferences) && Array.isArray(seed.conferences)) {
      system.conferences = system.conferences.map((row) => {
        const match = seed.conferences.find((s) => s.key === row.key);
        const rowEspn = Number(row.espnLeagueId);
        const seedEspn = Number(match?.espnLeagueId);
        // Recreated 2026 Detail / Overtime leagues — replace retired ESPN IDs in place.
        if (row.key === 'detail' && rowEspn === 559054421 && seedEspn === 1444967743) {
          dirty = true;
          return { ...row, espnLeagueId: seedEspn };
        }
        if (row.key === 'overtime' && rowEspn === 236438046 && seedEspn === 952732392) {
          dirty = true;
          return { ...row, espnLeagueId: seedEspn };
        }
        if ((!Number.isFinite(rowEspn) || rowEspn <= 0) && Number.isFinite(seedEspn) && seedEspn > 0) {
          dirty = true;
          return { ...row, espnLeagueId: seedEspn };
        }
        return row;
      });
    }
    if (!store.activeLeagueId) {
      store.activeLeagueId = system.id;
      dirty = true;
    }
    if (!Array.isArray(system.historySeasons)) {
      system.historySeasons = Array.isArray(seed.historySeasons)
        ? normalizeHistorySeasons(seed.historySeasons)
        : [];
      dirty = true;
    }
    if (dirty) writeStore(store);
    return publicLeague(system);
  }

  const confs = (seed.conferences || []).map((c, i) => ({
    key: c.key,
    name: c.name,
    shortName: c.shortName,
    espnLeagueId: c.espnLeagueId,
    logo: c.logo || null,
    color: i === 0 ? '#ff7a18' : '#e2232a',
    isRulesPrimary: i === 0
  }));

  system = {
    id: 'system-gridiron24',
    slug: 'gridiron24',
    status: 'active',
    isSystem: true,
    season: seed.season,
    brand: {
      name: seed.brand?.name || 'GridIron 24',
      tagline: seed.brand?.tagline || '',
      logo: '/assets/gridiron24-league.png?v=8',
      crest: '/assets/gridiron24-league.png?v=8'
    },
    conferences: confs,
    championship: {
      name: 'GridIron Bowl',
      logo: '/assets/gridiron-bowl.png?v=6',
      titleWeek: 16,
      bowlWeek: 17,
      confChampLogos: {
        detail: '/assets/detail-conf-champ.png',
        overtime: '/assets/overtime-conf-champ.png'
      },
      thirdPlaceLogos: {
        detail: '/assets/detail-3rd-place.png',
        overtime: '/assets/overtime-3rd-place.png'
      }
    },
    structure: {
      teamsPerConference: 12,
      totalTeams: 24,
      playoffTeamCount: 6,
      playoffWeeks: [14, 15, 16]
    },
    payouts: seed.payouts || {
      seasonLabel: `${seed.season} Season`,
      buyInPerTeam: 100,
      teamCount: 24,
      currency: 'USD',
      notes: '',
      prizes: []
    },
    calendarDefaults: seed.calendarDefaults || [],
    survival: defaultSurvival(seed.survival),
    affiliatedLeagues: defaultAffiliatedLeagues(seed.affiliatedLeagues),
    historySeasons: normalizeHistorySeasons(seed.historySeasons || []),
    ownerUserId: null,
    createdAt: new Date().toISOString(),
    activatedAt: new Date().toISOString()
  };

  store.leagues.unshift(system);
  store.activeLeagueId = system.id;
  writeStore(store);
  return publicLeague(system);
}

function updateLeagueAssets(leagueId, assetMap) {
  const store = readStore();
  const idx = store.leagues.findIndex((l) => l.id === leagueId);
  if (idx === -1) throw Object.assign(new Error('League not found'), { status: 404 });
  const league = store.leagues[idx];
  if (assetMap.brandLogo) league.brand.logo = assetMap.brandLogo;
  if (assetMap.brandCrest) league.brand.crest = assetMap.brandCrest;
  if (assetMap.championshipLogo) league.championship.logo = assetMap.championshipLogo;
  league.conferences.forEach((c, i) => {
    const k = `conferenceLogo${i}`;
    if (assetMap[k]) c.logo = assetMap[k];
  });
  const keys = league.conferences.map((c) => c.key);
  if (assetMap.confChampLogo0 && keys[0]) league.championship.confChampLogos[keys[0]] = assetMap.confChampLogo0;
  if (assetMap.confChampLogo1 && keys[1]) league.championship.confChampLogos[keys[1]] = assetMap.confChampLogo1;
  if (assetMap.thirdPlaceLogo0 && keys[0]) league.championship.thirdPlaceLogos[keys[0]] = assetMap.thirdPlaceLogo0;
  if (assetMap.thirdPlaceLogo1 && keys[1]) league.championship.thirdPlaceLogos[keys[1]] = assetMap.thirdPlaceLogo1;
  writeStore(store);
  return publicLeague(league);
}

function createIndependentLeague({
  id: requestedId = null,
  ownerUserId,
  ownerName = null,
  ownerEmail = null,
  season,
  brand,
  conferences,
  championship,
  structure,
  payouts,
  calendarDefaults,
  settings,
  rulebook,
  franchises,
  survival,
  uploadedAssets = {}
}) {
  const store = readStore();
  const brandName = String(brand?.name || '').trim();
  if (!brandName) throw Object.assign(new Error('League name is required'), { status: 400 });

  const slug = allocateLeagueSlug(brand?.slug || brandName, store.leagues);

  // Registration only — ignore any full-wizard payload. Placeholders until post-approval setup.
  const conferenceCountWanted = Number(structure?.conferenceCount) === 2 ? 2 : 1;
  let confInputs = conferenceCountWanted === 2
    ? [
        { name: 'East Conference', key: 'east', shortName: 'EAST', color: '#ff7a18' },
        { name: 'West Conference', key: 'west', shortName: 'WEST', color: '#e2232a' }
      ]
    : [{ name: 'League', key: 'league', shortName: 'LG', color: '#c9a227' }];
  const normalizedConfs = confInputs.map((c, i) =>
    normalizeConferenceInput(c, i, uploadedAssets, { requireEspn: false })
  );
  if (normalizedConfs.length === 2 && normalizedConfs[0].key === normalizedConfs[1].key) {
    normalizedConfs[1].key = `${normalizedConfs[1].key}b`;
  }
  normalizedConfs[0].isRulesPrimary = true;
  if (normalizedConfs[1]) normalizedConfs[1].isRulesPrimary = false;

  const year = Number(season) || new Date().getFullYear();
  const totalRequested = Number(structure?.totalTeams);
  const structureSeed = {
    conferenceCount: normalizedConfs.length,
    ...(structure || {})
  };
  if (normalizedConfs.length === 2 && Number.isFinite(totalRequested) && totalRequested >= 2) {
    structureSeed.teamsPerConference = Math.round(totalRequested / 2);
    structureSeed.totalTeams = structureSeed.teamsPerConference * 2;
  }
  const structureNorm = normalizeIndependentStructure(structureSeed, {
    conferences: normalizedConfs,
    structure: structureSeed
  });
  const teamsPerConference = structureNorm.teamsPerConference;
  const totalTeams = structureNorm.totalTeams;
  if (!ALLOWED_INDEPENDENT_TEAM_COUNTS.includes(totalTeams)) {
    throw Object.assign(
      new Error(`Team count must be one of: ${ALLOWED_INDEPENDENT_TEAM_COUNTS.join(', ')}`),
      { status: 400 }
    );
  }
  if (normalizedConfs.length === 2 && totalTeams % 2 !== 0) {
    throw Object.assign(new Error('Two-conference leagues need an even team count'), { status: 400 });
  }
  const buyIn = Number(payouts?.buyInPerTeam) || 0;
  const champName = String(championship?.name || '').trim();
  const leagueSettings = defaultIndependentSettings({
    ...(settings || {}),
    draftScope: normalizedConfs.length === 2 ? 'conference' : 'league'
  });
  const franchiseList = buildPlaceholderFranchises(normalizedConfs, teamsPerConference, franchises);

  const leagueId = requestedId && !store.leagues.some((l) => l.id === requestedId)
    ? String(requestedId)
    : crypto.randomUUID();

  const now = new Date().toISOString();
  const league = {
    id: leagueId,
    slug,
    status: 'pending_approval',
    platform: 'independent',
    isSystem: false,
    season: year,
    leagueType: normalizedConfs.length === 2 ? 'two-conferences' : 'one-conference',
    setupComplete: false,
    brand: {
      name: brandName,
      tagline: String(brand?.tagline || '').trim(),
      logo: uploadedAssets.brandLogo || brand?.logo || null,
      crest: uploadedAssets.brandCrest || brand?.crest || uploadedAssets.brandLogo || brand?.logo || null
    },
    conferences: normalizedConfs.map((c, i) => ({
      ...c,
      espnLeagueId: null,
      logo: c.logo || uploadedAssets[`conferenceLogo${i}`] || null
    })),
    championship: {
      name: champName,
      logo: uploadedAssets.championshipLogo || championship?.logo || null,
      titleWeek: championship?.titleWeek ?? null,
      bowlWeek: championship?.bowlWeek ?? null,
      confChampLogos: Object.fromEntries(
        normalizedConfs.map((c, i) => [
          c.key,
          uploadedAssets[`confChampLogo${i}`] || championship?.confChampLogos?.[c.key] || null
        ])
      ),
      thirdPlaceLogos: Object.fromEntries(
        normalizedConfs.map((c, i) => [
          c.key,
          uploadedAssets[`thirdPlaceLogo${i}`] || championship?.thirdPlaceLogos?.[c.key] || null
        ])
      )
    },
    structure: structureNorm,
    settings: leagueSettings,
    rulebook: defaultIndependentRulebook(rulebook || {}),
    draft: defaultIndependentDraft(),
    franchises: franchiseList,
    payouts: {
      seasonLabel: String(payouts?.seasonLabel || `${year} Season`).trim(),
      buyInPerTeam: buyIn,
      teamCount: totalTeams,
      currency: String(payouts?.currency || 'USD').trim() || 'USD',
      notes: String(payouts?.notes || '').trim(),
      prizes: (Array.isArray(payouts?.prizes) ? payouts.prizes : []).map(normalizePrize)
    },
    calendarDefaults: calendarDefaults != null
      ? defaultIndependentCalendar(calendarDefaults, {
          brand: { name: brandName },
          conferences: normalizedConfs,
          championship: { name: champName },
          survival: survival || { enabled: false }
        })
      : [],
    survival: defaultSurvival(survival || { enabled: false }),
    affiliatedLeagues: [],
    historySeasons: [],
    ownerUserId: ownerUserId || null,
    ownerName: ownerName ? String(ownerName).trim() : null,
    ownerEmail: ownerEmail ? String(ownerEmail).trim().toLowerCase() : null,
    rejectionReason: null,
    submittedAt: now,
    approvedAt: null,
    approvedBy: null,
    createdAt: now,
    activatedAt: null
  };

  league.championship = normalizeIndependentChampionship({
    ...league.championship,
    name: champName,
    titleWeek: championship?.titleWeek,
    bowlWeek: championship?.bowlWeek,
    format: championship?.format
  }, league);
  league.structure = normalizeIndependentStructure(league.structure, league);

  store.leagues.push(league);
  writeStore(store);
  return publicLeague(league);
}

function listIndependentLeagues() {
  return readStore().leagues
    .filter((l) => l.platform === 'independent')
    .map(publicLeague)
    .sort((a, b) => String(b.submittedAt || b.createdAt || '').localeCompare(String(a.submittedAt || a.createdAt || '')));
}

function listPendingIndependentLeagues() {
  return listIndependentLeagues().filter((l) => l.status === 'pending_approval');
}

function listIndependentLeaguesForOwner(ownerUserId) {
  if (!ownerUserId) return [];
  return readStore().leagues
    .filter((l) => l.platform === 'independent' && l.ownerUserId === ownerUserId)
    .map(publicLeague);
}

function independentRecordForFranchise(league, franchiseId) {
  const wr = independentWeekResults(league);
  const fid = String(franchiseId || '');
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let pointsFor = 0;
  let pointsAgainst = 0;
  let playoff = false;
  for (const key of Object.keys(wr || {})) {
    const week = wr[key];
    if (!week) continue;
    for (const m of week.matchups || []) {
      if (!m || m.result === 'upcoming') continue;
      const homeId = String(m.homeId || '');
      const awayId = String(m.awayId || '');
      if (homeId !== fid && awayId !== fid) continue;
      const hs = Number(m.homeScore) || 0;
      const as = Number(m.awayScore) || 0;
      const mineHome = homeId === fid;
      const pf = mineHome ? hs : as;
      const pa = mineHome ? as : hs;
      pointsFor += pf;
      pointsAgainst += pa;
      if (week.phase === 'playoff') playoff = true;
      if (m.result === 'tie') ties += 1;
      else if ((m.result === 'home' && mineHome) || (m.result === 'away' && !mineHome)) wins += 1;
      else losses += 1;
    }
  }
  return {
    wins,
    losses,
    ties,
    pointsFor: Math.round(pointsFor * 10) / 10,
    pointsAgainst: Math.round(pointsAgainst * 10) / 10,
    playoff
  };
}

function independentChampionFranchiseId(league) {
  const games = league?.playoffs?.games;
  if (!Array.isArray(games)) return null;
  const finals = games.filter((g) => g && (g.final === true || g.id === 'final-0'));
  const last = finals.sort((a, b) => Number(b.round || 0) - Number(a.round || 0))[0]
    || games.filter((g) => g.winnerId).sort((a, b) => Number(b.round || 0) - Number(a.round || 0))[0];
  return last?.winnerId ? String(last.winnerId) : null;
}

function listIndependentMembershipsForUser(userId) {
  const uid = String(userId || '');
  if (!uid) return [];
  const out = [];
  for (const l of readStore().leagues || []) {
    if (l.platform !== 'independent' || l.status === 'rejected' || l.status === 'archived') continue;
    const isOwner = String(l.ownerUserId || '') === uid;
    const franchise = (l.franchises || []).find((f) => f.managerUserId && String(f.managerUserId) === uid) || null;
    if (!isOwner && !franchise) continue;
    const record = franchise ? independentRecordForFranchise(l, franchise.id) : null;
    const champId = independentChampionFranchiseId(l);
    out.push({
      leagueId: l.id,
      slug: l.slug,
      name: (l.brand && l.brand.name) || l.slug,
      season: l.season,
      format: (l.settings && l.settings.leagueFormat) || 'redraft',
      status: l.status,
      isOwner,
      champion: Boolean(franchise && champId && String(franchise.id) === champId),
      franchise: franchise
        ? {
          id: franchise.id,
          name: franchise.name,
          conferenceKey: franchise.conferenceKey || null,
          rosterSize: Array.isArray(franchise.roster) ? franchise.roster.length : 0,
          ...record
        }
        : null,
      paths: {
        home: independentHomePath(l),
        myRoster: independentSectionPath(l, 'my-roster'),
        keepers: independentSectionPath(l, 'keepers'),
        settings: independentSectionPath(l, 'settings'),
        scoring: independentSectionPath(l, 'scoring'),
        manage: independentSectionPath(l, 'manage'),
        draft: independentSectionPath(l, 'draft'),
        transactions: independentSectionPath(l, 'transactions'),
        standings: independentSectionPath(l, 'standings')
      }
    });
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function completeIndependentLeagueSetup(leagueId, body = {}, actor = null, uploadedAssets = {}) {
  const { store, league } = requireIndependentLeague(leagueId);
  if (actor && !canManageIndependentLeague(actor, league) && !actor.siteOwner) {
    throw Object.assign(new Error('Only the league owner can finish setup'), { status: 403 });
  }
  if (league.status === 'pending_approval') {
    throw Object.assign(new Error('Wait for site-owner approval before finishing setup'), { status: 403 });
  }
  if (league.status === 'rejected') {
    throw Object.assign(new Error('This league was not approved'), { status: 403 });
  }
  if (league.setupComplete === true) {
    throw Object.assign(new Error('League setup is already complete'), { status: 400 });
  }

  const brandName = String(body.brand?.name || league.brand?.name || '').trim();
  if (!brandName) throw Object.assign(new Error('League name is required'), { status: 400 });

  let confInputs = Array.isArray(body.conferences)
    ? body.conferences.filter((c) => c && String(c.name || '').trim())
    : [];
  const conferenceCountWanted = Number(body.structure?.conferenceCount) === 1
    ? 1
    : (Number(body.structure?.conferenceCount) === 2
      ? 2
      : (confInputs.length === 1 ? 1 : 2));
  if (confInputs.length === 0) {
    confInputs = conferenceCountWanted === 2
      ? [
          { name: 'East Conference', key: 'east', shortName: 'EAST', color: '#ff7a18' },
          { name: 'West Conference', key: 'west', shortName: 'WEST', color: '#e2232a' }
        ]
      : [{ name: 'League', key: 'league', shortName: 'LG', color: '#c9a227' }];
  }
  if (conferenceCountWanted === 1) confInputs = confInputs.slice(0, 1);
  if (conferenceCountWanted === 2 && confInputs.length === 1) {
    confInputs.push({ name: 'West Conference', key: 'west', shortName: 'WEST', color: '#e2232a' });
  }
  const normalizedConfs = confInputs.map((c, i) =>
    normalizeConferenceInput(c, i, uploadedAssets, { requireEspn: false })
  );
  if (normalizedConfs.length === 2 && normalizedConfs[0].key === normalizedConfs[1].key) {
    normalizedConfs[1].key = `${normalizedConfs[1].key}b`;
  }
  normalizedConfs[0].isRulesPrimary = true;
  if (normalizedConfs[1]) normalizedConfs[1].isRulesPrimary = false;

  const structureSeed = {
    conferenceCount: normalizedConfs.length,
    ...(body.structure || {})
  };
  const totalRequested = Number(structureSeed.totalTeams);
  if (normalizedConfs.length === 2 && Number.isFinite(totalRequested) && totalRequested >= 2) {
    structureSeed.teamsPerConference = Math.round(totalRequested / 2);
    structureSeed.totalTeams = structureSeed.teamsPerConference * 2;
  }
  const structureNorm = normalizeIndependentStructure(structureSeed, {
    conferences: normalizedConfs,
    structure: structureSeed
  });
  if (!ALLOWED_INDEPENDENT_TEAM_COUNTS.includes(structureNorm.totalTeams)) {
    throw Object.assign(
      new Error(`Team count must be one of: ${ALLOWED_INDEPENDENT_TEAM_COUNTS.join(', ')}`),
      { status: 400 }
    );
  }

  const champName = String(body.championship?.name || '').trim();

  const slots = body.settings?.rosterSlots || {};
  const starters = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'SFLEX', 'DST', 'K']
    .reduce((sum, k) => sum + (Number(slots[k]) || 0), 0);
  if (starters < 1) {
    throw Object.assign(new Error('Set at least one starter roster slot'), { status: 400 });
  }

  const prevFranchises = Array.isArray(league.franchises) ? league.franchises : [];
  const nextFranchises = buildPlaceholderFranchises(
    normalizedConfs,
    structureNorm.teamsPerConference,
    body.franchises
  ).map((f) => {
    const match = prevFranchises.find((p) => p.id === f.id)
      || prevFranchises.find((p) => p.conferenceKey === f.conferenceKey && p.slot === f.slot);
    if (!match) return f;
    return {
      ...f,
      managerUserId: match.managerUserId || null,
      managerName: match.managerName || null,
      roster: Array.isArray(match.roster) ? match.roster : []
    };
  });

  if (body.brand?.slug) {
    const wanted = slugify(body.brand.slug);
    if (wanted && wanted !== league.slug && !isReservedLeagueSlug(wanted)) {
      const taken = store.leagues.some((l) => l.id !== league.id && l.slug === wanted);
      if (!taken) league.slug = wanted;
    }
  }

  league.brand = {
    name: brandName,
    tagline: String(body.brand?.tagline || league.brand?.tagline || '').trim(),
    logo: uploadedAssets.brandLogo || body.brand?.logo || league.brand?.logo || null,
    crest: uploadedAssets.brandCrest
      || body.brand?.crest
      || uploadedAssets.brandLogo
      || body.brand?.logo
      || league.brand?.crest
      || league.brand?.logo
      || null
  };
  league.conferences = normalizedConfs.map((c, i) => ({
    ...c,
    espnLeagueId: null,
    logo: c.logo || uploadedAssets[`conferenceLogo${i}`] || null
  }));
  league.structure = structureNorm;
  league.leagueType = normalizedConfs.length === 2 ? 'two-conferences' : 'one-conference';
  league.championship = normalizeIndependentChampionship({
    name: champName,
    titleWeek: body.championship?.titleWeek,
    bowlWeek: body.championship?.bowlWeek,
    format: body.championship?.format
      || (normalizedConfs.length === 1 ? 'single-bracket' : 'super-bowl'),
    logo: uploadedAssets.championshipLogo || body.championship?.logo || league.championship?.logo || null,
    confChampLogos: Object.fromEntries(
      normalizedConfs.map((c, i) => [
        c.key,
        uploadedAssets[`confChampLogo${i}`] || body.championship?.confChampLogos?.[c.key] || null
      ])
    ),
    thirdPlaceLogos: Object.fromEntries(
      normalizedConfs.map((c, i) => [
        c.key,
        uploadedAssets[`thirdPlaceLogo${i}`] || body.championship?.thirdPlaceLogos?.[c.key] || null
      ])
    )
  }, league);
  league.settings = defaultIndependentSettings({
    ...(league.settings || {}),
    ...(body.settings || {}),
    draftScope: normalizedConfs.length === 1
      ? 'league'
      : (body.settings?.draftScope || 'conference')
  });
  league.survival = defaultSurvival(body.survival || { enabled: false });
  league.payouts = {
    seasonLabel: String(body.payouts?.seasonLabel || `${league.season} Season`).trim(),
    buyInPerTeam: Number(body.payouts?.buyInPerTeam) || 0,
    teamCount: structureNorm.totalTeams,
    currency: String(body.payouts?.currency || 'USD').trim() || 'USD',
    notes: String(body.payouts?.notes || '').trim(),
    prizes: (Array.isArray(body.payouts?.prizes) ? body.payouts.prizes : []).map(normalizePrize)
  };
  if (Number(body.season) >= 2018 && Number(body.season) <= 2100) {
    league.season = Number(body.season);
  }
  league.franchises = nextFranchises;
  league.calendarDefaults = defaultIndependentCalendar(body.calendarDefaults || [], {
    brand: league.brand,
    conferences: league.conferences,
    championship: league.championship,
    survival: league.survival
  });
  if (!league.draft) league.draft = defaultIndependentDraft();
  league.setupComplete = true;
  league.setupCompletedAt = new Date().toISOString();
  league.updatedAt = league.setupCompletedAt;
  writeStore(store);
  return publicLeague(league);
}

function approveIndependentLeague(leagueId, actorUserId) {
  const store = readStore();
  const league = store.leagues.find((l) => l.id === leagueId);
  if (!league) throw Object.assign(new Error('League not found'), { status: 404 });
  if (league.platform !== 'independent') {
    throw Object.assign(new Error('Only independent leagues use this approval flow'), { status: 400 });
  }
  if (league.status !== 'pending_approval') {
    throw Object.assign(new Error(`League is already ${league.status}`), { status: 400 });
  }
  league.status = 'approved';
  league.approvedAt = new Date().toISOString();
  league.approvedBy = actorUserId || null;
  league.rejectionReason = null;
  // Owner finishes the full Create a League wizard before HQ settings unlock.
  if (league.setupComplete !== true) league.setupComplete = false;
  // Independent leagues never replace the site-wide active ESPN HQ.
  writeStore(store);
  return publicLeague(league);
}

function rejectIndependentLeague(leagueId, reason, actorUserId) {
  const store = readStore();
  const league = store.leagues.find((l) => l.id === leagueId);
  if (!league) throw Object.assign(new Error('League not found'), { status: 404 });
  if (league.platform !== 'independent') {
    throw Object.assign(new Error('Only independent leagues use this approval flow'), { status: 400 });
  }
  if (league.status !== 'pending_approval') {
    throw Object.assign(new Error(`League is already ${league.status}`), { status: 400 });
  }
  league.status = 'rejected';
  league.rejectionReason = String(reason || '').trim() || 'Rejected by site owner';
  league.approvedAt = null;
  league.approvedBy = actorUserId || null;
  writeStore(store);
  return publicLeague(league);
}

function assertIndependentNotSystem(league) {
  if (!league || league.platform !== 'independent') {
    throw Object.assign(new Error('Only independent leagues can be managed here'), { status: 400 });
  }
  if (league.isSystem) {
    throw Object.assign(new Error('Cannot change the system league'), { status: 400 });
  }
}

function archiveIndependentLeague(leagueId) {
  const store = readStore();
  const league = store.leagues.find((l) => l.id === leagueId);
  if (!league) throw Object.assign(new Error('League not found'), { status: 404 });
  assertIndependentNotSystem(league);
  if (league.status === 'pending_approval') {
    throw Object.assign(new Error('Approve or reject this request first'), { status: 400 });
  }
  if (league.status === 'rejected') {
    throw Object.assign(new Error('Rejected leagues cannot be archived — delete them instead'), { status: 400 });
  }
  if (league.status === 'archived') {
    throw Object.assign(new Error('This league is already archived'), { status: 400 });
  }
  league.status = 'archived';
  league.archivedAt = new Date().toISOString();
  league.updatedAt = league.archivedAt;
  writeStore(store);
  return publicLeague(league);
}

function restoreIndependentLeague(leagueId) {
  const store = readStore();
  const league = store.leagues.find((l) => l.id === leagueId);
  if (!league) throw Object.assign(new Error('League not found'), { status: 404 });
  assertIndependentNotSystem(league);
  if (league.status !== 'archived') {
    throw Object.assign(new Error('Only archived leagues can be restored'), { status: 400 });
  }
  league.status = 'approved';
  league.archivedAt = null;
  league.updatedAt = new Date().toISOString();
  writeStore(store);
  return publicLeague(league);
}

function renewIndependentLeague(leagueId, { season } = {}) {
  const store = readStore();
  const league = store.leagues.find((l) => l.id === leagueId);
  if (!league) throw Object.assign(new Error('League not found'), { status: 404 });
  assertIndependentNotSystem(league);
  if (league.status === 'pending_approval' || league.status === 'rejected') {
    throw Object.assign(new Error('Only an approved league can be renewed'), { status: 400 });
  }
  const current = Number(league.season) || new Date().getFullYear();
  const nextSeason = Number(season) || current + 1;
  if (!(nextSeason > current)) {
    throw Object.assign(new Error(`Renewal season must be after ${current}`), { status: 400 });
  }
  const format = String(league.settings?.leagueFormat || 'redraft').toLowerCase();
  league.season = nextSeason;
  league.status = 'approved';
  league.archivedAt = null;
  league.draft = defaultIndependentDraft({ status: 'scheduled' });
  league.weekResults = {};
  league.schedule = null;
  league.playoffs = {
    locked: false,
    format: league.playoffs?.format || null,
    champName: league.playoffs?.champName || league.championship?.name || null,
    weeks: [],
    seeds: []
  };
  league.transactions = [];
  if (format !== 'dynasty' && Array.isArray(league.franchises)) {
    league.franchises = league.franchises.map((f) => ({ ...f, roster: [] }));
  }
  if (league.keepers && typeof league.keepers === 'object') {
    league.keepers = { season: nextSeason, status: 'open', declarations: [] };
  }
  league.renewedAt = new Date().toISOString();
  league.updatedAt = league.renewedAt;
  writeStore(store);
  return publicLeague(league);
}

function deleteIndependentLeague(leagueId) {
  const store = readStore();
  const idx = store.leagues.findIndex((l) => l.id === leagueId);
  if (idx === -1) throw Object.assign(new Error('League not found'), { status: 404 });
  const league = store.leagues[idx];
  assertIndependentNotSystem(league);
  store.leagues.splice(idx, 1);
  writeStore(store);
  return publicLeague(league);
}

function updateIndependentFranchises(leagueId, franchises) {
  const store = readStore();
  const league = store.leagues.find((l) => l.id === leagueId);
  if (!league) throw Object.assign(new Error('League not found'), { status: 404 });
  if (league.platform !== 'independent') {
    throw Object.assign(new Error('Not an independent league'), { status: 400 });
  }
  league.franchises = buildPlaceholderFranchises(
    league.conferences,
    league.structure?.teamsPerConference,
    franchises
  );
  league.updatedAt = new Date().toISOString();
  writeStore(store);
  return publicLeague(league);
}

function pushIndependentTransaction(league, row = {}) {
  league.transactions = Array.isArray(league.transactions) ? league.transactions : [];
  league.transactions.push({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...row
  });
  if (league.transactions.length > 200) league.transactions = league.transactions.slice(-200);
}

function withIndependentLeague(leagueId, mutator) {
  const { store, league } = requireIndependentLeague(leagueId);
  const out = mutator(league);
  league.updatedAt = new Date().toISOString();
  writeStore(store);
  return out !== undefined ? out : publicLeague(league);
}

function requireIndependentLeague(leagueId) {
  const store = readStore();
  const league = store.leagues.find((l) => l.id === leagueId);
  if (!league) throw Object.assign(new Error('League not found'), { status: 404 });
  if (league.platform !== 'independent') {
    throw Object.assign(new Error('Official draft is only for independent leagues'), { status: 400 });
  }
  if (league.isSystem) {
    throw Object.assign(new Error('Cannot modify the system league'), { status: 400 });
  }
  return { store, league };
}

function updateIndependentSettings(leagueId, patch = {}, actor = null) {
  const { store, league } = requireIndependentLeague(leagueId);
  if (actor && !canManageIndependentLeague(actor, league)) {
    throw Object.assign(new Error('Only the league owner can change settings'), { status: 403 });
  }
  if (league.status === 'pending_approval') {
    throw Object.assign(
      new Error('League settings unlock after the site owner approves this league'),
      { status: 403 }
    );
  }
  if (league.status === 'rejected') {
    throw Object.assign(new Error('This league was not approved'), { status: 403 });
  }
  if (league.status === 'archived') {
    throw Object.assign(new Error('This league is archived. Restore it in Site Tools first.'), { status: 403 });
  }
  if (league.setupComplete === false) {
    throw Object.assign(
      new Error('Finish the Create a League wizard first'),
      { status: 403, code: 'setup_required' }
    );
  }
  const draftStatus = String(league.draft?.status || 'scheduled');
  if (draftStatus === 'live' || draftStatus === 'complete') {
    // Allow notes/scoring after draft, but lock draft schedule once live/complete.
    const lockedKeys = ['draftAt', 'draftScope', 'draftRounds', 'draftSecondsPerPick', 'draftFillEmptySeats', 'draftOrder', 'draftType'];
    for (const key of lockedKeys) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        throw Object.assign(new Error('Draft settings are locked after the draft starts'), { status: 400 });
      }
    }
  }
  const next = defaultIndependentSettings({
    ...(league.settings || {}),
    ...patch,
    rosterSlots: patch.rosterSlots
      ? { ...(league.settings?.rosterSlots || {}), ...patch.rosterSlots }
      : league.settings?.rosterSlots,
    scoring: (() => {
      const receptionFor = (p) => (p === 'standard' ? 0 : p === 'half-ppr' ? 0.5 : 1);
      if (patch.scoring) {
        const preset = String(patch.scoringPreset || league.settings?.scoringPreset || 'custom');
        const seedPreset = preset === 'custom' ? 'ppr-6' : preset;
        return defaultIndependentScoring(
          { ...(league.settings?.scoring || {}), ...patch.scoring },
          seedPreset
        );
      }
      // Preset-only: apply pass TD + PPR; keep kicker/DST customizations.
      if (patch.scoringPreset) {
        const p = String(patch.scoringPreset);
        if (p && p !== 'custom') {
          return defaultIndependentScoring({
            ...(league.settings?.scoring || {}),
            passingTD: passingTdForPreset(p),
            reception: receptionFor(p)
          }, p);
        }
        return league.settings?.scoring;
      }
      return league.settings?.scoring;
    })()
  });
  if (next.draftAt && draftStatus === 'scheduled') {
    const t = Date.parse(next.draftAt);
    if (!Number.isFinite(t)) {
      throw Object.assign(new Error('Invalid draft date/time'), { status: 400 });
    }
  }
  league.settings = next;
  if (Object.prototype.hasOwnProperty.call(patch, 'conferences')) {
    league.conferences = normalizeIndependentConferences(patch.conferences, league);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'structure')) {
    const confCount = Number(patch.structure?.conferenceCount)
      || league.conferences?.length
      || 2;
    if (confCount <= 1 && (league.conferences || []).length > 1) {
      league.conferences = league.conferences.slice(0, 1);
    }
    if (confCount >= 2 && (league.conferences || []).length < 2) {
      league.conferences = normalizeIndependentConferences([
        league.conferences[0] || { name: 'Conference 1', shortName: 'C1' },
        { name: 'Conference 2', shortName: 'C2', key: 'conference2' }
      ], league);
    }
    league.structure = normalizeIndependentStructure({
      ...patch.structure,
      conferenceCount: league.conferences.length
    }, league);
    const draftOk = !['live', 'complete'].includes(String(league.draft?.status || 'scheduled'));
    if (draftOk && league.structure.teamsPerConference > 0) {
      const prev = Array.isArray(league.franchises) ? league.franchises : [];
      const nextFranchises = buildPlaceholderFranchises(
        league.conferences,
        league.structure.teamsPerConference
      );
      league.franchises = nextFranchises.map((f) => {
        const match = prev.find((p) => p.id === f.id)
          || prev.find((p) => p.conferenceKey === f.conferenceKey && p.slot === f.slot);
        if (!match) return f;
        return {
          ...f,
          managerUserId: match.managerUserId || null,
          managerName: match.managerName || null,
          roster: Array.isArray(match.roster) ? match.roster : []
        };
      });
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'championship')) {
    league.championship = normalizeIndependentChampionship(patch.championship, league);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'survival')) {
    league.survival = defaultSurvival({
      ...(league.survival || {}),
      ...(typeof patch.survival === 'object' && patch.survival ? patch.survival : {})
    });
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'rulebook')) {
    const incoming = typeof patch.rulebook === 'object' && patch.rulebook ? patch.rulebook : {};
    const ownerOnly = (Array.isArray(incoming.articles) ? incoming.articles : [])
      .filter((a) => !a?.source || a.source === 'owner')
      .filter((a) => !String(a?.id || '').startsWith('settings-'));
    league.rulebook = defaultIndependentRulebook({
      articles: ownerOnly,
      updatedAt: new Date().toISOString(),
      updatedByName: actor?.name || actor?.loginName || league.ownerName || null
    });
  }
  if (!league.draft) league.draft = defaultIndependentDraft();
  if (league.draft.status === 'scheduled' && next.draftAt) {
    league.draft.status = 'scheduled';
  }
  const builtSchedule = buildIndependentScheduleWeeks(league);
  if (scheduleNeedsRebuild(league, builtSchedule)) league.schedule = builtSchedule;
  league.updatedAt = new Date().toISOString();
  writeStore(store);
  return publicLeague(league);
}

function canManageIndependentLeague(user, league) {
  if (!user?.id || !league) return false;
  if (user.siteOwner || user.canSwitchLeagues) return true;
  return Boolean(league.ownerUserId && league.ownerUserId === user.id);
}

function setIndependentDraftState(leagueId, draftPatch = {}) {
  const { store, league } = requireIndependentLeague(leagueId);
  league.draft = defaultIndependentDraft({
    ...(league.draft || {}),
    ...draftPatch
  });
  league.updatedAt = new Date().toISOString();
  writeStore(store);
  return publicLeague(league);
}

function applyIndependentDraftRosters(leagueId, picksByFranchiseId = {}, allPicks = null) {
  const { store, league } = requireIndependentLeague(leagueId);
  const franchises = Array.isArray(league.franchises) ? league.franchises : [];
  const slots = league.settings?.rosterSlots || {};
  league.franchises = franchises.map((f) => {
    const incoming = Array.isArray(picksByFranchiseId[f.id]) ? picksByFranchiseId[f.id] : [];
    const settings = defaultIndependentSettings(league.settings || {});
    const format = settings.leagueFormat || 'redraft';
    const keepersMod = require('./independent-keepers');
    const stamped = incoming.map((row) => {
      const pick = (Array.isArray(allPicks) ? allPicks : []).find((p) =>
        String(p.franchiseId) === String(f.id) && String(p.playerId || p.id) === String(row.playerId || row.id)
      );
      return keepersMod.stampDraftPlayer(row, pick || row, league.season);
    });
    let roster;
    if (format === 'dynasty' || (format === 'keeper' && (f.roster || []).length)) {
      const have = new Set((f.roster || []).map((p) => String(p.playerId || p.id)));
      roster = [...(f.roster || [])];
      for (const row of stamped) {
        const id = String(row.playerId || row.id || '');
        if (!id || have.has(id)) continue;
        roster.push({ ...row, slot: row.slot || 'BN' });
        have.add(id);
      }
      if (!(f.roster || []).length) {
        roster = independentScoring.assignDefaultSlots(roster, slots);
      }
    } else {
      roster = stamped.length ? independentScoring.assignDefaultSlots(stamped, slots) : (f.roster || []);
    }
    return { ...f, roster };
  });
  const flat = Array.isArray(allPicks)
    ? allPicks
    : Object.entries(picksByFranchiseId).flatMap(([franchiseId, rows]) =>
      (rows || []).map((row) => ({ ...row, franchiseId }))
    );
  league.draft = defaultIndependentDraft({
    ...(league.draft || {}),
    status: 'complete',
    completedAt: new Date().toISOString(),
    picks: flat
  });
  const builtSchedule = buildIndependentScheduleWeeks(league);
  if (scheduleNeedsRebuild(league, builtSchedule)) league.schedule = builtSchedule;
  league.updatedAt = new Date().toISOString();
  writeStore(store);
  return publicLeague(league);
}

function assignFranchiseManager(leagueId, franchiseId, manager) {
  const { store, league } = requireIndependentLeague(leagueId);
  const fid = String(franchiseId || '');
  const idx = (league.franchises || []).findIndex((f) => String(f.id) === fid);
  if (idx < 0) throw Object.assign(new Error('Franchise not found'), { status: 404 });
  const managerId = manager?.id || null;
  // One franchise seat per manager in this league.
  if (managerId) {
    league.franchises = (league.franchises || []).map((f) => {
      if (f.managerUserId === managerId && String(f.id) !== fid) {
        return { ...f, managerUserId: null, managerName: null };
      }
      return f;
    });
  }
  const freshIdx = (league.franchises || []).findIndex((f) => String(f.id) === fid);
  league.franchises[freshIdx] = {
    ...league.franchises[freshIdx],
    managerUserId: managerId,
    managerName: managerId ? (manager?.name || manager?.loginName || null) : null
  };
  league.updatedAt = new Date().toISOString();
  writeStore(store);
  return publicLeague(league);
}

function renameIndependentFranchise(leagueId, franchiseId, patch = {}) {
  const { store, league } = requireIndependentLeague(leagueId);
  const fid = String(franchiseId || '');
  const idx = (league.franchises || []).findIndex((f) => String(f.id) === fid);
  if (idx < 0) throw Object.assign(new Error('Franchise not found'), { status: 404 });
  const next = { ...league.franchises[idx] };
  if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
    next.name = normalizeFranchiseName(patch.name);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'abbrev')) {
    const abbrev = String(patch.abbrev || '').trim().toUpperCase().slice(0, 4);
    next.abbrev = abbrev || null;
  }
  league.franchises[idx] = next;
  league.updatedAt = new Date().toISOString();
  writeStore(store);
  return publicLeague(league);
}

function roundRobinPairings(franchiseIds, week) {
  const ids = [...franchiseIds];
  if (ids.length < 2) return [];
  if (ids.length % 2 === 1) ids.push(null);
  const n = ids.length;
  const rounds = n - 1;
  const half = n / 2;
  const arr = [...ids];
  const roundIndex = ((Math.max(1, Number(week) || 1) - 1) % Math.max(1, rounds));
  for (let r = 0; r < roundIndex; r += 1) {
    const rest = arr.slice(1);
    rest.unshift(rest.pop());
    arr.splice(0, arr.length, arr[0], ...rest);
  }
  const pairs = [];
  for (let i = 0; i < half; i += 1) {
    const home = arr[i];
    const away = arr[n - 1 - i];
    if (!home || !away) continue;
    pairs.push({ homeId: home, awayId: away });
  }
  return pairs;
}

function buildIndependentScheduleWeeks(league) {
  const weeksN = Math.max(1, Math.min(18, Number(league.structure?.regularSeasonEndWeek) || 13));
  const confCount = Number(league.structure?.conferenceCount) === 1 ? 1 : 2;
  const franchises = Array.isArray(league.franchises) ? league.franchises : [];
  const weeks = [];
  const confs = Array.isArray(league.conferences) ? league.conferences : [];
  if (confCount === 2 && confs.length >= 2) {
    const groups = confs.slice(0, 2).map((c) =>
      franchises.filter((f) => String(f.conferenceKey) === String(c.key)).map((f) => f.id)
    );
    for (let w = 1; w <= weeksN; w += 1) {
      weeks.push({
        week: w,
        matchups: groups.flatMap((ids) => roundRobinPairings(ids, w))
      });
    }
  } else {
    const ids = franchises.map((f) => f.id);
    for (let w = 1; w <= weeksN; w += 1) {
      weeks.push({ week: w, matchups: roundRobinPairings(ids, w) });
    }
  }
  return { weeks };
}

function scheduleNeedsRebuild(league, built) {
  const existing = league.schedule?.weeks;
  if (!Array.isArray(existing) || !existing.length) return true;
  if (existing.length !== built.weeks.length) return true;
  const oldIds = new Set();
  for (const w of existing) {
    for (const m of w.matchups || []) {
      if (m.homeId) oldIds.add(String(m.homeId));
      if (m.awayId) oldIds.add(String(m.awayId));
    }
  }
  const newIds = new Set((league.franchises || []).map((f) => String(f.id)));
  if (oldIds.size !== newIds.size) return true;
  for (const id of newIds) {
    if (!oldIds.has(id)) return true;
  }
  return false;
}

function ensureIndependentSchedule(leagueId) {
  const { store, league } = requireIndependentLeague(leagueId);
  const built = buildIndependentScheduleWeeks(league);
  if (scheduleNeedsRebuild(league, built)) {
    league.schedule = built;
    league.updatedAt = new Date().toISOString();
    writeStore(store);
  }
  return publicLeague(league);
}

function setIndependentLineup(leagueId, franchiseId, lineup, actor = {}) {
  const keepers = require('./independent-keepers');
  const { store, league } = requireIndependentLeague(leagueId);
  const fid = String(franchiseId || '');
  const idx = (league.franchises || []).findIndex((f) => String(f.id) === fid);
  if (idx < 0) throw Object.assign(new Error('Franchise not found'), { status: 404 });
  const franchise = league.franchises[idx];
  const isOwner = String(actor.userId) === String(league.ownerUserId) || Boolean(actor.isSiteOwner);
  const isManager = franchise.managerUserId && String(franchise.managerUserId) === String(actor.userId);
  if (!isOwner && !isManager) {
    throw Object.assign(new Error('Only this team’s manager can set the lineup'), { status: 403 });
  }
  const roster = Array.isArray(franchise.roster) ? franchise.roster.slice() : [];
  const byId = new Map(roster.map((p) => [String(p.playerId || p.id), p]));
  const slots = league.settings?.rosterSlots || {};
  const assignments = Array.isArray(lineup) ? lineup : [];
  const counts = {};
  const seen = new Set();
  const slotByPlayer = new Map();
  for (const row of assignments) {
    const pid = String(row.playerId || '');
    const slot = independentScoring.normalizeSlot(row.slot);
    if (!pid || !byId.has(pid)) {
      throw Object.assign(new Error('Player is not on this roster'), { status: 400 });
    }
    const player = byId.get(pid);
    if (!independentScoring.slotEligible(player.position, slot)) {
      throw Object.assign(new Error(`${player.name || 'Player'} cannot start at ${slot}`), { status: 400 });
    }
    if (independentScoring.STARTER_KEYS.includes(slot)) {
      counts[slot] = (counts[slot] || 0) + 1;
      if (counts[slot] > (Number(slots[slot]) || 0)) {
        throw Object.assign(new Error(`Too many players at ${slot}`), { status: 400 });
      }
    }
    if (slot === 'IR' || slot === 'TAXI') {
      counts[slot] = (counts[slot] || 0) + 1;
      if (counts[slot] > (Number(slots[slot]) || 0)) {
        throw Object.assign(new Error(`Too many players at ${slot}`), { status: 400 });
      }
    }
    if (seen.has(pid)) {
      throw Object.assign(new Error('A player can only occupy one slot'), { status: 400 });
    }
    seen.add(pid);
    slotByPlayer.set(pid, slot);
  }
  const nextRoster = roster.map((p) => {
    const pid = String(p.playerId || p.id);
    const slot = slotByPlayer.get(pid)
      || (['IR', 'TAXI'].includes(independentScoring.normalizeSlot(p.slot)) ? independentScoring.normalizeSlot(p.slot) : 'BN');
    const inj = keepers.playerInjury(p, actor.injuries || null);
    return { ...p, slot, injuryStatus: inj || p.injuryStatus || null };
  });
  keepers.validateReserveSlots(league, franchise, nextRoster, actor.injuries || null);
  league.franchises[idx] = {
    ...franchise,
    roster: nextRoster
  };
  league.transactions = Array.isArray(league.transactions) ? league.transactions : [];
  league.transactions.push({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    type: 'lineup',
    franchiseId: fid,
    franchiseName: franchise.name,
    actorName: actor.name || actor.loginName || 'Manager',
    summary: 'Set starting lineup'
  });
  if (league.transactions.length > 200) league.transactions = league.transactions.slice(-200);
  league.updatedAt = new Date().toISOString();
  writeStore(store);
  return publicLeague(league);
}

const WEEK_RESULT_THROTTLE_MS = 60_000;
const weekWriteAt = new Map();

function recordIndependentWeekResults(leagueId, weekPayload) {
  const week = Number(weekPayload?.week);
  if (!leagueId || !Number.isFinite(week) || week < 1) return null;
  const live = Boolean(weekPayload.live);
  const key = `${leagueId}:${week}`;
  const last = weekWriteAt.get(key) || 0;
  if (live && Date.now() - last < WEEK_RESULT_THROTTLE_MS) return null;
  const { store, league } = requireIndependentLeague(leagueId);
  league.weekResults = league.weekResults && typeof league.weekResults === 'object'
    ? league.weekResults
    : {};
  league.weekResults[String(week)] = {
    week,
    live,
    phase: weekPayload.phase === 'playoff' ? 'playoff' : 'regular',
    matchups: (weekPayload.matchups || []).map((m) => ({
      homeId: m.home?.franchiseId || m.homeId,
      awayId: m.away?.franchiseId || m.awayId,
      homeScore: Number(m.homeScore) || 0,
      awayScore: Number(m.awayScore) || 0,
      result: m.result || 'upcoming'
    })),
    recordedAt: new Date().toISOString()
  };
  weekWriteAt.set(key, Date.now());
  league.updatedAt = new Date().toISOString();
  writeStore(store);
  return publicLeague(league);
}

function independentWeekResults(league) {
  return league?.weekResults && typeof league.weekResults === 'object' ? league.weekResults : {};
}

function listIndependentLeaguesForDraftTick() {
  return readStore().leagues.filter((l) =>
    l.platform === 'independent'
    && !l.isSystem
    && l.status === 'approved'
  );
}

function attachOwner(leagueId, userId) {
  const store = readStore();
  const idx = store.leagues.findIndex((l) => l.id === leagueId);
  if (idx === -1) throw Object.assign(new Error('League not found'), { status: 404 });
  store.leagues[idx].ownerUserId = userId;
  writeStore(store);
  return publicLeague(store.leagues[idx]);
}

function registrationEnabled() {
  const raw = String(process.env.ENABLE_LEAGUE_REGISTRATION || 'true').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off';
}

function listDraftAssets(draftId) {
  const dir = path.join(UPLOAD_DIR, draftId);
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const name of fs.readdirSync(dir)) {
    const base = name.replace(/\.[^.]+$/, '');
    if (ASSET_TYPES.has(base)) {
      out[base] = `/uploads/leagues/${draftId}/${name}`;
    }
  }
  return out;
}

function resolveLeagueUploadPath(relative) {
  const safe = path.normalize(String(relative || '')).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(UPLOAD_DIR, safe);
  if (!full.startsWith(UPLOAD_DIR)) return null;
  return fs.existsSync(full) ? full : null;
}

module.exports = {
  ASSET_TYPES,
  IMAGE_MIME,
  UPLOAD_DIR,
  listLeagues,
  findById,
  findBySlug,
  getActiveLeague,
  getActiveLeagueId,
  setActiveLeague,
  createLeague,
  createIndependentLeague,
  completeIndependentLeagueSetup,
  listIndependentLeagues,
  listPendingIndependentLeagues,
  listIndependentLeaguesForOwner,
  listIndependentMembershipsForUser,
  independentRecordForFranchise,
  independentChampionFranchiseId,
  independentHomePath,
  independentSectionPath,
  isReservedLeagueSlug,
  allocateLeagueSlug,
  RESERVED_LEAGUE_SLUGS,
  approveIndependentLeague,
  rejectIndependentLeague,
  archiveIndependentLeague,
  restoreIndependentLeague,
  renewIndependentLeague,
  deleteIndependentLeague,
  updateIndependentFranchises,
  updateIndependentSettings,
  setIndependentDraftState,
  applyIndependentDraftRosters,
  assignFranchiseManager,
  renameIndependentFranchise,
  setIndependentLineup,
  ensureIndependentSchedule,
  recordIndependentWeekResults,
  independentWeekResults,
  withIndependentLeague,
  pushIndependentTransaction,
  canManageIndependentLeague,
  listIndependentLeaguesForDraftTick,
  defaultIndependentDraft,
  defaultIndependentRulebook,
  composeIndependentRulebook,
  formatIndependentRulebookFromSettings,
  vanillaIndependentTemplate,
  ALLOWED_INDEPENDENT_TEAM_COUNTS,
  FRANCHISE_NAME_MAX,
  normalizeFranchiseName,
  defaultIndependentSettings,
  defaultIndependentScoring,
  normalizeRosterSlots,
  defaultIndependentCalendar,
  normalizeIndependentStructure,
  normalizeIndependentChampionship,
  ensureSystemLeague,
  saveAssetBuffer,
  listDraftAssets,
  resolveLeagueUploadPath,
  updateLeagueAssets,
  attachOwner,
  registrationEnabled,
  publicLeague,
  setHistorySeasons,
  setEspnLeagueBindings,
  normalizeHistorySeasons,
  slugify,
  conferenceKeyFromName
};
