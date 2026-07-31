/**
 * Lounge paper sportsbook — Degenerate Gambler desk.
 * Fun-money straights + parlays across ESPN sports lines; tracks W-L and bankroll.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'paper-book.json');
const STARTING_BANKROLL = 1000;
const MIN_STAKE = 5;
const MAX_STAKE = 500;
const MAX_PARLAY_LEGS = 8;
const MAX_OPEN_SLIPS = 40;
const MAX_HISTORY = 120;
const DEFAULT_JUICE = -110;

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({ accounts: {}, slips: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      accounts: data.accounts && typeof data.accounts === 'object' ? data.accounts : {},
      slips: Array.isArray(data.slips) ? data.slips : []
    };
  } catch {
    return { accounts: {}, slips: [] };
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

function ensureAccount(store, user) {
  const id = user.id;
  if (!store.accounts[id]) {
    store.accounts[id] = {
      userId: id,
      name: user.name || user.loginName || 'Member',
      bankroll: STARTING_BANKROLL,
      wins: 0,
      losses: 0,
      pushes: 0,
      unitsWon: 0,
      createdAt: new Date().toISOString()
    };
  } else {
    store.accounts[id].name = user.name || user.loginName || store.accounts[id].name;
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
  if (slip.status === 'won') {
    account.wins += 1;
    account.bankroll = Math.round((account.bankroll + Number(slip.payout)) * 100) / 100;
    account.unitsWon = Math.round((account.unitsWon + Number(slip.profit)) * 100) / 100;
  } else if (slip.status === 'lost') {
    account.losses += 1;
    account.unitsWon = Math.round((account.unitsWon + Number(slip.profit)) * 100) / 100;
    // stake already deducted at placement
  } else if (slip.status === 'push') {
    account.pushes += 1;
    account.bankroll = Math.round((account.bankroll + Number(slip.stake)) * 100) / 100;
  }
  slip._applied = true;
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
  // Trim history
  const closed = store.slips.filter((s) => s.status !== 'open');
  if (closed.length > MAX_HISTORY) {
    const keepOpen = store.slips.filter((s) => s.status === 'open');
    const keepClosed = closed
      .slice()
      .sort((a, b) => String(b.settledAt || '').localeCompare(String(a.settledAt || '')))
      .slice(0, MAX_HISTORY);
    store.slips = [...keepOpen, ...keepClosed];
  }
  writeStore(store);
  return settled;
}

function getBook(user, boards = []) {
  if (boards?.length) settleOpenSlips(boards);
  const store = readStore();
  const account = ensureAccount(store, user);
  writeStore(store);

  const mine = store.slips
    .filter((s) => s.userId === user.id)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  const leaderboard = Object.values(store.accounts)
    .map((a) => ({
      userId: a.userId,
      name: a.name,
      bankroll: a.bankroll,
      wins: a.wins,
      losses: a.losses,
      pushes: a.pushes,
      unitsWon: a.unitsWon,
      record: `${a.wins}-${a.losses}${a.pushes ? `-${a.pushes}` : ''}`
    }))
    .sort((a, b) => b.unitsWon - a.unitsWon || b.bankroll - a.bankroll)
    .slice(0, 24);

  return {
    ok: true,
    startingBankroll: STARTING_BANKROLL,
    account: {
      bankroll: account.bankroll,
      wins: account.wins,
      losses: account.losses,
      pushes: account.pushes,
      unitsWon: account.unitsWon,
      record: `${account.wins}-${account.losses}${account.pushes ? `-${account.pushes}` : ''}`
    },
    open: mine.filter((s) => s.status === 'open'),
    recent: mine.filter((s) => s.status !== 'open').slice(0, 25),
    leaderboard
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
    return buildLegFromGame(hit.game, hit.leagueId, hit.leagueLabel, leg.market, leg.side);
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
  const slip = {
    id: crypto.randomUUID(),
    userId: user.id,
    name: account.name,
    type,
    stake,
    odds,
    toWin: profit,
    legs,
    status: 'open',
    payout: null,
    profit: null,
    createdAt: new Date().toISOString(),
    settledAt: null,
    _applied: false
  };
  store.slips.unshift(slip);
  writeStore(store);
  return getBook(user, boards);
}

module.exports = {
  getBook,
  placeBet,
  settleOpenSlips,
  STARTING_BANKROLL,
  MIN_STAKE,
  MAX_STAKE,
  DEFAULT_JUICE
};
