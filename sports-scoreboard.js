/**
 * Multi-sport live scores for the Members Lounge.
 * Primary: ESPN public site scoreboard / golf leaderboard APIs (multi-host).
 * Fallback: free public APIs (MLB Stats, NHL Web, TheSportsDB, optional CFBD).
 */

const espnResilient = require('./espn-resilient');
const sportsFallbacks = require('./sports-fallbacks');

const CACHE_MS = 20_000;

/** Shared NCAA mark for every college league tab / header. */
const NCAA_LOGO = '/assets/ncaa-logo.png';

const LEAGUES = {
  nfl: {
    id: 'nfl',
    label: 'NFL',
    sport: 'football',
    league: 'nfl',
    kind: 'team',
    logo: 'https://a.espncdn.com/i/teamlogos/leagues/500/nfl.png'
  },
  ncaaf: {
    id: 'ncaaf',
    label: 'College FB',
    sport: 'football',
    league: 'college-football',
    kind: 'team',
    logo: NCAA_LOGO,
    lockLogo: true
  },
  mlb: {
    id: 'mlb',
    label: 'MLB',
    sport: 'baseball',
    league: 'mlb',
    kind: 'team',
    logo: 'https://a.espncdn.com/i/teamlogos/leagues/500/mlb.png'
  },
  llws: {
    id: 'llws',
    label: 'LLWS',
    sport: 'baseball',
    league: 'llb',
    kind: 'team',
    logo: 'https://a.espncdn.com/combiner/i?img=/redesign/assets/img/icons/ESPN-icon-baseball.png'
  },
  cbase: {
    id: 'cbase',
    label: 'College BB',
    sport: 'baseball',
    league: 'college-baseball',
    kind: 'team',
    logo: NCAA_LOGO,
    lockLogo: true
  },
  nhl: {
    id: 'nhl',
    label: 'NHL',
    sport: 'hockey',
    league: 'nhl',
    kind: 'team',
    logo: 'https://a.espncdn.com/i/teamlogos/leagues/500/nhl.png'
  },
  wnba: {
    id: 'wnba',
    label: 'WNBA',
    sport: 'basketball',
    league: 'wnba',
    kind: 'team',
    logo: 'https://a.espncdn.com/i/teamlogos/leagues/500/wnba.png'
  },
  mls: {
    id: 'mls',
    label: 'MLS',
    sport: 'soccer',
    league: 'usa.1',
    kind: 'team',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500/19.png'
  },
  golf: {
    id: 'golf',
    label: 'Golf',
    sport: 'golf',
    league: 'leaderboard',
    kind: 'golf',
    // Golf uses a dedicated leaderboard endpoint (not …/scoreboard).
    url: 'https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard',
    logo: 'https://a.espncdn.com/combiner/i?img=/redesign/assets/img/icons/ESPN-icon-golf.png'
  }
};

const DEFAULT_LEAGUES = ['nfl', 'ncaaf', 'mlb', 'llws', 'cbase', 'nhl', 'wnba', 'mls', 'golf'];
/** Cap only as a safety valve — ESPN can return a full field. */
const GOLF_LEADER_LIMIT = 24;

function sitePathForMeta(meta) {
  if (meta.url) {
    try {
      const u = new URL(meta.url);
      return `${u.pathname.replace(/^\//, '')}${u.search || ''}`;
    } catch {
      return null;
    }
  }
  return `apis/site/v2/sports/${meta.sport}/${meta.league}/scoreboard`;
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
  if (status.displayThru) return String(status.displayThru);
  const thruN = Number(status.thru);
  if (Number.isFinite(thruN) && thruN > 0) return thruN >= 18 ? 'F' : String(thruN);

  const dv = String(status.displayValue || '').trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(dv)) {
    const tee = String(status.detail || '').trim();
    return tee || '—';
  }
  if (dv && dv !== '-') return dv;

  const detail = String(status.detail || '').trim();
  if (detail && !/^scheduled$/i.test(detail)) return detail;
  return '—';
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
      return {
        id: row.id || athlete.id || null,
        name: athlete.displayName || athlete.fullName || '',
        shortName: athlete.shortName || athlete.displayName || '',
        position: rowStatus.position?.displayName || '—',
        score,
        thru: golfThruLabel(rowStatus),
        state: rowStatus.type?.state || state
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

async function fetchLeagueRaw(meta) {
  const pathAndQuery = sitePathForMeta(meta);
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
    counts,
    games: list,
    season: null,
    week: null
  };
}

async function getSportsScores({ leagues } = {}) {
  const ids = parseLeagueList(leagues);
  const fetchedAt = new Date().toISOString();
  let usedFallback = false;
  const boards = await Promise.all(
    ids.map(async (id) => {
      const meta = LEAGUES[id];
      try {
        const { raw, from } = await fetchLeagueRaw(meta);
        const games = (raw.events || []).map((ev) =>
          meta.kind === 'golf' ? normalizeGolfEvent(ev) : normalizeTeamEvent(ev, id)
        );
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

  const totals = { live: 0, final: 0, upcoming: 0, games: 0 };
  for (const b of boards) {
    totals.live += b.counts.live || 0;
    totals.final += b.counts.final || 0;
    totals.upcoming += b.counts.upcoming || 0;
    totals.games += (b.games || []).length;
  }

  return {
    ok: true,
    source: usedFallback ? 'sports-fallback' : 'espn-site-scoreboard',
    fallbackUsed: usedFallback,
    upstream: espnResilient.getUpstreamStatus().site,
    fetchedAt,
    cacheMs: CACHE_MS,
    totals,
    leagues: boards
  };
}

module.exports = {
  LEAGUES,
  DEFAULT_LEAGUES,
  getSportsScores
};
