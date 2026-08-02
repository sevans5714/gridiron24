/**
 * Little League International schedule/score provider (littleleague.org).
 * Used alongside ESPN so LLWS boards are not tied to a single upstream.
 *
 * Parses public World Series tournament schedule pages (ws-card markup).
 */

const CACHE_MS = 45_000;
const cache = new Map(); // key -> { at, games }

const CURRENT_YEAR = 2026;

/** Tournament schedule pages that cover boys/girls LLWS divisions. */
const TOURNAMENTS = [
  {
    series: 'Senior Baseball',
    path: `/world-series/${CURRENT_YEAR}/slbws/tournaments/world-series/`
  },
  {
    series: 'Intermediate',
    path: `/world-series/${CURRENT_YEAR}/5070/tournaments/world-series/`
  },
  {
    series: 'Junior Baseball',
    path: `/world-series/${CURRENT_YEAR}/jlbws/tournaments/world-series/`
  },
  {
    series: 'Softball',
    path: `/world-series/${CURRENT_YEAR}/llsws/tournaments/world-series/`
  },
  {
    series: 'Junior Softball',
    path: `/world-series/${CURRENT_YEAR}/jlsws/tournaments/world-series/`
  },
  {
    series: 'Senior Softball',
    path: `/world-series/${CURRENT_YEAR}/slsws/tournaments/world-series/`
  },
  {
    series: 'Baseball',
    path: `/world-series/${CURRENT_YEAR}/llbws/tournaments/world-series/`
  }
];

const MONTHS = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12
};

function origin() {
  return 'https://www.littleleague.org';
}

async function fetchHtml(path) {
  const url = path.startsWith('http') ? path : `${origin()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'GridIron24-LittleLeague/1.0'
      },
      signal: controller.signal
    });
    if (!res.ok) {
      const err = new Error(`Little League org ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.text();
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s = '') {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(html = '') {
  return decodeEntities(String(html).replace(/<[^>]+>/g, ' '));
}

function parseCardTime(headerText, year) {
  // Examples:
  // "9:00 A.M. - August 2 @ JB Red Owens"
  // "12:00 PM (ET) - August 2 @ JB Red Owens"
  // "9:00 AM (ET) - August 1 @ JB Red Owens"
  const text = decodeEntities(headerText);
  const m = text.match(
    /(\d{1,2}):(\d{2})\s*(A\.?M\.?|P\.?M\.?)\b(?:\s*\([^)]*\))?\s*[-–]\s*([A-Za-z]+)\s+(\d{1,2})\b/i
  );
  if (!m) return { date: null, label: text };
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const ampm = m[3].replace(/\./g, '').toUpperCase();
  const month = MONTHS[String(m[4]).toLowerCase()];
  const day = Number(m[5]);
  if (!month || !day) return { date: null, label: text };
  if (ampm.startsWith('P') && hour < 12) hour += 12;
  if (ampm.startsWith('A') && hour === 12) hour = 0;
  // Treat schedule times as US Eastern (Little League publishes ET).
  const iso = new Date(Date.UTC(year, month - 1, day, hour + 4, minute, 0));
  // Rough EDT (+4) / EST (+5) — good enough for board ordering; Aug is EDT.
  return {
    date: Number.isNaN(iso.getTime()) ? null : iso.toISOString(),
    label: `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${ampm}`
  };
}

function parseTeams(matchupHtml) {
  const teams = [];
  const lis = String(matchupHtml).match(/<li[\s\S]*?<\/li>/gi) || [];
  for (const li of lis) {
    const abbr = decodeEntities((li.match(/class="[^"]*ws-card__initials[^"]*"[^>]*>([^<]+)/i) || [])[1] || '');
    const name = decodeEntities((li.match(/<h4[^>]*class="[^"]*ws-card__team[^"]*"[^>]*>([^<]+)/i) || [])[1]
      || (li.match(/class="ws-card__team"[^>]*>([^<]+)/i) || [])[1]
      || '');
    const scoreRaw = (li.match(/class="[^"]*ws-card__score[^"]*"[^>]*>([^<]*)/i) || [])[1];
    const score = scoreRaw != null && String(scoreRaw).trim() !== ''
      ? Number(String(scoreRaw).trim())
      : null;
    if (!name && !abbr) continue;
    teams.push({
      id: null,
      abbreviation: abbr || (name || '?').slice(0, 3).toUpperCase(),
      name: name || abbr || 'TBD',
      shortName: name || abbr || 'TBD',
      logo: null,
      score: Number.isFinite(score) ? score : null,
      record: null,
      winner: false
    });
  }
  return teams;
}

function statusForGame({ date, away, home, now = new Date() }) {
  const hasScores = away?.score != null && home?.score != null;
  if (hasScores) {
    return {
      bucket: 'final',
      state: 'post',
      completed: true,
      name: 'STATUS_FINAL',
      detail: 'Final',
      shortDetail: 'Final'
    };
  }
  if (!date) {
    return {
      bucket: 'upcoming',
      state: 'pre',
      completed: false,
      name: 'STATUS_SCHEDULED',
      detail: 'Scheduled',
      shortDetail: 'Scheduled'
    };
  }
  const start = new Date(date).getTime();
  const t = now.getTime();
  if (t < start - 2 * 60_000) {
    return {
      bucket: 'upcoming',
      state: 'pre',
      completed: false,
      name: 'STATUS_SCHEDULED',
      detail: 'Scheduled',
      shortDetail: new Date(date).toLocaleString('en-US', {
        timeZone: 'America/New_York',
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit'
      })
    };
  }
  // No live pitch-by-pitch from this source — treat in-window as live until scores land.
  if (t <= start + 4 * 60 * 60_000) {
    return {
      bucket: 'live',
      state: 'in',
      completed: false,
      name: 'STATUS_IN_PROGRESS',
      detail: 'In Progress',
      shortDetail: 'Live'
    };
  }
  return {
    bucket: 'upcoming',
    state: 'pre',
    completed: false,
    name: 'STATUS_SCHEDULED',
    detail: 'Scheduled',
    shortDetail: 'Scheduled'
  };
}

function parseTournamentHtml(html, { series, year = CURRENT_YEAR, leagueId = 'llws' } = {}) {
  const games = [];
  const source = String(html || '');
  const matchups = [...source.matchAll(/<ul([^>]*ws-card__matchup[^>]*)>([\s\S]*?)<\/ul>/gi)];

  for (const m of matchups) {
    const fullOpen = m[0];
    const idx = m.index ?? source.indexOf(fullOpen);
    const before = source.slice(Math.max(0, idx - 1200), idx);
    const header = (before.match(/<header[\s\S]*$/i) || [])[0]
      || (before.match(/ws-card__title[\s\S]*$/i) || [])[0]
      || before;
    const headerText = stripTags(header);
    // Prefer the meta line that carries kickoff time.
    const metaLine = (header.match(/ws-card__meta[\s\S]*?<\/span>\s*<\/span>/i) || [])[0] || header;
    const timeText = stripTags(metaLine);
    if (!/Game\s+\d+/i.test(headerText) && !/\bA\.?M\.?\b|\bP\.?M\.?\b/i.test(timeText + headerText)) continue;

    const teams = parseTeams(fullOpen);
    if (teams.length < 2) continue;

    const away = teams[0];
    const home = teams[1];
    if (/ws-card__link-list--team-1-wins/i.test(fullOpen)) away.winner = true;
    if (/ws-card__link-list--team-2-wins/i.test(fullOpen)) home.winner = true;

    const { date } = parseCardTime(`${timeText} ${headerText}`, year);
    const status = statusForGame({ date, away, home });
    const gameNo = (headerText.match(/Game\s+(\d+)/i) || [])[1] || '';
    const idSeed = `${series}-${gameNo || 'x'}-${away.abbreviation}-${home.abbreviation}-${(date || headerText).slice(0, 24)}`;
    const slug = idSeed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 56);

    games.push({
      id: `llorg-${slug}`,
      league: leagueId,
      kind: 'team',
      series,
      name: `${away.name} at ${home.name}`,
      shortName: `${away.abbreviation || away.shortName} @ ${home.abbreviation || home.shortName}`,
      date,
      status: {
        bucket: status.bucket,
        state: status.state,
        completed: status.completed,
        name: status.name,
        description: status.detail,
        detail: status.detail,
        shortDetail: status.shortDetail,
        clock: null,
        period: 0
      },
      venue: null,
      broadcasts: [],
      away,
      home,
      odds: null,
      leaders: null,
      provider: 'littleleague.org'
    });
  }
  return games;
}

async function fetchTournamentGames(tournament, { leagueId = 'llws' } = {}) {
  const html = await fetchHtml(tournament.path);
  return parseTournamentHtml(html, {
    series: tournament.series,
    year: CURRENT_YEAR,
    leagueId
  });
}

/**
 * All Little League World Series–family games from littleleague.org.
 * @returns {Promise<{ source: string, provider: string, games: object[] }>}
 */
async function fetchLlwsBoard({ leagueId = 'llws' } = {}) {
  const key = `llws:${leagueId}:${CURRENT_YEAR}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return { source: 'littleleague-org', provider: 'Little League.org', games: hit.games };
  }

  const chunks = await Promise.all(
    TOURNAMENTS.map(async (t) => {
      try {
        return await fetchTournamentGames(t, { leagueId });
      } catch (err) {
        console.warn(`[little-league-org] ${t.series} failed:`, err.message || err);
        return [];
      }
    })
  );

  const games = chunks.flat();
  // Keep recent finals + near-term schedule (regionals / WS windows span weeks).
  const now = Date.now();
  const behindMs = 2 * 24 * 60 * 60_000;
  const aheadMs = 21 * 24 * 60 * 60_000;
  const filtered = games.filter((g) => {
    if (!g.date) return true;
    const t = new Date(g.date).getTime();
    if (Number.isNaN(t)) return true;
    if (t >= now - behindMs && t <= now + aheadMs) return true;
    return g.status?.bucket === 'final' && t >= now - behindMs;
  });

  filtered.sort((a, b) => {
    const order = { live: 0, upcoming: 1, final: 2 };
    const ao = order[a.status?.bucket] ?? 3;
    const bo = order[b.status?.bucket] ?? 3;
    if (ao !== bo) return ao - bo;
    return String(a.date || '').localeCompare(String(b.date || ''));
  });

  cache.set(key, { at: Date.now(), games: filtered });
  return { source: 'littleleague-org', provider: 'Little League.org', games: filtered };
}

module.exports = {
  fetchLlwsBoard,
  parseTournamentHtml,
  TOURNAMENTS
};
