/**
 * Betting-line enrichment when ESPN scoreboard odds are missing.
 *
 * Priority per game:
 *  1. ESPN core competition odds (same ESPN ecosystem, often richer than scoreboard)
 *  2. Bovada public coupon API (no key)
 *  3. Optional The Odds API when ODDS_API_KEY / THE_ODDS_API_KEY is set
 */

const CACHE_MS = 55_000;
const cache = new Map(); // key -> { at, value }
const MAX_ESPN_CORE_PER_BOARD = 24;

const LEAGUE_ODDS = {
  nfl: {
    espnSport: 'football',
    espnLeague: 'nfl',
    bovada: 'football/nfl',
    oddsApi: 'americanfootball_nfl'
  },
  ncaaf: {
    espnSport: 'football',
    espnLeague: 'college-football',
    bovada: 'football/college-football',
    oddsApi: 'americanfootball_ncaaf'
  },
  nba: {
    espnSport: 'basketball',
    espnLeague: 'nba',
    bovada: 'basketball/nba',
    oddsApi: 'basketball_nba'
  },
  ncaam: {
    espnSport: 'basketball',
    espnLeague: 'mens-college-basketball',
    bovada: 'basketball/college-basketball',
    oddsApi: 'basketball_ncaab'
  },
  ncaaw: {
    espnSport: 'basketball',
    espnLeague: 'womens-college-basketball',
    bovada: null,
    oddsApi: null
  },
  mlb: {
    espnSport: 'baseball',
    espnLeague: 'mlb',
    bovada: 'baseball/mlb',
    oddsApi: 'baseball_mlb'
  },
  nhl: {
    espnSport: 'hockey',
    espnLeague: 'nhl',
    bovada: 'hockey/nhl',
    oddsApi: 'icehockey_nhl'
  },
  wnba: {
    espnSport: 'basketball',
    espnLeague: 'wnba',
    bovada: 'basketball/wnba',
    oddsApi: 'basketball_wnba'
  },
  mls: {
    espnSport: 'soccer',
    espnLeague: 'usa.1',
    bovada: 'soccer/north-america/united-states/major-league-soccer',
    oddsApi: 'soccer_usa_mls'
  },
  cbase: {
    espnSport: 'baseball',
    espnLeague: 'college-baseball',
    bovada: null,
    oddsApi: null
  },
  csoft: {
    espnSport: 'baseball',
    espnLeague: 'college-softball',
    bovada: null,
    oddsApi: null
  },
  llws: {
    espnSport: 'baseball',
    espnLeague: 'llb',
    bovada: null,
    oddsApi: null
  }
};

function oddsApiKey() {
  return String(process.env.ODDS_API_KEY || process.env.THE_ODDS_API_KEY || '').trim();
}

async function fetchJson(url, { timeoutMs = 9000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'GridIron24-OddsEnrich/1.0 (fantasy HQ; paper sportsbook)',
        ...headers
      },
      signal: controller.signal
    });
    if (!res.ok) {
      const err = new Error(`Odds upstream ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

function cached(key, builder, ttl = CACHE_MS) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.value);
  return builder()
    .then((value) => {
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .catch((err) => {
      // Soft-fail cache empty briefly so we don't stampede a dead source.
      cache.set(key, { at: Date.now(), value: null });
      throw err;
    });
}

function moneylineClose(sideOdds) {
  if (sideOdds == null) return null;
  if (typeof sideOdds === 'number' || typeof sideOdds === 'string') {
    const n = Number(String(sideOdds).replace(/[^0-9+\-.]/g, ''));
    return Number.isFinite(n) && n !== 0 ? String(n) : null;
  }
  if (typeof sideOdds !== 'object') return null;
  const close = sideOdds.close?.odds ?? sideOdds.odds ?? sideOdds.moneyLine ?? sideOdds.moneyline ?? null;
  return moneylineClose(close);
}

/** Normalize ESPN scoreboard / core / pickcenter odds blobs into lounge shape. */
function normalizeEspnOddsBlob(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const spreadAbs = Number(raw.spread);
  const ou = raw.overUnder == null || raw.overUnder === '' ? null : Number(raw.overUnder);
  const awayFav = Boolean(raw.awayTeamOdds?.favorite);
  const homeFav = Boolean(raw.homeTeamOdds?.favorite);

  let awaySpread = null;
  let homeSpread = null;
  if (Number.isFinite(spreadAbs)) {
    if (awayFav && !homeFav) {
      awaySpread = -Math.abs(spreadAbs);
      homeSpread = Math.abs(spreadAbs);
    } else if (homeFav && !awayFav) {
      homeSpread = -Math.abs(spreadAbs);
      awaySpread = Math.abs(spreadAbs);
    } else if (spreadAbs === 0) {
      awaySpread = 0;
      homeSpread = 0;
    } else if (raw.awayTeamOdds?.underdog && !raw.homeTeamOdds?.underdog) {
      awaySpread = Math.abs(spreadAbs);
      homeSpread = -Math.abs(spreadAbs);
    } else if (raw.homeTeamOdds?.underdog && !raw.awayTeamOdds?.underdog) {
      homeSpread = Math.abs(spreadAbs);
      awaySpread = -Math.abs(spreadAbs);
    }
  }

  // pointSpread outcomes sometimes carry signed lines
  const psAway = Number(
    raw.pointSpread?.away?.close?.line
    ?? raw.pointSpread?.away?.close?.point
    ?? raw.pointSpread?.away?.line
  );
  const psHome = Number(
    raw.pointSpread?.home?.close?.line
    ?? raw.pointSpread?.home?.close?.point
    ?? raw.pointSpread?.home?.line
  );
  if (awaySpread == null && Number.isFinite(psAway)) awaySpread = psAway;
  if (homeSpread == null && Number.isFinite(psHome)) homeSpread = psHome;

  const awayMl =
    moneylineClose(raw.moneyline?.away) ||
    moneylineClose(raw.awayTeamOdds?.moneyLine) ||
    moneylineClose(raw.awayTeamOdds?.close?.odds) ||
    moneylineClose(raw.current?.away?.moneyLine);
  const homeMl =
    moneylineClose(raw.moneyline?.home) ||
    moneylineClose(raw.homeTeamOdds?.moneyLine) ||
    moneylineClose(raw.homeTeamOdds?.close?.odds) ||
    moneylineClose(raw.current?.home?.moneyLine);

  if (awaySpread == null && homeSpread == null && ou == null && !awayMl && !homeMl) {
    return null;
  }

  return {
    details: raw.details ? String(raw.details) : null,
    provider: raw.provider?.displayName || raw.provider?.name || 'ESPN',
    source: 'espn',
    overUnder: Number.isFinite(ou) ? ou : null,
    away: {
      favorite: awayFav,
      spread: awaySpread,
      moneyline: awayMl
    },
    home: {
      favorite: homeFav,
      spread: homeSpread,
      moneyline: homeMl
    }
  };
}

function hasUsableOdds(odds) {
  if (!odds) return false;
  return (
    odds.away?.spread != null ||
    odds.home?.spread != null ||
    odds.overUnder != null ||
    odds.away?.moneyline != null ||
    odds.home?.moneyline != null
  );
}

function needsOdds(game) {
  if (!game || game.kind === 'golf' || game.kind === 'racing') return false;
  if (game.status?.bucket === 'final' || game.status?.completed) return false;
  return !hasUsableOdds(game.odds);
}

function normToken(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}

function namesLooselyMatch(a, b) {
  const na = normToken(a);
  const nb = normToken(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) return true;
  return false;
}

function gameMatchesSides(game, awayName, homeName) {
  const a = game.away || {};
  const h = game.home || {};
  const awayOk =
    namesLooselyMatch(a.name, awayName) ||
    namesLooselyMatch(a.shortName, awayName) ||
    namesLooselyMatch(a.abbreviation, awayName);
  const homeOk =
    namesLooselyMatch(h.name, homeName) ||
    namesLooselyMatch(h.shortName, homeName) ||
    namesLooselyMatch(h.abbreviation, homeName);
  return awayOk && homeOk;
}

function parseAmerican(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace(/[^0-9+\-.]/g, ''));
  return Number.isFinite(n) && n !== 0 ? String(n) : null;
}

function parseHandicap(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace(/[^0-9+\-.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function fetchEspnCoreOdds(game, meta) {
  if (!meta?.espnSport || !meta?.espnLeague || !game?.id) return null;
  const eventId = String(game.id).replace(/^espn-/, '');
  const compId = eventId;
  const url =
    `https://sports.core.api.espn.com/v2/sports/${meta.espnSport}/leagues/${meta.espnLeague}` +
    `/events/${encodeURIComponent(eventId)}/competitions/${encodeURIComponent(compId)}/odds` +
    `?lang=en&region=us`;
  try {
    const data = await cached(`espn-core:${meta.espnLeague}:${eventId}`, () => fetchJson(url));
    const items = Array.isArray(data?.items) ? data.items : [];
    for (const item of items) {
      const odd = item?.$ref ? await fetchJson(item.$ref) : item;
      const normalized = normalizeEspnOddsBlob(odd);
      if (hasUsableOdds(normalized)) {
        return { ...normalized, source: 'espn-core', provider: normalized.provider || 'ESPN' };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function mapBovadaEvent(ev) {
  const desc = String(ev?.description || '');
  const parts = desc.split(/\s+@\s+/);
  if (parts.length !== 2) return null;
  const awayName = parts[0].trim();
  const homeName = parts[1].trim();
  const groups = Array.isArray(ev.displayGroups) ? ev.displayGroups : [];
  let awaySpread = null;
  let homeSpread = null;
  let awayMl = null;
  let homeMl = null;
  let total = null;

  for (const group of groups) {
    for (const market of group.markets || []) {
      const label = String(market.description || market.key || '').toLowerCase();
      const outcomes = market.outcomes || [];
      if (label.includes('moneyline') || label === 'money line') {
        for (const o of outcomes) {
          const ml = parseAmerican(o.price?.american);
          if (namesLooselyMatch(o.description, awayName)) awayMl = ml;
          if (namesLooselyMatch(o.description, homeName)) homeMl = ml;
        }
      } else if (
        label.includes('spread') ||
        label.includes('runline') ||
        label.includes('puck line') ||
        label.includes('handicap')
      ) {
        for (const o of outcomes) {
          const line = parseHandicap(o.price?.handicap);
          if (!Number.isFinite(line)) continue;
          if (namesLooselyMatch(o.description, awayName)) awaySpread = line;
          if (namesLooselyMatch(o.description, homeName)) homeSpread = line;
        }
      } else if (label.includes('total') || label === 'over/under') {
        for (const o of outcomes) {
          const line = parseHandicap(o.price?.handicap);
          if (Number.isFinite(line)) total = line;
        }
      }
    }
  }

  if (awaySpread == null && homeSpread == null && total == null && !awayMl && !homeMl) {
    return null;
  }

  return {
    awayName,
    homeName,
    odds: {
      details: null,
      provider: 'Bovada',
      source: 'bovada',
      overUnder: total,
      away: {
        favorite: awaySpread != null ? awaySpread < 0 : false,
        spread: awaySpread,
        moneyline: awayMl
      },
      home: {
        favorite: homeSpread != null ? homeSpread < 0 : false,
        spread: homeSpread,
        moneyline: homeMl
      }
    }
  };
}

async function fetchBovadaLeague(meta) {
  if (!meta?.bovada) return [];
  const path = meta.bovada;
  const urls = [
    `https://www.bovada.lv/services/sports/event/coupon/events/A/description/${path}?marketFilterId=def&lang=en`,
    `https://www.bovada.lv/services/sports/event/coupon/events/A/description/${path}?marketFilterId=def&preMatchOnly=true&lang=en`
  ];
  const mapped = [];
  for (const url of urls) {
    try {
      const data = await cached(`bovada:${path}:${url.includes('preMatchOnly') ? 'pre' : 'all'}`, () =>
        fetchJson(url, { timeoutMs: 11000 })
      ).catch(() => null);
      if (!data) continue;
      const blocks = Array.isArray(data) ? data : [];
      for (const block of blocks) {
        for (const ev of block.events || []) {
          const row = mapBovadaEvent(ev);
          if (row) mapped.push(row);
        }
      }
      if (mapped.length) break;
    } catch {
      /* try next */
    }
  }
  return mapped;
}

function matchBovadaOdds(game, bovadaRows) {
  for (const row of bovadaRows) {
    if (gameMatchesSides(game, row.awayName, row.homeName)) return row.odds;
  }
  return null;
}

function mapOddsApiEvent(ev) {
  const awayName = ev.away_team;
  const homeName = ev.home_team;
  const bookmakers = Array.isArray(ev.bookmakers) ? ev.bookmakers : [];
  const book = bookmakers[0];
  if (!book) return null;
  const markets = book.markets || [];
  let awaySpread = null;
  let homeSpread = null;
  let awayMl = null;
  let homeMl = null;
  let total = null;

  for (const m of markets) {
    const key = String(m.key || '');
    const outcomes = m.outcomes || [];
    if (key === 'h2h') {
      for (const o of outcomes) {
        const ml = parseAmerican(o.price);
        if (namesLooselyMatch(o.name, awayName)) awayMl = ml;
        if (namesLooselyMatch(o.name, homeName)) homeMl = ml;
      }
    } else if (key === 'spreads') {
      for (const o of outcomes) {
        const line = Number(o.point);
        if (!Number.isFinite(line)) continue;
        if (namesLooselyMatch(o.name, awayName)) awaySpread = line;
        if (namesLooselyMatch(o.name, homeName)) homeSpread = line;
      }
    } else if (key === 'totals') {
      for (const o of outcomes) {
        const line = Number(o.point);
        if (Number.isFinite(line)) total = line;
      }
    }
  }

  if (awaySpread == null && homeSpread == null && total == null && !awayMl && !homeMl) {
    return null;
  }

  return {
    awayName,
    homeName,
    odds: {
      details: null,
      provider: book.title || 'Odds API',
      source: 'the-odds-api',
      overUnder: total,
      away: {
        favorite: awaySpread != null ? awaySpread < 0 : false,
        spread: awaySpread,
        moneyline: awayMl
      },
      home: {
        favorite: homeSpread != null ? homeSpread < 0 : false,
        spread: homeSpread,
        moneyline: homeMl
      }
    }
  };
}

async function fetchOddsApiLeague(meta) {
  const key = oddsApiKey();
  if (!key || !meta?.oddsApi) return [];
  const url =
    `https://api.the-odds-api.com/v4/sports/${meta.oddsApi}/odds` +
    `?apiKey=${encodeURIComponent(key)}&regions=us&markets=h2h,spreads,totals&oddsFormat=american`;
  try {
    const data = await cached(`oddsapi:${meta.oddsApi}`, () => fetchJson(url, { timeoutMs: 12000 }), 90_000);
    const rows = [];
    for (const ev of Array.isArray(data) ? data : []) {
      const row = mapOddsApiEvent(ev);
      if (row) rows.push(row);
    }
    return rows;
  } catch {
    return [];
  }
}

function matchOddsApi(game, rows) {
  for (const row of rows) {
    if (gameMatchesSides(game, row.awayName, row.homeName)) return row.odds;
  }
  return null;
}

async function mapPool(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => run()));
  return out;
}

function isOpenForLines(game) {
  if (!game || game.kind === 'golf' || game.kind === 'racing') return false;
  if (game.status?.bucket === 'final' || game.status?.completed) return false;
  return true;
}

async function enrichBoard(board) {
  if (!board?.ok || board.kind === 'golf' || board.kind === 'racing') return board;
  const meta = LEAGUE_ODDS[board.id];
  if (!meta) return board;
  const games = Array.isArray(board.games) ? board.games : [];
  // Refresh upcoming/live lines every pass — ESPN scoreboard odds often sit still
  // while real books move before kickoff. Prefer Bovada / Odds API when available.
  const openGames = games.filter(isOpenForLines);
  if (!openGames.length) return board;

  let bovadaRows = [];
  let oddsApiRows = [];
  try {
    bovadaRows = await fetchBovadaLeague(meta);
  } catch {
    bovadaRows = [];
  }
  try {
    oddsApiRows = await fetchOddsApiLeague(meta);
  } catch {
    oddsApiRows = [];
  }

  const stillNeedEspn = [];
  const patched = new Map();

  for (const g of openGames) {
    const fromBovada = matchBovadaOdds(g, bovadaRows);
    if (hasUsableOdds(fromBovada)) {
      patched.set(String(g.id), fromBovada);
      continue;
    }
    const fromApi = matchOddsApi(g, oddsApiRows);
    if (hasUsableOdds(fromApi)) {
      patched.set(String(g.id), fromApi);
      continue;
    }
    // Keep whatever ESPN scoreboard already posted; only hit core if empty.
    if (needsOdds(g)) stillNeedEspn.push(g);
  }

  const espnTargets = stillNeedEspn.slice(0, MAX_ESPN_CORE_PER_BOARD);
  await mapPool(espnTargets, 6, async (g) => {
    const odd = await fetchEspnCoreOdds(g, meta);
    if (hasUsableOdds(odd)) patched.set(String(g.id), odd);
    return null;
  });

  if (!patched.size) return board;

  return {
    ...board,
    games: games.map((g) => {
      const odd = patched.get(String(g.id));
      return odd ? { ...g, odds: odd } : g;
    }),
    oddsEnriched: true
  };
}

async function enrichBoards(boards = []) {
  const list = Array.isArray(boards) ? boards : [];
  return Promise.all(list.map((b) => enrichBoard(b).catch(() => b)));
}

module.exports = {
  enrichBoards,
  enrichBoard,
  normalizeEspnOddsBlob,
  hasUsableOdds,
  LEAGUE_ODDS
};
