/**
 * Season rules (scoring, lineup, playoff format) lock at kickoff of NFL Week 1.
 */
const nflverseLive = require('./nflverse-live');

const CACHE_MS = 60_000;
let cache = { at: 0, season: null, value: null };

const SEASON_RULE_PATCH_KEYS = [
  'scoring',
  'scoringPreset',
  'rosterSlots',
  'structure',
  'championship',
  'survival'
];

function earliestKickoff(games) {
  let t = null;
  for (const g of games || []) {
    const ms = Date.parse(g?.date);
    if (!Number.isFinite(ms)) continue;
    if (t == null || ms < t) t = ms;
  }
  return t;
}

function gamesHaveStarted(games, now) {
  for (const g of games || []) {
    const bucket = String(g?.status?.bucket || '');
    if (bucket === 'live' || bucket === 'final') return true;
    const ms = Date.parse(g?.date);
    if (Number.isFinite(ms) && ms <= now) return true;
  }
  return false;
}

function pack({ locked, season, firstKickoff, reason, source }) {
  return {
    locked: Boolean(locked),
    season: Number(season) || null,
    firstKickoff: firstKickoff ? new Date(firstKickoff).toISOString() : null,
    lockedAt: locked ? new Date().toISOString() : null,
    reason: reason || (locked ? 'week1_kickoff' : 'unlocked'),
    source: source || null
  };
}

async function evaluate(seasonYear) {
  const now = Date.now();
  const year = Number(seasonYear) || new Date().getFullYear();

  let week1 = null;
  try {
    week1 = await nflverseLive.getLiveScoring({ week: 1, seasontype: 2, season: year });
  } catch {
    week1 = null;
  }

  const week1Games = week1?.games || [];
  const firstKickoff = earliestKickoff(week1Games);
  if (gamesHaveStarted(week1Games, now)) {
    return pack({
      locked: true,
      season: year,
      firstKickoff,
      reason: 'week1_kickoff',
      source: 'nfl-week-1'
    });
  }

  let current = null;
  try {
    current = await nflverseLive.getLiveScoring({ seasontype: 2, season: year });
  } catch {
    current = null;
  }

  const curWeek = Number(current?.week?.number);
  const curType = Number(current?.season?.type);
  if (curType === 2 && curWeek > 1) {
    return pack({
      locked: true,
      season: year,
      firstKickoff,
      reason: 'regular_season_past_week_1',
      source: 'nfl-current'
    });
  }
  if (curType === 3) {
    return pack({
      locked: true,
      season: year,
      firstKickoff,
      reason: 'postseason',
      source: 'nfl-current'
    });
  }
  if (curType === 2 && curWeek === 1 && gamesHaveStarted(current?.games, now)) {
    return pack({
      locked: true,
      season: year,
      firstKickoff: firstKickoff || earliestKickoff(current.games),
      reason: 'week1_kickoff',
      source: 'nfl-current'
    });
  }

  return pack({
    locked: false,
    season: year,
    firstKickoff,
    reason: firstKickoff && firstKickoff > now ? 'before_kickoff' : 'preseason',
    source: week1 ? 'nfl-week-1' : (current ? 'nfl-current' : 'none')
  });
}

async function getStatus(seasonYear) {
  const year = Number(seasonYear) || new Date().getFullYear();
  if (cache.value && cache.season === year && Date.now() - cache.at < CACHE_MS) {
    return cache.value;
  }
  const value = await evaluate(year);
  cache = { at: Date.now(), season: year, value };
  return value;
}

function patchTouchesSeasonRules(patch = {}) {
  return SEASON_RULE_PATCH_KEYS.some((key) => Object.prototype.hasOwnProperty.call(patch, key));
}

module.exports = {
  getStatus,
  patchTouchesSeasonRules,
  SEASON_RULE_PATCH_KEYS
};
