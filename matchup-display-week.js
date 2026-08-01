/**
 * Hold fantasy matchup display on the previous ESPN week until the morning
 * after the last NFL game of that week (6:00 AM America/New_York).
 */
const nflverseLive = require('./nflverse-live');

const CACHE_MS = 60_000;
const MORNING_HOUR_ET = 6;
const GAME_LENGTH_MS = 4 * 60 * 60 * 1000;

let cache = { key: null, at: 0, value: null };

function etParts(ms) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
      .formatToParts(new Date(ms))
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

function etYmd(ms) {
  const p = etParts(ms);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** UTC ms for the next 6:00 AM ET strictly after `afterMs`. */
function nextMorningEtMs(afterMs, hour = MORNING_HOUR_ET) {
  const startYmd = etYmd(afterMs);
  let t = afterMs + 30 * 60 * 1000;
  for (let i = 0; i < 72; i += 1) {
    const p = etParts(t);
    const ymd = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
    if (ymd > startYmd && p.hour === hour && p.minute <= 5) {
      return t - p.minute * 60 * 1000;
    }
    if (ymd <= startYmd) {
      t += 60 * 60 * 1000;
      continue;
    }
    if (p.hour < hour) {
      t += (hour - p.hour) * 60 * 60 * 1000 - p.minute * 60 * 1000;
      continue;
    }
    if (p.hour > hour) {
      t += (24 - p.hour + hour) * 60 * 60 * 1000;
      continue;
    }
    t += 15 * 60 * 1000;
  }
  return afterMs + 12 * 60 * 60 * 1000;
}

function latestKickoffMs(games) {
  let latest = 0;
  for (const g of games || []) {
    const t = Date.parse(g?.date);
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  return latest;
}

/**
 * @param {number} espnWeek ESPN status.currentMatchupPeriod
 * @returns {Promise<{ week: number, espnWeek: number, held: boolean, reason?: string }>}
 */
async function resolveDisplayMatchupWeek(espnWeek) {
  const current = Math.max(1, Number(espnWeek) || 1);
  const key = String(current);
  if (cache.key === key && Date.now() - cache.at < CACHE_MS && cache.value) {
    return cache.value;
  }

  const result = { week: current, espnWeek: current, held: false };
  if (current <= 1) {
    cache = { key, at: Date.now(), value: result };
    return result;
  }

  const prev = current - 1;
  try {
    const slate = await nflverseLive.getLiveScoring({ week: prev, seasontype: 2 });
    const games = Array.isArray(slate?.games) ? slate.games : [];
    if (!games.length) {
      cache = { key, at: Date.now(), value: result };
      return result;
    }

    const incomplete = games.some((g) => String(g?.status?.bucket || '') !== 'final');
    if (incomplete) {
      const held = { week: prev, espnWeek: current, held: true, reason: 'nfl-week-open' };
      cache = { key, at: Date.now(), value: held };
      return held;
    }

    const latestKick = latestKickoffMs(games);
    if (!latestKick) {
      cache = { key, at: Date.now(), value: result };
      return result;
    }

    const estimatedEnd = latestKick + GAME_LENGTH_MS;
    const unlockAt = nextMorningEtMs(estimatedEnd, MORNING_HOUR_ET);
    if (Date.now() < unlockAt) {
      const held = {
        week: prev,
        espnWeek: current,
        held: true,
        reason: 'before-morning-after',
        unlockAt: new Date(unlockAt).toISOString()
      };
      cache = { key, at: Date.now(), value: held };
      return held;
    }
  } catch {
    /* If NFL slate fails, follow ESPN. */
  }

  cache = { key, at: Date.now(), value: result };
  return result;
}

module.exports = {
  resolveDisplayMatchupWeek,
  nextMorningEtMs,
  MORNING_HOUR_ET
};
