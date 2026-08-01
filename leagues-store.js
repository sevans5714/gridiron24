const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'leagues.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads', 'leagues');

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
  return {
    enabled: seed.enabled !== false,
    week: Number(seed.week) || 17,
    name: String(seed.name || "Mayor's Cup").trim() || "Mayor's Cup"
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

function publicLeague(league) {
  if (!league) return null;
  const pub = {
    id: league.id,
    slug: league.slug,
    status: league.status,
    platform: league.platform || (league.isSystem ? 'espn' : 'espn'),
    isSystem: Boolean(league.isSystem),
    season: league.season,
    brand: league.brand,
    conferences: league.conferences,
    championship: league.championship,
    structure: league.structure,
    survival: league.survival || defaultSurvival(),
    affiliatedLeagues: Array.isArray(league.affiliatedLeagues)
      ? league.affiliatedLeagues
      : defaultAffiliatedLeagues(),
    historySeasons: Array.isArray(league.historySeasons) ? league.historySeasons : [],
    payouts: league.payouts,
    calendarDefaults: league.calendarDefaults,
    settings: league.settings || null,
    franchises: Array.isArray(league.franchises) ? league.franchises : [],
    ownerUserId: league.ownerUserId || null,
    ownerName: league.ownerName || null,
    ownerEmail: league.ownerEmail || null,
    rejectionReason: league.rejectionReason || null,
    submittedAt: league.submittedAt || null,
    approvedAt: league.approvedAt || null,
    approvedBy: league.approvedBy || null,
    createdAt: league.createdAt,
    activatedAt: league.activatedAt || null
  };
  if (pub.platform === 'independent') {
    pub.homePath = independentHomePath(league);
    pub.affiliatedLeagues = []; // never tied to GridIron 24 / AAA
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
function defaultIndependentSettings(seed = {}) {
  const preset = String(seed.scoringPreset || seed.preset || 'gridiron24-vanilla').trim() || 'gridiron24-vanilla';
  const reception =
    preset === 'standard' ? 0 : preset === 'half-ppr' ? 0.5 : 1;
  const roster = seed.rosterSlots && typeof seed.rosterSlots === 'object'
    ? seed.rosterSlots
    : {};
  return {
    scoringPreset: preset,
    rosterSlots: {
      QB: Number(roster.QB) >= 0 ? Number(roster.QB) : 1,
      RB: Number(roster.RB) >= 0 ? Number(roster.RB) : 2,
      WR: Number(roster.WR) >= 0 ? Number(roster.WR) : 2,
      TE: Number(roster.TE) >= 0 ? Number(roster.TE) : 1,
      FLEX: Number(roster.FLEX) >= 0 ? Number(roster.FLEX) : 1,
      DST: Number(roster.DST) >= 0 ? Number(roster.DST) : 1,
      K: Number(roster.K) >= 0 ? Number(roster.K) : 1,
      BN: Number(roster.BN) >= 0 ? Number(roster.BN) : 6
    },
    scoring: {
      passingYardsPerPoint: 25,
      passingTD: 4,
      interception: -2,
      rushingYardsPerPoint: 10,
      rushingTD: 6,
      receivingYardsPerPoint: 10,
      receivingTD: 6,
      reception,
      fumbleLost: -2,
      twoPointConversion: 2,
      ...(seed.scoring && typeof seed.scoring === 'object' ? seed.scoring : {})
    },
    draftType: String(seed.draftType || 'snake').trim() || 'snake',
    waiverType: String(seed.waiverType || 'FAAB').trim() || 'FAAB',
    notes: String(seed.notes || '').trim()
      || 'Independent league — scoring and rosters are local to this HQ (not ESPN).'
  };
}

function buildPlaceholderFranchises(conferences, teamsPerConference, customList) {
  if (Array.isArray(customList) && customList.length) {
    return customList.map((row, index) => ({
      id: String(row.id || `franchise-${index + 1}`),
      conferenceKey: String(row.conferenceKey || conferences[0]?.key || 'conferencea'),
      name: String(row.name || `Franchise ${index + 1}`).trim() || `Franchise ${index + 1}`,
      abbrev: String(row.abbrev || '').trim().toUpperCase().slice(0, 4) || null,
      slot: Number(row.slot) || index + 1
    }));
  }
  const out = [];
  const n = Math.max(4, Math.min(20, Number(teamsPerConference) || 12));
  (conferences || []).forEach((conf, ci) => {
    for (let i = 1; i <= n; i++) {
      out.push({
        id: `franchise-${conf.key}-${i}`,
        conferenceKey: conf.key,
        name: `${conf.shortName || conf.name} ${i}`,
        abbrev: null,
        slot: i
      });
    }
  });
  return out;
}

function vanillaIndependentTemplate() {
  const year = new Date().getFullYear();
  return {
    platform: 'independent',
    season: year,
    brand: {
      name: '',
      tagline: '24 Teams. Two Conferences. One Champion.',
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
      name: 'League Championship',
      titleWeek: 16,
      bowlWeek: 17
    },
    structure: {
      teamsPerConference: 12,
      totalTeams: 24,
      playoffTeamCount: 6,
      playoffWeeks: [14, 15, 16]
    },
    settings: defaultIndependentSettings(),
    survival: defaultSurvival({ enabled: true, week: 17, name: "Mayor's Cup" }),
    payouts: {
      seasonLabel: `${year} Season`,
      buyInPerTeam: 100,
      teamCount: 24,
      currency: 'USD',
      notes: 'Prize pool equals buy-in × total franchises. Edit prize labels to match your league.',
      prizes: [
        { place: 1, label: 'League Champion', amount: 1000 },
        { place: 2, label: 'Championship Runner-Up', amount: 500 },
        { place: 3, label: 'East Conference 2nd Place', amount: 250 },
        { place: 4, label: 'West Conference 2nd Place', amount: 250 },
        { place: 5, label: 'East Third Place', amount: 100 },
        { place: 6, label: 'West Third Place', amount: 100 },
        { place: 7, label: 'East Most Points', amount: 100 },
        { place: 8, label: 'West Most Points', amount: 100 }
      ]
    },
    calendarDefaults: [
      { title: 'Draft Day', type: 'draft', date: '', notes: 'Both conferences draft.' },
      { title: 'Dues Due', type: 'dues', date: '', notes: '' },
      { title: 'Trade Deadline', type: 'deadline', date: '', notes: 'No trades after this date.' },
      { title: 'Conference Playoffs Begin', type: 'event', date: '', notes: 'Week 14 Wild Card.' },
      { title: 'Championship', type: 'bowl', date: '', notes: 'Week 17 — conference champs.' }
    ]
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
        if (Number.isFinite(seedEspn) && seedEspn > 0 && seedEspn !== rowEspn) {
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
  franchises,
  survival,
  uploadedAssets = {}
}) {
  const store = readStore();
  const brandName = String(brand?.name || '').trim();
  if (!brandName) throw Object.assign(new Error('League name is required'), { status: 400 });

  const slug = allocateLeagueSlug(brand?.slug || brandName, store.leagues);

  const confInputs = Array.isArray(conferences) ? conferences : [];
  if (confInputs.length !== 2) {
    throw Object.assign(new Error('Exactly two conferences are required'), { status: 400 });
  }
  const normalizedConfs = confInputs.map((c, i) =>
    normalizeConferenceInput(c, i, uploadedAssets, { requireEspn: false })
  );
  if (normalizedConfs[0].key === normalizedConfs[1].key) {
    normalizedConfs[1].key = `${normalizedConfs[1].key}b`;
  }
  normalizedConfs[0].isRulesPrimary = true;
  normalizedConfs[1].isRulesPrimary = false;

  const year = Number(season) || new Date().getFullYear();
  const teamsPerConference = Math.max(4, Math.min(20, Number(structure?.teamsPerConference) || 12));
  const totalTeams = teamsPerConference * 2;
  const buyIn = Number(payouts?.buyInPerTeam) || 0;
  const champName = String(championship?.name || `${brandName} Championship`).trim();
  const titleWeek = Number(championship?.titleWeek) || 16;
  const bowlWeek = Number(championship?.bowlWeek) || 17;
  const leagueSettings = defaultIndependentSettings(settings || {});
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
    settings: leagueSettings,
    franchises: franchiseList,
    payouts: {
      seasonLabel: String(payouts?.seasonLabel || `${year} Season`).trim(),
      buyInPerTeam: buyIn,
      teamCount: totalTeams,
      currency: String(payouts?.currency || 'USD').trim() || 'USD',
      notes: String(payouts?.notes || '').trim(),
      prizes: (Array.isArray(payouts?.prizes) ? payouts.prizes : []).map(normalizePrize)
    },
    calendarDefaults: Array.isArray(calendarDefaults) ? calendarDefaults : [],
    survival: defaultSurvival(survival || {}),
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

  store.leagues.push(league);
  writeStore(store);
  return publicLeague(league);
}

function listPendingIndependentLeagues() {
  return readStore().leagues
    .filter((l) => l.platform === 'independent' && l.status === 'pending_approval')
    .map(publicLeague)
    .sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));
}

function listIndependentLeaguesForOwner(ownerUserId) {
  if (!ownerUserId) return [];
  return readStore().leagues
    .filter((l) => l.platform === 'independent' && l.ownerUserId === ownerUserId)
    .map(publicLeague);
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
  listPendingIndependentLeagues,
  listIndependentLeaguesForOwner,
  independentHomePath,
  independentSectionPath,
  isReservedLeagueSlug,
  allocateLeagueSlug,
  RESERVED_LEAGUE_SLUGS,
  approveIndependentLeague,
  rejectIndependentLeague,
  updateIndependentFranchises,
  vanillaIndependentTemplate,
  defaultIndependentSettings,
  ensureSystemLeague,
  saveAssetBuffer,
  listDraftAssets,
  resolveLeagueUploadPath,
  updateLeagueAssets,
  attachOwner,
  registrationEnabled,
  publicLeague,
  setHistorySeasons,
  normalizeHistorySeasons,
  slugify,
  conferenceKeyFromName
};
