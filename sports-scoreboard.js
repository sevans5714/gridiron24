/**
 * Multi-sport live scores for the Members Lounge.
 * Upstream: ESPN public site scoreboard / golf leaderboard APIs.
 */

const CACHE_MS = 20_000;

const LEAGUES = {
  ncaaf: {
    id: 'ncaaf',
    label: 'College FB',
    sport: 'football',
    league: 'college-football',
    kind: 'team'
  },
  mlb: {
    id: 'mlb',
    label: 'MLB',
    sport: 'baseball',
    league: 'mlb',
    kind: 'team'
  },
  llws: {
    id: 'llws',
    label: 'LLWS',
    sport: 'baseball',
    league: 'llb',
    kind: 'team'
  },
  cbase: {
    id: 'cbase',
    label: 'College BB',
    sport: 'baseball',
    league: 'college-baseball',
    kind: 'team'
  },
  nhl: {
    id: 'nhl',
    label: 'NHL',
    sport: 'hockey',
    league: 'nhl',
    kind: 'team'
  },
  wnba: {
    id: 'wnba',
    label: 'WNBA',
    sport: 'basketball',
    league: 'wnba',
    kind: 'team'
  },
  mls: {
    id: 'mls',
    label: 'MLS',
    sport: 'soccer',
    league: 'usa.1',
    kind: 'team'
  },
  golf: {
    id: 'golf',
    label: 'Golf',
    sport: 'golf',
    league: 'leaderboard',
    kind: 'golf',
    // Golf uses a dedicated leaderboard endpoint (not …/scoreboard).
    url: 'https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard'
  }
};

const DEFAULT_LEAGUES = ['ncaaf', 'mlb', 'llws', 'cbase', 'nhl', 'wnba', 'mls', 'golf'];
const GOLF_LEADER_LIMIT = 12;

const cache = new Map(); // url -> { at, data }

function scoreboardUrl(meta) {
  if (meta.url) return meta.url;
  return `https://site.api.espn.com/apis/site/v2/sports/${meta.sport}/${meta.league}/scoreboard`;
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

function normalizeGolfEvent(event) {
  const competition = event?.competitions?.[0] || {};
  const status = competition.status || event.status || {};
  const type = status.type || {};
  const state = String(type.state || 'pre');
  const completed = Boolean(type.completed);
  const bucket = statusBucket(state, completed);
  const broadcasts = (competition.broadcasts || [])
    .flatMap((b) => b.names || [])
    .filter(Boolean);

  const leaders = (competition.competitors || [])
    .slice()
    .sort(golfPositionSort)
    .slice(0, GOLF_LEADER_LIMIT)
    .map((row) => {
      const athlete = row.athlete || {};
      return {
        id: row.id || athlete.id || null,
        name: athlete.displayName || athlete.fullName || '',
        shortName: athlete.shortName || athlete.displayName || '',
        position: row.status?.position?.displayName || '—',
        score: row.score?.displayValue || row.status?.detail || '—',
        thru: row.status?.displayThru || row.status?.displayValue || '',
        state: row.status?.type?.state || state
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
      detail: type.detail || '',
      shortDetail: type.shortDetail || type.detail || '',
      clock: null,
      period: status.period || 0
    },
    venue: event.courses?.[0]?.name || null,
    broadcasts,
    away: null,
    home: null,
    leaders
  };
}

async function fetchLeagueRaw(meta) {
  const url = scoreboardUrl(meta);
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'GridIron24-MembersLounge/1.0'
    }
  });
  if (!res.ok) {
    throw Object.assign(new Error(`${meta.label} scoreboard failed (${res.status})`), {
      status: 502
    });
  }
  const raw = await res.json();
  cache.set(url, { at: Date.now(), data: raw });
  return raw;
}

function parseLeagueList(param) {
  if (!param || !String(param).trim()) return DEFAULT_LEAGUES.slice();
  const ids = String(param)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((id) => LEAGUES[id]);
  return ids.length ? [...new Set(ids)] : DEFAULT_LEAGUES.slice();
}

async function getSportsScores({ leagues } = {}) {
  const ids = parseLeagueList(leagues);
  const fetchedAt = new Date().toISOString();
  const boards = await Promise.all(
    ids.map(async (id) => {
      const meta = LEAGUES[id];
      try {
        const raw = await fetchLeagueRaw(meta);
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
        return {
          ok: false,
          id: meta.id,
          label: meta.label,
          kind: meta.kind,
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
    source: 'espn-site-scoreboard',
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
