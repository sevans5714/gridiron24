/**
 * Multi-sport live scores for the Members Lounge.
 * Primary: ESPN public site scoreboard / golf leaderboard APIs (multi-host).
 * Fallback: free public APIs (MLB Stats, NHL Web, TheSportsDB, optional CFBD).
 */

const espnResilient = require('./espn-resilient');
const sportsFallbacks = require('./sports-fallbacks');
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
    kind: 'team',
    logo: 'https://a.espncdn.com/combiner/i?img=/redesign/assets/img/icons/ESPN-icon-baseball.png',
    seasonMonths: [8]
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
const GOLF_LEADER_LIMIT = 24;

function isLeagueMonthInSeason(meta, now = new Date()) {
  const months = meta?.seasonMonths;
  if (!Array.isArray(months) || !months.length) return true;
  return months.includes(now.getMonth() + 1);
}

function boardHasActiveGames(board) {
  return (board?.games || []).some((g) => {
    const bucket = g?.status?.bucket;
    return bucket === 'live' || bucket === 'upcoming';
  });
}

/** Keep calendar-in-season leagues, plus any offseason board that still has live/upcoming games. */
function filterInSeasonBoards(boards, now = new Date()) {
  return (boards || []).filter((board) => {
    if (board?.fantasy || FANTASY_LEAGUE_IDS.has(board?.id)) return true;
    const meta = LEAGUES[board.id];
    if (!meta) return Boolean(board?.games?.length);
    if (isLeagueMonthInSeason(meta, now)) return true;
    return boardHasActiveGames(board);
  }).map((board) => ({
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

function sitePathForMeta(meta, { daysAhead = 0, daysBehind = 0 } = {}) {
  if (meta.url) {
    try {
      const u = new URL(meta.url);
      return `${u.pathname.replace(/^\//, '')}${u.search || ''}`;
    } catch {
      return null;
    }
  }
  let path = `apis/site/v2/sports/${meta.sport}/${meta.league}/scoreboard`;
  const ahead = Math.max(0, Math.min(10, Number(daysAhead) || 0));
  const behind = Math.max(0, Math.min(10, Number(daysBehind) || 0));
  if ((ahead > 0 || behind > 0) && DAILY_RANGE_LEAGUES.has(meta.id)) {
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

function normalizeTeamEvent(event, leagueId) {
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
    odds: leagueId === 'ncaaf' ? null : pickOdds(competition),
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
  if (status.displayThru) return compactGolfTee(String(status.displayThru));
  const thruN = Number(status.thru);
  if (Number.isFinite(thruN) && thruN > 0) return thruN >= 18 ? 'F' : String(thruN);

  const dv = String(status.displayValue || '').trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(dv)) {
    const tee = String(status.detail || '').trim();
    return tee ? compactGolfTee(tee) : '—';
  }
  if (dv && dv !== '-') return compactGolfTee(dv);

  const detail = String(status.detail || '').trim();
  if (detail && !/^scheduled$/i.test(detail)) return compactGolfTee(detail);
  return '—';
}

/** "8:42 AM" → "8:42a" so lounge tee columns don't clip. */
function compactGolfTee(value) {
  const s = String(value || '').trim();
  if (!s) return s;
  const m = s.match(/^(\d{1,2}:\d{2})\s*([AaPp])\.?[Mm]\.?$/);
  if (m) return `${m[1]}${m[2].toLowerCase()}`;
  return s;
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
      const score = (scoreRaw == null || scoreRaw === '')
        ? (rowStatus.todayDetail || '—')
        : String(scoreRaw);
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

async function fetchLeagueRaw(meta, { daysAhead = 0, daysBehind = 0 } = {}) {
  const pathAndQuery = sitePathForMeta(meta, { daysAhead, daysBehind });
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

async function getSportsScores({ leagues, extraBoards = [], daysAhead = 0, daysBehind = 0 } = {}) {
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
        const { raw, from } = await fetchLeagueRaw(meta, { daysAhead, daysBehind });
        let games = (raw.events || []).map((ev) => {
          if (meta.kind === 'golf') return normalizeGolfEvent(ev);
          if (meta.kind === 'racing') return normalizeRacingEvent(ev, meta.id);
          return normalizeTeamEvent(ev, id);
        });
        if (meta.kind === 'racing') {
          games = await fillRacingFields(games);
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
        return {
          ok: true,
          id: meta.id,
          label: meta.label,
          kind: meta.kind,
          logo: meta.lockLogo ? (meta.logo || null) : pickLeagueLogo(raw, meta.logo),
          from: from || 'live',
          source: 'espn',
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
          const fb = await sportsFallbacks.fetchFallbackBoard(id);
          if (fb?.games) {
            usedFallback = true;
            return boardFromGames(meta, fb.games, {
              source: fb.source,
              provider: fb.provider,
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
  const visible = filterInSeasonBoards(enriched);

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
    source: usedFallback ? 'sports-fallback' : 'espn-site-scoreboard',
    fallbackUsed: usedFallback,
    oddsFilled,
    upstream: espnResilient.getUpstreamStatus().site,
    fetchedAt,
    cacheMs: CACHE_MS,
    totals,
    leagues: visible
  };
}

module.exports = {
  LEAGUES,
  DEFAULT_LEAGUES,
  FANTASY_LEAGUE_IDS,
  getSportsScores,
  boardFromFantasyConferences,
  fantasyMatchupToGame,
  fantasyOddsFromProjected
};
