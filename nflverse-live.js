/**
 * Live NFL scoring feed for GridIron BETA + scoreboard NFL slate.
 *
 * Production fantasy Scoreboard / standings / schedules stay on ESPN Fantasy.
 * This module powers NFL game scores with silent multi-source failover:
 *   1. ESPN site API (multi-host)
 *   2. ESPN CDN scoreboard
 *   3. TheSportsDB NFL round / day schedule
 *
 * Callers get a single unified payload — no degraded/stale banners.
 */
const espnResilient = require('./espn-resilient');
const sportsFallbacks = require('./sports-fallbacks');

const CACHE_MS = 15_000;
const SCOREBOARD_PATH = 'apis/site/v2/sports/football/nfl/scoreboard';
const SCOREBOARD_URL = `https://site.api.espn.com/${SCOREBOARD_PATH}`;

function seasonTypeLabel(type) {
  const n = Number(type);
  if (n === 1) return 'Preseason';
  if (n === 3) return 'Postseason';
  return 'Regular Season';
}

function statusBucket(state, completed) {
  if (completed || state === 'post') return 'final';
  if (state === 'in') return 'live';
  return 'upcoming';
}

function pickCompetitor(competitors, side) {
  const row = (competitors || []).find((c) => c.homeAway === side) || null;
  if (!row) return null;
  const team = row.team || {};
  return {
    id: team.id || null,
    uid: team.uid || null,
    abbreviation: team.abbreviation || '',
    name: team.displayName || team.name || '',
    shortName: team.shortDisplayName || team.name || '',
    logo: team.logo || null,
    color: team.color || null,
    score: row.score == null || row.score === '' ? null : Number(row.score),
    record: row.records?.[0]?.summary || null,
    winner: Boolean(row.winner),
    homeAway: side
  };
}

function normalizeEvent(event) {
  const competition = event?.competitions?.[0] || {};
  const status = competition.status || {};
  const type = status.type || {};
  const state = String(type.state || 'pre');
  const completed = Boolean(type.completed);
  const bucket = statusBucket(state, completed);
  const broadcasts = (competition.broadcasts || [])
    .flatMap((b) => b.names || [])
    .filter(Boolean);
  const odds = competition.odds?.[0] || null;

  return {
    id: event.id,
    uid: event.uid || null,
    name: event.name || '',
    shortName: event.shortName || '',
    date: event.date || competition.date || null,
    status: {
      bucket,
      state,
      completed,
      name: type.name || '',
      description: type.description || '',
      detail: type.detail || '',
      shortDetail: type.shortDetail || '',
      clock: status.displayClock || null,
      period: status.period || 0
    },
    venue: competition.venue?.fullName || null,
    broadcasts,
    odds: odds
      ? {
          details: odds.details || null,
          overUnder: odds.overUnder == null ? null : Number(odds.overUnder)
        }
      : null,
    away: pickCompetitor(competition.competitors, 'away'),
    home: pickCompetitor(competition.competitors, 'home')
  };
}

function buildQuery({ week, seasontype, dates, season } = {}) {
  const params = new URLSearchParams();
  if (week != null && String(week).trim() !== '') params.set('week', String(week));
  if (seasontype != null && String(seasontype).trim() !== '') {
    params.set('seasontype', String(seasontype));
  }
  if (dates) params.set('dates', String(dates));
  else if (season != null && String(season).trim() !== '') params.set('dates', String(season));
  const qs = params.toString();
  return qs ? `${SCOREBOARD_PATH}?${qs}` : SCOREBOARD_PATH;
}

function payloadFromEspnRaw(raw) {
  const season = raw.season || {};
  const week = raw.week || {};
  const games = (raw.events || []).map(normalizeEvent);
  const counts = { live: 0, final: 0, upcoming: 0 };
  for (const g of games) {
    counts[g.status.bucket] = (counts[g.status.bucket] || 0) + 1;
  }
  return {
    ok: true,
    source: 'nfl',
    provider: 'NFL',
    fetchedAt: new Date().toISOString(),
    cacheMs: CACHE_MS,
    season: {
      year: season.year || null,
      type: season.type || null,
      typeLabel: seasonTypeLabel(season.type),
      name: season.name || null,
      slug: season.slug || null
    },
    week: {
      number: week.number || null,
      text: week.text || null
    },
    counts,
    games
  };
}

function payloadFromFallback(fb) {
  const games = Array.isArray(fb.games) ? fb.games : [];
  const counts = { live: 0, final: 0, upcoming: 0 };
  for (const g of games) {
    counts[g.status?.bucket] = (counts[g.status?.bucket] || 0) + 1;
  }
  const season = fb.season || {};
  const week = fb.week || {};
  return {
    ok: true,
    source: 'nfl',
    provider: 'NFL',
    fetchedAt: new Date().toISOString(),
    cacheMs: CACHE_MS,
    season: {
      year: season.year || null,
      type: season.type || null,
      typeLabel: seasonTypeLabel(season.type),
      name: season.name || null,
      slug: season.slug || null
    },
    week: {
      number: week.number || null,
      text: week.text || null
    },
    counts,
    games
  };
}

async function fetchEspnSiteScoreboard(query) {
  const pathAndQuery = buildQuery(query);
  const hit = await espnResilient.fetchJsonResilient({
    urls: espnResilient.siteApiUrls(pathAndQuery),
    cacheKey: `nfl-live:${pathAndQuery}`,
    ttlMs: CACHE_MS,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'GridIron24-BetaScoring/1.0'
    },
    lane: 'site'
  });
  return hit.data;
}

async function fetchEspnCdnScoreboard(query) {
  return sportsFallbacks.fetchEspnCdnNflScoreboard({
    week: query.week,
    seasontype: query.seasontype,
    season: query.season,
    dates: query.dates,
    year: query.year
  });
}

/**
 * Silent waterfall — first source that returns a usable scoreboard wins.
 * Empty event lists from a healthy upstream still count (bye / offseason).
 */
async function getLiveScoring(query = {}) {
  const errors = [];

  try {
    const raw = await fetchEspnSiteScoreboard(query);
    if (raw && (Array.isArray(raw.events) || raw.season || raw.week)) {
      return payloadFromEspnRaw(raw);
    }
  } catch (err) {
    errors.push(`site:${err.message || err}`);
  }

  try {
    const raw = await fetchEspnCdnScoreboard(query);
    if (raw && (Array.isArray(raw.events) || raw.season || raw.week)) {
      return payloadFromEspnRaw(raw);
    }
  } catch (err) {
    errors.push(`cdn:${err.message || err}`);
  }

  try {
    const fb = await sportsFallbacks.fetchNflFallbackGames(query);
    if (fb?.games) {
      return payloadFromFallback(fb);
    }
  } catch (err) {
    errors.push(`alt:${err.message || err}`);
  }

  const err = new Error(errors.slice(-1)[0] || 'NFL scores unavailable');
  err.status = 502;
  err.detail = errors.join(' | ').slice(0, 500);
  throw err;
}

function isFirstQuarterGame(game) {
  if (!game || game.status?.bucket !== 'live') return false;
  const period = Number(game.status?.period);
  if (period === 1) return true;
  const detail = `${game.status?.shortDetail || ''} ${game.status?.detail || ''} ${game.status?.description || ''}`.toLowerCase();
  return /\b1st\b/.test(detail) || /\bfirst quarter\b/.test(detail);
}

/**
 * Live NFL scoreboard check used by roster-violation Q1 patrol.
 * Returns active=true when any regular-season (or current) game is in the first quarter.
 */
async function getFirstQuarterPatrolState({ season, week, seasontype } = {}) {
  const query = {};
  if (seasontype != null) query.seasontype = String(seasontype);
  else query.seasontype = '2';
  if (week != null && String(week).trim() !== '') query.week = String(week);
  if (season != null && String(season).trim() !== '') query.season = String(season);

  let live;
  try {
    live = await getLiveScoring(query);
  } catch {
    // Fall back to "current" scoreboard if week/season query fails.
    live = await getLiveScoring({});
  }

  const firstQuarterGames = (live.games || []).filter(isFirstQuarterGame);
  return {
    ok: true,
    active: firstQuarterGames.length > 0,
    fetchedAt: live.fetchedAt,
    season: live.season,
    week: live.week,
    counts: live.counts,
    games: firstQuarterGames.map((g) => ({
      id: g.id,
      name: g.shortName || g.name,
      period: g.status?.period || 1,
      clock: g.status?.clock || null,
      detail: g.status?.shortDetail || g.status?.detail || null
    }))
  };
}

module.exports = {
  getLiveScoring,
  getFirstQuarterPatrolState,
  isFirstQuarterGame,
  SCOREBOARD_URL
};
