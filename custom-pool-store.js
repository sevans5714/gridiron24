/**
 * Lounge custom pools — members create pick'em, confidence, brackets, squares,
 * survivor, props, auction, draft, sweepstakes, and open-roster contests.
 * Paper / fun money only. Owner scores results.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'custom-pools.json');

const MAX_POOLS = 60;
const MAX_NAME = 60;
const MAX_DESC = 400;
const MAX_MEMBERS = 48;
const MAX_OPTIONS = 64;
const MAX_OPTION_LABEL = 120;
const MAX_ENTRY_TEXT = 2000;
const MIN_BUY_IN = 0;
const MAX_BUY_IN = 10000;
const SQUARES_SIZE = 10;

const POOL_TYPES = {
  pickem: {
    id: 'pickem',
    label: "Pick'em",
    blurb: 'Predict winners for a slate of games or matchups. Straight-up scoring.'
  },
  confidence: {
    id: 'confidence',
    label: 'Confidence',
    blurb: 'Pick winners and rank confidence — higher confidence = more points when correct.'
  },
  bracket: {
    id: 'bracket',
    label: 'Bracket',
    blurb: 'Fill a tournament bracket before tip-off. Owner scores rounds as games finish.'
  },
  squares: {
    id: 'squares',
    label: 'Squares',
    blurb: 'Claim cells on a 10×10 board. Digits settle against a final score.'
  },
  survivor: {
    id: 'survivor',
    label: 'Survivor',
    blurb: 'Pick one survivor each round. Wrong pick and you’re out — last alive wins.'
  },
  props: {
    id: 'props',
    label: 'Prop board',
    blurb: 'Answer proposition questions (first TD, O/U props, awards night, etc.).'
  },
  auction: {
    id: 'auction',
    label: 'Auction',
    blurb: 'Nominate items and bid a paper budget. Highest bid wins each lot.'
  },
  draft: {
    id: 'draft',
    label: 'Snake draft',
    blurb: 'Take turns drafting unique items or players into your board.'
  },
  sweep: {
    id: 'sweep',
    label: 'Sweepstakes',
    blurb: 'Everyone buys in; owner draws a winner (or multiple) at random.'
  },
  open: {
    id: 'open',
    label: 'Open roster',
    blurb: 'Submit a roster or set of picks — items can appear on multiple boards.'
  },
  custom: {
    id: 'custom',
    label: 'Custom',
    blurb: 'Freeform contest. Describe the rules; members post entries; you score.'
  }
};

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({ pools: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { pools: Array.isArray(data.pools) ? data.pools : [] };
  } catch {
    return { pools: [] };
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pools: Array.isArray(data.pools) ? data.pools : [] }, null, 2));
  fs.renameSync(tmp, FILE);
}

function err(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function clampNum(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function normalizeType(raw) {
  const key = String(raw || '').trim().toLowerCase();
  return POOL_TYPES[key] ? key : null;
}

function normalizeName(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_NAME);
}

function normalizeDesc(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_DESC);
}

function emptySquares() {
  const cells = [];
  for (let r = 0; r < SQUARES_SIZE; r++) {
    for (let c = 0; c < SQUARES_SIZE; c++) {
      cells.push({ r, c, userId: null, name: null });
    }
  }
  return cells;
}

function publicMember(m) {
  return {
    userId: m.userId,
    name: m.name || 'Member',
    joinedAt: m.joinedAt || null,
    alive: m.alive !== false,
    score: Number(m.score) || 0,
    cash: Number.isFinite(Number(m.cash)) ? Number(m.cash) : null
  };
}

function publicOption(o, at = Date.now()) {
  const ends = Date.parse(o.auctionEndsAt || '');
  const msLeft = Number.isFinite(ends) ? Math.max(0, ends - at) : 0;
  const bids = Array.isArray(o.bids) ? o.bids : [];
  const high = bids.slice().sort((a, b) => Number(b.amount) - Number(a.amount))[0] || null;
  return {
    id: o.id,
    label: o.label,
    meta: o.meta || null,
    choices: Array.isArray(o.choices) ? o.choices : null,
    result: o.result || null,
    reserve: Number.isFinite(Number(o.reserve)) ? Number(o.reserve) : null,
    auctionHours: Number.isFinite(Number(o.auctionHours)) ? Number(o.auctionHours) : null,
    auctionEndsAt: o.auctionEndsAt || null,
    auctionMsLeft: o.status === 'auction' ? msLeft : 0,
    status: o.status || null,
    highBid: high
      ? { amount: Number(high.amount) || 0, name: high.name || '—', userId: high.userId }
      : null,
    ownerId: o.ownerId || null,
    ownerName: o.ownerName || null,
    winningBid: o.winningBid != null ? Number(o.winningBid) : null
  };
}

function publicPool(pool, viewerId) {
  const members = Array.isArray(pool.members) ? pool.members : [];
  const me = members.find((m) => m.userId === viewerId) || null;
  const entries = Array.isArray(pool.entries) ? pool.entries : [];
  const myEntries = entries.filter((e) => e.userId === viewerId);
  const typeMeta = POOL_TYPES[pool.type] || POOL_TYPES.custom;

  let board = null;
  if (pool.type === 'squares') {
    board = {
      size: SQUARES_SIZE,
      cells: (pool.squares || emptySquares()).map((cell) => ({
        r: cell.r,
        c: cell.c,
        userId: cell.userId || null,
        name: cell.name || null,
        mine: cell.userId === viewerId
      })),
      rowDigits: pool.rowDigits || null,
      colDigits: pool.colDigits || null
    };
  }

  return {
    id: pool.id,
    name: pool.name,
    type: pool.type,
    typeLabel: typeMeta.label,
    blurb: typeMeta.blurb,
    description: pool.description || '',
    status: pool.status || 'open',
    buyIn: Number(pool.buyIn) || 0,
    pot: Number(pool.pot) || 0,
    ownerId: pool.ownerId,
    ownerName: pool.ownerName,
    createdAt: pool.createdAt,
    memberCount: members.length,
    members: members.map(publicMember),
    options: (pool.options || []).map((o) => publicOption(o)),
    startingCash: pool.startingCash != null ? Number(pool.startingCash) : null,
    joined: Boolean(me),
    isOwner: pool.ownerId === viewerId,
    me: me ? publicMember(me) : null,
    myEntries,
    entries: pool.status === 'locked' || pool.status === 'settled' || pool.ownerId === viewerId
      ? entries.map((e) => ({
          id: e.id,
          userId: e.userId,
          name: e.name,
          optionId: e.optionId || null,
          pick: e.pick || null,
          confidence: e.confidence ?? null,
          text: e.text || null,
          score: Number(e.score) || 0,
          createdAt: e.createdAt
        }))
      : myEntries.map((e) => ({
          id: e.id,
          userId: e.userId,
          name: e.name,
          optionId: e.optionId || null,
          pick: e.pick || null,
          confidence: e.confidence ?? null,
          text: e.text || null,
          score: Number(e.score) || 0,
          createdAt: e.createdAt
        })),
    board,
    winners: Array.isArray(pool.winners) ? pool.winners : []
  };
}

function listTypes() {
  return Object.values(POOL_TYPES);
}

function getOverview(viewer = null) {
  const store = readStore();
  const viewerId = viewer?.id || null;
  let dirty = false;
  for (const p of store.pools) {
    if (p.type === 'auction' && settleAuctionLots(p)) dirty = true;
  }
  if (dirty) writeStore(store);
  const pools = store.pools
    .slice()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .map((p) => publicPool(p, viewerId));
  return {
    ok: true,
    types: listTypes(),
    pools,
    defaults: { buyIn: 0, maxMembers: MAX_MEMBERS }
  };
}

function getPool(poolId, viewer = null) {
  const store = readStore();
  const pool = store.pools.find((p) => p.id === poolId);
  if (!pool) throw err(404, 'Pool not found');
  return { ok: true, types: listTypes(), pool: publicPool(pool, viewer?.id || null) };
}

function createPool(viewer, body = {}) {
  if (!viewer?.id) throw err(401, 'Sign in required');
  const type = normalizeType(body.type);
  if (!type) throw err(400, 'Pick a pool type');
  const name = normalizeName(body.name);
  if (!name) throw err(400, 'Name your pool');
  const description = normalizeDesc(body.description);
  const buyIn = clampNum(body.buyIn, MIN_BUY_IN, MAX_BUY_IN, 0);
  const store = readStore();
  if (store.pools.length >= MAX_POOLS) throw err(400, 'Pool limit reached — close an old one first');

  const startingCash = type === 'auction'
    ? clampNum(body.startingCash, 50, 100000, 500)
    : null;

  const pool = {
    id: crypto.randomUUID(),
    name,
    type,
    description,
    status: 'open',
    buyIn,
    pot: buyIn,
    ownerId: viewer.id,
    ownerName: viewer.name || 'Member',
    createdAt: new Date().toISOString(),
    members: [
      {
        userId: viewer.id,
        name: viewer.name || 'Member',
        joinedAt: new Date().toISOString(),
        alive: true,
        score: 0,
        cash: startingCash
      }
    ],
    options: [],
    entries: [],
    squares: type === 'squares' ? emptySquares() : null,
    rowDigits: null,
    colDigits: null,
    winners: [],
    startingCash
  };

  store.pools.unshift(pool);
  writeStore(store);
  return { ok: true, pool: publicPool(pool, viewer.id) };
}

function findPoolOrThrow(store, poolId) {
  const idx = store.pools.findIndex((p) => p.id === poolId);
  if (idx === -1) throw err(404, 'Pool not found');
  return { idx, pool: store.pools[idx] };
}

function requireOwner(pool, viewer) {
  if (!viewer?.id || pool.ownerId !== viewer.id) throw err(403, 'Only the pool owner can do that');
}

function joinPool(viewer, poolId) {
  if (!viewer?.id) throw err(401, 'Sign in required');
  const store = readStore();
  const { idx, pool } = findPoolOrThrow(store, poolId);
  if (pool.status === 'closed' || pool.status === 'settled') {
    throw err(400, 'This pool is closed');
  }
  if ((pool.members || []).some((m) => m.userId === viewer.id)) {
    return { ok: true, pool: publicPool(pool, viewer.id) };
  }
  if ((pool.members || []).length >= MAX_MEMBERS) throw err(400, 'Pool is full');
  const buyIn = Number(pool.buyIn) || 0;
  pool.members.push({
    userId: viewer.id,
    name: viewer.name || 'Member',
    joinedAt: new Date().toISOString(),
    alive: true,
    score: 0,
    cash: pool.type === 'auction' ? Number(pool.startingCash) || 500 : null
  });
  pool.pot = (Number(pool.pot) || 0) + buyIn;
  store.pools[idx] = pool;
  writeStore(store);
  return { ok: true, pool: publicPool(pool, viewer.id) };
}

function addOption(viewer, poolId, body = {}) {
  const store = readStore();
  const { idx, pool } = findPoolOrThrow(store, poolId);
  requireOwner(pool, viewer);
  if (pool.status !== 'open') throw err(400, 'Pool is locked');
  if ((pool.options || []).length >= MAX_OPTIONS) throw err(400, 'Too many items on the board');
  const label = String(body.label || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_OPTION_LABEL);
  if (!label) throw err(400, 'Add a label');
  let choices = null;
  if (Array.isArray(body.choices)) {
    choices = body.choices
      .map((c) => String(c || '').trim().slice(0, 60))
      .filter(Boolean)
      .slice(0, 12);
    if (choices.length < 2) choices = null;
  }
  if ((pool.type === 'props' || pool.type === 'pickem' || pool.type === 'confidence' || pool.type === 'survivor') && !choices) {
    if (pool.type === 'pickem' || pool.type === 'confidence' || pool.type === 'survivor') {
      choices = ['Away', 'Home'];
    }
  }

  const option = {
    id: crypto.randomUUID(),
    label,
    meta: String(body.meta || '').trim().slice(0, 80) || null,
    choices,
    result: null
  };

  if (pool.type === 'auction') {
    const reserve = clampNum(body.reserve ?? body.price, 0, 100000, 0);
    const auctionHours = clampNum(body.auctionHours, 1, 168, 24);
    const openNow = body.openAuction !== false && body.openAuction !== 'false';
    const at = Date.now();
    option.reserve = reserve;
    option.auctionHours = auctionHours;
    option.bids = [];
    option.status = openNow ? 'auction' : 'listed';
    option.auctionEndsAt = openNow ? new Date(at + auctionHours * 3600000).toISOString() : null;
    option.ownerId = null;
    option.ownerName = null;
    option.winningBid = null;
    if (body.meta == null && reserve > 0) {
      option.meta = `Reserve $${reserve}`;
    }
  }

  pool.options = pool.options || [];
  pool.options.push(option);
  store.pools[idx] = pool;
  writeStore(store);
  return { ok: true, pool: publicPool(pool, viewer.id) };
}

function settleAuctionLots(pool, at = Date.now()) {
  let dirty = false;
  for (const o of pool.options || []) {
    if (o.status !== 'auction') continue;
    const ends = Date.parse(o.auctionEndsAt || '');
    if (!Number.isFinite(ends) || ends > at) continue;
    const bids = Array.isArray(o.bids) ? o.bids : [];
    const high = bids.slice().sort((a, b) => Number(b.amount) - Number(a.amount))[0];
    const reserve = Number(o.reserve) || 0;
    if (high && Number(high.amount) >= reserve) {
      o.status = 'sold';
      o.ownerId = high.userId;
      o.ownerName = high.name;
      o.winningBid = Number(high.amount);
      const buyer = (pool.members || []).find((m) => m.userId === high.userId);
      if (buyer && buyer.cash != null) {
        buyer.cash = Math.max(0, (Number(buyer.cash) || 0) - Number(high.amount));
        buyer.score = (Number(buyer.score) || 0) + 1;
      }
    } else {
      o.status = 'unsold';
    }
    dirty = true;
  }
  return dirty;
}

function placeLotBid(viewer, poolId, body = {}) {
  if (!viewer?.id) throw err(401, 'Sign in required');
  const store = readStore();
  const { idx, pool } = findPoolOrThrow(store, poolId);
  if (pool.type !== 'auction') throw err(400, 'Bidding is only for auction pools');
  settleAuctionLots(pool);
  if (pool.status !== 'open') throw err(400, 'Pool is locked');

  const member = (pool.members || []).find((m) => m.userId === viewer.id);
  if (!member) throw err(403, 'Join the pool before bidding');

  const optionId = String(body.optionId || '').trim();
  const amount = Math.floor(Number(body.amount));
  if (!Number.isFinite(amount) || amount < 1) throw err(400, 'Enter a bid amount');

  const option = (pool.options || []).find((o) => o.id === optionId);
  if (!option) throw err(404, 'Lot not found');
  if (option.status !== 'auction') throw err(400, 'Auction is not open for this lot');
  const ends = Date.parse(option.auctionEndsAt || '');
  if (!Number.isFinite(ends) || ends <= Date.now()) {
    settleAuctionLots(pool);
    writeStore(store);
    throw err(400, 'Auction has ended');
  }

  const bids = Array.isArray(option.bids) ? option.bids : [];
  const high = bids.slice().sort((a, b) => Number(b.amount) - Number(a.amount))[0];
  const minNext = Math.max((Number(option.reserve) || 0), high ? Number(high.amount) + 1 : 1);
  if (amount < minNext) throw err(400, `Bid must be at least $${minNext}`);

  let reserved = 0;
  for (const o of pool.options || []) {
    if (o.status !== 'auction' || o.id === option.id) continue;
    const t = (o.bids || []).slice().sort((a, b) => Number(b.amount) - Number(a.amount))[0];
    if (t && t.userId === viewer.id) reserved += Number(t.amount) || 0;
  }
  const avail = Math.max(0, (Number(member.cash) || 0) - reserved);
  if (amount > avail) throw err(400, `Not enough cash — you have $${avail} available`);

  option.bids = bids;
  option.bids.push({
    userId: viewer.id,
    name: member.name,
    amount,
    at: new Date().toISOString()
  });
  store.pools[idx] = pool;
  writeStore(store);
  return { ok: true, pool: publicPool(pool, viewer.id) };
}

function assignMember(viewer, poolId, body = {}) {
  const store = readStore();
  const { idx, pool } = findPoolOrThrow(store, poolId);
  requireOwner(pool, viewer);
  if (pool.status === 'closed' || pool.status === 'settled') {
    throw err(400, 'This pool is closed');
  }
  const targetId = String(body.userId || '').trim();
  const targetName = String(body.name || '').trim().slice(0, 80) || 'Member';
  if (!targetId) throw err(400, 'Pick a member to assign');
  if ((pool.members || []).some((m) => m.userId === targetId)) {
    return { ok: true, pool: publicPool(pool, viewer.id), alreadyJoined: true };
  }
  if ((pool.members || []).length >= MAX_MEMBERS) throw err(400, 'Pool is full');
  const buyIn = Number(pool.buyIn) || 0;
  pool.members.push({
    userId: targetId,
    name: targetName,
    joinedAt: new Date().toISOString(),
    alive: true,
    score: 0,
    cash: pool.type === 'auction' ? Number(pool.startingCash) || 500 : null,
    assignedBy: viewer.id
  });
  pool.pot = (Number(pool.pot) || 0) + buyIn;
  store.pools[idx] = pool;
  writeStore(store);
  return { ok: true, pool: publicPool(pool, viewer.id), assigned: true };
}

function importOptions(viewer, poolId, body = {}) {
  const store = readStore();
  const { idx, pool } = findPoolOrThrow(store, poolId);
  requireOwner(pool, viewer);
  if (pool.status !== 'open') throw err(400, 'Pool is locked');

  let items = Array.isArray(body.items) ? body.items : null;
  if (!items && body.text) {
    items = String(body.text)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/[|,;\t]/).map((p) => p.trim()).filter(Boolean);
        return {
          label: parts[0],
          reserve: parts[1] != null ? Number(String(parts[1]).replace(/[^0-9.]/g, '')) : undefined,
          auctionHours: parts[2] != null ? Number(parts[2]) : undefined,
          meta: parts.length > 1 ? parts.slice(1).join(' · ') : undefined,
          choices: pool.type !== 'auction' && parts.length >= 3 ? parts.slice(1) : undefined
        };
      });
  }
  if (!items || !items.length) throw err(400, 'Paste items (one per line)');

  pool.options = pool.options || [];
  let added = 0;
  const openNow = body.openAuctions !== false && body.openAuctions !== 'false';
  const at = Date.now();

  for (const item of items.slice(0, 40)) {
    if (pool.options.length >= MAX_OPTIONS) break;
    const label = String(item.label || item.name || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, MAX_OPTION_LABEL);
    if (!label) continue;

    const option = {
      id: crypto.randomUUID(),
      label,
      meta: String(item.meta || '').trim().slice(0, 80) || null,
      choices: Array.isArray(item.choices) && item.choices.length >= 2
        ? item.choices.map((c) => String(c).trim().slice(0, 60)).filter(Boolean).slice(0, 12)
        : (pool.type === 'pickem' || pool.type === 'confidence' || pool.type === 'survivor'
          ? ['Away', 'Home']
          : null),
      result: null
    };

    if (pool.type === 'auction') {
      const reserve = clampNum(item.reserve ?? item.price, 0, 100000, 0);
      const auctionHours = clampNum(item.auctionHours ?? item.hours, 1, 168, 24);
      option.reserve = reserve;
      option.auctionHours = auctionHours;
      option.bids = [];
      option.status = openNow ? 'auction' : 'listed';
      option.auctionEndsAt = openNow ? new Date(at + auctionHours * 3600000).toISOString() : null;
      if (!option.meta && reserve > 0) option.meta = `Reserve $${reserve}`;
    }

    pool.options.push(option);
    added += 1;
  }

  store.pools[idx] = pool;
  writeStore(store);
  return { ok: true, pool: publicPool(pool, viewer.id), imported: added };
}

function submitEntry(viewer, poolId, body = {}) {
  if (!viewer?.id) throw err(401, 'Sign in required');
  const store = readStore();
  const { idx, pool } = findPoolOrThrow(store, poolId);
  if (pool.status !== 'open') throw err(400, 'Entries are locked');
  const member = (pool.members || []).find((m) => m.userId === viewer.id);
  if (!member) throw err(403, 'Join the pool first');
  if (member.alive === false) throw err(400, 'You are eliminated');

  const text = String(body.text || '').trim().slice(0, MAX_ENTRY_TEXT);
  const pick = body.pick != null ? String(body.pick).trim().slice(0, 80) : null;
  const optionId = body.optionId ? String(body.optionId) : null;
  const confidence = body.confidence != null ? clampNum(body.confidence, 1, MAX_OPTIONS, null) : null;

  if (pool.type === 'squares') throw err(400, 'Claim a square instead');
  if (pool.type === 'sweep' && !text && !pick) {
    // joining is enough for sweep — allow a note
  }

  if (optionId) {
    const opt = (pool.options || []).find((o) => o.id === optionId);
    if (!opt) throw err(400, 'Unknown board item');
    if (Array.isArray(opt.choices) && pick && !opt.choices.includes(pick)) {
      throw err(400, 'Pick one of the listed choices');
    }
    pool.entries = (pool.entries || []).filter(
      (e) => !(e.userId === viewer.id && e.optionId === optionId)
    );
  } else if (pool.type === 'survivor') {
    // one pick per open round — replace latest open entry without optionId
    pool.entries = (pool.entries || []).filter(
      (e) => !(e.userId === viewer.id && !e.optionId && !e.settled)
    );
  } else if (['bracket', 'open', 'custom', 'draft', 'auction'].includes(pool.type) && text) {
    // freeform / roster — keep multiple unless replacing by id
    if (body.replaceId) {
      pool.entries = (pool.entries || []).filter(
        (e) => !(e.userId === viewer.id && e.id === body.replaceId)
      );
    }
  }

  const entry = {
    id: crypto.randomUUID(),
    userId: viewer.id,
    name: viewer.name || 'Member',
    optionId,
    pick,
    confidence,
    text: text || null,
    score: 0,
    settled: false,
    createdAt: new Date().toISOString()
  };
  pool.entries = pool.entries || [];
  pool.entries.push(entry);
  store.pools[idx] = pool;
  writeStore(store);
  return { ok: true, pool: publicPool(pool, viewer.id) };
}

function claimSquare(viewer, poolId, body = {}) {
  if (!viewer?.id) throw err(401, 'Sign in required');
  const store = readStore();
  const { idx, pool } = findPoolOrThrow(store, poolId);
  if (pool.type !== 'squares') throw err(400, 'Not a squares pool');
  if (pool.status !== 'open') throw err(400, 'Board is locked');
  const member = (pool.members || []).find((m) => m.userId === viewer.id);
  if (!member) throw err(403, 'Join the pool first');
  const r = clampNum(body.r, 0, SQUARES_SIZE - 1, -1);
  const c = clampNum(body.c, 0, SQUARES_SIZE - 1, -1);
  if (r < 0 || c < 0) throw err(400, 'Pick a square');
  pool.squares = pool.squares || emptySquares();
  const cell = pool.squares.find((x) => x.r === r && x.c === c);
  if (!cell) throw err(400, 'Invalid square');
  if (cell.userId && cell.userId !== viewer.id) throw err(400, 'Square already taken');
  if (cell.userId === viewer.id) {
    cell.userId = null;
    cell.name = null;
  } else {
    cell.userId = viewer.id;
    cell.name = viewer.name || 'Member';
  }
  store.pools[idx] = pool;
  writeStore(store);
  return { ok: true, pool: publicPool(pool, viewer.id) };
}

function setDigits(viewer, poolId, body = {}) {
  const store = readStore();
  const { idx, pool } = findPoolOrThrow(store, poolId);
  requireOwner(pool, viewer);
  if (pool.type !== 'squares') throw err(400, 'Not a squares pool');
  const parseDigits = (arr) => {
    if (!Array.isArray(arr) || arr.length !== SQUARES_SIZE) return null;
    const nums = arr.map((n) => clampNum(n, 0, 9, NaN));
    if (nums.some((n) => !Number.isFinite(n))) return null;
    return nums;
  };
  const rowDigits = parseDigits(body.rowDigits);
  const colDigits = parseDigits(body.colDigits);
  if (!rowDigits || !colDigits) throw err(400, 'Need 10 row digits and 10 column digits (0–9)');
  pool.rowDigits = rowDigits;
  pool.colDigits = colDigits;
  store.pools[idx] = pool;
  writeStore(store);
  return { ok: true, pool: publicPool(pool, viewer.id) };
}

function lockPool(viewer, poolId) {
  const store = readStore();
  const { idx, pool } = findPoolOrThrow(store, poolId);
  requireOwner(pool, viewer);
  if (pool.status !== 'open') throw err(400, 'Already locked');
  pool.status = 'locked';
  store.pools[idx] = pool;
  writeStore(store);
  return { ok: true, pool: publicPool(pool, viewer.id) };
}

function setResult(viewer, poolId, body = {}) {
  const store = readStore();
  const { idx, pool } = findPoolOrThrow(store, poolId);
  requireOwner(pool, viewer);
  const optionId = String(body.optionId || '');
  const opt = (pool.options || []).find((o) => o.id === optionId);
  if (!opt) throw err(400, 'Unknown board item');
  const result = String(body.result || '').trim().slice(0, 80);
  if (!result) throw err(400, 'Set a result');
  opt.result = result;

  for (const entry of pool.entries || []) {
    if (entry.optionId !== optionId) continue;
    const correct = String(entry.pick || '') === result;
    if (pool.type === 'confidence') {
      entry.score = correct ? Number(entry.confidence) || 1 : 0;
    } else {
      entry.score = correct ? 1 : 0;
    }
    entry.settled = true;
  }

  if (pool.type === 'survivor') {
    for (const m of pool.members || []) {
      const hit = (pool.entries || []).find(
        (e) => e.userId === m.userId && e.optionId === optionId
      );
      if (!hit || String(hit.pick || '') !== result) {
        m.alive = false;
      }
    }
  }

  for (const m of pool.members || []) {
    m.score = (pool.entries || [])
      .filter((e) => e.userId === m.userId)
      .reduce((sum, e) => sum + (Number(e.score) || 0), 0);
  }

  store.pools[idx] = pool;
  writeStore(store);
  return { ok: true, pool: publicPool(pool, viewer.id) };
}

function drawSweep(viewer, poolId, body = {}) {
  const store = readStore();
  const { idx, pool } = findPoolOrThrow(store, poolId);
  requireOwner(pool, viewer);
  if (pool.type !== 'sweep') throw err(400, 'Not a sweepstakes pool');
  const members = pool.members || [];
  if (!members.length) throw err(400, 'No members to draw');
  const count = clampNum(body.count, 1, Math.min(10, members.length), 1);
  const bag = members.slice();
  const winners = [];
  for (let i = 0; i < count; i++) {
    const j = crypto.randomInt(bag.length);
    const [picked] = bag.splice(j, 1);
    winners.push({ userId: picked.userId, name: picked.name });
  }
  pool.winners = winners;
  pool.status = 'settled';
  store.pools[idx] = pool;
  writeStore(store);
  return { ok: true, pool: publicPool(pool, viewer.id) };
}

function settlePool(viewer, poolId) {
  const store = readStore();
  const { idx, pool } = findPoolOrThrow(store, poolId);
  requireOwner(pool, viewer);
  pool.status = 'settled';
  const ranked = (pool.members || [])
    .slice()
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || String(a.name).localeCompare(String(b.name)));
  if (pool.type === 'survivor') {
    const alive = ranked.filter((m) => m.alive !== false);
    pool.winners = (alive.length ? alive : ranked.slice(0, 1)).map((m) => ({
      userId: m.userId,
      name: m.name,
      score: m.score
    }));
  } else if (pool.type !== 'sweep') {
    const top = Number(ranked[0]?.score) || 0;
    pool.winners = ranked
      .filter((m) => (Number(m.score) || 0) === top && top > 0)
      .map((m) => ({ userId: m.userId, name: m.name, score: m.score }));
  }
  store.pools[idx] = pool;
  writeStore(store);
  return { ok: true, pool: publicPool(pool, viewer.id) };
}

function closePool(viewer, poolId) {
  const store = readStore();
  const { idx, pool } = findPoolOrThrow(store, poolId);
  requireOwner(pool, viewer);
  pool.status = 'closed';
  store.pools[idx] = pool;
  writeStore(store);
  return { ok: true, pool: publicPool(pool, viewer.id) };
}

function handleAction(viewer, body = {}) {
  const action = String(body.action || '').toLowerCase();
  const poolId = body.poolId ? String(body.poolId) : null;
  if (action === 'create') return createPool(viewer, body);
  if (!poolId) throw err(400, 'poolId required');
  if (action === 'join') return joinPool(viewer, poolId);
  if (action === 'assign' || action === 'assign_member') return assignMember(viewer, poolId, body);
  if (action === 'import' || action === 'import_options') return importOptions(viewer, poolId, body);
  if (action === 'add_option') return addOption(viewer, poolId, body);
  if (action === 'bid' || action === 'bid_lot') return placeLotBid(viewer, poolId, body);
  if (action === 'submit') return submitEntry(viewer, poolId, body);
  if (action === 'claim_square') return claimSquare(viewer, poolId, body);
  if (action === 'set_digits') return setDigits(viewer, poolId, body);
  if (action === 'lock') return lockPool(viewer, poolId);
  if (action === 'set_result') return setResult(viewer, poolId, body);
  if (action === 'draw') return drawSweep(viewer, poolId, body);
  if (action === 'settle') return settlePool(viewer, poolId);
  if (action === 'close') return closePool(viewer, poolId);
  throw err(400, 'Unknown pool action');
}

module.exports = {
  POOL_TYPES,
  listTypes,
  getOverview,
  getPool,
  handleAction
};
