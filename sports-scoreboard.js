/**
 * Multi-sport live scores for the Members Lounge.
 * Providers are merged — ESPN is never the sole source of truth.
 *   - ESPN public site scoreboards (multi-host)
 *   - Little League.org tournament schedules (LLWS family)
 *   - MLB Stats, NHL Web, TheSportsDB, optional CFBD
 */

const espnResilient = require('./espn-resilient');
const sportsFallbacks = require('./sports-fallbacks');
const littleLeagueOrg = require('./little-league-org');
const llwsTeams = require('./llws-teams');
const oddsEnrich = require('./odds-enrich');

const CACHE_MS = 20_000;

/** Leagues whose ESPN scoreboard is day-based (not NFL week). */
const DAILY_RANGE_LEAGUES = new Set([
  'mlb',
  'nba',
  'nhl',
  'mls',
  'wnba',
  'ncaam',
  'ncaaw',
  'cbase',
  'csoft',
  'llws'
]);

/** Shared NCAA mark for every college league tab / header. */
const NCAA_LOGO = '/assets/ncaa-logo.png?v=3';

const LEAGUES = {
  nfl: {
    id: 'nfl',
    label: 'NFL',
    sport: 'football',
    league: 'nfl',
    kind: 'team',
    logo: 'https://a.espncdn.com/i/teamlogos/leagues/500/nfl.png',
    // Preseason through Super Bowl
    seasonMonths: [8, 9, 10, 11, 12, 1, 2]
  },
  ncaaf: {
    id: 'ncaaf',
    label: 'College FB',
    sport: 'football',
    league: 'college-football',
    kind: 'team',
    logo: NCAA_LOGO,
    lockLogo: true,
    seasonMonths: [8, 9, 10, 11, 12, 1]
  },
  nba: {
    id: 'nba',
    label: 'NBA',
    sport: 'basketball',
    league: 'nba',
    kind: 'team',
    logo: 'https://a.espncdn.com/i/teamlogos/leagues/500/nba.png',
    seasonMonths: [10, 11, 12, 1, 2, 3, 4, 5, 6]
  },
  ncaam: {
    id: 'ncaam',
    label: 'College MBB',
    sport: 'basketball',
    league: 'mens-college-basketball',
    kind: 'team',
    logo: NCAA_LOGO,
    lockLogo: true,
    seasonMonths: [11, 12, 1, 2, 3, 4]
  },
  ncaaw: {
    id: 'ncaaw',
    label: 'College WBB',
    sport: 'basketball',
    league: 'womens-college-basketball',
    kind: 'team',
    logo: NCAA_LOGO,
    lockLogo: true,
    seasonMonths: [11, 12, 1, 2, 3, 4]
  },
  mlb: {
    id: 'mlb',
    label: 'MLB',
    sport: 'baseball',
    league: 'mlb',
    kind: 'team',
    logo: 'https://a.espncdn.com/i/teamlogos/leagues/500/mlb.png',
    seasonMonths: [3, 4, 5, 6, 7, 8, 9, 10]
  },
  llws: {
    id: 'llws',
    label: 'LLWS',
    sport: 'baseball',
    league: 'llb',
    // Softball World Series uses a separate ESPN league (lls). Merge into one LLWS tab.
    extraLeagues: [
      { sport: 'baseball', league: 'lls', series: 'Softball' }
    ],
    kind: 'team',
    logo: 'https://a.espncdn.com/combiner/i?img=/redesign/assets/img/icons/ESPN-icon-baseball.png',
    // Softball regionals/WS in July–Aug; baseball WS in August
    seasonMonths: [7, 8]
  },
  cbase: {
    id: 'cbase',
    label: 'College Base',
    sport: 'baseball',
    league: 'college-baseball',
    kind: 'team',
    logo: NCAA_LOGO,
    lockLogo: true,
    seasonMonths: [2, 3, 4, 5, 6]
  },
  csoft: {
    id: 'csoft',
    label: 'College SB',
    sport: 'baseball',
    league: 'college-softball',
    kind: 'team',
    logo: NCAA_LOGO,
    lockLogo: true,
    seasonMonths: [2, 3, 4, 5, 6]
  },
  nhl: {
    id: 'nhl',
    label: 'NHL',
    sport: 'hockey',
    league: 'nhl',
    kind: 'team',
    logo: 'https://a.espncdn.com/i/teamlogos/leagues/500/nhl.png',
    seasonMonths: [10, 11, 12, 1, 2, 3, 4, 5, 6]
  },
  wnba: {
    id: 'wnba',
    label: 'WNBA',
    sport: 'basketball',
    league: 'wnba',
    kind: 'team',
    logo: 'https://a.espncdn.com/i/teamlogos/leagues/500/wnba.png',
    seasonMonths: [5, 6, 7, 8, 9, 10]
  },
  mls: {
    id: 'mls',
    label: 'MLS',
    sport: 'soccer',
    league: 'usa.1',
    kind: 'team',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500/19.png',
    seasonMonths: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  },
  golf: {
    id: 'golf',
    label: 'Golf',
    sport: 'golf',
    league: 'leaderboard',
    kind: 'golf',
    // Golf uses a dedicated leaderboard endpoint (not …/scoreboard).
    url: 'https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard',
    logo: 'https://a.espncdn.com/combiner/i?img=/redesign/assets/img/icons/ESPN-icon-golf.png',
    seasonMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  },
  nascar: {
    id: 'nascar',
    label: 'NASCAR',
    sport: 'racing',
    league: 'nascar-premier',
    kind: 'racing',
    logo: 'https://a.espncdn.com/i/teamlogos/leagues/500/nascar.png',
    seasonMonths: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  }
};

const DEFAULT_LEAGUES = [
  'nfl',
  'ncaaf',
  'nba',
  'ncaam',
  'ncaaw',
  'mlb',
  'llws',
  'cbase',
  'csoft',
  'nhl',
  'wnba',
  'mls',
  'golf',
  'nascar'
];

/** Fantasy boards injected by the server (GridIron 24 + AAA). */
const FANTASY_LEAGUE_IDS = new Set(['gi24', 'aaa']);

/** Cap only as a safety valve — ESPN can return a full field. */
const GOLF_LEADER_LIMIT = 40;

/**
 * Off-season boards may surface only for live action or games starting very soon.
 * Prevents NHL/NBA/etc. from appearing all summer because ESPN listed a Sept opener.
 */
const OFFSEASON_UPCOMING_MAX_MS = 2 * 24 * 60 * 60 * 1000;
const OFFSEASON_FINAL_MAX_MS = 36 * 60 * 60 * 1000;

function isLeagueMonthInSeason(meta, now = new Date()) {
  const months = meta?.seasonMonths;
  if (!Array.isArray(months) || !months.length) return true;
  return months.includes(now.getMonth() + 1);
}

function gameStartTime(g) {
  const t = Date.parse(g?.date || '');
  return Number.isFinite(t) ? t : null;
}

function isNearTermUpcoming(g, now = new Date(), maxMs = OFFSEASON_UPCOMING_MAX_MS) {
  if (g?.status?.bucket !== 'upcoming') return false;
  const start = gameStartTime(g);
  if (start == null) return false;
  const t = now.getTime();
  // Allow a small past skew for timezone / late tip-off status lag.
  return start >= t - 6 * 60 * 60 * 1000 && start <= t + maxMs;
}

function boardHasActiveGames(board, now = new Date()) {
  return (board?.games || []).some((g) => {
    if (g?.status?.bucket === 'live') return true;
    return isNearTermUpcoming(g, now);
  });
}

function recountBoardGames(games) {
  const counts = { live: 0, final: 0, upcoming: 0 };
  for (const g of games || []) {
    const bucket = g?.status?.bucket;
    if (bucket && counts[bucket] != null) counts[bucket] += 1;
  }
  return counts;
}

/** Drop far-future schedule teasers from calendar-offseason boards. */
function pruneOffSeasonGames(board, now = new Date()) {
  if (board?.fantasy || FANTASY_LEAGUE_IDS.has(board?.id)) return board;
  const meta = LEAGUES[board?.id];
  if (!meta || isLeagueMonthInSeason(meta, now)) return board;
  const games = (board.games || []).filter((g) => {
    const bucket = g?.status?.bucket;
    if (bucket === 'live') return true;
    if (bucket === 'final') {
      const start = gameStartTime(g);
      if (start == null) return false;
      return start >= now.getTime() - OFFSEASON_FINAL_MAX_MS;
    }
    return isNearTermUpcoming(g, now);
  });
  if (games.length === (board.games || []).length) return board;
  return { ...board, games, counts: recountBoardGames(games) };
}

function gameDedupeKey(g) {
  const day = String(g?.date || '').slice(0, 10);
  const a = String(g?.away?.name || g?.away?.abbreviation || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const h = String(g?.home?.name || g?.home?.abbreviation || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const series = String(g?.series || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return `${series}|${day}|${a}|${h}`;
}

function gameFreshnessScore(g) {
  let score = 0;
  const bucket = g?.status?.bucket;
  if (bucket === 'live') score += 50;
  if (bucket === 'final') score += 30;
  if (bucket === 'upcoming') score += 10;
  if (g?.away?.score != null && g?.home?.score != null) score += 40;
  if (g?.odds) score += 5;
  if (g?.broadcasts?.length) score += 3;
  // Prefer official youth schedules when ESPN has no score yet.
  if (g?.provider === 'littleleague.org') score += 8;
  if (g?.provider === 'espn' || !g?.provider) score += 2;
  return score;
}

/** Merge multi-source games; keep the richest row per matchup. */
function mergeGameLists(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const g of list || []) {
      if (!g) continue;
      const key = gameDedupeKey(g) || `id:${g.id}`;
      const prev = map.get(key);
      if (!prev || gameFreshnessScore(g) >= gameFreshnessScore(prev)) {
        const llws = g.league === 'llws' || prev?.league === 'llws';
        map.set(key, {
          ...prev,
          ...g,
          series: g.series || prev?.series || null,
          provider: g.provider || prev?.provider || null,
          odds: g.odds || prev?.odds || null,
          broadcasts: (g.broadcasts && g.broadcasts.length)
            ? g.broadcasts
            : (prev?.broadcasts || g.broadcasts || []),
          away: llws
            ? llwsTeams.mergeLlwsSide(prev?.away, g.away)
            : { ...(prev?.away || {}), ...(g.away || {}), logo: g?.away?.logo || prev?.away?.logo || null },
          home: llws
            ? llwsTeams.mergeLlwsSide(prev?.home, g.home)
            : { ...(prev?.home || {}), ...(g.home || {}), logo: g?.home?.logo || prev?.home?.logo || null },
          status: g.status || prev?.status
        });
      }
    }
  }
  const out = [...map.values()];
  out.sort((a, b) => {
    const order = { live: 0, upcoming: 1, final: 2 };
    const ao = order[a.status?.bucket] ?? 3;
    const bo = order[b.status?.bucket] ?? 3;
    if (ao !== bo) return ao - bo;
    return String(a.date || '').localeCompare(String(b.date || ''));
  });
  return out;
}

async function fetchSecondaryGames(leagueId) {
  const extras = [];
  if (leagueId === 'llws') {
    try {
      const ll = await littleLeagueOrg.fetchLlwsBoard({ leagueId: 'llws' });
      if (ll?.games?.length) extras.push(ll.games);
    } catch (err) {
      console.warn('[sports] littleleague.org merge failed', err.message || err);
    }
  }
  try {
    const fb = await sportsFallbacks.fetchFallbackBoard(leagueId);
    if (fb?.games?.length) {
      extras.push(fb.games.map((g) => ({ ...g, provider: fb.provider || fb.source || 'fallback' })));
    }
  } catch {
    /* optional */
  }
  return extras.flat();
}

/** Keep calendar-in-season leagues, plus any offseason board that still has live/near-term games. */
function filterInSeasonBoards(boards, now = new Date()) {
  return (boards || [])
    .map((board) => pruneOffSeasonGames(board, now))
    .filter((board) => {
      if (board?.fantasy || FANTASY_LEAGUE_IDS.has(board?.id)) return true;
      const meta = LEAGUES[board.id];
      if (!meta) return Boolean(board?.games?.length);
      if (isLeagueMonthInSeason(meta, now)) return true;
      return boardHasActiveGames(board, now);
    })
    .map((board) => ({
      ...board,
      inSeason: board?.fantasy || FANTASY_LEAGUE_IDS.has(board?.id)
        ? true
        : isLeagueMonthInSeason(LEAGUES[board.id], now)
    }));
}

function yyyymmddLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function sitePathForMeta(meta, { daysAhead = 0, daysBehind = 0, forceDateRange = false } = {}) {
  if (meta.url) {
    try {
      const u = new URL(meta.url);
      return `${u.pathname.replace(/^\//, '')}${u.search || ''}`;
    } catch {
      return null;
    }
  }
  let path = `apis/site/v2/sports/${meta.sport}/${meta.league}/scoreboard`;
  const cap = forceDateRange ? 14 : 10;
  const ahead = Math.max(0, Math.min(cap, Number(daysAhead) || 0));
  const behind = Math.max(0, Math.min(cap, Number(daysBehind) || 0));
  // Settlement pulls force a date window for week-based boards (NFL / CFB) so
  // finished games still appear after ESPN rolls to the next week.
  const useDates =
    (ahead > 0 || behind > 0) &&
    (forceDateRange || DAILY_RANGE_LEAGUES.has(meta.id)) &&
    meta.kind !== 'golf' &&
    meta.kind !== 'racing';
  if (useDates) {
    const start = new Date();
    start.setDate(start.getDate() - behind);
    const end = new Date();
    end.setDate(end.getDate() + ahead);
    path += `?dates=${yyyymmddLocal(start)}-${yyyymmddLocal(end)}&limit=300`;
  }
  return path;
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
    abbreviation: team.abbreviation || '',
    name: team.displayName || team.name || '',
    shortName: team.shortDisplayName || team.name || '',
    logo: team.logo || null,
    score: row.score == null || row.score === '' ? null : Number(row.score),
    record: row.records?.[0]?.summary || null,
    winner: Boolean(row.winner)
  };
}

/** Pull DraftKings (etc.) lines ESPN embeds on scoreboard competitions. */
function pickOdds(competition) {
  const raw = Array.isArray(competition?.odds) ? competition.odds[0] : null;
  const normalized = oddsEnrich.normalizeEspnOddsBlob(raw);
  return oddsEnrich.hasUsableOdds(normalized) ? normalized : null;
}

function normalizeTeamEvent(event, leagueId, { series = null } = {}) {
  const competition = event?.competitions?.[0] || {};
  const status = competition.status || {};
  const type = status.type || {};
  const state = String(type.state || 'pre');
  const completed = Boolean(type.completed);
  const bucket = statusBucket(state, completed);
  const broadcasts = (competition.broadcasts || [])
    .flatMap((b) => b.names || [])
    .filter(Boolean);

  return {
    id: event.id,
    league: leagueId,
    kind: 'team',
    series: series || null,
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
    away: pickCompetitor(competition.competitors, 'away'),
    home: pickCompetitor(competition.competitors, 'home'),
    odds: pickOdds(competition),
    leaders: null
  };
}

function golfPositionSort(a, b) {
  const pa = Number(a.status?.position?.id);
  const pb = Number(b.status?.position?.id);
  if (Number.isFinite(pa) && Number.isFinite(pb) && pa !== pb) return pa - pb;
  return (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0);
}

  /** ESPN often puts an ISO tee time in displayValue between rounds — never show that raw. */
function golfThruLabel(status = {}) {
  const thruN = Number(status.thru);
  if (Number.isFinite(thruN) && thruN > 0) return thruN >= 18 ? 'F' : String(thruN);
  if (status.displayThru) {
    const thru = compactGolfTee(String(status.displayThru));
    if (thru && thru !== '—') return thru;
  }
  const detail = String(status.detail || '').trim();
  if (detail && !/^scheduled$/i.test(detail) && !looksLikeGolfScore(detail)) {
    const tee = compactGolfTee(detail);
    if (tee && tee !== '—') return tee;
  }
  if (status.teeTime) {
    const tee = compactGolfTee(String(status.teeTime));
    if (tee && tee !== '—') return tee;
  }
  const dv = String(status.displayValue || '').trim();
  if (dv && dv !== '-') {
    const tee = compactGolfTee(dv);
    if (tee && tee !== '—') return tee;
  }
  return '—';
}

function looksLikeIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}T/.test(String(value || '').trim());
}

function looksLikeGolfScore(value) {
  const s = String(value || '').trim();
  return /^([+-]?\d+|E)\s*(?:\(\d+\))?$/i.test(s);
}

function formatGolfTeeIso(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).formatToParts(d);
    const hour = parts.find((p) => p.type === 'hour')?.value;
    const minute = parts.find((p) => p.type === 'minute')?.value;
    const period = String(parts.find((p) => p.type === 'dayPeriod')?.value || '');
    const ap = period[0] ? period[0].toLowerCase() : '';
    if (hour && minute && ap) return `${hour}:${minute}${ap}`;
  } catch {
    /* fall through */
  }
  return '';
}

/** "1:20 PM ET" / "8:42 AM" / ISO → "1:20p" / "8:42a" so the Tee column stays readable. */
function compactGolfTee(value) {
  const s = String(value || '').trim();
  if (!s || s === '-' || s === '—') return '—';
  if (looksLikeIsoDate(s)) return formatGolfTeeIso(s) || '—';
  const m = s.match(/(\d{1,2}:\d{2})\s*([AaPp])(?:\.?[Mm]\.?)?(?:\s*[A-Z]{1,3})?/);
  if (m) return `${m[1]}${m[2].toLowerCase()}`;
  const already = s.match(/^(\d{1,2}:\d{2})([ap])$/i);
  if (already) return `${already[1]}${already[2].toLowerCase()}`;
  return s;
}

/** Pull today's to-par from ESPN (without the "(thru)" suffix). Never use tee-time detail. */
function golfTodayScore(row = {}, rowStatus = {}) {
  const lines = Array.isArray(row.linescores) ? row.linescores : [];
  const currentPeriod = Number(rowStatus.period) || 0;
  const currentLine = lines.find((ls) => Number(ls.period) === currentPeriod && ls.displayValue != null)
    || [...lines].reverse().find((ls) => ls.displayValue != null && ls.displayValue !== '');
  if (currentLine?.displayValue != null && String(currentLine.displayValue).trim() !== '') {
    const fromLine = String(currentLine.displayValue).trim();
    if (fromLine !== '-' && !looksLikeIsoDate(fromLine) && !/\d{1,2}:\d{2}/.test(fromLine)) {
      return fromLine;
    }
  }
  const raw = String(rowStatus.todayDetail || '').trim();
  if (!raw || /^scheduled$/i.test(raw) || looksLikeIsoDate(raw) || /\d{1,2}:\d{2}/.test(raw)) return null;
  const m = raw.match(/^([+-]?\d+|E)\s*(?:\(\d+\))?$/i);
  if (m) return m[1].toUpperCase() === 'E' ? 'E' : m[1];
  if (looksLikeGolfScore(raw)) return raw;
  return null;
}

function normalizeGolfEvent(event) {
  const competition = event?.competitions?.[0] || {};
  const eventType = event?.status?.type || {};
  const compStatus = competition.status || {};
  const compType = compStatus.type || {};
  // Tournament-level state wins: round "Play Complete" must not mark a live event final.
  const type = eventType.state ? eventType : compType;
  const state = String(type.state || 'pre');
  const completed = Boolean(type.completed);
  const bucket = statusBucket(state, completed);
  const broadcasts = (competition.broadcasts || [])
    .flatMap((b) => b.names || [])
    .filter(Boolean);
  const roundDetail = compType.shortDetail || compType.detail || type.shortDetail || type.detail || '';

  const leaders = (competition.competitors || [])
    .slice()
    .sort(golfPositionSort)
    .slice(0, GOLF_LEADER_LIMIT)
    .map((row) => {
      const athlete = row.athlete || {};
      const rowStatus = row.status || {};
      const scoreRaw = row.score?.displayValue ?? row.score;
      const overall = (scoreRaw == null || scoreRaw === '' || scoreRaw === '-')
        ? null
        : String(scoreRaw);
      const today = golfTodayScore(row, rowStatus);
      // Prefer overall for `score` (back-compat); keep today separate for the board.
      const score = overall || today || '—';
      const positionId = rowStatus.position?.id != null ? String(rowStatus.position.id) : null;
      const orderN = Number(positionId);
      return {
        id: row.id || athlete.id || null,
        name: athlete.displayName || athlete.fullName || '',
        shortName: athlete.shortName || athlete.displayName || '',
        position: rowStatus.position?.displayName || '—',
        positionId,
        order: Number.isFinite(orderN) ? orderN : null,
        score,
        overall: overall || '—',
        today: today || '—',
        thru: golfThruLabel(rowStatus),
        state: rowStatus.type?.state || state,
        winner: Boolean(row.winner)
      };
    });

  return {
    id: event.id,
    league: 'golf',
    kind: 'golf',
    name: event.name || '',
    shortName: event.shortName || event.name || '',
    date: event.date || competition.date || null,
    status: {
      bucket,
      state,
      completed,
      name: type.name || '',
      description: type.description || '',
      detail: roundDetail || type.detail || '',
      shortDetail: roundDetail || type.shortDetail || type.detail || '',
      clock: null,
      period: compStatus.period || 0
    },
    venue: event.courses?.[0]?.name || null,
    broadcasts,
    away: null,
    home: null,
    leaders
  };
}

function normalizeRacingEvent(event, leagueId = 'nascar') {
  const competition = event?.competitions?.[0] || {};
  const type = competition.status?.type || event?.status?.type || {};
  const state = String(type.state || 'pre');
  const completed = Boolean(type.completed);
  const bucket = statusBucket(state, completed);
  const broadcasts = (competition.broadcasts || [])
    .flatMap((b) => b.names || [])
    .filter(Boolean);
  if (competition.broadcast && !broadcasts.length) {
    const b = competition.broadcast;
    if (typeof b === 'string') broadcasts.push(b);
    else if (b?.market) broadcasts.push(String(b.market));
  }

  const leaders = (competition.competitors || [])
    .slice()
    .sort((a, b) => (Number(a.order) || 999) - (Number(b.order) || 999))
    .slice(0, GOLF_LEADER_LIMIT)
    .map((row) => {
      const athlete = row.athlete || {};
      const order = Number(row.order);
      return {
        id: row.id || athlete.id || null,
        name: athlete.displayName || athlete.fullName || '',
        shortName: athlete.shortName || athlete.displayName || '',
        position: Number.isFinite(order) ? String(order) : '—',
        positionId: Number.isFinite(order) ? String(order) : null,
        order: Number.isFinite(order) ? order : null,
        score: '—',
        thru: row.winner ? 'W' : (completed && Number.isFinite(order) ? 'F' : '—'),
        state,
        winner: Boolean(row.winner)
      };
    });

  return {
    id: event.id,
    league: leagueId,
    kind: 'racing',
    name: event.name || '',
    shortName: event.shortName || event.name || '',
    date: event.date || competition.date || competition.startDate || null,
    status: {
      bucket,
      state,
      completed,
      name: type.name || '',
      description: type.description || '',
      detail: type.detail || '',
      shortDetail: type.shortDetail || type.detail || '',
      clock: null,
      period: competition.status?.period || 0
    },
    venue: competition.venue?.fullName || null,
    broadcasts,
    away: null,
    home: null,
    leaders
  };
}

let nascarStandingsCache = { at: 0, leaders: [] };

async function fetchNascarStandingsLeaders() {
  const now = Date.now();
  if (now - nascarStandingsCache.at < 15 * 60_000 && nascarStandingsCache.leaders.length) {
    return nascarStandingsCache.leaders;
  }
  try {
    const hit = await espnResilient.fetchJsonResilient({
      urls: [
        'https://site.web.api.espn.com/apis/v2/sports/racing/nascar-premier/standings',
        'https://site.api.espn.com/apis/v2/sports/racing/nascar-premier/standings'
      ],
      cacheKey: 'site:nascar:standings',
      ttlMs: 15 * 60_000,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'GridIron24-MembersLounge/1.0'
      },
      lane: 'site'
    });
    const entries = hit.data?.children?.[0]?.standings?.entries || [];
    const leaders = entries.slice(0, GOLF_LEADER_LIMIT).map((row, idx) => {
      const athlete = row.athlete || {};
      const rankStat = (row.stats || []).find((s) => s.name === 'rank' || s.abbreviation === 'RK');
      const ptsStat = (row.stats || []).find((s) => s.name === 'championshipPts' || s.abbreviation === 'PTS');
      const rank = Number(rankStat?.value);
      const order = Number.isFinite(rank) ? rank : idx + 1;
      return {
        id: athlete.id || null,
        name: athlete.displayName || athlete.fullName || '',
        shortName: athlete.shortName || athlete.displayName || '',
        position: String(order),
        positionId: String(order),
        order,
        score: ptsStat?.displayValue || '—',
        thru: 'RK',
        state: 'pre',
        winner: false,
        provisional: true
      };
    }).filter((p) => p.id);
    nascarStandingsCache = { at: now, leaders };
    return leaders;
  } catch {
    return nascarStandingsCache.leaders || [];
  }
}

async function fillRacingFields(games) {
  const list = Array.isArray(games) ? games : [];
  const needsField = list.some((g) => g?.kind === 'racing' && !(g.leaders && g.leaders.length)
    && g.status?.bucket !== 'final');
  if (!needsField) return list;
  const standings = await fetchNascarStandingsLeaders();
  if (!standings.length) return list;
  return list.map((g) => {
    if (g?.kind !== 'racing' || (g.leaders && g.leaders.length) || g.status?.bucket === 'final') {
      return g;
    }
    return { ...g, leaders: standings };
  });
}

function boardHasOpenGames(games) {
  return (games || []).some((g) => {
    const bucket = g?.status?.bucket;
    return bucket === 'live' || bucket === 'upcoming';
  });
}

/** ESPN week boards lag after a slate ends (preseason NFL stuck on last week's finals). */
async function fetchFootballWeekRaw(meta, { week, seasontype }) {
  const w = Number(week);
  if (!Number.isFinite(w) || w < 1) return null;
  const q = [`week=${w}`];
  const st = Number(seasontype);
  if (Number.isFinite(st) && st > 0) q.push(`seasontype=${st}`);
  const pathAndQuery = `apis/site/v2/sports/${meta.sport}/${meta.league}/scoreboard?${q.join('&')}`;
  const hit = await espnResilient.fetchJsonResilient({
    urls: espnResilient.siteApiUrls(pathAndQuery),
    cacheKey: `site:${meta.id}:${pathAndQuery}`,
    ttlMs: CACHE_MS,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'GridIron24-MembersLounge/1.0'
    },
    lane: 'site'
  });
  return hit.data || null;
}

async function rollForwardFootballWeek(meta, raw, games) {
  if (meta?.id !== 'nfl' && meta?.id !== 'ncaaf') return null;
  if (boardHasOpenGames(games)) return null;
  const week = Number(raw?.week?.number);
  const seasontype = Number(raw?.season?.type);
  if (!Number.isFinite(week) || week < 1) return null;
  try {
    const nextRaw = await fetchFootballWeekRaw(meta, { week: week + 1, seasontype });
    const nextGames = (nextRaw?.events || []).map((ev) => ({
      ...normalizeTeamEvent(ev, meta.id),
      provider: 'espn'
    }));
    if (!boardHasOpenGames(nextGames)) return null;
    return { raw: nextRaw, games: nextGames };
  } catch {
    return null;
  }
}

async function fetchLeagueRaw(meta, { daysAhead = 0, daysBehind = 0, forceDateRange = false } = {}) {
  const pathAndQuery = sitePathForMeta(meta, { daysAhead, daysBehind, forceDateRange });
  if (!pathAndQuery) {
    throw Object.assign(new Error(`${meta.label} scoreboard URL invalid`), { status: 502 });
  }
  const hit = await espnResilient.fetchJsonResilient({
    urls: espnResilient.siteApiUrls(pathAndQuery),
    cacheKey: `site:${meta.id}:${pathAndQuery}`,
    ttlMs: CACHE_MS,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'GridIron24-MembersLounge/1.0'
    },
    lane: 'site'
  });
  return { raw: hit.data, source: hit.source, from: hit.from };
}

/** Extra ESPN league slugs folded into one board (e.g. LLWS baseball + softball). */
async function fetchExtraLeagueGames(meta, boardId, { daysAhead = 0, daysBehind = 0, forceDateRange = false } = {}) {
  const extras = Array.isArray(meta?.extraLeagues) ? meta.extraLeagues : [];
  if (!extras.length) return [];
  const chunks = await Promise.all(extras.map(async (extra) => {
    const subMeta = {
      id: `${meta.id}:${extra.league}`,
      label: meta.label,
      sport: extra.sport || meta.sport,
      league: extra.league,
      kind: meta.kind
    };
    try {
      const { raw } = await fetchLeagueRaw(subMeta, { daysAhead, daysBehind, forceDateRange });
      const series = extra.series || null;
      return (raw.events || []).map((ev) => normalizeTeamEvent(ev, boardId, { series }));
    } catch {
      return [];
    }
  }));
  return chunks.flat();
}

/** Single-game fetch for open tickets whose event dropped off the scoreboard. */
async function fetchTeamEventById(leagueId, eventId) {
  const meta = LEAGUES[leagueId];
  const id = String(eventId || '').trim();
  if (!meta || !id || meta.kind === 'golf' || meta.kind === 'racing') return null;
  const leagueSlugs = [
    meta.league,
    ...((meta.extraLeagues || []).map((e) => e.league).filter(Boolean))
  ];
  for (const slug of leagueSlugs) {
    const pathAndQuery = `apis/site/v2/sports/${meta.sport}/${slug}/summary?event=${encodeURIComponent(id)}`;
    try {
      const hit = await espnResilient.fetchJsonResilient({
        urls: espnResilient.siteApiUrls(pathAndQuery),
        cacheKey: `site:event:${meta.id}:${slug}:${id}`,
        ttlMs: CACHE_MS,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'GridIron24-MembersLounge/1.0'
        },
        lane: 'site'
      });
      const raw = hit.data || {};
      const header = raw.header || {};
      const competition =
        (Array.isArray(header.competitions) && header.competitions[0]) ||
        (Array.isArray(raw.competitions) && raw.competitions[0]) ||
        null;
      if (!competition) continue;
      const event = {
        id: String(header.id || id),
        name: header.name || '',
        shortName: header.shortDetail || header.name || '',
        date: competition.date || header.date || null,
        competitions: [competition]
      };
      const seriesHit = (meta.extraLeagues || []).find((e) => e.league === slug);
      const game = normalizeTeamEvent(event, meta.id, {
        series: seriesHit?.series || (slug === meta.league && meta.extraLeagues?.length ? 'Baseball' : null)
      });
      return meta.id === 'llws' ? llwsTeams.enrichLlwsGame(game) : game;
    } catch {
      /* try next slug */
    }
  }
  return null;
}

function pickLeagueLogo(raw, fallback) {
  const logos = raw?.leagues?.[0]?.logos;
  if (!Array.isArray(logos) || !logos.length) return fallback || null;
  const ranked = [...logos].sort((a, b) => {
    const ra = Array.isArray(a.rel) ? a.rel : [];
    const rb = Array.isArray(b.rel) ? b.rel : [];
    const score = (rel) => (rel.includes('dark') ? 2 : 0) + (rel.includes('full') ? 1 : 0) + (rel.includes('default') ? 1 : 0);
    return score(rb) - score(ra);
  });
  return ranked[0]?.href || fallback || null;
}

function parseLeagueList(param) {
  if (!param || !String(param).trim()) return DEFAULT_LEAGUES.slice();
  const ids = String(param)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((id) => LEAGUES[id]);
  return ids.length ? [...new Set(ids)] : DEFAULT_LEAGUES.slice();
}

function boardFromGames(meta, games, { source, provider, from = 'fallback' } = {}) {
  const counts = { live: 0, final: 0, upcoming: 0 };
  const list = Array.isArray(games) ? games.slice() : [];
  for (const g of list) {
    counts[g.status?.bucket] = (counts[g.status?.bucket] || 0) + 1;
  }
  list.sort((a, b) => {
    const order = { live: 0, upcoming: 1, final: 2 };
    const ao = order[a.status?.bucket] ?? 3;
    const bo = order[b.status?.bucket] ?? 3;
    if (ao !== bo) return ao - bo;
    return String(a.date || '').localeCompare(String(b.date || ''));
  });
  return {
    ok: true,
    id: meta.id,
    label: meta.label,
    kind: meta.kind,
    logo: meta.logo || null,
    from,
    source: source || from,
    provider: provider || null,
    fantasy: Boolean(meta.fantasy),
    counts,
    games: list,
    season: meta.season || null,
    week: meta.week || null
  };
}

function fantasyTeamAbbr(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const a = parts[0].replace(/[^A-Za-z0-9]/g, '');
    const b = parts[parts.length - 1].replace(/[^A-Za-z0-9]/g, '');
    if (a && b) return `${a[0]}${b.slice(0, 3)}`.toUpperCase();
  }
  return s.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase() || '?';
}

function formatFantasyRecord(rec) {
  if (rec == null || rec === '') return null;
  if (typeof rec === 'string') {
    const s = rec.trim();
    return s || null;
  }
  if (typeof rec !== 'object') return null;
  const w = Number(rec.wins);
  const l = Number(rec.losses);
  const t = Number(rec.ties);
  if (!Number.isFinite(w) && !Number.isFinite(l)) return null;
  const wins = Number.isFinite(w) ? w : 0;
  const losses = Number.isFinite(l) ? l : 0;
  const ties = Number.isFinite(t) ? t : 0;
  return ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

function fantasySide(team, winnerCode, sideCode) {
  if (!team) return null;
  const score = Number(team.score);
  const projected = Number(team.projected);
  return {
    id: team.id ?? null,
    abbreviation: fantasyTeamAbbr(team.name),
    name: team.name || `Team ${team.id || ''}`,
    shortName: team.name || `Team ${team.id || ''}`,
    logo: team.logo || null,
    score: Number.isFinite(score) ? score : null,
    projected: Number.isFinite(projected) ? projected : null,
    record: formatFantasyRecord(team.record),
    winner: winnerCode === sideCode
  };
}

/** Spread = projected point difference; O/U = combined projected points. */
function fantasyOddsFromProjected(awayProj, homeProj) {
  const a = Number(awayProj);
  const h = Number(homeProj);
  if (!Number.isFinite(a) || !Number.isFinite(h)) return null;
  const round1 = (n) => Math.round(Number(n) * 10) / 10;
  const total = round1(a + h);
  // Favorite (higher projection) gets the negative line.
  const awaySpread = round1(h - a);
  const homeSpread = round1(a - h);
  return {
    details: `Proj ${round1(a).toFixed(1)}–${round1(h).toFixed(1)}`,
    provider: 'Projected',
    source: 'fantasy-proj',
    overUnder: total,
    away: {
      favorite: a > h,
      spread: awaySpread,
      moneyline: null
    },
    home: {
      favorite: h > a,
      spread: homeSpread,
      moneyline: null
    }
  };
}

/**
 * Map an ESPN fantasy matchup into the sports scoreboard game shape.
 * @param {object} matchup normalizeSchedule matchup
 * @param {{ leagueId: string, confLabel?: string, week?: number }} opts
 */
function fantasyMatchupToGame(matchup, opts = {}) {
  const leagueId = opts.leagueId || 'gi24';
  const winner = String(matchup?.winner || 'UNDECIDED').toUpperCase();
  const decided = winner === 'HOME' || winner === 'AWAY';
  const homeScore = Number(matchup?.home?.score || 0);
  const awayScore = Number(matchup?.away?.score || 0);
  const scoringStarted = homeScore > 0 || awayScore > 0;
  let bucket = 'upcoming';
  let shortDetail = opts.confLabel ? `${opts.confLabel} · Upcoming` : 'Upcoming';
  let state = 'pre';
  if (decided) {
    bucket = 'final';
    shortDetail = opts.confLabel ? `${opts.confLabel} · Final` : 'Final';
    state = 'post';
  } else if (scoringStarted) {
    bucket = 'live';
    shortDetail = opts.confLabel ? `${opts.confLabel} · Live` : 'Live';
    state = 'in';
  } else if (opts.confLabel) {
    shortDetail = `${opts.confLabel} · Upcoming`;
  }

  const week = opts.week != null ? Number(opts.week) : Number(matchup?.matchupPeriodId) || null;
  const awayName = matchup?.away?.name || 'Away';
  const homeName = matchup?.home?.name || 'Home';
  const away = fantasySide(matchup?.away, winner, 'AWAY');
  const home = fantasySide(matchup?.home, winner, 'HOME');

  return {
    id: `ffl-${leagueId}-${matchup?.id ?? `${awayName}-${homeName}`}`,
    league: leagueId,
    kind: 'team',
    fantasy: true,
    name: `${awayName} at ${homeName}`,
    shortName: `${fantasyTeamAbbr(awayName)} @ ${fantasyTeamAbbr(homeName)}`,
    date: null,
    week,
    confLabel: opts.confLabel || null,
    status: {
      bucket,
      state,
      completed: decided,
      name: decided ? 'STATUS_FINAL' : (scoringStarted ? 'STATUS_IN_PROGRESS' : 'STATUS_SCHEDULED'),
      description: shortDetail,
      detail: week != null ? `Week ${week}` : shortDetail,
      shortDetail: week != null ? `Week ${week}` : shortDetail,
      clock: null,
      period: 0
    },
    venue: null,
    broadcasts: [],
    away,
    home,
    odds: fantasyOddsFromProjected(away?.projected, home?.projected),
    leaders: null
  };
}

/**
 * Build a fantasy league board from schedule conference payloads.
 * @param {{ id: string, label: string, logo?: string }} meta
 * @param {Array<object>} conferences scheduleForConference results
 */
function boardFromFantasyConferences(meta, conferences = []) {
  const games = [];
  let week = null;
  let season = null;
  for (const conf of conferences) {
    if (!conf?.ok) continue;
    if (week == null && conf.week != null) week = Number(conf.week);
    for (const m of conf.matchups || []) {
      games.push(fantasyMatchupToGame(m, {
        leagueId: meta.id,
        confLabel: conf.shortName || conf.name || null,
        week: conf.week
      }));
    }
  }
  return boardFromGames(
    {
      id: meta.id,
      label: meta.label,
      kind: 'team',
      logo: meta.logo || null,
      fantasy: true,
      week: week != null ? { number: week, text: `Week ${week}` } : null,
      season
    },
    games,
    { source: 'espn-fantasy', from: 'fantasy' }
  );
}

async function getSportsScores({
  leagues,
  extraBoards = [],
  daysAhead = 0,
  daysBehind = 0,
  forceDateRange = false,
  /** When false (settlement), keep off-season boards so open tickets can still grade. */
  applySeasonFilter = true
} = {}) {
  const ids = parseLeagueList(leagues);
  const fetchedAt = new Date().toISOString();
  let usedFallback = false;
  const boards = await Promise.all(
    ids.map(async (id) => {
      const meta = LEAGUES[id];
      if (!meta) {
        return {
          ok: false,
          id,
          label: String(id).toUpperCase(),
          kind: 'team',
          logo: null,
          error: 'Unknown league',
          counts: { live: 0, final: 0, upcoming: 0 },
          games: []
        };
      }
      try {
        const fetched = await fetchLeagueRaw(meta, {
          daysAhead,
          daysBehind,
          forceDateRange
        });
        let raw = fetched.raw;
        const from = fetched.from;
        let games = (raw.events || []).map((ev) => {
          if (meta.kind === 'golf') return normalizeGolfEvent(ev);
          if (meta.kind === 'racing') return normalizeRacingEvent(ev, meta.id);
          const series = meta.extraLeagues?.length ? 'Baseball' : null;
          return { ...normalizeTeamEvent(ev, id, { series }), provider: 'espn' };
        });
        if (!forceDateRange) {
          const rolled = await rollForwardFootballWeek(meta, raw, games);
          if (rolled?.games?.length) {
            games = rolled.games;
            raw = rolled.raw || raw;
          }
        }
        if (meta.extraLeagues?.length && meta.kind === 'team') {
          const extras = await fetchExtraLeagueGames(meta, id, {
            daysAhead,
            daysBehind,
            forceDateRange
          });
          if (extras.length) {
            const seen = new Set(games.map((g) => String(g.id)));
            for (const g of extras) {
              if (seen.has(String(g.id))) continue;
              seen.add(String(g.id));
              games.push({ ...g, provider: g.provider || 'espn' });
            }
          }
        }
        if (meta.kind === 'racing') {
          games = await fillRacingFields(games);
        }
        // Always merge secondary providers — ESPN is never the sole source of truth.
        const secondary = await fetchSecondaryGames(id);
        if (secondary.length) {
          usedFallback = true;
          games = mergeGameLists(games, secondary);
        }
        if (id === 'llws') {
          games = games.map((g) => llwsTeams.enrichLlwsGame(g));
        }
        const counts = { live: 0, final: 0, upcoming: 0 };
        for (const g of games) {
          counts[g.status.bucket] = (counts[g.status.bucket] || 0) + 1;
        }
        games.sort((a, b) => {
          const order = { live: 0, upcoming: 1, final: 2 };
          const ao = order[a.status?.bucket] ?? 3;
          const bo = order[b.status?.bucket] ?? 3;
          if (ao !== bo) return ao - bo;
          return String(a.date || '').localeCompare(String(b.date || ''));
        });
        const providers = [...new Set(games.map((g) => g.provider).filter(Boolean))];
        return {
          ok: true,
          id: meta.id,
          label: meta.label,
          kind: meta.kind,
          logo: meta.lockLogo ? (meta.logo || null) : pickLeagueLogo(raw, meta.logo),
          from: from || 'live',
          source: providers.length > 1 ? 'multi' : (providers[0] || 'espn'),
          providers,
          counts,
          games,
          season: raw.season
            ? {
                year: raw.season.year || null,
                type: raw.season.type || null,
                name: raw.season.name || null
              }
            : null,
          week: raw.week
            ? { number: raw.week.number || null, text: raw.week.text || null }
            : null
        };
      } catch (err) {
        try {
          const secondary = await fetchSecondaryGames(id);
          if (secondary.length) {
            usedFallback = true;
            return boardFromGames(meta, secondary, {
              source: 'multi',
              provider: 'fallback',
              from: 'fallback'
            });
          }
        } catch {
          /* fall through */
        }
        return {
          ok: false,
          id: meta.id,
          label: meta.label,
          kind: meta.kind,
          logo: meta.logo || null,
          error: err.message || 'Unavailable',
          counts: { live: 0, final: 0, upcoming: 0 },
          games: []
        };
      }
    })
  );

  const fantasyBoards = (Array.isArray(extraBoards) ? extraBoards : [])
    .filter((b) => b && b.id);
  const merged = [...fantasyBoards, ...boards];
  const enriched = await oddsEnrich.enrichBoards(merged);
  // Keep projected fantasy lines; don't let odds enrichers wipe them.
  for (const board of enriched) {
    if (!board?.fantasy && !FANTASY_LEAGUE_IDS.has(board?.id)) continue;
    board.fantasy = true;
    for (const g of board.games || []) {
      g.fantasy = true;
      if (!g.odds) {
        g.odds = fantasyOddsFromProjected(g.away?.projected, g.home?.projected);
      }
    }
  }
  const visible = applySeasonFilter
    ? filterInSeasonBoards(enriched)
    : enriched.map((board) => ({
        ...board,
        inSeason: board?.fantasy || FANTASY_LEAGUE_IDS.has(board?.id)
          ? true
          : isLeagueMonthInSeason(LEAGUES[board.id])
      }));

  const totals = { live: 0, final: 0, upcoming: 0, games: 0 };
  let oddsFilled = 0;
  for (const b of visible) {
    totals.live += b.counts?.live || 0;
    totals.final += b.counts?.final || 0;
    totals.upcoming += b.counts?.upcoming || 0;
    totals.games += (b.games || []).length;
    for (const g of b.games || []) {
      if (oddsEnrich.hasUsableOdds(g.odds)) oddsFilled += 1;
    }
  }

  return {
    ok: true,
    source: usedFallback ? 'multi-source' : 'espn-site-scoreboard',
    fallbackUsed: usedFallback,
    oddsFilled,
    upstream: espnResilient.getUpstreamStatus().site,
    fetchedAt,
    cacheMs: CACHE_MS,
    totals,
    leagues: visible
  };
}

/**
 * Scoreboards for grading open sportsbook tickets.
 * Uses a wide date window (incl. NFL/CFB) and refreshes open events by id
 * so a cached "live" board cannot block a game that already went final.
 */
function gameIsGradeable(game) {
  if (!game) return false;
  const done = game.status?.bucket === 'final' || game.status?.completed;
  if (!done) return false;
  if (game.kind === 'golf' || game.kind === 'racing' || (game.leaders && game.leaders.length)) {
    return Array.isArray(game.leaders) && game.leaders.length > 0;
  }
  return Number.isFinite(Number(game.away?.score)) && Number.isFinite(Number(game.home?.score));
}

async function getSettlementBoards({ openLegs = [] } = {}) {
  const scores = await getSportsScores({
    daysAhead: 6,
    daysBehind: 14,
    forceDateRange: true,
    applySeasonFilter: false
  });
  const boards = (scores.leagues || []).map((b) => ({
    ...b,
    games: Array.isArray(b.games) ? b.games.slice() : []
  }));
  const byId = new Map();
  for (const board of boards) {
    for (const g of board.games || []) {
      byId.set(String(g.id), { game: g, board });
    }
  }

  const pending = [];
  const seen = new Set();
  for (const leg of openLegs || []) {
    const eventId = String(leg.eventId || '').trim();
    const leagueId = String(leg.leagueId || '').trim().toLowerCase();
    if (!eventId) continue;
    const key = `${leagueId}|${eventId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = byId.get(eventId);
    if (hit && gameIsGradeable(hit.game)) continue;
    pending.push({ eventId, leagueId: leagueId || hit?.board?.id || '' });
  }

  // Cap per settle pass so a huge backlog can't hammer ESPN.
  for (const row of pending.slice(0, 40)) {
    const game = await fetchTeamEventById(row.leagueId, row.eventId);
    if (!game) continue;
    const existing = byId.get(String(game.id));
    if (existing) {
      const idx = existing.board.games.findIndex((g) => String(g.id) === String(game.id));
      if (idx >= 0) existing.board.games[idx] = game;
      else existing.board.games.push(game);
      byId.set(String(game.id), { game, board: existing.board });
      continue;
    }
    let board = boards.find((b) => b.id === row.leagueId);
    if (!board) {
      const meta = LEAGUES[row.leagueId];
      board = {
        ok: true,
        id: row.leagueId,
        label: meta?.label || row.leagueId,
        kind: meta?.kind || 'team',
        logo: meta?.logo || null,
        games: [],
        counts: { live: 0, final: 0, upcoming: 0 }
      };
      boards.push(board);
    }
    board.games.push(game);
    const bucket = game.status?.bucket || 'upcoming';
    board.counts[bucket] = (board.counts[bucket] || 0) + 1;
    byId.set(String(game.id), { game, board });
  }

  return boards;
}

module.exports = {
  LEAGUES,
  DEFAULT_LEAGUES,
  FANTASY_LEAGUE_IDS,
  getSportsScores,
  getSettlementBoards,
  fetchTeamEventById,
  boardFromFantasyConferences,
  fantasyMatchupToGame,
  fantasyOddsFromProjected
};
