/**
 * Live NFL scoring feed for GridIron BETA (own-platform sandbox).
 *
 * Production fantasy Scoreboard / standings / schedules stay on ESPN Fantasy.
 * This module powers the separate Beta area while that platform is built.
 *
 * Upstream: ESPN NFL scoreboard — the live surface used by nflverse /
 * sportsdataverse tooling. (nflverse release files are historical only.)
 */
const CACHE_MS = 15_000;
const SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

let cache = { key: '', at: 0, data: null };

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
  return qs ? `${SCOREBOARD_URL}?${qs}` : SCOREBOARD_URL;
}

async function fetchScoreboardRaw(query) {
  const url = buildQuery(query);
  const key = url;
  if (cache.data && cache.key === key && Date.now() - cache.at < CACHE_MS) {
    return cache.data;
  }

  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'GridIron24-BetaScoring/1.0'
    }
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Live scoring upstream failed (${res.status})`), {
      status: 502
    });
  }
  const raw = await res.json();
  cache = { key, at: Date.now(), data: raw };
  return raw;
}

async function getLiveScoring(query = {}) {
  const raw = await fetchScoreboardRaw(query);
  const season = raw.season || {};
  const week = raw.week || {};
  const games = (raw.events || []).map(normalizeEvent);

  const counts = { live: 0, final: 0, upcoming: 0 };
  for (const g of games) {
    counts[g.status.bucket] = (counts[g.status.bucket] || 0) + 1;
  }

  return {
    ok: true,
    source: 'nflverse-espn-scoreboard',
    provider: 'ESPN NFL Scoreboard (nflverse / sportsdataverse live surface)',
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
  } catch (err) {
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
