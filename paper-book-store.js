/**
 * Lounge paper sportsbook — Casala's Palace desk.
 * Game slips use fun-money units; futures are record-only (no stake).
 * Standings are win–loss by last name.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const futuresMarkets = require('./futures-markets');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'paper-book.json');
const STARTING_BANKROLL = 1000;
const MIN_STAKE = 5;
const MAX_STAKE = 500;
const MAX_PARLAY_LEGS = 8;
const MAX_OPEN_SLIPS = 40;
const MAX_OPEN_FUTURES = 16;
const MAX_HISTORY = 120;
const DEFAULT_JUICE = -110;

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({ accounts: {}, slips: [], futures: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      accounts: data.accounts && typeof data.accounts === 'object' ? data.accounts : {},
      slips: Array.isArray(data.slips) ? data.slips : [],
      futures: Array.isArray(data.futures) ? data.futures : [],
      champions: data.champions && typeof data.champions === 'object' ? data.champions : {}
    };
  } catch {
    return { accounts: {}, slips: [], futures: [], champions: {} };
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

function lastNameOf(full) {
  const parts = String(full || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return 'Player';
  // Drop trailing generational suffixes for standings display.
  const last = parts[parts.length - 1];
  if (/^(jr\.?|sr\.?|ii|iii|iv)$/i.test(last) && parts.length >= 2) {
    return parts[parts.length - 2];
  }
  return last;
}

function ensureAccount(store, user) {
  const id = user.id;
  const fullName = user.name || user.loginName || 'Member';
  if (!store.accounts[id]) {
    store.accounts[id] = {
      userId: id,
      name: fullName,
      lastName: lastNameOf(fullName),
      bankroll: STARTING_BANKROLL,
      wins: 0,
      losses: 0,
      pushes: 0,
      unitsWon: 0,
      createdAt: new Date().toISOString()
    };
  } else {
    store.accounts[id].name = fullName;
    store.accounts[id].lastName = lastNameOf(fullName);
    if (!Number.isFinite(Number(store.accounts[id].bankroll))) {
      store.accounts[id].bankroll = STARTING_BANKROLL;
    }
  }
  return store.accounts[id];
}

function americanToDecimal(odds) {
  const o = Number(odds);
  if (!Number.isFinite(o) || o === 0) return null;
  if (o > 0) return 1 + o / 100;
  return 1 + 100 / Math.abs(o);
}

function profitFromAmerican(stake, odds) {
  const o = Number(odds);
  const s = Number(stake);
  if (!Number.isFinite(o) || !Number.isFinite(s)) return 0;
  if (o > 0) return Math.round(s * (o / 100) * 100) / 100;
  return Math.round(s * (100 / Math.abs(o)) * 100) / 100;
}

function combineParlayOdds(legs) {
  let decimal = 1;
  for (const leg of legs) {
    const d = americanToDecimal(leg.odds);
    if (!d) return DEFAULT_JUICE;
    decimal *= d;
  }
  // Convert combined decimal back to American for display.
  if (decimal >= 2) return Math.round((decimal - 1) * 100);
  return Math.round(-100 / (decimal - 1));
}

function parseMoneyline(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace(/[^0-9+\-.]/g, ''));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function findGame(boards, eventId) {
  for (const board of boards || []) {
    for (const g of board.games || []) {
      if (String(g.id) === String(eventId)) {
        return { game: g, leagueId: board.id, leagueLabel: board.label };
      }
    }
  }
  return null;
}

function buildLegFromGame(game, leagueId, leagueLabel, market, side) {
  const odds = game.odds || null;
  if (!odds && market !== 'moneyline') {
    throw Object.assign(new Error('No line posted for that game yet'), { status: 400 });
  }
  const m = String(market || 'spread').toLowerCase();
  const s = String(side || '').toLowerCase();
  const away = game.away?.abbreviation || 'AWAY';
  const home = game.home?.abbreviation || 'HOME';
  const labelBase = `${away} @ ${home}`;

  if (m === 'spread') {
    if (s !== 'away' && s !== 'home') {
      throw Object.assign(new Error('Pick away or home against the spread'), { status: 400 });
    }
    const line = s === 'away' ? odds?.away?.spread : odds?.home?.spread;
    if (line == null || !Number.isFinite(Number(line))) {
      throw Object.assign(new Error('Spread not available'), { status: 400 });
    }
    const ml = parseMoneyline(s === 'away' ? odds?.away?.moneyline : odds?.home?.moneyline);
    return {
      eventId: String(game.id),
      leagueId,
      leagueLabel,
      market: 'spread',
      side: s,
      line: Number(line),
      odds: ml || DEFAULT_JUICE,
      label: `${s === 'away' ? away : home} ${Number(line) > 0 ? '+' : ''}${line}`,
      matchup: labelBase,
      status: 'open',
      result: null
    };
  }

  if (m === 'total' || m === 'ou') {
    if (s !== 'over' && s !== 'under') {
      throw Object.assign(new Error('Pick over or under'), { status: 400 });
    }
    const total = odds?.overUnder;
    if (total == null || !Number.isFinite(Number(total))) {
      throw Object.assign(new Error('Total not available'), { status: 400 });
    }
    return {
      eventId: String(game.id),
      leagueId,
      leagueLabel,
      market: 'total',
      side: s,
      line: Number(total),
      odds: DEFAULT_JUICE,
      label: `${s === 'over' ? 'Over' : 'Under'} ${total}`,
      matchup: labelBase,
      status: 'open',
      result: null
    };
  }

  if (m === 'moneyline' || m === 'ml') {
    if (s !== 'away' && s !== 'home') {
      throw Object.assign(new Error('Pick away or home moneyline'), { status: 400 });
    }
    const ml = parseMoneyline(s === 'away' ? odds?.away?.moneyline : odds?.home?.moneyline);
    if (ml == null) {
      throw Object.assign(new Error('Moneyline not available'), { status: 400 });
    }
    return {
      eventId: String(game.id),
      leagueId,
      leagueLabel,
      market: 'moneyline',
      side: s,
      line: null,
      odds: ml,
      label: `${s === 'away' ? away : home} ML ${ml > 0 ? '+' : ''}${ml}`,
      matchup: labelBase,
      status: 'open',
      result: null
    };
  }

  throw Object.assign(new Error('Unknown market'), { status: 400 });
}

function applyQuotedPrice(built, quote = {}) {
  if (!built) return built;
  const next = { ...built };
  const qLine = Number(quote.line);
  const qOdds = Number(quote.odds);
  if ((next.market === 'spread' || next.market === 'total') && Number.isFinite(qLine)) {
    next.line = qLine;
  }
  if (Number.isFinite(qOdds) && qOdds !== 0) next.odds = qOdds;

  const parts = String(next.matchup || '').split('@').map((s) => s.trim());
  const away = parts[0] || '';
  const home = parts[1] || '';
  if (next.market === 'spread' && next.line != null) {
    const who = next.side === 'away' ? away : home;
    next.label = `${who} ${Number(next.line) > 0 ? '+' : ''}${next.line}`;
  } else if (next.market === 'total' && next.line != null) {
    next.label = `${next.side === 'over' ? 'Over' : 'Under'} ${next.line}`;
  } else if (next.market === 'moneyline') {
    const who = next.side === 'away' ? away : home;
    next.label = `${who} ML ${next.odds > 0 ? '+' : ''}${next.odds}`;
  }
  return next;
}

function gradeLeg(leg, game) {
  if (!game || (game.status?.bucket !== 'final' && !game.status?.completed)) {
    return null;
  }
  const awayScore = Number(game.away?.score);
  const homeScore = Number(game.home?.score);
  if (!Number.isFinite(awayScore) || !Number.isFinite(homeScore)) return null;

  if (leg.market === 'spread') {
    const line = Number(leg.line);
    const margin = awayScore - homeScore;
    // Positive line = getting points. Away +3 covers if awayScore + 3 >= homeScore → margin + line >= 0
    const cover = leg.side === 'away'
      ? margin + line
      : -margin + line;
    if (Math.abs(cover) < 0.0001) return 'push';
    return cover > 0 ? 'win' : 'loss';
  }

  if (leg.market === 'total') {
    const total = awayScore + homeScore;
    const line = Number(leg.line);
    if (total === line) return 'push';
    if (leg.side === 'over') return total > line ? 'win' : 'loss';
    return total < line ? 'win' : 'loss';
  }

  if (leg.market === 'moneyline') {
    if (awayScore === homeScore) return 'push';
    const awayWon = awayScore > homeScore;
    if (leg.side === 'away') return awayWon ? 'win' : 'loss';
    return awayWon ? 'loss' : 'win';
  }
  return null;
}

function settleSlip(slip, gameIndex) {
  if (slip.status !== 'open') return false;
  let changed = false;
  for (const leg of slip.legs) {
    if (leg.result) continue;
    const hit = gameIndex.get(String(leg.eventId));
    const result = hit ? gradeLeg(leg, hit.game) : null;
    if (!result) continue;
    leg.result = result;
    leg.status = result;
    changed = true;
  }
  if (!slip.legs.every((l) => l.result)) return changed;

  const results = slip.legs.map((l) => l.result);
  if (results.includes('loss')) {
    slip.status = 'lost';
    slip.payout = 0;
    slip.profit = -Number(slip.stake);
  } else if (results.every((r) => r === 'push')) {
    slip.status = 'push';
    slip.payout = Number(slip.stake);
    slip.profit = 0;
  } else if (results.includes('push') && results.includes('win')) {
    // Reduce parlay to remaining win legs; if only pushes+wins with all non-push wins, pay full.
    const active = slip.legs.filter((l) => l.result === 'win');
    if (!active.length) {
      slip.status = 'push';
      slip.payout = Number(slip.stake);
      slip.profit = 0;
    } else {
      const odds = active.length === 1 ? active[0].odds : combineParlayOdds(active);
      const profit = profitFromAmerican(slip.stake, odds);
      slip.status = 'won';
      slip.payout = Math.round((Number(slip.stake) + profit) * 100) / 100;
      slip.profit = profit;
      slip.settledOdds = odds;
    }
  } else {
    const profit = profitFromAmerican(slip.stake, slip.odds);
    slip.status = 'won';
    slip.payout = Math.round((Number(slip.stake) + profit) * 100) / 100;
    slip.profit = profit;
  }
  slip.settledAt = new Date().toISOString();
  return true;
}

function applySettlementToAccount(account, slip) {
  if (slip._applied) return;
  const isFuture = slip.type === 'future';
  if (slip.status === 'won') {
    account.wins += 1;
    if (!isFuture) {
      account.bankroll = Math.round((account.bankroll + Number(slip.payout || 0)) * 100) / 100;
      account.unitsWon = Math.round((account.unitsWon + Number(slip.profit || 0)) * 100) / 100;
    }
  } else if (slip.status === 'lost') {
    account.losses += 1;
    if (!isFuture) {
      account.unitsWon = Math.round((account.unitsWon + Number(slip.profit || 0)) * 100) / 100;
    }
  } else if (slip.status === 'push') {
    account.pushes += 1;
    if (!isFuture && Number(slip.stake) > 0) {
      account.bankroll = Math.round((account.bankroll + Number(slip.stake)) * 100) / 100;
    }
  }
  slip._applied = true;
}

function winPct(a) {
  const w = Number(a.wins || 0);
  const l = Number(a.losses || 0);
  const g = w + l;
  return g ? w / g : 0;
}

function publicRecord(a) {
  return `${a.wins}-${a.losses}${a.pushes ? `-${a.pushes}` : ''}`;
}

function standingsRow(a) {
  return {
    userId: a.userId,
    name: a.name,
    lastName: a.lastName || lastNameOf(a.name),
    wins: a.wins,
    losses: a.losses,
    pushes: a.pushes,
    bankroll: Number(a.bankroll) || 0,
    record: publicRecord(a),
    winPct: Math.round(winPct(a) * 1000) / 1000
  };
}

function buildStandings(store) {
  const activeIds = new Set();
  for (const a of Object.values(store.accounts)) {
    if ((a.wins || 0) + (a.losses || 0) + (a.pushes || 0) > 0) activeIds.add(a.userId);
  }
  for (const s of store.slips || []) activeIds.add(s.userId);
  for (const f of store.futures || []) activeIds.add(f.userId);

  return Object.values(store.accounts)
    .filter((a) => activeIds.has(a.userId))
    .map(standingsRow)
    .sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.winPct !== a.winPct) return b.winPct - a.winPct;
      if (a.losses !== b.losses) return a.losses - b.losses;
      return String(a.lastName).localeCompare(String(b.lastName), undefined, { sensitivity: 'base' });
    })
    .slice(0, 40);
}

function normTeam(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function teamMatchesChampion(pickName, championName) {
  const a = normTeam(pickName);
  const b = normTeam(championName);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function settleFutures(store) {
  const champions = store.champions || {};
  let settled = 0;
  for (const pick of store.futures || []) {
    if (pick.status !== 'open' || pick._applied) continue;
    const champ = champions[pick.boardId] || champions[pick.marketId];
    if (!champ) continue;
    const hit = teamMatchesChampion(pick.selection, champ);
    pick.status = hit ? 'won' : 'lost';
    pick.result = pick.status;
    pick.champion = champ;
    pick.settledAt = new Date().toISOString();
    const account = store.accounts[pick.userId];
    if (account) {
      if (pick.status === 'won') account.wins += 1;
      else account.losses += 1;
    }
    pick._applied = true;
    settled += 1;
  }
  return settled;
}

function setChampion(boardId, teamName) {
  const store = readStore();
  if (!store.champions) store.champions = {};
  store.champions[String(boardId)] = String(teamName || '').trim();
  settleFutures(store);
  writeStore(store);
  return { ok: true, champions: store.champions };
}

function buildGameIndex(boards) {
  const map = new Map();
  for (const board of boards || []) {
    for (const g of board.games || []) {
      map.set(String(g.id), { game: g, leagueId: board.id, leagueLabel: board.label });
    }
  }
  return map;
}

function settleOpenSlips(boards) {
  const store = readStore();
  const index = buildGameIndex(boards);
  let settled = 0;
  for (const slip of store.slips) {
    if (slip.status !== 'open') continue;
    const before = slip.status;
    settleSlip(slip, index);
    if (slip.status !== 'open' && slip.status !== before) {
      const account = store.accounts[slip.userId];
      if (account) applySettlementToAccount(account, slip);
      settled += 1;
    }
  }
  const closed = store.slips.filter((s) => s.status !== 'open');
  if (closed.length > MAX_HISTORY) {
    const keepOpen = store.slips.filter((s) => s.status === 'open');
    const keepClosed = closed
      .slice()
      .sort((a, b) => String(b.settledAt || '').localeCompare(String(a.settledAt || '')))
      .slice(0, MAX_HISTORY);
    store.slips = [...keepOpen, ...keepClosed];
  }
  settleFutures(store);
  writeStore(store);
  return settled;
}

function getBook(user, boards = []) {
  if (boards?.length) settleOpenSlips(boards);
  const store = readStore();
  settleFutures(store);
  const account = ensureAccount(store, user);
  writeStore(store);

  const mine = store.slips
    .filter((s) => s.userId === user.id)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  const myFutures = (store.futures || [])
    .filter((f) => f.userId === user.id)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  const standings = buildStandings(store);

  return {
    ok: true,
    startingBankroll: STARTING_BANKROLL,
    account: {
      userId: account.userId,
      name: account.name,
      lastName: account.lastName || lastNameOf(account.name),
      bankroll: account.bankroll,
      wins: account.wins,
      losses: account.losses,
      pushes: account.pushes,
      unitsWon: account.unitsWon,
      record: publicRecord(account)
    },
    open: mine.filter((s) => s.status === 'open'),
    recent: mine.filter((s) => s.status !== 'open').slice(0, 25),
    openFutures: myFutures.filter((f) => f.status === 'open'),
    recentFutures: myFutures.filter((f) => f.status !== 'open').slice(0, 20),
    standings,
    leaderboard: standings,
    champions: store.champions || {}
  };
}

function placeFuture(user, body = {}, futuresBoard = null) {
  if (!user?.id) {
    throw Object.assign(new Error('Sign in required'), { status: 401 });
  }
  const marketId = String(body.marketId || '').trim();
  const outcomeId = String(body.outcomeId || '').trim();
  if (!marketId || !outcomeId) {
    throw Object.assign(new Error('Pick a futures market and team'), { status: 400 });
  }

  const board = futuresBoard || null;
  const hit = board ? futuresMarkets.findOutcome(board, marketId, outcomeId) : null;
  if (!hit) {
    throw Object.assign(new Error('That futures price is no longer on the board'), { status: 404 });
  }

  const store = readStore();
  settleFutures(store);
  const account = ensureAccount(store, user);
  if (!Array.isArray(store.futures)) store.futures = [];

  const openCount = store.futures.filter((f) => f.userId === user.id && f.status === 'open').length;
  if (openCount >= MAX_OPEN_FUTURES) {
    throw Object.assign(new Error('Too many open futures — wait for some to grade'), { status: 400 });
  }

  // One open pick per market — replace prior open selection.
  store.futures = store.futures.filter(
    (f) => !(f.userId === user.id && f.marketId === hit.market.id && f.status === 'open')
  );

  const pick = {
    id: crypto.randomUUID(),
    userId: user.id,
    name: account.name,
    lastName: account.lastName || lastNameOf(account.name),
    type: 'future',
    marketId: hit.market.id,
    boardId: hit.market.boardId,
    sport: hit.market.sport,
    marketLabel: hit.market.label,
    title: hit.market.title,
    selection: hit.outcome.name,
    outcomeId: hit.outcome.id,
    odds: hit.outcome.odds,
    stake: 0,
    private: Boolean(body.private),
    status: 'open',
    result: null,
    champion: null,
    createdAt: new Date().toISOString(),
    settledAt: null,
    _applied: false
  };
  store.futures.unshift(pick);
  writeStore(store);

  const book = getBook(user, []);
  return {
    ...book,
    placedFuture: {
      id: pick.id,
      type: 'future',
      sport: pick.sport,
      marketLabel: pick.marketLabel,
      title: pick.title,
      selection: pick.selection,
      odds: pick.odds,
      private: Boolean(pick.private),
      createdAt: pick.createdAt
    }
  };
}

function placeBet(user, body = {}, boards = []) {
  if (!user?.id) {
    throw Object.assign(new Error('Sign in required'), { status: 401 });
  }
  if (boards?.length) settleOpenSlips(boards);

  const stake = Number(body.stake);
  if (!Number.isFinite(stake) || stake < MIN_STAKE || stake > MAX_STAKE) {
    throw Object.assign(new Error(`Stake must be ${MIN_STAKE}–${MAX_STAKE} units`), { status: 400 });
  }

  const rawLegs = Array.isArray(body.legs) ? body.legs : [];
  if (!rawLegs.length) {
    throw Object.assign(new Error('Add at least one leg'), { status: 400 });
  }
  if (rawLegs.length > MAX_PARLAY_LEGS) {
    throw Object.assign(new Error(`Max ${MAX_PARLAY_LEGS} legs`), { status: 400 });
  }

  const legs = rawLegs.map((leg) => {
    const hit = findGame(boards, leg.eventId);
    if (!hit) {
      throw Object.assign(new Error('Game not found on the board'), { status: 404 });
    }
    if (hit.game.status?.bucket === 'final' || hit.game.status?.completed) {
      throw Object.assign(new Error('That game is already final'), { status: 400 });
    }
    if (hit.game.kind === 'golf') {
      throw Object.assign(new Error('Golf is board-only — pick a team game'), { status: 400 });
    }
    return applyQuotedPrice(
      buildLegFromGame(hit.game, hit.leagueId, hit.leagueLabel, leg.market, leg.side),
      leg
    );
  });

  // Unique events in a parlay
  const eventIds = new Set(legs.map((l) => l.eventId));
  if (eventIds.size !== legs.length) {
    throw Object.assign(new Error('Parlay legs must be different games'), { status: 400 });
  }

  const type = legs.length === 1 ? 'straight' : 'parlay';
  const odds = legs.length === 1 ? legs[0].odds : combineParlayOdds(legs);
  const profit = profitFromAmerican(stake, odds);

  const store = readStore();
  const account = ensureAccount(store, user);
  const openCount = store.slips.filter((s) => s.userId === user.id && s.status === 'open').length;
  if (openCount >= MAX_OPEN_SLIPS) {
    throw Object.assign(new Error('Too many open slips — let some grade first'), { status: 400 });
  }
  if (account.bankroll < stake) {
    throw Object.assign(new Error('Not enough bankroll'), { status: 400 });
  }

  account.bankroll = Math.round((account.bankroll - stake) * 100) / 100;
  const isPrivate = Boolean(body.private);
  const slip = {
    id: crypto.randomUUID(),
    userId: user.id,
    name: account.name,
    type,
    stake,
    odds,
    toWin: profit,
    legs,
    private: isPrivate,
    status: 'open',
    payout: null,
    profit: null,
    createdAt: new Date().toISOString(),
    settledAt: null,
    _applied: false
  };
  store.slips.unshift(slip);
  writeStore(store);
  const book = getBook(user, boards);
  return {
    ...book,
    placedSlip: {
      id: slip.id,
      type: slip.type,
      stake: slip.stake,
      odds: slip.odds,
      toWin: slip.toWin,
      private: Boolean(slip.private),
      legs: (slip.legs || []).map((l) => ({
        eventId: l.eventId,
        label: l.label,
        matchup: l.matchup,
        leagueLabel: l.leagueLabel,
        market: l.market,
        odds: l.odds
      })),
      createdAt: slip.createdAt
    }
  };
}

const PRIVATE_INSULTS = [
  'hid this pick like a coward.',
  'marked it private — soft as warm butter.',
  "doesn't want the lounge roasting their steamers.",
  'thinks secrecy will cover that dog of a bet.',
  'locked it private. Bold of them to still announce it.',
  'whispered this one into the void. Chicken.',
  'went private. The board already knows they are cooked.',
  'is ashamed of their own action. Correct instinct.',
  'tucked this ticket under the mattress. Weak.',
  'chose private mode — the hall of fame of yellow.',
  'wants privacy for a paper bet. Peak soft.',
  'marked private so nobody sees the steamer coming.'
];

function insultForSlip(id) {
  const raw = String(id || '');
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % PRIVATE_INSULTS.length;
  return PRIVATE_INSULTS[idx];
}

function formatSlipChat(slip) {
  if (!slip) return null;
  const fmtOdds = (o) => {
    const n = Number(o);
    if (!Number.isFinite(n)) return '—';
    return n > 0 ? `+${n}` : String(n);
  };
  const fmtU = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    return v % 1 ? v.toFixed(2) : String(v);
  };

  const isPrivate = Boolean(slip.private);
  const insult = isPrivate ? insultForSlip(slip.id) : null;

  if (slip.type === 'future') {
    if (isPrivate) {
      return {
        body: [`Private future · record only`, insult].filter(Boolean).join('\n'),
        meta: {
          slipId: slip.id,
          type: 'future',
          private: true,
          insult,
          stake: 0,
          odds: slip.odds,
          toWin: null,
          legs: [{
            label: 'Private pick',
            matchup: null,
            leagueLabel: slip.sport || 'Futures'
          }]
        }
      };
    }
    const body = [
      `Casala's future · ${slip.marketLabel || slip.title || 'Futures'}`,
      `${slip.selection} (${fmtOdds(slip.odds)}) · record only`
    ].join('\n');
    return {
      body,
      meta: {
        slipId: slip.id,
        type: 'future',
        private: false,
        stake: 0,
        odds: slip.odds,
        toWin: null,
        legs: [{
          label: `${slip.selection} ${fmtOdds(slip.odds)}`,
          matchup: slip.title || slip.marketLabel,
          leagueLabel: slip.sport
        }]
      }
    };
  }

  const typeLabel = slip.type === 'parlay'
    ? `Parlay (${(slip.legs || []).length} legs)`
    : 'Straight';
  const leagues = [...new Set((slip.legs || []).map((l) => l.leagueLabel).filter(Boolean))];
  const leagueBit = leagues.length ? ` · ${leagues.join(' / ')}` : '';

  if (isPrivate) {
    return {
      body: [
        `Private bet · ${typeLabel}${leagueBit} · ${fmtU(slip.stake)}u to win ${fmtU(slip.toWin)} (${fmtOdds(slip.odds)})`,
        insult
      ].filter(Boolean).join('\n'),
      meta: {
        slipId: slip.id,
        type: slip.type,
        private: true,
        insult,
        stake: slip.stake,
        odds: slip.odds,
        toWin: slip.toWin,
        leagues,
        legs: [{
          label: 'Private pick — details locked',
          matchup: null,
          leagueLabel: leagues.join(' / ') || null
        }]
      }
    };
  }

  const legs = (slip.legs || []).map((l) => l.label || 'pick').join(' · ');
  const body = [
    `Casala's bet · ${typeLabel}${leagueBit} · ${fmtU(slip.stake)}u to win ${fmtU(slip.toWin)} (${fmtOdds(slip.odds)})`,
    legs
  ].filter(Boolean).join('\n');
  const meta = {
    slipId: slip.id,
    type: slip.type,
    private: false,
    stake: slip.stake,
    odds: slip.odds,
    toWin: slip.toWin,
    leagues,
    legs: (slip.legs || []).map((l) => ({
      label: l.label,
      matchup: l.matchup,
      leagueLabel: l.leagueLabel
    }))
  };
  return { body, meta };
}

module.exports = {
  getBook,
  placeBet,
  placeFuture,
  settleOpenSlips,
  setChampion,
  formatSlipChat,
  lastNameOf,
  STARTING_BANKROLL,
  MIN_STAKE,
  MAX_STAKE,
  DEFAULT_JUICE
};
