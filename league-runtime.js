const staticConfig = require('./config');
const leagues = require('./leagues-store');
const users = require('./users-store');
const logos = require('./logos-store');

function syncConferenceKeys(league) {
  const confKeys = (league?.conferences || []).map((c) => c.key);
  const affiliateKeys = (
    Array.isArray(league?.affiliatedLeagues) && league.affiliatedLeagues.length
      ? league.affiliatedLeagues
      : (staticConfig.affiliatedLeagues || [])
  ).map((l) => l.key);
  const keys = [...confKeys, ...affiliateKeys]
    .map((k) => String(k || '').trim().toLowerCase())
    .filter(Boolean);
  if (typeof users.setAllowedConferenceKeys === 'function') {
    users.setAllowedConferenceKeys(keys);
  }
  if (typeof logos.setAllowedConferenceKeys === 'function') {
    logos.setAllowedConferenceKeys(keys);
  }
}

function leagueToConfig(league) {
  if (!league) return { ...staticConfig };
  return {
    season: league.season || staticConfig.season,
    brand: {
      name: league.brand?.name || 'Fantasy League',
      tagline: league.brand?.tagline || '',
      logo: league.brand?.logo || null,
      crest: league.brand?.crest || league.brand?.logo || null
    },
    conferences: (league.conferences || []).map((c) => ({
      key: c.key,
      name: c.name,
      shortName: c.shortName,
      espnLeagueId: c.espnLeagueId,
      logo: c.logo || null,
      color: c.color || null,
      isRulesPrimary: Boolean(c.isRulesPrimary)
    })),
    payouts: league.payouts || staticConfig.payouts,
    calendarDefaults: league.calendarDefaults || staticConfig.calendarDefaults || [],
    championship: league.championship || {
      name: 'Championship',
      logo: null,
      titleWeek: 16,
      bowlWeek: 17,
      confChampLogos: {},
      thirdPlaceLogos: {}
    },
    structure: league.structure || {
      teamsPerConference: 12,
      totalTeams: 24,
      playoffTeamCount: 6,
      playoffWeeks: [14, 15, 16]
    },
    survival: league.survival || staticConfig.survival || {
      enabled: true,
      week: 17,
      name: 'Toilet Bowl'
    },
    affiliatedLeagues: Array.isArray(league.affiliatedLeagues)
      ? league.affiliatedLeagues
      : (staticConfig.affiliatedLeagues || []),
    leagueId: league.id,
    slug: league.slug,
    isSystem: Boolean(league.isSystem)
  };
}

function bootstrap() {
  const system = leagues.ensureSystemLeague(staticConfig);
  const active = leagues.getActiveLeague() || system;
  syncConferenceKeys(active);
  return active;
}

function getActiveConfig() {
  const active = leagues.getActiveLeague() || bootstrap();
  syncConferenceKeys(active);
  return leagueToConfig(active);
}

function refresh() {
  return getActiveConfig();
}

/** Drop-in replacement for require('./config') — always reflects active league. */
const configProxy = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === 'refresh') return refresh;
      if (prop === 'getActiveConfig') return getActiveConfig;
      if (prop === 'bootstrap') return bootstrap;
      if (prop === 'leagueToConfig') return leagueToConfig;
      if (prop === '__esModule') return false;
      const cfg = getActiveConfig();
      const value = cfg[prop];
      return typeof value === 'function' ? value.bind(cfg) : value;
    },
    ownKeys() {
      return Reflect.ownKeys(getActiveConfig());
    },
    getOwnPropertyDescriptor(_t, prop) {
      const cfg = getActiveConfig();
      if (!(prop in cfg)) return undefined;
      return { configurable: true, enumerable: true, value: cfg[prop] };
    }
  }
);

module.exports = configProxy;
module.exports.getActiveConfig = getActiveConfig;
module.exports.bootstrap = bootstrap;
module.exports.refresh = refresh;
module.exports.leagueToConfig = leagueToConfig;
