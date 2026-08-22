/**
 * Season futures boards (Super Bowl, NBA title, World Series, Stanley Cup, …).
 * Source: Bovada public futures coupons (no API key).
 */

const CACHE_MS = 10 * 60_000;
const cache = new Map();

const FUTURES_PATHS = [
  { id: 'nfl-sb', path: 'football/nfl-futures', sport: 'NFL', label: 'Super Bowl' },
  { id: 'nba-chip', path: 'basketball/nba-futures', sport: 'NBA', label: 'NBA Champion' },
  { id: 'mlb-ws', path: 'baseball/mlb-futures', sport: 'MLB', label: 'World Series' },
  { id: 'nhl-cup', path: 'hockey/nhl-futures', sport: 'NHL', label: 'Stanley Cup' },
  { id: 'ncaaf-chip', path: 'football/college-football-futures', sport: 'NCAAF', label: 'CFB Champ' }
];

async function fetchJson(url, { timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'GridIron24-Futures/1.0 (paper sportsbook)'
      },
      signal: controller.signal
    });
    if (!res.ok) {
      const err = new Error(`Futures upstream ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

function parseAmerican(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace(/[^0-9+\-.]/g, ''));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function classifyFutureMarket(meta, title) {
  const t = String(title || '').toLowerCase();
  if (/mvp|cy young|rookie|coach|player|props?|yes\/no|over\/under|make the playoffs|win the division|division winner|north|south|atlantic|central|pacific|mountain|win total|regular season/.test(t)) {
    if (!/super\s*bowl|\bafc\b|\bnfc\b|world series|stanley cup|nba (champion|title)|national champion|college football playoff/.test(t)) {
      return null;
    }
  }
  if (meta.sport === 'NFL') {
    if (/super\s*bowl/.test(t)) return { chip: 'Super Bowl', rank: 1 };
    if (/\bafc\b/.test(t) && !/division|north|south|east|west/.test(t)) return { chip: 'AFC', rank: 2 };
    if (/\bnfc\b/.test(t) && !/division|north|south|east|west/.test(t)) return { chip: 'NFC', rank: 3 };
    return null;
  }
  if (meta.sport === 'NBA' && /(champion|title|winner)/.test(t) && !/conference|division|east|west/.test(t)) {
    return { chip: 'NBA Champ', rank: 10 };
  }
  if (meta.sport === 'MLB' && /world series/.test(t)) return { chip: 'World Series', rank: 11 };
  if (meta.sport === 'NHL' && /stanley cup/.test(t)) return { chip: 'Stanley Cup', rank: 12 };
  if (meta.sport === 'NCAAF' && /(national champion|playoff champion|cfb champ|ncaa.*champ)/.test(t)) {
    return { chip: 'CFB Champ', rank: 13 };
  }
  return null;
}

function mapMarket(meta, event, market) {
  const outcomes = (market.outcomes || [])
    .map((o) => {
      const odds = parseAmerican(o.price?.american);
      const name = String(o.description || '').trim();
      if (!name || odds == null) return null;
      return {
        id: String(o.id || `${meta.id}:${name}`),
        name,
        odds
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.odds - b.odds);

  if (!outcomes.length) return null;

  const title = String(market.description || event.description || meta.label).trim();
  const kind = classifyFutureMarket(meta, title);
  if (!kind) return null;
  return {
    id: `${meta.id}:${String(market.id || title)}`,
    boardId: meta.id,
    sport: meta.sport,
    label: kind.chip,
    chip: kind.chip,
    rank: kind.rank,
    title,
    eventName: event.description || meta.label,
    seasonHint: event.description || null,
    provider: 'Bovada',
    outcomes
  };
}

async function fetchPath(meta) {
  const url = `https://www.bovada.lv/services/sports/event/coupon/events/A/description/${meta.path}?lang=en`;
  const data = await fetchJson(url);
  const events = (Array.isArray(data) && data[0]?.events) || [];
  const markets = [];
  for (const event of events) {
    const groups = event.displayGroups || [];
    for (const group of groups) {
      for (const market of group.markets || []) {
        const mapped = mapMarket(meta, event, market);
        if (mapped) markets.push(mapped);
      }
    }
    for (const market of event.markets || []) {
      const mapped = mapMarket(meta, event, market);
      if (mapped) markets.push(mapped);
    }
  }
  return markets;
}

async function getFuturesBoard() {
  const hit = cache.get('futures');
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const markets = [];
  const errors = [];
  await Promise.all(
    FUTURES_PATHS.map(async (meta) => {
      try {
        const rows = await fetchPath(meta);
        markets.push(...rows);
      } catch (err) {
        errors.push({ id: meta.id, error: err.message || 'Unavailable' });
      }
    })
  );

  // One board per futures title (Super Bowl, AFC, NFC, …) — keep the deepest book.
  const byChip = new Map();
  for (const m of markets) {
    const key = `${m.sport}:${m.chip || m.label}`;
    const prev = byChip.get(key);
    if (!prev || m.outcomes.length > prev.outcomes.length) byChip.set(key, m);
  }

  const value = {
    ok: true,
    source: 'bovada-futures',
    generatedAt: new Date().toISOString(),
    markets: [...byChip.values()].sort((a, b) => (a.rank || 99) - (b.rank || 99) || a.sport.localeCompare(b.sport)),
    errors
  };
  cache.set('futures', { at: Date.now(), value });
  return value;
}

function findOutcome(board, marketId, outcomeId) {
  const market = (board.markets || []).find((m) => String(m.id) === String(marketId));
  if (!market) return null;
  const outcome = (market.outcomes || []).find((o) => String(o.id) === String(outcomeId));
  if (!outcome) return null;
  return { market, outcome };
}

module.exports = {
  getFuturesBoard,
  findOutcome,
  FUTURES_PATHS
};
