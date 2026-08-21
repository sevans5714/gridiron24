/**
 * Free public sports APIs used when ESPN site scoreboards are unavailable.
 *
 * Sources (no API key required for defaults):
 *  - MLB Stats API (statsapi.mlb.com)
 *  - NHL Web API (api-web.nhle.com)
 *  - TheSportsDB free tier (key "123", override with THESPORTSDB_KEY)
 *  - ESPN CDN NFL scoreboard (cdn.espn.com) + TheSportsDB NFL rounds
 *
 * Optional:
 *  - COLLEGE_FOOTBALL_DATA_API_KEY for CollegeFootballData.com (NCAAF)
 *
 * Fantasy ESPN leagues still have no free alternate provider.
 */

const CACHE_MS = 25_000;
const cache = new Map(); // key -> { at, games }

/** NHL's /scoreboard/now jumps to next season's opener in the summer. */
const FALLBACK_UPCOMING_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const FALLBACK_PAST_MAX_MS = 36 * 60 * 60 * 1000;

function isNearTermIso(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return false;
  return t >= now - FALLBACK_PAST_MAX_MS && t <= now + FALLBACK_UPCOMING_MAX_MS;
}

function clipFallbackGames(games) {
  return (games || []).filter((g) => {
    if (g?.status?.bucket === 'live') return true;
    return isNearTermIso(g?.date);
  });
}

function clipFallbackResult(result) {
  if (!result) return result;
  if (Array.isArray(result.games)) {
    return { ...result, games: clipFallbackGames(result.games) };
  }
  return result;
}

function sportsDbKey() {
  return String(process.env.THESPORTSDB_KEY || process.env.THE_SPORTS_DB_KEY || '123').trim() || '123';
}

function cfbdKey() {
  return String(process.env.COLLEGE_FOOTBALL_DATA_API_KEY || process.env.CFBD_API_KEY || '').trim();
}

async function fetchJson(url, { headers = {}, timeoutMs = 9000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'GridIron24-SportsFallback/1.0',
        ...headers
      },
      signal: controller.signal
    });
    if (!res.ok) {
      const err = new Error(`Fallback upstream ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

function cached(key, builder) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.games);
  return builder().then((games) => {
    cache.set(key, { at: Date.now(), games });
    return games;
  });
}

function teamSide({ id, abbreviation, name, shortName, logo, score, record, winner }) {
  return {
    id: id == null ? null : String(id),
    abbreviation: abbreviation || '',
    name: name || '',
    shortName: shortName || name || '',
    logo: logo || null,
    score: score == null || score === '' ? null : Number(score),
    record: record || null,
    winner: Boolean(winner)
  };
}

function gameShape({
  id,
  league,
  name,
  shortName,
  date,
  bucket,
  state,
  completed,
  statusName,
  detail,
  shortDetail,
  clock,
  period,
  venue,
  broadcasts,
  away,
  home
}) {
  return {
    id: String(id),
    league,
    kind: 'team',
    name: name || shortName || '',
    shortName: shortName || name || '',
    date: date || null,
    status: {
      bucket,
      state,
      completed: Boolean(completed),
      name: statusName || '',
      description: detail || '',
      detail: detail || '',
      shortDetail: shortDetail || detail || '',
      clock: clock || null,
      period: period || 0
    },
    venue: venue || null,
    broadcasts: broadcasts || [],
    away,
    home,
    odds: null,
    leaders: null
  };
}

function mlbBucket(status) {
  const abs = String(status?.abstractGameState || '').toLowerCase();
  const detailed = String(status?.detailedState || '').toLowerCase();
  if (abs === 'final' || detailed.includes('final') || detailed.includes('completed')) return 'final';
  if (abs === 'live' || detailed.includes('in progress') || detailed.includes('manager challenge')) return 'live';
  return 'upcoming';
}

async function fetchMlbGames() {
  return cached('mlb', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const url =
      `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}` +
      `&hydrate=linescore,team,flags`;
    const raw = await fetchJson(url);
    const games = [];
    for (const day of raw.dates || []) {
      for (const g of day.games || []) {
        const status = g.status || {};
        const bucket = mlbBucket(status);
        const ls = g.linescore || {};
        const awayScore = ls.teams?.away?.runs;
        const homeScore = ls.teams?.home?.runs;
        const away = g.teams?.away?.team || {};
        const home = g.teams?.home?.team || {};
        const inning = ls.currentInningOrdinal || ls.currentInning;
        const half = ls.inningState || ls.inningHalf || '';
        let detail = status.detailedState || status.abstractGameState || '';
        if (bucket === 'live' && inning) detail = `${half} ${inning}`.trim();
        games.push(gameShape({
          id: `mlb-${g.gamePk}`,
          league: 'mlb',
          name: `${away.name || 'Away'} at ${home.name || 'Home'}`,
          shortName: `${away.abbreviation || 'AWAY'} @ ${home.abbreviation || 'HOME'}`,
          date: g.gameDate || null,
          bucket,
          state: bucket === 'final' ? 'post' : bucket === 'live' ? 'in' : 'pre',
          completed: bucket === 'final',
          statusName: status.detailedState || '',
          detail,
          shortDetail: detail,
          clock: null,
          period: Number(ls.currentInning || 0),
          venue: g.venue?.name || null,
          broadcasts: [],
          away: teamSide({
            id: away.id,
            abbreviation: away.abbreviation,
            name: away.name,
            shortName: away.teamName || away.name,
            logo: away.id ? `https://www.mlbstatic.com/team-logos/${away.id}.svg` : null,
            score: awayScore,
            record: g.teams?.away?.leagueRecord
              ? `${g.teams.away.leagueRecord.wins}-${g.teams.away.leagueRecord.losses}`
              : null,
            winner: Boolean(g.teams?.away?.isWinner)
          }),
          home: teamSide({
            id: home.id,
            abbreviation: home.abbreviation,
            name: home.name,
            shortName: home.teamName || home.name,
            logo: home.id ? `https://www.mlbstatic.com/team-logos/${home.id}.svg` : null,
            score: homeScore,
            record: g.teams?.home?.leagueRecord
              ? `${g.teams.home.leagueRecord.wins}-${g.teams.home.leagueRecord.losses}`
              : null,
            winner: Boolean(g.teams?.home?.isWinner)
          })
        }));
      }
    }
    return games;
  });
}

function nhlBucket(state) {
  const s = String(state || '').toUpperCase();
  if (['OFF', 'FINAL', 'OVER'].includes(s)) return 'final';
  if (['LIVE', 'CRIT'].includes(s)) return 'live';
  return 'upcoming';
}

function nhlName(team) {
  if (!team) return '';
  return team.name?.default || team.commonName?.default || team.abbrev || '';
}

async function fetchNhlGames() {
  return cached('nhl', async () => {
    const raw = await fetchJson('https://api-web.nhle.com/v1/scoreboard/now');
    const games = [];
    const now = Date.now();
    for (const day of raw.gamesByDate || []) {
      const dayStamp = String(day.date || day.gameDate || '');
      if (dayStamp && !isNearTermIso(`${dayStamp}T12:00:00Z`, now)) continue;
      for (const g of day.games || []) {
        const startIso = g.startTimeUTC || g.gameDate || null;
        if (!isNearTermIso(startIso, now)) continue;
        const bucket = nhlBucket(g.gameState);
        const away = g.awayTeam || {};
        const home = g.homeTeam || {};
        const clock = g.clock?.timeRemaining || null;
        const period = g.periodDescriptor?.number || g.period || 0;
        let detail = String(g.gameState || '');
        if (bucket === 'live') {
          detail = [g.periodDescriptor?.otPeriods ? 'OT' : (period ? `P${period}` : ''), clock].filter(Boolean).join(' ');
        } else if (bucket === 'final') {
          detail = 'Final';
        }
        const broadcasts = (g.tvBroadcasts || [])
          .map((b) => b.network || b.market || '')
          .filter(Boolean);
        games.push(gameShape({
          id: `nhl-${g.id}`,
          league: 'nhl',
          name: `${nhlName(away)} at ${nhlName(home)}`,
          shortName: `${away.abbrev || 'AWAY'} @ ${home.abbrev || 'HOME'}`,
          date: g.startTimeUTC || g.gameDate || null,
          bucket,
          state: bucket === 'final' ? 'post' : bucket === 'live' ? 'in' : 'pre',
          completed: bucket === 'final',
          statusName: g.gameState || '',
          detail,
          shortDetail: detail,
          clock,
          period: Number(period || 0),
          venue: g.venue?.default || null,
          broadcasts,
          away: teamSide({
            id: away.id,
            abbreviation: away.abbrev,
            name: nhlName(away),
            shortName: away.commonName?.default || nhlName(away),
            logo: away.logo || null,
            score: away.score,
            record: away.record || null,
            winner: bucket === 'final' && Number(away.score || 0) > Number(home.score || 0)
          }),
          home: teamSide({
            id: home.id,
            abbreviation: home.abbrev,
            name: nhlName(home),
            shortName: home.commonName?.default || nhlName(home),
            logo: home.logo || null,
            score: home.score,
            record: home.record || null,
            winner: bucket === 'final' && Number(home.score || 0) > Number(away.score || 0)
          })
        }));
      }
    }
    return games;
  });
}

function sportsDbBucket(ev) {
  const status = String(ev.strStatus || ev.strProgress || '').toUpperCase();
  if (['FT', 'AET', 'PEN', 'FINISHED', 'AOT', 'CANC', 'PST', 'SUSP', 'AWARDED'].includes(status)) {
    if (['CANC', 'PST', 'SUSP'].includes(status)) return 'upcoming';
    return 'final';
  }
  if (status === 'NS' || status === 'TBD' || status === 'NOT STARTED' || !status) {
    if (ev.intHomeScore != null || ev.intAwayScore != null) return 'live';
    return 'upcoming';
  }
  // In-progress codes vary: 1H, 2H, HT, LIVE, Q1…
  return 'live';
}

function sportsDbDate(ev) {
  if (ev.strTimestamp) return ev.strTimestamp.endsWith('Z') ? ev.strTimestamp : `${ev.strTimestamp}Z`;
  if (ev.dateEvent && ev.strTime) return `${ev.dateEvent}T${ev.strTime}Z`;
  return ev.dateEvent || null;
}

function mapSportsDbEvent(ev, leagueId) {
  const bucket = sportsDbBucket(ev);
  const detail = ev.strProgress || ev.strStatus || (bucket === 'final' ? 'Final' : '');
  return gameShape({
    id: `tsdb-${ev.idEvent}`,
    league: leagueId,
    name: ev.strEvent || `${ev.strAwayTeam} at ${ev.strHomeTeam}`,
    shortName: `${ev.strAwayTeam || 'Away'} @ ${ev.strHomeTeam || 'Home'}`,
    date: sportsDbDate(ev),
    bucket,
    state: bucket === 'final' ? 'post' : bucket === 'live' ? 'in' : 'pre',
    completed: bucket === 'final',
    statusName: ev.strStatus || '',
    detail,
    shortDetail: detail,
    clock: null,
    period: 0,
    venue: ev.strVenue || null,
    broadcasts: [],
    away: teamSide({
      id: ev.idAwayTeam,
      abbreviation: '',
      name: ev.strAwayTeam,
      shortName: ev.strAwayTeam,
      logo: ev.strAwayTeamBadge || null,
      score: ev.intAwayScore,
      record: null,
      winner: bucket === 'final' && Number(ev.intAwayScore) > Number(ev.intHomeScore)
    }),
    home: teamSide({
      id: ev.idHomeTeam,
      abbreviation: '',
      name: ev.strHomeTeam,
      shortName: ev.strHomeTeam,
      logo: ev.strHomeTeamBadge || null,
      score: ev.intHomeScore,
      record: null,
      winner: bucket === 'final' && Number(ev.intHomeScore) > Number(ev.intAwayScore)
    })
  });
}

async function fetchSportsDbDay(sport, { leagueFilter = null, leagueId = 'misc' } = {}) {
  const key = sportsDbKey();
  const day = new Date().toISOString().slice(0, 10);
  const cacheKey = `tsdb:${sport}:${day}:${leagueFilter || ''}:${leagueId}`;
  return cached(cacheKey, async () => {
    const url = `https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(key)}/eventsday.php?d=${day}&s=${encodeURIComponent(sport)}`;
    const raw = await fetchJson(url);
    let events = raw.events || [];
    if (leagueFilter) {
      const re = leagueFilter instanceof RegExp ? leagueFilter : new RegExp(leagueFilter, 'i');
      events = events.filter((e) => re.test(String(e.strLeague || '')));
    }
    return events.map((ev) => mapSportsDbEvent(ev, leagueId));
  });
}

/** NFL league id on TheSportsDB free API. */
const THESPORTSDB_NFL_ID = '4391';

async function fetchSportsDbNflRound({ week, season } = {}) {
  const round = Number(week);
  const year = String(season || new Date().getFullYear()).slice(0, 4);
  if (!Number.isFinite(round) || round < 1) return null;
  const key = sportsDbKey();
  const cacheKey = `tsdb-nfl-round:${year}:${round}`;
  return cached(cacheKey, async () => {
    const url =
      `https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(key)}` +
      `/eventsround.php?id=${THESPORTSDB_NFL_ID}&r=${encodeURIComponent(String(round))}` +
      `&s=${encodeURIComponent(year)}`;
    const raw = await fetchJson(url);
    return (raw.events || []).map((ev) => mapSportsDbEvent(ev, 'nfl'));
  });
}

/**
 * ESPN CDN scoreboard — same event shape as site.api, different host/path.
 * Useful when lm/site hosts flap.
 */
async function fetchEspnCdnNflScoreboard({ week, seasontype, season, dates, year } = {}) {
  const params = new URLSearchParams({ xhr: '1' });
  if (week != null && String(week).trim() !== '') params.set('week', String(week));
  if (seasontype != null && String(seasontype).trim() !== '') {
    params.set('seasontype', String(seasontype));
  }
  const y = year || season || dates;
  if (y != null && String(y).trim() !== '') params.set('year', String(y).slice(0, 4));
  const url = `https://cdn.espn.com/core/nfl/scoreboard?${params.toString()}`;
  const raw = await fetchJson(url, { timeoutMs: 10_000 });
  const sb = raw?.content?.sbData;
  if (!sb || typeof sb !== 'object') {
    const err = new Error('ESPN CDN returned no scoreboard');
    err.status = 502;
    throw err;
  }
  return sb;
}

/**
 * NFL live/slate backups. Tries round schedule first (week-accurate), then today.
 * @returns {Promise<{ source: string, provider: string, games: object[], season?: object, week?: object }|null>}
 */
async function fetchNflFallbackGames(query = {}) {
  const week = query.week;
  const season = query.season || query.dates || query.year;
  const errors = [];

  if (week != null && String(week).trim() !== '') {
    try {
      const games = await fetchSportsDbNflRound({ week, season });
      if (games?.length) {
        return {
          source: 'thesportsdb-round',
          provider: 'TheSportsDB',
          games,
          season: {
            year: season ? Number(String(season).slice(0, 4)) : null,
            type: Number(query.seasontype) || 2,
            name: null
          },
          week: { number: Number(week), text: `Week ${week}` }
        };
      }
    } catch (err) {
      errors.push(err.message || String(err));
    }
  }

  try {
    const games = await fetchSportsDbDay('American Football', {
      leagueFilter: /\bnfl\b/i,
      leagueId: 'nfl'
    });
    if (games) {
      return { source: 'thesportsdb', provider: 'TheSportsDB', games };
    }
  } catch (err) {
    errors.push(err.message || String(err));
  }

  if (errors.length) {
    console.warn('NFL fallback failed:', errors.slice(-1)[0]);
  }
  return null;
}

async function fetchCfbdScoreboard() {
  const key = cfbdKey();
  if (!key) return null;
  return cached('cfbd', async () => {
    const year = new Date().getFullYear();
    const url = `https://api.collegefootballdata.com/scoreboard?year=${year}&classification=fbs`;
    const raw = await fetchJson(url, {
      headers: { Authorization: `Bearer ${key}` }
    });
    const games = Array.isArray(raw) ? raw : (raw.games || []);
    return games.map((g) => {
      const home = g.homeTeam || g.home || {};
      const away = g.awayTeam || g.away || {};
      const status = String(g.status || g.gameStatus || '').toLowerCase();
      let bucket = 'upcoming';
      if (status.includes('final') || status === 'completed') bucket = 'final';
      else if (status.includes('in_progress') || status.includes('live')) bucket = 'live';
      return gameShape({
        id: `cfbd-${g.id || `${away.name}-${home.name}`}`,
        league: 'ncaaf',
        name: `${away.name || away} at ${home.name || home}`,
        shortName: `${away.classification || away.name || 'AWAY'} @ ${home.classification || home.name || 'HOME'}`,
        date: g.startDate || g.start_date || null,
        bucket,
        state: bucket === 'final' ? 'post' : bucket === 'live' ? 'in' : 'pre',
        completed: bucket === 'final',
        statusName: g.status || '',
        detail: g.period ? `Q${g.period}` : (g.status || ''),
        shortDetail: g.clock || g.status || '',
        clock: g.clock || null,
        period: Number(g.period || 0),
        venue: g.venue || null,
        broadcasts: g.tv || [],
        away: teamSide({
          id: away.id,
          abbreviation: away.abbreviation,
          name: away.name || String(away),
          shortName: away.name || String(away),
          logo: null,
          score: away.points ?? away.score,
          record: null,
          winner: false
        }),
        home: teamSide({
          id: home.id,
          abbreviation: home.abbreviation,
          name: home.name || String(home),
          shortName: home.name || String(home),
          logo: null,
          score: home.points ?? home.score,
          record: null,
          winner: false
        })
      });
    });
  });
}

/**
 * @param {string} leagueId one of ncaaf|mlb|nhl|wnba|mls|…
 * @returns {Promise<{ source: string, provider: string, games: object[] }|null>}
 */
async function fetchFallbackBoard(leagueId) {
  const id = String(leagueId || '').toLowerCase();
  try {
    let result = null;
    if (id === 'nfl') {
      const nfl = await fetchNflFallbackGames();
      result = nfl?.games ? nfl : null;
    } else if (id === 'mlb') {
      result = { source: 'mlb-statsapi', provider: 'MLB Stats API', games: await fetchMlbGames() };
    } else if (id === 'nhl') {
      result = { source: 'nhl-web-api', provider: 'NHL Web API', games: await fetchNhlGames() };
    } else if (id === 'mls') {
      result = {
        source: 'thesportsdb',
        provider: 'TheSportsDB',
        games: await fetchSportsDbDay('Soccer', { leagueFilter: /major league soccer|\bmls\b/i, leagueId: 'mls' })
      };
    } else if (id === 'nba') {
      result = {
        source: 'thesportsdb',
        provider: 'TheSportsDB',
        games: await fetchSportsDbDay('Basketball', { leagueFilter: /\bnba\b/i, leagueId: 'nba' })
      };
    } else if (id === 'wnba') {
      result = {
        source: 'thesportsdb',
        provider: 'TheSportsDB',
        games: await fetchSportsDbDay('Basketball', { leagueFilter: /wnba/i, leagueId: 'wnba' })
      };
    } else if (id === 'ncaam') {
      result = {
        source: 'thesportsdb',
        provider: 'TheSportsDB',
        games: await fetchSportsDbDay('Basketball', {
          leagueFilter: /ncaa|college|ncaab/i,
          leagueId: 'ncaam'
        })
      };
    } else if (id === 'ncaaw') {
      result = {
        source: 'thesportsdb',
        provider: 'TheSportsDB',
        games: await fetchSportsDbDay('Basketball', {
          leagueFilter: /ncaa.*women|women.*ncaa|wncaa|college/i,
          leagueId: 'ncaaw'
        })
      };
    } else if (id === 'ncaaf') {
      const cfbd = await fetchCfbdScoreboard();
      if (cfbd) {
        result = { source: 'collegefootballdata', provider: 'CollegeFootballData', games: cfbd };
      } else {
        result = {
          source: 'thesportsdb',
          provider: 'TheSportsDB',
          games: await fetchSportsDbDay('American Football', {
            leagueFilter: /ncaa|college/i,
            leagueId: 'ncaaf'
          })
        };
      }
    } else if (id === 'llws' || id === 'cbase' || id === 'csoft') {
      result = {
        source: 'thesportsdb',
        provider: 'TheSportsDB',
        games: await fetchSportsDbDay('Baseball', {
          leagueFilter:
            id === 'llws'
              ? /little league/i
              : id === 'csoft'
                ? /softball|ncaa/i
                : /college|ncaa/i,
          leagueId: id
        })
      };
    }
    return clipFallbackResult(result);
  } catch (err) {
    console.warn(`Sports fallback failed for ${id}:`, err.message || err);
    return null;
  }
}

module.exports = {
  fetchFallbackBoard,
  fetchNflFallbackGames,
  fetchEspnCdnNflScoreboard,
  fetchMlbGames,
  fetchNhlGames
};
