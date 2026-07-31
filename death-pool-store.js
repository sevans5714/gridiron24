/**
 * Lounge Death Pool — auction or draft formats, fun-money bankrolls.
 * Paper game only. Scoring: pool creator marks a sold name deceased → owner scores a hit.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { listFigures, findFigure } = require('./death-pool-figures');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'death-pool.json');

const DEFAULT_AUCTION_HOURS = 24;
const MIN_AUCTION_HOURS = 1;
const MAX_AUCTION_HOURS = 168;
const MIN_BUY_IN = 0;
const MAX_BUY_IN = 10000;
const MIN_STARTING_CASH = 100;
const MAX_STARTING_CASH = 100000;
const MIN_BID = 1;
const MIN_RUN_DAYS = 7;
const MAX_RUN_DAYS = 730;
const MAX_NAME_LEN = 80;
const MAX_POOL_NAME = 60;
const MAX_POOLS = 40;
const MAX_NOMS_PER_POOL = 200;
const MODES = new Set(['auction', 'draft']);

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
    return {
      pools: Array.isArray(data.pools) ? data.pools : [],
      newsWatch: data.newsWatch && typeof data.newsWatch === 'object' ? data.newsWatch : null
    };
  } catch {
    return { pools: [], newsWatch: null };
  }
}

function writeStore(data) {
  ensureStore();
  const current = (() => {
    try {
      return JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch {
      return {};
    }
  })();
  const payload = {
    pools: Array.isArray(data.pools) ? data.pools : [],
    newsWatch:
      data.newsWatch !== undefined
        ? data.newsWatch
        : current.newsWatch && typeof current.newsWatch === 'object'
          ? current.newsWatch
          : { lastScanAt: null, stories: [], errors: [], sources: [] }
  };
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, FILE);
}

function err(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function nowMs() {
  return Date.now();
}

function clampNum(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function normalizeName(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_NAME_LEN);
}

function nameKey(name) {
  return normalizeName(name).toLowerCase();
}

function normalizeMode(mode) {
  const key = String(mode || 'auction').trim().toLowerCase();
  return MODES.has(key) ? key : 'auction';
}

function highBid(nom) {
  const bids = Array.isArray(nom.bids) ? nom.bids : [];
  if (!bids.length) return null;
  return bids.reduce((best, b) => (!best || Number(b.amount) > Number(best.amount) ? b : best), null);
}

function reservedForMember(pool, userId) {
  let reserved = 0;
  for (const nom of pool.noms || []) {
    if (nom.status !== 'auction') continue;
    const top = highBid(nom);
    if (top && top.userId === userId) reserved += Number(top.amount) || 0;
  }
  return reserved;
}

function availableCash(pool, member) {
  const bank = Number(member.bankroll) || 0;
  return Math.max(0, bank - reservedForMember(pool, member.userId));
}

function ensureDraft(pool) {
  if (!pool.draft || typeof pool.draft !== 'object') {
    pool.draft = { status: 'setup', order: [], pickIndex: 0, snake: true };
  }
  if (!Array.isArray(pool.draft.order)) pool.draft.order = [];
  if (!['setup', 'active', 'complete'].includes(pool.draft.status)) pool.draft.status = 'setup';
  if (typeof pool.draft.snake !== 'boolean') pool.draft.snake = true;
  pool.draft.pickIndex = Math.max(0, Number(pool.draft.pickIndex) || 0);
  return pool.draft;
}

function draftSlot(pickIndex, n, snake) {
  if (!n) return 0;
  const round = Math.floor(pickIndex / n);
  const pos = pickIndex % n;
  if (snake && round % 2 === 1) return n - 1 - pos;
  return pos;
}

function currentDraftPicker(pool) {
  const draft = ensureDraft(pool);
  if (draft.status !== 'active' || !draft.order.length) return null;
  const slot = draftSlot(draft.pickIndex, draft.order.length, draft.snake !== false);
  return draft.order[slot] || null;
}

function settleExpiredAuctions(pool, at = nowMs()) {
  if (normalizeMode(pool.mode) !== 'auction') return false;
  let changed = false;
  for (const nom of pool.noms || []) {
    if (nom.status !== 'auction') continue;
    const ends = Date.parse(nom.auctionEndsAt || '');
    if (!Number.isFinite(ends) || ends > at) continue;
    const top = highBid(nom);
    if (top && Number(top.amount) >= MIN_BID) {
      nom.status = 'sold';
      nom.ownerId = top.userId;
      nom.ownerName = top.name;
      nom.winningBid = Number(top.amount);
      nom.soldAt = new Date(ends).toISOString();
      const buyer = (pool.members || []).find((m) => m.userId === top.userId);
      if (buyer) {
        buyer.bankroll = Math.max(0, (Number(buyer.bankroll) || 0) - Number(top.amount));
        buyer.spent = (Number(buyer.spent) || 0) + Number(top.amount);
      }
    } else {
      nom.status = 'unsold';
      nom.soldAt = new Date(ends).toISOString();
    }
    changed = true;
  }
  return changed;
}

function refreshPoolStatus(pool, at = nowMs()) {
  const ends = Date.parse(pool.endsAt || '');
  const closes = Date.parse(pool.closesAt || '');
  if (Number.isFinite(ends) && ends <= at) {
    pool.status = 'ended';
  } else if (Number.isFinite(closes) && closes <= at && pool.status === 'open') {
    pool.status = 'closed';
  }
}

function memberHits(pool, userId) {
  return (pool.noms || []).filter((n) => n.status === 'deceased' && n.ownerId === userId).length;
}

function resolveName(body) {
  let name;
  let category = 'Custom';
  let figureId = null;
  if (body.figureId) {
    const fig = findFigure(body.figureId);
    if (!fig) throw err(400, 'Unknown figure on the system list');
    name = fig.name;
    category = fig.category;
    figureId = fig.id;
  } else {
    name = normalizeName(body.name);
    if (!name || name.length < 2) throw err(400, 'Enter a name to pick');
    category = String(body.category || 'Custom').slice(0, 40);
  }
  return { name, category, figureId };
}

function publicNom(nom, at = nowMs()) {
  const top = highBid(nom);
  const ends = Date.parse(nom.auctionEndsAt || '');
  const msLeft = Number.isFinite(ends) ? Math.max(0, ends - at) : 0;
  return {
    id: nom.id,
    name: nom.name,
    category: nom.category || 'Custom',
    figureId: nom.figureId || null,
    nominatedBy: nom.nominatedBy || null,
    nominatedAt: nom.nominatedAt,
    auctionEndsAt: nom.auctionEndsAt,
    auctionMsLeft: nom.status === 'auction' ? msLeft : 0,
    status: nom.status,
    highBid: top ? { userId: top.userId, name: top.name, amount: Number(top.amount) } : null,
    bidCount: Array.isArray(nom.bids) ? nom.bids.length : 0,
    ownerId: nom.ownerId || null,
    ownerName: nom.ownerName || null,
    winningBid: nom.winningBid != null ? Number(nom.winningBid) : null,
    draftPick: nom.draftPick != null ? Number(nom.draftPick) : null,
    deceasedAt: nom.deceasedAt || null
  };
}

function publicMember(m, pool, viewerId) {
  const hits = memberHits(pool, m.userId);
  const draft = ensureDraft(pool);
  const draftSlotNum = draft.order.findIndex((o) => o.userId === m.userId);
  return {
    userId: m.userId,
    name: m.name,
    bankroll: Number(m.bankroll) || 0,
    available: availableCash(pool, m),
    spent: Number(m.spent) || 0,
    hits,
    joinedAt: m.joinedAt,
    draftSlot: draftSlotNum >= 0 ? draftSlotNum + 1 : null,
    isMe: viewerId && m.userId === viewerId
  };
}

function publicDraft(pool, viewerId) {
  if (normalizeMode(pool.mode) !== 'draft') return null;
  const draft = ensureDraft(pool);
  const onClock = currentDraftPicker(pool);
  const n = draft.order.length || 1;
  const round = draft.status === 'active' ? Math.floor(draft.pickIndex / n) + 1 : 0;
  return {
    status: draft.status,
    snake: draft.snake !== false,
    pickIndex: draft.pickIndex,
    pickNumber: draft.pickIndex + 1,
    round,
    order: draft.order.map((o, i) => ({
      userId: o.userId,
      name: o.name,
      slot: i + 1,
      isMe: viewerId && o.userId === viewerId
    })),
    onClock: onClock
      ? {
          userId: onClock.userId,
          name: onClock.name,
          isMe: viewerId && onClock.userId === viewerId
        }
      : null,
    myTurn: Boolean(onClock && viewerId && onClock.userId === viewerId)
  };
}

function publicPool(pool, viewerId, at = nowMs()) {
  settleExpiredAuctions(pool, at);
  refreshPoolStatus(pool, at);
  const mode = normalizeMode(pool.mode);
  const me = (pool.members || []).find((m) => m.userId === viewerId) || null;
  const standings = (pool.members || [])
    .map((m) => publicMember(m, pool, viewerId))
    .sort((a, b) => b.hits - a.hits || a.name.localeCompare(b.name));
  const pot = (Number(pool.buyIn) || 0) * (pool.members || []).length;
  const runMs = Date.parse(pool.endsAt) - Date.parse(pool.createdAt);
  const runDays = Number.isFinite(runMs) ? Math.round(runMs / 86400000) : null;
  return {
    id: pool.id,
    name: pool.name,
    mode,
    createdBy: pool.createdBy,
    createdAt: pool.createdAt,
    buyIn: Number(pool.buyIn) || 0,
    startingCash: Number(pool.startingCash) || 0,
    closesAt: pool.closesAt,
    endsAt: pool.endsAt,
    runDays,
    auctionHours: Number(pool.auctionHours) || DEFAULT_AUCTION_HOURS,
    status: pool.status,
    pot,
    memberCount: (pool.members || []).length,
    joined: Boolean(me),
    me: me ? publicMember(me, pool, viewerId) : null,
    isCreator: viewerId && pool.createdBy?.userId === viewerId,
    members: standings,
    draft: publicDraft(pool, viewerId),
    noms: (pool.noms || [])
      .map((n) => publicNom(n, at))
      .sort((a, b) => {
        if (mode === 'draft') {
          const da = a.draftPick != null ? a.draftPick : 9999;
          const db = b.draftPick != null ? b.draftPick : 9999;
          if (da !== db) return da - db;
        }
        const order = { auction: 0, sold: 1, deceased: 2, unsold: 3 };
        return (order[a.status] ?? 9) - (order[b.status] ?? 9) || String(a.name).localeCompare(String(b.name));
      })
  };
}

function getOverview(viewer) {
  const store = readStore();
  const at = nowMs();
  let dirty = false;
  for (const pool of store.pools) {
    if (!pool.mode) {
      pool.mode = 'auction';
      dirty = true;
    }
    if (settleExpiredAuctions(pool, at)) dirty = true;
    const before = pool.status;
    refreshPoolStatus(pool, at);
    if (pool.status !== before) dirty = true;
  }
  if (dirty) writeStore(store);

  const viewerId = viewer?.id;
  const pools = store.pools
    .map((p) => publicPool(p, viewerId, at))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  return {
    ok: true,
    pools,
    figures: listFigures(),
    defaults: {
      buyIn: 50,
      startingCash: 1000,
      auctionHours: DEFAULT_AUCTION_HOURS,
      runDays: 365,
      mode: 'auction',
      snake: true
    }
  };
}

function getPool(poolId, viewer) {
  const store = readStore();
  const pool = store.pools.find((p) => p.id === poolId);
  if (!pool) throw err(404, 'Pool not found');
  const at = nowMs();
  settleExpiredAuctions(pool, at);
  refreshPoolStatus(pool, at);
  writeStore(store);
  return { ok: true, pool: publicPool(pool, viewer?.id, at), figures: listFigures() };
}

function createPool(user, body = {}) {
  const name = normalizeName(body.name || '').slice(0, MAX_POOL_NAME);
  if (!name || name.length < 3) throw err(400, 'Pool name must be at least 3 characters');

  const mode = normalizeMode(body.mode);
  const buyIn = clampNum(body.buyIn, MIN_BUY_IN, MAX_BUY_IN, 50);
  const startingCash = clampNum(body.startingCash, MIN_STARTING_CASH, MAX_STARTING_CASH, 1000);
  const auctionHours = clampNum(
    body.auctionHours,
    MIN_AUCTION_HOURS,
    MAX_AUCTION_HOURS,
    DEFAULT_AUCTION_HOURS
  );
  const snake = body.snake !== false && body.snake !== 'false';

  let closesAt;
  if (body.closesAt) {
    closesAt = Date.parse(body.closesAt);
    if (!Number.isFinite(closesAt)) throw err(400, 'Invalid closing date');
  } else {
    closesAt = nowMs() + 14 * 86400000;
  }

  let endsAt;
  if (body.endsAt) {
    endsAt = Date.parse(body.endsAt);
    if (!Number.isFinite(endsAt)) throw err(400, 'Invalid pool end date');
  } else {
    const runDays = clampNum(body.runDays, MIN_RUN_DAYS, MAX_RUN_DAYS, 365);
    endsAt = nowMs() + runDays * 86400000;
  }

  if (endsAt <= nowMs() + 86400000) throw err(400, 'Pool must run at least 1 day');
  if (closesAt > endsAt) throw err(400, 'Closing date must be on or before the pool end date');

  const store = readStore();
  if (store.pools.length >= MAX_POOLS) throw err(400, 'Too many pools — delete one first (max ' + MAX_POOLS + ')');

  const createdAt = new Date().toISOString();
  const creator = {
    userId: user.id,
    name: user.name || user.loginName || 'Member'
  };
  const pool = {
    id: crypto.randomUUID(),
    name,
    mode,
    createdBy: creator,
    createdAt,
    buyIn,
    startingCash,
    closesAt: new Date(closesAt).toISOString(),
    endsAt: new Date(endsAt).toISOString(),
    auctionHours,
    status: 'open',
    members: [
      {
        userId: user.id,
        name: creator.name,
        bankroll: startingCash,
        spent: 0,
        joinedAt: createdAt
      }
    ],
    draft: {
      status: 'setup',
      order: mode === 'draft' ? [{ userId: creator.userId, name: creator.name }] : [],
      pickIndex: 0,
      snake
    },
    noms: []
  };

  store.pools.unshift(pool);
  writeStore(store);
  return { ok: true, pool: publicPool(pool, user.id), created: true };
}

function joinPool(user, poolId) {
  const store = readStore();
  const pool = store.pools.find((p) => p.id === poolId);
  if (!pool) throw err(404, 'Pool not found');
  const at = nowMs();
  settleExpiredAuctions(pool, at);
  refreshPoolStatus(pool, at);
  if (pool.status === 'ended') throw err(400, 'This pool has ended');
  if (pool.status !== 'open') throw err(400, 'Joining is closed for this pool');

  const draft = ensureDraft(pool);
  if (normalizeMode(pool.mode) === 'draft' && draft.status === 'active') {
    throw err(400, 'Draft already started — joining is closed');
  }

  if ((pool.members || []).some((m) => m.userId === user.id)) {
    writeStore(store);
    return { ok: true, pool: publicPool(pool, user.id), alreadyJoined: true };
  }

  const member = {
    userId: user.id,
    name: user.name || user.loginName || 'Member',
    bankroll: Number(pool.startingCash) || 1000,
    spent: 0,
    joinedAt: new Date().toISOString()
  };
  pool.members.push(member);

  if (normalizeMode(pool.mode) === 'draft' && draft.status === 'setup') {
    if (!draft.order.some((o) => o.userId === user.id)) {
      draft.order.push({ userId: member.userId, name: member.name });
    }
  }

  writeStore(store);
  return { ok: true, pool: publicPool(pool, user.id), joined: true };
}

function assignMember(user, body = {}) {
  const poolId = String(body.poolId || '').trim();
  const targetId = String(body.userId || '').trim();
  const targetName = String(body.name || '').trim().slice(0, 80) || 'Member';
  if (!targetId) throw err(400, 'Pick a member to assign');

  const store = readStore();
  const pool = store.pools.find((p) => p.id === poolId);
  if (!pool) throw err(404, 'Pool not found');
  requireCreator(pool, user);

  const at = nowMs();
  settleExpiredAuctions(pool, at);
  refreshPoolStatus(pool, at);
  if (pool.status === 'ended') throw err(400, 'This pool has ended');
  if (pool.status !== 'open') throw err(400, 'Joining is closed for this pool');

  const draft = ensureDraft(pool);
  if (normalizeMode(pool.mode) === 'draft' && draft.status === 'active') {
    throw err(400, 'Draft already started — cannot add members');
  }

  if ((pool.members || []).some((m) => m.userId === targetId)) {
    return { ok: true, pool: publicPool(pool, user.id), alreadyJoined: true };
  }

  const member = {
    userId: targetId,
    name: targetName,
    bankroll: Number(pool.startingCash) || 1000,
    spent: 0,
    joinedAt: new Date().toISOString(),
    assignedBy: { userId: user.id, name: user.name || user.loginName || 'Member' }
  };
  pool.members.push(member);

  if (normalizeMode(pool.mode) === 'draft' && draft.status === 'setup') {
    if (!draft.order.some((o) => o.userId === targetId)) {
      draft.order.push({ userId: member.userId, name: member.name });
    }
  }

  writeStore(store);
  return { ok: true, pool: publicPool(pool, user.id), assigned: true, member: publicMember(member, pool, user.id) };
}

function importNoms(user, body = {}) {
  const poolId = String(body.poolId || '').trim();
  const store = readStore();
  const pool = store.pools.find((p) => p.id === poolId);
  if (!pool) throw err(404, 'Pool not found');
  requireCreator(pool, user);

  const at = nowMs();
  settleExpiredAuctions(pool, at);
  refreshPoolStatus(pool, at);
  if (pool.status === 'ended') throw err(400, 'This pool has ended');
  if (pool.status !== 'open') throw err(400, 'Pool is locked');

  const member = (pool.members || []).find((m) => m.userId === user.id);
  if (!member) throw err(403, 'Join the pool before importing');

  const mode = normalizeMode(pool.mode);
  if (mode === 'draft') {
    throw err(400, 'Import is for auction pools — use the draft once it starts');
  }

  let items = Array.isArray(body.items) ? body.items : null;
  if (!items && body.text) {
    items = String(body.text)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/[|,;\t]/).map((p) => p.trim()).filter(Boolean);
        return { name: parts[0], category: parts[1] || 'Custom' };
      });
  }
  if (!items || !items.length) throw err(400, 'Paste names (one per line) or upload a list');

  const hours = clampNum(
    body.auctionHours != null ? body.auctionHours : pool.auctionHours,
    MIN_AUCTION_HOURS,
    MAX_AUCTION_HOURS,
    DEFAULT_AUCTION_HOURS
  );
  const openNow = body.openAuctions !== false && body.openAuctions !== 'false';
  let added = 0;
  const skipped = [];
  pool.noms = pool.noms || [];

  for (const raw of items.slice(0, 100)) {
    if (pool.noms.length >= MAX_NOMS_PER_POOL) break;
    let name;
    let category;
    let figureId = null;
    try {
      ({ name, category, figureId } = resolveName(
        typeof raw === 'string' ? { name: raw } : raw
      ));
    } catch {
      skipped.push(String(raw?.name || raw || '').slice(0, 40));
      continue;
    }
    const key = nameKey(name);
    if (pool.noms.some((n) => nameKey(n.name) === key && n.status !== 'unsold')) {
      skipped.push(name);
      continue;
    }
    const nom = {
      id: crypto.randomUUID(),
      name,
      category,
      figureId,
      nominatedBy: { userId: user.id, name: member.name },
      nominatedAt: new Date(at).toISOString(),
      auctionEndsAt: openNow ? new Date(at + hours * 3600000).toISOString() : null,
      status: openNow ? 'auction' : 'listed',
      bids: [],
      ownerId: null,
      ownerName: null,
      winningBid: null,
      draftPick: null,
      soldAt: null
    };
    pool.noms.push(nom);
    added += 1;
  }

  writeStore(store);
  return {
    ok: true,
    pool: publicPool(pool, user.id),
    imported: added,
    skipped: skipped.slice(0, 20)
  };
}

function requireCreator(pool, user) {
  if (pool.createdBy?.userId !== user.id) {
    throw err(403, 'Only the pool creator can do that');
  }
}

function setDraftOrder(user, body = {}) {
  const poolId = String(body.poolId || '').trim();
  const store = readStore();
  const pool = store.pools.find((p) => p.id === poolId);
  if (!pool) throw err(404, 'Pool not found');
  requireCreator(pool, user);
  if (normalizeMode(pool.mode) !== 'draft') throw err(400, 'This pool is auction style');

  const draft = ensureDraft(pool);
  if (draft.status === 'active') throw err(400, 'Cannot change order while the draft is active');
  if (draft.status === 'complete') throw err(400, 'Draft is already complete');

  if (Object.prototype.hasOwnProperty.call(body, 'snake')) {
    draft.snake = body.snake !== false && body.snake !== 'false';
  }

  const memberById = new Map((pool.members || []).map((m) => [m.userId, m]));
  let orderIds = Array.isArray(body.order)
    ? body.order.map((id) => String(id || '').trim()).filter(Boolean)
    : null;

  if (body.shuffle === true || body.shuffle === 'true') {
    orderIds = (pool.members || []).map((m) => m.userId);
    for (let i = orderIds.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [orderIds[i], orderIds[j]] = [orderIds[j], orderIds[i]];
    }
  }

  if (!orderIds || !orderIds.length) {
    orderIds = (pool.members || []).map((m) => m.userId);
  }

  const seen = new Set();
  const order = [];
  for (const id of orderIds) {
    if (seen.has(id)) continue;
    const m = memberById.get(id);
    if (!m) continue;
    seen.add(id);
    order.push({ userId: m.userId, name: m.name });
  }
  for (const m of pool.members || []) {
    if (seen.has(m.userId)) continue;
    order.push({ userId: m.userId, name: m.name });
  }
  if (order.length < 2) throw err(400, 'Need at least 2 members before setting draft order');

  draft.order = order;
  draft.status = 'setup';
  draft.pickIndex = 0;
  writeStore(store);
  return { ok: true, pool: publicPool(pool, user.id) };
}

function startDraft(user, body = {}) {
  const poolId = String(body.poolId || '').trim();
  const store = readStore();
  const pool = store.pools.find((p) => p.id === poolId);
  if (!pool) throw err(404, 'Pool not found');
  requireCreator(pool, user);
  if (normalizeMode(pool.mode) !== 'draft') throw err(400, 'This pool is auction style');

  const draft = ensureDraft(pool);
  if (draft.status === 'active') {
    return { ok: true, pool: publicPool(pool, user.id), alreadyStarted: true };
  }
  if (draft.status === 'complete') throw err(400, 'Draft is already complete');

  if (!draft.order.length) {
    draft.order = (pool.members || []).map((m) => ({ userId: m.userId, name: m.name }));
  } else {
    const seen = new Set(draft.order.map((o) => o.userId));
    for (const m of pool.members || []) {
      if (!seen.has(m.userId)) draft.order.push({ userId: m.userId, name: m.name });
    }
  }
  if (draft.order.length < 2) throw err(400, 'Need at least 2 members to start the draft');

  if (Object.prototype.hasOwnProperty.call(body, 'snake')) {
    draft.snake = body.snake !== false && body.snake !== 'false';
  }

  draft.status = 'active';
  draft.pickIndex = 0;
  writeStore(store);
  return { ok: true, pool: publicPool(pool, user.id), started: true };
}

function endDraft(user, body = {}) {
  const poolId = String(body.poolId || '').trim();
  const store = readStore();
  const pool = store.pools.find((p) => p.id === poolId);
  if (!pool) throw err(404, 'Pool not found');
  requireCreator(pool, user);
  if (normalizeMode(pool.mode) !== 'draft') throw err(400, 'This pool is auction style');
  const draft = ensureDraft(pool);
  if (draft.status !== 'active') throw err(400, 'Draft is not active');
  draft.status = 'complete';
  writeStore(store);
  return { ok: true, pool: publicPool(pool, user.id) };
}

function updatePoolSettings(user, body = {}) {
  const poolId = String(body.poolId || '').trim();
  const store = readStore();
  const pool = store.pools.find((p) => p.id === poolId);
  if (!pool) throw err(404, 'Pool not found');
  requireCreator(pool, user);
  if (pool.status === 'ended') throw err(400, 'This pool has ended');

  if (normalizeMode(pool.mode) === 'auction' && body.auctionHours != null) {
    pool.auctionHours = clampNum(
      body.auctionHours,
      MIN_AUCTION_HOURS,
      MAX_AUCTION_HOURS,
      pool.auctionHours || DEFAULT_AUCTION_HOURS
    );
  }
  if (normalizeMode(pool.mode) === 'draft' && Object.prototype.hasOwnProperty.call(body, 'snake')) {
    const draft = ensureDraft(pool);
    if (draft.status === 'setup') {
      draft.snake = body.snake !== false && body.snake !== 'false';
    }
  }
  writeStore(store);
  return { ok: true, pool: publicPool(pool, user.id) };
}

function nominate(user, body = {}) {
  const poolId = String(body.poolId || '').trim();
  const store = readStore();
  const pool = store.pools.find((p) => p.id === poolId);
  if (!pool) throw err(404, 'Pool not found');
  const at = nowMs();
  settleExpiredAuctions(pool, at);
  refreshPoolStatus(pool, at);
  if (pool.status === 'ended') throw err(400, 'This pool has ended');

  const mode = normalizeMode(pool.mode);
  const member = (pool.members || []).find((m) => m.userId === user.id);
  if (!member) throw err(403, 'Join the pool before picking');

  if ((pool.noms || []).length >= MAX_NOMS_PER_POOL) throw err(400, 'Pool nomination limit reached');

  const { name, category, figureId } = resolveName(body);
  const key = nameKey(name);
  if ((pool.noms || []).some((n) => nameKey(n.name) === key && n.status !== 'unsold')) {
    throw err(400, 'That name is already in this pool');
  }

  if (mode === 'draft') {
    const draft = ensureDraft(pool);
    if (draft.status !== 'active') {
      throw err(400, 'Draft has not started — wait for the pool owner to start it');
    }
    const onClock = currentDraftPicker(pool);
    if (!onClock || onClock.userId !== user.id) {
      throw err(403, onClock ? `It is ${onClock.name}'s turn to pick` : 'Draft is not on the clock');
    }

    const pickNumber = draft.pickIndex + 1;
    const nom = {
      id: crypto.randomUUID(),
      name,
      category,
      figureId,
      nominatedBy: { userId: user.id, name: member.name },
      nominatedAt: new Date(at).toISOString(),
      auctionEndsAt: null,
      status: 'sold',
      bids: [],
      ownerId: user.id,
      ownerName: member.name,
      winningBid: 0,
      draftPick: pickNumber,
      soldAt: new Date(at).toISOString()
    };
    pool.noms.push(nom);
    draft.pickIndex += 1;
    writeStore(store);
    return { ok: true, pool: publicPool(pool, user.id), nominated: publicNom(nom, at), drafted: true };
  }

  if (pool.status !== 'open') throw err(400, 'Nominations are closed');

  const hours = clampNum(pool.auctionHours, MIN_AUCTION_HOURS, MAX_AUCTION_HOURS, DEFAULT_AUCTION_HOURS);
  const nom = {
    id: crypto.randomUUID(),
    name,
    category,
    figureId,
    nominatedBy: { userId: user.id, name: member.name },
    nominatedAt: new Date(at).toISOString(),
    auctionEndsAt: new Date(at + hours * 3600000).toISOString(),
    status: 'auction',
    bids: [],
    ownerId: null,
    ownerName: null,
    winningBid: null
  };
  pool.noms.push(nom);
  writeStore(store);
  return { ok: true, pool: publicPool(pool, user.id), nominated: publicNom(nom, at) };
}

function placeBid(user, body = {}) {
  const poolId = String(body.poolId || '').trim();
  const nomId = String(body.nomId || '').trim();
  const amount = Math.floor(Number(body.amount));
  if (!Number.isFinite(amount) || amount < MIN_BID) throw err(400, `Minimum bid is $${MIN_BID}`);

  const store = readStore();
  const pool = store.pools.find((p) => p.id === poolId);
  if (!pool) throw err(404, 'Pool not found');
  if (normalizeMode(pool.mode) !== 'auction') throw err(400, 'This pool is draft style — no bidding');

  const at = nowMs();
  settleExpiredAuctions(pool, at);
  refreshPoolStatus(pool, at);
  if (pool.status === 'ended') throw err(400, 'This pool has ended');

  const member = (pool.members || []).find((m) => m.userId === user.id);
  if (!member) throw err(403, 'Join the pool before bidding');

  const nom = (pool.noms || []).find((n) => n.id === nomId);
  if (!nom) throw err(404, 'Nomination not found');
  if (nom.status !== 'auction') throw err(400, 'Auction is not open for this name');
  const ends = Date.parse(nom.auctionEndsAt || '');
  if (!Number.isFinite(ends) || ends <= at) {
    settleExpiredAuctions(pool, at);
    writeStore(store);
    throw err(400, 'Auction has ended');
  }

  const top = highBid(nom);
  const minNext = top ? Number(top.amount) + 1 : MIN_BID;
  if (amount < minNext) throw err(400, `Bid must be at least $${minNext}`);

  let reserved = 0;
  for (const n of pool.noms || []) {
    if (n.status !== 'auction' || n.id === nom.id) continue;
    const t = highBid(n);
    if (t && t.userId === user.id) reserved += Number(t.amount) || 0;
  }
  const avail = Math.max(0, (Number(member.bankroll) || 0) - reserved);
  if (amount > avail) throw err(400, `Not enough cash — you have $${avail} available`);

  nom.bids.push({
    userId: user.id,
    name: member.name,
    amount,
    at: new Date(at).toISOString()
  });
  writeStore(store);
  return { ok: true, pool: publicPool(pool, user.id), bid: { nomId, amount } };
}

function markDeceased(user, body = {}) {
  const poolId = String(body.poolId || '').trim();
  const nomId = String(body.nomId || '').trim();
  const store = readStore();
  const pool = store.pools.find((p) => p.id === poolId);
  if (!pool) throw err(404, 'Pool not found');
  const at = nowMs();
  settleExpiredAuctions(pool, at);
  refreshPoolStatus(pool, at);
  requireCreator(pool, user);

  const nom = (pool.noms || []).find((n) => n.id === nomId);
  if (!nom) throw err(404, 'Nomination not found');
  if (nom.status === 'deceased') throw err(400, 'Already marked deceased');
  if (nom.status !== 'sold') throw err(400, 'Only owned names can be scored');

  nom.status = 'deceased';
  nom.deceasedAt = new Date(at).toISOString();
  nom.deceasedBy = { userId: user.id, name: user.name || user.loginName || 'Member' };
  writeStore(store);
  return { ok: true, pool: publicPool(pool, user.id), scored: publicNom(nom, at) };
}

function deletePool(user, poolId) {
  if (!user?.id) throw err(401, 'Sign in required');
  const id = String(poolId || '').trim();
  if (!id) throw err(400, 'poolId required');
  const store = readStore();
  const idx = store.pools.findIndex((p) => p.id === id);
  if (idx === -1) throw err(404, 'Pool not found');
  const pool = store.pools[idx];
  requireCreator(pool, user);
  const removed = {
    id: pool.id,
    name: pool.name,
    mode: pool.mode
  };
  store.pools.splice(idx, 1);
  writeStore(store);
  return { ok: true, deleted: true, pool: removed };
}

module.exports = {
  getOverview,
  getPool,
  createPool,
  joinPool,
  assignMember,
  importNoms,
  nominate,
  placeBid,
  markDeceased,
  setDraftOrder,
  startDraft,
  endDraft,
  updatePoolSettings,
  deletePool,
  listFigures
};
